import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { LESSONS, LESSON_SETTINGS } from "../../src/lessons/lessons";
import { HINT_AFTER_MS, LessonRunner, type LabApi, type Lesson, type LessonStep } from "../../src/lessons/runner";
import * as R from "../../src/lessons/recipes";
import * as COPY from "../../src/copy";
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
const lessonText = (id: string) =>
  lesson(id)
    .steps.map((s) => s.text)
    .join(" ");

/** A step that only waits for time to pass can never leave a viewer stuck; any other waiting step can. */
const canGetStuck = (s: LessonStep): boolean => {
  if (!s.waitFor) return false;
  const reading = (active: number, status: "idle" | "running" | "success" | "failed"): LabApi =>
    ({ activeFraction: () => active, simTimeMs: () => 0, lastBeatMs: () => -Infinity, induceStatus: () => status }) as unknown as LabApi;
  return !(s.waitFor(reading(0.5, "running")) && s.waitFor(reading(0, "idle")));
};

describe("lessons: the data", () => {
  it("has the five lessons, in teaching order", () => {
    expect(LESSONS.map((l) => l.id)).toEqual(["normal-beat", "extra-beat", "tachycardia", "fibrillation", "shock"]);
    expect(LESSONS.map((l) => l.title)).toEqual(["One beat", "An early beat (PVC)", "Racing rhythm (VT)", "Chaos: fibrillation (VF)", "Shock it back"]);
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

  it("ends every lesson with a 'What you learned' left with the Next button", () => {
    for (const l of LESSONS) {
      const last = l.steps[l.steps.length - 1];
      expect(last.title, l.id).toBe("What you learned");
      expect(last.waitFor, l.id).toBeUndefined();
    }
  });

  it("keeps every step to 35 words or fewer", () => {
    for (const l of LESSONS) l.steps.forEach((s, i) => expect(words(s.text), `${l.id} step ${i}: "${s.text}"`).toBeLessThanOrEqual(35));
  });

  it("keeps a caption that moves on by itself short enough to read before it goes", () => {
    // 20 words when it can go after a moment; 40 when it stays for four seconds or more. A step only the viewer can
    // finish (pressing Shock) stays until they do.
    for (const l of LESSONS)
      for (const [i, s] of l.steps.entries())
        if (s.waitFor && s.canSkip !== false) expect(words(s.text), `${l.id} step ${i}: "${s.text}"`).toBeLessThanOrEqual((s.minMs ?? 0) >= 4000 ? 40 : 20);
  });

  it("uses plain English: short sentences", () => {
    for (const l of LESSONS)
      for (const text of allText(l))
        for (const sentence of text.split(/(?<=[.!?])\s+/)) expect(words(sentence), `${l.id}: "${sentence}"`).toBeLessThanOrEqual(32);
  });

  it("avoids jargon that is never explained, and never gives a diagnosis or advice about the viewer's own heart", () => {
    const jargon =
      /\b(refractory|repolari[sz]ation|depolari[sz]ation|action potential|ectopic|myocardi\w*|anisotropi\w*|ischemi\w*|infarct\w*|re-?entry|vulnerable window|sinus rhythm|wavelength)\b/i;
    const advice = /\b(diagnos\w*|treatment|therapy|medical advice|your heart|you have)\b/i;
    for (const l of LESSONS)
      for (const text of allText(l)) {
        expect(text, `${l.id} jargon`).not.toMatch(jargon);
        expect(text, `${l.id} advice`).not.toMatch(advice);
      }
  });

  it("does not say which way the ECG trace points: that depends on the lead the strip is showing", () => {
    for (const l of LESSONS)
      for (const text of allText(l)) expect(text, l.id).not.toMatch(/\b(upward|downward|upright|positive|negative|tall)\b/i);
  });

  it("explains each medical word where it first appears in a lesson", () => {
    const explained: [RegExp, RegExp][] = [
      [/\bPVC\b/, /PVC, a premature ventricular contraction/],
      [/\btachycardia\b/i, /ventricular tachycardia \(VT\), a racing rhythm from the lower chambers/],
      [/\bfibrillation\b/i, /Doctors call this ventricular fibrillation \(VF\)|fibrillation again: chaotic waves, no pumping/],
      [/\bQRS\b/, /a quick spike as the wave spreads \(the QRS complex\)/],
      [/\bT wave\b/, /a rounder wave as the muscle resets \(the T wave\)/],
      [/\bP wave\b/, /a small bump before each beat, the P wave, made by the upper chambers/],
      [/\bAED\b/, /AED, (a|the) public defibrillator/],
      [/\bCPR\b/, /CPR \(chest compressions\)|chest compressions \(CPR\)/],
      [/\bpacemaker\b/i, /pacemaker cells/],
    ];
    for (const l of LESSONS) {
      const steps = l.steps.map((s) => s.text);
      for (const [word, gloss] of explained) {
        const first = steps.findIndex((t) => word.test(t));
        if (first >= 0) expect(steps[first], `${l.id}: first use of ${word}`).toMatch(gloss);
      }
    }
  });

  it("gives every step a viewer could get stuck on a hint; a skippable step's hint offers Skip, the Shock step's does not", () => {
    for (const l of LESSONS)
      for (const [i, s] of l.steps.entries()) {
        if (!canGetStuck(s)) continue;
        expect(s.hint?.trim().length ?? 0, `${l.id} step ${i}`).toBeGreaterThan(0);
        if (s.canSkip === false) {
          expect(s.hint, `${l.id} step ${i}`).toMatch(/Shock button/);
          expect(s.hint, `${l.id} step ${i}`).not.toMatch(/Skip/);
        } else expect(s.hint, `${l.id} step ${i}`).toMatch(/Skip/);
      }
  });

  it("lets only the Shock steps refuse Skip, and every lesson that breaks the heart ends with the viewer's Shock", () => {
    for (const l of LESSONS) {
      const fixed = l.steps.filter((s) => s.canSkip === false);
      expect(fixed.every((s) => /Press Shock/.test(s.text)), l.id).toBe(true);
      expect(fixed.length, l.id).toBe(["tachycardia", "fibrillation", "shock"].includes(l.id) ? 1 : 0);
    }
  });

  it("names the page's controls with the words the page uses (src/copy.ts)", () => {
    const labels = Object.values(COPY.LABELS).map((s) => s.toLowerCase());
    expect(labels).toContain("shock");
    expect(labels).toContain("steady beat");
    expect([COPY.LESSON_UI.skip, COPY.LESSON_UI.next]).toEqual(["Skip", "Next"]);
    for (const l of LESSONS)
      for (const text of allText(l)) {
        if (/press shock/i.test(text)) expect(labels, `${l.id}: "${text}"`).toContain("shock");
        if (/steady beat/i.test(text)) expect(labels, `${l.id}: "${text}"`).toContain("steady beat");
      }
  });

  it("holds the ECG only while its words point at a trace that would otherwise have moved on", () => {
    const held = LESSONS.flatMap((l) => l.steps.filter((s) => s.holdEcg).map((s) => `${l.id}/${s.title}`));
    expect(held).toEqual(["normal-beat/Two kinds of beat", "extra-beat/What you saw", "extra-beat/Why the pause"]);
    for (const title of ["Two kinds of beat", "What you saw"]) expect(LESSONS.flatMap((l) => l.steps).find((s) => s.title === title)?.text).toMatch(/^The ECG is held\./);
  });

  it("is honest about the model and about real hearts", () => {
    // where real beats start, where this model starts them, and what it leaves out
    expect(lessonText("normal-beat")).toMatch(/starts at the top/);
    expect(lessonText("normal-beat")).toMatch(/Here it starts in that wiring/);
    // a beat through the wiring is narrow, a beat from one spot is wide: true of the model since its beat uses the wiring
    expect(lessonText("normal-beat")).toMatch(/narrow spike/);
    expect(lessonText("normal-beat")).toMatch(/wide swing/);
    expect(lessonText("extra-beat")).toMatch(/from one spot, so it drew a wide, different shape/);
    expect(lessonText("normal-beat")).toMatch(/drawn here but not simulated, so it is missing/);
    // the early beat: the pause, the feeling, and that occasional ones are usually nothing to fear
    expect(lessonText("extra-beat")).toMatch(/pause/);
    expect(lessonText("extra-beat")).toMatch(/skipped beat/);
    expect(lessonText("extra-beat")).toMatch(/common and often harmless/);
    // the racing rhythm: the tissue, the trigger, and what it means in a person
    expect(lessonText("tachycardia")).toMatch(/fragile/);
    expect(lessonText("tachycardia")).toMatch(/one early beat/);
    expect(lessonText("tachycardia")).toMatch(/emergency/);
    // ...and that a shock in real life is not for a person with a racing heart who is up and about
    expect(lessonText("tachycardia")).toMatch(/In real life, a bystander shocks only a collapsed person/);
    // fibrillation: cardiac arrest, and what to do in real life
    expect(lessonText("fibrillation")).toMatch(/cardiac arrest/);
    expect(lessonText("fibrillation")).toMatch(/no pulse/);
    expect(lessonText("fibrillation")).toMatch(/call emergency services, start CPR/);
    // ...and only for someone who has collapsed and is not breathing normally: the condition comes before the actions
    expect(lessonText("fibrillation")).toMatch(/If someone collapses and is not breathing normally: call emergency services, start CPR/);
    expect(lessonText("fibrillation")).toMatch(/about ten a second/);
    // the shock: how it works, and when a real AED refuses
    expect(lessonText("shock")).toMatch(/every cell fire at the same moment/);
    expect(lessonText("shock")).toMatch(/will not shock a heart that is pumping, or one that is still/);
    expect(lessonText("shock")).toMatch(/cannot start a still heart/);
    for (const l of LESSONS) {
      const text = allText(l).join(" ");
      // a shock does not put the heart to rest: it makes every cell fire at once
      expect(text, l.id).not.toMatch(/resets every cell|back to rest|puts? .* to rest/i);
      // the model's rhythm is not a sinus rhythm, and real beats do not start at the tip
      expect(text, l.id).not.toMatch(/\bsinus\b|beat at the tip|starts at the tip/i);
    }
  });
});

describe("the page's words (src/copy.ts): within the limits the layout and the reader can take", () => {
  it("keeps the status card short", () => {
    for (const [key, r] of Object.entries(COPY.RHYTHM_COPY)) {
      expect(r.name.length, key).toBeLessThanOrEqual(22);
      expect(words(r.sentence), key).toBeLessThanOrEqual(25);
      expect(r.pumping.length, key).toBeGreaterThan(0);
      expect(r.next.length, key).toBeGreaterThan(0);
    }
  });

  it("keeps the refusals, the banner, the ECG line and the lead captions within their limits", () => {
    for (const s of Object.values(COPY.SHOCK_REFUSAL)) expect(s.length).toBeLessThanOrEqual(120);
    expect(COPY.DISCLAIMER.banner.length).toBeLessThanOrEqual(60);
    expect(COPY.DISCLAIMER.ecgLine.length).toBeLessThanOrEqual(140);
    for (const s of Object.values(COPY.LEAD_CAPTIONS)) {
      expect(s).toContain("{lead}");
      expect(s.replace("{lead}", "aVR").length).toBeLessThanOrEqual(140);
    }
  });

  it("defines every term in 15 words or fewer", () => {
    for (const [term, def] of Object.entries(COPY.TERMS)) expect(words(def), term).toBeLessThanOrEqual(15);
  });

  it("follows the clinical ground rules at the top of copy.ts", () => {
    const everything = JSON.stringify(COPY);
    expect(everything).not.toMatch(/\bsinus rhythm\b|starts at the tip/i);
    expect(COPY.RHYTHM_COPY.chaotic.medicalName).toBe("Ventricular fibrillation (VF)");
    expect(COPY.TERMS["Atrial fibrillation"]).toMatch(/different condition from VF/);
    expect(COPY.SHOCK_REFUSAL.still).toMatch(/cannot start a still heart/);
    expect(COPY.SOUND_NOTE).toMatch(/synthesised from the simulated beats, not recorded/);
    // the heart's fat and surface vessels are drawn for looks: the words never claim they come from the scan
    expect(COPY.DISCLAIMER.explore).toMatch(/fat and the blood vessels on the surface are added for looks/);
    for (const [term, def] of Object.entries(COPY.TERMS)) if (/fat|coronary/i.test(term)) expect(def, term).toMatch(/Drawn here for looks/);
    for (const note of Object.values(COPY.SIM_ECG_NOTES)) expect(note!.length).toBeLessThanOrEqual(100);
  });

  it("has three first-run steps: tap, break, fix", () => {
    expect(COPY.FIRST_RUN_STEPS.map((s) => s.title)).toEqual(["Tap the heart", "Break it", "Fix it"]);
  });

  it("says what to do in real life only after the condition for it: someone collapsed and not breathing normally", () => {
    const next = COPY.RHYTHM_COPY.chaotic.next;
    expect(next).toMatch(/^Shock now\. /);
    const condition = next.indexOf("has collapsed and is not breathing normally");
    expect(condition, next).toBeGreaterThan(-1);
    for (const action of ["call emergency services", "start CPR", "use an AED"]) expect(next.indexOf(action), action).toBeGreaterThan(condition);
  });

  it("does not leave 'Press Shock' for the racing rhythm standing as if a bystander would shock anyone with a racing heart", () => {
    expect(COPY.FIRST_RUN_STEPS[2].body).toMatch(/^Press Shock\. .*In real life, a bystander shocks only a collapsed person\.$/);
  });

  it("defines Pacemaker as both the heart's own (the sinus node) and the implanted device", () => {
    expect(COPY.TERMS.Pacemaker).toMatch(/sinus node/);
    expect(COPY.TERMS.Pacemaker).toMatch(/implanted device/);
    expect(COPY.TERMS.Pacemaker).toMatch(/heart's own/);
  });
});

describe("lessons: the settings they rely on", () => {
  it("keeps only numbers in LESSON_SETTINGS: the tuned values are read from recipes.ts", () => {
    for (const [name, value] of Object.entries(S)) expect(typeof value, name).toBe("number");
    expect(Object.keys(S).some((k) => /recipe|apex/i.test(k))).toBe(false);
  });

  it("uses the lab's own pacemaker period for the steady gap between beats", () => {
    expect(S.steadyGapMs).toBe(PACEMAKER_PERIOD_MS);
  });

  it("makes true what the lessons say about fragile tissue: each recipe lowers both sliders, and fibrillation goes lower again", () => {
    expect(R.TACHYCARDIA_TISSUE.recovery).toBeLessThan(R.NORMAL_TISSUE.recovery);
    expect(R.TACHYCARDIA_TISSUE.conduction).toBeLessThan(R.NORMAL_TISSUE.conduction);
    expect(R.FIBRILLATION_TISSUE.recovery).toBeLessThan(R.TACHYCARDIA_TISSUE.recovery);
    expect(R.FIBRILLATION_TISSUE.conduction).toBeLessThan(R.TACHYCARDIA_TISSUE.conduction);
  });

  it("shows the steady beat long enough, in the first lesson, for two of its spikes to be drawn before the ECG is held", () => {
    // switched on, its first beat comes 400 ms later and may be blocked by the nudge just before; a spike takes about 100 ms
    expect(S.steadyShowMs).toBeGreaterThanOrEqual(400 + 2 * S.steadyGapMs + 100);
  });

  it("gives the early beat before the next steady beat is due, and watches long enough to draw the pause after it", () => {
    expect(R.PVC_EXTRA_BEAT_MS).toBeGreaterThanOrEqual(550);
    expect(R.PVC_EXTRA_BEAT_MS).toBeLessThan(S.steadyGapMs);
    // the steady beat after the early one does nothing; the one after that, and its big swing, must be on screen
    const nextDrawn = 2 * S.steadyGapMs - R.PVC_EXTRA_BEAT_MS;
    expect(S.pauseWatchMs).toBeGreaterThanOrEqual(nextDrawn + 200);
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

// A stand-in for the lab with the rules the lessons rely on. The pacemaker runs from the start and fires every 800 ms
// while it is on. A beat's wave is over 470 ms after it starts, and for its first 350 ms the muscle cannot fire again,
// so a stimulus then does nothing (it still counts as the last beat, as in the real engine). `induce` takes 3 s and
// then leaves a wave that never ends (or fails). The viewer's Shock follows the AED rule: it only fires on a circling
// rhythm (or while one is being started), and then the whole heart fires at once for 300 ms, the tissue is healthy
// and the pacemaker restarts 1.5 s later.
function fakeHeart(opts: { canInduce?: boolean; pacemaker?: boolean; circling?: boolean } = {}) {
  const canInduce = opts.canInduce ?? true;
  type Call = { name: string; at: number; active: number; arg?: unknown };
  type Kind = "pacemaker" | "pace" | "normal" | "extra" | "tap";
  const calls: Call[] = [];
  const stimuli: { kind: Kind; at: number; captured: boolean }[] = [];
  let now = 0;
  let pacemaker = opts.pacemaker ?? true;
  let nextBeat = 300;
  let lastBeat = -Infinity;
  let wave: { start: number; kind: "beat" | "circling" | "whole" } | null = opts.circling ? { start: -5000, kind: "circling" } : null;
  let induction: { startedAt: number; done: boolean } | null = null;

  const active = (): number => {
    if (!wave) return 0;
    const dt = now - wave.start;
    if (wave.kind === "circling") return dt < 300 ? Math.min(1, dt / 200) : 0.45;
    if (wave.kind === "whole") return dt < 300 ? 1 : 0;
    return dt < 470 ? Math.min(1, dt / 200) : 0;
  };
  const note = (name: string, arg?: unknown) => calls.push({ name, at: now, active: active(), arg });
  const deliver = (kind: Kind) => {
    lastBeat = now;
    const busy = wave !== null && (wave.kind === "circling" || now - wave.start < 350);
    stimuli.push({ kind, at: now, captured: !busy });
    if (!busy) wave = { start: now, kind: "beat" };
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
      note("reset"); // the lesson itself put the heart to rest, silently
      wave = null;
      nextBeat = now + 1500;
    },
    normalBeat: () => {
      note("normal beat");
      deliver("normal");
    },
    defibrillate: () => note("defibrillate"),
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
      wave = null;
      induction = { startedAt: now, done: false };
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
      wave = canInduce ? { start: now, kind: "circling" } : null;
    }
  };
  return {
    api,
    calls,
    stimuli,
    advance,
    now: () => now,
    active,
    /** The viewer taps the heart. */
    tap: () => {
      note("tap");
      deliver("tap");
    },
    /** The viewer presses Shock. Returns whether it fired. */
    pressShock: (): boolean => {
      const inducing = status() === "running";
      if (wave?.kind !== "circling" && !inducing) {
        note("shock refused");
        return false;
      }
      note("shock by viewer");
      induction = inducing ? null : induction;
      note("tissue", { ...R.NORMAL_TISSUE });
      pacemaker = true;
      wave = { start: now, kind: "whole" };
      nextBeat = now + 1500;
      return true;
    },
    /** The rhythm stops by itself, with no shock. */
    stopWave: () => {
      wave = null;
    },
  };
}

type Heart = ReturnType<typeof fakeHeart>;

/**
 * A viewer who reads for a while on each Next step (5 frames unless told otherwise) and then presses Next, taps the
 * heart when asked (after 20 frames), and presses Shock a moment after a lesson asks for it; on "Try it on a steady
 * heart" they press Shock once too, as the step asks.
 */
function playThrough(id: string, heart: Heart, opts: { maxFrames?: number; readFrames?: number; tap?: boolean; pressShock?: boolean } = {}) {
  const runner = new LessonRunner(LESSONS, heart.api);
  const moves: { to: string | null; at: number }[] = [];
  const hints: { title: string | null; hint: string; at: number }[] = [];
  runner.onChange(() => {
    moves.push({ to: runner.state.step?.title ?? null, at: heart.now() });
    if (runner.state.hint) hints.push({ title: runner.state.step?.title ?? null, hint: runner.state.hint, at: heart.now() });
  });
  runner.start(id);
  let frames = 0;
  let onStep = 0;
  let lastTitle: string | null = null;
  let triedSteady = false;
  while (!runner.state.finished && frames < (opts.maxFrames ?? 4000)) {
    frames++;
    heart.advance(16);
    runner.tick();
    const s = runner.state.step;
    if (!s) continue;
    if (s.title !== lastTitle) {
      lastTitle = s.title ?? null;
      onStep = 0;
    }
    onStep++;
    if (s.title === "Tap the heart") {
      if ((opts.tap ?? true) && onStep === 20) heart.tap();
    } else if (s.canSkip === false) {
      if ((opts.pressShock ?? true) && onStep === 8) heart.pressShock();
    } else if (!s.waitFor && onStep >= (opts.readFrames ?? 5)) {
      if (s.title === "Try it on a steady heart" && !triedSteady) {
        triedSteady = true;
        heart.pressShock();
      }
      runner.next();
    }
  }
  return { runner, frames, moves, hints };
}

const names = (heart: Heart) => heart.calls.map((c) => c.name);
const entered = (moves: { to: string | null; at: number }[], title: string) => {
  const m = moves.find((x) => x.to === title);
  if (!m) throw new Error(`never reached "${title}": ${moves.map((x) => x.to).join(" > ")}`);
  return m.at;
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

  it("never presses Shock for the viewer", () => {
    for (const l of LESSONS) {
      const heart = fakeHeart();
      playThrough(l.id, heart);
      expect(names(heart), l.id).not.toContain("defibrillate");
    }
  });

  it("one beat: pauses the steady beat, waits for the viewer's tap, then shows the steady beat beside it and holds the ECG", () => {
    const heart = fakeHeart();
    const { moves } = playThrough("normal-beat", heart);
    const n = names(heart);
    expect(n.slice(0, 2)).toEqual(["tissue", "pacemaker off"]);
    expect(n).toContain("tap");
    expect(n).not.toContain("pace");
    // the lesson waits for the tap's wave to be over before it moves on
    const tap = heart.calls.find((c) => c.name === "tap")!;
    const steady = entered(moves, "The steady beat");
    expect(steady - tap.at).toBeGreaterThanOrEqual(S.waveMs);
    // the steady beat comes back at once (the step's action runs on the next frame)
    const on = heart.calls.find((c) => c.name === "pacemaker on")!.at - steady;
    expect(on).toBeGreaterThanOrEqual(0);
    expect(on).toBeLessThanOrEqual(16);
    // and the ECG is held only once the tap and two steady beats after it have been drawn
    const held = entered(moves, "Two kinds of beat");
    const steadyBeats = heart.stimuli.filter((s) => s.kind === "pacemaker" && s.captured && s.at > tap.at && s.at + 100 <= held);
    expect(steadyBeats.length).toBeGreaterThanOrEqual(2);
  });

  it("one beat: a viewer who presses Skip instead of tapping still gets a beat from one spot to compare: the lab nudges the tip", () => {
    const heart = fakeHeart();
    const runner = new LessonRunner(LESSONS, heart.api);
    runner.start("normal-beat");
    heart.advance(16);
    runner.tick();
    runner.next(); // Skip
    heart.advance(16);
    runner.tick();
    expect(runner.state.step?.title).toBe("The steady beat");
    const nudge = heart.calls.filter((c) => c.name === "pace");
    expect(nudge.map((c) => c.arg)).toEqual([R.APEX]);
    expect(names(heart)).not.toContain("normal beat");
    // with the nudge's wave still busy, the first steady beat can be blocked: two captured ones are still drawn in time
    let frames = 0;
    while (runner.state.step?.title === "The steady beat" && frames++ < 400) {
      heart.advance(16);
      runner.tick();
    }
    expect(runner.state.step?.title).toBe("Two kinds of beat");
    const captured = heart.stimuli.filter((s) => s.kind === "pacemaker" && s.captured && s.at + 100 <= heart.now());
    expect(captured.length).toBeGreaterThanOrEqual(2);
  });

  it("one beat: offers the tap hint only after 8 s of simulated time without a tap", () => {
    const heart = fakeHeart();
    const { runner, hints } = playThrough("normal-beat", heart, { tap: false, maxFrames: Math.ceil((HINT_AFTER_MS + 2000) / 16) });
    expect(runner.state.step?.title).toBe("Tap the heart");
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0].at).toBeGreaterThanOrEqual(HINT_AFTER_MS);
    expect(hints[0].hint).toMatch(/Tap or click anywhere on the heart/);
  });

  it("an early beat: the steady beat keeps going, one early beat comes just after the muscle has reset, and the pause follows", () => {
    for (const readFrames of [1, 5, 13, 29]) {
      const heart = fakeHeart({ pacemaker: true });
      const { moves } = playThrough("extra-beat", heart, { readFrames });
      const n = names(heart);
      expect(n, `read ${readFrames}`).not.toContain("pacemaker off");
      expect(n.filter((x) => x === "premature"), `read ${readFrames}`).toHaveLength(1);
      const i = heart.stimuli.findIndex((s) => s.kind === "extra");
      const [before, extra, blocked, after] = heart.stimuli.slice(i - 1, i + 3);
      expect(before.kind).toBe("pacemaker");
      expect(extra.at - before.at).toBeGreaterThanOrEqual(R.PVC_EXTRA_BEAT_MS);
      expect(extra.at - before.at).toBeLessThan(R.PVC_EXTRA_BEAT_MS + 40);
      expect(extra.captured).toBe(true);
      // the next steady beat falls while the muscle is still resetting and does nothing: a full compensatory pause
      expect(blocked.kind).toBe("pacemaker");
      expect(blocked.captured).toBe(false);
      expect(after.kind).toBe("pacemaker");
      expect(after.captured).toBe(true);
      expect(after.at - before.at).toBe(2 * PACEMAKER_PERIOD_MS);
      // the held steps come only once the beat after the pause, and its big swing, have been drawn
      expect(entered(moves, "What you saw")).toBeGreaterThanOrEqual(after.at + 200);
    }
  });

  it("an early beat: switches the steady beat on only when it is off, so a running rhythm is not restarted", () => {
    const off = fakeHeart({ pacemaker: false });
    playThrough("extra-beat", off);
    expect(names(off).filter((x) => x === "pacemaker on")).toHaveLength(1);
    const on = fakeHeart({ pacemaker: true });
    on.advance(300); // the steady beat has fired
    playThrough("extra-beat", on);
    expect(names(on)).not.toContain("pacemaker on");
  });

  it("racing and fibrillation: start the rhythm once, watch it, then wait for the viewer's Shock, which cannot be skipped", () => {
    for (const [id, kind, watch, watchTitle] of [
      ["tachycardia", "tachycardia", S.keepsGoingMs, "Watch it race"],
      ["fibrillation", "fibrillation", S.seeingMs, "Watch the chaos"],
    ] as const) {
      const heart = fakeHeart();
      const runner = new LessonRunner(LESSONS, heart.api);
      const moves: { to: string | null; at: number }[] = [];
      runner.onChange(() => moves.push({ to: runner.state.step?.title ?? null, at: heart.now() }));
      runner.start(id);
      let frames = 0;
      while (runner.state.step?.title !== "Fix it" && frames++ < 2000) {
        heart.advance(16);
        runner.tick();
        if (runner.state.step && !runner.state.step.waitFor) runner.next();
      }
      expect(names(heart).filter((x) => x === "induce"), id).toHaveLength(1);
      expect(heart.calls.find((c) => c.name === "induce")!.arg, id).toBe(kind);
      expect(entered(moves, "Fix it") - entered(moves, watchTitle), id).toBeGreaterThanOrEqual(watch);
      // Skip does nothing here, and time alone does not help
      for (let i = 0; i < Math.ceil((HINT_AFTER_MS + 500) / 16); i++) {
        heart.advance(16);
        runner.tick();
        runner.next();
      }
      expect(runner.state.step?.title, id).toBe("Fix it");
      expect(runner.state.hint, id).toMatch(/Press the Shock button/);
      // the viewer's shock does it
      expect(heart.pressShock()).toBe(true);
      for (let i = 0; i < 40; i++) {
        heart.advance(16);
        runner.tick();
      }
      expect(runner.state.step?.title, id).toBe("What you learned");
    }
  });

  it("the Shock step is not passed by a rhythm that simply stops, until the heart has been quiet long enough that nothing is left to shock", () => {
    const heart = fakeHeart();
    const runner = new LessonRunner(LESSONS, heart.api);
    runner.start("tachycardia");
    let frames = 0;
    while (runner.state.step?.title !== "Fix it" && frames++ < 2000) {
      heart.advance(16);
      runner.tick();
      if (runner.state.step && !runner.state.step.waitFor) runner.next();
    }
    heart.advance(16);
    runner.tick();
    heart.stopWave(); // the rhythm ends without a shock
    const stoppedAt = heart.now();
    while (runner.state.step?.title === "Fix it" && frames++ < 4000) {
      heart.advance(16);
      runner.tick();
    }
    expect(heart.now() - stoppedAt).toBeGreaterThanOrEqual(S.nothingToShockMs);
    expect(runner.state.step?.title).toBe("What you learned");
  });

  it("a waiting step offers its hint only when what it waits for is missing", () => {
    // the lab cannot start the rhythm: the hint comes after startingHintMs, and not before
    for (const id of ["tachycardia", "fibrillation", "shock"]) {
      const heart = fakeHeart({ canInduce: false });
      const { runner, hints } = playThrough(id, heart, { maxFrames: Math.ceil((S.startingHintMs + 3000) / 16) });
      expect(runner.state.finished, id).toBe(false);
      expect(hints.length, id).toBeGreaterThan(0);
      expect(hints[0].at, id).toBeGreaterThanOrEqual(S.startingHintMs);
      expect(hints[0].hint, id).toMatch(/Skip/);
    }
    // a rhythm that keeps going never brings the "it stopped" hint; one that stops brings it within stoppedHintMs
    const heart = fakeHeart();
    const runner = new LessonRunner(LESSONS, heart.api);
    runner.start("tachycardia");
    let frames = 0;
    while (runner.state.step?.title !== "Watch it race" && frames++ < 2000) {
      heart.advance(16);
      runner.tick();
    }
    for (let i = 0; i < 200; i++) {
      heart.advance(16);
      runner.tick();
      expect(runner.state.hint).toBeNull();
      if (runner.state.step?.title !== "Watch it race") break;
    }
    const again = fakeHeart();
    const r2 = new LessonRunner(LESSONS, again.api);
    r2.start("tachycardia");
    frames = 0;
    while (r2.state.step?.title !== "Watch it race" && frames++ < 2000) {
      again.advance(16);
      r2.tick();
    }
    again.stopWave();
    const stoppedAt = again.now();
    while (r2.state.hint === null && frames++ < 4000) {
      again.advance(16);
      r2.tick();
    }
    expect(r2.state.step?.title).toBe("Watch it race");
    expect(again.now() - stoppedAt).toBeLessThanOrEqual(S.stoppedHintMs + 32);
    expect(r2.state.hint).toMatch(/did not keep going/);
  });

  it("shock it back: sets up fibrillation, waits for the viewer, the steady rhythm returns, and a Shock on it is refused", () => {
    const heart = fakeHeart();
    const { runner, moves } = playThrough("shock", heart, { readFrames: 60 }); // about a second on each step
    expect(runner.state.finished).toBe(true);
    const n = names(heart);
    expect(heart.calls.find((c) => c.name === "induce")!.arg).toBe("fibrillation");
    expect(n.filter((x) => x === "shock by viewer")).toHaveLength(1);
    const shock = heart.calls.find((c) => c.name === "shock by viewer")!;
    expect(shock.active, "the viewer shocked a heart that was in trouble").toBeGreaterThan(S.goingAbove);
    // the steady beats came back while the lesson was still on, and a second Shock on them was refused
    const back = heart.stimuli.filter((s) => s.kind === "pacemaker" && s.captured && s.at > shock.at && s.at < entered(moves, "No shock advised"));
    expect(back.length).toBeGreaterThanOrEqual(2);
    expect(n).toContain("shock refused");
    expect(n.indexOf("shock refused")).toBeGreaterThan(n.indexOf("shock by viewer"));
  });

  it("only the early-beat lesson fires an early beat, and only the first lesson fires a beat of its own (when the tap is skipped)", () => {
    for (const l of LESSONS) {
      const heart = fakeHeart();
      playThrough(l.id, heart);
      expect(names(heart).includes("premature"), l.id).toBe(l.id === "extra-beat");
      expect(names(heart).includes("normal beat"), l.id).toBe(false);
      expect(names(heart).includes("pace"), l.id).toBe(false);
    }
  });

  it("puts a rhythm left circling from free play to rest before the first two lessons, and leaves a healthy beating heart alone", () => {
    for (const id of ["normal-beat", "extra-beat"]) {
      const circling = fakeHeart({ pacemaker: false, circling: true });
      circling.advance(2000);
      const r1 = new LessonRunner(LESSONS, circling.api);
      r1.start(id);
      r1.tick();
      expect(names(circling)[0], id).toBe("reset");
      const beating = fakeHeart({ pacemaker: true });
      beating.advance(350); // the first beat fires
      beating.advance(100); // and its wave is crossing the heart
      const r2 = new LessonRunner(LESSONS, beating.api);
      r2.start(id);
      r2.tick();
      expect(names(beating), id).not.toContain("reset");
    }
  });
});
