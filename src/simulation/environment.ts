/**
 * environment.ts — Light and temperature field computation
 *
 * Pure functions for computing environmental influence at any world position:
 * - Light: Sum of contributions from all light sources, with wall occlusion via DDA ray march
 * - Temperature: Sum of contributions from all temperature sources (no wall occlusion)
 * - Viscosity: Base viscosity modified by local temperature
 * - Metabolism: Speed multiplier from local temperature
 */

import type { LightSource, TemperatureSource, CurrentSource } from '../types';
import { CurrentType } from '../types';
import {
  TANK_GRID_SPACING,
  VISCOSITY_MIN_DAMPING,
  VISCOSITY_MAX_DAMPING,
  TEMP_METABOLISM_MIN,
  TEMP_METABOLISM_MAX,
  CURRENT_FORCE_SCALE,
  DAY_NIGHT_MIN_INTENSITY,
} from '../constants';


// ─── Quadratic Falloff ──────────────────────────────────────

/** contribution = intensity * (1 - (dist/radius)²), 0 if outside radius */
function quadraticFalloff(dist: number, radius: number, intensity: number): number {
  if (dist >= radius) return 0;
  const t = dist / radius;
  return intensity * (1 - t * t);
}


// ─── Ray Tracing (Wall Occlusion) ───────────────────────────

/**
 * Check if a ray from (x0,y0) to (x1,y1) passes through any non-tank cells.
 * Uses DDA (Digital Differential Analyzer) grid traversal.
 * Origin-centered grid: col = floor(x / gs).
 * Returns true if the path is CLEAR (all cells along the ray are tank cells).
 */
export function isPathClear(
  x0: number, y0: number,
  x1: number, y1: number,
  tankCells: Set<string>,
): boolean {
  const gs = TANK_GRID_SPACING;

  // Convert to origin-centered grid coordinates
  const startCol = Math.floor(x0 / gs);
  const startRow = Math.floor(y0 / gs);
  const endCol = Math.floor(x1 / gs);
  const endRow = Math.floor(y1 / gs);

  const dx = x1 - x0;
  const dy = y1 - y0;

  const stepCol = dx >= 0 ? 1 : -1;
  const stepRow = dy >= 0 ? 1 : -1;

  // How far along the ray (in t) to cross one full grid cell
  const tDeltaCol = dx !== 0 ? Math.abs(gs / dx) : Infinity;
  const tDeltaRow = dy !== 0 ? Math.abs(gs / dy) : Infinity;

  // t value at which the ray crosses the next column/row boundary
  const colBoundary = dx >= 0
    ? (startCol + 1) * gs
    : startCol * gs;
  const rowBoundary = dy >= 0
    ? (startRow + 1) * gs
    : startRow * gs;

  let tMaxCol = dx !== 0 ? (colBoundary - x0) / dx : Infinity;
  let tMaxRow = dy !== 0 ? (rowBoundary - y0) / dy : Infinity;

  let col = startCol;
  let row = startRow;

  // Walk the ray through grid cells
  const maxSteps = Math.abs(endCol - startCol) + Math.abs(endRow - startRow) + 2;
  for (let step = 0; step < maxSteps; step++) {
    // Inverted: non-tank cells block the ray (skip source cell at step 0)
    if (step > 0 && !tankCells.has(`${col},${row}`)) {
      return false; // Non-tank cell blocks the ray
    }

    // Reached the target cell
    if (col === endCol && row === endRow) return true;

    // Step to next cell (DDA)
    if (tMaxCol < tMaxRow) {
      col += stepCol;
      tMaxCol += tDeltaCol;
    } else {
      row += stepRow;
      tMaxRow += tDeltaRow;
    }
  }

  return true;
}


// ─── Light Field ────────────────────────────────────────────

/**
 * Compute total light at a world position.
 * Sums contributions from all light sources, skipping ones occluded by non-tank cells.
 * Returns 0-N (consumer should clamp to 0-1 if needed).
 */
export function computeLight(
  x: number, y: number,
  sources: LightSource[],
  tankCells: Set<string>,
  dayNightMult: number = 1,
): number {
  if (sources.length === 0) return 0;

  let total = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dx = x - s.x;
    const dy = y - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist >= s.radius) continue;

    // Check occlusion by non-tank cells
    if (!isPathClear(s.x, s.y, x, y, tankCells)) continue;

    total += quadraticFalloff(dist, s.radius, s.intensity) * dayNightMult;
  }

  return total;
}


// ─── Temperature Field ──────────────────────────────────────

/**
 * Compute net temperature at a world position.
 * No boundary occlusion — heat radiates through tank boundaries.
 * Positive = hot, negative = cold.
 */
export function computeTemperature(
  x: number, y: number,
  sources: TemperatureSource[],
): number {
  if (sources.length === 0) return 0;

  let total = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dx = x - s.x;
    const dy = y - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist >= s.radius) continue;

    total += quadraticFalloff(dist, s.radius, s.intensity);
  }

  return total;
}


// ─── Viscosity Damping ──────────────────────────────────────

/**
 * Compute the Verlet damping factor at a world position.
 * baseViscosity 0→1 maps to VISCOSITY_MIN_DAMPING→VISCOSITY_MAX_DAMPING.
 * Temperature locally shifts: hot → more fluid, cold → more viscous.
 */
export function computeDamping(
  x: number, y: number,
  baseViscosity: number,
  tempSources: TemperatureSource[],
): number {
  // Map baseViscosity 0-1 → damping range
  // 0 = max viscosity (min damping), 1 = min viscosity (max damping)
  const baseDamping = VISCOSITY_MIN_DAMPING
    + (VISCOSITY_MAX_DAMPING - VISCOSITY_MIN_DAMPING) * baseViscosity;

  const temp = computeTemperature(x, y, tempSources);
  if (temp === 0) return baseDamping;

  // Hot (positive) increases damping (less viscous), cold decreases it
  const tempModifier = temp * 0.05;
  return Math.max(VISCOSITY_MIN_DAMPING,
    Math.min(VISCOSITY_MAX_DAMPING, baseDamping + tempModifier));
}


// ─── Metabolism Modifier ────────────────────────────────────

/**
 * Compute metabolism speed multiplier at a world position.
 * Hot → faster metabolism (up to 1.5x), cold → slower (down to 0.5x).
 */
export function computeMetabolismMultiplier(
  x: number, y: number,
  tempSources: TemperatureSource[],
): number {
  const temp = computeTemperature(x, y, tempSources);
  if (temp === 0) return 1.0;

  // Linear: temp +1 → 1.5x, temp -1 → 0.5x
  return Math.max(TEMP_METABOLISM_MIN, Math.min(TEMP_METABOLISM_MAX, 1.0 + temp * 0.5));
}


// ─── Current Force Field ─────────────────────────────────────

/**
 * Compute total current force at a world position.
 * Whirlpool: tangential force (counterclockwise) with quadratic falloff.
 * Directional: linear force along source.direction with quadratic falloff.
 * No wall occlusion — force flows through boundaries.
 */
export function computeCurrentForce(
  x: number, y: number,
  sources: CurrentSource[],
): { fx: number; fy: number } {
  let fx = 0;
  let fy = 0;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dx = x - s.x;
    const dy = y - s.y;
    const distSq = dx * dx + dy * dy;
    const radiusSq = s.radius * s.radius;
    if (distSq >= radiusSq || distSq < 1) continue;

    const dist = Math.sqrt(distSq);
    const t = dist / s.radius;
    const falloff = 1 - t * t;
    const force = s.strength * CURRENT_FORCE_SCALE * falloff;

    if (s.type === CurrentType.Whirlpool) {
      // Tangential: perpendicular to radius vector (counterclockwise)
      const nx = -dy / dist;
      const ny = dx / dist;
      fx += nx * force;
      fy += ny * force;
    } else {
      // Directional: constant direction
      fx += Math.cos(s.direction) * force;
      fy += Math.sin(s.direction) * force;
    }
  }
  return { fx, fy };
}


// ─── Day/Night Cycle ─────────────────────────────────────────

/**
 * Compute the day/night light multiplier from the current phase.
 * Phase 0 = midnight (minimum), phase 0.5 = noon (maximum).
 * Returns DAY_NIGHT_MIN_INTENSITY..1.0 via sine wave.
 */
export function getDayNightMultiplier(phase: number): number {
  // sin maps: phase 0 → sin(-π/2) = -1, phase 0.5 → sin(π/2-π/2)=sin(0)...
  // Actually: we want phase 0.5 = noon = max (1.0), phase 0 = midnight = min
  // Use: 0.5 + 0.5 * sin(2π*phase - π/2)
  // At phase=0.5: sin(π - π/2) = sin(π/2) = 1 → 0.5+0.5 = 1.0 ✓
  // At phase=0:   sin(0 - π/2) = sin(-π/2) = -1 → 0.5-0.5 = 0.0 → clamp to min ✓
  const raw = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2 - Math.PI / 2);
  return DAY_NIGHT_MIN_INTENSITY + (1 - DAY_NIGHT_MIN_INTENSITY) * raw;
}
