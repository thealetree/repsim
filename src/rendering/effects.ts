/**
 * effects.ts — Lightweight birth/death/pulse animations
 *
 * All animation state is plain numbers in arrays — no object allocation per frame.
 * The renderer calls update() each frame and queries for visual modifiers.
 */

import type { GhostSegmentData } from '../simulation/world';

// ─── Timing constants ────────────────────────────────────────
const BIRTH_DURATION = 0.35;      // seconds to scale up
const GHOST_DELAY_MAX = 0.2;      // max random delay before shrink starts
const GHOST_SHRINK_MIN = 0.2;     // min shrink duration
const GHOST_SHRINK_MAX = 0.5;     // max shrink duration
const GHOST_MAX_LIFE = 0.9;       // max total ghost lifetime
const GHOST_DRIFT = 25;           // world units per second outward drift
const PULSE_DURATION = 0.45;      // seconds for pulse ring
const PULSE_MAX_RADIUS = 50;      // max radius of pulse ring

// ─── Ghost segment (death animation) ────────────────────────
interface Ghost {
  x: number;
  y: number;
  color: number;
  depth: number;
  driftX: number;
  driftY: number;
  delay: number;
  shrinkDur: number;
}

interface GhostGroup {
  ghosts: Ghost[];
  startTime: number;
}

// ─── Pulse ring ──────────────────────────────────────────────
interface Pulse {
  x: number;
  y: number;
  startTime: number;
  isBirth: boolean;
}

// ─── Renderable output (reused array to avoid GC) ───────────
export interface RenderableGhost {
  x: number;
  y: number;
  color: number;
  depth: number;
  scale: number;
}

export interface RenderablePulse {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  isBirth: boolean;
}

// ─── Effects interface ───────────────────────────────────────
export interface Effects {
  addBirth(orgId: number, x: number, y: number): void;
  addDeath(segments: GhostSegmentData[], cx: number, cy: number): void;
  getBirthScale(orgId: number, now: number): number;
  update(now: number, ghostOut: RenderableGhost[], pulseOut: RenderablePulse[]): void;
}

export function createEffects(): Effects {
  const births = new Map<number, number>(); // orgId → startTime
  const ghostGroups: GhostGroup[] = [];
  const pulses: Pulse[] = [];

  return {
    addBirth(orgId: number, x: number, y: number): void {
      const now = performance.now() / 1000;
      births.set(orgId, now);
      pulses.push({ x, y, startTime: now, isBirth: true });
    },

    addDeath(segments: GhostSegmentData[], cx: number, cy: number): void {
      const now = performance.now() / 1000;
      const ghosts: Ghost[] = [];
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        const dx = s.x - cx;
        const dy = s.y - cy;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        ghosts.push({
          x: s.x, y: s.y,
          color: s.color, depth: s.depth,
          driftX: (dx / len) * GHOST_DRIFT,
          driftY: (dy / len) * GHOST_DRIFT,
          delay: Math.random() * GHOST_DELAY_MAX,
          shrinkDur: GHOST_SHRINK_MIN + Math.random() * (GHOST_SHRINK_MAX - GHOST_SHRINK_MIN),
        });
      }
      ghostGroups.push({ ghosts, startTime: now });
      pulses.push({ x: cx, y: cy, startTime: now, isBirth: false });
    },

    getBirthScale(orgId: number, now: number): number {
      const start = births.get(orgId);
      if (start === undefined) return 1;
      const t = (now - start) / BIRTH_DURATION;
      if (t >= 1) {
        births.delete(orgId);
        return 1;
      }
      // Ease-out cubic: fast start, smooth finish
      return 1 - (1 - t) * (1 - t) * (1 - t);
    },

    update(now: number, ghostOut: RenderableGhost[], pulseOut: RenderablePulse[]): void {
      ghostOut.length = 0;
      pulseOut.length = 0;

      // Process ghost groups
      for (let g = ghostGroups.length - 1; g >= 0; g--) {
        const group = ghostGroups[g];
        const elapsed = now - group.startTime;

        if (elapsed > GHOST_MAX_LIFE) {
          ghostGroups.splice(g, 1);
          continue;
        }

        for (let i = 0; i < group.ghosts.length; i++) {
          const gh = group.ghosts[i];
          if (elapsed < gh.delay) {
            // Still waiting — render at full size
            ghostOut.push({ x: gh.x, y: gh.y, color: gh.color, depth: gh.depth, scale: 1 });
          } else {
            const shrinkT = elapsed - gh.delay;
            if (shrinkT >= gh.shrinkDur) continue; // fully gone
            const t = shrinkT / gh.shrinkDur;
            const scale = (1 - t) * (1 - t); // ease-in quadratic
            ghostOut.push({
              x: gh.x + gh.driftX * shrinkT,
              y: gh.y + gh.driftY * shrinkT,
              color: gh.color,
              depth: gh.depth,
              scale,
            });
          }
        }
      }

      // Process pulses
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i];
        const t = (now - p.startTime) / PULSE_DURATION;
        if (t >= 1) {
          pulses.splice(i, 1);
          continue;
        }
        pulseOut.push({
          x: p.x,
          y: p.y,
          radius: t * PULSE_MAX_RADIUS,
          alpha: (1 - t) * 0.5,
          isBirth: p.isBirth,
        });
      }

      // Clean expired births
      for (const [orgId, start] of births) {
        if (now - start > BIRTH_DURATION) births.delete(orgId);
      }
    },
  };
}
