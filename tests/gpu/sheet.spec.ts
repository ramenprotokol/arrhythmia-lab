import { test, expect, type Page } from "@playwright/test";

test.afterEach(async ({ page }) => {
  // A shader or pipeline error does not throw, it makes the GPU do nothing. Fail on any.
  const errors = await page.evaluate(() => window.gpuErrors ?? []);
  expect(errors).toEqual([]);
});
import { CpuSheet } from "./cpuSheet";

const N = 64, D = 0.1, DX = 0.5, DT = 0.05;

async function open(page: Page) {
  await page.goto("/tests/gpu/harness.html");
  await page.evaluate(() => window.labReady);
}

test("GPU sheet matches the CPU reference after a centre stimulus", async ({ page }) => {
  await open(page);
  const steps = 4000; // 200 ms
  const gpu = await page.evaluate(async ({ N, D, DX, DT, steps }) => {
    const sim = new window.lab.SheetSim(window.lab.device, N, { D, dx: DX, dt: DT });
    sim.stimulate(N / 2, N / 2, 3);
    sim.step(steps);
    return Array.from(await sim.readU());
  }, { N, D, DX, DT, steps });

  const cpu = new CpuSheet(N, D, DX, DT);
  cpu.stimulate(N / 2, N / 2, 3);
  cpu.step(steps);
  const ref = cpu.u();

  // Measured gap is about 1e-6 (32-bit float rounding). These bounds catch real drift.
  let sum = 0, worst = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(ref[i] - gpu[i]);
    sum += d;
    worst = Math.max(worst, d);
  }
  expect(sum / ref.length).toBeLessThan(1e-4);
  expect(worst).toBeLessThan(5e-3);

  // The wavefront must have travelled about the same distance on both.
  const radius = (u: ArrayLike<number>) => {
    let far = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++)
        if (u[y * N + x] > 0.5) far = Math.max(far, Math.hypot(x - N / 2, y - N / 2));
    return far;
  };
  expect(Math.abs(radius(ref) - radius(gpu))).toBeLessThanOrEqual(1);
  expect(radius(gpu)).toBeGreaterThan(8); // it really did spread
});

test("refuses a time step that breaks the diffusion stability limit", async ({ page }) => {
  await open(page);
  const message = await page.evaluate(() => {
    try {
      new window.lab.SheetSim(window.lab.device, 32, { D: 0.1, dx: 0.5, dt: 1.0 });
      return "no error";
    } catch (e) {
      return String(e);
    }
  });
  expect(message).toMatch(/stab/i);
});

test("shock returns the whole sheet to rest", async ({ page }) => {
  await open(page);
  const maxU = await page.evaluate(async () => {
    const sim = new window.lab.SheetSim(window.lab.device, 32, { D: 0.1, dx: 0.5, dt: 0.05 });
    sim.stimulate(16, 16, 3);
    sim.step(200);
    sim.shock();
    const u = await sim.readU();
    return Math.max(...u);
  });
  expect(maxU).toBe(0);
});

// Cross-field protocol: a plane wave (S1) from the left edge, then a second stimulus (S2) on the
// lower-left block. Found by exploration (see docs/receipts.md): with a shortened recovery
// (tauWp x 0.35, action potential about 125 ms) and D = 0.05, S2 before about 190 ms is absorbed
// because the tissue is still refractory, and S2 after that starts a wave that keeps circling.
async function crossField(page: Page, t2: number, tail: number[]): Promise<number[]> {
  return page.evaluate(async ({ t2, tail }) => {
    const N = 160, DT = 0.05;
    const params = { ...window.lab.EPI, tauWp: window.lab.EPI.tauWp * 0.35 };
    const sim = new window.lab.SheetSim(window.lab.device, N, { D: 0.05, dx: 0.5, dt: DT, params });
    sim.stimulateRect(0, 0, 3, N - 1);
    sim.step(Math.round(t2 / DT));
    sim.stimulateRect(0, 0, N / 2, N / 2, { amp: 0.4 });
    const out: number[] = [];
    let prev = 0;
    for (const ms of tail) {
      sim.step(Math.round((ms - prev) / DT));
      prev = ms;
      const u = await sim.readU();
      out.push(u.reduce((a, x) => a + (x > 0.5 ? 1 : 0), 0) / u.length);
    }
    return out;
  }, { t2, tail });
}

test("a second stimulus during the refractory period is absorbed", async ({ page }) => {
  await open(page);
  const f = await crossField(page, 150, [3000]);
  expect(f[0]).toBe(0);
});

test("a second stimulus after recovery starts a wave that keeps circling", async ({ page }) => {
  await open(page);
  const f = await crossField(page, 220, [4000, 8000]);
  // A rotating wave has about half the sheet excited at any moment: it is still there at 8 s.
  for (const x of f) {
    expect(x).toBeGreaterThan(0.2);
    expect(x).toBeLessThan(0.7);
  }
});

test("a shock ends a wave that is circling", async ({ page }) => {
  await open(page);
  const after = await page.evaluate(async () => {
    const N = 160, DT = 0.05;
    const params = { ...window.lab.EPI, tauWp: window.lab.EPI.tauWp * 0.35 };
    const sim = new window.lab.SheetSim(window.lab.device, N, { D: 0.05, dx: 0.5, dt: DT, params });
    sim.stimulateRect(0, 0, 3, N - 1);
    sim.step(Math.round(220 / DT));
    sim.stimulateRect(0, 0, N / 2, N / 2, { amp: 0.4 });
    sim.step(Math.round(4000 / DT));
    const before = (await sim.readU()).reduce((a, x) => a + (x > 0.5 ? 1 : 0), 0);
    sim.shock();
    sim.step(Math.round(2000 / DT));
    const u = await sim.readU();
    return { before, after: u.reduce((a, x) => a + (x > 0.5 ? 1 : 0), 0) };
  });
  expect(after.before).toBeGreaterThan(1000); // it really was circling
  expect(after.after).toBe(0); // and the shock ended it for good
});
