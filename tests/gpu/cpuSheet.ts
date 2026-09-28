// CPU reference for the 2D sheet: the same maths as the GPU kernel, in float64.
import { stepCell, restingCell, EPI, type Cell, type Params } from "../../src/model/bocf";

export class CpuSheet {
  cells: Cell[];
  constructor(
    readonly n: number,
    readonly D: number,
    readonly dx: number,
    readonly dt: number,
    readonly p: Params = EPI,
  ) {
    this.cells = Array.from({ length: n * n }, () => restingCell());
  }
  /** Same pulse as the GPU: add amp*dt to u in the disc, then step, for ms/dt steps. */
  stimulate(cx: number, cy: number, r: number, amp = 2, ms = 2): void {
    const count = Math.ceil(ms / this.dt);
    for (let s = 0; s < count; s++) {
      for (let y = 0; y < this.n; y++)
        for (let x = 0; x < this.n; x++)
          if (Math.hypot(x - cx, y - cy) <= r) this.cells[y * this.n + x].u += amp * this.dt;
      this.step(1);
    }
  }
  step(steps: number): void {
    const { n, D, dx, dt, p } = this;
    const k = D / (dx * dx);
    for (let s = 0; s < steps; s++) {
      const next: Cell[] = new Array(n * n);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const c = this.cells[y * n + x];
          const w = this.cells[y * n + Math.max(x - 1, 0)].u;
          const e = this.cells[y * n + Math.min(x + 1, n - 1)].u;
          const no = this.cells[Math.max(y - 1, 0) * n + x].u;
          const so = this.cells[Math.min(y + 1, n - 1) * n + x].u;
          const lap = w + e + no + so - 4 * c.u;
          next[y * n + x] = stepCell(c, p, dt, k * lap);
        }
      }
      this.cells = next;
    }
  }
  u(): Float64Array {
    return Float64Array.from(this.cells, (c) => c.u);
  }
}
