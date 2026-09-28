import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFrame, type HeartFrame, type Vec3 } from "../../src/data/heartFrame";
import { parseHeart, type HeartGrid } from "../../src/data/loadHeart";

const dir = resolve(__dirname, "../../public/data");

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
// Math.max(...values) overflows the call stack on 180,000 values, so fold instead.
const maxOf = (xs: number[]): number => xs.reduce((m, x) => (x > m ? x : m), -Infinity);
const minOf = (xs: number[]): number => xs.reduce((m, x) => (x < m ? x : m), Infinity);

// A small valid frame, axis aligned. Right-handed means superior x left = posterior = -anterior.
function goodFrame(): Record<string, unknown> {
  return {
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
  };
}

describe("parseFrame", () => {
  it("accepts a valid frame and returns the same numbers", () => {
    const f = parseFrame(goodFrame());
    expect(f.voxelMm).toBe(1);
    expect(f.leftDir).toEqual([1, 0, 0]);
    expect(f.apexVoxel).toEqual([10, 20, 2]);
    expect(f.lengthMm).toBe(58);
  });

  it("ignores keys it does not know", () => {
    expect(() => parseFrame({ ...goodFrame(), note: "extra" })).not.toThrow();
  });

  it("rejects input that is not an object", () => {
    for (const bad of [null, undefined, 3, "frame", [1, 2, 3]]) expect(() => parseFrame(bad)).toThrow(/heart frame/);
  });

  it("rejects a frame with any key missing, naming the key", () => {
    for (const key of Object.keys(goodFrame())) {
      const g = goodFrame();
      delete g[key];
      expect(() => parseFrame(g), key).toThrow(new RegExp(key));
    }
  });

  it("rejects a vector that is not three finite numbers", () => {
    for (const bad of [[1, 0], [1, 0, 0, 0], [1, 0, Number.NaN], [1, "0", 0], "x"]) {
      expect(() => parseFrame({ ...goodFrame(), centroid: bad })).toThrow(/centroid/);
    }
  });

  it("rejects a voxel size or length that is not a positive number", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseFrame({ ...goodFrame(), voxelMm: bad })).toThrow(/voxelMm/);
      expect(() => parseFrame({ ...goodFrame(), lengthMm: bad })).toThrow(/lengthMm/);
    }
  });

  it("rejects voxel indices that are not non-negative whole numbers", () => {
    expect(() => parseFrame({ ...goodFrame(), apexVoxel: [1.5, 2, 3] })).toThrow(/apexVoxel/);
    expect(() => parseFrame({ ...goodFrame(), baseVoxel: [1, -2, 3] })).toThrow(/baseVoxel/);
  });

  it("holds direction vectors to unit length within 1e-3", () => {
    expect(() => parseFrame({ ...goodFrame(), leftDir: [1.0005, 0, 0] })).not.toThrow();
    for (const key of ["longAxis", "leftDir", "superiorDir", "anteriorDir"]) {
      const g = goodFrame();
      const v = g[key] as number[];
      g[key] = v.map((x) => x * 1.002);
      expect(() => parseFrame(g), key).toThrow(new RegExp(`${key}.*unit`));
    }
  });

  it("holds the three axes orthogonal within 1e-2", () => {
    const tilt = (deg: number): number[] => [Math.cos((deg * Math.PI) / 180), 0, Math.sin((deg * Math.PI) / 180)];
    // 0.3 degrees off is a dot product of 0.005: allowed. 1 degree is 0.017: not allowed.
    expect(() => parseFrame({ ...goodFrame(), leftDir: tilt(0.3) })).not.toThrow();
    expect(() => parseFrame({ ...goodFrame(), leftDir: tilt(1) })).toThrow(/orthogonal/);
  });

  it("rejects a mirrored (left-handed) frame", () => {
    expect(() => parseFrame({ ...goodFrame(), anteriorDir: [0, 1, 0] })).toThrow(/right-handed/);
  });
});

// ---- the shipped file ----------------------------------------------------------------------------

// HEART_FRAME points the same checks at another frame file, for example a candidate for a different heart.
const rawJson = JSON.parse(readFileSync(process.env.HEART_FRAME ?? resolve(dir, "heart-frame.json"), "utf8")) as unknown;
const heartFile = readFileSync(resolve(dir, "heart.bin"));
const grid: HeartGrid = parseHeart(heartFile.buffer.slice(heartFile.byteOffset, heartFile.byteOffset + heartFile.byteLength));

function muscleVoxels(g: HeartGrid): Vec3[] {
  const out: Vec3[] = [];
  for (let z = 0; z < g.nz; z++)
    for (let y = 0; y < g.ny; y++)
      for (let x = 0; x < g.nx; x++) if (g.tissue[x + g.nx * (y + g.ny * z)] > 0) out.push([x, y, z]);
  return out;
}

describe("public/data/heart-frame.json", () => {
  const f: HeartFrame = parseFrame(rawJson);
  const voxels = muscleVoxels(grid);
  const isMuscle = (v: Vec3): boolean => grid.tissue[v[0] + grid.nx * (v[1] + grid.ny * v[2])] > 0;

  it("passes parseFrame and has exactly the documented keys", () => {
    expect(Object.keys(rawJson as object).sort()).toEqual(
      [
        "anteriorDir",
        "apexVoxel",
        "atriaCentroid",
        "baseVoxel",
        "centroid",
        "leftDir",
        "lengthMm",
        "longAxis",
        "lvCentroid",
        "rvCentroid",
        "superiorDir",
        "voxelMm",
      ].sort(),
    );
  });

  it("uses the same voxel size as heart.bin", () => {
    expect(f.voxelMm).toBe(grid.voxelMm);
  });

  it("has unit, mutually orthogonal, right-handed axes to better than 1e-5", () => {
    for (const v of [f.longAxis, f.leftDir, f.superiorDir, f.anteriorDir]) expect(Math.abs(norm(v) - 1)).toBeLessThan(1e-5);
    expect(Math.abs(dot(f.leftDir, f.superiorDir))).toBeLessThan(1e-5);
    expect(Math.abs(dot(f.leftDir, f.anteriorDir))).toBeLessThan(1e-5);
    expect(Math.abs(dot(f.superiorDir, f.anteriorDir))).toBeLessThan(1e-5);
    // posterior = superior x left, anterior = -posterior
    const posterior = cross(f.superiorDir, f.leftDir);
    for (let i = 0; i < 3; i++) expect(Math.abs(posterior[i] + f.anteriorDir[i])).toBeLessThan(1e-5);
  });

  it("points superior along the reverse of the base-to-apex axis, and left across it", () => {
    expect(Math.abs(dot(f.leftDir, f.longAxis))).toBeLessThan(1e-5);
    for (let i = 0; i < 3; i++) expect(Math.abs(f.superiorDir[i] + f.longAxis[i])).toBeLessThan(1e-5);
  });

  it("has a centroid equal to the mean muscle voxel of heart.bin (checks the coordinate convention)", () => {
    const mean: Vec3 = [0, 0, 0];
    for (const v of voxels) for (let i = 0; i < 3; i++) mean[i] += v[i] / voxels.length;
    // a shift of half a voxel or a swapped axis would give 0.5 mm or more
    expect(norm(sub(mean, f.centroid))).toBeLessThan(0.1);
  });

  it("has the apex and base voxels on muscle, at the two ends of the long axis", () => {
    for (const v of [f.apexVoxel, f.baseVoxel]) {
      expect(v[0]).toBeLessThan(grid.nx);
      expect(v[1]).toBeLessThan(grid.ny);
      expect(v[2]).toBeLessThan(grid.nz);
      expect(isMuscle(v)).toBe(true);
    }
    const t = voxels.map((v) => dot(sub(v, f.centroid), f.longAxis));
    const tApex = dot(sub(f.apexVoxel, f.centroid), f.longAxis);
    const tBase = dot(sub(f.baseVoxel, f.centroid), f.longAxis);
    expect(tApex).toBeCloseTo(maxOf(t), 9);
    expect(tBase).toBeCloseTo(minOf(t), 9);
    expect(f.lengthMm).toBeCloseTo((tApex - tBase) * f.voxelMm, 3);
    expect(f.lengthMm).toBeGreaterThan(80);
    expect(f.lengthMm).toBeLessThan(160);
  });

  // The three checks the frame has to survive. See tools/README.md for why (a) is not the one first proposed.
  it("(a) has the right-handed anatomy the derivation assumes: RV on the right of the LV", () => {
    // The RV to LV direction defines "left", so the RV centroid must sit clearly on the negative side.
    expect(dot(sub(f.lvCentroid, f.rvCentroid), f.leftDir)).toBeGreaterThan(20);
    // and, by construction, the two centroids have no anterior offset at all. That is why the RV cannot be
    // used to test the anterior sign: the pulmonary artery vs aorta check and the fibre helix check do.
    expect(Math.abs(dot(sub(f.rvCentroid, f.lvCentroid), f.anteriorDir))).toBeLessThan(1e-3);
  });

  it("(a) has fibres that are a right-handed helix at the endocardium and left-handed at the epicardium", () => {
    // Streeter: subendocardial fibres wind like a right-handed screw about the long axis, subepicardial
    // ones like a left-handed screw. A mirrored coordinate system would swap them.
    const axis = f.longAxis;
    const centre = f.lvCentroid;
    function rightHandedFraction(layer: number): number {
      let right = 0;
      let total = 0;
      for (const v of voxels) {
        if (grid.tissue[v[0] + grid.nx * (v[1] + grid.ny * v[2])] !== layer) continue;
        const p = sub(v, centre);
        const along = dot(p, axis);
        const radial: Vec3 = [p[0] - along * axis[0], p[1] - along * axis[1], p[2] - along * axis[2]];
        const r = norm(radial);
        if (r < 5 || r > 45 || Math.abs(along) > 25) continue; // the free wall of the LV, mid-ventricle
        const theta = cross(axis, [radial[0] / r, radial[1] / r, radial[2] / r]);
        const i = v[0] + grid.nx * (v[1] + grid.ny * v[2]);
        const fibre: Vec3 = [grid.fibre[3 * i] / 127, grid.fibre[3 * i + 1] / 127, grid.fibre[3 * i + 2] / 127];
        if (dot(fibre, axis) * dot(fibre, theta) > 0) right++;
        total++;
      }
      return right / total;
    }
    const endo = rightHandedFraction(1);
    const epi = rightHandedFraction(3);
    console.log(`fibre helix: endocardium ${(100 * endo).toFixed(0)}% right-handed, epicardium ${(100 * epi).toFixed(0)}% right-handed`);
    expect(endo).toBeGreaterThan(0.6);
    expect(epi).toBeLessThan(0.2);
  });

  it("(b) has the atria on the superior side of the ventricles", () => {
    const d = dot(sub(f.atriaCentroid, f.centroid), f.superiorDir);
    console.log(`atria are ${d.toFixed(1)} mm superior of the ventricular centroid`);
    expect(d).toBeGreaterThan(20);
  });

  it("(c) has the apex at the narrower end of the ventricles", () => {
    // Width of the muscle in a slab covering 15% of the length at each end: RMS distance from the axis.
    // (Counting muscle voxels instead is misleading here: the base is a hollow ring and the apex is solid.)
    const t = voxels.map((v) => dot(sub(v, f.centroid), f.longAxis));
    const lo = minOf(t);
    const hi = maxOf(t);
    const slab = 0.15 * (hi - lo);
    function rms(select: (x: number) => boolean): number {
      let sum = 0;
      let n = 0;
      voxels.forEach((v, k) => {
        if (!select(t[k])) return;
        const p = sub(v, f.centroid);
        const perp: Vec3 = [p[0] - t[k] * f.longAxis[0], p[1] - t[k] * f.longAxis[1], p[2] - t[k] * f.longAxis[2]];
        sum += dot(perp, perp);
        n++;
      });
      return Math.sqrt(sum / n);
    }
    const apex = rms((x) => x > hi - slab);
    const base = rms((x) => x < lo + slab);
    console.log(`slab width (RMS radius): apex end ${apex.toFixed(1)} mm, base end ${base.toFixed(1)} mm`);
    expect(apex).toBeLessThan(0.7 * base);
  });
});
