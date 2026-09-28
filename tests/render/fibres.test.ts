import { describe, it, expect } from "vitest";
import { fibreTensors } from "../../src/render/fibres";
import { blockGrid } from "../gpu/synthGrid";
import type { HeartGrid } from "../../src/data/loadHeart";

const q = (v: number) => Math.round(v * 127);

/** A grid with the given fibre at voxel 0 and 1, the rest empty. */
function twoVoxels(f0: [number, number, number], f1: [number, number, number]): HeartGrid {
  const g = blockGrid(2, 1, 1, [1, 0, 0]);
  g.fibre.set([q(f0[0]), q(f0[1]), q(f0[2]), q(f1[0]), q(f1[1]), q(f1[2])]);
  return g;
}

describe("fibreTensors", () => {
  // padded 4 x 3 x 3; original voxel (x, 0, 0) is padded (x + 1, 1, 1)
  const at = (x: number) => 4 * (x + 1 + 4 * (1 + 3 * 1));

  it("stores f f^T of the fibre: xx yy zz xy in the first texture, xz yz in the second", () => {
    const t = fibreTensors(twoVoxels([1, 0, 0], [0.6, 0.8, 0]));
    const a = (i: number) => t.a[at(0) + i] / 127;
    const b = (i: number) => t.b[at(0) + i] / 127;
    expect([a(0), a(1), a(2), a(3)]).toEqual([1, 0, 0, 0]); // along x
    expect(b(0)).toBe(0);
    expect(b(1)).toBe(0);
    // the second voxel: f = (0.6, 0.8, 0)
    const a1 = (i: number) => t.a[at(1) + i] / 127;
    expect(a1(0)).toBeCloseTo(0.36, 1);
    expect(a1(1)).toBeCloseTo(0.64, 1);
    expect(a1(3)).toBeCloseTo(0.48, 1);
  });

  it("does not care about the sign of the fibre", () => {
    const up = fibreTensors(twoVoxels([0.3, -0.6, 0.74], [0.3, -0.6, 0.74]));
    const down = fibreTensors(twoVoxels([-0.3, 0.6, -0.74], [-0.3, 0.6, -0.74]));
    expect(Array.from(up.a)).toEqual(Array.from(down.a));
    expect(Array.from(up.b)).toEqual(Array.from(down.b));
  });

  it("renormalises a fibre that was rounded to 8 bits, and leaves empty voxels zero", () => {
    const t = fibreTensors(twoVoxels([0.7, 0.7, 0.14], [0, 0, 1]));
    const trace = (t.a[at(0)] + t.a[at(0) + 1] + t.a[at(0) + 2]) / 127;
    expect(trace).toBeGreaterThan(0.97);
    expect(trace).toBeLessThan(1.03);
    // the padding layer and everything else is empty
    expect(Array.from(t.a.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(t.b.slice(0, 4))).toEqual([0, 0, 0, 0]);
  });

  it("has one four-byte texel per padded voxel in both textures", () => {
    const t = fibreTensors(blockGrid(5, 6, 7, [1, 0, 0]));
    expect(t.a.length).toBe(4 * 7 * 8 * 9);
    expect(t.b.length).toBe(4 * 7 * 8 * 9);
  });
});
