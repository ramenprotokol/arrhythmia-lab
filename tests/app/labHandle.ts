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
  monitor: { getTrace(lead: number): { t: Float32Array; v: Float32Array } };
  sim: { excitedFraction(): Promise<number> };
  runner: { state: { lessonId: string | null; stepIndex: number; finished: boolean } };
  setSpeed(s: number): void;
};

declare global {
  interface Window {
    __lab: LabHandle;
    __labErrors?: string[];
  }
}
