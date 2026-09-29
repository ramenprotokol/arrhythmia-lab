// What the status card says, worked out from the rhythm analyser's reading and a few page events. Pure: no DOM, so it
// is unit-tested on its own (tests/ui/status.test.ts). The words come from src/copy.ts.
import { HUD, RHYTHM_COPY, STARTING_MESSAGE, type RhythmKey } from "../copy";
import type { RhythmState } from "../audio/rhythm";
import { UI_TEXT } from "./text";

export type StatusKey = RhythmKey | "starting";
/** Shown in place of a rate. */
export const NO_RATE = "—";
/** The colour family of a state: green, amber, red, grey, cyan. */
export type StatusTone = "ok" | "notice" | "alarm" | "idle" | "info";

export interface StatusInput {
  rhythm: RhythmState;
  /** An early extra beat was seen a moment ago. */
  extra: boolean;
  /** The person's shock fired and no beat has come back yet. */
  resetting: boolean;
  /** The lab is finding the moment that starts a rhythm. */
  starting: "racing" | "fibrillation" | null;
  /**
   * The lab has just started this rhythm and the analyser has not caught up yet (for up to a second it can still read
   * "quiet" while the heart is visibly racing or fibrillating). The card names the rhythm the lab started.
   */
  settling: "racing" | "fibrillation" | null;
  /** The steady beat (the pacemaker) is switched on. A quiet heart with it on is only waiting for its next beat. */
  pacing: boolean;
}

export interface StatusView {
  key: StatusKey;
  tone: StatusTone;
  name: string;
  medicalName: string | null;
  /** The big number: a rate, or NO_RATE when there is none to count. */
  value: string;
  unit: string;
  /** How many of the five pumping bars are lit. */
  bars: number;
  pumping: string;
  sentence: string;
  next: string;
  /** The lab is working on something: show a progress bar instead of the rate and the pumping bars. */
  busy: boolean;
}

const TONE: Record<RhythmKey, StatusTone> = { steady: "ok", extra: "notice", racing: "alarm", chaotic: "alarm", resetting: "idle", quiet: "idle" };

/**
 * Which state to show. Setting a rhythm up comes first, then the pause after a shock, then a rhythm the lab has just
 * started, then what the analyser reads.
 */
export function statusKey(i: StatusInput): StatusKey {
  if (i.starting) return "starting";
  if (i.resetting) return "resetting";
  if (i.settling) return i.settling === "racing" ? "racing" : "chaotic";
  if (i.rhythm.kind === "racing") return "racing";
  if (i.rhythm.kind === "chaotic") return "chaotic";
  if (i.extra) return "extra";
  // The analyser reads "quiet" for a moment at the start and after a lesson's pause: with the steady beat on, the next
  // beat is on its way, so the card should not say the beat is switched off.
  return i.rhythm.kind === "steady" || i.pacing ? "steady" : "quiet";
}

function bars(key: RhythmKey, output: number): number {
  const lit = Math.round(Math.min(1, Math.max(0, output)) * 5);
  if (key === "steady") return Math.max(1, lit);
  if (key === "extra") return 4;
  if (key === "racing") return Math.min(1, lit);
  return 0;
}

export function statusView(i: StatusInput): StatusView {
  const key = statusKey(i);
  if (key === "starting") {
    return {
      key,
      tone: "info",
      name: i.starting === "fibrillation" ? UI_TEXT.startingFibrillation : UI_TEXT.starting,
      medicalName: null,
      value: "",
      unit: "",
      bars: 0,
      pumping: "",
      sentence: STARTING_MESSAGE[i.starting ?? "racing"],
      next: "",
      busy: true,
    };
  }
  const copy = RHYTHM_COPY[key];
  // A beating rhythm has a rate, even in the first seconds before three beats have been counted. The number is only
  // shown when the analyser reads the rhythm the card names: a racing rhythm that is still settling has no rate yet.
  const beating = key === "steady" || key === "extra" || key === "racing";
  const measured = key === "racing" ? i.rhythm.kind === "racing" : beating && i.rhythm.kind === "steady";
  const bpm = measured ? i.rhythm.bpm : null;
  return {
    key,
    tone: TONE[key],
    name: copy.name,
    medicalName: copy.medicalName ?? null,
    value: bpm !== null ? String(Math.round(bpm)) : NO_RATE,
    // while a beating rhythm's rate is still being counted, say so, rather than "— a minute"
    unit: !beating ? HUD.noRate : bpm !== null ? HUD.rateUnit : UI_TEXT.countingBeats,
    bars: bars(key, i.rhythm.output),
    pumping: copy.pumping,
    sentence: copy.sentence,
    next: copy.next,
    busy: false,
  };
}
