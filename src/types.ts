/**
 * types.ts — Core type definitions for Repsim V2
 *
 * This file defines ALL the data structures used across the simulation.
 * Everything is typed so TypeScript catches bugs at compile time.
 *
 * Key concepts:
 * - SegmentColor: The 5 colors that determine organism behavior
 * - Gene/Genome: The DNA of each organism (color + angle per segment)
 * - SegmentArrays: "Struct of Arrays" — stores segment data in typed arrays
 *   for cache-friendly iteration (much faster than arrays of objects)
 * - Organism: The living entity — tracks its segment range, health, etc.
 * - World: The complete simulation state at any point in time
 */

// ─── Segment Colors ───────────────────────────────────────────
// These are the 6 biological roles. Using 'as const' object pattern
// instead of TypeScript `enum` because our tsconfig has erasableSyntaxOnly
// (enums generate runtime code, which strict TS mode doesn't allow).

export const SegmentColor = {
  Green: 0,   // Photosynthesis — generates energy from light
  Blue: 1,    // HP Reserve — extra health capacity
  Yellow: 2,  // Movement — thrust along segment direction
  Red: 3,     // Attack — deals damage on collision
  Black: 4,   // Sexual Reproduction — enables mating on collision
  White: 5,   // Scavenger — eats food particles from dead organisms
} as const;

// This creates a type from the object values: 0 | 1 | 2 | 3 | 4 | 5
export type SegmentColor = typeof SegmentColor[keyof typeof SegmentColor];

// Total number of colors — used for random selection
export const SEGMENT_COLOR_COUNT = 6;


// ─── Virus Effects ──────────────────────────────────────────
// Each virus strain rolls 1-2 of these effects when created.

export const VirusEffect = {
  Swelling: 0,           // 1.3x segment scale — bigger collision profile
  EnergyDrain: 1,        // Siphon HP from rootHealthReserve
  JointWeakness: 2,      // Rest lengths wobble ±20% — organism becomes shaky
  ColorCorruption: 3,    // Probabilistic behavior suppression (green stops photo, etc.)
  ReproductionHijack: 4, // Black segments sometimes produce viral blooms instead of children
} as const;
export type VirusEffect = typeof VirusEffect[keyof typeof VirusEffect];
export const VIRUS_EFFECT_COUNT = 5;


// ─── Viral Strain ───────────────────────────────────────────
// A virus strain is a small evolving genome — color affinity, virulence,
// transmission rate, and 1-2 effects. Strains mutate on spread.

export interface ViralStrain {
  id: number;                    // Monotonic ID (never reused)
  colorAffinity: SegmentColor;   // Which segment color this strain infects
  virulence: number;             // 0-1, how aggressively it drains HP
  transmissionRate: number;      // 0-1, chance to spread on collision
  effects: VirusEffect[];        // 1-2 effects rolled at strain creation
  effectsMask: number;           // Bitmask of effects (1 << effect) for O(1) hot-path checks
  parentStrainId: number;        // -1 for spontaneous origin
  alive: boolean;                // For pool reuse
  hostCount: number;             // Number of currently infected segments
}

/** Convert effects array to a bitmask for fast hot-path checks. */
export function effectsToMask(effects: VirusEffect[]): number {
  let mask = 0;
  for (const e of effects) mask |= (1 << e);
  return mask;
}

export interface VirusStrainPool {
  strains: ViralStrain[];        // Fixed-size pool (VIRUS_MAX_STRAINS)
  freeSlots: number[];           // Stack of free pool indices
  nextStrainId: number;          // Monotonic ID counter
}


// ─── Genome ──────────────────────────────────────────────────
// A genome is a list of genes, one per segment in the organism.
// Each gene says: "this segment is [color] and points at [angle] relative to parent"

export interface Gene {
  color: SegmentColor;
  angle: number;   // radians — turn angle relative to parent's incoming direction
  parent: number;  // index of parent gene in the genome array (-1 for root)
  length: number;  // 0.6-1.6 multiplier on chain distance + visual pill length
}

export type Genome = Gene[];

/**
 * Precomputed tree topology for a genome — derived from parent references.
 * Built once at spawn time, cached on the Organism for constraints/rendering.
 */
export interface GenomeTopology {
  /** children[i] = array of gene indices whose parent === i */
  children: number[][];
  /** childCount[i] = number of children of gene i */
  childCount: number[];
  /** isLeaf[i] = true if gene i has no children */
  isLeaf: boolean[];
  /** depth[i] = distance from root (root = 0) */
  depth: number[];
  /** cos(cumulative angle from root to gene i) — pre-computed at spawn for angular constraints */
  cosCumAngle: Float64Array;
  /** sin(cumulative angle from root to gene i) — pre-computed at spawn for angular constraints */
  sinCumAngle: Float64Array;
  /** Pre-computed chain distance per gene (0 for root) */
  chainDist: Float64Array;
}


// ─── Segment Storage (Struct of Arrays) ──────────────────────
// Instead of: segments = [{ x: 1, y: 2, health: 100 }, ...]
// We use:     x = [1, 3, ...], y = [2, 4, ...], health = [100, 200, ...]
//
// Why? When the physics loop needs to update ALL positions, it reads x[]
// and y[] which are contiguous in memory → CPU cache hits → much faster
// for 1000+ segments than an array of objects.

export interface SegmentArrays {
  // Position (current frame) — where the segment IS right now
  x: Float32Array;
  y: Float32Array;

  // Previous position — where the segment WAS last frame
  // Verlet integration uses (current - previous) as implicit velocity
  prevX: Float32Array;
  prevY: Float32Array;

  // Render-time previous positions — snapshotted at the START of each sim tick.
  // The renderer lerps between renderPrevX/Y (start of tick) and x/y (end of tick)
  // using getAlpha(), so every rendered frame gets a smoothly interpolated position
  // even when no new tick has occurred (e.g. 3 render frames per 1 tick at 1x speed).
  renderPrevX: Float32Array;
  renderPrevY: Float32Array;

  // Health per segment (starts at 1000; blue segments get bonus)
  health: Float32Array;

  // Color of each segment (0-4, maps to SegmentColor)
  color: Uint8Array;

  // Which organism this segment belongs to (organism ID)
  organismId: Uint32Array;

  // Is this the root (first) segment of an organism? (0 or 1)
  isRoot: Uint8Array;

  // Is this segment alive? (0 or 1) — dead segments are skipped
  alive: Uint8Array;

  // Offset from this segment's global index to its parent's global index.
  // For gene i with parent gene p: parentOffset = p - i (always ≤ 0).
  // Root segments store 0 (no parent). To find parent: parentGlobalIdx = thisIdx + parentOffset[thisIdx]
  parentOffset: Int8Array;

  // Per-segment depth in the dish (0 = deep/blurred, 1 = shallow/sharp).
  // Unlike org.depth which is uniform, individual segments can be at different
  // depths — root leads the dive and children follow with a delay, creating a
  // wave propagation "diving through layers" effect along the organism's body.
  segmentDepth: Float32Array;

  // Per-segment rest distance to parent (0 for root).
  // Derived from gene.length * SEGMENT_CHAIN_DISTANCE at spawn time.
  restLength: Float32Array;

  // Virus infection per segment: 0 = uninfected, >0 = strain pool index + 1
  virusStrainId: Uint16Array;
  // Tick when this segment was infected (for immunity timer calculation)
  virusInfectedAt: Uint32Array;
}


// ─── Organism ────────────────────────────────────────────────
// An organism is a TREE of connected segments. It's the "creature" the player sees.
// The organism doesn't store segment positions directly — those live in SegmentArrays.
// Instead it stores the INDEX RANGE into those arrays.

export interface Organism {
  id: number;

  // Segment indices — which slots in SegmentArrays belong to this organism
  // segments[firstSegment] through segments[firstSegment + segmentCount - 1]
  firstSegment: number;
  segmentCount: number;

  // The genome that built this organism
  genome: Genome;

  // Display name (from color syllables: Red=Ba, Blue=De, Green=Ti, Yellow=Mo, Black=Cu)
  name: string;

  // Main health pool shared across all segments
  // Photosynthesis fills this, root drain depletes it
  rootHealthReserve: number;

  // Size-scaled max HP reserve (from getMaxReserve at spawn)
  rootHealthReserveMax: number;

  // Fills up when healthy; triggers reproduction when full
  reproMeter: number;

  // How many generations back to the original spawned organism
  generation: number;

  // Number of children this organism has produced
  childCount: number;

  // Is this organism still alive?
  alive: boolean;

  // Depth in the dish (0 = bottom/deep, 1 = top/shallow) — for 2.5D blur effect
  depth: number;

  // Target depth this organism is drifting toward (smooth lerp, not instant)
  depthTarget: number;

  // Simulation tick when this organism will die of old age
  timedDeathAt: number;

  // Quick flag: does this organism have at least one black segment?
  hasBlack: boolean;

  // Quick flag: does this organism have at least one white segment?
  // Used for organism-wide food scavenging (any segment eats food if org has white)
  hasWhite: boolean;

  // Quick flag: does this organism have at least one yellow segment?
  // Used to skip Brownian rotation (yellow organisms rotate from thrust)
  hasYellow: boolean;

  // Set of strain IDs this organism is immune to (survives infection → gains immunity)
  immuneTo: Set<number>;

  // Count of currently infected segments (quick aggregate for UI/logic)
  virusInfectionCount: number;

  // ID of parent organism (-1 if originally spawned)
  parentId: number;

  // Tick when this organism's yellow segments next fire movement thrust
  nextMoveTick: number;

  // Tick when this organism last dealt red attack damage (cooldown tracking)
  lastAttackTick: number;

  // Precomputed tree topology — children lists, leaf flags, depths
  // Built once at spawn time from the genome's parent references.
  topology: GenomeTopology;

  // Species fingerprint — hash of genome structure, computed once at spawn.
  // Used by charts for O(1) species diversity counting instead of per-sample recomputation.
  fingerprint: string;

  // ID of the organism whose red attack killed this organism (-1 = natural death).
  // Set during runRedAttack, read by removeOrganism to transfer energy.
  killedByOrgId: number;

  // Smoothed orientation angle (radians) — the organism's heading derived from the
  // previous tick's first-child direction. Updated AFTER angular corrections each tick
  // so it reflects post-correction state. Using last-tick angle (not live) prevents the
  // first-child's jitter from instantly snapping all downstream segments.
  orientationAngle: number;
  angularVelocity: number;   // Radians/tick — decays via damping, injected by wall bounces/collisions/Brownian
}


// ─── Food Particles (Death Drops) ───────────────────────────
// When segments die, they scatter food particles. Red and White segments
// can eat them, creating an emergent food chain. SoA layout for performance.

export interface FoodParticles {
  x: Float32Array;
  y: Float32Array;
  energy: Float32Array;       // Remaining energy value
  spawnTick: Uint32Array;     // Tick when spawned (for decay calculation)
  alive: Uint8Array;          // 0 = free slot, 1 = active
  driftDx: Float32Array;      // Random drift direction X
  driftDy: Float32Array;      // Random drift direction Y
  depth: Float32Array;        // Depth layer for 2.5D rendering
  isViral: Uint8Array;         // 0 = normal food, 1 = viral (causes infection on consumption)
  count: number;              // Active particle count
  freeSlots: number[];        // Stack of free indices for O(1) alloc
}


// ─── World State ─────────────────────────────────────────────
// The complete state of the simulation at any point in time.
// The renderer reads this to draw. The UI reads stats.
// NOTHING else should store game state — this is the single source of truth.

export interface World {
  // All segment data in typed arrays
  segments: SegmentArrays;

  // All living organisms, keyed by ID
  organisms: Map<number, Organism>;

  // How many segment slots are currently in use
  segmentCount: number;

  // Maximum segment slots allocated
  maxSegments: number;

  // Next organism ID to assign (increments forever, never reused)
  nextOrganismId: number;

  // Tank dimensions (rounded rectangle)
  tankHalfWidth: number;
  tankHalfHeight: number;

  // Current simulation tick (increments by 1 each sim step)
  tick: number;

  // Running statistics
  stats: {
    births: number;
    deaths: number;
    population: number;
  };

  // Free segment slots (indices) available for reuse when organisms die
  freeSegmentSlots: number[];

  // Grid cells that form the tank — habitable space for organisms.
  // Key format: "col,row" where col/row are origin-centered grid indices.
  // Everything outside these cells is boundary.
  tankCells: Set<string>;
  tankCellsArray: string[];    // Sync'd mirror for O(1) random cell pick
  tankCellsDirty: boolean;     // Rebuild array when cells change

  // Environment sources (max 5 each)
  lightSources: LightSource[];
  temperatureSources: TemperatureSource[];
  currentSources: CurrentSource[];
  nextLightSourceId: number;
  nextTemperatureSourceId: number;
  nextCurrentSourceId: number;

  // Day/night cycle
  dayNightEnabled: boolean;
  dayNightPhase: number;      // 0-1 where 0 = midnight, 0.5 = noon
  dayNightSpeed: number;      // Full cycles per sim-minute (1200 ticks)

  // Food particles dropped by dead segments
  food: FoodParticles;

  // Virus strain pool — evolved parasites that infect organisms
  virusStrains: VirusStrainPool;

  // Theme flag — affects photosynthesis behavior with light sources
  // In light mode, light sources become shadow zones that INHIBIT photosynthesis
  isLightTheme: boolean;
}


// ─── Simulation Config ───────────────────────────────────────
// All tunable parameters. Defaults are from V1, tuned over 4 months of playtesting.

export interface SimConfig {
  repCount: number;          // Starting organism count (default: 20)
  repLimit: number;          // Population cap (default: 100)
  asexMutationRate: number;  // % chance per gene of mutation in asexual reproduction
  sexMutationRate: number;   // % chance per gene of mutation in sexual reproduction
  sexGeneComboRate: number;  // % chance of picking recessive parent's gene
  virusEnabled: boolean;     // Is the virus system active?
  virusVirulence: number;    // Base virulence multiplier (0-1 slider)
  virusTransmission: number; // Base transmission multiplier (0-1 slider)
  virusImmunityTime: number; // Seconds for immunity to develop (slider)
  greenFeed: number;         // HP gained per green photosynthesis cycle
  blueHP: number;            // Extra HP capacity for blue segments
  yellowFreq: number;        // Seconds between yellow movement pulses
  redDamage: number;         // Damage dealt per red segment attack
  purpleCost: number;        // HP cost for sexual reproduction
  baseViscosity: number;     // 0 = max viscosity (sticky), 1 = min viscosity (fluid). Default 0.5 ≈ VERLET_DAMPING
  foodDecaySeconds: number;  // Food particle lifespan in seconds (30-300, default 120)
  redTargets: boolean[];     // 6 entries (one per SegmentColor) — which colors red can attack. Default: all true
}


// ─── Environment Sources ─────────────────────────────────────

export interface LightSource {
  id: number;
  x: number;          // World position
  y: number;
  radius: number;     // Falloff radius in world units (default 400, range 100-800)
  intensity: number;  // 0-1 brightness (default 0.8)
}

export interface TemperatureSource {
  id: number;
  x: number;
  y: number;
  radius: number;     // Falloff radius in world units (default 300, range 100-600)
  intensity: number;  // -1 (cold) to +1 (hot), default 0.5
}

// ─── Current Sources ─────────────────────────────────────────

export const CurrentType = {
  Whirlpool: 0,
  Directional: 1,
} as const;
export type CurrentType = typeof CurrentType[keyof typeof CurrentType];

export interface CurrentSource {
  id: number;
  x: number;
  y: number;
  radius: number;     // Falloff radius in world units (default 300, range 100-600)
  strength: number;   // 0-1 force multiplier (default 0.5)
  type: CurrentType;  // Whirlpool (tangential) or Directional (linear)
  direction: number;  // Radians, only used by Directional (default 0 = rightward)
}

/** Which tool the user is currently using for canvas interaction */
export const ToolMode = {
  Select: 0,
  Tank: 1,
  Light: 2,
  Temperature: 3,
  Current: 4,
} as const;
export type ToolMode = typeof ToolMode[keyof typeof ToolMode];


// ─── Camera ──────────────────────────────────────────────────

export interface Camera {
  x: number;       // Camera center X in world space
  y: number;       // Camera center Y in world space
  zoom: number;    // Zoom level (1 = default, >1 = zoomed in)
  minZoom: number;
  maxZoom: number;
}


// ─── Chart Data ─────────────────────────────────────────────

/** One data point sampled every CHART_SAMPLE_INTERVAL ticks */
export interface ChartSample {
  tick: number;
  population: number;
  births: number;              // cumulative
  deaths: number;              // cumulative
  colorCounts: number[];       // [green, blue, yellow, red, black, white] segment totals
  avgGenomeLength: number;
  maxGeneration: number;
  avgGeneration: number;
  speciesCount: number;        // unique genome fingerprints alive
  aliveStrains: number;        // number of active virus strains
  totalInfected: number;       // number of infected organisms
}


// ─── Save/Share Payloads ────────────────────────────────────

/** Payload for sharing a single organism via URL (?o=) */
export interface OrganismPayload {
  v: 1;                        // version for backward compat
  g: Gene[];                   // genome
  gen: number;                 // generation
  n: string;                   // name
}

/** Payload for sharing a tank configuration via URL (?t=) */
export interface TankPayload {
  v: 1;
  tank: [number, number][];          // [col, row] pairs (always included)
  lights?: LightSource[];             // optional
  temps?: TemperatureSource[];        // optional
  currents?: CurrentSource[];         // optional
  config?: Partial<SimConfig>;        // optional (only non-default values)
  dayNight?: { enabled: boolean; speed: number; phase: number }; // optional
  orgs?: OrganismPayload[];           // optional
}
