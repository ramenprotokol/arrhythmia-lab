// The lab engine (clock, pacemaker, burst, inducer) against the real heart, as the page drives it: chunk by chunk.
import { test, expect, type Page } from "@playwright/test";

test.afterEach(async ({ page }) => {
  const errors = await page.evaluate(() => window.gpuErrors ?? []);
  expect(errors).toEqual([]);
});

async function open(page: Page) {
  await page.goto("/tests/gpu/harness.html");
  await page.evaluate(() => window.labReady);
}

// Runs inside the page. `run(ms)` advances the engine chunk by chunk, refreshing the excited fraction as the page does.
const setup = `
  const g = await window.lab.loadHeart("/data/heart.bin");
  const R = window.lab.recipes;
  const sim = await window.lab.Simulation.create(window.lab.device, g, { dt: 0.1 });
  const e = new window.lab.LabEngine(sim);
  e.pacemaker = false;
  const run = async (ms, each) => {
    const end = e.simTime + ms;
    let n = 0;
    while (e.simTime < end) {
      e.advanceChunk();
      if (n++ % 5 === 0) { await e.refreshExcitedNow(); if (each) await each(); }
    }
  };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
`;
const run = (page: Page, body: string) =>
  page.evaluate(`(async () => { ${setup} ${body} })()`) as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test("a normal beat activates the whole heart and everything returns to rest", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page);
  const r = await run(page, `
    e.setTissue(R.NORMAL_TISSUE);
    e.beatAtApex();
    let peak = 0;
    await run(700, async () => { peak = Math.max(peak, e.excited); });
    return { peak, end: e.excited };
  `);
  console.log(`normal beat: peak excited ${r.peak.toFixed(3)}, at 700 ms ${r.end}`);
  expect(r.peak).toBeGreaterThan(0.95);
  expect(r.end).toBe(0);
});

test("an extra beat with normal tissue is captured once and then dies out", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page);
  const r = await run(page, `
    e.setTissue(R.NORMAL_TISSUE);
    e.beatAtApex();
    const t0 = e.simTime;
    await run(R.PVC_EXTRA_BEAT_MS - 2);
    const before = e.excited;
    e.extraBeat();
    let peak = 0;
    await run(1500, async () => { peak = Math.max(peak, e.excited); });
    return { before, peak, end: e.excited };
  `);
  console.log(`extra beat: excited just before ${r.before}, peak after ${r.peak.toFixed(3)}, at 1.5 s ${r.end}`);
  expect(r.before).toBe(0); // the first beat had finished, so this really is a separate beat
  expect(r.peak).toBeGreaterThan(0.9);
  expect(r.end).toBe(0);
});

test("the inducer starts a sustained tachycardia that keeps circling", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page);
  const r = await run(page, `
    e.induce("tachycardia");
    await run(40000, async () => { if (e.inducer.state.status !== "running") throw new Error("done"); }).catch(() => undefined);
    const state = { ...e.inducer.state };
    const series = [];
    await run(4000, async () => { series.push(e.excited); });
    return { state, series, tissue: { ...e.tissue }, pacemaker: e.pacemaker };
  `);
  console.log(`tachycardia: ${JSON.stringify(r.state)}, next 4 s excited: min ${Math.min(...r.series).toFixed(2)} mean ${(r.series.reduce((a: number, b: number) => a + b, 0) / r.series.length).toFixed(2)}`);
  expect(r.state.status).toBe("success");
  expect(r.state.attempt).toBeLessThanOrEqual(6);
  expect(r.tissue).toEqual({ conduction: 0.7, recovery: 0.3 });
  expect(r.pacemaker).toBe(false);
  expect(Math.min(...r.series)).toBeGreaterThan(0.02); // still circling four seconds later
});

test("the inducer starts fibrillation: many wavefronts that do not die out", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page);
  const r = await run(page, `
    e.induce("fibrillation");
    await run(40000, async () => { if (e.inducer.state.status !== "running") throw new Error("done"); }).catch(() => undefined);
    const state = { ...e.inducer.state };
    const regions = [], frac = [];
    for (let i = 0; i < 16; i++) {
      await run(250);
      regions.push(window.lab.regionStats(await sim.readU(), g).regions);
      frac.push(e.excited);
    }
    return { state, regions, frac };
  `);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`fibrillation: ${JSON.stringify(r.state)}, regions mean ${mean(r.regions).toFixed(1)} max ${Math.max(...r.regions)}, fraction last ${r.frac[r.frac.length - 1].toFixed(2)}`);
  expect(r.state.status).toBe("success");
  expect(r.frac[r.frac.length - 1]).toBeGreaterThan(0.03);
  expect(mean(r.regions)).toBeGreaterThanOrEqual(3);
  expect(Math.max(...r.regions)).toBeGreaterThanOrEqual(6);
});

test("a shock ends the rhythm, and with the pacemaker on the normal rhythm returns", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page);
  const r = await run(page, `
    const out = {};
    for (const kind of ["tachycardia", "fibrillation"]) {
      e.induce(kind);
      await run(40000, async () => { if (e.inducer.state.status !== "running") throw new Error("done"); }).catch(() => undefined);
      await run(1500);
      out[kind + "Before"] = e.excited;
      e.shock();
      await e.refreshExcitedNow();
      out[kind + "AfterShock"] = e.excited;
      await run(500);
      out[kind + "Quiet"] = e.excited;
    }
    // normal tissue, pacemaker back on: the regular rhythm should resume by itself
    e.setTissue(R.NORMAL_TISSUE);
    e.setPacemaker(true);
    e.shock();
    let beats = 0, was = 0;
    await run(5000, async () => { if (was < 0.5 && e.excited >= 0.5) beats++; was = e.excited; });
    out.beats = beats;
    return out;
  `);
  console.log("shock:", JSON.stringify(r));
  for (const k of ["tachycardia", "fibrillation"]) {
    expect(r[k + "Before"]).toBeGreaterThan(0.02);
    expect(r[k + "AfterShock"]).toBe(0);
    expect(r[k + "Quiet"]).toBe(0);
  }
  expect(r.beats).toBeGreaterThanOrEqual(3); // 5 s after the pacemaker restarts: at least three regular beats
});
