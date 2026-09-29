// Runs inside the browser under Playwright. Renders the heart sounds offline, through the same path the page uses to
// reach the speakers, and hands the samples back so a spec can measure them.
import { buildChain } from "../../src/audio/heartAudio";
import { makeNoise, playFirstSound, playSecondSound, playShock, playThump, type Bus } from "../../src/audio/voices";

const RATE = 44100;

export interface Score {
  /** What to play: each at a time (seconds) with a loudness (0 to 1). */
  first?: [when: number, strength: number][];
  second?: [when: number, strength: number][];
  thump?: [when: number, strength: number][];
  shock?: number[];
  seconds: number;
  volume?: number;
}

async function render(score: Score): Promise<number[]> {
  const ctx = new OfflineAudioContext(1, Math.ceil(score.seconds * RATE), RATE);
  const { voices, bright, master } = buildChain(ctx);
  master.gain.value = score.volume ?? 0.8;
  const bus: Bus = { ctx, out: voices, bright, noise: makeNoise(ctx) };
  for (const [t, s] of score.first ?? []) playFirstSound(bus, t, s);
  for (const [t, s] of score.second ?? []) playSecondSound(bus, t, s);
  for (const [t, s] of score.thump ?? []) playThump(bus, t, s);
  for (const t of score.shock ?? []) playShock(bus, t);
  const buffer = await ctx.startRendering();
  return Array.from(buffer.getChannelData(0));
}

declare global {
  interface Window {
    audioLab: { rate: number; render(score: Score): Promise<number[]> };
  }
}
window.audioLab = { rate: RATE, render };
