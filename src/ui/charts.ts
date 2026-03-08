/**
 * charts.ts — Left panel with real-time population charts
 *
 * Subscribes to chart:sample events from the simulation engine and renders
 * 6 canvas-based charts in a collapsible left panel with accordion sections.
 *
 * Data is stored in a fixed-size ring buffer (600 samples = ~50 min of sim time).
 * Charts redraw only on new samples, not per animation frame — zero FPS impact.
 */

import type { SimulationEngine } from '../simulation/engine';
import type { EventBus } from '../events';
import type { ChartSample } from '../types';
import type { TooltipSystem } from './tooltips';
import {
  CHART_HISTORY_SIZE,
  CHART_PANEL_WIDTH,
  CHART_HEIGHT,
  SEGMENT_RENDER_COLORS,
} from '../constants';

// ─── Ring Buffer ─────────────────────────────────────────────

interface ChartData {
  samples: ChartSample[];
  writeIdx: number;
  count: number;
}

function createChartData(): ChartData {
  return {
    samples: new Array(CHART_HISTORY_SIZE),
    writeIdx: 0,
    count: 0,
  };
}

function pushSample(data: ChartData, sample: ChartSample): void {
  data.samples[data.writeIdx] = sample;
  data.writeIdx = (data.writeIdx + 1) % CHART_HISTORY_SIZE;
  if (data.count < CHART_HISTORY_SIZE) data.count++;
}

/** Get the i-th oldest sample (0 = oldest still in buffer) */
function getSample(data: ChartData, i: number): ChartSample {
  const start = data.count < CHART_HISTORY_SIZE
    ? 0
    : data.writeIdx;
  return data.samples[(start + i) % CHART_HISTORY_SIZE];
}

// ─── Data Sampling ───────────────────────────────────────────

// Reusable Set for species counting (cleared each sample, avoids per-sample allocation).
const _speciesSet = new Set<string>();

function collectSample(engine: SimulationEngine): ChartSample {
  const world = engine.world;
  let totalSegments = 0;
  const colorCounts = [0, 0, 0, 0, 0, 0]; // green, blue, yellow, red, black, white
  let genomeSum = 0;
  let genSum = 0;
  let maxGen = 0;
  let orgCount = 0;
  let totalInfected = 0;
  _speciesSet.clear();

  for (const org of world.organisms.values()) {
    orgCount++;
    genomeSum += org.genome.length;
    genSum += org.generation;
    if (org.generation > maxGen) maxGen = org.generation;
    _speciesSet.add(org.fingerprint); // Use cached fingerprint (computed at spawn)
    if (org.virusInfectionCount > 0) totalInfected++;

    // Count segment colors
    for (let i = 0; i < org.segmentCount; i++) {
      const idx = org.firstSegment + i;
      if (world.segments.alive[idx]) {
        const c = world.segments.color[idx];
        if (c >= 0 && c < 6) colorCounts[c]++;
        totalSegments++;
      }
    }
  }

  // Virus strain count
  let aliveStrains = 0;
  for (const strain of world.virusStrains.strains) {
    if (strain.alive && strain.hostCount > 0) aliveStrains++;
  }

  return {
    tick: world.tick,
    population: world.stats.population,
    births: world.stats.births,
    deaths: world.stats.deaths,
    colorCounts,
    avgGenomeLength: orgCount > 0 ? genomeSum / orgCount : 0,
    maxGeneration: maxGen,
    avgGeneration: orgCount > 0 ? genSum / orgCount : 0,
    speciesCount: _speciesSet.size,
    aliveStrains,
    totalInfected,
  };
}

// ─── Canvas Chart Drawing ────────────────────────────────────

/** Convert PixiJS 0xRRGGBB integer to CSS color string */
function hexToCSS(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 0xFF;
  const g = (hex >> 8) & 0xFF;
  const b = hex & 0xFF;
  return alpha < 1
    ? `rgba(${r},${g},${b},${alpha})`
    : `rgb(${r},${g},${b})`;
}

function drawLineChart(
  ctx: CanvasRenderingContext2D,
  data: ChartData,
  width: number,
  height: number,
  getValue: (s: ChartSample) => number,
  color: string,
  lineWidth = 1.5,
): void {
  if (data.count < 2) return;

  // Find range
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.count; i++) {
    const v = getValue(getSample(data, i));
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max === min) { max = min + 1; }

  const pad = 2;
  const plotH = height - pad * 2;
  const plotW = width - pad * 2;

  ctx.beginPath();
  for (let i = 0; i < data.count; i++) {
    const v = getValue(getSample(data, i));
    const x = pad + (i / (data.count - 1)) * plotW;
    const y = pad + plotH - ((v - min) / (max - min)) * plotH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();

  // Label: current value (top-right)
  if (data.count > 0) {
    const latest = getValue(getSample(data, data.count - 1));
    const label = Number.isInteger(latest) ? String(latest) : latest.toFixed(1);
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'right';
    ctx.fillText(label, width - 4, 12);
  }
}

function drawStackedArea(
  ctx: CanvasRenderingContext2D,
  data: ChartData,
  width: number,
  height: number,
): void {
  if (data.count < 2) return;

  const pad = 2;
  const plotH = height - pad * 2;
  const plotW = width - pad * 2;

  // Find max total for Y-axis scaling
  let maxTotal = 0;
  for (let i = 0; i < data.count; i++) {
    const s = getSample(data, i);
    let total = 0;
    for (let c = 0; c < 6; c++) total += s.colorCounts[c];
    if (total > maxTotal) maxTotal = total;
  }
  if (maxTotal === 0) maxTotal = 1;

  // Draw stacked areas bottom-to-top (color 0=green first at bottom)
  const colorOrder = [0, 1, 2, 3, 4, 5]; // green, blue, yellow, red, black, white
  const prevY = new Float32Array(data.count).fill(height - pad);

  for (const c of colorOrder) {
    ctx.beginPath();

    // Forward pass (top edge)
    for (let i = 0; i < data.count; i++) {
      const s = getSample(data, i);
      let cumulative = 0;
      for (let cc = 0; cc <= c; cc++) cumulative += s.colorCounts[colorOrder[cc]];
      const x = pad + (i / (data.count - 1)) * plotW;
      const y = pad + plotH - (cumulative / maxTotal) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    // Backward pass (bottom edge = previous layer's top)
    for (let i = data.count - 1; i >= 0; i--) {
      const x = pad + (i / (data.count - 1)) * plotW;
      ctx.lineTo(x, prevY[i]);
    }

    ctx.closePath();
    // White (5) and black (4) are near-invisible in light mode — use darker substitutes
    const isLight = document.documentElement.classList.contains('light-theme');
    const chartColor = (isLight && c === 5) ? 0xaa9988 : (isLight && c === 4) ? 0x444444 : SEGMENT_RENDER_COLORS[c];
    ctx.fillStyle = hexToCSS(chartColor, 0.6);
    ctx.fill();

    // Update prevY for next layer
    for (let i = 0; i < data.count; i++) {
      const s = getSample(data, i);
      let cumulative = 0;
      for (let cc = 0; cc <= c; cc++) cumulative += s.colorCounts[colorOrder[cc]];
      prevY[i] = pad + plotH - (cumulative / maxTotal) * plotH;
    }
  }
}

function drawDualLine(
  ctx: CanvasRenderingContext2D,
  data: ChartData,
  width: number,
  height: number,
  getA: (s: ChartSample) => number,
  getB: (s: ChartSample) => number,
  colorA: string,
  colorB: string,
): void {
  if (data.count < 2) return;

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.count; i++) {
    const s = getSample(data, i);
    const a = getA(s), b = getB(s);
    if (a < min) min = a; if (a > max) max = a;
    if (b < min) min = b; if (b > max) max = b;
  }
  if (max === min) max = min + 1;

  const pad = 2;
  const plotH = height - pad * 2;
  const plotW = width - pad * 2;

  for (const [getValue, color] of [[getA, colorA], [getB, colorB]] as const) {
    ctx.beginPath();
    for (let i = 0; i < data.count; i++) {
      const v = getValue(getSample(data, i));
      const x = pad + (i / (data.count - 1)) * plotW;
      const y = pad + plotH - ((v - min) / (max - min)) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Labels
  if (data.count > 0) {
    const latest = getSample(data, data.count - 1);
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right';
    const aVal = getA(latest), bVal = getB(latest);
    ctx.fillStyle = colorA;
    ctx.fillText(Number.isInteger(aVal) ? String(aVal) : aVal.toFixed(1), width - 4, 12);
    ctx.fillStyle = colorB;
    ctx.fillText(Number.isInteger(bVal) ? String(bVal) : bVal.toFixed(1), width - 4, 24);
  }
}

// ─── Rate Computation ────────────────────────────────────────

function getBirthRate(data: ChartData, i: number): number {
  if (i <= 0) return 0;
  const curr = getSample(data, i);
  const prev = getSample(data, i - 1);
  const dt = curr.tick - prev.tick;
  return dt > 0 ? ((curr.births - prev.births) / dt) * 20 : 0; // per second
}

function getDeathRate(data: ChartData, i: number): number {
  if (i <= 0) return 0;
  const curr = getSample(data, i);
  const prev = getSample(data, i - 1);
  const dt = curr.tick - prev.tick;
  return dt > 0 ? ((curr.deaths - prev.deaths) / dt) * 20 : 0;
}

// ─── Left Panel DOM ──────────────────────────────────────────

interface ChartDef {
  id: string;
  title: string;
  tooltipKey: string;
  draw: (ctx: CanvasRenderingContext2D, data: ChartData, w: number, h: number) => void;
}

export function createChartSystem(
  engine: SimulationEngine,
  events: EventBus,
  tooltips?: TooltipSystem,
): { panel: HTMLElement } {
  const chartData = createChartData();

  // Birth/death rate data needs a special drawing approach since rates are derived
  const birthRates: number[] = [];
  const deathRates: number[] = [];

  const charts: ChartDef[] = [
    {
      id: 'population',
      title: 'POPULATION',
      tooltipKey: 'chart-population',
      draw: (ctx, data, w, h) =>
        drawLineChart(ctx, data, w, h, s => s.population, 'var(--ui-accent)'),
    },
    {
      id: 'colors',
      title: 'COLORS',
      tooltipKey: 'chart-colors',
      draw: (ctx, data, w, h) => drawStackedArea(ctx, data, w, h),
    },
    {
      id: 'birthsdeath',
      title: 'BIRTH / DEATH RATE',
      tooltipKey: 'chart-birthsdeath',
      draw: (ctx, _data, w, h) => {
        // Draw birth/death rates from derived arrays
        if (birthRates.length < 2) return;
        let max = 1;
        for (let i = 0; i < birthRates.length; i++) {
          if (birthRates[i] > max) max = birthRates[i];
          if (deathRates[i] > max) max = deathRates[i];
        }
        const pad = 2, plotH = h - pad * 2, plotW = w - pad * 2;
        const n = birthRates.length;
        for (const [arr, color] of [[birthRates, '#44cc44'], [deathRates, '#ff4444']] as const) {
          ctx.beginPath();
          for (let i = 0; i < n; i++) {
            const x = pad + (i / (n - 1)) * plotW;
            const y = pad + plotH - (arr[i] / max) * plotH;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        // Labels
        ctx.font = '10px Inter, system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillStyle = '#44cc44';
        ctx.fillText(birthRates[n - 1].toFixed(1), w - 4, 12);
        ctx.fillStyle = '#ff4444';
        ctx.fillText(deathRates[n - 1].toFixed(1), w - 4, 24);
      },
    },
    {
      id: 'genomelength',
      title: 'GENOME LENGTH',
      tooltipKey: 'chart-genomelength',
      draw: (ctx, data, w, h) =>
        drawLineChart(ctx, data, w, h, s => s.avgGenomeLength, '#cc88ff'),
    },
    {
      id: 'generation',
      title: 'GENERATION',
      tooltipKey: 'chart-generation',
      draw: (ctx, data, w, h) =>
        drawDualLine(ctx, data, w, h,
          s => s.avgGeneration, s => s.maxGeneration,
          '#88ccff', '#4488ff'),
    },
    {
      id: 'diversity',
      title: 'SPECIES',
      tooltipKey: 'chart-diversity',
      draw: (ctx, data, w, h) =>
        drawLineChart(ctx, data, w, h, s => s.speciesCount, '#ffaa44'),
    },
    {
      id: 'virus',
      title: 'VIRUS ACTIVITY',
      tooltipKey: 'chart-virus',
      draw: (ctx, data, w, h) =>
        drawDualLine(ctx, data, w, h,
          s => s.totalInfected, s => s.aliveStrains,
          '#88dd66', '#dddd44'),
    },
  ];

  // Build panel DOM
  const panel = document.createElement('div');
  panel.id = 'repsim-left-panel';
  panel.className = 'repsim-ui';

  // Toggle button (separate from panel to avoid backdrop-filter containment)
  const toggle = document.createElement('button');
  toggle.id = 'repsim-left-panel-toggle';
  toggle.className = 'repsim-ui';
  toggle.textContent = '\u25C0'; // ◀ (points left = will collapse left)
  toggle.title = 'Toggle charts panel';

  let collapsed = false;
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    collapsed = !collapsed;
    panel.classList.toggle('collapsed', collapsed);
    toggle.classList.toggle('collapsed', collapsed);
    toggle.textContent = collapsed ? '\u25B6' : '\u25C0'; // ▶ = expand right, ◀ = collapse left
  });

  // Chart sections
  const canvases: HTMLCanvasElement[] = [];

  for (const chart of charts) {
    const section = document.createElement('div');
    section.className = 'panel-section';
    section.dataset.section = `chart-${chart.id}`;

    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = `
      <span class="section-title">${chart.title}</span>
      <span class="section-chevron">▼</span>
    `;

    const body = document.createElement('div');
    body.className = 'section-body';

    const canvas = document.createElement('canvas');
    canvas.width = CHART_PANEL_WIDTH - 16; // account for padding
    canvas.height = CHART_HEIGHT;
    canvas.style.cssText = `width:100%;height:${CHART_HEIGHT}px;border-radius:4px;background:var(--ui-surface);`;
    body.appendChild(canvas);
    canvases.push(canvas);

    // Accordion toggle
    let sectionOpen = true;
    header.addEventListener('click', () => {
      sectionOpen = !sectionOpen;
      body.classList.toggle('collapsed', !sectionOpen);
      header.querySelector('.section-chevron')!.classList.toggle('collapsed', !sectionOpen);
    });

    section.appendChild(header);
    section.appendChild(body);
    panel.appendChild(section);

    if (tooltips) tooltips.attach(header, chart.tooltipKey);
  }

  document.body.appendChild(panel);
  document.body.appendChild(toggle);

  // ── Subscribe to chart:sample events ──
  events.on('chart:sample', () => {
    const sample = collectSample(engine);
    pushSample(chartData, sample);

    // Derive birth/death rates
    birthRates.length = 0;
    deathRates.length = 0;
    for (let i = 0; i < chartData.count; i++) {
      birthRates.push(getBirthRate(chartData, i));
      deathRates.push(getDeathRate(chartData, i));
    }

    // Redraw all charts
    for (let i = 0; i < charts.length; i++) {
      const canvas = canvases[i];
      const ctx = canvas.getContext('2d')!;
      // Handle DPI scaling
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);
      }
      ctx.clearRect(0, 0, w, h);
      charts[i].draw(ctx, chartData, w, h);
    }
  });

  return { panel };
}

// ─── CSS for left panel ──────────────────────────────────────

export function injectChartStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    #repsim-left-panel {
      position: fixed;
      top: 40px;
      left: 0;
      bottom: 0;
      width: ${CHART_PANEL_WIDTH}px;
      background: var(--ui-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-right: 1px solid var(--ui-border);
      overflow-y: auto;
      overflow-x: hidden;
      padding: 8px 8px 8px 8px;
      font-family: var(--ui-font);
      color: var(--ui-text);
      transition: left 0.2s ease;
      z-index: 90;
    }
    #repsim-left-panel.collapsed {
      left: -${CHART_PANEL_WIDTH}px;
    }

    /* Scrollbar styling (match right panel) */
    #repsim-left-panel::-webkit-scrollbar { width: 4px; }
    #repsim-left-panel::-webkit-scrollbar-track { background: transparent; }
    #repsim-left-panel::-webkit-scrollbar-thumb { background: var(--ui-border); border-radius: 2px; }

    /* Toggle button for left panel (lives outside panel in DOM) */
    #repsim-left-panel-toggle {
      position: fixed;
      top: 40px;
      left: ${CHART_PANEL_WIDTH}px;
      width: 24px;
      height: 24px;
      background: var(--ui-bg);
      border: 1px solid var(--ui-border);
      border-left: none;
      border-radius: 0 6px 6px 0;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 10px;
      color: var(--ui-text-muted);
      z-index: 101;
      pointer-events: auto;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      transition: left 0.2s ease, color 0.12s ease;
    }
    #repsim-left-panel-toggle.collapsed {
      left: 0;
    }
    #repsim-left-panel-toggle:hover {
      color: var(--ui-text);
    }
  `;
  document.head.appendChild(style);
}
