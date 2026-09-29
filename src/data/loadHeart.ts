// Parsers for the files written by tools/build_heart.py (layout in tools/README.md).
// All values are little-endian.
//
// heart.bin:         "HRT1", uint32 nx, ny, nz, float32 voxelMm  (20 bytes)
//                    then 4 bytes per voxel, interleaved: uint8 tissue, int8 fx, fy, fz.
//                    Tissue: 0 outside, 1 endo, 2 mid, 3 epi. Fibre components are scaled by 127.
//                    Voxel index is x + nx * (y + ny * z).
// heart-surface.bin: "SRF1", uint32 vertexCount, uint32 indexCount  (12 bytes)
//                    then float32 positions (3 per vertex), float32 normals (3 per vertex),
//                    then uint32 indices. Same millimetre frame as the grid.
// heart-anatomy.bin: "ANA1", uint32 V (heart-surface.bin's vertexCount), uint32 E, uint32 EI  (16 bytes)
//                    then int16 x 4 per ventricle vertex (groove and base in 0.1 mm, ao x 32767,
//                    concavity per mm x 10000), then the rest of the heart's outer surface: float32
//                    positions (3 per vertex), int8 normals x 127 (4 per vertex, the 4th unused), uint8 x 4
//                    per vertex (part, mm from the ventricles, ao x 255, 128 + concavity x 400), uint32 indices.

export type HeartGrid = {
  nx: number;
  ny: number;
  nz: number;
  voxelMm: number;
  tissue: Uint8Array;
  fibre: Int8Array;
};

export type HeartSurface = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

/** What each vertex of the rest of the heart (everything but the ventricles) belongs to. */
export const ANATOMY_PART = { leftAtrium: 1, rightAtrium: 2, aorta: 3, pulmonaryArtery: 4, veins: 5, cap: 6 } as const;

/**
 * Anatomy for drawing the whole heart. Per vertex of the ventricular surface (heart-surface.bin, same order):
 * where the grooves are, occlusion and curvature. And the outer surface of the rest of the heart (atria, great
 * vessels, vein stumps), which is drawn but not simulated; it meets the ventricular surface along a seam whose
 * vertices are identical in both meshes. Each triangle of the rest has one part: vertices on a border between
 * parts are repeated, once per part.
 */
export type HeartAnatomy = {
  /** Signed distance along the surface to the interventricular grooves, mm: negative on the LV side. */
  groove: Float32Array;
  /** Distance along the surface from the base (the seam with the atria and great vessels), mm. */
  base: Float32Array;
  /** Ambient occlusion baked against the whole heart: 0 shut in, 1 open. */
  ao: Float32Array;
  /** Minus the mean curvature, per mm: positive in grooves and creases, negative on bulges. */
  concavity: Float32Array;
  extra: {
    positions: Float32Array;
    /** Unit outward normals, 3 per vertex. */
    normals: Float32Array;
    /** One of ANATOMY_PART. */
    part: Uint8Array;
    /** Distance from the ventricular muscle, mm (capped at 255). */
    dist: Float32Array;
    ao: Float32Array;
    concavity: Float32Array;
    indices: Uint32Array;
  };
};

function magic(dv: DataView): string {
  return String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
}

export function parseHeart(buffer: ArrayBuffer): HeartGrid {
  if (buffer.byteLength < 20) throw new Error("heart.bin: file too small");
  const dv = new DataView(buffer);
  if (magic(dv) !== "HRT1") throw new Error("heart.bin: bad magic number");
  const nx = dv.getUint32(4, true);
  const ny = dv.getUint32(8, true);
  const nz = dv.getUint32(12, true);
  const voxelMm = dv.getFloat32(16, true);
  const n = nx * ny * nz;
  if (buffer.byteLength !== 20 + 4 * n) throw new Error("heart.bin: size does not match header");

  const tissue = new Uint8Array(n);
  const fibre = new Int8Array(3 * n);
  const bytes = new Uint8Array(buffer, 20, 4 * n);
  const signed = new Int8Array(buffer, 20, 4 * n);
  for (let i = 0; i < n; i++) {
    tissue[i] = bytes[4 * i];
    fibre[3 * i] = signed[4 * i + 1];
    fibre[3 * i + 1] = signed[4 * i + 2];
    fibre[3 * i + 2] = signed[4 * i + 3];
  }
  return { nx, ny, nz, voxelMm, tissue, fibre };
}

export function parseSurface(buffer: ArrayBuffer): HeartSurface {
  if (buffer.byteLength < 12) throw new Error("heart-surface.bin: file too small");
  const dv = new DataView(buffer);
  if (magic(dv) !== "SRF1") throw new Error("heart-surface.bin: bad magic number");
  const V = dv.getUint32(4, true);
  const I = dv.getUint32(8, true);
  if (buffer.byteLength !== 12 + 24 * V + 4 * I) throw new Error("heart-surface.bin: size does not match header");

  const positions = new Float32Array(buffer.slice(12, 12 + 12 * V));
  const normals = new Float32Array(buffer.slice(12 + 12 * V, 12 + 24 * V));
  const indices = new Uint32Array(buffer.slice(12 + 24 * V, 12 + 24 * V + 4 * I));
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= V) throw new Error("heart-surface.bin: index points past the last vertex");
  }
  return { positions, normals, indices };
}

/**
 * Read heart-anatomy.bin. ventricleVertexCount, when given, must match the file (it describes the vertices of
 * that ventricular surface, in order).
 */
export function parseAnatomy(buffer: ArrayBuffer, ventricleVertexCount?: number): HeartAnatomy {
  if (buffer.byteLength < 16) throw new Error("heart-anatomy.bin: file too small");
  const dv = new DataView(buffer);
  if (magic(dv) !== "ANA1") throw new Error("heart-anatomy.bin: bad magic number");
  const V = dv.getUint32(4, true);
  const E = dv.getUint32(8, true);
  const EI = dv.getUint32(12, true);
  if (EI % 3 !== 0) throw new Error("heart-anatomy.bin: index count is not a multiple of 3");
  if (buffer.byteLength !== 16 + 8 * V + 20 * E + 4 * EI) throw new Error("heart-anatomy.bin: size does not match header");
  if (ventricleVertexCount !== undefined && V !== ventricleVertexCount) {
    throw new Error(`heart-anatomy.bin: describes ${V} ventricle vertices, the surface has ${ventricleVertexCount}`);
  }

  const groove = new Float32Array(V), base = new Float32Array(V), ao = new Float32Array(V), concavity = new Float32Array(V);
  for (let i = 0; i < V; i++) {
    const o = 16 + 8 * i;
    groove[i] = dv.getInt16(o, true) / 10;
    base[i] = dv.getInt16(o + 2, true) / 10;
    ao[i] = Math.max(0, dv.getInt16(o + 4, true)) / 32767;
    concavity[i] = dv.getInt16(o + 6, true) / 10000;
  }
  let at = 16 + 8 * V;
  const positions = new Float32Array(buffer.slice(at, at + 12 * E));
  at += 12 * E;
  const n8 = new Int8Array(buffer, at, 4 * E);
  const attr = new Uint8Array(buffer, at + 4 * E, 4 * E);
  at += 8 * E;
  const indices = new Uint32Array(buffer.slice(at, at + 4 * EI));
  const normals = new Float32Array(3 * E);
  const part = new Uint8Array(E), dist = new Float32Array(E), xao = new Float32Array(E), xconc = new Float32Array(E);
  for (let i = 0; i < E; i++) {
    const x = n8[4 * i], y = n8[4 * i + 1], z = n8[4 * i + 2];
    const len = Math.hypot(x, y, z) || 1;
    normals[3 * i] = x / len;
    normals[3 * i + 1] = y / len;
    normals[3 * i + 2] = z / len;
    part[i] = attr[4 * i];
    dist[i] = attr[4 * i + 1];
    xao[i] = attr[4 * i + 2] / 255;
    xconc[i] = (attr[4 * i + 3] - 128) / 400;
  }
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= E) throw new Error("heart-anatomy.bin: index points past the last vertex");
  }
  return { groove, base, ao, concavity, extra: { positions, normals, part, dist, ao: xao, concavity: xconc, indices } };
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url}: ${res.status}`);
  return res.arrayBuffer();
}

export async function loadHeart(url: string): Promise<HeartGrid> {
  return parseHeart(await fetchBuffer(url));
}

export async function loadSurface(url: string): Promise<HeartSurface> {
  return parseSurface(await fetchBuffer(url));
}

export async function loadAnatomy(url: string, ventricleVertexCount?: number): Promise<HeartAnatomy> {
  return parseAnatomy(await fetchBuffer(url), ventricleVertexCount);
}
