import { describe, it, expect } from "vitest";
import { castRay, pickVoxel } from "../../src/render/pick";
import { blockGrid, jaggedGrid, mulberry32 } from "../gpu/synthGrid";
import type { HeartGrid } from "../../src/data/loadHeart";

type V3 = [number, number, number];

const idx = (g: HeartGrid, [x, y, z]: V3) => x + g.nx * (y + g.ny * z);

/** Empty a box of voxels (inclusive bounds), to make pockets and tunnels in a block. */
function carve(g: HeartGrid, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g.tissue[x + g.nx * (y + g.ny * z)] = 0;
}

/** Distance along a unit ray at which it enters a voxel's box (slab method), 1 mm voxels. */
function entryT(o: V3, d: V3, v: V3): number {
  let t0 = -Infinity;
  for (let a = 0; a < 3; a++) {
    if (d[a] === 0) continue;
    const ta = (v[a] - o[a]) / d[a];
    const tb = (v[a] + 1 - o[a]) / d[a];
    t0 = Math.max(t0, Math.min(ta, tb));
  }
  return t0;
}

describe("pickVoxel", () => {
  const block = blockGrid(8, 8, 8, [1, 0, 0]);

  it("hits the first voxel on a straight ray, from either side", () => {
    expect(pickVoxel(block, [-5, 3.5, 3.5], [1, 0, 0], 1)).toEqual([0, 3, 3]);
    expect(pickVoxel(block, [20, 3.5, 3.5], [-1, 0, 0], 1)).toEqual([7, 3, 3]);
    expect(pickVoxel(block, [4.2, 3.5, 30], [0, 0, -1], 1)).toEqual([4, 3, 7]);
    expect(pickVoxel(block, [2.5, -9, 6.5], [0, 1, 0], 1)).toEqual([2, 0, 6]);
  });

  it("follows an oblique ray to the voxel it really enters", () => {
    // from (-2, -2, 0.5) along (1, 1, 0) the ray passes through the corner cell first
    expect(pickVoxel(block, [-2, -2, 0.5], [1, 1, 0], 1)).toEqual([0, 0, 0]);
    // steeply down from above: at y = 8 the ray is at x = 3.5 + 0.02 * 32 and z = 3.5 + 0.01 * 32
    expect(pickVoxel(block, [3.5, 40, 3.5], [0.02, -1, 0.01], 1)).toEqual([4, 7, 3]);
  });

  it("misses a block the ray passes by, or points away from", () => {
    expect(pickVoxel(block, [-5, 9.5, 3.5], [1, 0, 0], 1)).toBeNull(); // passes above
    expect(pickVoxel(block, [-5, 3.5, 3.5], [-1, 0, 0], 1)).toBeNull(); // points away
    expect(pickVoxel(block, [-5, 3.5, 3.5], [0, 1, 0], 1)).toBeNull(); // runs alongside, never enters
    expect(pickVoxel(block, [-3, -3, 3.5], [1, 0.2, 0], 1)).toBeNull(); // stays below the block the whole way
  });

  it("separates a ray that grazes inside an edge from one that grazes outside it", () => {
    expect(pickVoxel(block, [-5, 0.001, 3.5], [1, 0, 0], 1)).toEqual([0, 0, 3]);
    expect(pickVoxel(block, [-5, -0.001, 3.5], [1, 0, 0], 1)).toBeNull();
    expect(pickVoxel(block, [-5, 7.999, 3.5], [1, 0, 0], 1)).toEqual([0, 7, 3]);
    expect(pickVoxel(block, [-5, 8.001, 3.5], [1, 0, 0], 1)).toBeNull();
    // a ray sliding exactly along the outer face at y = 8 is outside the half-open voxel range
    expect(pickVoxel(block, [-5, 8, 3.5], [1, 0, 0], 1)).toBeNull();
    // running diagonally past the vertical edge at x = 0, z = 0: the line x + z = c stays outside for c < 0
    expect(pickVoxel(block, [-2, 3.5, 1.999], [1, 0, -1], 1)).toBeNull();
    expect(pickVoxel(block, [-2, 3.5, 2.001], [1, 0, -1], 1)).toEqual([0, 3, 0]);
  });

  it("returns the voxel a ray starts in when it starts inside muscle", () => {
    expect(pickVoxel(block, [2.5, 4.5, 5.5], [0.3, -0.2, 1], 1)).toEqual([2, 4, 5]);
    expect(pickVoxel(block, [0, 0, 0], [1, 1, 1], 1)).toEqual([0, 0, 0]);
  });

  it("finds the first muscle beyond a pocket when it starts in empty space inside the grid", () => {
    const g = blockGrid(10, 6, 6, [1, 0, 0]);
    carve(g, 0, 3, 0, 5, 0, 5); // empty slab x = 0..3
    expect(pickVoxel(g, [1.5, 2.5, 2.5], [1, 0, 0], 1)).toEqual([4, 2, 2]);
    expect(pickVoxel(g, [8, 2.5, 2.5], [-1, 0, 0], 1)).toEqual([8, 2, 2]);
  });

  it("passes down a tunnel without touching its walls, and hits the wall once it leaves the tunnel", () => {
    const t = blockGrid(10, 6, 6, [1, 0, 0]);
    carve(t, 0, 9, 2, 3, 2, 3); // a tunnel along x, two voxels square
    expect(pickVoxel(t, [-3, 3, 3], [1, 0, 0], 1)).toBeNull();
    // y = 3 + 0.21 * (x + 3) reaches 4 inside column x = 1, so the ray enters the wall voxel (1, 4, 3)
    expect(pickVoxel(t, [-3, 3, 3], [1, 0.21, 0], 1)).toEqual([1, 4, 3]);
  });

  it("works in millimetres with a voxel size other than one", () => {
    const g = { ...blockGrid(8, 8, 8, [1, 0, 0]), voxelMm: 2 };
    expect(pickVoxel(g, [-10, 7, 7], [1, 0, 0], 2)).toEqual([0, 3, 3]);
    expect(pickVoxel(g, [7, 7, 40], [0, 0, -1], 2)).toEqual([3, 3, 7]);
    expect(pickVoxel(g, [-10, 16.001, 7], [1, 0, 0], 2)).toBeNull(); // 16 mm is the top face
  });

  it("stops at a maximum distance when given one", () => {
    // the ray from x = -5 meets the block at distance 5
    expect(pickVoxel(block, [-5, 3.5, 3.5], [1, 0, 0], 1, 4.9)).toBeNull();
    expect(pickVoxel(block, [-5, 3.5, 3.5], [1, 0, 0], 1, 5.1)).toEqual([0, 3, 3]);
    // distances are in millimetres: with 2 mm voxels the same ray (from -10 mm) meets the block at 10 mm
    const g = { ...blockGrid(8, 8, 8, [1, 0, 0]), voxelMm: 2 };
    expect(pickVoxel(g, [-10, 7, 7], [1, 0, 0], 2, 9.9)).toBeNull();
    expect(pickVoxel(g, [-10, 7, 7], [1, 0, 0], 2, 10.1)).toEqual([0, 3, 3]);
    // a limit that ends inside the block still finds its first voxel
    expect(pickVoxel(block, [-5, 3.5, 3.5], [1, 0, 0], 1, 6.5)).toEqual([0, 3, 3]);
  });

  it("does not need a unit direction", () => {
    expect(pickVoxel(block, [-5, 3.5, 3.5], [40, 0, 0], 1)).toEqual([0, 3, 3]);
    expect(pickVoxel(block, [-5, 3.5, 3.5], [0.001, 0, 0], 1)).toEqual([0, 3, 3]);
  });

  it("terminates on rays that run exactly through voxel corners and edges", () => {
    expect(pickVoxel(block, [-4, -4, -4], [1, 1, 1], 1)).toEqual([0, 0, 0]);
    expect(pickVoxel(block, [12, 12, 12], [-1, -1, -1], 1)).toEqual([7, 7, 7]);
    // touches the block only at a corner point: any answer is fine, hanging is not
    expect(() => pickVoxel(block, [-4, 4, 4], [1, -1, 1], 1)).not.toThrow();
    expect(() => pickVoxel(block, [0, 0, -5], [0, 1, 1], 1)).not.toThrow();
  });

  it("returns a muscle voxel, and the first one, on a rough block", () => {
    const g = jaggedGrid(28, 7);
    const rnd = mulberry32(11);
    let hits = 0;
    for (let r = 0; r < 400; r++) {
      // from a random point in a box around the grid, aimed at a random point inside the grid
      const o: V3 = [-6 + 40 * rnd(), -6 + 40 * rnd(), -6 + 40 * rnd()];
      const aim: V3 = [4 + 20 * rnd(), 4 + 20 * rnd(), 4 + 20 * rnd()];
      const d0: V3 = [aim[0] - o[0] + 1e-3, aim[1] - o[1], aim[2] - o[2]];
      const len = Math.hypot(...d0);
      const d: V3 = [d0[0] / len, d0[1] / len, d0[2] / len];
      const got = pickVoxel(g, o, d0, 1);
      // reference: walk the ray in tiny steps and take the first sample that lands in muscle
      let ref: V3 | null = null;
      for (let t = 0; t < 120 && !ref; t += 0.004) {
        const x = Math.floor(o[0] + d[0] * t);
        const y = Math.floor(o[1] + d[1] * t);
        const z = Math.floor(o[2] + d[2] * t);
        if (x < 0 || y < 0 || z < 0 || x >= 28 || y >= 28 || z >= 28) continue;
        if (g.tissue[x + 28 * (y + 28 * z)] > 0) ref = [x, y, z];
      }
      if (got) {
        hits++;
        expect(g.tissue[idx(g, got)]).toBeGreaterThan(0);
      }
      // The exact traversal may catch a corner sliver the sampler steps over, never the other way round.
      if (ref) expect(got).not.toBeNull();
      if (ref && got && (got[0] !== ref[0] || got[1] !== ref[1] || got[2] !== ref[2])) {
        expect(entryT(o, d, got)).toBeLessThanOrEqual(entryT(o, d, ref) + 1e-9);
      }
    }
    expect(hits).toBeGreaterThan(100); // the rays really did hit the blob often
  });
});

describe("castRay", () => {
  const block = blockGrid(8, 8, 8, [1, 0, 0]);

  it("gives the voxel and the distance to where the ray enters it", () => {
    expect(castRay(block, [-5, 3.5, 3.5], [1, 0, 0], 1)).toEqual({ voxel: [0, 3, 3], distance: 5 });
    expect(castRay(block, [20, 3.5, 3.5], [-1, 0, 0], 1)).toEqual({ voxel: [7, 3, 3], distance: 12 });
    const oblique = castRay(block, [-2, -2, 0.5], [Math.SQRT1_2, Math.SQRT1_2, 0], 1);
    expect(oblique?.voxel).toEqual([0, 0, 0]);
    expect(oblique?.distance).toBeCloseTo(2 * Math.SQRT2, 6); // to the corner (0, 0)
  });

  it("measures the distance in millimetres", () => {
    const g = { ...blockGrid(8, 8, 8, [1, 0, 0]), voxelMm: 2 };
    expect(castRay(g, [-10, 7, 7], [1, 0, 0], 2)).toEqual({ voxel: [0, 3, 3], distance: 10 });
  });

  it("is zero for a ray that starts inside muscle, and reaches across a pocket", () => {
    expect(castRay(block, [2.5, 4.5, 5.5], [0, 0, 1], 1)?.distance).toBe(0);
    const g = blockGrid(10, 6, 6, [1, 0, 0]);
    carve(g, 0, 3, 0, 5, 0, 5);
    expect(castRay(g, [1.5, 2.5, 2.5], [1, 0, 0], 1)).toEqual({ voxel: [4, 2, 2], distance: 2.5 });
  });

  it("is null for a miss or a hit beyond the limit, and pickVoxel agrees", () => {
    expect(castRay(block, [-5, 9.5, 3.5], [1, 0, 0], 1)).toBeNull();
    expect(castRay(block, [-5, 3.5, 3.5], [1, 0, 0], 1, 4.9)).toBeNull();
    expect(castRay(block, [-5, 3.5, 3.5], [1, 0, 0], 1, 5.1)?.voxel).toEqual([0, 3, 3]);
    expect(pickVoxel(block, [-5, 3.5, 3.5], [1, 0, 0], 1)).toEqual(castRay(block, [-5, 3.5, 3.5], [1, 0, 0], 1)?.voxel);
  });
});
