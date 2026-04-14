/**
 * tooltips.ts — Delayed hover tooltip system for Repsim V2
 *
 * A single reusable tooltip element positioned near hovered UI elements.
 * Tooltips appear after an 800ms hover delay and can be globally toggled off.
 * Persisted in localStorage so the preference survives reloads.
 */

import { TOOLTIP_DELAY_MS, TOOLTIP_MAX_WIDTH } from '../constants';

// ─── Tooltip Content Map ─────────────────────────────────────
// Keyed by data-tooltip attribute value on each element.

const TOOLTIP_TEXTS: Record<string, string> = {
  // Top bar stats
  'stat-pop': 'Current number of living organisms',
  'stat-births': 'Total organisms born since simulation start',
  'stat-deaths': 'Total organisms died since simulation start',
  'stat-time': 'Elapsed simulation time (speeds up with sim speed)',

  // Tool icons
  'tool-select': 'Select tool — click organisms to inspect',
  'tool-tank': 'Tank tool — click/drag to paint or erase walls',
  'tool-light': 'Light tool — click to place, scroll to resize, drag to move',
  'tool-temp': 'Temperature tool — click to place heat/cold zones',
  'tool-current': 'Current tool — click to place a water flow or whirlpool; drag to move, scroll to resize',

  // Speed controls
  'speed-pause': 'Pause simulation',
  'speed-1': 'Normal speed (20 ticks/sec)',
  'speed-2': 'Double speed',
  'speed-4': 'Quadruple speed',
  'speed-8': '8× speed (may affect performance with many organisms)',

  // Top bar buttons
  'empty': 'Remove all organisms without repopulating — keeps tank shape, lights, and settings',
  'flush': 'Kill all organisms and reseed — keeps tank shape, lights, and settings',
  'new-tank': 'Reset everything with a fresh tank and population',
  'theme-toggle': 'Switch between dark and light theme',
  'tutorial-btn': 'Show the interactive tutorial',

  // Focus depth
  'focus-slider': 'Adjust focal depth — organisms at this depth appear sharpest',

  // Config sliders
  'slider-repCount': 'Number of organisms to seed when creating a new tank',
  'slider-repLimit': 'Maximum population cap — organisms stop reproducing above this',
  'slider-greenFeed': 'Energy gained per photosynthesis cycle (green segments)',
  'slider-blueHP': 'Extra health capacity per blue segment',
  'slider-yellowFreq': 'Movement speed — how often yellow segments fire thrust',
  'slider-redDamage': 'Damage dealt per red segment attack',
  'slider-purpleCost': 'Health cost to reproduce sexually (purple segments)',
  'slider-asexMutationRate': 'Mutation chance per gene during asexual reproduction (%)',
  'slider-sexMutationRate': 'Mutation chance per gene during sexual reproduction (%)',
  'slider-sexGeneComboRate': 'Chance of picking the recessive parent\'s gene during crossover (%)',

  // Virus controls
  'virus-enabled': 'Enable the evolved parasite system — viruses emerge and evolve',
  'virus-virulence': 'How aggressively viruses drain host energy',
  'virus-transmission': 'How easily viruses spread between organisms on contact',
  'virus-immunity': 'How long before an organism develops immunity to a strain',
  'virus-release': 'Manually introduce a new random virus strain into the population',

  // Save/Share
  'share-org': 'Copy a shareable URL for this organism\'s genome',
  'share-copy-url': 'Generate a compressed URL with the selected components',

  // Chart panels (brief labels)
  'chart-population': 'Total living organisms over time',
  'chart-colors': 'Segment color distribution over time',
  'chart-birthsdeath': 'Birth and death rates over time',
  'chart-genomelength': 'Average number of segments per organism over time',
  'chart-generation': 'Average and maximum generation depth over time',
  'chart-diversity': 'Number of unique species (genome fingerprints) over time',
  'chart-virus': 'Infected organisms (green) and active virus strains (yellow) over time',

  // Tank Settings (Environment panel)
  'env-light': 'Base photosynthesis energy — how much food green segments produce per tick',
  'env-viscosity': 'Global fluid thickness — higher values slow all movement',
  'env-food-decay': 'How long dead-segment food particles persist before dissolving',
  'env-daynight-toggle': 'Enable a day/night cycle that dims light sources over time',
  'env-daynight-speed': 'How fast the day/night cycle progresses',

  // Tooltips toggle itself
  'tooltips-toggle': 'Show or hide hover tooltips on UI elements',
};

// ─── Tooltip System ──────────────────────────────────────────

export interface TooltipSystem {
  /** Attach a tooltip to an element by its data-tooltip key */
  attach(element: HTMLElement, key: string): void;
  /** Manually attach with explicit text (no key lookup) */
  attachText(element: HTMLElement, text: string): void;
  /** Set tooltip visibility globally */
  setEnabled(enabled: boolean): void;
  /** Get current enabled state */
  isEnabled(): boolean;
  /** Clean up */
  destroy(): void;
}

const STORAGE_KEY = 'repsim-tooltips';

export function createTooltipSystem(): TooltipSystem {
  // Create the single tooltip element
  const tooltip = document.createElement('div');
  tooltip.className = 'repsim-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  document.body.appendChild(tooltip);

  let hoverTimer = 0;
  let enabled = localStorage.getItem(STORAGE_KEY) !== 'off';
  const cleanups: Array<() => void> = [];

  function show(target: HTMLElement, text: string): void {
    if (!enabled || !text) return;
    hoverTimer = window.setTimeout(() => {
      tooltip.textContent = text;
      tooltip.classList.add('visible');
      position(tooltip, target);
    }, TOOLTIP_DELAY_MS);
  }

  function hide(): void {
    clearTimeout(hoverTimer);
    tooltip.classList.remove('visible');
  }

  function position(tip: HTMLElement, target: HTMLElement): void {
    const tr = target.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Measure tooltip with visibility hidden to get real dimensions
    tip.style.left = '0';
    tip.style.top = '0';
    const tipRect = tip.getBoundingClientRect();

    // Default: centered below target
    let left = tr.left + tr.width / 2 - tipRect.width / 2;
    let top = tr.bottom + 8;

    // Flip above if too close to bottom
    if (top + tipRect.height > vh - 8) {
      top = tr.top - tipRect.height - 8;
    }

    // Clamp horizontal
    if (left < 8) left = 8;
    if (left + tipRect.width > vw - 8) left = vw - 8 - tipRect.width;

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function attachHandlers(element: HTMLElement, text: string): void {
    const onEnter = () => show(element, text);
    const onLeave = () => hide();

    element.addEventListener('mouseenter', onEnter);
    element.addEventListener('mouseleave', onLeave);
    // Also hide on click (tooltip shouldn't linger after clicking)
    element.addEventListener('mousedown', onLeave);

    cleanups.push(() => {
      element.removeEventListener('mouseenter', onEnter);
      element.removeEventListener('mouseleave', onLeave);
      element.removeEventListener('mousedown', onLeave);
    });
  }

  return {
    attach(element: HTMLElement, key: string): void {
      const text = TOOLTIP_TEXTS[key];
      if (text) {
        element.setAttribute('data-tooltip', key);
        attachHandlers(element, text);
      }
    },

    attachText(element: HTMLElement, text: string): void {
      attachHandlers(element, text);
    },

    setEnabled(value: boolean): void {
      enabled = value;
      localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
      if (!value) hide();
    },

    isEnabled(): boolean {
      return enabled;
    },

    destroy(): void {
      for (const fn of cleanups) fn();
      cleanups.length = 0;
      clearTimeout(hoverTimer);
      tooltip.remove();
    },
  };
}

// ─── CSS (injected once) ─────────────────────────────────────

export function injectTooltipStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    .repsim-tooltip {
      position: fixed;
      z-index: 200;
      background: var(--ui-bg-solid);
      border: 1px solid var(--ui-border);
      border-radius: 6px;
      padding: 6px 10px;
      font-family: var(--ui-font);
      font-size: 11px;
      line-height: 1.4;
      color: var(--ui-text);
      max-width: ${TOOLTIP_MAX_WIDTH}px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s ease;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
      white-space: normal;
    }
    .repsim-tooltip.visible {
      opacity: 1;
    }
  `;
  document.head.appendChild(style);
}
