/**
 * virus.ts — Evolved Parasite System
 *
 * Viruses are small evolving genomes (color affinity + virulence + transmission)
 * that infect whole organisms. They emerge from contaminated food (dense
 * food clusters spontaneously become viral), spread on ANY segment-to-segment
 * contact between organisms, and mutate each time they spread.
 *
 * Infection is organism-wide: all segments get tagged with the strain.
 * Effects only impact segments matching the strain's color affinity.
 * Visually, all segments of an infected org turn a dark version of the target color.
 *
 * Effects (1-2 per strain, rolled at creation):
 * - Swelling: color-matching segments grow 1.3x (renderer handles visual)
 * - EnergyDrain: siphons HP (only from color-matching segments)
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
import { SegmentColor, VirusEffect, SEGMENT_COLOR_COUNT } from '../types';
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
  VIRUS_ENERGY_DRAIN_RATE,
  VIRUS_BLUE_ADJACENCY_SPEEDUP,
  VIRUS_INITIAL_VIRULENCE_MIN,
  VIRUS_INITIAL_VIRULENCE_MAX,
  VIRUS_INITIAL_TRANSMISSION_MIN,
  VIRUS_INITIAL_TRANSMISSION_MAX,
  VIRUS_SPREAD_RANGE,
  BLUR_LAYER_COUNT,
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
      virulence: 0,
      transmissionRate: 0,
      effects: [],
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
  virulence: number,
  transmissionRate: number,
  effects: VirusEffect[],
  parentStrainId: number,
): number {
  if (pool.freeSlots.length === 0) return -1;

  const idx = pool.freeSlots.pop()!;
  const strain = pool.strains[idx];
  strain.id = pool.nextStrainId++;
  strain.colorAffinity = colorAffinity;
  strain.virulence = virulence;
  strain.transmissionRate = transmissionRate;
  strain.effects = effects;
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

/** Roll 1-2 random virus effects. */
function rollEffects(): VirusEffect[] {
  const count = Math.random() < 0.5 ? 1 : 2;
  const available = [0, 1, 2, 3, 4] as VirusEffect[];

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
  config: SimConfig,
  fixedColor: number = -1,
): number {
  const colorAffinity = fixedColor >= 0
    ? fixedColor as SegmentColor
    : Math.floor(Math.random() * SEGMENT_COLOR_COUNT) as SegmentColor;

  const virulence = VIRUS_INITIAL_VIRULENCE_MIN
    + Math.random() * (VIRUS_INITIAL_VIRULENCE_MAX - VIRUS_INITIAL_VIRULENCE_MIN);
  const transmission = VIRUS_INITIAL_TRANSMISSION_MIN
    + Math.random() * (VIRUS_INITIAL_TRANSMISSION_MAX - VIRUS_INITIAL_TRANSMISSION_MIN);

  return createStrain(
    pool,
    colorAffinity,
    virulence * config.virusVirulence,
    transmission * config.virusTransmission,
    rollEffects(),
    -1,
  );
}


/** Clone a strain with mutation (on spread). Returns new pool index or -1. */
export function mutateStrain(
  pool: VirusStrainPool,
  parentPoolIndex: number,
  _config: SimConfig,
): number {
  const parent = pool.strains[parentPoolIndex];
  if (!parent.alive) return -1;

  // Drift virulence and transmission
  let virulence = parent.virulence + (Math.random() * 2 - 1) * VIRUS_MUTATION_DRIFT;
  let transmission = parent.transmissionRate + (Math.random() * 2 - 1) * VIRUS_MUTATION_DRIFT;
  virulence = Math.max(0.01, Math.min(1, virulence));
  transmission = Math.max(0.01, Math.min(1, transmission));

  // Small chance of color affinity change
  let colorAffinity = parent.colorAffinity;
  if (Math.random() < VIRUS_COLOR_MUTATION_CHANCE) {
    colorAffinity = Math.floor(Math.random() * SEGMENT_COLOR_COUNT) as SegmentColor;
  }

  return createStrain(
    pool,
    colorAffinity,
    virulence,
    transmission,
    [...parent.effects], // Inherit effects (don't re-roll)
    parent.id,
  );
}


// ─── Infection ─────────────────────────────────────────────

/** Check if an organism is immune to a strain (walks lineage). */
function isImmuneToStrain(org: Organism, strain: ViralStrain, pool: VirusStrainPool): boolean {
  // Check this strain's ID
  if (org.immuneTo.has(strain.id)) return true;

  // Walk ancestry (max 20 steps to prevent infinite loops)
  let parentId = strain.parentStrainId;
  let steps = 0;
  while (parentId !== -1 && steps < 20) {
    if (org.immuneTo.has(parentId)) return true;
    // Find strain by ID in pool
    const parentStrain = pool.strains.find(s => s.id === parentId);
    if (!parentStrain) break;
    parentId = parentStrain.parentStrainId;
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
  segGlobalIdx: number,
  strainPoolIndex: number,
  tick: number,
): boolean {
  return infectOrganism(world, segGlobalIdx, strainPoolIndex, tick, true);
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
): void {
  if (!config.virusEnabled) return;

  checkViralFoodSpawning(world, foodHash);
  runVirusSpread(world, config, attackHash);
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


/** Spread virus on ANY segment collision between infected and uninfected organisms. */
function runVirusSpread(
  world: World,
  config: SimConfig,
  attackHash: SpatialHash,
): void {
  if (world.tick % VIRUS_SPREAD_CHECK_INTERVAL !== 0) return;

  const seg = world.segments;
  const pool = world.virusStrains;
  const rangeSq = VIRUS_SPREAD_RANGE * VIRUS_SPREAD_RANGE;

  // Pre-compute depth layers + track which orgs already spread this tick
  const orgDepthLayer = new Map<number, number>();
  for (const org of world.organisms.values()) {
    if (org.alive) {
      orgDepthLayer.set(org.id, Math.min(BLUR_LAYER_COUNT - 1,
        Math.floor(org.depth * BLUR_LAYER_COUNT)));
    }
  }

  // Track organisms already infected this tick to avoid double-infecting
  const infectedThisTick = new Set<number>();

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

      // Roll transmission
      if (Math.random() > strain.transmissionRate * config.virusTransmission) continue;

      // Mutate and infect the entire target organism
      const childStrainIdx = mutateStrain(pool, strainPoolIdx - 1, config);
      if (childStrainIdx !== -1) {
        if (infectOrganism(world, targetOrgId, childStrainIdx, world.tick, false)) {
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

    // ALL viruses drain energy based on virulence. At max virulence this is fatal.
    // Drain scales with organism size so larger organisms aren't more resistant.
    const drainPerTick = VIRUS_ENERGY_DRAIN_RATE
      * strain.virulence * config.virusVirulence
      * (1 + org.segmentCount * 0.2); // Larger organisms drain faster
    org.rootHealthReserve -= drainPerTick;

    // EnergyDrain effect: bonus drain on top of base virulence drain
    if (strain.effects.includes(VirusEffect.EnergyDrain)) {
      org.rootHealthReserve -= drainPerTick * 0.5; // +50% bonus drain
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
      // Gain immunity to this strain and ancestors
      org.immuneTo.add(strain.id);
      let parentId = strain.parentStrainId;
      let steps = 0;
      while (parentId !== -1 && steps < 20) {
        org.immuneTo.add(parentId);
        const parentStrain = pool.strains.find(s => s.id === parentId);
        if (!parentStrain) break;
        parentId = parentStrain.parentStrainId;
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
  if (!strain.effects.includes(VirusEffect.ColorCorruption)) return false;

  // Virus completely disables segments matching the strain's color affinity
  return world.segments.color[segGlobalIdx] === strain.colorAffinity;
}
