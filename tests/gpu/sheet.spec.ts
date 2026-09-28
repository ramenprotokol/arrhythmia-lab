import { test, expect, type Page } from "@playwright/test";
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
