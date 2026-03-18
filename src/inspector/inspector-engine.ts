/**
 * inspector-engine.ts — Minimal single-organism physics engine for the Rep Inspector.
 *
 * Unlike the full SimulationEngine, this handles exactly one organism in a
 * circular "petri dish" tank. No food, no viruses, no reproduction — just
 * the rep floating, wobbling, and holding its genetic shape.
 *
 * The genome mutation API lets the UI edit genes live:
 *   setSegmentColor → instant color swap (no rebuild)
 *   setSegmentAngle / setSegmentLength → rebuild organism in place
 *   addChild / deleteGene → structural changes, rebuild
 *   setGenome → replace entire genome, rebuild
 */

import type { World, Genome, SimConfig, Organism } from '../types';
import { SegmentColor } from '../types';
import {
  DEFAULT_CONFIG,
  SEGMENT_RADIUS,
  COLOR_PREFERRED_ANGLES,
  COLOR_LENGTH_RANGES,
  MAX_GENE_TURN_ANGLE,
  SIM_DT,
} from '../constants';
import { createWorld, spawnOrganismFromGenome, createRandomGenome } from '../simulation/world';
import { isValidTreeGenome, buildGenomeTopology } from '../simulation/tree-utils';
import { generateName } from '../simulation/naming';
import {
  integrateVerlet,
  enforceAngularConstraints,
} from '../simulation/systems/constraints';


// ─── Inspector Constants ─────────────────────────────────────

export const INSPECTOR_TANK_RADIUS = 130;   // World units — circular petri dish
const INSPECTOR_CONFIG: SimConfig = {
  ...DEFAULT_CONFIG,
  repLimit: 2,
  repCount: 0,
};


// ─── Types ───────────────────────────────────────────────────

export interface InspectorEngine {
  world: World;
  config: SimConfig;
  genome: Genome;
  paused: boolean;
  selectedGeneIdx: number | null;
  onGenomeChanged: (() => void) | null;
  onGeneSelected: ((idx: number | null) => void) | null;

  update(deltaSeconds: number): void;
  getOrganism(): Organism | null;

  // Genome mutation API
  setSegmentColor(geneIdx: number, color: SegmentColor): void;
  setSegmentAngle(geneIdx: number, angle: number): void;
  setSegmentLength(geneIdx: number, length: number): void;
  /** Smooth update — update topology in-place so physics converges naturally. No rebuild, no callback. */
  softSetAngle(geneIdx: number, angle: number): void;
  softSetLength(geneIdx: number, length: number): void;
  /** Move organism root to world position (wx, wy), clamped to circular boundary. Zeroes velocity. */
  moveRoot(wx: number, wy: number): void;
  addChild(parentGeneIdx: number, color: SegmentColor, angle: number, length: number): void;
  deleteGene(geneIdx: number): void;
  setGenome(genome: Genome): void;

  // Selection
  selectGene(geneIdx: number | null): void;

  // Physics control
  setPaused(paused: boolean): void;

  // Serialization for share/export
  getExportData(): { genome: Genome; name: string; generation: number };
}


// ─── Circular Boundary ───────────────────────────────────────

function enforceCircularBoundary(world: World, radius: number): void {
  const seg = world.segments;
  const limit = radius - SEGMENT_RADIUS;
  const limitSq = limit * limit;

  for (let i = 0; i < world.segmentCount; i++) {
    if (!seg.alive[i]) continue;

    const dx = seg.x[i];
    const dy = seg.y[i];
    const distSq = dx * dx + dy * dy;

    if (distSq > limitSq) {
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const ny = dy / dist;
      const corrX = seg.x[i] - nx * limit;
      const corrY = seg.y[i] - ny * limit;
      seg.x[i] -= corrX;
      seg.y[i] -= corrY;
      seg.prevX[i] -= corrX;
      seg.prevY[i] -= corrY;
    }
  }
}


// ─── Genome Editing Helpers ──────────────────────────────────

/** Delete a gene and all its descendants. Returns the trimmed genome. */
function deleteGeneSubtree(genome: Genome, geneIdx: number): Genome {
  if (genome.length <= 1) return genome; // Can't delete the only gene

  // Collect all descendants (BFS forward through topology)
  const toDelete = new Set<number>();
  toDelete.add(geneIdx);

  // Since genome is topologically sorted (parent < child), a single forward pass suffices
  for (let i = 0; i < genome.length; i++) {
    if (i !== 0 && toDelete.has(genome[i].parent)) {
      toDelete.add(i);
    }
  }

  // Build index remap: old index → new index (or -1 if deleted)
  const indexRemap: number[] = [];
  let newIdx = 0;
  for (let i = 0; i < genome.length; i++) {
    indexRemap.push(toDelete.has(i) ? -1 : newIdx++);
  }

  // Build new genome with remapped parent references
  const newGenome: Genome = [];
  for (let i = 0; i < genome.length; i++) {
    if (toDelete.has(i)) continue;
    const gene = genome[i];
    newGenome.push({
      color: gene.color,
      angle: gene.angle,
      parent: gene.parent === -1 ? -1 : indexRemap[gene.parent],
      length: gene.length,
    });
  }

  return newGenome;
}

/** Get the preferred default angle for a new child of the given parent color. */
function defaultChildAngle(parentColor: SegmentColor): number {
  const prefs = COLOR_PREFERRED_ANGLES[parentColor];
  return prefs && prefs.length > 0 ? prefs[0] : 0;
}

/** Get the preferred default length for a color. */
function defaultChildLength(color: SegmentColor): number {
  const range = COLOR_LENGTH_RANGES[color];
  return range ? (range[0] + range[1]) / 2 : 1.0;
}


// ─── World Setup ─────────────────────────────────────────────

function createInspectorWorld(): World {
  const world = createWorld(INSPECTOR_CONFIG);
  // Clear the default tank cells and environment sources
  world.tankCells.clear();
  world.tankCellsArray = [];
  world.tankCellsDirty = true;
  world.lightSources = [];
  world.temperatureSources = [];
  world.currentSources = [];
  return world;
}


// ─── Organism Rebuild ────────────────────────────────────────

function rebuildOrganism(engine: InspectorEngine, genome: Genome): void {
  const world = engine.world;

  // Preserve current root position AND orientation so the rep doesn't jump on edits
  let spawnX = 0, spawnY = 0;
  let savedOrientation = 0;
  const existing = engine.getOrganism();
  if (existing) {
    const seg = world.segments;
    const rootIdx = existing.firstSegment;
    if (seg.alive[rootIdx]) {
      spawnX = seg.x[rootIdx];
      spawnY = seg.y[rootIdx];
    }
    savedOrientation = existing.orientationAngle;
  }

  // Clear all existing organisms + segments
  world.organisms.clear();
  world.segmentCount = 0;
  world.freeSegmentSlots.length = 0;
  world.stats.population = 0;
  world.stats.births = 0;
  world.stats.deaths = 0;

  spawnOrganismFromGenome(world, genome, spawnX, spawnY, engine.config, -1, 0);

  // Restore orientation so enforceAngularConstraints snaps to the same facing direction.
  // Without this the rep jumps as all children rotate to orientation=0 on the first tick.
  const newOrg = engine.getOrganism();
  if (newOrg) newOrg.orientationAngle = savedOrientation;
}


// ─── Engine Creation ─────────────────────────────────────────

export function createInspectorEngine(initialGenome: Genome): InspectorEngine {
  const world = createInspectorWorld();
  const config = { ...INSPECTOR_CONFIG };
  let accumulator = 0;

  const engine: InspectorEngine = {
    world,
    config,
    genome: initialGenome.map(g => ({ ...g })),
    paused: false,
    selectedGeneIdx: null,
    onGenomeChanged: null,
    onGeneSelected: null,

    update(deltaSeconds: number): void {
      if (engine.paused) return;

      const clamped = Math.min(deltaSeconds, 0.1);
      accumulator += clamped;

      while (accumulator >= SIM_DT) {
        tickInspector(world, config);
        accumulator -= SIM_DT;
      }
    },

    getOrganism(): Organism | null {
      for (const org of world.organisms.values()) {
        if (org.alive) return org;
      }
      return null;
    },

    // ── Genome mutation: color only (fast, no rebuild) ──
    setSegmentColor(geneIdx: number, color: SegmentColor): void {
      if (geneIdx < 0 || geneIdx >= engine.genome.length) return;
      engine.genome[geneIdx].color = color;

      const org = engine.getOrganism();
      if (org) {
        const segIdx = org.firstSegment + geneIdx;
        world.segments.color[segIdx] = color;
        // Update quick flags
        org.hasBlack = engine.genome.some(g => g.color === SegmentColor.Black);
        org.hasWhite = engine.genome.some(g => g.color === SegmentColor.White);
        org.hasYellow = engine.genome.some(g => g.color === SegmentColor.Yellow);
        org.genome[geneIdx].color = color;
        org.name = generateName(engine.genome);
      }
      engine.onGenomeChanged?.();
    },

    // ── Genome mutation: angle/length (requires topology rebuild) ──
    setSegmentAngle(geneIdx: number, angle: number): void {
      if (geneIdx < 0 || geneIdx >= engine.genome.length) return;
      engine.genome[geneIdx].angle = Math.max(-MAX_GENE_TURN_ANGLE, Math.min(MAX_GENE_TURN_ANGLE, angle));
      rebuildOrganism(engine, engine.genome);
      engine.onGenomeChanged?.();
    },

    setSegmentLength(geneIdx: number, length: number): void {
      if (geneIdx < 0 || geneIdx >= engine.genome.length) return;
      engine.genome[geneIdx].length = Math.max(0.4, Math.min(3.0, length));
      rebuildOrganism(engine, engine.genome);
      engine.onGenomeChanged?.();
    },

    // ── Smooth updates — update topology in-place, physics converges naturally ──
    softSetAngle(geneIdx: number, angle: number): void {
      if (geneIdx < 0 || geneIdx >= engine.genome.length) return;
      engine.genome[geneIdx].angle = Math.max(-MAX_GENE_TURN_ANGLE, Math.min(MAX_GENE_TURN_ANGLE, angle));
      const org = engine.getOrganism();
      if (org) org.topology = buildGenomeTopology(engine.genome);
    },

    softSetLength(geneIdx: number, length: number): void {
      if (geneIdx < 0 || geneIdx >= engine.genome.length) return;
      const clamped = Math.max(0.4, Math.min(3.0, length));
      engine.genome[geneIdx].length = clamped;
      const org = engine.getOrganism();
      if (org) {
        org.genome[geneIdx].length = clamped; // renderer reads org.genome for scale
        org.topology = buildGenomeTopology(engine.genome);
      }
    },

    moveRoot(wx: number, wy: number): void {
      const org = engine.getOrganism();
      if (!org) return;
      const seg = engine.world.segments;
      const root = org.firstSegment;
      const limit = INSPECTOR_TANK_RADIUS - SEGMENT_RADIUS;
      // Clamp to circular boundary
      const dist = Math.sqrt(wx * wx + wy * wy);
      if (dist > limit) { wx = (wx / dist) * limit; wy = (wy / dist) * limit; }
      seg.x[root] = wx;
      seg.y[root] = wy;
      seg.prevX[root] = wx; // zero velocity so organism doesn't drift after release
      seg.prevY[root] = wy;
    },

    // ── Add a new child gene ──
    addChild(parentGeneIdx: number, color: SegmentColor, angle: number, length: number): void {
      if (parentGeneIdx < 0 || parentGeneIdx >= engine.genome.length) return;
      const newGenome = engine.genome.map(g => ({ ...g }));
      newGenome.push({ color, angle, parent: parentGeneIdx, length });
      engine.genome = newGenome;
      rebuildOrganism(engine, engine.genome);
      // Auto-select the new gene
      const newIdx = engine.genome.length - 1;
      engine.selectedGeneIdx = newIdx;
      engine.onGeneSelected?.(newIdx);
      engine.onGenomeChanged?.();
    },

    // ── Delete a gene and all descendants ──
    deleteGene(geneIdx: number): void {
      if (geneIdx < 0 || geneIdx >= engine.genome.length) return;
      if (geneIdx === 0 && engine.genome.length === 1) return; // can't delete last gene

      const newGenome = deleteGeneSubtree(engine.genome, geneIdx);
      if (newGenome.length === 0) return; // safety

      engine.genome = newGenome;
      rebuildOrganism(engine, engine.genome);

      // Clear selection if selected gene was deleted
      if (engine.selectedGeneIdx !== null && engine.selectedGeneIdx >= engine.genome.length) {
        engine.selectedGeneIdx = null;
        engine.onGeneSelected?.(null);
      }
      engine.onGenomeChanged?.();
    },

    // ── Replace entire genome ──
    setGenome(genome: Genome): void {
      if (!isValidTreeGenome(genome)) return;
      engine.genome = genome.map(g => ({ ...g }));
      engine.selectedGeneIdx = null;
      rebuildOrganism(engine, engine.genome);
      engine.onGeneSelected?.(null);
      engine.onGenomeChanged?.();
    },

    // ── Selection ──
    selectGene(geneIdx: number | null): void {
      engine.selectedGeneIdx = geneIdx;
      engine.onGeneSelected?.(geneIdx);
    },

    setPaused(paused: boolean): void {
      engine.paused = paused;
    },

    getExportData() {
      const org = engine.getOrganism();
      return {
        genome: engine.genome.map(g => ({ ...g })),
        name: org?.name ?? generateName(engine.genome),
        generation: org?.generation ?? 0,
      };
    },
  };

  // Spawn initial organism
  rebuildOrganism(engine, engine.genome);

  return engine;
}


// ─── Inspector Motion ─────────────────────────────────────────

/**
 * Gentle drift for the inspector petri dish:
 * - Slow random translational walk (injects velocity via prevPos reduction)
 * - Very slow spin (much gentler than main-sim Brownian rotation)
 *
 * Strength values tuned so the rep wanders lazily without bouncing off walls
 * every second. VERLET_DAMPING=0.98 means velocity half-life ~1.7s, so a
 * drift impulse of 0.025/tick gives a comfortable low-speed cruise.
 */
function applyInspectorMotion(world: World): void {
  const seg = world.segments;
  const DRIFT = 0.025;   // translational impulse per tick (world units/tick velocity)
  const SPIN  = 0.004;   // max rotation per tick (radians) — about 5x gentler than main sim

  for (const org of world.organisms.values()) {
    if (!org.alive) continue;
    const root = org.firstSegment;
    if (!seg.alive[root]) continue;

    // Uniform translational drift — same impulse to every segment keeps it rigid-body
    const driftAngle = Math.random() * Math.PI * 2;
    const dvx = Math.cos(driftAngle) * DRIFT;
    const dvy = Math.sin(driftAngle) * DRIFT;
    for (let i = 0; i < org.segmentCount; i++) {
      const idx = root + i;
      if (!seg.alive[idx]) continue;
      seg.prevX[idx] -= dvx;   // velocity injection: vel = pos - prevPos
      seg.prevY[idx] -= dvy;
    }

    // Gentle spin — nudge stored orientation; rigid snap applies it to all segments.
    if (org.segmentCount >= 2) {
      org.orientationAngle += (Math.random() - 0.5) * 2 * SPIN;
    }
  }
}


// ─── Physics Tick ────────────────────────────────────────────

function tickInspector(world: World, config: SimConfig): void {
  world.tick++;

  // Verlet integration (applies existing velocity)
  integrateVerlet(world, config);

  // Gentle inspector-specific motion: slow drift + soft spin
  applyInspectorMotion(world);

  // Settle root against circular boundary before snapping shape
  enforceCircularBoundary(world, INSPECTOR_TANK_RADIUS);

  // Rigid body snap — hard-set all non-root segments to exact rest positions
  enforceAngularConstraints(world);

  // Final boundary pass
  enforceCircularBoundary(world, INSPECTOR_TANK_RADIUS);
}


// ─── Default Genome Presets ──────────────────────────────────

/** A single green root — minimal "blank slate". */
export function minimalGenome(): Genome {
  return [{ color: SegmentColor.Green, angle: 0, parent: -1, length: 1.0 }];
}

/** A symmetric bilateral organism: green hub + left/right arms. */
export function symmetricalGenome(): Genome {
  return [
    { color: SegmentColor.Green, angle: 0, parent: -1, length: 1.2 },   // root hub
    { color: SegmentColor.Blue,  angle: -Math.PI / 3, parent: 0, length: 1.0 },  // left arm
    { color: SegmentColor.Blue,  angle:  Math.PI / 3, parent: 0, length: 1.0 },  // right arm
    { color: SegmentColor.Yellow, angle: 0, parent: 1, length: 1.4 },   // left flagellum
    { color: SegmentColor.Yellow, angle: 0, parent: 2, length: 1.4 },   // right flagellum
  ];
}

/** Load a random organism genome (3–8 genes). */
export function randomInspectorGenome(): Genome {
  const segCount = 3 + Math.floor(Math.random() * 6);
  return createRandomGenome(segCount);
}

/** Get default angle for a new child segment based on parent color. */
export function getDefaultChildAngle(parentColor: SegmentColor): number {
  return defaultChildAngle(parentColor);
}

/** Get default length for a given segment color. */
export function getDefaultChildLength(color: SegmentColor): number {
  return defaultChildLength(color);
}
