import { test } from "@playwright/test";
test.skip(process.env.TUNING !== "1", "tuning tool: run with TUNING=1");
test("activation time from the true apex at the app's settings", async ({ page }) => {
  await page.goto("/tests/gpu/harness.html");
  await page.evaluate(() => window.labReady);
  const r = await page.evaluate(async () => {
    const g = await window.lab.loadHeart("/data/heart.bin");
    const sim = await window.lab.Simulation.create(window.lab.device, g, { dt: 0.1 });
    const e = new window.lab.LabEngine(sim);
    e.pacemaker = false;
    e.beatAtApex();
    const marks: Record<string, number> = {};
    const ever = new Uint8Array(g.tissue.length);
    let muscle = 0; for (const t of g.tissue) if (t > 0) muscle++;
    let n = 0;
    for (let ms = 4; ms < 600; ms += 4) {
      e.advanceChunk();
      if (++n % 2 === 0) {
        const u = await sim.readU();
        let c = 0;
        for (let i = 0; i < u.length; i++) { if (g.tissue[i] > 0 && u[i] > 0.5) ever[i] = 1; c += ever[i]; }
        for (const f of [0.5, 0.9, 0.99]) if (marks[f] === undefined && c >= f * muscle) marks[f] = e.simTime;
      }
    }
    const t0 = performance.now();
    for (let i = 0; i < 250; i++) e.advanceChunk(); // one simulated second
    await window.lab.device.queue.onSubmittedWorkDone();
    return { marks, gpuMsPerSimSecond: performance.now() - t0 };
  });
  console.log("ACT " + JSON.stringify(r));
});
