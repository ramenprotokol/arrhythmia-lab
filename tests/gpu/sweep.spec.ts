import { test, expect, type Page } from "@playwright/test";

test.afterEach(async ({ page }) => {
  const errors = await page.evaluate(() => window.gpuErrors ?? []);
  expect(errors).toEqual([]);
});

async function open(page: Page) {
  await page.goto("/tests/gpu/harness.html");
  await page.evaluate(() => window.labReady);
}

test("a sweep slot fires exactly the voxels whose time falls inside it", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const grid = window.lab.blockGrid(16, 6, 6, [1, 0, 0], 2);
    const sim = await window.lab.Simulation.create(window.lab.device, grid, { dt: 0.1 });
    // voxel x fires at 2 x ms; the last four columns are never reached by the sweep (a huge time)
    const times = new Float32Array(16 * 6 * 6);
    for (let z = 0; z < 6; z++) for (let y = 0; y < 6; y++) for (let x = 0; x < 16; x++) times[x + 16 * (y + 6 * z)] = x >= 12 ? 1e30 : 2 * x;
    sim.setSweepTimes(times);
    for (let t = 0; t < 5; t++) sim.stimulateSweep(t, t + 1, { amp: 2, ms: 1 });
    const u = await sim.readU();
    const at = (x: number) => u[x + 16 * (3 + 6 * 3)];
    return { fired: [0, 1, 2].map(at), waiting: [8, 10, 13, 15].map(at) };
  });
  console.log(`fired ${r.fired.map((v) => v.toFixed(2))}, waiting ${r.waiting.map((v) => v.toFixed(3))}`);
  for (const v of r.fired) expect(v).toBeGreaterThan(0.5);
  for (const v of r.waiting) expect(v).toBeLessThan(0.05);
});

test("on the real heart the ordinary beat switches on the whole ventricles in about 100 ms, far faster than a nudge at the tip", async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  const r = await page.evaluate(async () => {
    const grid = await window.lab.loadHeart("/data/heart.bin");
    const frame = await window.lab.loadFrame("/data/heart-frame.json");
    const excitedAfter = async (sweep: boolean, ms: number) => {
      const sim = await window.lab.Simulation.create(window.lab.device, grid, { dt: 0.1 });
      const engine = new window.lab.LabEngine(sim);
      engine.setPacemaker(false);
      if (sweep) engine.useConductionSweep(grid, frame);
      engine.normalBeat();
      const seen: Record<number, number> = {};
      for (let t = 0; t < ms; t += 4) {
        engine.advanceChunk();
        await engine.refreshExcitedNow();
        seen[t + 4] = engine.excited;
      }
      return seen;
    };
    return { sweep: await excitedAfter(true, 400), tip: await excitedAfter(false, 400) };
  });
  const near = (m: Record<number, number>, t: number) => m[Math.round(t / 4) * 4];
  console.log(`excited at 60/100/140 ms: sweep ${[60, 100, 140].map((t) => near(r.sweep, t).toFixed(2))}, tip ${[60, 100, 140].map((t) => near(r.tip, t).toFixed(2))}`);
  expect(near(r.sweep, 140)).toBeGreaterThan(0.9);
  expect(near(r.tip, 140)).toBeLessThan(0.9);
  expect(near(r.sweep, 60)).toBeGreaterThan(near(r.tip, 60));
  // and it is over sooner: the muscle has recovered before the tip beat's
  expect(near(r.sweep, 380)).toBeLessThan(0.05);
});
