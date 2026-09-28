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
const cfg = JSON.parse(process.env.SERIES_CFG ?? "{}");

test("time series", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/tests/gpu/harness.html");
  await page.evaluate(() => window.labReady);
  const out = await page.evaluate(async ({ apex, cfg }) => {
    const g = await window.lab.loadHeart("/data/heart.bin");
    const dt = 0.1;
    const sim = await window.lab.Simulation.create(window.lab.device, g, { dt, reaction: true });
    sim.setTissue({ conduction: cfg.c, recovery: cfg.r });
    sim.stimulate(apex as [number, number, number], 3);
    let t = 2;
    sim.step(cfg.ci - t); t = cfg.ci;
    sim.stimulate(cfg.site, cfg.s2r ?? 5, { amp: cfg.s2amp ?? 0.5 }); t += 2;
    const series: number[] = [];
    const regionsSeries: number[] = [];
    const end = t + cfg.tail;
    const t0 = t;
    let switched = false;
    let n = 0;
    while (t < end) {
      if (cfg.then && !switched && t - t0 >= cfg.then.at) { sim.setTissue({ conduction: cfg.then.c, recovery: cfg.then.r }); switched = true; }
      sim.step(25); t += 25; n++;
      series.push(await sim.excitedFraction());
      if (n % 8 === 0) regionsSeries.push(window.lab.regionStats(await sim.readU(), g).regions);
    }
    // is any voxel stuck excited? read voltage and gates at the end
    const u = await sim.readU();
    let hi = 0, muscle = 0;
    for (let i = 0; i < u.length; i++) if (g.tissue[i] > 0) { muscle++; if (u[i] > 0.8) hi++; }
    const maxStuck = hi / muscle;
    return { series, regionsSeries, maxStuck, regions: window.lab.regionStats(u, g) };
  }, { apex: shape.apex, cfg });
  const s = out.series;
  // crude period estimate: count upward crossings of the mean
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  let ups = 0; for (let i = 1; i < s.length; i++) if (s[i - 1] < mean && s[i] >= mean) ups++;
  console.log(`SERIES c=${cfg.c} r=${cfg.r} ci=${cfg.ci} site=${JSON.stringify(cfg.site)} mean ${mean.toFixed(3)} min ${Math.min(...s).toFixed(3)} max ${Math.max(...s).toFixed(3)} upcrossings ${ups} in ${(s.length * 25 / 1000).toFixed(1)} s; end regions ${JSON.stringify(out.regions)} stuck>0.8 ${out.maxStuck.toFixed(4)}`);
  console.log("SERIES regions every 200ms: " + out.regionsSeries.join(" "));
  if (cfg.dump) console.log("SERIES data " + s.map((x) => x.toFixed(2)).join(" "));
});
