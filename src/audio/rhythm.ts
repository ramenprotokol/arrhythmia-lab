// What the heart is doing right now, worked out from the simulated ECG and the excited fraction: when each beat
// happens, how fast the rhythm is, whether it is steady, racing or chaotic, and whether the muscle is pumping.
// It owns no audio and no graphics. The heartbeat sound and the status badge both read it, and it is tested against
// ECG recorded from the real simulation (tests/audio/fixtures).
//
// Everything is measured in SIMULATED milliseconds, so slow motion changes nothing: 75 beats per minute stays 75.
//
// How a beat is found. Every ECG sample gives one number: how steeply the twelve leads are changing, added up. A beat
// is a burst of steepness (the QRS). One lead alone would not do: in the racing rhythm lead II is almost flat. What
// counts as a burst depends on the rhythm. In a steady rhythm the ordinary beat is far steeper than anything else
// (the T wave that follows is about a twentieth of it), and an early beat, being a slower wave, is much smaller than
// the ordinary one, so a beat only has to reach 15% of the recent biggest burst, and it can only start while most of the
// muscle is at rest: a burst while the muscle is still firing is a beat that did not take. In a fast rhythm (racing,
// fibrillation) each turn of the wave has smaller bursts round it, so a beat has to reach 68% of the biggest.
//
// The second heart sound comes from the muscle, not from a formula: contraction ends when the excited fraction falls
// away after a beat, so the sound follows the recovery slider and the rate for free.
//
// How the rhythm is named. The excited fraction (the share of muscle switched on) swings from 0 to 1 in a healthy
// beat, because the whole heart fires together. In the racing rhythm it only wobbles between about 0.3 and 0.45, and in
// fibrillation it barely moves: the muscle is busy but not pumping. So a big swing means an organised beat, and a small
// swing with very regular bursts means the racing wave, and a small swing with irregular bursts means fibrillation.

export type RhythmKind = "quiet" | "steady" | "racing" | "chaotic";

export interface BeatEvent {
  /** Simulated time of the beat, in ms. */
  tMs: number;
  /** True when it came clearly earlier than the rhythm before it (an extra beat). */
  premature: boolean;
}

/** The muscle has finished contracting after a beat: the moment of the second heart sound. */
export interface SecondSoundEvent {
  /** Simulated time at which the contraction ended, in ms. */
  tMs: number;
  /** Simulated time of the beat it belongs to. */
  beatMs: number;
  /** True when that beat was an extra beat. */
  premature: boolean;
}

export interface RhythmState {
  kind: RhythmKind;
  /** Beats (or turns of the racing wave) per simulated minute. Null when it cannot be told yet, or there is none. */
  bpm: number | null;
  /** 0 to 1: how much of the muscle switches on and off together. About 1 in a healthy beat, near 0 in fibrillation. */
  output: number;
  /** Simulated time at which this kind began, in ms. */
  sinceMs: number;
}

/** Steepness is averaged over this many samples (20 ms at 250 samples a second) so noise does not fake a beat. */
const SMOOTH_SAMPLES = 5;
/** How fast the memory of "the biggest recent burst" fades. */
const ENVELOPE_DECAY_S = 1.5;
/** A beat starts when the steepness passes this share of the recent biggest burst (a steady rhythm, or one not yet known), and the detector re-arms below OFF. */
const BEAT_ON_SLOW = 0.15;
/** The same for a fast rhythm. Anything from 0.65 to 0.72 works on the recordings; the middle leaves room. */
const BEAT_ON_FAST = 0.68;
const BEAT_OFF = 0.3;
/** Below this average share of muscle firing, evenly spaced bursts are still called fibrillation, not the racing wave. */
const RACING_MIN_FIRING = 0.22;
/** A rhythm whose beats come closer than this is fast. */
const FAST_GAP_MS = 350;
/** In a steady rhythm a burst is only a new beat while less than this share of the muscle is firing. */
const BUSY_FRACTION = 0.5;
/** The contraction is over when the excited fraction falls below this share of its peak after a beat, the peak being at least MIN_PEAK. */
const SECOND_SOUND_FALL = 0.3;
const SECOND_SOUND_MIN_PEAK = 0.4;
/** Steepness below this (mV per sample, all leads together) counts as silence. Recorded silence is exactly zero. */
const SILENCE_FLOOR = 0.03;
/** Least time between two beats: half the usual gap between beats, kept between these limits. The racing wave's ECG
 *  has a second, smaller burst 70 to 90 ms after each main one; with a floor under 140 ms the detector counts both,
 *  the gaps look shorter, the floor shrinks, and it stays wrong. */
const REFRACTORY_MIN_MS = 140;
const REFRACTORY_MAX_MS = 420;
const REFRACTORY_DEFAULT_MS = 200;
/** The window the excited fraction and the beat regularity are judged over. */
const WINDOW_MS = 1600;
/** How much the muscle pumps is judged over just this much of the recent past, so it follows a change quickly. */
const OUTPUT_WINDOW_MS = 1000;
/** How far back the usual gap between ordinary beats is looked for. */
const USUAL_GAP_MEMORY_MS = 6400;
/** Two gaps between beats agree when they are within this share of each other. */
const USUAL_GAP_AGREE = 0.1;
/** Beats older than this no longer count towards the rate. */
const RATE_MEMORY_MS = 3200;
/** No electrical activity for this long reads as "quiet". */
const QUIET_AFTER_MS = 1000;
/** An organised rhythm at or above this rate is called racing. */
const RACING_BPM = 140;
/**
 * It has to keep that pace for this many gaps in a row. A tap that lands just before the next steady beat gives two or
 * three beats close together (and the tissue can echo once more), which is not the racing wave.
 */
const RACING_MIN_GAPS = 4;
/**
 * A beat that comes in less than this share of the recent gap is an extra beat. The beats of this heart are level to
 * within a few ms, so the margin only has to cover that and the fact that an early beat's burst is seen about 40 ms later
 * than an ordinary one's (it is a slower wave): an early beat 680 ms after one that came every 800 is seen 718 ms after.
 */
const PREMATURE_RATIO = 0.92;
/** A new reading must hold this long before it replaces the old one; the step from racing to chaotic must hold longer. */
const CONFIRM_MS = 300;
const CONFIRM_CHAOTIC_MS = 1000;
/** How often the reading is refreshed, in simulated ms. */
const EVALUATE_EVERY_MS = 100;
/** After a reset (a shock), samples are ignored this long: they hold the shock's own one-sample spike and any samples
 *  from before the shock still waiting to be read back. A defibrillation is longer: the whole heart fires at once and
 *  recovers together, which is not a heartbeat. */
export const BLANK_AFTER_RESET_MS = 40;
export const BLANK_AFTER_DEFIBRILLATION_MS = 450;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const allFinite = (values: ArrayLike<number>): boolean => {
  for (let k = 0; k < values.length; k++) if (!Number.isFinite(values[k])) return false;
  return true;
};

export class RhythmAnalyzer {
  private prev: Float64Array | null = null;
  private readonly smooth = new Float64Array(SMOOTH_SAMPLES);
  private smoothAt = 0;
  private smoothSum = 0;
  private envelope = 0;
  private armed = true;
  private lastSampleMs = -Infinity;
  private lastBeatMs = -Infinity;
  private lastActiveMs = -Infinity;
  private blankUntilMs = -Infinity;
  private beats: number[] = [];
  /** Whether each beat in `beats` was an extra beat. */
  private early: boolean[] = [];
  private fractions: { t: number; f: number }[] = [];
  private lastEvaluateMs = -Infinity;
  private candidate: RhythmKind = "quiet";
  private candidateSinceMs = 0;
  private current: RhythmState = { kind: "quiet", bpm: null, output: 0, sinceMs: 0 };
  private secondArmed = false;
  private lastBeatPremature = false;
  private peakFraction = 0;
  private readonly secondListeners = new Set<(e: SecondSoundEvent) => void>();
  private readonly beatListeners = new Set<(e: BeatEvent) => void>();
  private readonly stateListeners = new Set<(s: RhythmState) => void>();

  /** The latest reading. Cheap to read every frame. */
  get state(): RhythmState {
    return this.current;
  }

  /** Simulated time of the most recent beat, or -Infinity. */
  get lastBeatAtMs(): number {
    return this.lastBeatMs;
  }

  /** Called for every beat, as soon as it is seen. Returns a function that stops the calls. */
  onBeat(cb: (e: BeatEvent) => void): () => void {
    this.beatListeners.add(cb);
    return () => this.beatListeners.delete(cb);
  }

  /** Called when the muscle finishes contracting after a beat. Racing and fibrillating rhythms never produce one. */
  onSecondSound(cb: (e: SecondSoundEvent) => void): () => void {
    this.secondListeners.add(cb);
    return () => this.secondListeners.delete(cb);
  }

  /** Called when the kind changes, or the rate or the output moves noticeably. */
  onState(cb: (s: RhythmState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /** Forget everything and read "quiet" at once. Call it when the heart is reset (a shock) at simulated time tMs; `settleMs` is how long to ignore the aftermath. */
  reset(tMs: number, settleMs: number = BLANK_AFTER_RESET_MS): void {
    this.blankUntilMs = tMs + settleMs;
    this.secondArmed = false;
    this.beats = [];
    this.early = [];
    this.fractions = [];
    // The averaging buffer still holds the steepness from before the shock; left alone it would fake a beat.
    this.smooth.fill(0);
    this.smoothSum = 0;
    this.envelope = 0;
    this.armed = true;
    this.lastActiveMs = -Infinity;
    this.lastBeatMs = -Infinity;
    this.candidate = "quiet";
    this.candidateSinceMs = tMs;
    this.publish({ kind: "quiet", bpm: null, output: 0, sinceMs: tMs });
  }

  /** The share of muscle that is switched on (0 to 1) at simulated time tMs. Call once per frame. A value that is not a number is skipped. */
  pushFraction(tMs: number, fraction: number): void {
    if (!Number.isFinite(tMs) || !Number.isFinite(fraction) || tMs <= this.blankUntilMs) return;
    this.fractions.push({ t: tMs, f: fraction });
    while (this.fractions.length > 0 && tMs - this.fractions[0].t > WINDOW_MS) this.fractions.shift();
    if (this.secondArmed) {
      if (fraction > this.peakFraction) this.peakFraction = fraction;
      if (this.peakFraction > SECOND_SOUND_MIN_PEAK && fraction < SECOND_SOUND_FALL * this.peakFraction) {
        this.secondArmed = false;
        const event: SecondSoundEvent = { tMs, beatMs: this.lastBeatMs, premature: this.lastBeatPremature };
        this.secondListeners.forEach((cb) => cb(event));
      }
    }
  }

  /**
   * One 12-lead ECG sample (millivolts) taken at simulated time tMs. Call in time order. A sample with a NaN or an infinity
   * in it (a bad readback) is skipped whole: taken in, it would sit in the running sums and the envelope for good.
   */
  push(tMs: number, leads: ArrayLike<number>): void {
    if (!Number.isFinite(tMs) || !allFinite(leads)) return;
    const steep = this.steepness(leads);
    if (tMs <= this.blankUntilMs) {
      this.lastSampleMs = tMs;
      return;
    }
    this.smoothSum += steep - this.smooth[this.smoothAt];
    this.smooth[this.smoothAt] = steep;
    this.smoothAt = (this.smoothAt + 1) % SMOOTH_SAMPLES;
    const e = this.smoothSum / SMOOTH_SAMPLES;

    const dt = Number.isFinite(this.lastSampleMs) ? Math.max(0, tMs - this.lastSampleMs) : 0;
    this.lastSampleMs = tMs;
    this.envelope = Math.max(e, this.envelope * Math.exp(-dt / 1000 / ENVELOPE_DECAY_S));
    if (e > SILENCE_FLOOR) this.lastActiveMs = tMs;

    const fast = this.isFast(tMs);
    if (this.armed) {
      if (e >= Math.max((fast ? BEAT_ON_FAST : BEAT_ON_SLOW) * this.envelope, SILENCE_FLOOR) && tMs - this.lastBeatMs >= this.refractoryMs(tMs)) {
        this.armed = false;
        // In a steady rhythm a burst while most of the muscle is still firing is a beat that did not take (it fell in the
        // recovery of the one before), not a new beat.
        const busy = this.fractions.length > 0 && this.fractions[this.fractions.length - 1].f >= BUSY_FRACTION;
        if (fast || !busy) this.registerBeat(tMs);
      }
    } else if (e < BEAT_OFF * this.envelope) {
      this.armed = true;
    }

    if (tMs - this.lastEvaluateMs >= EVALUATE_EVERY_MS) {
      this.lastEvaluateMs = tMs;
      this.evaluate(tMs);
    }
  }

  private steepness(leads: ArrayLike<number>): number {
    let sum = 0;
    if (this.prev && this.prev.length === leads.length) {
      for (let k = 0; k < leads.length; k++) sum += Math.abs(leads[k] - this.prev[k]);
    }
    if (!this.prev || this.prev.length !== leads.length) this.prev = new Float64Array(leads.length);
    for (let k = 0; k < leads.length; k++) this.prev[k] = leads[k];
    return sum;
  }

  /** Gaps between the beats seen in the last few seconds, oldest first. */
  private gaps(nowMs: number): number[] {
    const recent = this.beats.filter((b) => nowMs - b <= RATE_MEMORY_MS).slice(-8);
    const gaps: number[] = [];
    for (let k = 1; k < recent.length; k++) gaps.push(recent[k] - recent[k - 1]);
    return gaps;
  }

  private isFast(nowMs: number): boolean {
    const gaps = this.gaps(nowMs);
    return gaps.length >= 2 && median(gaps.slice(-3)) < FAST_GAP_MS;
  }

  private refractoryMs(nowMs: number): number {
    const gaps = this.gaps(nowMs);
    if (gaps.length === 0) return REFRACTORY_DEFAULT_MS;
    return Math.min(REFRACTORY_MAX_MS, Math.max(REFRACTORY_MIN_MS, 0.5 * median(gaps.slice(-3))));
  }

  /**
   * The usual gap between ordinary beats: the gap most of the recent ones agree on, judged only from gaps where neither
   * beat was early (the pause after an early beat is long and the gap before it short, and neither says what the rhythm
   * is). Two gaps within 10% of each other are enough (this heart's steady beats agree to within a few ms). Null until then. Taking the largest group, not the middle of all
   * of them, keeps a tap in the first seconds after the page opens from skewing it.
   */
  private usualGap(nowMs: number): number | null {
    const gaps: number[] = [];
    for (let k = this.beats.length - 1; k >= 1 && gaps.length < 6; k--) {
      if (nowMs - this.beats[k] > USUAL_GAP_MEMORY_MS) break;
      if (this.early[k] || this.early[k - 1]) continue;
      gaps.push(this.beats[k] - this.beats[k - 1]);
    }
    let group: number[] = [];
    for (const g of gaps) {
      const near = gaps.filter((x) => Math.abs(x - g) <= USUAL_GAP_AGREE * Math.max(x, g));
      if (near.length > group.length) group = near;
    }
    return group.length >= 2 ? median(group) : null;
  }

  private registerBeat(tMs: number): void {
    const previous = this.beats[this.beats.length - 1];
    const usual = this.usualGap(tMs);
    const premature = usual !== null && this.current.kind === "steady" && previous !== undefined && tMs - previous < PREMATURE_RATIO * usual;
    this.beats.push(tMs);
    this.early.push(premature);
    if (this.beats.length > 64) {
      this.beats.shift();
      this.early.shift();
    }
    this.lastBeatMs = tMs;
    this.secondArmed = true;
    this.peakFraction = 0;
    this.lastBeatPremature = premature;
    const event: BeatEvent = { tMs, premature };
    this.beatListeners.forEach((cb) => cb(event));
  }

  private evaluate(tMs: number): void {
    const silentMs = tMs - this.lastActiveMs;
    const recentBeats = this.beats.filter((b) => tMs - b <= WINDOW_MS);
    const gaps: number[] = [];
    for (let k = 1; k < recentBeats.length; k++) gaps.push(recentBeats[k] - recentBeats[k - 1]);

    const swingOver = (windowMs: number): number => {
      let lo = Infinity;
      let hi = -Infinity;
      let seen = 0;
      for (const { t, f } of this.fractions) {
        if (tMs - t > windowMs) continue;
        seen++;
        if (f < lo) lo = f;
        if (f > hi) hi = f;
      }
      return seen > 1 ? hi - lo : 0;
    };
    const swing = swingOver(WINDOW_MS);

    const rateGaps = this.gaps(tMs);
    const recentBpm = rateGaps.length >= 2 ? 60000 / median(rateGaps.slice(-3)) : null;
    const lastGaps = rateGaps.slice(-RACING_MIN_GAPS);
    const sustainedFast = lastGaps.length >= RACING_MIN_GAPS && Math.max(...lastGaps) < 60000 / RACING_BPM;
    const organisedKind: RhythmKind = sustainedFast ? "racing" : "steady";
    // The rate. A racing heart's rate is the pace of its last few turns. A steady heart's is its usual gap between ordinary
    // beats, so an early beat and the pause after it do not move it. Until the usual gap is known, a rate is stated only
    // when the last two gaps agree: two quick beats after a tap in the first seconds are not a rate.
    const usual = this.usualGap(tMs);
    let bpm: number | null;
    if (organisedKind === "racing" || this.current.kind === "racing") {
      bpm = recentBpm;
    } else if (usual !== null && 60000 / usual < RACING_BPM) {
      bpm = 60000 / usual;
    } else if (rateGaps.length >= 2) {
      const [a, b] = rateGaps.slice(-2);
      bpm = Math.abs(a - b) <= USUAL_GAP_AGREE * Math.max(a, b) ? 60000 / ((a + b) / 2) : null;
    } else {
      bpm = null;
    }

    let kind: RhythmKind;
    if (silentMs > QUIET_AFTER_MS) {
      kind = "quiet";
    } else if (swing >= 0.5) {
      kind = organisedKind;
    } else if (gaps.length >= 4) {
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const spread = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gaps.length) / mean;
      // The racing wave keeps about a third of the muscle firing (0.28 to 0.46 in the recordings); in fibrillation it is
      // about a fifth (0.13 to 0.23). So bursts that happen to be evenly spaced, with little muscle firing, are not the racing wave.
      const firing = this.fractions.length > 0 ? this.fractions.reduce((a, x) => a + x.f, 0) / this.fractions.length : 1;
      kind = spread <= 0.12 && firing >= RACING_MIN_FIRING ? "racing" : "chaotic";
    } else {
      // Not enough evidence to change the reading: keep it, but keep the rate and the name in step.
      kind = this.current.kind === "steady" || this.current.kind === "racing" ? organisedKind : this.current.kind;
    }

    if (kind !== this.candidate) {
      this.candidate = kind;
      this.candidateSinceMs = tMs;
    }
    let shown = this.current.kind;
    let since = this.current.sinceMs;
    const hold = this.candidate === "chaotic" && shown === "racing" ? CONFIRM_CHAOTIC_MS : CONFIRM_MS;
    if (this.candidate !== shown && tMs - this.candidateSinceMs >= hold) {
      shown = this.candidate;
      since = tMs;
    }
    // A quiet heart pumps nothing, whatever the last frames of the fraction still say (its readback lags a frame or two).
    const output = shown === "quiet" ? 0 : Math.min(1, Math.max(0, (swingOver(OUTPUT_WINDOW_MS) - 0.08) / 0.6));
    this.publish({ kind: shown, bpm: shown === "steady" || shown === "racing" ? bpm : null, output, sinceMs: since });
  }

  private publish(next: RhythmState): void {
    const prev = this.current;
    this.current = next;
    const changed =
      next.kind !== prev.kind ||
      (next.bpm === null) !== (prev.bpm === null) ||
      (next.bpm !== null && prev.bpm !== null && Math.abs(next.bpm - prev.bpm) >= 2) ||
      Math.abs(next.output - prev.output) >= 0.15;
    if (changed) this.stateListeners.forEach((cb) => cb(next));
  }
}
