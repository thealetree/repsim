/**
 * camera.ts — Camera system for pan and zoom
 *
 * The camera controls what portion of the world is visible on screen.
 * It supports:
 * - Mouse wheel zoom (zoom toward/away from cursor position)
 * - Click-and-drag panning (middle mouse button)
 *
 * The camera doesn't move the canvas — instead, it transforms a PixiJS
 * Container that holds all world-space objects. The math:
 *   screenX = (worldX - camera.x) * zoom + screenWidth/2
 *   screenY = (worldY - camera.y) * zoom + screenHeight/2
 */

import type { Camera } from '../types';
import {
  CAMERA_DEFAULT_ZOOM,
  CAMERA_MIN_ZOOM,
  CAMERA_MAX_ZOOM,
  CAMERA_ZOOM_SPEED,
} from '../constants';


/**
 * Create a new camera with default settings.
 * Starts centered at world origin (0, 0) with default zoom.
 */
export function createCamera(): Camera {
  return {
    x: 0,
    y: 0,
    zoom: CAMERA_DEFAULT_ZOOM,
    minZoom: CAMERA_MIN_ZOOM,
    maxZoom: CAMERA_MAX_ZOOM,
  };
}


/**
 * Apply zoom centered on a specific screen point.
 * This makes zooming feel natural — like Google Maps, the point under
 * the cursor stays in place while everything else scales around it.
 *
 * How it works:
 * 1. Convert cursor screen position to world position BEFORE zoom
 * 2. Apply the zoom
 * 3. Convert the same screen position to world position AFTER zoom
 * 4. Adjust camera so the world point under the cursor stays put
 *
 * @param camera The camera to modify
 * @param delta Scroll delta (positive = zoom in, negative = zoom out)
 * @param screenX Cursor X on screen
 * @param screenY Cursor Y on screen
 * @param screenWidth Canvas width
 * @param screenHeight Canvas height
 */
export function zoomCamera(
  camera: Camera,
  delta: number,
  screenX: number,
  screenY: number,
  screenWidth: number,
  screenHeight: number,
): void {
  // Step 1: Where is the cursor in world space BEFORE zooming?
  const worldXBefore = (screenX - screenWidth / 2) / camera.zoom + camera.x;
  const worldYBefore = (screenY - screenHeight / 2) / camera.zoom + camera.y;

  // Step 2: Apply zoom (multiply by factor so it feels proportional)
  const zoomFactor = 1 + (delta > 0 ? CAMERA_ZOOM_SPEED : -CAMERA_ZOOM_SPEED);
  camera.zoom = Math.max(
    camera.minZoom,
    Math.min(camera.maxZoom, camera.zoom * zoomFactor),
  );

  // Step 3: Where is the cursor in world space AFTER zooming?
  const worldXAfter = (screenX - screenWidth / 2) / camera.zoom + camera.x;
  const worldYAfter = (screenY - screenHeight / 2) / camera.zoom + camera.y;

  // Step 4: Adjust camera so the world point under cursor hasn't moved
  camera.x += worldXBefore - worldXAfter;
  camera.y += worldYBefore - worldYAfter;
}


/**
 * Pan the camera by a screen-space offset (e.g., from mouse drag).
 * Divides by zoom so panning speed feels consistent at any zoom level.
 *
 * @param camera The camera to modify
 * @param screenDX How far the mouse moved on screen (X)
 * @param screenDY How far the mouse moved on screen (Y)
 */
export function panCamera(camera: Camera, screenDX: number, screenDY: number): void {
  // Divide by zoom so panning is slower when zoomed in, faster when zoomed out
  camera.x -= screenDX / camera.zoom;
  camera.y -= screenDY / camera.zoom;
}
