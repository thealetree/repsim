/**
 * world.ts — World state creation and organism spawning
 *
 * The World is the single source of truth for the entire simulation.
 * It holds all segment data (in typed arrays for performance) and
 * all organism metadata.
 *
 * TREE STRUCTURE: Organisms are TREES of connected segments, not linear chains.
 * Each gene has a `parent` field pointing to its parent gene's index (-1 for root).
 * The genome array is topologically sorted — parent index < own index, always.
 *
 * Key functions:
 * - createWorld(): Creates an empty world with pre-allocated arrays
 * - spawnOrganismFromGenome(): Adds an organism with a specific genome
 * - spawnRandomOrganism(): Adds an organism with a random genome
 * - removeOrganism(): Marks an organism and its segments as dead
 * - seedPopulation(): Creates the starting population
 */

import type { World, Organism, Genome, SegmentArrays, SimConfig } from '../types';
import { SegmentColor, SEGMENT_COLOR_COUNT } from '../types';
import { createFoodParticles, spawnFood } from './food';
import { createVirusStrainPool, clearOrganismInfection } from './virus';
import {
  TANK_HALF_WIDTH,
  TANK_HALF_HEIGHT,
  TANK_GRID_SPACING,
  SEGMENT_BASE_HEALTH,
  getMaxReserve,
  getStartReserve,
  MIN_SEGMENTS,
  MAX_SEGMENTS,
  TIMED_DEATH_MIN_TICKS,
  TIMED_DEATH_MAX_TICKS,
  SEGMENT_CHAIN_DISTANCE,
  SEGMENT_CHAIN_BASE,
  SEGMENT_RADIUS,
  MAX_GENE_TURN_ANGLE,
  BLUR_LAYER_COUNT,
  BRANCH_PROBABILITY,
  FOOD_ENERGY_PER_SEGMENT,
  ORGANISM_KILL_ENERGY_FRACTION,
  ORGANISM_KILL_FOOD_REDUCTION,
  ORGANISM_KILL_MIN_ENERGY,
  REPRO_FILL_FRACTION,
  REPRO_METER_MAX,
  PREFERRED_ANGLE_CHANCE,
  PREFERRED_ANGLE_JITTER,
  COLOR_PREFERRED_ANGLES,
  COLOR_BRANCH_PROBABILITY,
  COLOR_LENGTH_RANGES,
  GENE_LENGTH_MIN,
  GENE_LENGTH_MAX,
  DEFAULT_CONFIG,
} from '../constants';
import { generateName } from './naming';
import { buildGenomeTopology } from './tree-utils';


// ─── Effects Queue ──────────────────────────────────────────
// Module-level queues that the renderer drains each frame.
// This avoids threading the EventBus through every behavior function.

export interface GhostSegmentData {
  x: number; y: number; color: number; depth: number;
}

export const effectsQueue = {
  births: [] as Array<{ id: number; x: number; y: number }>,
  deaths: [] as Array<{ segments: GhostSegmentData[]; cx: number; cy: number }>,
};


// ─── Random Helpers ──────────────────────────────────────────
// Small utility functions used throughout this file.

/** Get a random SegmentColor (0-4), uniformly distributed.
 *  V1 had a bug here — getRandomColor() used cascading if/else with
 *  non-uniform probabilities. V2 fixes this with proper uniform random.
 *  Exported for use by reproduction/mutation system. */
export function randomColor(): SegmentColor {
  return Math.floor(Math.random() * SEGMENT_COLOR_COUNT) as SegmentColor;
}

/**
 * Get a random turn angle for a genome gene, using chemistry-inspired
 * preferred angles based on the segment's color.
 *
 * Each color has 2-3 "likely" bond angles (like molecular geometry).
 * 60% of the time, the angle snaps to a preferred angle with jitter.
 * 40% of the time, it's pure random in [-MAX_TURN, +MAX_TURN].
 *
 * This makes symmetry statistically favored without hardcoding it.
 */
export function randomTurnAngle(color: SegmentColor): number {
  if (Math.random() < PREFERRED_ANGLE_CHANCE) {
    // Use a chemistry-inspired preferred angle for this color
    const prefs = COLOR_PREFERRED_ANGLES[color];
    if (prefs && prefs.length > 0) {
      const base = prefs[Math.floor(Math.random() * prefs.length)];
      const jitter = (Math.random() * 2 - 1) * PREFERRED_ANGLE_JITTER;
      const angle = base + jitter;
      // Clamp to max turn angle range
      return Math.max(-MAX_GENE_TURN_ANGLE, Math.min(MAX_GENE_TURN_ANGLE, angle));
    }
  }
  // Pure random fallback
  return (Math.random() * 2 - 1) * MAX_GENE_TURN_ANGLE;
}


/** Get a random gene length for a given color, within its preferred range */
export function randomGeneLength(color: SegmentColor): number {
  const range = COLOR_LENGTH_RANGES[color];
  if (range) return range[0] + Math.random() * (range[1] - range[0]);
  return GENE_LENGTH_MIN + Math.random() * (GENE_LENGTH_MAX - GENE_LENGTH_MIN);
}

/** Get a random float between min and max */
function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Get a random integer between min (inclusive) and max (inclusive) */
function randomInt(min: number, max: number): number {
  return Math.floor(randomRange(min, max + 1));
}


// ─── Tank Cell Helpers ───────────────────────────────────────
// The tank is defined by a set of grid cells. These helpers convert
// between world coordinates and grid indices (origin-centered).

/** Cell key string from col,row */
export function cellKey(col: number, row: number): string {
  return `${col},${row}`;
}

/** Convert world coordinates to grid cell indices (origin-centered) */
export function worldToCell(wx: number, wy: number): { col: number; row: number } {
  return {
    col: Math.floor(wx / TANK_GRID_SPACING),
    row: Math.floor(wy / TANK_GRID_SPACING),
  };
}

/** Convert grid cell indices to world-space center of that cell */
export function cellToWorld(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TANK_GRID_SPACING + TANK_GRID_SPACING / 2,
    y: row * TANK_GRID_SPACING + TANK_GRID_SPACING / 2,
  };
}

/** Check if a grid cell is a tank cell */
export function isTankCell(world: World, col: number, row: number): boolean {
  return world.tankCells.has(cellKey(col, row));
}

/** Rebuild the tankCellsArray from tankCells set */
export function syncTankCellsArray(world: World): void {
  world.tankCellsArray = Array.from(world.tankCells);
  world.tankCellsDirty = false;
}

/** Get a random position inside a random tank cell */
export function getRandomTankPosition(world: World): { x: number; y: number } {
  if (world.tankCellsDirty) syncTankCellsArray(world);
  if (world.tankCellsArray.length === 0) return { x: 0, y: 0 };

  const key = world.tankCellsArray[Math.floor(Math.random() * world.tankCellsArray.length)];
  const sep = key.indexOf(',');
  const col = Number(key.slice(0, sep));
  const row = Number(key.slice(sep + 1));

  // Random position within that cell (inset by segment radius to avoid edge spawns)
  const pad = SEGMENT_RADIUS * 2;
  return {
    x: col * TANK_GRID_SPACING + pad + Math.random() * (TANK_GRID_SPACING - pad * 2),
    y: row * TANK_GRID_SPACING + pad + Math.random() * (TANK_GRID_SPACING - pad * 2),
  };
}

/**
 * Initialize tankCells as the default Repsim tank — a complex cross with
 * internal corridors and corner rooms. This creates distinct ecological niches:
 * top/bottom arms, left/right rooms, narrow corridors, and a wide center.
 *
 * Layout (# = cell, . = wall/empty):
 *   ............################............   rows -18 to -12: top arm (16 wide)
 *   ..................####..................   rows -11 to -9: narrow corridor (4 wide)
 *   #########...################...#########  rows -8 to -3: rooms + center
 *   ########################################  rows -2 to 1: full width (40)
 *   #########...################...#########  rows 2 to 7: rooms + center
 *   ..................####..................   rows 8 to 10: narrow corridor (4 wide)
 *   ............################............   rows 11 to 17: bottom arm (16 wide)
 */
export function initDefaultTankCells(world: World): void {
  world.tankCells.clear();

  for (let col = -22; col <= 17; col++) {
    for (let row = -18; row <= 17; row++) {
      let include = false;

      if (row >= -18 && row <= -12) {
        // Top arm: cols -10 to 5 (16 wide)
        include = col >= -10 && col <= 5;
      } else if (row >= -11 && row <= -9) {
        // Narrow corridor: cols -1 to 2 (4 wide)
        include = col >= -1 && col <= 2;
      } else if (row >= -8 && row <= -3) {
        // Left room (cols -22 to -14) + center (cols -10 to 5) + right room (cols 9 to 17)
        include = (col >= -22 && col <= -14) || (col >= -10 && col <= 5) || (col >= 9 && col <= 17);
      } else if (row >= -2 && row <= 1) {
        // Full width: cols -22 to 17 (40 wide)
        include = col >= -22 && col <= 17;
      } else if (row >= 2 && row <= 7) {
        // Left room + center + right room (same as rows -8 to -3)
        include = (col >= -22 && col <= -14) || (col >= -10 && col <= 5) || (col >= 9 && col <= 17);
      } else if (row >= 8 && row <= 10) {
        // Narrow corridor: cols -1 to 2 (4 wide)
        include = col >= -1 && col <= 2;
      } else if (row >= 11 && row <= 17) {
        // Bottom arm: cols -10 to 5 (16 wide)
        include = col >= -10 && col <= 5;
      }

      if (include) {
        world.tankCells.add(cellKey(col, row));
      }
    }
  }
  world.tankCellsDirty = true;
}

/**
 * Initialize the default environment sources for the complex cross tank.
 * Creates ecological gradients: lit corridors (left/right lights),
 * hot top + cold bottom temperature zones, and a gentle center current.
 */
export function initDefaultEnvironment(world: World): void {
  // Two lights in the left and right arms
  world.lightSources = [
    { id: 1, x: -1464, y: -45, radius: 800, intensity: 2 },
    { id: 2, x: 1093, y: 6, radius: 950, intensity: 2 },
  ];
  world.nextLightSourceId = 3;

  // Hot top, cold bottom — creates a temperature gradient
  world.temperatureSources = [
    { id: 1, x: -156, y: -1216, radius: 1100, intensity: 2 },
    { id: 2, x: -137, y: 1241, radius: 1010, intensity: -2 },
  ];
  world.nextTemperatureSourceId = 3;

  // Gentle center current (whirlpool type, direction 0)
  world.currentSources = [
    { id: 1, x: -152, y: 53, radius: 600, strength: 1, type: 0, direction: 0 },
  ];
  world.nextCurrentSourceId = 2;
}


// ─── World Creation ──────────────────────────────────────────

/**
 * Create a new, empty world with pre-allocated arrays.
 *
 * We allocate arrays for MAX possible segments upfront so we never need
 * to resize during gameplay (resizing typed arrays means copying everything).
 * A population of 100 organisms x 15 segments = 1500 max, but we allocate
 * extra for safety during birth/death transitions.
 */
export function createWorld(config: SimConfig = DEFAULT_CONFIG): World {
  // Generous allocation: repLimit * maxSegments * 1.5 for birth/death overlap
  const maxSegments = Math.ceil(config.repLimit * MAX_SEGMENTS * 1.5);

  const world: World = {
    segments: createSegmentArrays(maxSegments),
    organisms: new Map(),
    segmentCount: 0,
    maxSegments,
    nextOrganismId: 1,
    tankHalfWidth: TANK_HALF_WIDTH,
    tankHalfHeight: TANK_HALF_HEIGHT,
    tick: 0,
    stats: { births: 0, deaths: 0, population: 0 },
    freeSegmentSlots: [],
    tankCells: new Set(),
    tankCellsArray: [],
    tankCellsDirty: true,
    lightSources: [],
    temperatureSources: [],
    currentSources: [],
    nextLightSourceId: 1,
    nextTemperatureSourceId: 1,
    nextCurrentSourceId: 1,
    dayNightEnabled: false,
    dayNightPhase: 0.5,         // Start at noon
    dayNightSpeed: 0.5,         // DAY_NIGHT_DEFAULT_SPEED
    food: createFoodParticles(),
    virusStrains: createVirusStrainPool(),
    isLightTheme: false,
  };

  initDefaultTankCells(world);
  initDefaultEnvironment(world);
  return world;
}

/**
 * Allocate all the typed arrays for segment storage.
 * Every array has the same length — index N in each array refers to the same segment.
 */
function createSegmentArrays(maxSegments: number): SegmentArrays {
  return {
    x: new Float32Array(maxSegments),
    y: new Float32Array(maxSegments),
    prevX: new Float32Array(maxSegments),
    prevY: new Float32Array(maxSegments),
    renderPrevX: new Float32Array(maxSegments),
    renderPrevY: new Float32Array(maxSegments),
    health: new Float32Array(maxSegments),
    color: new Uint8Array(maxSegments),
    organismId: new Uint32Array(maxSegments),
    isRoot: new Uint8Array(maxSegments),
    alive: new Uint8Array(maxSegments),
    parentOffset: new Int8Array(maxSegments),
    segmentDepth: new Float32Array(maxSegments),
    restLength: new Float32Array(maxSegments),
    virusStrainId: new Uint16Array(maxSegments),
    virusInfectedAt: new Uint32Array(maxSegments),
  };
}


// ─── Genome Creation ─────────────────────────────────────────

/**
 * Check whether a genome's TREE layout would cause any non-parent-child
 * segments to overlap (distance < 2 * SEGMENT_RADIUS).
 *
 * We lay out the tree from (0,0) in topological order (array index order)
 * and check all non-parent-child pairs. O(n²) but n ≤ 15, so it's instant.
 */
export function isGenomeSelfIntersecting(genome: Genome): boolean {
  const minDistSq = (SEGMENT_RADIUS * 2) * (SEGMENT_RADIUS * 2);
  const n = genome.length;
  const xs = new Array<number>(n);
  const ys = new Array<number>(n);
  const incomingAngle = new Array<number>(n);

  // Place root at origin
  xs[0] = 0;
  ys[0] = 0;
  incomingAngle[0] = 0; // arbitrary initial direction for validation

  // Layout tree in topological order (index order, since genome is topologically sorted)
  for (let i = 1; i < n; i++) {
    const p = genome[i].parent;
    const angle = incomingAngle[p] + genome[i].angle;
    incomingAngle[i] = angle;
    const parentLength = genome[p].length;
    const chainDist = SEGMENT_CHAIN_BASE * (parentLength + genome[i].length);
    xs[i] = xs[p] + Math.cos(angle) * chainDist;
    ys[i] = ys[p] + Math.sin(angle) * chainDist;
  }

  // Check all non-parent-child pairs for overlap
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Skip if i is j's parent or j is i's parent
      if (genome[j].parent === i || genome[i].parent === j) continue;

      const dx = xs[j] - xs[i];
      const dy = ys[j] - ys[i];
      if (dx * dx + dy * dy < minDistSq) return true;
    }
  }

  return false;
}

/**
 * Generate a random genome with TREE topology.
 *
 * Each gene has a `parent` field pointing to its parent gene's index.
 * The genome is topologically sorted (parent index < own index, always).
 *
 * Growth strategy:
 * - 70% of the time: extend an existing tip (like chain growth)
 * - 30% of the time: branch from any existing gene (creates Y-forks, starfish, etc.)
 *
 * Turn angles use chemistry-inspired preferred angles based on color,
 * which statistically encourages bilateral and radial symmetry.
 *
 * Validates that the tree shape doesn't self-intersect; regenerates if it does.
 */
export function createRandomGenome(segmentCount: number): Genome {
  const MAX_ATTEMPTS = 50;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const genome: Genome = [];

    // Gene 0: root (no parent)
    const rootColor = randomColor();
    genome.push({
      color: rootColor,
      angle: randomTurnAngle(rootColor),
      parent: -1,
      length: randomGeneLength(rootColor),
    });

    // Track which gene indices are "tips" (leaves with no children yet).
    // Tips are preferred for chain-like growth; picking non-tips creates branches.
    const tips: number[] = [0];

    for (let i = 1; i < segmentCount; i++) {
      let parentIdx: number;

      // Branch decision based on the TIP's color (the segment we'd extend from).
      // Green/Blue (carbon-like) branch 70% of the time → radial hubs.
      // Yellow/Red/Black branch rarely → serial chains/appendages.
      const tipIdx = tips.length > 0 ? tips[tips.length - 1] : 0;
      const branchProb = COLOR_BRANCH_PROBABILITY[genome[tipIdx].color] ?? BRANCH_PROBABILITY;

      if (tips.length > 0 && Math.random() > branchProb) {
        // EXTEND: grow from the most recent tip (produces longer chains)
        parentIdx = tips[tips.length - 1];
        // This tip now has a child, so it's no longer a tip
        tips.pop();
      } else {
        // BRANCH: pick any existing gene as parent (creates a new branch)
        parentIdx = Math.floor(Math.random() * i);
      }

      const color = randomColor();
      genome.push({
        color,
        angle: randomTurnAngle(color),
        parent: parentIdx,
        length: randomGeneLength(color),
      });

      // The new gene is now a tip
      tips.push(i);
    }

    // Accept if no self-intersection (or on last attempt, accept anyway)
    if (!isGenomeSelfIntersecting(genome) || attempt === MAX_ATTEMPTS - 1) {
      return genome;
    }
  }

  // Unreachable, but TypeScript needs it
  const fallbackColor = randomColor();
  return [{ color: fallbackColor, angle: 0, parent: -1, length: randomGeneLength(fallbackColor) }];
}


// ─── Segment Allocation ──────────────────────────────────────

/**
 * Allocate segment slots for a new organism.
 * Returns the starting index, or -1 if there's no room.
 *
 * First tries to reuse a contiguous block from freed organism slots.
 * Falls back to appending at the end of the used segment range.
 *
 * freeSegmentSlots stores [start, count] pairs (flattened: even = start, odd = count).
 */
function allocateSegments(world: World, count: number): number {
  // Try to reuse a freed contiguous block
  const free = world.freeSegmentSlots;
  for (let i = 0; i < free.length; i += 2) {
    const freeStart = free[i];
    const freeCount = free[i + 1];
    if (freeCount >= count) {
      // Use this block (or part of it)
      if (freeCount === count) {
        // Exact fit — remove the entry
        free.splice(i, 2);
      } else {
        // Partial use — shrink the entry
        free[i] = freeStart + count;
        free[i + 1] = freeCount - count;
      }
      return freeStart;
    }
  }

  // No reusable block found — append at end
  if (world.segmentCount + count > world.maxSegments) {
    return -1; // No room!
  }
  const start = world.segmentCount;
  world.segmentCount += count;
  return start;
}


// ─── Organism Spawning ───────────────────────────────────────

/**
 * Spawn a new organism from a specific genome at a specific position.
 * This is the core spawning function — both random spawning and reproduction use this.
 *
 * TREE LAYOUT: Segments are placed in topological order (index order).
 * The root is placed at (spawnX, spawnY). Each subsequent gene is placed
 * relative to its parent's position at the gene's turn angle.
 *
 * @param world The world to spawn into
 * @param genome The genome to build from (must be a valid tree genome)
 * @param spawnX Starting X position (root segment)
 * @param spawnY Starting Y position (root segment)
 * @param config Simulation config (needed for blueHP)
 * @param parentId ID of parent organism (-1 if none)
 * @param generation Generation number (0 for original spawns)
 * @returns The created organism, or null if world is full
 */
export function spawnOrganismFromGenome(
  world: World,
  genome: Genome,
  spawnX: number,
  spawnY: number,
  config: SimConfig,
  parentId: number = -1,
  generation: number = 0,
): Organism | null {
  const count = genome.length;
  const firstSegment = allocateSegments(world, count);

  if (firstSegment === -1) {
    return null; // World is full
  }

  // Check if this organism has any black/white/yellow/green/red segments (quick flags)
  const hasBlack = genome.some(g => g.color === SegmentColor.Black);
  const hasWhite = genome.some(g => g.color === SegmentColor.White);
  const hasYellow = genome.some(g => g.color === SegmentColor.Yellow);
  const hasGreen = genome.some(g => g.color === SegmentColor.Green);
  const hasRed = genome.some(g => g.color === SegmentColor.Red);

  // Build tree topology (cached for constraints/rendering)
  const topology = buildGenomeTopology(genome);

  // Create the organism metadata
  const id = world.nextOrganismId++;

  // Compute yellow movement interval from config
  // V1: yellowFreq = 1.25 seconds → at 20 tps = 25 ticks
  const yellowIntervalTicks = Math.round(config.yellowFreq * 20);

  // Compute genome fingerprint once at spawn (used by charts for species diversity).
  // Species = same color sequence + tree topology. Angle/length differences are
  // individual variation within a species, not speciation events.
  const fingerprint = genome.map(g => `${g.color}:${g.parent}`).join(',');

  const organism: Organism = {
    id,
    firstSegment,
    segmentCount: count,
    genome: genome.map(g => ({ ...g })), // Deep copy — mutations don't affect parent
    name: generateName(genome),
    rootHealthReserve: getStartReserve(count),
    rootHealthReserveMax: getMaxReserve(count),
    reproMeter: 0,
    generation,
    childCount: 0,
    alive: true,
    depth: Math.random(), // Random depth for 2.5D effect
    depthTarget: Math.random(), // Initial target — organism will drift toward this
    timedDeathAt: world.tick + randomInt(TIMED_DEATH_MIN_TICKS, TIMED_DEATH_MAX_TICKS),
    hasBlack,
    hasWhite,
    hasYellow,
    hasGreen,
    hasRed,
    immuneTo: new Set(),
    virusInfectionCount: 0,
    parentId,
    nextMoveTick: world.tick + randomInt(1, yellowIntervalTicks), // Stagger initial movement
    lastAttackTick: 0,
    topology,
    fingerprint,
    killedByOrgId: -1,
    orientationAngle: 0, // updated each tick by angular constraint (first tick sets it from first-child position)
    angularVelocity: 0,
  };

  // ─── Place segments in a TREE ───
  // Root goes at (spawnX, spawnY). Each subsequent gene is placed relative
  // to its parent, at SEGMENT_CHAIN_DISTANCE away at the computed angle.
  //
  // We track the "incoming angle" at each gene index — the direction the
  // chain was heading when it arrived at this gene. Children branch from
  // this direction by adding their own gene.angle.

  const seg = world.segments;
  const incomingAngle = new Array<number>(count);

  // Place root segment
  const rootIdx = firstSegment;
  incomingAngle[0] = Math.random() * Math.PI * 2; // Random initial direction
  seg.x[rootIdx] = spawnX;
  seg.y[rootIdx] = spawnY;
  seg.prevX[rootIdx] = spawnX; // No initial velocity
  seg.prevY[rootIdx] = spawnY;
  seg.renderPrevX[rootIdx] = spawnX; // Match spawn position so first-frame lerp is correct
  seg.renderPrevY[rootIdx] = spawnY;
  seg.health[rootIdx] = SEGMENT_BASE_HEALTH
    + (genome[0].color === SegmentColor.Blue ? genome[0].length * config.blueHP : 0);
  seg.color[rootIdx] = genome[0].color;
  seg.organismId[rootIdx] = id;
  seg.isRoot[rootIdx] = 1;
  seg.alive[rootIdx] = 1;
  seg.parentOffset[rootIdx] = 0; // Root has no parent
  seg.segmentDepth[rootIdx] = organism.depth; // Per-segment depth starts at organism depth
  seg.restLength[rootIdx] = 0; // Root has no parent chain distance

  // Place all other segments in topological order (index 1..N-1)
  // Topological sort guarantee: genome[i].parent < i, so parent is already placed
  for (let i = 1; i < count; i++) {
    const gene = genome[i];
    const parentGeneIdx = gene.parent;
    const parentGlobalIdx = firstSegment + parentGeneIdx;
    const myGlobalIdx = firstSegment + i;

    // Variable chain distance — sqrt-compressed average of parent + child length.
    // Sqrt compression prevents huge gaps at branch points where only the parent's
    // narrow pill width (not length) faces the branch child.
    const parentLength = genome[parentGeneIdx].length;
    const chainDist = SEGMENT_CHAIN_BASE * (parentLength + gene.length);

    // Compute outgoing angle: parent's incoming angle + this gene's turn angle
    const outAngle = incomingAngle[parentGeneIdx] + gene.angle;
    incomingAngle[i] = outAngle;

    // Place this segment at variable chain distance from parent
    seg.x[myGlobalIdx] = seg.x[parentGlobalIdx] + Math.cos(outAngle) * chainDist;
    seg.y[myGlobalIdx] = seg.y[parentGlobalIdx] + Math.sin(outAngle) * chainDist;
    seg.prevX[myGlobalIdx] = seg.x[myGlobalIdx]; // No initial velocity
    seg.prevY[myGlobalIdx] = seg.y[myGlobalIdx];
    seg.renderPrevX[myGlobalIdx] = seg.x[myGlobalIdx]; // Match spawn position
    seg.renderPrevY[myGlobalIdx] = seg.y[myGlobalIdx];

    // Health: base + blue bonus (scaled by length)
    seg.health[myGlobalIdx] = SEGMENT_BASE_HEALTH
      + (gene.color === SegmentColor.Blue ? gene.length * config.blueHP : 0);

    seg.color[myGlobalIdx] = gene.color;
    seg.organismId[myGlobalIdx] = id;
    seg.isRoot[myGlobalIdx] = 0;
    seg.alive[myGlobalIdx] = 1;

    // Parent offset: how to find parent from this segment's global index
    // parentGlobalIdx = myGlobalIdx + parentOffset → parentOffset = parentGeneIdx - i
    seg.parentOffset[myGlobalIdx] = parentGeneIdx - i;

    // Per-segment depth starts uniform (wave propagation creates variation over time)
    seg.segmentDepth[myGlobalIdx] = organism.depth;

    // Store rest length for physics constraints
    seg.restLength[myGlobalIdx] = chainDist;
  }

  // Initialize orientationAngle from first child's actual placed position (if genome has >1 gene)
  if (genome.length > 1 && topology.children[0].length > 0) {
    const firstChildGeneIdx = topology.children[0][0];
    const firstChildGlobal = firstSegment + firstChildGeneIdx;
    const dx = seg.x[firstChildGlobal] - seg.x[firstSegment];
    const dy = seg.y[firstChildGlobal] - seg.y[firstSegment];
    organism.orientationAngle = Math.atan2(dy, dx);
  }

  // Register the organism in the world
  world.organisms.set(id, organism);
  world.stats.population++;
  world.stats.births++;

  // Queue birth effect for renderer
  effectsQueue.births.push({ id, x: spawnX, y: spawnY });

  return organism;
}

/**
 * Compute the depth layer index (0 to BLUR_LAYER_COUNT-1) for a given depth value.
 * Used by both spawn spacing and collision checks to ensure consistency.
 */
export function getDepthLayer(depth: number): number {
  return Math.min(BLUR_LAYER_COUNT - 1, Math.floor(depth * BLUR_LAYER_COUNT));
}

/**
 * Check if a spawn position is too close to any existing organism on the same depth layer.
 * Returns true if the position is clear, false if it overlaps.
 *
 * For tree organisms, we estimate the max extent as the tree's depth × chain distance
 * (a tree can spread wider than a chain of the same segment count).
 */
function isSpawnPositionClear(
  world: World,
  x: number,
  y: number,
  depth: number,
  genomeLength: number,
): boolean {
  const spawnLayer = getDepthLayer(depth);
  // Conservative estimate: organism extent = segCount × chainDistance
  // (trees can spread in any direction, so radius ≈ segCount × chainDist)
  const minDist = genomeLength * SEGMENT_CHAIN_DISTANCE + SEGMENT_RADIUS * 4;
  const minDistSq = minDist * minDist;

  for (const org of world.organisms.values()) {
    if (!org.alive) continue;

    // Only check organisms on the same depth layer
    if (getDepthLayer(org.depth) !== spawnLayer) continue;

    // Check distance to this organism's root segment
    const rootIdx = org.firstSegment;
    const dx = world.segments.x[rootIdx] - x;
    const dy = world.segments.y[rootIdx] - y;
    if (dx * dx + dy * dy < minDistSq) return false;
  }

  return true;
}

/**
 * Spawn a random organism at a random position inside the dish.
 * Used for initial population seeding.
 *
 * Tries multiple positions to find one that doesn't overlap with
 * existing organisms on the same depth layer. If no clear position
 * is found after several attempts, spawns anyway (better than failing).
 */
export function spawnRandomOrganism(world: World, config: SimConfig): Organism | null {
  // Random segment count between min and max
  const segCount = randomInt(MIN_SEGMENTS, MAX_SEGMENTS);
  const genome = createRandomGenome(segCount);

  // Random depth for 2.5D effect
  const depth = Math.random();

  // Try to find a clear spawn position inside tank cells (up to 20 attempts)
  let x = 0, y = 0;

  for (let attempt = 0; attempt < 20; attempt++) {
    const pos = getRandomTankPosition(world);
    x = pos.x;
    y = pos.y;

    if (isSpawnPositionClear(world, x, y, depth, segCount)) break;
  }

  // Spawn with pre-determined depth (overriding the random one in spawnOrganismFromGenome)
  const org = spawnOrganismFromGenome(world, genome, x, y, config);
  if (org) org.depth = depth;
  return org;
}

/**
 * Mark an organism and all its segments as dead.
 * The segment slots remain occupied but are skipped by all systems.
 */
export function removeOrganism(world: World, id: number): void {
  const org = world.organisms.get(id);
  if (!org || !org.alive) return;

  // Capture segment data for death animation BEFORE marking dead
  const seg = world.segments;
  const ghostSegs: GhostSegmentData[] = [];

  // Get viral color from strain BEFORE clearing infection
  let viralFoodColor = -1; // -1 = not viral
  if (org.virusInfectionCount > 0) {
    for (let i = 0; i < org.segmentCount; i++) {
      const spIdx = seg.virusStrainId[org.firstSegment + i];
      if (spIdx > 0) {
        const strain = world.virusStrains.strains[spIdx - 1];
        if (strain?.alive) viralFoodColor = strain.colorAffinity;
        break;
      }
    }
  }

  // ── Energy-on-Kill: transfer stored energy to the killer ──
  const wasKilledByPredator = org.killedByOrgId >= 0;
  if (wasKilledByPredator) {
    const killer = world.organisms.get(org.killedByOrgId);
    if (killer && killer.alive) {
      const transferAmount = Math.max(
        ORGANISM_KILL_MIN_ENERGY,
        org.rootHealthReserve * ORGANISM_KILL_ENERGY_FRACTION,
      );
      killer.rootHealthReserve += transferAmount;
      killer.rootHealthReserve = Math.min(killer.rootHealthReserve, killer.rootHealthReserveMax);
      // Active energy fills repro meter
      killer.reproMeter = Math.min(REPRO_METER_MAX, killer.reproMeter + transferAmount * REPRO_FILL_FRACTION);
    }
  }

  // Food energy per particle: reduced when killed by predator (anti-double-dipping)
  const foodEnergy = wasKilledByPredator
    ? FOOD_ENERGY_PER_SEGMENT * ORGANISM_KILL_FOOD_REDUCTION
    : FOOD_ENERGY_PER_SEGMENT;

  let cx = 0, cy = 0, aliveCount = 0;
  for (let i = 0; i < org.segmentCount; i++) {
    const idx = org.firstSegment + i;
    if (seg.alive[idx]) {
      ghostSegs.push({
        x: seg.x[idx],
        y: seg.y[idx],
        color: seg.color[idx],
        depth: seg.segmentDepth[idx],
      });
      cx += seg.x[idx];
      cy += seg.y[idx];
      aliveCount++;

      // Drop food particle — reduced energy if killed by red; viral color if infected
      spawnFood(world.food, seg.x[idx], seg.y[idx],
        foodEnergy, seg.segmentDepth[idx], world.tick, viralFoodColor);
    }
  }
  if (aliveCount > 0) {
    cx /= aliveCount;
    cy /= aliveCount;
    effectsQueue.deaths.push({ segments: ghostSegs, cx, cy });
  }

  org.alive = false;

  // Clear virus infection before marking dead (decrements strain host count)
  if (org.virusInfectionCount > 0) {
    clearOrganismInfection(world, org);
  }

  // Mark all of this organism's segments as dead
  for (let i = 0; i < org.segmentCount; i++) {
    const idx = org.firstSegment + i;
    seg.alive[idx] = 0;
    // Clear virus arrays so recycled slots start clean
    seg.virusStrainId[idx] = 0;
    seg.virusInfectedAt[idx] = 0;
  }

  // Return the contiguous segment block to the free list for reuse.
  // Stored as [start, count] pairs (flattened).
  world.freeSegmentSlots.push(org.firstSegment, org.segmentCount);

  world.stats.population--;
  world.stats.deaths++;

  // Remove from the Map so hot loops don't iterate dead entries.
  // Every system checks `org.alive` anyway, but leaving dead entries causes
  // unbounded Map growth over time and wastes iteration budget.
  world.organisms.delete(id);
}

/**
 * Seed the world with the starting population of random organisms.
 */
export function seedPopulation(world: World, config: SimConfig): void {
  for (let i = 0; i < config.repCount; i++) {
    spawnRandomOrganism(world, config);
  }
}
