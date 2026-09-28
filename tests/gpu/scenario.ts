// Scenario runner for tuning arrhythmia behaviour on the real heart. Runs in the browser page.
import type { Simulation } from "../../src/sim/Simulation";
import type { HeartGrid } from "../../src/data/loadHeart";

export interface Site {
  voxel: [number, number, number];
  radiusMm: number;
  amp?: number;
  ms?: number;
}

export interface ScenarioSpec {
  recovery: number;
  conduction: number;
  /** First stimulus, at t = 0. */
  s1: Site;
  /** Premature stimulus, delayMs after the start of S1. Leave out for a single beat. */
  s2?: Site & { delayMs: number };
  /** Times, in ms after the START of S1, at which to measure. Must be increasing. */
  sampleAtMs: number[];
}

export interface Sample {
  atMs: number;
  /** Fraction of muscle voxels that are excited (u > 0.5). */
  fraction: number;
  /** Number of separate excited regions (26-connected). */
  regions: number;
  /** Largest single region as a fraction of muscle. */
  largest: number;
}

/** Excited-region statistics of a voltage field. */
export function regionStats(u: Float32Array, grid: HeartGrid): { fraction: number; regions: number; largest: number } {
  const { nx, ny, nz } = grid;
  const n = nx * ny * nz;
  let muscle = 0;
  const hot = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (grid.tissue[i] > 0) {
      muscle++;
      if (u[i] > 0.5) hot[i] = 1;
    }
  }
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  let regions = 0, total = 0, largest = 0;
  for (let start = 0; start < n; start++) {
    if (!hot[start] || seen[start]) continue;
    regions++;
    let size = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop() as number;
      size++;
      const x = p % nx, y = Math.floor(p / nx) % ny, z = Math.floor(p / (nx * ny));
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const X = x + dx, Y = y + dy, Z = z + dz;
            if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
            const q = X + nx * (Y + ny * Z);
            if (hot[q] && !seen[q]) {
              seen[q] = 1;
              stack.push(q);
            }
          }
    }
    total += size;
    if (size > largest) largest = size;
  }
  return { fraction: total / muscle, regions, largest: largest / muscle };
}

/** Run one scenario from rest on a reused simulation and return the samples. */
export async function runScenario(sim: Simulation, grid: HeartGrid, spec: ScenarioSpec, dt: number): Promise<Sample[]> {
  sim.shock();
  sim.setTissue({ conduction: spec.conduction, recovery: spec.recovery });
  let now = 0;
  const advanceTo = (t: number) => {
    if (t > now) {
      sim.step(t - now);
      now = t;
    }
  };
  const stim = (s: Site) => {
    sim.stimulate(s.voxel, s.radiusMm, { amp: s.amp, ms: s.ms });
    now += s.ms ?? 2;
  };
  stim(spec.s1);
  const out: Sample[] = [];
  let s2Done = !spec.s2;
  for (const t of spec.sampleAtMs) {
    if (!s2Done && spec.s2 && spec.s2.delayMs <= t) {
      advanceTo(spec.s2.delayMs);
      stim(spec.s2);
      s2Done = true;
    }
    advanceTo(Math.round(t / dt) * dt);
    const u = await sim.readU();
    out.push({ atMs: t, ...regionStats(u, grid) });
  }
  return out;
}
