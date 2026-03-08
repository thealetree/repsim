/**
 * food.ts — Food particle system (death drops)
 *
 * When organisms or segments die, they scatter food particles at their positions.
 * Red segments and white (scavenger) segments can eat nearby food particles.
 * Food particles slowly decay over ~60 seconds.
 *
 * Storage: SoA (Struct of Arrays) with a free-list for O(1) spawn/despawn.
 */

import type { FoodParticles } from '../types';
import {
  FOOD_MAX_PARTICLES,
  FOOD_DECAY_TICKS,
  FOOD_DRIFT_SPEED,
  TANK_GRID_SPACING,
} from '../constants';


/** Allocate pre-sized typed arrays for food particles. */
export function createFoodParticles(): FoodParticles {
  const n = FOOD_MAX_PARTICLES;

  // Build free-slot stack (all slots start free)
  const freeSlots: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    freeSlots.push(i);
  }

  return {
    x: new Float32Array(n),
    y: new Float32Array(n),
    energy: new Float32Array(n),
    spawnTick: new Uint32Array(n),
    alive: new Uint8Array(n),
    driftDx: new Float32Array(n),
    driftDy: new Float32Array(n),
    depth: new Float32Array(n),
    isViral: new Uint8Array(n),
    count: 0,
    freeSlots,
  };
}


/**
 * Spawn a food particle at (x, y). Silently drops if at capacity.
 * viralColor: -1 = normal food, 0-5 = viral with that SegmentColor affinity.
 * Stored as viralColor + 1 so 0 = not viral in the array.
 */
export function spawnFood(
  food: FoodParticles,
  x: number,
  y: number,
  energy: number,
  depth: number,
  tick: number,
  viralColor: number = -1,
): void {
  if (food.freeSlots.length === 0) return; // At cap — drop silently

  const i = food.freeSlots.pop()!;

  food.x[i] = x;
  food.y[i] = y;
  food.energy[i] = energy;
  food.spawnTick[i] = tick;
  food.alive[i] = 1;
  food.depth[i] = depth;
  food.isViral[i] = viralColor >= 0 ? viralColor + 1 : 0;

  // Random drift direction (normalized)
  const angle = Math.random() * Math.PI * 2;
  food.driftDx[i] = Math.cos(angle);
  food.driftDy[i] = Math.sin(angle);

  food.count++;
}


/**
 * Pack col,row into a single integer key for fast Set lookups.
 * Matches the same packing used by constraints.ts to avoid string allocation.
 */
function packCellKey(col: number, row: number): number {
  return ((col + 10000) << 16) | ((row + 10000) & 0xFFFF);
}

// Module-level fast numeric tank cell set — rebuilt from string-based Set on demand.
let _foodTankCellsFast: Set<number> | null = null;
let _foodTankCellsSize = -1;

/** Rebuild fast numeric lookup from the canonical string-based tank cells Set. */
function syncFoodTankCells(tankCells: Set<string>): void {
  if (_foodTankCellsFast && tankCells.size === _foodTankCellsSize) return;
  _foodTankCellsFast = new Set<number>();
  for (const key of tankCells) {
    const sep = key.indexOf(',');
    const col = Number(key.slice(0, sep));
    const row = Number(key.slice(sep + 1));
    _foodTankCellsFast.add(packCellKey(col, row));
  }
  _foodTankCellsSize = tankCells.size;
}

/** Update food particles: apply drift and decay expired ones. */
export function updateFood(food: FoodParticles, tick: number, tankCells: Set<string>): void {
  if (food.count === 0) return;

  // Sync numeric tank cell lookup (only rebuilds when size changes)
  syncFoodTankCells(tankCells);
  const fastCells = _foodTankCellsFast!;

  const gs = TANK_GRID_SPACING;

  for (let i = 0; i < FOOD_MAX_PARTICLES; i++) {
    if (!food.alive[i]) continue;

    // Decay check
    if (tick - food.spawnTick[i] >= FOOD_DECAY_TICKS) {
      food.alive[i] = 0;
      food.freeSlots.push(i);
      food.count--;
      continue;
    }

    // Slow drift
    const newX = food.x[i] + food.driftDx[i] * FOOD_DRIFT_SPEED;
    const newY = food.y[i] + food.driftDy[i] * FOOD_DRIFT_SPEED;

    // Check if new position is inside a tank cell (numeric key — no string allocation)
    const col = Math.floor(newX / gs);
    const row = Math.floor(newY / gs);

    if (fastCells.has(packCellKey(col, row))) {
      food.x[i] = newX;
      food.y[i] = newY;
    } else {
      // Hit tank boundary — reverse drift direction
      food.driftDx[i] *= -1;
      food.driftDy[i] *= -1;
    }
  }
}


/**
 * Consume a food particle. Returns energy and viral color (-1 if not viral).
 */
export function consumeFood(food: FoodParticles, index: number): { energy: number; wasViral: boolean; viralColor: number } {
  const energy = food.energy[index];
  const rawViral = food.isViral[index];
  const wasViral = rawViral > 0;
  const viralColor = rawViral > 0 ? rawViral - 1 : -1;
  food.alive[index] = 0;
  food.isViral[index] = 0;
  food.freeSlots.push(index);
  food.count--;
  return { energy, wasViral, viralColor };
}
