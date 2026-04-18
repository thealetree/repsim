/**
 * about-panel.ts — "About" section for the bottom panel + mobile modal
 *
 * Adds:
 * - A short blurb explaining what Repsim is
 * - Attribution to Van Sanders + link to wanderingwojo.com
 * - A compact KLADG Radio music player streaming Van's original tracks
 *
 * Desktop: rendered as a section inside the bottom Tank Settings panel.
 * Mobile: same content rendered inside an "About" modal opened from a
 * small link in the top bar. Both share the same DOM ids so the audio
 * player's event listeners stay valid across responsive switches.
 *
 * Data: track + art manifests are copied from the Wandering Wojo project
 * into Repsim's public/data/ directory. Audio + cover art stream from
 * https://kladg.com (no CORS needed for <audio>/<img>).
 */

import { registerDrawer } from './bottom-drawers';

interface KladgTrack {
  id: string;
  title: string;
  artId?: string;
  archiveUrl?: string;
  localUrl?: string;
}

interface KladgArt {
  id: string;
  filename: string;
}

const KLADG_TRACKS_URL = 'data/kladg-tracks.json';
const KLADG_ART_URL = 'data/kladg-art.json';
const KLADG_BASE = 'https://kladg.com';
const WANDERING_WOJO_URL = 'https://wanderingwojo.com';
const AUTOPLAY_KEY = 'repsim-kladg-autoplay';
const DEFAULT_AUTOPLAY = false;

function loadAutoplay(): boolean {
  try {
    const v = localStorage.getItem(AUTOPLAY_KEY);
    if (v === 'on') return true;
    if (v === 'off') return false;
  } catch { /* disabled */ }
  return DEFAULT_AUTOPLAY;
}
function saveAutoplay(on: boolean): void {
  try { localStorage.setItem(AUTOPLAY_KEY, on ? 'on' : 'off'); } catch { /* noop */ }
}

// ── Styles ───────────────────────────────────────────────────

export function injectAboutPanelStyles(): void {
  if (document.getElementById('repsim-about-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'repsim-about-panel-styles';
  style.textContent = `
    /* ── Full-width About panel (desktop) ─────────────────────── */
    #repsim-about-panel {
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
    #repsim-about-panel.expanded { height: 170px; }

    .about-panel-content {
      display: flex;
      gap: 32px;
      padding: 14px 20px;
      height: 100%;
      overflow-y: auto;
      align-items: flex-start;
    }
    .about-panel-blurb-col {
      flex: 1 1 0;
      min-width: 240px;
      max-width: 520px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .about-panel-music-col {
      flex: 1 1 0;
      min-width: 280px;
      max-width: 480px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .about-blurb {
      font-size: 10.5px;
      line-height: 1.5;
      color: var(--ui-text-dim);
      max-width: 380px;
    }
    .about-attribution {
      font-size: 10px;
      color: var(--ui-text-muted);
      line-height: 1.5;
    }
    .about-attribution a,
    .about-link {
      color: var(--ui-accent);
      text-decoration: none;
      border-bottom: 1px dotted currentColor;
    }
    .about-attribution a:hover,
    .about-link:hover { color: var(--ui-text); }

    /* Music player strip */
    .kladg-player {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      background: var(--ui-surface);
      border: 1px solid var(--ui-border);
      border-radius: 6px;
    }
    .kladg-player__art {
      width: 34px;
      height: 34px;
      flex-shrink: 0;
      border-radius: 4px;
      object-fit: cover;
      background: var(--ui-bar-bg);
    }
    .kladg-player__body {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      overflow: hidden;
    }
    .kladg-player__label {
      font-size: 9px;
      color: var(--ui-text-muted);
      letter-spacing: 0.05em;
      text-transform: uppercase;
      line-height: 1;
    }
    .kladg-player__title {
      font-size: 11px;
      color: var(--ui-text);
      text-decoration: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.3;
    }
    .kladg-player__title:hover { color: var(--ui-accent); }
    .kladg-player__controls {
      display: flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }
    .kladg-player__btn {
      width: 24px;
      height: 24px;
      padding: 0;
      font-family: var(--ui-font);
      font-size: 13px;
      line-height: 1;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--ui-text-dim);
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .kladg-player__btn:hover {
      background: var(--ui-bg);
      color: var(--ui-text);
    }
    .kladg-player__btn--play {
      color: var(--ui-accent);
    }

    /* Autoplay row — small toggle under the player */
    .kladg-autoplay-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 0 2px;
    }
    .kladg-autoplay-label {
      font-size: 10px;
      color: var(--ui-text-muted);
      letter-spacing: 0.03em;
    }
    .kladg-autoplay-wrap {
      position: relative;
      display: inline-block;
      width: 28px;
      height: 16px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .kladg-autoplay-wrap input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .kladg-autoplay-track {
      position: absolute;
      inset: 0;
      background: var(--ui-slider-track);
      border-radius: 8px;
      transition: background 0.15s;
    }
    .kladg-autoplay-dot {
      position: absolute;
      left: 2px;
      top: 2px;
      width: 12px;
      height: 12px;
      background: var(--ui-text-muted);
      border-radius: 50%;
      transition: left 0.15s, background 0.15s;
    }
    .kladg-autoplay-wrap input:checked ~ .kladg-autoplay-track {
      background: var(--ui-accent-dim);
    }
    .kladg-autoplay-wrap input:checked ~ .kladg-autoplay-dot {
      left: 14px;
      background: var(--ui-accent);
    }

    /* Modal for mobile / small screens — reuses the glassmorphic pattern */
    .about-modal {
      position: fixed;
      inset: 0;
      z-index: 450;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.4);
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    .about-modal.visible { opacity: 1; }
    .about-modal-card {
      width: min(440px, calc(100vw - 32px));
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
    .about-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px 10px;
      border-bottom: 1px solid var(--ui-border);
    }
    .about-modal-eyebrow {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.1em;
      color: var(--ui-text-dim);
    }
    .about-modal-close {
      background: transparent;
      border: none;
      color: var(--ui-text-muted);
      cursor: pointer;
      font: 20px var(--ui-font);
      padding: 0 4px;
      line-height: 1;
    }
    .about-modal-close:hover { color: var(--ui-text); }
    .about-modal-body {
      overflow-y: auto;
      padding: 14px 18px 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .about-modal-body .about-blurb { max-width: none; font-size: 12px; }
    .about-modal-body .about-attribution { font-size: 11px; }
    .about-modal-body .kladg-player__label { font-size: 10px; }
    .about-modal-body .kladg-player__title { font-size: 12px; }

    /* Top-bar About button — visible on both desktop + mobile */
    #repsim-about-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 8px;
      height: 22px;
      font-family: var(--ui-font);
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ui-text-muted);
      background: transparent;
      border: 1px solid var(--ui-border);
      border-radius: 4px;
      cursor: pointer;
      transition: color 0.12s, border-color 0.12s;
    }
    #repsim-about-btn:hover { color: var(--ui-text); border-color: var(--ui-accent); }

    /* ── Mobile: hide desktop bottom about panel (toggle hidden via shared bar) ── */
    @media (max-width: 767px) {
      #repsim-about-panel { display: none !important; }
    }
  `;
  document.head.appendChild(style);
}


// ── Content (shared HTML) ────────────────────────────────────

const ABOUT_BLURB =
  'A browser-based evolution toy. Colored segments form tree-shaped "reps" that photosynthesize, hunt, reproduce, mutate, and die — selection does the rest.';

/** Build the About section content. Uses a prefix so desktop + modal don't collide on ids. */
function aboutContentHTML(idPrefix: string): string {
  return `
    <div class="about-blurb">${ABOUT_BLURB}</div>
    <div class="about-attribution">
      Created by Van Sanders &middot;
      <a href="${WANDERING_WOJO_URL}" target="_blank" rel="noopener noreferrer">wanderingwojo.com</a>
    </div>
    <div class="kladg-player" id="${idPrefix}-player">
      <img class="kladg-player__art" id="${idPrefix}-art" alt="" />
      <div class="kladg-player__body">
        <span class="kladg-player__label">KLADG Radio &middot; Original music by Van</span>
        <a class="kladg-player__title" id="${idPrefix}-title" href="${KLADG_BASE}" target="_blank" rel="noopener noreferrer">Loading…</a>
      </div>
      <div class="kladg-player__controls">
        <button class="kladg-player__btn" id="${idPrefix}-prev" type="button" title="Previous" aria-label="Previous">\u23EE</button>
        <button class="kladg-player__btn kladg-player__btn--play" id="${idPrefix}-play" type="button" title="Play / pause" aria-label="Play">\u25B6</button>
        <button class="kladg-player__btn" id="${idPrefix}-next" type="button" title="Next" aria-label="Next">\u23ED</button>
      </div>
    </div>
    <div class="kladg-autoplay-row">
      <span class="kladg-autoplay-label">Autoplay on arrival</span>
      <label class="kladg-autoplay-wrap">
        <input type="checkbox" id="${idPrefix}-autoplay" class="kladg-autoplay-checkbox">
        <span class="kladg-autoplay-track"></span>
        <span class="kladg-autoplay-dot"></span>
      </label>
    </div>
  `;
}


// ── KLADG Player (shared audio element across desktop + mobile DOM) ──

// Single Audio element + playlist shared by both render targets so
// switching between the desktop panel and the mobile modal keeps playback state.
const kladgState: {
  audio: HTMLAudioElement | null;
  tracks: KladgTrack[];
  artMap: Map<string, string>;
  history: KladgTrack[];
  historyIndex: number;
  isPlaying: boolean;
  autoplay: boolean;         // Persisted preference; gates auto-advance on track end + initial auto-start
  initialAutoplayTried: boolean;
  loadPromise: Promise<void> | null;
  mounts: Array<{ prefix: string }>;
} = {
  audio: null,
  tracks: [],
  artMap: new Map(),
  history: [],
  historyIndex: -1,
  isPlaying: false,
  autoplay: loadAutoplay(),
  initialAutoplayTried: false,
  loadPromise: null,
  mounts: [],
};

function ensureKladgData(): Promise<void> {
  if (kladgState.loadPromise) return kladgState.loadPromise;
  kladgState.loadPromise = Promise.all([
    fetch(KLADG_TRACKS_URL).then(r => r.json() as Promise<KladgTrack[]>),
    fetch(KLADG_ART_URL).then(r => r.json() as Promise<KladgArt[]>),
  ]).then(([tracks, art]) => {
    kladgState.tracks = tracks;
    for (const a of art) kladgState.artMap.set(a.id, a.filename);
  }).catch((err) => {
    console.warn('KLADG Radio data failed to load:', err);
  });
  return kladgState.loadPromise;
}

function pickRandom(): KladgTrack | null {
  const tracks = kladgState.tracks;
  if (tracks.length === 0) return null;
  const recent = kladgState.history.slice(-10).map(h => h.id);
  const candidates = tracks.filter(t => !recent.includes(t.id));
  const pool = candidates.length > 0 ? candidates : tracks;
  return pool[Math.floor(Math.random() * pool.length)];
}

function loadTrack(track: KladgTrack | null, autoplay: boolean): void {
  if (!track || !kladgState.audio) return;
  const urlPath = track.archiveUrl || track.localUrl || '';
  kladgState.audio.src = KLADG_BASE + urlPath;
  kladgState.audio.load();

  const h = kladgState.history;
  if (kladgState.historyIndex < 0 || h[kladgState.historyIndex]?.id !== track.id) {
    h.length = kladgState.historyIndex + 1;
    h.push(track);
    kladgState.historyIndex = h.length - 1;
  }

  const artFile = track.artId ? kladgState.artMap.get(track.artId) : undefined;
  const artUrl = artFile ? `${KLADG_BASE}/art/${artFile}` : '';
  const trackUrl = `${KLADG_BASE}/#/track/${track.id}`;
  updateAllMounts(track.title, artUrl, trackUrl);

  if (autoplay) {
    kladgState.audio.play().then(() => {
      kladgState.isPlaying = true;
      updateAllPlayButtons();
    }).catch(() => { /* autoplay blocked — wait for user */ });
  }
}

function updateAllMounts(title: string, artUrl: string, trackUrl: string): void {
  for (const { prefix } of kladgState.mounts) {
    const titleEl = document.getElementById(`${prefix}-title`) as HTMLAnchorElement | null;
    const artEl = document.getElementById(`${prefix}-art`) as HTMLImageElement | null;
    if (titleEl) {
      titleEl.textContent = title;
      titleEl.href = trackUrl;
    }
    if (artEl) {
      if (artUrl) {
        artEl.src = artUrl;
        artEl.style.display = '';
      } else {
        artEl.removeAttribute('src');
        artEl.style.display = 'none';
      }
    }
  }
}

function updateAllPlayButtons(): void {
  const icon = kladgState.isPlaying ? '\u23F8' : '\u25B6';
  for (const { prefix } of kladgState.mounts) {
    const btn = document.getElementById(`${prefix}-play`);
    if (btn) btn.textContent = icon;
  }
}

function togglePlay(): void {
  if (!kladgState.audio || !kladgState.audio.src) return;
  if (kladgState.isPlaying) {
    kladgState.audio.pause();
    kladgState.isPlaying = false;
  } else {
    kladgState.audio.play().catch(() => { /* noop */ });
    kladgState.isPlaying = true;
  }
  updateAllPlayButtons();
}

function skipNext(): void {
  const track = pickRandom();
  if (track) loadTrack(track, true);
}

function skipPrev(): void {
  if (kladgState.historyIndex > 0) {
    kladgState.historyIndex--;
    loadTrack(kladgState.history[kladgState.historyIndex], true);
  }
}

/** Initialize the audio element once, lazily. */
function ensureAudio(): void {
  if (kladgState.audio) return;
  const audio = new Audio();
  audio.preload = 'auto';
  audio.addEventListener('ended', () => {
    kladgState.isPlaying = false;
    updateAllPlayButtons();
    // Only auto-advance when autoplay is on. User's explicit play of a
    // single track shouldn't turn into an unbounded session.
    if (kladgState.autoplay) skipNext();
  });
  kladgState.audio = audio;
}

/** Sync all visible autoplay checkboxes to the current state. */
function syncAutoplayCheckboxes(): void {
  for (const { prefix } of kladgState.mounts) {
    const cb = document.getElementById(`${prefix}-autoplay`) as HTMLInputElement | null;
    if (cb) cb.checked = kladgState.autoplay;
  }
}

/** Wire the prev/play/next buttons + autoplay toggle for a given mount. */
function wireMount(prefix: string): void {
  const prev = document.getElementById(`${prefix}-prev`);
  const play = document.getElementById(`${prefix}-play`);
  const next = document.getElementById(`${prefix}-next`);
  prev?.addEventListener('click', (e) => { e.stopPropagation(); skipPrev(); });
  play?.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
  next?.addEventListener('click', (e) => { e.stopPropagation(); skipNext(); });

  const autoplayCb = document.getElementById(`${prefix}-autoplay`) as HTMLInputElement | null;
  if (autoplayCb) {
    autoplayCb.checked = kladgState.autoplay;
    autoplayCb.addEventListener('change', () => {
      kladgState.autoplay = autoplayCb.checked;
      saveAutoplay(autoplayCb.checked);
      // Mirror state across all mounted instances (desktop + modal can be open together)
      syncAutoplayCheckboxes();
    });
  }

  if (!kladgState.mounts.some(m => m.prefix === prefix)) {
    kladgState.mounts.push({ prefix });
  }
}

/** Start the player — fetches data if not already loaded and seeds a random track. */
function startKladgPlayer(prefix: string): void {
  ensureAudio();
  wireMount(prefix);
  ensureKladgData().then(() => {
    if (kladgState.historyIndex < 0) {
      // First mount — seed a random track.
      // If autoplay is on AND we haven't already tried to auto-start this
      // session, attempt to play. Browsers block autoplay without user
      // interaction, so this may fall through to a cued/paused state; the
      // user can hit play once and it'll work on every subsequent visit.
      const track = pickRandom();
      if (track) {
        const attemptAutoplay = kladgState.autoplay && !kladgState.initialAutoplayTried;
        kladgState.initialAutoplayTried = true;
        loadTrack(track, attemptAutoplay);
      }
    } else {
      // Mount added late — reflect current track into the new mount
      const current = kladgState.history[kladgState.historyIndex];
      if (current) {
        const artFile = current.artId ? kladgState.artMap.get(current.artId) : undefined;
        const artUrl = artFile ? `${KLADG_BASE}/art/${artFile}` : '';
        updateAllMounts(current.title, artUrl, `${KLADG_BASE}/#/track/${current.id}`);
        updateAllPlayButtons();
      }
    }
  });
}


// ── Desktop: standalone full-width About panel with its own toggle ─────

/**
 * Create a second bottom panel dedicated to About content. It sits beneath
 * a toggle at the right half of the bottom bar (the Tank Settings toggle
 * occupies the left half). Only one of the two panels is visible at a time
 * — opening one dispatches `repsim:close-bottom-panels` to close the other.
 *
 * On mobile the panel + toggle are hidden via @media rules; mobile users
 * reach About via the top-bar About button → modal.
 */
export function createAboutPanel(): void {
  // Panel
  const panel = document.createElement('div');
  panel.id = 'repsim-about-panel';
  panel.innerHTML = `
    <div class="about-panel-content">
      <div class="about-panel-blurb-col">
        <div class="bottom-section-title">ABOUT REPSIM</div>
        <div class="about-blurb">${ABOUT_BLURB}</div>
        <div class="about-attribution">
          Created by Van Sanders &middot;
          <a href="${WANDERING_WOJO_URL}" target="_blank" rel="noopener noreferrer">wanderingwojo.com</a>
        </div>
      </div>
      <div class="about-panel-music-col">
        <div class="bottom-section-title">MUSIC CONTROLS &middot; KLADG RADIO</div>
        <div class="kladg-player" id="about-desk-player">
          <img class="kladg-player__art" id="about-desk-art" alt="" />
          <div class="kladg-player__body">
            <span class="kladg-player__label">Original music by Van</span>
            <a class="kladg-player__title" id="about-desk-title" href="${KLADG_BASE}" target="_blank" rel="noopener noreferrer">Loading…</a>
          </div>
          <div class="kladg-player__controls">
            <button class="kladg-player__btn" id="about-desk-prev" type="button" title="Previous" aria-label="Previous">\u23EE</button>
            <button class="kladg-player__btn kladg-player__btn--play" id="about-desk-play" type="button" title="Play / pause" aria-label="Play">\u25B6</button>
            <button class="kladg-player__btn" id="about-desk-next" type="button" title="Next" aria-label="Next">\u23ED</button>
          </div>
        </div>
        <div class="kladg-autoplay-row">
          <span class="kladg-autoplay-label">Autoplay a random track on every visit</span>
          <label class="kladg-autoplay-wrap">
            <input type="checkbox" id="about-desk-autoplay" class="kladg-autoplay-checkbox">
            <span class="kladg-autoplay-track"></span>
            <span class="kladg-autoplay-dot"></span>
          </label>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // Start the shared player wired to these DOM ids
  startKladgPlayer('about-desk');

  // Register drawer with the shared toggle bar
  registerDrawer({
    id: 'about',
    labelClosed: '▲ About Repsim & Music Controls',
    labelOpen: '▼ About Repsim & Music Controls',
    panel,
  });

  // Sync panel edges against the side panels the same way the Tank Settings
  // panel does, so both sit cleanly between the Charts (left) and Settings
  // (right) columns on desktop.
  function syncPanelEdges(): void {
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
  setInterval(syncPanelEdges, 150);
  window.addEventListener('resize', syncPanelEdges);
}


// ── Mobile inline About (for the top dropdown menu) ─────────

/**
 * Build an inline About content element for mobile — used in the top
 * dropdown menu. Returns a ready-to-insert DOM node with the kladg player
 * wired to a unique prefix so it coexists with the desktop drawer mount.
 */
export function createAboutInline(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'about-mobile-inline';
  el.innerHTML = aboutContentHTML('about-mobile-inline');
  // Defer player start so the DOM is attached before wiring
  queueMicrotask(() => startKladgPlayer('about-mobile-inline'));
  return el;
}


// ── Top-bar About button + modal (legacy; no longer wired) ───────

let aboutModal: HTMLElement | null = null;

function openAboutModal(): void {
  if (aboutModal) return;
  const modal = document.createElement('div');
  modal.className = 'about-modal';
  modal.innerHTML = `
    <div class="about-modal-card">
      <div class="about-modal-header">
        <span class="about-modal-eyebrow">ABOUT REPSIM</span>
        <button class="about-modal-close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="about-modal-body">
        ${aboutContentHTML('about-modal')}
      </div>
    </div>
  `;
  modal.querySelector('.about-modal-close')!.addEventListener('click', closeAboutModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeAboutModal(); });
  document.body.appendChild(modal);
  aboutModal = modal;
  startKladgPlayer('about-modal');
  requestAnimationFrame(() => modal.classList.add('visible'));
}

function closeAboutModal(): void {
  if (!aboutModal) return;
  aboutModal.classList.remove('visible');
  const m = aboutModal;
  aboutModal = null;
  // Drop the modal mount so audio state isn't updating dead DOM
  kladgState.mounts = kladgState.mounts.filter(x => x.prefix !== 'about-modal');
  window.setTimeout(() => m.remove(), 220);
}

/** Create an "About" button in the top bar (right side). */
export function createAboutButton(): HTMLElement {
  const btn = document.createElement('button');
  btn.id = 'repsim-about-btn';
  btn.type = 'button';
  btn.textContent = 'About';
  btn.title = 'About Repsim';
  btn.addEventListener('click', openAboutModal);
  return btn;
}
