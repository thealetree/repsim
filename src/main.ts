/**
 * main.ts — Entry point for Repsim V2
 *
 * This file wires everything together:
 * 1. Creates the event bus (communication backbone)
 * 2. Creates the simulation engine (game logic at fixed 20 ticks/sec)
 * 3. Creates the renderer (PixiJS visuals at 60fps)
 * 4. Runs the game loop (requestAnimationFrame)
 *
 * The game loop:
 * - Measures real elapsed time since last frame
 * - Feeds it to the simulation engine (which runs fixed-rate ticks internally)
 * - Gets the interpolation alpha (for smooth rendering between ticks)
 * - Renders the current world state
 */

import { createEventBus } from './events';
import { createSimulationEngine } from './simulation/engine';
import { createRenderer } from './rendering/renderer';
import { createUI } from './ui/ui';
import { createTooltipSystem, injectTooltipStyles } from './ui/tooltips';
import { createChartSystem, injectChartStyles } from './ui/charts';
import { parseUrlParams, injectSaveShareStyles, autoSave, autoRestore, loadOrganismFromInspector } from './ui/save-share';
import { createTutorialSystem, createTutorialButton, autoStartTutorial, injectTutorialStyles } from './ui/tutorial';
import { createEnvironmentPanel, injectEnvironmentPanelStyles } from './ui/environment-panel';
import { injectAboutPanelStyles, createAboutPanel } from './ui/about-panel';
import { createQuickRefPanel } from './ui/quick-ref';
import { createScenarioSystem, injectScenarioStyles } from './ui/scenarios';
import { createFieldNotes } from './ui/field-notes';
import { setupMobileLayout } from './ui/mobile-layout';
import { DEFAULT_CONFIG, TANK_HALF_WIDTH, TANK_HALF_HEIGHT } from './constants';
import { spawnOrganismFromGenome } from './simulation/world';

/**
 * Main initialization — async because PixiJS init is async.
 */
async function main(): Promise<void> {
  console.log('🧬 Repsim V2 — Starting up...');

  // ── 1. Event Bus ──
  // All communication between systems goes through here
  const events = createEventBus();

  // ── 2. Simulation Engine ──
  // Creates the world, seeds organisms, runs physics at fixed timestep
  const config = { ...DEFAULT_CONFIG, redTargets: [...DEFAULT_CONFIG.redTargets] };
  const engine = createSimulationEngine(events, config);
  console.log(`🔬 World created: ${config.repCount} organisms seeded`);

  // ── 3. Renderer ──
  // PixiJS canvas with petri dish background and segment sprites
  const renderer = await createRenderer(window.innerWidth, window.innerHeight);

  // ── 4. Attach canvas to the page ──
  const appDiv = document.getElementById('app')!;
  appDiv.appendChild(renderer.getCanvas());

  // ── 5. Tooltip System ──
  injectTooltipStyles();
  const tooltips = createTooltipSystem();

  // Field Notes sets up globals that the UI's toggle checkboxes read from,
  // so initialize it BEFORE createUI. The module has no UI dependencies of
  // its own — it creates its pill + modal imperatively.
  createFieldNotes(engine, events);

  // ── 6. UI Layer ──
  createUI(engine, renderer, events, tooltips);

  // ── 7. Charts (Left Panel) ──
  injectChartStyles();
  createChartSystem(engine, events, tooltips);

  // ── 8. Save/Share System ──
  injectSaveShareStyles();
  await parseUrlParams(engine, renderer);

  // ── 8a. Auto-restore from localStorage (if no URL params) ──
  const urlHasParams = window.location.search.length > 1;
  if (!urlHasParams) {
    const restored = autoRestore(engine);
    if (restored) console.log('🧬 Restored autosave');
  }

  // ── 8a2. Inspector export — spawn edited rep returned from Inspector ──
  const inspectorOrg = await loadOrganismFromInspector();
  if (inspectorOrg) {
    const px = (Math.random() * 2 - 1) * TANK_HALF_WIDTH * 0.6;
    const py = (Math.random() * 2 - 1) * TANK_HALF_HEIGHT * 0.6;
    spawnOrganismFromGenome(engine.world, inspectorOrg.genome, px, py, engine.config, inspectorOrg.generation, 0);
    console.log(`🔬 Rep returned from Inspector: "${inspectorOrg.name}"`);
    // Brief toast
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(20,20,40,0.92);color:#a0c4ff;border:1px solid rgba(100,150,255,0.3);border-radius:8px;padding:8px 18px;font-family:Inter,sans-serif;font-size:13px;z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.3s;';
    toast.textContent = `🔬 Rep "${inspectorOrg.name}" returned from Inspector`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 350); }, 2500);
  }

  // ── 8b. Bottom Environment Panel ──
  injectAboutPanelStyles();
  injectEnvironmentPanelStyles();
  createEnvironmentPanel(engine, renderer, events, tooltips);
  createAboutPanel();
  createQuickRefPanel();

  // Note: no top-bar About button. On desktop the About drawer is the entry
  // point; on mobile the About content is inlined into the top dropdown
  // (see mobile-layout.ts).

  // ── 8c. Mobile Layout ──
  setupMobileLayout(engine, renderer, events);

  // ── 9a. Scenario System ──
  injectScenarioStyles();
  createScenarioSystem(engine, renderer, events);

  // ── 9. Tutorial System ──
  injectTutorialStyles();
  const tutorial = createTutorialSystem();
  const tutorialBtn = createTutorialButton(tutorial);
  // Insert ? button at rightmost position in top bar
  const topRight = document.querySelector('.top-right')!;
  topRight.appendChild(tutorialBtn);
  tooltips.attach(tutorialBtn, 'tutorial-btn');
  autoStartTutorial(tutorial);

  // ── 10. Game Loop ──
  // requestAnimationFrame runs at screen refresh rate (typically 60fps).
  // Each frame we:
  //   a) Measure real elapsed time
  //   b) Feed it to the simulation (which runs fixed 20Hz ticks internally)
  //   c) Render the result
  let lastTime = performance.now();

  function gameLoop(currentTime: number): void {
    // How much real time has passed since last frame? (in seconds)
    const deltaMs = currentTime - lastTime;
    lastTime = currentTime;
    const deltaSeconds = deltaMs / 1000;

    // Update simulation — may run 0, 1, or multiple fixed ticks internally
    engine.update(deltaSeconds);

    // Render with interpolation alpha for potentially smoother visuals
    const alpha = engine.getAlpha();
    renderer.render(engine.world, alpha);

    // Schedule next frame
    requestAnimationFrame(gameLoop);
  }

  // Kick off the loop!
  requestAnimationFrame(gameLoop);
  console.log('🧬 Repsim V2 — Running!');

  // ── 11. Auto-save every 15 seconds ──
  setInterval(() => autoSave(engine), 15_000);

  // ── Debug: expose engine for console inspection ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__engine = engine;
  (window as any).__renderer = renderer;

  // ── 7. Handle window resize ──
  window.addEventListener('resize', () => {
    renderer.resize(window.innerWidth, window.innerHeight);
  });
}

// Go!
main().catch(console.error);
