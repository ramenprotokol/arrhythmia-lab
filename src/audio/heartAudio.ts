// The heartbeat you can hear: it listens to the rhythm analyser and plays what the heart is doing, as it happens.
//   steady    a "lub-dub" for every beat: the "lub" when the beat starts, the "dub" when the muscle has finished contracting (from the simulation, so it follows the rate and the recovery slider)
//   extra     an early beat is softer, with its second sound close behind
//   racing    one short thump per turn of the wave when it is too fast to hold two sounds, and quieter, because it pumps little
//   chaotic   nothing: fibrillation has no heartbeat to hear (the muscle quivers, and nothing pumps)
//   shock     a thud and a crackle, then quiet until the heart restarts
//   quiet     silence
// The sound is off until the person turns it on, and the first time that has to come from a click or a key press,
// or the browser keeps audio blocked.
import type { BeatEvent, RhythmState, SecondSoundEvent } from "./rhythm";
import { makeNoise, playFirstSound, playSecondSound, playShock, playThump, type Bus } from "./voices";

export type SoundState = "off" | "on" | "blocked";

/** From this many beats a minute there is no room for two sounds in a beat: each beat is one thump. */
export const SINGLE_THUMP_BPM = 180;
/**
 * A real first heart sound comes about 40 to 70 ms after the QRS begins (the valves close as the pressure builds). The
 * analyser sees a beat about 20 ms after it starts and the sound is scheduled 5 ms after that, so this adds the rest.
 */
const FIRST_SOUND_DELAY_S = 0.03;
/** Used until the analyser has a rate to give. */
const DEFAULT_BPM = 75;
/** Beats of a heart that pumps little are quieter: a racing heart is about half as loud as a healthy one. */
const QUIETEST_SHARE = 0.35;
const EXTRA_BEAT_SHARE = 0.7;
const SECOND_SOUND_SHARE = 0.78;
const EXTRA_SECOND_SOUND_SHARE = 0.6;
/** Beats are never exactly the same: a little variation in loudness. */
const HUMAN_VARIATION = 0.12;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const PREFERENCE_KEY = "arrhythmia-lab:sound";

/** Remembers, in this browser only, whether the person had the sound on. Storage can be blocked, so nothing here may throw. */
export const soundPreference = {
  load(): boolean {
    try {
      return globalThis.localStorage?.getItem(PREFERENCE_KEY) === "on";
    } catch {
      return false;
    }
  },
  save(on: boolean): void {
    try {
      globalThis.localStorage?.setItem(PREFERENCE_KEY, on ? "on" : "off");
    } catch {
      // private window or blocked storage: the choice just is not remembered
    }
  },
};

/**
 * The path every sound takes to the speakers: voices -> a soft low-pass, so it sounds as if it comes from inside a
 * chest -> a gentle limiter -> the volume -> out. (A shock's crackle goes straight to the limiter, so it stays bright.) Shared with the offline sound check in the browser tests, so the
 * check hears exactly what the page plays.
 */
export function buildChain(ctx: BaseAudioContext, destination: AudioNode = ctx.destination): { voices: GainNode; bright: GainNode; master: GainNode } {
  const voices = ctx.createGain();
  const bright = ctx.createGain();
  const chest = ctx.createBiquadFilter();
  chest.type = "lowpass";
  chest.frequency.value = 900;
  chest.Q.value = 0.5;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -14;
  limiter.knee.value = 10;
  limiter.ratio.value = 6;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;
  const master = ctx.createGain();
  master.gain.value = 0;
  voices.connect(chest);
  chest.connect(limiter);
  bright.connect(limiter);
  limiter.connect(master);
  master.connect(destination);
  return { voices, bright, master };
}

export class HeartAudio {
  /** How many of each sound have been asked for since the page loaded. The browser tests read these: a test cannot listen. */
  readonly stats = { first: 0, second: 0, thump: 0, shock: 0 };

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bus: Bus | null = null;
  private tap: MediaStreamAudioDestinationNode | null = null;
  private wanted = false;
  /** The browser could not make an audio context at all (none exists, or it refused): the sound stays off and nothing throws. */
  private failed = false;
  private volume: number;
  private suspendTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly createContext: () => AudioContext = () => new AudioContext({ latencyHint: "interactive" }),
    volume = 0.5,
    private readonly random: () => number = Math.random,
  ) {
    this.volume = clamp(volume, 0, 1);
  }

  /**
   * Make the audio path now (silent while the sound is off), so captureStream exists even if the sound has never been turned
   * on. Call it from a click, such as the one that starts a recording, so a person who turns the sound on part way through a
   * clip gets it in the clip.
   */
  prepare(): void {
    this.ensureContext();
  }

  /** True where the browser cannot play sound at all, so the page can say so instead of showing a button that does nothing. */
  get unavailable(): boolean {
    return this.failed;
  }

  /**
   * A live copy of what the speakers play, as a stream the clip recorder can record along with the picture. Null until the
   * sound has been turned on once (or where the browser cannot make one). It is silent while the sound is off.
   */
  get captureStream(): MediaStream | null {
    return this.tap?.stream ?? null;
  }

  /** "off": the person has it off. "on": it is playing. "blocked": they want it on but the browser has not allowed audio yet. */
  get state(): SoundState {
    if (!this.wanted) return "off";
    return this.ctx?.state === "running" ? "on" : "blocked";
  }

  /** Turn the sound on or off. Turning it on for the first time must happen inside a click or key press. */
  async setOn(on: boolean): Promise<void> {
    this.wanted = on;
    clearTimeout(this.suspendTimer);
    if (on) {
      const ctx = this.ensureContext();
      if (!ctx) {
        this.wanted = false;
        return;
      }
      try {
        await ctx.resume();
      } catch {
        // stays "blocked"; the next click will try again
      }
      this.fadeMaster(this.volume);
    } else if (this.ctx) {
      this.fadeMaster(0);
      // Give the fade a moment, then stop the audio clock so a silent page costs nothing.
      this.suspendTimer = setTimeout(() => {
        if (!this.wanted) void this.ctx?.suspend();
      }, 300);
    }
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.wanted) this.fadeMaster(this.volume);
  }

  /** A beat has been seen. `state` is the analyser's reading at that moment: it says how fast and how strong. */
  beat(e: BeatEvent, state: RhythmState): void {
    const bus = this.liveBus();
    // Fibrillation has no beats to hear: the ECG still wiggles, but nothing is pumping. (A "quiet" reading is not muted:
    // the first beat after a shock arrives before the reading has caught up, and it should be heard.)
    if (!bus || state.kind === "chaotic") return;
    const strength = this.strength(state, e.premature);
    const when = bus.ctx.currentTime + 0.005;
    if ((state.bpm ?? DEFAULT_BPM) >= SINGLE_THUMP_BPM) {
      playThump(bus, when, strength);
      this.stats.thump++;
      return;
    }
    playFirstSound(bus, when + FIRST_SOUND_DELAY_S, strength);
    this.stats.first++;
  }

  /**
   * The muscle has finished contracting after a beat: the second sound. It comes from the simulation, so it is later in a
   * slow beat and sooner in a fast one, stretches in slow motion, and follows the recovery slider. A rhythm too fast for
   * two sounds (a thump per turn) and fibrillation have none.
   */
  secondSound(e: SecondSoundEvent, state: RhythmState): void {
    const bus = this.liveBus();
    if (!bus || state.kind === "chaotic" || (state.bpm ?? DEFAULT_BPM) >= SINGLE_THUMP_BPM) return;
    playSecondSound(bus, bus.ctx.currentTime + 0.005, this.strength(state, e.premature) * (e.premature ? EXTRA_SECOND_SOUND_SHARE : SECOND_SOUND_SHARE));
    this.stats.second++;
  }

  /** The person shocked the heart: a thud and a crackle. */
  shock(): void {
    const bus = this.liveBus();
    if (!bus) return;
    playShock(bus, bus.ctx.currentTime + 0.005);
    this.stats.shock++;
  }

  /** Release the audio device. The page never needs this; tests do. */
  dispose(): void {
    clearTimeout(this.suspendTimer);
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.bus = null;
    this.tap = null;
    this.wanted = false;
  }

  /** How loud a beat is: less for a heart that pumps little, softer for an extra beat, and never exactly the same twice. */
  private strength(state: RhythmState, premature: boolean): number {
    const pumping = QUIETEST_SHARE + (1 - QUIETEST_SHARE) * clamp(state.output, 0, 1);
    const variation = 1 - HUMAN_VARIATION / 2 + HUMAN_VARIATION * this.random();
    return clamp(pumping * (premature ? EXTRA_BEAT_SHARE : 1) * variation, 0, 1);
  }

  private liveBus(): Bus | null {
    if (!this.wanted || !this.ctx || this.ctx.state !== "running" || !this.bus) return null;
    return this.bus;
  }

  private fadeMaster(target: number): void {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(target, now, 0.03);
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (this.failed) return null;
    try {
      const ctx = this.createContext();
      const { voices, bright, master } = buildChain(ctx);
      this.ctx = ctx;
      this.master = master;
      this.bus = { ctx, out: voices, bright, noise: makeNoise(ctx) };
      if (typeof ctx.createMediaStreamDestination === "function") {
        this.tap = ctx.createMediaStreamDestination();
        master.connect(this.tap);
      }
      return ctx;
    } catch {
      // no Web Audio here, or the browser refused to make a context: the lab works without sound
      this.ctx = null;
      this.master = null;
      this.bus = null;
      this.tap = null;
      this.failed = true;
      return null;
    }
  }
}
