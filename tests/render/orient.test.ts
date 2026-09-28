import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { heartFrame, poseRotation, rotate, rotateBack, type Mat3 } from "../../src/render/orient";
import type { Vec3 } from "../../src/render/camera";
import { parseHeart, type HeartGrid } from "../../src/data/loadHeart";

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angleDeg = (a: number[], b: number[]) => (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;

/**
 * A crude ventricle: a hollow cone along +x, thick-walled, open at its wide flat cut at the -x end and
 * closed and blunt at the +x end, with a thin-walled lobe hanging off its +y side (the "right ventricle").
 */
function coneGrid(): HeartGrid {
  const [nx, ny, nz] = [96, 64, 60];
  const tissue = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 12; x < nx; x++) {
        const r = Math.hypot(y - 25, z - 30);
        const rOut = Math.max(0, 24 * (1 - (x - 12) / 78));
        const rIn = x < 70 ? 17 * (1 - (x - 12) / 58) : -1;
        const cone = r <= rOut && r > rIn;
        // a lobe: a shell two voxels thick on the +y side
        const q = ((x - 42) / 24) ** 2 + ((y - 42) / 13) ** 2 + ((z - 30) / 15) ** 2;
        const qIn = ((x - 42) / 22) ** 2 + ((y - 42) / 11) ** 2 + ((z - 30) / 13) ** 2;
        const lobe = q <= 1 && qIn > 1 && y > 32;
        if (cone || lobe) tissue[x + nx * (y + ny * z)] = 2;
      }
  return { nx, ny, nz, voxelMm: 1, tissue, fibre: new Int8Array(3 * nx * ny * nz) };
}

describe("heartFrame on a synthetic cone", () => {
  const f = heartFrame(coneGrid());

  it("finds the apex at the closed end, away from the open cut", () => {
    expect(f.apex[0]).toBeGreaterThan(0.95);
  });

  it("finds the thin-walled side", () => {
    expect(f.rv[1]).toBeGreaterThan(0.7);
    expect(Math.abs(dot(f.rv, f.apex))).toBeLessThan(1e-6);
    expect(Math.hypot(...f.rv)).toBeCloseTo(1, 6);
  });
});

describe("heartFrame on the real heart", () => {
  const raw = readFileSync("public/data/heart.bin");
  const grid = parseHeart(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const f = heartFrame(grid);

  it("puts the apex opposite the open base", () => {
    // The base is the flat cut end, the low end of the long axis (0.845, 0.532, -0.057), found by
    // hand from the slab profile and from renders of the open base.
    expect(angleDeg(f.apex, [0.845, 0.532, -0.057])).toBeLessThan(12);
  });

  it("points the right-ventricle direction from the thick wall toward the thin one", () => {
    expect(angleDeg(f.rv, [0.3, -0.55, -0.78])).toBeLessThan(30);
  });
});

describe("poseRotation", () => {
  const frame = { centroid: [0, 0, 0] as [number, number, number], apex: [0.6, 0, 0.8] as [number, number, number], rv: [0, 1, 0] as [number, number, number] };
  const tilt = (30 * Math.PI) / 180;
  const R = poseRotation(frame, tilt);

  it("is a proper rotation", () => {
    const rows = [R.slice(0, 3), R.slice(3, 6), R.slice(6, 9)];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(dot(rows[i], rows[j])).toBeCloseTo(i === j ? 1 : 0, 6);
    const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
    expect(det).toBeCloseTo(1, 6);
  });

  it("stands the apex down and a little to the right, and puts the right ventricle on the left", () => {
    const a = rotate(R, frame.apex);
    expect(a[0]).toBeCloseTo(Math.sin(tilt), 6);
    expect(a[1]).toBeCloseTo(-Math.cos(tilt), 6);
    expect(a[2]).toBeCloseTo(0, 6);
    const r = rotate(R, frame.rv);
    expect(r[0]).toBeLessThan(-0.8);
  });

  it("is undone by rotateBack", () => {
    const v: [number, number, number] = [0.3, -1.2, 2.5];
    const back = rotateBack(R as Mat3, rotate(R as Mat3, v));
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(v[i], 6);
  });
});

describe("poseRotation from the anatomical frame file", () => {
  // the frame of the shipped heart: apex = long axis, right ventricle = minus the left direction
  const f = JSON.parse(readFileSync("public/data/heart-frame.json", "utf8")) as { longAxis: Vec3; leftDir: Vec3; superiorDir: Vec3; anteriorDir: Vec3 };
  const tilt = (30 * Math.PI) / 180;
  const R = poseRotation({ apex: f.longAxis, rv: [-f.leftDir[0], -f.leftDir[1], -f.leftDir[2]] }, tilt);
  const close = (v: Vec3, want: Vec3) => v.forEach((x, i) => expect(x).toBeCloseTo(want[i], 2));

  it("is the textbook front view: the front of the heart faces the viewer", () => {
    close(rotate(R, f.anteriorDir), [0, 0, 1]);
  });

  it("puts the apex down and to the viewer's right, the base up and to the left", () => {
    close(rotate(R, f.longAxis), [Math.sin(tilt), -Math.cos(tilt), 0]);
    close(rotate(R, f.superiorDir), [-Math.sin(tilt), Math.cos(tilt), 0]);
  });

  it("puts the left ventricle to the right of the picture and the right ventricle to the left", () => {
    close(rotate(R, f.leftDir), [Math.cos(tilt), Math.sin(tilt), 0]);
  });

  it("stays a rotation when the two directions are not quite perpendicular", () => {
    const skew = poseRotation({ apex: f.longAxis, rv: [-f.leftDir[0] + 0.02, -f.leftDir[1], -f.leftDir[2] + 0.01] }, tilt);
    const row = (i: number) => skew.slice(3 * i, 3 * i + 3);
    for (let i = 0; i < 3; i++) expect(Math.hypot(...row(i))).toBeCloseTo(1, 6);
    expect(dot(row(0), row(1))).toBeCloseTo(0, 6);
  });
});
