// Where the heart's ordinary beat starts. In a real heart a beat begins at the sinus node in the top of the right atrium,
// runs down the bundle of His and out along the Purkinje fibres, and reaches the inner wall of both ventricles at
// several places within a few milliseconds. The muscle is switched on almost together, so the QRS is short (under 0.12 s).
//
// This model has only the ventricles and no wiring. One nudge at the tip crawls up through the muscle and takes about
// 300 ms, which looks like a paced beat (wide, upside down in lead II). Firing several places on the inner wall
// (endocardium) together stands in for the wiring. The sites are worked out from the heart itself: the source data
// labels every voxel inner wall (1), middle (2) or outer (3), and heart-frame.json gives the two cavities and the axes.
import type { HeartGrid } from "../data/loadHeart";
import type { HeartFrame, Vec3 } from "../data/heartFrame";
import { SWEEP_NEVER } from "../sim/Simulation";

export type Voxel = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/** One place on the inner wall: which ventricle, the way it lies from that ventricle's centre, and how far along the long axis toward the apex (mm, from the centre). */
type Wish = { ventricle: "lv" | "rv"; direction: Vec3; heightMm: number };

/**
 * The inner-wall voxel of a ventricle that lies furthest in `direction` from its centre, at about `heightMm` along the
 * long axis toward the apex. A voxel belongs to the ventricle whose centre it is nearer to.
 */
function innerWallVoxel(grid: HeartGrid, frame: HeartFrame, wish: Wish): Voxel {
  const own = wish.ventricle === "lv" ? frame.lvCentroid : frame.rvCentroid;
  const other = wish.ventricle === "lv" ? frame.rvCentroid : frame.lvCentroid;
  const dir = unit(wish.direction);
  let best: Voxel | null = null;
  let bestScore = -Infinity;
  for (let z = 0; z < grid.nz; z++) {
    for (let y = 0; y < grid.ny; y++) {
      for (let x = 0; x < grid.nx; x++) {
        if (grid.tissue[x + grid.nx * (y + grid.ny * z)] !== 1) continue;
        const p: Vec3 = [x, y, z];
        const fromOwn = sub(p, own);
        const fromOther = sub(p, other);
        if (dot(fromOwn, fromOwn) > dot(fromOther, fromOther)) continue;
        const height = dot(fromOwn, frame.longAxis) * grid.voxelMm;
        const score = dot(fromOwn, dir) * grid.voxelMm - Math.abs(height - wish.heightMm);
        if (score > bestScore) {
          bestScore = score;
          best = [x, y, z];
        }
      }
    }
  }
  if (best === null) throw new Error("no inner-wall voxel found: does the heart file have tissue label 1?");
  return best;
}

/**
 * The places the ordinary beat fires, in the order it fires them. Left ventricle: the septum, the apical septum, the
 * front wall and the side wall. Right ventricle: near the apex, the septum and the free wall. (After Durrer's map of
 * where a human heart is first switched on.)
 */
export function activationSites(grid: HeartGrid, frame: HeartFrame): Voxel[] {
  const towardRv = unit(sub(frame.rvCentroid, frame.lvCentroid));
  const towardLv = scale(towardRv, -1);
  const wishes: Wish[] = [
    { ventricle: "lv", direction: towardRv, heightMm: 0 },
    { ventricle: "lv", direction: frame.longAxis, heightMm: 25 },
    { ventricle: "rv", direction: frame.longAxis, heightMm: 20 },
    { ventricle: "lv", direction: frame.anteriorDir, heightMm: 10 },
    { ventricle: "rv", direction: towardLv, heightMm: 0 },
    { ventricle: "lv", direction: towardLv, heightMm: 0 },
    { ventricle: "rv", direction: scale(towardLv, -1), heightMm: 0 },
  ];
  const seen = new Set<string>();
  const sites: Voxel[] = [];
  for (const wish of wishes) {
    const v = innerWallVoxel(grid, frame, wish);
    const key = v.join(",");
    if (!seen.has(key)) {
      seen.add(key);
      sites.push(v);
    }
  }
  return sites;
}

/** One step of the sweep: fire the inner-wall patch within radiusMm of `centre`, `atMs` after the beat begins. */
export type ActivationStage = { atMs: number; centre: Voxel; radiusMm: number };

export interface SweepOptions {
  /** How many patches the inner surface is cut into. */
  patches?: number;
  /** How fast the beat travels over the inner surface along the conduction fibres, mm per ms (the real fibres are 2 to 4). */
  speedMmPerMs?: number;
  /** Radius of each patch, mm. */
  radiusMm?: number;
}

/**
 * The ordinary beat as a sweep over the inner wall. A real beat enters at the septum and runs out along the conduction
 * fibres, so every part of the inner surface is switched on within about 30 ms, in the order of its distance from the
 * entry point; the wave then crosses the wall from the inside out. Here the inner surface is cut into overlapping patches
 * spread evenly over both ventricles (farthest-point sampling), and each is fired at a time that grows with its distance
 * from the entry point at the middle of the septum. Times are whole multiples of the 2 ms a stimulus lasts.
 */
export function activationSweep(grid: HeartGrid, frame: HeartFrame, opts: SweepOptions = {}): ActivationStage[] {
  const patches = opts.patches ?? 14;
  const speed = opts.speedMmPerMs ?? 3;
  const radiusMm = opts.radiusMm ?? 20;
  const entry = innerWallVoxel(grid, frame, { ventricle: "lv", direction: sub(frame.rvCentroid, frame.lvCentroid), heightMm: 0 });

  const inner: Voxel[] = [];
  for (let z = 0; z < grid.nz; z++) {
    for (let y = 0; y < grid.ny; y++) {
      for (let x = 0; x < grid.nx; x++) if (grid.tissue[x + grid.nx * (y + grid.ny * z)] === 1) inner.push([x, y, z]);
    }
  }
  if (inner.length === 0) throw new Error("no inner-wall voxels: does the heart file have tissue label 1?");

  const distance = (a: Voxel, b: Voxel): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * grid.voxelMm;
  const chosen: Voxel[] = [entry];
  const nearest = new Float64Array(inner.length);
  for (let i = 0; i < inner.length; i++) nearest[i] = distance(inner[i], entry);
  while (chosen.length < patches) {
    let best = 0;
    for (let i = 1; i < inner.length; i++) if (nearest[i] > nearest[best]) best = i;
    chosen.push(inner[best]);
    for (let i = 0; i < inner.length; i++) nearest[i] = Math.min(nearest[i], distance(inner[i], inner[best]));
  }

  const stages = chosen
    .map((centre) => ({ atMs: Math.round(distance(entry, centre) / speed / 2) * 2, centre, radiusMm }))
    .sort((a, b) => a.atMs - b.atMs);
  return stages;
}

export interface SweepTimesOptions {
  /** Speed over the inner surface along the conduction fibres, mm per ms. Real fibres run at 2 to 4. */
  leftSpeedMmPerMs?: number;
  rightSpeedMmPerMs?: number;
  /** The right ventricle starts this long after the left (the right bundle branch is a little behind). */
  rightDelayMs?: number;
  /** A straight line across the cavity is shorter than the way over the inner surface: path = line x this. */
  pathFactor?: number;
}

/**
 * When the ordinary beat reaches each muscle voxel's inner wall, for Simulation.setSweepTimes: a value per muscle voxel
 * (in the simulation's own order: z, then y, then x, skipping empty voxels), SWEEP_NEVER except on the inner wall.
 * The left ventricle's inner surface is switched on from the middle of the septum, outward at the fibres' speed; the
 * right ventricle's from near its apex, a few ms later. Each voxel is fired at the moment the front reaches it, so the
 * beat advances as a smooth sweep, and the wave then crosses the wall from the inside out. With the engine's speeds the
 * sweep takes up to about 100 ms and the QRS comes out about 80 ms wide, upright in lead II, with an upright T wave.
 * (A patch-by-patch version was tried first: however it was tuned, it left needle-thin jagged spikes in the ECG, an
 * artefact of injecting current into whole patches at once. Firing each voxel when the front reaches it is smooth.)
 */
export function activationTimes(grid: HeartGrid, frame: HeartFrame, opts: SweepTimesOptions = {}): Float32Array {
  const vLeft = opts.leftSpeedMmPerMs ?? 3;
  const vRight = opts.rightSpeedMmPerMs ?? 3;
  const rightDelay = opts.rightDelayMs ?? 6;
  const pathFactor = opts.pathFactor ?? 1.3;
  const lvEntry = innerWallVoxel(grid, frame, { ventricle: "lv", direction: sub(frame.rvCentroid, frame.lvCentroid), heightMm: 0 });
  const rvEntry = innerWallVoxel(grid, frame, { ventricle: "rv", direction: frame.longAxis, heightMm: 20 });

  const times: number[] = [];
  for (let z = 0; z < grid.nz; z++) {
    for (let y = 0; y < grid.ny; y++) {
      for (let x = 0; x < grid.nx; x++) {
        const tissue = grid.tissue[x + grid.nx * (y + grid.ny * z)];
        if (tissue === 0) continue;
        if (tissue !== 1) {
          times.push(SWEEP_NEVER);
          continue;
        }
        const p: Vec3 = [x, y, z];
        const fromLv = sub(p, frame.lvCentroid);
        const fromRv = sub(p, frame.rvCentroid);
        const isLeft = dot(fromLv, fromLv) <= dot(fromRv, fromRv);
        const entry = isLeft ? lvEntry : rvEntry;
        const d = Math.hypot(p[0] - entry[0], p[1] - entry[1], p[2] - entry[2]) * grid.voxelMm * pathFactor;
        times.push(isLeft ? d / vLeft : rightDelay + d / vRight);
      }
    }
  }
  return Float32Array.from(times);
}
