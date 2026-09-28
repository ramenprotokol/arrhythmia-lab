// Synthetic heart grids for tests: same shape as the real HeartGrid, built in code.
import type { HeartGrid } from "../../src/data/loadHeart";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const q = (f: number): number => Math.max(-127, Math.min(127, Math.round(f * 127)));

function setFibre(g: HeartGrid, i: number, f: [number, number, number]): void {
  const l = Math.hypot(f[0], f[1], f[2]) || 1;
  g.fibre[3 * i] = q(f[0] / l);
  g.fibre[3 * i + 1] = q(f[1] / l);
  g.fibre[3 * i + 2] = q(f[2] / l);
}

function empty(nx: number, ny: number, nz: number, voxelMm = 1): HeartGrid {
  const n = nx * ny * nz;
  return { nx, ny, nz, voxelMm, tissue: new Uint8Array(n), fibre: new Int8Array(3 * n) };
}

/** A solid block of muscle, every voxel with the same fibre direction. */
export function blockGrid(nx: number, ny: number, nz: number, fibre: [number, number, number], tissue = 3): HeartGrid {
  const g = empty(nx, ny, nz);
  for (let i = 0; i < nx * ny * nz; i++) {
    g.tissue[i] = tissue;
    setFibre(g, i, fibre);
  }
  return g;
}

/**
 * A rough, concave blob with holes and single-voxel pits, oblique fibres that turn smoothly and
 * a mix of all three wall layers. It is deliberately nasty for the tissue edge.
 */
export function jaggedGrid(n: number, seed: number): HeartGrid {
  const rnd = mulberry32(seed);
  const g = empty(n, n, n);
  const balls = Array.from({ length: 4 }, () => ({
    c: [n * (0.3 + 0.4 * rnd()), n * (0.3 + 0.4 * rnd()), n * (0.3 + 0.4 * rnd())],
    r: n * (0.22 + 0.12 * rnd()),
  }));
  const holes = Array.from({ length: 3 }, () => ({
    c: [n * (0.25 + 0.5 * rnd()), n * (0.25 + 0.5 * rnd()), n * (0.25 + 0.5 * rnd())],
    r: n * (0.08 + 0.07 * rnd()),
  }));
  const inBall = (b: { c: number[]; r: number }, x: number, y: number, z: number) =>
    Math.hypot(x - b.c[0], y - b.c[1], z - b.c[2]) <= b.r;
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = x + n * (y + n * z);
        const solid = balls.some((b) => inBall(b, x, y, z)) && !holes.some((h) => inBall(h, x, y, z));
        if (!solid || rnd() < 0.03) continue; // 3% random pits make the edge rough
        g.tissue[i] = 1 + ((x * 3 + y * 5 + z * 7) % 3);
        const a = 0.2 * x + 0.13 * y;
        const b = 0.17 * z + 0.11 * x;
        setFibre(g, i, [Math.cos(a) * Math.cos(b) + 0.2 * (rnd() - 0.5), Math.sin(a) * Math.cos(b) + 0.2 * (rnd() - 0.5), Math.sin(b) + 0.2 * (rnd() - 0.5)]);
      }
  return g;
}

export function muscleCount(g: HeartGrid): number {
  let c = 0;
  for (const t of g.tissue) if (t > 0) c++;
  return c;
}
