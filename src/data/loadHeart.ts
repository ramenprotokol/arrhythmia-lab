// Parsers for the two files written by tools/build_heart.py (layout in tools/README.md).
// All values are little-endian.
//
// heart.bin:         "HRT1", uint32 nx, ny, nz, float32 voxelMm  (20 bytes)
//                    then 4 bytes per voxel, interleaved: uint8 tissue, int8 fx, fy, fz.
//                    Tissue: 0 outside, 1 endo, 2 mid, 3 epi. Fibre components are scaled by 127.
//                    Voxel index is x + nx * (y + ny * z).
// heart-surface.bin: "SRF1", uint32 vertexCount, uint32 indexCount  (12 bytes)
//                    then float32 positions (3 per vertex), float32 normals (3 per vertex),
//                    then uint32 indices. Same millimetre frame as the grid.

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
