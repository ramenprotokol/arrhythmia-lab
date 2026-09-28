// Float64 reference for the ECG sum, written straight from the physics (not from the GPU kernel): the
// potential of a current-dipole density in an infinite homogeneous conductor,
//
//   phi(x_e) = -gain * h^3 * SUM over muscle voxels p of  (q_p . r) / |r|^3,   r = x_e - x_p (mm)
//
// with q_p = D grad(u) at p. The gradient is the central difference that uses only muscle neighbours
// (one-sided if only one side is muscle, zero if neither), D = dPerp I + (dPar - dPerp) f f^T, and f is the
// stored fibre decoded as int8 / 127. Voxel (i, j, k) sits at (i, j, k) * h millimetres. The sign is such that
// a depolarisation wave travelling toward an electrode gives a positive potential there.
import type { HeartGrid } from "../../src/data/loadHeart";
import { ELECTRODE_NAMES, type ElectrodeName } from "../../src/ecg/electrodes";
import type { Vec3 } from "../../src/data/heartFrame";

export function referencePotentials(
  grid: HeartGrid,
  u: ArrayLike<number>,
  diffusion: { dPar: number; dPerp: number },
  positions: Record<ElectrodeName, Vec3>,
  gainMvPerUnit = 1,
): Record<ElectrodeName, number> {
  const { nx, ny, nz, voxelMm: h } = grid;
  const { dPar, dPerp } = diffusion;
  const stride = [1, nx, nx * ny];
  const muscle = (x: number, y: number, z: number): boolean =>
    x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && grid.tissue[x + nx * (y + ny * z)] > 0;

  const sums = ELECTRODE_NAMES.map(() => 0);
  const g: Vec3 = [0, 0, 0];
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = x + nx * (y + ny * z);
        if (grid.tissue[i] === 0) continue;
        for (let axis = 0; axis < 3; axis++) {
          const step = [0, 0, 0];
          step[axis] = 1;
          const hasP = muscle(x + step[0], y + step[1], z + step[2]);
          const hasM = muscle(x - step[0], y - step[1], z - step[2]);
          const ip = i + stride[axis];
          const im = i - stride[axis];
          if (hasP && hasM) g[axis] = ((u[ip] - u[im]) * 0.5) / h;
          else if (hasP) g[axis] = (u[ip] - u[i]) / h;
          else if (hasM) g[axis] = (u[i] - u[im]) / h;
          else g[axis] = 0;
        }
        const f: Vec3 = [grid.fibre[3 * i] / 127, grid.fibre[3 * i + 1] / 127, grid.fibre[3 * i + 2] / 127];
        const fg = f[0] * g[0] + f[1] * g[1] + f[2] * g[2];
        const k = (dPar - dPerp) * fg;
        const q: Vec3 = [dPerp * g[0] + k * f[0], dPerp * g[1] + k * f[1], dPerp * g[2] + k * f[2]];
        ELECTRODE_NAMES.forEach((name, e) => {
          const p = positions[name];
          const rx = p[0] - x * h;
          const ry = p[1] - y * h;
          const rz = p[2] - z * h;
          const d2 = rx * rx + ry * ry + rz * rz;
          sums[e] -= (q[0] * rx + q[1] * ry + q[2] * rz) / (d2 * Math.sqrt(d2));
        });
      }

  const scale = gainMvPerUnit * h * h * h;
  const out = {} as Record<ElectrodeName, number>;
  ELECTRODE_NAMES.forEach((name, e) => (out[name] = sums[e] * scale));
  return out;
}
