// The guided-lesson engine. Pure logic: no DOM, no GPU. A lesson only drives the same controls a
// viewer has, through the LabApi it is given.

export type Voxel = [number, number, number];

/** The controls a lesson may use. `activeFraction` is the share of muscle that is currently excited (0 to 1). */
export type LabApi = {
  pace(voxel: Voxel): void;
  prematureBeat(): void;
  /** A silent reset: every cell to rest at once. For a lesson clearing the heart before it starts. */
  shock(): void;
  /** The heart's ordinary beat (what the pacemaker fires). */
  normalBeat(): void;
  /** A defibrillator's shock: the whole heart fires at once, with the flash and the sound. */
  defibrillate(): void;
  setTissue(t: { conduction?: number; recovery?: number }): void;
  activeFraction(): number;
  /** Simulated time in ms. It only moves while the simulation runs. */
  simTimeMs(): number;
  /** Turn the regular pacemaker (a beat at the tip every 800 ms) on or off. */
  setPacemaker(on: boolean): void;
  /** `beats` fast beats at the tip, `periodMs` apart, starting now. */
  burstPace(beats: number, periodMs: number): void;
  /** Simulated time of the most recent beat or extra beat, or -Infinity if there has been none. */
  lastBeatMs(): number;
  /**
   * Start a sustained rhythm. The lab tries a short list of known-good timings and keeps the first that
   * takes on this computer (the circling waves are sensitive to tiny numerical differences).
   */
  induce(kind: "tachycardia" | "fibrillation"): void;
  /** How the last `induce` is going. */
  induceStatus(): "idle" | "running" | "success" | "failed";
};

export type LessonStep = {
  text: string;
  title?: string;
  /** Runs once per visit to the step, on the first tick after the step is entered. */
  action?: (api: LabApi) => void;
  /** Polled every tick. When present the step moves on by itself once this is true and `minMs` has passed. */
  waitFor?: (api: LabApi) => boolean;
  /** Simulated ms that must pass, counted from when the action ran, before `waitFor` may move the step on. */
  minMs?: number;
  /**
   * Help for a viewer who seems stuck on a `waitFor` step. It is offered (RunnerState.hint) only once the step has
   * lasted `hintAfterMs` of simulated time and `waitFor` is still false, so it never contradicts what is on screen.
   */
  hint?: string;
  /** Simulated ms before the hint may be offered. Default HINT_AFTER_MS. */
  hintAfterMs?: number;
  /** False for a step only the viewer can finish, such as pressing Shock: no Skip, and next() waits for `waitFor`. */
  canSkip?: boolean;
  /** Hold the ECG trace still while this step is on screen, because its words point at what the trace shows. */
  holdEcg?: boolean;
};

export type Lesson = { id: string; title: string; summary: string; steps: LessonStep[] };

export type RunnerState = {
  lessonId: string | null;
  /** One past the last step once the lesson has finished, so `stepIndex / steps.length` reaches 1. */
  stepIndex: number;
  /** The step on screen. Null when no lesson is loaded and after a lesson has finished. */
  step: LessonStep | null;
  finished: boolean;
  running: boolean;
  /** The step's hint when the viewer seems stuck (see LessonStep.hint), otherwise null. */
  hint: string | null;
};

/** How long a `waitFor` step lasts, in simulated ms, before its hint may be offered. */
export const HINT_AFTER_MS = 8000;

const IDLE: RunnerState = { lessonId: null, stepIndex: 0, step: null, finished: false, running: false, hint: null };

export class LessonRunner {
  private readonly byId = new Map<string, Lesson>();
  private readonly listeners = new Set<{ fn: () => void }>();
  private lesson: Lesson | null = null;
  private index = 0;
  private done = false;
  /** True from entering a step until its action has run. */
  private pending = false;
  private enteredAtMs = 0;
  private hint: string | null = null;
  private snapshot: RunnerState = IDLE;

  constructor(
    readonly lessons: readonly Lesson[],
    private readonly api: LabApi,
  ) {
    for (const l of lessons) {
      if (this.byId.has(l.id)) throw new Error(`Duplicate lesson id "${l.id}"`);
      this.byId.set(l.id, l);
    }
  }

  /** Replaced, not mutated, when something changes, so `state` can be compared by identity. */
  get state(): RunnerState {
    return this.snapshot;
  }

  start(id: string): void {
    const lesson = this.byId.get(id);
    if (lesson === undefined) throw new Error(`Unknown lesson "${id}"`);
    this.lesson = lesson;
    this.enter(0);
    this.publish();
  }

  /**
   * Call every frame. Runs a pending action once, then moves a `waitFor` step on when it is ready, and offers its
   * hint while the viewer seems stuck.
   */
  tick(): void {
    const lesson = this.lesson;
    if (lesson === null || this.done) return;
    const step = lesson.steps[this.index];
    if (!this.runPending()) return;
    if (step.waitFor === undefined) return;
    const now = this.api.simTimeMs();
    if (now < this.enteredAtMs) this.enteredAtMs = now; // the simulation clock restarted
    const elapsed = now - this.enteredAtMs;
    const minMet = elapsed >= (step.minMs ?? 0);
    const hintDue = step.hint !== undefined && elapsed >= (step.hintAfterMs ?? HINT_AFTER_MS);
    if (!minMet && !hintDue) return;
    const ready = step.waitFor(this.api);
    if (ready && minMet) {
      this.advance();
      return;
    }
    const hint = hintDue && !ready ? (step.hint ?? null) : null;
    if (hint !== this.hint) {
      this.hint = hint;
      this.publish();
    }
  }

  /**
   * Manual advance. A step whose action has not run yet runs it first, so later steps can rely on it. A step that
   * cannot be skipped only moves on once its `waitFor` is true.
   */
  next(): void {
    const lesson = this.lesson;
    if (lesson === null || this.done) return;
    if (!this.runPending()) return;
    const step = lesson.steps[this.index];
    if (step.canSkip === false && step.waitFor !== undefined && !step.waitFor(this.api)) return;
    this.advance();
  }

  /** Back one step and re-enter it, so its action runs again. From the finished screen, back to the last step. */
  back(): void {
    const lesson = this.lesson;
    if (lesson === null || lesson.steps.length === 0) return;
    if (this.done) this.enter(lesson.steps.length - 1);
    else if (this.index > 0) this.enter(this.index - 1);
    else return;
    this.publish();
  }

  restart(): void {
    if (this.lesson === null) return;
    this.enter(0);
    this.publish();
  }

  stop(): void {
    if (this.lesson === null) return;
    this.lesson = null;
    this.index = 0;
    this.done = false;
    this.pending = false;
    this.publish();
  }

  /** Called whenever `state` changes. Returns a function that removes the listener. */
  onChange(listener: () => void): () => void {
    const entry = { fn: listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  private enter(index: number): void {
    this.index = index;
    this.done = this.lesson === null || index >= this.lesson.steps.length;
    this.pending = !this.done;
    this.hint = null;
  }

  private advance(): void {
    this.enter(this.index + 1);
    this.publish();
  }

  /** Runs the current step's action if it has not run. False if the action itself moved the runner. */
  private runPending(): boolean {
    const lesson = this.lesson;
    if (!this.pending || lesson === null) return true;
    const index = this.index;
    this.pending = false; // cleared first, so an action that throws is not retried every frame
    this.enteredAtMs = this.api.simTimeMs();
    lesson.steps[index].action?.(this.api);
    return this.lesson === lesson && this.index === index && !this.done;
  }

  private publish(): void {
    const lesson = this.lesson;
    this.snapshot =
      lesson === null
        ? IDLE
        : {
            lessonId: lesson.id,
            stepIndex: this.index,
            step: this.done ? null : lesson.steps[this.index],
            finished: this.done,
            running: !this.done,
            hint: this.done ? null : this.hint,
          };
    for (const entry of [...this.listeners]) entry.fn();
  }
}
