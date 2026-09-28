import type { HeartGrid } from "../data/loadHeart";

// Static volumes for the raymarcher, built once on the CPU from the tissue mask. All are padded by one
// empty voxel on every side, the same layout the solver uses for its voltage buffer, so one set of
// texture coordinates serves them all: original voxel (x, y, z) is padded voxel (x + 1, y + 1, z + 1).

/** The distance texture saturates here, in millimetres. */
export const SDF_MAX_MM = 32;
/** Width of the Gaussian that softens the 0/1 occupancy into a density, in voxels. */
const BLUR_SIGMA = 0.85;
/** A second, wider blur applied on top, for surface normals that do not show the voxel staircase. */
const WIDE_SIGMA = 1.8;

export interface VolumeFields {
  /** Padded dimensions. */
  sx: number;
  sy: number;
  sz: number;
  /** Tissue class per padded voxel: 0 outside, 1 endo, 2 mid, 3 epi. */
  tissue: Uint8Array;
  /** Occupancy blurred by about one voxel, 0..255. Its 0.5 level (128) is the tissue surface. */
  density: Uint8Array;
  /** The same blurred by about two voxels, 0..255: too soft for the surface itself, right for its normal. */
  smooth: Uint8Array;
  /** Distance in mm to the centre of the nearest muscle voxel, times 255 / SDF_MAX_MM, capped at 255. */
  distance: Uint8Array;
}

// 1D squared distance transform (Felzenszwalb and Huttenlocher, 2012): the lower envelope of the
// parabolas rooted at every sample. f holds 0 at sources and a huge number elsewhere.
function distance1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s: number;
    for (;;) {
      const p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k] && k > 0) k--;
      else break;
    }
    if (s <= z[k]) {
      // the new parabola beats the first one everywhere
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      continue;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    out[q] = (q - p) * (q - p) + f[p];
  }
}

/** Euclidean distance, in voxels, from every voxel to the nearest occupied one (0 on occupied voxels). */
export function distanceTransform(occ: Uint8Array, nx: number, ny: number, nz: number): Float32Array {
  const BIG = 1e18;
  const d = new Float64Array(nx * ny * nz);
  for (let i = 0; i < d.length; i++) d[i] = occ[i] ? 0 : BIG;
  const longest = Math.max(nx, ny, nz);
  const line = new Float64Array(longest);
  const res = new Float64Array(longest);
  const v = new Int32Array(longest);
  const z = new Float64Array(longest + 1);
  const strides = [1, nx, nx * ny];
  const dims = [nx, ny, nz];
  for (let axis = 0; axis < 3; axis++) {
    const n = dims[axis];
    const stride = strides[axis];
    const a = (axis + 1) % 3;
    const b = (axis + 2) % 3;
    for (let j = 0; j < dims[b]; j++)
      for (let i = 0; i < dims[a]; i++) {
        const base = i * strides[a] + j * strides[b];
        for (let q = 0; q < n; q++) line[q] = d[base + q * stride];
        distance1d(line, n, res, v, z);
        for (let q = 0; q < n; q++) d[base + q * stride] = res[q];
      }
  }
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = Math.sqrt(d[i]);
  return out;
}

/** A normalised Gaussian kernel of 2 * radius + 1 taps. */
function gaussian(sigma: number, radius: number): Float32Array {
  const w = new Float32Array(2 * radius + 1);
  let total = 0;
  for (let k = -radius; k <= radius; k++) total += w[k + radius] = Math.exp(-(k * k) / (2 * sigma * sigma));
  for (let i = 0; i < w.length; i++) w[i] /= total;
  return w;
}

function blurAxis(src: Float32Array, dst: Float32Array, dims: number[], axis: number, w: Float32Array): void {
  const radius = (w.length - 1) / 2;
  const strides = [1, dims[0], dims[0] * dims[1]];
  const n = dims[axis];
  const stride = strides[axis];
  const a = (axis + 1) % 3;
  const b = (axis + 2) % 3;
  for (let j = 0; j < dims[b]; j++)
    for (let i = 0; i < dims[a]; i++) {
      const base = i * strides[a] + j * strides[b];
      for (let q = 0; q < n; q++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const p = Math.min(n - 1, Math.max(0, q + k));
          sum += w[k + radius] * src[base + p * stride];
        }
        dst[base + q * stride] = sum;
      }
    }
}

/** Blur a padded volume with a Gaussian along all three axes, in place, using scratch as workspace. */
function blur3d(vol: Float32Array, scratch: Float32Array, dims: number[], w: Float32Array): void {
  blurAxis(vol, scratch, dims, 0, w);
  blurAxis(scratch, vol, dims, 1, w);
  blurAxis(vol, scratch, dims, 2, w);
  vol.set(scratch);
}

const toBytes = (v: Float32Array): Uint8Array => Uint8Array.from(v, (x) => Math.round(255 * Math.min(1, Math.max(0, x))));

export function buildFields(grid: HeartGrid): VolumeFields {
  const { nx, ny, nz, voxelMm } = grid;
  const sx = nx + 2, sy = ny + 2, sz = nz + 2;
  const count = sx * sy * sz;
  const tissue = new Uint8Array(count);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) tissue[x + 1 + sx * (y + 1 + sy * (z + 1))] = grid.tissue[x + nx * (y + ny * z)];

  const occ = tissue.map((t) => (t > 0 ? 1 : 0));

  const dims = [sx, sy, sz];
  const vol = Float32Array.from(occ);
  const scratch = new Float32Array(count);
  blur3d(vol, scratch, dims, gaussian(BLUR_SIGMA, 3));
  const density = toBytes(vol);
  blur3d(vol, scratch, dims, gaussian(WIDE_SIGMA, 5));
  const smooth = toBytes(vol);

  const dist = distanceTransform(occ, sx, sy, sz);
  const distance = new Uint8Array(count);
  for (let i = 0; i < count; i++) distance[i] = Math.min(255, Math.round((dist[i] * voxelMm * 255) / SDF_MAX_MM));

  return { sx, sy, sz, tissue, density, smooth, distance };
}
