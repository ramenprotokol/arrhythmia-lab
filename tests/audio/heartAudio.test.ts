// What the heartbeat player asks the sound system for, with a fake audio context that only remembers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeartAudio, SINGLE_THUMP_BPM } from "../../src/audio/heartAudio";
import type { BeatEvent, RhythmState, SecondSoundEvent } from "../../src/audio/rhythm";
import { FakeAudioContext } from "./fakeAudio";

const steady: RhythmState = { kind: "steady", bpm: 75, output: 1, sinceMs: 0 };
const racing: RhythmState = { kind: "racing", bpm: 268, output: 0.15, sinceMs: 0 };
const chaotic: RhythmState = { kind: "chaotic", bpm: null, output: 0.02, sinceMs: 0 };
const quiet: RhythmState = { kind: "quiet", bpm: null, output: 0, sinceMs: 0 };
const beat = (over: Partial<BeatEvent> = {}): BeatEvent => ({ tMs: 1000, premature: false, ...over });
const second = (over: Partial<SecondSoundEvent> = {}): SecondSoundEvent => ({ tMs: 1320, beatMs: 1000, premature: false, ...over });

function setup(opts: { allowAudio?: boolean } = {}) {
  const ctx = new FakeAudioContext();
  ctx.resumeMakesRunning = opts.allowAudio ?? true;
  // A fixed "random" so loudness is predictable: the middle of the variation range, a factor of exactly 1.
  const audio = new HeartAudio(() => ctx as unknown as AudioContext, 0.5, () => 0.5);
  return { ctx, audio };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("turning it on and off", () => {
  it("is off until asked, and plays nothing while off", () => {
    const { ctx, audio } = setup();
    expect(audio.state).toBe("off");
    audio.beat(beat(), steady);
    audio.secondSound(second(), steady);
    audio.shock();
    expect(ctx.soundsStarted()).toEqual([]);
  });

  it("makes one audio context when it is first turned on, and reports on", async () => {
    const { ctx, audio } = setup();
    await audio.setOn(true);
    expect(audio.state).toBe("on");
    expect(ctx.state).toBe("running");
    await audio.setOn(false);
    await audio.setOn(true);
    expect(ctx.gains.length).toBeGreaterThan(0);
  });

  it("reports blocked, and stays silent, when the browser refuses audio", async () => {
    const { ctx, audio } = setup({ allowAudio: false });
    await audio.setOn(true);
    expect(audio.state).toBe("blocked");
    audio.beat(beat(), steady);
    expect(ctx.soundsStarted()).toEqual([]);
  });

  it("stays off, and throws nothing, in a browser that cannot make an audio context", async () => {
    const audio = new HeartAudio(() => {
      throw new Error("AudioContext is not supported");
    });
    audio.prepare(); // what the clip recorder calls
    await expect(audio.setOn(true)).resolves.toBeUndefined();
    expect(audio.state).toBe("off");
    expect(audio.unavailable).toBe(true);
    expect(audio.captureStream).toBeNull();
    audio.beat(beat(), steady);
    audio.secondSound(second(), steady);
    audio.shock();
    await audio.setOn(false);
    expect(audio.stats).toEqual({ first: 0, second: 0, thump: 0, shock: 0 });
  });

  it("fades to silence when turned off, and stops the audio clock a moment later", async () => {
    const { ctx, audio } = setup();
    await audio.setOn(true);
    await audio.setOn(false);
    expect(audio.state).toBe("off");
    expect(ctx.suspends).toBe(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(ctx.suspends).toBe(1);
    audio.beat(beat(), steady);
    expect(ctx.soundsStarted()).toEqual([]);
  });
});

describe("a steady heart: the first sound when the beat starts, the second when the muscle has finished contracting", () => {
  it("plays the first sound for a beat and, later, a softer second sound", async () => {
    const { ctx, audio } = setup();
    await audio.setOn(true);
    audio.beat(beat(), steady);
    ctx.currentTime = 0.36;
    audio.secondSound(second(), steady);
    const [first, next, ...rest] = ctx.soundsStarted();
    expect(rest).toEqual([]);
    expect(first.at).toBeGreaterThan(0.03); // a real first sound comes a little after the beat starts
    expect(next.at).toBeGreaterThan(first.at + 0.3);
    expect(next.peak).toBeLessThan(first.peak);
    expect(audio.stats).toEqual({ first: 1, second: 1, thump: 0, shock: 0 });
  });
});

describe("extra beats and racing", () => {
  it("makes an extra beat softer than a regular one, and its second sound softer still", async () => {
    const regular = setup();
    await regular.audio.setOn(true);
    regular.audio.beat(beat(), steady);
    regular.ctx.currentTime = 0.32;
    regular.audio.secondSound(second(), steady);
    const early = setup();
    await early.audio.setOn(true);
    early.audio.beat(beat({ premature: true }), steady);
    early.ctx.currentTime = 0.32;
    early.audio.secondSound(second({ premature: true }), steady);
    const [r1, r2] = regular.ctx.soundsStarted();
    const [e1, e2] = early.ctx.soundsStarted();
    expect(e1.peak).toBeLessThan(r1.peak * 0.8);
    expect(e2.peak / e1.peak).toBeLessThan(r2.peak / r1.peak);
  });

  it(`plays one thump, no second sound, from ${SINGLE_THUMP_BPM} beats a minute, and quietly, because little is pumped`, async () => {
    const healthy = setup();
    await healthy.audio.setOn(true);
    healthy.audio.beat(beat(), steady);
    const fast = setup();
    await fast.audio.setOn(true);
    fast.audio.beat(beat(), racing);
    fast.audio.secondSound(second(), racing);
    expect(fast.ctx.soundsStarted().length).toBe(1);
    expect(fast.ctx.soundsStarted()[0].peak).toBeLessThan(healthy.ctx.soundsStarted()[0].peak * 0.6);
    expect(fast.audio.stats).toEqual({ first: 0, second: 0, thump: 1, shock: 0 });
  });

  it("still plays a second sound in an organised fast rhythm that is below the thump rate", async () => {
    const { ctx, audio } = setup();
    await audio.setOn(true);
    const fastButPumping: RhythmState = { kind: "racing", bpm: 150, output: 0.9, sinceMs: 0 };
    audio.beat(beat(), fastButPumping);
    ctx.currentTime = 0.2;
    audio.secondSound(second(), fastButPumping);
    expect(ctx.soundsStarted().length).toBe(2);
  });
});

describe("fibrillation and the shock", () => {
  it("plays nothing in fibrillation: the ECG wiggles, but there is no heartbeat to hear", async () => {
    const { ctx, audio } = setup();
    await audio.setOn(true);
    audio.beat(beat(), chaotic);
    audio.beat(beat(), chaotic);
    audio.secondSound(second(), chaotic);
    expect(ctx.soundsStarted()).toEqual([]);
    expect(audio.stats).toEqual({ first: 0, second: 0, thump: 0, shock: 0 });
  });

  it("still plays the first beat after a shock, before the reading has caught up with the new rhythm", async () => {
    const { ctx, audio } = setup();
    await audio.setOn(true);
    audio.beat(beat(), quiet);
    expect(ctx.soundsStarted().length).toBe(1);
  });

  it("plays a loud thud on a shock", async () => {
    const { ctx, audio } = setup();
    await audio.setOn(true);
    ctx.currentTime = 2;
    audio.shock();
    const started = ctx.soundsStarted().filter((s) => s.at >= 2);
    expect(started.length).toBeGreaterThan(0);
    expect(Math.max(...started.map((s) => s.peak))).toBeGreaterThanOrEqual(0.95);
    expect(audio.stats.shock).toBe(1);
  });
});
