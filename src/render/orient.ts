import type { HeartGrid } from "../data/loadHeart";
import type { Vec3 } from "./camera";
import { distanceTransform } from "./fields";

// Where the heart points, found from the muscle mask, so the renderer can stand it up in a natural pose
// whatever the frame of the source data. Three rows of a 3x3 matrix, row-major.
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface HeartFrame {
  /** Centroid of the muscle, mm. */
  centroid: Vec3;
  /** Unit long axis, from the open base toward the apex. */
  apex: Vec3;
  /** Unit vector at right angles to the apex axis, from the thick left-ventricle wall toward the thin right-ventricle wall. */
  rv: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Rotate a vector by the matrix. */
export function rotate(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** Rotate a vector by the inverse (the transpose) of the matrix. */
export function rotateBack(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
}

/** Largest value in a window of 2 * radius + 1 along one axis (a cube filter is three of these). */
function maxAlong(src: Float32Array, dims: number[], axis: number, radius: number): Float32Array {
  const dst = new Float32Array(src.length);
  const strides = [1, dims[0], dims[0] * dims[1]];
  const n = dims[axis];
  const stride = strides[axis];
  const a = (axis + 1) % 3;
  const b = (axis + 2) % 3;
  for (let j = 0; j < dims[b]; j++)
    for (let i = 0; i < dims[a]; i++) {
      const base = i * strides[a] + j * strides[b];
      for (let q = 0; q < n; q++) {
        let m = 0;
        for (let k = Math.max(0, q - radius); k <= Math.min(n - 1, q + radius); k++) m = Math.max(m, src[base + k * stride]);
        dst[base + q * stride] = m;
      }
    }
  return dst;
}

/** How many millimetres in from the end of the muscle its cross-section reaches 80% of its steady value. */
function rise(profile: number[]): number {
  const steady = [...profile.slice(10, 25)].sort((p, q) => p - q)[Math.floor((Math.min(profile.length, 25) - 10) / 2)] ?? 1;
  for (let k = 0; k < profile.length; k++) if (profile[k] >= 0.8 * steady) return k;
  return profile.length;
}

/**
 * The heart's long axis and its right-ventricle side. The long axis is the principal axis of the muscle.
 * The base is the end that is cut flat (its cross-section is already full a few millimetres in) while
 * the apex is blunt and rounded (its cross-section swells over several more). The right ventricle is
 * where the muscle is thin, seen from the thick left-ventricle wall, in the middle of the ventricles.
 */
export function heartFrame(grid: HeartGrid): HeartFrame {
  const { nx, ny, nz, voxelMm: h, tissue } = grid;
  const pts: number[] = [];
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) if (tissue[x + nx * (y + ny * z)] > 0) pts.push((x + 0.5) * h, (y + 0.5) * h, (z + 0.5) * h);
  const n = pts.length / 3;
  if (n === 0) throw new Error("the heart grid has no muscle voxels");

  const c: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += pts[3 * i + k] / n;
  const cov = [0, 0, 0, 0, 0, 0]; // xx yy zz xy xz yz
  for (let i = 0; i < n; i++) {
    const dx = pts[3 * i] - c[0], dy = pts[3 * i + 1] - c[1], dz = pts[3 * i + 2] - c[2];
    cov[0] += dx * dx; cov[1] += dy * dy; cov[2] += dz * dz;
    cov[3] += dx * dy; cov[4] += dx * dz; cov[5] += dy * dz;
  }
  let v: Vec3 = unit([1, 0.37, 0.21]);
  for (let it = 0; it < 100; it++) {
    v = unit([
      cov[0] * v[0] + cov[3] * v[1] + cov[4] * v[2],
      cov[3] * v[0] + cov[1] * v[1] + cov[5] * v[2],
      cov[4] * v[0] + cov[5] * v[1] + cov[2] * v[2],
    ]);
  }

  // cross-section per millimetre along the axis, and which end is the flat cut
  const proj = new Float64Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    proj[i] = (pts[3 * i] - c[0]) * v[0] + (pts[3 * i + 1] - c[1]) * v[1] + (pts[3 * i + 2] - c[2]) * v[2];
    lo = Math.min(lo, proj[i]);
    hi = Math.max(hi, proj[i]);
  }
  const bins = new Array<number>(Math.floor(hi - lo) + 1).fill(0);
  for (let i = 0; i < n; i++) bins[Math.floor(proj[i] - lo)]++;
  const baseIsLow = rise(bins) <= rise([...bins].reverse());
  const apex: Vec3 = baseIsLow ? v : [-v[0], -v[1], -v[2]];

  // wall thickness: distance to the nearest empty voxel, then the largest such value nearby
  const air = new Uint8Array(tissue.length);
  for (let i = 0; i < tissue.length; i++) air[i] = tissue[i] === 0 ? 1 : 0;
  let thick = distanceTransform(air, nx, ny, nz);
  for (let axis = 0; axis < 3; axis++) thick = maxAlong(thick, [nx, ny, nz], axis, 3);

  // in the middle of the ventricles, compare the thick and thin muscle
  const span = hi - lo;
  const mid: number[] = [];
  let k = 0;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const idx = x + nx * (y + ny * z);
        if (tissue[idx] === 0) continue;
        if (proj[k] > lo + 0.2 * span && proj[k] < hi - 0.2 * span) mid.push(idx, k);
        k++;
      }
  const sorted = Float64Array.from({ length: mid.length / 2 }, (_, i) => thick[mid[2 * i]]).sort();
  const qThin = sorted[Math.floor(sorted.length * 0.3)];
  const qThick = sorted[Math.floor(sorted.length * 0.7)];
  const thin: Vec3 = [0, 0, 0], full: Vec3 = [0, 0, 0];
  let nThin = 0, nFull = 0;
  for (let i = 0; i < mid.length; i += 2) {
    const t = thick[mid[i]];
    const p = mid[i + 1];
    if (t <= qThin) { for (let a = 0; a < 3; a++) thin[a] += pts[3 * p + a]; nThin++; }
    else if (t >= qThick) { for (let a = 0; a < 3; a++) full[a] += pts[3 * p + a]; nFull++; }
  }
  const d: Vec3 = [thin[0] / nThin - full[0] / nFull, thin[1] / nThin - full[1] / nFull, thin[2] / nThin - full[2] / nFull];
  const along = dot(d, apex);
  const rv = unit([d[0] - along * apex[0], d[1] - along * apex[1], d[2] - along * apex[2]]);
  return { centroid: c, apex, rv };
}

/**
 * The rotation from the grid frame to the display frame that stands the heart up like a textbook plate:
 * apex down and tilted toward the viewer's right by tilt, right ventricle on the left, and the two
 * ventricles side by side across the picture, so the open base is seen edge on. Display y is up.
 */
export function poseRotation(frame: Pick<HeartFrame, "apex" | "rv">, tilt = (30 * Math.PI) / 180): Mat3 {
  const a = unit(frame.apex);
  // the right-ventricle direction made exactly perpendicular to the axis, so the result is a true rotation
  const r0 = unit(frame.rv);
  const along = dot(r0, a);
  const r = unit([r0[0] - along * a[0], r0[1] - along * a[1], r0[2] - along * a[2]]);
  const p = cross(a, r);
  const ad: Vec3 = [Math.sin(tilt), -Math.cos(tilt), 0];
  const rd: Vec3 = [-Math.cos(tilt), -Math.sin(tilt), 0];
  const pd: Vec3 = cross(ad, rd);
  // R = ad a^T + rd r^T + pd p^T
  const m: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m.push(ad[i] * a[j] + rd[i] * r[j] + pd[i] * p[j]);
  return m as Mat3;
}
