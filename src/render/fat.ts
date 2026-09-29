import type { HeartAnatomy, HeartSurface } from "../data/loadHeart";
import type { Vec3 } from "./camera";

// Epicardial fat, as a real layer: a thickness per vertex, in mm, that the vertex shaders push the surface out by.
// It fills the atrioventricular groove (thickest under the atria), runs down the interventricular grooves narrowing
// toward the apex, and wraps the roots of the great vessels. The layer is lumpy, and its edge wanders. At the seam
// between the ventricles and the rest of the heart both meshes carry the same thickness along the same normals, so
// the seam cannot open. Also the normals of the thickened surfaces, for shading.

/** Fat along the seam itself, mm: both meshes carry this much there. */
export const SEAM_FAT_MM = 0.9;

function hash13(x: number, y: number, z: number): number {
  let qx = (x * 0.1031) % 1, qy = (y * 0.1031) % 1, qz = (z * 0.1031) % 1;
  if (qx < 0) qx += 1;
  if (qy < 0) qy += 1;
  if (qz < 0) qz += 1;
  const d = qx * (qz + 31.32) + qy * (qy + 31.32) + qz * (qx + 31.32);
  qx += d;
  qy += d;
  qz += d;
  const r = (qx + qy) * qz;
  return r - Math.floor(r);
}

/** Smooth value noise in 3D, 0..1. */
export function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const n = (a: number, b: number, c: number) => hash13(ix + a, iy + b, iz + c);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(n(0, 0, 0), n(1, 0, 0), ux), lerp(n(0, 1, 0), n(1, 1, 0), ux), uy),
    lerp(lerp(n(0, 0, 1), n(1, 0, 1), ux), lerp(n(0, 1, 1), n(1, 1, 1), ux), uy),
    uz,
  );
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The fat's thickness over the ventricles, mm, per vertex. g and b are the smoothed groove and base distances, seam
 * the two atrium weights per vertex, front 0..1 how far toward the front of the heart the vertex is.
 */
export function ventricleFat(surface: HeartSurface, g: Float32Array, b: Float32Array, seam: Float32Array, front: Float32Array, fromSeam: Float32Array): Float32Array {
  const P = surface.positions;
  const V = P.length / 3;
  const out = new Float32Array(V);
  for (let v = 0; v < V; v++) {
    const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
    const wobble = noise3(x * 0.11, y * 0.11, z * 0.11) - 0.5;
    const lumps = noise3(x * 0.3 + 5, y * 0.3, z * 0.3) - 0.5;
    const av = Math.min(1, seam[2 * v] + seam[2 * v + 1]);
    // the atrioventricular groove: a band from the seam, wide and deep under the atria, narrower under the great vessels
    // (always whole right at the seam, where the rest of the heart carries the same)
    const band = Math.max(1 - smooth(av > 0.5 ? 8 : 3, av > 0.5 ? 19 : 10, b[v] + wobble * 16), 1 - smooth(0, 1.5, fromSeam[v]));
    // the interventricular grooves, narrowing toward the apex; the apex itself is bare
    const width = (10 - 7.5 * smooth(8, 95, b[v])) * (0.8 + 0.35 * front[v]);
    const strip = 1 - smooth(width * 0.55, width + 2.5, Math.abs(g[v] + 0.8) + wobble * 6);
    const bare = 1 - 0.8 * smooth(88, 104, b[v]);
    // nothing but the seam's own share right at the seam, so it meets the rest of the heart exactly
    const away = smooth(0, 7, fromSeam[v]);
    let t = SEAM_FAT_MM * band + (2.4 * av + 0.8) * band * away + (2.2 - 1.2 * smooth(20, 90, b[v])) * strip * away;
    t *= bare;
    if (t > 0.05) t = Math.max(0, t + lumps * 1.6 * Math.min(1, t / 1.5) * away);
    out[v] = t;
  }
  return out;
}

/**
 * The fat's thickness over the rest of the heart, mm: a collar round the seam, heavier round the great vessels' roots.
 * fromSeam is each vertex's distance from the seam along the mesh.
 */
export function extraFat(anatomy: HeartAnatomy, fromSeam: Float32Array): Float32Array {
  const x = anatomy.extra;
  const E = x.part.length;
  const out = new Float32Array(E);
  for (let i = 0; i < E; i++) {
    const px = x.positions[3 * i], py = x.positions[3 * i + 1], pz = x.positions[3 * i + 2];
    const part = x.part[i];
    const wobble = noise3(px * 0.09, py * 0.09, pz * 0.09) - 0.5;
    const lumps = noise3(px * 0.3 + 5, py * 0.3, pz * 0.3) - 0.5;
    const vessel = part === 3 || part === 4;
    const reach = vessel ? 16 : part === 5 || part === 6 ? 3 : 11;
    const collar = Math.max(1 - smooth(Math.max(1, reach - 9), reach, x.dist[i] + wobble * 12), 1 - smooth(0, 1.5, fromSeam[i]));
    const away = smooth(0, 6, fromSeam[i]);
    let t = SEAM_FAT_MM * collar + (vessel ? 1.4 : 0.8) * collar * away;
    if (t > 0.05) t = Math.max(0, t + lumps * 1.2 * Math.min(1, t / 1.5) * away);
    // none on shut-in surfaces, such as the inside of a vessel's cut end (but always the seam's own share)
    const open = smooth(0.3, 0.6, x.ao[i]);
    out[i] = Math.max(t * open, SEAM_FAT_MM * (1 - smooth(0, 1.5, fromSeam[i])));
  }
  return out;
}

/**
 * Vertex normals of a mesh whose vertices are pushed out along their normals by a thickness each. fromSeam is each
 * vertex's distance from the seam, mm: on the seam the mesh's own normal is kept, because it is shared with the other
 * mesh there.
 */
export function thickenedNormals(positions: Float32Array, normals: Float32Array, indices: Uint32Array, thickness: Float32Array, fromSeam: Float32Array, twins: number[][] = []): Float32Array {
  const V = positions.length / 3;
  const p = new Float32Array(3 * V);
  for (let v = 0; v < V; v++) for (let k = 0; k < 3; k++) p[3 * v + k] = positions[3 * v + k] + normals[3 * v + k] * thickness[v];
  const acc = new Float32Array(3 * V);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    const e1: Vec3 = [p[3 * b] - p[3 * a], p[3 * b + 1] - p[3 * a + 1], p[3 * b + 2] - p[3 * a + 2]];
    const e2: Vec3 = [p[3 * c] - p[3 * a], p[3 * c + 1] - p[3 * a + 1], p[3 * c + 2] - p[3 * a + 2]];
    const n: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) acc[3 * v + k] += n[k];
  }
  // a vertex repeated on the border between two parts gathers the triangles round all its copies
  for (const g of twins) {
    const sum = [0, 0, 0];
    for (const i of g) for (let k = 0; k < 3; k++) sum[k] += acc[3 * i + k];
    for (const i of g) for (let k = 0; k < 3; k++) acc[3 * i + k] = sum[k];
  }
  // where the fat is thin keep the mesh's own normal (it is shared across the seam); blend in the thickened one
  const out = new Float32Array(3 * V);
  for (let v = 0; v < V; v++) {
    const l = Math.hypot(acc[3 * v], acc[3 * v + 1], acc[3 * v + 2]) || 1;
    const w = Math.min(1, thickness[v] / 1.2) * smooth(0, 3, fromSeam[v]);
    let nx = normals[3 * v] + (acc[3 * v] / l - normals[3 * v]) * w;
    let ny = normals[3 * v + 1] + (acc[3 * v + 1] / l - normals[3 * v + 1]) * w;
    let nz = normals[3 * v + 2] + (acc[3 * v + 2] / l - normals[3 * v + 2]) * w;
    const m = Math.hypot(nx, ny, nz) || 1;
    nx /= m;
    ny /= m;
    nz /= m;
    out.set([nx, ny, nz], 3 * v);
  }
  return out;
}

/**
 * Thin the fat wherever pushing the surface out by it would fold a triangle over (in tight creases, such as where a
 * great vessel leaves the heart): each pass halves the thickness round any triangle whose pushed-out normal turns away
 * from its own. Vertices on the seam are left alone, since the other mesh carries the same thickness there.
 */
export function relaxFolds(positions: Float32Array, normals: Float32Array, indices: Uint32Array, thickness: Float32Array, fromSeam: Float32Array, twins: number[][] = [], passes = 8): Float32Array {
  const t = Float32Array.from(thickness);
  const V = positions.length / 3;
  const moved = new Float32Array(3 * V);
  const P = positions;
  for (let pass = 0; pass < passes; pass++) {
    for (let v = 0; v < V; v++) for (let k = 0; k < 3; k++) moved[3 * v + k] = P[3 * v + k] + normals[3 * v + k] * t[v];
    const folded = new Uint8Array(V);
    let any = false;
    for (let k = 0; k < indices.length; k += 3) {
      const a = 3 * indices[k], b = 3 * indices[k + 1], c = 3 * indices[k + 2];
      if (t[a / 3] + t[b / 3] + t[c / 3] < 0.05) continue;
      // the triangle's normal before and after (unnormalised), and whether it turned by more than about 70 degrees
      let ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      let wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
      const n0x = uy * wz - uz * wy, n0y = uz * wx - ux * wz, n0z = ux * wy - uy * wx;
      ux = moved[b] - moved[a]; uy = moved[b + 1] - moved[a + 1]; uz = moved[b + 2] - moved[a + 2];
      wx = moved[c] - moved[a]; wy = moved[c + 1] - moved[a + 1]; wz = moved[c + 2] - moved[a + 2];
      const n1x = uy * wz - uz * wy, n1y = uz * wx - ux * wz, n1z = ux * wy - uy * wx;
      const d = n0x * n1x + n0y * n1y + n0z * n1z;
      if (d < 0.35 * Math.hypot(n0x, n0y, n0z) * Math.hypot(n1x, n1y, n1z)) {
        folded[a / 3] = folded[b / 3] = folded[c / 3] = 1;
        any = true;
      }
    }
    if (!any) break;
    for (let v = 0; v < V; v++) if (folded[v] && fromSeam[v] > 0) t[v] *= 0.5;
    // a vertex repeated on the border between two parts is one point: it keeps one thickness
    for (const g of twins) {
      let m = Infinity;
      for (const i of g) m = Math.min(m, t[i]);
      for (const i of g) t[i] = m;
    }
  }
  return t;
}

/**
 * Keep the fat from pushing a surface through whatever lies just in front of it (the aortic root beside the right
 * ventricle's outflow, an atrium over its groove): each thickness is capped at the clearance along its normal to the
 * nearest point of either mesh, less a margin. Seam vertices are left alone.
 */
export function capByClearance(
  meshes: { positions: Float32Array; normals: Float32Array; thickness: Float32Array; fromSeam: Float32Array }[],
  margin = 0.8,
): void {
  const cell = 4;
  const grid = new Map<number, number[]>(); // mesh index * 2^24 + vertex
  // cells numbered in a box of 1024 on a side, well beyond the heart's reach in 4 mm cells
  const cellId = (cx: number, cy: number, cz: number) => ((cx + 512) * 1024 + (cy + 512)) * 1024 + (cz + 512);
  const cellKey = (x: number, y: number, z: number) => cellId(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
  meshes.forEach((m, mi) => {
    for (let v = 0; v < m.positions.length / 3; v++) {
      const k = cellKey(m.positions[3 * v], m.positions[3 * v + 1], m.positions[3 * v + 2]);
      const list = grid.get(k);
      const id = mi * 16777216 + v;
      if (list) list.push(id);
      else grid.set(k, [id]);
    }
  });
  for (const m of meshes) {
    const P = m.positions, N = m.normals, T = m.thickness;
    for (let v = 0; v < P.length / 3; v++) {
      if (T[v] < 0.05 || m.fromSeam[v] <= 0) continue;
      const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
      const nx = N[3 * v], ny = N[3 * v + 1], nz = N[3 * v + 2];
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
      let cap = T[v];
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++)
          for (let c = -1; c <= 1; c++)
            for (const id of grid.get(cellId(cx + a, cy + b, cz + c)) ?? []) {
              const o = meshes[Math.floor(id / 16777216)];
              const w = id % 16777216;
              const ex = o.positions[3 * w] - x, ey = o.positions[3 * w + 1] - y, ez = o.positions[3 * w + 2] - z;
              const along = ex * nx + ey * ny + ez * nz;
              if (along < 0.6) continue; // beside or behind: its own neighbours on the same surface
              const lateral = Math.hypot(ex - nx * along, ey - ny * along, ez - nz * along);
              if (lateral > 2.5) continue;
              // (the other point may carry fat of its own toward this one, so leave room for half of it)
              cap = Math.min(cap, Math.max(0, along - margin - 0.5 * o.thickness[w]));
            }
      T[v] = cap;
    }
  }
}

