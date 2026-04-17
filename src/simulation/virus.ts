/**
 * virus.ts — Evolved Parasite System
 *
 * Viruses are small evolving genomes: color affinity + three independent numeric
 * knobs (spread / damageRate / lethality) + 1-2 effects. They emerge from
 * contaminated food (dense food clusters spontaneously become viral), spread
 * on ANY segment-to-segment contact between organisms, and mutate each time
 * they spread.
 *
 * Infection is organism-wide: all segments get tagged with the strain.
 * Effects only impact segments matching the strain's color affinity.
 * Visually, all segments of an infected org turn a dark version of the target color.
 *
 * Lethality model: at infection seed, a single roll decides whether this
 * specific infection is lethal. Lethal infections drain HP to 0 (death).
 * Non-lethal infections drain down to NONLETHAL_FLOOR × maxReserve and stop,
 * so the host is weakened but survives until immunity kicks in.
 *
 * Effects (1-2 per strain, rolled at creation):
 * - JointWeakness: color-matching segments wobble ±20% (constraints handle physics)
 * - ColorCorruption: behavior suppression on color-matching segments
 * - ReproductionHijack: black segments produce viral blooms (reproduction handles)
 *
 * Immunity: survive infection 30-40s → gain immunity to that strain lineage.
 * Blue segments speed up immunity recovery for the whole organism.
 *
 * Storage: Object pool with free-list (strains are few and complex, not SoA).
 */

import type { World, SimConfig, ViralStrain, VirusStrainPool, Organism } from '../types';
import { SegmentColor, VirusEffect, VIRUS_EFFECT_VALUES, SEGMENT_COLOR_COUNT, effectsToMask } from '../types';
import {
  VIRUS_MAX_STRAINS,
  VIRUS_FOOD_DENSITY_THRESHOLD,
  VIRUS_FOOD_DENSITY_RADIUS,
  VIRUS_FOOD_DENSITY_CHECK_INTERVAL,
  VIRUS_FOOD_SPAWN_CHANCE,
  VIRUS_SPREAD_CHECK_INTERVAL,
  VIRUS_EFFECT_INTERVAL,
  VIRUS_MUTATION_DRIFT,
  VIRUS_COLOR_MUTATION_CHANCE,
  VIRUS_DAMAGE_BASE,
  NONLETHAL_FLOOR,
  VIRUS_BLUE_ADJACENCY_SPEEDUP,
  VIRUS_INITIAL_DAMAGE_MIN,
  VIRUS_INITIAL_DAMAGE_MAX,
  VIRUS_INITIAL_SPREAD_MIN,
  VIRUS_INITIAL_SPREAD_MAX,
  VIRUS_INITIAL_LETHALITY_MIN,
  VIRUS_INITIAL_LETHALITY_MAX,
  VIRUS_SPREAD_RANGE,
  FOOD_MAX_PARTICLES,
  SIM_TICKS_PER_SECOND,
} from '../constants';
import type { SpatialHash } from './spatial-hash';
import { querySpatialHash } from './spatial-hash';


// ─── Pool Management ───────────────────────────────────────

/** Create an empty virus strain pool. */
export function createVirusStrainPool(): VirusStrainPool {
  const strains: ViralStrain[] = [];
  const freeSlots: number[] = [];

  for (let i = VIRUS_MAX_STRAINS - 1; i >= 0; i--) {
    strains.push({
      id: 0,
      colorAffinity: 0 as SegmentColor,
      spread: 0,
      damageRate: 0,
      lethality: 0,
      effects: [],
      effectsMask: 0,
      parentStrainId: -1,
      alive: false,
      hostCount: 0,
    });
    freeSlots.push(i);
  }

  return { strains, freeSlots, nextStrainId: 1 };
}


/** Allocate a new strain in the pool. Returns pool index or -1 if full. */
export function createStrain(
  pool: VirusStrainPool,
  colorAffinity: SegmentColor,
  spread: number,
  damageRate: number,
  lethality: number,
  effects: VirusEffect[],
  parentStrainId: number,
): number {
  if (pool.freeSlots.length === 0) return -1;

  const idx = pool.freeSlots.pop()!;
  const strain = pool.strains[idx];
  strain.id = pool.nextStrainId++;
  strain.colorAffinity = colorAffinity;
  strain.spread = spread;
  strain.damageRate = damageRate;
  strain.lethality = lethality;
  strain.effects = effects;
  strain.effectsMask = effectsToMask(effects);
  strain.parentStrainId = parentStrainId;
  strain.alive = true;
  strain.hostCount = 0;

  return idx;
}


/** Release a strain back to the pool. */
function releaseStrain(pool: VirusStrainPool, poolIndex: number): void {
  pool.strains[poolIndex].alive = false;
  pool.strains[poolIndex].hostCount = 0;
  pool.freeSlots.push(poolIndex);
}


// ─── Strain Creation ───────────────────────────────────────

/** Roll 1-2 random virus effects from the three available (JointWeakness/ColorCorruption/ReproductionHijack). */
function rollEffects(): VirusEffect[] {
  const count = Math.random() < 0.5 ? 1 : 2;
  const available = [...VIRUS_EFFECT_VALUES];

  // Shuffle and pick
  for (let i = available.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [available[i], available[j]] = [available[j], available[i]];
  }

  return available.slice(0, count);
}


/** Create a spontaneous strain (from viral food). Optionally specify the color affinity. */
export function createSpontaneousStrain(
  pool: VirusStrainPool,
  _config: SimConfig,
  fixedColor: number = -1,
): number {
  const colorAffinity = fixedColor >= 0
    ? fixedColor as SegmentColor
    : Math.floor(Math.random() * SEGMENT_COLOR_COUNT) as SegmentColor;

  // Strain-intrinsic rolls — global config multipliers are applied at use-sites
  // (spread roll in runVirusSpread, damage in applyVirusEffects, lethality in
  // infectOrganism) so the strain's own genome stays comparable as sliders change.
  const spread = VIRUS_INITIAL_SPREAD_MIN
    + Math.random() * (VIRUS_INITIAL_SPREAD_MAX - VIRUS_INITIAL_SPREAD_MIN);
  const damageRate = VIRUS_INITIAL_DAMAGE_MIN
    + Math.random() * (VIRUS_INITIAL_DAMAGE_MAX - VIRUS_INITIAL_DAMAGE_MIN);
  const lethality = VIRUS_INITIAL_LETHALITY_MIN
    + Math.random() * (VIRUS_INITIAL_LETHALITY_MAX - VIRUS_INITIAL_LETHALITY_MIN);

  return createStrain(pool, colorAffinity, spread, damageRate, lethality, rollEffects(), -1);
}


/**
 * Attempt to mutate a strain on spread. If the mutation is significant
 * (color affinity changes), create a new child strain. Otherwise, reuse
 * the parent strain — infections from the same lineage share a strain ID
 * unless a meaningful mutation occurs.
 *
 * Returns pool index (may be the parent's own index if no new strain created), or -1 on error.
 */
export function mutateStrain(
  pool: VirusStrainPool,
  parentPoolIndex: number,
  _config: SimConfig,
): number {
  const parent = pool.strains[parentPoolIndex];
  if (!parent.alive) return -1;

  // Roll whether color affinity mutates (the significant mutation)
  const colorMutated = Math.random() < VIRUS_COLOR_MUTATION_CHANCE;

  const drift = () => (Math.random() * 2 - 1) * VIRUS_MUTATION_DRIFT;
  const clamp01 = (v: number) => Math.max(0.01, Math.min(1, v));

  if (!colorMutated) {
    // Minor drift only — apply in-place to parent strain and reuse it.
    // All three numeric fields drift per spread.
    parent.spread = clamp01(parent.spread + drift());
    parent.damageRate = clamp01(parent.damageRate + drift());
    parent.lethality = clamp01(parent.lethality + drift());
    return parentPoolIndex; // Reuse parent strain
  }

  // Significant mutation: new color affinity → create a new child strain
  const spread = clamp01(parent.spread + drift());
  const damageRate = clamp01(parent.damageRate + drift());
  const lethality = clamp01(parent.lethality + drift());

  let colorAffinity = Math.floor(Math.random() * SEGMENT_COLOR_COUNT) as SegmentColor;
  // Ensure it actually changed
  if (colorAffinity === parent.colorAffinity) {
    colorAffinity = ((colorAffinity + 1) % SEGMENT_COLOR_COUNT) as SegmentColor;
  }

  return createStrain(
    pool,
    colorAffinity,
    spread,
    damageRate,
    lethality,
    [...parent.effects], // Inherit effects (don't re-roll)
    parent.id,
  );
}


// ─── Infection ─────────────────────────────────────────────

// Module-level strain ID → pool index lookup for O(1) lineage walks.
const _strainIdToIndex = new Map<number, number>();

/** Rebuild strain ID lookup. Called before lineage walks. */
function syncStrainIdLookup(pool: VirusStrainPool): void {
  _strainIdToIndex.clear();
  for (let i = 0; i < pool.strains.length; i++) {
    if (pool.strains[i].alive) {
      _strainIdToIndex.set(pool.strains[i].id, i);
    }
  }
}

/** Check if an organism is immune to a strain (walks lineage with O(1) lookups). */
function isImmuneToStrain(org: Organism, strain: ViralStrain, pool: VirusStrainPool): boolean {
  // Check this strain's ID
  if (org.immuneTo.has(strain.id)) return true;

  // Walk ancestry (max 20 steps to prevent infinite loops)
  let parentId = strain.parentStrainId;
  let steps = 0;
  while (parentId !== -1 && steps < 20) {
    if (org.immuneTo.has(parentId)) return true;
    const idx = _strainIdToIndex.get(parentId);
    if (idx === undefined) break;
    parentId = pool.strains[idx].parentStrainId;
    steps++;
  }

  return false;
}


/**
 * Infect an entire organism. All segments get tagged with the strain.
 * Can be called with any segment of the target organism.
 * Returns true if infection took hold.
 */
export function infectOrganism(
  world: World,
  config: SimConfig,
  orgOrSegIdx: number,
  strainPoolIndex: number,
  tick: number,
  isSegmentIndex = true,
): boolean {
  const seg = world.segments;
  const pool = world.virusStrains;
  const strain = pool.strains[strainPoolIndex];

  if (!strain?.alive) return false;

  // Resolve organism
  let org: Organism | undefined;
  if (isSegmentIndex) {
    if (!seg.alive[orgOrSegIdx]) return false;
    const orgId = seg.organismId[orgOrSegIdx];
    org = world.organisms.get(orgId);
  } else {
    org = world.organisms.get(orgOrSegIdx);
  }
  if (!org || !org.alive) return false;
  if (org.virusInfectionCount > 0) return false; // Already infected
  if (isImmuneToStrain(org, strain, pool)) return false;

  // Roll lethality once per infection. Lethal rolls let the damage drain HP
  // to 0 (death); non-lethal rolls clamp HP at NONLETHAL_FLOOR × maxReserve
  // so the host is weakened but survives until immunity fires.
  org.infectionLethal = Math.random() < strain.lethality * config.virusLethality;

  // Infect ALL segments
  const storeVal = strainPoolIndex + 1; // +1 so 0 = uninfected
  let infected = 0;
  for (let i = 0; i < org.segmentCount; i++) {
    const idx = org.firstSegment + i;
    if (!seg.alive[idx]) continue;
    seg.virusStrainId[idx] = storeVal;
    seg.virusInfectedAt[idx] = tick;
    infected++;
  }

  strain.hostCount++;
  org.virusInfectionCount = infected;

  return true;
}

/** Legacy wrapper — redirects to infectOrganism for backward compat. */
export function infectSegment(
  world: World,
  config: SimConfig,
  segGlobalIdx: number,
  strainPoolIndex: number,
  tick: number,
): boolean {
  return infectOrganism(world, config, segGlobalIdx, strainPoolIndex, tick, true);
}


/** Clear infection from an entire organism. */
export function clearOrganismInfection(world: World, org: Organism): void {
  const seg = world.segments;
  let strainPoolIdx = 0;

  for (let i = 0; i < org.segmentCount; i++) {
    const idx = org.firstSegment + i;
    if (seg.virusStrainId[idx] > 0 && strainPoolIdx === 0) {
      strainPoolIdx = seg.virusStrainId[idx];
    }
    seg.virusStrainId[idx] = 0;
    seg.virusInfectedAt[idx] = 0;
  }

  // Decrement host count on the strain (once per organism, not per segment)
  if (strainPoolIdx > 0) {
    const strain = world.virusStrains.strains[strainPoolIdx - 1];
    if (strain) {
      strain.hostCount = Math.max(0, strain.hostCount - 1);
    }
  }

  org.virusInfectionCount = 0;
  org.infectionLethal = false;
}

/** Legacy wrapper — clears the whole organism that owns this segment. */
export function clearSegmentInfection(world: World, segGlobalIdx: number): void {
  const orgId = world.segments.organismId[segGlobalIdx];
  const org = world.organisms.get(orgId);
  if (org) {
    clearOrganismInfection(world, org);
  }
}


// ─── Blue Adjacency Helper ────────────────────────────────
// Reserved for future use: blue neighbor check speeds up immunity.
// hasBlueNeighbor(world, org, geneIdx) → true if parent or child is blue.


// ─── Per-Tick Systems ──────────────────────────────────────

/** Main virus tick — called from runBehaviors when virusEnabled. */
export function runVirusSystem(
  world: World,
  config: SimConfig,
  attackHash: SpatialHash,
  foodHash: SpatialHash,
  orgDepthLayer: Map<number, number>,
): void {
  if (!config.virusEnabled) return;

  // Build strain ID→index lookup once per virus tick (O(maxStrains), used by lineage walks)
  syncStrainIdLookup(world.virusStrains);

  checkViralFoodSpawning(world, foodHash);
  runVirusSpread(world, config, attackHash, orgDepthLayer);
  applyVirusEffects(world, config);
  runImmunityChecks(world, config);
  cleanupExtinctStrains(world);
}


/** Check for viral food spawning from dense food clusters. */
function checkViralFoodSpawning(
  world: World,
  foodHash: SpatialHash,
): void {
  if (world.tick % VIRUS_FOOD_DENSITY_CHECK_INTERVAL !== 0) return;
  if (world.food.count === 0) return;

  const food = world.food;
  const radiusSq = VIRUS_FOOD_DENSITY_RADIUS * VIRUS_FOOD_DENSITY_RADIUS;

  // Sample up to 20 random alive food particles
  let sampled = 0;
  for (let attempt = 0; attempt < 40 && sampled < 20; attempt++) {
    const fi = Math.floor(Math.random() * FOOD_MAX_PARTICLES);
    if (!food.alive[fi] || food.isViral[fi]) continue;
    sampled++;

    // Count nearby food using spatial hash
    const nearbyLen = querySpatialHash(foodHash, food.x[fi], food.y[fi]);
    const fBuf = foodHash.queryBuf;
    let count = 0;
    for (let n = 0; n < nearbyLen; n++) {
      const ni = fBuf[n];
      if (!food.alive[ni] || ni === fi) continue;
      const dx = food.x[ni] - food.x[fi];
      const dy = food.y[ni] - food.y[fi];
      if (dx * dx + dy * dy <= radiusSq) {
        count++;
      }
    }

    if (count >= VIRUS_FOOD_DENSITY_THRESHOLD && Math.random() < VIRUS_FOOD_SPAWN_CHANCE) {
      // Random color affinity, stored as color + 1 (0 = not viral)
      food.isViral[fi] = Math.floor(Math.random() * SEGMENT_COLOR_COUNT) + 1;
    }
  }
}


// Module-level reusable Set for virus spread (avoids per-call allocation).
const _infectedThisTick = new Set<number>();

/** Spread virus on ANY segment collision between infected and uninfected organisms. */
function runVirusSpread(
  world: World,
  config: SimConfig,
  attackHash: SpatialHash,
  orgDepthLayer: Map<number, number>,
): void {
  if (world.tick % VIRUS_SPREAD_CHECK_INTERVAL !== 0) return;

  const seg = world.segments;
  const pool = world.virusStrains;
  const rangeSq = VIRUS_SPREAD_RANGE * VIRUS_SPREAD_RANGE;
  // Depth layers provided by caller (computed once per tick in behaviors)

  // Track organisms already infected this tick (reuse module-level Set)
  _infectedThisTick.clear();
  const infectedThisTick = _infectedThisTick;

  // Iterate all infected segments — any touch can spread
  for (let idx = 0; idx < world.segmentCount; idx++) {
    if (!seg.alive[idx]) continue;
    const strainPoolIdx = seg.virusStrainId[idx];
    if (strainPoolIdx === 0) continue; // Not infected

    const strain = pool.strains[strainPoolIdx - 1];
    if (!strain?.alive) continue;

    const myOrgId = seg.organismId[idx];
    const myLayer = orgDepthLayer.get(myOrgId);

    // Query nearby segments
    const nearbyLen = querySpatialHash(attackHash, seg.x[idx], seg.y[idx]);
    const aBuf = attackHash.queryBuf;

    for (let n = 0; n < nearbyLen; n++) {
      const j = aBuf[n];
      if (!seg.alive[j]) continue;

      const targetOrgId = seg.organismId[j];
      if (targetOrgId === myOrgId) continue; // Same organism

      // Check if target org is already infected or was infected this tick
      const targetOrg = world.organisms.get(targetOrgId);
      if (!targetOrg || targetOrg.virusInfectionCount > 0) continue;
      if (infectedThisTick.has(targetOrgId)) continue;

      // Same depth layer
      const targetLayer = orgDepthLayer.get(targetOrgId);
      if (targetLayer !== myLayer) continue;

      // Distance check
      const dx = seg.x[j] - seg.x[idx];
      const dy = seg.y[j] - seg.y[idx];
      if (dx * dx + dy * dy > rangeSq) continue;

      // Roll spread (contagion gate — decoupled from damage + lethality)
      if (Math.random() > strain.spread * config.virusSpread) continue;

      // Mutate and infect the entire target organism
      const childStrainIdx = mutateStrain(pool, strainPoolIdx - 1, config);
      if (childStrainIdx !== -1) {
        if (infectOrganism(world, config, targetOrgId, childStrainIdx, world.tick, false)) {
          infectedThisTick.add(targetOrgId);
        }
      }
      break; // One spread per infected segment per tick
    }
  }
}


/** Apply virus effects — only to segments matching the strain's color affinity. */
function applyVirusEffects(world: World, config: SimConfig): void {
  if (world.tick % VIRUS_EFFECT_INTERVAL !== 0) return;

  const seg = world.segments;
  const pool = world.virusStrains;

  for (const org of world.organisms.values()) {
    if (!org.alive || org.virusInfectionCount === 0) continue;

    // Get strain from first infected segment (all segments share the same strain)
    let strain: ViralStrain | null = null;
    for (let i = 0; i < org.segmentCount; i++) {
      const idx = org.firstSegment + i;
      const spIdx = seg.virusStrainId[idx];
      if (spIdx > 0) {
        strain = pool.strains[spIdx - 1];
        break;
      }
    }
    if (!strain?.alive) continue;

    // Drain HP based on damageRate × global slider. Scales with organism size
    // so bigger hosts (which have bigger reserves) aren't effectively resistant.
    const drain = VIRUS_DAMAGE_BASE
      * strain.damageRate * config.virusDamage
      * (1 + org.segmentCount * 0.2);
    org.rootHealthReserve -= drain;

    // Lethality gate: non-lethal infections clamp HP at a survival floor so
    // the host is weakened but doesn't die from the virus itself. Lethal
    // infections drain unchecked.
    if (!org.infectionLethal) {
      const floor = org.rootHealthReserveMax * NONLETHAL_FLOOR;
      if (org.rootHealthReserve < floor) org.rootHealthReserve = floor;
    }
  }
}


/** Check immunity timers and cure entire organisms at once. */
function runImmunityChecks(world: World, config: SimConfig): void {
  if (world.tick % VIRUS_EFFECT_INTERVAL !== 0) return;

  const seg = world.segments;
  const pool = world.virusStrains;
  // Immunity time 0 = no immunity possible (organisms never recover)
  const canGainImmunity = config.virusImmunityTime > 0;
  const baseImmunityTicks = canGainImmunity
    ? config.virusImmunityTime * SIM_TICKS_PER_SECOND
    : Infinity;

  for (const org of world.organisms.values()) {
    if (!org.alive || org.virusInfectionCount === 0) continue;

    // Get strain info from first infected segment
    let strainPoolIdx = 0;
    let infectedAt = 0;
    for (let i = 0; i < org.segmentCount; i++) {
      const idx = org.firstSegment + i;
      if (seg.virusStrainId[idx] > 0) {
        strainPoolIdx = seg.virusStrainId[idx];
        infectedAt = seg.virusInfectedAt[idx];
        break;
      }
    }

    if (strainPoolIdx === 0) continue;
    const strain = pool.strains[strainPoolIdx - 1];

    if (!strain?.alive) {
      // Strain is dead, clear entire organism
      clearOrganismInfection(world, org);
      continue;
    }

    // Skip immunity if disabled
    if (!canGainImmunity) continue;

    // Blue segments speed immunity for the whole organism
    let immunityTicks = baseImmunityTicks;
    let hasBlue = false;
    for (let i = 0; i < org.segmentCount; i++) {
      const idx = org.firstSegment + i;
      if (seg.alive[idx] && seg.color[idx] === SegmentColor.Blue) {
        hasBlue = true;
        break;
      }
    }
    if (hasBlue) {
      immunityTicks /= VIRUS_BLUE_ADJACENCY_SPEEDUP;
    }

    // Check if enough time has passed — cure the whole organism at once
    if (world.tick - infectedAt >= immunityTicks) {
      // Gain immunity to this strain and ancestors (O(1) lookups via _strainIdToIndex)
      org.immuneTo.add(strain.id);
      let parentId = strain.parentStrainId;
      let steps = 0;
      while (parentId !== -1 && steps < 20) {
        org.immuneTo.add(parentId);
        const pIdx = _strainIdToIndex.get(parentId);
        if (pIdx === undefined) break;
        parentId = pool.strains[pIdx].parentStrainId;
        steps++;
      }

      clearOrganismInfection(world, org);
    }
  }
}


/** Clean up extinct strains (no hosts left). */
function cleanupExtinctStrains(world: World): void {
  const pool = world.virusStrains;
  for (let i = 0; i < VIRUS_MAX_STRAINS; i++) {
    const strain = pool.strains[i];
    if (strain.alive && strain.hostCount <= 0) {
      releaseStrain(pool, i);
    }
  }
}


// ─── Color Corruption Helper ──────────────────────────────

/**
 * Check if a segment's behavior is disabled by virus infection.
 * Virus completely disables segments matching the strain's color affinity.
 * Called by behavior functions (photosynthesis, yellow movement, red attack).
 */
export function isColorCorrupted(world: World, segGlobalIdx: number): boolean {
  const strainPoolIdx = world.segments.virusStrainId[segGlobalIdx];
  if (strainPoolIdx === 0) return false;

  const strain = world.virusStrains.strains[strainPoolIdx - 1];
  if (!strain?.alive) return false;

  // Only strains with the ColorCorruption effect disable segment behavior
  if ((strain.effectsMask & (1 << VirusEffect.ColorCorruption)) === 0) return false;

  // Virus completely disables segments matching the strain's color affinity
  return world.segments.color[segGlobalIdx] === strain.colorAffinity;
}
