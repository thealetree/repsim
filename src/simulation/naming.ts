/**
 * naming.ts — Organism name generation from genome colors
 *
 * V1's naming system: each color maps to a syllable, and the organism's name
 * is built by combining the syllables of its segment colors.
 *
 * Color → Syllable mapping (from V1's DragAndDrop.makeName()):
 *   Red = "Ba", Blue = "De", Green = "Ti", Yellow = "Mo", Black = "Cu"
 *
 * TREE TRAVERSAL: For tree-structured organisms, we traverse the genome
 * in depth-first order to produce a consistent syllable sequence.
 * For pure chains, DFS order = [0, 1, 2, ..., N-1], which produces
 * identical names to the old linear approach.
 *
 * Pattern:
 *   First gene's syllable (in DFS order) = "first name" (capitalized)
 *   Remaining genes' syllables = "last name" (concatenated, first letter capitalized)
 *
 * Examples:
 *   [Red]                    → "Ba"
 *   [Red, Blue]              → "Ba De"
 *   [Green, Yellow, Red]     → "Ti Moba"
 *   [Blue, Green, Red, Yellow] → "De Tibamo"
 */

import type { Genome } from '../types';
import { COLOR_SYLLABLES } from '../constants';

/**
 * Generate a display name from an organism's genome.
 * Each segment's color contributes a syllable to the name.
 * The tree is traversed depth-first for consistent ordering.
 */
export function generateName(genome: Genome): string {
  if (genome.length === 0) return 'Unknown';

  // Build children lists from parent references
  const children: number[][] = Array.from({ length: genome.length }, () => []);
  for (let i = 1; i < genome.length; i++) {
    children[genome[i].parent].push(i);
  }

  // DFS traversal order — produces consistent linear ordering of the tree
  // For a pure chain, this is just [0, 1, 2, ..., N-1]
  const order: number[] = [];
  const stack: number[] = [0];
  while (stack.length > 0) {
    const idx = stack.pop()!;
    order.push(idx);
    // Push children in reverse so first child is visited first
    const kids = children[idx];
    for (let c = kids.length - 1; c >= 0; c--) {
      stack.push(kids[c]);
    }
  }

  // First gene in DFS order = first name (already capitalized in our syllable map)
  const firstName = COLOR_SYLLABLES[genome[order[0]].color] ?? '??';

  // If single-segment organism, just the first name
  if (order.length === 1) return firstName;

  // Remaining genes form the "last name"
  // First syllable of last name is capitalized, rest are lowercase
  let lastName = '';
  for (let i = 1; i < order.length; i++) {
    const syllable = COLOR_SYLLABLES[genome[order[i]].color] ?? '??';
    if (i === 1) {
      // First syllable of last name: capitalize
      lastName += syllable.charAt(0).toUpperCase() + syllable.slice(1).toLowerCase();
    } else {
      // Subsequent syllables: all lowercase
      lastName += syllable.toLowerCase();
    }
  }

  return `${firstName} ${lastName}`;
}
