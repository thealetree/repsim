/**
 * tutorial.ts — Interactive tutorial system for Repsim V2
 *
 * A sequence of 13 floating cards that guide first-time users through
 * the simulation's key concepts and UI. Each card is positioned near
 * a relevant UI element with a semi-transparent overlay dimming the rest.
 *
 * Trigger:
 * - Auto-starts after 2s on first visit (localStorage check)
 * - Manual replay via ? button in top bar
 *
 * Persisted via localStorage('repsim-tutorial-done').
 */

import { TUTORIAL_AUTO_DELAY_MS } from '../constants';

// ─── Tutorial Step Definitions ──────────────────────────────

interface TutorialStep {
  title: string;
  body: string;
  /** Optional mobile-specific body — used when the desktop instructions
   *  (e.g. mentioning middle-click) don't apply to a touch device. */
  bodyMobile?: string;
  /** CSS selector for the target element to highlight. null = centered on screen */
  target: string | null;
  /** Mobile-viewport override — desktop-only targets (like the bottom panel) are
   *  hidden under 768px, so we swap to a visible equivalent (e.g. the mobile tab). */
  targetMobile?: string | null;
  /** Preferred card position relative to target */
  position: 'below' | 'above' | 'right' | 'left' | 'center';
  positionMobile?: 'below' | 'above' | 'right' | 'left' | 'center';
  /** Optional hook run when the step is shown — e.g. expand a panel so it's visible. */
  onEnter?: () => void;
  onEnterMobile?: () => void;
}

function isMobileViewport(): boolean {
  return window.innerWidth < 768;
}

const STEPS: TutorialStep[] = [
  {
    title: 'Welcome',
    body: 'Watch natural selection happen in real time!',
    target: null,
    position: 'center',
  },
  {
    title: 'The Organisms',
    body: 'Each creature is a branching tree of colored segments. Colors represent abilities, size determines capability.',
    target: null,
    position: 'center',
  },
  {
    title: 'Green = Energy',
    body: 'Green segments photosynthesize\u2009—\u2009converting light into health. The foundation of every ecosystem.',
    target: null,
    position: 'center',
  },
  {
    title: 'Blue = Energy Reserves',
    body: 'Blue segments store bonus health. They are the stored energy and immune response of an organism.',
    target: null,
    position: 'center',
  },
  {
    title: 'Yellow = Movement',
    body: 'Yellow segments provide thrust. More yellow means faster. They also control depth. These consume energy to generate motion.',
    target: null,
    position: 'center',
  },
  {
    title: 'Red = Attack',
    body: 'Red segments damage nearby organisms on contact, stealing their energy. Predators evolve red.',
    target: null,
    position: 'center',
  },
  {
    title: 'Purple = Reproduction',
    body: 'Organisms with purple segments reproduce sexually on contact\u2009—\u2009mixing genomes from two parents.',
    target: null,
    position: 'center',
  },
  {
    title: 'White = Scavenger',
    body: 'White segments eat food particles dropped by dead organisms. This creates a food chain.',
    target: null,
    position: 'center',
  },
  {
    title: 'Evolution',
    body: 'Healthy organisms reproduce automatically. Children may mutate\u2009—\u2009gaining, losing, or changing segments. The fittest shapes survive.',
    target: null,
    position: 'center',
  },
  {
    title: 'Navigating the Scene',
    body: '<b>Scroll</b> to zoom into an area. <b>Middle-click and drag</b> (or hold <b>Space + drag</b>) to pan. <b>Click</b> any segment to select an organism. Hit the crosshair <b>Center Map</b> button in the bottom-right if you get lost — it fits the whole tank back into view.',
    bodyMobile: '<b>Pinch</b> with two fingers to zoom. <b>Drag</b> with one finger to pan the view. <b>Tap</b> any segment to select an organism. Hit the crosshair <b>Center Map</b> button in the bottom-right if you get lost — it fits the whole tank back into view.',
    target: null,
    position: 'center',
  },
  {
    title: 'Depth \u0026 Focus',
    body: 'Organisms swim at different depths \u2014 blurry ones are deeper, sharp ones are nearer. The Focus slider adjusts which depth appears sharpest, like a microscope.',
    target: '.top-focus-group',
    position: 'below',
  },
  {
    title: 'Tools',
    body: 'Shape the environment: select organisms, edit tank walls, place lights and temperature zones.',
    target: '#repsim-tool-icons',
    position: 'below',
  },
  {
    title: 'Speed',
    body: 'Control simulation speed. Pause to inspect, speed up to watch evolution unfold.',
    target: '#repsim-speed-controls',
    position: 'below',
  },
  {
    title: 'Flush & New',
    body: 'Flush kills all organisms but keeps your tank shape and settings. New resets everything to a fresh start.',
    target: '.btn-group',
    position: 'below',
  },
  {
    title: 'Theme',
    body: 'Toggle between dark and light mode. The simulation adapts its visuals to match.',
    target: '#repsim-theme-toggle',
    position: 'below',
  },
  {
    title: 'Tank Settings',
    body: 'The bottom panel holds environment controls \u2014 ambient Light, Viscosity, Food Decay, and a Day/Night cycle. When a light, temperature, or current source is selected, its radius and intensity sliders appear here too.',
    target: '#repsim-bottom-panel',
    targetMobile: '.tab-btn[data-tab="environment"]',
    position: 'above',
    positionMobile: 'above',
    onEnter: () => {
      const panel = document.getElementById('repsim-bottom-panel');
      const toggle = document.getElementById('repsim-bottom-toggle');
      if (panel && !panel.classList.contains('expanded')) toggle?.click();
    },
  },
  {
    title: 'About Repsim & Music Controls',
    body: 'Another bottom tab opens a panel with a short description of Repsim, credit to creator Van Sanders, and KLADG Radio with his original music. Toggle Autoplay to have a random track start on every visit.',
    bodyMobile: 'On mobile, tap the <b>⋯</b> (more) button at the top right of the screen. The drop-down has quick reference cards and about/music controls at the bottom.',
    target: '#repsim-about-panel',
    targetMobile: '#repsim-mobile-more',
    position: 'above',
    positionMobile: 'below',
    onEnter: () => {
      const panel = document.getElementById('repsim-about-panel');
      const toggle = document.getElementById('repsim-about-toggle');
      if (panel && !panel.classList.contains('expanded')) toggle?.click();
    },
  },
  {
    title: 'Quick Reference',
    body: 'The third bottom tab pops open a cheat-sheet of every segment color plus a few core rules (reproduction, food chain, depth, infection tells). If the tutorial fades from memory, this is the first place to look.',
    bodyMobile: 'The <b>⋯</b> drop-down at the top right also has a Quick Reference cheat-sheet: every segment color plus core rules. If the tutorial fades from memory, this is the first place to look.',
    target: '#repsim-quickref-panel',
    targetMobile: '#repsim-mobile-more',
    position: 'above',
    positionMobile: 'below',
    onEnter: () => {
      const panel = document.getElementById('repsim-quickref-panel');
      const toggle = document.getElementById('repsim-quickref-toggle');
      if (panel && !panel.classList.contains('expanded')) toggle?.click();
    },
  },
  {
    title: 'Settings',
    body: 'Tune parameters, inspect organisms, manage viruses, and share your creations. Hover over any setting for a quick explanation.',
    target: '#repsim-right-panel',
    targetMobile: '.tab-btn[data-tab="settings"]',
    position: 'left',
    positionMobile: 'above',
  },
  {
    title: 'Controls',
    body: 'In the Controls section of the right panel you can toggle Tooltips (hover hints), Field Notes (ambient observations about the sim), and Tips (occasional suggestions for things to try). All three are on by default.',
    target: '[data-section="controls"]',
    targetMobile: '.tab-btn[data-tab="settings"]',
    position: 'left',
    positionMobile: 'above',
    onEnter: () => {
      const section = document.querySelector<HTMLElement>('[data-section="controls"]');
      const body = section?.querySelector<HTMLElement>('.section-body');
      const chevron = section?.querySelector<HTMLElement>('.section-chevron');
      if (body?.classList.contains('collapsed')) {
        body.classList.remove('collapsed');
        chevron?.classList.remove('collapsed');
      }
      section?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
  },
  {
    title: 'Scenarios',
    body: 'Try guided lessons that demonstrate specific biology concepts like directional selection and genetic drift. Each scenario sets up a custom environment with teacher-friendly explanations.',
    target: '[data-section="scenarios"]',
    position: 'left',
  },
  {
    title: 'Charts',
    body: 'Track population, segments, and evolution over time. Both side panels can be collapsed with their edge arrows.',
    target: '#repsim-left-panel',
    position: 'right',
  },
  {
    title: 'Go!',
    body: 'Experiment, observe, and let evolution surprise you. Press <b>?</b> anytime to replay this guide.',
    target: null,
    position: 'center',
  },
];

// Color accents for segment color steps (indices 2-7)
const STEP_COLORS: Record<number, string> = {
  2: '#44cc66', // green
  3: '#4488ff', // blue
  4: '#ccaa22', // yellow
  5: '#dd4444', // red
  6: '#9944cc', // purple (matches actual segment color)
  7: '#cccccc', // white
};

// ─── Storage ────────────────────────────────────────────────

const STORAGE_KEY = 'repsim-tutorial-done';

function isTutorialDone(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'yes';
}

function markTutorialDone(): void {
  localStorage.setItem(STORAGE_KEY, 'yes');
}

// ─── Tutorial System ────────────────────────────────────────

export interface TutorialSystem {
  /** Start (or restart) the tutorial from step 0 */
  start(): void;
  /** Clean up DOM elements */
  destroy(): void;
}

export function createTutorialSystem(): TutorialSystem {
  let overlay: HTMLElement | null = null;
  let card: HTMLElement | null = null;
  let highlightEl: HTMLElement | null = null;
  let active = false;

  function createOverlay(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tutorial-overlay';
    document.body.appendChild(el);
    return el;
  }

  function createCard(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'tutorial-card';
    document.body.appendChild(el);
    return el;
  }

  function removeHighlight(): void {
    if (highlightEl) {
      highlightEl.classList.remove('tutorial-highlight');
      highlightEl = null;
    }
  }

  function positionCard(cardEl: HTMLElement, step: TutorialStep): void {
    const mobile = isMobileViewport();
    const targetSelector = mobile && step.targetMobile !== undefined ? step.targetMobile : step.target;
    const position = mobile && step.positionMobile ? step.positionMobile : step.position;
    const targetEl = targetSelector ? document.querySelector<HTMLElement>(targetSelector) : null;

    if (targetEl) {
      // Highlight the target
      removeHighlight();
      targetEl.classList.add('tutorial-highlight');
      highlightEl = targetEl;

      const tr = targetEl.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Measure card
      cardEl.style.left = '0';
      cardEl.style.top = '0';
      const cr = cardEl.getBoundingClientRect();

      let left = 0;
      let top = 0;

      switch (position) {
        case 'below':
          left = tr.left + tr.width / 2 - cr.width / 2;
          top = tr.bottom + 12;
          break;
        case 'above':
          left = tr.left + tr.width / 2 - cr.width / 2;
          top = tr.top - cr.height - 12;
          break;
        case 'right':
          left = tr.right + 12;
          top = tr.top + tr.height / 2 - cr.height / 2;
          break;
        case 'left':
          left = tr.left - cr.width - 12;
          top = tr.top + tr.height / 2 - cr.height / 2;
          break;
        default:
          left = vw / 2 - cr.width / 2;
          top = vh / 2 - cr.height / 2;
      }

      // Clamp to viewport
      if (left < 12) left = 12;
      if (left + cr.width > vw - 12) left = vw - 12 - cr.width;
      if (top < 52) top = 52; // below top bar
      if (top + cr.height > vh - 12) top = vh - 12 - cr.height;

      cardEl.style.left = `${left}px`;
      cardEl.style.top = `${top}px`;
    } else {
      // Center on screen
      removeHighlight();
      cardEl.style.left = '0';
      cardEl.style.top = '0';
      const cr = cardEl.getBoundingClientRect();
      cardEl.style.left = `${(window.innerWidth - cr.width) / 2}px`;
      cardEl.style.top = `${(window.innerHeight - cr.height) / 2}px`;
    }
  }

  function renderStep(stepIdx: number): void {
    if (stepIdx < 0 || stepIdx >= STEPS.length) {
      stop();
      return;
    }

    const step = STEPS[stepIdx];

    // Run side-effects — e.g. expand a panel or open the mobile sheet so the
    // target actually exists / is visible before we try to highlight it.
    const mobile = isMobileViewport();
    const enter = mobile && step.onEnterMobile ? step.onEnterMobile : step.onEnter;
    if (enter) {
      try { enter(); } catch { /* best-effort */ }
    }

    if (!overlay) overlay = createOverlay();
    if (!card) card = createCard();

    // Color accent for segment color steps
    const accentColor = STEP_COLORS[stepIdx] ?? 'var(--ui-accent)';

    // Build step indicator dots
    let dots = '<div class="tutorial-dots">';
    for (let i = 0; i < STEPS.length; i++) {
      const cls = i === stepIdx ? 'tutorial-dot active' : 'tutorial-dot';
      dots += `<span class="${cls}"></span>`;
    }
    dots += '</div>';

    const body = mobile && step.bodyMobile ? step.bodyMobile : step.body;
    card.innerHTML = `
      <div class="tutorial-title" style="color:${accentColor}">${step.title}</div>
      <div class="tutorial-body">${body}</div>
      ${dots}
      <div class="tutorial-actions">
        <button class="tutorial-skip">Skip</button>
        <button class="tutorial-next">${stepIdx === STEPS.length - 1 ? 'Finish' : 'Next'}</button>
      </div>
    `;

    // Wire buttons
    card.querySelector('.tutorial-skip')!.addEventListener('click', stop);
    card.querySelector('.tutorial-next')!.addEventListener('click', () => {
      renderStep(stepIdx + 1);
    });

    // Show with animation
    overlay.classList.add('visible');
    card.classList.remove('visible'); // reset
    positionCard(card, step);
    requestAnimationFrame(() => card!.classList.add('visible'));
  }

  function stop(): void {
    if (!active) return;
    active = false;
    removeHighlight();
    if (overlay) {
      overlay.classList.remove('visible');
      setTimeout(() => { overlay?.remove(); overlay = null; }, 300);
    }
    if (card) {
      card.classList.remove('visible');
      setTimeout(() => { card?.remove(); card = null; }, 300);
    }
    markTutorialDone();
  }

  function start(): void {
    if (active) stop();
    active = true;
    renderStep(0);
  }

  return {
    start,
    destroy(): void {
      stop();
    },
  };
}

// ─── ? Button (Top Bar) ────────────────────────────────────

export function createTutorialButton(tutorial: TutorialSystem): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'ui-btn-icon';
  btn.id = 'repsim-tutorial-btn';
  btn.textContent = '?';
  btn.title = 'Tutorial';
  btn.style.cssText = 'font-weight:700;font-size:14px;';
  btn.addEventListener('click', () => tutorial.start());
  return btn;
}

// ─── Auto-start on first visit ──────────────────────────────

export function autoStartTutorial(tutorial: TutorialSystem): void {
  if (!isTutorialDone()) {
    setTimeout(() => tutorial.start(), TUTORIAL_AUTO_DELAY_MS);
  }
}

// ─── CSS (injected once) ────────────────────────────────────

export function injectTutorialStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    /* ── Tutorial Overlay ── */
    .tutorial-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 290;
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: auto;
    }
    .tutorial-overlay.visible {
      opacity: 1;
    }

    /* ── Tutorial Card ── */
    .tutorial-card {
      position: fixed;
      z-index: 300;
      background: var(--ui-bg-solid);
      border: 1px solid var(--ui-accent);
      border-radius: 10px;
      padding: 16px 20px;
      max-width: 280px;
      min-width: 220px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
      font-family: var(--ui-font);
      opacity: 0;
      transform: translateY(8px);
      transition: opacity 0.25s ease, transform 0.25s ease;
      pointer-events: auto;
    }
    .tutorial-card.visible {
      opacity: 1;
      transform: translateY(0);
    }

    .tutorial-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--ui-accent);
      margin-bottom: 6px;
      letter-spacing: -0.01em;
    }

    .tutorial-body {
      font-size: 12px;
      line-height: 1.6;
      color: var(--ui-text);
      margin-bottom: 12px;
    }

    /* ── Step Dots ── */
    .tutorial-dots {
      display: flex;
      justify-content: center;
      gap: 4px;
      margin-bottom: 10px;
    }
    .tutorial-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--ui-border);
      transition: background 0.2s;
    }
    .tutorial-dot.active {
      background: var(--ui-accent);
    }

    /* ── Actions ── */
    .tutorial-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .tutorial-skip {
      background: none;
      border: none;
      color: var(--ui-text-muted);
      cursor: pointer;
      font-family: var(--ui-font);
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 4px;
      transition: color 0.15s;
    }
    .tutorial-skip:hover {
      color: var(--ui-text);
    }
    .tutorial-next {
      background: var(--ui-accent);
      border: none;
      color: #fff;
      cursor: pointer;
      font-family: var(--ui-font);
      font-size: 11px;
      font-weight: 600;
      padding: 6px 14px;
      border-radius: 6px;
      transition: opacity 0.15s;
    }
    .tutorial-next:hover {
      opacity: 0.85;
    }

    /* ── Target Highlight ── */
    .tutorial-highlight {
      position: relative;
      z-index: 295;
      box-shadow: 0 0 0 4px rgba(107, 138, 255, 0.3),
                  0 0 16px rgba(107, 138, 255, 0.2);
      border-radius: 6px;
      animation: tutorial-pulse 1.5s ease-in-out infinite;
    }
    @keyframes tutorial-pulse {
      0%, 100% { box-shadow: 0 0 0 4px rgba(107, 138, 255, 0.3), 0 0 16px rgba(107, 138, 255, 0.2); }
      50% { box-shadow: 0 0 0 6px rgba(107, 138, 255, 0.5), 0 0 24px rgba(107, 138, 255, 0.3); }
    }
  `;
  document.head.appendChild(style);
}
