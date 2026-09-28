// Geometry helpers for the real heart grid (test use only).
//
// WARNING: `apex` and `base` here are only the two ends of the long axis, and which end is which is a GUESS
// (the end with less muscle in its slab). On the shipped heart that guess picks the WRONG end: the true apex is
// voxel (119, 19, 23), read from public/data/heart-frame.json, which is built from the source labels. Use
// tests/gpu/frame.ts for anything that must be anatomically correct.
import type { HeartGrid } from "../../src/data/loadHeart";

export interface HeartShape {
  centroid: [number, number, number];
  axis: [number, number, number]; // unit long axis (direction is a guess, see the warning above)
  apex: [number, number, number]; // one end of the long axis (may really be the base)
  base: [number, number, number]; // the other end
  lengthMm: number;
}

export function heartShape(g: HeartGrid): HeartShape {
  const pts: [number, number, number][] = [];
  for (let z = 0; z < g.nz; z++)
    for (let y = 0; y < g.ny; y++)
      for (let x = 0; x < g.nx; x++) if (g.tissue[x + g.nx * (y + g.ny * z)] > 0) pts.push([x, y, z]);
  const c: [number, number, number] = [0, 0, 0];
  for (const p of pts) for (let i = 0; i < 3; i++) c[i] += p[i] / pts.length;
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of pts) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a][b] += ((p[a] - c[a]) * (p[b] - c[b])) / pts.length;
  let v: [number, number, number] = [1, 0.3, 0.2];
  for (let it = 0; it < 200; it++) {
    const w: [number, number, number] = [0, 0, 0];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) w[a] += cov[a][b] * v[b];
    const l = Math.hypot(...w);
    v = [w[0] / l, w[1] / l, w[2] / l];
  }
  const proj = pts.map((p) => (p[0] - c[0]) * v[0] + (p[1] - c[1]) * v[1] + (p[2] - c[2]) * v[2]);
  let lo = Infinity, hi = -Infinity;
  for (const t of proj) {
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const slab = (hi - lo) * 0.15;
  const nLow = proj.filter((t) => t < lo + slab).length;
  const nHigh = proj.filter((t) => t > hi - slab).length;
  const apexIsHigh = nHigh < nLow;
  const axis: [number, number, number] = apexIsHigh ? v : [-v[0], -v[1], -v[2]];
  const p2 = proj.map((t) => (apexIsHigh ? t : -t));
  let iApex = 0, iBase = 0;
  p2.forEach((t, i) => {
    if (t > p2[iApex]) iApex = i;
    if (t < p2[iBase]) iBase = i;
  });
  return { centroid: c, axis, apex: pts[iApex], base: pts[iBase], lengthMm: (hi - lo) * g.voxelMm };
}
