import type { HeartGrid } from "../data/loadHeart";

// The muscle fibre direction for the shell's grain. The stored fibre has no consistent sign from one
// voxel to the next (a fibre and its negative are the same fibre), and averaging a vector with its
// negative gives zero, so what goes to the GPU is the tensor f f^T, which is the same for both signs and
// interpolates smoothly. Two textures of four signed bytes per padded voxel, in the solver's padded layout:
//   a = (xx, yy, zz, xy)    b = (xz, yz, 0, 0)
export interface FibreTensors {
  a: Int8Array;
  b: Int8Array;
}

export function fibreTensors(grid: HeartGrid): FibreTensors {
  const { nx, ny, nz } = grid;
  const sx = nx + 2, sy = ny + 2, sz = nz + 2;
  const a = new Int8Array(4 * sx * sy * sz);
  const b = new Int8Array(4 * sx * sy * sz);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = x + nx * (y + ny * z);
        if (grid.tissue[i] === 0) continue;
        let fx = grid.fibre[3 * i], fy = grid.fibre[3 * i + 1], fz = grid.fibre[3 * i + 2];
        const len = Math.hypot(fx, fy, fz);
        if (len === 0) continue;
        fx /= len;
        fy /= len;
        fz /= len;
        const p = 4 * (x + 1 + sx * (y + 1 + sy * (z + 1)));
        a[p] = Math.round(127 * fx * fx);
        a[p + 1] = Math.round(127 * fy * fy);
        a[p + 2] = Math.round(127 * fz * fz);
        a[p + 3] = Math.round(127 * fx * fy);
        b[p] = Math.round(127 * fx * fz);
        b[p + 1] = Math.round(127 * fy * fz);
      }
  return { a, b };
}
