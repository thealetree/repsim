/**
 * main.ts — Inspector entry point.
 *
 * Bootstrap sequence:
 * 1. Load genome: ?o= URL param → repsim:inspector-context localStorage → random
 * 2. Create inspector engine (single-rep physics)
 * 3. Create inspector renderer (circular petri dish, PixiJS)
 * 4. Attach canvas to #app
 * 5. Create genome editor (canvas click/drag interaction)
 * 6. Create inspector UI (all panels)
 * 7. Start game loop (60fps rendering, 20Hz physics internally)
 * 8. Handle resize
 */

import { createInspectorEngine, randomInspectorGenome } from './inspector-engine';
import { createInspectorRenderer } from './inspector-renderer';
import { createGenomeEditor } from './genome-editor';
import { createInspectorUI } from './inspector-ui';
import type { Genome } from '../types';

// ─── Genome Loading ───────────────────────────────────────────

function base64urlDecode(str: string): Uint8Array {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function decompress(b64: string): Promise<string> {
  const buf = base64urlDecode(b64);
  const stream = new Blob([buf.buffer as ArrayBuffer]).stream().pipeThrough(
    new DecompressionStream('deflate')
  );
  return await new Response(stream).text();
}

async function loadGenome(): Promise<Genome> {
  // 1. Check ?o= URL param (same format as main sim sharing)
  const params = new URLSearchParams(window.location.search);
  if (params.has('o')) {
    try {
      const json = await decompress(params.get('o')!);
      const payload = JSON.parse(json);
      if (payload.v === 1 && Array.isArray(payload.g) && payload.g.length > 0) {
        console.log(`🔬 Inspector: loaded shared organism "${payload.n}"`);
        // Clean URL without reloading
        window.history.replaceState({}, '', window.location.pathname);
        return payload.g as Genome;
      }
    } catch (err) {
      console.warn('Inspector: failed to parse ?o= param:', err);
    }
  }

  // 2. Check localStorage for sim→inspector context
  const ctx = localStorage.getItem('repsim:inspector-context');
  if (ctx) {
    try {
      const parsed = JSON.parse(ctx);
      // New format: plain JSON payload (synchronous save, no compression)
      if (parsed.payload?.v === 1 && Array.isArray(parsed.payload.g) && parsed.payload.g.length > 0) {
        console.log(`🔬 Inspector: loaded organism from sim "${parsed.payload.n}"`);
        return parsed.payload.g as Genome;
      }
      // Legacy format: compressed payload
      if (parsed.encoded) {
        const json = await decompress(parsed.encoded);
        const payload = JSON.parse(json);
        if (payload.v === 1 && Array.isArray(payload.g) && payload.g.length > 0) {
          console.log(`🔬 Inspector: loaded organism from sim "${payload.n}"`);
          return payload.g as Genome;
        }
      }
    } catch (err) {
      console.warn('Inspector: failed to parse inspector-context:', err);
    }
  }

  // 3. Fall back to random genome
  console.log('🔬 Inspector: starting with random genome');
  return randomInspectorGenome();
}


// ─── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🔬 Rep Inspector — Starting up...');

  // ── 1. Load initial genome ──
  const genome = await loadGenome();

  // ── 2. Create engine ──
  const engine = createInspectorEngine(genome);

  // ── 3. Create renderer ──
  const renderer = await createInspectorRenderer(window.innerWidth, window.innerHeight);

  // ── 4. Attach canvas to #app ──
  const appDiv = document.getElementById('app')!;
  appDiv.appendChild(renderer.getCanvas());

  // ── 5. Create genome editor (canvas events: click-to-select, drag-drop, scroll) ──
  const editor = createGenomeEditor(engine, renderer);

  // ── 6. Create inspector UI (top bar, left/right/bottom panels) ──
  createInspectorUI(engine, renderer, editor);

  // ── 7. Game loop ──
  let lastTime = performance.now();

  function gameLoop(currentTime: number): void {
    const deltaMs = currentTime - lastTime;
    lastTime = currentTime;
    const deltaSeconds = Math.min(deltaMs / 1000, 0.1);

    engine.update(deltaSeconds);

    const now = currentTime / 1000;
    renderer.render(engine.world, engine.selectedGeneIdx, editor.ghost, now);
    renderer.updateCamera();

    requestAnimationFrame(gameLoop);
  }

  requestAnimationFrame(gameLoop);
  console.log('🔬 Rep Inspector — Running!');

  // ── 8. Handle resize ──
  window.addEventListener('resize', () => {
    renderer.resize(window.innerWidth, window.innerHeight);
  });

  // ── Debug ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__inspectorEngine = engine;
  (window as any).__inspectorRenderer = renderer;
}

main().catch(console.error);
