// Which timings the inducer tries, in order. Found on the shipped heart (see docs/receipts.md) and pinned by
// tests/gpu/lab.spec.ts. Several are listed because the circling waves are sensitive to tiny numerical
// differences between graphics cards: the first that takes on a given computer is kept.
import type { Attempt, InduceKind, Plan } from "./induce";
import * as R from "../lessons/recipes";

const extraBeatAttempts = (intervalsMs: number[]): Attempt[] =>
  intervalsMs.map((ci) => ({
    stimuli: [
      { atMs: 0, kind: "apex" as const },
      { atMs: ci, kind: "extra" as const },
    ],
    // judged 2.5 s after the extra beat: a wave still circling then is a sustained rhythm
    checkAtMs: ci + 2500,
  }));

const burstAttempts = (bursts: { beats: number; periodMs: number }[]): Attempt[] =>
  bursts.map(({ beats, periodMs }) => ({
    stimuli: Array.from({ length: beats }, (_, i) => ({ atMs: i * periodMs, kind: "apex" as const })),
    checkAtMs: (beats - 1) * periodMs + 3000,
  }));

export const PLANS: Record<InduceKind, Plan> = {
  tachycardia: {
    tissue: R.TACHYCARDIA_TISSUE,
    minFraction: 0.05,
    attempts: extraBeatAttempts(R.TACHYCARDIA_EXTRA_BEAT_MS),
  },
  fibrillation: {
    tissue: R.FIBRILLATION_TISSUE,
    minFraction: 0.05,
    attempts: burstAttempts(R.FIBRILLATION_BURSTS),
  },
};
