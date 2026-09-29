import type { HeartSurface } from "../data/loadHeart";
import type { Vec3 } from "./camera";

// The coronary arteries and cardiac veins on the ventricles, as real tubes. Each vessel follows a level line over the
// surface of one of two per-vertex fields: g, the signed distance to the interventricular grooves (negative on the left
// ventricle), and b, the distance from the base. The vessels in the grooves follow g near zero; the ones in the
// atrioventricular groove follow b near zero under an atrium; the branches leave a groove and wander down the walls.
// The paths are found by marching triangles, smoothed, kept on the surface, and swept into tubes that taper toward
// their ends and sit partly sunk into the surface (deeper in the fatty grooves). The tubes are drawn by the heart
// pass and move with the muscle under them.

/** What the tube builder needs to know about the surface: the fields, and which side of the heart each vertex is on. */
export interface VesselFields {
  /** The surface the vessels lie on (the ventricles thickened by their fat). */
  surface: HeartSurface;
  /** The fat's thickness per vertex, mm (the tubes sink back with it while the heart is cut open). */
  fat: Float32Array;
  /** Signed distance to the interventricular grooves, mm (negative on the left ventricle). */
  groove: Float32Array;
  /** Distance from the base, mm. */
  base: Float32Array;
  /** Per vertex, two numbers: 1 where the nearest seam is with the left atrium, and with the right. */
  seam: Float32Array;
  /** The heart's centroid and anterior direction, to tell the front of the heart from the back. */
  centroid: Vec3;
  anterior: Vec3;
}

/**
 * The tubes: 3 floats per vertex for positions, normals, the surface normal under the tube and the surface point under
 * the middle of its ring (every vertex of a ring moves with the muscle there), 4 for (kind, base, radius, fat under it).
 */
export interface VesselMesh {
  positions: Float32Array;
  normals: Float32Array;
  anchors: Float32Array;
  under: Float32Array;
  attrs: Float32Array;
  indices: Uint32Array;
}

type Region = "front" | "back" | "leftAtrium" | "rightAtrium" | "any";

interface Spec {
  vein: boolean;
  /** Which field the path is a level line of, and the level as a function of the other field. */
  follows: "g" | "b";
  level: (other: number) => number;
  /** Where along the other field the path runs. */
  from: number;
  to: number;
  region: Region;
  /** Radius at the start and at the end, mm. */
  r0: number;
  r1: number;
  /** How far the tube's centre sits below the surface, as a share of its radius (0 on the surface). */
  sink: number;
  /** It rises out of the fat at its start (rather than leaving another vessel there). */
  emerges?: boolean;
}

// ---- smooth 1D noise for the vessels' wandering --------------------------------------------------------------------

function hash1(n: number, seed: number): number {
  const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i, seed) * (1 - u) + hash1(i + 1, seed) * u;
}

/** A smooth offset of a few mm along a coordinate, so no vessel is ruler-straight. */
function meander(s: number, seed: number, amp: number): number {
  return (noise1(s * 0.04, seed) - 0.5) * 2 * amp + (noise1(s * 0.11, seed + 3.1) - 0.5) * amp * 0.4;
}

// ---- the vessels of this heart -------------------------------------------------------------------------------------

const SPECS: Spec[] = [
  // anterior interventricular groove: the left anterior descending artery and the great cardiac vein beside it
  { vein: false, follows: "g", level: (b) => -0.6 + meander(b, 1.3, 1.0), from: 9, to: 106, region: "front", r0: 1.9, r1: 0.55, sink: 0.75, emerges: true },
  { vein: true, follows: "g", level: (b) => -4.6 + meander(b, 4.7, 1.3), from: 7, to: 84, region: "front", r0: 2.1, r1: 0.7, sink: 0.7, emerges: true },
  // its diagonal branches, leaving it for the left ventricle and heading down toward the apex
  { vein: false, follows: "g", level: (b) => -0.6 - 0.62 * (b - 18) + meander(b, 11, 2.2), from: 18, to: 74, region: "front", r0: 1.25, r1: 0.35, sink: 0.1 },
  { vein: false, follows: "g", level: (b) => -0.6 - 0.8 * (b - 44) + meander(b, 12, 2.0), from: 44, to: 88, region: "front", r0: 1.0, r1: 0.3, sink: 0.1 },
  // posterior interventricular groove: the posterior descending artery and the middle cardiac vein
  { vein: false, follows: "g", level: (b) => 0.8 + meander(b, 21, 0.9), from: 8, to: 92, region: "back", r0: 1.45, r1: 0.45, sink: 0.75, emerges: true },
  { vein: true, follows: "g", level: (b) => -3.4 + meander(b, 23, 1.2), from: 6, to: 80, region: "back", r0: 1.9, r1: 0.6, sink: 0.7, emerges: true },
  // atrioventricular grooves: the right coronary artery and the small cardiac vein under the right atrium, the
  // circumflex artery and the coronary sinus under the left
  { vein: false, follows: "b", level: (g) => 4.8 + meander(g, 31, 0.8), from: -200, to: 200, region: "rightAtrium", r0: 1.8, r1: 1.5, sink: 0.7 },
  { vein: true, follows: "b", level: (g) => 8.6 + meander(g, 33, 1.0), from: -200, to: 200, region: "rightAtrium", r0: 0.9, r1: 0.8, sink: 0.35 },
  { vein: false, follows: "b", level: (g) => 4.2 + meander(g, 35, 0.7), from: -200, to: 200, region: "leftAtrium", r0: 1.4, r1: 1.2, sink: 0.7 },
  { vein: true, follows: "b", level: (g) => 7.6 + meander(g, 37, 0.9), from: -200, to: 200, region: "leftAtrium", r0: 2.2, r1: 2.0, sink: 0.6 },
  // obtuse marginals down the left ventricle's side wall, the acute marginal along the right ventricle's lower edge,
  // and an anterior cardiac vein over the right ventricle
  { vein: false, follows: "g", level: (b) => -38 + 0.16 * (b - 4) + meander(b, 41, 4.5), from: 4, to: 70, region: "any", r0: 1.3, r1: 0.35, sink: 0.05 },
  { vein: false, follows: "g", level: (b) => -57 + 0.21 * (b - 10) + meander(b, 48, 4.0), from: 10, to: 60, region: "any", r0: 1.05, r1: 0.3, sink: 0.05 },
  { vein: false, follows: "g", level: (b) => 44 - 0.12 * (b - 5) + meander(b, 51, 4.0), from: 5, to: 67, region: "any", r0: 1.2, r1: 0.35, sink: 0.05 },
  { vein: true, follows: "g", level: (b) => 24 + 0.08 * (b - 3) + meander(b, 61, 3.5), from: 3, to: 46, region: "front", r0: 1.0, r1: 0.35, sink: 0.05 },
];

/** Which vertices may carry a vessel of a region. */
function inRegion(f: VesselFields, v: number, region: Region): boolean {
  const P = f.surface.positions;
  if (region === "any") return true;
  if (region === "leftAtrium") return f.seam[2 * v] > 0.5;
  if (region === "rightAtrium") return f.seam[2 * v + 1] > 0.5;
  const d = (P[3 * v] - f.centroid[0]) * f.anterior[0] + (P[3 * v + 1] - f.centroid[1]) * f.anterior[1] + (P[3 * v + 2] - f.centroid[2]) * f.anterior[2];
  return region === "front" ? d > -4 : d < 4;
}

interface Crossing {
  p: Vec3;
  n: Vec3;
  /** The other field's value there (b for a g-path, g for a b-path), and the base distance. */
  along: number;
  base: number;
  fat: number;
}

/** The level line of a spec as polylines of surface points, longest first. */
function trace(f: VesselFields, spec: Spec): Crossing[][] {
  const { positions: P, normals: N, indices: I } = f.surface;
  const V = P.length / 3;
  const main = spec.follows === "g" ? f.groove : f.base;
  const other = spec.follows === "g" ? f.base : f.groove;
  const h = new Float32Array(V);
  const ok = new Uint8Array(V);
  for (let v = 0; v < V; v++) {
    h[v] = main[v] - spec.level(other[v]);
    ok[v] = other[v] >= spec.from - 3 && other[v] <= spec.to + 3 && inRegion(f, v, spec.region) ? 1 : 0;
  }
  const points = new Map<number, Crossing>();
  const links = new Map<number, number[]>();
  const crossing = (a: number, b: number): number => {
    const key = a < b ? a * V + b : b * V + a;
    if (!points.has(key)) {
      const t = h[a] / (h[a] - h[b]);
      const lerp = (arr: Float32Array, k: number) => arr[3 * a + k] + (arr[3 * b + k] - arr[3 * a + k]) * t;
      const n: Vec3 = [lerp(N, 0), lerp(N, 1), lerp(N, 2)];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      points.set(key, {
        p: [lerp(P, 0), lerp(P, 1), lerp(P, 2)],
        n: [n[0] / l, n[1] / l, n[2] / l],
        along: other[a] + (other[b] - other[a]) * t,
        base: f.base[a] + (f.base[b] - f.base[a]) * t,
        fat: f.fat[a] + (f.fat[b] - f.fat[a]) * t,
      });
    }
    return key;
  };
  const link = (x: number, y: number) => {
    if (!links.has(x)) links.set(x, []);
    if (!links.has(y)) links.set(y, []);
    links.get(x)!.push(y);
    links.get(y)!.push(x);
  };
  for (let k = 0; k < I.length; k += 3) {
    const tri = [I[k], I[k + 1], I[k + 2]];
    if (!ok[tri[0]] || !ok[tri[1]] || !ok[tri[2]]) continue;
    const ends: number[] = [];
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3];
      if (h[a] < 0 !== h[b] < 0) ends.push(crossing(a, b));
    }
    if (ends.length === 2) link(ends[0], ends[1]);
  }
  // walk the chains
  const seen = new Set<number>();
  const chains: Crossing[][] = [];
  const walk = (start: number) => {
    const keys = [start];
    seen.add(start);
    let at = start;
    for (;;) {
      const next = (links.get(at) ?? []).find((x) => !seen.has(x));
      if (next === undefined) break;
      seen.add(next);
      keys.push(next);
      at = next;
    }
    return keys;
  };
  // ends first, so open chains are walked from one end to the other
  const order = [...links.keys()].sort((x, y) => (links.get(x)!.length === 1 ? 0 : 1) - (links.get(y)!.length === 1 ? 0 : 1));
  for (const key of order) {
    if (seen.has(key)) continue;
    const keys = walk(key);
    const chain = keys.map((x) => points.get(x)!).filter((c) => c.along >= spec.from && c.along <= spec.to);
    if (chain.length > 4) chains.push(chain);
  }
  const length = (c: Crossing[]) => c.reduce((s, x, i) => (i ? s + Math.hypot(x.p[0] - c[i - 1].p[0], x.p[1] - c[i - 1].p[1], x.p[2] - c[i - 1].p[2]) : 0), 0);
  return chains.sort((a, b) => length(b) - length(a));
}

/** Resample a chain every `step` mm and smooth it, keeping its normals. */
function resample(chain: Crossing[], step: number): Crossing[] {
  const out: Crossing[] = [chain[0]];
  let carry = 0;
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1], b = chain[i];
    const d = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]);
    let t = step - carry;
    while (t <= d) {
      const u = t / d;
      const mix = (x: number, y: number) => x + (y - x) * u;
      const n: Vec3 = [mix(a.n[0], b.n[0]), mix(a.n[1], b.n[1]), mix(a.n[2], b.n[2])];
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      out.push({ p: [mix(a.p[0], b.p[0]), mix(a.p[1], b.p[1]), mix(a.p[2], b.p[2])], n: [n[0] / l, n[1] / l, n[2] / l], along: mix(a.along, b.along), base: mix(a.base, b.base), fat: mix(a.fat, b.fat) });
      t += step;
    }
    carry = d - (t - step);
  }
  // relax the kinks the triangles left, moving each point only along the surface
  for (let it = 0; it < 4; it++) {
    const next = out.map((c) => ({ ...c, p: [...c.p] as Vec3 }));
    for (let i = 1; i < out.length - 1; i++) {
      const m: Vec3 = [0, 1, 2].map((k) => 0.25 * out[i - 1].p[k] + 0.5 * out[i].p[k] + 0.25 * out[i + 1].p[k]) as Vec3;
      const n = out[i].n;
      const off = (m[0] - out[i].p[0]) * n[0] + (m[1] - out[i].p[1]) * n[1] + (m[2] - out[i].p[2]) * n[2];
      next[i].p = [m[0] - n[0] * off, m[1] - n[1] * off, m[2] - n[2] * off];
    }
    for (let i = 0; i < out.length; i++) out[i] = next[i];
  }
  return out;
}

const SIDES = 10;

/** The pieces of each vessel's path worth drawing: the longest, and any other long ones (a line can be broken by the mesh). */
function pathsOf(f: VesselFields, spec: Spec): Crossing[][] {
  const out: Crossing[][] = [];
  for (const [ci, raw] of trace(f, spec).entries()) {
    if (ci > 0 && raw.length < 25) break;
    const pts = resample(raw, 0.8);
    if (pts.length >= 6) out.push(pts);
  }
  return out;
}

/**
 * A thin sheath of fat along the branches that run over the bare walls (the ones in the grooves are in fat already):
 * a thickness per vertex, mm, to add to the layer of fat.
 */
export function sheathFat(f: VesselFields, fromSeam: Float32Array): Float32Array {
  const P = f.surface.positions;
  const V = P.length / 3;
  const out = new Float32Array(V);
  const cell = 4;
  const cellId = (cx: number, cy: number, cz: number) => ((cx + 512) * 1024 + (cy + 512)) * 1024 + (cz + 512);
  const key = (x: number, y: number, z: number) => cellId(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
  const grid = new Map<number, { p: Vec3; r: number }[]>();
  for (const spec of SPECS) {
    if (spec.sink > 0.3) continue;
    for (const pts of pathsOf(f, spec)) {
      pts.forEach((c, i) => {
        const r = spec.r0 + (spec.r1 - spec.r0) * (i / (pts.length - 1));
        const k = key(c.p[0], c.p[1], c.p[2]);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k)!.push({ p: c.p, r });
      });
    }
  }
  for (let v = 0; v < V; v++) {
    const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = 0;
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++)
        for (let c = -1; c <= 1; c++) {
          for (const q of grid.get(cellId(cx + a, cy + b, cz + c)) ?? []) {
            const d = Math.hypot(q.p[0] - x, q.p[1] - y, q.p[2] - z);
            const t = Math.min(1, Math.max(0, (d - q.r * 0.9) / (q.r * 0.9 + 0.8)));
            best = Math.max(best, (1 - t * t * (3 - 2 * t)) * (0.40 + 0.22 * q.r));
          }
        }
    // nothing on the seam itself, where the rest of the heart carries the fat
    const s = Math.min(1, Math.max(0, fromSeam[v] / 3));
    out[v] = best * s * s * (3 - 2 * s);
  }
  return out;
}

/** All the vessels of the heart as one mesh of tubes. */
export function buildVessels(f: VesselFields): VesselMesh {
  const pos: number[] = [], nrm: number[] = [], anc: number[] = [], und: number[] = [], att: number[] = [], idx: number[] = [];
  for (const spec of SPECS) {
    for (const pts of pathsOf(f, spec)) {
      const span = Math.abs(spec.to - spec.from) || 1;
      const lengthMm = (pts.length - 1) * 0.8;
      const first = pos.length / 3;
      for (let i = 0; i < pts.length; i++) {
        const c = pts[i];
        const prev = pts[Math.max(0, i - 1)].p, next = pts[Math.min(pts.length - 1, i + 1)].p;
        let t: Vec3 = [next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]];
        const n = c.n;
        const along = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
        t = [t[0] - n[0] * along, t[1] - n[1] * along, t[2] - n[2] * along];
        const tl = Math.hypot(t[0], t[1], t[2]) || 1;
        t = [t[0] / tl, t[1] / tl, t[2] / tl];
        const s: Vec3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
        // radius: from r0 to r1 along the other field (a groove vessel thins toward the apex), rounded off at both ends
        const frac = spec.follows === "g" ? Math.min(1, Math.max(0, (c.along - spec.from) / span)) : i / (pts.length - 1);
        let r = spec.r0 + (spec.r1 - spec.r0) * frac;
        const fromStart = i * 0.8, fromEnd = lengthMm - i * 0.8;
        const endTaper = (d: number, len: number) => (d >= len ? 1 : Math.sqrt(Math.max(0, 1 - ((len - d) / len) ** 2)));
        r *= Math.min(endTaper(fromEnd, Math.max(1.5, r * 2.5)), spec.follows === "b" || spec.emerges ? endTaper(fromStart, Math.max(3, r * 3.5)) : 1);
        const lift = r * (0.25 - spec.sink);
        for (let k = 0; k < SIDES; k++) {
          const a = (2 * Math.PI * k) / SIDES;
          const ca = Math.cos(a), sa = Math.sin(a);
          const dir: Vec3 = [n[0] * ca + s[0] * sa, n[1] * ca + s[1] * sa, n[2] * ca + s[2] * sa];
          pos.push(c.p[0] + n[0] * lift + dir[0] * r, c.p[1] + n[1] * lift + dir[1] * r, c.p[2] + n[2] * lift + dir[2] * r);
          nrm.push(dir[0], dir[1], dir[2]);
          anc.push(n[0], n[1], n[2]);
          und.push(c.p[0], c.p[1], c.p[2]);
          att.push(spec.vein ? 1 : 0, c.base, r, c.fat);
        }
      }
      for (let i = 0; i + 1 < pts.length; i++)
        for (let k = 0; k < SIDES; k++) {
          const a = first + i * SIDES + k, b = first + i * SIDES + ((k + 1) % SIDES);
          const c = a + SIDES, d = b + SIDES;
          // counterclockwise seen from outside the tube
          idx.push(a, c, b, b, c, d);
        }
    }
  }
  return {
    positions: Float32Array.from(pos),
    normals: Float32Array.from(nrm),
    anchors: Float32Array.from(anc),
    under: Float32Array.from(und),
    attrs: Float32Array.from(att),
    indices: Uint32Array.from(idx),
  };
}
