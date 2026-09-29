import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ANATOMY_PART, parseAnatomy, parseHeart, parseSurface } from "../../src/data/loadHeart";

// heart-anatomy.bin: the per-vertex anatomy of the ventricular surface and the outer surface of the rest of the
// heart (atria, great vessels, vein stumps), written by tools/build_heart.py.

const file = (path: string): ArrayBuffer => {
  const raw = readFileSync(path);
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
};

/** A tiny ANA1 file: V ventricle vertices, one extra triangle. */
function tinyAnatomy(V: number, opts: { magic?: string; index?: number; trailing?: number } = {}): ArrayBuffer {
  const E = 3, EI = 3;
  const buf = new ArrayBuffer(16 + 8 * V + 20 * E + 4 * EI + (opts.trailing ?? 0));
  const dv = new DataView(buf);
  (opts.magic ?? "ANA1").split("").forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint32(4, V, true);
  dv.setUint32(8, E, true);
  dv.setUint32(12, EI, true);
  for (let i = 0; i < V; i++) {
    dv.setInt16(16 + 8 * i, -125, true); // groove -12.5 mm
    dv.setInt16(16 + 8 * i + 2, 30 + i, true); // base 3.0 mm, 3.1 mm, ...
    dv.setInt16(16 + 8 * i + 4, 32767, true); // open
    dv.setInt16(16 + 8 * i + 6, 500, true); // concavity 0.05 per mm
  }
  let o = 16 + 8 * V;
  for (let k = 0; k < 3 * E; k++) dv.setFloat32(o + 4 * k, k, true);
  o += 12 * E;
  for (let i = 0; i < E; i++) dv.setInt8(o + 4 * i + 2, 127); // +z
  o += 4 * E;
  for (let i = 0; i < E; i++) [ANATOMY_PART.aorta, 7, 255, 128 + 40].forEach((b, k) => dv.setUint8(o + 4 * i + k, b));
  o += 4 * E;
  [0, 1, opts.index ?? 2].forEach((v, i) => dv.setUint32(o + 4 * i, v, true));
  return buf;
}

describe("parseAnatomy", () => {
  it("reads the ventricle attributes and the extra mesh", () => {
    const a = parseAnatomy(tinyAnatomy(2), 2);
    expect(Array.from(a.groove)).toEqual([-12.5, -12.5]);
    expect(a.base[1]).toBeCloseTo(3.1, 5);
    expect(a.ao[0]).toBe(1);
    expect(a.concavity[0]).toBeCloseTo(0.05, 6);
    expect(a.extra.positions[8]).toBe(8);
    expect(Array.from(a.extra.normals.slice(0, 3))).toEqual([0, 0, 1]);
    expect(Array.from(a.extra.part)).toEqual([3, 3, 3]);
    expect(a.extra.dist[0]).toBe(7);
    expect(a.extra.ao[0]).toBe(1);
    expect(a.extra.concavity[0]).toBeCloseTo(0.1, 6);
    expect(Array.from(a.extra.indices)).toEqual([0, 1, 2]);
  });

  it("rejects a bad magic number, a wrong size, a stray index and a vertex count that does not match", () => {
    expect(() => parseAnatomy(tinyAnatomy(2, { magic: "SRF1" }))).toThrow(/magic/);
    expect(() => parseAnatomy(tinyAnatomy(2, { trailing: 4 }))).toThrow(/size/);
    expect(() => parseAnatomy(tinyAnatomy(2, { index: 3 }))).toThrow(/index/);
    expect(() => parseAnatomy(tinyAnatomy(2), 5)).toThrow(/ventricle vertices/);
    expect(() => parseAnatomy(new ArrayBuffer(8))).toThrow(/small/);
  });
});

describe("the shipped heart-anatomy.bin", () => {
  const surface = parseSurface(file("public/data/heart-surface.bin"));
  const V = surface.positions.length / 3;
  const a = parseAnatomy(file("public/data/heart-anatomy.bin"), V);
  const grid = parseHeart(file("public/data/heart.bin"));
  const box = [grid.nx * grid.voxelMm, grid.ny * grid.voxelMm, grid.nz * grid.voxelMm];

  it("describes every vertex of the ventricular surface, with sane values", () => {
    expect(a.groove.length).toBe(V);
    const range = (x: Float32Array) => [Math.min(...x), Math.max(...x)];
    const [g0, g1] = range(a.groove);
    expect(g0).toBeLessThan(-20); // there is LV surface well away from the grooves ...
    expect(g1).toBeGreaterThan(20); // ... and RV surface
    expect(g0).toBeGreaterThan(-200);
    expect(g1).toBeLessThan(200);
    const near = a.groove.filter((g) => Math.abs(g) < 3).length;
    expect(near / V).toBeGreaterThan(0.01); // the grooves run the length of the heart
    const [b0, b1] = range(a.base);
    expect(b0).toBe(0); // the seam
    expect(b1).toBeGreaterThan(60); // the apex is far from the base
    expect(b1).toBeLessThan(200);
    for (const v of a.ao) expect(v >= 0 && v <= 1).toBe(true);
    const openShare = Array.from(a.ao).filter((v) => v > 0.8).length / V;
    expect(openShare).toBeGreaterThan(0.6); // most of the ventricular surface faces the open
    const conc = Array.from(a.concavity).sort((p, q) => p - q);
    expect(conc[Math.floor(V / 2)]).toBeLessThan(0); // the heart is mostly convex
    expect(conc[Math.floor(V * 0.99)]).toBeGreaterThan(0.05); // but it has grooves
  });

  it("has the atria, the aorta, the pulmonary artery and vein stumps, drawn round the ventricles", () => {
    const E = a.extra.part.length;
    expect(E).toBeGreaterThan(5000);
    expect(a.extra.indices.length / 3).toBeGreaterThan(10000);
    const count = (p: number) => a.extra.part.filter((q) => q === p).length;
    for (const p of [ANATOMY_PART.leftAtrium, ANATOMY_PART.rightAtrium, ANATOMY_PART.aorta, ANATOMY_PART.pulmonaryArtery, ANATOMY_PART.veins]) {
      expect(count(p)).toBeGreaterThan(200);
    }
    expect(count(0)).toBe(0);
    for (let i = 0; i < a.extra.positions.length; i++) {
      const k = i % 3;
      expect(a.extra.positions[i]).toBeGreaterThan(-40);
      expect(a.extra.positions[i]).toBeLessThan(box[k] + 40);
    }
    for (let i = 0; i < E; i++) {
      const n = Math.hypot(a.extra.normals[3 * i], a.extra.normals[3 * i + 1], a.extra.normals[3 * i + 2]);
      expect(Math.abs(n - 1)).toBeLessThan(1e-3);
    }
    // the extra mesh starts at the ventricles
    expect(Math.min(...a.extra.dist)).toBeLessThan(1);
  });

  it("meets the ventricular surface along a seam of shared vertices, with no triangle blending two parts", () => {
    const key = (p: Float32Array, i: number) => `${p[3 * i]},${p[3 * i + 1]},${p[3 * i + 2]}`;
    const vent = new Set<string>();
    for (let i = 0; i < V; i++) vent.add(key(surface.positions, i));
    const E = a.extra.part.length;
    let shared = 0;
    for (let i = 0; i < E; i++) if (vent.has(key(a.extra.positions, i))) shared++;
    expect(shared).toBeGreaterThan(300);
    // the ventricular surface is open only along that seam: every border vertex of it is shared
    const edges = new Map<string, number>();
    const idx = surface.indices;
    for (let t = 0; t < idx.length; t += 3)
      for (const [p, q] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) {
        const e = p < q ? `${p}-${q}` : `${q}-${p}`;
        edges.set(e, (edges.get(e) ?? 0) + 1);
      }
    const extraKeys = new Set<string>();
    for (let i = 0; i < E; i++) extraKeys.add(key(a.extra.positions, i));
    let border = 0, open = 0;
    for (const [e, n] of edges) {
      if (n !== 1) continue;
      border++;
      for (const v of e.split("-").map(Number)) if (!extraKeys.has(key(surface.positions, v))) open++;
    }
    expect(border).toBeGreaterThan(300);
    expect(open).toBe(0);
    const x = a.extra.indices;
    for (let t = 0; t < x.length; t += 3) {
      expect(a.extra.part[x[t]]).toBe(a.extra.part[x[t + 1]]);
      expect(a.extra.part[x[t]]).toBe(a.extra.part[x[t + 2]]);
    }
  });
});
