import type { HeartAnatomy, HeartSurface } from "../data/loadHeart";

// Where the ventricles meet the rest of the heart. The two meshes share their seam's vertices exactly (same positions,
// same normals), so anything that moves or thickens a surface must treat those vertices the same on both sides or the
// seam opens. This finds them by position, measures every vertex's distance from the seam along its own mesh, and
// notes which atrium, if any, meets the ventricles nearest each ventricle vertex.

export interface Seam {
  /** Per ventricle vertex, two numbers: 1 where the nearest seam is with the left atrium, and with the right. */
  sides: Float32Array;
  /** Distance along each mesh from the seam, mm (exactly 0 on it). */
  ventFromSeam: Float32Array;
  extraFromSeam: Float32Array;
  /**
   * Straight-line distance of each vertex of the rest of the heart from the nearest seam vertex, mm. How far a point
   * follows the ventricles' beat goes by this, so the inner and outer walls of a vessel move together.
   */
  extraNearSeam: Float32Array;
}

const key = (p: Float32Array, i: number) => `${Math.round(p[3 * i] * 100)},${Math.round(p[3 * i + 1] * 100)},${Math.round(p[3 * i + 2] * 100)}`;

/**
 * Groups of vertices of one mesh at the same place: the rest of the heart repeats a vertex on the border between two of
 * its parts, once per part. Whatever moves or thickens the surface must treat a group as one point.
 */
export function twinGroups(positions: Float32Array): number[][] {
  const at = new Map<string, number[]>();
  for (let i = 0; i < positions.length / 3; i++) {
    const k = key(positions, i);
    const list = at.get(k);
    if (list) list.push(i);
    else at.set(k, [i]);
  }
  return [...at.values()].filter((g) => g.length > 1);
}

/** Make every group of twins share one value: the smallest of theirs. */
export function unifyTwins(values: Float32Array, twins: number[][]): Float32Array {
  for (const g of twins) {
    let m = Infinity;
    for (const i of g) m = Math.min(m, values[i]);
    for (const i of g) values[i] = m;
  }
  return values;
}

/** Distances along a mesh's edges from a set of source vertices, nearest first, carrying each source's label. */
function spread(positions: Float32Array, indices: Uint32Array, sources: Map<number, number>, twins: number[][] = []): { dist: Float32Array; label: Int8Array } {
  const V = positions.length / 3;
  // (double precision: a distance rounded on the way into a Float32Array can look shorter than itself next time round)
  const dist = new Float64Array(V).fill(Infinity);
  const label = new Int8Array(V);
  const neighbours: number[][] = Array.from({ length: V }, () => []);
  for (let k = 0; k < indices.length; k += 3)
    for (let e = 0; e < 3; e++) {
      const a = indices[k + e], b = indices[k + ((e + 1) % 3)];
      neighbours[a].push(b);
      neighbours[b].push(a);
    }
  // twins are the same point: joined at no distance
  for (const g of twins) for (const a of g) for (const b of g) if (a !== b) neighbours[a].push(b);
  // a binary heap of (distance, vertex)
  const heap: [number, number][] = [];
  const push = (d: number, v: number) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const [v, l] of sources) {
    dist[v] = 0;
    label[v] = l;
    push(0, v);
  }
  const P = positions;
  while (heap.length > 0) {
    const [d, v] = pop();
    if (d > dist[v]) continue;
    for (const w of neighbours[v]) {
      const nd = d + Math.hypot(P[3 * w] - P[3 * v], P[3 * w + 1] - P[3 * v + 1], P[3 * w + 2] - P[3 * v + 2]);
      if (nd < dist[w]) {
        dist[w] = nd;
        label[w] = label[v];
        push(nd, w);
      }
    }
  }
  return { dist: Float32Array.from(dist), label };
}

export function findSeam(surface: HeartSurface, anatomy: HeartAnatomy): Seam {
  const x = anatomy.extra;
  // the part of the rest of the heart at each seam position (an atrium wins over a vessel where both touch it)
  const partAt = new Map<string, number>();
  for (let i = 0; i < x.part.length; i++) {
    const k = key(x.positions, i);
    const had = partAt.get(k);
    if (had === undefined || (x.part[i] <= 2 && had > 2)) partAt.set(k, x.part[i]);
  }
  const V = surface.positions.length / 3;
  const ventSources = new Map<number, number>();
  const onSeam = new Set<string>();
  for (let v = 0; v < V; v++) {
    const k = key(surface.positions, v);
    const part = partAt.get(k);
    if (part === undefined) continue;
    ventSources.set(v, part === 1 ? 1 : part === 2 ? 2 : 0);
    onSeam.add(k);
  }
  const extraSources = new Map<number, number>();
  for (let i = 0; i < x.part.length; i++) if (onSeam.has(key(x.positions, i))) extraSources.set(i, 0);
  const vent = spread(surface.positions, surface.indices, ventSources);
  const extra = spread(x.positions, x.indices, extraSources, twinGroups(x.positions));
  const sides = new Float32Array(2 * V);
  for (let v = 0; v < V; v++) {
    sides[2 * v] = vent.label[v] === 1 ? 1 : 0;
    sides[2 * v + 1] = vent.label[v] === 2 ? 1 : 0;
  }
  // a mesh with no seam at all counts as far from it everywhere
  const finite = (d: Float32Array) => d.map((v) => (Number.isFinite(v) ? v : 1000));
  // straight-line distance to the seam's nearest point: the seam is a thousand points or so, so look at them all
  const seamPts = Float32Array.from([...ventSources.keys()].flatMap((v) => [surface.positions[3 * v], surface.positions[3 * v + 1], surface.positions[3 * v + 2]]));
  const near = new Float32Array(x.part.length);
  for (let i = 0; i < near.length; i++) {
    if (extraSources.has(i)) continue;
    const px = x.positions[3 * i], py = x.positions[3 * i + 1], pz = x.positions[3 * i + 2];
    let best = Infinity;
    for (let j = 0; j < seamPts.length; j += 3) {
      const dx = seamPts[j] - px, dy = seamPts[j + 1] - py, dz = seamPts[j + 2] - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    near[i] = Number.isFinite(best) ? Math.sqrt(best) : 1000;
  }
  return { sides, ventFromSeam: finite(vent.dist), extraFromSeam: finite(extra.dist), extraNearSeam: near };
}

/**
 * For the ends of the vessels. The rest of the heart is one closed surface: every vessel stump (the pulmonary veins, the
 * venae cavae, the great arteries) ends in a cap (ANATOMY_PART.cap), the flat cut through its lumen or valve plane. Per
 * vertex, how far along the surface it is from the edge of the nearest cap, mm: on a cap, from its own edge (for the
 * dark blood deeper in its middle), and on the walls, from the cap's edge along the wall (for a band that reads as the
 * thickness of the cut wall). Far from any cap it is large (capped at 60).
 */
export function vesselEnds(anatomy: HeartAnatomy): Float32Array {
  const x = anatomy.extra;
  const P = x.positions;
  const E = x.part.length;
  const CAP = 6;
  const I = x.indices;
  // the parts at each position: a cap's edge is where a cap vertex shares its place with a vertex of another part
  const partsAt = new Map<string, Set<number>>();
  for (let i = 0; i < E; i++) {
    const k = key(P, i);
    const set = partsAt.get(k);
    if (set) set.add(x.part[i]);
    else partsAt.set(k, new Set([x.part[i]]));
  }
  const onEdge = (i: number) => {
    const set = partsAt.get(key(P, i));
    return set !== undefined && set.has(CAP) && set.size > 1;
  };
  const capSources = new Map<number, number>();
  const wallSources = new Map<number, number>();
  for (let i = 0; i < E; i++) {
    if (!onEdge(i)) continue;
    if (x.part[i] === CAP) capSources.set(i, 0);
    else wallSources.set(i, 0);
  }
  const capTris: number[] = [];
  const wallTris: number[] = [];
  for (let t = 0; t < I.length; t += 3) (x.part[I[t]] === CAP ? capTris : wallTris).push(I[t], I[t + 1], I[t + 2]);
  const twins = twinGroups(P);
  const onCap = spread(P, Uint32Array.from(capTris), capSources).dist;
  const onWall = spread(P, Uint32Array.from(wallTris), wallSources, twins).dist;
  const out = new Float32Array(E);
  for (let i = 0; i < E; i++) out[i] = Math.min(60, x.part[i] === CAP ? onCap[i] : onWall[i]);
  return out;
}
