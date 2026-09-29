// Where the ordinary beat starts, worked out from the real shipped heart.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { activationSites } from "../../src/lab/conduction";
import { parseFrame } from "../../src/data/heartFrame";
import { parseHeart } from "../../src/data/loadHeart";

const file = readFileSync(new URL("../../public/data/heart.bin", import.meta.url));
const grid = parseHeart(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer);
const frame = parseFrame(JSON.parse(readFileSync(new URL("../../public/data/heart-frame.json", import.meta.url), "utf8")));
const sites = activationSites(grid, frame);
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * grid.voxelMm;

describe("the sites where the ordinary beat starts", () => {
  it("finds several distinct places", () => {
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it("are all on the inner wall, the layer next to the cavities", () => {
    for (const [x, y, z] of sites) expect(grid.tissue[x + grid.nx * (y + grid.ny * z)]).toBe(1);
  });

  it("are spread out: no two within 8 mm, so the muscle is switched on from several places", () => {
    for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) expect(dist(sites[i], sites[j])).toBeGreaterThan(8);
  });

  it("start in both ventricles, mostly the left (each site lies nearer its own cavity's centre)", () => {
    const lv = sites.filter((s) => dist(s, frame.lvCentroid) < dist(s, frame.rvCentroid));
    const rv = sites.length - lv.length;
    expect(lv.length).toBeGreaterThanOrEqual(3);
    expect(rv).toBeGreaterThanOrEqual(2);
  });

  it("are not all at the tip: the beat does not crawl up from the apex", () => {
    const farFromApex = sites.filter((s) => dist(s, frame.apexVoxel) > 25);
    expect(farFromApex.length).toBeGreaterThanOrEqual(3);
  });
});
