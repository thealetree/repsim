/**
 * events.ts — Typed event bus for communication between systems
 *
 * The simulation, renderer, and UI are completely decoupled.
 * They communicate through this event bus:
 *
 *   Simulation → EventBus → UI (update stats display)
 *   Simulation → EventBus → Renderer (flash effects on death)
 *   Input → EventBus → Simulation (player clicks organism)
 *
 * This pattern means we can change the UI without touching simulation code,
 * or swap renderers without breaking anything.
 */

// ─── Event Type Definitions ──────────────────────────────────
// Every event has a name (string key) and a payload shape (the data it carries).

export interface EventMap {
  // Organism lifecycle
  'organism:born': { id: number; parentId: number; generation: number };
  'organism:died': { id: number; x: number; y: number; segmentCount: number };
  'organism:selected': { id: number | null };  // null = deselected

  // Population stats updates
  'stats:updated': { population: number; births: number; deaths: number; tick: number };

  // Simulation control
  'sim:paused': { paused: boolean };
  'sim:reset': undefined;
  'sim:tick': { tick: number };

  // Tool mode
  'tool:changed': { mode: number };

  // Environment source selection
  'source:selected': { type: 'light' | 'temperature' | 'current' | null; id: number | null };

  // Virus events
  'virus:outbreak': { strainId: number; colorAffinity: number };
  'virus:strain_extinct': { strainId: number };

  // Chart data sampling
  'chart:sample': { tick: number };
}

// The event names are the keys of EventMap
type EventName = keyof EventMap;

// A listener is a function that receives the event payload
type Listener<T> = (data: T) => void;


// ─── EventBus Interface ──────────────────────────────────────

/**
 * EventBus — publish/subscribe message system
 *
 * Usage:
 *   const bus = createEventBus();
 *   bus.on('organism:born', (data) => console.log(`Born: ${data.id}`));
 *   bus.emit('organism:born', { id: 1, parentId: -1, generation: 0 });
 */
export interface EventBus {
  /** Subscribe to an event — your function gets called whenever this event fires */
  on<K extends EventName>(event: K, listener: Listener<EventMap[K]>): void;

  /** Unsubscribe from an event — stop receiving notifications */
  off<K extends EventName>(event: K, listener: Listener<EventMap[K]>): void;

  /** Fire an event — calls all registered listeners with the provided data */
  emit<K extends EventName>(event: K, data: EventMap[K]): void;
}


// ─── EventBus Implementation ─────────────────────────────────

export function createEventBus(): EventBus {
  // Map of event name → set of listener functions
  // Using Map<string, Set> for O(1) add/remove
  const listeners = new Map<string, Set<Listener<unknown>>>();

  return {
    on<K extends EventName>(event: K, listener: Listener<EventMap[K]>): void {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(listener as Listener<unknown>);
    },

    off<K extends EventName>(event: K, listener: Listener<EventMap[K]>): void {
      listeners.get(event)?.delete(listener as Listener<unknown>);
    },

    emit<K extends EventName>(event: K, data: EventMap[K]): void {
      const set = listeners.get(event);
      if (set && set.size > 0) {
        // Iterate Set directly — safe because listeners don't self-remove during emit.
        // Avoids array spread allocation on every emit call.
        for (const fn of set) {
          fn(data);
        }
      }
    },
  };
}
