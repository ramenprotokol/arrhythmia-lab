// The heart sounds, rendered offline in real Chrome through the same path the page uses to reach the speakers, then
// measured: loud enough but never clipping, low like a chest and not a click or a hiss, with the second sound where it
// belongs. A machine cannot say whether a sound is pleasant, but it can catch a silent, clipping, hissy or misplaced one.
// Set SOUND_PREVIEW_DIR to also write WAV files to listen to.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { consoleGuard } from "../ui/consoleGuard";

const guard = consoleGuard();
test.beforeEach(({ page }) => guard.attach(page));
test.afterEach(() => guard.check());

interface Score {
  first?: [number, number][];
  second?: [number, number][];
  thump?: [number, number][];
  shock?: number[];
  seconds: number;
  volume?: number;
}
const RATE = 44100;

async function render(page: Page, score: Score): Promise<Float64Array> {
  const data = await page.evaluate((s) => (window as unknown as { audioLab: { render(s: Score): Promise<number[]> } }).audioLab.render(s), score);
  return Float64Array.from(data);
}

async function open(page: Page) {
  await page.goto("/tests/audio/harness.html");
  await page.waitForFunction(() => Boolean((window as unknown as { audioLab?: unknown }).audioLab), undefined, { timeout: 10_000 });
}

// ---- a little signal processing -------------------------------------------------------------------------
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/** The share of the signal's energy that lies between lo and hi Hz. */
function bandShare(samples: Float64Array, lo: number, hi: number): number {
  let n = 1;
  while (n < samples.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(samples);
  fft(re, im);
  let band = 0;
  let total = 0;
  for (let k = 1; k < n / 2; k++) {
    const p = re[k] * re[k] + im[k] * im[k];
    total += p;
    const hz = (k * RATE) / n;
    if (hz >= lo && hz <= hi) band += p;
  }
  return total === 0 ? 0 : band / total;
}

/** RMS in windows of `ms` milliseconds. */
function envelope(samples: Float64Array, ms = 5): number[] {
  const w = Math.round((RATE * ms) / 1000);
  const out: number[] = [];
  for (let i = 0; i + w <= samples.length; i += w) {
    let sum = 0;
    for (let k = i; k < i + w; k++) sum += samples[k] * samples[k];
    out.push(Math.sqrt(sum / w));
  }
  return out;
}

const peakOf = (s: Float64Array): number => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const timeOf = (windowIndex: number, ms = 5): number => (windowIndex * ms) / 1000;
/** First time (s) at or after `from` that the envelope reaches `share` of `ref`. */
function onset(env: number[], from: number, share: number, ref: number): number {
  for (let i = Math.floor(from / 0.005); i < env.length; i++) if (env[i] >= share * ref) return timeOf(i);
  return Infinity;
}
/** How long (s) the envelope stays above `share` of its own peak between two times. */
function lasts(env: number[], from: number, to: number, share: number): number {
  const slice = env.slice(Math.floor(from / 0.005), Math.floor(to / 0.005));
  const top = Math.max(...slice);
  const above = slice.map((v, i) => (v >= share * top ? i : -1)).filter((i) => i >= 0);
  return above.length === 0 ? 0 : timeOf(above[above.length - 1] - above[0] + 1);
}

test("a heartbeat sounds like a chest: audible, never clipping, low, with the second sound in the right place", async ({ page }) => {
  await open(page);
  const beat = await render(page, { first: [[0.1, 1]], second: [[0.396, 0.78]], seconds: 1 });
  expect(beat.every(Number.isFinite)).toBe(true);
  const peak = peakOf(beat);
  test.info().annotations.push({
    type: "measured",
    description: `peak ${peak.toFixed(3)}; 30-450 Hz ${bandShare(beat, 30, 450).toFixed(3)}; 100-450 Hz ${bandShare(beat, 100, 450).toFixed(3)}; above 1 kHz ${bandShare(beat, 1000, 20000).toFixed(4)}`,
  });
  expect(peak, "too quiet to hear").toBeGreaterThan(0.12);
  expect(peak, "clipping").toBeLessThan(0.95);
  expect(Math.abs(beat.reduce((a, b) => a + b, 0) / beat.length), "a constant offset (a pop when it starts and stops)").toBeLessThan(0.005);
  // nothing before the first sound: no click or pop from a node starting late
  expect(peakOf(beat.subarray(0, Math.floor(0.095 * RATE)))).toBeLessThan(0.002);

  expect(bandShare(beat, 30, 450), "not low enough to be a chest").toBeGreaterThan(0.85);
  expect(bandShare(beat, 1000, 20000), "hissy or clicky").toBeLessThan(0.03);
  expect(bandShare(beat, 100, 450), "too little a laptop speaker can play").toBeGreaterThan(0.45);

  const env = envelope(beat);
  const top = Math.max(...env);
  expect(onset(env, 0, 0.1, top)).toBeGreaterThan(0.095);
  expect(onset(env, 0, 0.1, top)).toBeLessThan(0.115);
  const secondAt = onset(env, 0.32, 0.1, top);
  expect(secondAt).toBeGreaterThan(0.39);
  expect(secondAt).toBeLessThan(0.415);
  // the second sound is shorter than the first, and there is quiet between them
  expect(lasts(env, 0.35, 0.8, 0.1)).toBeLessThan(lasts(env, 0.09, 0.32, 0.1));
  const between = env.slice(Math.floor(0.3 / 0.005), Math.floor(0.38 / 0.005));
  expect(Math.max(...between)).toBeLessThan(0.2 * top);
});

test("a racing thump is shorter and softer than a first sound, and a shock is the loudest thing with a crackle in it", async ({ page }) => {
  await open(page);
  const first = await render(page, { first: [[0.1, 1]], seconds: 0.8 });
  const thump = await render(page, { thump: [[0.1, 0.45]], seconds: 0.8 });
  const shock = await render(page, { shock: [0.1], seconds: 1 });
  expect(peakOf(thump)).toBeLessThan(peakOf(first));
  expect(lasts(envelope(thump), 0.09, 0.7, 0.1)).toBeLessThan(lasts(envelope(first), 0.09, 0.7, 0.1));
  expect(peakOf(shock)).toBeGreaterThan(peakOf(first));
  expect(peakOf(shock), "clipping").toBeLessThan(0.98);
  test.info().annotations.push({ type: "measured", description: `shock peak ${peakOf(shock).toFixed(3)} vs first sound ${peakOf(first).toFixed(3)}; shock above 900 Hz ${bandShare(shock, 900, 20000).toFixed(3)}` });
  expect(bandShare(shock, 900, 20000), "no crackle").toBeGreaterThan(0.03);
  // it is over quickly
  const env = envelope(shock);
  expect(lasts(env, 0.09, 1, 0.05)).toBeLessThan(0.6);
});

test("writes WAV files to listen to when SOUND_PREVIEW_DIR is set", async ({ page }) => {
  const dir = process.env.SOUND_PREVIEW_DIR;
  test.skip(!dir, "set SOUND_PREVIEW_DIR to write preview WAV files");
  await open(page);
  const beats = (bpm: number, count: number, start: number): Score => {
    const gap = 60 / bpm;
    const systole = Math.min(0.36, Math.max(0.15, 0.16 + 0.17 * gap));
    return {
      first: Array.from({ length: count }, (_, i) => [start + i * gap, 1] as [number, number]),
      second: Array.from({ length: count }, (_, i) => [start + i * gap + systole, 0.78] as [number, number]),
      seconds: start + count * gap + 0.6,
    };
  };
  const files: Record<string, Score> = {
    "1-healthy-75bpm.wav": beats(75, 6, 0.2),
    "2-fast-150bpm.wav": beats(150, 10, 0.2),
    "3-racing-268bpm-one-thump-each.wav": { thump: Array.from({ length: 16 }, (_, i) => [0.2 + i * 0.224, 0.45] as [number, number]), seconds: 4.2 },
    "4-shock.wav": { shock: [0.3], seconds: 1.5 },
  };
  mkdirSync(dir as string, { recursive: true });
  for (const [name, score] of Object.entries(files)) {
    const samples = await render(page, score);
    const pcm = Buffer.alloc(44 + samples.length * 2);
    pcm.write("RIFF", 0);
    pcm.writeUInt32LE(36 + samples.length * 2, 4);
    pcm.write("WAVEfmt ", 8);
    pcm.writeUInt32LE(16, 16);
    pcm.writeUInt16LE(1, 20);
    pcm.writeUInt16LE(1, 22);
    pcm.writeUInt32LE(RATE, 24);
    pcm.writeUInt32LE(RATE * 2, 28);
    pcm.writeUInt16LE(2, 32);
    pcm.writeUInt16LE(16, 34);
    pcm.write("data", 36);
    pcm.writeUInt32LE(samples.length * 2, 40);
    samples.forEach((v, i) => pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
    writeFileSync(`${dir}/${name}`, pcm);
  }
});
