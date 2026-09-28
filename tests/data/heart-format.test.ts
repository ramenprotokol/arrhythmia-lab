import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(__dirname, "../../public/data");
const heartPath = resolve(dir, "heart.bin");
const surfacePath = resolve(dir, "heart-surface.bin");
const creditsPath = resolve(dir, "credits.json");

const MiB = 1024 * 1024;

function view(path: string): DataView {
  const b = readFileSync(path);
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

const magic = (v: DataView) => String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));

describe("heart.bin", () => {
  const v = view(heartPath);
  const nx = v.getUint32(4, true);
  const ny = v.getUint32(8, true);
  const nz = v.getUint32(12, true);
  const voxelMm = v.getFloat32(16, true);
  const HEADER = 20;

  it("has the HRT1 magic and a sane header", () => {
    expect(magic(v)).toBe("HRT1");
    expect(nx).toBeGreaterThan(0);
    expect(ny).toBeGreaterThan(0);
    expect(nz).toBeGreaterThan(0);
    expect(voxelMm).toBeGreaterThanOrEqual(0.5);
    expect(voxelMm).toBeLessThanOrEqual(2);
  });

  it("has exactly header + 4 bytes per voxel", () => {
    expect(v.byteLength).toBe(HEADER + nx * ny * nz * 4);
  });

  it("keeps total shipped data under 8 MiB", () => {
    const total = statSync(heartPath).size + statSync(surfacePath).size + statSync(creditsPath).size;
    expect(total).toBeLessThan(8 * MiB);
  });

  it("has between 100,000 and 2,000,000 muscle voxels, all three layers present", () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < nx * ny * nz; i++) {
      const t = v.getUint8(HEADER + i * 4);
      expect(t).toBeLessThanOrEqual(3);
      counts[t]++;
    }
    const muscle = counts[1] + counts[2] + counts[3];
    expect(muscle).toBeGreaterThanOrEqual(100_000);
    expect(muscle).toBeLessThanOrEqual(2_000_000);
    expect(counts[1]).toBeGreaterThan(0);
    expect(counts[2]).toBeGreaterThan(0);
    expect(counts[3]).toBeGreaterThan(0);
  });

  it("has unit fibre vectors (0.9..1.1) on every muscle voxel", () => {
    let bad = 0;
    for (let i = 0; i < nx * ny * nz; i++) {
      const o = HEADER + i * 4;
      if (v.getUint8(o) === 0) continue;
      const fx = v.getInt8(o + 1) / 127;
      const fy = v.getInt8(o + 2) / 127;
      const fz = v.getInt8(o + 3) / 127;
      const len = Math.hypot(fx, fy, fz);
      if (len < 0.9 || len > 1.1) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe("heart-surface.bin", () => {
  const v = view(surfacePath);
  const vertexCount = v.getUint32(4, true);
  const indexCount = v.getUint32(8, true);
  const HEADER = 12;

  it("has the SRF1 magic and a plausible size", () => {
    expect(magic(v)).toBe("SRF1");
    expect(vertexCount).toBeGreaterThan(1000);
    expect(indexCount % 3).toBe(0);
    expect(indexCount / 3).toBeGreaterThan(10_000);
    expect(indexCount / 3).toBeLessThan(80_000);
  });

  it("has exactly header + positions + normals + indices", () => {
    expect(v.byteLength).toBe(HEADER + vertexCount * 12 * 2 + indexCount * 4);
  });

  it("has every index below vertexCount", () => {
    const off = HEADER + vertexCount * 24;
    let max = 0;
    for (let i = 0; i < indexCount; i++) max = Math.max(max, v.getUint32(off + i * 4, true));
    expect(max).toBeLessThan(vertexCount);
  });

  it("has finite positions and unit normals", () => {
    let badNormal = 0;
    for (let i = 0; i < vertexCount; i++) {
      const p = HEADER + i * 12;
      const n = HEADER + vertexCount * 12 + i * 12;
      for (let k = 0; k < 3; k++) expect(Number.isFinite(v.getFloat32(p + k * 4, true))).toBe(true);
      const len = Math.hypot(v.getFloat32(n, true), v.getFloat32(n + 4, true), v.getFloat32(n + 8, true));
      if (len < 0.9 || len > 1.1) badNormal++;
    }
    expect(badNormal).toBe(0);
  });

  it("shares the grid's millimetre frame (surface lies inside the grid box)", () => {
    const h = view(heartPath);
    const box = [0, 1, 2].map((k) => h.getUint32(4 + k * 4, true) * h.getFloat32(16, true));
    for (let i = 0; i < vertexCount; i++) {
      for (let k = 0; k < 3; k++) {
        const x = v.getFloat32(HEADER + i * 12 + k * 4, true);
        expect(x).toBeGreaterThanOrEqual(-1);
        expect(x).toBeLessThanOrEqual(box[k] + 1);
      }
    }
  });
});

describe("credits.json", () => {
  const c = JSON.parse(readFileSync(creditsPath, "utf8")) as Record<string, unknown>;
  it("names the dataset, authors, licence and record URL", () => {
    expect(typeof c.title).toBe("string");
    expect(Array.isArray(c.authors)).toBe(true);
    expect((c.authors as string[]).length).toBeGreaterThan(0);
    expect(c.licence).toBe("CC BY 4.0");
    expect(c.url).toBe("https://zenodo.org/records/3890034");
  });
});
