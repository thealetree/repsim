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
  SEGMENT_RADIUS,
  SEGMENT_PILL_LENGTH,
  SEGMENT_PILL_WIDTH,
  TANK_GRID_SPACING,
  COLLISION_PUSH_STRENGTH,
  VIRUS_JOINT_WOBBLE,
  PARALLAX_BOUNDARY_MARGIN,
} from '../../constants';
import {
  createSpatialHash,
  clearSpatialHash,
  insertIntoSpatialHash,
  querySpatialHash,
} from '../spatial-hash';
import { computeDamping, computeCurrentForce } from '../environment';
import { _orgDepthLayer } from './behaviors';

const spatialHash = createSpatialHash();



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
      const distSq = dx * dx + dy * dy;
      if (distSq < 0.000001) continue; // same as dist < 0.001

      let restDist = seg.restLength[b] || SEGMENT_CHAIN_DISTANCE;

      // Virus: JointWeakness wobble — only on segments matching strain's color affinity
      if (seg.virusStrainId[b] > 0) {
        const strainIdx = seg.virusStrainId[b] - 1;
        const strain = world.virusStrains.strains[strainIdx];
        if (strain?.alive
          && seg.color[b] === strain.colorAffinity
          && (strain.effectsMask & (1 << VirusEffect.JointWeakness)) !== 0) {
          restDist *= 1 + Math.sin(world.tick * 0.15 + b * 0.7) * VIRUS_JOINT_WOBBLE;
        }
      }

      // Skip sqrt when segment is already near rest distance (correction < ~1%)
      const restDistSq = restDist * restDist;
      if (Math.abs(distSq - restDistSq) < 0.0002 * restDistSq) continue;

      const dist = Math.sqrt(distSq);
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
 * Rigid Body Snap — Place all non-root segments at their exact rest positions.
 *
 * Organisms are treated as rigid bodies: the genome defines a fixed shape,
 * and all segments are hard-set to that shape relative to the root every tick.
 * This eliminates all spring-based angular tension and oscillation — angles
 * are pure geometry, not physics forces.
 *
 * Non-root segments inherit the root's velocity (prevPos = pos - rootVelocity)
 * so they drift with the root rather than oscillating relative to it.
 *
 * Orientation (orientationAngle) is the only rotational degree of freedom.
 * It is updated from the first child's post-snap direction each tick.
 * Brownian rotation nudges it directly; yellow thrust drives translation of root.
 */
export function enforceAngularConstraints(world: World): void {
  const seg = world.segments;

  for (const org of world.organisms.values()) {
    if (!org.alive || org.segmentCount < 2) continue;

    const root = org.firstSegment;
    const topology = org.topology;

    if (topology.children[0].length === 0) continue;

    const firstChildGeneIdx = topology.children[0][0];
    const firstChildGlobal = root + firstChildGeneIdx;

    if (!seg.alive[root] || !seg.alive[firstChildGlobal]) continue;

    // effectiveBase = orientationAngle directly so every genome[i].angle contributes
    // to its segment's world position without the firstChild angle cancelling itself out.
    const effectiveBase = org.orientationAngle;
    const cosBase = Math.cos(effectiveBase);
    const sinBase = Math.sin(effectiveBase);

    // Root's current velocity — all non-root segments inherit this so the
    // whole body drifts together with zero relative motion between segments.
    const rootVx = seg.x[root] - seg.prevX[root];
    const rootVy = seg.y[root] - seg.prevY[root];

    // Hard-set each segment to its exact rest position (topological order:
    // parent is already placed when child is processed).
    for (let i = 1; i < org.segmentCount; i++) {
      const idx = root + i;
      if (!seg.alive[idx]) continue;

      const geneParent = org.genome[i].parent;
      const parentIdx = root + geneParent;

      if (!seg.alive[parentIdx]) continue; // Orphan guard: parent dead → skip (behaviors.ts will kill this segment)

      const cosAngle = cosBase * topology.cosCumAngle[i] - sinBase * topology.sinCumAngle[i];
      const sinAngle = sinBase * topology.cosCumAngle[i] + cosBase * topology.sinCumAngle[i];

      // Cap-focus snap: child's back cap focus meets the parent's front cap focus.
      //
      // Pills are rendered with non-uniform scaling: length scales at 1× per lengthMult,
      // width scales at 0.35× per extra lengthMult (widthMult = 1 + (len-1)*0.35).
      // The cap radius in world space = (SEGMENT_PILL_WIDTH/2) * widthMult.
      // The cap focus (center of the arc) from segment center = (SEGMENT_PILL_LENGTH/2)*len - (SEGMENT_PILL_WIDTH/2)*widthMult.
      const cosParentAngle = cosBase * topology.cosCumAngle[geneParent] - sinBase * topology.sinCumAngle[geneParent];
      const sinParentAngle = sinBase * topology.cosCumAngle[geneParent] + cosBase * topology.sinCumAngle[geneParent];
      const parentLen = org.genome[geneParent].length;
      const childLen  = org.genome[i].length;
      const parentWidthMult = 1 + (parentLen - 1) * 0.35;
      const childWidthMult  = 1 + (childLen  - 1) * 0.35;
      const HALF_LEN = SEGMENT_PILL_LENGTH * 0.5;
      const HALF_WID = SEGMENT_PILL_WIDTH  * 0.5;
      const parentCapFocus = HALF_LEN * parentLen - HALF_WID * parentWidthMult;
      const childCapFocus  = HALF_LEN * childLen  - HALF_WID * childWidthMult;
      const restX = seg.x[parentIdx]
        + cosParentAngle * parentCapFocus
        + cosAngle       * childCapFocus;
      const restY = seg.y[parentIdx]
        + sinParentAngle * parentCapFocus
        + sinAngle       * childCapFocus;

      // Teleport to rest position; set prevPos so velocity = root velocity.
      // This makes segments move with the root instead of oscillating relative to it.
      seg.x[idx] = restX;
      seg.y[idx] = restY;
      seg.prevX[idx] = restX - rootVx;
      seg.prevY[idx] = restY - rootVy;
    }

    // orientationAngle is updated only by Brownian + velocity steering — no readback needed.
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
  // Depth layers already computed at start of runBehaviors via computeDepthLayers()

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

      // Intra-organism: rigid snap handles all internal geometry — no collision needed.
      if (sameOrganism) continue;

      // Different organisms: only collide if they're on the SAME depth layer
      const layerI = _orgDepthLayer.get(seg.organismId[i]);
      const layerJ = _orgDepthLayer.get(seg.organismId[j]);
      if (layerI !== layerJ) continue;

      const dx = seg.x[j] - seg.x[i];
      const dy = seg.y[j] - seg.y[i];
      const distSq = dx * dx + dy * dy;

      if (distSq < minDistSq && distSq > 0.001) {
        const dist = Math.sqrt(distSq);
        const overlap = (minDist - dist) / dist;
        const pushX = dx * overlap * COLLISION_PUSH_STRENGTH;
        const pushY = dy * overlap * COLLISION_PUSH_STRENGTH;

        // INTER-organism: Redirect impulses to roots.
        // The rigid snap erases any impulse applied to a non-root segment on the
        // same tick. Applying the push to roots means the whole organism bounces.
        const rI = world.organisms.get(seg.organismId[i])!.firstSegment;
        const rJ = world.organisms.get(seg.organismId[j])!.firstSegment;

        seg.x[rI] -= pushX;
        seg.y[rI] -= pushY;
        seg.x[rJ] += pushX;
        seg.y[rJ] += pushY;

        // Tangential velocity kicks to add variety to collision response
        const tangentScale = 0.3;
        const tanX = -pushY * tangentScale;
        const tanY = pushX * tangentScale;
        seg.prevX[rI] += tanX;
        seg.prevY[rI] += tanY;
        seg.prevX[rJ] -= tanX;
        seg.prevY[rJ] -= tanY;

        // (Collision torque removed — was causing violent spinning via underdamped accumulator)
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
  const baseR = SEGMENT_RADIUS;
  const gs = TANK_GRID_SPACING;
  const maxSearch = 50; // Max cells to search in cardinal directions
  // Segments at extreme depths get a larger effective collision radius so
  // they stay further from tank edges, preventing parallax-shifted sprites
  // from visually poking outside the tank.
  const parallaxMargin = PARALLAX_BOUNDARY_MARGIN;

  for (let i = 0; i < count; i++) {
    if (!seg.alive[i]) continue;
    // Skip non-root segments — their positions are determined by the rigid snap
    // relative to their root. Pushing non-root independently creates snap-boundary
    // oscillation: snap puts them back, boundary pushes them out, every tick.
    // Root-only boundary ensures the whole organism moves away from walls correctly.
    if (seg.parentOffset[i] !== 0) continue;
    // Depth-based extra margin: |depth - 0.5| * 2 → 0 at mid, 1 at extremes
    const depthExtremity = Math.abs(seg.segmentDepth[i] - 0.5) * 2;
    const r = baseR + depthExtremity * parallaxMargin;

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

        // (Wall torque removed — was causing violent spinning via underdamped accumulator)
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
/**
 * Apply current source forces to all alive segments.
 * Injects velocity by shifting prevPos backward (same as yellow thrust).
 * Called after Verlet integration so force adds to existing velocity.
 */
function applyCurrentForces(world: World): void {
  if (world.currentSources.length === 0) return;
  const seg = world.segments;
  const count = world.segmentCount;

  for (let i = 0; i < count; i++) {
    if (!seg.alive[i]) continue;
    const { fx, fy } = computeCurrentForce(
      seg.x[i], seg.y[i], world.currentSources,
    );
    if (fx !== 0 || fy !== 0) {
      seg.prevX[i] -= fx;
      seg.prevY[i] -= fy;
    }
  }
}


// ─── Angular Velocity Constants ──────────────────────────────────────────────
// Each organism has an angularVelocity (rad/tick) that decays each tick and is
// injected by physics events: wall bounces, collisions, and Brownian noise.
const ANGULAR_DAMPING        = 0.85;   // Per-tick decay — stronger to kill oscillation quickly
const BROWNIAN_ANGULAR_KICK  = 0.015;  // Max random angular impulse per tick (gentler ambient wobble)
const STEERING_DIRECT_GAIN   = 0.04;   // Direct orientationAngle nudge toward velocity (first-order, no oscillation)


/**
 * Brownian Rotation — Kick angularVelocity with random thermal noise.
 * Accumulated angular velocity decays via ANGULAR_DAMPING, giving natural
 * drift without locked orientations.
 */
export function applyBrownianRotation(world: World): void {
  for (const org of world.organisms.values()) {
    if (!org.alive) continue;
    org.angularVelocity += (Math.random() - 0.5) * 2 * BROWNIAN_ANGULAR_KICK;
  }
}


/**
 * Velocity Steering — nudge angularVelocity toward root's direction of travel.
 * Organisms gradually face where they're going (wall bounces, currents, thrust).
 */
function applyVelocitySteering(world: World): void {
  const seg = world.segments;

  for (const org of world.organisms.values()) {
    if (!org.alive) continue;

    const root = org.firstSegment;
    if (!seg.alive[root]) continue;

    const vx = seg.x[root] - seg.prevX[root];
    const vy = seg.y[root] - seg.prevY[root];

    if (vx * vx + vy * vy < 0.0004) continue; // Not moving meaningfully — skip

    // Shortest angular delta, normalized to [-π, π]
    let delta = Math.atan2(vy, vx) - org.orientationAngle;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    else if (delta < -Math.PI) delta += 2 * Math.PI;

    org.orientationAngle += delta * STEERING_DIRECT_GAIN; // Direct nudge — bypasses accumulator, no oscillation
  }
}


/**
 * Angular Velocity Integration — apply damping then integrate into orientationAngle.
 * Called once per tick after Brownian + steering have kicked angularVelocity.
 */
function integrateAngularVelocity(world: World): void {
  for (const org of world.organisms.values()) {
    if (!org.alive) continue;
    org.angularVelocity *= ANGULAR_DAMPING;
    org.orientationAngle += org.angularVelocity;
  }
}


export function runConstraints(world: World, config: SimConfig): void {
  // Sync fast numeric tank cell lookup (only rebuilds when dirty)
  syncFastTankCells(world);

  integrateVerlet(world, config);
  applyCurrentForces(world);
  applyBrownianRotation(world);       // Kick angularVelocity with thermal noise
  applyVelocitySteering(world);       // Directly nudge orientationAngle toward direction of travel
  integrateAngularVelocity(world);    // Damp + apply angularVelocity → orientationAngle

  // 1. Settle roots against walls.
  enforceTankBoundaryCollisions(world);

  // 2. Rigid body snap — place all non-root segments at exact rest positions.
  enforceAngularConstraints(world);

  // 3. Inter-organism collision — impulses redirected to roots.
  resolveCollisions(world);

  // 4. Re-snap after roots moved by collision impulses.
  enforceAngularConstraints(world);

  // 5. Final boundary — clamp roots pushed outside by collisions.
  enforceTankBoundaryCollisions(world);

  // 6. Re-snap so non-root prevX is anchored to root's boundary-corrected position.
  enforceAngularConstraints(world);
}
