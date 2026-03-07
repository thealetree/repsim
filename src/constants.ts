/**
 * constants.ts — Default values and tuning constants for Repsim V2
 *
 * These defaults come from V1, which was playtested and tuned over 4 months.
 * They create a balanced ecosystem where populations can sustain, evolve,
 * and exhibit interesting emergent behavior.
 */

import type { SimConfig } from './types';

// ─── Simulation Defaults ─────────────────────────────────────
// These match V1's SetParams.cs defaults exactly

export const DEFAULT_CONFIG: SimConfig = {
  repCount: 100,          // Start with 100 organisms — large starting population
  repLimit: 500,          // Cap at 500 — large ecosystem with selection pressure
  asexMutationRate: 1,    // 1% per gene — slow enough to see lineages, fast enough to evolve
  sexMutationRate: 2,     // 2% per gene — sexual repro already mixes, so slightly higher
  sexGeneComboRate: 15,   // 15% recessive gene chance — dominant parent matters
  virusEnabled: false,    // Off by default — player can enable for extra challenge
  virusVirulence: 0.5,   // Base virulence multiplier
  virusTransmission: 0.5, // Base transmission multiplier
  virusImmunityTime: 35,  // Seconds to develop immunity
  greenFeed: 100,         // HP per photosynthesis tick — balanced against root drain of 70
  blueHP: 1000,           // Extra HP per blue segment — doubles base segment health
  yellowFreq: 1.25,       // Seconds between movement — not too twitchy, not too sluggish
  redDamage: 400,         // Damage per attack — kills a normal segment in ~2.5 hits
  purpleCost: 3500,       // Sexual repro cost — more expensive than asexual (3000)
  baseViscosity: 0.5,      // Default maps to VERLET_DAMPING (0.98)
};


// ─── Segment Constants ───────────────────────────────────────

export const SEGMENT_RADIUS = 8;                // Visual radius of each segment circle (world units)
export const SEGMENT_BASE_HEALTH = 1000;        // Starting HP for each segment
export const ROOT_HEALTH_RESERVE_START = 4000;  // Starting HP pool for the organism
export const ROOT_HEALTH_RESERVE_MAX = 5000;    // Max HP pool — photosynthesis stops filling here
export const ROOT_DRAIN_AMOUNT = 70;            // HP lost by root every drain tick
export const ROOT_DRAIN_INTERVAL_TICKS = 22;    // ~1.1 seconds at 20 ticks/sec (V1: every 1.1s)
export const REPLENISH_AMOUNT = 50;             // HP moved from root → damaged segment per tick
export const REPLENISH_INTERVAL_TICKS = 15;     // ~0.75 seconds at 20 ticks/sec (V1: every 0.75s)


// ─── Reproduction Constants ──────────────────────────────────

export const REPRO_METER_MAX = 3001;            // Meter must reach this to trigger reproduction
export const REPRO_METER_FILL = 100;            // Amount added per fill tick when healthy
export const REPRO_METER_FILL_INTERVAL = 10;    // ~0.5 seconds at 20 ticks/sec
export const REPRO_HEALTH_THRESHOLD = 4990;     // Root HP must be above this to fill repro meter
export const ASEXUAL_REPRO_COST = 3000;         // HP cost to reproduce asexually
export const SEXUAL_REPRO_RANGE = 150;           // Root-to-root distance for mate finding (world units)
export const STRUCTURAL_MUTATION_CHANCE = 0.15;  // 15% chance per child of gaining/losing a segment


// ─── Organism Constants ──────────────────────────────────────

export const MIN_SEGMENTS = 2;                  // Minimum segments per organism
export const MAX_SEGMENTS = 15;                 // Maximum segments per organism

// ─── Genome Shape Constants ─────────────────────────────────
// Turn angles are clamped to prevent self-intersecting organism shapes.
// ±45° allows interesting curves (S-bends, arcs, spirals) but keeps
// non-adjacent segments far enough apart that they never overlap.
// With chain distance 2.2r and ±45° turns, the tightest possible
// circle has radius ~23 units with ~18 unit spacing between segments,
// comfortably above the 16-unit collision diameter.
export const MAX_GENE_TURN_ANGLE = Math.PI * 0.6; // ±108° — allows wide radial angles for green/blue hubs
export const TIMED_DEATH_MIN_TICKS = 2000;      // ~100 seconds at 20 tps (V1: 100s)
export const TIMED_DEATH_MAX_TICKS = 4000;      // ~200 seconds at 20 tps (V1: 200s)

// ─── Branching Constants ────────────────────────────────────
// Organisms are TREES, not just chains. Any segment can have multiple children.
// BRANCH_PROBABILITY controls how often new genes branch from existing segments
// vs extending an existing tip. 0.3 = 30% branch, 70% extend tip.
// This produces a natural mix: some pure chains, some with 1-2 branches, rarely
// highly branched structures like starfish.
export const BRANCH_PROBABILITY = 0.3;

// ─── Per-Color Branch Probability ───────────────────────────
// Green/Blue act like carbon — multiple radial binding sites, branch often (hubs).
// Yellow/Red/Black are serial — 1-2 binding sites, rarely branch (limbs).
// Looked up by the PARENT gene's color when deciding branch vs extend.
export const COLOR_BRANCH_PROBABILITY: Record<number, number> = {
  0: 0.70,  // Green: carbon-like hub, branches often → canopy structures
  1: 0.70,  // Blue: structural scaffold, branches often → cross/star shapes
  2: 0.20,  // Yellow: streamlined serial chains → flagella/tails
  3: 0.20,  // Red: serial spikes → thorn arrays
  4: 0.15,  // Black: compact, rarely branches → reproductive tips
  5: 0.25,  // White: moderate branching → scavenger sweep
};

// ─── Chemistry-Inspired Angle Preferences ───────────────────
// Like molecular bond angles in chemistry, each segment color has preferred
// attachment angles. Green/Blue have wide radial angles (like carbon's tetrahedral
// geometry), producing hub-like junctions. Yellow/Red/Black have narrow serial
// angles, producing chain-like appendages.
//
// This makes interesting body plans STATISTICALLY FAVORED:
// - Green/blue nodes create radial branch points (hubs)
// - Yellow/red/black extend as serial arms/limbs from those hubs
export const PREFERRED_ANGLE_CHANCE = 0.75;                    // 75% use preferred angle
export const PREFERRED_ANGLE_JITTER = Math.PI / 12;            // ±15° wobble

// Preferred angles per color (radians).
export const COLOR_PREFERRED_ANGLES: Record<number, number[]> = {
  0: [-Math.PI / 3, 0, Math.PI / 3, -2 * Math.PI / 3, 2 * Math.PI / 3], // Green: 5-way canopy (-120°,-60°,0°,+60°,+120°)
  1: [-Math.PI / 2, 0, Math.PI / 2, Math.PI],                             // Blue: 4-way cross (-90°,0°,+90°,180°)
  2: [-Math.PI / 8, 0, Math.PI / 8],                                      // Yellow: nearly straight (±22.5°)
  3: [-Math.PI / 2, Math.PI / 2],                                         // Red: ±90° perpendicular thorns
  4: [0],                                                                   // Black: straight only
  5: [-Math.PI / 4, 0, Math.PI / 4],                                        // White: ±45° sweep (scavenging reach)
};

// ─── Variable Segment Length ────────────────────────────────
// Each gene has a length multiplier affecting visual size, chain distance,
// and gameplay effects. Longer blue = more HP, longer red = more damage, etc.
export const GENE_LENGTH_MIN = 0.4;
export const GENE_LENGTH_MAX = 3.0;
export const LENGTH_MUTATION_DRIFT = 0.3;  // ±drift per mutation event

// Per-color default length ranges — color determines natural size distribution
export const COLOR_LENGTH_RANGES: Record<number, [number, number]> = {
  0: [0.6, 2.0],   // Green: moderate (leaves/canopy)
  1: [1.0, 3.0],   // Blue: longest (backbone/scaffold)
  2: [1.0, 2.8],   // Yellow: long (flagella/fins)
  3: [0.4, 1.2],   // Red: short (compact thorns/spikes)
  4: [0.5, 0.8],   // Black: shortest (compact reproductive)
  5: [0.6, 1.4],   // White: moderate (scavenger)
};


// ─── Behavior Intervals ─────────────────────────────────────
// How often each system fires, in simulation ticks (20 ticks = 1 second).
// Staggered intervals prevent all systems from spiking on the same tick.

export const GREEN_FEED_INTERVAL_TICKS = 20;    // 1.0s — photosynthesis cycle
// ROOT_DRAIN_INTERVAL_TICKS = 22  (already defined above, ~1.1s)
// REPLENISH_INTERVAL_TICKS = 15   (already defined above, ~0.75s)

// ─── Yellow Movement Constants ──────────────────────────────
// Yellow segments provide thrust, pushing the organism through the dish.
// In verlet physics, thrust is applied by shifting prevPos (injecting velocity).
// Each yellow segment fires on its organism's movement timer.

export const YELLOW_THRUST_STRENGTH = 2.5;      // Verlet velocity impulse per yellow segment
export const YELLOW_MOVEMENT_COST = 25;          // HP cost per yellow segment per thrust
export const YELLOW_DEPTH_IMPULSE = 0.03;        // Depth change per yellow from Y-component of thrust

// ─── Red Attack Constants ───────────────────────────────────
// Red segments deal damage to nearby enemy segments on the same depth layer.
// Attack range is slightly larger than collision range so organisms that
// bump into each other will trigger combat.

export const RED_ATTACK_RANGE = SEGMENT_RADIUS * 3;       // Proximity for attack
export const RED_ATTACK_COOLDOWN_TICKS = 20;               // 1s between attacks per organism
export const RED_ATTACK_HP_GAIN_FRACTION = 0.5;            // Attacker gains 50% of damage as HP


// ─── Physics Constants ───────────────────────────────────────

export const SIM_TICKS_PER_SECOND = 20;         // Fixed simulation rate
export const SIM_DT = 1 / SIM_TICKS_PER_SECOND; // Time step in seconds (0.05)
export const VERLET_DAMPING = 0.98;             // Velocity damping per tick (0-1)
export const CHAIN_CONSTRAINT_ITERATIONS = 3;   // How many times to enforce chain constraints
export const SEGMENT_CHAIN_DISTANCE = SEGMENT_RADIUS * 1.6; // Target distance between connected segments (tighter for branch overlap)
export const COLLISION_PUSH_STRENGTH = 0.8;     // How hard segments push apart on overlap
export const ANGULAR_CONSTRAINT_STIFFNESS = 0.5; // How strongly organisms hold their genetic shape (per iteration)


// ─── Tank Constants ─────────────────────────────────────────
// The tank is a rounded rectangle — fills the viewport better than a circle,
// and sets up for future layout editing (walls, dividers snap to grid).
// Organisms are tiny relative to the tank — lots of space to explore.

export const TANK_HALF_WIDTH = 1200;             // Half-width of DEFAULT tank in world units (total 2400)
export const TANK_HALF_HEIGHT = 880;             // Half-height of DEFAULT tank in world units (total 1760)
export const TANK_MAX_EXTENT = 12000;            // Max world-space extent in any direction (~10x default)


// ─── Spatial Hash Constants ──────────────────────────────────

export const SPATIAL_HASH_CELL_SIZE = SEGMENT_RADIUS * 4; // ~2 segment diameters


// ─── Rendering Constants ─────────────────────────────────────

export const CANVAS_BG_COLOR = 0x0a0a12;        // Dark blue-black background
export const TANK_BG_COLOR = 0x111122;           // Slightly lighter tank interior
export const TANK_EDGE_COLOR = 0x334466;         // Glass-like edge color
export const TANK_GRID_COLOR = 0x1a1a2e;         // Faint grid lines inside tank
export const TANK_GRID_SPACING = 80;             // Distance between grid lines (larger for big tank)
export const WALL_COLOR = 0x2a3355;               // Semi-visible wall cell fill color

// Light theme colors
export const LIGHT_CANVAS_BG_COLOR = 0xe8eaf0;    // Soft gray background
export const LIGHT_TANK_BG_COLOR = 0xf4f5f8;      // Near-white tank interior
export const LIGHT_TANK_EDGE_COLOR = 0xb0bcc8;    // Medium gray edge
export const LIGHT_TANK_GRID_COLOR = 0xdde0e8;    // Very faint grid
export const LIGHT_WALL_COLOR = 0xa0aabb;          // Visible wall fill

// Segment colors for rendering (hex values for PixiJS)
export const SEGMENT_RENDER_COLORS: Record<number, number> = {
  0: 0x44cc44,  // Green — photosynthesis
  1: 0x4488ff,  // Blue — HP reserve
  2: 0xffcc22,  // Yellow — movement
  3: 0xff4444,  // Red — attack
  4: 0x2a2a3a,  // Black — sexual reproduction (slightly lighter than BG for visibility)
  5: 0xeeeedd,  // White — scavenger (off-white/ivory)
};

// Color syllables for organism naming (from V1's DragAndDrop.makeName())
export const COLOR_SYLLABLES: Record<number, string> = {
  0: 'Ti',   // Green
  1: 'De',   // Blue
  2: 'Mo',   // Yellow
  3: 'Ba',   // Red
  4: 'Cu',   // Black
  5: 'Vo',   // White
};


// ─── Camera Constants ────────────────────────────────────────

export const CAMERA_DEFAULT_ZOOM = 0.45;         // Fits the larger tank in viewport
export const CAMERA_MIN_ZOOM = 0.04;              // Zoomed out to see 10x tank extent
export const CAMERA_MAX_ZOOM = 3.0;
export const CAMERA_ZOOM_SPEED = 0.1;


// ─── Pill Shape Constants ────────────────────────────────────
// Segments are pill/capsule shapes, not circles. The aspect ratio creates
// the elongated organism segment look from V1's capsule meshes.

export const SEGMENT_PILL_LENGTH = SEGMENT_RADIUS * 3.0;  // Long axis of capsule
export const SEGMENT_PILL_WIDTH = SEGMENT_RADIUS * 1.5;   // Short axis of capsule
// With chain distance 1.6r, sqrt-compressed length factor, and pill length 3.0r,
// pills overlap generously at joints — including at branch points where only
// the parent's width faces the child. Long segments get a 35% width boost.


// ─── 2.5D Blur Layers (Depth Effect) ────────────────────────
// Organisms exist at different "depths" in the petri dish. We render them
// on separate PixiJS containers, each with a different blur strength.
// Deeper organisms are blurrier and smaller, closer ones are sharp and larger.
// This creates the illusion of looking down into a 3D dish through a microscope.
//
// We use 7 internal layers with fine blur gradations (step of ~1.0 between
// adjacent layers) so that blur transitions appear smooth as organisms drift
// between depths. Each layer covers ~14% of the depth range, meaning at
// DEPTH_LERP_SPEED an organism takes ~2.4 seconds to cross one layer boundary
// and the blur change per boundary is only ~1.0 — nearly imperceptible.

export const BLUR_LAYER_COUNT = 7;
export const BLUR_LAYER_STRENGTHS = [6, 5, 4, 3, 2, 1, 0]; // Blur per layer: deepest → shallowest (step of 1.0)
export const BLUR_LAYER_ALPHAS = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]; // All 1.0 — alpha is per-sprite for smooth transitions
export const BLUR_LAYER_QUALITY = 2;               // Blur quality (higher = smoother, slower)

// Parallax: deeper blur layers shift less when panning, creating a 2.5D depth effect
export const PARALLAX_STRENGTH = 0.3;   // Max offset factor for deepest layer (0 = off). Deepest layer moves at (1-this) of surface speed.
export const PARALLAX_MAX_OFFSET = 100; // Max world-space parallax offset (px). Caps via tanh so it responds smoothly at any pan distance.
export const PARALLAX_BOUNDARY_MARGIN = 55; // Extra collision radius (px) at extreme depths (0 or 1) to keep organisms from tank edges

// Depth-based scale: deeper organisms appear smaller (perspective)
export const DEPTH_SCALE_MIN = 0.78;  // Scale at depth 0 (deepest)
export const DEPTH_SCALE_MAX = 1.08;  // Scale at depth 1 (shallowest)

// Depth-based alpha: deeper organisms are more transparent (faded into background)
// Alpha is now per-sprite (continuous) instead of per-layer (discrete) for smooth transitions
export const DEPTH_ALPHA_MIN = 0.4;   // Alpha at depth 0 (deepest, most faded)
export const DEPTH_ALPHA_MAX = 1.0;   // Alpha at depth 1 (shallowest, fully opaque)

// ─── Per-Segment Depth (Wave Propagation) ───────────────────
// Depth movement is driven by YELLOW SEGMENTS — the Y-component of each
// yellow segment's thrust direction nudges the organism's depth. Swimming
// downward on screen → dive deeper (more blur). Swimming up → surface (sharper).
// Organisms WITHOUT yellow segments stay at their spawn depth — sessile producers
// don't explore depth layers, only mobile organisms do.
//
// Individual segments can be at different depths — the root leads a depth
// change and children follow with a delay, like a whale diving headfirst.
// Each child segment closes FOLLOW_RATE fraction of the gap to its parent
// per tick (exponential decay). Adjacent segments are clamped to differ by
// at most one blur layer (1/BLUR_LAYER_COUNT depth units).
//
// Steady-state lag per link ≈ DEPTH_LERP_SPEED / FOLLOW_RATE = 0.0375 depth units.
// A 5-segment chain spans ~1 blur layer; a 15-segment organism spans ~4 layers.
export const SEGMENT_DEPTH_FOLLOW_RATE = 0.04; // Fraction of gap closed per tick (0-1)
export const MAX_ADJACENT_DEPTH_DIFF = 1 / BLUR_LAYER_COUNT; // Max depth diff between connected segments


// ─── Environment Constants ──────────────────────────────────
export const MAX_LIGHT_SOURCES = 5;
export const MAX_TEMPERATURE_SOURCES = 5;

// Light source defaults and ranges
export const LIGHT_DEFAULT_RADIUS = 400;
export const LIGHT_MIN_RADIUS = 100;
export const LIGHT_MAX_RADIUS = 800;
export const LIGHT_DEFAULT_INTENSITY = 0.8;
export const LIGHT_RESIZE_SPEED = 20;         // World units per scroll tick

// Temperature source defaults and ranges
export const TEMP_DEFAULT_RADIUS = 300;
export const TEMP_MIN_RADIUS = 100;
export const TEMP_MAX_RADIUS = 600;
export const TEMP_DEFAULT_INTENSITY = 0.5;     // Positive = hot
export const TEMP_RESIZE_SPEED = 15;

// Viscosity tuning
export const VISCOSITY_MIN_DAMPING = 0.90;     // Very viscous (cold/high viscosity)
export const VISCOSITY_MAX_DAMPING = 0.995;    // Very fluid (hot/low viscosity)

// Temperature metabolism modifier range
export const TEMP_METABOLISM_MIN = 0.5;        // Cold slows metabolism to 0.5x
export const TEMP_METABOLISM_MAX = 1.5;        // Hot speeds up metabolism 1.5x

// Environment rendering
export const LIGHT_GLOW_COLOR = 0xffffaa;      // Warm yellow glow
export const TEMP_HOT_COLOR = 0xff4422;        // Red overlay for heat
export const TEMP_COLD_COLOR = 0x2244ff;       // Blue overlay for cold

// ─── Food Particle Constants ──────────────────────────────
// When segments die, they scatter food particles. Red and White segments
// can eat them, creating an emergent food chain / trophic loop.

export const FOOD_MAX_PARTICLES = 500;                      // Cap on simultaneous food particles
export const FOOD_DECAY_TICKS = 1200;                       // ~60 seconds at 20 tps
export const FOOD_ENERGY_PER_SEGMENT = 500;                 // Energy value of each food particle
export const FOOD_PARTICLE_RADIUS = 3;                      // Visual radius (smaller than segments)
export const FOOD_DRIFT_SPEED = 0.15;                       // Slow random drift per tick (world units)
export const FOOD_SCAVENGE_RANGE = SEGMENT_RADIUS * 3;      // Proximity to eat food (~24 world units)
export const FOOD_RED_EFFICIENCY = 0.75;                    // Red gets 75% of food energy
export const FOOD_WHITE_EFFICIENCY = 1.2;                   // White gets 120% of food energy
export const FOOD_SCAVENGE_INTERVAL_TICKS = 5;              // Check for food every 0.25s
export const FOOD_RENDER_COLOR = 0xddccaa;                  // Warm off-white visual color


// ─── Virus Constants ────────────────────────────────────────
// Viruses are evolved parasites with their own genome (color affinity,
// virulence, transmission rate). They emerge from contaminated food,
// spread on collision, and create evolutionary pressure on organisms.

export const VIRUS_MAX_STRAINS = 64;                          // Max concurrent strains in pool
export const VIRUS_FOOD_DENSITY_THRESHOLD = 8;                // Food particles nearby to trigger viral food
export const VIRUS_FOOD_DENSITY_RADIUS = 80;                  // World units for density check
export const VIRUS_FOOD_DENSITY_CHECK_INTERVAL = 100;         // Every 5s at 20 tps
export const VIRUS_FOOD_SPAWN_CHANCE = 0.3;                   // 30% per dense cluster check
export const VIRUS_SPREAD_CHECK_INTERVAL = 5;                 // Every 0.25s (frequent spreading)
export const VIRUS_EFFECT_INTERVAL = 10;                      // Every 0.5s for effect application
export const VIRUS_VERTICAL_TRANSMISSION_CHANCE = 0.15;       // 15% parent→offspring
export const VIRUS_IMMUNITY_INHERITANCE_CHANCE = 0.5;          // 50% immunity passed to child
export const VIRUS_MUTATION_DRIFT = 0.1;                      // ±drift on virulence/transmission per spread
export const VIRUS_COLOR_MUTATION_CHANCE = 0.1;                // 10% chance affinity changes on spread
export const VIRUS_ENERGY_DRAIN_RATE = 200;                    // HP drained per effect tick (× virulence) — scales with org size
export const VIRUS_SWELLING_FACTOR = 1.3;                      // Scale multiplier for swollen segments
export const VIRUS_JOINT_WOBBLE = 0.20;                        // ±20% rest length oscillation
export const VIRUS_CORRUPTION_RATE = 0.02;                     // Per-tick chance of behavior skip
export const VIRUS_BLOOM_CHANCE = 0.05;                        // Per repro, chance of viral bloom
export const VIRUS_BLOOM_LIFESPAN_TICKS = 200;                 // 10 seconds
export const VIRUS_BLUE_ADJACENCY_SPEEDUP = 2.0;              // Blue neighbors halve immunity time
export const VIRUS_INITIAL_VIRULENCE_MIN = 0.2;
export const VIRUS_INITIAL_VIRULENCE_MAX = 0.8;
export const VIRUS_INITIAL_TRANSMISSION_MIN = 0.3;
export const VIRUS_INITIAL_TRANSMISSION_MAX = 0.7;
export const VIRUS_SPREAD_RANGE = SEGMENT_RADIUS * 5;          // Wider than attack — viruses are contagious
export const VIRUS_FOOD_COLOR = 0x88dd66;                      // Greenish food particles

// Dark versions of each segment color for infected organisms
// All segments of an infected org visually turn this color
export const VIRUS_DARK_RENDER_COLORS: Record<number, number> = {
  0: 0x1a6b1a,  // Dark green
  1: 0x1a3a8a,  // Dark blue
  2: 0x8a6a0a,  // Dark amber/yellow
  3: 0x8a1a1a,  // Dark red
  4: 0x12121e,  // Dark black (near background)
  5: 0x6a6a5a,  // Dark white/gray
};
