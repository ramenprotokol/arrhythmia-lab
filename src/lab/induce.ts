// Starts a sustained arrhythmia on demand, robustly.
//
// The circling waves depend on the exact moment of an extra beat, and a chaotic system can behave a little
// differently on another graphics card because of tiny rounding differences. So instead of one exact timing
// this tries a short list of known-good ones, one after another, and keeps the first that takes: if an attempt
// leaves the heart quiet it is shocked back to rest and the next timing is tried.

export type InduceKind = "tachycardia" | "fibrillation";
export type InduceStatus = "idle" | "running" | "success" | "failed";

/** One thing to deliver: a beat at the tip of the heart, or an extra beat at the side wall, atMs after the attempt starts. */
export type Stimulus = { atMs: number; kind: "apex" | "extra" };

export type Attempt = {
  stimuli: Stimulus[];
  /** Judge the attempt this long after it starts. */
  checkAtMs: number;
};

export type Plan = {
  tissue: { conduction: number; recovery: number };
  attempts: Attempt[];
  /** The attempt worked if at least this fraction of the muscle is excited at the check time. */
  minFraction: number;
};

/** What the inducer needs from the lab. */
export type InduceHost = {
  simTimeMs(): number;
  activeFraction(): number;
  apexBeat(): void;
  extraBeat(): void;
  shock(): void;
  setTissue(t: { conduction: number; recovery: number }): void;
  setPacemaker(on: boolean): void;
};

export type InduceState = { status: InduceStatus; kind: InduceKind | null; attempt: number; attempts: number };

/** Settling time before each attempt, so it starts from a heart at rest. */
const SETTLE_MS = 400;

export class Inducer {
  private plan: Plan | null = null;
  private kind: InduceKind | null = null;
  private status: InduceStatus = "idle";
  private attempt = 0;
  private startedAtMs = 0;
  private delivered = 0;
  private listeners = new Set<() => void>();

  constructor(
    private readonly host: InduceHost,
    private readonly plans: Record<InduceKind, Plan>,
  ) {}

  get state(): InduceState {
    return { status: this.status, kind: this.kind, attempt: this.attempt + 1, attempts: this.plan?.attempts.length ?? 0 };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(kind: InduceKind): void {
    this.kind = kind;
    this.plan = this.plans[kind];
    this.attempt = 0;
    this.status = "running";
    this.host.setPacemaker(false);
    this.host.setTissue(this.plan.tissue);
    this.begin();
    this.emit();
  }

  cancel(): void {
    if (this.status === "running") {
      this.status = "idle";
      this.emit();
    }
  }

  /** Call before every simulation chunk, so stimuli land on the chunk grid (a few ms of jitter at most). */
  tick(): void {
    const plan = this.plan;
    if (this.status !== "running" || plan === null) return;
    const attempt = plan.attempts[this.attempt];
    const rel = this.host.simTimeMs() - this.startedAtMs;
    if (rel < 0) return; // still settling

    while (this.delivered < attempt.stimuli.length && attempt.stimuli[this.delivered].atMs <= rel) {
      const s = attempt.stimuli[this.delivered++];
      if (s.kind === "apex") this.host.apexBeat();
      else this.host.extraBeat();
    }

    if (rel >= attempt.checkAtMs) {
      if (this.host.activeFraction() >= plan.minFraction) {
        this.status = "success";
      } else if (this.attempt + 1 < plan.attempts.length) {
        this.host.shock();
        this.attempt++;
        this.begin();
      } else {
        this.host.shock();
        this.status = "failed";
      }
      this.emit();
    }
  }

  private begin(): void {
    this.delivered = 0;
    this.startedAtMs = this.host.simTimeMs() + SETTLE_MS;
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }
}
