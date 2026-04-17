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
const TIPS_STORAGE_KEY = 'repsim-tips';
const HISTORY_MAX = 30;
const NOTE_DISPLAY_MS = 5_000;         // Linger long enough to read without rushing
const PILL_FADE_IN_MS = 280;           // Quick fade-in
const PILL_FADE_OUT_MS = 700;          // Slower, graceful dissolve
const STATS_WINDOW_SIZE = 60;          // ~5 min of samples at 100 ticks each
const DEFAULT_ENABLED = true;
const DEFAULT_TIPS_ENABLED = true;
const TIP_MIN_INTERVAL_MS = 60_000;    // First tip at least 60s after boot
const TIP_AVG_INTERVAL_MS = 90_000;    // Typical spacing between tips (randomized)

// Curated tips — suggestions the user might not have discovered yet.
// Shown through the same pill UI as field notes, but scheduled by time
// rather than sim events. Each tip fires at most once per session.
const TIPS: string[] = [
  'Tip: Hold Alt and scroll to adjust depth focus — reveals the 2.5D layering of organisms.',
  'Tip: Shift + click-drag paints wall cells into the tank. Build your own environment.',
  'Tip: Try setting Sun Feed to 0 with just one or two light sources. Watch organisms crowd the lit zones.',
  'Tip: Click any rep to see its genome dots, HP, and prose summary — each dot matches a segment on its body.',
  'Tip: Save & Share → Copy URL sends your entire tank setup to someone else. Or save it to one of four slots.',
  'Tip: The Virus panel\'s Release Virus button seeds a single random strain. Then watch what the sliders do.',
  'Tip: Scenarios come with curated tanks and teaching prompts. The Plague shows virus evolution; Founder\'s Luck shows genetic drift.',
  'Tip: The Segment Type Ratio chart has Phenotype/Genotype modes. Genotype shows what\'s encoded in genes even when those segments died.',
  'Tip: Flush reseeds the population in the same tank — useful for Phase 2 of Founder\'s Luck, or to reset dynamics without losing your setup.',
  'Tip: Organism names are built from the DFS traversal of their genome. Same genome = same name; related lineages share prefixes.',
  'Tip: The toolbar (top bar) switches between Select / Walls / Light / Temperature / Current. Place environment sources anywhere.',
  'Tip: Red segments only attack green by default. Change which colors red targets in Simulation → Red Targets.',
  'Tip: Blue segments halve the time to develop immunity to a virus strain. Matters a lot in virus-heavy runs.',
  'Tip: Lower Mate Cost to see reproduction explode. Lower Mutate % to let structures stabilize once they\'re working.',
  'Tip: Turn on Day / Night cycle in Tank Settings (bottom) to add rhythmic pressure — organisms have to handle periodic darkness.',
  'Tip: Temperature sources change metabolism speed. Warm = faster everything; cold = slower, more viscous.',
  'Tip: Currents push segments around. Whirlpools are good for mixing populations; directional currents can trap or sort them.',
  'Tip: If a rep looks tiny, an early green segment probably got pruned. Evolution will eventually favor greens placed as leaves, not near the root.',
  'Tip: The Center Map button (bottom-right) fits the whole tank to your screen, no matter the size.',
  'Tip: Pause (Space) and click through organisms to compare genomes. The prose summary tells you what role each one fills.',
];

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
// Each rule is a pure function of the current observation context and
// returns either a string (the note to emit) or null (skip this sample).
// Most rules pick from an array of phrasings so repeat fires feel fresh,
// and weave in live context (dominant color, specific counts, etc).

const COLOR_NAMES = ['green', 'blue', 'yellow', 'red', 'purple', 'white'];

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

function populationDelta(ctx: ObservationContext, lookback: number): { start: number; end: number } | null {
  if (ctx.samples.length < lookback + 1) return null;
  const start = ctx.samples[ctx.samples.length - 1 - lookback].population;
  const end = ctx.latest.population;
  return { start, end };
}

interface DomColor {
  idx: number;
  name: string;
  pct: number;      // 0..1
  count: number;
}

function dominantColor(counts: number[]): DomColor | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let idx = 0;
  for (let i = 1; i < 6; i++) if (counts[i] > counts[idx]) idx = i;
  return { idx, name: COLOR_NAMES[idx], pct: counts[idx] / total, count: counts[idx] };
}

function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

const RULES: Rule[] = [
  // Population boom — +50% over recent window
  {
    kind: 'pop-boom',
    cooldownSamples: 20,
    check: (ctx) => {
      const d = populationDelta(ctx, Math.min(60, ctx.samples.length - 1));
      if (!d || d.start < 30) return null;
      const ratio = d.end / d.start;
      if (ratio < 1.5) return null;
      const dom = dominantColor(ctx.latest.colorCounts);
      const pct = Math.round((ratio - 1) * 100);
      const variants = [
        `Population boom: ${d.start} → ${d.end}${dom ? ` — reps carrying plenty of ${dom.name} are leading the charge.` : '.'}`,
        `+${pct}% population in minutes (${d.start} → ${d.end}). Something about this environment rewards ${dom?.name ?? 'the current'} segments.`,
        `Surge: ${d.end} alive, up from ${d.start}. ${dom ? `${capitalize(dom.name)}-heavy lineages are thriving.` : 'The tank is filling fast.'}`,
        `The population just jumped ${pct}%. ${dom && dom.pct > 0.5 ? `${capitalize(dom.name)} segments are paying off.` : 'A new equilibrium is forming.'}`,
      ];
      return pick(variants);
    },
  },

  // Population crash — −40% over recent window
  {
    kind: 'pop-crash',
    cooldownSamples: 20,
    check: (ctx) => {
      const d = populationDelta(ctx, Math.min(60, ctx.samples.length - 1));
      if (!d || d.start < 50) return null;
      const ratio = d.end / d.start;
      if (ratio > 0.6) return null;
      const lost = d.start - d.end;
      const pct = Math.round((1 - ratio) * 100);
      const variants = [
        `Crash: ${d.start} → ${d.end}. ${lost} reps gone in the last few minutes.`,
        `Population dropped ${pct}% (${d.start} → ${d.end}). Whatever was sustaining them ran out.`,
        `Down to ${d.end} from ${d.start}. A selection pressure just cut deep.`,
        `Die-off: ${lost} deaths this window. The tank is thinning.`,
      ];
      return pick(variants);
    },
  },

  // First extinction — population hit 0
  {
    kind: 'first-extinction',
    cooldownSamples: 0,
    check: (ctx) => {
      if (ctx.firstFlags.has('extinction')) return null;
      if (ctx.latest.population !== 0) return null;
      ctx.firstFlags.add('extinction');
      return pick([
        'Extinction. The tank is empty. Press Flush to reseed — natural selection needs something to select.',
        'All dead. Whatever was running here, it couldn\'t sustain itself. Hit Flush to start over.',
        'Population: 0. That\'s the end of this lineage. Flush to try a new founding stock.',
      ]);
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
      const dom = dominantColor(ctx.latest.colorCounts);
      const variants = [
        `Species diversity collapsed: ${prevSpecies} → ${cur} distinct body plans. ${dom ? `A ${dom.name}-heavy lineage is sweeping.` : 'One body plan is sweeping.'}`,
        `From ${prevSpecies} species down to ${cur} — selection is brutal right now.`,
        `Diversity crunch: ${prevSpecies} → ${cur}. ${dom ? `The ${dom.name} strategy is out-competing everything else.` : 'A single body plan is taking over.'}`,
      ];
      return pick(variants);
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
      return pick([
        `Species count just doubled: ${prevSpecies} → ${cur}. Radiation event — mutation is outpacing selection.`,
        `Adaptive radiation: ${prevSpecies} → ${cur} body plans. Nothing is dominating yet.`,
        `${cur} distinct body plans now (was ${prevSpecies}). Plenty of room for everyone.`,
      ]);
    },
  },

  // Generation milestone — every 50 gens of the deepest lineage
  {
    kind: 'gen-milestone',
    cooldownSamples: 0,
    check: (ctx) => {
      const gen = Math.floor(ctx.latest.maxGeneration);
      if (gen < 50 || gen % 50 !== 0) return null;
      const key = `gen-${gen}`;
      if (ctx.firstFlags.has(key)) return null;
      ctx.firstFlags.add(key);
      return pick([
        `Generation ${gen}. Your deepest lineage has descended ${gen} times from the founding stock.`,
        `Gen ${gen} reached. ${gen} rounds of mutation and selection stand between the current population and the seed organisms.`,
        `${gen} generations deep. The oldest living ancestry in this tank is ${gen} reproductive events long.`,
      ]);
    },
  },

  // Color dominance shift — a new color becomes majority for the first time
  {
    kind: 'color-shift',
    cooldownSamples: 12,
    check: (ctx) => {
      const dom = dominantColor(ctx.latest.colorCounts);
      if (!dom) return null;
      const total = ctx.latest.colorCounts.reduce((a, b) => a + b, 0);
      if (total < 100) return null;
      const key = `dom-${dom.idx}`;
      if (ctx.firstFlags.has(key)) return null;
      if (dom.pct < 0.4) return null;
      ctx.firstFlags.add(key);
      const pct = Math.round(dom.pct * 100);
      const name = capitalize(dom.name);
      return pick([
        `${name} segments just crossed ${pct}% of the population. A new body plan is taking over.`,
        `${name} is ascendant — ${pct}% of all living segments are ${dom.name}.`,
        `Shift: ${name} now dominates (${pct}%). The ecosystem is tilting toward ${roleHint(dom.idx)}.`,
      ]);
    },
  },

  // Sexual reproduction taking hold — gated so it doesn't fire just because
  // random seeding scattered purple segments. Needs (1) at least 5 minutes of
  // sim time so initial noise has settled, AND (2) purple to be a real
  // presence — ≥5% of all segments — not just scattered leftovers.
  {
    kind: 'first-sexual',
    cooldownSamples: 0,
    check: (ctx) => {
      if (ctx.firstFlags.has('first-sexual')) return null;
      if (ctx.world.tick < 6000) return null; // 5 min at 20 ticks/sec
      const total = ctx.latest.colorCounts.reduce((a, b) => a + b, 0);
      if (total < 100) return null;
      const purple = ctx.latest.colorCounts[4];
      if (purple / total < 0.05) return null;
      ctx.firstFlags.add('first-sexual');
      const pct = Math.round((purple / total) * 100);
      return pick([
        `Sexual reproduction is taking hold — purple segments are now ${pct}% of the population. The sim is rich enough to afford the cost.`,
        `Purple crossed ${pct}%. That's sexual reproduction sticking around — costlier per child, but it shuffles genes every generation.`,
        `Sex is here to stay. Purple is expensive, so ${pct}% means the population is thriving enough to support it.`,
      ]);
    },
  },

  // Virus outbreak — strain count goes from 0 to ≥1
  {
    kind: 'virus-outbreak',
    cooldownSamples: 6,
    check: (ctx) => {
      if (!ctx.prev) return null;
      if (ctx.prev.aliveStrains !== 0 || ctx.latest.aliveStrains === 0) return null;
      const n = ctx.latest.totalInfected;
      return pick([
        `A virus just emerged. ${n} organism${n === 1 ? '' : 's'} already infected.`,
        `Outbreak: ${n} infected so far. Watch for the virus to mutate as it spreads.`,
        `New strain circulating. ${n} host${n === 1 ? '' : 's'} so far — mutation is now possible on every spread.`,
      ]);
    },
  },

  // Strain cleared — went from ≥1 strain to 0
  {
    kind: 'virus-cleared',
    cooldownSamples: 10,
    check: (ctx) => {
      if (!ctx.prev) return null;
      if (ctx.prev.aliveStrains === 0 || ctx.latest.aliveStrains !== 0) return null;
      return pick([
        'Virus gone. Either it burned through its hosts or the population developed herd immunity.',
        'Epidemic over. The survivors carry the immunity; the virus has nowhere left to go.',
        'No active strains. This lineage of virus just went extinct.',
      ]);
    },
  },

  // Stable community — stats flat for a while
  {
    kind: 'stable',
    cooldownSamples: 60,
    check: (ctx) => {
      if (ctx.samples.length < 40) return null;
      const recent = ctx.samples.slice(-20);
      const pops = recent.map(s => s.population);
      const min = Math.min(...pops), max = Math.max(...pops);
      if (min === 0) return null;
      const spread = (max - min) / min;
      if (spread > 0.15) return null;
      const dom = dominantColor(ctx.latest.colorCounts);
      const variants = [
        `Stable at ~${ctx.latest.population} for several minutes. ${dom ? `${capitalize(dom.name)}-heavy body plans found an equilibrium.` : 'The ecosystem has settled.'} Try releasing a virus or shifting Sun Feed.`,
        `Flat line: population holding near ${ctx.latest.population}. Want to see it respond? Adjust a slider.`,
        `${ctx.latest.population} alive and nothing dramatic happening. ${dom ? `Reps with plenty of ${dom.name} are the steady state here.` : 'The tank is at rest.'}`,
      ];
      return pick(variants);
    },
  },

  // Genome length drift — average organism grew or shrank meaningfully
  {
    kind: 'genome-size',
    cooldownSamples: 40,
    check: (ctx) => {
      if (ctx.samples.length < 30) return null;
      const past = ctx.samples[ctx.samples.length - 30].avgGenomeLength;
      const now = ctx.latest.avgGenomeLength;
      if (past < 2 || now < 2) return null;
      const ratio = now / past;
      if (ratio >= 0.8 && ratio <= 1.25) return null;
      const direction = ratio > 1 ? 'larger' : 'smaller';
      const fromTo = `${past.toFixed(1)} → ${now.toFixed(1)} segments`;
      return pick([
        `Average rep is getting ${direction}: ${fromTo}. Selection is favoring a different body size.`,
        `Body plans are ${direction === 'larger' ? 'growing' : 'shrinking'} — ${fromTo} avg. ${direction === 'larger' ? 'Energy is plentiful.' : 'Something\'s rewarding minimalism.'}`,
        `Genome size drift: ${fromTo}. The typical rep looks different than it did a few minutes ago.`,
      ]);
    },
  },

  // Infection wave — many organisms currently infected (≥20% of pop)
  {
    kind: 'infection-wave',
    cooldownSamples: 30,
    check: (ctx) => {
      if (ctx.latest.population < 30 || ctx.latest.totalInfected === 0) return null;
      const rate = ctx.latest.totalInfected / ctx.latest.population;
      if (rate < 0.2) return null;
      const pct = Math.round(rate * 100);
      return pick([
        `${pct}% of the population is currently infected (${ctx.latest.totalInfected} of ${ctx.latest.population}). Watch for a crash.`,
        `Infection wave: ${ctx.latest.totalInfected} sick, ${ctx.latest.population - ctx.latest.totalInfected} healthy. The next few minutes decide.`,
        `Peak infection: ${pct}%. Either the population adapts or this strain burns it down.`,
      ]);
    },
  },

  // Long lineage alive — oldest living lineage is deep
  {
    kind: 'old-lineage',
    cooldownSamples: 80,
    check: (ctx) => {
      if (ctx.samples.length < 20) return null;
      const gen = Math.floor(ctx.latest.maxGeneration);
      if (gen < 80) return null;
      // Only fire once per "era" — use 100-gen buckets so it re-fires over long runs
      const bucket = Math.floor(gen / 100);
      const key = `old-lineage-${bucket}`;
      if (ctx.firstFlags.has(key)) return null;
      ctx.firstFlags.add(key);
      return pick([
        `An unbroken lineage ${gen} generations deep is still alive. That's a lot of continuous ancestry.`,
        `Gen ${gen} descendants are walking around right now. This genome has mutated but not died out.`,
        `${gen} reproductive generations between now and the founding stock — and the chain is unbroken.`,
      ]);
    },
  },
];

function roleHint(colorIdx: number): string {
  switch (colorIdx) {
    case 0: return 'photosynthesis';
    case 1: return 'defense';
    case 2: return 'mobility';
    case 3: return 'predation';
    case 4: return 'sexual reproduction';
    case 5: return 'scavenging';
    default: return 'a different strategy';
  }
}

// ─── System factory ────────────────────────────────────────────

export function createFieldNotes(engine: SimulationEngine, events: EventBus): void {
  const samples: ChartSample[] = [];
  const firstFlags = new Set<string>();
  const history: FieldNote[] = [];
  const ruleCooldowns = new Map<string, number>(); // kind → sample-index of last fire

  let enabled = loadEnabled();
  let tipsEnabled = loadTipsEnabled();
  let nextNoteId = 1;
  let sampleIdx = 0;                  // Monotonic counter
  let currentNote: FieldNote | null = null;
  let noteTimer: number | null = null;
  let historyModal: HTMLElement | null = null;

  // ── Tips state ──
  // Tips fire on a randomized timer, independent of sim events. Shuffle the
  // tip list once so users see all 20 before any repeat in a single session.
  const tipOrder: number[] = TIPS.map((_, i) => i);
  for (let i = tipOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tipOrder[i], tipOrder[j]] = [tipOrder[j], tipOrder[i]];
  }
  let tipCursor = 0;
  let tipTimer: number | null = null;

  // ── DOM ──
  injectStyles();
  const pill = document.createElement('div');
  pill.id = 'field-notes-pill';
  pill.className = 'field-notes-pill';
  pill.innerHTML = `
    <span class="field-notes-dot"></span>
    <span class="field-notes-text" role="button" tabindex="0" title="Open history"></span>
    <button class="field-notes-dismiss" type="button" aria-label="Dismiss" title="Dismiss (Field Notes toggle in Settings)">\u00D7</button>
  `;
  pill.style.display = 'none';
  document.body.appendChild(pill);

  const textEl = pill.querySelector<HTMLElement>('.field-notes-text')!;
  const dismissBtn = pill.querySelector<HTMLButtonElement>('.field-notes-dismiss')!;

  textEl.addEventListener('click', openHistory);
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHistory(); }
  });
  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hidePill();
  });

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
      }, PILL_FADE_OUT_MS);
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

  // ── Tips scheduler ──
  // Fires a curated tip through the same pill. Randomized interval so
  // successive tips don't feel metronomic. Skips firing if a tip would
  // overwrite a just-shown field note (grace period ≈ display window).
  function fireTip(): void {
    if (!tipsEnabled) return;
    if (tipCursor >= tipOrder.length) {
      // Reshuffle and start over — users who run long sessions get fresh order
      for (let i = tipOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tipOrder[i], tipOrder[j]] = [tipOrder[j], tipOrder[i]];
      }
      tipCursor = 0;
    }
    const text = TIPS[tipOrder[tipCursor++]];
    emitNote('tip', text);
  }

  function scheduleNextTip(): void {
    if (tipTimer !== null) { window.clearTimeout(tipTimer); tipTimer = null; }
    if (!tipsEnabled) return;
    const jitter = TIP_AVG_INTERVAL_MS * (0.6 + Math.random() * 0.8); // ±40% spread
    const delay = Math.max(TIP_MIN_INTERVAL_MS, Math.round(jitter));
    tipTimer = window.setTimeout(() => {
      fireTip();
      scheduleNextTip();
    }, delay);
  }

  if (tipsEnabled) scheduleNextTip();

  // ── Toggles (exposed via global functions for Settings wiring) ──
  (window as unknown as Record<string, unknown>).__repsimFieldNotesToggle = (on: boolean) => {
    enabled = on;
    saveEnabled(on);
    if (!on) hidePill();
  };
  (window as unknown as Record<string, unknown>).__repsimFieldNotesEnabled = () => enabled;
  (window as unknown as Record<string, unknown>).__repsimTipsToggle = (on: boolean) => {
    tipsEnabled = on;
    saveTipsEnabled(on);
    if (on) {
      scheduleNextTip();
    } else if (tipTimer !== null) {
      window.clearTimeout(tipTimer);
      tipTimer = null;
    }
  };
  (window as unknown as Record<string, unknown>).__repsimTipsEnabled = () => tipsEnabled;
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

function loadTipsEnabled(): boolean {
  try {
    const v = localStorage.getItem(TIPS_STORAGE_KEY);
    if (v === 'on') return true;
    if (v === 'off') return false;
  } catch { /* localStorage disabled */ }
  return DEFAULT_TIPS_ENABLED;
}

function saveTipsEnabled(on: boolean): void {
  try { localStorage.setItem(TIPS_STORAGE_KEY, on ? 'on' : 'off'); } catch { /* noop */ }
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
      /* Default (fade-out) transition — slow graceful dissolve.
         When .visible is added, the transition overrides to a quicker fade-in. */
      transition:
        opacity ${PILL_FADE_OUT_MS}ms cubic-bezier(0.4, 0, 0.2, 1),
        transform ${PILL_FADE_OUT_MS}ms cubic-bezier(0.4, 0, 0.2, 1);
      transform: translateX(-50%) translateY(-6px);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .field-notes-pill.visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
      transition:
        opacity ${PILL_FADE_IN_MS}ms cubic-bezier(0.2, 0, 0.2, 1),
        transform ${PILL_FADE_IN_MS}ms cubic-bezier(0.2, 0, 0.2, 1);
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
      cursor: pointer;
      flex: 1 1 auto;
      min-width: 0;
    }
    .field-notes-text:hover { color: var(--ui-accent); }
    .field-notes-dismiss {
      flex-shrink: 0;
      margin-left: 2px;
      width: 18px;
      height: 18px;
      padding: 0;
      font: 14px/1 var(--ui-font);
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--ui-text-muted);
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .field-notes-dismiss:hover {
      background: var(--ui-surface);
      color: var(--ui-text);
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
