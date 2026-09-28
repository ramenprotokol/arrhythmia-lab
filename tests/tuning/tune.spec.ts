import { test } from "@playwright/test";

// A tuning tool, not a test: it takes minutes and prints numbers. Run it with TUNING=1 (see docs/tuning.md).
test.skip(process.env.TUNING !== "1", "tuning tool: run with TUNING=1");
import { readFileSync } from "node:fs";
import { parseHeart } from "../../src/data/loadHeart";


const raw = readFileSync("public/data/heart.bin");
const grid = parseHeart(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
// Anatomy from the frame file built from the source labels (atria sit at the base). A quick geometry
// guess ("the narrower end is the apex") picked the wrong end, so never use that for placing anything.
const frame = JSON.parse(readFileSync("public/data/heart-frame.json", "utf8"));
const shape = {
  apex: frame.apexVoxel.map(Math.round) as [number, number, number],
  base: frame.baseVoxel.map(Math.round) as [number, number, number],
  axis: frame.longAxis as [number, number, number],
};

function nearestMuscle(p: [number, number, number]): [number, number, number] {
  let best: [number, number, number] = [0, 0, 0], bd = Infinity;
  for (let z = 0; z < grid.nz; z++) for (let y = 0; y < grid.ny; y++) for (let x = 0; x < grid.nx; x++) {
    if (grid.tissue[x + grid.nx * (y + grid.ny * z)] === 0) continue;
    const d = (x - p[0]) ** 2 + (y - p[1]) ** 2 + (z - p[2]) ** 2;
    if (d < bd) { bd = d; best = [x, y, z]; }
  }
  return best;
}

// candidate premature-beat sites: two heights along the long axis, four directions around it
function sites(): { name: string; voxel: [number, number, number] }[] {
  const a = shape.axis;
  const ref: [number, number, number] = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const e1 = [ref[0] - dot(ref, a) * a[0], ref[1] - dot(ref, a) * a[1], ref[2] - dot(ref, a) * a[2]];
  const l1 = Math.hypot(...e1); for (let i = 0; i < 3; i++) e1[i] /= l1;
  const e2 = [a[1] * e1[2] - a[2] * e1[1], a[2] * e1[0] - a[0] * e1[2], a[0] * e1[1] - a[1] * e1[0]];
  const out: { name: string; voxel: [number, number, number] }[] = [];
  for (const f of [0.35, 0.65]) {
    for (const [nm, d] of [["+e1", e1], ["-e1", e1.map((x) => -x)], ["+e2", e2], ["-e2", e2.map((x) => -x)]] as [string, number[]][]) {
      const p: [number, number, number] = [0, 1, 2].map((i) => shape.apex[i] + f * (shape.base[i] - shape.apex[i]) + 30 * d[i]) as [number, number, number];
      out.push({ name: `h${f}${nm}`, voxel: nearestMuscle(p) });
    }
  }
  return out;
}

const cfg = JSON.parse(process.env.TUNE_CFG ?? "{}");
const DT = cfg.dt ?? 0.1;

test("scan premature beats", async ({ page }) => {
  test.setTimeout(3_000_000);
  await page.goto("/tests/gpu/harness.html");
  await page.evaluate(() => window.labReady);
  const list = sites();
  console.log("SITES " + JSON.stringify(list));
  const combos: [number, number][] = cfg.combos ?? [[1, 0.35]];
  const cis: number[] = cfg.cis ?? [100, 140, 180, 220];
  const s2amp: number = cfg.s2amp ?? 0.5;
  const s2r: number = cfg.s2r ?? 5;
  const chosen = cfg.sites ? list.filter((s) => cfg.sites.includes(s.name)) : list;
  for (const [conduction, recovery] of combos) {
    for (const site of chosen) {
      const row: string[] = [];
      for (const ci of cis) {
        const r = await page.evaluate(async ({ apex, site, conduction, recovery, ci, dt, s2amp, s2r }) => {
          const g = await window.lab.loadHeart("/data/heart.bin");
          const w = window as unknown as { __sim?: Awaited<ReturnType<typeof window.lab.Simulation.create>> };
          w.__sim ??= await window.lab.Simulation.create(window.lab.device, g, { dt, reaction: true });
          const s = await window.lab.runScenario(w.__sim, g, {
            conduction, recovery,
            s1: { voxel: apex as [number, number, number], radiusMm: 3 },
            s2: { voxel: site.voxel, radiusMm: s2r, amp: s2amp, delayMs: ci },
            sampleAtMs: [ci + 300, ci + 900, ci + 2000],
          }, dt);
          return s.map((x) => `${x.fraction.toFixed(2)}/${x.regions}`).join(",");
        }, { apex: shape.apex, site, conduction, recovery, ci, dt: DT, s2amp, s2r });
        row.push(`${ci}:${r}`);
      }
      console.log(`SCAN c=${conduction} r=${recovery} ${site.name} ${JSON.stringify(site.voxel)} -> ${row.join("  ")}`);
    }
  }
});
