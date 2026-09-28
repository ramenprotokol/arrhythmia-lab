import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseHeart, parseSurface } from "../../src/data/loadHeart";

function tinyHeart(nx: number, ny: number, nz: number, voxelMm: number, records: number[][]): ArrayBuffer {
  const buf = new ArrayBuffer(20 + 4 * nx * ny * nz);
  const dv = new DataView(buf);
  "HRT1".split("").forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint32(4, nx, true);
  dv.setUint32(8, ny, true);
  dv.setUint32(12, nz, true);
  dv.setFloat32(16, voxelMm, true);
  records.forEach((r, i) => {
    dv.setUint8(20 + 4 * i, r[0]);
    dv.setInt8(21 + 4 * i, r[1]);
    dv.setInt8(22 + 4 * i, r[2]);
    dv.setInt8(23 + 4 * i, r[3]);
  });
  return buf;
}

describe("parseHeart", () => {
  it("splits interleaved records into tissue and fibre arrays", () => {
    const g = parseHeart(tinyHeart(2, 1, 2, 1.5, [[0, 0, 0, 0], [1, 127, 0, 0], [2, 0, -127, 0], [3, 0, 0, 64]]));
    expect([g.nx, g.ny, g.nz, g.voxelMm]).toEqual([2, 1, 2, 1.5]);
    expect(Array.from(g.tissue)).toEqual([0, 1, 2, 3]);
    expect(Array.from(g.fibre)).toEqual([0, 0, 0, 127, 0, 0, 0, -127, 0, 0, 0, 64]);
  });

  it("rejects a bad magic number", () => {
    const buf = tinyHeart(1, 1, 1, 1, [[1, 0, 0, 0]]);
    new DataView(buf).setUint8(0, 0x58);
    expect(() => parseHeart(buf)).toThrow(/magic/i);
  });

  it("rejects a file whose size does not match its header", () => {
    const buf = tinyHeart(2, 2, 2, 1, []);
    expect(() => parseHeart(buf.slice(0, buf.byteLength - 4))).toThrow(/size/i);
  });

  it("parses the shipped heart file", () => {
    const raw = readFileSync("public/data/heart.bin");
    const g = parseHeart(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    expect(g.tissue.length).toBe(g.nx * g.ny * g.nz);
    expect(g.fibre.length).toBe(3 * g.tissue.length);
    expect(g.tissue.reduce((n, t) => n + (t > 0 ? 1 : 0), 0)).toBeGreaterThan(100_000);
  });
});

describe("parseSurface", () => {
  it("reads positions, normals and indices", () => {
    const V = 3, I = 3;
    const buf = new ArrayBuffer(12 + 24 * V + 4 * I);
    const dv = new DataView(buf);
    "SRF1".split("").forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
    dv.setUint32(4, V, true);
    dv.setUint32(8, I, true);
    for (let i = 0; i < 3 * V; i++) dv.setFloat32(12 + 4 * i, i, true);
    for (let i = 0; i < 3 * V; i++) dv.setFloat32(12 + 12 * V + 4 * i, 0.5, true);
    [0, 1, 2].forEach((v, i) => dv.setUint32(12 + 24 * V + 4 * i, v, true));
    const s = parseSurface(buf);
    expect(s.positions.length).toBe(9);
    expect(s.positions[8]).toBe(8);
    expect(s.normals[0]).toBe(0.5);
    expect(Array.from(s.indices)).toEqual([0, 1, 2]);
  });

  it("rejects an index that points past the last vertex", () => {
    const V = 1, I = 3;
    const buf = new ArrayBuffer(12 + 24 * V + 4 * I);
    const dv = new DataView(buf);
    "SRF1".split("").forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
    dv.setUint32(4, V, true);
    dv.setUint32(8, I, true);
    dv.setUint32(12 + 24 * V, 5, true);
    expect(() => parseSurface(buf)).toThrow(/index/i);
  });

  it("parses the shipped surface file", () => {
    const raw = readFileSync("public/data/heart-surface.bin");
    const s = parseSurface(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    expect(s.indices.length % 3).toBe(0);
    expect(s.positions.length).toBe(s.normals.length);
  });
});
