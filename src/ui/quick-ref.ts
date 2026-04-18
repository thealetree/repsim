/**
 * quick-ref.ts — Quick Reference drawer
 *
 * A third bottom drawer that gives users a persistent, glanceable card of
 * what each segment color does + a short note about the core dynamics they
 * might forget after the tutorial. Returning to this is cheap — no modal,
 * no dig through menus.
 *
 * Exposes:
 * - injectQuickRefStyles() — CSS for the drawer + inline mobile variant
 * - createQuickRefPanel() — desktop: creates the bottom panel + registers
 *   its toggle with the shared bottom toggle bar.
 * - buildQuickRefContent() — returns a fresh DOM element containing the
 *   same content, for reuse in the mobile top-dropdown.
 */

import { registerDrawer } from './bottom-drawers';
import { SEGMENT_RENDER_COLORS } from '../constants';

interface SegmentCard {
  color: string;       // CSS rgb() computed from SEGMENT_RENDER_COLORS
  name: string;
  role: string;
  note: string;
}

function hexInt(hex: number): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgb(${r}, ${g}, ${b})`;
}

const CARDS: SegmentCard[] = [
  {
    color: hexInt(SEGMENT_RENDER_COLORS[0]),
    name: 'Green',
    role: 'Photosynthesis',
    note: 'Absorbs light; the foundation of every food web.',
  },
  {
    color: hexInt(SEGMENT_RENDER_COLORS[1]),
    name: 'Blue',
    role: 'HP Reserve & Immunity',
    note: 'Stores bonus energy and speeds recovery from viral infection.',
  },
  {
    color: hexInt(SEGMENT_RENDER_COLORS[2]),
    name: 'Yellow',
    role: 'Movement',
    note: 'Provides thrust. More yellow = faster (and hungrier).',
  },
  {
    color: hexInt(SEGMENT_RENDER_COLORS[3]),
    name: 'Red',
    role: 'Attack',
    note: 'Damages nearby enemy segments of enabled target colors.',
  },
  {
    color: hexInt(SEGMENT_RENDER_COLORS[4]),
    name: 'Purple',
    role: 'Sexual Reproduction',
    note: 'Two purple reps near each other mix genes on contact.',
  },
  {
    color: hexInt(SEGMENT_RENDER_COLORS[5]),
    name: 'White',
    role: 'Scavenger',
    note: 'Lets any org eat food particles dropped by the dead.',
  },
];

const EXTRAS = [
  {
    title: 'Reproduction',
    body: 'Organisms reproduce automatically when their energy fills. Children inherit the parent\'s body plan with small random mutations — sometimes adding, losing, or recoloring segments.',
  },
  {
    title: 'Food Chain',
    body: 'Dead organisms drop food particles. White-bearing reps can eat them; reds steal energy directly by attacking.',
  },
  {
    title: 'Depth Layers',
    body: 'Reps swim at different depths. Only same-depth organisms interact (collide, attack). The Focus slider picks which depth appears sharpest.',
  },
  {
    title: 'Infection Tells',
    body: 'Infected reps show dark, muted segments in the virus\'s target color and may move with a twitchy wobble.',
  },
];

// ── Styles ───────────────────────────────────────────────────

export function injectQuickRefStyles(): void {
  if (document.getElementById('repsim-quick-ref-styles')) return;
  const style = document.createElement('style');
  style.id = 'repsim-quick-ref-styles';
  style.textContent = `
    #repsim-quickref-panel {
      position: fixed;
      bottom: 0;
      left: 240px;
      right: 220px;
      height: 0;
      max-height: 170px;
      background: var(--ui-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-top: 1px solid var(--ui-border);
      z-index: 95;
      overflow: hidden;
      transition: height 0.25s ease, left 0.2s ease, right 0.2s ease;
      font-family: var(--ui-font);
      color: var(--ui-text);
    }
    #repsim-quickref-panel.expanded { height: 170px; }

    .quickref-content {
      display: flex;
      gap: 18px;
      padding: 12px 18px;
      height: 100%;
      overflow-x: auto;
      overflow-y: auto;
      align-items: flex-start;
    }
    /* Cards are uniform width (sized to fit the longest note over 3 lines)
       and flow as a flex-wrap row. No stretching — each card stays snug. */
    .quickref-cards {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      flex: 0 1 auto;
    }
    .quickref-card {
      flex: 0 0 auto;
      width: 200px;
      display: grid;
      grid-template-columns: 10px 1fr;
      gap: 8px;
      align-items: start;
      padding: 6px 8px;
      background: var(--ui-surface);
      border: 1px solid var(--ui-border);
      border-radius: 6px;
    }
    .quickref-swatch {
      width: 10px;
      height: 10px;
      margin-top: 4px;
      border-radius: 50%;
      box-shadow: 0 0 6px currentColor;
    }
    .quickref-card-body {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    .quickref-card-name {
      font-size: 10.5px;
      font-weight: 600;
      color: var(--ui-text);
      line-height: 1.25;
    }
    .quickref-card-role {
      font-size: 9px;
      color: var(--ui-text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .quickref-card-note {
      font-size: 10px;
      color: var(--ui-text-muted);
      line-height: 1.35;
      margin-top: 2px;
    }

    .quickref-extras {
      flex: 1 1 300px;
      min-width: 260px;
      max-width: 420px;
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 8px 12px;
      padding-left: 18px;
      border-left: 1px solid var(--ui-border);
    }
    .quickref-extra {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .quickref-extra-title {
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ui-text-dim);
    }
    .quickref-extra-body {
      font-size: 10px;
      color: var(--ui-text-muted);
      line-height: 1.35;
    }

    /* Narrow desktop fallback — extras collapse to a single column */
    @media (max-width: 1200px) {
      .quickref-extras { grid-template-columns: 1fr; }
    }

    /* Mobile inline (inside top dropdown) — stack the two sections vertically */
    .quickref-content.mobile {
      flex-direction: column;
      padding: 0;
      overflow: visible;
      gap: 12px;
      height: auto;                  /* override desktop's height:100% so the
                                        flex column sizes to content, not to
                                        the scroll wrapper */
    }
    .quickref-content.mobile .quickref-cards {
      justify-content: flex-start;
      flex: 0 0 auto;                /* don't stretch vertically */
    }
    .quickref-content.mobile .quickref-card {
      width: calc(50% - 6px);         /* two uniform cards per row on mobile */
    }
    .quickref-content.mobile .quickref-extras {
      border-left: none;
      padding-left: 0;
      padding-top: 10px;
      border-top: 1px solid var(--ui-border);
      grid-template-columns: 1fr;
      flex: 0 0 auto;                /* THE BUG — was inheriting flex:1 1 300px
                                        from desktop, which made the extras grid
                                        grow to fill the column and leave a big
                                        blank gap between the last extra and the
                                        About section below. */
    }

    /* Hide the desktop bottom panel on mobile — content lives inline in the top dropdown */
    @media (max-width: 767px) {
      #repsim-quickref-panel { display: none !important; }
    }
  `;
  document.head.appendChild(style);
}


// ── Content builder (shared desktop + mobile) ────────────────

/** Build a fresh DOM element containing the Quick Reference content. */
export function buildQuickRefContent(mobile = false): HTMLElement {
  const root = document.createElement('div');
  root.className = 'quickref-content' + (mobile ? ' mobile' : '');

  const cardsWrap = document.createElement('div');
  cardsWrap.className = 'quickref-cards';
  for (const c of CARDS) {
    const card = document.createElement('div');
    card.className = 'quickref-card';
    const escapedName = escapeHTML(c.name);
    const escapedRole = escapeHTML(c.role);
    const escapedNote = escapeHTML(c.note);
    card.innerHTML = `
      <span class="quickref-swatch" style="background:${c.color};color:${c.color}"></span>
      <div class="quickref-card-body">
        <span class="quickref-card-name">${escapedName}</span>
        <span class="quickref-card-role">${escapedRole}</span>
        <span class="quickref-card-note">${escapedNote}</span>
      </div>
    `;
    cardsWrap.appendChild(card);
  }
  root.appendChild(cardsWrap);

  const extrasWrap = document.createElement('div');
  extrasWrap.className = 'quickref-extras';
  for (const e of EXTRAS) {
    const item = document.createElement('div');
    item.className = 'quickref-extra';
    item.innerHTML = `
      <span class="quickref-extra-title">${escapeHTML(e.title)}</span>
      <span class="quickref-extra-body">${escapeHTML(e.body)}</span>
    `;
    extrasWrap.appendChild(item);
  }
  root.appendChild(extrasWrap);

  return root;
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;');
}


// ── Desktop drawer ───────────────────────────────────────────

export function createQuickRefPanel(): void {
  injectQuickRefStyles();

  const panel = document.createElement('div');
  panel.id = 'repsim-quickref-panel';
  panel.appendChild(buildQuickRefContent(false));
  document.body.appendChild(panel);

  registerDrawer({
    id: 'quickref',
    labelClosed: '▲ Quick Reference',
    labelOpen: '▼ Quick Reference',
    panel,
  });

  // Follow side-panel edges like the other bottom drawers
  function syncEdges(): void {
    const leftPanel = document.getElementById('repsim-left-panel');
    const rightPanel = document.getElementById('repsim-right-panel');
    const leftRight = leftPanel ? leftPanel.getBoundingClientRect().right : 0;
    const vpWidth = window.innerWidth;
    const rightLeft = rightPanel ? rightPanel.getBoundingClientRect().left : vpWidth;
    const newLeft = `${Math.max(0, leftRight)}px`;
    const newRight = `${Math.max(0, vpWidth - rightLeft)}px`;
    if (panel.style.left !== newLeft) panel.style.left = newLeft;
    if (panel.style.right !== newRight) panel.style.right = newRight;
  }
  setInterval(syncEdges, 150);
  window.addEventListener('resize', syncEdges);
}
