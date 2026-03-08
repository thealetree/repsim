/**
 * mobile-layout.ts — Mobile tab bar + half-sheet overlay system
 *
 * On screens <768px, hides desktop side panels and shows:
 * - A bottom tab bar with 4 tabs (Charts, Env, Settings, Organism)
 * - A half-sheet overlay that slides up with the selected tab's content
 * - Swipe-to-dismiss on the sheet handle
 *
 * Content is MOVED (not cloned) between desktop panels and the sheet,
 * preserving all event listeners. On resize above 768px, content is
 * returned to desktop panels seamlessly.
 */

import type { SimulationEngine } from '../simulation/engine';
import type { Renderer } from '../rendering/renderer';
import type { EventBus } from '../events';

// ─── Breakpoint ──────────────────────────────────────────────

const MOBILE_BREAKPOINT = 768;

export function isMobile(): boolean {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

// ─── Tab Definitions ─────────────────────────────────────────

interface TabDef {
  id: string;
  label: string;
  icon: string; // SVG string
}

const TABS: TabDef[] = [
  {
    id: 'charts',
    label: 'Charts',
    icon: '<svg viewBox="0 0 24 24"><rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="7" width="4" height="14" rx="1"/><rect x="17" y="3" width="4" height="18" rx="1"/></svg>',
  },
  {
    id: 'environment',
    label: 'Env',
    icon: '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 8h16M4 16h16"/><circle cx="8" cy="8" r="2.5"/><circle cx="16" cy="16" r="2.5"/></svg>',
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: '<svg viewBox="0 0 24 24"><path d="M12 15.5A3.5 3.5 0 1 0 12 8.5a3.5 3.5 0 0 0 0 7zm7.43-2.53c.04-.32.07-.64.07-.97s-.03-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.04 7.04 0 0 0-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.49.49 0 0 0 .12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.39 1.08.73 1.69.98l.38 2.65c.05.24.26.42.49.42h4c.24 0 .44-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1a.5.5 0 0 0 .61-.22l2-3.46a.49.49 0 0 0-.12-.64l-2.11-1.65z"/></svg>',
  },
  {
    id: 'organism',
    label: 'Organism',
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 8v4m-4 3c0-2.2 1.8-4 4-4s4 1.8 4 4m-8 0v4m8-4v4"/></svg>',
  },
];

// ─── Content Mapping ─────────────────────────────────────────

interface ContentSlot {
  tabId: string;
  getNodes(): Node[];
  originalParent: HTMLElement | null;
}

function buildContentMap(): ContentSlot[] {
  return [
    {
      tabId: 'charts',
      originalParent: document.getElementById('repsim-left-panel'),
      getNodes() {
        const panel = document.getElementById('repsim-left-panel');
        return panel ? Array.from(panel.children) : [];
      },
    },
    {
      tabId: 'environment',
      originalParent: null, // set lazily
      getNodes() {
        const content = document.querySelector('#repsim-bottom-panel .bottom-panel-content');
        if (!content) return [];
        this.originalParent = content as HTMLElement;
        return Array.from(content.children);
      },
    },
    {
      tabId: 'settings',
      originalParent: document.getElementById('repsim-right-panel'),
      getNodes() {
        const panel = document.getElementById('repsim-right-panel');
        if (!panel) return [];
        const sim = panel.querySelector('[data-section="sim"]');
        const virus = panel.querySelector('[data-section="virus"]');
        return [sim, virus].filter(Boolean) as Node[];
      },
    },
    {
      tabId: 'organism',
      originalParent: document.getElementById('repsim-right-panel'),
      getNodes() {
        const panel = document.getElementById('repsim-right-panel');
        if (!panel) return [];
        const org = panel.querySelector('[data-section="organism"]');
        const share = panel.querySelector('[data-section="save-share"]');
        const controls = panel.querySelector('[data-section="controls"]');
        return [org, share, controls].filter(Boolean) as Node[];
      },
    },
  ];
}

// ─── CSS Injection ───────────────────────────────────────────

function injectMobileStyles(): void {
  if (document.getElementById('repsim-mobile-styles')) return;
  const style = document.createElement('style');
  style.id = 'repsim-mobile-styles';
  style.textContent = `
    /* Tab Bar — hidden on desktop, flex on mobile */
    #repsim-tab-bar {
      display: none;
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      height: 52px;
      background: var(--ui-bg-solid);
      border-top: 1px solid var(--ui-border);
      align-items: center;
      justify-content: space-around;
      z-index: 400;
      padding: 0 4px;
      padding-bottom: env(safe-area-inset-bottom, 0);
      font-family: var(--ui-font);
    }
    @media (max-width: ${MOBILE_BREAKPOINT - 1}px) {
      #repsim-tab-bar { display: flex; }
    }

    .tab-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      background: none;
      border: none;
      color: var(--ui-text-muted);
      cursor: pointer;
      padding: 6px 12px;
      border-radius: 8px;
      font-family: var(--ui-font);
      font-size: 9px;
      font-weight: 500;
      transition: color 0.15s, background 0.15s;
      -webkit-tap-highlight-color: transparent;
    }
    .tab-btn.active {
      color: var(--ui-accent);
      background: var(--ui-accent-dim);
    }
    .tab-btn svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }

    /* Sheet Backdrop */
    #repsim-sheet-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.3);
      z-index: 398;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
    }
    #repsim-sheet-backdrop.visible {
      opacity: 1;
      pointer-events: auto;
    }

    /* Half-Sheet — hidden on desktop, flex on mobile */
    #repsim-sheet {
      display: none;
      position: fixed;
      bottom: 52px;
      left: 0;
      right: 0;
      max-height: 60vh;
      background: var(--ui-bg-solid);
      border-top: 1px solid var(--ui-border);
      border-radius: 16px 16px 0 0;
      z-index: 399;
      transform: translateY(100%);
      transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1);
      overflow: hidden;
      flex-direction: column;
      font-family: var(--ui-font);
      color: var(--ui-text);
    }
    #repsim-sheet.open {
      transform: translateY(0);
    }
    @media (max-width: ${MOBILE_BREAKPOINT - 1}px) {
      #repsim-sheet { display: flex; }
    }

    @supports (padding-bottom: env(safe-area-inset-bottom)) {
      #repsim-sheet {
        bottom: calc(52px + env(safe-area-inset-bottom, 0));
      }
    }

    @media (orientation: landscape) and (max-width: ${MOBILE_BREAKPOINT - 1}px) {
      #repsim-sheet { max-height: 50vh; }
    }

    .sheet-handle {
      width: 36px;
      height: 4px;
      background: var(--ui-border);
      border-radius: 2px;
      margin: 8px auto 4px;
      flex-shrink: 0;
    }

    #repsim-sheet-content {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 4px 12px 12px;
      -webkit-overflow-scrolling: touch;
    }
    #repsim-sheet-content::-webkit-scrollbar { width: 4px; }
    #repsim-sheet-content::-webkit-scrollbar-thumb {
      background: var(--ui-border);
      border-radius: 2px;
    }

    /* Sections inside sheet: inherit panel styles */
    #repsim-sheet-content .panel-section {
      border-bottom: 1px solid var(--ui-border);
    }
    #repsim-sheet-content .section-body {
      max-height: 500px;
      opacity: 1;
      padding: 0 10px 10px;
    }

    /* Bottom panel sections inside sheet: stack vertically, full width */
    #repsim-sheet-content .bottom-panel-section {
      display: flex;
      flex-direction: column;
      min-width: 0;
      white-space: normal;
      padding: 8px 0;
      border-bottom: 1px solid var(--ui-border);
    }
    #repsim-sheet-content .bottom-panel-section:last-child {
      border-bottom: none;
    }

    /* Charts in sheet: full width */
    #repsim-sheet-content canvas {
      width: 100% !important;
    }
  `;
  document.head.appendChild(style);
}

// ─── Main Setup ──────────────────────────────────────────────

export function setupMobileLayout(
  _engine: SimulationEngine,
  _renderer: Renderer,
  events: EventBus,
): void {
  injectMobileStyles();

  // ── Build DOM ──
  const tabBar = document.createElement('div');
  tabBar.id = 'repsim-tab-bar';
  tabBar.className = 'repsim-ui';

  for (const tab of TABS) {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = tab.id;
    btn.innerHTML = `${tab.icon}<span>${tab.label}</span>`;
    tabBar.appendChild(btn);
  }

  const backdrop = document.createElement('div');
  backdrop.id = 'repsim-sheet-backdrop';

  const sheet = document.createElement('div');
  sheet.id = 'repsim-sheet';
  sheet.className = 'repsim-ui';
  sheet.innerHTML = `
    <div class="sheet-handle" id="repsim-sheet-handle"></div>
    <div id="repsim-sheet-content"></div>
  `;

  document.body.appendChild(tabBar);
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);

  const sheetContent = document.getElementById('repsim-sheet-content')!;
  const sheetHandle = document.getElementById('repsim-sheet-handle')!;

  // ── Content mapping (lazy, built on first mobile activation) ──
  let contentMap: ContentSlot[] | null = null;
  let activeTab: string | null = null;
  let movedNodes: { nodes: Node[]; originalParent: HTMLElement }[] = [];

  function ensureContentMap(): ContentSlot[] {
    if (!contentMap) contentMap = buildContentMap();
    return contentMap;
  }

  // ── Open / Close Sheet ──

  function openSheet(tabId: string): void {
    // Close current if different tab
    if (activeTab && activeTab !== tabId) {
      returnContent();
    }

    const map = ensureContentMap();
    const slot = map.find(s => s.tabId === tabId);
    if (!slot) return;

    // Move content into sheet
    sheetContent.innerHTML = '';
    const nodes = slot.getNodes();
    const parent = slot.originalParent;
    if (parent && nodes.length > 0) {
      movedNodes = [{ nodes: [...nodes], originalParent: parent }];
      for (const node of nodes) {
        sheetContent.appendChild(node);
      }
    }

    // Activate visuals
    activeTab = tabId;
    sheet.classList.add('open');
    backdrop.classList.add('visible');

    // Update tab buttons
    tabBar.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.tab === tabId);
    });
  }

  function closeSheet(): void {
    returnContent();
    activeTab = null;
    sheet.classList.remove('open');
    sheet.style.transform = '';
    backdrop.classList.remove('visible');

    tabBar.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.remove('active');
    });
  }

  function returnContent(): void {
    for (const { nodes, originalParent } of movedNodes) {
      for (const node of nodes) {
        originalParent.appendChild(node);
      }
    }
    movedNodes = [];
    sheetContent.innerHTML = '';
  }

  // ── Tab bar click ──

  tabBar.addEventListener('click', (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('.tab-btn') as HTMLElement | null;
    if (!btn) return;
    const tabId = btn.dataset.tab!;

    if (activeTab === tabId) {
      closeSheet();
    } else {
      openSheet(tabId);
    }
  });

  // ── Backdrop click ──
  backdrop.addEventListener('click', () => closeSheet());

  // ── Swipe-to-dismiss ──
  let swipeStartY = 0;
  let swipeCurrentY = 0;
  let isSwiping = false;

  sheetHandle.addEventListener('touchstart', (e: TouchEvent) => {
    swipeStartY = e.touches[0].clientY;
    swipeCurrentY = 0;
    isSwiping = true;
    sheet.style.transition = 'none';
  }, { passive: true });

  sheetHandle.addEventListener('touchmove', (e: TouchEvent) => {
    if (!isSwiping) return;
    const dy = e.touches[0].clientY - swipeStartY;
    if (dy > 0) {
      swipeCurrentY = dy;
      sheet.style.transform = `translateY(${dy}px)`;
    }
  }, { passive: true });

  sheetHandle.addEventListener('touchend', () => {
    if (!isSwiping) return;
    isSwiping = false;
    sheet.style.transition = '';
    if (swipeCurrentY > 80) {
      closeSheet();
    } else {
      sheet.style.transform = 'translateY(0)';
    }
    swipeCurrentY = 0;
  });

  // ── Auto-open organism tab on selection ──
  events.on('organism:selected', (data) => {
    if (data.id !== null && isMobile() && activeTab !== 'organism') {
      openSheet('organism');
    }
  });

  // ── Resize handler: switch between mobile and desktop ──
  let wasMobile = isMobile();

  window.addEventListener('resize', () => {
    const nowMobile = isMobile();
    if (nowMobile === wasMobile) return;
    wasMobile = nowMobile;

    if (!nowMobile) {
      // Crossed to desktop: close sheet, return all content
      closeSheet();
      // Reset content map so it rebuilds fresh next time
      contentMap = null;
    }
  });
}
