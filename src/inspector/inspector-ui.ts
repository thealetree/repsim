/**
 * inspector-ui.ts — HTML overlay UI for the Rep Inspector.
 *
 * Panels:
 *   Top bar     — name, pause, theme, share, return to sim
 *   Left panel  — genome readout: SVG tree, gene cards, color stats, bio stats
 *   Right panel — segment editor: color buttons, angle/length sliders, add/delete
 *   Bottom      — segment palette (drag to add) + new rep presets
 */

import type { InspectorEngine } from './inspector-engine';
import type { InspectorRenderer } from './inspector-renderer';
import type { GenomeEditor } from './genome-editor';
import {
  SEGMENT_RENDER_COLORS,
  getRootDrain,
  getReproCost,
} from '../constants';
import { SegmentColor, type Genome } from '../types';
import { generateName } from '../simulation/naming';
import { buildGenomeTopology } from '../simulation/tree-utils';
import {
  minimalGenome,
  symmetricalGenome,
  randomInspectorGenome,
  getDefaultChildAngle,
  getDefaultChildLength,
} from './inspector-engine';

// ─── Color Metadata ──────────────────────────────────────────

const COLOR_NAMES: Record<number, string> = {
  0: 'Green', 1: 'Blue', 2: 'Yellow', 3: 'Red', 4: 'Purple', 5: 'White',
};
const COLOR_ROLES: Record<number, string> = {
  0: 'Photosynthesis', 1: 'HP Reserve', 2: 'Movement',
  3: 'Attack', 4: 'Sexual Repro', 5: 'Scavenger',
};


// ─── Styles ──────────────────────────────────────────────────

function injectInspectorStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    :root {
      --ui-bg: rgba(10, 10, 18, 0.50);
      --ui-bg-solid: #0d0d16;
      --ui-border: rgba(255, 255, 255, 0.06);
      --ui-text: #d4d8e0;
      --ui-text-dim: #7a8294;
      --ui-text-muted: #4e5564;
      --ui-accent: #6b8aff;
      --ui-accent-dim: rgba(107, 138, 255, 0.12);
      --ui-surface: rgba(255, 255, 255, 0.04);
      --ui-surface-hover: rgba(255, 255, 255, 0.07);
      --ui-slider-track: rgba(255, 255, 255, 0.08);
      --ui-slider-thumb: #6b8aff;
      --ui-bar-bg: rgba(255, 255, 255, 0.06);
      --ui-font: 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
    :root.light-theme {
      --ui-bg: rgba(255, 255, 255, 0.50);
      --ui-bg-solid: #f8f9fb;
      --ui-border: rgba(0, 0, 0, 0.08);
      --ui-text: #1a1d24;
      --ui-text-dim: #6b7280;
      --ui-text-muted: #9ca3af;
      --ui-accent: #4f6be8;
      --ui-accent-dim: rgba(79, 107, 232, 0.10);
      --ui-surface: rgba(0, 0, 0, 0.03);
      --ui-surface-hover: rgba(0, 0, 0, 0.06);
      --ui-slider-track: rgba(0, 0, 0, 0.08);
      --ui-slider-thumb: #4f6be8;
      --ui-bar-bg: rgba(0, 0, 0, 0.06);
    }

    /* ── Base ── */
    .insp-ui {
      font-family: var(--ui-font);
      font-size: 12px;
      color: var(--ui-text);
      pointer-events: none;
      user-select: none;
      -webkit-font-smoothing: antialiased;
    }
    .insp-ui * { pointer-events: auto; }

    /* ── Top Bar ── */
    #insp-top-bar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 40px;
      background: var(--ui-bg);
      border-bottom: 1px solid var(--ui-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 12px;
      z-index: 100;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      gap: 8px;
    }
    #insp-top-bar .top-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
    #insp-top-bar .top-center { display: flex; align-items: center; gap: 10px; flex: 1; justify-content: center; min-width: 0; }
    #insp-top-bar .top-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

    .insp-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: var(--ui-accent);
      white-space: nowrap;
    }
    .insp-sep {
      width: 1px; height: 16px;
      background: var(--ui-border);
      flex-shrink: 0;
    }
    #insp-org-name {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--ui-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 200px;
    }
    #insp-genome-size {
      font-size: 10px;
      color: var(--ui-text-muted);
      white-space: nowrap;
    }

    /* ── Buttons ── */
    .ui-btn {
      background: var(--ui-surface);
      border: 1px solid var(--ui-border);
      color: var(--ui-text-dim);
      padding: 5px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-family: var(--ui-font);
      font-size: 11px;
      font-weight: 500;
      transition: all 0.12s ease;
      line-height: 1;
      white-space: nowrap;
    }
    .ui-btn:hover { background: var(--ui-surface-hover); color: var(--ui-text); }
    .ui-btn.active { background: var(--ui-accent-dim); color: var(--ui-accent); border-color: rgba(107,138,255,0.2); }
    .ui-btn-icon {
      background: none; border: none;
      color: var(--ui-text-dim);
      cursor: pointer; padding: 4px 6px;
      border-radius: 6px; font-size: 15px;
      line-height: 1;
      transition: all 0.12s ease;
    }
    .ui-btn-icon:hover { background: var(--ui-surface-hover); color: var(--ui-text); }

    /* ── Left Panel ── */
    #insp-left-panel {
      position: fixed;
      top: 40px; left: 0; bottom: 96px;
      width: 240px;
      background: var(--ui-bg);
      border-right: 1px solid var(--ui-border);
      overflow-y: auto;
      overflow-x: hidden;
      z-index: 50;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      display: flex;
      flex-direction: column;
    }
    #insp-left-panel::-webkit-scrollbar { width: 4px; }
    #insp-left-panel::-webkit-scrollbar-thumb { background: var(--ui-border); border-radius: 2px; }

    .left-section {
      padding: 10px 12px;
      border-bottom: 1px solid var(--ui-border);
    }
    .left-section-title {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.1em;
      color: var(--ui-text-muted);
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    /* SVG tree */
    #insp-tree-svg {
      width: 100%;
      display: block;
      overflow: visible;
    }
    .tree-node { cursor: pointer; transition: all 0.1s; }
    .tree-node:hover circle { opacity: 0.85; }
    .tree-node.selected circle { stroke-width: 2.5; }
    .tree-edge { stroke-width: 1.2; opacity: 0.4; }

    /* Gene cards */
    .gene-card {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 7px;
      border-radius: 5px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.1s;
      margin-bottom: 2px;
    }
    .gene-card:hover { background: var(--ui-surface); }
    .gene-card.selected {
      background: var(--ui-accent-dim);
      border-color: rgba(107, 138, 255, 0.25);
    }
    .gene-card-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
      border: 1px solid rgba(255,255,255,0.2);
    }
    .gene-card-idx {
      font-size: 9px;
      color: var(--ui-text-muted);
      min-width: 18px;
      font-variant-numeric: tabular-nums;
    }
    .gene-card-info {
      flex: 1;
      min-width: 0;
      font-size: 10px;
      color: var(--ui-text-dim);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .gene-card-info strong { color: var(--ui-text); font-weight: 600; }
    .gene-card-angle {
      font-size: 9px;
      color: var(--ui-text-muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    /* Color stats */
    .color-stats-row {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      align-items: center;
    }
    .color-stat-chip {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 10px;
      color: var(--ui-text-dim);
      padding: 2px 5px;
      border-radius: 4px;
      background: var(--ui-surface);
    }
    .color-stat-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    /* Bio stats table */
    .bio-stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 0;
      border-bottom: 1px solid var(--ui-border);
      font-size: 10px;
    }
    .bio-stat-row:last-child { border-bottom: none; }
    .bio-stat-label { color: var(--ui-text-dim); }
    .bio-stat-value {
      font-weight: 600;
      color: var(--ui-text);
      font-variant-numeric: tabular-nums;
    }
    .bio-stat-value.positive { color: #44cc88; }
    .bio-stat-value.negative { color: #ff6655; }
    .bio-stat-value.neutral { color: var(--ui-text-dim); }

    /* ── Right Panel ── */
    #insp-right-panel {
      position: fixed;
      top: 40px; right: 0; bottom: 96px;
      width: 220px;
      background: var(--ui-bg);
      border-left: 1px solid var(--ui-border);
      overflow-y: auto;
      overflow-x: hidden;
      z-index: 50;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    #insp-right-panel::-webkit-scrollbar { width: 4px; }
    #insp-right-panel::-webkit-scrollbar-thumb { background: var(--ui-border); border-radius: 2px; }

    .right-section {
      padding: 10px 12px;
      border-bottom: 1px solid var(--ui-border);
    }
    .right-section-title {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.1em;
      color: var(--ui-text-muted);
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .right-placeholder {
      font-size: 11px;
      color: var(--ui-text-muted);
      text-align: center;
      padding: 12px 0;
      font-style: italic;
    }
    #insp-gene-editor { display: none; }

    /* Color picker grid */
    .color-picker-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 4px;
      margin-bottom: 10px;
    }
    .color-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      padding: 5px 4px;
      border-radius: 5px;
      border: 1px solid var(--ui-border);
      cursor: pointer;
      background: var(--ui-surface);
      transition: all 0.1s;
      font-family: var(--ui-font);
    }
    .color-btn:hover { background: var(--ui-surface-hover); border-color: rgba(255,255,255,0.12); }
    .color-btn.active {
      border-color: var(--ui-accent);
      background: var(--ui-accent-dim);
      box-shadow: 0 0 0 1px var(--ui-accent);
    }
    .color-btn-dot {
      width: 14px; height: 14px;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.2);
    }
    .color-btn-label { font-size: 8px; color: var(--ui-text-dim); letter-spacing: 0.03em; }

    /* Slider rows */
    .slider-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    .slider-label { font-size: 10px; color: var(--ui-text-dim); min-width: 38px; }
    .slider-row input[type=range] {
      flex: 1;
      height: 4px;
      border-radius: 2px;
      appearance: none;
      background: var(--ui-slider-track);
      cursor: pointer;
      outline: none;
    }
    .slider-row input[type=range]::-webkit-slider-thumb {
      appearance: none;
      width: 12px; height: 12px;
      border-radius: 50%;
      background: var(--ui-slider-thumb);
      cursor: pointer;
    }
    .slider-value {
      font-size: 10px;
      color: var(--ui-text);
      min-width: 32px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .slider-hint { font-size: 9px; color: var(--ui-text-muted); margin-bottom: 6px; }

    /* Gene meta info */
    .gene-meta {
      font-size: 10px;
      color: var(--ui-text-dim);
      margin-bottom: 8px;
      line-height: 1.5;
    }
    .gene-meta strong { color: var(--ui-text); font-weight: 600; }

    /* Action buttons */
    .action-btn-row {
      display: flex;
      gap: 6px;
      margin-top: 6px;
    }
    .action-btn-row .ui-btn {
      flex: 1;
      font-size: 10px;
      padding: 5px 6px;
      text-align: center;
    }
    .ui-btn.danger {
      color: #ff6655;
      border-color: rgba(255, 102, 85, 0.25);
    }
    .ui-btn.danger:hover {
      background: rgba(255, 102, 85, 0.1);
      color: #ff8877;
    }

    /* ── Bottom Panel ── */
    #insp-bottom-panel {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      height: 96px;
      background: var(--ui-bg);
      border-top: 1px solid var(--ui-border);
      z-index: 50;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      display: flex;
      align-items: center;
      padding: 0 16px;
      gap: 20px;
      overflow: hidden;
    }
    .palette-section {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .palette-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.1em;
      color: var(--ui-text-muted);
      text-transform: uppercase;
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      white-space: nowrap;
    }
    .palette-tiles {
      display: flex;
      gap: 6px;
    }
    .palette-tile {
      width: 44px;
      height: 60px;
      border-radius: 8px;
      border: 1px solid var(--ui-border);
      cursor: grab;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      background: var(--ui-surface);
      transition: all 0.12s;
      user-select: none;
    }
    .palette-tile:hover {
      background: var(--ui-surface-hover);
      border-color: rgba(255,255,255,0.12);
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
    .palette-tile:active { cursor: grabbing; transform: translateY(0); }
    .palette-tile-circle {
      width: 20px; height: 20px;
      border-radius: 50%;
      border: 1.5px solid rgba(255,255,255,0.25);
    }
    .palette-tile-label { font-size: 8px; color: var(--ui-text-muted); }

    .presets-section {
      display: flex;
      flex-direction: column;
      gap: 5px;
      flex-shrink: 0;
    }
    .presets-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.1em;
      color: var(--ui-text-muted);
      text-transform: uppercase;
    }
    .presets-btns { display: flex; gap: 5px; }

    /* ── Toast ── */
    .insp-toast {
      position: fixed;
      bottom: 106px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--ui-bg-solid);
      border: 1px solid var(--ui-border);
      border-radius: 8px;
      padding: 8px 16px;
      font-family: var(--ui-font);
      font-size: 12px;
      color: var(--ui-text);
      z-index: 300;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
      backdrop-filter: blur(12px);
      white-space: nowrap;
    }
    .insp-toast.visible { opacity: 1; }

    /* ── Return badge ── */
    #insp-return-btn {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
    }

    /* ── Keyboard hint in right panel ── */
    .kbd-hint {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      font-size: 9px;
      color: var(--ui-text-muted);
    }
    kbd {
      font-family: var(--ui-font);
      font-size: 8px;
      background: var(--ui-surface);
      border: 1px solid var(--ui-border);
      border-radius: 3px;
      padding: 1px 4px;
      color: var(--ui-text-dim);
    }

    /* ─── Mobile Tab Bar (hidden on desktop) ─── */
    #insp-tab-bar { display: none; }
    .insp-tab-btn {
      flex: 1;
      height: 100%;
      background: none;
      border: none;
      color: var(--ui-text);
      font-size: 12px;
      cursor: pointer;
      font-family: var(--ui-font);
    }
    .insp-tab-btn:active { background: var(--ui-hover); }

    /* ─── Mobile (≤767px) ─── */
    @media (max-width: 767px) {
      #insp-top-bar .top-center { display: none; }

      #insp-left-panel, #insp-right-panel {
        position: fixed;
        left: 0; right: 0;
        top: auto;
        bottom: 52px;
        width: 100%;
        height: 28vh;
        max-height: 28vh;
        transform: translateY(100%);
        transition: transform 0.25s ease;
        border-top: 1px solid var(--ui-border);
        border-radius: 12px 12px 0 0;
        overflow-y: auto;
        z-index: 60;
      }
      #insp-left-panel.mobile-visible,
      #insp-right-panel.mobile-visible {
        transform: translateY(0);
      }

      #insp-bottom-panel {
        height: 52px;
        padding: 4px 8px;
        overflow-x: auto;
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 6px;
      }
      .presets-section { display: none; }

      #insp-tab-bar {
        display: flex;
        position: fixed;
        bottom: 0; left: 0; right: 0;
        height: 52px;
        background: var(--ui-bg-solid);
        border-top: 1px solid var(--ui-border);
        z-index: 70;
      }
    }
  `;
  document.head.appendChild(style);
}


// ─── Toast ───────────────────────────────────────────────────

function showToast(message: string): void {
  const toast = document.createElement('div');
  toast.className = 'insp-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 1800);
}


// ─── Compression for share URL ───────────────────────────────

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function compressGenome(payload: object): Promise<string> {
  const json = JSON.stringify(payload);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate'));
  const buf = await new Response(stream).arrayBuffer();
  return base64urlEncode(new Uint8Array(buf));
}

async function buildShareURL(engine: InspectorEngine): Promise<string | null> {
  const { genome, name, generation } = engine.getExportData();
  const payload = { v: 1, g: genome, gen: generation, n: name };
  const encoded = await compressGenome(payload);
  const base = window.location.origin + '/inspector/';
  const url = `${base}?o=${encoded}`;
  return url.length <= 8000 ? url : null;
}


// ─── SVG Tree Diagram ────────────────────────────────────────

function renderSVGTree(
  genome: Genome,
  selectedIdx: number | null,
  onNodeClick: (idx: number) => void,
): SVGSVGElement {
  const n = genome.length;
  if (n === 0) {
    const empty = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    empty.setAttribute('width', '0');
    empty.setAttribute('height', '0');
    return empty;
  }

  const topology = buildGenomeTopology(genome);
  const nodeR = 8;
  const hGap = 26;
  const vGap = 30;

  // Assign x positions via DFS (leaves get sequential x positions)
  const xPos: number[] = new Array(n).fill(0);
  const yPos: number[] = new Array(n);

  let leafX = 0;
  function assignX(i: number): void {
    yPos[i] = topology.depth[i] * vGap + nodeR + 2;
    const kids = topology.children[i];
    if (kids.length === 0) {
      xPos[i] = leafX * hGap + nodeR + 4;
      leafX++;
    } else {
      for (const c of kids) assignX(c);
      // Center over children
      xPos[i] = (xPos[topology.children[i][0]] + xPos[topology.children[i][topology.children[i].length - 1]]) / 2;
    }
  }
  assignX(0);

  const svgW = Math.max(leafX * hGap + nodeR * 2 + 8, 100);
  const maxDepth = Math.max(...topology.depth);
  const svgH = (maxDepth + 1) * vGap + nodeR * 2 + 6;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('id', 'insp-tree-svg');
  svg.setAttribute('width', `${svgW}`);
  svg.setAttribute('height', `${svgH}`);
  svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);

  // Draw edges first (behind nodes)
  for (let i = 1; i < n; i++) {
    const p = genome[i].parent;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', `${xPos[p]}`);
    line.setAttribute('y1', `${yPos[p]}`);
    line.setAttribute('x2', `${xPos[i]}`);
    line.setAttribute('y2', `${yPos[i]}`);
    line.setAttribute('stroke', 'var(--ui-text-muted)');
    line.setAttribute('stroke-width', '1.2');
    line.setAttribute('opacity', '0.45');
    line.classList.add('tree-edge');
    svg.appendChild(line);
  }

  // Draw nodes
  for (let i = 0; i < n; i++) {
    const hexColor = SEGMENT_RENDER_COLORS[genome[i].color] ?? 0xaaaaaa;
    const cssColor = '#' + hexColor.toString(16).padStart(6, '0');
    const isSelected = i === selectedIdx;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(${xPos[i]},${yPos[i]})`);
    g.classList.add('tree-node');
    if (isSelected) g.classList.add('selected');
    g.style.cursor = 'pointer';

    // Selection glow ring
    if (isSelected) {
      const glow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      glow.setAttribute('r', `${nodeR + 3}`);
      glow.setAttribute('fill', 'none');
      glow.setAttribute('stroke', 'var(--ui-accent)');
      glow.setAttribute('stroke-width', '2');
      glow.setAttribute('opacity', '0.7');
      g.appendChild(glow);
    }

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', `${nodeR}`);
    circle.setAttribute('fill', cssColor);
    circle.setAttribute('stroke', isSelected ? 'var(--ui-accent)' : 'rgba(255,255,255,0.2)');
    circle.setAttribute('stroke-width', isSelected ? '2' : '0.8');
    g.appendChild(circle);

    // Gene index label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('font-size', '7');
    text.setAttribute('font-family', 'var(--ui-font)');
    text.setAttribute('font-weight', '700');
    text.setAttribute('fill', 'rgba(255,255,255,0.85)');
    text.textContent = `${i}`;
    g.appendChild(text);

    g.addEventListener('click', () => onNodeClick(i));
    svg.appendChild(g);
  }

  return svg;
}


// ─── Bio Stats Calculation ───────────────────────────────────

interface BioStats {
  segCount: number;
  energyBalance: string;
  energyClass: string;
  mobility: string;
  mobilityClass: string;
  defense: string;
  attack: string;
  reproType: string;
  reproCost: string;
  longestChain: number;
}

function computeBioStats(genome: Genome): BioStats {
  const n = genome.length;

  let greenCount = 0, yellowCount = 0, redCount = 0, blueCount = 0, blackCount = 0;
  let blueHpTotal = 0;

  for (const gene of genome) {
    const l = gene.length;
    if (gene.color === SegmentColor.Green) greenCount++;
    if (gene.color === SegmentColor.Yellow) yellowCount++;
    if (gene.color === SegmentColor.Red) redCount++;
    if (gene.color === SegmentColor.Blue) { blueCount++; blueHpTotal += l * 600; }
    if (gene.color === SegmentColor.Black) blackCount++;
  }

  // Energy: photosynthesis gain minus drain (per sim second)
  // 1 green feeds 100 HP per 20 ticks = 100 HP/s per segment
  const photoRate = greenCount * 100; // HP/s
  const drainRate = getRootDrain(n); // HP per 22 ticks ~ /s approximately
  const netEnergy = photoRate - drainRate * (20 / 22);
  const energyBalance = netEnergy >= 0
    ? `+${Math.round(netEnergy)} HP/s`
    : `${Math.round(netEnergy)} HP/s`;
  const energyClass = netEnergy > 0 ? 'positive' : netEnergy < 0 ? 'negative' : 'neutral';

  // Mobility: yellow thrust impulse count per second
  const mobilityStr = yellowCount > 0
    ? `${yellowCount} thrust(s)/1.25s`
    : 'None';
  const mobilityClass = yellowCount > 0 ? 'positive' : 'neutral';

  // Defense: total blue HP
  const defenseStr = blueHpTotal > 0
    ? `+${Math.round(blueHpTotal)} HP`
    : 'None';

  // Attack: red segments
  const attackStr = redCount > 0
    ? `${redCount}× 400 dmg`
    : 'None';

  // Reproduction
  const hasBlack = blackCount > 0;
  const reproType = hasBlack ? 'Sexual' : 'Asexual';
  const reproCost = `${getReproCost(n)} HP`;

  // Longest chain
  const topology = buildGenomeTopology(genome);
  const maxDepth = Math.max(...topology.depth) + 1;

  return {
    segCount: n,
    energyBalance,
    energyClass,
    mobility: mobilityStr,
    mobilityClass,
    defense: defenseStr,
    attack: attackStr,
    reproType,
    reproCost,
    longestChain: maxDepth,
  };
}


// ─── Main UI Builder ─────────────────────────────────────────

export function createInspectorUI(
  engine: InspectorEngine,
  renderer: InspectorRenderer,
  editor: GenomeEditor,
): { setTheme(theme: 'dark' | 'light'): void } {
  injectInspectorStyles();

  let currentTheme: 'dark' | 'light' = 'dark';
  const fromSim = (() => {
    try {
      const raw = localStorage.getItem('repsim:inspector-context');
      if (raw) return JSON.parse(raw).fromSim === true;
    } catch { /* ok */ }
    return false;
  })();

  // ── Root UI wrapper ──
  const root = document.createElement('div');
  root.className = 'insp-ui';
  document.body.appendChild(root);

  // ╔══════════════════════════════════════╗
  // ║               TOP BAR               ║
  // ╚══════════════════════════════════════╝
  const topBar = document.createElement('div');
  topBar.id = 'insp-top-bar';

  const topLeft = document.createElement('div');
  topLeft.className = 'top-left';

  // Return to sim button
  const returnBtn = document.createElement('button');
  returnBtn.className = 'ui-btn';
  returnBtn.id = 'insp-return-btn';
  returnBtn.innerHTML = '← Sim';
  returnBtn.title = 'Return to simulation';
  returnBtn.style.display = fromSim ? '' : 'none';
  returnBtn.addEventListener('click', () => {
    const { genome, name, generation } = engine.getExportData();
    const payload = JSON.stringify({ v: 1, g: genome, gen: generation, n: name });
    try { localStorage.setItem('repsim:inspector-export', payload); } catch { /* ok */ }
    window.location.href = '/';
  });
  topLeft.appendChild(returnBtn);

  if (fromSim) {
    const sep = document.createElement('div');
    sep.className = 'insp-sep';
    topLeft.appendChild(sep);
  }

  const title = document.createElement('span');
  title.className = 'insp-title';
  title.textContent = '🔬 REP INSPECTOR';
  topLeft.appendChild(title);

  const topCenter = document.createElement('div');
  topCenter.className = 'top-center';

  const orgNameEl = document.createElement('span');
  orgNameEl.id = 'insp-org-name';
  orgNameEl.textContent = '—';
  topCenter.appendChild(orgNameEl);

  const genomeSizeEl = document.createElement('span');
  genomeSizeEl.id = 'insp-genome-size';
  genomeSizeEl.textContent = '';
  topCenter.appendChild(genomeSizeEl);

  const topRight = document.createElement('div');
  topRight.className = 'top-right';

  // Pause/play button
  const pauseBtn = document.createElement('button');
  pauseBtn.className = 'ui-btn-icon';
  pauseBtn.textContent = '⏸';
  pauseBtn.title = 'Pause / Resume (Space)';
  pauseBtn.addEventListener('click', () => {
    engine.setPaused(!engine.paused);
    pauseBtn.textContent = engine.paused ? '▶' : '⏸';
  });
  topRight.appendChild(pauseBtn);

  // Theme toggle
  const themeBtn = document.createElement('button');
  themeBtn.className = 'ui-btn-icon';
  const MOON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M21.64 13a1 1 0 00-1.05-.14 8.05 8.05 0 01-3.37.73A8.15 8.15 0 019.08 5.49a8.59 8.59 0 01.25-2 1 1 0 00-1.28-1.18A10 10 0 1021.93 14.12a1 1 0 00-.29-1.12z"/></svg>';
  const SUN_SVG  = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><circle cx="12" cy="12" r="4"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 5.64l2.12-2.12"/></svg>';
  themeBtn.innerHTML = MOON_SVG;
  themeBtn.title = 'Toggle light/dark mode';
  themeBtn.addEventListener('click', () => {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('light-theme', currentTheme === 'light');
    renderer.setTheme(currentTheme);
    themeBtn.innerHTML = currentTheme === 'dark' ? MOON_SVG : SUN_SVG;
  });
  topRight.appendChild(themeBtn);

  // Share button
  const shareBtn = document.createElement('button');
  shareBtn.className = 'ui-btn';
  shareBtn.textContent = 'Share ↗';
  shareBtn.title = 'Copy share URL to clipboard';
  shareBtn.addEventListener('click', () => {
    buildShareURL(engine).then(url => {
      if (!url) { showToast('Genome too large to share'); return; }
      navigator.clipboard?.writeText(url).then(() => {
        showToast('Share Link Copied To Clipboard!');
        const orig = shareBtn.textContent;
        shareBtn.textContent = 'Copied!';
        setTimeout(() => { shareBtn.textContent = orig; }, 1200);
      }).catch(() => {
        // Clipboard blocked (in-app browsers, non-HTTPS) — show URL in a selectable box
        const box = document.createElement('div');
        box.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--ui-bg-solid);border:1px solid var(--ui-border);border-radius:10px;padding:12px 14px;z-index:9999;display:flex;flex-direction:column;gap:6px;max-width:min(90vw,520px);box-shadow:0 4px 24px rgba(0,0,0,0.5);';
        const label = document.createElement('div');
        label.textContent = 'Copy link manually:';
        label.style.cssText = 'font-size:11px;color:var(--ui-text-dim);font-family:var(--ui-font);';
        const input = document.createElement('input');
        input.value = url;
        input.readOnly = true;
        input.style.cssText = 'width:100%;background:var(--ui-surface);border:1px solid var(--ui-border);border-radius:5px;padding:6px 8px;color:var(--ui-text);font-size:11px;font-family:monospace;box-sizing:border-box;outline:none;';
        box.appendChild(label);
        box.appendChild(input);
        document.body.appendChild(box);
        input.focus();
        input.select();
        // Dismiss on outside click or after 15s
        const dismiss = (e: Event) => { if (!box.contains(e.target as Node)) { box.remove(); document.removeEventListener('pointerdown', dismiss); } };
        setTimeout(() => { document.addEventListener('pointerdown', dismiss); }, 100);
        setTimeout(() => box.remove(), 15_000);
      });
    });
  });
  topRight.appendChild(shareBtn);

  topBar.appendChild(topLeft);
  topBar.appendChild(topCenter);
  topBar.appendChild(topRight);
  root.appendChild(topBar);

  // Space key for pause/play
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      engine.setPaused(!engine.paused);
      pauseBtn.textContent = engine.paused ? '▶' : '⏸';
    }
  });

  // ╔══════════════════════════════════════╗
  // ║            LEFT PANEL               ║
  // ╚══════════════════════════════════════╝
  const leftPanel = document.createElement('div');
  leftPanel.id = 'insp-left-panel';
  root.appendChild(leftPanel);

  // ── SVG Tree section ──
  const treeSection = document.createElement('div');
  treeSection.className = 'left-section';
  const treeTitleEl = document.createElement('div');
  treeTitleEl.className = 'left-section-title';
  treeTitleEl.textContent = 'Gene Tree';
  treeSection.appendChild(treeTitleEl);
  const treeContainer = document.createElement('div');
  treeContainer.style.cssText = 'overflow-x: auto;';
  treeSection.appendChild(treeContainer);
  leftPanel.appendChild(treeSection);

  // ── Gene cards section ──
  const cardsSection = document.createElement('div');
  cardsSection.className = 'left-section';
  const cardsTitleEl = document.createElement('div');
  cardsTitleEl.className = 'left-section-title';
  cardsTitleEl.textContent = 'Genome Sequence';
  cardsSection.appendChild(cardsTitleEl);
  const cardsContainer = document.createElement('div');
  cardsSection.appendChild(cardsContainer);
  leftPanel.appendChild(cardsSection);

  // ── Bio stats section ──
  const bioSection = document.createElement('div');
  bioSection.className = 'left-section';
  bioSection.style.borderBottom = 'none';
  const bioTitleEl = document.createElement('div');
  bioTitleEl.className = 'left-section-title';
  bioTitleEl.textContent = 'Biological Stats';
  bioSection.appendChild(bioTitleEl);
  const bioContainer = document.createElement('div');
  bioSection.appendChild(bioContainer);
  leftPanel.appendChild(bioSection);

  // ╔══════════════════════════════════════╗
  // ║            RIGHT PANEL              ║
  // ╚══════════════════════════════════════╝
  const rightPanel = document.createElement('div');
  rightPanel.id = 'insp-right-panel';
  root.appendChild(rightPanel);

  const rightSection = document.createElement('div');
  rightSection.className = 'right-section';

  const rightTitle = document.createElement('div');
  rightTitle.className = 'right-section-title';
  rightTitle.textContent = 'Segment Editor';
  rightSection.appendChild(rightTitle);

  // Empty state
  const rightPlaceholder = document.createElement('div');
  rightPlaceholder.className = 'right-placeholder';
  rightPlaceholder.textContent = 'Click a segment to inspect';
  rightSection.appendChild(rightPlaceholder);

  // Gene editor (hidden until gene selected)
  const geneEditor = document.createElement('div');
  geneEditor.id = 'insp-gene-editor';
  rightSection.appendChild(geneEditor);
  rightPanel.appendChild(rightSection);

  // ── Build gene editor contents ──
  // Gene meta info
  const geneMeta = document.createElement('div');
  geneMeta.className = 'gene-meta';
  geneEditor.appendChild(geneMeta);

  // Color picker
  const colorPickerTitle = document.createElement('div');
  colorPickerTitle.style.cssText = 'font-size:9px;font-weight:700;letter-spacing:.1em;color:var(--ui-text-muted);text-transform:uppercase;margin-bottom:5px;';
  colorPickerTitle.textContent = 'Color';
  geneEditor.appendChild(colorPickerTitle);

  const colorGrid = document.createElement('div');
  colorGrid.className = 'color-picker-grid';

  const colorButtons: HTMLButtonElement[] = [];
  for (let c = 0; c < 6; c++) {
    const btn = document.createElement('button');
    btn.className = 'color-btn';
    const hexColor = SEGMENT_RENDER_COLORS[c];
    const cssColor = '#' + hexColor.toString(16).padStart(6, '0');

    const dot = document.createElement('div');
    dot.className = 'color-btn-dot';
    dot.style.background = cssColor;

    const lbl = document.createElement('span');
    lbl.className = 'color-btn-label';
    lbl.textContent = COLOR_NAMES[c];

    btn.appendChild(dot);
    btn.appendChild(lbl);
    btn.addEventListener('click', () => {
      const idx = engine.selectedGeneIdx;
      if (idx === null) return;
      engine.setSegmentColor(idx, c as SegmentColor);
    });
    colorGrid.appendChild(btn);
    colorButtons.push(btn);
  }
  geneEditor.appendChild(colorGrid);

  // Angle slider
  const angleTitle = document.createElement('div');
  angleTitle.style.cssText = 'font-size:9px;font-weight:700;letter-spacing:.1em;color:var(--ui-text-muted);text-transform:uppercase;margin-bottom:5px;';
  angleTitle.textContent = 'Turn Angle';
  geneEditor.appendChild(angleTitle);

  const angleHint = document.createElement('div');
  angleHint.className = 'slider-hint';
  angleHint.innerHTML = '<span class="kbd-hint">Scroll <kbd>↕</kbd> to adjust</span>';
  geneEditor.appendChild(angleHint);

  const angleRow = document.createElement('div');
  angleRow.className = 'slider-row';
  const angleLabel = document.createElement('span');
  angleLabel.className = 'slider-label';
  angleLabel.textContent = 'Angle';
  const angleInput = document.createElement('input');
  angleInput.type = 'range';
  angleInput.min = `${-108}`;
  angleInput.max = `${108}`;
  angleInput.step = '1';
  angleInput.value = '0';
  const angleValue = document.createElement('span');
  angleValue.className = 'slider-value';
  angleValue.textContent = '0°';

  angleInput.addEventListener('input', () => {
    const idx = engine.selectedGeneIdx;
    if (idx === null || idx === 0) return;
    const deg = Number(angleInput.value);
    angleValue.textContent = `${deg}°`;
    engine.softSetAngle(idx, (deg * Math.PI) / 180);
  });
  angleInput.addEventListener('change', () => {
    const idx = engine.selectedGeneIdx;
    if (idx === null || idx === 0) return;
    engine.setSegmentAngle(idx, (Number(angleInput.value) * Math.PI) / 180);
  });
  angleRow.appendChild(angleLabel);
  angleRow.appendChild(angleInput);
  angleRow.appendChild(angleValue);
  geneEditor.appendChild(angleRow);

  // Length slider
  const lengthTitle = document.createElement('div');
  lengthTitle.style.cssText = 'font-size:9px;font-weight:700;letter-spacing:.1em;color:var(--ui-text-muted);text-transform:uppercase;margin:8px 0 5px;';
  lengthTitle.textContent = 'Length';
  geneEditor.appendChild(lengthTitle);

  const lengthHint = document.createElement('div');
  lengthHint.className = 'slider-hint';
  lengthHint.innerHTML = '<span class="kbd-hint"><kbd>Shift</kbd> + Scroll to adjust</span>';
  geneEditor.appendChild(lengthHint);

  const lengthRow = document.createElement('div');
  lengthRow.className = 'slider-row';
  const lengthLabel = document.createElement('span');
  lengthLabel.className = 'slider-label';
  lengthLabel.textContent = 'Length';
  const lengthInput = document.createElement('input');
  lengthInput.type = 'range';
  lengthInput.min = '0.4';
  lengthInput.max = '3.0';
  lengthInput.step = '0.05';
  lengthInput.value = '1.0';
  const lengthValue = document.createElement('span');
  lengthValue.className = 'slider-value';
  lengthValue.textContent = '×1.0';

  lengthInput.addEventListener('input', () => {
    const idx = engine.selectedGeneIdx;
    if (idx === null) return;
    const l = Number(lengthInput.value);
    lengthValue.textContent = `×${l.toFixed(1)}`;
    engine.softSetLength(idx, l); // smooth update during drag — topology only, no rebuild
  });
  lengthInput.addEventListener('change', () => {
    const idx = engine.selectedGeneIdx;
    if (idx === null) return;
    engine.setSegmentLength(idx, Number(lengthInput.value)); // commit on release
  });
  lengthRow.appendChild(lengthLabel);
  lengthRow.appendChild(lengthInput);
  lengthRow.appendChild(lengthValue);
  geneEditor.appendChild(lengthRow);

  // Action buttons (Add Child / Delete)
  const actionRow = document.createElement('div');
  actionRow.className = 'action-btn-row';

  const addChildBtn = document.createElement('button');
  addChildBtn.className = 'ui-btn';
  addChildBtn.textContent = '+ Add Child';
  addChildBtn.style.fontSize = '10px';
  addChildBtn.addEventListener('click', () => {
    const idx = engine.selectedGeneIdx;
    if (idx === null) return;
    const parentColor = engine.genome[idx].color;
    const angle = getDefaultChildAngle(parentColor as SegmentColor);
    const color = SegmentColor.Green; // default new gene color
    const length = getDefaultChildLength(color);
    engine.addChild(idx, color, angle, length);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'ui-btn danger';
  deleteBtn.textContent = '✂ Delete';
  deleteBtn.style.fontSize = '10px';
  deleteBtn.addEventListener('click', () => {
    const idx = engine.selectedGeneIdx;
    if (idx === null) return;
    if (idx === 0 && engine.genome.length === 1) {
      showToast('Cannot delete the only gene');
      return;
    }

    const children = buildGenomeTopology(engine.genome).children[idx];
    if (children.length > 0) {
      if (!confirm(`Delete Gene ${idx} and its ${children.length} descendant(s)?`)) return;
    }
    engine.deleteGene(idx);
  });

  actionRow.appendChild(addChildBtn);
  actionRow.appendChild(deleteBtn);
  geneEditor.appendChild(actionRow);

  // ╔══════════════════════════════════════╗
  // ║           BOTTOM PANEL              ║
  // ╚══════════════════════════════════════╝
  const bottomPanel = document.createElement('div');
  bottomPanel.id = 'insp-bottom-panel';
  root.appendChild(bottomPanel);

  // Palette section
  const paletteSection = document.createElement('div');
  paletteSection.className = 'palette-section';
  const paletteLabel = document.createElement('div');
  paletteLabel.className = 'palette-label';
  paletteLabel.textContent = 'Drag to Add';
  paletteSection.appendChild(paletteLabel);

  const paletteTiles = document.createElement('div');
  paletteTiles.className = 'palette-tiles';

  for (let c = 0; c < 6; c++) {
    const tile = document.createElement('div');
    tile.className = 'palette-tile';
    tile.draggable = true;
    tile.dataset.color = `${c}`;

    const circle = document.createElement('div');
    circle.className = 'palette-tile-circle';
    const hexColor = SEGMENT_RENDER_COLORS[c];
    circle.style.background = '#' + hexColor.toString(16).padStart(6, '0');

    const lbl = document.createElement('div');
    lbl.className = 'palette-tile-label';
    lbl.textContent = COLOR_NAMES[c];

    tile.appendChild(circle);
    tile.appendChild(lbl);

    tile.addEventListener('dragstart', (e: DragEvent) => {
      e.dataTransfer?.setData('text/plain', `${c}`);
      editor.startDrag(c);
      tile.style.opacity = '0.5';
    });
    tile.addEventListener('dragend', () => {
      editor.endDrag();
      tile.style.opacity = '';
    });

    paletteTiles.appendChild(tile);
  }
  paletteSection.appendChild(paletteTiles);
  bottomPanel.appendChild(paletteSection);

  // Separator
  const sep = document.createElement('div');
  sep.style.cssText = 'width:1px;height:64px;background:var(--ui-border);flex-shrink:0;';
  bottomPanel.appendChild(sep);

  // Presets section
  const presetsSection = document.createElement('div');
  presetsSection.className = 'presets-section';
  const presetsLabel = document.createElement('div');
  presetsLabel.className = 'presets-label';
  presetsLabel.textContent = 'New Rep';
  presetsSection.appendChild(presetsLabel);

  const presetsBtns = document.createElement('div');
  presetsBtns.className = 'presets-btns';

  const presets: Array<{ label: string; fn: () => Genome }> = [
    { label: 'Random', fn: randomInspectorGenome },
    { label: 'Minimal', fn: minimalGenome },
    { label: 'Bilateral', fn: symmetricalGenome },
  ];
  for (const preset of presets) {
    const btn = document.createElement('button');
    btn.className = 'ui-btn';
    btn.style.fontSize = '10px';
    btn.textContent = preset.label;
    btn.addEventListener('click', () => {
      engine.setGenome(preset.fn());
    });
    presetsBtns.appendChild(btn);
  }
  presetsSection.appendChild(presetsBtns);
  bottomPanel.appendChild(presetsSection);

  // ── Wire up callbacks ──────────────────────────────────────

  function updateGenomePanels(): void {
    const genome = engine.genome;
    const org = engine.getOrganism();

    // Top bar
    orgNameEl.textContent = org?.name ?? generateName(genome);
    genomeSizeEl.textContent = `${genome.length} gene${genome.length !== 1 ? 's' : ''}`;

    // SVG tree
    treeContainer.innerHTML = '';
    const svg = renderSVGTree(genome, engine.selectedGeneIdx, (idx) => {
      engine.selectGene(idx);
    });
    treeContainer.appendChild(svg);

    // Gene cards (DFS order)
    cardsContainer.innerHTML = '';
    // Build DFS order
    const children: number[][] = Array.from({ length: genome.length }, () => []);
    for (let i = 1; i < genome.length; i++) children[genome[i].parent].push(i);
    const dfsOrder: number[] = [];
    const stack = [0];
    while (stack.length) {
      const i = stack.pop()!;
      dfsOrder.push(i);
      for (let c = children[i].length - 1; c >= 0; c--) stack.push(children[i][c]);
    }

    for (const i of dfsOrder) {
      const gene = genome[i];
      const hex = SEGMENT_RENDER_COLORS[gene.color];
      const cssColor = '#' + hex.toString(16).padStart(6, '0');
      const isRoot = gene.parent === -1;

      const card = document.createElement('div');
      card.className = 'gene-card' + (i === engine.selectedGeneIdx ? ' selected' : '');
      card.style.cssText = 'flex-direction:column; align-items:stretch; gap:4px;';

      // Top row: dot + index + name + parent label
      const topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex; align-items:center; gap:6px; cursor:pointer;';

      const dot = document.createElement('div');
      dot.className = 'gene-card-dot';
      dot.style.background = cssColor;
      dot.style.boxShadow = `0 0 5px ${cssColor}55`;

      const idx = document.createElement('span');
      idx.className = 'gene-card-idx';
      idx.textContent = `${i}`;

      const info = document.createElement('span');
      info.className = 'gene-card-info';
      const parentStr = isRoot ? 'root' : `child of ${gene.parent}`;
      info.innerHTML = `<strong>${COLOR_NAMES[gene.color]}</strong> <span style="opacity:.55">${parentStr}</span>`;

      topRow.appendChild(dot);
      topRow.appendChild(idx);
      topRow.appendChild(info);
      topRow.addEventListener('click', () => engine.selectGene(i));
      card.appendChild(topRow);

      // Controls row: angle + length sliders (not shown for root angle)
      if (!isRoot) {
        const controls = document.createElement('div');
        controls.style.cssText = 'display:flex; flex-direction:column; gap:2px; padding:1px 2px 2px 16px; overflow:hidden;';

        // Angle control
        const angleRow = document.createElement('div');
        angleRow.style.cssText = 'display:flex; align-items:center; gap:5px;';
        const angleLabel = document.createElement('span');
        angleLabel.style.cssText = 'font-size:9px; color:var(--ui-text-muted); width:28px; flex-shrink:0;';
        angleLabel.textContent = 'Angle';
        const angleVal = document.createElement('span');
        angleVal.style.cssText = 'font-size:9px; color:var(--ui-text-dim); width:30px; text-align:right; flex-shrink:0; font-variant-numeric:tabular-nums;';
        const angleDeg = Math.round((gene.angle * 180) / Math.PI);
        angleVal.textContent = `${angleDeg > 0 ? '+' : ''}${angleDeg}°`;
        const angleSlider = document.createElement('input');
        angleSlider.type = 'range';
        angleSlider.min = '-108';
        angleSlider.max = '108';
        angleSlider.step = '1';
        angleSlider.value = String(angleDeg);
        angleSlider.style.cssText = 'flex:1; min-width:0; height:3px; accent-color:var(--ui-accent); cursor:pointer;';
        angleSlider.addEventListener('click', e => e.stopPropagation());
        angleSlider.addEventListener('input', () => {
          const deg = Number(angleSlider.value);
          angleVal.textContent = `${deg > 0 ? '+' : ''}${deg}°`;
          engine.softSetAngle(i, (deg * Math.PI) / 180);
        });
        angleSlider.addEventListener('change', () => {
          engine.setSegmentAngle(i, (Number(angleSlider.value) * Math.PI) / 180);
        });
        angleRow.appendChild(angleLabel);
        angleRow.appendChild(angleSlider);
        angleRow.appendChild(angleVal);
        controls.appendChild(angleRow);

        // Length control
        const lenRow = document.createElement('div');
        lenRow.style.cssText = 'display:flex; align-items:center; gap:5px;';
        const lenLabel = document.createElement('span');
        lenLabel.style.cssText = 'font-size:9px; color:var(--ui-text-muted); width:28px; flex-shrink:0;';
        lenLabel.textContent = 'Size';
        const lenVal = document.createElement('span');
        lenVal.style.cssText = 'font-size:9px; color:var(--ui-text-dim); width:26px; text-align:right; flex-shrink:0; font-variant-numeric:tabular-nums;';
        lenVal.textContent = `×${gene.length.toFixed(1)}`;
        const lenSlider = document.createElement('input');
        lenSlider.type = 'range';
        lenSlider.min = '0.4';
        lenSlider.max = '3.0';
        lenSlider.step = '0.1';
        lenSlider.value = String(gene.length.toFixed(1));
        lenSlider.style.cssText = 'flex:1; min-width:0; height:3px; accent-color:var(--ui-accent); cursor:pointer;';
        lenSlider.addEventListener('click', e => e.stopPropagation());
        lenSlider.addEventListener('input', () => {
          lenVal.textContent = `×${Number(lenSlider.value).toFixed(1)}`;
          engine.softSetLength(i, Number(lenSlider.value)); // smooth during drag
        });
        lenSlider.addEventListener('change', () => {
          engine.setSegmentLength(i, Number(lenSlider.value)); // commit on release
        });
        lenRow.appendChild(lenLabel);
        lenRow.appendChild(lenSlider);
        lenRow.appendChild(lenVal);
        controls.appendChild(lenRow);

        card.appendChild(controls);
      } else {
        // Root: just show size control (no angle since it's meaningless for root)
        const controls = document.createElement('div');
        controls.style.cssText = 'display:flex; flex-direction:column; gap:2px; padding:1px 2px 2px 16px; overflow:hidden;';
        const lenRow = document.createElement('div');
        lenRow.style.cssText = 'display:flex; align-items:center; gap:5px;';
        const lenLabel = document.createElement('span');
        lenLabel.style.cssText = 'font-size:9px; color:var(--ui-text-muted); width:28px; flex-shrink:0;';
        lenLabel.textContent = 'Size';
        const lenVal = document.createElement('span');
        lenVal.style.cssText = 'font-size:9px; color:var(--ui-text-dim); width:26px; text-align:right; flex-shrink:0; font-variant-numeric:tabular-nums;';
        lenVal.textContent = `×${gene.length.toFixed(1)}`;
        const lenSlider = document.createElement('input');
        lenSlider.type = 'range';
        lenSlider.min = '0.4';
        lenSlider.max = '3.0';
        lenSlider.step = '0.1';
        lenSlider.value = String(gene.length.toFixed(1));
        lenSlider.style.cssText = 'flex:1; min-width:0; height:3px; accent-color:var(--ui-accent); cursor:pointer;';
        lenSlider.addEventListener('click', e => e.stopPropagation());
        lenSlider.addEventListener('input', () => {
          lenVal.textContent = `×${Number(lenSlider.value).toFixed(1)}`;
          engine.softSetLength(i, Number(lenSlider.value)); // smooth during drag
        });
        lenSlider.addEventListener('change', () => {
          engine.setSegmentLength(i, Number(lenSlider.value)); // commit on release
        });
        lenRow.appendChild(lenLabel);
        lenRow.appendChild(lenSlider);
        lenRow.appendChild(lenVal);
        controls.appendChild(lenRow);
        card.appendChild(controls);
      }

      cardsContainer.appendChild(card);
    }

    // Bio stats
    const stats = computeBioStats(genome);
    bioContainer.innerHTML = '';
    const statDefs: Array<[string, string, string]> = [
      ['Segments', `${stats.segCount}`, 'neutral'],
      ['Energy/s', stats.energyBalance, stats.energyClass],
      ['Mobility', stats.mobility, stats.mobilityClass],
      ['Defense', stats.defense, stats.defense === 'None' ? 'neutral' : 'positive'],
      ['Attack', stats.attack, stats.attack === 'None' ? 'neutral' : 'neutral'],
      ['Repro', `${stats.reproType} — ${stats.reproCost}`, 'neutral'],
      ['Chain Depth', `${stats.longestChain}`, 'neutral'],
    ];
    for (const [label, value, cls] of statDefs) {
      const row = document.createElement('div');
      row.className = 'bio-stat-row';
      const labelEl = document.createElement('span');
      labelEl.className = 'bio-stat-label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = `bio-stat-value ${cls}`;
      valueEl.textContent = value;
      row.appendChild(labelEl);
      row.appendChild(valueEl);
      bioContainer.appendChild(row);
    }
  }

  function updateSegmentEditor(geneIdx: number | null): void {
    if (geneIdx === null) {
      rightPlaceholder.style.display = 'block';
      geneEditor.style.display = 'none';
      return;
    }

    const gene = engine.genome[geneIdx];
    if (!gene) return;

    rightPlaceholder.style.display = 'none';
    geneEditor.style.display = 'block';

    // Update meta info
    const hex = SEGMENT_RENDER_COLORS[gene.color];
    const cssColor = '#' + hex.toString(16).padStart(6, '0');
    const angleDeg = Math.round((gene.angle * 180) / Math.PI);
    const topology = buildGenomeTopology(engine.genome);

    geneMeta.innerHTML = `
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${cssColor};border:1px solid rgba(255,255,255,0.3);margin-right:4px;vertical-align:middle;"></span>
      <strong>Gene ${geneIdx}</strong> — ${COLOR_NAMES[gene.color]}<br>
      <span style="opacity:.6">${gene.parent === -1 ? '(root)' : `child of Gene ${gene.parent}`} · ${COLOR_ROLES[gene.color]}</span>
    `;

    // Color buttons
    colorButtons.forEach((btn, c) => {
      btn.classList.toggle('active', c === gene.color);
    });

    // Angle slider (root has no meaningful angle to change)
    const isRoot = geneIdx === 0;
    angleInput.disabled = isRoot;
    angleInput.value = `${angleDeg}`;
    angleValue.textContent = isRoot ? '(root)' : `${angleDeg > 0 ? '+' : ''}${angleDeg}°`;

    // Length slider
    lengthInput.value = `${gene.length}`;
    lengthValue.textContent = `×${gene.length.toFixed(1)}`;

    // Delete button: disable if it would remove all genes
    const isOnlyGene = engine.genome.length === 1;
    deleteBtn.disabled = isOnlyGene;
    deleteBtn.style.opacity = isOnlyGene ? '0.4' : '';
    deleteBtn.title = isOnlyGene ? 'Cannot delete the only gene' : `Delete Gene ${geneIdx}`;

    // Hint about descendants
    const childCount = topology.children[geneIdx]?.length ?? 0;
    const hasKids = childCount > 0;
    deleteBtn.textContent = hasKids ? `✂ Delete (+${childCount})` : '✂ Delete';
  }

  // ── Register engine callbacks ──
  engine.onGenomeChanged = () => {
    updateGenomePanels();
    // Re-sync segment editor if gene is still valid
    updateSegmentEditor(engine.selectedGeneIdx);
  };

  engine.onGeneSelected = (idx) => {
    updateSegmentEditor(idx);
    // Highlight selected gene card and tree node
    cardsContainer.querySelectorAll('.gene-card').forEach((el) => {
      // Cards are in DFS order, need to find the right one by data
      el.classList.remove('selected');
    });
    // Rebuild to update selection highlight (cheapest way given small genome size)
    updateGenomePanels();
  };

  // Initial render
  updateGenomePanels();
  updateSegmentEditor(null);

  // Mobile: tab bar + bottom sheet panels
  function setupMobileLayout(): void {
    const tabBar = document.createElement('div');
    tabBar.id = 'insp-tab-bar';

    let activeTab: 'genome' | 'edit' | null = null;

    function makeTab(label: string, key: 'genome' | 'edit'): HTMLButtonElement {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.className = 'insp-tab-btn';
      btn.addEventListener('click', () => {
        const leftPanel = document.getElementById('insp-left-panel')!;
        const rightPanel = document.getElementById('insp-right-panel')!;
        if (activeTab === key) {
          leftPanel.classList.remove('mobile-visible');
          rightPanel.classList.remove('mobile-visible');
          activeTab = null;
          renderer.setCameraForMobilePanel(null);
        } else {
          leftPanel.classList.toggle('mobile-visible', key === 'genome');
          rightPanel.classList.toggle('mobile-visible', key === 'edit');
          activeTab = key;
          renderer.setCameraForMobilePanel(window.innerHeight * 0.28);
        }
      });
      return btn;
    }

    tabBar.appendChild(makeTab('🧬 Genome', 'genome'));
    tabBar.appendChild(makeTab('✏️ Edit', 'edit'));
    document.body.appendChild(tabBar);

    // Dismiss sheet on tap outside panels
    document.addEventListener('pointerdown', (e) => {
      if (activeTab === null) return;
      const left = document.getElementById('insp-left-panel')!;
      const right = document.getElementById('insp-right-panel')!;
      if (
        !left.contains(e.target as Node) &&
        !right.contains(e.target as Node) &&
        !tabBar.contains(e.target as Node)
      ) {
        left.classList.remove('mobile-visible');
        right.classList.remove('mobile-visible');
        activeTab = null;
        renderer.setCameraForMobilePanel(null);
      }
    });
  }
  setupMobileLayout();

  return {
    setTheme(theme: 'dark' | 'light'): void {
      currentTheme = theme;
      document.documentElement.classList.toggle('light-theme', theme === 'light');
      renderer.setTheme(theme);
      themeBtn.innerHTML = theme === 'dark' ? MOON_SVG : SUN_SVG;
    },
  };
}
