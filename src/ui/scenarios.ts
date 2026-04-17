/**
 * scenarios.ts — Educational lesson preset system for Repsim V2
 *
 * Adds a "Scenarios" accordion section to the right panel with 3 classroom-
 * ready presets. Each scenario loads a custom tank, environment, and config
 * designed to teach a specific biology concept (directional selection,
 * predator-prey arms race, genetic drift / bottleneck effect).
 *
 * UI components:
 *   - Accordion section (right panel) with 3 scenario cards
 *   - Glassmorphic popup modal (preamble → reference phases)
 *   - Persistent badge in the top bar when a scenario is active
 */

import type { SimulationEngine } from '../simulation/engine';
import type { Renderer } from '../rendering/renderer';
import type { EventBus } from '../events';
import type { TankPayload, SimConfig, SegmentColor } from '../types';
import { flushWithoutReseed, applyTankPayload } from './save-share';
import { seedPopulation } from '../simulation/world';
import { createStrain, infectOrganism } from '../simulation/virus';
import { TANK_GRID_SPACING, CAMERA_MIN_ZOOM, CAMERA_MAX_ZOOM } from '../constants';


// ─── Types ───────────────────────────────────────────────────

interface WatchItem {
  time: string;
  text: string;
}

interface ScenarioDef {
  id: string;
  title: string;
  subtitle: string;
  /** Array of paragraph strings for the preamble */
  preamble: string[];
  tankCells: [number, number][];
  lights?: Array<{ id: number; x: number; y: number; radius: number; intensity: number }>;
  temps?: Array<{ id: number; x: number; y: number; radius: number; intensity: number }>;
  config: Partial<SimConfig>;
  /** Optional: seed a virus strain at scenario start and infect one random organism. */
  seedVirus?: {
    colorAffinity: SegmentColor;
    spread: number;      // 0-1 contagion rate
    damageRate: number;  // 0-1 HP drain per tick
    lethality: number;   // 0-1 probability an infection rolls lethal
  };
  watchFor: WatchItem[];
  questions: string[];
}


// ─── Tank Cell Helpers ────────────────────────────────────────

function rectCells(colMin: number, colMax: number, rowMin: number, rowMax: number): [number, number][] {
  const cells: [number, number][] = [];
  for (let col = colMin; col <= colMax; col++) {
    for (let row = rowMin; row <= rowMax; row++) {
      cells.push([col, row]);
    }
  }
  return cells;
}

function circleCells(radiusCells: number): [number, number][] {
  const cells: [number, number][] = [];
  const r2 = radiusCells * radiusCells;
  for (let col = -radiusCells; col <= radiusCells; col++) {
    for (let row = -radiusCells; row <= radiusCells; row++) {
      if (col * col + row * row <= r2) {
        cells.push([col, row]);
      }
    }
  }
  return cells;
}


// ─── Scenario Definitions ─────────────────────────────────────

export const SCENARIOS: ScenarioDef[] = [
  // ── Scenario 1: Light and Shadow ──────────────────────────
  {
    id: 'light-shadow',
    title: 'Light and Shadow',
    subtitle: 'Why different environments produce different organisms',
    preamble: [
      'Natural selection doesn\'t build a single "best" organism — it builds the organism best suited to this environment, right now. To see why, consider two adjacent environments with completely different energy sources. In one, abundant sunlight rewards any organism that can harvest it; in the other, sunlight never penetrates, so the only energy available comes from organic matter left by organisms that wandered in and died.',
      'In this simulation, green segments photosynthesize — they\'re the primary producers of this world. But in a dark environment, green segments are useless: they cost energy to maintain yet produce nothing. Red segments attack other organisms and steal their energy; white segments scavenge food particles from corpses. In the dark zone, these are the survival traits.',
      'Watch carefully as the two populations diverge. They begin with the same random mix of traits. By the end of the run, you should see two strikingly different communities occupying the same tank, separated by nothing but the presence or absence of light.',
    ],
    tankCells: [
      ...rectCells(-21, -7, -13, 13),  // Left Room (lit): 15 wide × 27 tall
      ...rectCells(-6, 6, -1, 1),      // Corridor: 13 wide × 3 tall (barbell bar — max that fits in tank)
      ...rectCells(7, 21, -13, 13),    // Right Room (dark): 15 wide × 27 tall (shifted right)
    ],
    lights: [
      { id: 1, x: -1440, y: -480, radius: 900, intensity: 2.0 },
      { id: 2, x: -1440, y:  480, radius: 900, intensity: 2.0 },
    ],
    temps: [
      { id: 1, x: 1160, y: 0, radius: 900, intensity: 1.2 },
    ],
    config: {
      repCount: 180,
      repLimit: 400,
      asexMutationRate: 3,
      greenFeed: 288,
      redDamage: 500,
      foodDecaySeconds: 200,
      virusEnabled: false,
      // Pinned explicitly so the scenario's teaching holds even if defaults drift:
      // red targets only green, so the dark room is a scavenger (white) niche.
      redTargets: [true, false, false, false, false, false],
    },
    watchFor: [
      { time: '~2 min', text: 'Color distribution charts start diverging. Select organisms in each room to compare their genomes.' },
      { time: '~5 min', text: 'The dark room may show boom-bust cycles as migrants wander in, die, and feed scavengers.' },
      { time: '~10 min', text: 'Left room trends green-heavy. Right room trends red/white. The corridor acts as a gene flow barrier.' },
    ],
    questions: [
      'An organism with all-green segments is perfectly adapted to the left room. What would happen if it migrated to the right room? What specific mechanism kills it?',
      'Is there any benefit to having some red segments even in the well-lit left room? Why might evolution not produce 100% green organisms?',
      'The corridor connects the two rooms. How does this affect each population compared to if the rooms were completely sealed? What real-world biological concept does this represent?',
      'We started with the same random population in both rooms. After 10 minutes, why are they different? Did we program different organisms into each room?',
    ],
  },

  // ── Scenario 2: The Red Queen ─────────────────────────────
  {
    id: 'red-queen',
    title: 'The Red Queen',
    subtitle: 'Why prey keeps getting harder to catch',
    preamble: [
      'In 1973, evolutionary biologist Leigh Van Valen proposed the Red Queen hypothesis — the idea that organisms must continuously evolve just to maintain their current fitness, because their predators, prey, and parasites are all evolving simultaneously.',
      'In this simulation, red segments attack nearby organisms and steal their energy. Green-dominant organisms can sustain themselves on light alone, but they\'re slow and vulnerable. Watch what happens when predators are highly effective: they rapidly deplete their prey, then crash when the food runs out. But evolution doesn\'t stop — surviving prey are the ones with traits that helped them survive: more blue segments for defense, more yellow for escape speed.',
      'This is a genuine arms race playing out in real time. You\'ll see population oscillations in the charts that match the mathematical predictions ecologists use to describe wolves and caribou, lions and wildebeest.',
    ],
    tankCells: circleCells(12),  // Circular arena, ~450 cells
    lights: [
      { id: 1, x:    0, y: -750, radius: 850, intensity: 1.8 },
      { id: 2, x:  750, y:  450, radius: 850, intensity: 1.8 },
      { id: 3, x: -750, y:  450, radius: 850, intensity: 1.8 },
    ],
    temps: [
      { id: 1, x: 0, y: 0, radius: 600, intensity: 1.5 },
    ],
    config: {
      repCount: 150,
      repLimit: 350,
      greenFeed: 192,
      redDamage: 650,
      blueHP: 900,
      asexMutationRate: 3,
      foodDecaySeconds: 60,
      yellowFreq: 1.0,
      virusEnabled: false,
      // Pure predator-prey: red attacks only green. Blue/yellow/etc evolve as
      // defensive traits without being direct targets themselves.
      redTargets: [true, false, false, false, false, false],
    },
    watchFor: [
      { time: 'First 5 min', text: 'Watch for population oscillations in the charts. Red booms tend to follow green booms by 30–60 seconds.' },
      { time: '~5–10 min', text: 'Arms race in body plans: compare organisms now vs when you started. Green survivors trend toward more blue/yellow.' },
      { time: 'Red overshoot', text: 'Watch for reds depleting greens so thoroughly that the red population crashes. Then greens recover — in the absence of predators.' },
    ],
    questions: [
      'The red population peaked and then crashed. What killed the predators? They weren\'t attacked — so what happened?',
      'After the first red crash, the green population recovered. But were the "new" green organisms identical to the ones from before? What might be different about the survivors?',
      'In nature, predator-prey populations also oscillate. Why don\'t the predators just evolve to be infinitely effective and eat everything?',
      'We gave this tank warm temperature in the center. What do you think would happen to the arms race if we used cold temperature instead?',
    ],
  },

  // ── Scenario 3: Founder's Luck ────────────────────────────
  {
    id: 'founders-luck',
    title: 'Founder\'s Luck',
    subtitle: 'When chance beats natural selection',
    preamble: [
      'Natural selection requires numbers. When a population is large, favorable traits reliably spread because the statistics are on selection\'s side. But what happens when a catastrophe wipes out 95% of a population? The survivors aren\'t necessarily the best — they\'re the lucky. An excellent photosynthesizer caught in the wrong place dies just as certainly as a poor one.',
      'This "bottleneck effect" explains some of the strangest patterns in biology: why cheetahs are so genetically uniform, why island populations evolve bizarre traits, and why small founding populations often look nothing like the large populations they came from.',
      'This experiment has two phases. In Phase 1, you\'ll run a large population and observe what natural selection produces in this environment. In Phase 2, you\'ll restart with only 10 organisms — simulating a mass extinction — and watch what genetic drift produces instead. Same environment, completely different outcome. Run Phase 2 again and you\'ll get yet another result.',
    ],
    tankCells: rectCells(-15, 15, -10, 10),  // Simple large rectangle, 31 × 21 = 651 cells
    // No lights → ambient photosynthesis via greenFeed config (uniform environment)
    config: {
      repCount: 250,
      repLimit: 800,
      asexMutationRate: 1,
      sexMutationRate: 2,
      greenFeed: 240,
      foodDecaySeconds: 120,
      virusEnabled: false,
      redTargets: [true, false, false, false, false, false],
    },
    watchFor: [
      { time: 'Phase 1 (~5 min at 8x)', text: 'Note the color distribution — this is what natural selection favors in a uniform environment. Remember which color dominates.' },
      { time: 'Transition to Phase 2', text: 'Press Flush to clear organisms. In the Simulation panel, set Start Pop to 10 and Pop Limit to 50. Press Flush again to seed 10 founders.' },
      { time: 'Phase 2 initial (~2–3 min)', text: 'Watch the tiny population. The 10 founders carry random colors — note which ones they have. This is genetic drift in action.' },
      { time: 'Phase 2 expansion', text: 'Increase Pop Limit to 400. Watch the population grow from the founder stock. The color distribution will reflect founder composition, not the environment.' },
      { time: 'Bonus', text: 'Press Flush again with Start Pop=10, Pop Limit=50 for a fresh set of 10 founders. Get a completely different outcome from the same environment.' },
    ],
    questions: [
      'In Phase 2, which color ended up most common after the population recovered? Was that the same color that dominated in Phase 1?',
      'We used the same tank, same settings, everything identical. The only difference was population size at the start. What does that tell us about genetic drift?',
      'If you were a conservation biologist trying to save a species that went through a bottleneck, why would you care about the genetic diversity of those few survivors?',
      'In Phase 1 with 800 organisms, if a harmful mutation appeared in one organism, what typically happens? In Phase 2 with only 10, what\'s different?',
      'Cheetahs can accept skin grafts from unrelated individuals without immune rejection. Using what you observed in Phase 2, explain how that uniformity could arise.',
    ],
  },

  // ── Scenario 4: The Plague ────────────────────────────────
  // Tank layout: dense central hub (169 cells) + four isolated refugium pods
  // (36 cells each, 144 total) connected to the hub by narrow 2-wide corridors
  // (6 cells each, 24 total). Total ~337 cells. The corridors act as imperfect
  // quarantine barriers — viruses can spread through them but slowly, letting
  // refugia serve as natural reservoirs of uninfected hosts and accumulated
  // immunity. A virus is seeded in one random organism at start.
  {
    id: 'the-plague',
    title: 'The Plague',
    subtitle: 'Why parasites evolve alongside their hosts',
    preamble: [
      'Viruses face a cruel trade-off. A virus that kills its host too quickly has no time to spread — it burns out in one generation. A virus that\'s too mild barely reproduces. Natural selection on the virus itself pushes it toward an intermediate virulence: infectious enough to spread, gentle enough to keep hosts alive long enough to contact others.',
      'Meanwhile, the hosts are evolving too. Survivors of an infection gain lifetime immunity to that strain\'s lineage. Blue segments accelerate the immune response. Over generations, the host population grows collectively more resistant — herd immunity — even as the virus mutates to escape familiar defenses. Neither side ever wins.',
      'This tank is a dense central chamber ringed by four small refugium pods, connected only by narrow corridors. A virus will be seeded in one random organism at start. Watch what happens: the outbreak in the hub, whether the virus crosses into the pods, how the strain\'s spread / damage / lethality shift as it mutates, and whether the population reaches an equilibrium — or collapses.',
    ],
    tankCells: [
      ...rectCells(-6, 6, -6, 6),        // Central hub: 13×13 = 169 cells
      ...rectCells(-2, 3, -15, -10),     // North refugium: 6×6 = 36 cells
      ...rectCells(-2, 3, 10, 15),       // South refugium: 6×6 = 36 cells
      ...rectCells(10, 15, -2, 3),       // East refugium: 6×6 = 36 cells
      ...rectCells(-15, -10, -2, 3),     // West refugium: 6×6 = 36 cells
      ...rectCells(0, 1, -9, -7),        // North corridor: 2×3 = 6 cells
      ...rectCells(0, 1, 7, 9),          // South corridor: 2×3 = 6 cells
      ...rectCells(7, 9, 0, 1),          // East corridor: 3×2 = 6 cells
      ...rectCells(-9, -7, 0, 1),        // West corridor: 3×2 = 6 cells
    ],
    // No lights — relying on ambient greenFeed so every region can sustain a
    // small population, including the isolated refugia. A single point light
    // would leave the corners dark.
    config: {
      repCount: 160,
      repLimit: 350,
      asexMutationRate: 2,
      greenFeed: 210,
      redDamage: 400,              // Default — predation isn't the story here
      foodDecaySeconds: 120,
      virusEnabled: true,
      virusSpread: 1.2,
      virusDamage: 0.9,
      virusLethality: 0.7,
      virusImmunityTime: 35,       // Faster than default 50 so herd immunity emerges inside a viewing window
      redTargets: [true, false, false, false, false, false],
    },
    seedVirus: {
      colorAffinity: 0 as SegmentColor,  // Green — the most common color, maximum contact surface
      spread: 0.6,
      damageRate: 0.6,
      lethality: 0.7,
    },
    watchFor: [
      { time: '~1 min', text: 'Initial outbreak in the hub. Watch the Infected stat climb and the Deaths counter follow.' },
      { time: '~3–5 min', text: 'Refugium pods may still be clean — the narrow corridors slow transmission. Check if the virus eventually crosses.' },
      { time: '~5–10 min', text: 'Strain evolution: open an infected organism\'s panel to see its strain. Strains that kill too fast burn out; strains with balanced damage and lethality persist.' },
      { time: '~10+ min', text: 'Herd immunity: the Infected count plateaus even as the virus keeps circulating. The population has collectively learned to live with the disease.' },
    ],
    questions: [
      'Why doesn\'t the virus simply evolve to be maximally lethal? What would happen to a strain that killed every host within one contact?',
      'The refugium pods are connected to the hub by narrow 2-cell corridors. What role do those corridors play in the dynamics? What if they were wider? What if they didn\'t exist at all?',
      'Set the Lethality slider to 0 (no infection is ever fatal) and restart. Does the virus still matter? What still affects organism fitness?',
      'Real-world analog: isolated island populations are often devastated by diseases that mainland populations have already adapted to. How does that relate to what you\'re seeing in the pods when an infected organism finally makes it through?',
      'Blue segments speed up immunity recovery. Over 10–15 minutes, do you see the population drift toward more blue segments on the Colors chart (try Genotype view)? What pressure would drive that?',
    ],
  },
];


// ─── Accordion State Helper ───────────────────────────────────
// Reuses the same localStorage key as ui.ts for consistent behavior

const ACCORDION_KEY = 'repsim-accordion';

function wireScenarioAccordion(header: HTMLElement, body: HTMLElement): void {
  const chevron = header.querySelector<HTMLElement>('.section-chevron')!;
  let state: Record<string, boolean> = {};
  try {
    const raw = localStorage.getItem(ACCORDION_KEY);
    if (raw) state = JSON.parse(raw);
  } catch { /* corrupted */ }

  const sectionId = 'scenarios';
  // Default: collapsed (scenarios is an advanced feature, don't crowd the panel)
  if (sectionId in state) {
    const shouldCollapse = !state[sectionId];
    body.classList.toggle('collapsed', shouldCollapse);
    chevron.classList.toggle('collapsed', shouldCollapse);
  } else {
    body.classList.add('collapsed');
    chevron.classList.add('collapsed');
  }

  header.addEventListener('click', () => {
    const isCollapsed = body.classList.toggle('collapsed');
    chevron.classList.toggle('collapsed', isCollapsed);
    try {
      const raw = localStorage.getItem(ACCORDION_KEY);
      const s: Record<string, boolean> = raw ? JSON.parse(raw) : {};
      s[sectionId] = !isCollapsed;
      localStorage.setItem(ACCORDION_KEY, JSON.stringify(s));
    } catch { /* quota */ }
  });
}


// ─── Scenario System ──────────────────────────────────────────

export function createScenarioSystem(
  engine: SimulationEngine,
  renderer: Renderer,
  events: EventBus,
): void {
  // ── State ──
  let activeIdx = -1;       // -1 = no active scenario
  let popupEl: HTMLElement | null = null;
  let badgeEl: HTMLElement | null = null;

  // ── Fit Tank to View ──
  function fitTankToView(def: ScenarioDef): void {
    if (!def.tankCells.length) {
      renderer.recenterView();
      return;
    }
    const gs = TANK_GRID_SPACING;
    const cols = def.tankCells.map(([c]) => c);
    const rows = def.tankCells.map(([, r]) => r);
    const colMin = Math.min(...cols);
    const colMax = Math.max(...cols);
    const rowMin = Math.min(...rows);
    const rowMax = Math.max(...rows);

    // World-space bounding box (each cell spans [col*gs, (col+1)*gs])
    const xMin = colMin * gs;
    const xMax = (colMax + 1) * gs;
    const yMin = rowMin * gs;
    const yMax = (rowMax + 1) * gs;
    const cx = (xMin + xMax) / 2;
    const cy = (yMin + yMax) / 2;
    const worldW = xMax - xMin;
    const worldH = yMax - yMin;

    // Available viewport, accounting for top bar (52px) and mobile tab bar (52px)
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobileVp = vw < 768;
    const availW = vw;
    const availH = vh - 52 - (isMobileVp ? 52 : 0);

    const PAD = 0.85;
    const zoom = Math.max(
      CAMERA_MIN_ZOOM,
      Math.min(CAMERA_MAX_ZOOM, Math.min((availW * PAD) / worldW, (availH * PAD) / worldH)),
    );

    renderer.camera.x = cx;
    renderer.camera.y = cy;
    renderer.camera.zoom = zoom;
  }

  // ── Load a Scenario ──
  function loadScenario(def: ScenarioDef): void {
    const payload: TankPayload = { v: 1, tank: def.tankCells };
    if (def.lights && def.lights.length > 0) payload.lights = def.lights;
    if (def.temps && def.temps.length > 0) payload.temps = def.temps;
    if (Object.keys(def.config).length > 0) payload.config = def.config;

    // Clear organisms/food/virus
    flushWithoutReseed(engine);

    // Always clear all environment sources so scenarios don't inherit stale state
    engine.world.lightSources.length = 0;
    engine.world.temperatureSources.length = 0;
    engine.world.currentSources.length = 0;
    engine.world.nextLightSourceId = 1;
    engine.world.nextTemperatureSourceId = 1;
    engine.world.nextCurrentSourceId = 1;

    // Apply tank shape + environment + config
    applyTankPayload(engine, payload);
    renderer.setWallsDirty();
    engine.world.tankCellsDirty = true;
    engine.world.tankCellsArray = [...engine.world.tankCells];

    // Seed fresh population with the new config
    seedPopulation(engine.world, engine.config);

    // Seed an initial virus strain if the scenario calls for one. The strain
    // values bypass the spontaneous-generation range so the scenario designer
    // can target a specific spot in (spread, damage, lethality) space.
    if (def.seedVirus && engine.config.virusEnabled) {
      const { colorAffinity, spread, damageRate, lethality } = def.seedVirus;
      const strainIdx = createStrain(
        engine.world.virusStrains,
        colorAffinity, spread, damageRate, lethality, [], -1,
      );
      if (strainIdx >= 0) {
        const alive = [...engine.world.organisms.values()].filter(o => o.alive);
        if (alive.length > 0) {
          const victim = alive[Math.floor(Math.random() * alive.length)];
          infectOrganism(engine.world, engine.config, victim.id, strainIdx, engine.world.tick, false);
        }
      }
    }

    // Reset selection state
    renderer.selectedOrganismId = null;
    renderer.selectedSourceType = null;
    renderer.selectedSourceId = null;
    events.emit('organism:selected', { id: null });
    events.emit('source:selected', { type: null, id: null });

    // Reset UI + charts
    events.emit('sim:reset', undefined);
    events.emit('chart:clear', undefined);

    // Recenter and zoom to fit the scenario tank in the viewport
    fitTankToView(def);
  }

  // ── Badge Management ──
  function showBadge(idx: number): void {
    if (!badgeEl) return;
    const scenLabel = badgeEl.querySelector<HTMLElement>('.scenario-badge-label')!;
    scenLabel.textContent = SCENARIOS[idx].title;
    badgeEl.style.display = 'flex';
    // Mark the mobile Scenarios tab as active (dot indicator + tap-to-reference behavior)
    const tabBtn = document.querySelector('.tab-btn[data-tab="scenarios"]') as HTMLElement | null;
    if (tabBtn) tabBtn.dataset.scenarioActive = 'true';
  }

  function hideBadge(): void {
    if (!badgeEl) return;
    badgeEl.style.display = 'none';
    // Clear mobile tab active state
    const tabBtn = document.querySelector('.tab-btn[data-tab="scenarios"]') as HTMLElement | null;
    if (tabBtn) delete tabBtn.dataset.scenarioActive;
  }

  // ── Popup ──
  function closePopup(): void {
    if (!popupEl) return;
    popupEl.classList.remove('visible');
    setTimeout(() => {
      popupEl?.remove();
      popupEl = null;
    }, 250);
  }

  function openPreamble(idx: number): void {
    closePopup();
    const def = SCENARIOS[idx];

    const el = document.createElement('div');
    el.className = 'scenario-popup';

    el.innerHTML = `
      <div class="scenario-popup-header">
        <div class="scenario-popup-header-text">
          <div class="scenario-popup-eyebrow">Lesson ${idx + 1} of ${SCENARIOS.length}</div>
          <div class="scenario-popup-title">${def.title}</div>
          <div class="scenario-popup-subtitle">${def.subtitle}</div>
        </div>
        <button class="scenario-popup-close" aria-label="Close">&times;</button>
      </div>
      <div class="scenario-popup-body">
        ${def.preamble.map(p => `<p class="scenario-preamble-para">${p}</p>`).join('')}
      </div>
      <div class="scenario-popup-footer">
        <span class="scenario-footer-hint">Sim continues running while you read</span>
        <button class="scenario-start-btn">Start Scenario &#9658;</button>
      </div>
    `;

    document.body.appendChild(el);
    popupEl = el;

    // Position centered
    positionPopup(el);

    // Wire close button
    el.querySelector('.scenario-popup-close')!.addEventListener('click', closePopup);

    // Wire start button
    el.querySelector('.scenario-start-btn')!.addEventListener('click', () => {
      activeIdx = idx;
      loadScenario(def);
      showBadge(idx);
      closePopup();
      // Close mobile half-sheet if open
      document.dispatchEvent(new CustomEvent('repsim:close-sheet'));
    });

    // Animate in
    requestAnimationFrame(() => el.classList.add('visible'));
  }

  function openReference(idx: number): void {
    closePopup();
    const def = SCENARIOS[idx];

    const watchHTML = def.watchFor.map(w => `
      <div class="scenario-watch-item">
        <span class="scenario-watch-time">${w.time}</span>
        <span class="scenario-watch-text">${w.text}</span>
      </div>
    `).join('');

    const questionsHTML = def.questions.map((q, i) => `
      <li class="scenario-question-item"><span class="scenario-q-num">${i + 1}.</span> ${q}</li>
    `).join('');

    const el = document.createElement('div');
    el.className = 'scenario-popup';

    el.innerHTML = `
      <div class="scenario-popup-header">
        <div class="scenario-popup-header-text">
          <div class="scenario-popup-eyebrow scenario-active-label">&#9679; Active Scenario</div>
          <div class="scenario-popup-title">${def.title}</div>
        </div>
        <button class="scenario-popup-close" aria-label="Close">&times;</button>
      </div>
      <div class="scenario-popup-body">
        <div class="scenario-section-heading">&#128065; What to Watch For</div>
        <div class="scenario-watch-list">${watchHTML}</div>
        <div class="scenario-section-heading">&#10067; Discussion Questions</div>
        <ol class="scenario-questions-list">${questionsHTML}</ol>
      </div>
      <div class="scenario-popup-footer">
        <button class="scenario-restart-btn">&#8635; Restart</button>
        <button class="scenario-exit-btn">Exit Scenario</button>
      </div>
    `;

    document.body.appendChild(el);
    popupEl = el;

    positionPopup(el);

    el.querySelector('.scenario-popup-close')!.addEventListener('click', closePopup);

    el.querySelector('.scenario-restart-btn')!.addEventListener('click', () => {
      loadScenario(def);
      closePopup();
    });

    el.querySelector('.scenario-exit-btn')!.addEventListener('click', () => {
      activeIdx = -1;
      hideBadge();
      closePopup();
    });

    requestAnimationFrame(() => el.classList.add('visible'));
  }

  function positionPopup(el: HTMLElement): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobileViewport = vw < 768;

    if (isMobileViewport) {
      // On mobile, CSS media query pins the popup between the top bar and tab bar
      // via top/bottom !important overrides — no inline positioning needed.
      return;
    }

    // Desktop: center the popup
    const maxW = Math.min(480, vw - 48);
    el.style.maxWidth = `${maxW}px`;
    const left = Math.max(12, (vw - maxW) / 2);
    el.style.left = `${left}px`;
    const usableH = vh - 52;
    const estimatedH = Math.min(usableH * 0.85, 600);
    const top = Math.max(52, 52 + (usableH - estimatedH) / 2);
    el.style.top = `${top}px`;
  }

  // ── Build Accordion Section ──
  function buildScenariosSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'panel-section';
    section.dataset.section = 'scenarios';

    const header = document.createElement('div');
    header.className = 'section-header';
    header.setAttribute('data-toggle', 'scenarios');
    header.innerHTML = `
      <span class="section-title">Scenarios</span>
      <span class="section-chevron">&#9660;</span>
    `;

    const body = document.createElement('div');
    body.className = 'section-body';
    body.setAttribute('data-body', 'scenarios');

    // Intro hint
    const hint = document.createElement('div');
    hint.className = 'hint-text';
    hint.style.marginBottom = '8px';
    hint.textContent = 'Educational presets for classroom use.';
    body.appendChild(hint);

    // 3 scenario cards
    SCENARIOS.forEach((def, idx) => {
      const card = document.createElement('div');
      card.className = 'scenario-card';
      card.innerHTML = `
        <div class="scenario-card-title">${def.title}</div>
        <div class="scenario-card-subtitle">${def.subtitle}</div>
      `;
      card.addEventListener('click', () => openPreamble(idx));
      body.appendChild(card);
    });

    section.appendChild(header);
    section.appendChild(body);
    wireScenarioAccordion(header, body);

    return section;
  }

  // ── Build Badge ──
  function buildBadge(): HTMLElement {
    const badge = document.createElement('div');
    badge.id = 'scenario-badge';
    badge.className = 'scenario-badge';
    badge.style.display = 'none';
    badge.innerHTML = `
      <span class="scenario-badge-dot">&#9679;</span>
      <span class="scenario-badge-label"></span>
      <button class="scenario-badge-close" title="Exit Scenario">&times;</button>
    `;

    // Click on badge label/dot → open reference popup
    badge.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('scenario-badge-close')) return; // handled separately
      if (activeIdx >= 0) openReference(activeIdx);
    });

    // Close button → exit scenario
    badge.querySelector('.scenario-badge-close')!.addEventListener('click', (e) => {
      e.stopPropagation();
      activeIdx = -1;
      hideBadge();
      closePopup();
    });

    return badge;
  }

  // ── Mobile Integration ──
  // When the mobile Scenarios tab is tapped while a scenario is active,
  // open the reference popup instead of the accordion sheet.
  document.addEventListener('repsim:scenarios-tab-tapped', (e: Event) => {
    if (activeIdx >= 0) {
      e.preventDefault(); // Signals to mobile-layout.ts that we handled it
      openReference(activeIdx);
    }
  });

  // ── Insert into DOM ──
  // Insert scenarios accordion between Simulation and Save & Share sections
  const rightPanel = document.getElementById('repsim-right-panel');
  if (rightPanel) {
    const scenSection = buildScenariosSection();
    const saveShareSection = rightPanel.querySelector('[data-section="save-share"]');
    if (saveShareSection) {
      rightPanel.insertBefore(scenSection, saveShareSection);
    } else {
      // Save & Share not yet inserted (shouldn't happen if called after createUI)
      const controlsSection = rightPanel.querySelector('[data-section="controls"]');
      if (controlsSection) {
        rightPanel.insertBefore(scenSection, controlsSection);
      } else {
        rightPanel.appendChild(scenSection);
      }
    }
  }

  // Insert badge into top-left, after the wordmark
  const wordmark = document.querySelector('.repsim-wordmark');
  if (wordmark) {
    const badge = buildBadge();
    badgeEl = badge;
    wordmark.insertAdjacentElement('afterend', badge);
  }
}


// ─── CSS Injection ────────────────────────────────────────────

export function injectScenarioStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    /* ── Scenario Cards (in accordion) ── */
    .scenario-card {
      padding: 8px 10px;
      border: 1px solid var(--ui-border);
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
      margin-bottom: 5px;
    }
    .scenario-card:last-child { margin-bottom: 0; }
    .scenario-card:hover {
      background: var(--ui-surface-hover);
      border-color: rgba(107, 138, 255, 0.2);
    }
    .scenario-card-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--ui-text);
      margin-bottom: 2px;
    }
    .scenario-card-subtitle {
      font-size: 10px;
      color: var(--ui-text-dim);
      line-height: 1.4;
    }

    /* ── Scenario Badge (top bar) ── */
    .scenario-badge {
      display: flex;
      align-items: center;
      gap: 5px;
      background: var(--ui-accent-dim);
      border: 1px solid rgba(107, 138, 255, 0.25);
      border-radius: 20px;
      padding: 3px 8px 3px 8px;
      font-size: 10px;
      font-weight: 500;
      color: var(--ui-accent);
      cursor: pointer;
      transition: background 0.12s ease;
      user-select: none;
      flex-shrink: 0;
    }
    .scenario-badge:hover {
      background: rgba(107, 138, 255, 0.18);
    }
    .scenario-badge-dot {
      font-size: 7px;
      opacity: 0.8;
    }
    .scenario-badge-label {
      white-space: nowrap;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .scenario-badge-close {
      background: none;
      border: none;
      color: var(--ui-accent);
      opacity: 0.6;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      padding: 0 0 0 2px;
      font-family: var(--ui-font);
      transition: opacity 0.12s ease;
    }
    .scenario-badge-close:hover { opacity: 1; }

    /* ── Scenario Popup ── */
    .scenario-popup {
      position: fixed;
      z-index: 450;
      background: var(--ui-bg-solid);
      border: 1px solid var(--ui-accent);
      border-radius: 12px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: var(--ui-font);
      box-shadow: 0 16px 64px rgba(0, 0, 0, 0.45);
      opacity: 0;
      transform: translateY(10px);
      transition: opacity 0.22s ease, transform 0.22s ease;
      pointer-events: auto;
    }
    .scenario-popup.visible {
      opacity: 1;
      transform: translateY(0);
    }

    .scenario-popup-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 20px 12px;
      border-bottom: 1px solid var(--ui-border);
      flex-shrink: 0;
    }
    .scenario-popup-header-text { flex: 1; min-width: 0; }
    .scenario-popup-eyebrow {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--ui-text-muted);
      margin-bottom: 4px;
    }
    .scenario-active-label { color: var(--ui-accent) !important; }
    .scenario-popup-title {
      font-size: 17px;
      font-weight: 700;
      color: var(--ui-accent);
      letter-spacing: -0.02em;
      margin-bottom: 3px;
    }
    .scenario-popup-subtitle {
      font-size: 11px;
      color: var(--ui-text-dim);
      line-height: 1.4;
    }
    .scenario-popup-close {
      background: none;
      border: none;
      color: var(--ui-text-muted);
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      padding: 0;
      font-family: var(--ui-font);
      flex-shrink: 0;
      margin-top: 2px;
      transition: color 0.12s ease;
    }
    .scenario-popup-close:hover { color: var(--ui-text); }

    .scenario-popup-body {
      flex: 1;
      min-height: 0; /* iOS Safari: allow flex child to shrink below content height */
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      padding: 16px 20px;
      font-size: 12px;
      line-height: 1.65;
      color: var(--ui-text);
    }
    .scenario-popup-body::-webkit-scrollbar { width: 4px; }
    .scenario-popup-body::-webkit-scrollbar-track { background: transparent; }
    .scenario-popup-body::-webkit-scrollbar-thumb { background: var(--ui-border); border-radius: 2px; }

    /* Preamble paragraphs */
    .scenario-preamble-para {
      margin: 0 0 12px 0;
    }
    .scenario-preamble-para:last-child { margin-bottom: 0; }

    /* Watch For + Questions (reference phase) */
    .scenario-section-heading {
      font-size: 12px;
      font-weight: 700;
      color: var(--ui-text);
      margin: 14px 0 8px 0;
      letter-spacing: -0.01em;
    }
    .scenario-section-heading:first-child { margin-top: 0; }

    .scenario-watch-list { display: flex; flex-direction: column; gap: 6px; }
    .scenario-watch-item {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      padding: 6px 8px;
      background: var(--ui-surface);
      border-radius: 6px;
      border-left: 2px solid var(--ui-accent);
    }
    .scenario-watch-time {
      font-size: 10px;
      font-weight: 600;
      color: var(--ui-accent);
      white-space: nowrap;
      flex-shrink: 0;
      margin-top: 1px;
      min-width: 58px;
    }
    .scenario-watch-text {
      font-size: 11px;
      color: var(--ui-text-dim);
      line-height: 1.5;
    }

    .scenario-questions-list {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .scenario-question-item {
      display: flex;
      gap: 8px;
      font-size: 11px;
      color: var(--ui-text-dim);
      line-height: 1.55;
      padding: 6px 8px;
      background: var(--ui-surface);
      border-radius: 6px;
    }
    .scenario-q-num {
      font-weight: 600;
      color: var(--ui-text-muted);
      flex-shrink: 0;
    }

    /* Footer */
    .scenario-popup-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      border-top: 1px solid var(--ui-border);
      flex-shrink: 0;
      gap: 8px;
    }
    .scenario-footer-hint {
      font-size: 10px;
      color: var(--ui-text-muted);
      font-style: italic;
      flex: 1;
    }
    .scenario-start-btn {
      background: var(--ui-accent);
      border: none;
      color: #fff;
      cursor: pointer;
      font-family: var(--ui-font);
      font-size: 12px;
      font-weight: 600;
      padding: 8px 18px;
      border-radius: 7px;
      transition: opacity 0.15s ease;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .scenario-start-btn:hover { opacity: 0.85; }

    .scenario-restart-btn,
    .scenario-exit-btn {
      background: var(--ui-surface);
      border: 1px solid var(--ui-border);
      color: var(--ui-text-dim);
      cursor: pointer;
      font-family: var(--ui-font);
      font-size: 11px;
      font-weight: 500;
      padding: 6px 14px;
      border-radius: 6px;
      transition: all 0.12s ease;
      white-space: nowrap;
    }
    .scenario-restart-btn:hover,
    .scenario-exit-btn:hover {
      background: var(--ui-surface-hover);
      color: var(--ui-text);
    }
    .scenario-exit-btn {
      margin-left: auto;
    }

    /* Mobile: show a shorter badge label on small screens */
    @media (max-width: 480px) {
      .scenario-badge-label {
        max-width: 72px;
      }
    }

    /* Mobile: full-width popup pinned between top bar and tab bar */
    @media (max-width: 767px) {
      .scenario-popup {
        left: 12px !important;
        right: 12px !important;
        max-width: none !important;
        /* Pin to top bar (52px) and bottom tab bar (52px) with small gaps */
        top: 56px !important;
        bottom: 56px !important;
        max-height: none !important;
        /* height is fully defined by top + bottom */
      }
    }

    /* Mobile Scenarios tab: active dot indicator */
    .tab-btn[data-tab="scenarios"][data-scenario-active] {
      position: relative;
      color: var(--ui-accent);
    }
    .tab-btn[data-tab="scenarios"][data-scenario-active]::after {
      content: '';
      position: absolute;
      top: 4px;
      right: 6px;
      width: 6px;
      height: 6px;
      background: var(--ui-accent);
      border-radius: 50%;
      border: 1.5px solid var(--ui-bg-solid);
    }
  `;
  document.head.appendChild(style);
}
