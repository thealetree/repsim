/**
 * touch.ts — Touch gesture handler for mobile Repsim V2
 *
 * Translates touch gestures into camera and mouse operations:
 * - Single finger = left mouse (click, drag, select, place sources, paint walls)
 * - Two finger pinch = zoom (toward midpoint)
 * - Two finger pan = camera pan
 *
 * Single-finger touches synthesize MouseEvents so all existing mouse-based
 * interactions in the renderer work without any changes.
 */

import type { Camera } from '../types';
import { panCamera, zoomCameraTo } from '../rendering/camera';

// ─── Types ───────────────────────────────────────────────────

export interface TouchDispatch {
  getScreenDimensions(): { width: number; height: number };
}

// ─── Setup ───────────────────────────────────────────────────

export function setupTouchInput(
  canvas: HTMLCanvasElement,
  camera: Camera,
  dispatch: TouchDispatch,
): { destroy(): void } {

  type GestureState = 'none' | 'single' | 'pinch';
  let gestureState: GestureState = 'none';

  // Single-finger tracking
  let lastTouchX = 0;
  let lastTouchY = 0;
  let mouseIsDown = false;

  // Two-finger tracking
  let lastPinchDist = 0;
  let lastMidX = 0;
  let lastMidY = 0;

  // ─── Helpers ──────────────────────────────────────────────

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

  /** Synthesize a MouseEvent so existing renderer mouse handlers fire */
  function fireMouseEvent(
    type: string,
    clientX: number,
    clientY: number,
    target: EventTarget = canvas,
  ): void {
    const isUpOrClick = type === 'mouseup' || type === 'click';
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: 0,
      buttons: isUpOrClick ? 0 : 1,
    });
    target.dispatchEvent(event);
  }

  // ─── Event Handlers ──────────────────────────────────────

  function onTouchStart(e: TouchEvent): void {
    e.preventDefault();

    if (e.touches.length === 1 && gestureState === 'none') {
      // Single finger → act as left mouse button
      const t = e.touches[0];
      gestureState = 'single';
      lastTouchX = t.clientX;
      lastTouchY = t.clientY;
      mouseIsDown = true;
      fireMouseEvent('mousedown', t.clientX, t.clientY);

    } else if (e.touches.length === 2) {
      // Cancel any in-progress mouse interaction before starting pinch
      if (mouseIsDown) {
        fireMouseEvent('mouseup', lastTouchX, lastTouchY);
        mouseIsDown = false;
      }
      // Switch to pinch/pan
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

    if (e.touches.length === 1 && gestureState === 'single') {
      // Single finger drag → synthesize mousemove
      const t = e.touches[0];
      fireMouseEvent('mousemove', t.clientX, t.clientY);
      lastTouchX = t.clientX;
      lastTouchY = t.clientY;

    } else if (e.touches.length === 2 && gestureState === 'pinch') {
      const dist = getTouchDistance(e.touches[0], e.touches[1]);
      const mid = getTouchMidpoint(e.touches[0], e.touches[1]);
      const dims = dispatch.getScreenDimensions();

      // Proportional zoom toward midpoint
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

    if (gestureState === 'single' && e.touches.length === 0) {
      // Finger lifted → mouseup + click
      if (mouseIsDown) {
        fireMouseEvent('mouseup', lastTouchX, lastTouchY);
        fireMouseEvent('click', lastTouchX, lastTouchY);
        mouseIsDown = false;
      }
      gestureState = 'none';

    } else if (gestureState === 'pinch') {
      if (e.touches.length === 0) {
        // Both fingers lifted — done
        gestureState = 'none';
      }
      // If one finger remains after pinch, stay in pinch state
      // to avoid accidental clicks at the end of a zoom gesture.
      // User must lift all fingers and start fresh.
    }
  }

  function onTouchCancel(e: TouchEvent): void {
    e.preventDefault();
    if (mouseIsDown) {
      fireMouseEvent('mouseup', lastTouchX, lastTouchY);
      mouseIsDown = false;
    }
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
