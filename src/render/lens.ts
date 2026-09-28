import type { OrbitCamera, Vec3 } from "./camera";
import { rotate, type Mat3 } from "./orient";

// The geometry between the heart and the canvas that has no GPU in it, so it can be tested: where panels
// leave room, how far back the camera goes to fit the heart in that room, the matrix from the grid frame to
// the screen, and projecting a point to canvas pixels. Canvas pixels are CSS pixels from the top left, the
// same space pick() and onTap use.

/** The part of the canvas that panels cover, in CSS pixels. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The narrowest or shortest free area worth fitting the heart into, in CSS pixels. */
const MIN_FREE = 120;

/** Column-major 4x4 product a * b. */
export function mul4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  return out;
}

/**
 * The canvas minus the panels. An inset that is not a number, or is negative, counts as none, and insets that
 * would leave less than MIN_FREE on an axis are ignored on that axis.
 */
export function freeRect(width: number, height: number, insets: Insets) {
  const clean = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  let left = clean(insets.left);
  let right = clean(insets.right);
  let top = clean(insets.top);
  let bottom = clean(insets.bottom);
  if (width - left - right < MIN_FREE) left = right = 0;
  if (height - top - bottom < MIN_FREE) top = bottom = 0;
  const x0 = left, x1 = width - right, y0 = top, y1 = height - bottom;
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

/**
 * The lens shift, in clip units, that carries the middle of the picture to the middle of the free rectangle:
 * x is positive to move the picture right, y positive to move it up. Zero without insets.
 */
export function lensShift(width: number, height: number, insets: Insets): [number, number] {
  const r = freeRect(width, height, insets);
  return [((r.cx - width / 2) * 2) / width, ((height / 2 - r.cy) * 2) / height];
}

/**
 * How far from the target the camera must be for a set of points to fit the free rectangle, with perspective:
 * a point nearer the camera looks bigger. view holds the points as triples (across, up, along), mm from the
 * target, across to the right of the picture, up up it, and along the line of sight positive away from the
 * camera. margin (1 or more) leaves room round the outermost point. The picture is one size for the whole
 * canvas, so a smaller free area means backing away. Each point needs
 * distance >= margin * max(|across| / kx, |up| / ky) - along, and the answer is the largest of these.
 */
export function fitDistanceToPoints(view: Float32Array, fovY: number, aspect: number, width: number, height: number, insets: Insets, margin: number): number {
  const r = freeRect(width, height, insets);
  const tanHalf = Math.tan(fovY / 2);
  const kx = tanHalf * aspect * (r.w / width);
  const ky = tanHalf * (r.h / height);
  let d = 0;
  for (let i = 0; i < view.length; i += 3) {
    const need = margin * Math.max(Math.abs(view[i]) / kx, Math.abs(view[i + 1]) / ky) - view[i + 2];
    if (need > d) d = need;
  }
  return d;
}

/**
 * The matrix from the grid frame (mm) to clip space: the pose that stands the heart up (grid to display frame,
 * turning about the grid point pivot, which lands on centre, the camera's target), then the orbit camera, then
 * the lens shift.
 */
export function gridViewProjection(camera: OrbitCamera, pose: Mat3, pivot: Vec3, centre: Vec3, shift: [number, number]): Float32Array {
  const t = rotate(pose, pivot);
  const model = new Float32Array([pose[0], pose[3], pose[6], 0, pose[1], pose[4], pose[7], 0, pose[2], pose[5], pose[8], 0, centre[0] - t[0], centre[1] - t[1], centre[2] - t[2], 1]);
  const lift = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, shift[0], shift[1], 0, 1]);
  return mul4(lift, mul4(camera.viewProjection(), model));
}

/**
 * A grid-frame point (mm) in canvas pixels. w is its depth in front of the camera: zero or less means the
 * point is behind it, and then x and y are NaN.
 */
export function projectToCanvas(viewProj: ArrayLike<number>, p: Vec3, width: number, height: number): { x: number; y: number; w: number } {
  const m = viewProj;
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  if (w <= 1e-6) return { x: NaN, y: NaN, w };
  const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  return { x: (cx / w * 0.5 + 0.5) * width, y: (0.5 - (cy / w) * 0.5) * height, w };
}

/**
 * The pixel of the plain, unshifted camera picture that a pixel of the shifted picture shows: what to give the
 * camera to get the ray through a pixel.
 */
export function unshiftPixel(px: number, py: number, width: number, height: number, shift: [number, number]): [number, number] {
  return [px - (shift[0] * width) / 2, py + (shift[1] * height) / 2];
}
