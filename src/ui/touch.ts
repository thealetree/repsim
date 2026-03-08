/**
 * touch.ts — Touch gesture handler for mobile Repsim V2
 *
 * Translates touch gestures into camera and tool operations:
 * - Single finger drag = pan
 * - Single finger tap = tool dispatch (select, place source, etc.)
 * - Two finger pinch = zoom (toward midpoint)
 * - Two finger pan = simultaneous pan while pinching
 */

import type { Camera } from '../types';
import { panCamera, zoomCameraTo } from '../rendering/camera';
import { ToolMode } from '../types';

// ─── Types ───────────────────────────────────────────────────

export interface ToolDispatch {
  selectClick(wx: number, wy: number): void;
  tankClick(clientX: number, clientY: number): void;
  lightClick(wx: number, wy: number): void;
  temperatureClick(wx: number, wy: number): void;
  currentClick(wx: number, wy: number): void;
  screenToWorld(sx: number, sy: number): { wx: number; wy: number };
  getScreenDimensions(): { width: number; height: number };
  getToolMode(): number;
}

// ─── Constants ───────────────────────────────────────────────

const TAP_MAX_DISTANCE = 10;   // px — if finger moves more, it becomes a pan
const TAP_MAX_DURATION = 300;  // ms

// ─── Setup ───────────────────────────────────────────────────

export function setupTouchInput(
  canvas: HTMLCanvasElement,
  camera: Camera,
  dispatch: ToolDispatch,
): { destroy(): void } {

  type GestureState = 'none' | 'tap-pending' | 'pan' | 'pinch';
  let gestureState: GestureState = 'none';

  // Single-finger tracking
  let tapStartTime = 0;
  let tapStartX = 0;
  let tapStartY = 0;
  let lastTouchX = 0;
  let lastTouchY = 0;

  // Two-finger tracking
  let lastPinchDist = 0;
  let lastMidX = 0;
  let lastMidY = 0;

  function getTouchDistance(t1: Touch, t2: Touch): number {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function getTouchMidpoint(t1: Touch, t2: Touch): { x: number; y: number } {
    return {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2,
    };
  }

  function clientToScreen(clientX: number, clientY: number): { sx: number; sy: number } {
    const rect = canvas.getBoundingClientRect();
    const dims = dispatch.getScreenDimensions();
    const scaleX = dims.width / rect.width;
    const scaleY = dims.height / rect.height;
    return {
      sx: (clientX - rect.left) * scaleX,
      sy: (clientY - rect.top) * scaleY,
    };
  }

  function dispatchToolTap(clientX: number, clientY: number): void {
    const { sx, sy } = clientToScreen(clientX, clientY);
    const { wx, wy } = dispatch.screenToWorld(sx, sy);
    const mode = dispatch.getToolMode();

    switch (mode) {
      case ToolMode.Select:
        dispatch.selectClick(wx, wy);
        break;
      case ToolMode.Tank:
        dispatch.tankClick(clientX, clientY);
        break;
      case ToolMode.Light:
        dispatch.lightClick(wx, wy);
        break;
      case ToolMode.Temperature:
        dispatch.temperatureClick(wx, wy);
        break;
      case ToolMode.Current:
        dispatch.currentClick(wx, wy);
        break;
    }
  }

  // ─── Event Handlers ──────────────────────────────────────

  function onTouchStart(e: TouchEvent): void {
    e.preventDefault();

    if (e.touches.length === 1) {
      const t = e.touches[0];
      tapStartTime = performance.now();
      tapStartX = t.clientX;
      tapStartY = t.clientY;
      lastTouchX = t.clientX;
      lastTouchY = t.clientY;
      gestureState = 'tap-pending';
    } else if (e.touches.length === 2) {
      // Switch to pinch
      const dist = getTouchDistance(e.touches[0], e.touches[1]);
      const mid = getTouchMidpoint(e.touches[0], e.touches[1]);
      lastPinchDist = dist;
      lastMidX = mid.x;
      lastMidY = mid.y;
      gestureState = 'pinch';
    }
  }

  function onTouchMove(e: TouchEvent): void {
    e.preventDefault();

    if (e.touches.length === 1 && gestureState !== 'pinch') {
      const t = e.touches[0];
      const dx = t.clientX - tapStartX;
      const dy = t.clientY - tapStartY;

      if (gestureState === 'tap-pending') {
        // Check if we've moved enough to become a pan
        if (Math.sqrt(dx * dx + dy * dy) > TAP_MAX_DISTANCE) {
          gestureState = 'pan';
        }
      }

      if (gestureState === 'pan') {
        const moveDx = t.clientX - lastTouchX;
        const moveDy = t.clientY - lastTouchY;
        panCamera(camera, moveDx, moveDy);
      }

      lastTouchX = t.clientX;
      lastTouchY = t.clientY;

    } else if (e.touches.length === 2 && gestureState === 'pinch') {
      const dist = getTouchDistance(e.touches[0], e.touches[1]);
      const mid = getTouchMidpoint(e.touches[0], e.touches[1]);
      const dims = dispatch.getScreenDimensions();

      // Proportional zoom: new zoom = start zoom * (current distance / start distance)
      if (lastPinchDist > 0) {
        const scale = dist / lastPinchDist;
        const newZoom = camera.zoom * scale;
        const { sx, sy } = clientToScreen(mid.x, mid.y);
        zoomCameraTo(camera, newZoom, sx, sy, dims.width, dims.height);
      }

      // Simultaneous pan from midpoint movement
      const panDx = mid.x - lastMidX;
      const panDy = mid.y - lastMidY;
      if (Math.abs(panDx) > 0.5 || Math.abs(panDy) > 0.5) {
        panCamera(camera, panDx, panDy);
      }

      lastPinchDist = dist;
      lastMidX = mid.x;
      lastMidY = mid.y;
    }
  }

  function onTouchEnd(e: TouchEvent): void {
    e.preventDefault();

    if (gestureState === 'tap-pending') {
      const elapsed = performance.now() - tapStartTime;
      if (elapsed < TAP_MAX_DURATION) {
        dispatchToolTap(tapStartX, tapStartY);
      }
    }

    if (e.touches.length === 1 && gestureState === 'pinch') {
      // One finger lifted during pinch — transition to pan with remaining finger
      const t = e.touches[0];
      lastTouchX = t.clientX;
      lastTouchY = t.clientY;
      gestureState = 'pan';
    } else if (e.touches.length === 0) {
      gestureState = 'none';
    }
  }

  function onTouchCancel(e: TouchEvent): void {
    e.preventDefault();
    gestureState = 'none';
  }

  // ─── Register ──────────────────────────────────────────────

  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  canvas.addEventListener('touchcancel', onTouchCancel, { passive: false });

  return {
    destroy(): void {
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchCancel);
    },
  };
}
