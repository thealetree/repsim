/**
 * tree-utils.ts — Genome tree topology utilities
 *
 * Organisms in Repsim V2 are TREES of connected segments, not linear chains.
 * Each gene in the genome has a `parent` field pointing to its parent gene's
 * index (-1 for the root). The genome array is topologically sorted — every
 * gene's parent index is less than its own index.
 *
 * This module provides functions to analyze tree genomes:
 * - buildGenomeTopology(): Computes children lists, leaf flags, depths — called
 *   once at spawn time and cached on the Organism for O(1) lookups during
 *   constraint solving and rendering.
 * - isValidTreeGenome(): Validates that a genome is a well-formed tree.
 */

import type { Genome, GenomeTopology } from '../types';
import { SEGMENT_CHAIN_DISTANCE } from '../constants';


/**
 * Build precomputed topology from a genome's parent references.
 * O(N) scan, called once per organism at spawn time.
 *
 * The topology is cached on the Organism so that constraint systems
 * and the renderer can traverse the tree structure without recomputing
 * anything each frame.
 */
export function buildGenomeTopology(genome: Genome): GenomeTopology {
  const n = genome.length;
  const children: number[][] = Array.from({ length: n }, () => []);
  const childCount = new Array<number>(n).fill(0);
  const depth = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    const p = genome[i].parent;
    children[p].push(i);
    childCount[p]++;
    depth[i] = depth[p] + 1;
  }

  const isLeaf = childCount.map(c => c === 0);

  // Pre-compute cumulative angles and chain distances for angular constraint optimization.
  // cumulativeAngle[i] = sum of genome[k].angle along path from root to gene i.
  // Using angle-addition identities at runtime avoids per-segment trig in the hot loop.
  const cumulativeAngle = new Float64Array(n);
  const cosCumAngle = new Float64Array(n);
  const sinCumAngle = new Float64Array(n);
  const chainDist = new Float64Array(n);

  cosCumAngle[0] = 1;  // cos(0)
  sinCumAngle[0] = 0;  // sin(0)
  chainDist[0] = 0;    // root has no parent chain

  for (let i = 1; i < n; i++) {
    const p = genome[i].parent;
    cumulativeAngle[i] = cumulativeAngle[p] + genome[i].angle;
    cosCumAngle[i] = Math.cos(cumulativeAngle[i]);
    sinCumAngle[i] = Math.sin(cumulativeAngle[i]);
    const pLen = genome[p].length || 1;
    const cLen = genome[i].length || 1;
    chainDist[i] = SEGMENT_CHAIN_DISTANCE * Math.sqrt((pLen + cLen) / 2);
  }

  return { children, childCount, isLeaf, depth, cosCumAngle, sinCumAngle, chainDist };
}


/**
 * Validate that a genome is a well-formed tree:
 * - At least one gene
 * - Exactly one root (gene[0] has parent === -1)
 * - All parent references point to lower indices (topological sort invariant)
 * - All parent references are in bounds
 */
export function isValidTreeGenome(genome: Genome): boolean {
  if (genome.length === 0) return false;
  if (genome[0].parent !== -1) return false;

  for (let i = 1; i < genome.length; i++) {
    const p = genome[i].parent;
    if (p < 0 || p >= i) return false; // must point to a lower-index gene
  }
  return true;
}
