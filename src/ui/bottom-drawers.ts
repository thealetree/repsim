/**
 * bottom-drawers.ts — Shared infrastructure for the row of bottom drawers
 *
 * The bottom of the viewport hosts several "drawers" (Tank Settings, About,
 * Quick Reference, …). Each drawer has a toggle button at the bottom-center.
 * The buttons sit side-by-side inside a single flex container so we can add
 * more drawers without re-doing fixed positioning for each.
 *
 * When any drawer is expanded, the whole container slides up above the panel.
 * Opening one drawer closes any other via the `repsim:close-bottom-panels`
 * custom event (detail.except = my-id) — each drawer's own open handler
 * dispatches it and each listens for it.
 */

// ── Styles ───────────────────────────────────────────────────

export function injectBottomDrawerStyles(): void {
  if (document.getElementById('repsim-bottom-drawers-styles')) return;
  const style = document.createElement('style');
  style.id = 'repsim-bottom-drawers-styles';
  style.textContent = `
    #repsim-bottom-toggle-bar {
      position: fixed;
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 4px;
      z-index: 96;
      transition: bottom 0.25s ease;
      pointer-events: none; /* children re-enable */
    }
    #repsim-bottom-toggle-bar.any-expanded { bottom: 170px; }
    #repsim-bottom-toggle-bar > button {
      pointer-events: auto;
      padding: 0 14px;
      height: 22px;
      background: var(--ui-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--ui-border);
      border-bottom: none;
      border-radius: 6px 6px 0 0;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      white-space: nowrap;
      color: var(--ui-text-muted);
      font-family: var(--ui-font);
    }
    #repsim-bottom-toggle-bar > button:hover { color: var(--ui-text); }
    #repsim-bottom-toggle-bar > button.expanded { color: var(--ui-text); }

    /* Hide the whole toggle bar on mobile — mobile access is via the top dropdown. */
    @media (max-width: 767px) {
      #repsim-bottom-toggle-bar { display: none !important; }
    }
  `;
  document.head.appendChild(style);
}


// ── Bar management ───────────────────────────────────────────

let bar: HTMLElement | null = null;
let expandedCount = 0;

/** Get or create the shared toggle bar container. */
export function getBottomToggleBar(): HTMLElement {
  if (bar) return bar;
  injectBottomDrawerStyles();
  bar = document.createElement('div');
  bar.id = 'repsim-bottom-toggle-bar';
  document.body.appendChild(bar);
  return bar;
}

/** Signal that a drawer has expanded — slides the whole bar up if needed. */
function onDrawerExpanded(): void {
  expandedCount++;
  getBottomToggleBar().classList.add('any-expanded');
}

/** Signal that a drawer has collapsed. */
function onDrawerCollapsed(): void {
  expandedCount = Math.max(0, expandedCount - 1);
  if (expandedCount === 0) {
    getBottomToggleBar().classList.remove('any-expanded');
  }
}


// ── Drawer registration ──────────────────────────────────────

export interface DrawerHandle {
  toggle: HTMLButtonElement;
  panel: HTMLElement;
  expand(on: boolean): void;
}

export interface DrawerSpec {
  /** Unique id used in mutual-exclusion events. */
  id: string;
  /** Text content for the toggle button, e.g. "▲ Tank Settings". */
  labelClosed: string;
  labelOpen: string;
  /** The panel element (already created and in the DOM). Mutual exclusion
   *  and expand/collapse state is managed here; the drawer itself owns its
   *  inner content. */
  panel: HTMLElement;
}

/**
 * Create a toggle button inside the shared bar, wire it to the given panel,
 * and return a handle that lets the caller expand/collapse programmatically.
 * Mutual exclusion with other drawers is handled automatically.
 */
export function registerDrawer(spec: DrawerSpec): DrawerHandle {
  const bar = getBottomToggleBar();

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.id = `repsim-${spec.id}-toggle`;
  toggle.textContent = spec.labelClosed;
  bar.appendChild(toggle);

  let expanded = false;

  function applyExpanded(on: boolean): void {
    if (on === expanded) return;
    expanded = on;
    spec.panel.classList.toggle('expanded', on);
    toggle.classList.toggle('expanded', on);
    toggle.textContent = on ? spec.labelOpen : spec.labelClosed;
    if (on) onDrawerExpanded();
    else onDrawerCollapsed();
  }

  toggle.addEventListener('click', () => {
    if (!expanded) {
      document.dispatchEvent(
        new CustomEvent('repsim:close-bottom-panels', { detail: { except: spec.id } }),
      );
    }
    applyExpanded(!expanded);
  });

  document.addEventListener('repsim:close-bottom-panels', (e) => {
    const detail = (e as CustomEvent).detail as { except?: string } | undefined;
    if (detail?.except === spec.id) return;
    if (expanded) applyExpanded(false);
  });

  return {
    toggle,
    panel: spec.panel,
    expand: applyExpanded,
  };
}
