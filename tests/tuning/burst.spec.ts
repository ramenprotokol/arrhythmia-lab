import { test } from "@playwright/test";

// A tuning tool, not a test: it takes minutes and prints numbers. Run it with TUNING=1 (see docs/tuning.md).
test.skip(process.env.TUNING !== "1", "tuning tool: run with TUNING=1");
import { readFileSync } from "node:fs";


// Anatomy from the frame file built from the source labels (atria sit at the base). A quick geometry
// guess ("the narrower end is the apex") picked the wrong end, so never use that for placing anything.
const frame = JSON.parse(readFileSync("public/data/heart-frame.json", "utf8"));
const shape = {
  apex: frame.apexVoxel.map(Math.round) as [number, number, number],
  base: frame.baseVoxel.map(Math.round) as [number, number, number],
  axis: frame.longAxis as [number, number, number],
};
const cfg = JSON.parse(process.env.BURST_CFG ?? "{}");

test("burst pacing", async ({ page }) => {
  test.setTimeout(1_800_000);
  await page.goto("/tests/gpu/harness.html");
  await page.evaluate(() => window.labReady);
  for (const [c, r] of cfg.combos as [number, number][]) {
    for (const period of cfg.periods as number[]) {
      const out = await page.evaluate(async ({ apex, c, r, period, beats, tail }) => {
        const g = await window.lab.loadHeart("/data/heart.bin");
        const dt = 0.1;
        const w = window as unknown as { __sim?: Awaited<ReturnType<typeof window.lab.Simulation.create>> };
        w.__sim ??= await window.lab.Simulation.create(window.lab.device, g, { dt, reaction: true });
        const sim = w.__sim;
        sim.shock();
        sim.setTissue({ conduction: c, recovery: r });
        for (let i = 0; i < beats; i++) { sim.stimulate(apex as [number, number, number], 3); sim.step(period - 2); }
        const regions: number[] = []; const frac: number[] = [];
        for (let t = 0; t < tail; t += 250) {
          sim.step(250);
          regions.push(window.lab.regionStats(await sim.readU(), g).regions);
          frac.push(Number((await sim.excitedFraction()).toFixed(2)));
        }
        return { regions, frac };
      }, { apex: shape.apex, c, r, period, beats: cfg.beats ?? 12, tail: cfg.tail ?? 6000 });
      const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
      const fm = mean(out.frac), sd = Math.sqrt(mean(out.frac.map((x) => (x - fm) ** 2)));
      const alive = out.frac[out.frac.length - 1] > 0;
      console.log(`BURST c=${c} r=${r} period=${period}: ${alive ? "ALIVE" : "dead"} meanRegions ${mean(out.regions).toFixed(1)} maxRegions ${Math.max(...out.regions)} fractionMean ${fm.toFixed(2)} CV ${(sd / (fm || 1)).toFixed(2)} | regions ${out.regions.join(" ")}`);
    }
  }
});
