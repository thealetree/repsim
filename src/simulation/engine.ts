/**
 * engine.ts — Simulation engine with fixed timestep
 *
 * The simulation runs at a FIXED rate (20 ticks per second) regardless of
 * how fast the screen renders. This is critical because:
 *
 * 1. Physics are deterministic — same input = same output, always
 * 2. Slow computers don't see slow-motion (they just render fewer frames)
 * 3. Fast computers don't see sped-up simulation (they interpolate between ticks)
 *
 * How fixed timestep works:
 * - Each frame, add real elapsed time to an "accumulator"
 * - While accumulator >= tick duration (50ms), run one sim tick and subtract
 * - The leftover in the accumulator = how far between ticks we are (alpha)
 * - Renderer can use alpha to interpolate positions for smooth display
 */

import type { World, SimConfig } from '../types';
import { SIM_DT, DEFAULT_CONFIG, CHART_SAMPLE_INTERVAL } from '../constants';
import { createWorld, seedPopulation, removeOrganism } from './world';
import { createVirusStrainPool } from './virus';
import { runConstraints } from './systems/constraints';
import { runBehaviors } from './systems/behaviors';
import type { EventBus } from '../events';


// ─── Engine Interface ────────────────────────────────────────

export interface SimulationEngine {
  /** The current world state — renderer reads this to draw */
  world: World;

  /** Simulation configuration (mutation rates, population limits, etc.) */
  config: SimConfig;

  /** Is the simulation paused? */
  paused: boolean;

  /** Speed multiplier (1 = normal, 2 = double, 4 = quadruple) */
  speed: number;

  /** Time accumulator for fixed timestep (internal) */
  accumulator: number;

  /** Advance simulation by the given real-time delta (in seconds) */
  update(deltaSeconds: number): void;

  /** Get interpolation alpha (0-1) for smooth rendering between ticks */
  getAlpha(): number;

  /** Pause or unpause the simulation */
  setPaused(paused: boolean): void;

  /** Set simulation speed multiplier */
  setSpeed(speed: number): void;

  /** Reset the simulation with a fresh world */
  reset(): void;

  /** Flush all organisms from the tank, keeping tank shape, lights, temps, config */
  flush(): void;
}


// ─── Engine Creation ─────────────────────────────────────────

/**
 * Create a new simulation engine.
 * This initializes the world, seeds the starting population, and returns
 * an engine object with update/pause/reset methods.
 */
export function createSimulationEngine(
  events: EventBus,
  config: SimConfig = DEFAULT_CONFIG,
): SimulationEngine {
  // Create and populate the world
  const world = createWorld(config);
  seedPopulation(world, config);

  const engine: SimulationEngine = {
    world,
    config,
    paused: false,
    speed: 1,
    accumulator: 0,

    /**
     * Called every frame with the real time elapsed since last frame.
     * Runs as many fixed-rate simulation ticks as fit within a per-frame
     * time budget, then defers the rest to the next frame via the accumulator.
     *
     * Why a time budget instead of a tick count cap?
     * At high speeds (4x/8x) with large populations, each tick can be
     * expensive (8-12ms). A fixed tick cap means "run N expensive ticks,
     * which may take 80-100ms" — the long frame causes the next frame's
     * delta to spike, which fills the accumulator, which causes another
     * long frame — a pulsing stutter at high population.
     *
     * With a time budget, we stop the tick batch when wall-clock time
     * exceeds ~13ms. Remaining accumulator carries to the next frame,
     * gracefully reducing effective speed (7x, 6x…) rather than
     * oscillating between 8x and 3x. No ticks are ever dropped.
     */
    update(deltaSeconds: number): void {
      if (engine.paused) return;

      // Clamp delta to prevent "spiral of death" (e.g. tab was backgrounded)
      const clampedDelta = Math.min(deltaSeconds, 0.1);
      engine.accumulator += clampedDelta * engine.speed;

      // Per-frame time budget: ~13ms leaves ~4ms headroom for rendering
      // within a 16.67ms (60fps) frame. Absolute tick-count ceiling of 12
      // is kept as a hard safety rail in case performance.now() is coarse.
      const TICK_BUDGET_MS = 13;
      const budgetStart = performance.now();

      // Snapshot render-interpolation positions ONCE per frame, before the tick
      // batch, so interpolation lerps from "start of frame" to "after all ticks."
      // Snapshotting inside the loop causes a mismatch at high speeds (8x): renderPrev
      // ends up only one tick behind x/y, but alpha spans the whole frame's accumulator,
      // making organisms appear as scattered individual segments.
      if (engine.accumulator >= SIM_DT) {
        const seg = engine.world.segments;
        const snapCount = engine.world.segmentCount;
        seg.renderPrevX.set(seg.x.subarray(0, snapCount));
        seg.renderPrevY.set(seg.y.subarray(0, snapCount));
      }

      let ticksThisFrame = 0;
      while (engine.accumulator >= SIM_DT && ticksThisFrame < 12) {
        tickSimulation(engine.world, engine.config, events);
        engine.accumulator -= SIM_DT;
        ticksThisFrame++;
        // Stop if we've exhausted the per-frame budget.
        // The remaining accumulator carries to the next frame so
        // no simulation work is lost — it's just spread across frames.
        if (performance.now() - budgetStart >= TICK_BUDGET_MS) break;
      }
    },

    /**
     * Returns how far we are between the last tick and the next one.
     * 0 = just ticked, 1 = about to tick.
     * The renderer can use this to interpolate positions for smoother visuals.
     */
    getAlpha(): number {
      return engine.accumulator / SIM_DT;
    },

    /** Pause or unpause */
    setPaused(paused: boolean): void {
      engine.paused = paused;
      events.emit('sim:paused', { paused });
    },

    /** Set speed multiplier (1, 2, 4, or 8) */
    setSpeed(speed: number): void {
      engine.speed = speed;
      // Clamp accumulator so downshifting feels instant (no backlog from old speed)
      if (engine.accumulator > SIM_DT) {
        engine.accumulator = SIM_DT;
      }
    },

    /** Reset the entire simulation from scratch */
    reset(): void {
      const newWorld = createWorld(engine.config);
      seedPopulation(newWorld, engine.config);
      engine.world = newWorld;
      engine.accumulator = 0;
      events.emit('sim:reset', undefined);
    },

    /** Flush all organisms — keep tank, lights, temps, config; reseed fresh population */
    flush(): void {
      const w = engine.world;
      // Kill all alive organisms (removeOrganism now deletes from Map, so collect IDs first)
      const idsToRemove: number[] = [];
      for (const [id, org] of w.organisms) {
        if (org.alive) idsToRemove.push(id);
      }
      for (const id of idsToRemove) {
        removeOrganism(w, id);
      }
      w.organisms.clear(); // Ensure no stale dead entries remain

      // Reset food particles properly (count + alive flags + free slots)
      const food = w.food;
      food.count = 0;
      food.alive.fill(0);
      food.freeSlots.length = 0;
      for (let i = food.x.length - 1; i >= 0; i--) {
        food.freeSlots.push(i);
      }

      // Reset virus strain pool properly (rebuild pool + free slots)
      w.virusStrains = createVirusStrainPool();

      // Reset segment allocation state
      w.freeSegmentSlots.length = 0;
      w.segmentCount = 0;

      // Reset stats (keep tick running)
      w.stats.population = 0;
      w.stats.births = 0;
      w.stats.deaths = 0;
      // Reseed population (force tankCellsArray refresh for custom tank shapes)
      w.tankCellsDirty = true;
      seedPopulation(w, engine.config);
      events.emit('sim:reset', undefined);
    },
  };

  return engine;
}


// ─── Tick Logic ──────────────────────────────────────────────

/**
 * Run one simulation tick — this is where ALL game logic happens.
 *
 * Tick order:
 * 1. Behaviors (photosynthesis, drain, movement, combat, death)
 * 2. Physics (verlet integration picks up movement impulses, then constraints)
 * 3. Events (notify UI/renderer of changes)
 *
 * Behaviors run BEFORE physics so that yellow movement impulses get
 * picked up by verlet integration in the same frame.
 */
function tickSimulation(world: World, config: SimConfig, events: EventBus): void {
  world.tick++;

  // ── Behaviors ──
  // Photosynthesis, root drain, replenishment, yellow movement,
  // red attack, health checks, timed death
  runBehaviors(world, config);

  // ── Physics ──
  // Verlet integration (applies yellow impulses), chain constraints,
  // angular constraints, collision resolution, dish boundary
  runConstraints(world, config);

  // ── Emit events ──
  // Stats update fires every 20 ticks (~1 second) to avoid flooding the event bus
  if (world.tick % 20 === 0) {
    events.emit('stats:updated', {
      population: world.stats.population,
      births: world.stats.births,
      deaths: world.stats.deaths,
      tick: world.tick,
    });
  }

  // Chart data sampling (every CHART_SAMPLE_INTERVAL ticks)
  if (world.tick % CHART_SAMPLE_INTERVAL === 0) {
    events.emit('chart:sample', { tick: world.tick });
  }
}
