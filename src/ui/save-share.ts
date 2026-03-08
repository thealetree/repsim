/**
 * save-share.ts — URL-based Save/Share system for Repsim V2
 *
 * Handles:
 * - Organism sharing via compact URL (?o=)
 * - Tank config sharing via URL (?t=) with modular toggles
 * - URL parsing on startup (paste a shared URL → loads automatically)
 *
 * Compression uses the browser's built-in CompressionStream (deflate)
 * with base64url encoding for URL-safe transport.
 */

import type { SimulationEngine } from '../simulation/engine';
import type { Renderer } from '../rendering/renderer';
import type { OrganismPayload, TankPayload, Gene, SimConfig } from '../types';
import type { TooltipSystem } from './tooltips';
import { DEFAULT_CONFIG } from '../constants';
import { spawnOrganismFromGenome } from '../simulation/world';

// ─── Base64url Encoding (RFC 4648) ───────────────────────────

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str: string): Uint8Array {
  // Restore standard base64
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ─── Compression (deflate via CompressionStream) ─────────────

async function compress(json: string): Promise<string> {
  const stream = new Blob([json]).stream().pipeThrough(
    new CompressionStream('deflate')
  );
  const buf = await new Response(stream).arrayBuffer();
  return base64urlEncode(new Uint8Array(buf));
}

async function decompress(b64: string): Promise<string> {
  const buf = base64urlDecode(b64);
  const stream = new Blob([buf.buffer as ArrayBuffer]).stream().pipeThrough(
    new DecompressionStream('deflate')
  );
  return await new Response(stream).text();
}

// ─── Organism Serialization ──────────────────────────────────

function serializeOrganism(genome: Gene[], generation: number, name: string): OrganismPayload {
  return {
    v: 1,
    g: genome.map(g => ({ color: g.color, angle: Math.round(g.angle * 1000) / 1000, parent: g.parent, length: Math.round(g.length * 100) / 100 })),
    gen: generation,
    n: name,
  };
}

// ─── Tank Serialization ──────────────────────────────────────

function serializeTank(
  engine: SimulationEngine,
  includeLights: boolean,
  includeTemps: boolean,
  includeCurrs: boolean,
  includeConfig: boolean,
): TankPayload {
  const world = engine.world;

  // Tank cells → [col, row] pairs
  const tank: [number, number][] = [];
  for (const key of world.tankCells) {
    const [c, r] = key.split(',');
    tank.push([Number(c), Number(r)]);
  }

  const payload: TankPayload = { v: 1, tank };

  if (includeLights && world.lightSources.length > 0) {
    payload.lights = world.lightSources.map(s => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y), radius: s.radius, intensity: s.intensity }));
  }

  if (includeTemps && world.temperatureSources.length > 0) {
    payload.temps = world.temperatureSources.map(s => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y), radius: s.radius, intensity: s.intensity }));
  }

  if (includeCurrs && world.currentSources.length > 0) {
    payload.currents = world.currentSources.map(s => ({
      id: s.id, x: Math.round(s.x), y: Math.round(s.y),
      radius: s.radius, strength: s.strength,
      type: s.type, direction: Math.round(s.direction * 1000) / 1000,
    }));
  }

  if (includeConfig) {
    // Only store non-default values to minimize payload
    const cfg: Partial<SimConfig> = {};
    const current = engine.config;
    for (const key of Object.keys(DEFAULT_CONFIG) as (keyof SimConfig)[]) {
      if (current[key] !== DEFAULT_CONFIG[key]) {
        (cfg as Record<string, unknown>)[key] = current[key];
      }
    }
    if (Object.keys(cfg).length > 0) payload.config = cfg;
  }

  return payload;
}

// ─── URL Generation ──────────────────────────────────────────

const URL_MAX_LENGTH = 8000; // Modern browsers support 8K+ URLs

async function generateOrganismURL(payload: OrganismPayload): Promise<string | null> {
  const json = JSON.stringify(payload);
  const encoded = await compress(json);
  const base = window.location.origin + window.location.pathname;
  const url = `${base}?o=${encoded}`;
  return url.length <= URL_MAX_LENGTH ? url : null;
}

async function generateTankURL(payload: TankPayload): Promise<string | null> {
  const json = JSON.stringify(payload);
  const encoded = await compress(json);
  const base = window.location.origin + window.location.pathname;
  const url = `${base}?t=${encoded}`;
  return url.length <= URL_MAX_LENGTH ? url : null;
}

// ─── Clipboard Helper ────────────────────────────────────────

/**
 * Copy text to clipboard using ClipboardItem with a deferred Promise.
 * This registers the write synchronously (preserving user activation)
 * while the actual data can resolve asynchronously.
 */
function copyDeferred(dataPromise: Promise<string>): Promise<boolean> {
  // ClipboardItem with deferred blob — registered synchronously in user gesture
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({
        'text/plain': dataPromise.then(text =>
          new Blob([text], { type: 'text/plain' })
        ),
      });
      return navigator.clipboard.write([item]).then(() => true, () => false);
    } catch { /* fall through */ }
  }
  // Fallback: await then try writeText / execCommand
  return dataPromise.then(async (text) => {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  });
}

// ─── Apply Loaded Data ───────────────────────────────────────

function applyOrganismPayload(engine: SimulationEngine, payload: OrganismPayload): void {
  const world = engine.world;
  // Pick a random position inside the tank
  if (world.tankCellsArray.length === 0) return;
  const randomCell = world.tankCellsArray[Math.floor(Math.random() * world.tankCellsArray.length)];
  const [c, r] = randomCell.split(',');
  const x = Number(c) * 80 + 40; // center of cell
  const y = Number(r) * 80 + 40;

  // Reconstruct full Gene objects
  const genome: Gene[] = payload.g.map(g => ({
    color: g.color,
    angle: g.angle,
    parent: g.parent,
    length: g.length ?? 1,
  }));

  spawnOrganismFromGenome(world, genome, x, y, engine.config, -1, payload.gen);
}

function applyTankPayload(engine: SimulationEngine, payload: TankPayload): void {
  const world = engine.world;

  // Apply tank cells
  world.tankCells.clear();
  for (const [col, row] of payload.tank) {
    world.tankCells.add(`${col},${row}`);
  }
  world.tankCellsDirty = true;
  // Sync array
  world.tankCellsArray = [...world.tankCells];

  // Apply light sources
  if (payload.lights) {
    world.lightSources.length = 0;
    for (const s of payload.lights) {
      world.lightSources.push({ ...s });
    }
    world.nextLightSourceId = Math.max(0, ...payload.lights.map(s => s.id)) + 1;
  }

  // Apply temperature sources
  if (payload.temps) {
    world.temperatureSources.length = 0;
    for (const s of payload.temps) {
      world.temperatureSources.push({ ...s });
    }
    world.nextTemperatureSourceId = Math.max(0, ...payload.temps.map(s => s.id)) + 1;
  }

  // Apply current sources
  if (payload.currents) {
    world.currentSources.length = 0;
    for (const s of payload.currents) {
      world.currentSources.push({ ...s });
    }
    world.nextCurrentSourceId = Math.max(0, ...payload.currents.map(s => s.id)) + 1;
  }

  // Apply config overrides
  if (payload.config) {
    for (const [key, val] of Object.entries(payload.config)) {
      (engine.config as unknown as Record<string, unknown>)[key] = val;
    }
  }

  // Spawn organisms
  if (payload.orgs) {
    for (const orgPayload of payload.orgs) {
      applyOrganismPayload(engine, orgPayload);
    }
  }
}

// ─── URL Parsing on Startup ──────────────────────────────────

export async function parseUrlParams(engine: SimulationEngine, renderer: Renderer): Promise<void> {
  const params = new URLSearchParams(window.location.search);

  try {
    if (params.has('o')) {
      const json = await decompress(params.get('o')!);
      const payload = JSON.parse(json) as OrganismPayload;
      if (payload.v === 1 && payload.g) {
        applyOrganismPayload(engine, payload);
        console.log(`Loaded shared organism: ${payload.n}`);
      }
    }

    if (params.has('t')) {
      const json = await decompress(params.get('t')!);
      const payload = JSON.parse(json) as TankPayload;
      if (payload.v === 1 && payload.tank) {
        applyTankPayload(engine, payload);
        renderer.setWallsDirty();
        console.log(`Loaded shared tank config (${payload.tank.length} cells)`);
      }
    }
  } catch (err) {
    console.warn('Failed to parse shared URL:', err);
  }

  // Clean URL without reloading
  if (params.has('o') || params.has('t')) {
    window.history.replaceState({}, '', window.location.pathname);
  }
}

// ─── Toast Feedback ──────────────────────────────────────────

function showToast(message: string): void {
  const toast = document.createElement('div');
  toast.className = 'repsim-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 1500);
}

// ─── Save/Share UI (Accordion Section) ───────────────────────

export function buildSaveShareSection(
  engine: SimulationEngine,
  renderer: Renderer,
  tooltips?: TooltipSystem,
): HTMLElement {
  const section = document.createElement('div');
  section.className = 'panel-section';
  section.dataset.section = 'save-share';

  const header = document.createElement('div');
  header.className = 'section-header';
  header.setAttribute('data-toggle', 'save-share');
  header.innerHTML = `
    <span class="section-title">SAVE & SHARE</span>
    <span class="section-chevron collapsed">▼</span>
  `;

  const body = document.createElement('div');
  body.className = 'section-body collapsed';
  body.setAttribute('data-body', 'save-share');

  // Toggle checkboxes
  const toggleDefs = [
    { id: 'share-tank', label: 'Tank Shape', checked: true, disabled: true },
    { id: 'share-lights', label: 'Light Sources', checked: false, disabled: false },
    { id: 'share-temps', label: 'Temperature', checked: false, disabled: false },
    { id: 'share-currs', label: 'Currents', checked: false, disabled: false },
    { id: 'share-config', label: 'Sim Config', checked: false, disabled: false },
  ];

  const checkboxes: Record<string, HTMLInputElement> = {};

  const toggleContainer = document.createElement('div');
  toggleContainer.style.cssText = 'margin-bottom:8px;';
  toggleContainer.innerHTML = '<div style="font-size:10px;color:var(--ui-text-dim);margin-bottom:4px;">Include:</div>';

  for (const def of toggleDefs) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;font-size:11px;color:var(--ui-text);';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = def.checked;
    cb.disabled = def.disabled;
    cb.style.cssText = 'accent-color:var(--ui-accent);';
    checkboxes[def.id] = cb;
    row.appendChild(cb);
    row.appendChild(document.createTextNode(def.label));
    toggleContainer.appendChild(row);
  }
  body.appendChild(toggleContainer);

  // Copy URL button (full width)
  const copyBtn = document.createElement('button');
  copyBtn.className = 'ui-btn';
  copyBtn.textContent = 'Copy URL';
  copyBtn.style.cssText = 'width:100%;font-size:10px;padding:5px 0;';
  if (tooltips) tooltips.attach(copyBtn, 'share-copy-url');
  body.appendChild(copyBtn);

  // ── Load URL input ──
  const loadContainer = document.createElement('div');
  loadContainer.style.cssText = 'margin-top:8px;display:flex;gap:4px;';

  const loadInput = document.createElement('input');
  loadInput.type = 'text';
  loadInput.placeholder = 'Paste shared URL…';
  loadInput.style.cssText = 'flex:1;min-width:0;font-family:var(--ui-font);font-size:10px;padding:4px 6px;background:var(--ui-surface);border:1px solid var(--ui-border);border-radius:4px;color:var(--ui-text);outline:none;';

  const loadBtn = document.createElement('button');
  loadBtn.className = 'ui-btn';
  loadBtn.textContent = 'Load';
  loadBtn.style.cssText = 'font-size:10px;padding:4px 10px;flex-shrink:0;';

  loadContainer.appendChild(loadInput);
  loadContainer.appendChild(loadBtn);
  body.appendChild(loadContainer);

  // Accordion toggle
  header.addEventListener('click', () => {
    const isCollapsed = body.classList.toggle('collapsed');
    header.querySelector('.section-chevron')!.classList.toggle('collapsed', isCollapsed);
  });

  // Copy URL handler — copyDeferred is called synchronously in the click
  // so the ClipboardItem registers before user activation expires.
  copyBtn.addEventListener('click', () => {
    const payload = serializeTank(
      engine,
      checkboxes['share-lights'].checked,
      checkboxes['share-temps'].checked,
      checkboxes['share-currs'].checked,
      checkboxes['share-config'].checked,
    );
    const urlPromise = generateTankURL(payload);

    // Register clipboard write synchronously, data resolves async
    const copyPromise = copyDeferred(
      urlPromise.then(url => {
        if (!url) throw new Error('too-large');
        return url;
      })
    );

    copyPromise.then(copied => {
      if (copied) {
        const orig = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = orig; }, 1200);
        showToast('URL copied to clipboard!');
      } else {
        // Clipboard failed — put URL in load input for manual copy
        urlPromise.then(url => {
          if (url) {
            loadInput.value = url;
            loadInput.focus();
            loadInput.select();
            showToast('Select All + Copy the URL from the field below');
          } else {
            showToast('Tank too large to share via URL');
          }
        });
      }
    });
  });

  // Load URL handler
  async function loadFromURL(): Promise<void> {
    const raw = loadInput.value.trim();
    if (!raw) return;
    try {
      const url = new URL(raw);
      const params = new URLSearchParams(url.search);

      if (params.has('o')) {
        const json = await decompress(params.get('o')!);
        const payload = JSON.parse(json) as OrganismPayload;
        if (payload.v === 1 && payload.g) {
          applyOrganismPayload(engine, payload);
          showToast(`Loaded organism: ${payload.n}`);
        }
      } else if (params.has('t')) {
        const json = await decompress(params.get('t')!);
        const payload = JSON.parse(json) as TankPayload;
        if (payload.v === 1 && payload.tank) {
          applyTankPayload(engine, payload);
          renderer.setWallsDirty();
          showToast(`Loaded tank (${payload.tank.length} cells)`);
        }
      } else {
        showToast('URL has no shared data (?o= or ?t=)');
      }
      loadInput.value = '';
    } catch {
      showToast('Invalid URL — paste a Repsim share link');
    }
  }

  loadBtn.addEventListener('click', loadFromURL);
  loadInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadFromURL();
  });

  section.appendChild(header);
  section.appendChild(body);
  return section;
}

// ─── Organism Share Button ───────────────────────────────────

export function createShareButton(
  engine: SimulationEngine,
  getSelectedId: () => number | null,
  tooltips?: TooltipSystem,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'ui-btn';
  btn.textContent = 'Share Genome';
  btn.style.cssText = 'width:100%;font-size:10px;padding:4px 0;margin-top:6px;';
  if (tooltips) tooltips.attach(btn, 'share-org');

  btn.addEventListener('click', () => {
    const orgId = getSelectedId();
    if (orgId === null) return;
    const org = engine.world.organisms.get(orgId);
    if (!org?.alive) return;

    const payload = serializeOrganism(org.genome, org.generation, org.name);
    const urlPromise = generateOrganismURL(payload);

    copyDeferred(
      urlPromise.then(url => {
        if (!url) throw new Error('too-large');
        return url;
      })
    ).then(copied => {
      if (copied) {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1200);
        showToast('Genome URL copied!');
      } else {
        showToast('Organism too complex to share via URL');
      }
    });
  });

  return btn;
}

// ─── Organism Spawn Input ────────────────────────────────────

export function createSpawnInput(engine: SimulationEngine): HTMLElement {
  const container = document.createElement('div');
  container.style.cssText = 'margin-top:6px;display:flex;gap:4px;';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Paste genome URL…';
  input.style.cssText = 'flex:1;min-width:0;font-family:var(--ui-font);font-size:10px;padding:4px 6px;background:var(--ui-surface);border:1px solid var(--ui-border);border-radius:4px;color:var(--ui-text);outline:none;';

  const spawnBtn = document.createElement('button');
  spawnBtn.className = 'ui-btn';
  spawnBtn.textContent = 'Spawn';
  spawnBtn.style.cssText = 'font-size:10px;padding:4px 10px;flex-shrink:0;';

  container.appendChild(input);
  container.appendChild(spawnBtn);

  async function spawnFromURL(): Promise<void> {
    const raw = input.value.trim();
    if (!raw) return;
    try {
      const url = new URL(raw);
      const params = new URLSearchParams(url.search);
      if (params.has('o')) {
        const json = await decompress(params.get('o')!);
        const payload = JSON.parse(json) as OrganismPayload;
        if (payload.v === 1 && payload.g) {
          applyOrganismPayload(engine, payload);
          showToast(`Spawned: ${payload.n}`);
        }
      } else {
        showToast('Not an organism URL (needs ?o=)');
      }
    } catch {
      showToast('Invalid URL — paste a genome share link');
    }
  }

  spawnBtn.addEventListener('click', spawnFromURL);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') spawnFromURL();
  });

  return container;
}

// ─── CSS ─────────────────────────────────────────────────────

export function injectSaveShareStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    .repsim-toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--ui-bg-solid);
      border: 1px solid var(--ui-border);
      border-radius: 8px;
      padding: 8px 16px;
      font-family: var(--ui-font);
      font-size: 12px;
      color: var(--ui-text);
      z-index: 300;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    }
    .repsim-toast.visible {
      opacity: 1;
    }

    /* ── Mobile Responsive ── */
    @media (max-width: 767px) {
      .repsim-toast { bottom: 68px; }
    }
  `;
  document.head.appendChild(style);
}
