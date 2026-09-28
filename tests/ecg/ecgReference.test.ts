import { describe, expect, it } from "vitest";
import { referencePotentials } from "./ecgReference";
import { ELECTRODE_NAMES, type ElectrodeName } from "../../src/ecg/electrodes";
import type { HeartGrid } from "../../src/data/loadHeart";
import type { Vec3 } from "../../src/data/heartFrame";
import { blockGrid, jaggedGrid, mulberry32 } from "../gpu/synthGrid";

// The reference is what the GPU kernel is tested against, so it gets its own checks against numbers worked
// out by hand and against symmetries. Units: gradient in 1/mm, positions in mm, gain 1.

/** All nine electrodes at the same spot except the ones a test names. */
function at(p: Vec3, extra: Partial<Record<ElectrodeName, Vec3>> = {}): Record<ElectrodeName, Vec3> {
  const out = {} as Record<ElectrodeName, Vec3>;
  for (const n of ELECTRODE_NAMES) out[n] = extra[n] ?? p;
  return out;
}

function twoVoxels(fibre: [number, number, number], voxelMm = 1): HeartGrid {
  return { nx: 2, ny: 1, nz: 1, voxelMm, tissue: Uint8Array.of(3, 3), fibre: Int8Array.from([...fibre, ...fibre]) };
}

const D = { dPar: 0.4, dPerp: 0.1 };

describe("referencePotentials, worked by hand on two adjacent voxels", () => {
  // u = [0, 1] along x, fibre along x. Each voxel has a one-sided gradient of 1 per mm, so q = dPar * (1, 0, 0).
  const grid = twoVoxels([127, 0, 0]);
  const u = Float32Array.of(0, 1);

  it("gives -sum(q . r / |r|^3) for an electrode on the depolarised side (the wave runs away: negative)", () => {
    const phi = referencePotentials(grid, u, D, at([5, 0, 0]));
    // voxels at x = 0 and 1: r = 5 and 4  ->  0.4 * (5 / 125 + 4 / 64) = 0.041
    expect(phi.RA).toBeCloseTo(-0.041, 12);
  });

  it("gives the exact opposite for an electrode on the resting side (the wave runs toward it: positive)", () => {
    const phi = referencePotentials(grid, u, D, at([-4, 0, 0]));
    expect(phi.RA).toBeCloseTo(0.041, 12);
  });

  it("gives zero on the plane that bisects the pair, and treats each electrode separately", () => {
    const phi = referencePotentials(grid, u, D, at([0.5, 10, 0], { LL: [5, 0, 0], V6: [-4, 0, 0] }));
    expect(Math.abs(phi.RA)).toBeLessThan(1e-15);
    expect(phi.LL).toBeCloseTo(-0.041, 12);
    expect(phi.V6).toBeCloseTo(0.041, 12);
  });

  it("scales with the gain", () => {
    expect(referencePotentials(grid, u, D, at([5, 0, 0]), 3).RA).toBeCloseTo(-0.123, 12);
  });

  it("uses the across-fibre coefficient when the gradient is perpendicular to the fibre", () => {
    const across = referencePotentials(twoVoxels([0, 127, 0]), u, D, at([5, 0, 0]));
    expect(across.RA).toBeCloseTo(-0.041 * (D.dPerp / D.dPar), 12);
  });

  it("does not change when the same physical setup is meshed twice as coarse (the voxel volume is included)", () => {
    // voxels 2 mm apart, so gradients are 0.5 per mm; electrode moved to the same physical spot scaled by 2
    const coarse = referencePotentials(twoVoxels([127, 0, 0], 2), u, D, at([10, 0, 0]));
    expect(coarse.RA).toBeCloseTo(-0.041, 12);
  });
});

describe("referencePotentials, symmetries and limits", () => {
  it("matches the far-field dipole of a uniform gradient block", () => {
    // 10 x 10 x 10 voxels, u rising by 0.1 per mm along x, fibre along x: every voxel has q = dPar * 0.1 along x,
    // so a far electrode sees N q_x R / R^3.
    const n = 10;
    const g = blockGrid(n, n, n, [1, 0, 0]);
    const u = new Float32Array(n * n * n);
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) u[x + n * (y + n * z)] = 0.1 * x;
    const R = 300;
    const centre = (n - 1) / 2;
    const phi = referencePotentials(g, u, D, at([centre + R, centre, centre]));
    const farField = -(n ** 3) * D.dPar * 0.1 * (1 / R ** 2);
    expect(Math.abs(phi.RA / farField - 1)).toBeLessThan(1e-3);
    // and the opposite side gives the opposite sign
    const behind = referencePotentials(g, u, D, at([centre - R, centre, centre]));
    expect(behind.RA / farField).toBeLessThan(-0.99);
  });

  it("gives the same answer along each axis when fibre, ramp and electrode are turned together", () => {
    const n = 8;
    const results: number[] = [];
    for (const axis of [0, 1, 2]) {
      const fibre: [number, number, number] = [0, 0, 0];
      fibre[axis] = 1;
      const g = blockGrid(n, n, n, fibre);
      const u = new Float32Array(n ** 3);
      for (let z = 0; z < n; z++)
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++) u[x + n * (y + n * z)] = 0.2 * [x, y, z][axis];
      const e: Vec3 = [3.5, 3.5, 3.5];
      e[axis] += 60;
      results.push(referencePotentials(g, u, D, at(e)).RA);
    }
    expect(results[0]).toBeLessThan(0);
    expect(results[1]).toBeCloseTo(results[0], 12);
    expect(results[2]).toBeCloseTo(results[0], 12);
  });

  it("is linear in the voltage field", () => {
    const grid = jaggedGrid(16, 3);
    const rnd = mulberry32(5);
    const field = () => Float32Array.from(grid.tissue, (t) => (t > 0 ? rnd() : 0));
    const a = field();
    const b = field();
    // float64 copies: mapping a Float32Array would round every value to float32 and hide the linearity
    const sum = Float64Array.from(a, (x, i) => x + b[i]);
    const scaled = Float64Array.from(a, (x) => 2.5 * x);
    const pos = at([70, -20, 30], { LA: [-50, 60, 10], LL: [10, 10, 90] });
    const pa = referencePotentials(grid, a, D, pos);
    const pb = referencePotentials(grid, b, D, pos);
    const ps = referencePotentials(grid, sum, D, pos);
    const pk = referencePotentials(grid, scaled, D, pos);
    for (const n of ELECTRODE_NAMES) {
      expect(ps[n]).toBeCloseTo(pa[n] + pb[n], 10);
      expect(pk[n]).toBeCloseTo(2.5 * pa[n], 10);
    }
  });

  it("is exactly zero for a uniform voltage and for an isolated voxel", () => {
    const grid = jaggedGrid(16, 3);
    const flat = Float32Array.from(grid.tissue, (t) => (t > 0 ? 0.7 : 0));
    const p = referencePotentials(grid, flat, D, at([70, -20, 30]));
    for (const n of ELECTRODE_NAMES) expect(p[n]).toBe(0);
    // one muscle voxel with no muscle neighbour has no defined direction of spread: no gradient, no source
    const lone: HeartGrid = { nx: 3, ny: 3, nz: 3, voxelMm: 1, tissue: new Uint8Array(27), fibre: new Int8Array(81) };
    lone.tissue[13] = 3;
    lone.fibre[39] = 127;
    const u = new Float32Array(27);
    u[13] = 5;
    expect(referencePotentials(lone, u, D, at([40, 1, 1])).RA).toBe(0);
  });
});
