// The handle the page exposes to browser tests when opened with ?debug (see src/app.ts). Declared once here, because
// two declarations of the same global property with different types fail the whole-repo typecheck.
export type LabHandle = {
  engine: {
    simTime: number;
    lastBeatAt: number;
    excited: number;
    pacemaker: boolean;
    tissue: { conduction: number; recovery: number };
    inducer: { state: { status: string; attempt: number } };
    induce(kind: "tachycardia" | "fibrillation"): void;
  };
  monitor: {
    getTrace(lead: number): { t: Float32Array; v: Float32Array };
    /** Where the boxes are, in device pixels (src/ui/monitorLayout.ts). */
    getLayout(): { boxes: { id: string; lead: number; y: number; h: number; baseline: number; pxPerMv: number }[] } | null;
    /** Each lead group's gain now, in mm per mV. */
    groupGains: { limb: number; chest: number };
  };
  sim: { excitedFraction(): Promise<number> };
  runner: { state: { lessonId: string | null; stepIndex: number; finished: boolean; step: { title?: string; canSkip?: boolean } | null; hint: string | null } };
  analyzer: {
    state: { kind: "quiet" | "steady" | "racing" | "chaotic"; bpm: number | null; output: number; sinceMs: number };
    onBeat(cb: (e: { tMs: number; premature: boolean }) => void): () => void;
  };
  audio: { state: "off" | "on" | "blocked"; stats: { first: number; second: number; thump: number; shock: number } };
  moves: {
    starting: "racing" | "fibrillation" | null;
    /** The rhythm that has just been made and is still settling (the reading is not to be trusted yet), or null. */
    settling: "racing" | "fibrillation" | null;
    extraBeat(): void;
    race(): void;
    fibrillate(): void;
    fix(): void;
    shock(rhythm: { kind: string; bpm: number | null; output: number; sinceMs: number }): { fired: true } | { fired: false; reason: "pumping" | "still" };
  };
  toggleSound(): void;
  /** Which lead the big strip shows (src/ecg/autoLead.ts). */
  autoLead: { lead: number; name: string };
  /** The first-run coach (src/ui/coach.ts). */
  coach: { hidden: boolean; done: [boolean, boolean, boolean]; finished: boolean };
  renderer: { pick(x: number, y: number): [number, number, number] | null };
  setSpeed(s: number): void;
};

declare global {
  interface Window {
    __lab: LabHandle;
    __labErrors?: string[];
  }
}
