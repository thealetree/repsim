/**
 * ui.ts — HTML overlay UI for Repsim V2
 *
 * Modern, minimalistic UI with:
 * - Top bar: stats, speed controls, new tank, theme toggle
 * - Collapsible right panel with accordion sections
 * - Light/dark mode support
 */

import type { SimulationEngine } from '../simulation/engine';
import type { Renderer } from '../rendering/renderer';
import type { EventBus } from '../events';
import type { Organism } from '../types';
import { ToolMode } from '../types';
import {
  SEGMENT_RENDER_COLORS,
  REPRO_METER_MAX,
  DEFAULT_CONFIG,
} from '../constants';
import { createSpontaneousStrain, infectSegment } from '../simulation/virus';
import { buildSaveShareSection, createShareButton, createSpawnInput, buildOrganismSlots, flushWithoutReseed, clearAutoSave, saveOrganismToInspectorSync, autoSave } from './save-share';

// ─── Color names for display ──────────────────────────────────
const COLOR_NAMES: Record<number, string> = {
  0: 'Green',
  1: 'Blue',
  2: 'Yellow',
  3: 'Red',
  4: 'Purple',
  5: 'White',
};

// ─── Slider config definitions ────────────────────────────────
interface SliderDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  invert?: boolean;  // When true, slider + means config value decreases (e.g. speed: + = lower yellowFreq = faster)
}

// Ranges are centered on DEFAULT_CONFIG values so the default sits at slider midpoint.
// Formula: min + max = 2 × default. Verified midpoints listed in comments.
const CONFIG_SLIDERS: SliderDef[] = [
  { key: 'repCount', label: 'Start Pop', min: 10, max: 490, step: 10 },      // default 250 — midpoint 250 ✓
  { key: 'repLimit', label: 'Pop Limit', min: 50, max: 1950, step: 50 },    // default 1000 — midpoint 1000 ✓
  { key: 'greenFeed', label: 'Sun Feed', min: 60, max: 420, step: 15 },     // default 240 — midpoint 240 ✓
  { key: 'blueHP', label: 'Blue HP', min: 150, max: 1050, step: 50 },       // default 600 — midpoint 600 ✓
  { key: 'yellowFreq', label: 'Speed', min: 0.25, max: 2.25, step: 0.25, invert: true }, // default 1.25 — midpoint 1.25 ✓; invert so + = faster
  { key: 'redDamage', label: 'Attack', min: 50, max: 750, step: 50 },       // default 400 — midpoint 400 ✓
  { key: 'purpleCost', label: 'Mate Cost', min: 250, max: 1750, step: 50 }, // default 1000 — midpoint 1000 ✓
  { key: 'asexMutationRate', label: 'Mutate %', min: 0, max: 2, step: 0.1, unit: '%' }, // default 1 — midpoint 1 ✓
  { key: 'sexMutationRate', label: 'Sex Mut %', min: 0, max: 4, step: 0.1, unit: '%' }, // default 2 — midpoint 2 ✓
  { key: 'sexGeneComboRate', label: 'Gene Mix %', min: 0, max: 30, step: 1, unit: '%' }, // default 15 — midpoint 15 ✓
];

// ─── CSS Styles ──────────────────────────────────────────────
function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    /* ── CSS Custom Properties (Theme) ── */
    :root {
      --ui-bg: rgba(10, 10, 18, 0.50);
      --ui-bg-solid: #0d0d16;
      --ui-border: rgba(255, 255, 255, 0.06);
      --ui-text: #d4d8e0;
      --ui-text-dim: #7a8294;
      --ui-text-muted: #4e5564;
      --ui-accent: #6b8aff;
      --ui-accent-dim: rgba(107, 138, 255, 0.12);
      --ui-surface: rgba(255, 255, 255, 0.04);
      --ui-surface-hover: rgba(255, 255, 255, 0.07);
      --ui-slider-track: rgba(255, 255, 255, 0.08);
      --ui-slider-thumb: #6b8aff;
      --ui-bar-bg: rgba(255, 255, 255, 0.06);
      --ui-font: 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }

    :root.light-theme {
      --ui-bg: rgba(255, 255, 255, 0.50);
      --ui-bg-solid: #f8f9fb;
      --ui-border: rgba(0, 0, 0, 0.08);
      --ui-text: #1a1d24;
      --ui-text-dim: #6b7280;
      --ui-text-muted: #9ca3af;
      --ui-accent: #4f6be8;
      --ui-accent-dim: rgba(79, 107, 232, 0.10);
      --ui-surface: rgba(0, 0, 0, 0.03);
      --ui-surface-hover: rgba(0, 0, 0, 0.06);
      --ui-slider-track: rgba(0, 0, 0, 0.08);
      --ui-slider-thumb: #4f6be8;
      --ui-bar-bg: rgba(0, 0, 0, 0.06);
    }

    /* ── UI Base ── */
    .repsim-ui {
      font-family: var(--ui-font);
      font-size: 12px;
      color: var(--ui-text);
      pointer-events: none;
      user-select: none;
      -webkit-font-smoothing: antialiased;
    }
    .repsim-ui * {
      pointer-events: auto;
    }

    /* ── Top Bar ── */
    #repsim-top-bar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 40px;
      background: var(--ui-bg);
      border-bottom: 1px solid var(--ui-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      z-index: 100;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }

    .top-left { display: flex; align-items: center; gap: 20px; }
    .top-right { display: flex; align-items: center; gap: 8px; }

    /* ── Wordmark ── */
    .repsim-wordmark {
      font-size: 13px;
      font-weight: 700;
      opacity: 0.7;
      color: var(--ui-text);
      letter-spacing: -0.02em;
      user-select: none;
      flex-shrink: 0;
    }

    /* ── Stats ── */
    #repsim-stats {
      display: flex;
      gap: 16px;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: -0.01em;
    }
    .stat-item { color: var(--ui-text-dim); white-space: nowrap; }
    .stat-value {
      color: var(--ui-text);
      font-variant-numeric: tabular-nums;
      font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
      font-size: 11px;
      margin-left: 4px;
      display: inline-block;
      text-align: right;
    }
    #stat-pop    { min-width: 4ch; }
    #stat-births { min-width: 6ch; }
    #stat-deaths { min-width: 6ch; }
    #stat-time   { min-width: 5ch; }

    /* ── Buttons ── */
    .ui-btn {
      background: var(--ui-surface);
      border: 1px solid var(--ui-border);
      color: var(--ui-text-dim);
      padding: 5px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-family: var(--ui-font);
      font-size: 11px;
      font-weight: 500;
      transition: all 0.12s ease;
      line-height: 1;
    }
    .ui-btn:hover {
      background: var(--ui-surface-hover);
      color: var(--ui-text);
    }
    .ui-btn.active {
      background: var(--ui-accent-dim);
      color: var(--ui-accent);
      border-color: rgba(107, 138, 255, 0.2);
    }
    .ui-btn-icon {
      background: none;
      border: none;
      color: var(--ui-text-dim);
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 6px;
      font-size: 15px;
      line-height: 1;
      transition: all 0.12s ease;
    }
    .ui-btn-icon:hover {
      background: var(--ui-surface-hover);
      color: var(--ui-text);
    }
    .btn-group { display: flex; align-items: center; }
    .btn-group .ui-btn { border-radius: 0; }
    .btn-group .btn-group-left { border-radius: 6px 0 0 6px; border-right: none; }
    .btn-group .btn-group-middle { border-right: none; }
    .btn-group .btn-group-right { border-radius: 0 6px 6px 0; }

    #repsim-speed-controls {
      display: flex;
      gap: 2px;
      background: var(--ui-surface);
      border-radius: 8px;
      padding: 2px;
    }
    #repsim-speed-controls .ui-btn {
      background: none;
      border: none;
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
    }
    #repsim-speed-controls .ui-btn.active {
      background: var(--ui-accent-dim);
    }

    /* ── Top Bar Focus ── */
    .top-focus-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .top-focus-label {
      font-size: 10px;
      color: var(--ui-text-dim);
      font-weight: 500;
    }
    .top-focus-slider {
      width: 60px;
      height: 4px;
      -webkit-appearance: none;
      appearance: none;
      background: var(--ui-slider-track);
      border-radius: 2px;
      outline: none;
    }
    .top-focus-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--ui-slider-thumb);
      cursor: pointer;
    }

    /* ── Right Panel ── */
    #repsim-right-panel {
      position: fixed;
      top: 40px;
      right: 0;
      bottom: 0;
      width: 220px;
      box-sizing: border-box;
      background: var(--ui-bg);
      border-left: 1px solid var(--ui-border);
      overflow-y: auto;
      overflow-x: hidden;
      z-index: 100;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      transition: right 0.2s ease;
    }
    #repsim-right-panel.collapsed {
      right: -220px;
    }
    #repsim-right-panel::-webkit-scrollbar {
      width: 4px;
    }
    #repsim-right-panel::-webkit-scrollbar-track {
      background: transparent;
    }
    #repsim-right-panel::-webkit-scrollbar-thumb {
      background: var(--ui-border);
      border-radius: 2px;
    }

    #repsim-panel-toggle {
      position: fixed;
      top: 40px;
      right: 220px;
      width: 24px;
      height: 24px;
      background: var(--ui-bg);
      border: 1px solid var(--ui-border);
      border-right: none;
      border-radius: 6px 0 0 6px;
      color: var(--ui-text-muted);
      cursor: pointer;
      font-size: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 101;
      pointer-events: auto;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      transition: right 0.2s ease, color 0.12s ease;
    }
    #repsim-panel-toggle.collapsed { right: 0; }
    #repsim-panel-toggle:hover { color: var(--ui-text); }

    /* ── Accordion Sections ── */
    .panel-section {
      border-bottom: 1px solid var(--ui-border);
    }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 10px;
      cursor: pointer;
      transition: background 0.12s ease;
    }
    .section-header:hover {
      background: var(--ui-surface);
    }
    .section-title {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--ui-text-dim);
    }
    .section-chevron {
      font-size: 10px;
      color: var(--ui-text-muted);
      transition: transform 0.2s ease;
    }
    .section-chevron.collapsed {
      transform: rotate(-90deg);
    }
    .section-body {
      padding: 0 10px 10px;
      overflow: hidden;
      transition: max-height 0.2s ease, padding 0.2s ease, opacity 0.15s ease;
      max-height: 500px;
      opacity: 1;
    }
    .section-body.collapsed {
      max-height: 0;
      padding-top: 0;
      padding-bottom: 0;
      opacity: 0;
    }

    /* ── Sliders ── */
    .slider-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
    }
    .slider-label {
      font-size: 11px;
      color: var(--ui-text-dim);
      min-width: 52px;
      max-width: 64px;
      flex-shrink: 0;
      white-space: nowrap;
    }
    .slider-row input[type="range"] {
      flex: 1;
      min-width: 0;
      height: 4px;
      -webkit-appearance: none;
      appearance: none;
      background: var(--ui-slider-track);
      border-radius: 2px;
      outline: none;
      cursor: pointer;
    }
    .slider-row input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--ui-slider-thumb);
      cursor: pointer;
      transition: transform 0.1s;
    }
    .slider-row input[type="range"]::-webkit-slider-thumb:hover {
      transform: scale(1.2);
    }
    .slider-cap {
      font-size: 10px;
      color: var(--ui-text-muted);
      flex-shrink: 0;
      line-height: 1;
    }
    .slider-val {
      font-size: 10px;
      color: var(--ui-text-muted);
      font-variant-numeric: tabular-nums;
      min-width: 30px;
      text-align: right;
      flex-shrink: 0;
      line-height: 1;
    }
    .slider-row.slider-disabled {
      opacity: 0.3;
      pointer-events: none;
    }
    .restore-defaults-btn {
      display: block;
      width: 100%;
      margin-top: 8px;
      padding: 4px 0;
      font-family: var(--ui-font);
      font-size: 10px;
      color: var(--ui-text-muted);
      background: var(--ui-surface);
      border: 1px solid var(--ui-border);
      border-radius: 4px;
      cursor: pointer;
      transition: color 0.15s, background 0.15s;
    }
    .restore-defaults-btn:hover {
      color: var(--ui-text);
      background: var(--ui-surface-hover);
    }

    /* ── Organism Info ── */
    #repsim-org-info {
      font-size: 12px;
      line-height: 1.6;
    }
    .org-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--ui-text);
      margin-bottom: 6px;
      letter-spacing: -0.01em;
    }
    .org-detail {
      font-size: 11px;
      color: var(--ui-text-dim);
    }
    .org-bar {
      height: 4px;
      background: var(--ui-bar-bg);
      border-radius: 2px;
      margin: 3px 0 8px 0;
      overflow: hidden;
    }
    .org-bar-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.15s ease;
    }
    .org-bar-label {
      font-size: 10px;
      color: var(--ui-text-muted);
      font-weight: 500;
    }
    .genome-dots {
      display: flex;
      gap: 3px;
      flex-wrap: wrap;
      margin: 6px 0;
    }
    .genome-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .light-theme .genome-dot {
      border-color: rgba(0,0,0,0.1);
    }
    .org-placeholder {
      color: var(--ui-text-muted);
      font-size: 12px;
    }

    /* ── Tool mode indicator ── */
    #repsim-tool-indicator {
      position: fixed;
      bottom: 30px;
      left: 256px;
      background: var(--ui-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--ui-border);
      border-radius: 20px;
      padding: 5px 14px;
      font-size: 11px;
      color: var(--ui-text-dim);
      z-index: 100;
      pointer-events: none;
      font-family: var(--ui-font);
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    #repsim-tool-indicator.visible { opacity: 1; }

    /* ── Focus indicator (toast) ── */
    #repsim-focus-indicator {
      position: fixed;
      bottom: 16px;
      left: 16px;
      background: var(--ui-bg);
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid var(--ui-border);
      font-size: 11px;
      color: var(--ui-text-dim);
      z-index: 100;
      opacity: 0;
      transition: opacity 0.25s ease;
      pointer-events: none;
      backdrop-filter: blur(8px);
      font-family: var(--ui-font);
    }
    #repsim-focus-indicator.visible { opacity: 1; }

    /* ── Theme change toast ── */
    #repsim-theme-toast {
      position: fixed;
      top: 52px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--ui-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--ui-border);
      border-radius: 20px;
      padding: 6px 16px;
      font-size: 11px;
      color: var(--ui-text-dim);
      z-index: 200;
      pointer-events: none;
      font-family: var(--ui-font);
      opacity: 0;
      transition: opacity 0.25s ease;
      white-space: nowrap;
    }
    #repsim-theme-toast.visible { opacity: 1; }

    /* ── Hint text ── */
    .hint-text {
      font-size: 10px;
      color: var(--ui-text-muted);
      line-height: 1.6;
    }
    .hint-kbd {
      display: inline-block;
      background: var(--ui-surface);
      border: 1px solid var(--ui-border);
      border-radius: 3px;
      padding: 0 4px;
      font-size: 9px;
      font-family: var(--ui-font);
    }

    /* ── Top Bar Tool Icons ── */
    .top-divider {
      width: 1px;
      height: 20px;
      background: var(--ui-border);
      flex-shrink: 0;
    }
    #repsim-tool-icons {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .tool-icon {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: none;
      color: var(--ui-text-dim);
      cursor: pointer;
      border-radius: 6px;
      transition: all 0.12s ease;
    }
    .tool-icon:hover {
      background: var(--ui-surface-hover);
      color: var(--ui-text);
    }
    .tool-icon.active {
      background: var(--ui-accent-dim);
      color: var(--ui-accent);
    }
    .tool-icon svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }
    .tool-icon[data-tool="4"] svg {
      width: 24px;
      height: 24px;
    }
    .tool-sep {
      width: 1px;
      height: 16px;
      background: var(--ui-border);
      flex-shrink: 0;
    }

    /* ── Source Properties ── */
    .source-props {
      margin-top: 4px;
    }
    .source-type-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--ui-text);
      margin-bottom: 6px;
    }
    .source-delete-btn {
      width: 100%;
      margin-top: 6px;
      padding: 5px 0;
      background: rgba(255, 68, 68, 0.08);
      border: 1px solid rgba(255, 68, 68, 0.2);
      color: #ff6666;
      border-radius: 6px;
      cursor: pointer;
      font-family: var(--ui-font);
      font-size: 11px;
      font-weight: 500;
      transition: all 0.12s ease;
    }
    .source-delete-btn:hover {
      background: rgba(255, 68, 68, 0.15);
      color: #ff4444;
    }
    .env-placeholder {
      color: var(--ui-text-muted);
      font-size: 11px;
      line-height: 1.5;
    }

    /* ── Zoom Buttons ── */
    #repsim-zoom-controls {
      position: fixed;
      right: 228px;
      bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      z-index: 101;
      transition: bottom 0.25s ease, right 0.2s ease;
    }
    #repsim-zoom-controls.panel-collapsed {
      right: 8px;
    }
    #repsim-zoom-controls.tank-expanded {
      bottom: 182px;
    }
    .zoom-btn {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--ui-bg);
      border: 1px solid var(--ui-border);
      border-radius: 6px;
      color: var(--ui-text-dim);
      cursor: pointer;
      font-size: 16px;
      font-weight: 500;
      line-height: 1;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      transition: all 0.12s ease;
      font-family: var(--ui-font);
    }
    .zoom-btn:hover {
      background: var(--ui-surface-hover);
      color: var(--ui-text);
    }
    .zoom-btn:active {
      transform: scale(0.92);
    }

    /* ── Mobile Responsive ── */
    @media (max-width: 767px) {
      #repsim-top-bar {
        height: 44px;
        padding: 0 8px;
        overflow: hidden;
        justify-content: space-between;
        gap: 0;
      }

      .top-left { gap: 6px; flex-shrink: 0; }
      .top-right { display: none !important; }
      .top-divider { display: none; }

      /* Hide tool icons on mobile (moved to dropdown) */
      #repsim-tool-icons { display: none !important; }

      /* Show only Pop and Time stats */
      #repsim-stats { gap: 8px; font-size: 11px; }
      #repsim-stats .stat-item:nth-child(2),
      #repsim-stats .stat-item:nth-child(3) { display: none; }

      /* Focus slider when in mobile bar */
      .mobile-bar-focus {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 1;
        min-width: 0;
      }
      .mobile-bar-focus .top-focus-label { font-size: 9px; white-space: nowrap; }
      .mobile-bar-focus .top-focus-slider { width: 70px; min-width: 40px; flex-shrink: 1; }

      /* Hide desktop panels */
      #repsim-right-panel,
      #repsim-panel-toggle { display: none !important; }

      /* Hide zoom buttons (pinch replaces) */
      #repsim-zoom-controls { display: none !important; }

      /* Toast above tab bar */
      #repsim-focus-indicator { bottom: 60px; }
    }
  `;
  document.head.appendChild(style);
}

// ─── Hex number to CSS color ──────────────────────────────────
function hexToCSS(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

// ─── Accordion section builder ────────────────────────────────
function buildSection(title: string, id: string, content: string, startOpen = true): string {
  const collapsedClass = startOpen ? '' : ' collapsed';
  return `
    <div class="panel-section" data-section="${id}">
      <div class="section-header" data-toggle="${id}">
        <span class="section-title">${title}</span>
        <span class="section-chevron${collapsedClass}">&#9660;</span>
      </div>
      <div class="section-body${collapsedClass}" data-body="${id}">
        ${content}
      </div>
    </div>
  `;
}

// ─── Build HTML ──────────────────────────────────────────────

function buildTopBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.id = 'repsim-top-bar';
  bar.className = 'repsim-ui';
  bar.innerHTML = `
    <div class="top-left">
      <span class="repsim-wordmark">Repsim</span>
      <div class="top-divider"></div>
      <div id="repsim-stats">
        <span class="stat-item">Pop<span class="stat-value" id="stat-pop">0</span></span>
        <span class="stat-item">Births<span class="stat-value" id="stat-births">0</span></span>
        <span class="stat-item">Deaths<span class="stat-value" id="stat-deaths">0</span></span>
        <span class="stat-item" id="stat-time-wrap">&#9201;<span class="stat-value" id="stat-time">0:00</span></span>
      </div>
      <button class="ui-btn-icon" id="repsim-copy-stats" title="Copy stats to clipboard" style="font-size:13px;padding:3px 5px;display:none">&#128203;</button>
      <div class="top-divider"></div>
      <div id="repsim-tool-icons">
        <button class="tool-icon active" data-tool="0" title="Select">
          <svg viewBox="0 0 24 24"><path d="M7 2l10 10h-6l4 9-2 1-4-9-4 3z"/></svg>
        </button>
        <div class="tool-sep"></div>
        <button class="tool-icon" data-tool="1" title="Tank Shape">
          <svg viewBox="0 0 24 24"><path d="M3 3h18v2H3zm0 4h8v4H3zm10 0h8v4h-8zM3 13h8v4H3zm10 0h8v4h-8zM3 19h18v2H3z"/></svg>
        </button>
        <div class="tool-sep"></div>
        <button class="tool-icon" data-tool="2" title="Light">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg>
        </button>
        <div class="tool-sep"></div>
        <button class="tool-icon" data-tool="3" title="Temperature">
          <svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 00-3 3v8.26A5 5 0 1017 17a5 5 0 00-2-3.74V5a3 3 0 00-3-3zm0 2a1 1 0 011 1v9.54l.42.26A3 3 0 1111 17a3 3 0 002.42-4.2l.42-.26H13V5a1 1 0 00-1-1z"/></svg>
        </button>
        <div class="tool-sep"></div>
        <button class="tool-icon" data-tool="4" title="Current">
          <svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" d="M4 10c2-3 4-3 6 0s4 3 6 0s4-3 6 0"/><path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" d="M4 16c2-3 4-3 6 0s4 3 6 0s4-3 6 0"/></svg>
        </button>
      </div>
    </div>
    <div class="top-right">
      <div class="top-focus-group">
        <span class="top-focus-label">Focus</span>
        <input type="range" id="focus-slider" min="0" max="1" step="0.02" value="1" class="top-focus-slider">
      </div>
      <div class="btn-group">
        <button class="ui-btn btn-group-left" id="repsim-empty" title="Empty">Empty</button>
        <button class="ui-btn btn-group-middle" id="repsim-flush" title="Flush">Flush</button>
        <button class="ui-btn btn-group-right" id="repsim-new-tank" title="New">New</button>
      </div>
      <div id="repsim-speed-controls">
        <button class="ui-btn" data-speed="0" title="Pause">&#10073;&#10073;</button>
        <button class="ui-btn active" data-speed="1" title="Normal">1x</button>
        <button class="ui-btn" data-speed="2" title="Fast">2x</button>
        <button class="ui-btn" data-speed="4" title="Fast">4x</button>
        <button class="ui-btn" data-speed="8" title="Fastest">8x</button>
      </div>
      <!-- desaturation toggle hidden for now -->
      <button class="ui-btn-icon" id="repsim-desat-toggle" title="Toggle desaturation" style="display:none">&#9681;</button>
      <button class="ui-btn-icon" id="repsim-theme-toggle" title="Toggle theme"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M21.64 13a1 1 0 00-1.05-.14 8.05 8.05 0 01-3.37.73A8.15 8.15 0 019.08 5.49a8.59 8.59 0 01.25-2 1 1 0 00-1.28-1.18A10 10 0 1021.93 14.12a1 1 0 00-.29-1.12z"/></svg></button>
    </div>
  `;
  return bar;
}

function buildRightPanel(engine: SimulationEngine): HTMLElement {
  const panel = document.createElement('div');
  panel.id = 'repsim-right-panel';
  panel.className = 'repsim-ui';

  // Config sliders
  let slidersContent = '';
  for (const def of CONFIG_SLIDERS) {
    let val = (engine.config as unknown as Record<string, number>)[def.key];
    // Inverted sliders: display value = (min + max) - config value
    if (def.invert) val = def.min + def.max - val;
    // Format initial display value
    const displayVal = Number.isInteger(val) ? String(val) : val.toFixed(1);
    const displayWithUnit = def.unit ? displayVal + def.unit : displayVal;
    slidersContent += `
      <div class="slider-row" id="row-${def.key}">
        <span class="slider-label">${def.label}</span>
        <span class="slider-cap">−</span>
        <input type="range" class="config-slider" data-key="${def.key}"
          min="${def.min}" max="${def.max}" step="${def.step}" value="${val}">
        <span class="slider-cap">+</span>
        <span class="slider-val" id="val-${def.key}">${displayWithUnit}</span>
      </div>
    `;
  }
  slidersContent += `<button class="restore-defaults-btn" id="restore-defaults">Restore Defaults</button>`;

  // Organism info
  const orgContent = `<div id="repsim-org-info"><span class="org-placeholder">Click an organism to inspect</span></div>`;

  // Controls hint
  const controlsContent = `
    <div class="hint-text">
      <span class="hint-kbd">Scroll</span> Zoom<br>
      <span class="hint-kbd">Middle/Right drag</span> Pan<br>
      <span class="hint-kbd">Left click</span> Select organism<br>
      <span class="hint-kbd">Shift+click</span> Sculpt tank<br>
      <span class="hint-kbd">Alt+Scroll</span> Focus depth<br>
      <span class="hint-kbd">Space</span> Pause / Resume<br>
      <span class="hint-kbd">1 / 2 / 4 / 8</span> Set speed
    </div>
    <div id="repsim-tooltips-row" style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;margin-top:6px">
      <span style="font-size:11px;color:var(--ui-text-dim)">Tooltips</span>
      <label style="position:relative;display:inline-block;width:32px;height:18px;cursor:pointer">
        <input type="checkbox" id="repsim-tooltips-checkbox" checked style="opacity:0;width:0;height:0">
        <span style="position:absolute;inset:0;background:var(--ui-slider-track);border-radius:9px;transition:background 0.2s"></span>
        <span id="repsim-tooltips-dot" style="position:absolute;left:2px;top:2px;width:14px;height:14px;background:var(--ui-text-muted);border-radius:50%;transition:all 0.2s"></span>
      </label>
    </div>
    <div style="text-align:right;margin-top:8px;font-size:9px;color:var(--ui-text-muted);letter-spacing:0.03em">v0.10.3</div>
  `;

  // Virus section
  const virusContent = `
    <div class="slider-row" style="justify-content:space-between">
      <span class="slider-label">Enabled</span>
      <label style="position:relative;display:inline-block;width:32px;height:18px;cursor:pointer">
        <input type="checkbox" id="virus-enabled" style="opacity:0;width:0;height:0">
        <span style="position:absolute;inset:0;background:var(--ui-slider-track);border-radius:9px;transition:background 0.2s"></span>
        <span id="virus-toggle-dot" style="position:absolute;left:2px;top:2px;width:14px;height:14px;background:var(--ui-text-muted);border-radius:50%;transition:all 0.2s"></span>
      </label>
    </div>
    <div class="slider-row">
      <span class="slider-label">Virulence</span>
      <span class="slider-cap">\u2212</span>
      <input type="range" class="virus-slider" data-vkey="virusVirulence"
        min="0" max="1" step="0.05" value="${engine.config.virusVirulence}">
      <span class="slider-cap">+</span>
    </div>
    <div class="slider-row">
      <span class="slider-label">Transmit</span>
      <span class="slider-cap">\u2212</span>
      <input type="range" class="virus-slider" data-vkey="virusTransmission"
        min="0" max="1" step="0.05" value="${engine.config.virusTransmission}">
      <span class="slider-cap">+</span>
    </div>
    <div class="slider-row">
      <span class="slider-label">Defense</span>
      <span class="slider-cap">\u2212</span>
      <input type="range" class="virus-slider" data-vkey="virusImmunityTime"
        min="0" max="60" step="5" value="${engine.config.virusImmunityTime}">
      <span class="slider-cap">+</span>
    </div>
    <div style="display:flex;gap:12px;margin:6px 0">
      <span class="stat-item" style="font-size:10px">Strains<span class="stat-value" id="stat-strains">0</span></span>
      <span class="stat-item" style="font-size:10px">Infected<span class="stat-value" id="stat-infected">0</span></span>
    </div>
    <button class="ui-btn" id="virus-release-btn" style="width:100%;margin-top:4px">Release Virus</button>
  `;

  panel.innerHTML =
    buildSection('Selected Organism', 'organism', orgContent) +
    buildSection('Virus', 'virus', virusContent) +
    buildSection('Simulation', 'sim', slidersContent) +
    buildSection('Controls', 'controls', controlsContent);

  return panel;
}

function buildToggleButton(): HTMLElement {
  const btn = document.createElement('button');
  btn.id = 'repsim-panel-toggle';
  btn.className = 'repsim-ui';
  btn.textContent = '\u25B6'; // ▶ (points right = will collapse right)
  btn.title = 'Toggle panel';
  return btn;
}

function buildFocusIndicator(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'repsim-focus-indicator';
  el.textContent = 'Focus: 1.00';
  return el;
}

function buildToolIndicator(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'repsim-tool-indicator';
  return el;
}

const TOOL_INDICATOR_TEXT: Record<number, string> = {
  1: 'Wall tool \u2014 click/drag to paint walls, Shift+drag to erase',
  2: 'Light tool \u2014 click to place, scroll to resize, drag to move',
  3: 'Temperature tool \u2014 click to place, scroll to resize, drag to move',
  4: 'Current tool \u2014 click to place, scroll to resize, drag to move',
};

function buildZoomControls(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'repsim-zoom-controls';
  el.className = 'repsim-ui';
  el.innerHTML = `
    <button class="zoom-btn" id="zoom-recenter" title="Recenter view">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2 L19 17 L12 13 L5 17 Z"/>
      </svg>
    </button>
    <button class="zoom-btn" id="zoom-in" title="Zoom in">+</button>
    <button class="zoom-btn" id="zoom-out" title="Zoom out">&minus;</button>
  `;
  return el;
}

// ─── Organism info renderer ──────────────────────────────────
function renderOrganismInfo(org: Organism | undefined): string {
  if (!org || !org.alive) {
    return '<span class="org-placeholder">Click an organism to inspect</span>';
  }

  const healthPct = Math.round((org.rootHealthReserve / org.rootHealthReserveMax) * 100);
  const reproPct = Math.round((org.reproMeter / REPRO_METER_MAX) * 100);

  let dots = '<div class="genome-dots">';
  for (const gene of org.genome) {
    const c = hexToCSS(SEGMENT_RENDER_COLORS[gene.color] ?? 0x888888);
    dots += `<div class="genome-dot" style="background:${c}" title="${COLOR_NAMES[gene.color] || '?'}"></div>`;
  }
  dots += '</div>';

  return `
    <div class="org-name">${org.name}</div>
    <div class="org-detail">Gen ${org.generation} &middot; ${org.segmentCount} segs &middot; ${org.childCount} children</div>
    <div class="org-bar-label">HP Reserve</div>
    <div class="org-bar"><div class="org-bar-fill" style="width:${healthPct}%;background:#4488ff"></div></div>
    <div class="org-bar-label">Repro Meter</div>
    <div class="org-bar"><div class="org-bar-fill" style="width:${reproPct}%;background:#44cc44"></div></div>
    <div class="org-bar-label">Genome</div>
    ${dots}
    <div class="org-detail">Depth ${org.depth.toFixed(2)} &middot; ${org.hasBlack ? 'Sexual' : 'Asexual'}${org.hasWhite ? ' &middot; Scavenger' : ''}</div>
    ${org.virusInfectionCount > 0 ? `<div class="org-detail" style="color:#88dd66;font-weight:600">INFECTED (${org.virusInfectionCount} seg${org.virusInfectionCount > 1 ? 's' : ''})</div>` : ''}
    ${org.immuneTo.size > 0 ? `<div class="org-detail" style="color:var(--ui-accent)">Immune to ${org.immuneTo.size} strain${org.immuneTo.size > 1 ? 's' : ''}</div>` : ''}
  `;
}

// ─── Main UI creation ────────────────────────────────────────

export function createUI(
  engine: SimulationEngine,
  renderer: Renderer,
  events: EventBus,
  tooltips?: import('./tooltips').TooltipSystem,
): void {
  injectStyles();

  const topBar = buildTopBar();
  const rightPanel = buildRightPanel(engine);
  const toggleBtn = buildToggleButton();
  const focusIndicator = buildFocusIndicator();
  const toolIndicator = buildToolIndicator();

  const zoomControls = buildZoomControls();

  // Theme toast (appears top-center when theme changes, informs about light/shadow inversion)
  const themeToast = document.createElement('div');
  themeToast.id = 'repsim-theme-toast';

  document.body.appendChild(topBar);
  document.body.appendChild(rightPanel);
  document.body.appendChild(toggleBtn);
  document.body.appendChild(focusIndicator);
  document.body.appendChild(toolIndicator);
  document.body.appendChild(themeToast);
  document.body.appendChild(zoomControls);

  // ── Stat references ──
  const statPop = document.getElementById('stat-pop')!;
  const statBirths = document.getElementById('stat-births')!;
  const statDeaths = document.getElementById('stat-deaths')!;
  const statTime = document.getElementById('stat-time')!;

  /** Convert simulation ticks to a time string (M:SS or H:MM:SS). 20 ticks = 1 sim-second. */
  function ticksToTime(ticks: number): string {
    const totalSeconds = Math.floor(ticks / 20);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const ss = String(seconds).padStart(2, '0');
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
    }
    return `${minutes}:${ss}`;
  }

  // ── Stats updates ──
  events.on('stats:updated', (stats) => {
    statPop.textContent = String(stats.population);
    statBirths.textContent = String(stats.births);
    statDeaths.textContent = String(stats.deaths);
    statTime.textContent = ticksToTime(stats.tick);
  });

  // ── Copy Stats button ──
  const copyStatsBtn = document.getElementById('repsim-copy-stats')!;
  copyStatsBtn.addEventListener('click', () => {
    const world = engine.world;
    const COLOR_LABELS = ['Green', 'Blue', 'Yellow', 'Red', 'Purple', 'White'];
    const colorCounts = [0, 0, 0, 0, 0, 0];
    let genSum = 0, maxGen = 0, orgCount = 0;
    const speciesSet = new Set<string>();

    for (const org of world.organisms.values()) {
      if (!org.alive) continue;
      orgCount++;
      genSum += org.generation;
      if (org.generation > maxGen) maxGen = org.generation;
      speciesSet.add(org.fingerprint);
      for (let i = 0; i < org.segmentCount; i++) {
        const idx = org.firstSegment + i;
        if (world.segments.alive[idx]) {
          const c = world.segments.color[idx];
          if (c >= 0 && c < 6) colorCounts[c]++;
        }
      }
    }

    const timeStr = ticksToTime(world.tick);
    const avgGen = orgCount > 0 ? (genSum / orgCount).toFixed(1) : '0';
    const lines = [
      `=== Repsim Stats @ ${timeStr} ===`,
      `Population: ${world.stats.population}  |  Births: ${world.stats.births}  |  Deaths: ${world.stats.deaths}`,
      `Species: ${speciesSet.size}  |  Generation: avg ${avgGen}  max ${maxGen}`,
      ``,
      `Segments by color:`,
      ...COLOR_LABELS.map((name, i) => `  ${name}: ${colorCounts[i]}`),
    ];
    const text = lines.join('\n');

    navigator.clipboard.writeText(text).then(() => {
      const prev = copyStatsBtn.textContent;
      copyStatsBtn.textContent = '✓';
      copyStatsBtn.style.color = 'var(--ui-accent)';
      setTimeout(() => {
        copyStatsBtn.textContent = prev ?? '📋';
        copyStatsBtn.style.color = '';
      }, 1200);
    }).catch(() => { /* clipboard denied */ });
  });

  // ── Speed controls ──
  const speedButtons = topBar.querySelectorAll<HTMLButtonElement>('#repsim-speed-controls .ui-btn');
  let lastSpeed = 1; // track last non-pause speed for spacebar toggle

  function activateSpeedButton(speed: number): void {
    speedButtons.forEach(b => b.classList.remove('active'));
    const target = topBar.querySelector<HTMLButtonElement>(`[data-speed="${speed}"]`);
    if (target) target.classList.add('active');
  }

  speedButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const speed = Number(btn.dataset.speed);
      activateSpeedButton(speed);
      if (speed === 0) {
        engine.setPaused(true);
      } else {
        lastSpeed = speed;
        if (engine.paused) engine.setPaused(false);
        engine.setSpeed(speed);
      }
    });
  });

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', (e) => {
    // Don't fire when user is typing in an input or textarea
    const tag = (document.activeElement as HTMLElement)?.tagName?.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (engine.paused) {
        engine.setPaused(false);
        engine.setSpeed(lastSpeed);
        activateSpeedButton(lastSpeed);
      } else {
        engine.setPaused(true);
        activateSpeedButton(0);
      }
      return;
    }

    if (e.key === '1' || e.key === '2' || e.key === '4' || e.key === '8') {
      const speed = Number(e.key);
      lastSpeed = speed;
      if (engine.paused) engine.setPaused(false);
      engine.setSpeed(speed);
      activateSpeedButton(speed);
    }
  });

  // ── Empty (kill all organisms, keep tank/config, do NOT reseed) ──
  document.getElementById('repsim-empty')!.addEventListener('click', () => {
    flushWithoutReseed(engine);
    renderer.selectedOrganismId = null;
    events.emit('organism:selected', { id: null });
    events.emit('sim:reset', undefined);
  });

  // ── Flush (kill all organisms, keep tank/config, reseed fresh) ──
  document.getElementById('repsim-flush')!.addEventListener('click', () => {
    engine.flush();
    renderer.selectedOrganismId = null;
    events.emit('organism:selected', { id: null });
  });

  // ── New Tank (full reset) ──
  document.getElementById('repsim-new-tank')!.addEventListener('click', () => {
    clearAutoSave();
    engine.reset();
    renderer.selectedOrganismId = null;
    renderer.selectedSourceType = null;
    renderer.selectedSourceId = null;
    renderer.setWallsDirty();
    events.emit('organism:selected', { id: null });
    events.emit('source:selected', { type: null, id: null });
  });

  // ── Desaturation toggle ──
  let desaturated = false;
  const desatBtn = document.getElementById('repsim-desat-toggle')!;

  desatBtn.addEventListener('click', () => {
    desaturated = !desaturated;
    renderer.setDesaturated(desaturated);
    desatBtn.style.color = desaturated ? 'var(--ui-accent)' : '';
  });

  // ── Theme toggle ──
  let currentTheme: 'dark' | 'light' = 'dark';
  const themeBtn = document.getElementById('repsim-theme-toggle')!;

  themeBtn.addEventListener('click', () => {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('light-theme', currentTheme === 'light');
    renderer.setTheme(currentTheme);
    engine.world.isLightTheme = currentTheme === 'light';
    // Swap icon: moon for dark, sun for light
    themeBtn.innerHTML = currentTheme === 'dark'
      ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M21.64 13a1 1 0 00-1.05-.14 8.05 8.05 0 01-3.37.73A8.15 8.15 0 019.08 5.49a8.59 8.59 0 01.25-2 1 1 0 00-1.28-1.18A10 10 0 1021.93 14.12a1 1 0 00-.29-1.12z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><circle cx="12" cy="12" r="4"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 5.64l2.12-2.12"/></svg>';
    // Inform the user that light sources invert between light and shadow in the two themes
    showThemeToast(
      currentTheme === 'light'
        ? 'Light sources now render as shadows'
        : 'Light sources now render as light',
    );
  });

  // ── Panel toggle ──
  let panelOpen = true;
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    panelOpen = !panelOpen;
    rightPanel.classList.toggle('collapsed', !panelOpen);
    toggleBtn.classList.toggle('collapsed', !panelOpen);
    toggleBtn.textContent = panelOpen ? '\u25B6' : '\u25C0'; // ▶ = collapse right, ◀ = expand left
    zoomControls.classList.toggle('panel-collapsed', !panelOpen);
  });

  // ── Zoom buttons ──
  const ZOOM_DELTA = 120; // equivalent to one scroll tick
  document.getElementById('zoom-recenter')!.addEventListener('click', () => {
    renderer.recenterView();
  });
  document.getElementById('zoom-in')!.addEventListener('click', () => {
    renderer.zoom(ZOOM_DELTA);
  });
  document.getElementById('zoom-out')!.addEventListener('click', () => {
    renderer.zoom(-ZOOM_DELTA);
  });

  // Track bottom panel expand/collapse to push zoom buttons up
  const bottomPanelObserver = new MutationObserver(() => {
    const bottomPanel = document.getElementById('repsim-bottom-panel');
    if (bottomPanel) {
      zoomControls.classList.toggle('tank-expanded', bottomPanel.classList.contains('expanded'));
    }
  });
  // Observe once the bottom panel exists (it's created later by environment-panel.ts)
  const waitForBottomPanel = () => {
    const bp = document.getElementById('repsim-bottom-panel');
    if (bp) {
      bottomPanelObserver.observe(bp, { attributes: true, attributeFilter: ['class'] });
    } else {
      requestAnimationFrame(waitForBottomPanel);
    }
  };
  waitForBottomPanel();

  // ── Accordion sections (with localStorage persistence) ──
  const ACCORDION_KEY = 'repsim-accordion';
  function loadAccordionState(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem(ACCORDION_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* corrupted */ }
    return {};
  }
  function saveAccordionState(state: Record<string, boolean>): void {
    try { localStorage.setItem(ACCORDION_KEY, JSON.stringify(state)); } catch { /* quota */ }
  }
  const accordionState = loadAccordionState();

  /** Wire up an accordion section: apply stored state, add click toggle with persistence */
  function wireAccordion(header: HTMLElement, body: Element, sectionId: string): void {
    const chevron = header.querySelector('.section-chevron')!;
    // Apply stored state (if exists), otherwise keep HTML default (expanded)
    if (sectionId in accordionState) {
      const shouldCollapse = !accordionState[sectionId]; // true = open, false = collapsed
      body.classList.toggle('collapsed', shouldCollapse);
      chevron.classList.toggle('collapsed', shouldCollapse);
    }
    header.addEventListener('click', () => {
      const isCollapsed = body.classList.toggle('collapsed');
      chevron.classList.toggle('collapsed', isCollapsed);
      accordionState[sectionId] = !isCollapsed;
      saveAccordionState(accordionState);
    });
  }

  rightPanel.querySelectorAll<HTMLElement>('.section-header').forEach((header) => {
    const sectionId = header.dataset.toggle!;
    const body = rightPanel.querySelector(`[data-body="${sectionId}"]`)!;
    wireAccordion(header, body, sectionId);
  });

  // ── Save & Share section (inserted between Simulation and Controls) ──
  const saveShareSection = buildSaveShareSection(engine, renderer, events, tooltips);
  const controlsSection = rightPanel.querySelector('[data-section="controls"]');
  if (controlsSection) {
    rightPanel.insertBefore(saveShareSection, controlsSection);
  } else {
    rightPanel.appendChild(saveShareSection);
  }
  // Wire save-share accordion with persistence
  const ssHeader = saveShareSection.querySelector<HTMLElement>('.section-header');
  const ssBody = saveShareSection.querySelector('[data-body="save-share"]');
  if (ssHeader && ssBody) wireAccordion(ssHeader, ssBody, 'save-share');

  // ── Focus slider (in top bar) ──
  const focusSlider = document.getElementById('focus-slider') as HTMLInputElement;

  focusSlider.addEventListener('input', () => {
    const val = parseFloat(focusSlider.value);
    renderer.setFocusDepth(val);
  });

  // Sync focus slider when alt+scroll changes focus
  renderer.getCanvas().addEventListener('focusdepthchange', ((e: CustomEvent) => {
    const val = e.detail as number;
    focusSlider.value = String(val);
    focusIndicator.textContent = `Focus: ${val.toFixed(2)}`;
    focusIndicator.classList.add('visible');
    clearTimeout(focusHideTimer);
    focusHideTimer = window.setTimeout(() => {
      focusIndicator.classList.remove('visible');
    }, 1500);
  }) as EventListener);

  let focusHideTimer = 0;

  // ── Theme toast helper ──
  let themeToastTimer = 0;
  function showThemeToast(message: string): void {
    themeToast.textContent = message;
    themeToast.classList.add('visible');
    clearTimeout(themeToastTimer);
    themeToastTimer = window.setTimeout(() => {
      themeToast.classList.remove('visible');
    }, 3000);
  }

  // ── Config sliders ──
  const configSliders = rightPanel.querySelectorAll<HTMLInputElement>('.config-slider');
  configSliders.forEach((slider) => {
    const key = slider.dataset.key!;
    const def = CONFIG_SLIDERS.find(d => d.key === key);
    const valEl = document.getElementById(`val-${key}`);

    function updateSliderVal(displayVal: number): void {
      if (!valEl) return;
      const formatted = Number.isInteger(displayVal) ? String(displayVal) : displayVal.toFixed(1);
      valEl.textContent = def?.unit ? formatted + def.unit : formatted;
    }

    slider.addEventListener('input', () => {
      const displayVal = parseFloat(slider.value);
      updateSliderVal(displayVal);
      // Inverted sliders: convert display value back to config value
      let configVal = displayVal;
      if (def?.invert) configVal = def.min + def.max - displayVal;
      (engine.config as unknown as Record<string, number | boolean>)[key] = configVal;
    });
  });

  // ── Restore Defaults button ──
  const restoreBtn = document.getElementById('restore-defaults');
  if (restoreBtn) {
    restoreBtn.addEventListener('click', () => {
      const defaults = DEFAULT_CONFIG as unknown as Record<string, number | boolean>;
      configSliders.forEach((slider) => {
        const key = slider.dataset.key!;
        const sliderDef = CONFIG_SLIDERS.find(d => d.key === key);
        const defVal = defaults[key] as number;
        if (defVal !== undefined) {
          // Invert display value for inverted sliders
          const displayVal = sliderDef?.invert ? sliderDef.min + sliderDef.max - defVal : defVal;
          slider.value = String(displayVal);
          (engine.config as unknown as Record<string, number | boolean>)[key] = defVal;
          // Sync readout
          const valEl = document.getElementById(`val-${key}`);
          if (valEl) {
            const formatted = Number.isInteger(displayVal) ? String(displayVal) : displayVal.toFixed(1);
            valEl.textContent = sliderDef?.unit ? formatted + sliderDef.unit : formatted;
          }
        }
      });
    });
  }

  // ── Virus controls ──
  const virusCheckbox = document.getElementById('virus-enabled') as HTMLInputElement;
  const virusToggleDot = document.getElementById('virus-toggle-dot')!;
  const virusSliders = rightPanel.querySelectorAll<HTMLInputElement>('.virus-slider');
  const statStrains = document.getElementById('stat-strains')!;
  const statInfected = document.getElementById('stat-infected')!;
  const virusReleaseBtn = document.getElementById('virus-release-btn')!;

  // Sync checkbox state from config
  virusCheckbox.checked = engine.config.virusEnabled;
  updateVirusToggleVisual(virusCheckbox.checked);

  function updateVirusToggleVisual(on: boolean): void {
    virusToggleDot.style.left = on ? '16px' : '2px';
    virusToggleDot.style.background = on ? 'var(--ui-accent)' : 'var(--ui-text-muted)';
    virusToggleDot.previousElementSibling!.setAttribute(
      'style',
      `position:absolute;inset:0;background:${on ? 'var(--ui-accent-dim)' : 'var(--ui-slider-track)'};border-radius:9px;transition:background 0.2s`,
    );
  }

  virusCheckbox.addEventListener('change', () => {
    engine.config.virusEnabled = virusCheckbox.checked;
    updateVirusToggleVisual(virusCheckbox.checked);
  });

  virusSliders.forEach((slider) => {
    slider.addEventListener('input', () => {
      const key = slider.dataset.vkey! as keyof typeof engine.config;
      (engine.config as unknown as Record<string, number>)[key] = parseFloat(slider.value);
    });
  });

  // Release virus button
  virusReleaseBtn.addEventListener('click', () => {
    if (!engine.config.virusEnabled) {
      engine.config.virusEnabled = true;
      virusCheckbox.checked = true;
      updateVirusToggleVisual(true);
    }

    const world = engine.world;
    const strainIdx = createSpontaneousStrain(world.virusStrains, engine.config);
    if (strainIdx < 0) return;

    // Pick a random organism and infect the whole organism
    const orgs = [...world.organisms.values()].filter(o => o.alive && o.virusInfectionCount === 0);
    if (orgs.length === 0) return;
    const org = orgs[Math.floor(Math.random() * orgs.length)];
    infectSegment(world, org.firstSegment, strainIdx, world.tick);
  });

  // Update virus stats periodically
  events.on('stats:updated', () => {
    const world = engine.world;
    let aliveStrains = 0;
    let totalInfected = 0;
    for (const strain of world.virusStrains.strains) {
      if (strain.alive) aliveStrains++;
    }
    for (const org of world.organisms.values()) {
      if (org.alive && org.virusInfectionCount > 0) totalInfected++;
    }
    statStrains.textContent = String(aliveStrains);
    statInfected.textContent = String(totalInfected);
  });

  // ── Refresh all sliders when config changes (save slot load, etc.) ──
  events.on('sim:reset', () => {
    // Right-panel config sliders
    configSliders.forEach((slider) => {
      const key = slider.dataset.key!;
      const def = CONFIG_SLIDERS.find(d => d.key === key);
      let val = (engine.config as unknown as Record<string, number>)[key];
      if (def?.invert) val = def.min + def.max - val;
      slider.value = String(val);
      // Sync readout
      const valEl = document.getElementById(`val-${key}`);
      if (valEl) {
        const formatted = Number.isInteger(val) ? String(val) : val.toFixed(1);
        valEl.textContent = def?.unit ? formatted + def.unit : formatted;
      }
    });

    // Virus controls
    virusCheckbox.checked = engine.config.virusEnabled;
    updateVirusToggleVisual(virusCheckbox.checked);
    virusSliders.forEach((slider) => {
      const vkey = slider.dataset.vkey! as keyof typeof engine.config;
      slider.value = String(engine.config[vkey]);
    });
  });

  // ── Organism selection ──
  const orgInfoEl = document.getElementById('repsim-org-info')!;

  // Share Genome button (persistent, shown when organism is selected)
  const shareBtn = createShareButton(
    engine,
    () => renderer.selectedOrganismId,
    tooltips,
  );
  shareBtn.style.display = 'none';
  orgInfoEl.parentElement!.appendChild(shareBtn);

  // Edit in Inspector button (shown when organism is selected)
  const inspectorBtn = document.createElement('button');
  inspectorBtn.className = 'ui-btn';
  inspectorBtn.textContent = '🔬 Edit in Inspector';
  inspectorBtn.style.cssText = 'width:100%;margin-top:4px;display:none;';
  inspectorBtn.addEventListener('click', () => {
    const orgId = renderer.selectedOrganismId;
    if (orgId === null) return;
    const org = engine.world.organisms.get(orgId);
    if (!org?.alive) return;
    saveOrganismToInspectorSync(org.genome, org.generation, org.name);
    autoSave(engine);                     // Snapshot tank state to sessionStorage before leaving
    window.location.href = '/inspector/'; // Same-tab navigation — sessionStorage survives the round-trip
  });
  orgInfoEl.parentElement!.appendChild(inspectorBtn);

  // Spawn from URL input (always visible in organism section)
  const spawnInput = createSpawnInput(engine);
  orgInfoEl.parentElement!.appendChild(spawnInput);

  // Organism save slots (persistent across sessions)
  const orgSlots = buildOrganismSlots(engine, () => renderer.selectedOrganismId);
  orgInfoEl.parentElement!.appendChild(orgSlots);

  function updateOrgInfo(org: Organism | undefined): void {
    orgInfoEl.innerHTML = renderOrganismInfo(org);
    const alive = org?.alive ? '' : 'none';
    shareBtn.style.display = alive;
    inspectorBtn.style.display = alive;
  }

  renderer.onOrganismSelected = (id: number | null) => {
    events.emit('organism:selected', { id });
  };

  events.on('organism:selected', (data) => {
    if (data.id === null) {
      updateOrgInfo(undefined);
    } else {
      const org = engine.world.organisms.get(data.id);
      updateOrgInfo(org);
    }
  });

  // Update organism info periodically if selected
  events.on('stats:updated', () => {
    if (renderer.selectedOrganismId !== null) {
      const org = engine.world.organisms.get(renderer.selectedOrganismId);
      updateOrgInfo(org);
    }
  });

  // ── Tool icons (in top bar) ──
  const toolBtns = topBar.querySelectorAll<HTMLButtonElement>('.tool-icon');
  toolBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = Number(btn.dataset.tool) as ToolMode;
      toolBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderer.setToolMode(mode);
      events.emit('tool:changed', { mode });
    });
  });

  // ── Tool mode indicator (bottom-left canvas badge) ──
  events.on('tool:changed', ({ mode }) => {
    const text = TOOL_INDICATOR_TEXT[mode];
    if (text) {
      toolIndicator.textContent = text;
      toolIndicator.classList.add('visible');
    } else {
      toolIndicator.classList.remove('visible');
    }
  });

  // ── Source selection — forward to bottom environment panel via events ──
  renderer.onSourceSelected = (type, id) => {
    events.emit('source:selected', { type: type ?? null, id: id ?? null });
  };

  // ── Attach tooltips to all interactive elements ──
  if (tooltips) {
    // Top bar stats
    const statEls: Record<string, string> = {
      'stat-pop': 'stat-pop',
      'stat-births': 'stat-births',
      'stat-deaths': 'stat-deaths',
      'stat-time-wrap': 'stat-time',
    };
    for (const [id, key] of Object.entries(statEls)) {
      const el = document.getElementById(id);
      if (el) tooltips.attach(el, key);
    }

    // Tool icons
    const toolKeys = ['tool-select', 'tool-tank', 'tool-light', 'tool-temp', 'tool-current'];
    topBar.querySelectorAll('#repsim-tool-icons .tool-icon').forEach((btn, i) => {
      if (toolKeys[i]) tooltips.attach(btn as HTMLElement, toolKeys[i]);
    });

    // Speed controls
    speedButtons.forEach((btn) => {
      const speed = btn.dataset.speed;
      const key = speed === '0' ? 'speed-pause' : `speed-${speed}`;
      tooltips.attach(btn, key);
    });

    // New Tank + Theme toggle
    const newTank = document.getElementById('repsim-new-tank');
    const flushBtn = document.getElementById('repsim-flush');
    const emptyBtn = document.getElementById('repsim-empty');
    if (emptyBtn) tooltips.attach(emptyBtn, 'empty');
    if (flushBtn) tooltips.attach(flushBtn, 'flush');
    if (newTank) tooltips.attach(newTank, 'new-tank');
    const themeBtn = document.getElementById('repsim-theme-toggle');
    if (themeBtn) tooltips.attach(themeBtn, 'theme-toggle');

    // Config sliders
    rightPanel.querySelectorAll('.slider-row').forEach((row) => {
      const input = row.querySelector<HTMLInputElement>('.config-slider');
      if (input?.dataset.key) {
        tooltips.attach(row as HTMLElement, `slider-${input.dataset.key}`);
      }
    });

    // Virus controls
    const virusSection = rightPanel.querySelector('[data-section="virus"]');
    if (virusSection) {
      const virusToggle = virusSection.querySelector('.toggle-wrap');
      if (virusToggle) tooltips.attach(virusToggle as HTMLElement, 'virus-enabled');
      virusSection.querySelectorAll('.slider-row').forEach((row) => {
        const label = row.querySelector('.slider-label')?.textContent?.toLowerCase();
        if (label?.includes('virulence')) tooltips.attach(row as HTMLElement, 'virus-virulence');
        else if (label?.includes('transmit')) tooltips.attach(row as HTMLElement, 'virus-transmission');
        else if (label?.includes('defense')) tooltips.attach(row as HTMLElement, 'virus-immunity');
      });
      const releaseBtn = virusSection.querySelector('.ui-btn');
      if (releaseBtn) tooltips.attach(releaseBtn as HTMLElement, 'virus-release');
    }

    // Focus depth slider (in top bar)
    const topFocusGroup = topBar.querySelector('.top-focus-group');
    if (topFocusGroup) tooltips.attach(topFocusGroup as HTMLElement, 'focus-slider');

    // Tooltips ON/OFF toggle in Controls section (HTML is in controlsContent template)
    const tooltipCheckbox = document.getElementById('repsim-tooltips-checkbox') as HTMLInputElement | null;
    const tooltipDot = document.getElementById('repsim-tooltips-dot');
    if (tooltipCheckbox) {
      tooltipCheckbox.checked = tooltips.isEnabled();
      // Sync dot style on load
      if (tooltipDot) {
        tooltipDot.style.left = tooltipCheckbox.checked ? '16px' : '2px';
        tooltipDot.style.background = tooltipCheckbox.checked ? 'var(--ui-accent)' : 'var(--ui-text-muted)';
      }
      tooltipCheckbox.addEventListener('change', () => {
        tooltips.setEnabled(tooltipCheckbox.checked);
        if (tooltipDot) {
          tooltipDot.style.left = tooltipCheckbox.checked ? '16px' : '2px';
          tooltipDot.style.background = tooltipCheckbox.checked ? 'var(--ui-accent)' : 'var(--ui-text-muted)';
        }
      });
      const tooltipRow = document.getElementById('repsim-tooltips-row');
      if (tooltipRow) tooltips.attach(tooltipRow, 'tooltips-toggle');
    }
  }
}
