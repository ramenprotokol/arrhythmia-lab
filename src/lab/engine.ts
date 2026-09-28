// The lab's clock and its rules: when the pacemaker fires, when a burst fires, when the inducer acts, and how
// the simulation is stepped. It owns no graphics, so the whole thing is tested against the real heart without a
// renderer. The page (app.ts) calls advanceChunk() as often as real time allows and draws in between.
import type { Simulation } from "../sim/Simulation";
import * as R from "../lessons/recipes";
import { Inducer, type InduceKind } from "./induce";
import { PLANS } from "./plans";

/** Time step of the cell model. 0.1 ms is as accurate as 0.05 for the action potential and twice as fast. */
export const DT_MS = 0.1;
/** The simulation advances in chunks of this many ms; one ECG sample is taken per chunk (250 per second). */
export const CHUNK_MS = 4;
export const PACEMAKER_PERIOD_MS = 800;
/** A stimulus pulse lasts this long, in simulated ms (Simulation.stimulate advances the clock by it). */
export const STIM_MS = 2;
/** After a shock the normal rhythm picks up again this long afterwards, if the pacemaker is on. */
export const AFTER_SHOCK_MS = 1500;

export interface EngineHooks {
  /** Called after every chunk and every stimulus, with the simulated time, so the ECG can be sampled. */
  afterAdvance?(simTimeMs: number): void;
  /** Called when the tissue settings or the pacemaker are changed from code, so the page can update its controls. */
  changed?(): void;
}

export class LabEngine {
  simTime = 0;
  pacemaker = true;
  nextBeat = 300;
  lastBeatAt = -Infinity;
  burst: number[] = [];
  excited = 0;
  readonly tissue = { conduction: 1, recovery: 1 };
  readonly inducer: Inducer;
  private excitedBusy = false;

  constructor(
    readonly sim: Simulation,
    private readonly hooks: EngineHooks = {},
  ) {
    this.inducer = new Inducer(
      {
        simTimeMs: () => this.simTime,
        activeFraction: () => this.excited,
        apexBeat: () => this.beatAtApex(),
        extraBeat: () => this.extraBeat(),
        shock: () => this.shock(),
        setTissue: (t) => this.setTissue(t),
        setPacemaker: (on) => this.setPacemaker(on),
      },
      PLANS,
    );
  }

  /** One chunk: anything due (inducer, burst, pacemaker) fires first, then the simulation steps CHUNK_MS. */
  advanceChunk(): void {
    this.inducer.tick();
    if (this.burst.length > 0 && this.burst[0] <= this.simTime) {
      this.burst.shift();
      this.beatAtApex();
      if (this.burst.length === 0) this.nextBeat = this.simTime + PACEMAKER_PERIOD_MS;
    } else if (this.pacemaker && this.burst.length === 0 && this.simTime >= this.nextBeat) {
      this.beatAtApex();
      this.nextBeat = this.simTime + PACEMAKER_PERIOD_MS;
    }
    this.sim.step(CHUNK_MS);
    this.simTime += CHUNK_MS;
    this.hooks.afterAdvance?.(this.simTime);
  }

  deliver(voxel: R.Voxel, radiusMm: number, amp: number): void {
    this.sim.stimulate(voxel, radiusMm, { amp, ms: STIM_MS });
    this.simTime += STIM_MS;
    this.lastBeatAt = this.simTime;
    this.hooks.afterAdvance?.(this.simTime);
  }

  beatAtApex(): void {
    this.deliver(R.APEX, R.APEX_STIM.radiusMm, R.APEX_STIM.amp);
  }

  extraBeat(): void {
    this.deliver(R.EXTRA_BEAT_SITE, R.EXTRA_BEAT_STIM.radiusMm, R.EXTRA_BEAT_STIM.amp);
  }

  setTissue(t: { conduction?: number; recovery?: number }): void {
    if (t.conduction !== undefined) this.tissue.conduction = t.conduction;
    if (t.recovery !== undefined) this.tissue.recovery = t.recovery;
    this.sim.setTissue(this.tissue);
    this.hooks.changed?.();
  }

  setPacemaker(on: boolean): void {
    this.pacemaker = on;
    this.nextBeat = this.simTime + 400;
    this.hooks.changed?.();
  }

  shock(): void {
    this.sim.shock();
    this.burst = [];
    this.nextBeat = this.simTime + AFTER_SHOCK_MS;
  }

  /** A burst of `beats` fast beats at the tip, `periodMs` apart, starting now. */
  startBurst(beats: number, periodMs: number): void {
    this.burst = Array.from({ length: beats }, (_, i) => this.simTime + i * periodMs);
  }

  /** Start a sustained rhythm on demand. Tries known-good timings until one takes (see induce.ts). */
  induce(kind: InduceKind): void {
    this.inducer.start(kind);
  }

  /** Like refreshExcited, but waits for the answer. For tests, where the clock is driven by hand. */
  async refreshExcitedNow(): Promise<void> {
    this.excited = await this.sim.excitedFraction();
  }

  /** Refresh the cached excited fraction from the GPU. Cheap: 4 bytes come back. Safe to call every frame. */
  refreshExcited(): void {
    if (this.excitedBusy) return;
    this.excitedBusy = true;
    this.sim
      .excitedFraction()
      .then((f) => (this.excited = f))
      .catch(() => undefined)
      .finally(() => (this.excitedBusy = false));
  }
}
