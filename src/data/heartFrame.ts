// The anatomical frame of the shipped heart. tools/build_frame.py writes public/data/heart-frame.json
// (derivation and checks in tools/README.md); this file reads and validates it.
//
// Coordinates are voxel INDEX coordinates of the original, unpadded grid in heart.bin: the centre of
// voxel (i, j, k) is exactly (i, j, k), so millimetres are the coordinate times voxelMm. That is the
// same convention Simulation.stimulate uses and the ECG kernel uses for a voxel's position.
//
// The three directions are an anatomical frame of the HEART: superiorDir runs from the apex toward the
// base (the reverse of longAxis), leftDir from the right ventricle toward the left ventricle across it, and
// anteriorDir completes a right-handed frame. Right-handed here means superior x left = posterior, so
// (left, posterior, superior) is a right-handed triple and anterior = -posterior.

export type Vec3 = [number, number, number];

export type HeartFrame = {
  voxelMm: number;
  /** Centroid of the whole ventricular muscle. */
  centroid: Vec3;
  lvCentroid: Vec3;
  rvCentroid: Vec3;
  atriaCentroid: Vec3;
  /** Unit vector from the base toward the apex. */
  longAxis: Vec3;
  /** Unit vectors of the anatomical frame, mutually orthogonal. */
  leftDir: Vec3;
  superiorDir: Vec3;
  anteriorDir: Vec3;
  /** Muscle voxels at the two ends of the long axis, as voxel indices. */
  apexVoxel: Vec3;
  baseVoxel: Vec3;
  /** Extent of the ventricular muscle along the long axis. */
  lengthMm: number;
};

const UNIT_TOLERANCE = 1e-3;
const ORTHOGONAL_TOLERANCE = 1e-2;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function vec3(json: Record<string, unknown>, key: string): Vec3 {
  const v = json[key];
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new Error(`heart frame: "${key}" must be three finite numbers`);
  }
  return [v[0], v[1], v[2]];
}

function voxel(json: Record<string, unknown>, key: string): Vec3 {
  const v = vec3(json, key);
  if (!v.every((x) => Number.isInteger(x) && x >= 0)) {
    throw new Error(`heart frame: "${key}" must be three whole voxel indices, zero or more`);
  }
  return v;
}

function positive(json: Record<string, unknown>, key: string): number {
  const v = json[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`heart frame: "${key}" must be a positive number`);
  return v;
}

function unit(json: Record<string, unknown>, key: string): Vec3 {
  const v = vec3(json, key);
  const length = Math.hypot(v[0], v[1], v[2]);
  if (Math.abs(length - 1) > UNIT_TOLERANCE) {
    throw new Error(`heart frame: "${key}" must be a unit vector (length ${length.toFixed(4)})`);
  }
  return v;
}

/** Check a parsed JSON value and return it as a HeartFrame. Throws with the reason if anything is off. */
export function parseFrame(json: unknown): HeartFrame {
  if (!isRecord(json)) throw new Error("heart frame: expected a JSON object");
  const frame: HeartFrame = {
    voxelMm: positive(json, "voxelMm"),
    centroid: vec3(json, "centroid"),
    lvCentroid: vec3(json, "lvCentroid"),
    rvCentroid: vec3(json, "rvCentroid"),
    atriaCentroid: vec3(json, "atriaCentroid"),
    longAxis: unit(json, "longAxis"),
    leftDir: unit(json, "leftDir"),
    superiorDir: unit(json, "superiorDir"),
    anteriorDir: unit(json, "anteriorDir"),
    apexVoxel: voxel(json, "apexVoxel"),
    baseVoxel: voxel(json, "baseVoxel"),
    lengthMm: positive(json, "lengthMm"),
  };
  const pairs: [string, Vec3, Vec3][] = [
    ["leftDir/superiorDir", frame.leftDir, frame.superiorDir],
    ["leftDir/anteriorDir", frame.leftDir, frame.anteriorDir],
    ["superiorDir/anteriorDir", frame.superiorDir, frame.anteriorDir],
  ];
  for (const [name, a, b] of pairs) {
    if (Math.abs(dot(a, b)) > ORTHOGONAL_TOLERANCE) throw new Error(`heart frame: ${name} are not orthogonal (dot ${dot(a, b).toFixed(4)})`);
  }
  // superior x left = posterior = -anterior, so the triple product of (superior, left, anterior) is -1.
  if (dot(cross(frame.superiorDir, frame.leftDir), frame.anteriorDir) > -0.5) {
    throw new Error("heart frame: the axes are not right-handed (superior x left must equal -anterior)");
  }
  return frame;
}

export async function loadFrame(url: string): Promise<HeartFrame> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not load ${url}: ${res.status}`);
  return parseFrame(await res.json());
}
