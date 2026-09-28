import type { HeartGrid } from "../data/loadHeart";
import type { Vec3 } from "./camera";

/**
 * First muscle voxel along a ray, by a 3D digital differential analyser (Amanatides and Woo), and how far
 * along the ray the ray enters it.
 *
 * origin and dir are in millimetres in the grid frame (origin at the grid's minimum corner). Voxel
 * (x, y, z) covers [x, x + 1) * voxelMm on each axis, a half-open box. dir need not be a unit vector, and
 * distance and maxMm are measured as multiples of dir (millimetres for a unit direction). A ray that starts
 * inside muscle returns the voxel it starts in, at distance 0. Null when the ray does not enter muscle within
 * maxMm.
 */
export function castRay(
  grid: HeartGrid,
  origin: Vec3,
  dir: Vec3,
  voxelMm: number,
  maxMm = Infinity,
): { voxel: [number, number, number]; distance: number } | null {
  const n = [grid.nx, grid.ny, grid.nz];
  const o = [origin[0] / voxelMm, origin[1] / voxelMm, origin[2] / voxelMm];

  // Clip the ray to the grid box (slab method) so the walk starts on the grid.
  let tEnter = 0;
  let tExit = maxMm / voxelMm;
  for (let a = 0; a < 3; a++) {
    if (dir[a] === 0) {
      if (o[a] < 0 || o[a] >= n[a]) return null;
      continue;
    }
    const inv = 1 / dir[a];
    const ta = (0 - o[a]) * inv;
    const tb = (n[a] - o[a]) * inv;
    tEnter = Math.max(tEnter, Math.min(ta, tb));
    tExit = Math.min(tExit, Math.max(ta, tb));
    if (tEnter > tExit) return null;
  }

  const cell = [0, 0, 0];
  const step = [0, 0, 0];
  const tDelta = [Infinity, Infinity, Infinity];
  const tMax = [Infinity, Infinity, Infinity];
  for (let a = 0; a < 3; a++) {
    cell[a] = Math.min(n[a] - 1, Math.max(0, Math.floor(o[a] + dir[a] * tEnter)));
    if (dir[a] === 0) continue;
    step[a] = dir[a] > 0 ? 1 : -1;
    tDelta[a] = Math.abs(1 / dir[a]);
    tMax[a] = (cell[a] + (dir[a] > 0 ? 1 : 0) - o[a]) / dir[a];
  }

  let tEntry = tEnter; // where the ray came into the cell it is now in
  for (;;) {
    if (grid.tissue[cell[0] + grid.nx * (cell[1] + grid.ny * cell[2])] > 0) return { voxel: [cell[0], cell[1], cell[2]], distance: tEntry * voxelMm };
    // step across the nearest voxel face
    const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : tMax[1] < tMax[2] ? 1 : 2;
    if (tMax[a] > tExit) return null;
    tEntry = tMax[a];
    cell[a] += step[a];
    if (cell[a] < 0 || cell[a] >= n[a]) return null;
    tMax[a] += tDelta[a];
  }
}

/** First muscle voxel along a ray (see castRay), or null. */
export function pickVoxel(grid: HeartGrid, origin: Vec3, dir: Vec3, voxelMm: number, maxMm = Infinity): [number, number, number] | null {
  return castRay(grid, origin, dir, voxelMm, maxMm)?.voxel ?? null;
}
