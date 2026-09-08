/**
 * Zoom / pan maths for the shared image viewer (the fullscreen lightbox
 * and the `kind: 'image'` editor tab). Pure and dependency-free so the
 * geometry is unit-tested on its own; the Angular component
 * (`src/app/image-viewer/`) holds the signals and DOM listeners.
 */

export const IMAGE_SCALE_MIN = 0.1;
export const IMAGE_SCALE_MAX = 8;
/** `factor = exp(-deltaY * this)` per wheel event -- smooth, direction from the sign. */
export const IMAGE_ZOOM_WHEEL_SENSITIVITY = 0.0015;
/** Multiplicative step for the `+` / `-` keys and the on-screen buttons. */
export const IMAGE_ZOOM_STEP = 1.2;

/**
 * Clamps a scale to `[MIN, MAX]` and snaps it to a 0.01 grid so a long run
 * of wheel/step events can't accumulate float drift. Non-finite input
 * (a stray `NaN`) falls back to 1 -- mirrors `clampEditorFontScale`.
 */
export function clampImageScale(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  const clamped = Math.min(IMAGE_SCALE_MAX, Math.max(IMAGE_SCALE_MIN, n));
  return Math.round(clamped * 100) / 100;
}

export interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Zooms about `cursor` so the image-space point currently under the cursor
 * stays put. All coordinates are stage-local px (origin at the stage's
 * top-left); `center` is the stage centre, which is the CSS
 * `transform-origin`. `factor` is the desired multiplicative scale change
 * (clamped here).
 *
 *   p       = (cursor - center - offset) / scale        // image-space point
 *   scale'  = clamp(scale * factor)
 *   offset' = cursor - center - p * scale'
 */
export function zoomToward(vp: Viewport, cursor: Point, center: Point, factor: number): Viewport {
  const nextScale = clampImageScale(vp.scale * factor);
  const px = (cursor.x - center.x - vp.offsetX) / vp.scale;
  const py = (cursor.y - center.y - vp.offsetY) / vp.scale;
  return {
    scale: nextScale,
    offsetX: cursor.x - center.x - px * nextScale,
    offsetY: cursor.y - center.y - py * nextScale,
  };
}

/**
 * The scale that fits `natural` inside `box` without upscaling past 100%.
 * A zero/unknown natural size (an SVG whose `naturalWidth` is 0) yields 1.
 */
export function fitScale(natural: { w: number; h: number }, box: { w: number; h: number }): number {
  if (!(natural.w > 0) || !(natural.h > 0) || !(box.w > 0) || !(box.h > 0)) {
    return 1;
  }
  return clampImageScale(Math.min(1, box.w / natural.w, box.h / natural.h));
}
