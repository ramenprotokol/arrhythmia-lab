import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ANATOMICAL_OFFSETS, ELECTRODE_NAMES, electrodePositions } from "../../src/ecg/electrodes";
import { parseFrame, type HeartFrame, type Vec3 } from "../../src/data/heartFrame";
import { parseHeart } from "../../src/data/loadHeart";

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// An axis-aligned frame: left = +x, superior = +z, so anterior = left x superior = -y (right-handed).
function frameWith(over: Partial<Record<keyof HeartFrame, unknown>> = {}): HeartFrame {
  return parseFrame({
    voxelMm: 1,
    centroid: [10, 20, 30],
    lvCentroid: [12, 20, 30],
    rvCentroid: [6, 20, 30],
    atriaCentroid: [10, 20, 80],
    longAxis: [0, 0, -1],
    leftDir: [1, 0, 0],
    superiorDir: [0, 0, 1],
    anteriorDir: [0, -1, 0],
    apexVoxel: [10, 20, 2],
    baseVoxel: [10, 20, 60],
    lengthMm: 58,
    ...over,
  });
}

describe("ANATOMICAL_OFFSETS", () => {
  it("holds the agreed idealised offsets (left, anterior, superior) in mm", () => {
    expect(ANATOMICAL_OFFSETS).toEqual({
      RA: [-190, 0, 230],
      LA: [190, 0, 230],
      LL: [100, 0, -350],
      V1: [-50, 85, 30],
      V2: [-15, 95, 25],
      V3: [25, 95, 10],
      V4: [65, 85, -5],
      V5: [105, 60, -5],
      V6: [135, 25, -5],
    });
  });

  it("lists the nine electrodes in the order the GPU kernel uses", () => {
    expect(ELECTRODE_NAMES).toEqual(["RA", "LA", "LL", "V1", "V2", "V3", "V4", "V5", "V6"]);
  });
});

describe("electrodePositions", () => {
  it("places each electrode at centroid + left*leftDir + anterior*anteriorDir + superior*superiorDir (axis-aligned frame)", () => {
    const p = electrodePositions(frameWith());
    // centroid (10, 20, 30); left is +x, anterior is -y, superior is +z
    expect(p.RA).toEqual([10 - 190, 20 - 0, 30 + 230]);
    expect(p.LL).toEqual([10 + 100, 20 - 0, 30 - 350]);
    expect(p.V1).toEqual([10 - 50, 20 - 85, 30 + 30]);
    expect(p.V6).toEqual([10 + 135, 20 - 25, 30 - 5]);
  });

  it("works in millimetres: voxel coordinates times the voxel size", () => {
    const p = electrodePositions(frameWith({ voxelMm: 2, centroid: [5, 10, 15] })); // centroid is (10, 20, 30) mm
    expect(p.RA).toEqual([10 - 190, 20, 30 + 230]);
    expect(p.V3).toEqual([10 + 25, 20 - 95, 30 + 10]);
  });

  it("recovers the offsets along the frame axes for a frame rotated in every direction", () => {
    // rotation by 0.9 rad about an oblique axis, applied to the axis-aligned frame: still right-handed
    const k: Vec3 = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    const c = Math.cos(0.9);
    const s = Math.sin(0.9);
    const rot = (v: Vec3): Vec3 => {
      const kv = dot(k, v);
      const kxv: Vec3 = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
      return [0, 1, 2].map((i) => v[i] * c + kxv[i] * s + k[i] * kv * (1 - c)) as Vec3;
    };
    const f = frameWith({ leftDir: rot([1, 0, 0]), superiorDir: rot([0, 0, 1]), anteriorDir: rot([0, -1, 0]), voxelMm: 1.5, centroid: [40, 30, 20] });
    const p = electrodePositions(f);
    const centre: Vec3 = [f.centroid[0] * f.voxelMm, f.centroid[1] * f.voxelMm, f.centroid[2] * f.voxelMm];
    for (const name of ELECTRODE_NAMES) {
      const d = sub(p[name], centre);
      const [left, anterior, superior] = ANATOMICAL_OFFSETS[name];
      expect(dot(d, f.leftDir)).toBeCloseTo(left, 9);
      expect(dot(d, f.anteriorDir)).toBeCloseTo(anterior, 9);
      expect(dot(d, f.superiorDir)).toBeCloseTo(superior, 9);
    }
  });

  it("puts the two arm electrodes on opposite sides of the heart and the leg electrode below them", () => {
    const f = frameWith();
    const p = electrodePositions(f);
    expect(dot(sub(p.LA, p.RA), f.leftDir)).toBeGreaterThan(0);
    expect(dot(sub(p.LL, p.RA), f.superiorDir)).toBeLessThan(0);
    expect(dot(sub(p.LL, p.LA), f.superiorDir)).toBeLessThan(0);
  });

  it("keeps every electrode of the shipped frame well clear of the heart muscle", () => {
    const dir = resolve(__dirname, "../../public/data");
    const frame = parseFrame(JSON.parse(readFileSync(resolve(dir, "heart-frame.json"), "utf8")));
    const raw = readFileSync(resolve(dir, "heart.bin"));
    const grid = parseHeart(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const pos = electrodePositions(frame);
    const nearest: Record<string, number> = {};
    for (const name of ELECTRODE_NAMES) nearest[name] = Infinity;
    for (let z = 0; z < grid.nz; z++)
      for (let y = 0; y < grid.ny; y++)
        for (let x = 0; x < grid.nx; x++) {
          if (grid.tissue[x + grid.nx * (y + grid.ny * z)] === 0) continue;
          for (const name of ELECTRODE_NAMES) {
            const e = pos[name];
            const d = Math.hypot(e[0] - x * grid.voxelMm, e[1] - y * grid.voxelMm, e[2] - z * grid.voxelMm);
            if (d < nearest[name]) nearest[name] = d;
          }
        }
    console.log("nearest muscle voxel to each electrode (mm): " + ELECTRODE_NAMES.map((n) => `${n} ${nearest[n].toFixed(0)}`).join(", "));
    // the 1/r^2 field is only meaningful at a distance: nothing may sit inside or against the muscle
    for (const name of ELECTRODE_NAMES) expect(nearest[name]).toBeGreaterThan(25);
  });
});
