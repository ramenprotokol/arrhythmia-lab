// The tuned settings behind the lessons. They were found by running the real simulation on the shipped
// heart (see docs/receipts.md) and are pinned by tests/gpu/arrhythmia.spec.ts. If public/data/heart.bin is
// ever rebuilt, these voxel coordinates and timings have to be found again.

export type Voxel = [number, number, number];

export type Tissue = { conduction: number; recovery: number };

/**
 * Where the pacemaker (and every "normal" beat) is delivered: the true apex, the tip of the heart. This is
 * heart-frame.json's apexVoxel, which is built from the source labels (the atria sit at the base). Do not
 * guess the apex from the shape: "the narrower end" picks the wrong end of this heart.
 */
export const APEX: Voxel = [119, 19, 23];
export const APEX_STIM = { radiusMm: 3, amp: 2 } as const;

/** Where an extra, early beat is delivered: on the heart's wall, about a third of the way up from the tip. */
export const EXTRA_BEAT_SITE: Voxel = [79, 47, 11];
export const EXTRA_BEAT_STIM = { radiusMm: 5, amp: 0.5 } as const;

/** Healthy, idealised tissue. */
export const NORMAL_TISSUE: Tissue = { conduction: 1, recovery: 1 };

/**
 * Sliders that make the electrical wave short enough to fit a loop inside the heart: slower conduction and a
 * shorter recovery time. An extra beat 245 to 305 ms after a normal beat then starts a wave that keeps circling.
 */
export const TACHYCARDIA_TISSUE: Tissue = { conduction: 0.7, recovery: 0.3 };
/** Extra-beat timings to try, in ms after the normal beat, best first (tuned on this heart; see plans.ts). */
export const TACHYCARDIA_EXTRA_BEAT_MS: number[] = [250, 246, 274, 254, 270, 242, 278, 258];

/** With normal tissue, an extra beat this long after a normal beat is captured once and then dies out. */
export const PVC_EXTRA_BEAT_MS = 550;

/** Even shorter wave: a burst of fast pacing breaks into many wavefronts (fibrillation). */
export const FIBRILLATION_TISSUE: Tissue = { conduction: 0.5, recovery: 0.17 };
/** Fast-pacing bursts to try (beats x period in ms), best first. The manual burst button uses the first. */
export const FIBRILLATION_BURSTS: { beats: number; periodMs: number }[] = [
  { beats: 16, periodMs: 100 },
  { beats: 16, periodMs: 96 },
  { beats: 16, periodMs: 104 },
  { beats: 18, periodMs: 100 },
  { beats: 14, periodMs: 100 },
  { beats: 16, periodMs: 108 },
];

/** The limits of the two sliders. Inside these the whole heart always activates from a normal beat. */
export const SLIDER_LIMITS = {
  conduction: { min: 0.4, max: 1.2, step: 0.01 },
  recovery: { min: 0.15, max: 1.2, step: 0.01 },
} as const;
