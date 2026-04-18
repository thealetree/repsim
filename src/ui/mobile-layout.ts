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
import { buildQuickRefContent } from './quick-ref';
import { createAboutInline } from './about-panel';

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
  {
    id: 'scenarios',
    label: 'Scenarios',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h6"/><path d="M9 3v6L5 16a2 2 0 001.8 3h10.4A2 2 0 0019 16l-4-7V3"/><path d="M7.5 16h9" stroke-width="1.5"/></svg>',
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
    {
      tabId: 'scenarios',
      originalParent: document.getElementById('repsim-right-panel'),
      getNodes() {
        const panel = document.getElementById('repsim-right-panel');
        if (!panel) return [];
        const scenarios = panel.querySelector('[data-section="scenarios"]');
        return scenarios ? [scenarios] : [];
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

    /* ── Mobile Top Bar Controls ── */

    /* Pause + More buttons: hidden on desktop */
    #repsim-mobile-pause,
    #repsim-mobile-more {
      display: none;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border: none;
      border-radius: 8px;
      background: var(--ui-bg);
      color: var(--ui-text);
      font-size: 14px;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      flex-shrink: 0;
    }
    #repsim-mobile-pause.paused {
      color: var(--ui-accent);
      background: var(--ui-accent-dim);
    }
    #repsim-mobile-more.active {
      color: var(--ui-accent);
      background: var(--ui-accent-dim);
    }
    @media (max-width: ${MOBILE_BREAKPOINT - 1}px) {
      #repsim-mobile-pause,
      #repsim-mobile-more { display: flex; }
    }

    /* Static-content headers inside the top dropdown */
    .top-dropdown-static-header {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ui-text-dim);
      padding: 10px 12px 4px;
      margin-top: 8px;
      border-top: 1px solid var(--ui-border);
    }
    #repsim-top-dropdown-static > *:first-child { border-top: none; margin-top: 0; }
    #repsim-top-dropdown-static .quickref-content.mobile {
      padding: 4px 12px 12px;
    }
    #repsim-top-dropdown-static .about-mobile-inline {
      padding: 4px 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #repsim-top-dropdown-static .about-mobile-inline .about-blurb {
      font-size: 12px;
      line-height: 1.45;
      color: var(--ui-text);
      max-width: none;
    }
    #repsim-top-dropdown-static .about-mobile-inline .about-attribution {
      font-size: 11px;
    }

    /* Top dropdown panel */
    /* Outer is a fixed-positioned container that defines the viewport and
       the visual chrome. It does NOT scroll — iOS Safari has a bug where
       overflow-y on a fixed-positioned element silently refuses touch
       scroll under some conditions. */
    #repsim-top-dropdown {
      display: none;
      position: fixed;
      top: 44px;
      left: 0;
      right: 0;
      bottom: 52px;                      /* stop above the mobile tab bar */
      background: var(--ui-bg-solid);
      border-bottom: 1px solid var(--ui-border);
      z-index: 350;
      font-family: var(--ui-font);
      color: var(--ui-text);
    }
    #repsim-top-dropdown.open { display: block; }

    /* Inner scroll wrapper does the actual scrolling. Being a regular
       (non-fixed) element inside a fixed container, iOS treats it as a
       normal scroll region and touch-drag Just Works. */
    #repsim-top-dropdown-scroll {
      position: absolute;
      inset: 0;
      overflow-y: scroll;
      -webkit-overflow-scrolling: touch; /* smooth iOS inertial scrolling */
      overscroll-behavior: contain;      /* scroll doesn't bubble to the canvas */
      touch-action: pan-y;               /* explicit permission for vertical drag */
      padding: 10px 12px 20px;
    }
    #repsim-top-dropdown-scroll > * + * { margin-top: 10px; }

    .top-dropdown-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .top-dropdown-row .row-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--ui-text-muted);
      text-transform: uppercase;
      width: 50px;
      flex-shrink: 0;
    }
    .top-dropdown-row .row-content {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
    }

    /* Speed buttons in dropdown */
    #repsim-top-dropdown .ui-btn {
      padding: 6px 12px;
      font-size: 12px;
    }

    /* Focus slider in dropdown */
    #repsim-top-dropdown .top-focus-slider {
      width: 100%;
      flex: 1;
    }
    #repsim-top-dropdown .top-focus-label {
      font-size: 11px;
    }

    /* Action buttons in dropdown */
    #repsim-top-dropdown .btn-group {
      display: flex;
      gap: 0;
    }

    /* Tool icons visible inside dropdown (override mobile hide) */
    #repsim-top-dropdown #repsim-tool-icons {
      display: flex !important;
      align-items: center;
      gap: 2px;
    }
    #repsim-top-dropdown .tool-icon {
      width: 36px;
      height: 36px;
    }
    #repsim-top-dropdown .tool-sep {
      height: 20px;
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

  // ── Mobile Top Bar: Pause + More buttons ──
  const pauseBtn = document.createElement('button');
  pauseBtn.id = 'repsim-mobile-pause';
  pauseBtn.innerHTML = '&#10073;&#10073;';
  pauseBtn.title = 'Pause / Play';

  const moreBtn = document.createElement('button');
  moreBtn.id = 'repsim-mobile-more';
  moreBtn.innerHTML = '&#8943;'; // ⋯
  moreBtn.title = 'More controls';

  // Inject pause + more into top bar (after .top-left, before .top-right)
  const topBar = document.getElementById('repsim-top-bar');
  const topRight = topBar?.querySelector('.top-right') as HTMLElement | null;
  if (topBar && topRight) {
    topBar.insertBefore(moreBtn, topRight);
    topBar.insertBefore(pauseBtn, moreBtn);
  }

  // ── Top Dropdown Panel ──
  //
  // The scrollable area is an INNER wrapper (.top-dropdown-scroll), not the
  // fixed-positioned outer element itself. This avoids a long-standing iOS
  // Safari bug where position:fixed + overflow:auto/scroll silently refuses
  // to scroll by touch (especially when html/body have overflow:hidden).
  // The outer element is a static backdrop; the inner is the scroll viewport.
  const topDropdown = document.createElement('div');
  topDropdown.id = 'repsim-top-dropdown';
  topDropdown.className = 'repsim-ui';
  const topDropdownScroll = document.createElement('div');
  topDropdownScroll.id = 'repsim-top-dropdown-scroll';
  topDropdown.appendChild(topDropdownScroll);
  document.body.appendChild(topDropdown);

  // Static sections that always live inside the scroll wrapper (not moved
  // in/out when opening/closing). openTopDropdown re-appends them after the
  // moved content so they stay at the bottom of the stack.
  const staticSections = document.createElement('div');
  staticSections.id = 'repsim-top-dropdown-static';

  const quickHeader = document.createElement('div');
  quickHeader.className = 'top-dropdown-static-header';
  quickHeader.textContent = 'QUICK REFERENCE';
  staticSections.appendChild(quickHeader);
  staticSections.appendChild(buildQuickRefContent(true));

  const aboutHeader = document.createElement('div');
  aboutHeader.className = 'top-dropdown-static-header';
  aboutHeader.textContent = 'ABOUT REPSIM & MUSIC';
  staticSections.appendChild(aboutHeader);
  staticSections.appendChild(createAboutInline());

  topDropdownScroll.appendChild(staticSections);

  let topDropdownOpen = false;
  let topRightNodes: Node[] = [];
  let topRightParent: HTMLElement | null = null;

  // ── Mobile bar swap state: track moved elements ──
  let barFocusGroup: HTMLElement | null = null;
  let barThemeToggle: HTMLElement | null = null;
  let toolIconsDiv: HTMLElement | null = null;
  let toolIconsOriginalParent: HTMLElement | null = null;
  let toolIconsNextSibling: Node | null = null;

  /** Move focus slider + theme toggle into visible bar; record tool icons position */
  function activateMobileBar(): void {
    if (!topBar || !topRight) return;

    // Move focus group from .top-right to before pauseBtn
    const focusGroup = topRight.querySelector('.top-focus-group') as HTMLElement | null;
    if (focusGroup && !barFocusGroup) {
      barFocusGroup = focusGroup;
      focusGroup.classList.add('mobile-bar-focus');
      topBar.insertBefore(focusGroup, pauseBtn);
    }

    // Move theme toggle from .top-right to before pauseBtn
    const themeToggle = topRight.querySelector('#repsim-theme-toggle') as HTMLElement | null;
    if (themeToggle && !barThemeToggle) {
      barThemeToggle = themeToggle;
      topBar.insertBefore(themeToggle, pauseBtn);
    }

    // Record tool icons position for dropdown moves
    const toolIcons = document.getElementById('repsim-tool-icons');
    if (toolIcons && !toolIconsDiv) {
      toolIconsDiv = toolIcons;
      toolIconsOriginalParent = toolIcons.parentElement as HTMLElement;
      toolIconsNextSibling = toolIcons.nextSibling;
    }
  }

  /** Return focus slider + theme toggle to .top-right for desktop */
  function deactivateMobileBar(): void {
    if (!topRight) return;

    // Return focus group as first child of .top-right
    if (barFocusGroup) {
      barFocusGroup.classList.remove('mobile-bar-focus');
      topRight.insertBefore(barFocusGroup, topRight.firstChild);
      barFocusGroup = null;
    }

    // Return theme toggle to end of .top-right
    if (barThemeToggle) {
      topRight.appendChild(barThemeToggle);
      barThemeToggle = null;
    }

    // Tool icons back to .top-left isn't needed here — closeTopDropdown handles it
    // But if dropdown was never opened, they're still in .top-left (hidden by CSS)
    toolIconsDiv = null;
    toolIconsOriginalParent = null;
    toolIconsNextSibling = null;
  }

  function openTopDropdown(): void {
    // Move tool icons into the scroll wrapper first
    if (toolIconsDiv && !topDropdownScroll.contains(toolIconsDiv)) {
      topDropdownScroll.insertBefore(toolIconsDiv, staticSections);
    }

    // Move remaining .top-right children (speed, flush/new) into scroll wrapper
    const tr = document.querySelector('#repsim-top-bar .top-right') as HTMLElement | null;
    if (tr && topRightNodes.length === 0) {
      topRightParent = tr;
      topRightNodes = Array.from(tr.children);
      for (const node of topRightNodes) {
        topDropdownScroll.insertBefore(node, staticSections);
      }
    }

    // Keep static sections (Quick Ref + About) at the bottom of the stack
    topDropdownScroll.appendChild(staticSections);

    topDropdown.classList.add('open');
    moreBtn.classList.add('active');
    topDropdownOpen = true;
  }

  function closeTopDropdown(): void {
    topDropdown.classList.remove('open');
    moreBtn.classList.remove('active');
    topDropdownOpen = false;

    // Return .top-right children (speed, flush/new)
    if (topRightParent && topRightNodes.length > 0) {
      for (const node of topRightNodes) {
        topRightParent.appendChild(node);
      }
      topRightNodes = [];
    }

    // Return tool icons to .top-left (CSS still hides them on mobile)
    if (toolIconsDiv && toolIconsOriginalParent) {
      if (toolIconsNextSibling && toolIconsNextSibling.parentNode === toolIconsOriginalParent) {
        toolIconsOriginalParent.insertBefore(toolIconsDiv, toolIconsNextSibling);
      } else {
        toolIconsOriginalParent.appendChild(toolIconsDiv);
      }
    }
  }

  moreBtn.addEventListener('click', () => {
    if (topDropdownOpen) {
      closeTopDropdown();
    } else {
      openTopDropdown();
    }
  });

  // ── Pause Button ──
  let lastNonZeroSpeed = '1';

  function syncPauseVisual(): void {
    const activeSpeedBtn = document.querySelector('#repsim-speed-controls .ui-btn.active') as HTMLElement | null;
    const currentSpeed = activeSpeedBtn?.dataset.speed ?? '1';
    if (currentSpeed === '0') {
      pauseBtn.innerHTML = '&#9654;';
      pauseBtn.classList.add('paused');
    } else {
      pauseBtn.innerHTML = '&#10073;&#10073;';
      pauseBtn.classList.remove('paused');
      lastNonZeroSpeed = currentSpeed;
    }
  }

  pauseBtn.addEventListener('click', () => {
    const activeSpeedBtn = document.querySelector('#repsim-speed-controls .ui-btn.active') as HTMLElement | null;
    const currentSpeed = activeSpeedBtn?.dataset.speed ?? '1';
    const speedBtns = document.querySelectorAll<HTMLButtonElement>('#repsim-speed-controls .ui-btn');

    if (currentSpeed === '0') {
      // Resume to last speed
      speedBtns.forEach(btn => {
        if (btn.dataset.speed === lastNonZeroSpeed) btn.click();
      });
    } else {
      // Pause
      lastNonZeroSpeed = currentSpeed;
      speedBtns.forEach(btn => {
        if (btn.dataset.speed === '0') btn.click();
      });
    }
    syncPauseVisual();
  });

  // ── Activate mobile bar on initial load ──
  if (isMobile()) {
    activateMobileBar();
  }

  // Watch speed buttons for changes (also fired from dropdown)
  const speedControls = document.getElementById('repsim-speed-controls');
  if (speedControls) {
    speedControls.addEventListener('click', () => {
      requestAnimationFrame(syncPauseVisual);
    });
  }

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
    // Close top dropdown if open
    if (topDropdownOpen) closeTopDropdown();

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

    // If the Scenarios tab is tapped while a scenario is active, dispatch a cancelable
    // event. scenarios.ts calls preventDefault() to signal it handled the tap
    // (opening the reference popup). If handled, close the sheet and return.
    if (tabId === 'scenarios' && btn.hasAttribute('data-scenario-active')) {
      const ev = new CustomEvent('repsim:scenarios-tab-tapped', { cancelable: true });
      if (!document.dispatchEvent(ev)) {
        // scenarios.ts handled it — close sheet if open, don't open accordion
        if (activeTab === 'scenarios') closeSheet();
        return;
      }
    }

    if (activeTab === tabId) {
      closeSheet();
    } else {
      openSheet(tabId);
    }
  });

  // ── External close-sheet requests (e.g. from scenario start button) ──
  document.addEventListener('repsim:close-sheet', () => {
    if (activeTab !== null) closeSheet();
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
      // Crossed to desktop: close everything, return all content
      closeSheet();
      if (topDropdownOpen) closeTopDropdown();
      deactivateMobileBar();
      // Reset content map so it rebuilds fresh next time
      contentMap = null;
    } else {
      // Crossed to mobile: set up mobile bar
      activateMobileBar();
    }
  });
}
