import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseFrame } from "../../src/data/heartFrame";
import { ELECTRODE_NAMES, type ElectrodeName } from "../../src/ecg/electrodes";
import { LEAD_NAMES } from "../../src/ecg/leads";
import { referencePotentials } from "./ecgReference";
import { jaggedGrid, mulberry32, muscleCount } from "../gpu/synthGrid";

const pageErrors: string[] = [];

test.beforeEach(({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
});

test.afterEach(async ({ page }) => {
  // A shader or pipeline error does not throw, it makes the GPU do nothing. Fail on any.
  const errors = await page.evaluate(() => window.ecgGpuErrors ?? []);
  expect(errors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

async function open(page: Page) {
  await page.goto("/tests/ecg/harness.html");
  await page.evaluate(() => window.ecgReady);
}

const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);
const maxOf = (xs: number[]): number => xs.reduce((m, x) => (x > m ? x : m), -Infinity);
const minOf = (xs: number[]): number => xs.reduce((m, x) => (x < m ? x : m), Infinity);
const II = LEAD_NAMES.indexOf("II");

type Potentials = Record<ElectrodeName, number>;

/** Worst |gpu - ref| / |ref| over the nine electrodes. */
function worstRelative(gpu: Potentials, ref: Potentials): number {
  return Math.max(...ELECTRODE_NAMES.map((n) => Math.abs(gpu[n] - ref[n]) / Math.abs(ref[n])));
}

// ---- the shader guard ---------------------------------------------------------------------------

test("a shader that does not compile is reported, not silently ignored", async ({ page }) => {
  await open(page);
  // "active" is a reserved word in WGSL: the compile error that once made a whole solver do nothing.
  const message = await page.evaluate(async () => {
    const { createCheckedModule, device } = window.ecgLab;
    try {
      await createCheckedModule(device, "@compute @workgroup_size(1) fn main() { let active = 1u; }", "broken test");
      return "no error";
    } catch (e) {
      return String(e);
    }
  });
  expect(message).toMatch(/broken test shader failed to compile/);
  expect(message).toMatch(/active/);
});

test("Ecg.create refuses to run without electrode positions", async ({ page }) => {
  await open(page);
  const message = await page.evaluate(async () => {
    const { Simulation, Ecg, blockGrid, device } = window.ecgLab;
    const sim = await Simulation.create(device, blockGrid(6, 6, 6, [1, 0, 0]), { dt: 0.05 });
    try {
      await Ecg.create(device, sim);
      return "no error";
    } catch (e) {
      return String(e);
    }
  });
  expect(message).toMatch(/positions/);
});

// ---- the GPU sum against the float64 reference ----------------------------------------------------

const N = 28;
const DIFFUSION_ONLY = { dt: 1.0, dPar: 0.1, dPerp: 0.025, reaction: false };

// Nine hand-picked points round a 28 mm block, from 8 mm outside one face to 90 mm away.
const JAGGED_POSITIONS: Record<ElectrodeName, [number, number, number]> = {
  RA: [-60, 14, 14],
  LA: [90, 30, 20],
  LL: [14, -70, 40],
  V1: [14, 14, 80],
  V2: [40, 50, 14],
  V3: [-8, 12, 15],
  V4: [20, 20, -35],
  V5: [70, 70, 70],
  V6: [-30, -30, 60],
};

test("GPU electrode potentials match the float64 reference on a jagged block", async ({ page }) => {
  await open(page);
  const grid = jaggedGrid(N, 7);
  const cases = [
    { seed: 1, conduction: 1 },
    { seed: 2, conduction: 1 },
    { seed: 3, conduction: 1.5 }, // diffusion() must already include the conduction slider
  ];
  const fields = cases.map((c) => {
    const rnd = mulberry32(c.seed);
    return Array.from(grid.tissue, (t) => (t > 0 ? rnd() : 0));
  });
  const out = await page.evaluate(
    async ({ fields, cases, N, opts, positions }) => {
      const { Simulation, Ecg, jaggedGrid, device } = window.ecgLab;
      const sim = await Simulation.create(device, jaggedGrid(N, 7), opts);
      const ecg = await Ecg.create(device, sim, { positions, gainMvPerUnit: 1 });
      const rows = [];
      for (let k = 0; k < cases.length; k++) {
        sim.setTissue({ conduction: cases[k].conduction });
        sim.writeVoltage(Float32Array.from(fields[k]));
        rows.push({ gpu: await ecg.electrodePotentials(), diffusion: sim.diffusion() });
      }
      return { rows, count: sim.muscleCount() };
    },
    { fields, cases, N, opts: DIFFUSION_ONLY, positions: JAGGED_POSITIONS },
  );
  expect(out.count).toBe(muscleCount(grid));
  expect(out.count).toBeGreaterThan(3000);
  cases.forEach((c, k) => {
    const { gpu, diffusion } = out.rows[k];
    expect(diffusion.dPar).toBeCloseTo(0.1 * c.conduction, 12);
    expect(diffusion.dPerp).toBeCloseTo(0.025 * c.conduction, 12);
    const ref = referencePotentials(grid, Float32Array.from(fields[k]), diffusion, JAGGED_POSITIONS, 1);
    const worst = worstRelative(gpu, ref);
    console.log(`jagged block, seed ${c.seed}, conduction ${c.conduction}: worst relative error over 9 electrodes ${worst.toExponential(2)}` +
      ` (smallest |value| ${minOf(ELECTRODE_NAMES.map((n) => Math.abs(ref[n]))).toExponential(2)})`);
    expect(worst).toBeLessThan(1e-4);
  });
});

test("GPU electrode potentials match the float64 reference on the real heart, random voltage", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { Simulation, Ecg, loadHeart, loadFrame, electrodePositions, mulberry32, referencePotentials, device } = window.ecgLab;
    const grid = await loadHeart("/data/heart.bin");
    const positions = electrodePositions(await loadFrame("/data/heart-frame.json"));
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    const ecg = await Ecg.create(device, sim, { positions, gainMvPerUnit: 1 });
    const rnd = mulberry32(11);
    const u = Float32Array.from(grid.tissue, (t) => (t > 0 ? rnd() : 0));
    sim.writeVoltage(u);
    const gpu = await ecg.electrodePotentials();
    const ref = referencePotentials(grid, u, sim.diffusion(), positions, 1);
    return { gpu, ref, count: sim.muscleCount() };
  });
  expect(r.count).toBe(182253);
  const worst = worstRelative(r.gpu, r.ref);
  console.log(`real heart, random voltage: worst relative error ${worst.toExponential(2)} (smallest |value| ${minOf(ELECTRODE_NAMES.map((n) => Math.abs(r.ref[n]))).toExponential(2)})`);
  expect(worst).toBeLessThan(1e-4);
});

test("GPU electrode potentials match the float64 reference on a live wave in the real heart", async ({ page }) => {
  await open(page);
  const frame = parseFrame(JSON.parse(readFileSync("public/data/heart-frame.json", "utf8")));
  const r = await page.evaluate(async ({ apex }) => {
    const { Simulation, Ecg, loadHeart, loadFrame, electrodePositions, referencePotentials, device } = window.ecgLab;
    const grid = await loadHeart("/data/heart.bin");
    const positions = electrodePositions(await loadFrame("/data/heart-frame.json"));
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    const ecg = await Ecg.create(device, sim, { positions, gainMvPerUnit: 1 });
    sim.stimulate(apex, 3);
    const rows = [];
    for (const ms of [20, 40, 40, 60]) {
      sim.step(ms);
      const u = await sim.readU(); // the very buffer the ECG reads next
      rows.push({ gpu: await ecg.electrodePotentials(), ref: referencePotentials(grid, u, sim.diffusion(), positions, 1) });
    }
    return rows;
  }, { apex: frame.apexVoxel });
  r.forEach((row, k) => {
    const worst = worstRelative(row.gpu, row.ref);
    console.log(`live wave, snapshot ${k + 1}: worst relative error ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-4);
  });
});

test("the ECG follows the solver's ping-pong buffers, after an odd and an even number of steps", async ({ page }) => {
  await open(page);
  const frame = parseFrame(JSON.parse(readFileSync("public/data/heart-frame.json", "utf8")));
  const r = await page.evaluate(async ({ apex }) => {
    const { Simulation, Ecg, loadHeart, loadFrame, electrodePositions, referencePotentials, device } = window.ecgLab;
    const grid = await loadHeart("/data/heart.bin");
    const positions = electrodePositions(await loadFrame("/data/heart-frame.json"));
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    const ecg = await Ecg.create(device, sim, { positions, gainMvPerUnit: 1 });
    sim.stimulate(apex, 3); // 40 steps
    sim.step(30); //           600 steps: the wave is well under way
    const rows = [];
    let previous = sim.voltageBuffer();
    for (let k = 0; k < 6; k++) {
      sim.step(0.05); // exactly one solver step, so the buffer holding u flips every time
      const now = sim.voltageBuffer();
      const flipped = now !== previous;
      previous = now;
      const u = await sim.readU();
      rows.push({ flipped, gpu: await ecg.electrodePotentials(), ref: referencePotentials(grid, u, sim.diffusion(), positions, 1) });
    }
    return rows;
  }, { apex: frame.apexVoxel });
  r.forEach((row, k) => {
    expect(row.flipped, `step ${k + 1} flips the buffer`).toBe(true);
    const worst = worstRelative(row.gpu, row.ref);
    console.log(`ping-pong, one solver step at a time, step ${k + 1}: worst relative error ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-4);
  });
});

test("concurrent sample() calls agree, and destroying one Ecg leaves another working", async ({ page }) => {
  await open(page);
  const frame = parseFrame(JSON.parse(readFileSync("public/data/heart-frame.json", "utf8")));
  const r = await page.evaluate(async ({ apex }) => {
    const { Simulation, Ecg, loadHeart, loadFrame, device } = window.ecgLab;
    const grid = await loadHeart("/data/heart.bin");
    const frameFromFile = await loadFrame("/data/heart-frame.json");
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    const ecg = await Ecg.create(device, sim, { frame: frameFromFile });
    sim.stimulate(apex, 3);
    sim.step(40);
    const many = (await Promise.all([ecg.sample(), ecg.sample(), ecg.sample(), ecg.sample(), ecg.sample()])).map((l) => Array.from(l));
    const other = await Ecg.create(device, sim, { frame: frameFromFile });
    const before = Array.from(await other.sample());
    ecg.destroy();
    const after = Array.from(await other.sample());
    return { many, before, after };
  }, { apex: frame.apexVoxel });
  expect(maxOf(r.many[0].map(Math.abs))).toBeGreaterThan(0.05);
  for (const m of r.many) expect(m).toEqual(r.many[0]);
  expect(r.before).toEqual(r.many[0]);
  expect(r.after).toEqual(r.before);
});

// ---- batched sampling: queue() and flush() ----------------------------------------------------------

/** Worst |a - b| over the twelve leads, relative to the largest lead of b. */
function worstLeadError(a: number[], b: number[]): number {
  return maxOf(a.map((x, k) => Math.abs(x - b[k]))) / maxOf(b.map(Math.abs));
}

test("queue() and flush() give the same five vectors as five separate sample() calls", async ({ page }) => {
  await open(page);
  const frame = parseFrame(JSON.parse(readFileSync("public/data/heart-frame.json", "utf8")));
  const r = await page.evaluate(async ({ apex }) => {
    const { Simulation, Ecg, loadHeart, loadFrame, device } = window.ecgLab;
    const grid = await loadHeart("/data/heart.bin");
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    const ecg = await Ecg.create(device, sim, { frame: await loadFrame("/data/heart-frame.json") });
    const rows = (leads: Float32Array[]) => leads.map((l) => Array.from(l));

    // (1) one simulation: queue() and sample() at the very same moments. sample() must not disturb the queue.
    sim.stimulate(apex, 3);
    sim.step(40);
    const singles: number[][] = [];
    for (let k = 0; k < 5; k++) {
      sim.step(4);
      ecg.queue();
      singles.push(Array.from(await ecg.sample()));
    }
    const interleaved = rows(await ecg.flush());

    // (2) the same run again, the way the app loop does it: step, queue, step, queue ... and only then flush
    sim.shock();
    sim.stimulate(apex, 3);
    sim.step(40);
    for (let k = 0; k < 5; k++) {
      sim.step(4);
      ecg.queue();
    }
    const replay = rows(await ecg.flush());
    return { singles, interleaved, replay };
  }, { apex: frame.apexVoxel });

  expect(r.interleaved.length).toBe(5);
  expect(r.replay.length).toBe(5);
  expect(maxOf(r.singles[0].map(Math.abs))).toBeGreaterThan(0.05); // a real signal, so the comparisons mean something
  // the five moments really differ, so each slot holds the voltage of its own moment and not of the last one
  expect(worstLeadError(r.singles[4], r.singles[0])).toBeGreaterThan(0.05);
  let worst = 0;
  for (let k = 0; k < 5; k++) {
    worst = Math.max(worst, worstLeadError(r.interleaved[k], r.singles[k]), worstLeadError(r.replay[k], r.singles[k]));
  }
  console.log(`batched vs single, 5 moments, worst lead error relative to the largest lead: ${worst.toExponential(2)}`);
  expect(worst).toBeLessThan(1e-6);
});

test("overlapping flushes each return their own slots, in order", async ({ page }) => {
  await open(page);
  const frame = parseFrame(JSON.parse(readFileSync("public/data/heart-frame.json", "utf8")));
  const r = await page.evaluate(async ({ apex }) => {
    const { Simulation, Ecg, loadHeart, loadFrame, device } = window.ecgLab;
    const grid = await loadHeart("/data/heart.bin");
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    const ecg = await Ecg.create(device, sim, { frame: await loadFrame("/data/heart-frame.json") });
    const rows = (leads: Float32Array[]) => leads.map((l) => Array.from(l));

    // what sample() says at six moments 4 ms apart
    sim.stimulate(apex, 3);
    sim.step(40);
    const reference: number[][] = [];
    for (let k = 0; k < 6; k++) {
      sim.step(4);
      reference.push(Array.from(await ecg.sample()));
    }

    // the same run with two flushes in flight together
    sim.shock();
    sim.stimulate(apex, 3);
    sim.step(40);
    const resolved: string[] = [];
    for (let k = 0; k < 3; k++) {
      sim.step(4);
      ecg.queue();
    }
    const first = ecg.flush().then((leads) => (resolved.push("first"), leads));
    for (let k = 0; k < 3; k++) {
      sim.step(4);
      ecg.queue(); // reuses ring slots 0 to 2 while the first flush has not resolved yet
    }
    const second = ecg.flush().then((leads) => (resolved.push("second"), leads));
    const [a, b] = await Promise.all([first, second]);
    return { reference, a: rows(a), b: rows(b), resolved };
  }, { apex: frame.apexVoxel });

  expect(r.a.length).toBe(3);
  expect(r.b.length).toBe(3);
  for (let k = 0; k < 3; k++) {
    expect(worstLeadError(r.a[k], r.reference[k]), `first flush, slot ${k}`).toBeLessThan(1e-6);
    expect(worstLeadError(r.b[k], r.reference[3 + k]), `second flush, slot ${k}`).toBeLessThan(1e-6);
  }
  expect(r.resolved).toEqual(["first", "second"]);
});

test("the ring holds 64 slots, refuses a 65th with a clear error, and works again after flush()", async ({ page }) => {
  await open(page);
  const frame = parseFrame(JSON.parse(readFileSync("public/data/heart-frame.json", "utf8")));
  const r = await page.evaluate(async ({ apex }) => {
    const { Simulation, Ecg, ECG_RING_SLOTS, loadHeart, loadFrame, device } = window.ecgLab;
    const grid = await loadHeart("/data/heart.bin");
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    const ecg = await Ecg.create(device, sim, { frame: await loadFrame("/data/heart-frame.json") });
    const rows = (leads: Float32Array[]) => leads.map((l) => Array.from(l));

    // sample() at 64 moments 1 ms apart, then the same run filling the whole ring
    sim.stimulate(apex, 3);
    sim.step(20);
    const reference: number[][] = [];
    for (let k = 0; k < ECG_RING_SLOTS; k++) {
      sim.step(1);
      reference.push(Array.from(await ecg.sample()));
    }
    sim.shock();
    sim.stimulate(apex, 3);
    sim.step(20);
    for (let k = 0; k < ECG_RING_SLOTS; k++) {
      sim.step(1);
      ecg.queue();
    }
    let message = "no error";
    try {
      ecg.queue();
    } catch (e) {
      message = String(e);
    }
    const full = rows(await ecg.flush());
    ecg.queue(); // usable again straight away
    const one = rows(await ecg.flush());
    const none = await ecg.flush();
    return { slots: ECG_RING_SLOTS, message, reference, full, one: one.length, none: none.length };
  }, { apex: frame.apexVoxel });

  expect(r.slots).toBe(64);
  expect(r.message).toMatch(/64/);
  expect(r.message).toMatch(/flush/);
  expect(r.full.length).toBe(64); // the refused queue() added nothing
  for (let k = 0; k < 64; k++) expect(worstLeadError(r.full[k], r.reference[k]), `slot ${k}`).toBeLessThan(1e-6);
  expect(r.one).toBe(1);
  expect(r.none).toBe(0);
});

test("each queued sample uses the tissue setting that was in force when it was queued", async ({ page }) => {
  await open(page);
  const frame = parseFrame(JSON.parse(readFileSync("public/data/heart-frame.json", "utf8")));
  const r = await page.evaluate(async ({ apex }) => {
    const { Simulation, Ecg, loadHeart, loadFrame, device } = window.ecgLab;
    const grid = await loadHeart("/data/heart.bin");
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    const ecg = await Ecg.create(device, sim, { frame: await loadFrame("/data/heart-frame.json") });
    sim.stimulate(apex, 3);
    sim.step(40);
    // the very same voltage three times, with the conduction slider moved in between: the dipoles scale with D
    ecg.queue();
    sim.setTissue({ conduction: 1.5 });
    ecg.queue();
    sim.setTissue({ conduction: 1 });
    ecg.queue();
    return (await ecg.flush()).map((l) => Array.from(l));
  }, { apex: frame.apexVoxel });
  const [a, b, c] = r;
  const scale = maxOf(a.map(Math.abs));
  expect(scale).toBeGreaterThan(0.05);
  for (let k = 0; k < 12; k++) {
    expect(Math.abs(b[k] - 1.5 * a[k]), `${LEAD_NAMES[k]} at conduction 1.5`).toBeLessThan(1e-6 * scale);
    expect(Math.abs(c[k] - a[k]), `${LEAD_NAMES[k]} back at conduction 1`).toBeLessThan(1e-6 * scale);
  }
});

test("the batched path is cheap: a frame of three steps and three queued samples", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page);
  const frame = parseFrame(JSON.parse(readFileSync("public/data/heart-frame.json", "utf8")));
  const r = await page.evaluate(async ({ apex }) => {
    const { Simulation, Ecg, loadHeart, loadFrame, device } = window.ecgLab;
    const grid = await loadHeart("/data/heart.bin");
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    const ecg = await Ecg.create(device, sim, { frame: await loadFrame("/data/heart-frame.json") });
    sim.stimulate(apex, 3);
    sim.step(30);
    const frames = 100;
    // the app's frame: three 4 ms chunks, a sample after each, one readback
    const batchedFrame = async () => {
      for (let i = 0; i < 3; i++) {
        sim.step(4);
        ecg.queue();
      }
      await ecg.flush();
    };
    const singleFrame = async () => {
      for (let i = 0; i < 3; i++) {
        sim.step(4);
        await ecg.sample();
      }
    };
    for (let i = 0; i < 10; i++) await batchedFrame(); // warm up
    let t0 = performance.now();
    for (let i = 0; i < frames; i++) await batchedFrame();
    const batched = (performance.now() - t0) / frames;
    t0 = performance.now();
    for (let i = 0; i < frames; i++) await singleFrame();
    const single = (performance.now() - t0) / frames;
    // cost of queue() alone: the JavaScript to encode and submit one reduction
    t0 = performance.now();
    for (let i = 0; i < 64; i++) ecg.queue();
    const queueMs = (performance.now() - t0) / 64;
    await ecg.flush();
    // and the steps alone, for scale
    t0 = performance.now();
    for (let i = 0; i < frames * 3; i++) sim.step(4);
    await device.queue.onSubmittedWorkDone();
    const stepsOnly = (performance.now() - t0) / frames;
    return { batched, single, queueMs, stepsOnly };
  }, { apex: frame.apexVoxel });
  console.log(`frame of 3 x (step 4 ms + sample): batched ${r.batched.toFixed(2)} ms, sample() each time ${r.single.toFixed(2)} ms, ` +
    `the 3 steps alone ${r.stepsOnly.toFixed(2)} ms; queue() costs ${(r.queueMs * 1000).toFixed(0)} us of JavaScript`);
  expect(r.batched).toBeLessThan(30);
});

// ---- sign and direction -------------------------------------------------------------------------

test("a wave travelling toward an electrode reads positive there, and negative at one it runs away from", async ({ page }) => {
  await open(page);
  const nx = 100, ny = 16, nz = 16;
  const rows = await page.evaluate(async ({ nx, ny, nz }) => {
    const { Simulation, Ecg, blockGrid, device } = window.ecgLab;
    const grid = blockGrid(nx, ny, nz, [1, 0, 0]);
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    // A plane wave: the slab x < 3 is already depolarised across the whole section, and it runs toward +x.
    const u0 = new Float32Array(nx * ny * nz);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < 3; x++) u0[x + nx * (y + ny * z)] = 1;
    sim.writeVoltage(u0);
    const cy = (ny - 1) / 2, cz = (nz - 1) / 2, mid = (nx - 1) / 2;
    const positions: Record<ElectrodeName, [number, number, number]> = {
      RA: [-150, cy, cz], //           behind the start of the wave, on its axis
      LA: [nx - 1 + 150, cy, cz], //   ahead of the wave, on its axis
      LL: [mid, cy + 150, cz], //      beside the path, half way along
      V1: [mid, cy, cz + 150],
      V2: [mid, cy - 150, cz],
      V3: [mid, cy, cz - 150],
      V4: [-150, cy + 100, cz],
      V5: [nx + 150, cy + 100, cz],
      V6: [mid, cy + 300, cz],
    };
    const ecg = await Ecg.create(device, sim, { positions });
    const centre = Math.floor(cy) * nx + Math.floor(cz) * nx * ny;
    const out: { ms: number; front: number; behind: number; ahead: number; beside: number }[] = [];
    let done = -1;
    for (let ms = 0; ms <= 400; ms++) {
      const p = await ecg.electrodePotentials();
      const u = await sim.readU();
      let front = -1;
      for (let x = 0; x < nx; x++) if (u[x + centre] > 0.5) front = x;
      out.push({ ms, front, behind: p.RA, ahead: p.LA, beside: p.LL });
      if (front >= nx - 2 && done < 0) done = ms;
      if (done >= 0 && ms >= done + 30) break;
      sim.step(1);
    }
    return out;
  }, { nx, ny, nz });

  const mid = (nx - 1) / 2;
  const travelling = rows.filter((r) => r.front >= 15 && r.front <= nx - 15);
  expect(travelling.length).toBeGreaterThan(30); // the wave really crossed the block
  console.log(`plane wave: ${travelling.length} samples with the front between x=15 and x=${nx - 15}; ` +
    `ahead ${minOf(travelling.map((r) => r.ahead)).toFixed(3)}..${maxOf(travelling.map((r) => r.ahead)).toFixed(3)} mV, ` +
    `behind ${minOf(travelling.map((r) => r.behind)).toFixed(3)}..${maxOf(travelling.map((r) => r.behind)).toFixed(3)} mV`);
  // ahead of the front: positive throughout. behind it: negative throughout.
  for (const r of travelling) {
    expect(r.ahead, `ahead at ${r.ms} ms, front at x=${r.front}`).toBeGreaterThan(0);
    expect(r.behind, `behind at ${r.ms} ms, front at x=${r.front}`).toBeLessThan(0);
  }
  // Half way along the two mirror-image electrodes see nearly opposite values (199 mm and 200 mm away).
  const halfway = travelling.reduce((best, r) => (Math.abs(r.front - mid) < Math.abs(best.front - mid) ? r : best));
  expect(Math.abs(halfway.ahead + halfway.behind)).toBeLessThan(0.1 * halfway.ahead);
  // An electrode beside the path sees the wave come toward it (positive) and then go away (negative).
  const approaching = rows.filter((r) => r.front >= 15 && r.front <= mid - 8);
  const receding = rows.filter((r) => r.front >= mid + 8 && r.front <= nx - 15);
  expect(approaching.length).toBeGreaterThan(10);
  expect(receding.length).toBeGreaterThan(10);
  for (const r of approaching) expect(r.beside, `beside, approaching, front x=${r.front}`).toBeGreaterThan(0);
  for (const r of receding) expect(r.beside, `beside, receding, front x=${r.front}`).toBeLessThan(0);
  // Once the whole block is depolarised there is no gradient left to drive a potential.
  const peak = maxOf(travelling.map((r) => r.ahead));
  expect(Math.abs(rows[rows.length - 1].ahead)).toBeLessThan(0.2 * peak);
});

// ---- the real heart: the sign and the frame ---------------------------------------------------------

type Run = { leads: number[][] };

function summarise(run: Run) {
  const lead2 = run.leads.map((l) => l[II]);
  const early = lead2.slice(0, 248); // 2 ms of stimulus + 248 ms = the first 250 ms
  const late = lead2.slice(248);
  const extreme = (xs: number[]) => (Math.abs(maxOf(xs)) >= Math.abs(minOf(xs)) ? maxOf(xs) : minOf(xs));
  return {
    integral250: sum(early), // mV * ms, 1 ms per sample
    peakPos: maxOf(early),
    peakNeg: minOf(early),
    peakToPeak: maxOf(lead2) - minOf(lead2),
    tWave: extreme(late),
    tWaveAt: 250 + late.indexOf(extreme(late)),
  };
}

test("pacing the real heart at the apex gives a negative lead II, at the base a positive one", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page);
  const frame = parseFrame(JSON.parse(readFileSync("public/data/heart-frame.json", "utf8")));
  const { apex, base, gain } = await page.evaluate(async ({ apexVoxel, baseVoxel }) => {
    const { Simulation, Ecg, ECG_GAIN_MV, loadHeart, loadFrame, electrodePositions, device } = window.ecgLab;
    const grid = await loadHeart("/data/heart.bin");
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    const ecg = await Ecg.create(device, sim, { positions: electrodePositions(await loadFrame("/data/heart-frame.json")) });
    const run = async (site: [number, number, number]) => {
      sim.shock();
      sim.stimulate(site, 3); // advances 2 ms
      const leads: number[][] = [];
      for (let ms = 1; ms <= 598; ms++) {
        sim.step(1);
        leads.push(Array.from(await ecg.sample()));
      }
      return { leads };
    };
    return { apex: await run(apexVoxel), base: await run(baseVoxel), gain: ECG_GAIN_MV };
  }, { apexVoxel: frame.apexVoxel, baseVoxel: frame.baseVoxel });

  const a = summarise(apex);
  const b = summarise(base);
  console.log(`gain ${gain} mV per unit`);
  console.log(`apex pacing: lead II integral over 250 ms ${a.integral250.toFixed(1)} mV.ms, ` +
    `peaks ${a.peakPos.toFixed(3)} / ${a.peakNeg.toFixed(3)} mV, peak-to-peak over the beat ${a.peakToPeak.toFixed(3)} mV; ` +
    `T wave ${a.tWave >= 0 ? "positive" : "negative"} (${a.tWave.toFixed(3)} mV at ${a.tWaveAt} ms)`);
  console.log(`base pacing: lead II integral over 250 ms ${b.integral250.toFixed(1)} mV.ms, ` +
    `peaks ${b.peakPos.toFixed(3)} / ${b.peakNeg.toFixed(3)} mV, peak-to-peak over the beat ${b.peakToPeak.toFixed(3)} mV; ` +
    `T wave ${b.tWave >= 0 ? "positive" : "negative"} (${b.tWave.toFixed(3)} mV at ${b.tWaveAt} ms)`);
  // polarity of every lead during the activation, for the record (not asserted)
  for (const [label, run] of [["apex", apex], ["base", base]] as const) {
    const row = LEAD_NAMES.map((name, k) => {
      const trace = run.leads.map((l) => l[k]).slice(0, 248);
      return `${name} ${sum(trace) >= 0 ? "+" : "-"}${Math.abs(sum(trace)).toFixed(0)}`;
    });
    console.log(`${label} pacing, integral of each lead over 250 ms (mV.ms): ${row.join("  ")}`);
  }

  // The wave runs away from the left-leg electrode when paced at the apex, toward it when paced at the base.
  expect(a.integral250).toBeLessThan(0);
  expect(b.integral250).toBeGreaterThan(0);
  // and it is the deflection that decides it, not a small residue
  expect(a.peakNeg).toBeLessThan(-2 * Math.abs(a.peakPos));
  expect(b.peakPos).toBeGreaterThan(2 * Math.abs(b.peakNeg));
  // calibration: a limb lead of about 1.5 mV peak to peak
  expect(a.peakToPeak).toBeGreaterThan(1.2);
  expect(a.peakToPeak).toBeLessThan(1.8);
});

test("the ECG is flat before any stimulus", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { Simulation, Ecg, loadHeart, loadFrame, electrodePositions, device } = window.ecgLab;
    const grid = await loadHeart("/data/heart.bin");
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    const ecg = await Ecg.create(device, sim, { positions: electrodePositions(await loadFrame("/data/heart-frame.json")) });
    const first = Array.from(await ecg.sample());
    sim.step(100); // the resting tissue stays at rest
    const later = Array.from(await ecg.sample());
    return { first, later };
  });
  console.log(`resting heart: largest |lead| over all 12 leads, before and after 100 ms of doing nothing: ${maxOf([...r.first, ...r.later].map(Math.abs))} mV`);
  for (const v of [...r.first, ...r.later]) expect(Math.abs(v)).toBeLessThan(1e-6);
});

// ---- assembly and options ---------------------------------------------------------------------------

test("sample() is the twelve leads of the nine electrode potentials, and the gain option scales them", async ({ page }) => {
  await open(page);
  const frame = parseFrame(JSON.parse(readFileSync("public/data/heart-frame.json", "utf8")));
  const r = await page.evaluate(async ({ apex }) => {
    const { Simulation, Ecg, ECG_GAIN_MV, loadHeart, loadFrame, electrodePositions, leadsFromElectrodes, device } = window.ecgLab;
    const grid = await loadHeart("/data/heart.bin");
    const frameFromFile = await loadFrame("/data/heart-frame.json");
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    const byFrame = await Ecg.create(device, sim, { frame: frameFromFile }); // positions derived from the frame
    const byPositions = await Ecg.create(device, sim, { positions: electrodePositions(frameFromFile) });
    const doubled = await Ecg.create(device, sim, { positions: electrodePositions(frameFromFile), gainMvPerUnit: 2 * ECG_GAIN_MV });
    sim.stimulate(apex, 3);
    sim.step(50);
    const pots = await byPositions.electrodePotentials();
    return {
      pots,
      fromPots: Array.from(leadsFromElectrodes(pots)),
      sample: Array.from(await byPositions.sample()),
      viaFrame: Array.from(await byFrame.sample()),
      doubled: Array.from(await doubled.sample()),
    };
  }, { apex: frame.apexVoxel });
  const scale = maxOf(r.sample.map(Math.abs));
  expect(scale).toBeGreaterThan(0.05); // an actual signal, so the comparisons below mean something
  for (let k = 0; k < 12; k++) {
    expect(Math.abs(r.sample[k] - r.fromPots[k]), LEAD_NAMES[k]).toBeLessThan(1e-6 * scale);
    expect(Math.abs(r.viaFrame[k] - r.sample[k]), LEAD_NAMES[k]).toBeLessThan(1e-6 * scale);
    expect(Math.abs(r.doubled[k] - 2 * r.sample[k]), LEAD_NAMES[k]).toBeLessThan(1e-6 * scale);
  }
  // Einthoven's law on the GPU output itself
  expect(Math.abs(r.sample[0] + r.sample[2] - r.sample[1])).toBeLessThan(1e-4 * scale);
});

// ---- speed --------------------------------------------------------------------------------------------

test("sample() is fast enough for a live view", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page);
  const frame = parseFrame(JSON.parse(readFileSync("public/data/heart-frame.json", "utf8")));
  const r = await page.evaluate(async ({ apex }) => {
    const { Simulation, Ecg, loadHeart, loadFrame, electrodePositions, device } = window.ecgLab;
    const grid = await loadHeart("/data/heart.bin");
    const sim = await Simulation.create(device, grid, { dt: 0.05, reaction: true });
    const ecg = await Ecg.create(device, sim, { positions: electrodePositions(await loadFrame("/data/heart-frame.json")) });
    sim.stimulate(apex, 3);
    sim.step(30);
    for (let i = 0; i < 20; i++) await ecg.sample(); // warm up
    const n = 300;
    let t0 = performance.now();
    for (let i = 0; i < n; i++) await ecg.sample();
    const alone = (performance.now() - t0) / n;
    t0 = performance.now();
    for (let i = 0; i < n; i++) {
      sim.step(1); // 20 solver steps, then read the ECG of the new state
      await ecg.sample();
    }
    const withStep = (performance.now() - t0) / n;
    t0 = performance.now();
    for (let i = 0; i < n; i++) sim.step(1);
    await device.queue.onSubmittedWorkDone();
    const stepOnly = (performance.now() - t0) / n;
    return { alone, withStep, stepOnly };
  }, { apex: frame.apexVoxel });
  console.log(`sample() alone ${r.alone.toFixed(2)} ms per call; step(1 ms) + sample() ${r.withStep.toFixed(2)} ms; step(1 ms) alone ${r.stepOnly.toFixed(2)} ms`);
  expect(r.alone).toBeLessThan(30);
});
