import { test, expect, type Page } from "@playwright/test";

test.afterEach(async ({ page }) => {
  // A shader or pipeline error does not throw, it makes the GPU do nothing. Fail on any.
  const errors = await page.evaluate(() => window.gpuErrors ?? []);
  expect(errors).toEqual([]);
});
import { CpuHeart } from "./cpuHeart";
import { jaggedGrid, mulberry32, muscleCount } from "./synthGrid";
import { readFileSync } from "node:fs";
import { parseHeart } from "../../src/data/loadHeart";
import { APEX } from "./frame";

async function open(page: Page) {
  await page.goto("/tests/gpu/harness.html");
  await page.evaluate(() => window.labReady);
}

function randomU(n: number, seed: number, grid = jaggedGrid(28, 7)): number[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => (grid.tissue[i] > 0 ? rnd() : 0));
}

const N = 28;
const DIFFUSION_ONLY = { dt: 1.0, dPar: 0.1, dPerp: 0.025, reaction: false };

test("the jagged test block is rough enough to matter", () => {
  expect(muscleCount(jaggedGrid(N, 7))).toBeGreaterThan(3000);
});

test("GPU keeps the total voltage of a sealed jagged block constant", async ({ page }) => {
  await open(page);
  const u0 = randomU(N ** 3, 1);
  const { before, after } = await page.evaluate(async ({ u0, N, opts }) => {
    const grid = window.lab.jaggedGrid(N, 7);
    const sim = await window.lab.Simulation.create(window.lab.device, grid, opts);
    sim.writeVoltage(Float32Array.from(u0));
    const sum = (a: Float32Array) => a.reduce((s, x) => s + x, 0);
    // float64 sum of the float32 values, so the sum itself adds no error
    const total = (a: Float32Array) => { let t = 0; for (const x of a) t += x; return t; };
    void sum;
    const before = total(await sim.readU());
    sim.step(300);
    return { before, after: total(await sim.readU()) };
  }, { u0, N, opts: DIFFUSION_ONLY });
  const drift = Math.abs(after - before) / before;
  console.log(`GPU conservation drift: ${drift.toExponential(2)}`);
  // Measured 2e-8 (32-bit rounding). The 'zero the neighbours' shortcut drifts by 1.8e-1 on this block.
  expect(drift).toBeLessThan(1e-6);
});

test("GPU diffusion matches the float64 CPU reference on a jagged block", async ({ page }) => {
  await open(page);
  const u0 = randomU(N ** 3, 1);
  const gpu = await page.evaluate(async ({ u0, N, opts }) => {
    const sim = await window.lab.Simulation.create(window.lab.device, window.lab.jaggedGrid(N, 7), opts);
    sim.writeVoltage(Float32Array.from(u0));
    sim.step(300);
    return Array.from(await sim.readU());
  }, { u0, N, opts: DIFFUSION_ONLY });
  const cpu = new CpuHeart(jaggedGrid(N, 7), DIFFUSION_ONLY);
  cpu.writeVoltage(Float64Array.from(u0));
  cpu.step(300);
  const ref = cpu.readU();
  let sum = 0, worst = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(ref[i] - gpu[i]);
    sum += d;
    worst = Math.max(worst, d);
  }
  console.log(`GPU vs CPU diffusion: mean ${(sum / ref.length).toExponential(2)} worst ${worst.toExponential(2)}`);
  // Measured mean 4e-9, worst 2e-7.
  expect(sum / ref.length).toBeLessThan(1e-7);
  expect(worst).toBeLessThan(1e-5);
});

// ---- reaction on: the whole solver against the float64 reference --------------------------------

test("GPU with the cell model matches the CPU reference on a jagged block", async ({ page }) => {
  await open(page);
  const opts = { dt: 0.05, dPar: 0.1, dPerp: 0.025, reaction: true };
  const grid = jaggedGrid(N, 7);
  // stimulate around the first muscle voxel in x-fastest order, then run 25 ms
  let c: [number, number, number] = [0, 0, 0];
  outer: for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
    if (grid.tissue[x + N * (y + N * z)] > 0) { c = [x, y, z]; break outer; }
  const gpu = await page.evaluate(async ({ c, N, opts }) => {
    const sim = await window.lab.Simulation.create(window.lab.device, window.lab.jaggedGrid(N, 7), opts);
    sim.stimulate(c, 3);
    sim.step(25);
    return Array.from(await sim.readU());
  }, { c, N, opts });
  const cpu = new CpuHeart(grid, opts);
  cpu.stimulate(c, 3);
  cpu.step(Math.round(25 / opts.dt));
  const ref = cpu.readU();
  let sum = 0, worst = 0, active = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(ref[i] - gpu[i]);
    sum += d;
    worst = Math.max(worst, d);
    if (ref[i] > 0.5) active++;
  }
  console.log(`GPU vs CPU with reaction: mean ${(sum / ref.length).toExponential(2)} worst ${worst.toExponential(2)}, ${active} voxels excited`);
  expect(active).toBeGreaterThan(50); // the wave really spread
  expect(sum / ref.length).toBeLessThan(1e-4);
  expect(worst).toBeLessThan(5e-3);
});

// ---- the tensor points along the fibre, on the GPU ----------------------------------------------

async function spreadOnGpu(page: Page, fibre: [number, number, number]) {
  return page.evaluate(async ({ fibre, opts }) => {
    const n = 48, c = 24, s0 = 2;
    const sim = await window.lab.Simulation.create(window.lab.device, window.lab.blockGrid(n, n, n, fibre), opts);
    const u = new Float32Array(n * n * n);
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
      u[x + n * (y + n * z)] = Math.exp(-((x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2) / (2 * s0 * s0));
    sim.writeVoltage(u);
    sim.step(100);
    const r = await sim.readU();
    let m = 0, cxx = 0, cyy = 0, czz = 0, cxy = 0;
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const a = r[x + n * (y + n * z)];
      m += a; cxx += a * (x - c) ** 2; cyy += a * (y - c) ** 2; czz += a * (z - c) ** 2; cxy += a * (x - c) * (y - c);
    }
    cxx /= m; cyy /= m; czz /= m; cxy /= m;
    return { along11: (cxx + cyy) / 2 + cxy, alongMinus: (cxx + cyy) / 2 - cxy, z: czz };
  }, { fibre, opts: DIFFUSION_ONLY });
}

test("GPU spreads along a 45 degree fibre with the analytic variances", async ({ page }) => {
  await open(page);
  const v = await spreadOnGpu(page, [1, 1, 0]);
  console.log(`GPU spread variances along/across/z: ${v.along11.toFixed(2)} / ${v.alongMinus.toFixed(2)} / ${v.z.toFixed(2)} (analytic 24 / 9 / 9)`);
  expect(v.along11).toBeGreaterThan(24 * 0.95);
  expect(v.along11).toBeLessThan(24 * 1.05);
  expect(v.alongMinus).toBeGreaterThan(9 * 0.95);
  expect(v.alongMinus).toBeLessThan(9 * 1.05);
  expect(v.z).toBeGreaterThan(9 * 0.95);
  expect(v.z).toBeLessThan(9 * 1.05);
});

test("GPU swaps the long axis when the fibre turns to the other diagonal", async ({ page }) => {
  await open(page);
  const v = await spreadOnGpu(page, [1, -1, 0]);
  expect(v.alongMinus).toBeGreaterThan(24 * 0.95);
  expect(v.along11).toBeLessThan(9 * 1.05);
});

// ---- behaviour ----------------------------------------------------------------------------------

test("a wave runs faster along the fibres than across them", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const n = 56, c = 28, dt = 0.05;
    const sim = await window.lab.Simulation.create(window.lab.device, window.lab.blockGrid(n, n, n, [1, 0, 0]), { dt, reaction: true });
    sim.stimulate([c, c, c], 3);
    const at = (x: number, y: number, z: number) => x + n * (y + n * z);
    const probes: Record<string, number> = { x8: at(c + 8, c, c), x20: at(c + 20, c, c), y8: at(c, c + 8, c), y20: at(c, c + 20, c) };
    const t: Record<string, number> = {};
    // 1 ms sampling; the 2 ms stimulus pulse is already included in the time the step calls add up
    for (let ms = 1; ms <= 250; ms += 1) {
      sim.step(1);
      const u = await sim.readU();
      for (const [k, i] of Object.entries(probes)) if (t[k] === undefined && u[i] > 0.5) t[k] = ms;
      if (Object.keys(t).length === 4) break;
    }
    return t;
  });
  expect(Object.keys(r).length).toBe(4);
  const along = 12 / (r.x20 - r.x8);
  const across = 12 / (r.y20 - r.y8);
  console.log(`speed along ${along.toFixed(3)} mm/ms, across ${across.toFixed(3)} mm/ms, ratio ${(along / across).toFixed(2)}`);
  // Real ventricular tissue conducts 2 to 3 times faster along the fibres than across them.
  expect(along / across).toBeGreaterThan(1.8);
  expect(along / across).toBeLessThan(3.2);
  // and both are in a believable range for heart muscle (0.3 to 1 m/s is 0.3 to 1 mm/ms)
  expect(along).toBeGreaterThan(0.5);
  expect(along).toBeLessThan(1.2);
  expect(across).toBeGreaterThan(0.2);
});

test("a stimulus outside the muscle does nothing, and shock returns everything to rest", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async ({ N }) => {
    const grid = window.lab.jaggedGrid(N, 7);
    const sim = await window.lab.Simulation.create(window.lab.device, grid, { dt: 0.05, reaction: true });
    sim.stimulate([0, 0, 0], 1.5); // a corner of the box: not muscle
    sim.step(30);
    const idle = (await sim.readU()).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    // now a real stimulus, then a shock
    let c: [number, number, number] = [0, 0, 0];
    outer: for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
      if (grid.tissue[x + N * (y + N * z)] > 0) { c = [x, y, z]; break outer; }
    sim.stimulate(c, 3);
    sim.step(10);
    const excited = (await sim.readU()).reduce((m, x) => Math.max(m, x), 0);
    sim.shock();
    const u = await sim.readU();
    const g = await sim.readGates();
    let muscle = 0, badGate = 0;
    for (let i = 0; i < grid.tissue.length; i++) if (grid.tissue[i] > 0) {
      muscle++;
      if (u[i] !== 0 || g[3 * i] !== 1 || g[3 * i + 1] !== 1 || g[3 * i + 2] !== 0) badGate++;
    }
    return { idle, excited, muscle, badGate };
  }, { N });
  expect(r.idle).toBe(0);
  expect(r.excited).toBeGreaterThan(0.5);
  expect(r.badGate).toBe(0);
});

test("refuses a time step that breaks the stability limit, and one too big for the cell model", async ({ page }) => {
  await open(page);
  const msgs = await page.evaluate(async () => {
    const grid = window.lab.blockGrid(8, 8, 8, [1, 0, 0]);
    const tryIt = async (opts: object, tissue?: { conduction: number }) => {
      try {
        const sim = await window.lab.Simulation.create(window.lab.device, grid, opts);
        if (tissue) sim.setTissue(tissue);
        return "no error";
      } catch (e) {
        return String(e);
      }
    };
    return [
      await tryIt({ dt: 5, reaction: false }),
      await tryIt({ dt: 0.5, reaction: true }),
      await tryIt({ dt: 1.0, reaction: false }, { conduction: 3 }),
    ];
  });
  expect(msgs[0]).toMatch(/stability/i);
  expect(msgs[1]).toMatch(/too large/i);
  expect(msgs[2]).toMatch(/stability/i);
});

// ---- the real heart -----------------------------------------------------------------------------

function realGrid() {
  const raw = readFileSync("public/data/heart.bin");
  return parseHeart(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

test("the real heart keeps its total voltage constant with no stimulus", async ({ page }) => {
  await open(page);
  const grid = realGrid();
  const rnd = mulberry32(3);
  const u0 = Array.from(grid.tissue, (t) => (t > 0 ? rnd() : 0));
  const { before, after } = await page.evaluate(async ({ u0, opts }) => {
    const g = await window.lab.loadHeart("/data/heart.bin");
    const sim = await window.lab.Simulation.create(window.lab.device, g, opts);
    sim.writeVoltage(Float32Array.from(u0));
    const total = (a: Float32Array) => { let t = 0; for (const x of a) t += x; return t; };
    const before = total(await sim.readU());
    sim.step(300);
    return { before, after: total(await sim.readU()) };
  }, { u0, opts: DIFFUSION_ONLY });
  const drift = Math.abs(after - before) / before;
  console.log(`real heart conservation drift: ${drift.toExponential(2)}`);
  expect(drift).toBeLessThan(1e-6);
});

test("a stimulus at the apex activates the whole real heart in a plausible time", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async ({ apex }) => {
    const g = await window.lab.loadHeart("/data/heart.bin");
    const sim = await window.lab.Simulation.create(window.lab.device, g, { dt: 0.05, reaction: true });
    sim.stimulate(apex as [number, number, number], 3);
    const ever = new Uint8Array(g.tissue.length);
    let muscle = 0;
    for (const t of g.tissue) if (t > 0) muscle++;
    const marks: Record<string, number> = {};
    for (let ms = 5; ms <= 500; ms += 5) {
      sim.step(5);
      const u = await sim.readU();
      let n = 0;
      for (let i = 0; i < u.length; i++) {
        if (g.tissue[i] > 0 && u[i] > 0.5) ever[i] = 1;
        n += ever[i];
      }
      for (const f of [0.5, 0.99]) if (marks[f] === undefined && n >= f * muscle) marks[f] = ms;
      if (marks[0.99] !== undefined) break;
    }
    return marks;
  }, { apex: APEX });
  console.log(`real heart: half of the muscle fired by ${r[0.5]} ms, 99% by ${r[0.99]} ms`);
  expect(r[0.99]).toBeDefined();
  expect(r[0.5]).toBeGreaterThanOrEqual(60);
  expect(r[0.99]).toBeLessThanOrEqual(300);
  expect(r[0.99]).toBeGreaterThanOrEqual(100);
});

test("the real heart runs fast enough for a live view", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const g = await window.lab.loadHeart("/data/heart.bin");
    const sim = await window.lab.Simulation.create(window.lab.device, g, { dt: 0.05, reaction: true });
    sim.stimulate([60, 50, 55], 3);
    sim.step(20); // warm up
    await window.lab.device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    sim.step(1000); // 20000 steps
    await window.lab.device.queue.onSubmittedWorkDone();
    return { wallMs: performance.now() - t0 };
  });
  const perStep = r.wallMs / 20000;
  // If the solver gets half of every 60 fps frame (8.3 ms), it can do 8.3 / perStep steps of 0.05 ms.
  const simMsPerSecond = 60 * (8.3 / perStep) * 0.05;
  console.log(`real heart: ${perStep.toFixed(4)} ms per step; at half a frame per frame that is ${simMsPerSecond.toFixed(0)} simulated ms per real second (${(simMsPerSecond / 1000).toFixed(2)}x real time)`);
  // A teaching view is best slowed down. Require at least 0.4x real time, so a heartbeat of about
  // 800 ms plays in under 2 seconds. Measured on this machine: 0.0345 ms per step.
  expect(simMsPerSecond).toBeGreaterThan(400);
});

test("excitedFraction counts on the GPU exactly what a full readback would count", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async ({ apex }) => {
    const g = await window.lab.loadHeart("/data/heart.bin");
    const sim = await window.lab.Simulation.create(window.lab.device, g, { dt: 0.1, reaction: true });
    const before = await sim.excitedFraction();
    sim.stimulate(apex as [number, number, number], 3);
    sim.step(100);
    const gpu = await sim.excitedFraction();
    const cpu = window.lab.regionStats(await sim.readU(), g).fraction;
    sim.step(400);
    const late = await sim.excitedFraction();
    return { before, gpu, cpu, late };
  }, { apex: APEX });
  console.log(`excited fraction: before ${r.before}, GPU ${r.gpu.toFixed(5)} vs full readback ${r.cpu.toFixed(5)}, after 500 ms ${r.late}`);
  expect(r.before).toBe(0);
  expect(r.gpu).toBeGreaterThan(0.05);
  expect(Math.abs(r.gpu - r.cpu)).toBeLessThan(1e-6);
  expect(r.late).toBeLessThan(0.01);
});
