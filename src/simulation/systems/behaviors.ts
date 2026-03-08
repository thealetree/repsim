/**
 * behaviors.ts — Organism behavior systems
 *
 * This file brings organisms to LIFE. Without it, they're just static shapes.
 * Each system runs every tick and handles one aspect of organism behavior:
 *
 * 1. Photosynthesis — Green segments generate energy (fill rootHealthReserve)
 * 2. Root Drain — Passive HP drain (cost of living)
 * 3. Replenishment — Root distributes HP to damaged segments
 * 4. Reproduction — Fill repro meters, spawn children (asexual & sexual)
 * 5. Yellow Movement — Yellow segments provide thrust AND drive depth changes
 * 6. Red Attack — Red segments deal damage to nearby enemies
 * 7. Segment Depth Propagation — Wave from root → leaves for per-segment depth
 * 8. Health Checks — Kill segments/organisms with 0 HP, sever tree branches
 * 9. Timed Death — Kill organisms past their lifespan
 *
 * ORDER MATTERS: Behaviors run BEFORE constraints each tick, so yellow
 * movement impulses get picked up by verlet integration in the same frame.
 *
 * DESIGN NOTE — V1 Parity:
 * V1 used Unity coroutines with WaitForSeconds. V2 uses tick-based intervals
 * (e.g., "every 20 ticks = every 1 second"). The intervals are tuned to match
 * V1's playtested feel from 4 months of iteration.
 */

import type { World, Organism, SimConfig } from '../../types';
import { SegmentColor } from '../../types';
import {
  GREEN_FEED_INTERVAL_TICKS,
  ROOT_DRAIN_INTERVAL_TICKS,
  getRootDrain,
  REPLENISH_INTERVAL_TICKS,
  REPLENISH_AMOUNT,
  YELLOW_THRUST_STRENGTH,
  YELLOW_MOVEMENT_COST,
  YELLOW_DEPTH_IMPULSE,
  RED_ATTACK_RANGE,
  RED_ATTACK_COOLDOWN_TICKS,
  RED_ATTACK_HP_GAIN_FRACTION,
  BLUR_LAYER_COUNT,
  SIM_TICKS_PER_SECOND,
  SEGMENT_DEPTH_FOLLOW_RATE,
  MAX_ADJACENT_DEPTH_DIFF,
  FOOD_ENERGY_PER_SEGMENT,
  FOOD_SCAVENGE_RANGE,
  FOOD_RED_EFFICIENCY,
  FOOD_WHITE_EFFICIENCY,
  FOOD_SCAVENGE_INTERVAL_TICKS,
  FOOD_MAX_PARTICLES,
} from '../../constants';
import {
  createSpatialHash,
  clearSpatialHash,
  insertIntoSpatialHash,
  querySpatialHash,
} from '../spatial-hash';
import { removeOrganism } from '../world';
import { runReproduction } from './reproduction';
import { computeLight, computeMetabolismMultiplier } from '../environment';
import { spawnFood, updateFood, consumeFood } from '../food';
import {
  runVirusSystem,
  createSpontaneousStrain,
  infectSegment,
  isColorCorrupted,
} from '../virus';


// ─── Spatial hash for red attack proximity checks ──────────
// Separate from the one in constraints.ts to avoid interference.
// Exported so virus.ts can reuse the same hash for spread checks.
export const attackSpatialHash = createSpatialHash();

// ─── Spatial hash for food particle proximity checks ──────────
// Exported so virus.ts can reuse the same hash for density checks.
export const foodSpatialHash = createSpatialHash();

// Module-level reusable Map for depth layer lookups (avoids allocation per tick).
// Shared across behaviors, constraints, and virus systems.
export const _orgDepthLayer = new Map<number, number>();

/** Rebuild the shared depth layer map from alive organisms. Call once per tick. */
export function computeDepthLayers(world: World): void {
  _orgDepthLayer.clear();
  for (const org of world.organisms.values()) {
    _orgDepthLayer.set(org.id, Math.min(
      BLUR_LAYER_COUNT - 1,
      Math.floor(org.depth * BLUR_LAYER_COUNT),
    ));
  }
}

// Module-level reusable arrays for organism removal (avoids per-tick allocation).
const _healthToRemove: number[] = [];
const _timedToRemove: number[] = [];


/**
 * Run all behavior systems in the correct order.
 *
 * Called every tick BEFORE runConstraints() so that:
 * - Yellow velocity impulses get integrated by verlet
 * - Death removals happen before constraint iteration
 */
export function runBehaviors(world: World, config: SimConfig): void {
  // Compute depth layers once for all systems this tick
  computeDepthLayers(world);

  runPhotosynthesis(world, config);
  runRootDrain(world);
  runReplenishment(world);
  runReproduction(world, config);  // Reproduce after metabolism, before combat
  runYellowMovement(world, config);
  runRedAttack(world, config);
  runScavenging(world, config);     // Segments eat food particles (white orgs: any seg)
  runVirusSystem(world, config, attackSpatialHash, foodSpatialHash, _orgDepthLayer); // Virus spread, effects, immunity
  runSegmentDepthPropagation(world); // Wave per-segment depth from root → leaves
  runHealthChecks(world);
  runTimedDeath(world);
  updateFood(world.food, world.tick, world.tankCells); // Decay + drift food particles
}


// ─── 1. Photosynthesis ──────────────────────────────────────
/**
 * Green segments generate energy for their organism.
 *
 * V1: Every 1s, each green segment adds `greenFeed` (default 100) HP
 * to rootHealthReserve, capped at org.rootHealthReserveMax (size-scaled).
 *
 * In V2 we check `tick % interval === 0` for simplicity — all organisms
 * photosynthesize on the same tick. This is fine because it's just addition.
 */
function runPhotosynthesis(world: World, config: SimConfig): void {
  if (world.tick % GREEN_FEED_INTERVAL_TICKS !== 0) return;

  const seg = world.segments;
  const hasLights = world.lightSources.length > 0;
  const hasTempSources = world.temperatureSources.length > 0;

  for (const org of world.organisms.values()) {
    if (!org.alive) continue;

    // Temperature affects metabolism speed at root position
    let metabolismMult = 1.0;
    if (hasTempSources) {
      const rootIdx = org.firstSegment;
      metabolismMult = computeMetabolismMultiplier(
        seg.x[rootIdx], seg.y[rootIdx], world.temperatureSources,
      );
    }

    if (hasLights) {
      // LIGHT-BASED: each green segment feeds proportional to received light.
      // Dark mode: light sources = light → higher light = more photosynthesis.
      // Light mode: light sources = shadow zones → higher light field = LESS photosynthesis.
      //   In light mode, ambient light is full (1.0) and shadow sources subtract from it.
      let totalLightFeed = 0;
      for (let i = 0; i < org.segmentCount; i++) {
        const idx = org.firstSegment + i;
        if (!seg.alive[idx] || seg.color[idx] !== SegmentColor.Green) continue;
        if (isColorCorrupted(world, idx)) continue; // Virus suppresses photosynthesis

        let light = computeLight(
          seg.x[idx], seg.y[idx], world.lightSources, world.tankCells,
        );

        if (world.isLightTheme) {
          // Light mode: invert — ambient is 1.0, shadow sources reduce it
          light = Math.max(0, 1 - light);
        }

        const lengthMult = org.genome[i]?.length || 1;
        totalLightFeed += Math.min(1, light) * lengthMult;
      }

      if (totalLightFeed > 0) {
        org.rootHealthReserve = Math.min(
          org.rootHealthReserveMax,
          org.rootHealthReserve + totalLightFeed * config.greenFeed * metabolismMult,
        );
      }
    } else {
      // AMBIENT: original behavior — count greens × greenFeed, scaled by length
      let greenContribution = 0;
      for (let i = 0; i < org.segmentCount; i++) {
        const idx = org.firstSegment + i;
        if (seg.alive[idx] && seg.color[idx] === SegmentColor.Green && !isColorCorrupted(world, idx)) {
          greenContribution += org.genome[i]?.length || 1;
        }
      }

      if (greenContribution > 0) {
        org.rootHealthReserve = Math.min(
          org.rootHealthReserveMax,
          org.rootHealthReserve + greenContribution * config.greenFeed * metabolismMult,
        );
      }
    }
  }
}


// ─── 2. Root Drain ──────────────────────────────────────────
/**
 * Organisms passively lose energy — the cost of being alive.
 *
 * V1: Every 1.1s, root loses 70 HP from rootHealthReserve.
 * Without green segments feeding, organisms slowly starve.
 * This is the core selection pressure — you must eat to survive.
 */
function runRootDrain(world: World): void {
  if (world.tick % ROOT_DRAIN_INTERVAL_TICKS !== 0) return;

  const seg = world.segments;
  const hasTempSources = world.temperatureSources.length > 0;

  for (const org of world.organisms.values()) {
    if (!org.alive) continue;

    let metabolismMult = 1.0;
    if (hasTempSources) {
      const rootIdx = org.firstSegment;
      metabolismMult = computeMetabolismMultiplier(
        seg.x[rootIdx], seg.y[rootIdx], world.temperatureSources,
      );
    }

    org.rootHealthReserve -= getRootDrain(org.genome.length) * metabolismMult;
    // Don't clamp to 0 here — healthChecks will handle death
  }
}


// ─── 3. Replenishment ───────────────────────────────────────
/**
 * Root distributes HP to the most damaged segment.
 *
 * V1: Every 0.75s, moves 50 HP from rootHealthReserve to the segment
 * with the lowest health (if any segment is damaged).
 *
 * This is how organisms heal from red attacks — the root pool acts as
 * a shared HP bank that gets distributed where needed.
 */
function runReplenishment(world: World): void {
  if (world.tick % REPLENISH_INTERVAL_TICKS !== 0) return;

  const seg = world.segments;

  for (const org of world.organisms.values()) {
    if (!org.alive || org.rootHealthReserve <= 0) continue;

    // Find the most damaged alive segment
    let worstIdx = -1;
    let worstHealth = Infinity;

    for (let i = 0; i < org.segmentCount; i++) {
      const idx = org.firstSegment + i;
      if (!seg.alive[idx]) continue;
      if (seg.health[idx] < worstHealth) {
        worstHealth = seg.health[idx];
        worstIdx = idx;
      }
    }

    // Only replenish if a segment is actually damaged
    if (worstIdx >= 0 && worstHealth < 1000) {
      const amount = Math.min(REPLENISH_AMOUNT, org.rootHealthReserve);
      seg.health[worstIdx] += amount;
      org.rootHealthReserve -= amount;
    }
  }
}


// ─── 4. Yellow Movement ─────────────────────────────────────
/**
 * Yellow segments provide thrust, making organisms MOVE and CHANGE DEPTH.
 *
 * V1: Every yellowFreq seconds (default 1.25), each yellow segment
 * fires a velocity impulse along its facing direction. Costs 25 HP per scoot.
 *
 * V2 VERLET APPROACH:
 * To inject velocity in verlet physics, we shift prevPos BACKWARDS
 * from the desired direction. On the next verlet integration step:
 *   velocity = (pos - prevPos) * damping
 * So shifting prevPos by -thrust creates velocity of +thrust.
 *
 * DEPTH FROM YELLOW:
 * The Y-component of each yellow segment's thrust direction also drives
 * depth changes. Swimming downward on screen → dive deeper (more blur).
 * Swimming upward → surface (less blur). Organisms without yellow segments
 * stay at their spawn depth — sessile producers don't explore depth layers.
 * This creates natural niche differentiation: mobile organisms explore all
 * depths while immobile ones specialize in their birth layer.
 *
 * DIRECTION: The segment's facing direction (same as renderer's pill rotation):
 * - Leaf segments: face away from parent (push organism forward)
 * - Root/internal segments: face toward first child
 */
function runYellowMovement(world: World, config: SimConfig): void {
  const seg = world.segments;
  const yellowIntervalTicks = Math.round(config.yellowFreq * SIM_TICKS_PER_SECOND);

  for (const org of world.organisms.values()) {
    if (!org.alive) continue;

    // Check if it's time for this organism to move
    if (world.tick < org.nextMoveTick) continue;

    // Schedule next movement
    org.nextMoveTick = world.tick + yellowIntervalTicks;

    // Apply thrust from each alive yellow segment
    const topology = org.topology;
    let depthImpulse = 0; // Accumulate depth change from all yellows

    for (let i = 0; i < org.segmentCount; i++) {
      const idx = org.firstSegment + i;
      if (!seg.alive[idx] || seg.color[idx] !== SegmentColor.Yellow) continue;
      if (isColorCorrupted(world, idx)) continue; // Virus suppresses movement

      const lengthMult = org.genome[i]?.length || 1;

      // HP cost for this scoot (scaled by length — longer = more powerful but costlier)
      const moveCost = YELLOW_MOVEMENT_COST * lengthMult;
      if (org.rootHealthReserve < moveCost) continue;
      org.rootHealthReserve -= moveCost;

      // Compute facing direction (same logic as renderer pill rotation)
      let dirX = 0;
      let dirY = 0;

      if (topology.isLeaf[i]) {
        // Leaf: face away from parent (push outward)
        if (i > 0) {
          const parentGlobal = idx + seg.parentOffset[idx];
          if (seg.alive[parentGlobal]) {
            dirX = seg.x[idx] - seg.x[parentGlobal];
            dirY = seg.y[idx] - seg.y[parentGlobal];
          }
        }
      } else {
        // Root or internal: face toward first child
        const firstChildGeneIdx = topology.children[i][0];
        const childGlobal = org.firstSegment + firstChildGeneIdx;
        if (seg.alive[childGlobal]) {
          dirX = seg.x[childGlobal] - seg.x[idx];
          dirY = seg.y[childGlobal] - seg.y[idx];
        }
      }

      // Normalize and apply thrust (scaled by length)
      const len = Math.sqrt(dirX * dirX + dirY * dirY);
      if (len < 0.01) continue;

      const nx = dirX / len;
      const ny = dirY / len;
      const thrust = YELLOW_THRUST_STRENGTH * lengthMult;

      // Inject velocity by shifting prevPos BACKWARDS from thrust direction
      // This creates forward velocity on next verlet integration
      seg.prevX[idx] -= nx * thrust;
      seg.prevY[idx] -= ny * thrust;

      // Depth impulse from Y-component of thrust direction
      // Swimming down (ny > 0) → dive deeper (depth decreases toward 0 = blurry)
      // Swimming up (ny < 0) → surface (depth increases toward 1 = sharp)
      depthImpulse -= ny * YELLOW_DEPTH_IMPULSE;
    }

    // Apply accumulated depth change from all yellow segments
    if (depthImpulse !== 0) {
      org.depth += depthImpulse;
      org.depth = Math.max(0, Math.min(1, org.depth));
    }
  }
}


// ─── 5. Red Attack ──────────────────────────────────────────
/**
 * Red segments deal damage to nearby enemy segments.
 *
 * V1: OnCollisionEnter — red deals `redDamage` (400) on contact,
 * attacker gains HP toward rootHealthReserve/reproMeter.
 *
 * V2: Every tick, red segments check for nearby enemy segments using
 * the spatial hash. If an enemy segment is within RED_ATTACK_RANGE
 * and on the same depth layer, deal damage. Each organism has a cooldown
 * to prevent rapid-fire damage (matches V1's collision-based rate limiting).
 *
 * PREDATOR-PREY DYNAMICS: The attacker gains a fraction of the damage
 * dealt as rootHealthReserve HP. This means red organisms can sustain
 * themselves by hunting — they're the predators, greens are the producers.
 */
function runRedAttack(world: World, config: SimConfig): void {
  const seg = world.segments;
  const count = world.segmentCount;
  // Depth layers already computed at start of runBehaviors via computeDepthLayers()

  // Build spatial hash of all alive segments (for proximity queries)
  clearSpatialHash(attackSpatialHash);
  for (let i = 0; i < count; i++) {
    if (seg.alive[i]) {
      insertIntoSpatialHash(attackSpatialHash, i, seg.x[i], seg.y[i]);
    }
  }

  const aBuf = attackSpatialHash.queryBuf;

  // Check each red segment for nearby enemies
  for (const org of world.organisms.values()) {
    if (!org.alive) continue;

    // Cooldown check — skip if this organism attacked recently
    if (world.tick - org.lastAttackTick < RED_ATTACK_COOLDOWN_TICKS) continue;

    const attackerLayer = _orgDepthLayer.get(org.id);
    let didAttack = false;

    for (let i = 0; i < org.segmentCount; i++) {
      const idx = org.firstSegment + i;
      if (!seg.alive[idx] || seg.color[idx] !== SegmentColor.Red) continue;
      if (isColorCorrupted(world, idx)) continue; // Virus suppresses attack

      const lengthMult = org.genome[i]?.length || 1;
      const attackRange = RED_ATTACK_RANGE * lengthMult;
      const attackRangeSq = attackRange * attackRange;

      // Query spatial hash for nearby segments
      const nearbyLen = querySpatialHash(attackSpatialHash, seg.x[idx], seg.y[idx]);

      for (let n = 0; n < nearbyLen; n++) {
        const j = aBuf[n];
        if (!seg.alive[j]) continue;

        // Skip self (same organism)
        if (seg.organismId[j] === org.id) continue;

        // Skip different depth layers
        const targetLayer = _orgDepthLayer.get(seg.organismId[j]);
        if (targetLayer !== attackerLayer) continue;

        // Check distance (range scaled by length)
        const dx = seg.x[j] - seg.x[idx];
        const dy = seg.y[j] - seg.y[idx];
        if (dx * dx + dy * dy > attackRangeSq) continue;

        // DEAL DAMAGE (scaled by length — longer = stronger)
        const damage = config.redDamage * lengthMult;
        seg.health[j] -= damage;

        // Attacker gains HP (predator-prey reward)
        org.rootHealthReserve += damage * RED_ATTACK_HP_GAIN_FRACTION;
        org.rootHealthReserve = Math.min(org.rootHealthReserve, org.rootHealthReserveMax);

        didAttack = true;
        break; // One target per red segment per attack
      }

      if (didAttack) break; // One attack event per organism per cooldown
    }

    if (didAttack) {
      org.lastAttackTick = world.tick;
    }
  }
}


// ─── 5b. Scavenging ──────────────────────────────────────────
/**
 * Segments eat nearby food particles dropped by dead organisms.
 *
 * If an organism has ANY white segment, then ALL its segments can eat food
 * (white scavenger efficiency). Otherwise, only Red segments eat (red efficiency).
 *
 * Viral food: eating a viral food particle grants energy normally but also
 * creates a spontaneous virus strain and infects the eating segment.
 */
function runScavenging(world: World, config: SimConfig): void {
  if (world.tick % FOOD_SCAVENGE_INTERVAL_TICKS !== 0) return;

  const food = world.food;
  if (food.count === 0) return;

  const seg = world.segments;
  const rangeSq = FOOD_SCAVENGE_RANGE * FOOD_SCAVENGE_RANGE;

  // Build spatial hash of alive food particles
  clearSpatialHash(foodSpatialHash);
  for (let i = 0; i < FOOD_MAX_PARTICLES; i++) {
    if (food.alive[i]) {
      insertIntoSpatialHash(foodSpatialHash, i, food.x[i], food.y[i]);
    }
  }

  const fBuf = foodSpatialHash.queryBuf;

  for (const org of world.organisms.values()) {
    if (!org.alive) continue;

    // Determine scavenging eligibility:
    // - hasWhite: any segment can eat food at white efficiency
    // - else: only Red segments can eat at red efficiency
    const orgCanEat = org.hasWhite;
    const orgEfficiency = org.hasWhite ? FOOD_WHITE_EFFICIENCY : FOOD_RED_EFFICIENCY;

    for (let i = 0; i < org.segmentCount; i++) {
      const idx = org.firstSegment + i;
      if (!seg.alive[idx]) continue;

      // Check if this segment can eat
      const color = seg.color[idx];
      if (!orgCanEat && color !== SegmentColor.Red) continue;

      // Query food spatial hash
      const nearbyLen = querySpatialHash(foodSpatialHash, seg.x[idx], seg.y[idx]);

      for (let n = 0; n < nearbyLen; n++) {
        const fi = fBuf[n];
        if (!food.alive[fi]) continue;

        // Depth layer check — must be on same blur layer
        const segLayer = Math.min(BLUR_LAYER_COUNT - 1,
          Math.floor(seg.segmentDepth[idx] * BLUR_LAYER_COUNT));
        const foodLayer = Math.min(BLUR_LAYER_COUNT - 1,
          Math.floor(food.depth[fi] * BLUR_LAYER_COUNT));
        if (segLayer !== foodLayer) continue;

        const dx = food.x[fi] - seg.x[idx];
        const dy = food.y[fi] - seg.y[idx];
        if (dx * dx + dy * dy > rangeSq) continue;

        // Eat the food
        const { energy, wasViral, viralColor } = consumeFood(world.food, fi);
        org.rootHealthReserve += energy * orgEfficiency;
        org.rootHealthReserve = Math.min(org.rootHealthReserve, org.rootHealthReserveMax);

        // Viral food: infect the eating organism with a strain matching the food's color
        if (wasViral && config.virusEnabled) {
          const strainIdx = createSpontaneousStrain(world.virusStrains, config, viralColor);
          if (strainIdx >= 0) {
            infectSegment(world, idx, strainIdx, world.tick);
          }
        }

        break; // One food per segment per tick
      }
    }
  }
}


// ─── 6. Health Checks ───────────────────────────────────────
/**
 * Check for segment and organism death conditions.
 *
 * SEGMENT DEATH: When segment health <= 0, it's destroyed.
 * In a tree, destroying a segment also destroys all its descendants
 * (they're severed from the organism like a broken branch).
 *
 * ORGANISM DEATH: When rootHealthReserve <= 0 OR root segment health <= 0.
 * The whole organism dies.
 *
 * V1: segmentHealth<=0 → segment severed (joint broken).
 *     rootHealthReserve<=0 OR root health<=0 → organism death.
 */
function runHealthChecks(world: World): void {
  const seg = world.segments;
  _healthToRemove.length = 0;
  const toRemove = _healthToRemove;

  for (const org of world.organisms.values()) {
    if (!org.alive) continue;

    // Check organism death: rootHealthReserve depleted
    if (org.rootHealthReserve <= 0) {
      toRemove.push(org.id);
      continue;
    }

    // Check root segment death
    const rootIdx = org.firstSegment;
    if (seg.health[rootIdx] <= 0) {
      toRemove.push(org.id);
      continue;
    }

    // Check individual segment death (non-root)
    // When a segment dies, sever it and all its descendants from the tree
    for (let i = 1; i < org.segmentCount; i++) {
      const idx = org.firstSegment + i;
      if (!seg.alive[idx]) continue;

      if (seg.health[idx] <= 0) {
        // Kill this segment and all descendants
        killBranch(world, org, i);
      }
    }
  }

  // Remove dead organisms
  for (const id of toRemove) {
    removeOrganism(world, id);
  }
}

/**
 * Kill a segment and all its descendants in the tree.
 * This "severs" a branch — like breaking off a limb.
 */
function killBranch(world: World, org: Organism, geneIdx: number): void {
  const seg = world.segments;
  const globalIdx = org.firstSegment + geneIdx;

  // Drop food particle at dying segment's position — viral (with color) if organism is infected
  if (seg.alive[globalIdx]) {
    let viralColor = -1;
    if (org.virusInfectionCount > 0 && seg.virusStrainId[globalIdx] > 0) {
      const strain = world.virusStrains.strains[seg.virusStrainId[globalIdx] - 1];
      if (strain?.alive) viralColor = strain.colorAffinity;
    }
    spawnFood(world.food, seg.x[globalIdx], seg.y[globalIdx],
      FOOD_ENERGY_PER_SEGMENT, seg.segmentDepth[globalIdx], world.tick, viralColor);
  }

  seg.alive[globalIdx] = 0;

  // Recursively kill all children
  const children = org.topology.children[geneIdx];
  for (let c = 0; c < children.length; c++) {
    const childGeneIdx = children[c];
    const childGlobalIdx = org.firstSegment + childGeneIdx;
    if (seg.alive[childGlobalIdx]) {
      killBranch(world, org, childGeneIdx);
    }
  }
}


// ─── 7. Segment Depth Propagation ───────────────────────────
/**
 * Propagate per-segment depth from root → leaves (wave effect).
 *
 * Depth changes are driven by YELLOW SEGMENTS in runYellowMovement —
 * not by random drift. This function just propagates whatever depth
 * the root is at outward through the tree with a delay.
 *
 * The root segment instantly tracks `org.depth`. Each non-root segment
 * follows its parent segment's depth with an exponential delay
 * (SEGMENT_DEPTH_FOLLOW_RATE per tick). This creates a "diving" wave:
 * the root enters a new depth first and the body follows, like a whale
 * diving headfirst.
 *
 * Adjacent segments are clamped to differ by at most one blur layer
 * (MAX_ADJACENT_DEPTH_DIFF), preventing extreme visual discontinuities.
 *
 * The per-segment depth is what the renderer uses for blur/alpha/scale,
 * so different parts of the same organism can appear at different blur
 * levels — the head sharp and the tail blurry as it dives deeper.
 */
function runSegmentDepthPropagation(world: World): void {
  const seg = world.segments;

  for (const org of world.organisms.values()) {
    if (!org.alive) continue;

    // Root segment instantly tracks organism depth (set by yellow movement)
    const rootIdx = org.firstSegment;
    seg.segmentDepth[rootIdx] = org.depth;

    // Children follow their parent's segment depth in topological order
    // (array index order = topological order, so parent is always processed first)
    for (let i = 1; i < org.segmentCount; i++) {
      const idx = org.firstSegment + i;
      if (!seg.alive[idx]) continue;

      const parentIdx = idx + seg.parentOffset[idx];
      const parentDepth = seg.segmentDepth[parentIdx];
      const myDepth = seg.segmentDepth[idx];

      // Exponential follow: close a fraction of the gap per tick
      const gap = parentDepth - myDepth;
      let newDepth = myDepth + gap * SEGMENT_DEPTH_FOLLOW_RATE;

      // Clamp: adjacent segments can differ by at most one blur layer
      const clampedDiff = Math.max(-MAX_ADJACENT_DEPTH_DIFF,
        Math.min(MAX_ADJACENT_DEPTH_DIFF, newDepth - parentDepth));
      newDepth = parentDepth + clampedDiff;

      // Clamp to valid range
      seg.segmentDepth[idx] = Math.max(0, Math.min(1, newDepth));
    }
  }
}


// ─── 8. Timed Death ─────────────────────────────────────────
/**
 * Organisms have a natural lifespan. When their time is up, they die.
 *
 * V1: Invoke("timedDeath", Random.Range(100, 200)) — 100-200 seconds
 * V2: timedDeathAt is set at spawn time (2000-4000 ticks = 100-200 seconds)
 *
 * This prevents any single lineage from dominating forever and creates
 * generational turnover — essential for evolution to work.
 */
function runTimedDeath(world: World): void {
  _timedToRemove.length = 0;
  const toRemove = _timedToRemove;

  for (const org of world.organisms.values()) {
    if (!org.alive) continue;
    if (world.tick >= org.timedDeathAt) {
      toRemove.push(org.id);
    }
  }

  for (const id of toRemove) {
    removeOrganism(world, id);
  }
}
