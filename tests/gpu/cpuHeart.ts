// CPU reference for the 3D solver: float64, the same maths as the WGSL kernel.
// Layout: the grid is padded by one empty voxel on every side, index = x + sx * (y + sy * z).
import { stepCell, restingCell, ENDO, MID, EPI, type Params } from "../../src/model/bocf";
import type { HeartGrid } from "../../src/data/loadHeart";

export interface CpuOptions {
  dt: number;
  dPar: number;
  dPerp: number;
  reaction: boolean;
}

const LAYERS: Params[] = [ENDO, MID, EPI];

export class CpuHeart {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly tissue: Uint8Array;
  readonly fibre: Float64Array; // 3 per padded voxel, decoded like the GPU (int8 / 127)
  readonly active: number[] = [];
  U: Float64Array;
  v: Float64Array;
  w: Float64Array;
  s: Float64Array;
  readonly h: number;

  constructor(readonly grid: HeartGrid, readonly opt: CpuOptions) {
    this.sx = grid.nx + 2;
    this.sy = grid.ny + 2;
    this.sz = grid.nz + 2;
    this.h = grid.voxelMm;
    const n = this.sx * this.sy * this.sz;
    this.tissue = new Uint8Array(n);
    this.fibre = new Float64Array(3 * n);
    this.U = new Float64Array(n);
    this.v = new Float64Array(n).fill(1);
    this.w = new Float64Array(n).fill(1);
    this.s = new Float64Array(n);
    for (let z = 0; z < grid.nz; z++)
      for (let y = 0; y < grid.ny; y++)
        for (let x = 0; x < grid.nx; x++) {
          const i = x + grid.nx * (y + grid.ny * z);
          const p = x + 1 + this.sx * (y + 1 + this.sy * (z + 1));
          this.tissue[p] = grid.tissue[i];
          for (let c = 0; c < 3; c++) this.fibre[3 * p + c] = grid.fibre[3 * i + c] / 127;
          if (grid.tissue[i] > 0) this.active.push(p);
        }
  }

  private stride(axis: number): number {
    return axis === 0 ? 1 : axis === 1 ? this.sx : this.sx * this.sy;
  }

  /** Central difference of u along axis j at voxel c, using only muscle neighbours. */
  private tdiff(U: Float64Array, c: number, j: number): number {
    const st = this.stride(j);
    const hasP = this.tissue[c + st] !== 0;
    const hasM = this.tissue[c - st] !== 0;
    if (hasP && hasM) return (U[c + st] - U[c - st]) * (0.5 / this.h);
    if (hasP) return (U[c + st] - U[c]) / this.h;
    if (hasM) return (U[c] - U[c - st]) / this.h;
    return 0;
  }

  /** Flux D grad(u) . e_axis through the face between voxel a and voxel a + e_axis. */
  faceFlux(U: Float64Array, a: number, axis: number): number {
    const b = a + this.stride(axis);
    if (this.tissue[a] === 0 || this.tissue[b] === 0) return 0;
    const g = [0, 0, 0];
    g[axis] = (U[b] - U[a]) / this.h;
    for (let j = 0; j < 3; j++) if (j !== axis) g[j] = 0.5 * (this.tdiff(U, a, j) + this.tdiff(U, b, j));
    const fa = [this.fibre[3 * a], this.fibre[3 * a + 1], this.fibre[3 * a + 2]];
    const fb = [this.fibre[3 * b], this.fibre[3 * b + 1], this.fibre[3 * b + 2]];
    const dd = this.opt.dPar - this.opt.dPerp;
    const da = fa[0] * g[0] + fa[1] * g[1] + fa[2] * g[2];
    const db = fb[0] * g[0] + fb[1] * g[1] + fb[2] * g[2];
    return this.opt.dPerp * g[axis] + 0.5 * dd * (fa[axis] * da + fb[axis] * db);
  }

  diffusion(U: Float64Array, p: number): number {
    let sum = 0;
    for (let axis = 0; axis < 3; axis++) sum += this.faceFlux(U, p, axis) - this.faceFlux(U, p - this.stride(axis), axis);
    return sum / this.h;
  }

  /** Add amp*dt to u in a ball (radius in mm, centre in original voxel coordinates), then step; ms/dt times. */
  stimulate(c: [number, number, number], radiusMm: number, amp = 2, ms = 2): void {
    const count = Math.ceil(ms / this.opt.dt);
    const r2 = (radiusMm / this.h) ** 2;
    for (let k = 0; k < count; k++) {
      for (const p of this.active) {
        const x = p % this.sx, y = Math.floor(p / this.sx) % this.sy, z = Math.floor(p / (this.sx * this.sy));
        const dx = x - (c[0] + 1), dy = y - (c[1] + 1), dz = z - (c[2] + 1);
        if (dx * dx + dy * dy + dz * dz <= r2) this.U[p] += amp * this.opt.dt;
      }
      this.step(1);
    }
  }

  writeVoltage(u: Float32Array | Float64Array): void {
    const { nx, ny, nz } = this.grid;
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) this.U[x + 1 + this.sx * (y + 1 + this.sy * (z + 1))] = u[x + nx * (y + ny * z)];
  }

  step(steps: number): void {
    const { dt, reaction } = this.opt;
    for (let n = 0; n < steps; n++) {
      const next = new Float64Array(this.U.length);
      for (const p of this.active) {
        const dDiff = this.diffusion(this.U, p);
        if (!reaction) {
          next[p] = this.U[p] + dt * dDiff;
          continue;
        }
        const params = LAYERS[this.tissue[p] - 1];
        const c = stepCell({ u: this.U[p], v: this.v[p], w: this.w[p], s: this.s[p] }, params, dt, dDiff);
        next[p] = c.u;
        this.v[p] = c.v;
        this.w[p] = c.w;
        this.s[p] = c.s;
      }
      this.U = next;
    }
  }

  shock(): void {
    const rest = restingCell();
    for (const p of this.active) {
      this.U[p] = rest.u;
      this.v[p] = rest.v;
      this.w[p] = rest.w;
      this.s[p] = rest.s;
    }
  }

  readU(): Float64Array {
    const { nx, ny, nz } = this.grid;
    const out = new Float64Array(nx * ny * nz);
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) out[x + nx * (y + ny * z)] = this.U[x + 1 + this.sx * (y + 1 + this.sy * (z + 1))];
    return out;
  }
}

/**
 * The tempting shortcut, kept ONLY as a negative control for the conservation test: a plain
 * 27-point cross-derivative stencil in which a neighbour that is not muscle is replaced by the
 * centre voxel's own value. It looks harmless and it leaks current at the tissue edge.
 */
export function naiveDiffusionStep(c: CpuHeart, U: Float64Array, dt: number): Float64Array {
  const next = new Float64Array(U.length);
  const h = c.h;
  const at = (p: number, center: number) => (c.tissue[p] !== 0 ? U[p] : U[center]);
  for (const p of c.active) {
    const f = [c.fibre[3 * p], c.fibre[3 * p + 1], c.fibre[3 * p + 2]];
    const dd = c.opt.dPar - c.opt.dPerp;
    const D = (a: number, b: number) => (a === b ? c.opt.dPerp : 0) + dd * f[a] * f[b];
    const sx = c.sx, sxy = c.sx * c.sy;
    const u = (dx: number, dy: number, dz: number) => at(p + dx + dy * sx + dz * sxy, p);
    let lap = 0;
    const d2 = [u(1, 0, 0) - 2 * U[p] + u(-1, 0, 0), u(0, 1, 0) - 2 * U[p] + u(0, -1, 0), u(0, 0, 1) - 2 * U[p] + u(0, 0, -1)];
    for (let a = 0; a < 3; a++) lap += D(a, a) * d2[a];
    lap += 2 * D(0, 1) * ((u(1, 1, 0) - u(1, -1, 0) - u(-1, 1, 0) + u(-1, -1, 0)) / 4);
    lap += 2 * D(0, 2) * ((u(1, 0, 1) - u(1, 0, -1) - u(-1, 0, 1) + u(-1, 0, -1)) / 4);
    lap += 2 * D(1, 2) * ((u(0, 1, 1) - u(0, 1, -1) - u(0, -1, 1) + u(0, -1, -1)) / 4);
    next[p] = U[p] + (dt * lap) / (h * h);
  }
  return next;
}
