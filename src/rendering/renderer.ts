/**
 * renderer.ts — PixiJS rendering engine
 *
 * Draws the simulation world to a canvas using PixiJS v8.
 *
 * Architecture:
 * - Application: The PixiJS app — manages the canvas and WebGL context
 * - worldContainer: Holds everything in "world space"
 *   Camera zoom/pan is applied by transforming this container
 * - 7 blur layers: Each is a Container with a BlurFilter of different strength.
 *   Deeper organisms go on blurrier layers, creating a 2.5D depth effect
 *   like looking down into a petri dish through a microscope.
 *   Fine blur gradations (step of 1.0) make transitions smooth as organisms
 *   drift between depths. Alpha is per-sprite for additional smooth transitions.
 * - Segments are pill/capsule shaped (not circles) and rotated to face
 *   along the chain direction — each organism looks like a segmented creature.
 *
 * Performance approach:
 * - Pre-generate pill texture per color (5 textures total)
 * - Per-layer sprite pools: reuse Sprite objects instead of creating/destroying
 * - Only iterate alive organisms and segments
 */

import { Application, Container, Graphics, Sprite, Texture, BlurFilter, ColorMatrixFilter } from 'pixi.js';
import type { World, Camera as CameraState, LightSource, TemperatureSource } from '../types';
import { ToolMode } from '../types';
import { createCamera, zoomCamera, panCamera } from './camera';
import { createEffects, type RenderableGhost, type RenderablePulse } from './effects';
import { effectsQueue } from '../simulation/world';
import {
  CANVAS_BG_COLOR,
  TANK_BG_COLOR,
  TANK_EDGE_COLOR,
  LIGHT_CANVAS_BG_COLOR,
  LIGHT_TANK_BG_COLOR,
  LIGHT_TANK_EDGE_COLOR,
  LIGHT_TANK_GRID_COLOR,
  TANK_GRID_COLOR,
  TANK_GRID_SPACING,
  TANK_MAX_EXTENT,
  SEGMENT_RENDER_COLORS,
  SEGMENT_PILL_LENGTH,
  SEGMENT_PILL_WIDTH,
  SEGMENT_RADIUS,
  BLUR_LAYER_COUNT,
  BLUR_LAYER_STRENGTHS,
  BLUR_LAYER_ALPHAS,
  BLUR_LAYER_QUALITY,
  DEPTH_SCALE_MIN,
  DEPTH_SCALE_MAX,
  DEPTH_ALPHA_MIN,
  DEPTH_ALPHA_MAX,
  MAX_LIGHT_SOURCES,
  MAX_TEMPERATURE_SOURCES,
  LIGHT_DEFAULT_RADIUS,
  LIGHT_DEFAULT_INTENSITY,
  LIGHT_MIN_RADIUS,
  LIGHT_MAX_RADIUS,
  LIGHT_RESIZE_SPEED,
  TEMP_DEFAULT_RADIUS,
  TEMP_DEFAULT_INTENSITY,
  TEMP_MIN_RADIUS,
  TEMP_MAX_RADIUS,
  TEMP_RESIZE_SPEED,
  FOOD_MAX_PARTICLES,
  FOOD_PARTICLE_RADIUS,
  FOOD_RENDER_COLOR,
  FOOD_DECAY_TICKS,
  VIRUS_SWELLING_FACTOR,
  VIRUS_DARK_RENDER_COLORS,
  PARALLAX_STRENGTH,
  PARALLAX_MAX_OFFSET,
} from '../constants';
import { VirusEffect } from '../types';
import { computeLight } from '../simulation/environment';


// ─── Types ───────────────────────────────────────────────────

/**
 * A blur layer holds one Container (with a BlurFilter) and a pool of sprites.
 * Organisms are assigned to layers based on their depth in the dish.
 * Deeper organisms → blurrier layers, creating a 2.5D microscope effect.
 */
interface BlurLayer {
  container: Container;   // PixiJS container with blur filter applied
  sprites: Sprite[];      // Pool of reusable sprites for this layer
  active: number;         // How many sprites are in use this frame
}

export interface Renderer {
  app: Application;
  camera: CameraState;
  worldContainer: Container;
  focusDepth: number;
  selectedOrganismId: number | null;
  onOrganismSelected: ((id: number | null) => void) | null;
  toolMode: ToolMode;
  selectedSourceType: 'light' | 'temperature' | null;
  selectedSourceId: number | null;
  onSourceSelected: ((type: 'light' | 'temperature' | null, id: number | null) => void) | null;
  render(world: World, alpha: number): void;
  destroy(): void;
  getCanvas(): HTMLCanvasElement;
  resize(width: number, height: number): void;
  setFocusDepth(depth: number): void;
  setWallsDirty(): void;
  setTheme(theme: 'dark' | 'light'): void;
  setDesaturated(on: boolean): void;
  setToolMode(mode: ToolMode): void;
}


// ─── Renderer Creation ───────────────────────────────────────

export async function createRenderer(width: number, height: number): Promise<Renderer> {
  // ── Initialize PixiJS ──
  const app = new Application();
  await app.init({
    width,
    height,
    backgroundColor: CANVAS_BG_COLOR,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });

  // ── World Container (camera transform applied here) ──
  const worldContainer = new Container();
  app.stage.addChild(worldContainer);
  worldContainer.x = width / 2;
  worldContainer.y = height / 2;

  const camera = createCamera();

  // ── Tank Cell Graphics (cell-based dynamic tank shape) ──
  const tankCellsGraphics = new Graphics();  // Filled backgrounds per cell
  worldContainer.addChild(tankCellsGraphics);

  const tankGridGraphics = new Graphics();   // Grid lines within tank cells
  worldContainer.addChild(tankGridGraphics);

  // wallsDirty triggers full cell redraw
  let wallsDirty = true;

  // ── 7 Blur Layers (fine gradations for smooth transitions) ──
  // Wrapped in a masked container so parallax-shifted sprites are clipped to the tank shape
  const blurLayerWrapper = new Container();
  worldContainer.addChild(blurLayerWrapper);

  const blurMask = new Graphics();
  blurLayerWrapper.addChild(blurMask);
  blurLayerWrapper.mask = blurMask;

  const blurLayers: BlurLayer[] = [];

  for (let i = 0; i < BLUR_LAYER_COUNT; i++) {
    const container = new Container();
    const strength = BLUR_LAYER_STRENGTHS[i];

    if (strength > 0) {
      const filter = new BlurFilter({ strength, quality: BLUR_LAYER_QUALITY });
      container.filters = [filter];
    }

    container.alpha = BLUR_LAYER_ALPHAS[i];

    blurLayerWrapper.addChild(container);
    blurLayers.push({ container, sprites: [], active: 0 });
  }

  // ── Selection highlight layer (on top of organisms, below tank edge) ──
  const selectionGraphics = new Graphics();
  worldContainer.addChild(selectionGraphics);

  // ── Tank Outline (on top of everything for "looking into tank" effect) ──
  // Dynamically traces the boundary of tank cells
  const tankOutlineGraphics = new Graphics();
  worldContainer.addChild(tankOutlineGraphics);

  // ── Box-select preview overlay (drawn on top of outline during drag) ──
  const boxPreviewGraphics = new Graphics();
  worldContainer.addChild(boxPreviewGraphics);

  // ── Pre-create pill textures for each segment color ──
  const segmentTextures = createPillTextures(app);

  // ── Dark infection textures (one per virus target color) ──
  const infectionTextures = createPillTextures(app, VIRUS_DARK_RENDER_COLORS);

  // ── Food particle textures (small circle, dark + light variants) ──
  const foodTextureDark = createFoodTexture(app, FOOD_RENDER_COLOR);
  const foodTextureLight = createFoodTexture(app, 0x887755); // Darker for light mode

  // ── Viral food textures — one per segment color (using dark infection colors) ──
  const viralFoodTextures: Record<number, Texture> = {};
  for (const [colorKey, hexColor] of Object.entries(VIRUS_DARK_RENDER_COLORS)) {
    viralFoodTextures[Number(colorKey)] = createFoodTexture(app, hexColor);
  }

  // ── Track screen dimensions ──
  let screenWidth = width;
  let screenHeight = height;

  // ── Focus depth state ──
  let focusDepth = 1.0;

  // ── Theme state ──
  let currentTheme: 'dark' | 'light' = 'dark';
  let isDesaturated = false;

  // ── Effects system ──
  const effects = createEffects();
  const ghostBuffer: RenderableGhost[] = [];
  const pulseBuffer: RenderablePulse[] = [];
  const effectsGraphics = new Graphics();
  // Insert before selectionGraphics (after blur layers)
  worldContainer.addChildAt(effectsGraphics, worldContainer.children.indexOf(selectionGraphics));

  // ── Selection state ──
  let selectedOrganismId: number | null = null;
  let onOrganismSelected: ((id: number | null) => void) | null = null;

  // ── Wall editing state (box-select) ──
  let isEditingWalls = false;
  let wallPaintMode: 'add' | 'remove' = 'add';
  let boxStartCol = 0;
  let boxStartRow = 0;
  let boxEndCol = 0;
  let boxEndRow = 0;
  let currentWorld: World | null = null; // set each render frame

  // ── Tool mode state ──
  let toolMode: ToolMode = ToolMode.Select;
  let selectedSourceType: 'light' | 'temperature' | null = null;
  let selectedSourceId: number | null = null;
  let isDraggingSource = false;
  let onSourceSelected: ((type: 'light' | 'temperature' | null, id: number | null) => void) | null = null;

  // ── Per-segment light cache (recomputed per sim tick) ──
  let segmentLightCache: Float32Array | null = null;
  let lightCacheTick = -1;

  // ── Environment Container (between tank cells and blur layers, masked to tank) ──
  const environmentContainer = new Container();
  worldContainer.addChildAt(environmentContainer, worldContainer.children.indexOf(blurLayerWrapper));

  // Mask environment to tank cell shape (redrawn when wallsDirty)
  const envMask = new Graphics();
  environmentContainer.addChild(envMask);
  environmentContainer.mask = envMask;

  // Dark overlay — visible only when light sources exist (redrawn when wallsDirty)
  const darkOverlay = new Graphics();
  darkOverlay.visible = false;
  environmentContainer.addChild(darkOverlay);

  // Sprite pools for environment sources
  const lightSprites: Sprite[] = [];
  const tempSprites: Sprite[] = [];

  // Pre-generate gradient textures for soft environment overlays
  const lightGlowTexture = createRadialGradientTexture(256, [
    [0, 'rgba(255,250,230,0.8)'],
    [0.2, 'rgba(255,245,210,0.4)'],
    [0.6, 'rgba(255,235,180,0.1)'],
    [1, 'rgba(255,235,180,0)'],
  ]);
  // Shadow texture for light-mode: light sources become shadow zones
  // Made more opaque so shadows are clearly visible
  const lightShadowTexture = createRadialGradientTexture(256, [
    [0, 'rgba(0,0,0,0.45)'],
    [0.3, 'rgba(0,0,0,0.25)'],
    [0.7, 'rgba(0,0,0,0.08)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  const tempHotTexture = createRadialGradientTexture(256, [
    [0, 'rgba(255,80,50,0.2)'],
    [0.4, 'rgba(255,60,40,0.08)'],
    [1, 'rgba(255,60,40,0)'],
  ]);
  const tempColdTexture = createRadialGradientTexture(256, [
    [0, 'rgba(50,80,255,0.2)'],
    [0.4, 'rgba(40,60,255,0.08)'],
    [1, 'rgba(40,60,255,0)'],
  ]);

  // ── Camera Input ──
  const canvas = app.canvas as HTMLCanvasElement;
  let isPanning = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  /** Convert screen coordinates to world coordinates */
  function screenToWorld(screenX: number, screenY: number): { wx: number; wy: number } {
    return {
      wx: (screenX - screenWidth / 2) / camera.zoom + camera.x,
      wy: (screenY - screenHeight / 2) / camera.zoom + camera.y,
    };
  }

  /** Get grid cell from world coordinates (origin-centered) */
  function worldToGridCell(wx: number, wy: number): { col: number; row: number } {
    return {
      col: Math.floor(wx / TANK_GRID_SPACING),
      row: Math.floor(wy / TANK_GRID_SPACING),
    };
  }

  /** Get the cell key for a grid cell */
  function cellKey(col: number, row: number): string {
    return `${col},${row}`;
  }

  /** Check if a grid cell is within the max tank extent */
  function isValidGridCell(col: number, row: number): boolean {
    const maxCells = Math.floor(TANK_MAX_EXTENT / TANK_GRID_SPACING);
    return col >= -maxCells && col <= maxCells && row >= -maxCells && row <= maxCells;
  }

  /** Convert clientX/clientY to a grid cell (col, row) */
  function clientToGridCell(clientX: number, clientY: number): { col: number; row: number } | null {
    const rect = canvas.getBoundingClientRect();
    const scaleX = screenWidth / rect.width;
    const scaleY = screenHeight / rect.height;
    const sx = (clientX - rect.left) * scaleX;
    const sy = (clientY - rect.top) * scaleY;
    const { wx, wy } = screenToWorld(sx, sy);
    const { col, row } = worldToGridCell(wx, wy);
    if (!isValidGridCell(col, row)) return null;
    return { col, row };
  }

  /** Apply all cells in the box-select rectangle (called on mouseup) */
  function applyBoxSelect(): void {
    if (!currentWorld) return;
    const minC = Math.min(boxStartCol, boxEndCol);
    const maxC = Math.max(boxStartCol, boxEndCol);
    const minR = Math.min(boxStartRow, boxEndRow);
    const maxR = Math.max(boxStartRow, boxEndRow);
    for (let c = minC; c <= maxC; c++) {
      for (let r = minR; r <= maxR; r++) {
        if (!isValidGridCell(c, r)) continue;
        const key = cellKey(c, r);
        if (wallPaintMode === 'add') {
          currentWorld.tankCells.add(key);
        } else {
          currentWorld.tankCells.delete(key);
        }
      }
    }
    currentWorld.tankCellsDirty = true;
    wallsDirty = true;
    boxPreviewGraphics.clear();
  }

  // Wheel: Alt+scroll = focus depth, source selected = resize radius, regular scroll = zoom
  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    if (e.altKey) {
      // Adjust focus depth
      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      focusDepth = Math.max(0, Math.min(1, focusDepth + delta));
      renderer.focusDepth = focusDepth;
      canvas.dispatchEvent(new CustomEvent('focusdepthchange', { detail: focusDepth }));
    } else if (selectedSourceId !== null && currentWorld) {
      // Resize selected source radius
      const sources = selectedSourceType === 'light'
        ? currentWorld.lightSources
        : currentWorld.temperatureSources;
      const src = sources.find(s => s.id === selectedSourceId);
      if (src) {
        const isLight = selectedSourceType === 'light';
        const speed = isLight ? LIGHT_RESIZE_SPEED : TEMP_RESIZE_SPEED;
        const minR = isLight ? LIGHT_MIN_RADIUS : TEMP_MIN_RADIUS;
        const maxR = isLight ? LIGHT_MAX_RADIUS : TEMP_MAX_RADIUS;
        const delta = e.deltaY > 0 ? -speed : speed;
        src.radius = Math.max(minR, Math.min(maxR, src.radius + delta));
        if (onSourceSelected) onSourceSelected(selectedSourceType, selectedSourceId);
      }
    } else {
      const rect = canvas.getBoundingClientRect();
      const scaleX = screenWidth / rect.width;
      const scaleY = screenHeight / rect.height;
      zoomCamera(
        camera,
        -e.deltaY,
        (e.clientX - rect.left) * scaleX,
        (e.clientY - rect.top) * scaleY,
        screenWidth,
        screenHeight,
      );
    }
  }, { passive: false });

  /** Handle organism selection click */
  function handleSelectClick(wx: number, wy: number): void {
    if (!currentWorld) return;
    let bestId: number | null = null;
    let bestDist = 20;
    const seg = currentWorld.segments;
    for (const org of currentWorld.organisms.values()) {
      if (!org.alive) continue;
      for (let i = 0; i < org.segmentCount; i++) {
        const idx = org.firstSegment + i;
        if (!seg.alive[idx]) continue;
        const dx = seg.x[idx] - wx;
        const dy = seg.y[idx] - wy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) {
          bestDist = dist;
          bestId = org.id;
        }
      }
    }
    selectedOrganismId = bestId;
    renderer.selectedOrganismId = bestId;
    if (onOrganismSelected) onOrganismSelected(bestId);
  }

  /** Handle tank cell editing click — start box-select */
  function handleTankClick(clientX: number, clientY: number): void {
    if (!currentWorld) return;
    const cell = clientToGridCell(clientX, clientY);
    if (!cell) return;
    const key = cellKey(cell.col, cell.row);
    // Click on existing cell → remove (shrink tank); click outside → add (extend tank)
    wallPaintMode = currentWorld.tankCells.has(key) ? 'remove' : 'add';
    boxStartCol = cell.col;
    boxStartRow = cell.row;
    boxEndCol = cell.col;
    boxEndRow = cell.row;
    isEditingWalls = true;
  }

  /** Handle light source click — select existing or place new */
  function handleLightClick(wx: number, wy: number): void {
    if (!currentWorld) return;
    // Hit-test existing light sources (generous radius for easy selection)
    for (const ls of currentWorld.lightSources) {
      const dx = wx - ls.x;
      const dy = wy - ls.y;
      const hitR = Math.max(30, ls.radius * 0.3);
      if (dx * dx + dy * dy < hitR * hitR) {
        selectedSourceType = 'light';
        selectedSourceId = ls.id;
        renderer.selectedSourceType = 'light';
        renderer.selectedSourceId = ls.id;
        isDraggingSource = true;
        if (onSourceSelected) onSourceSelected('light', ls.id);
        return;
      }
    }
    // Place new source (if under limit)
    if (currentWorld.lightSources.length >= MAX_LIGHT_SOURCES) return;
    const newSource: LightSource = {
      id: currentWorld.nextLightSourceId++,
      x: wx, y: wy,
      radius: LIGHT_DEFAULT_RADIUS,
      intensity: LIGHT_DEFAULT_INTENSITY,
    };
    currentWorld.lightSources.push(newSource);
    selectedSourceType = 'light';
    selectedSourceId = newSource.id;
    renderer.selectedSourceType = 'light';
    renderer.selectedSourceId = newSource.id;
    if (onSourceSelected) onSourceSelected('light', newSource.id);
  }

  /** Handle temperature source click — select existing or place new */
  function handleTemperatureClick(wx: number, wy: number): void {
    if (!currentWorld) return;
    for (const ts of currentWorld.temperatureSources) {
      const dx = wx - ts.x;
      const dy = wy - ts.y;
      const hitR = Math.max(30, ts.radius * 0.3);
      if (dx * dx + dy * dy < hitR * hitR) {
        selectedSourceType = 'temperature';
        selectedSourceId = ts.id;
        renderer.selectedSourceType = 'temperature';
        renderer.selectedSourceId = ts.id;
        isDraggingSource = true;
        if (onSourceSelected) onSourceSelected('temperature', ts.id);
        return;
      }
    }
    if (currentWorld.temperatureSources.length >= MAX_TEMPERATURE_SOURCES) return;
    const newSource: TemperatureSource = {
      id: currentWorld.nextTemperatureSourceId++,
      x: wx, y: wy,
      radius: TEMP_DEFAULT_RADIUS,
      intensity: TEMP_DEFAULT_INTENSITY,
    };
    currentWorld.temperatureSources.push(newSource);
    selectedSourceType = 'temperature';
    selectedSourceId = newSource.id;
    renderer.selectedSourceType = 'temperature';
    renderer.selectedSourceId = newSource.id;
    if (onSourceSelected) onSourceSelected('temperature', newSource.id);
  }

  // Mouse down: shift = tank edit (always), middle/right = pan, left = tool dispatch
  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button === 1 || e.button === 2) {
      isPanning = true;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      e.preventDefault();
    } else if (e.button === 0 && e.shiftKey) {
      // Shift+click always does tank cell editing regardless of tool mode
      handleTankClick(e.clientX, e.clientY);
      e.preventDefault();
    } else if (e.button === 0 && !e.altKey) {
      if (!currentWorld) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = screenWidth / rect.width;
      const scaleY = screenHeight / rect.height;
      const sx = (e.clientX - rect.left) * scaleX;
      const sy = (e.clientY - rect.top) * scaleY;
      const { wx, wy } = screenToWorld(sx, sy);

      switch (toolMode) {
        case ToolMode.Select:
          handleSelectClick(wx, wy);
          break;
        case ToolMode.Tank:
          handleTankClick(e.clientX, e.clientY);
          e.preventDefault();
          break;
        case ToolMode.Light:
          handleLightClick(wx, wy);
          break;
        case ToolMode.Temperature:
          handleTemperatureClick(wx, wy);
          break;
      }
    }
  });

  canvas.addEventListener('mousemove', (e: MouseEvent) => {
    if (isPanning) {
      panCamera(camera, e.clientX - lastMouseX, e.clientY - lastMouseY);
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    } else if (isDraggingSource && currentWorld && selectedSourceId !== null) {
      // Drag selected source to new position
      const rect = canvas.getBoundingClientRect();
      const scaleX = screenWidth / rect.width;
      const scaleY = screenHeight / rect.height;
      const sx = (e.clientX - rect.left) * scaleX;
      const sy = (e.clientY - rect.top) * scaleY;
      const { wx, wy } = screenToWorld(sx, sy);
      const sources = selectedSourceType === 'light'
        ? currentWorld.lightSources
        : currentWorld.temperatureSources;
      const src = sources.find(s => s.id === selectedSourceId);
      if (src) {
        src.x = wx;
        src.y = wy;
      }
    } else if (isEditingWalls && (e.shiftKey || toolMode === ToolMode.Tank)) {
      // Update box-select end cell
      const cell = clientToGridCell(e.clientX, e.clientY);
      if (cell) {
        boxEndCol = cell.col;
        boxEndRow = cell.row;
      }
    }
  });

  canvas.addEventListener('mouseup', (e: MouseEvent) => {
    if (e.button === 1 || e.button === 2) isPanning = false;
    if (e.button === 0) {
      if (isEditingWalls) {
        applyBoxSelect();
      }
      isEditingWalls = false;
      isDraggingSource = false;
    }
  });

  canvas.addEventListener('mouseleave', () => {
    isPanning = false;
    if (isEditingWalls) boxPreviewGraphics.clear();
    isEditingWalls = false;
    isDraggingSource = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // ── The Renderer Object ──
  const renderer: Renderer = {
    app,
    camera,
    worldContainer,
    focusDepth: 1.0,
    selectedOrganismId: null,
    onOrganismSelected: null,
    toolMode: ToolMode.Select,
    selectedSourceType: null,
    selectedSourceId: null,
    onSourceSelected: null,

    setFocusDepth(depth: number): void {
      focusDepth = Math.max(0, Math.min(1, depth));
      renderer.focusDepth = focusDepth;
    },

    setWallsDirty(): void {
      wallsDirty = true;
    },

    setToolMode(mode: ToolMode): void {
      toolMode = mode;
      renderer.toolMode = mode;
      // Deselect source when switching away from Light/Temperature tools
      if (mode !== ToolMode.Light && mode !== ToolMode.Temperature) {
        selectedSourceType = null;
        selectedSourceId = null;
        renderer.selectedSourceType = null;
        renderer.selectedSourceId = null;
        if (onSourceSelected) onSourceSelected(null, null);
      }
    },

    render(world: World, _alpha: number): void {
      currentWorld = world;
      onOrganismSelected = renderer.onOrganismSelected;
      onSourceSelected = renderer.onSourceSelected;
      const now = performance.now() / 1000;

      // ── Update per-segment light cache (once per sim tick, not per frame) ──
      const hasLights = world.lightSources.length > 0;
      if (hasLights && world.tick !== lightCacheTick) {
        lightCacheTick = world.tick;
        const totalSegs = world.segments.x.length;
        if (!segmentLightCache || segmentLightCache.length < totalSegs) {
          segmentLightCache = new Float32Array(totalSegs);
        }
        const seg = world.segments;
        for (let idx = 0; idx < totalSegs; idx++) {
          if (!seg.alive[idx]) continue;
          const raw = computeLight(seg.x[idx], seg.y[idx], world.lightSources, world.tankCells);
          segmentLightCache[idx] = Math.min(1, raw);
        }
      }

      // ── Drain effects queue ──
      for (let i = 0; i < effectsQueue.births.length; i++) {
        const b = effectsQueue.births[i];
        effects.addBirth(b.id, b.x, b.y);
      }
      effectsQueue.births.length = 0;
      for (let i = 0; i < effectsQueue.deaths.length; i++) {
        const d = effectsQueue.deaths[i];
        effects.addDeath(d.segments, d.cx, d.cy);
      }
      effectsQueue.deaths.length = 0;

      // ── Update effects ──
      effects.update(now, ghostBuffer, pulseBuffer);

      // ── Apply camera transform ──
      worldContainer.scale.set(camera.zoom);
      worldContainer.x = screenWidth / 2 - camera.x * camera.zoom;
      worldContainer.y = screenHeight / 2 - camera.y * camera.zoom;

      // ── Parallax offset values (applied per-organism in the render loop) ──
      // Uses root segment depth so all segments in an organism shift together.
      // tanh caps the offset smoothly so it never exceeds PARALLAX_MAX_OFFSET,
      // regardless of how far the camera pans in a huge tank.
      const parallaxCamX = PARALLAX_MAX_OFFSET * Math.tanh(camera.x * PARALLAX_STRENGTH / PARALLAX_MAX_OFFSET);
      const parallaxCamY = PARALLAX_MAX_OFFSET * Math.tanh(camera.y * PARALLAX_STRENGTH / PARALLAX_MAX_OFFSET);

      // ── Redraw tank cells if dirty ──
      if (wallsDirty) {
        const gs = TANK_GRID_SPACING;
        const isLight = currentTheme === 'light';
        const bgColor = isLight ? LIGHT_TANK_BG_COLOR : TANK_BG_COLOR;
        const gridColor = isLight ? LIGHT_TANK_GRID_COLOR : TANK_GRID_COLOR;
        const edgeColor = isLight ? LIGHT_TANK_EDGE_COLOR : TANK_EDGE_COLOR;

        // ── Cell backgrounds ──
        tankCellsGraphics.clear();
        for (const key of world.tankCells) {
          const [colStr, rowStr] = key.split(',');
          const col = Number(colStr);
          const row = Number(rowStr);
          tankCellsGraphics.rect(col * gs, row * gs, gs, gs);
        }
        if (world.tankCells.size > 0) {
          tankCellsGraphics.fill({ color: bgColor });
        }
        // Clip convex corners: fill the tiny triangle between the rect corner
        // and the rounded outline with canvas background color
        const canvasBg = isLight ? LIGHT_CANVAS_BG_COLOR : CANVAS_BG_COLOR;
        const cr = gs * 0.4; // Must match drawRoundedTankOutline corner radius
        drawConvexCornerMasks(tankCellsGraphics, world.tankCells, gs, cr, canvasBg);

        // ── Grid lines (between adjacent tank cells) ──
        tankGridGraphics.clear();
        for (const key of world.tankCells) {
          const [colStr, rowStr] = key.split(',');
          const col = Number(colStr);
          const row = Number(rowStr);
          const x = col * gs;
          const y = row * gs;
          // Right edge: draw if right neighbor is also a tank cell
          if (world.tankCells.has(`${col + 1},${row}`)) {
            tankGridGraphics.moveTo(x + gs, y);
            tankGridGraphics.lineTo(x + gs, y + gs);
          }
          // Bottom edge: draw if bottom neighbor is also a tank cell
          if (world.tankCells.has(`${col},${row + 1}`)) {
            tankGridGraphics.moveTo(x, y + gs);
            tankGridGraphics.lineTo(x + gs, y + gs);
          }
        }
        tankGridGraphics.stroke({ color: gridColor, width: 1, alpha: 0.3 });

        // ── Tank outline with rounded corners ──
        tankOutlineGraphics.clear();
        drawRoundedTankOutline(tankOutlineGraphics, world.tankCells, gs);
        tankOutlineGraphics.stroke({ color: edgeColor, width: 2.5, alpha: 0.6 });

        // ── Environment mask (cell-based) ──
        envMask.clear();
        for (const key of world.tankCells) {
          const [colStr, rowStr] = key.split(',');
          const col = Number(colStr);
          const row = Number(rowStr);
          envMask.rect(col * gs, row * gs, gs, gs);
        }
        if (world.tankCells.size > 0) {
          envMask.fill({ color: 0xffffff });
        }

        // ── Blur layer mask (clips parallax-shifted sprites to tank shape) ──
        blurMask.clear();
        for (const key of world.tankCells) {
          const [colStr, rowStr] = key.split(',');
          const col = Number(colStr);
          const row = Number(rowStr);
          blurMask.rect(col * gs, row * gs, gs, gs);
        }
        if (world.tankCells.size > 0) {
          blurMask.fill({ color: 0xffffff });
        }

        // ── Dark overlay (cell-based) ──
        darkOverlay.clear();
        for (const key of world.tankCells) {
          const [colStr, rowStr] = key.split(',');
          const col = Number(colStr);
          const row = Number(rowStr);
          darkOverlay.rect(col * gs, row * gs, gs, gs);
        }
        if (world.tankCells.size > 0) {
          darkOverlay.fill({ color: 0x000000, alpha: 0.45 });
        }

        wallsDirty = false;
      }

      // ── Draw environment overlays (soft gradient sprites, clipped to tank) ──
      const isLightTheme = currentTheme === 'light';
      // Dark overlay only in dark mode when lights exist
      darkOverlay.visible = hasLights && !isLightTheme;

      // Manage light glow sprites
      while (lightSprites.length < world.lightSources.length) {
        const s = new Sprite(lightGlowTexture);
        s.anchor.set(0.5);
        environmentContainer.addChild(s);
        lightSprites.push(s);
      }
      for (let i = 0; i < lightSprites.length; i++) {
        if (i < world.lightSources.length) {
          const src = world.lightSources[i];
          lightSprites[i].visible = true;
          // Dark mode: subtle additive glow. Light mode: shadow zone.
          lightSprites[i].texture = isLightTheme ? lightShadowTexture : lightGlowTexture;
          lightSprites[i].blendMode = isLightTheme ? 'normal' : 'add';
          lightSprites[i].x = src.x;
          lightSprites[i].y = src.y;
          lightSprites[i].width = src.radius * 2;
          lightSprites[i].height = src.radius * 2;
          lightSprites[i].alpha = isLightTheme ? src.intensity * 0.85 : src.intensity * 0.2;
        } else {
          lightSprites[i].visible = false;
        }
      }

      // Manage temperature gradient sprites
      while (tempSprites.length < world.temperatureSources.length) {
        const s = new Sprite();
        s.anchor.set(0.5);
        environmentContainer.addChild(s);
        tempSprites.push(s);
      }
      for (let i = 0; i < tempSprites.length; i++) {
        if (i < world.temperatureSources.length) {
          const src = world.temperatureSources[i];
          tempSprites[i].visible = true;
          tempSprites[i].texture = src.intensity >= 0 ? tempHotTexture : tempColdTexture;
          tempSprites[i].x = src.x;
          tempSprites[i].y = src.y;
          tempSprites[i].width = src.radius * 2;
          tempSprites[i].height = src.radius * 2;
          tempSprites[i].alpha = Math.abs(src.intensity) * 0.5;
        } else {
          tempSprites[i].visible = false;
        }
      }

      // ── Reset all blur layers ──
      for (const layer of blurLayers) {
        layer.active = 0;
      }

      const seg = world.segments;
      const fd = focusDepth;

      // ── Iterate organisms ──
      for (const org of world.organisms.values()) {
        if (!org.alive) continue;

        const topology = org.topology;

        // Per-organism parallax: use ROOT segment depth so all segments
        // in the organism shift together (no tearing from depth variation).
        const rootDepth = seg.segmentDepth[org.firstSegment];
        const orgPFactor = 0.5 - rootDepth; // centered on depth 0.5: deep → +, shallow → −
        const orgParallaxX = parallaxCamX * orgPFactor;
        const orgParallaxY = parallaxCamY * orgPFactor;

        for (let i = 0; i < org.segmentCount; i++) {
          const idx = org.firstSegment + i;
          if (!seg.alive[idx]) continue;

          // Per-segment depth → sharpness based on distance from focus plane
          const segDepth = seg.segmentDepth[idx];
          const sharpness = 1 - Math.abs(segDepth - fd);

          const layerIdx = Math.min(
            BLUR_LAYER_COUNT - 1,
            Math.floor(sharpness * BLUR_LAYER_COUNT),
          );
          const layer = blurLayers[layerIdx];

          const depthScale = DEPTH_SCALE_MIN
            + (DEPTH_SCALE_MAX - DEPTH_SCALE_MIN) * sharpness;

          const depthAlpha = DEPTH_ALPHA_MIN
            + (DEPTH_ALPHA_MAX - DEPTH_ALPHA_MIN) * sharpness;

          // Get or create a sprite from this layer's pool
          let sprite: Sprite;
          if (layer.active < layer.sprites.length) {
            sprite = layer.sprites[layer.active];
            sprite.visible = true;
          } else {
            sprite = new Sprite();
            sprite.anchor.set(0.5);
            layer.container.addChild(sprite);
            layer.sprites.push(sprite);
          }

          const colorKey = seg.color[idx];

          // Virus: infected organisms → ALL segments use dark texture of strain's target color
          let isInfected = false;
          let virusStrain: { colorAffinity: number; effects: number[]; effectsMask: number; alive: boolean } | null = null;
          if (seg.virusStrainId[idx] > 0) {
            const si = seg.virusStrainId[idx] - 1;
            const s = world.virusStrains.strains[si];
            if (s?.alive) {
              isInfected = true;
              virusStrain = s;
              // Use dark texture keyed to the strain's color affinity (not the segment's own color)
              sprite.texture = infectionTextures[s.colorAffinity] ?? infectionTextures[0];
            } else {
              sprite.texture = segmentTextures[colorKey] ?? segmentTextures[0];
            }
          } else {
            sprite.texture = segmentTextures[colorKey] ?? segmentTextures[0];
          }

          sprite.tint = 0xFFFFFF; // Texture handles color — no extra tint needed
          sprite.x = seg.x[idx] + orgParallaxX;
          sprite.y = seg.y[idx] + orgParallaxY;

          // ── Compute pill rotation (tree-aware) ──
          let angle = 0;

          if (topology.isLeaf[i]) {
            if (i > 0) {
              const parentGlobal = idx + seg.parentOffset[idx];
              if (seg.alive[parentGlobal]) {
                const dx = seg.x[idx] - seg.x[parentGlobal];
                const dy = seg.y[idx] - seg.y[parentGlobal];
                if (dx * dx + dy * dy > 0.01) {
                  angle = Math.atan2(dy, dx);
                }
              }
            }
          } else {
            const firstChildGeneIdx = topology.children[i][0];
            const childGlobal = org.firstSegment + firstChildGeneIdx;
            if (seg.alive[childGlobal]) {
              const dx = seg.x[childGlobal] - seg.x[idx];
              const dy = seg.y[childGlobal] - seg.y[idx];
              if (dx * dx + dy * dy > 0.01) {
                angle = Math.atan2(dy, dx);
              }
            }
          }
          sprite.rotation = angle;

          const rootBonus = seg.isRoot[idx] ? 1.15 : 1.0;
          const birthScale = effects.getBirthScale(org.id, now);
          const lengthMult = org.genome[i]?.length || 1;
          const widthMult = 1 + (lengthMult - 1) * 0.35; // Long segments are slightly wider for branch overlap
          let uniformScale = depthScale * rootBonus * birthScale;

          // Virus: Swelling only on segments matching strain's color affinity
          if (isInfected && virusStrain
            && colorKey === virusStrain.colorAffinity
            && (virusStrain.effectsMask & (1 << VirusEffect.Swelling)) !== 0) {
            uniformScale *= VIRUS_SWELLING_FACTOR;
          }

          sprite.scale.set(uniformScale * lengthMult, uniformScale * widthMult);

          // Modulate alpha by light when light sources are present
          let baseAlpha = depthAlpha;
          if (hasLights && segmentLightCache) {
            if (isLightTheme) {
              baseAlpha = depthAlpha * (1.0 - 0.35 * segmentLightCache[idx]);
            } else {
              baseAlpha = depthAlpha * (0.3 + 0.7 * segmentLightCache[idx]);
            }
          }

          // Virus: subtle pulse on infected segments
          if (isInfected) {
            baseAlpha *= 0.85 + 0.15 * Math.sin(now * 3 + idx);
          }

          sprite.alpha = baseAlpha;

          layer.active++;
        }
      }

      // ── Render food particles into blur layers (proper depth blur) ──
      const food = world.food;
      if (food.count > 0) {
        const normalFoodTex = isLightTheme ? foodTextureLight : foodTextureDark;
        for (let fi = 0; fi < FOOD_MAX_PARTICLES; fi++) {
          if (!food.alive[fi]) continue;

          const foodSharpness = 1 - Math.abs(food.depth[fi] - fd);
          const layerIdx = Math.min(
            BLUR_LAYER_COUNT - 1,
            Math.floor(foodSharpness * BLUR_LAYER_COUNT),
          );
          const layer = blurLayers[layerIdx];

          const foodScale = DEPTH_SCALE_MIN
            + (DEPTH_SCALE_MAX - DEPTH_SCALE_MIN) * foodSharpness;
          const foodAlpha = DEPTH_ALPHA_MIN
            + (DEPTH_ALPHA_MAX - DEPTH_ALPHA_MIN) * foodSharpness;

          // Decay fade: fade out over last 20% of lifetime
          const viralVal = food.isViral[fi]; // 0 = normal, 1-6 = viral color + 1
          const isViral = viralVal > 0;
          const lifetime = isViral ? FOOD_DECAY_TICKS >> 1 : FOOD_DECAY_TICKS;
          const age = world.tick - food.spawnTick[fi];
          const decayFade = age > lifetime * 0.8
            ? 1 - (age - lifetime * 0.8) / (lifetime * 0.2)
            : 1;
          let alpha = foodAlpha * decayFade * 0.8;

          // Viral food: subtle pulsing glow
          if (isViral) {
            alpha = foodAlpha * decayFade * (0.6 + 0.3 * Math.sin(now * 4 + fi));
          }

          if (alpha < 0.05) continue;

          // Get or create sprite in this blur layer
          let sprite: Sprite;
          if (layer.active < layer.sprites.length) {
            sprite = layer.sprites[layer.active];
            sprite.visible = true;
          } else {
            sprite = new Sprite();
            sprite.anchor.set(0.5);
            layer.container.addChild(sprite);
            layer.sprites.push(sprite);
          }

          // Viral food uses the dark color texture matching the strain's target
          if (isViral) {
            const viralColorIdx = viralVal - 1;
            sprite.texture = viralFoodTextures[viralColorIdx] ?? viralFoodTextures[0];
          } else {
            sprite.texture = normalFoodTex;
          }
          // Parallax offset for food (same depth-based approach as segments)
          const foodPFactor = 0.5 - food.depth[fi];
          sprite.x = food.x[fi] + parallaxCamX * foodPFactor;
          sprite.y = food.y[fi] + parallaxCamY * foodPFactor;
          sprite.rotation = 0;
          // Viral food is slightly larger
          const s = foodScale * (isViral ? 0.7 : 0.5);
          sprite.scale.set(s, s);
          sprite.alpha = alpha;
          sprite.tint = 0xFFFFFF; // Reset tint (textures handle color)
          layer.active++;
        }
      }

      // ── Hide unused sprites in all layers ──
      for (const layer of blurLayers) {
        for (let i = layer.active; i < layer.sprites.length; i++) {
          layer.sprites[i].visible = false;
        }
      }

      // ── Draw effects: ghost segments + pulses ──
      effectsGraphics.clear();

      // Ghost segments (death animation) — draw as filled circles
      for (let i = 0; i < ghostBuffer.length; i++) {
        const gh = ghostBuffer[i];
        const colorHex = SEGMENT_RENDER_COLORS[gh.color] ?? 0x888888;
        const r = SEGMENT_RADIUS * gh.scale;
        if (r < 0.5) continue;
        effectsGraphics.circle(gh.x, gh.y, r);
        effectsGraphics.fill({ color: colorHex, alpha: gh.scale * 0.8 });
      }

      // Pulse rings (birth = green, death = red)
      for (let i = 0; i < pulseBuffer.length; i++) {
        const p = pulseBuffer[i];
        const color = p.isBirth ? 0x44cc44 : 0xff4444;
        effectsGraphics.circle(p.x, p.y, p.radius);
        effectsGraphics.stroke({ color, width: 2, alpha: p.alpha });
      }

      // ── Draw selection outline ──
      selectionGraphics.clear();
      if (selectedOrganismId !== null) {
        const selOrg = world.organisms.get(selectedOrganismId);
        if (selOrg && selOrg.alive) {
          // Theme-aware outline color
          const outlineColor = currentTheme === 'light' ? 0x2a3050 : 0xffffff;
          const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 250);

          // Draw outline at every segment position
          for (let i = 0; i < selOrg.segmentCount; i++) {
            const idx = selOrg.firstSegment + i;
            if (!seg.alive[idx]) continue;
            selectionGraphics.circle(seg.x[idx], seg.y[idx], SEGMENT_RADIUS * 1.8);
            selectionGraphics.stroke({ color: outlineColor, width: 1.5, alpha: 0.4 * pulse });
          }
        } else {
          selectedOrganismId = null;
          renderer.selectedOrganismId = null;
          if (onOrganismSelected) onOrganismSelected(null);
        }
      }

      // ── Show origin dots for sources when their tool mode is active ──
      if (toolMode === ToolMode.Light) {
        for (const ls of world.lightSources) {
          const isSelected = selectedSourceId === ls.id && selectedSourceType === 'light';
          selectionGraphics.circle(ls.x, ls.y, isSelected ? 7 : 5);
          selectionGraphics.fill({ color: 0xffe8a0, alpha: isSelected ? 0.8 : 0.45 });
        }
      } else if (toolMode === ToolMode.Temperature) {
        for (const ts of world.temperatureSources) {
          const isSelected = selectedSourceId === ts.id && selectedSourceType === 'temperature';
          const col = ts.intensity >= 0 ? 0xff5032 : 0x3250ff;
          selectionGraphics.circle(ts.x, ts.y, isSelected ? 7 : 5);
          selectionGraphics.fill({ color: col, alpha: isSelected ? 0.8 : 0.45 });
        }
      } else if (selectedSourceId !== null) {
        // Show selected source dot even in other tool modes
        const sources = selectedSourceType === 'light'
          ? world.lightSources
          : world.temperatureSources;
        const src = sources.find(s => s.id === selectedSourceId);
        if (src) {
          const highlightColor = selectedSourceType === 'light'
            ? 0xffe8a0
            : (src.intensity >= 0 ? 0xff5032 : 0x3250ff);
          selectionGraphics.circle(src.x, src.y, 6);
          selectionGraphics.fill({ color: highlightColor, alpha: 0.6 });
        } else {
          selectedSourceType = null;
          selectedSourceId = null;
          renderer.selectedSourceType = null;
          renderer.selectedSourceId = null;
          if (onSourceSelected) onSourceSelected(null, null);
        }
      }

      // ── Box-select preview ──
      boxPreviewGraphics.clear();
      if (isEditingWalls) {
        const gs = TANK_GRID_SPACING;
        const minC = Math.min(boxStartCol, boxEndCol);
        const maxC = Math.max(boxStartCol, boxEndCol);
        const minR = Math.min(boxStartRow, boxEndRow);
        const maxR = Math.max(boxStartRow, boxEndRow);
        const px = minC * gs;
        const py = minR * gs;
        const pw = (maxC - minC + 1) * gs;
        const ph = (maxR - minR + 1) * gs;
        const fillColor = wallPaintMode === 'add' ? 0x44cc44 : 0xff4444;
        const cornerR = gs * 0.4; // Match tank outline corner radius
        boxPreviewGraphics.roundRect(px, py, pw, ph, cornerR);
        boxPreviewGraphics.fill({ color: fillColor, alpha: 0.2 });
        boxPreviewGraphics.roundRect(px, py, pw, ph, cornerR);
        boxPreviewGraphics.stroke({ color: fillColor, width: 2, alpha: 0.6 });
      }
    },

    destroy(): void {
      app.destroy(true, { children: true, texture: true });
    },

    getCanvas(): HTMLCanvasElement {
      return canvas;
    },

    resize(w: number, h: number): void {
      screenWidth = w;
      screenHeight = h;
      app.renderer.resize(w, h);
    },

    setTheme(theme: 'dark' | 'light'): void {
      const isLight = theme === 'light';
      app.renderer.background.color = isLight ? LIGHT_CANVAS_BG_COLOR : CANVAS_BG_COLOR;

      // Mark cells dirty to redraw tank bg, grid, outline, env mask with new colors
      wallsDirty = true;
      currentTheme = theme;
      // Re-apply desaturation filter with new theme-aware matrix
      if (isDesaturated) {
        renderer.setDesaturated(false);
        renderer.setDesaturated(true);
      }
    },

    setDesaturated(on: boolean): void {
      isDesaturated = on;
      // Mauve/lavender tinted desaturation — biological specimen look
      // Theme-aware: darker tint on dark bg, lighter tint on light bg
      const makeBioFilter = (): ColorMatrixFilter => {
        const cmf = new ColorMatrixFilter();
        const lr = 0.2126, lg = 0.7152, lb = 0.0722;
        if (currentTheme === 'dark') {
          cmf.matrix = [
            lr * 0.88, lg * 0.88, lb * 0.88, 0, 0.02,
            lr * 0.62, lg * 0.62, lb * 0.62, 0, 0.00,
            lr * 0.72, lg * 0.72, lb * 0.72, 0, 0.01,
            0,         0,         0,         1, 0,
          ];
        } else {
          // Light mode: 50% less tint than dark, 2x lifted shadows
          cmf.matrix = [
            lr * 1.18, lg * 1.18, lb * 1.18, 0, 0.10,
            lr * 0.99, lg * 0.99, lb * 0.99, 0, 0.06,
            lr * 1.06, lg * 1.06, lb * 1.06, 0, 0.08,
            0,         0,         0,         1, 0,
          ];
        }
        return cmf;
      };

      for (const layer of blurLayers) {
        if (on) {
          const existing = layer.container.filters ?? [];
          layer.container.filters = [...existing, makeBioFilter()];
        } else {
          const existing = layer.container.filters ?? [];
          layer.container.filters = existing.filter(f => !(f instanceof ColorMatrixFilter));
        }
      }
      // Also tint effects (ghost segments)
      effectsGraphics.filters = on ? [makeBioFilter()] : [];
    },
  };

  return renderer;
}


// ─── Helper Functions ────────────────────────────────────────

// Old rounded-rect tank rendering functions removed.
// Tank shape is now dynamic — rendered as individual cells in the render() loop.

/**
 * Create pill/capsule shaped textures for each segment color.
 *
 * Each texture is a rounded rectangle (roundRect with corner radius = half height)
 * which creates a perfect capsule/pill shape. A subtle highlight stripe on top
 * gives a 3D cylindrical appearance.
 *
 * The pill is drawn horizontally (long axis along X). Sprites are rotated
 * in the render loop to face along the chain direction.
 */
function createPillTextures(
  app: Application,
  colorMap: Record<number, number> = SEGMENT_RENDER_COLORS,
): Record<number, Texture> {
  const textures: Record<number, Texture> = {};
  const len = SEGMENT_PILL_LENGTH;
  const wid = SEGMENT_PILL_WIDTH;
  const cornerRadius = wid / 2; // Half-height radius = perfect capsule ends

  for (const [colorKey, hexColor] of Object.entries(colorMap)) {
    const g = new Graphics();

    // ── Main pill body ──
    g.roundRect(-len / 2, -wid / 2, len, wid, cornerRadius);
    g.fill({ color: hexColor });

    // ── Subtle highlight stripe (3D cylindrical look) ──
    // A slightly lighter band along the upper portion of the pill
    const hlHeight = wid * 0.3;
    const hlInset = 2;
    g.roundRect(
      -len / 2 + hlInset,
      -wid / 2 + 1,
      len - hlInset * 2,
      hlHeight,
      hlHeight / 2,
    );
    g.fill({ color: 0xffffff, alpha: 0.12 });

    // ── Thin border for definition against dark background ──
    g.roundRect(-len / 2, -wid / 2, len, wid, cornerRadius);
    g.stroke({ color: 0xffffff, width: 0.5, alpha: 0.08 });

    // Generate reusable texture from this drawing
    const texture = app.renderer.generateTexture(g);
    textures[Number(colorKey)] = texture;
    g.destroy();
  }

  return textures;
}

/** Create a small circle texture for food particles. */
function createFoodTexture(app: Application, hexColor: number): Texture {
  const r = FOOD_PARTICLE_RADIUS * 2; // Texture size (will be scaled down by sprite)
  const g = new Graphics();
  g.circle(0, 0, r);
  g.fill({ color: hexColor });
  // Soft highlight
  g.circle(-r * 0.2, -r * 0.2, r * 0.4);
  g.fill({ color: 0xffffff, alpha: 0.15 });
  const texture = app.renderer.generateTexture(g);
  g.destroy();
  return texture;
}

/** Create a soft radial gradient texture from Canvas2D, for environment overlays */
function createRadialGradientTexture(
  size: number,
  stops: Array<[number, string]>,
): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const half = size / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  for (const [pos, color] of stops) gradient.addColorStop(pos, color);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(half, half, half, 0, Math.PI * 2);
  ctx.fill();
  return Texture.from(canvas, true);
}


/**
 * Draw the tank outline with intelligent rounded corners.
 *
 * Two phases:
 * 1) EDGES — For each tank cell's exposed edges, draw line segments shortened
 *    at endpoints that are corners (convex or concave).
 * 2) ARCS — For each grid vertex on the boundary, draw a quadratic curve
 *    connecting the shortened edge endpoints.
 *
 * Corner classification per vertex (4 surrounding cells):
 * - 1 tank cell → CONVEX corner (outer turn, round outward)
 * - 3 tank cells → CONCAVE corner (inner notch, round inward)
 * - 2 diagonal cells → Two separate CONVEX arcs
 * - 2 adjacent cells → STRAIGHT through (no rounding)
 * - 0 or 4 cells → No boundary at this vertex
 */
function drawRoundedTankOutline(
  g: Graphics,
  tankCells: Set<string>,
  gs: number,
): void {
  const r = gs * 0.4; // Corner radius
  const has = (c: number, row: number) => tankCells.has(`${c},${row}`);

  // ── Phase 1: Shortened edge segments ──
  for (const key of tankCells) {
    const sep = key.indexOf(',');
    const c = Number(key.substring(0, sep));
    const row = Number(key.substring(sep + 1));
    const x = c * gs;
    const y = row * gs;

    const N = has(c, row - 1);
    const S = has(c, row + 1);
    const E = has(c + 1, row);
    const W = has(c - 1, row);
    const NW = has(c - 1, row - 1);
    const NE = has(c + 1, row - 1);
    const SW = has(c - 1, row + 1);
    const SE = has(c + 1, row + 1);

    // Top edge (exposed if no north neighbor)
    if (!N) {
      // Left vertex straight-through when west cell exists but NW doesn't
      // (outline continues horizontally from west cell's top edge)
      const leftStraight = W && !NW;
      const rightStraight = E && !NE;
      const x0 = leftStraight ? x : x + r;
      const x1 = rightStraight ? x + gs : x + gs - r;
      if (x1 > x0) { g.moveTo(x0, y); g.lineTo(x1, y); }
    }

    // Bottom edge (exposed if no south neighbor)
    if (!S) {
      const leftStraight = W && !SW;
      const rightStraight = E && !SE;
      const x0 = leftStraight ? x : x + r;
      const x1 = rightStraight ? x + gs : x + gs - r;
      if (x1 > x0) { g.moveTo(x0, y + gs); g.lineTo(x1, y + gs); }
    }

    // Left edge (exposed if no west neighbor)
    if (!W) {
      const topStraight = N && !NW;
      const bottomStraight = S && !SW;
      const y0 = topStraight ? y : y + r;
      const y1 = bottomStraight ? y + gs : y + gs - r;
      if (y1 > y0) { g.moveTo(x, y0); g.lineTo(x, y1); }
    }

    // Right edge (exposed if no east neighbor)
    if (!E) {
      const topStraight = N && !NE;
      const bottomStraight = S && !SE;
      const y0 = topStraight ? y : y + r;
      const y1 = bottomStraight ? y + gs : y + gs - r;
      if (y1 > y0) { g.moveTo(x + gs, y0); g.lineTo(x + gs, y1); }
    }
  }

  // ── Phase 2: Corner arcs at boundary vertices ──
  // Each tank cell contributes 4 corner vertices. Deduplicate via Set.
  const vertexVisited = new Set<string>();

  for (const key of tankCells) {
    const sep = key.indexOf(',');
    const c = Number(key.substring(0, sep));
    const row = Number(key.substring(sep + 1));

    for (let dvc = 0; dvc <= 1; dvc++) {
      for (let dvr = 0; dvr <= 1; dvr++) {
        const vc = c + dvc;
        const vr = row + dvr;
        const vkey = `${vc},${vr}`;
        if (vertexVisited.has(vkey)) continue;
        vertexVisited.add(vkey);

        const vx = vc * gs;
        const vy = vr * gs;

        // 4 cells sharing this vertex
        const tl = has(vc - 1, vr - 1);
        const tr = has(vc, vr - 1);
        const bl = has(vc - 1, vr);
        const br = has(vc, vr);

        const count = +tl + +tr + +bl + +br;
        if (count === 0 || count === 4) continue;

        if (count === 1) {
          // ── Convex corner: one tank cell, round outward ──
          if (tl) {
            g.moveTo(vx, vy - r);
            g.quadraticCurveTo(vx, vy, vx - r, vy);
          } else if (tr) {
            g.moveTo(vx + r, vy);
            g.quadraticCurveTo(vx, vy, vx, vy - r);
          } else if (bl) {
            g.moveTo(vx - r, vy);
            g.quadraticCurveTo(vx, vy, vx, vy + r);
          } else {
            // br
            g.moveTo(vx, vy + r);
            g.quadraticCurveTo(vx, vy, vx + r, vy);
          }
        } else if (count === 3) {
          // ── Concave corner: one missing cell, round inward ──
          if (!tl) {
            g.moveTo(vx - r, vy);
            g.quadraticCurveTo(vx, vy, vx, vy - r);
          } else if (!tr) {
            g.moveTo(vx, vy - r);
            g.quadraticCurveTo(vx, vy, vx + r, vy);
          } else if (!bl) {
            g.moveTo(vx, vy + r);
            g.quadraticCurveTo(vx, vy, vx - r, vy);
          } else {
            // !br
            g.moveTo(vx + r, vy);
            g.quadraticCurveTo(vx, vy, vx, vy + r);
          }
        } else if (count === 2) {
          // ── Diagonal: two separate convex arcs ──
          if (tl && br && !tr && !bl) {
            g.moveTo(vx, vy - r);
            g.quadraticCurveTo(vx, vy, vx - r, vy);
            g.moveTo(vx, vy + r);
            g.quadraticCurveTo(vx, vy, vx + r, vy);
          } else if (tr && bl && !tl && !br) {
            g.moveTo(vx + r, vy);
            g.quadraticCurveTo(vx, vy, vx, vy - r);
            g.moveTo(vx - r, vy);
            g.quadraticCurveTo(vx, vy, vx, vy + r);
          }
          // Adjacent pairs: straight through, no arc needed
        }
      }
    }
  }
}


/**
 * Mask convex corners so the rectangular cell background doesn't poke past
 * the rounded outline. At each convex corner vertex, draw a small curved
 * triangle (rect corner → edge → arc → close) filled with the canvas
 * background color, effectively "erasing" the protruding background.
 *
 * Called AFTER the cell backgrounds are filled, draws on the same Graphics
 * object so the masks layer on top.
 */
function drawConvexCornerMasks(
  g: Graphics,
  tankCells: Set<string>,
  gs: number,
  r: number,
  canvasBg: number,
): void {
  const has = (c: number, row: number) => tankCells.has(`${c},${row}`);

  // Helper: draw one convex mask for a specific quadrant at vertex (vx, vy)
  const maskConvex = (vx: number, vy: number, which: 'tl' | 'tr' | 'bl' | 'br') => {
    switch (which) {
      case 'tl':
        // TL cell's bottom-right corner at (vx, vy)
        g.moveTo(vx, vy);
        g.lineTo(vx, vy - r);
        g.quadraticCurveTo(vx, vy, vx - r, vy);
        g.closePath();
        break;
      case 'tr':
        // TR cell's bottom-left corner at (vx, vy)
        g.moveTo(vx, vy);
        g.lineTo(vx + r, vy);
        g.quadraticCurveTo(vx, vy, vx, vy - r);
        g.closePath();
        break;
      case 'bl':
        // BL cell's top-right corner at (vx, vy)
        g.moveTo(vx, vy);
        g.lineTo(vx - r, vy);
        g.quadraticCurveTo(vx, vy, vx, vy + r);
        g.closePath();
        break;
      case 'br':
        // BR cell's top-left corner at (vx, vy)
        g.moveTo(vx, vy);
        g.lineTo(vx, vy + r);
        g.quadraticCurveTo(vx, vy, vx + r, vy);
        g.closePath();
        break;
    }
  };

  const vertexVisited = new Set<string>();

  for (const key of tankCells) {
    const sep = key.indexOf(',');
    const c = Number(key.substring(0, sep));
    const row = Number(key.substring(sep + 1));

    for (let dvc = 0; dvc <= 1; dvc++) {
      for (let dvr = 0; dvr <= 1; dvr++) {
        const vc = c + dvc;
        const vr = row + dvr;
        const vkey = `${vc},${vr}`;
        if (vertexVisited.has(vkey)) continue;
        vertexVisited.add(vkey);

        const vx = vc * gs;
        const vy = vr * gs;

        const tl = has(vc - 1, vr - 1);
        const tr = has(vc, vr - 1);
        const bl = has(vc - 1, vr);
        const br = has(vc, vr);

        const count = +tl + +tr + +bl + +br;

        if (count === 1) {
          // Single convex corner
          if (tl) maskConvex(vx, vy, 'tl');
          else if (tr) maskConvex(vx, vy, 'tr');
          else if (bl) maskConvex(vx, vy, 'bl');
          else maskConvex(vx, vy, 'br');
        } else if (count === 2) {
          // Diagonal: two separate convex masks
          if (tl && br && !tr && !bl) {
            maskConvex(vx, vy, 'tl');
            maskConvex(vx, vy, 'br');
          } else if (tr && bl && !tl && !br) {
            maskConvex(vx, vy, 'tr');
            maskConvex(vx, vy, 'bl');
          }
          // Adjacent pairs: straight through, no masking needed
        }
        // count === 3 (concave): no masking needed — backgrounds are inside the curve
      }
    }
  }

  // Fill all mask sub-paths at once with the canvas background color
  g.fill({ color: canvasBg });
}
