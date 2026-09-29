// The lab's clock and its rules: when the pacemaker fires, when a burst fires, when the inducer acts, and how
// the simulation is stepped. It owns no graphics, so the whole thing is tested against the real heart without a
// renderer. The page (app.ts) calls advanceChunk() as often as real time allows and draws in between.
import { SWEEP_NEVER, type Simulation } from "../sim/Simulation";
import type { HeartGrid } from "../data/loadHeart";
import type { HeartFrame } from "../data/heartFrame";
import * as R from "../lessons/recipes";
import { activationTimes, type SweepTimesOptions } from "./conduction";
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
/** A conduction sweep is fired in slots this long, in simulated ms (see useConductionSweep). */
export const SWEEP_SLOT_MS = 1;
/**
 * Current given to a voxel in its slot. Any value from 0.4 to 2 fires a rested heart and gives the same ECG. A gentler one
 * is kept because a beat that arrives while the muscle is still recovering should not be forced through: with 1, the
 * ordinary beat that falls 250 ms after an early beat is blocked, and the early beat is followed by the pause a real one is.
 */
const SWEEP_AMP = 1;
/** How fast the beat travels over the inner wall, mm per ms, and how far behind the right ventricle starts: they give a QRS of about 80 ms. */
const SWEEP_DEFAULTS: SweepTimesOptions = { leftSpeedMmPerMs: 1.5, rightSpeedMmPerMs: 1.5, rightDelayMs: 10 };

/** A radius that reaches every cell of the heart, for a stimulus that has to fire the whole muscle at once. */
export const WHOLE_HEART_MM = 400;

export interface EngineHooks {
  /** Called after every chunk and every stimulus, with the simulated time, so the ECG can be sampled. */
  afterAdvance?(simTimeMs: number): void;
  /** Called when the tissue settings or the pacemaker are changed from code, so the page can update its controls. */
  changed?(): void;
  /**
   * Called whenever the heart is shocked, whoever asked: the person (`wholeHeart` true: the whole heart fires at once and
   * recovers together, which is not a heartbeat), or the lab resetting the heart between induction attempts (false: an
   * instant reset that leaves nothing behind).
   */
  shocked?(simTimeMs: number, wholeHeart: boolean): void;
}

export class LabEngine {
  simTime = 0;
  pacemaker = true;
  nextBeat = 300;
  lastBeatAt = -Infinity;
  /** Simulated time of the most recent shock of either kind, or -Infinity. */
  lastShockAt = -Infinity;
  burst: number[] = [];
  /** When set, an extra beat is fired as soon as this many ms have passed since the last beat. */
  private extraCouplingMs: number | null = null;
  /** Ms into the ordinary beat's conduction sweep that is under way, or null. The sweep runs inside the chunks, in place of plain stepping. */
  private sweepAt: number | null = null;
  private sweepEndMs = 0;
  private hasSweep = false;
  /** Current given to a voxel in its slot of the sweep. Public so it can be tuned against the live simulation. */
  sweepAmp = SWEEP_AMP;
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
    if (this.extraCouplingMs !== null && this.simTime - this.lastBeatAt >= this.extraCouplingMs) {
      this.extraCouplingMs = null;
      this.extraBeat();
    } else if (this.burst.length > 0 && this.burst[0] <= this.simTime) {
      this.burst.shift();
      this.beatAtApex();
      if (this.burst.length === 0) this.nextBeat = this.simTime + PACEMAKER_PERIOD_MS;
    } else if (this.pacemaker && this.burst.length === 0 && this.simTime >= this.nextBeat) {
      this.normalBeat();
      this.nextBeat = this.simTime + PACEMAKER_PERIOD_MS;
    }
    if (this.sweepAt !== null) this.sweepChunk();
    else this.sim.step(CHUNK_MS);
    this.simTime += CHUNK_MS;
    this.hooks.afterAdvance?.(this.simTime);
  }

  /** One chunk of the sweep: each slot fires the voxels the front reaches in it, and steps the simulation by the slot. */
  private sweepChunk(): void {
    let t = this.sweepAt as number;
    for (let k = 0; k < CHUNK_MS / SWEEP_SLOT_MS; k++) {
      this.sim.stimulateSweep(t, t + SWEEP_SLOT_MS, { amp: this.sweepAmp, ms: SWEEP_SLOT_MS });
      t += SWEEP_SLOT_MS;
    }
    this.sweepAt = t < this.sweepEndMs ? t : null;
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

  /**
   * The heart's ordinary beat, what the pacemaker fires. With a conduction sweep (useConductionSweep) the inner wall of both
   * ventricles is switched on from the septum outward over about 60 ms, as the heart's conduction fibres do, and the wave
   * then crosses the wall: a QRS of about 80 ms, upright in lead II. Without one it is a single nudge at the tip.
   * The sweep runs over the next few chunks; it does not add time to the clock.
   */
  normalBeat(): void {
    if (!this.hasSweep) {
      this.beatAtApex();
      return;
    }
    this.sweepAt = 0;
    this.lastBeatAt = this.simTime;
  }

  /**
   * Give the ordinary beat its conduction sweep, worked out from the heart itself (src/lab/conduction.ts). The real
   * heart has fast conduction fibres that this model lacks; without a sweep the beat crawls up from the tip in about
   * 300 ms and the ECG looks like a paced beat.
   */
  useConductionSweep(grid: HeartGrid, frame: HeartFrame, opts: SweepTimesOptions = {}): void {
    const times = activationTimes(grid, frame, { ...SWEEP_DEFAULTS, ...opts });
    this.sim.setSweepTimes(times);
    let latest = 0;
    for (const v of times) if (v < SWEEP_NEVER && v > latest) latest = v;
    this.sweepEndMs = latest + SWEEP_SLOT_MS;
    this.hasSweep = true;
  }

  extraBeat(): void {
    this.deliver(R.EXTRA_BEAT_SITE, R.EXTRA_BEAT_STIM.radiusMm, R.EXTRA_BEAT_STIM.amp);
  }

  /**
   * An extra beat that will show. Fired at once, it does nothing if the muscle is still recovering from the last beat,
   * so this waits until it has rested for `couplingMs` (an early beat, but not too early), then fires it. If the
   * pacemaker gets there first, it waits for the next gap.
   */
  scheduleExtraBeat(couplingMs: number = R.PVC_EXTRA_BEAT_MS): void {
    this.extraCouplingMs = couplingMs;
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
    this.extraCouplingMs = null;
    this.sweepAt = null;
    this.nextBeat = this.simTime + AFTER_SHOCK_MS;
    this.lastShockAt = this.simTime;
    this.hooks.shocked?.(this.simTime, false);
  }

  /** A burst of `beats` fast beats at the tip, `periodMs` apart, starting now. */
  startBurst(beats: number, periodMs: number): void {
    this.burst = Array.from({ length: beats }, (_, i) => this.simTime + i * periodMs);
  }

  /**
   * A defibrillator's shock: every muscle cell is stimulated at once, so they all fire together and then all recover
   * together, and no wave is left circling. This is the person's Shock. The lab's own silent resets (between induction
   * attempts, at the start of a lesson) use shock() instead, which just puts every cell at rest.
   */
  defibrillate(): void {
    this.inducer.cancel();
    this.burst = [];
    this.extraCouplingMs = null;
    this.sweepAt = null;
    this.deliver(R.APEX, WHOLE_HEART_MM, 2);
    this.nextBeat = this.simTime + AFTER_SHOCK_MS;
    this.lastShockAt = this.simTime;
    this.hooks.shocked?.(this.simTime, true);
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
