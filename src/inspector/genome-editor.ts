/**
 * genome-editor.ts — Canvas interaction for the Rep Inspector.
 *
 * Handles:
 * - Click-to-select: clicking a segment selects that gene
 * - Palette drag-and-drop: drag a colored tile onto a segment to add a child
 * - Scroll-to-adjust: scroll wheel adjusts angle (or length with Shift) of selected gene
 */

import type { InspectorEngine } from './inspector-engine';
import type { InspectorRenderer, GhostState } from './inspector-renderer';
import { getDefaultChildAngle, getDefaultChildLength } from './inspector-engine';
import { SEGMENT_RADIUS } from '../constants';
import type { SegmentColor } from '../types';

// Snap radius in world units — how close the mouse needs to be to snap to a segment
const SNAP_RADIUS_WORLD = SEGMENT_RADIUS * 3;


export interface GenomeEditor {
  /** Current ghost state — read by renderer each frame */
  ghost: GhostState | null;
  /** Called when user starts dragging a color from the palette */
  startDrag(color: number): void;
  /** Called when drag ends (drop or cancel) */
  endDrag(): void;
}


export function createGenomeEditor(
  engine: InspectorEngine,
  renderer: InspectorRenderer,
): GenomeEditor {
  const canvas = renderer.getCanvas();
  let draggingColor: number | null = null;
  let ghostState: GhostState | null = null;

  // ── Click to select / drag to move ──────────────────────────
  let _pointerDown = false;
  let _draggingOrg = false;
  let _dragStartX = 0;
  let _dragStartY = 0;
  const DRAG_THRESHOLD_SQ = 16; // 4px² — move beyond this to start dragging

  function handleSelectClick(sx: number, sy: number): void {
    const { wx, wy } = renderer.screenToWorld(sx, sy);
    if (draggingColor !== null) return;
    const org = engine.getOrganism();
    if (!org) { engine.selectGene(null); return; }
    const seg = engine.world.segments;
    let bestDist = SNAP_RADIUS_WORLD;
    let bestGene: number | null = null;
    for (let i = 0; i < org.segmentCount; i++) {
      const idx = org.firstSegment + i;
      if (!seg.alive[idx]) continue;
      const dx = seg.x[idx] - wx;
      const dy = seg.y[idx] - wy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) { bestDist = dist; bestGene = i; }
    }
    engine.selectGene(bestGene);
  }

  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    _pointerDown = true;
    _draggingOrg = false;
    _dragStartX = e.clientX;
    _dragStartY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (!_pointerDown) return;
    const ddx = e.clientX - _dragStartX;
    const ddy = e.clientY - _dragStartY;
    if (!_draggingOrg && ddx * ddx + ddy * ddy > DRAG_THRESHOLD_SQ) {
      _draggingOrg = true;
    }
    if (_draggingOrg) {
      const rect = canvas.getBoundingClientRect();
      const { wx, wy } = renderer.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      engine.moveRoot(wx, wy);
    }
  });

  canvas.addEventListener('pointerup', (e: PointerEvent) => {
    if (!_pointerDown) return;
    _pointerDown = false;
    if (!_draggingOrg) {
      // Tap/click — run select logic
      const rect = canvas.getBoundingClientRect();
      handleSelectClick(e.clientX - rect.left, e.clientY - rect.top);
    }
    _draggingOrg = false;
  });

  // ── Scroll wheel: Alt+scroll = angle, Shift+scroll = length ─
  // Plain scroll is handled by the renderer for pan/zoom.
  canvas.addEventListener('wheel', (e: WheelEvent) => {
    const idx = engine.selectedGeneIdx;
    if (idx === null || idx === 0) return;
    if (!e.altKey && !e.shiftKey) return; // plain scroll → let renderer zoom

    e.preventDefault();
    const delta = e.deltaY > 0 ? 1 : -1;

    if (e.shiftKey) {
      // Shift+scroll → adjust length
      const current = engine.genome[idx].length;
      engine.setSegmentLength(idx, current - delta * 0.1);
    } else {
      // Alt+scroll → adjust angle (5° per notch)
      const current = engine.genome[idx].angle;
      const step = (5 * Math.PI) / 180;
      engine.setSegmentAngle(idx, current + delta * step);
    }
  }, { passive: false });

  // ── Drag-over: track mouse for ghost rendering ──────────────
  canvas.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault();
    if (draggingColor === null) return;

    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { wx, wy } = renderer.screenToWorld(sx, sy);

    // Find nearest segment as snap target
    const snapTarget = findNearestSegment(engine, wx, wy, SNAP_RADIUS_WORLD);

    ghostState = {
      worldX: wx,
      worldY: wy,
      color: draggingColor,
      snapTargetGeneIdx: snapTarget,
    };
  });

  // ── Drop: add child gene ─────────────────────────────────────
  canvas.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    if (draggingColor === null || !ghostState) {
      endDrag();
      return;
    }

    const target = ghostState.snapTargetGeneIdx;
    if (target !== null) {
      const color = draggingColor as SegmentColor;
      const parentColor = engine.genome[target].color;
      const angle = getDefaultChildAngle(parentColor as SegmentColor);
      const length = getDefaultChildLength(color);
      engine.addChild(target, color, angle, length);
    }

    endDrag();
  });

  canvas.addEventListener('dragleave', () => {
    ghostState = null;
  });

  function endDrag(): void {
    draggingColor = null;
    ghostState = null;
  }

  function startDrag(color: number): void {
    draggingColor = color;
  }

  const editor: GenomeEditor = {
    get ghost() { return ghostState; },
    startDrag,
    endDrag,
  };

  return editor;
}


// ─── Helper ──────────────────────────────────────────────────

function findNearestSegment(
  engine: InspectorEngine,
  wx: number,
  wy: number,
  maxDist: number,
): number | null {
  const org = engine.getOrganism();
  if (!org) return null;

  const seg = engine.world.segments;
  let best = maxDist;
  let bestIdx: number | null = null;

  for (let i = 0; i < org.segmentCount; i++) {
    const idx = org.firstSegment + i;
    if (!seg.alive[idx]) continue;
    const dx = seg.x[idx] - wx;
    const dy = seg.y[idx] - wy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < best) {
      best = dist;
      bestIdx = i;
    }
  }

  return bestIdx;
}
