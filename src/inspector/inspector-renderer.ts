/**
 * inspector-renderer.ts — PixiJS renderer for the Rep Inspector.
 *
 * A simplified renderer compared to the main sim:
 * - Single flat layer (no 2.5D blur)
 * - Circular "petri dish" with microscopy-style markings
 * - Selection ring with pulsing alpha around selected segment
 * - Ghost segment pill for drag-and-drop preview
 * - Auto-zoomed to fill the viewport with the circular tank
 */

import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';

// ─── Canvas Gradient Pill Textures ───────────────────────────

function hexToRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function lighten([r, g, b]: [number, number, number], t: number): string {
  return `rgba(${Math.min(255, Math.round(r + (255 - r) * t))},${Math.min(255, Math.round(g + (255 - g) * t))},${Math.min(255, Math.round(b + (255 - b) * t))},1)`;
}

function darken([r, g, b]: [number, number, number], t: number): string {
  return `rgba(${Math.round(r * (1 - t))},${Math.round(g * (1 - t))},${Math.round(b * (1 - t))},1)`;
}
import type { World, Organism } from '../types';
import {
  CANVAS_BG_COLOR,
  LIGHT_CANVAS_BG_COLOR,
  SEGMENT_RENDER_COLORS,
  SEGMENT_PILL_LENGTH,
  SEGMENT_PILL_WIDTH,
  SEGMENT_RADIUS,
} from '../constants';
import { INSPECTOR_TANK_RADIUS } from './inspector-engine';

export interface GhostState {
  worldX: number;
  worldY: number;
  color: number;          // SegmentColor value (0-5)
  snapTargetGeneIdx: number | null;  // gene index of snap target
}

export interface InspectorRenderer {
  app: Application;
  worldContainer: Container;

  render(world: World, selectedGeneIdx: number | null, ghost: GhostState | null, now: number): void;
  /** Call once per frame to apply the camera transform (handles pan/zoom). */
  updateCamera(): void;
  getCanvas(): HTMLCanvasElement;
  resize(width: number, height: number): void;
  setTheme(theme: 'dark' | 'light'): void;
  screenToWorld(sx: number, sy: number): { wx: number; wy: number };
  /** Return the zoom level so the editor can use it for hit detection. */
  getZoom(): number;
  /** Shift + zoom camera so tank is centred above an open mobile panel. Pass null to restore default. */
  setCameraForMobilePanel(sheetHeightPx: number | null): void;
}


// ─── Pill Textures ───────────────────────────────────────────

// High-res offscreen canvas size for gradient quality — drawn in this space then scaled to world units via sprite.scale
const PILL_TEX_PX = 128; // Fixed pixel width for all pill textures — sprite scale corrects world size

function createPillTextures(_app: Application, colorMap: Record<number, number>): Record<number, Texture> {
  const textures: Record<number, Texture> = {};
  const len = SEGMENT_PILL_LENGTH;
  const wid = SEGMENT_PILL_WIDTH;
  // Aspect ratio preserved: canvas height = PILL_TEX_PX * (wid/len)
  const PX_W = PILL_TEX_PX;
  const PX_H = Math.ceil(PILL_TEX_PX * (wid / len));
  const pr = PX_H / 2;  // pixel corner radius

  for (const [colorKey, hexColor] of Object.entries(colorMap)) {
    const canvas = document.createElement('canvas');
    canvas.width = PX_W;
    canvas.height = PX_H;
    const ctx = canvas.getContext('2d')!;
    const rgb = hexToRgb(hexColor);

    function pillPath(): void {
      ctx.beginPath();
      ctx.moveTo(pr, 0);
      ctx.lineTo(PX_W - pr, 0);
      ctx.arc(PX_W - pr, pr, pr, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(pr, PX_H);
      ctx.arc(pr, pr, pr, Math.PI / 2, 3 * Math.PI / 2);
      ctx.closePath();
    }

    // 1. Cylindrical body gradient: bright top → base → shadow bottom
    pillPath();
    const bodyGrad = ctx.createLinearGradient(0, 0, 0, PX_H);
    bodyGrad.addColorStop(0.00, lighten(rgb, 0.48));
    bodyGrad.addColorStop(0.25, lighten(rgb, 0.15));
    bodyGrad.addColorStop(0.65, darken(rgb, 0.12));
    bodyGrad.addColorStop(1.00, darken(rgb, 0.40));
    ctx.fillStyle = bodyGrad;
    ctx.fill();

    // 2. Specular gloss: soft white shine on upper third
    pillPath();
    const specGrad = ctx.createLinearGradient(0, 0, 0, PX_H * 0.45);
    specGrad.addColorStop(0.0, 'rgba(255,255,255,0.28)');
    specGrad.addColorStop(1.0, 'rgba(255,255,255,0.00)');
    ctx.fillStyle = specGrad;
    ctx.fill();

    // 3. Fine edge highlight
    pillPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    textures[Number(colorKey)] = Texture.from(canvas);
  }
  return textures;
}

// How much to multiply sprite.scale by so a PILL_TEX_PX-wide texture renders at SEGMENT_PILL_LENGTH world units
const PILL_SPRITE_SCALE = SEGMENT_PILL_LENGTH / PILL_TEX_PX;


// ─── Renderer Creation ───────────────────────────────────────

export async function createInspectorRenderer(width: number, height: number): Promise<InspectorRenderer> {
  const app = new Application();
  await app.init({
    width,
    height,
    backgroundColor: CANVAS_BG_COLOR,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });

  let screenWidth = width;
  let screenHeight = height;
  let currentTheme: 'dark' | 'light' = 'dark';

  // ── World container (camera transform applied here) ──
  const worldContainer = new Container();
  app.stage.addChild(worldContainer);
  worldContainer.x = width / 2;
  worldContainer.y = height / 2;

  // Compute default zoom to fit circular tank with 8% margin
  function computeDefaultZoom(): number {
    return Math.min(screenWidth, screenHeight) * 0.46 / INSPECTOR_TANK_RADIUS;
  }

  // Camera state
  const camera = { x: 0, y: 0, zoom: computeDefaultZoom() };
  const ZOOM_SPEED = 0.1;
  const ZOOM_MIN = 0.05;
  const ZOOM_MAX = 30;

  // Animated camera targets for mobile panel open/close (null = no animation active)
  let targetCameraZoom: number | null = null;
  let targetCameraY:   number | null = null;

  function applyCamera(): void {
    worldContainer.scale.set(camera.zoom);
    worldContainer.x = screenWidth / 2 - camera.x * camera.zoom;
    worldContainer.y = screenHeight / 2 - camera.y * camera.zoom;
  }
  applyCamera();

  // Convenience getter so existing code can read zoom for line widths
  function getZoom(): number { return camera.zoom; }

  // ── Camera input — right-click drag to pan, wheel to zoom ──
  const canvas = app.canvas as HTMLCanvasElement;
  let isPanning = false;
  let lastPanX = 0;
  let lastPanY = 0;

  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button === 1 || e.button === 2) {
      isPanning = true;
      lastPanX = e.clientX;
      lastPanY = e.clientY;
      e.preventDefault();
    }
  });

  canvas.addEventListener('mousemove', (e: MouseEvent) => {
    if (isPanning) {
      camera.x -= (e.clientX - lastPanX) / camera.zoom;
      camera.y -= (e.clientY - lastPanY) / camera.zoom;
      lastPanX = e.clientX;
      lastPanY = e.clientY;
    }
  });

  canvas.addEventListener('mouseup', (e: MouseEvent) => {
    if (e.button === 1 || e.button === 2) isPanning = false;
  });

  canvas.addEventListener('mouseleave', () => { isPanning = false; });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e: WheelEvent) => {
    if (e.altKey || e.shiftKey) return; // let genome-editor handle Alt/Shift+scroll
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    // World position under cursor before zoom
    const wx0 = (sx - screenWidth / 2) / camera.zoom + camera.x;
    const wy0 = (sy - screenHeight / 2) / camera.zoom + camera.y;
    // Apply zoom
    const factor = 1 + (e.deltaY < 0 ? ZOOM_SPEED : -ZOOM_SPEED);
    camera.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, camera.zoom * factor));
    // Keep world point under cursor fixed
    const wx1 = (sx - screenWidth / 2) / camera.zoom + camera.x;
    const wy1 = (sy - screenHeight / 2) / camera.zoom + camera.y;
    camera.x += wx0 - wx1;
    camera.y += wy0 - wy1;
  }, { passive: false });

  // ── Petri dish background ──
  const dishGraphics = new Graphics();
  worldContainer.addChild(dishGraphics);

  function drawDish(): void {
    const r = INSPECTOR_TANK_RADIUS;
    dishGraphics.clear();

    // Main fill
    const bgColor = currentTheme === 'dark' ? 0x0d1022 : 0xf0f2f8;
    dishGraphics.circle(0, 0, r);
    dishGraphics.fill({ color: bgColor });

    // Concentric depth rings (microscopy style)
    const ringAlpha = currentTheme === 'dark' ? 0.06 : 0.08;
    const ringColor = currentTheme === 'dark' ? 0x8899cc : 0x6677aa;
    for (const ringR of [r * 0.33, r * 0.66, r]) {
      dishGraphics.circle(0, 0, ringR);
      dishGraphics.stroke({ color: ringColor, alpha: ringAlpha, width: 0.5 / camera.zoom });
    }

    // Center crosshair
    const crossAlpha = currentTheme === 'dark' ? 0.07 : 0.1;
    const crossLen = r * 0.08;
    const lineW = 0.5 / camera.zoom;
    dishGraphics.moveTo(-crossLen, 0);
    dishGraphics.lineTo(crossLen, 0);
    dishGraphics.stroke({ color: ringColor, alpha: crossAlpha, width: lineW });
    dishGraphics.moveTo(0, -crossLen);
    dishGraphics.lineTo(0, crossLen);
    dishGraphics.stroke({ color: ringColor, alpha: crossAlpha, width: lineW });

    // Outer border ring (glass edge effect)
    const rimColor = currentTheme === 'dark' ? 0x3344aa : 0x8899cc;
    dishGraphics.circle(0, 0, r);
    dishGraphics.stroke({ color: rimColor, alpha: 0.6, width: 2.5 / camera.zoom });

    // Inner rim subtle glow
    dishGraphics.circle(0, 0, r - 3 / camera.zoom);
    dishGraphics.stroke({ color: rimColor, alpha: 0.15, width: 1.5 / camera.zoom });
  }

  drawDish();

  // ── Segment sprite pool ──
  const segmentContainer = new Container();
  worldContainer.addChild(segmentContainer);

  const SPRITE_POOL_SIZE = 200;
  const spritePool: Sprite[] = [];
  let segmentTextures: Record<number, Texture> = {};

  function initSprites(): void {
    segmentTextures = createPillTextures(app, SEGMENT_RENDER_COLORS);
    for (let i = 0; i < SPRITE_POOL_SIZE; i++) {
      const s = new Sprite();
      s.anchor.set(0.5);
      s.visible = false;
      segmentContainer.addChild(s);
      spritePool.push(s);
    }
  }

  initSprites();
  let spritesActive = 0;

  // ── Selection ring / snap ring overlay ──
  const overlayGraphics = new Graphics();
  worldContainer.addChild(overlayGraphics);

  // Previous sprite rotations (for stable rotation when segments overlap)
  const prevRotations: number[] = new Array(SPRITE_POOL_SIZE).fill(0);

  // ── Render function ──
  function render(world: World, selectedGeneIdx: number | null, ghost: GhostState | null, now: number): void {
    // Reset sprite visibility
    for (let i = 0; i < spritesActive; i++) {
      spritePool[i].visible = false;
    }
    spritesActive = 0;

    overlayGraphics.clear();

    for (const org of world.organisms.values()) {
      if (!org.alive) continue;
      const seg = world.segments;

      // Per-organism: precompute rotation basis from orientationAngle + topology.
      // Pills must face their genome cumulative angle (same direction the physics uses for
      // cap-focus placement), NOT atan2(self − parent).  With the cap-focus formula
      // child_center − parent_center is a blend of parent and child genome directions,
      // so atan2(self−parent) lies between them and drifts as the parent rotates.
      const topology = org.topology;
      const cosOri = Math.cos(org.orientationAngle);
      const sinOri = Math.sin(org.orientationAngle);

      for (let i = 0; i < org.segmentCount; i++) {
        const idx = org.firstSegment + i;
        if (!seg.alive[idx]) continue;

        const sprite = spritePool[spritesActive];
        if (!sprite) break;

        const colorKey = seg.color[idx];
        sprite.texture = segmentTextures[colorKey] ?? segmentTextures[0];
        sprite.x = seg.x[idx];
        sprite.y = seg.y[idx];

        // Pill rotation: genome cumulative world angle = orientationAngle + cumulative gene angles.
        // This exactly matches the direction used in enforceAngularConstraints so the rendered
        // cap tip stays locked to the physics connection point as segments rotate.
        const cosA = cosOri * topology.cosCumAngle[i] - sinOri * topology.sinCumAngle[i];
        const sinA = sinOri * topology.cosCumAngle[i] + cosOri * topology.sinCumAngle[i];
        const angle = Math.atan2(sinA, cosA);
        sprite.rotation = angle;
        prevRotations[spritesActive] = angle;

        // Scale from gene length — multiply by PILL_SPRITE_SCALE to correct for high-res texture size
        const lengthMult = org.genome[i]?.length ?? 1;
        const widthMult = 1 + (lengthMult - 1) * 0.35;
        const rootBonus = seg.isRoot[idx] ? 1.15 : 1.0;
        sprite.scale.set(rootBonus * lengthMult * PILL_SPRITE_SCALE, rootBonus * widthMult * PILL_SPRITE_SCALE);

        // Dim non-selected segments when a gene is selected
        if (selectedGeneIdx !== null) {
          sprite.alpha = i === selectedGeneIdx ? 1.0 : 0.45;
        } else {
          sprite.alpha = 1.0;
        }

        sprite.tint = 0xFFFFFF;
        sprite.visible = true;
        spritesActive++;

        // Selection ring around selected gene
        if (i === selectedGeneIdx) {
          const pulse = 0.55 + 0.45 * Math.sin(now * 4.0);
          const ringRadius = SEGMENT_RADIUS * 1.7 * rootBonus;
          const ringColor = currentTheme === 'dark' ? 0x6b8aff : 0x4f6be8;
          overlayGraphics.circle(seg.x[idx], seg.y[idx], ringRadius);
          overlayGraphics.stroke({ color: ringColor, alpha: pulse, width: 2.0 / camera.zoom });
        }
      }
    }

    // Snap target highlight (while dragging from palette)
    if (ghost?.snapTargetGeneIdx !== null && ghost?.snapTargetGeneIdx !== undefined) {
      const org = world.organisms.values().next().value as Organism | undefined;
      if (org) {
        const idx = org.firstSegment + ghost.snapTargetGeneIdx;
        const seg = world.segments;
        if (seg.alive[idx]) {
          const snapRadius = SEGMENT_RADIUS * 2.0;
          overlayGraphics.circle(seg.x[idx], seg.y[idx], snapRadius);
          overlayGraphics.stroke({ color: 0x44ff88, alpha: 0.9, width: 2.5 / camera.zoom });
          overlayGraphics.circle(seg.x[idx], seg.y[idx], snapRadius * 1.4);
          overlayGraphics.stroke({ color: 0x44ff88, alpha: 0.35, width: 1.0 / camera.zoom });
        }
      }
    }

    // Ghost segment pill (shows where drag-dropped gene would land)
    if (ghost && ghost.snapTargetGeneIdx !== null) {
      const ghostHex = SEGMENT_RENDER_COLORS[ghost.color] ?? 0xffffff;
      const r = SEGMENT_RADIUS * 0.9;
      const halfLen = SEGMENT_PILL_LENGTH * 0.45;
      overlayGraphics.roundRect(
        ghost.worldX - halfLen, ghost.worldY - r,
        halfLen * 2, r * 2,
        r,
      );
      overlayGraphics.fill({ color: ghostHex, alpha: 0.55 });
      overlayGraphics.roundRect(
        ghost.worldX - halfLen, ghost.worldY - r,
        halfLen * 2, r * 2,
        r,
      );
      overlayGraphics.stroke({ color: 0xffffff, alpha: 0.25, width: 1.0 / camera.zoom });
    }
  }

  function screenToWorld(sx: number, sy: number): { wx: number; wy: number } {
    return {
      wx: (sx - screenWidth / 2) / camera.zoom + camera.x,
      wy: (sy - screenHeight / 2) / camera.zoom + camera.y,
    };
  }

  function resize(w: number, h: number): void {
    const oldDefault = computeDefaultZoom(); // compute before updating dimensions
    screenWidth = w;
    screenHeight = h;
    app.renderer.resize(w, h);
    const newDefault = computeDefaultZoom();
    camera.zoom = camera.zoom * (newDefault / oldDefault);
    applyCamera();
    drawDish();
  }

  function setTheme(theme: 'dark' | 'light'): void {
    currentTheme = theme;
    app.renderer.background.color = theme === 'dark' ? CANVAS_BG_COLOR : LIGHT_CANVAS_BG_COLOR;
    drawDish();
  }

  // Apply camera each frame (called from render loop after physics)
  function updateCamera(): void {
    // Lerp toward mobile panel targets (no-op when both null)
    if (targetCameraZoom !== null) {
      camera.zoom += (targetCameraZoom - camera.zoom) * 0.15;
      if (Math.abs(targetCameraZoom - camera.zoom) < 0.0005) {
        camera.zoom = targetCameraZoom;
        targetCameraZoom = null;
      }
    }
    if (targetCameraY !== null) {
      camera.y += (targetCameraY - camera.y) * 0.15;
      if (Math.abs(targetCameraY - camera.y) < 0.5) {
        camera.y = targetCameraY;
        targetCameraY = null;
      }
    }
    applyCamera();
  }

  function setCameraForMobilePanel(sheetHeightPx: number | null): void {
    if (sheetHeightPx === null) {
      targetCameraZoom = computeDefaultZoom();
      targetCameraY = 0;
    } else {
      const TAB_BAR_H = 52;
      const TOP_BAR_H = 40;
      const availH = screenHeight - TAB_BAR_H - sheetHeightPx - TOP_BAR_H;
      const newZoom = Math.min(screenWidth, availH) * 0.40 / INSPECTOR_TANK_RADIUS;
      targetCameraZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
      const availCentreScreenY = TOP_BAR_H + availH / 2;
      targetCameraY = (screenHeight / 2 - availCentreScreenY) / targetCameraZoom;
    }
  }

  return {
    app,
    worldContainer,
    render,
    updateCamera,
    getCanvas: () => app.canvas as HTMLCanvasElement,
    resize,
    setTheme,
    screenToWorld,
    getZoom: getZoom,
    setCameraForMobilePanel,
  };
}
