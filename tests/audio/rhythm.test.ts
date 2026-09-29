// The rhythm analyser against ECG recorded from the real simulation (fixtures/rhythms.json): the beats it finds, the
// extra beats it flags, the second heart sound it finds in the muscle, and the name it gives each rhythm.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BLANK_AFTER_DEFIBRILLATION_MS, RhythmAnalyzer, type BeatEvent, type RhythmState, type SecondSoundEvent } from "../../src/audio/rhythm";

interface Segment {
  name: string;
  ecg: number[][];
  fractions: number[][];
  beats: number[];
  extras: number[];
  shockAtMs: number | null;
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/rhythms.json", import.meta.url), "utf8")) as { scale: number; segments: Segment[] };
const segment = (name: string): Segment => {
  const s = fixture.segments.find((x) => x.name === name);
  if (!s) throw new Error(`no fixture segment called ${name}`);
  return s;
};

/**
 * Feed a segment to a fresh analyser the way the page does: fractions and samples in time order, and a reset when the shock happens.
 * `tamper` may swap what one sample or one fraction reads as (a bad readback), to see what the analyser does with it.
 */
function run(seg: Segment, tamper: { sample?: (index: number, tMs: number, leads: number[]) => [number, number[]]; fraction?: (index: number, value: number) => number } = {}) {
  const analyser = new RhythmAnalyzer();
  const beats: BeatEvent[] = [];
  const seconds: SecondSoundEvent[] = [];
  const changes: RhythmState[] = [];
  analyser.onBeat((e) => beats.push(e));
  analyser.onSecondSound((e) => seconds.push(e));
  analyser.onState((s) => changes.push(s));
  const readings: { t: number; state: RhythmState }[] = [];
  let f = 0;
  let shocked = seg.shockAtMs === null;
  for (const [index, row] of seg.ecg.entries()) {
    const t = row[0];
    // The page resets a few samples before the shock's own samples arrive: the readback lags the click.
    if (!shocked && seg.shockAtMs !== null && t >= seg.shockAtMs - 20) {
      analyser.reset(seg.shockAtMs, BLANK_AFTER_DEFIBRILLATION_MS);
      shocked = true;
    }
    while (f < seg.fractions.length && seg.fractions[f][0] <= t) {
      analyser.pushFraction(seg.fractions[f][0], tamper.fraction ? tamper.fraction(f, seg.fractions[f][1]) : seg.fractions[f][1]);
      f++;
    }
    const leads = row.slice(1).map((v) => v / fixture.scale);
    const [sampleT, sampleLeads] = tamper.sample ? tamper.sample(index, t, leads) : [t, leads];
    analyser.push(sampleT, sampleLeads);
    readings.push({ t, state: analyser.state });
  }
  const at = (t: number): RhythmState => readings.reduce((best, r) => (r.t <= t ? r : best), readings[0]).state;
  return { analyser, beats, seconds, changes, at };
}

const near = (events: { tMs: number }[], t: number, withinMs: number) => events.find((e) => e.tMs >= t - 5 && e.tMs <= t + withinMs);

describe("healthy beats", () => {
  const seg = segment("sinus");
  const { beats, seconds, at, changes } = run(seg);

  it("finds every beat within 90 ms of its start and nothing else", () => {
    expect(beats.length).toBe(seg.beats.length);
    for (const b of seg.beats) expect(near(beats, b, 90), `no beat near ${b} ms`).toBeDefined();
  });

  it("does not call a regular beat early", () => {
    expect(beats.filter((b) => b.premature)).toEqual([]);
  });

  it("reads steady, about 75 a minute, pumping, once it has seen a few beats", () => {
    const s = at(4400);
    expect(s.kind).toBe("steady");
    expect(s.bpm).toBeGreaterThan(73);
    expect(s.bpm).toBeLessThan(77);
    expect(s.output).toBeGreaterThan(0.9);
  });

  it("goes from quiet to steady once and does not flicker on the way there", () => {
    const kinds = changes.map((c) => c.kind).filter((k, i, all) => i === 0 || k !== all[i - 1]);
    expect(kinds.length).toBeLessThanOrEqual(2);
    expect(kinds[kinds.length - 1]).toBe("steady");
  });

  it("finds the second heart sound in the muscle, once per beat, about 0.3 s after the beat starts", () => {
    // the last beat in the segment has not finished contracting when the recording ends
    for (const b of seg.beats.slice(0, -1)) {
      const s = seconds.find((x) => Math.abs(x.beatMs - b) < 40);
      expect(s, `no second sound for the beat at ${b} ms`).toBeDefined();
      const after = (s as SecondSoundEvent).tMs - b;
      expect(after).toBeGreaterThan(250);
      expect(after).toBeLessThan(520);
      expect((s as SecondSoundEvent).premature).toBe(false);
    }
    // once the heart has settled to its steady rate the gap is steady too
    const settled = seconds.filter((x) => x.beatMs > 2000).map((x) => x.tMs - x.beatMs);
    expect(Math.max(...settled) - Math.min(...settled)).toBeLessThan(40);
    expect(Math.min(...settled)).toBeGreaterThan(280);
    expect(Math.max(...settled)).toBeLessThan(360);
  });
});

describe("extra beats", () => {
  for (const [name, coupling] of [
    ["extra beat, 550 ms", 550],
    ["extra beat, 680 ms", 680],
  ] as const) {
    describe(`an early beat ${coupling} ms after the last`, () => {
      const seg = segment(name);
      const extra = seg.extras[0];
      const { beats, seconds, at } = run(seg);

      it("is found and flagged early, and it is the only one flagged", () => {
        const found = near(beats, extra, 120) as BeatEvent | undefined;
        expect(found, "the extra beat was not found").toBeDefined();
        expect(found?.premature).toBe(true);
        expect(beats.filter((b) => b.premature).length).toBe(1);
      });

      it("is followed by a pause: the pacemaker's next beat, which falls in the recovery, does not take and makes no sound", () => {
        const blocked = seg.beats.filter((b) => b > extra && b < extra + 400);
        expect(blocked.length).toBeGreaterThan(0);
        for (const b of blocked) expect(near(beats, b, 150), `a beat was counted at ${b} ms, which did not take`).toBeUndefined();
        const next = seg.beats.find((b) => b > extra + 400) as number;
        expect(near(beats, next, 90), "the beat after the pause was missed").toBeDefined();
      });

      it("does not move the rate: the card keeps saying about 75 a minute through the early beat and the pause", () => {
        for (let t = extra + 200; t <= extra + 3000; t += 100) {
          const s = at(t);
          if (s.kind !== "steady") continue;
          expect(s.bpm, `rate at ${t} ms`).not.toBeNull();
          expect(s.bpm as number, `rate at ${t} ms`).toBeGreaterThan(72);
          expect(s.bpm as number, `rate at ${t} ms`).toBeLessThan(78);
        }
      });

      it("has its own, softer second sound", () => {
        const s = seconds.find((x) => Math.abs(x.beatMs - extra) < 130);
        expect(s, "no second sound for the extra beat").toBeDefined();
        expect((s as SecondSoundEvent).premature).toBe(true);
      });
    });
  }
});

describe("the racing rhythm", () => {
  const { beats, seconds, at } = run(segment("racing, then a shock"));

  it("reads racing, at the true rate of the wave (about 270 a minute), with little pumping", () => {
    const s = at(37800);
    expect(s.kind).toBe("racing");
    expect(s.bpm).toBeGreaterThan(250);
    expect(s.bpm).toBeLessThan(290);
    expect(s.output).toBeLessThan(0.3);
  });

  it("finds one beat per turn of the wave, evenly spaced, and no second sound: there is not time for one", () => {
    const inside = beats.filter((b) => b.tMs > 36000 && b.tMs < 38200).map((b) => b.tMs);
    const gaps = inside.slice(1).map((t, i) => t - inside[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(gaps.length).toBeGreaterThan(6);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.15 * mean);
    expect(seconds.filter((s) => s.tMs > 35000 && s.tMs < 38200)).toEqual([]);
  });

  it("reads quiet right after a shock, and the shock's flash is not a beat", () => {
    expect(at(38300).kind).toBe("quiet");
    expect(at(38900).kind).toBe("quiet");
    expect(beats.filter((b) => b.tMs > 38228)).toEqual([]);
    expect(seconds.filter((s) => s.tMs > 38228)).toEqual([]);
  });
});

describe("recovery after a whole-heart shock", () => {
  const seg = segment("recovery after a shock");
  const { beats, seconds, at } = run(seg);

  it("stays quiet through the flash and the pause: no beat, no sound, until the heart restarts", () => {
    const first = seg.beats[0];
    const shock = seg.shockAtMs as number;
    // (the segment starts while the racing rhythm is still running; what matters is everything after the shock)
    expect(beats.filter((b) => b.tMs > shock && b.tMs < first - 200)).toEqual([]);
    expect(seconds.filter((s) => s.tMs > shock && s.tMs < first)).toEqual([]);
    expect(at(first - 100).kind).toBe("quiet");
  });

  it("hears the first beat when it comes, and its second sound, and reads steady again", () => {
    const first = seg.beats[0];
    expect(near(beats, first, 90), "the first beat after the shock was missed").toBeDefined();
    const s = seconds.find((x) => Math.abs(x.beatMs - first) < 40);
    expect(s).toBeDefined();
    expect(at(44100).kind).toBe("steady");
    expect(at(44100).bpm).toBeGreaterThan(72);
    expect(at(44100).bpm).toBeLessThan(78);
  });
});

describe("the racing wave and fibrillation, when the bursts alone cannot tell them apart", () => {
  it("does not call evenly spaced bursts the racing wave when only a fifth of the muscle is firing", () => {
    const seg = segment("racing, then a shock");
    const quietFraction = { ...seg, fractions: seg.fractions.map(([t]) => [t, 0.15]) };
    expect(run(quietFraction).at(37800).kind).toBe("chaotic");
    expect(run(seg).at(37800).kind).toBe("racing");
  });
});

describe("fibrillation", () => {
  const { seconds, at } = run(segment("fibrillation"));

  it("reads chaotic, with no rate and almost no pumping, and has no second sound", () => {
    const s = at(60800);
    expect(s.kind).toBe("chaotic");
    expect(s.bpm).toBeNull();
    expect(s.output).toBeLessThan(0.2);
    expect(seconds).toEqual([]);
  });
});

describe("reset", () => {
  it("reads quiet at once and announces it", () => {
    const seg = segment("racing, then a shock");
    const { analyser, changes } = run(seg);
    const before = changes.length;
    analyser.reset(40000);
    expect(analyser.state.kind).toBe("quiet");
    expect(analyser.state.bpm).toBeNull();
    expect(changes.length).toBe(before); // already quiet: nothing new to announce
  });

  it("starts out quiet", () => {
    expect(new RhythmAnalyzer().state.kind).toBe("quiet");
  });
});

// The samples are read back from the graphics card. One bad one (a NaN or an infinity) must be skipped: taken in, it would
// sit in the running sums and in the memory of "the biggest recent burst" for good, and no beat would be found again
// until the next shock cleared them.
describe("a bad sample from the graphics card", () => {
  const seg = segment("sinus");
  const clean = run(seg);
  const bad = seg.ecg.findIndex((row) => row[0] >= 1500); // between two beats
  type Tamper = Parameters<typeof run>[1];
  const cases: [string, Tamper][] = [
    ["one lead is NaN", { sample: (i, t, leads) => [t, i === bad ? leads.map((v, k) => (k === 3 ? Number.NaN : v)) : leads] }],
    ["every lead is NaN", { sample: (i, t, leads) => [t, i === bad ? leads.map(() => Number.NaN) : leads] }],
    ["a lead is infinite", { sample: (i, t, leads) => [t, i === bad ? leads.map((v, k) => (k === 0 ? Infinity : v)) : leads] }],
    ["its time is NaN", { sample: (i, t, leads) => [i === bad ? Number.NaN : t, leads] }],
  ];

  for (const [name, tamper] of cases) {
    describe(`when ${name} in one sample`, () => {
      const r = run(seg, tamper);

      it("still finds every beat where it found it before, and no others", () => {
        expect(r.beats.length).toBe(clean.beats.length);
        r.beats.forEach((b, i) => expect(Math.abs(b.tMs - clean.beats[i].tMs), `beat ${i}`).toBeLessThanOrEqual(8));
      });

      it("keeps reading steady, about 75 a minute, pumping, with real numbers", () => {
        const s = r.at(4400);
        expect(s.kind).toBe("steady");
        expect(s.bpm).toBeGreaterThan(73);
        expect(s.bpm).toBeLessThan(77);
        expect(s.output).toBeGreaterThan(0.9);
      });
    });
  }

  it("also skips a share of the muscle that is not a number: the racing rhythm is still called racing", () => {
    const racing = segment("racing, then a shock");
    const r = run(racing, { fraction: (i, v) => (i % 4 === 0 ? Number.NaN : v) });
    expect(r.at(37800).kind).toBe("racing");
  });
});

// A tap on the heart can land just before the next steady beat. The tap's own beat and the steady beat that follows it
// then come close together, and the tissue can echo once more: in the real page, a tap 430 ms after the first steady
// beat gave beats at 304, 778 (the tap), 1114, 1398 (an echo) and 1946 ms. Two or three quick beats are not the racing wave.
describe("quick beats after a tap", () => {
  /** Synthetic ECG and muscle activity for beats at the given times: a steep burst about 60 ms wide, and the muscle firing for about 250 ms. */
  function synthetic(beatTimes: number[], endMs: number) {
    const analyser = new RhythmAnalyzer();
    const readings: { t: number; state: RhythmState }[] = [];
    for (let t = 0; t <= endMs; t += 4) {
      let v = 0;
      let fraction = 0;
      for (const b of beatTimes) {
        const dt = t - b;
        if (dt >= 0 && dt < 60) v += Math.sin((dt / 60) * Math.PI * 2);
        if (dt >= 0 && dt < 400) fraction = Math.max(fraction, dt < 30 ? (dt / 30) * 0.95 : 0.95 * Math.exp(-(dt - 30) / 90));
      }
      analyser.pushFraction(t, fraction);
      analyser.push(t, Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? v : -0.6 * v)));
      readings.push({ t, state: analyser.state });
    }
    return readings;
  }

  it("never reads racing, never states a wrong rate, and has the rate of about 75 a minute again once the beats settle", () => {
    const steadyBeats = [304, 1114, 1946, 2746, 3526, 4326, 5126, 5926, 6726];
    const withTap = [...steadyBeats, 778, 1398].sort((a, b) => a - b);
    const readings = synthetic(withTap, 7600);
    expect(readings.filter((r) => r.state.kind === "racing")).toEqual([]);
    // while the beats are still irregular the card may have no rate ("—"), but it never shows a wrong one
    for (const r of readings.filter((x) => x.state.kind === "steady" && x.state.bpm !== null)) {
      expect(r.state.bpm as number, `rate at ${r.t} ms`).toBeGreaterThan(70);
      expect(r.state.bpm as number, `rate at ${r.t} ms`).toBeLessThan(80);
    }
    const late = readings.filter((r) => r.t > 3800);
    expect(late.length).toBeGreaterThan(50);
    for (const r of late) {
      expect(r.state.kind).toBe("steady");
      expect(r.state.bpm, `no rate at ${r.t} ms`).not.toBeNull();
    }
  });

  it("still reads a sustained fast rhythm as racing, at its own rate, within a couple of seconds", () => {
    const wave: number[] = [];
    for (let t = 1000; t < 9000; t += 224) wave.push(t);
    const readings = synthetic([304, 1114, ...wave], 9000);
    const at = (t: number) => readings.reduce((best, r) => (r.t <= t ? r : best), readings[0]).state;
    // (the detector needs a few turns to lock on to a rate this fast, so the name comes a moment after the wave starts)
    expect(at(4000).kind).toBe("racing");
    expect(at(4000).bpm as number).toBeGreaterThan(255);
    expect(at(4000).bpm as number).toBeLessThan(280);
    expect(at(8000).kind).toBe("racing");
  });
});
