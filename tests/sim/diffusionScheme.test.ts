import { describe, it, expect } from "vitest";
import { CpuHeart, naiveDiffusionStep } from "../gpu/cpuHeart";
import { blockGrid, jaggedGrid, mulberry32, muscleCount } from "../gpu/synthGrid";

const OPT = { dt: 1.0, dPar: 0.1, dPerp: 0.025, reaction: false };

function randomVoltage(sim: CpuHeart, seed: number): void {
  const rnd = mulberry32(seed);
  for (const p of sim.active) sim.U[p] = rnd();
}
const total = (sim: CpuHeart, U = sim.U): number => sim.active.reduce((a, p) => a + U[p], 0);

describe("face-flux diffusion on a rough tissue edge", () => {
  it("has a jagged test grid that is really rough", () => {
    const g = jaggedGrid(28, 7);
    expect(muscleCount(g)).toBeGreaterThan(3000);
  });

  it("keeps the total voltage of a sealed block constant, to rounding error", () => {
    const sim = new CpuHeart(jaggedGrid(28, 7), OPT);
    randomVoltage(sim, 1);
    const before = total(sim);
    sim.step(300);
    const drift = Math.abs(total(sim) - before) / before;
    expect(drift).toBeLessThan(1e-12);
  });

  it("negative control: the 'zero the neighbours' shortcut leaks on the same block", () => {
    const sim = new CpuHeart(jaggedGrid(28, 7), OPT);
    randomVoltage(sim, 1);
    const before = total(sim);
    let U = sim.U;
    for (let i = 0; i < 300; i++) U = naiveDiffusionStep(sim, U, OPT.dt);
    const drift = Math.abs(total(sim, U) - before) / before;
    // If this were not far above the good scheme, the conservation test above would prove nothing.
    expect(drift).toBeGreaterThan(1e-4);
  });

  it("stays bounded at 95% of the time-step limit, with oblique fibres and a rough edge", () => {
    const h = 1;
    const limit = (h * h) / (6 * OPT.dPar);
    const sim = new CpuHeart(jaggedGrid(28, 11), { ...OPT, dt: 0.95 * limit });
    randomVoltage(sim, 2);
    sim.step(400);
    for (const p of sim.active) {
      expect(Number.isFinite(sim.U[p])).toBe(true);
      expect(sim.U[p]).toBeLessThan(1.2);
      expect(sim.U[p]).toBeGreaterThan(-0.2);
    }
  });
});

describe("the tensor points along the fibre", () => {
  // A Gaussian blob spreading in a uniform-fibre block: along the fibre its variance grows by
  // 2 * dPar * t, across by 2 * dPerp * t. A sign error in the cross terms would turn the long
  // axis to the wrong diagonal.
  function spread(fibre: [number, number, number]) {
    const n = 48, c = 24, s0 = 2;
    const sim = new CpuHeart(blockGrid(n, n, n, fibre), OPT);
    const u = new Float64Array(n * n * n);
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) u[x + n * (y + n * z)] = Math.exp(-((x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2) / (2 * s0 * s0));
    sim.writeVoltage(u);
    sim.step(100); // 100 ms
    const r = sim.readU();
    let m = 0, cxx = 0, cyy = 0, czz = 0, cxy = 0;
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const a = r[x + n * (y + n * z)];
          m += a;
          cxx += a * (x - c) ** 2;
          cyy += a * (y - c) ** 2;
          czz += a * (z - c) ** 2;
          cxy += a * (x - c) * (y - c);
        }
    cxx /= m; cyy /= m; czz /= m; cxy /= m;
    return { along11: (cxx + cyy) / 2 + cxy, alongMinus: (cxx + cyy) / 2 - cxy, z: czz };
  }

  it("spreads along a 45 degree fibre with the analytic variances", () => {
    const v = spread([1, 1, 0]);
    // variance = s0^2 + 2 D t : 4 + 2*0.1*100 = 24 along, 4 + 2*0.025*100 = 9 across
    expect(v.along11).toBeGreaterThan(24 * 0.95);
    expect(v.along11).toBeLessThan(24 * 1.05);
    expect(v.alongMinus).toBeGreaterThan(9 * 0.95);
    expect(v.alongMinus).toBeLessThan(9 * 1.05);
    expect(v.z).toBeGreaterThan(9 * 0.95);
    expect(v.z).toBeLessThan(9 * 1.05);
  });

  it("swaps the long axis when the fibre swaps to the other diagonal", () => {
    const v = spread([1, -1, 0]);
    expect(v.alongMinus).toBeGreaterThan(24 * 0.95);
    expect(v.along11).toBeLessThan(9 * 1.05);
  });
});
