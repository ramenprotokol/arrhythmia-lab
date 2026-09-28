import { describe, it, expect } from "vitest";
import { buildFields, distanceTransform, SDF_MAX_MM } from "../../src/render/fields";
import { blockGrid, jaggedGrid } from "../gpu/synthGrid";
import type { HeartGrid } from "../../src/data/loadHeart";

describe("distanceTransform", () => {
  it("is the exact Euclidean distance to the nearest occupied voxel", () => {
    const [nx, ny, nz] = [9, 8, 7];
    const occ = new Uint8Array(nx * ny * nz);
    const at = (x: number, y: number, z: number) => x + nx * (y + ny * z);
    occ[at(3, 2, 4)] = 1;
    occ[at(7, 6, 1)] = 1;
    const d = distanceTransform(occ, nx, ny, nz);
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const want = Math.min(Math.hypot(x - 3, y - 2, z - 4), Math.hypot(x - 7, y - 6, z - 1));
          expect(d[at(x, y, z)]).toBeCloseTo(want, 5);
        }
  });

  it("is zero on occupied voxels and grows away from a block", () => {
    const n = 12;
    const occ = new Uint8Array(n * n * n);
    for (let z = 4; z < 8; z++) for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) occ[x + n * (y + n * z)] = 1;
    const d = distanceTransform(occ, n, n, n);
    expect(d[5 + n * (5 + n * 5)]).toBe(0);
    expect(d[2 + n * (5 + n * 5)]).toBeCloseTo(2, 6); // two voxels left of the block face
    expect(d[0 + n * (0 + n * 0)]).toBeCloseTo(Math.hypot(4, 4, 4), 5);
  });

  it("never returns a distance longer than the true nearest one when nothing is occupied nearby", () => {
    const occ = new Uint8Array(6 * 6 * 6);
    const d = distanceTransform(occ, 6, 6, 6);
    expect(d[0]).toBeGreaterThan(1e6); // no occupied voxel anywhere: effectively infinite
  });
});

describe("buildFields", () => {
  const g: HeartGrid = blockGrid(10, 12, 14, [1, 0, 0]);
  const f = buildFields(g);
  const at = (x: number, y: number, z: number) => x + f.sx * (y + f.sy * z);

  it("pads the volume by one empty voxel on every side", () => {
    expect([f.sx, f.sy, f.sz]).toEqual([12, 14, 16]);
    expect(f.tissue.length).toBe(12 * 14 * 16);
    // original voxel (0, 0, 0) is padded voxel (1, 1, 1); the padding layer itself is empty
    expect(f.tissue[at(1, 1, 1)]).toBe(3);
    expect(f.tissue[at(0, 5, 5)]).toBe(0);
    expect(f.tissue[at(f.sx - 1, 5, 5)]).toBe(0);
  });

  it("keeps the tissue class of every voxel", () => {
    const j = jaggedGrid(20, 3);
    const fj = buildFields(j);
    for (let z = 0; z < 20; z++)
      for (let y = 0; y < 20; y++)
        for (let x = 0; x < 20; x++)
          expect(fj.tissue[x + 1 + fj.sx * (y + 1 + fj.sy * (z + 1))]).toBe(j.tissue[x + 20 * (y + 20 * z)]);
  });

  it("smooths the occupancy so that the 0.5 level sits on the tissue surface", () => {
    // deep inside: full; the padding corner only touches the block diagonally: nearly empty;
    // the voxels either side of a flat face: about one half each
    expect(f.density[at(6, 7, 8)]).toBeGreaterThan(250);
    expect(f.density[at(0, 0, 0)]).toBeLessThan(30);
    const inside = f.density[at(1, 7, 8)]; // the outermost muscle voxel
    const outside = f.density[at(0, 7, 8)]; // the padding voxel just beyond it
    expect(inside).toBeGreaterThan(128);
    expect(outside).toBeLessThan(128);
    expect(inside + outside).toBeGreaterThan(240); // symmetric about the face: the two sum to about 255
    expect(inside + outside).toBeLessThan(270);
  });

  it("also keeps a wider density, for smooth surface normals, with the same 0.5 level on the surface", () => {
    // a block with plenty of empty margin around it, as the heart has
    const n = 32;
    const grid = blockGrid(n, n, n, [1, 0, 0]);
    grid.tissue.fill(0);
    for (let z = 10; z < 22; z++) for (let y = 10; y < 22; y++) for (let x = 10; x < 22; x++) grid.tissue[x + n * (y + n * z)] = 3;
    const w = buildFields(grid);
    const idx = (x: number, y: number, z: number) => x + 1 + w.sx * (y + 1 + w.sy * (z + 1));
    expect(w.smooth.length).toBe(w.density.length);
    expect(w.smooth[idx(16, 16, 16)]).toBeGreaterThan(240); // deep inside: full
    expect(w.smooth[idx(0, 0, 0)]).toBe(0); // far outside: empty
    for (const d of [w.density, w.smooth]) {
      const inside = d[idx(10, 16, 16)]; // first muscle voxel across the face
      const outside = d[idx(9, 16, 16)]; // first empty voxel
      expect(inside + outside).toBeGreaterThan(245); // symmetric about the face
      expect(inside + outside).toBeLessThan(266);
    }
    // and the wide one is wider: a gentler step across the face
    const step = (d: Uint8Array) => d[idx(10, 16, 16)] - d[idx(9, 16, 16)];
    expect(step(w.smooth)).toBeLessThan(step(w.density));
  });

  it("stores the distance to the nearest muscle voxel in units of SDF_MAX_MM / 255", () => {
    expect(f.distance[at(6, 7, 8)]).toBe(0); // inside muscle
    expect(f.distance[at(0, 7, 8)]).toBe(Math.round((1 / SDF_MAX_MM) * 255)); // one voxel out
    expect(f.distance[at(0, 0, 0)]).toBe(Math.round((Math.hypot(1, 1, 1) / SDF_MAX_MM) * 255));
  });

  it("scales the distance by the voxel size", () => {
    const g2: HeartGrid = { ...blockGrid(6, 6, 6, [1, 0, 0]), voxelMm: 2 };
    const f2 = buildFields(g2);
    expect(f2.distance[0 + f2.sx * (3 + f2.sy * 3)]).toBe(Math.round((2 / SDF_MAX_MM) * 255));
  });
});
