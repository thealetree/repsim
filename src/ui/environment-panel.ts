/**
 * environment-panel.ts — Bottom environment panel for Repsim V2
 *
 * Horizontally scrollable panel at the bottom of the viewport, positioned
 * between the left charts panel and right settings panel. Houses:
 * - Viscosity slider
 * - Day/night cycle toggle + speed slider
 * - Selected source properties (light/temp/current)
 */

import type { SimulationEngine } from '../simulation/engine';
import type { Renderer } from '../rendering/renderer';
import type { EventBus } from '../events';
import type { World, CurrentSource, LightSource, TemperatureSource } from '../types';
import { CurrentType } from '../types';
import {
  LIGHT_MIN_RADIUS, LIGHT_MAX_RADIUS,
  TEMP_MIN_RADIUS, TEMP_MAX_RADIUS,
  CURRENT_MIN_RADIUS, CURRENT_MAX_RADIUS,
} from '../constants';


// ─── Styles ─────────────────────────────────────────────────

export function injectEnvironmentPanelStyles(): void {
  if (document.getElementById('repsim-env-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'repsim-env-panel-styles';
  style.textContent = `
    #repsim-bottom-panel {
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
    #repsim-bottom-panel.expanded {
      height: 170px;
    }

    #repsim-bottom-toggle {
      position: fixed;
      bottom: 0;
      left: 50%;
      transform: translateX(-50%);
      padding: 0 14px;
      height: 22px;
      background: var(--ui-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--ui-border);
      border-bottom: none;
      border-radius: 6px 6px 0 0;
      cursor: pointer;
      z-index: 96;
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
      transition: bottom 0.25s ease;
    }
    #repsim-bottom-toggle.expanded {
      bottom: 170px;
    }
    #repsim-bottom-toggle:hover {
      color: var(--ui-text);
    }

    .bottom-panel-content {
      display: flex;
      align-items: flex-start;
      gap: 24px;
      padding: 10px 16px;
      overflow-x: auto;
      overflow-y: hidden;
      height: 100%;
      white-space: nowrap;
    }
    .bottom-panel-section {
      display: inline-flex;
      flex-direction: column;
      gap: 6px;
      min-width: 170px;
      flex-shrink: 0;
    }
    .bottom-section-title {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--ui-text-dim);
      white-space: nowrap;
      margin-bottom: 2px;
    }

    .env-slider-row {
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }
    .env-slider-label {
      font-size: 10px;
      color: var(--ui-text-dim);
      min-width: 55px;
    }
    .env-slider-row input[type="range"] {
      width: 80px;
      height: 4px;
      -webkit-appearance: none;
      appearance: none;
      background: var(--ui-slider-track);
      border-radius: 2px;
      outline: none;
    }
    .env-slider-row input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--ui-slider-thumb);
      cursor: pointer;
    }
    .env-slider-val {
      font-size: 10px;
      color: var(--ui-text-muted);
      min-width: 28px;
      text-align: right;
    }

    .env-toggle-row {
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
    }
    .env-toggle-label {
      font-size: 10px;
      color: var(--ui-text-dim);
    }
    .env-toggle-wrap {
      position: relative;
      width: 28px;
      height: 14px;
      cursor: pointer;
    }
    .env-toggle-wrap input {
      position: absolute;
      opacity: 0;
      width: 0;
      height: 0;
    }
    .env-toggle-track {
      position: absolute;
      inset: 0;
      background: var(--ui-surface);
      border-radius: 7px;
      transition: background 0.15s;
    }
    .env-toggle-wrap input:checked + .env-toggle-track {
      background: var(--ui-accent);
    }
    .env-toggle-dot {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 10px;
      height: 10px;
      background: var(--ui-text);
      border-radius: 50%;
      transition: left 0.15s;
    }
    .env-toggle-wrap input:checked ~ .env-toggle-dot {
      left: 16px;
    }

    .env-phase-bar {
      width: 80px;
      height: 6px;
      background: var(--ui-surface);
      border-radius: 3px;
      overflow: hidden;
      margin-top: 2px;
    }
    .env-phase-fill {
      height: 100%;
      background: var(--ui-accent);
      border-radius: 3px;
    }
    .daynight-controls.disabled {
      opacity: 0.35;
      pointer-events: none;
    }
    .daynight-disabled-msg {
      font-size: 9px;
      color: var(--ui-text-muted);
      font-style: italic;
      white-space: normal;
      line-height: 1.4;
      display: none;
    }
    .daynight-controls.disabled + .daynight-disabled-msg {
      display: block;
      transition: width 0.1s;
    }

    .env-placeholder {
      font-size: 10px;
      color: var(--ui-text-muted);
      white-space: normal;
      line-height: 1.4;
    }

    .env-type-toggle {
      display: flex;
      gap: 4px;
    }
    .env-type-btn {
      font-size: 9px;
      padding: 2px 8px;
      border: 1px solid var(--ui-border);
      border-radius: 4px;
      background: transparent;
      color: var(--ui-text-dim);
      cursor: pointer;
      font-family: inherit;
    }
    .env-type-btn.active {
      background: var(--ui-accent);
      color: #fff;
      border-color: var(--ui-accent);
    }

    .source-delete-btn {
      margin-top: 4px;
      padding: 3px 12px;
      font-size: 10px;
      font-family: inherit;
      border: 1px solid rgba(255,80,80,0.3);
      border-radius: 4px;
      background: rgba(255,60,60,0.1);
      color: #ff6060;
      cursor: pointer;
    }
    .source-delete-btn:hover {
      background: rgba(255,60,60,0.2);
    }

    /* ── Mobile Responsive ── */
    @media (max-width: 767px) {
      #repsim-bottom-panel,
      #repsim-bottom-toggle { display: none !important; }
    }
  `;
  document.head.appendChild(style);
}


// ─── Panel Creation ──────────────────────────────────────────

export function createEnvironmentPanel(
  engine: SimulationEngine,
  renderer: Renderer,
  events: EventBus,
): void {
  // ── Build toggle button ──
  const toggle = document.createElement('div');
  toggle.id = 'repsim-bottom-toggle';
  toggle.textContent = '▲ Tank Settings';
  document.body.appendChild(toggle);

  // ── Build panel ──
  const panel = document.createElement('div');
  panel.id = 'repsim-bottom-panel';
  panel.innerHTML = `
    <div class="bottom-panel-content">
      <div class="bottom-panel-section">
        <div class="bottom-section-title">Environment</div>
        <div class="env-slider-row">
          <span class="env-slider-label">Light</span>
          <input type="range" id="env-light" min="10" max="190" step="10" value="${engine.config.greenFeed}">
          <span class="env-slider-val" id="env-light-val">${engine.config.greenFeed}</span>
        </div>
        <div class="env-slider-row">
          <span class="env-slider-label">Viscosity</span>
          <input type="range" id="env-viscosity" min="0" max="1" step="0.05" value="${(1 - engine.config.baseViscosity).toFixed(2)}">
          <span class="env-slider-val" id="env-viscosity-val">${(1 - engine.config.baseViscosity).toFixed(2)}</span>
        </div>
        <div class="env-slider-row">
          <span class="env-slider-label">Food Decay</span>
          <input type="range" id="env-food-decay" min="30" max="300" step="10" value="${engine.config.foodDecaySeconds}">
          <span class="env-slider-val" id="env-food-decay-val">${engine.config.foodDecaySeconds}s</span>
        </div>
      </div>

      <div class="bottom-panel-section">
        <div class="bottom-section-title">Day / Night</div>
        <div class="daynight-controls" id="daynight-controls">
          <div class="env-toggle-row">
            <span class="env-toggle-label">Cycle</span>
            <label class="env-toggle-wrap">
              <input type="checkbox" id="env-daynight-toggle" ${engine.world.dayNightEnabled ? 'checked' : ''}>
              <span class="env-toggle-track"></span>
              <span class="env-toggle-dot"></span>
            </label>
          </div>
          <div class="env-slider-row">
            <span class="env-slider-label">Speed</span>
            <input type="range" id="env-daynight-speed" min="0.1" max="3" step="0.1" value="${engine.world.dayNightSpeed}">
            <span class="env-slider-val" id="env-daynight-speed-val">${engine.world.dayNightSpeed.toFixed(1)}</span>
          </div>
          <div class="env-phase-bar">
            <div class="env-phase-fill" id="env-daynight-phase" style="width:50%"></div>
          </div>
        </div>
        <div class="daynight-disabled-msg" id="daynight-disabled-msg">Place a light source to enable</div>
      </div>

      <div class="bottom-panel-section" id="bottom-source-props">
        <div class="bottom-section-title">Light / Temp / Current</div>
        <span class="env-placeholder">Select a source to edit</span>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // ── Toggle expand/collapse ──
  let expanded = false;
  toggle.addEventListener('click', () => {
    expanded = !expanded;
    panel.classList.toggle('expanded', expanded);
    toggle.classList.toggle('expanded', expanded);
    toggle.textContent = expanded ? '▼ Tank Settings' : '▲ Tank Settings';
  });

  // ── Dynamically track side panel edges ──
  // Reads the actual rendered position of each side panel so the bottom panel
  // always sits just inside their inner edges, whether expanded or collapsed.
  function syncPanelEdges(): void {
    const leftPanel = document.getElementById('repsim-left-panel');
    const rightPanel = document.getElementById('repsim-right-panel');

    // Left edge = right edge of the left panel (0 when collapsed off-screen)
    const leftRight = leftPanel ? leftPanel.getBoundingClientRect().right : 0;
    const newLeft = `${Math.max(0, leftRight)}px`;

    // Right edge = distance from right side of viewport to right panel's left edge
    const vpWidth = window.innerWidth;
    const rightLeft = rightPanel ? rightPanel.getBoundingClientRect().left : vpWidth;
    const newRight = `${Math.max(0, vpWidth - rightLeft)}px`;

    if (panel.style.left !== newLeft) panel.style.left = newLeft;
    if (panel.style.right !== newRight) panel.style.right = newRight;
  }
  // Poll edges (simpler than MutationObserver for transition tracking)
  setInterval(syncPanelEdges, 150);
  // Also sync immediately on resize
  window.addEventListener('resize', syncPanelEdges);

  // ── Wire Light (photosynthesis) slider ──
  const lightSlider = document.getElementById('env-light') as HTMLInputElement;
  const lightVal = document.getElementById('env-light-val')!;
  lightSlider.addEventListener('input', () => {
    const v = parseFloat(lightSlider.value);
    engine.config.greenFeed = v;
    lightVal.textContent = String(Math.round(v));
  });

  // ── Wire viscosity slider ──
  const viscSlider = document.getElementById('env-viscosity') as HTMLInputElement;
  const viscVal = document.getElementById('env-viscosity-val')!;
  viscSlider.addEventListener('input', () => {
    const v = parseFloat(viscSlider.value);
    // Invert: slider 1 (max viscosity) → baseViscosity 0 (min damping = thick)
    engine.config.baseViscosity = 1 - v;
    viscVal.textContent = v.toFixed(2);
  });

  // ── Wire food decay slider ──
  const foodDecaySlider = document.getElementById('env-food-decay') as HTMLInputElement;
  const foodDecayVal = document.getElementById('env-food-decay-val')!;
  foodDecaySlider.addEventListener('input', () => {
    const v = parseFloat(foodDecaySlider.value);
    engine.config.foodDecaySeconds = v;
    foodDecayVal.textContent = `${Math.round(v)}s`;
  });

  // ── Wire day/night toggle ──
  const dnToggle = document.getElementById('env-daynight-toggle') as HTMLInputElement;
  dnToggle.addEventListener('change', () => {
    engine.world.dayNightEnabled = dnToggle.checked;
  });

  // ── Wire day/night speed ──
  const dnSpeedSlider = document.getElementById('env-daynight-speed') as HTMLInputElement;
  const dnSpeedVal = document.getElementById('env-daynight-speed-val')!;
  dnSpeedSlider.addEventListener('input', () => {
    const v = parseFloat(dnSpeedSlider.value);
    engine.world.dayNightSpeed = v;
    dnSpeedVal.textContent = v.toFixed(1);
  });

  // ── Update phase indicator bar + day/night grayout ──
  const phaseBar = document.getElementById('env-daynight-phase')!;
  const daynightControls = document.getElementById('daynight-controls')!;
  events.on('stats:updated', () => {
    // Gray out day/night when no light sources
    const hasLights = engine.world.lightSources.length > 0;
    daynightControls.classList.toggle('disabled', !hasLights);

    if (engine.world.dayNightEnabled && hasLights) {
      // Phase 0.5 = noon (max brightness), 0 = midnight
      const brightness = 0.5 + 0.5 * Math.sin(engine.world.dayNightPhase * Math.PI * 2 - Math.PI / 2);
      phaseBar.style.width = `${(brightness * 100).toFixed(0)}%`;
    }
  });

  // ── Source properties — updated by event ──
  events.on('source:selected', (data) => {
    updateSourceProps(data.type, data.id, engine.world);
  });

  // Also update on scroll resize (source:selected re-emitted by renderer)
  renderer.onSourceSelected = (type, id) => {
    events.emit('source:selected', { type: type ?? null, id: id ?? null });
  };

  function updateSourceProps(
    type: 'light' | 'temperature' | 'current' | null,
    id: number | null,
    world: World,
  ): void {
    const el = document.getElementById('bottom-source-props')!;

    if (!type || id === null) {
      el.innerHTML = `
        <div class="bottom-section-title">Light / Temp / Current</div>
        <span class="env-placeholder">Select a source to edit</span>
      `;
      return;
    }

    const sources = type === 'light' ? world.lightSources
      : type === 'temperature' ? world.temperatureSources
      : world.currentSources;
    const src = sources.find(s => s.id === id);
    if (!src) {
      el.innerHTML = `
        <div class="bottom-section-title">Light / Temp / Current</div>
        <span class="env-placeholder">Select a source to edit</span>
      `;
      return;
    }

    const label = type.charAt(0).toUpperCase() + type.slice(1);
    const minR = type === 'light' ? LIGHT_MIN_RADIUS : type === 'temperature' ? TEMP_MIN_RADIUS : CURRENT_MIN_RADIUS;
    const maxR = type === 'light' ? LIGHT_MAX_RADIUS : type === 'temperature' ? TEMP_MAX_RADIUS : CURRENT_MAX_RADIUS;

    let html = `<div class="bottom-section-title">${label} #${id}</div>`;

    // Radius slider
    html += `
      <div class="env-slider-row">
        <span class="env-slider-label">Radius</span>
        <input type="range" id="src-radius" min="${minR}" max="${maxR}" step="10" value="${src.radius}">
        <span class="env-slider-val" id="src-radius-val">${Math.round(src.radius)}</span>
      </div>
    `;

    // Type-specific controls
    if (type === 'light') {
      const ls = src as LightSource;
      html += `
        <div class="env-slider-row">
          <span class="env-slider-label">Intensity</span>
          <input type="range" id="src-intensity" min="0" max="1" step="0.05" value="${ls.intensity}">
          <span class="env-slider-val" id="src-intensity-val">${ls.intensity.toFixed(2)}</span>
        </div>
      `;
    } else if (type === 'temperature') {
      const ts = src as TemperatureSource;
      html += `
        <div class="env-slider-row">
          <span class="env-slider-label">Intensity</span>
          <input type="range" id="src-intensity" min="-1" max="1" step="0.05" value="${ts.intensity}">
          <span class="env-slider-val" id="src-intensity-val">${ts.intensity.toFixed(2)}</span>
        </div>
      `;
    } else if (type === 'current') {
      const cs = src as CurrentSource;
      html += `
        <div class="env-slider-row">
          <span class="env-slider-label">Strength</span>
          <input type="range" id="src-strength" min="0" max="1" step="0.05" value="${cs.strength}">
          <span class="env-slider-val" id="src-strength-val">${cs.strength.toFixed(2)}</span>
        </div>
        <div class="env-slider-row">
          <span class="env-slider-label">Type</span>
          <div class="env-type-toggle">
            <button class="env-type-btn ${cs.type === CurrentType.Whirlpool ? 'active' : ''}" data-ctype="0">Whirl</button>
            <button class="env-type-btn ${cs.type === CurrentType.Directional ? 'active' : ''}" data-ctype="1">Flow</button>
          </div>
        </div>
      `;
      if (cs.type === CurrentType.Whirlpool) {
        html += `
          <div class="env-slider-row">
            <span class="env-slider-label">Spin</span>
            <div class="env-type-toggle">
              <button class="env-type-btn ${cs.direction >= 0 ? 'active' : ''}" data-spin="cw">CW</button>
              <button class="env-type-btn ${cs.direction < 0 ? 'active' : ''}" data-spin="ccw">CCW</button>
            </div>
          </div>
        `;
      } else if (cs.type === CurrentType.Directional) {
        const deg = Math.round(cs.direction * 180 / Math.PI);
        html += `
          <div class="env-slider-row">
            <span class="env-slider-label">Direction</span>
            <input type="range" id="src-direction" min="0" max="360" step="5" value="${deg}">
            <span class="env-slider-val" id="src-direction-val">${deg}°</span>
          </div>
        `;
      }
    }

    html += `<button class="source-delete-btn" id="src-delete">Delete</button>`;
    el.innerHTML = html;

    // Wire sliders
    wireSourceSliders(type, id, world);
  }

  function wireSourceSliders(
    type: 'light' | 'temperature' | 'current',
    id: number,
    world: World,
  ): void {
    const sources = type === 'light' ? world.lightSources
      : type === 'temperature' ? world.temperatureSources
      : world.currentSources;

    // Radius
    const radiusSlider = document.getElementById('src-radius') as HTMLInputElement | null;
    const radiusVal = document.getElementById('src-radius-val');
    radiusSlider?.addEventListener('input', () => {
      const src = sources.find(s => s.id === id);
      if (src) {
        src.radius = parseFloat(radiusSlider.value);
        if (radiusVal) radiusVal.textContent = Math.round(src.radius).toString();
      }
    });

    // Intensity (light/temp)
    const intensitySlider = document.getElementById('src-intensity') as HTMLInputElement | null;
    const intensityVal = document.getElementById('src-intensity-val');
    intensitySlider?.addEventListener('input', () => {
      const src = sources.find(s => s.id === id) as LightSource | TemperatureSource | undefined;
      if (src) {
        src.intensity = parseFloat(intensitySlider.value);
        if (intensityVal) intensityVal.textContent = src.intensity.toFixed(2);
      }
    });

    // Strength (current)
    const strengthSlider = document.getElementById('src-strength') as HTMLInputElement | null;
    const strengthVal = document.getElementById('src-strength-val');
    strengthSlider?.addEventListener('input', () => {
      const src = world.currentSources.find(s => s.id === id);
      if (src) {
        src.strength = parseFloat(strengthSlider.value);
        if (strengthVal) strengthVal.textContent = src.strength.toFixed(2);
      }
    });

    // Type toggle (current)
    const typeButtons = document.querySelectorAll('.env-type-btn[data-ctype]');
    typeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const src = world.currentSources.find(s => s.id === id);
        if (src) {
          src.type = parseInt((btn as HTMLElement).dataset.ctype!) as 0 | 1;
          // Reset direction when switching types to avoid invalid values
          if (src.type === CurrentType.Directional && src.direction < 0) {
            src.direction = 0; // Clear CCW spin flag for directional
          } else if (src.type === CurrentType.Whirlpool) {
            src.direction = src.direction < 0 ? -1 : 0; // Normalize to spin flag
          }
          updateSourceProps(type, id, world);
        }
      });
    });

    // Spin toggle (whirlpool current)
    const spinButtons = document.querySelectorAll('.env-type-btn[data-spin]');
    spinButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const src = world.currentSources.find(s => s.id === id);
        if (src) {
          src.direction = (btn as HTMLElement).dataset.spin === 'ccw' ? -1 : 0;
          updateSourceProps(type, id, world);
        }
      });
    });

    // Direction (directional current)
    const dirSlider = document.getElementById('src-direction') as HTMLInputElement | null;
    const dirVal = document.getElementById('src-direction-val');
    dirSlider?.addEventListener('input', () => {
      const src = world.currentSources.find(s => s.id === id);
      if (src) {
        const deg = parseFloat(dirSlider.value);
        src.direction = deg * Math.PI / 180;
        if (dirVal) dirVal.textContent = `${Math.round(deg)}°`;
      }
    });

    // Delete
    const deleteBtn = document.getElementById('src-delete');
    deleteBtn?.addEventListener('click', () => {
      const arr = type === 'light' ? world.lightSources
        : type === 'temperature' ? world.temperatureSources
        : world.currentSources;
      const idx = arr.findIndex(s => s.id === id);
      if (idx >= 0) arr.splice(idx, 1);

      // Deselect
      renderer.selectedSourceType = null;
      renderer.selectedSourceId = null;
      events.emit('source:selected', { type: null, id: null });
    });
  }
}
