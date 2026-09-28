import type { HeartFrame, Vec3 } from "../data/heartFrame";

export type ElectrodeName = "RA" | "LA" | "LL" | "V1" | "V2" | "V3" | "V4" | "V5" | "V6";

/** The nine electrodes, in the order the GPU kernel numbers them. */
export const ELECTRODE_NAMES: readonly ElectrodeName[] = ["RA", "LA", "LL", "V1", "V2", "V3", "V4", "V5", "V6"];

/**
 * Where each electrode sits, as (left, anterior, superior) millimetres from the centroid of the ventricular
 * muscle, measured along the anatomical axes of the heart (see HeartFrame).
 *
 * These numbers are IDEALISED, not measured from any body. The limb electrodes stand for the two shoulders
 * and the left hip, far away so that each acts as a far-field pick-up; the chest electrodes follow a
 * standard arc from the right of the sternum (V1) round to the left side (V6). The idealisation is the
 * point: the simulated 12 leads only need the right geometry relative to the heart, so they come out
 * qualitatively like a textbook ECG and are never a measurement of anyone.
 *
 * Left, anterior and superior are the axes of THIS HEART (HeartFrame), which follow its tilt and rotation,
 * not the body's. The shipped heart lies flat and rotated, so with these offsets the chest arc does not sit
 * where a real chest arc would: read as a patient frame, V6 lands about 89 mm behind the ventricles and V1
 * about 53 mm in front. tools/README.md ("What the frame is, and is not") has the numbers and a comparison.
 */
export const ANATOMICAL_OFFSETS: Record<ElectrodeName, Vec3> = {
  RA: [-190, 0, 230],
  LA: [190, 0, 230],
  LL: [100, 0, -350],
  V1: [-50, 85, 30],
  V2: [-15, 95, 25],
  V3: [25, 95, 10],
  V4: [65, 85, -5],
  V5: [105, 60, -5],
  V6: [135, 25, -5],
};

/**
 * Electrode positions in millimetres in grid coordinates (voxel coordinates times voxelMm, the same
 * frame the solver and the ECG kernel use): centroid + left*leftDir + anterior*anteriorDir + superior*superiorDir.
 */
export function electrodePositions(frame: HeartFrame): Record<ElectrodeName, Vec3> {
  const c = frame.centroid.map((x) => x * frame.voxelMm);
  const out = {} as Record<ElectrodeName, Vec3>;
  for (const name of ELECTRODE_NAMES) {
    const [left, anterior, superior] = ANATOMICAL_OFFSETS[name];
    out[name] = [0, 1, 2].map((i) => c[i] + left * frame.leftDir[i] + anterior * frame.anteriorDir[i] + superior * frame.superiorDir[i]) as Vec3;
  }
  return out;
}
