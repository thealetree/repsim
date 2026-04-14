/**
 * reproduction.ts — Reproduction and mutation systems
 *
 * This is how organisms EVOLVE. Without reproduction, the simulation is a
 * closed system that slowly dies. With it, organisms pass on their genomes
 * (with mutations) to create the next generation.
 *
 * TWO MODES OF REPRODUCTION:
 *
 * 1. ASEXUAL (no black segments):
 *    When an organism's repro meter fills up (3001) from active energy gains
 *    (photosynthesis, food, predation), it copies its genome with small
 *    mutations and spawns a child nearby. Costs 3000 HP from the parent.
 *
 * 2. SEXUAL (has black segments):
 *    Requires a nearby mate (within 150 world units, same depth layer) who
 *    also has black segments and a full repro meter. The dominant parent's
 *    tree topology is used, with the recessive parent's colors/angles mixed
 *    in at a 15% rate per gene. Costs 3500 HP from EACH parent.
 *
 * MUTATION SYSTEM:
 * - Per-gene: mutationRate% chance to change color (with new chemistry-based angle)
 * - Structural: 15% chance per child of gaining or losing one segment
 *   - Adding: append new gene as child of random existing gene
 *   - Removing: remove a random leaf gene
 *   - Self-intersection validation prevents invalid body shapes
 *
 * V1 PARITY:
 * V1 used Unity's OnCollisionEnter for sexual reproduction contact detection.
 * V2 uses root-to-root proximity (150 units ≈ touching distance for typical organisms).
 * All mutation rates, HP costs, and meter thresholds match V1 defaults.
 */

import type { World, Organism, Genome, Gene, SimConfig } from '../../types';
import { SegmentColor, VirusEffect } from '../../types';
import {
  REPRO_METER_MAX,
  getReproCost,
  SEXUAL_REPRO_RANGE,
  STRUCTURAL_MUTATION_CHANCE,
  MIN_SEGMENTS,
  MAX_SEGMENTS,
  LENGTH_MUTATION_DRIFT,
  GENE_LENGTH_MIN,
  GENE_LENGTH_MAX,
  SEXUAL_VIGOR_BONUS,
  SEXUAL_LIFESPAN_BONUS,
  SEXUAL_IMMUNITY_INHERIT_RATE,
  VIRUS_VERTICAL_TRANSMISSION_CHANCE,
  VIRUS_IMMUNITY_INHERITANCE_CHANCE,
  VIRUS_BLOOM_CHANCE,
  VIRUS_BLOOM_LIFESPAN_TICKS,
} from '../../constants';
import {
  spawnOrganismFromGenome,
  getDepthLayer,
  randomColor,
  randomTurnAngle,
  randomGeneLength,
  isGenomeSelfIntersecting,
} from '../world';
import { infectOrganism } from '../virus';


// Pre-compute squared range to avoid sqrt in distance checks
const SEXUAL_REPRO_RANGE_SQ = SEXUAL_REPRO_RANGE * SEXUAL_REPRO_RANGE;


/**
 * Run the reproduction system.
 *
 * Called every tick as part of runBehaviors, AFTER photosynthesis/drain/replenishment
 * (so HP state is current) and BEFORE movement/combat (so newborns don't immediately
 * get attacked on their birth tick).
 *
 * Flow:
 * 1. Repro meters are filled by ACTIVE energy systems in behaviors.ts
 *    (photosynthesis, food eating, predation — not passive reserve levels)
 * 2. Collect organisms ready to reproduce (meter >= REPRO_METER_MAX)
 * 3. Process asexual births (no black segments)
 * 4. Process sexual births (find mate pairs with black segments)
 * 5. Respect population cap — stop birthing when full
 */
export function runReproduction(world: World, config: SimConfig): void {
  // Check for births periodically (meter filling happens in behavior systems)
  if (world.tick % 10 !== 0) return;  // Every 0.5s

  // ── Population cap: soft cap + hard safety ceiling ──
  // Hard ceiling at 1.25× repLimit is a safety valve to prevent FPS degradation.
  // Below that, reproduction probability decreases smoothly as population approaches
  // repLimit — allowing emergent boom/bust cycles rather than a hard cliff.
  //
  //   pop < 80% repLimit  → full probability (no throttle)
  //   pop = 100% repLimit → ~4% probability  (steep quadratic drop)
  //   pop ≥ 125% repLimit → hard blocked      (performance safety valve)
  const pop = world.stats.population;
  const hardCeiling = Math.floor(config.repLimit * 1.25);
  if (pop >= hardCeiling) return;

  if (pop > config.repLimit * 0.8) {
    // excessRatio: 0 at 80%, 1 at 100% (full repLimit), >1 beyond cap
    const excessRatio = (pop - config.repLimit * 0.8) / (config.repLimit * 0.2);
    // Quadratic drop: 1.0 at ratio=0, ~0.04 at ratio=1, 0 beyond ~1.02
    const reproProb = Math.max(0, 1 - excessRatio * excessRatio * 0.96);
    if (Math.random() > reproProb) return;
  }

  // ── Collect organisms ready to reproduce ──
  const readyAsexual: Organism[] = [];
  const readySexual: Organism[] = [];

  for (const org of world.organisms.values()) {
    if (!org.alive) continue;
    if (org.reproMeter < REPRO_METER_MAX) continue;

    if (org.hasBlack) {
      readySexual.push(org);
    } else {
      readyAsexual.push(org);
    }
  }

  // ── Process asexual reproduction ──
  for (const parent of readyAsexual) {
    if (!parent.alive) continue;
    if (world.stats.population >= hardCeiling) break;

    reproduceAsexually(world, parent, config);
  }

  // ── Process sexual reproduction ──
  // Track which organisms have already mated this tick to prevent double-mating
  const mated = new Set<number>();

  for (const org of readySexual) {
    if (!org.alive || mated.has(org.id)) continue;
    if (world.stats.population >= hardCeiling) break;

    // Find a nearby mate (also has black, also ready, same depth layer)
    const mate = findMate(world, org, readySexual, mated);
    if (mate) {
      mated.add(org.id);
      mated.add(mate.id);
      reproduceSexually(world, org, mate, config);
    }
  }
}


// ─── Asexual Reproduction ──────────────────────────────────

/**
 * Asexual reproduction: copy genome with mutation, spawn child near parent.
 *
 * V1: MakeChild() — copies genome, mutates at asexMutationRate%, spawns nearby.
 * Cost: 3000 HP. Simpler and cheaper than sexual, but less genetic diversity.
 */
function reproduceAsexually(world: World, parent: Organism, config: SimConfig): void {
  // HP cost check — scaled by organism size
  const cost = getReproCost(parent.genome.length);
  if (parent.rootHealthReserve < cost) return;

  parent.rootHealthReserve -= cost;
  parent.reproMeter = 0;

  // Spawn near parent (random offset 30-60 units from root)
  const seg = world.segments;
  const rootIdx = parent.firstSegment;
  const offset = 30 + Math.random() * 30;
  const angle = Math.random() * Math.PI * 2;
  const spawnX = seg.x[rootIdx] + Math.cos(angle) * offset;
  const spawnY = seg.y[rootIdx] + Math.sin(angle) * offset;

  // Virus: check for viral bloom hijack (infected black segments may produce blooms)
  if (tryViralBloom(world, parent, config, spawnX, spawnY)) {
    parent.childCount++;
    return; // Hijacked — bloom spawned instead of normal child
  }

  // Mutate genome
  const childGenome = mutateGenome(parent.genome, config.asexMutationRate);

  const child = spawnOrganismFromGenome(
    world, childGenome, spawnX, spawnY, config,
    parent.id, parent.generation + 1,
  );

  if (child) {
    // Inherit similar depth (with slight variation for visual interest)
    child.depth = Math.max(0, Math.min(1,
      parent.depth + (Math.random() * 0.2 - 0.1),
    ));
    child.depthTarget = Math.random(); // Independent depth target

    // Initialize all child segments to the child's depth
    // (wave propagation in runDepthDrift will create variation over time)
    const childSeg = world.segments;
    for (let s = 0; s < child.segmentCount; s++) {
      childSeg.segmentDepth[child.firstSegment + s] = child.depth;
    }

    // Virus: vertical transmission + immunity inheritance
    if (config.virusEnabled) {
      transmitVirusVertically(world, parent, child);
      inheritImmunity(parent, child, VIRUS_IMMUNITY_INHERITANCE_CHANCE);
    }

    parent.childCount++;
  }
}


// ─── Sexual Reproduction ───────────────────────────────────

/**
 * Sexual reproduction: crossover two genomes with mutation, spawn child between parents.
 *
 * V1: Reprodcution.cs OnCollisionEnter → both must have black, both have full meter.
 * Dominant parent = longer genome. Recessive parent's genes mix in at sexGeneComboRate%.
 * Cost: purpleCost (3500) from EACH parent — more expensive than asexual.
 * Benefit: genetic diversity from crossover, making evolution faster.
 */
function reproduceSexually(
  world: World,
  parent1: Organism,
  parent2: Organism,
  config: SimConfig,
): void {
  // Sexual repro cost scales with organism size — prevents large organisms
  // from reproducing cheaply. Base purpleCost + 200 per segment.
  const cost1 = config.purpleCost + 200 * parent1.segmentCount;
  const cost2 = config.purpleCost + 200 * parent2.segmentCount;

  // HP cost check for both parents
  if (parent1.rootHealthReserve < cost1 || parent2.rootHealthReserve < cost2) return;

  parent1.rootHealthReserve -= cost1;
  parent2.rootHealthReserve -= cost2;
  parent1.reproMeter = 0;
  parent2.reproMeter = 0;

  // Determine dominant parent (longer genome = more genes to pass on)
  // Ties go to parent1 (arbitrary, just needs to be deterministic)
  const dominant = parent1.genome.length >= parent2.genome.length ? parent1 : parent2;
  const recessive = dominant === parent1 ? parent2 : parent1;

  // Virus: check for viral bloom hijack from either parent
  const seg = world.segments;
  const r1 = parent1.firstSegment;
  const r2 = parent2.firstSegment;
  const midX = (seg.x[r1] + seg.x[r2]) / 2;
  const midY = (seg.y[r1] + seg.y[r2]) / 2;
  if (tryViralBloom(world, dominant, config, midX, midY)) {
    parent1.childCount++;
    parent2.childCount++;
    return; // Hijacked
  }

  // Crossover: use dominant's tree topology, mix in recessive's colors/angles
  const crossedGenome = crossoverGenomes(
    dominant.genome, recessive.genome, config.sexGeneComboRate,
  );

  // Apply sexual mutation rate (2% default, higher than asexual's 1%)
  const childGenome = mutateGenome(crossedGenome, config.sexMutationRate);

  // Spawn between parents (with slight jitter so siblings don't stack)
  const jitter = 20;
  const spawnX = midX + (Math.random() * 2 - 1) * jitter;
  const spawnY = midY + (Math.random() * 2 - 1) * jitter;

  const child = spawnOrganismFromGenome(
    world, childGenome, spawnX, spawnY, config,
    dominant.id, Math.max(parent1.generation, parent2.generation) + 1,
  );

  if (child) {
    // Depth between parents (average with slight jitter)
    child.depth = Math.max(0, Math.min(1,
      (parent1.depth + parent2.depth) / 2 + (Math.random() * 0.1 - 0.05),
    ));
    child.depthTarget = Math.random(); // Independent depth target

    // Initialize all child segments to the child's depth
    const childSeg = world.segments;
    for (let s = 0; s < child.segmentCount; s++) {
      childSeg.segmentDepth[child.firstSegment + s] = child.depth;
    }

    // Hybrid vigor: sexually-produced offspring start with bonus HP
    child.rootHealthReserve = Math.min(
      child.rootHealthReserve * SEXUAL_VIGOR_BONUS,
      child.rootHealthReserveMax,
    );

    // Sexual offspring live longer — reward for the cost of finding a mate
    child.timedDeathAt = Math.round(child.timedDeathAt + (child.timedDeathAt - world.tick) * (SEXUAL_LIFESPAN_BONUS - 1));

    // Virus: vertical transmission from dominant parent + immunity from both
    // Sexual offspring inherit immunity at higher rate (75% vs 50% asexual)
    if (config.virusEnabled) {
      transmitVirusVertically(world, dominant, child);
      inheritImmunity(dominant, child, SEXUAL_IMMUNITY_INHERIT_RATE);
      inheritImmunity(recessive, child, SEXUAL_IMMUNITY_INHERIT_RATE);
    }

    parent1.childCount++;
    parent2.childCount++;
  }
}


/**
 * Find a nearby mate for sexual reproduction.
 *
 * Requirements:
 * - Different organism (not self)
 * - Alive and not already mated this tick
 * - On the same or adjacent depth layer (±1 blur layer)
 * - Root-to-root distance within SEXUAL_REPRO_RANGE (300 units)
 *
 * Returns the closest valid mate, or null if none found.
 */
function findMate(
  world: World,
  org: Organism,
  candidates: Organism[],
  mated: Set<number>,
): Organism | null {
  const seg = world.segments;
  const orgLayer = getDepthLayer(org.depth);
  const orgRootIdx = org.firstSegment;
  const ox = seg.x[orgRootIdx];
  const oy = seg.y[orgRootIdx];

  let bestMate: Organism | null = null;
  let bestDistSq = SEXUAL_REPRO_RANGE_SQ;

  for (const candidate of candidates) {
    if (candidate.id === org.id) continue;
    if (!candidate.alive) continue;
    if (mated.has(candidate.id)) continue;

    // Must be on the same or adjacent depth layer (±1 layer)
    const candidateLayer = getDepthLayer(candidate.depth);
    if (Math.abs(candidateLayer - orgLayer) > 1) continue;

    // Root-to-root distance check
    const cRootIdx = candidate.firstSegment;
    const dx = seg.x[cRootIdx] - ox;
    const dy = seg.y[cRootIdx] - oy;
    const distSq = dx * dx + dy * dy;

    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestMate = candidate;
    }
  }

  return bestMate;
}


// ─── Genome Crossover ──────────────────────────────────────

/**
 * Crossover two genomes for sexual reproduction.
 *
 * Uses the dominant parent's tree topology (parent references, segment count).
 * For each gene position, there's a `comboRate`% chance of swapping in the
 * recessive parent's color and angle (but NOT the parent reference — topology
 * stays intact from the dominant parent).
 *
 * If the resulting shape self-intersects (because recessive angles changed
 * the geometry), falls back to color-only swaps (keeps dominant's angles).
 *
 * V1: Reproduction.cs mixes genes at sexGeneComboRate (15% default).
 */
function crossoverGenomes(
  dominant: Genome,
  recessive: Genome,
  comboRate: number,
): Genome {
  const result: Genome = [];

  for (let i = 0; i < dominant.length; i++) {
    const gene: Gene = { ...dominant[i] };

    // Chance to use recessive parent's traits
    if (i < recessive.length && Math.random() * 100 < comboRate) {
      gene.color = recessive[i].color;
      gene.angle = recessive[i].angle;
      gene.length = recessive[i].length;
      // Keep dominant's parent reference — tree topology is preserved
    }

    result.push(gene);
  }

  // Validate the resulting shape
  if (isGenomeSelfIntersecting(result)) {
    // Shape is invalid — fall back to color-only swaps (keep dominant's angles)
    const fallback: Genome = [];
    for (let i = 0; i < dominant.length; i++) {
      const gene: Gene = { ...dominant[i] };
      if (i < recessive.length && Math.random() * 100 < comboRate) {
        gene.color = recessive[i].color;
        // Keep dominant's angle to preserve valid shape
      }
      fallback.push(gene);
    }
    return fallback;
  }

  return result;
}


// ─── Mutation System ───────────────────────────────────────

/**
 * Mutate a genome for a child organism.
 *
 * Two types of mutation:
 *
 * 1. PER-GENE (mutationRate% per gene):
 *    Color changes to a random color, and the angle is regenerated using
 *    the new color's chemistry-based preferred angles. This means a green
 *    segment mutating to red will also shift from ±60° preference to ±90°.
 *
 * 2. STRUCTURAL (15% per reproduction event):
 *    50% chance to ADD a segment (append as child of random gene),
 *    50% chance to REMOVE a segment (remove a random leaf gene).
 *    Clamped to MIN_SEGMENTS..MAX_SEGMENTS range.
 *    Self-intersection check prevents invalid body shapes.
 *
 * V1: MakeChild() just did per-gene color swaps. V2 adds structural mutation
 * so organisms can evolve their size — a more interesting evolutionary dimension.
 */
function mutateGenome(genome: Genome, mutationRate: number): Genome {
  // Deep copy the genome (mutations must not affect parent)
  let mutated: Genome = genome.map(g => ({ ...g }));

  // ── Per-gene color mutation ──
  for (let i = 0; i < mutated.length; i++) {
    if (Math.random() * 100 < mutationRate) {
      const newColor = randomColor();
      mutated[i].color = newColor;
      // Regenerate angle and length based on new color's preferences
      mutated[i].angle = randomTurnAngle(newColor);
      mutated[i].length = randomGeneLength(newColor);
    } else if (Math.random() * 100 < mutationRate * 2) {
      // Independent length drift (slightly more common than color mutation)
      mutated[i].length = Math.max(GENE_LENGTH_MIN, Math.min(GENE_LENGTH_MAX,
        mutated[i].length + (Math.random() * 2 - 1) * LENGTH_MUTATION_DRIFT,
      ));
    }
  }

  // ── Structural mutation (add or remove a segment) ──
  if (Math.random() < STRUCTURAL_MUTATION_CHANCE) {
    if (Math.random() < 0.5 && mutated.length < MAX_SEGMENTS) {
      // ADD: append new gene as child of random existing gene
      mutated = addRandomSegment(mutated);
    } else if (mutated.length > MIN_SEGMENTS) {
      // REMOVE: remove a random leaf gene
      mutated = removeRandomLeaf(mutated);
    }
  }

  return mutated;
}


/**
 * Add a random segment to a genome.
 *
 * Appends a new gene at the end of the array with a random existing gene
 * as its parent. Since new index = genome.length and parent < genome.length,
 * topological sort is maintained automatically.
 *
 * Validates self-intersection — if the new segment causes overlap, the
 * addition is rejected and the original genome is returned.
 */
function addRandomSegment(genome: Genome): Genome {
  const color = randomColor();
  const parentIdx = Math.floor(Math.random() * genome.length);

  const newGene: Gene = {
    color,
    angle: randomTurnAngle(color),
    parent: parentIdx,
    length: randomGeneLength(color),
  };

  const extended = [...genome, newGene];

  // Validate: check self-intersection with new shape
  if (isGenomeSelfIntersecting(extended)) {
    return genome; // Reject structural change, keep original
  }

  return extended;
}


/**
 * Remove a random leaf gene from a genome.
 *
 * A "leaf" is a gene with no children (no other gene has it as parent).
 * The root (index 0) is never removed.
 *
 * After removal, all parent references that pointed past the removed index
 * are decremented by 1 to maintain correct topology. Since we only remove
 * leaves (genes with no children), no gene has the removed index as its parent.
 */
function removeRandomLeaf(genome: Genome): Genome {
  // Find all leaves (genes that no other gene points to as parent)
  const hasChildren = new Set<number>();
  for (let i = 1; i < genome.length; i++) {
    hasChildren.add(genome[i].parent);
  }

  const leaves: number[] = [];
  for (let i = 1; i < genome.length; i++) { // Skip root (index 0)
    if (!hasChildren.has(i)) {
      leaves.push(i);
    }
  }

  if (leaves.length === 0) return genome; // No removable leaves

  // Pick a random leaf to remove
  const removeIdx = leaves[Math.floor(Math.random() * leaves.length)];

  // Build new genome: skip the removed gene, fix parent references
  const result: Genome = [];
  for (let i = 0; i < genome.length; i++) {
    if (i === removeIdx) continue;

    const gene: Gene = { ...genome[i] };

    // Adjust parent reference: if it pointed past the removed index, shift down by 1
    // Note: gene.parent should NEVER === removeIdx because we only remove leaves
    if (gene.parent > removeIdx) {
      gene.parent -= 1;
    }

    result.push(gene);
  }

  return result;
}


// ─── Virus Vertical Transmission ────────────────────────────

/**
 * Vertical transmission: parent's active virus infection may pass to child.
 * Infection is organism-wide, so we pass the parent's strain to the whole child.
 * VIRUS_VERTICAL_TRANSMISSION_CHANCE (15%) chance per strain.
 */
function transmitVirusVertically(world: World, parent: Organism, child: Organism): void {
  if (parent.virusInfectionCount === 0) return;

  const seg = world.segments;

  // Get the parent's strain (organism-wide, so just grab from any infected segment)
  let strainIdx = -1;
  for (let i = 0; i < parent.segmentCount; i++) {
    const idx = parent.firstSegment + i;
    if (seg.virusStrainId[idx] > 0) {
      strainIdx = seg.virusStrainId[idx] - 1;
      break;
    }
  }

  if (strainIdx < 0) return;
  if (Math.random() >= VIRUS_VERTICAL_TRANSMISSION_CHANCE) return;

  const strain = world.virusStrains.strains[strainIdx];
  if (!strain?.alive) return;

  // Infect the entire child organism
  infectOrganism(world, child.id, strainIdx, world.tick, false);
}

/**
 * Immunity inheritance: child has 50% chance to inherit each immunity from parent.
 */
function inheritImmunity(parent: Organism, child: Organism, rate: number): void {
  for (const strainId of parent.immuneTo) {
    if (Math.random() < rate) {
      child.immuneTo.add(strainId);
    }
  }
}


// ─── Viral Bloom (ReproductionHijack) ───────────────────────

/**
 * Check if an organism's reproduction should be hijacked by virus.
 * If parent has infected black segments with ReproductionHijack effect,
 * there's a chance (VIRUS_BLOOM_CHANCE) to produce a viral bloom instead
 * of a normal child.
 *
 * Returns true if hijacked (caller should skip normal reproduction).
 */
function tryViralBloom(
  world: World, parent: Organism, config: SimConfig,
  spawnX: number, spawnY: number,
): boolean {
  if (!config.virusEnabled || parent.virusInfectionCount === 0) return false;

  const seg = world.segments;
  let hijackStrainIdx = -1;

  // Check for infected black segments with ReproductionHijack
  for (let i = 0; i < parent.segmentCount; i++) {
    const idx = parent.firstSegment + i;
    if (!seg.alive[idx]) continue;
    if (seg.color[idx] !== SegmentColor.Black) continue;
    if (seg.virusStrainId[idx] === 0) continue;

    const strainIdx = seg.virusStrainId[idx] - 1;
    const strain = world.virusStrains.strains[strainIdx];
    if (strain?.alive && (strain.effectsMask & (1 << VirusEffect.ReproductionHijack)) !== 0) {
      hijackStrainIdx = strainIdx;
      break;
    }
  }

  if (hijackStrainIdx < 0) return false;
  if (Math.random() >= VIRUS_BLOOM_CHANCE) return false;

  // Spawn a tiny 1-2 segment viral bloom organism
  const bloomSize = 1 + Math.floor(Math.random() * 2);
  const bloomGenome: Genome = [];
  for (let i = 0; i < bloomSize; i++) {
    bloomGenome.push({
      color: randomColor(),
      angle: randomTurnAngle(randomColor()),
      parent: i === 0 ? -1 : 0,
      length: randomGeneLength(randomColor()),
    });
  }

  const bloom = spawnOrganismFromGenome(
    world, bloomGenome, spawnX, spawnY, config,
    parent.id, parent.generation + 1,
  );

  if (bloom) {
    bloom.depth = parent.depth;
    bloom.depthTarget = Math.random();
    bloom.timedDeathAt = world.tick + VIRUS_BLOOM_LIFESPAN_TICKS;

    // Pre-infect the entire bloom with the hijacking strain
    infectOrganism(world, bloom.id, hijackStrainIdx, world.tick, false);

    // Initialize all bloom segments to parent's depth
    for (let s = 0; s < bloom.segmentCount; s++) {
      seg.segmentDepth[bloom.firstSegment + s] = bloom.depth;
    }
  }

  return true; // Hijacked — parent spent HP but got a bloom instead
}
