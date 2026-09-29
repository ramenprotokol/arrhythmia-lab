// The sounds themselves, made from scratch with the Web Audio API (no audio files): the first and second heart sound,
// a single thump for a very fast rhythm, and the thud and crackle of a shock. Fibrillation has no sound: there is no heartbeat to hear.
// Every function takes the audio-clock time to start at, so the same code plays live and renders offline for tests.
//
// A real heart sound is low: most of a "lub" sits between 25 and 150 Hz, and a laptop speaker cannot play much below
// 100 Hz. So each sound is a low body plus higher partials (about twice and four times the body's pitch) that the
// speaker can play and the ear still hears as the same low thump, plus a short burst of filtered noise for the valves.

export interface Bus {
  ctx: BaseAudioContext;
  /** Where every voice sends its sound. */
  out: AudioNode;
  /** A second way out that skips the soft low-pass, for sounds that must stay bright (the crackle of a shock). Falls back to `out`. */
  bright?: AudioNode;
  /** One second of white noise, shared by every voice that needs noise. */
  noise: AudioBuffer;
}

/** One second of white noise, made once per audio context. */
export function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // A fixed seed, so a rendered test signal is the same every run.
  let seed = 0x2f6e2b1;
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    data[i] = (seed >>> 8) / 0x800000 - 1;
  }
  return buffer;
}

const SILENT = 0.0001;

/** Swell to `peak` over `attack` seconds, then die away over `decay` seconds. */
function shape(param: AudioParam, when: number, peak: number, attack: number, decay: number): void {
  param.setValueAtTime(SILENT, when);
  param.exponentialRampToValueAtTime(Math.max(SILENT * 2, peak), when + attack);
  param.exponentialRampToValueAtTime(SILENT, when + attack + decay);
}

interface ToneSpec {
  from: number;
  to: number;
  sweepS: number;
  peak: number;
  attack: number;
  decay: number;
  type?: OscillatorType;
}

/** A pitched thump: a sine that slides down a little as it dies away, the way a tightening chamber does. */
function tone(bus: Bus, when: number, spec: ToneSpec): void {
  const osc = bus.ctx.createOscillator();
  osc.type = spec.type ?? "sine";
  osc.frequency.setValueAtTime(spec.from, when);
  osc.frequency.exponentialRampToValueAtTime(spec.to, when + spec.sweepS);
  const gain = bus.ctx.createGain();
  shape(gain.gain, when, spec.peak, spec.attack, spec.decay);
  osc.connect(gain);
  gain.connect(bus.out);
  osc.start(when);
  osc.stop(when + spec.attack + spec.decay + 0.05);
}

interface BurstSpec {
  filter: BiquadFilterType;
  centre: number;
  q: number;
  peak: number;
  attack: number;
  decay: number;
}

/** A short burst of filtered noise: the valves, the click, the crackle. `bright` skips the chest low-pass. */
function burst(bus: Bus, when: number, spec: BurstSpec, bright = false): void {
  const src = bus.ctx.createBufferSource();
  src.buffer = bus.noise;
  const filter = bus.ctx.createBiquadFilter();
  filter.type = spec.filter;
  filter.frequency.value = spec.centre;
  filter.Q.value = spec.q;
  const gain = bus.ctx.createGain();
  shape(gain.gain, when, spec.peak, spec.attack, spec.decay);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(bright ? (bus.bright ?? bus.out) : bus.out);
  // Start at different places in the noise so two bursts never sound identical.
  src.start(when, ((when * 7.13) % 0.5));
  src.stop(when + spec.attack + spec.decay + 0.05);
}

/** "Lub": the first heart sound, the valves between the atria and the ventricles closing as the ventricles squeeze. Lower and longer. */
export function playFirstSound(bus: Bus, when: number, strength: number): void {
  const s = Math.max(0, Math.min(1, strength));
  tone(bus, when, { from: 78, to: 52, sweepS: 0.11, peak: 0.6 * s, attack: 0.007, decay: 0.16 });
  tone(bus, when, { from: 156, to: 104, sweepS: 0.09, peak: 0.7 * s, attack: 0.006, decay: 0.12 });
  tone(bus, when, { from: 234, to: 156, sweepS: 0.08, peak: 0.4 * s, attack: 0.006, decay: 0.09 });
  tone(bus, when, { from: 312, to: 208, sweepS: 0.06, peak: 0.18 * s, attack: 0.005, decay: 0.06, type: "triangle" });
  burst(bus, when, { filter: "bandpass", centre: 150, q: 1.1, peak: 0.6 * s, attack: 0.006, decay: 0.1 });
  burst(bus, when, { filter: "highpass", centre: 400, q: 0.7, peak: 0.18 * s, attack: 0.002, decay: 0.02 });
}

/** "Dub": the second heart sound, the valves leading out of the ventricles closing as they relax. Higher, shorter, crisper. */
export function playSecondSound(bus: Bus, when: number, strength: number): void {
  const s = Math.max(0, Math.min(1, strength));
  tone(bus, when, { from: 105, to: 78, sweepS: 0.07, peak: 0.5 * s, attack: 0.004, decay: 0.1 });
  tone(bus, when, { from: 210, to: 156, sweepS: 0.06, peak: 0.55 * s, attack: 0.004, decay: 0.08 });
  tone(bus, when, { from: 315, to: 234, sweepS: 0.05, peak: 0.25 * s, attack: 0.004, decay: 0.06 });
  burst(bus, when, { filter: "bandpass", centre: 190, q: 1.4, peak: 0.4 * s, attack: 0.004, decay: 0.07 });
  burst(bus, when, { filter: "highpass", centre: 500, q: 0.7, peak: 0.22 * s, attack: 0.002, decay: 0.015 });
}

/** One short thump per turn of the wave, for a rhythm too fast to hold two separate sounds. */
export function playThump(bus: Bus, when: number, strength: number): void {
  const s = Math.max(0, Math.min(1, strength));
  tone(bus, when, { from: 92, to: 62, sweepS: 0.06, peak: 0.7 * s, attack: 0.005, decay: 0.09 });
  tone(bus, when, { from: 184, to: 124, sweepS: 0.05, peak: 0.4 * s, attack: 0.004, decay: 0.07 });
  burst(bus, when, { filter: "bandpass", centre: 140, q: 1.2, peak: 0.35 * s, attack: 0.004, decay: 0.06 });
}

/** The thud of the paddles and the crackle of the discharge. */
export function playShock(bus: Bus, when: number): void {
  tone(bus, when, { from: 95, to: 32, sweepS: 0.22, peak: 1, attack: 0.004, decay: 0.3 });
  tone(bus, when, { from: 190, to: 64, sweepS: 0.2, peak: 0.45, attack: 0.004, decay: 0.2 });
  burst(bus, when, { filter: "highpass", centre: 900, q: 0.7, peak: 0.6, attack: 0.001, decay: 0.09 }, true);
  burst(bus, when + 0.01, { filter: "bandpass", centre: 3000, q: 0.8, peak: 0.25, attack: 0.002, decay: 0.25 }, true);
}
