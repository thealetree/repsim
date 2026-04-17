/**
 * field-notes.ts — Ambient observation stream
 *
 * Surfaces a slow drip of notable things happening in the sim (population
 * booms, species convergence, first sexual repro, virus outbreaks, etc.)
 * as plain-language notes in a small pill at top-center. Click the pill to
 * open a scrollable history of past notes.
 *
 * Everything is rule-based and read from the existing event bus — no LLM,
 * no API, no backend. Rules are pure functions of rolling sim state.
 *
 * Why this exists: the scenarios + tutorial explain the *rules* of Repsim,
 * but the dynamics (what's beautiful about watching a population evolve)
 * stay invisible unless someone already knows what to look for. Field Notes
 * does that looking on the user's behalf.
 */

import type { SimulationEngine } from '../simulation/engine';
import type { EventBus } from '../events';
import type { ChartSample, Organism, World } from '../types';

const STORAGE_KEY = 'repsim-field-notes';
const HISTORY_MAX = 30;
const NOTE_DISPLAY_MS = 18_000;       // How long a note lingers in the pill
const PILL_FADE_MS = 350;              // CSS transition time
const STATS_WINDOW_SIZE = 60;          // ~5 min of samples at 100 ticks each
const DEFAULT_ENABLED = true;

interface FieldNote {
  id: number;
  tick: number;
  wallTimeMs: number;
  kind: string;
  text: string;
}

interface ObservationContext {
  world: World;
  samples: ChartSample[];    // Oldest → newest
  latest: ChartSample;
  prev: ChartSample | null;   // Sample immediately before latest, if any
  firstFlags: Set<string>;    // Mutated by rules that want one-time fires
  tick: number;
}

type Rule = {
  kind: string;
  cooldownSamples: number;   // Min samples between same-kind fires (0 = can fire every sample)
  check: (ctx: ObservationContext) => string | null;
};

// ─── Rules ─────────────────────────────────────────────────────
// Each rule is a pure function of the current observation context. Return a
// string to emit a note; return null to skip this sample.

const COLOR_NAMES = ['green', 'blue', 'yellow', 'red', 'purple', 'white'];

function populationDelta(ctx: ObservationContext, lookback: number): { start: number; end: number } | null {
  if (ctx.samples.length < lookback + 1) return null;
  const start = ctx.samples[ctx.samples.length - 1 - lookback].population;
  const end = ctx.latest.population;
  return { start, end };
}

const RULES: Rule[] = [
  // Population boom — +50% over last ~5 min
  {
    kind: 'pop-boom',
    cooldownSamples: 20, // ~20 samples = ~100 sim seconds
    check: (ctx) => {
      const d = populationDelta(ctx, Math.min(60, ctx.samples.length - 1));
      if (!d || d.start < 30) return null;
      const ratio = d.end / d.start;
      if (ratio < 1.5) return null;
      return `Population boom: ${d.start} → ${d.end} over the last few minutes. Something's working.`;
    },
  },

  // Population crash — −40% over last ~5 min
  {
    kind: 'pop-crash',
    cooldownSamples: 20,
    check: (ctx) => {
      const d = populationDelta(ctx, Math.min(60, ctx.samples.length - 1));
      if (!d || d.start < 50) return null;
      const ratio = d.end / d.start;
      if (ratio > 0.6) return null;
      return `Population crash: ${d.start} → ${d.end}. Whatever they were doing just stopped working.`;
    },
  },

  // First extinction — population hit 0 then recovered, or is at 0
  {
    kind: 'first-extinction',
    cooldownSamples: 0,
    check: (ctx) => {
      if (ctx.firstFlags.has('extinction')) return null;
      if (ctx.latest.population !== 0) return null;
      ctx.firstFlags.add('extinction');
      return `Extinction. The tank is empty. Press Flush to reseed — natural selection needs something to select.`;
    },
  },

  // Species convergence — diversity drops sharply
  {
    kind: 'species-converge',
    cooldownSamples: 30,
    check: (ctx) => {
      if (ctx.samples.length < 10) return null;
      const prevSpecies = ctx.samples[ctx.samples.length - 10].speciesCount;
      const cur = ctx.latest.speciesCount;
      if (prevSpecies < 50 || cur >= prevSpecies * 0.5) return null;
      return `Species diversity collapsed: ${prevSpecies} → ${cur} distinct body plans. One lineage is sweeping.`;
    },
  },

  // Species explosion — diversity doubles
  {
    kind: 'species-explode',
    cooldownSamples: 30,
    check: (ctx) => {
      if (ctx.samples.length < 10) return null;
      const prevSpecies = ctx.samples[ctx.samples.length - 10].speciesCount;
      const cur = ctx.latest.speciesCount;
      if (prevSpecies < 10 || cur < prevSpecies * 2) return null;
      return `Species count just doubled: ${prevSpecies} → ${cur}. Radiation event — mutation is outpacing selection.`;
    },
  },

  // Generation milestone — every 50 generations of the deepest lineage
  {
    kind: 'gen-milestone',
    cooldownSamples: 0,
    check: (ctx) => {
      const gen = Math.floor(ctx.latest.maxGeneration);
      if (gen < 50 || gen % 50 !== 0) return null;
      const key = `gen-${gen}`;
      if (ctx.firstFlags.has(key)) return null;
      ctx.firstFlags.add(key);
      return `Generation ${gen}. Your deepest lineage has descended ${gen} times from the founding stock.`;
    },
  },

  // Color dominance shift — a new color becomes majority for the first time
  {
    kind: 'color-shift',
    cooldownSamples: 12,
    check: (ctx) => {
      const counts = ctx.latest.colorCounts;
      const total = counts.reduce((a, b) => a + b, 0);
      if (total < 100) return null;
      let domIdx = 0;
      for (let i = 1; i < 6; i++) if (counts[i] > counts[domIdx]) domIdx = i;
      const key = `dom-${domIdx}`;
      if (ctx.firstFlags.has(key)) return null;
      if (counts[domIdx] / total < 0.4) return null;
      ctx.firstFlags.add(key);
      const pct = Math.round((counts[domIdx] / total) * 100);
      return `${COLOR_NAMES[domIdx][0].toUpperCase()}${COLOR_NAMES[domIdx].slice(1)} segments just crossed ${pct}% of the population. A new body plan is taking over.`;
    },
  },

  // First sexual reproduction — purple (black) color appears
  {
    kind: 'first-sexual',
    cooldownSamples: 0,
    check: (ctx) => {
      if (ctx.firstFlags.has('first-sexual')) return null;
      if (ctx.latest.colorCounts[4] < 3) return null;
      ctx.firstFlags.add('first-sexual');
      return `Sexual reproduction is taking hold. Purple segments are expensive — the sim is rich enough to afford them.`;
    },
  },

  // Virus outbreak — strain count goes from 0 to ≥1
  {
    kind: 'virus-outbreak',
    cooldownSamples: 6,
    check: (ctx) => {
      if (!ctx.prev) return null;
      if (ctx.prev.aliveStrains !== 0 || ctx.latest.aliveStrains === 0) return null;
      return `A virus just emerged. ${ctx.latest.totalInfected} organism${ctx.latest.totalInfected === 1 ? '' : 's'} currently infected. Watch the Segment Type Ratio chart for effects.`;
    },
  },

  // Strain extinction — strain count drops but infected went to 0
  {
    kind: 'virus-cleared',
    cooldownSamples: 10,
    check: (ctx) => {
      if (!ctx.prev) return null;
      if (ctx.prev.aliveStrains === 0 || ctx.latest.aliveStrains !== 0) return null;
      return `Virus gone. Either it burned through its hosts or the population developed herd immunity.`;
    },
  },

  // Stable community — stats flat for a while
  {
    kind: 'stable',
    cooldownSamples: 60, // Don't spam
    check: (ctx) => {
      if (ctx.samples.length < 40) return null;
      const recent = ctx.samples.slice(-20);
      const pops = recent.map(s => s.population);
      const min = Math.min(...pops), max = Math.max(...pops);
      if (min === 0) return null;
      const spread = (max - min) / min;
      if (spread > 0.15) return null;
      return `Stable community (~${ctx.latest.population} organisms for several minutes). Try releasing a virus or shifting Sun Feed to see it respond.`;
    },
  },
];

// ─── System factory ────────────────────────────────────────────

export function createFieldNotes(engine: SimulationEngine, events: EventBus): void {
  const samples: ChartSample[] = [];
  const firstFlags = new Set<string>();
  const history: FieldNote[] = [];
  const ruleCooldowns = new Map<string, number>(); // kind → sample-index of last fire

  let enabled = loadEnabled();
  let nextNoteId = 1;
  let sampleIdx = 0;                  // Monotonic counter
  let currentNote: FieldNote | null = null;
  let noteTimer: number | null = null;
  let historyModal: HTMLElement | null = null;

  // ── DOM ──
  injectStyles();
  const pill = document.createElement('button');
  pill.id = 'field-notes-pill';
  pill.type = 'button';
  pill.className = 'field-notes-pill';
  pill.innerHTML = `<span class="field-notes-dot"></span><span class="field-notes-text"></span>`;
  pill.style.display = 'none';
  pill.addEventListener('click', openHistory);
  document.body.appendChild(pill);

  const textEl = pill.querySelector<HTMLElement>('.field-notes-text')!;

  // ── Event wiring ──
  events.on('chart:sample', () => {
    samples.push(collectSnapshot(engine));
    if (samples.length > STATS_WINDOW_SIZE) samples.shift();
    sampleIdx++;
    if (!enabled) return;
    evaluateRules();
  });

  events.on('sim:reset', () => {
    samples.length = 0;
    firstFlags.clear();
    ruleCooldowns.clear();
    history.length = 0;
    sampleIdx = 0;
    hidePill();
  });

  events.on('chart:clear', () => {
    // Same reset as sim:reset but keep firstFlags preserved across chart clear
    // so scenario tracks don't re-fire; actually easier to just mirror sim:reset.
    samples.length = 0;
    firstFlags.clear();
    ruleCooldowns.clear();
  });

  // ── Rule evaluation ──
  function evaluateRules(): void {
    if (samples.length === 0) return;
    const latest = samples[samples.length - 1];
    const prev = samples.length >= 2 ? samples[samples.length - 2] : null;
    const ctx: ObservationContext = {
      world: engine.world,
      samples,
      latest,
      prev,
      firstFlags,
      tick: engine.world.tick,
    };

    for (const rule of RULES) {
      const lastFire = ruleCooldowns.get(rule.kind) ?? -Infinity;
      if (sampleIdx - lastFire < rule.cooldownSamples) continue;
      const text = rule.check(ctx);
      if (text) {
        emitNote(rule.kind, text);
        ruleCooldowns.set(rule.kind, sampleIdx);
        return; // One note per sample — leaves breathing room
      }
    }
  }

  function emitNote(kind: string, text: string): void {
    const note: FieldNote = {
      id: nextNoteId++,
      tick: engine.world.tick,
      wallTimeMs: Date.now(),
      kind,
      text,
    };
    history.push(note);
    if (history.length > HISTORY_MAX) history.shift();
    showNote(note);
  }

  // ── Pill display ──
  function showNote(note: FieldNote): void {
    currentNote = note;
    pill.style.display = 'flex';
    // Reset animation by removing then forcing reflow + re-adding class
    pill.classList.remove('visible', 'pulse');
    void pill.offsetWidth;
    textEl.textContent = note.text;
    pill.classList.add('visible', 'pulse');
    if (noteTimer !== null) window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => {
      pill.classList.remove('visible');
      window.setTimeout(() => {
        if (currentNote?.id === note.id) pill.style.display = 'none';
      }, PILL_FADE_MS);
    }, NOTE_DISPLAY_MS);
  }

  function hidePill(): void {
    currentNote = null;
    pill.classList.remove('visible');
    pill.style.display = 'none';
    if (noteTimer !== null) { window.clearTimeout(noteTimer); noteTimer = null; }
  }

  // ── History modal ──
  function openHistory(): void {
    if (historyModal) { closeHistory(); return; }
    const modal = document.createElement('div');
    modal.className = 'field-notes-modal';
    modal.innerHTML = `
      <div class="field-notes-modal-card">
        <div class="field-notes-modal-header">
          <span class="field-notes-modal-eyebrow">FIELD NOTES</span>
          <button class="field-notes-modal-close" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="field-notes-modal-body"></div>
      </div>
    `;
    const body = modal.querySelector<HTMLElement>('.field-notes-modal-body')!;
    if (history.length === 0) {
      body.innerHTML = `<div class="field-notes-empty">Nothing notable yet — let the sim run.</div>`;
    } else {
      for (const note of history.slice().reverse()) {
        const row = document.createElement('div');
        row.className = 'field-notes-row';
        const secs = Math.floor(note.tick / 20); // 20 ticks/sec
        const mm = Math.floor(secs / 60);
        const ss = String(secs % 60).padStart(2, '0');
        row.innerHTML = `<span class="field-notes-time">${mm}:${ss}</span><span class="field-notes-body">${escapeHTML(note.text)}</span>`;
        body.appendChild(row);
      }
    }
    modal.querySelector('.field-notes-modal-close')!.addEventListener('click', closeHistory);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeHistory(); });
    document.body.appendChild(modal);
    historyModal = modal;
    requestAnimationFrame(() => modal.classList.add('visible'));
  }

  function closeHistory(): void {
    if (!historyModal) return;
    historyModal.classList.remove('visible');
    const m = historyModal;
    historyModal = null;
    window.setTimeout(() => m.remove(), 250);
  }

  // ── Toggle (exposed via global function for Settings wiring) ──
  (window as unknown as Record<string, unknown>).__repsimFieldNotesToggle = (on: boolean) => {
    enabled = on;
    saveEnabled(on);
    if (!on) hidePill();
  };
  (window as unknown as Record<string, unknown>).__repsimFieldNotesEnabled = () => enabled;
}

// ─── Helpers ───────────────────────────────────────────────────

function collectSnapshot(engine: SimulationEngine): ChartSample {
  const world = engine.world;
  const colorCounts = [0, 0, 0, 0, 0, 0];
  const genomeColorCounts = [0, 0, 0, 0, 0, 0];
  let totalInfected = 0;
  const species = new Set<string>();
  let maxGen = 0;
  let genSum = 0;
  let genomeSum = 0;
  let orgCount = 0;
  for (const org of world.organisms.values()) {
    if (!org.alive) continue;
    orgCount++;
    species.add(org.fingerprint);
    if (org.generation > maxGen) maxGen = org.generation;
    genSum += org.generation;
    genomeSum += org.genome.length;
    if (org.virusInfectionCount > 0) totalInfected++;
    for (let i = 0; i < org.segmentCount; i++) {
      const idx = org.firstSegment + i;
      if (world.segments.alive[idx]) {
        const c = world.segments.color[idx];
        if (c >= 0 && c < 6) colorCounts[c]++;
      }
    }
    for (const gene of org.genome) {
      if (gene.color >= 0 && gene.color < 6) genomeColorCounts[gene.color]++;
    }
  }
  let aliveStrains = 0;
  for (const s of world.virusStrains.strains) if (s.alive && s.hostCount > 0) aliveStrains++;
  return {
    tick: world.tick,
    population: world.stats.population,
    births: world.stats.births,
    deaths: world.stats.deaths,
    colorCounts,
    genomeColorCounts,
    avgGenomeLength: orgCount > 0 ? genomeSum / orgCount : 0,
    maxGeneration: maxGen,
    avgGeneration: orgCount > 0 ? genSum / orgCount : 0,
    speciesCount: species.size,
    aliveStrains,
    totalInfected,
  };
}

function loadEnabled(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'on') return true;
    if (v === 'off') return false;
  } catch { /* localStorage disabled */ }
  return DEFAULT_ENABLED;
}

function saveEnabled(on: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* noop */ }
}

function escapeHTML(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ─── Organism prose summary ────────────────────────────────────
// Imported by ui.ts and appended to the Selected Organism panel.

export function describeOrganism(org: Organism, world: World): string {
  const counts = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < org.segmentCount; i++) {
    const idx = org.firstSegment + i;
    if (world.segments.alive[idx]) counts[world.segments.color[idx]]++;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return '';

  let domIdx = 0;
  for (let i = 1; i < 6; i++) if (counts[i] > counts[domIdx]) domIdx = i;
  const domPct = counts[domIdx] / total;

  const type = domPct >= 0.7 ? `${COLOR_NAMES[domIdx]}-dominant`
    : domPct >= 0.45 ? `${COLOR_NAMES[domIdx]}-leaning`
    : 'balanced';

  const roleHint: Record<number, string> = {
    0: 'built for steady photosynthesis',
    1: 'built for defense',
    2: 'built for mobility',
    3: 'built for predation',
    4: 'invested in sexual reproduction',
    5: 'built for scavenging',
  };
  const lead = roleHint[domIdx];

  // Secondary traits — flag meaningful presences beyond the dominant color
  const traits: string[] = [];
  if (domIdx !== 1 && counts[1] >= 2) traits.push('well-defended');
  if (domIdx !== 2 && counts[2] >= 2) traits.push('mobile');
  if (domIdx !== 3 && counts[3] >= 1) traits.push('predatory');
  if (domIdx !== 5 && counts[5] >= 1) traits.push('a scavenger');
  if (domIdx !== 4 && counts[4] >= 1) traits.push('sexual');
  const traitStr = traits.length > 0 ? `, also ${traits.join(' and ')}` : '';

  const segList = counts
    .map((c, i) => c > 0 ? `${c} ${COLOR_NAMES[i]}` : null)
    .filter(Boolean)
    .join(', ');

  return `A ${type} rep (${segList}) — ${lead}${traitStr}.`;
}

// ─── Styles ────────────────────────────────────────────────────

function injectStyles(): void {
  if (document.getElementById('field-notes-styles')) return;
  const style = document.createElement('style');
  style.id = 'field-notes-styles';
  style.textContent = `
    .field-notes-pill {
      position: fixed;
      top: 52px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 85;
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: min(720px, calc(100vw - 480px));
      padding: 6px 14px 6px 12px;
      border: 1px solid var(--ui-border);
      border-radius: 16px;
      background: var(--ui-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      font: 11px/1.4 var(--ui-font);
      color: var(--ui-text);
      cursor: pointer;
      opacity: 0;
      transition: opacity ${PILL_FADE_MS}ms ease, transform ${PILL_FADE_MS}ms ease;
      transform: translateX(-50%) translateY(-6px);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .field-notes-pill.visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .field-notes-pill:hover { border-color: var(--ui-accent); }
    .field-notes-dot {
      display: inline-block;
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--ui-accent);
      flex-shrink: 0;
    }
    .field-notes-pill.pulse .field-notes-dot {
      animation: fieldNotesPulse 1.2s ease-out 1;
    }
    @keyframes fieldNotesPulse {
      0%   { box-shadow: 0 0 0 0 var(--ui-accent); }
      100% { box-shadow: 0 0 0 10px rgba(107,138,255,0); }
    }
    .field-notes-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Modal — mirrors the scenario popup visual language */
    .field-notes-modal {
      position: fixed; inset: 0;
      z-index: 450;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.4);
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    .field-notes-modal.visible { opacity: 1; }
    .field-notes-modal-card {
      width: min(520px, calc(100vw - 32px));
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      background: var(--ui-bg-solid);
      border: 1px solid var(--ui-border);
      border-radius: 14px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      overflow: hidden;
      color: var(--ui-text);
      font-family: var(--ui-font);
    }
    .field-notes-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px 10px;
      border-bottom: 1px solid var(--ui-border);
    }
    .field-notes-modal-eyebrow {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.1em;
      color: var(--ui-text-dim);
    }
    .field-notes-modal-close {
      background: transparent;
      border: none;
      color: var(--ui-text-muted);
      cursor: pointer;
      font: 20px var(--ui-font);
      padding: 0 4px;
      line-height: 1;
    }
    .field-notes-modal-close:hover { color: var(--ui-text); }
    .field-notes-modal-body {
      overflow-y: auto;
      padding: 10px 18px 16px;
    }
    .field-notes-empty {
      color: var(--ui-text-muted);
      font-style: italic;
      font-size: 12px;
      padding: 20px 0;
      text-align: center;
    }
    .field-notes-row {
      display: flex;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--ui-border);
      font-size: 12px;
      line-height: 1.4;
    }
    .field-notes-row:last-child { border-bottom: none; }
    .field-notes-time {
      flex-shrink: 0;
      color: var(--ui-text-muted);
      font-variant-numeric: tabular-nums;
      min-width: 42px;
    }
    .field-notes-body { color: var(--ui-text); }

    @media (max-width: 767px) {
      .field-notes-pill {
        top: 52px;
        max-width: calc(100vw - 32px);
        font-size: 10px;
      }
    }
  `;
  document.head.appendChild(style);
}
