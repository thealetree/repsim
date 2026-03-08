/**
 * save-share.ts — Save/Share system for Repsim V2
 *
 * Handles:
 * - Organism sharing via compact URL (?o=)
 * - Tank config sharing via URL (?t=) with modular toggles
 * - File export/import (.repsim JSON files)
 * - URL parsing on startup
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
  includeConfig: boolean,
  includeOrgs: boolean,
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

  if (includeOrgs) {
    payload.orgs = [];
    for (const org of world.organisms.values()) {
      if (!org.alive) continue;
      payload.orgs.push(serializeOrganism(org.genome, org.generation, org.name));
    }
  }

  return payload;
}

// ─── URL Generation ──────────────────────────────────────────

const URL_MAX_LENGTH = 2000;

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

// ─── File Export/Import ──────────────────────────────────────

function downloadJSON(payload: OrganismPayload | TankPayload, filename: string): void {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function loadFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.repsim,.json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { reject(new Error('No file selected')); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
    input.click();
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
        console.log(`🧬 Loaded shared organism: ${payload.n}`);
      }
    }

    if (params.has('t')) {
      const json = await decompress(params.get('t')!);
      const payload = JSON.parse(json) as TankPayload;
      if (payload.v === 1 && payload.tank) {
        applyTankPayload(engine, payload);
        renderer.setWallsDirty();
        console.log(`🧬 Loaded shared tank config (${payload.tank.length} cells)`);
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
    { id: 'share-config', label: 'Sim Config', checked: false, disabled: false },
    { id: 'share-orgs', label: 'All Organisms', checked: false, disabled: false },
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

  // Buttons
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'ui-btn';
  copyBtn.textContent = 'Copy URL';
  copyBtn.style.cssText = 'flex:1;font-size:10px;padding:5px 0;';
  if (tooltips) tooltips.attach(copyBtn, 'share-copy-url');

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'ui-btn';
  downloadBtn.textContent = 'Download';
  downloadBtn.style.cssText = 'flex:1;font-size:10px;padding:5px 0;';
  if (tooltips) tooltips.attach(downloadBtn, 'share-download');

  btnRow.appendChild(copyBtn);
  btnRow.appendChild(downloadBtn);
  body.appendChild(btnRow);

  const loadBtn = document.createElement('button');
  loadBtn.className = 'ui-btn';
  loadBtn.textContent = 'Load from File';
  loadBtn.style.cssText = 'width:100%;font-size:10px;padding:5px 0;';
  if (tooltips) tooltips.attach(loadBtn, 'share-load');
  body.appendChild(loadBtn);

  // Accordion toggle
  header.addEventListener('click', () => {
    const isCollapsed = body.classList.toggle('collapsed');
    header.querySelector('.section-chevron')!.classList.toggle('collapsed', isCollapsed);
  });

  // Button handlers
  copyBtn.addEventListener('click', async () => {
    const payload = serializeTank(
      engine,
      checkboxes['share-lights'].checked,
      checkboxes['share-temps'].checked,
      checkboxes['share-config'].checked,
      checkboxes['share-orgs'].checked,
    );
    const url = await generateTankURL(payload);
    if (url) {
      await navigator.clipboard.writeText(url);
      showToast('URL copied to clipboard!');
    } else {
      showToast('Too large for URL — use Download instead');
    }
  });

  downloadBtn.addEventListener('click', () => {
    const payload = serializeTank(
      engine,
      checkboxes['share-lights'].checked,
      checkboxes['share-temps'].checked,
      checkboxes['share-config'].checked,
      checkboxes['share-orgs'].checked,
    );
    downloadJSON(payload, `repsim-tank-${Date.now()}.repsim`);
    showToast('Downloaded!');
  });

  loadBtn.addEventListener('click', async () => {
    try {
      const text = await loadFile();
      const payload = JSON.parse(text);
      if (payload.v === 1) {
        if (payload.tank) {
          applyTankPayload(engine, payload as TankPayload);
          showToast('Tank loaded!');
        } else if (payload.g) {
          applyOrganismPayload(engine, payload as OrganismPayload);
          showToast('Organism loaded!');
        }
      }
    } catch (err) {
      console.warn('Load failed:', err);
      showToast('Failed to load file');
    }
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

  btn.addEventListener('click', async () => {
    const orgId = getSelectedId();
    if (orgId === null) return;
    const org = engine.world.organisms.get(orgId);
    if (!org?.alive) return;

    const payload = serializeOrganism(org.genome, org.generation, org.name);
    const url = await generateOrganismURL(payload);
    if (url) {
      await navigator.clipboard.writeText(url);
      showToast('Genome URL copied!');
    } else {
      downloadJSON(payload, `repsim-${org.name}.repsim`);
      showToast('Genome too large for URL — downloaded file');
    }
  });

  return btn;
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
  `;
  document.head.appendChild(style);
}
