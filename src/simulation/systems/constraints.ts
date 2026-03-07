/**
 * constraints.ts — Physics constraint systems
 *
 * This file handles the physical rules that keep the simulation stable:
 *
 * 1. Verlet Integration — Updates positions based on implicit velocity
 * 2. Chain Constraints — Keeps connected segments at the right distance
 * 3. Angular Constraints — Keeps organism shapes matching their genome
 * 4. Dish Boundary — Keeps all segments inside the petri dish
 * 5. Segment Collision — Pushes overlapping segments apart
 *
 * TREE STRUCTURE: Organisms are trees, not chains. Each segment has a parent
 * (stored as `parentOffset` in the segment arrays). Constraints use parent-child
 * relationships instead of sequential index pairs.
 *
 * CRITICAL DESIGN NOTE — Position-Only Constraints:
 * All constraints adjust BOTH position AND previous position by the same delta.
 * In verlet physics, velocity = pos - prevPos. If we only move pos, we
 * accidentally inject velocity and organisms spin/drift on their own.
 * By moving prevPos too, constraints are pure position corrections with
 * ZERO velocity injection. Organisms only move when actual forces are applied
 * (yellow segments in Phase 2).
 *
 * PERFORMANCE NOTE — Numeric Cell Keys:
 * Tank boundary collision is the hottest loop (called 4× per tick on ALL segments).
 * We use packed numeric keys instead of template literal strings for tank cell
 * lookups, and cache which cells are "interior" (all 8 neighbors are tank cells)
 * to skip boundary checks for ~80% of segments. This eliminates hundreds of
 * thousands of string allocations per frame at high speed with many organisms.
 */

import type { World, SimConfig } from '../../types';
import { VirusEffect } from '../../types';
import {
  VERLET_DAMPING,
  SEGMENT_CHAIN_DISTANCE,
  CHAIN_CONSTRAINT_ITERATIONS,
  SEGMENT_RADIUS,
  TANK_GRID_SPACING,
  COLLISION_PUSH_STRENGTH,
  ANGULAR_CONSTRAINT_STIFFNESS,
  BLUR_LAYER_COUNT,
  MAX_SEGMENTS,
  VIRUS_JOINT_WOBBLE,
} from '../../constants';
import {
  createSpatialHash,
  clearSpatialHash,
  insertIntoSpatialHash,
  querySpatialHash,
} from '../spatial-hash';
import { computeDamping } from '../environment';

const spatialHash = createSpatialHash();

// Module-level scratch buffers for angular constraints.
// Reused every frame to avoid garbage collection. MAX_SEGMENTS = 15.
const _incomingAngle = new Float64Array(MAX_SEGMENTS);
const _restX = new Float64Array(MAX_SEGMENTS);
const _restY = new Float64Array(MAX_SEGMENTS);

// Module-level reusable Map for depth layer lookups (avoids allocation per tick).
const _orgDepthLayer = new Map<number, number>();


// ─── Fast Numeric Tank Cell Lookup ──────────────────────────
// The original tankCells uses string keys like "3,-5". Creating template
// literal strings in the hot physics loop causes massive GC pressure.
// We maintain a shadow Set<number> with packed integer keys that is
// rebuilt only when tankCells changes (tankCellsDirty flag).
//
// Additionally, we track "interior" cells — cells where ALL 8 neighbors
// are also tank cells. Segments in interior cells can skip the entire
// Phase 2 boundary check, which eliminates ~80% of the work.

let _tankCellsFast: Set<number> | null = null;
let _interiorCells: Set<number> | null = null;
let _lastTankCellsSize = -1;

/** Pack col,row into a single integer key. Handles coords from -10000 to +10000. */
function packCellKey(col: number, row: number): number {
  return ((col + 10000) << 16) | ((row + 10000) & 0xFFFF);
}

/** Rebuild the fast numeric tank cell lookup from the string-based Set. */
function syncFastTankCells(world: World): void {
  // Skip if nothing changed
  if (_tankCellsFast && !world.tankCellsDirty && world.tankCells.size === _lastTankCellsSize) {
    return;
  }

  _tankCellsFast = new Set<number>();
  _interiorCells = new Set<number>();

  // Parse string keys once and build numeric set
  for (const key of world.tankCells) {
    const sep = key.indexOf(',');
    const col = Number(key.slice(0, sep));
    const row = Number(key.slice(sep + 1));
    _tankCellsFast.add(packCellKey(col, row));
  }

  // Identify interior cells (all 8 neighbors present → no boundary checks needed)
  for (const key of world.tankCells) {
    const sep = key.indexOf(',');
    const col = Number(key.slice(0, sep));
    const row = Number(key.slice(sep + 1));

    let isInterior = true;
    for (let dc = -1; dc <= 1 && isInterior; dc++) {
      for (let dr = -1; dr <= 1 && isInterior; dr++) {
        if (dc === 0 && dr === 0) continue;
        if (!_tankCellsFast.has(packCellKey(col + dc, row + dr))) {
          isInterior = false;
        }
      }
    }
    if (isInterior) {
      _interiorCells.add(packCellKey(col, row));
    }
  }

  _lastTankCellsSize = world.tankCells.size;

  // Mark as synced so we don't rebuild every tick if something left dirty=true
  // (tankCellsDirty is also used by world.ts syncTankCellsArray, which resets it,
  // but if that hasn't run yet, we still want to avoid redundant rebuilds)
  world.tankCellsDirty = false;
}

/** Fast numeric tank cell check — no string allocation. */
function hasTankCell(col: number, row: number): boolean {
  return _tankCellsFast!.has(packCellKey(col, row));
}

/** Check if a cell is interior (all 8 neighbors are tank cells). */
function isInteriorCell(col: number, row: number): boolean {
  return _interiorCells!.has(packCellKey(col, row));
}


/**
 * Verlet Integration — THE core physics update
 *
 * velocity = (currentPos - previousPos) * damping
 * newPos = currentPos + velocity
 *
 * Without any forces applied, organisms remain stationary.
 * Only yellow segment thrust (Phase 2) will create movement.
 */
export function integrateVerlet(world: World, config: SimConfig): void {
  const seg = world.segments;
  const count = world.segmentCount;
  const hasTempSources = world.temperatureSources.length > 0;
  const needsPerSegment = hasTempSources || config.baseViscosity !== 0.5;

  for (let i = 0; i < count; i++) {
    if (!seg.alive[i]) continue;

    // Per-segment damping from viscosity + temperature, or fast path
    const damping = needsPerSegment
      ? computeDamping(seg.x[i], seg.y[i], config.baseViscosity, world.temperatureSources)
      : VERLET_DAMPING;

    const vx = (seg.x[i] - seg.prevX[i]) * damping;
    const vy = (seg.y[i] - seg.prevY[i]) * damping;

    seg.prevX[i] = seg.x[i];
    seg.prevY[i] = seg.y[i];

    seg.x[i] += vx;
    seg.y[i] += vy;
  }
}


/**
 * Chain Constraints — Keep connected segments at the right distance
 *
 * TREE-AWARE: Instead of assuming segment i connects to i+1, each
 * non-root segment is constrained to its parent via parentOffset.
 *
 * Both pos AND prevPos are adjusted by the same amount so the correction
 * doesn't inject any velocity. This is the key to keeping organisms still.
 */
export function enforceChainConstraints(world: World): void {
  const seg = world.segments;

  for (const org of world.organisms.values()) {
    if (!org.alive) continue;

    // For each non-root segment, constrain it to its parent
    for (let i = 1; i < org.segmentCount; i++) {
      const b = org.firstSegment + i;
      if (!seg.alive[b]) continue;

      // Find parent via parentOffset
      const a = b + seg.parentOffset[b];
      if (!seg.alive[a]) continue;

      const dx = seg.x[b] - seg.x[a];
      const dy = seg.y[b] - seg.y[a];

      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 0.001) continue;

      let restDist = seg.restLength[b] || SEGMENT_CHAIN_DISTANCE;

      // Virus: JointWeakness wobble — only on segments matching strain's color affinity
      if (seg.virusStrainId[b] > 0) {
        const strainIdx = seg.virusStrainId[b] - 1;
        const strain = world.virusStrains.strains[strainIdx];
        if (strain?.alive
          && seg.color[b] === strain.colorAffinity
          && strain.effects.includes(VirusEffect.JointWeakness)) {
          restDist *= 1 + Math.sin(world.tick * 0.15 + b * 0.7) * VIRUS_JOINT_WOBBLE;
        }
      }

      const diff = (restDist - dist) / dist;
      const corrX = dx * diff * 0.5;
      const corrY = dy * diff * 0.5;

      // Move BOTH pos and prevPos — pure position correction, no velocity injection
      seg.x[a] -= corrX;
      seg.y[a] -= corrY;
      seg.prevX[a] -= corrX;
      seg.prevY[a] -= corrY;

      seg.x[b] += corrX;
      seg.y[b] += corrY;
      seg.prevX[b] += corrX;
      seg.prevY[b] += corrY;
    }
  }
}


/**
 * Angular Constraints — Make organisms hold their genetic shape
 *
 * TREE-AWARE: Computes the "rest shape" by walking the tree in topological
 * order (index order), building rest positions from the genome's parent
 * references and turn angles. Each segment is blended toward its rest position.
 *
 * The organism's current orientation comes from the root→first-child direction.
 * This means organisms can freely rotate as a whole, but internal angles
 * are rigidly maintained — including branch angles.
 *
 * CRITICAL: Both pos and prevPos are adjusted by the same delta.
 * This prevents the angular constraint from injecting rotational velocity.
 */
export function enforceAngularConstraints(world: World): void {
  const seg = world.segments;
  const stiffness = ANGULAR_CONSTRAINT_STIFFNESS;

  for (const org of world.organisms.values()) {
    if (!org.alive || org.segmentCount < 3) continue;

    const root = org.firstSegment;
    const topology = org.topology;

    // We need at least one child of root to compute orientation
    if (topology.children[0].length === 0) continue;

    // Organism orientation = direction from root to its first child
    const firstChildGeneIdx = topology.children[0][0];
    const firstChildGlobal = root + firstChildGeneIdx;

    if (!seg.alive[root] || !seg.alive[firstChildGlobal]) continue;

    const refDx = seg.x[firstChildGlobal] - seg.x[root];
    const refDy = seg.y[firstChildGlobal] - seg.y[root];
    const baseAngle = Math.atan2(refDy, refDx);

    // The reference angle is the actual root→firstChild direction.
    // The genome says firstChild's angle offset is genome[firstChildGeneIdx].angle.
    // So the "effective base" that makes firstChild land correctly is:
    //   effectiveBase + genome[firstChildGeneIdx].angle = baseAngle
    //   effectiveBase = baseAngle - genome[firstChildGeneIdx].angle
    const effectiveBase = baseAngle - org.genome[firstChildGeneIdx].angle;

    // Compute rest positions in topological order using scratch buffers
    _incomingAngle[0] = effectiveBase;
    _restX[0] = seg.x[root];
    _restY[0] = seg.y[root];

    for (let i = 1; i < org.segmentCount; i++) {
      const geneParent = org.genome[i].parent;
      const outAngle = _incomingAngle[geneParent] + org.genome[i].angle;
      _incomingAngle[i] = outAngle;

      const parentLen = org.genome[geneParent].length || 1;
      const childLen = org.genome[i].length || 1;
      const chainDist = SEGMENT_CHAIN_DISTANCE * Math.sqrt((parentLen + childLen) / 2);
      _restX[i] = _restX[geneParent] + Math.cos(outAngle) * chainDist;
      _restY[i] = _restY[geneParent] + Math.sin(outAngle) * chainDist;
    }

    // Apply corrections for all segments except root and the reference child
    // (the first child of root defines the reference direction — constraining it
    // would fight the reference computation)
    for (let i = 1; i < org.segmentCount; i++) {
      if (i === firstChildGeneIdx) continue; // reference child — skip

      const idx = root + i;
      if (!seg.alive[idx]) continue;

      const corrX = (_restX[i] - seg.x[idx]) * stiffness;
      const corrY = (_restY[i] - seg.y[idx]) * stiffness;

      // Apply to BOTH pos and prevPos — no velocity injection!
      seg.x[idx] += corrX;
      seg.y[idx] += corrY;
      seg.prevX[idx] += corrX;
      seg.prevY[idx] += corrY;
    }
  }
}


/**
 * Segment Collision — Push overlapping segments apart
 *
 * IMPORTANT RULES:
 * 1. Only organisms on the SAME depth layer can collide.
 * 2. Parent-child segments in the same organism skip collision (they're connected).
 *
 * TWO COLLISION MODES:
 * - INTRA-organism: Move both pos AND prevPos (pure position correction,
 *   no velocity injection — prevents phantom internal movement).
 * - INTER-organism: Move ONLY pos, NOT prevPos. This INJECTS VELOCITY
 *   into the colliding segments. On the next frame, verlet integration
 *   picks up this velocity and chain constraints propagate it to ALL
 *   segments of the organism — making the WHOLE organism push away,
 *   not just the colliding segment. This is what makes organisms bounce
 *   off each other like physical objects instead of passing through.
 *
 * TREE-AWARE adjacency: Uses parentOffset to detect parent-child relationships
 * instead of the old sequential index difference.
 */
export function resolveCollisions(world: World): void {
  const seg = world.segments;
  const count = world.segmentCount;
  const minDist = SEGMENT_RADIUS * 2;
  const minDistSq = minDist * minDist;

  // ── Pre-compute depth layer per organism (reuse module-level Map) ──
  _orgDepthLayer.clear();
  for (const org of world.organisms.values()) {
    if (!org.alive) continue;
    _orgDepthLayer.set(org.id, Math.min(
      BLUR_LAYER_COUNT - 1,
      Math.floor(org.depth * BLUR_LAYER_COUNT),
    ));
  }

  clearSpatialHash(spatialHash);
  for (let i = 0; i < count; i++) {
    if (seg.alive[i]) {
      insertIntoSpatialHash(spatialHash, i, seg.x[i], seg.y[i]);
    }
  }

  const qBuf = spatialHash.queryBuf;

  for (let i = 0; i < count; i++) {
    if (!seg.alive[i]) continue;

    const nearbyLen = querySpatialHash(spatialHash, seg.x[i], seg.y[i]);

    for (let n = 0; n < nearbyLen; n++) {
      const j = qBuf[n];

      if (j <= i || !seg.alive[j]) continue;

      const sameOrganism = seg.organismId[i] === seg.organismId[j];

      if (sameOrganism) {
        // Same organism: skip parent-child pairs (they're connected by chain constraint)
        const parentOfI = i + seg.parentOffset[i];
        const parentOfJ = j + seg.parentOffset[j];
        if (parentOfI === j || parentOfJ === i) continue;
      } else {
        // Different organisms: only collide if they're on the SAME depth layer
        const layerI = _orgDepthLayer.get(seg.organismId[i]);
        const layerJ = _orgDepthLayer.get(seg.organismId[j]);
        if (layerI !== layerJ) continue;
      }

      const dx = seg.x[j] - seg.x[i];
      const dy = seg.y[j] - seg.y[i];
      const distSq = dx * dx + dy * dy;

      if (distSq < minDistSq && distSq > 0.001) {
        const dist = Math.sqrt(distSq);
        const overlap = (minDist - dist) / dist;
        const pushX = dx * overlap * COLLISION_PUSH_STRENGTH;
        const pushY = dy * overlap * COLLISION_PUSH_STRENGTH;

        if (sameOrganism) {
          // INTRA-organism: pure position correction (no velocity injection).
          // Adjust BOTH pos and prevPos to avoid phantom internal movement.
          seg.x[i] -= pushX;
          seg.y[i] -= pushY;
          seg.prevX[i] -= pushX;
          seg.prevY[i] -= pushY;

          seg.x[j] += pushX;
          seg.y[j] += pushY;
          seg.prevX[j] += pushX;
          seg.prevY[j] += pushY;
        } else {
          // INTER-organism: VELOCITY INJECTION.
          // Only move pos — prevPos stays, creating velocity = (pos - prevPos).
          // This velocity is picked up by verlet integration next frame,
          // and chain constraints propagate it to ALL segments of the organism.
          // Result: whole organism pushes away from the collision, not just
          // the individual colliding segment.
          seg.x[i] -= pushX;
          seg.y[i] -= pushY;

          seg.x[j] += pushX;
          seg.y[j] += pushY;
        }
      }
    }
  }
}


/**
 * Tank Boundary Collision — Push segments into tank cells.
 *
 * The tank is defined by world.tankCells — a Set of habitable grid cells.
 * Any cell NOT in the set is boundary. This replaces both the old rounded-rectangle
 * tank boundary and the wall collision system.
 *
 * PERFORMANCE: Uses numeric packed keys (hasTankCell) instead of string template
 * literals, and skips Phase 2 entirely for segments in "interior" cells (where
 * all 8 neighbors are also tank cells). This is the biggest perf win because
 * this function is called 4× per tick on ALL segments.
 *
 * Two-phase approach:
 * Phase 1: If a segment center is in a non-tank cell, find the nearest
 *          tank cell edge in 4 cardinal directions and push the segment there.
 * Phase 2: For segments inside a BOUNDARY tank cell (not interior), push them
 *          away if their radius overlaps any neighboring non-tank cell.
 */
export function enforceTankBoundaryCollisions(world: World): void {
  const seg = world.segments;
  const count = world.segmentCount;
  const r = SEGMENT_RADIUS;
  const gs = TANK_GRID_SPACING;
  const maxSearch = 50; // Max cells to search in cardinal directions

  for (let i = 0; i < count; i++) {
    if (!seg.alive[i]) continue;

    const col = Math.floor(seg.x[i] / gs);
    const row = Math.floor(seg.y[i] / gs);

    if (!hasTankCell(col, row)) {
      // Phase 1: Segment center is OUTSIDE the tank — find nearest tank cell edge.
      let bestDist = Infinity;
      let bestX = seg.x[i];
      let bestY = seg.y[i];
      let bestNx = 0;
      let bestNy = 0;

      // Search left (decreasing col) for a tank cell
      for (let c = col - 1; c >= col - maxSearch; c--) {
        if (hasTankCell(c, row)) {
          // Right edge of tank cell c = (c+1)*gs. Push segment to just inside.
          const exitX = (c + 1) * gs - r;
          const dist = Math.abs(seg.x[i] - exitX);
          if (dist < bestDist) { bestDist = dist; bestX = exitX; bestY = seg.y[i]; bestNx = -1; bestNy = 0; }
          break;
        }
      }
      // Search right (increasing col)
      for (let c = col + 1; c <= col + maxSearch; c++) {
        if (hasTankCell(c, row)) {
          // Left edge of tank cell c = c*gs. Push segment to just inside.
          const exitX = c * gs + r;
          const dist = Math.abs(exitX - seg.x[i]);
          if (dist < bestDist) { bestDist = dist; bestX = exitX; bestY = seg.y[i]; bestNx = 1; bestNy = 0; }
          break;
        }
      }
      // Search up (decreasing row)
      for (let rr = row - 1; rr >= row - maxSearch; rr--) {
        if (hasTankCell(col, rr)) {
          const exitY = (rr + 1) * gs - r;
          const dist = Math.abs(seg.y[i] - exitY);
          if (dist < bestDist) { bestDist = dist; bestX = seg.x[i]; bestY = exitY; bestNx = 0; bestNy = -1; }
          break;
        }
      }
      // Search down (increasing row)
      for (let rr = row + 1; rr <= row + maxSearch; rr++) {
        if (hasTankCell(col, rr)) {
          const exitY = rr * gs + r;
          const dist = Math.abs(exitY - seg.y[i]);
          if (dist < bestDist) { bestDist = dist; bestX = seg.x[i]; bestY = exitY; bestNx = 0; bestNy = 1; }
          break;
        }
      }

      if (bestDist < Infinity) {
        const shiftX = bestX - seg.x[i];
        const shiftY = bestY - seg.y[i];

        seg.x[i] = bestX;
        seg.y[i] = bestY;
        seg.prevX[i] += shiftX;
        seg.prevY[i] += shiftY;

        // Zero velocity pointing away from the tank cell
        const velX = seg.x[i] - seg.prevX[i];
        const velY = seg.y[i] - seg.prevY[i];
        const velDot = velX * (-bestNx) + velY * (-bestNy);
        if (velDot > 0) {
          seg.prevX[i] = seg.x[i] - (velX - velDot * (-bestNx));
          seg.prevY[i] = seg.y[i] - (velY - velDot * (-bestNy));
        }
      }
    } else if (!isInteriorCell(col, row)) {
      // Phase 2: Segment center is inside a BOUNDARY tank cell — check if radius
      // overlaps any neighboring non-tank cell. Check 3x3 neighborhood.
      // Interior cells (all 8 neighbors are tank cells) skip this entirely.
      for (let dc = -1; dc <= 1; dc++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (hasTankCell(col + dc, row + dr)) continue; // Skip tank cells

          // This neighbor is NOT a tank cell — push segment away from it
          const nc = col + dc;
          const nr = row + dr;
          const cellLeft = nc * gs;
          const cellTop = nr * gs;
          const cellRight = cellLeft + gs;
          const cellBottom = cellTop + gs;

          const nearX = Math.max(cellLeft, Math.min(seg.x[i], cellRight));
          const nearY = Math.max(cellTop, Math.min(seg.y[i], cellBottom));

          const dx = seg.x[i] - nearX;
          const dy = seg.y[i] - nearY;
          const distSq = dx * dx + dy * dy;

          if (distSq >= r * r || distSq < 0.001) continue;

          const dist = Math.sqrt(distSq);
          const nx = dx / dist;
          const ny = dy / dist;
          const penetration = r - dist;

          const shiftX = nx * penetration;
          const shiftY = ny * penetration;

          seg.x[i] += shiftX;
          seg.y[i] += shiftY;
          seg.prevX[i] += shiftX;
          seg.prevY[i] += shiftY;

          const velX = seg.x[i] - seg.prevX[i];
          const velY = seg.y[i] - seg.prevY[i];
          const velDot = velX * (-nx) + velY * (-ny);
          if (velDot > 0) {
            seg.prevX[i] = seg.x[i] - (velX - velDot * (-nx));
            seg.prevY[i] = seg.y[i] - (velY - velDot * (-ny));
          }
        }
      }
    }
    // else: Interior cell — no boundary check needed, segment is fully surrounded
  }
}


/**
 * Run all constraint systems in the correct order.
 *
 * 1. Verlet integration (apply existing velocity)
 * 2. Iterative solve (distance + angular constraints converge together)
 * 3. Collisions (separate overlapping segments)
 * 4. Dish boundary (keep in bounds)
 * 5. Wall collisions (keep out of walled grid cells)
 */
export function runConstraints(world: World, config: SimConfig): void {
  // Sync fast numeric tank cell lookup (only rebuilds when dirty)
  syncFastTankCells(world);

  integrateVerlet(world, config);

  for (let iter = 0; iter < CHAIN_CONSTRAINT_ITERATIONS; iter++) {
    enforceChainConstraints(world);
    enforceAngularConstraints(world);
    // Hard boundaries inside every iteration — prevents chain/angular
    // constraints from pulling segments back through tank cell boundaries
    enforceTankBoundaryCollisions(world);
  }

  resolveCollisions(world);

  // Final hard boundary pass after collisions push segments around
  enforceTankBoundaryCollisions(world);
}
