import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { LESSONS, LESSON_SETTINGS } from "../../src/lessons/lessons";
import { LessonRunner, type LabApi, type Lesson } from "../../src/lessons/runner";
import * as R from "../../src/lessons/recipes";
import { PACEMAKER_PERIOD_MS } from "../../src/lab/engine";
import { parseHeart } from "../../src/data/loadHeart";
import { APEX } from "../gpu/frame";

const S = LESSON_SETTINGS;
const allText = (l: Lesson) => [l.title, l.summary, ...l.steps.flatMap((s) => [s.title ?? "", s.text, s.hint ?? ""])];
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const lesson = (id: string): Lesson => {
  const l = LESSONS.find((x) => x.id === id);
  if (!l) throw new Error(`no lesson ${id}`);
  return l;
};

describe("lessons: the data", () => {
  it("has the five lessons, in teaching order", () => {
    expect(LESSONS.map((l) => l.id)).toEqual(["normal-beat", "extra-beat", "tachycardia", "fibrillation", "shock"]);
    expect(LESSONS.map((l) => l.title)).toEqual([
      "Normal beat",
      "An extra beat (PVC)",
      "Sustained tachycardia",
      "Break into fibrillation",
      "Shock it back",
    ]);
  });

  it("gives every lesson a title, a summary, at least 3 steps, and text in every step", () => {
    for (const l of LESSONS) {
      expect(l.title.trim().length, l.id).toBeGreaterThan(0);
      expect(l.summary.trim().length, l.id).toBeGreaterThan(0);
      expect(l.steps.length, l.id).toBeGreaterThanOrEqual(3);
      l.steps.forEach((s, i) => expect(s.text.trim().length, `${l.id} step ${i}`).toBeGreaterThan(0));
    }
  });

  it("uses each lesson id once and each step title once within a lesson", () => {
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(LESSONS.length);
    for (const l of LESSONS) {
      const titles = l.steps.map((s) => s.title);
      expect(titles.every((t) => typeof t === "string" && t.length > 0), l.id).toBe(true);
      expect(new Set(titles).size, l.id).toBe(titles.length);
    }
  });

  it("ends every lesson with a short 'What you learned'", () => {
    for (const l of LESSONS) {
      const last = l.steps[l.steps.length - 1];
      expect(last.title, l.id).toBe("What you learned");
      expect(last.text.length, l.id).toBeLessThanOrEqual(420);
      expect(last.waitFor, `${l.id} must be left with the Next button`).toBeUndefined();
    }
  });

  it("says in every lesson, on its first step, that this is an idealised simulation", () => {
    for (const l of LESSONS) expect(l.steps[0].text, l.id).toMatch(/idealised simulation/i);
  });

  it("tells the viewer, on the first step, that the pacemaker was paused, because the lab starts with it running", () => {
    for (const l of LESSONS) expect(l.steps[0].text, l.id).toMatch(/paused the pacemaker, the part that (normally )?fires a steady beat/);
  });

  it("keeps each step short enough to read on a phone", () => {
    for (const l of LESSONS) l.steps.forEach((s, i) => expect(s.text.length, `${l.id} step ${i}`).toBeLessThanOrEqual(520));
  });

  it("keeps the caption of a step that moves on by itself short enough to read before it goes", () => {
    // 20 words when it can go after a moment; 40 when it stays for four seconds of simulated time or more
    for (const l of LESSONS)
      for (const [i, s] of l.steps.entries())
        if (s.waitFor) expect(words(s.text), `${l.id} step ${i}: "${s.text}"`).toBeLessThanOrEqual((s.minMs ?? 0) >= 4000 ? 40 : 20);
  });

  it("uses plain English: short sentences", () => {
    for (const l of LESSONS)
      for (const text of allText(l))
        for (const sentence of text.split(/(?<=[.!?])\s+/)) expect(words(sentence), `${l.id}: "${sentence}"`).toBeLessThanOrEqual(32);
  });

  it("avoids jargon that is never explained, and never gives advice or diagnoses", () => {
    const jargon =
      /\b(refractory|repolari[sz]ation|depolari[sz]ation|action potential|ectopic|myocardi\w*|anisotropi\w*|ischemi\w*|infarct\w*|re-?entry|vulnerable window|sinus rhythm)\b/i;
    const advice = /\b(diagnos\w*|treatment|therapy|medical advice|your heart|you have)\b/i;
    for (const l of LESSONS)
      for (const text of allText(l)) {
        expect(text, `${l.id} jargon`).not.toMatch(jargon);
        expect(text, `${l.id} advice`).not.toMatch(advice);
      }
  });

  it("does not say which way the ECG trace points, or call it a spike: on the real ECG a normal beat dips and then rises in a rounded wave", () => {
    for (const l of LESSONS)
      for (const text of allText(l)) expect(text, l.id).not.toMatch(/\b(spikes?|upward|downward|upright|positive|negative|tall)\b/i);
  });

  it("explains each medical word where it first appears in a lesson", () => {
    const explained: [RegExp, RegExp][] = [
      [/\bPVC\b/, /premature ventricular contraction[^.]*\. It just means an early extra beat/],
      [/\btachycardia\b/i, /fast rhythm like this is called tachycardia/],
      [/\bfibrillation\b/i, /This is called fibrillation|Fibrillation is when many small waves wander over the heart at once/],
      [/\bQRS\b/, /sharp swing \(doctors call it the QRS complex\)/],
      [/\bpacemaker\b/i, /pacemaker(,| \()? ?(the part that|which) (normally )?fires a steady beat/],
    ];
    for (const l of LESSONS) {
      const steps = l.steps.map((s) => s.text);
      for (const [word, gloss] of explained) {
        const first = steps.findIndex((t) => word.test(t));
        if (first >= 0) expect(steps[first], `${l.id}: first use of ${word}`).toMatch(gloss);
      }
    }
  });

  it("gives every step that waits for the simulation a hint for a stuck viewer, and the hint names a control that exists", () => {
    const page = readFileSync("src/dom.ts", "utf8");
    for (const l of LESSONS)
      for (const [i, s] of l.steps.entries())
        if (s.waitFor) {
          expect(s.hint?.trim().length ?? 0, `${l.id} step ${i}`).toBeGreaterThan(0);
          expect(s.hint, `${l.id} step ${i}`).toMatch(/Skip|Shock button/);
        }
    // the words the lessons use for the page's own controls are the words on the page
    const names: [string, string][] = [
      ["Skip", "Skip"],
      ["Restart", "Restart"],
      ["Extra beat", "Extra beat"],
      ["Fast pacing burst", "Fast pacing burst"],
      ["Shock", "Shock"],
      ["the S key", "Key: S"],
      ["Conduction speed", "Conduction speed"],
      ["Recovery time", "Recovery time"],
    ];
    for (const l of LESSONS)
      for (const text of allText(l))
        for (const [said, onPage] of names) if (text.includes(said)) expect(page, `"${said}" in ${l.id}`).toContain(onPage);
  });

  it("is honest about what the lab does for the viewer", () => {
    const text = (id: string) =>
      lesson(id)
        .steps.map((s) => s.text)
        .join(" ");
    // tachycardia: the timing is the point, and the lab tries a few for you
    expect(text("tachycardia")).toMatch(/early beat at the wrong moment, in a heart with short waves, can start a wave that keeps circling/);
    expect(text("tachycardia")).toMatch(/exact moment matters/);
    expect(text("tachycardia")).toMatch(/tries a few (different )?timings for you/);
    const induce = lesson("tachycardia").steps.find((s) => s.title === "A beat, then an early one");
    expect(induce?.hint).toMatch(/timings/);
    expect(induce?.hint).toMatch(/Skip/);
    // fibrillation: a burst of fast beats, not one early beat
    expect(text("fibrillation")).toMatch(/burst of (very )?fast beats/);
    expect(text("fibrillation")).toMatch(/about ten a second/);
    expect(text("fibrillation")).toMatch(/how (the lab starts|fibrillation is (started|provoked))/i);
    expect(text("fibrillation"), "one early beat no longer starts fibrillation").not.toMatch(/early (extra )?beat/i);
    // the extra-beat lesson gives the two gaps it really gives
    expect(text("extra-beat")).toMatch(/0\.8 seconds/);
    expect(text("extra-beat")).toMatch(/half a second/);
    // the shock lesson asks the viewer to press the button
    const shock = lesson("shock").steps.find((s) => s.title === "Shock");
    expect(shock?.text).toMatch(/press the amber Shock button/i);
    expect(shock?.text).toMatch(/the S key/);
    expect(shock?.hint).toMatch(/amber Shock button/);
  });
});

describe("lessons: the settings they rely on", () => {
  it("keeps only timings in LESSON_SETTINGS: the tuned values are read from recipes.ts", () => {
    for (const [name, value] of Object.entries(S)) expect(typeof value, name).toBe("number");
    expect(Object.keys(S).some((k) => /recipe|apex/i.test(k))).toBe(false);
  });

  it("uses the lab's own pacemaker period for the steady gap between beats", () => {
    expect(S.steadyGapMs).toBe(PACEMAKER_PERIOD_MS);
  });

  it("makes true what the lessons say about the sliders: each recipe lowers both, and fibrillation goes lower again", () => {
    expect(R.TACHYCARDIA_TISSUE.recovery).toBeLessThan(R.NORMAL_TISSUE.recovery);
    expect(R.TACHYCARDIA_TISSUE.conduction).toBeLessThan(R.NORMAL_TISSUE.conduction);
    expect(R.FIBRILLATION_TISSUE.recovery).toBeLessThan(R.TACHYCARDIA_TISSUE.recovery);
    expect(R.FIBRILLATION_TISSUE.conduction).toBeLessThan(R.TACHYCARDIA_TISSUE.conduction);
  });

  it("gives the extra beat before the next steady beat is due, but after the muscle has finished resetting", () => {
    expect(R.PVC_EXTRA_BEAT_MS).toBeGreaterThanOrEqual(550);
    expect(R.PVC_EXTRA_BEAT_MS).toBeLessThan(S.steadyGapMs);
  });

  it("describes the burst that starts fibrillation truthfully: about ten beats a second", () => {
    for (const burst of R.FIBRILLATION_BURSTS) {
      expect(burst.periodMs).toBeGreaterThanOrEqual(90);
      expect(burst.periodMs).toBeLessThanOrEqual(110);
    }
  });

  it("paces at the true apex, which is muscle, and which is not what a guess from the heart's shape gives", () => {
    expect(R.APEX).toEqual(APEX);
    const raw = readFileSync("public/data/heart.bin");
    const grid = parseHeart(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const [x, y, z] = R.APEX;
    expect(grid.tissue[x + grid.nx * (y + grid.ny * z)]).toBeGreaterThan(0);
  });
});

// A stand-in for the lab with the rules the lessons rely on: a pacemaker that runs from the start and fires every
// 800 ms while it is on, a wave that is over 470 ms after a beat, and an `induce` that takes 3 s and then leaves a
// wave that never ends (or fails). A shock ends every wave.
function fakeHeart(opts: { canInduce?: boolean; pacemaker?: boolean; circling?: boolean } = {}) {
  const canInduce = opts.canInduce ?? true;
  type Call = { name: string; at: number; active: number; since: number; arg?: unknown };
  const calls: Call[] = [];
  const stimuli: { kind: "pacemaker" | "pace" | "extra"; at: number }[] = [];
  let now = 0;
  let pacemaker = opts.pacemaker ?? true;
  let nextBeat = 300;
  let lastBeat = -Infinity;
  let wave: { start: number; circling: boolean } | null = opts.circling ? { start: -5000, circling: true } : null;
  let induction: { kind: string; startedAt: number; done: boolean } | null = null;

  const active = (): number => {
    if (!wave) return 0;
    const dt = now - wave.start;
    if (wave.circling) return dt < 300 ? Math.min(1, dt / 200) : 0.45;
    return dt < 470 ? Math.min(1, dt / 200) : 0;
  };
  const note = (name: string, arg?: unknown) => calls.push({ name, at: now, active: active(), since: now - lastBeat, arg });
  const deliver = (kind: "pacemaker" | "pace" | "extra", circling = false) => {
    stimuli.push({ kind, at: now });
    lastBeat = now;
    wave = { start: now, circling };
  };
  const status = (): "idle" | "running" | "success" | "failed" => {
    if (!induction) return "idle";
    if (now - induction.startedAt < 3000) return "running";
    return canInduce ? "success" : "failed";
  };

  const api: LabApi = {
    pace: (v) => {
      note("pace", v);
      deliver("pace");
    },
    prematureBeat: () => {
      note("premature");
      deliver("extra");
    },
    shock: () => {
      note("shock"); // the lesson itself shocked the heart
      wave = null;
      nextBeat = now + 1500;
    },
    setTissue: (t) => note("tissue", { ...t }),
    activeFraction: active,
    simTimeMs: () => now,
    setPacemaker: (on) => {
      note(on ? "pacemaker on" : "pacemaker off");
      pacemaker = on;
      nextBeat = now + 400;
    },
    burstPace: (beats, periodMs) => note("burst", { beats, periodMs }),
    lastBeatMs: () => lastBeat,
    induce: (kind) => {
      note("induce", kind);
      pacemaker = false;
      induction = { kind, startedAt: now, done: false };
    },
    induceStatus: status,
  };

  const advance = (ms: number) => {
    now += ms;
    if (pacemaker && now >= nextBeat) {
      deliver("pacemaker");
      nextBeat = now + PACEMAKER_PERIOD_MS;
    }
    // a lab that has started a rhythm delivers its beats over the first 0.7 s; a wave that circles is what is left
    if (induction && !induction.done && now >= induction.startedAt + 700) {
      induction.done = true;
      lastBeat = now;
      wave = { start: now, circling: canInduce };
    }
  };
  return {
    api,
    calls,
    stimuli,
    advance,
    now: () => now,
    // the viewer pressing the Shock button: the same effect, but the log says who did it
    viewerShock: () => {
      note("shock by viewer");
      wave = null;
      nextBeat = now + 1500;
    },
  };
}

type Heart = ReturnType<typeof fakeHeart>;

// A viewer who reads for a while on each manual step (5 frames unless told otherwise) and then presses Next, and who
// presses the Shock button a moment after the lesson asks for it (unless told not to).
function playThrough(id: string, heart: Heart, opts: { maxFrames?: number; readFrames?: number; pressShock?: boolean } = {}) {
  const runner = new LessonRunner(LESSONS, heart.api);
  const moves: { to: string | null; at: number }[] = [];
  runner.onChange(() => moves.push({ to: runner.state.step?.title ?? null, at: heart.now() }));
  runner.start(id);
  let read = 0;
  let asked = 0;
  let pressed = false;
  let frames = 0;
  while (!runner.state.finished && frames < (opts.maxFrames ?? 4000)) {
    frames++;
    heart.advance(16);
    runner.tick();
    const step = runner.state.step;
    if (step && !step.waitFor && ++read >= (opts.readFrames ?? 5)) {
      read = 0;
      runner.next();
    }
    if (step?.title === "Shock" && (opts.pressShock ?? true) && !pressed && ++asked >= 8) {
      pressed = true;
      heart.viewerShock();
    }
  }
  return { runner, frames, moves };
}

const names = (heart: Heart) => heart.calls.map((c) => c.name);
const firstTick = (id: string, heart: Heart) => {
  const runner = new LessonRunner(LESSONS, heart.api);
  runner.start(id);
  runner.tick();
  return runner;
};

describe("lessons: playing each one through against a stand-in lab", () => {
  it("every lesson finishes, in well under a minute of simulated time", () => {
    for (const l of LESSONS) {
      const heart = fakeHeart();
      const { runner, frames } = playThrough(l.id, heart);
      expect(runner.state.finished, l.id).toBe(true);
      expect(frames * 16, `${l.id} sim ms`).toBeLessThan(60_000);
    }
  });

  it("the first step of every lesson pauses the pacemaker, which the lab starts with running", () => {
    for (const l of LESSONS) {
      const heart = fakeHeart({ pacemaker: true });
      firstTick(l.id, heart);
      expect(names(heart), l.id).toContain("pacemaker off");
      expect(heart.stimuli, `${l.id}: no beat is given before the viewer has read the first step`).toEqual([]);
    }
  });

  it("the first step of the normal beat, extra beat and shock lessons also sets healthy tissue", () => {
    for (const id of ["normal-beat", "extra-beat", "shock"]) {
      const heart = fakeHeart();
      firstTick(id, heart);
      const tissue = heart.calls.filter((c) => c.name === "tissue");
      expect(
        tissue.map((c) => c.arg),
        id,
      ).toEqual([R.NORMAL_TISSUE]);
    }
  });

  it("normal beat: pauses the pacemaker, gives one beat at the apex, then puts the pacemaker back", () => {
    const heart = fakeHeart();
    playThrough("normal-beat", heart);
    expect(names(heart)).toEqual(["pacemaker off", "tissue", "pace", "pacemaker on"]);
    expect(heart.calls[1].arg).toEqual(R.NORMAL_TISSUE);
    expect(heart.calls[2].arg).toEqual(APEX);
    expect(heart.stimuli.filter((s) => s.kind === "pace")).toHaveLength(1);
    expect(heart.stimuli.filter((s) => s.at < heart.calls[3].at).map((s) => s.kind)).toEqual(["pace"]);
  });

  it("extra beat: two steady beats a steady gap apart, then an extra beat the muscle has just had time to recover for", () => {
    for (const readFrames of [1, 5, 9, 14, 20, 27, 33, 41]) {
      const heart = fakeHeart();
      playThrough("extra-beat", heart, { readFrames });
      const n = names(heart);
      expect(n, `read for ${readFrames} frames`).toEqual(["pacemaker off", "tissue", "pace", "pace", "premature", "pacemaker on"]);
      const [one, two, extra] = heart.stimuli.slice(0, 3);
      expect([one.kind, two.kind, extra.kind]).toEqual(["pace", "pace", "extra"]);
      const steady = two.at - one.at;
      const early = extra.at - two.at;
      expect(steady, `read for ${readFrames} frames`).toBeGreaterThanOrEqual(S.steadyGapMs - 2);
      expect(steady, `read for ${readFrames} frames`).toBeLessThan(S.steadyGapMs + 40);
      expect(early, `read for ${readFrames} frames`).toBeGreaterThanOrEqual(R.PVC_EXTRA_BEAT_MS);
      expect(early, `read for ${readFrames} frames`).toBeLessThan(R.PVC_EXTRA_BEAT_MS + 40);
      expect(early).toBeLessThan(steady); // early: before the next steady beat was due
      expect(heart.calls.filter((c) => c.name === "pace").map((c) => c.arg)).toEqual([APEX, APEX]);
    }
  });

  it("extra beat: no beat is given by the pacemaker while the lesson is timing its own", () => {
    const heart = fakeHeart();
    playThrough("extra-beat", heart);
    const end = heart.calls.find((c) => c.name === "pacemaker on")!.at;
    expect(heart.stimuli.filter((s) => s.at < end).map((s) => s.kind)).toEqual(["pace", "pace", "extra"]);
  });

  it("tachycardia: shorter waves, an explanation of the timing, then one call to the lab, and a rhythm watched for a while", () => {
    const heart = fakeHeart();
    const { runner, moves } = playThrough("tachycardia", heart);
    const n = names(heart);
    expect(n.filter((x) => x === "induce")).toHaveLength(1);
    const induce = heart.calls.find((c) => c.name === "induce")!;
    expect(induce.arg).toBe("tachycardia");
    expect(heart.calls.filter((c) => c.name === "tissue").pop()?.arg).toEqual(R.TACHYCARDIA_TISSUE);
    expect(n.indexOf("tissue")).toBeLessThan(n.indexOf("induce"));
    expect(n.indexOf("pacemaker off")).toBeLessThan(n.indexOf("tissue"));
    // the lab times the beats, so the lesson gives none of its own
    expect(n).not.toContain("premature");
    expect(n).not.toContain("pace");
    // the lesson moves on when the lab says it took (3 s in the stand-in), and stays on the circling wave for a while
    const learned = moves.find((m) => m.to === "What you learned");
    expect((learned?.at ?? 0) - induce.at).toBeGreaterThanOrEqual(3000 + S.keepsGoingMs);
    expect(runner.state.finished).toBe(true);
  });

  it("tachycardia and fibrillation: if the lab cannot start the rhythm, the lesson waits, and says what is happening", () => {
    for (const id of ["tachycardia", "fibrillation"]) {
      const heart = fakeHeart({ canInduce: false });
      const { runner } = playThrough(id, heart, { maxFrames: 3000 });
      expect(runner.state.finished, id).toBe(false);
      const step = runner.state.step;
      expect(step?.waitFor, id).toBeDefined();
      expect(step?.hint, id).toMatch(/Skip/);
      expect(step?.hint, id).toMatch(/timings|bursts/);
      expect(names(heart), id).not.toContain("shock");
    }
  });

  it("tachycardia and fibrillation: a step that says the wave keeps going waits until it does", () => {
    for (const [id, title] of [
      ["tachycardia", "A wave that keeps going"],
      ["fibrillation", "What you are seeing"],
    ] as const) {
      // a rhythm that the lab starts and then loses again: the lesson must not carry on as if it were still going
      const heart = fakeHeart();
      const runner = new LessonRunner(LESSONS, heart.api);
      runner.start(id);
      let frames = 0;
      let cut = false;
      while (!runner.state.finished && frames++ < 4000) {
        heart.advance(16);
        runner.tick();
        if (runner.state.step?.title === title && !cut) {
          cut = true;
          heart.viewerShock(); // the wave stops
        }
        if (runner.state.step && !runner.state.step.waitFor && frames % 5 === 0) runner.next();
      }
      expect(cut, id).toBe(true);
      expect(runner.state.step?.title ?? "finished", id).toBe(title); // still waiting for a wave that is gone
    }
  });

  it("leaves a rhythm the viewer left circling to be shocked to rest before the other lessons begin", () => {
    for (const id of ["normal-beat", "extra-beat", "tachycardia", "fibrillation"]) {
      const heart = fakeHeart({ pacemaker: false, circling: true });
      heart.advance(2000);
      firstTick(id, heart);
      expect(names(heart)[0], id).toBe("shock");
    }
  });

  it("does not shock a healthy heart that is simply beating when a lesson starts", () => {
    for (const l of LESSONS) {
      const heart = fakeHeart({ pacemaker: true });
      heart.advance(350); // the first beat fires
      heart.advance(100); // and its wave is now crossing the heart
      expect(heart.api.activeFraction()).toBeGreaterThan(S.activeAbove);
      firstTick(l.id, heart);
      expect(names(heart), l.id).not.toContain("shock");
    }
  });

  it("fibrillation: shorter waves, an explanation of the burst, then one call to the lab, and the rhythm watched for a while", () => {
    const heart = fakeHeart();
    const { runner, moves } = playThrough("fibrillation", heart);
    const n = names(heart);
    const induce = heart.calls.find((c) => c.name === "induce")!;
    expect(induce.arg).toBe("fibrillation");
    expect(heart.calls.filter((c) => c.name === "tissue").pop()?.arg).toEqual(R.FIBRILLATION_TISSUE);
    expect(n.indexOf("tissue")).toBeLessThan(n.indexOf("induce"));
    expect(n).not.toContain("premature");
    expect(n).not.toContain("pace");
    const learned = moves.find((m) => m.to === "What you learned");
    expect((learned?.at ?? 0) - induce.at).toBeGreaterThanOrEqual(3000 + S.seeingMs);
    expect(runner.state.finished).toBe(true);
  });

  it("shock: the lab sets up fibrillation, the viewer shocks it, and the steady rhythm comes back", () => {
    const heart = fakeHeart();
    const { runner } = playThrough("shock", heart);
    expect(names(heart)).toEqual(["pacemaker off", "tissue", "induce", "shock by viewer", "tissue", "pacemaker on"]);
    expect(heart.calls[1].arg).toEqual(R.NORMAL_TISSUE);
    expect(heart.calls[2].arg).toBe("fibrillation");
    const shock = heart.calls.find((c) => c.name === "shock by viewer")!;
    expect(shock.active, "the viewer shocked a heart that was in trouble").toBeGreaterThan(S.activeAbove);
    expect(heart.calls.filter((c) => c.name === "tissue")[1].arg).toEqual(R.NORMAL_TISSUE);
    expect(names(heart), "the lesson never presses Shock for the viewer").not.toContain("shock");
    // the normal rhythm resumes by itself, and the lesson stays long enough to show it
    const back = heart.calls.find((c) => c.name === "pacemaker on")!;
    const beatsAfter = heart.stimuli.filter((s) => s.kind === "pacemaker" && s.at > back.at);
    expect(beatsAfter.length).toBeGreaterThanOrEqual(2);
    expect(heart.stimuli.filter((s) => s.kind === "pace")).toEqual([]);
    expect(runner.state.finished).toBe(true);
  });

  it("shock: waits for the viewer to press the button, and says so", () => {
    const heart = fakeHeart();
    const { runner } = playThrough("shock", heart, { pressShock: false, maxFrames: 2500 });
    expect(runner.state.finished).toBe(false);
    expect(runner.state.step?.title).toBe("Shock");
    expect(runner.state.step?.text).toMatch(/press the amber Shock button/i);
    expect(runner.state.step?.hint).toMatch(/amber Shock button/);
    expect(names(heart)).not.toContain("shock");
  });

  it("shock: if the heart is already in a rhythm when the lesson starts, it is left running, not started again", () => {
    const heart = fakeHeart({ pacemaker: false, circling: true });
    heart.advance(2000);
    const { runner } = playThrough("shock", heart);
    expect(names(heart)).not.toContain("induce");
    expect(names(heart)).not.toContain("shock"); // the lesson does not shock it away at the start either
    expect(names(heart)).toContain("shock by viewer");
    expect(runner.state.finished).toBe(true);
  });

  it("shock: a normal beat whose wave is merely in flight is not mistaken for a rhythm, so the heart is still set up", () => {
    // start the lesson while the pacemaker's beat is crossing the heart, and press Next at once
    const heart = fakeHeart({ pacemaker: true });
    heart.advance(350); // the first beat fires
    heart.advance(100); // and its wave is crossing the heart
    expect(heart.api.activeFraction()).toBeGreaterThan(S.goingAbove);
    const { runner } = playThrough("shock", heart, { readFrames: 2 });
    expect(names(heart)).toContain("induce");
    expect(runner.state.finished).toBe(true);
    // and the Shock step was not passed just because that wave ended: the viewer's shock came first
    const induce = heart.calls.find((c) => c.name === "induce")!;
    const shock = heart.calls.find((c) => c.name === "shock by viewer")!;
    expect(shock.at).toBeGreaterThanOrEqual(induce.at + 3000);
  });

  it("shock: if the lab cannot start the fibrillation the lesson waits, and says what to do", () => {
    const heart = fakeHeart({ canInduce: false });
    const { runner } = playThrough("shock", heart, { maxFrames: 3000 });
    expect(runner.state.finished).toBe(false);
    expect(runner.state.step?.title).toBe("Setting up");
    expect(runner.state.step?.hint).toMatch(/Skip/);
  });

  it("only the extra-beat lesson gives early beats by hand, and only the normal beat and extra beat lessons give beats at all", () => {
    for (const l of LESSONS) {
      const heart = fakeHeart();
      playThrough(l.id, heart);
      expect(names(heart).includes("premature"), l.id).toBe(l.id === "extra-beat");
      expect(names(heart).includes("pace"), l.id).toBe(l.id === "normal-beat" || l.id === "extra-beat");
    }
  });
});
