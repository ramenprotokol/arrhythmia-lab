// The five lessons played on the real page, in real Chrome with the real GPU, the way a viewer plays them: open the
// Lessons drawer, pick the lesson, tap the heart when asked, press Next when a step has one, press Shock when a lesson
// asks for it, and let the waiting steps move on by themselves. Nothing is skipped, so every waiting condition has to
// be satisfied by the real simulation, and what the words say about the beats is checked against the real heart.
// Needs the page's ?debug handle (window.__lab, see src/app.ts) to read where the lesson is and what the heart does.
// The unit tests in lessons.test.ts cover the same flows against a stand-in lab.
import { test, expect, type Page } from "@playwright/test";
import { consoleGuard } from "./consoleGuard";
import * as R from "../../src/lessons/recipes";
import { LESSONS, LESSON_SETTINGS } from "../../src/lessons/lessons";
import { LESSON_UI, LABELS } from "../../src/copy";
import { PACEMAKER_PERIOD_MS } from "../../src/lab/engine";

const S = LESSON_SETTINGS;

const guard = consoleGuard();
test.beforeEach(({ page }) => guard.attach(page));
test.afterEach(async ({ page }) => {
  guard.check();
  const gpuErrors = await page.evaluate(() => (window as unknown as { __labErrors?: string[] }).__labErrors ?? []);
  expect(gpuErrors).toEqual([]);
});
test.describe.configure({ mode: "serial" });

type Step = { title?: string; waitFor?: unknown; canSkip?: boolean };
type Lab = {
  engine: { simTime: number; lastBeatAt: number; excited: number; pacemaker: boolean; tissue: { conduction: number; recovery: number }; inducer: { state: { status: string } } };
  runner: { state: { lessonId: string | null; stepIndex: number; step: Step | null; finished: boolean; hint: string | null }; start(id: string): void; next(): void };
  renderer: { project(voxel: [number, number, number]): { x: number; y: number; visible: boolean }; onTap?: (x: number, y: number) => void };
  analyzer: { state: { kind: string; bpm: number | null; output: number; sinceMs: number } };
  moves: { shock(rhythm: unknown): { fired: boolean; reason?: string } };
  setSpeed(s: number): void;
};
type Log = {
  /** Every stimulus the engine delivered (it notes the time of each), whether or not it captured. */
  beats: { at: number; pacemaker: boolean }[];
  steps: { title: string; lesson: string | null; at: number; excited: number }[];
  /** How much of the muscle was excited, on every frame. */
  excited: { at: number; value: number }[];
};

async function open(page: Page) {
  await page.goto("/?debug&quality=low");
  await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, undefined, { timeout: 90_000 });
  await page.waitForFunction(() => Boolean((window as unknown as { __lab?: unknown }).__lab), undefined, { timeout: 5_000 });
  await page.evaluate(() => {
    const lab = () => (window as unknown as { __lab: Lab }).__lab;
    lab().setSpeed(1); // real time, the page's default
    // a sampler that notes every stimulus and every change of step, as the lessons run
    const log: Log = { beats: [], steps: [], excited: [] };
    let lastBeat = lab().engine.lastBeatAt;
    let lastKey = "";
    const sample = () => {
      const e = lab().engine;
      log.excited.push({ at: e.simTime, value: e.excited });
      if (e.lastBeatAt !== lastBeat) {
        lastBeat = e.lastBeatAt;
        log.beats.push({ at: lastBeat, pacemaker: e.pacemaker });
      }
      const s = lab().runner.state;
      const title = s.finished ? "(finished)" : (s.step?.title ?? "(none)");
      const key = `${s.lessonId}/${title}`;
      if (key !== lastKey) {
        lastKey = key;
        log.steps.push({ title, lesson: s.lessonId, at: e.simTime, excited: e.excited });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    (window as unknown as { lessonLog: Log }).lessonLog = log;
  });
}

/**
 * A click on the front of the heart, over the middle of the muscle (the middle itself is hidden behind the front wall,
 * which is what the click lands on). A real mouse click when nothing covers that spot; if a panel does, the page's own
 * tap handler is called with the same point.
 */
async function tapHeart(page: Page) {
  const at = await page.evaluate(async () => {
    const frame = (await (await fetch("data/heart-frame.json")).json()) as { centroid: [number, number, number] };
    const w = window as unknown as { __lab: Lab };
    const p = w.__lab.renderer.project(frame.centroid.map(Math.round) as [number, number, number]);
    const canvas = document.getElementById("heart")!;
    const box = canvas.getBoundingClientRect();
    const x = box.left + p.x;
    const y = box.top + p.y;
    const onCanvas = p.x >= 0 && p.y >= 0 && p.x <= box.width && p.y <= box.height;
    const clear = onCanvas && document.elementFromPoint(x, y) === canvas;
    if (onCanvas && !clear) w.__lab.renderer.onTap?.(p.x, p.y);
    return { x, y, onCanvas, clear };
  });
  expect(at.onCanvas, "the middle of the heart is on the canvas").toBe(true);
  if (at.clear) await page.mouse.click(at.x, at.y);
}

/** Press the page's Shock button, as the viewer would. */
async function pressShock(page: Page) {
  await page.getByRole("button", { name: LABELS.shock, exact: true }).first().click();
}

/** The lesson panel, inside the drawer. */
const lessonPanel = (page: Page) => page.locator("#lessons");

/** Open the Lessons drawer from the top bar, as a viewer does, and pick the lesson by its title. */
async function startLesson(page: Page, id: string) {
  const title = LESSONS.find((l) => l.id === id)!.title;
  const choice = lessonPanel(page).getByRole("button", { name: title });
  if (!(await choice.isVisible())) await page.getByRole("button", { name: LABELS.lessons, exact: true }).first().click();
  await choice.click();
}

/**
 * Play a lesson: open it from the Lessons drawer (unless `resume`, which carries on where it is), tap when asked, press
 * Next on reading steps, Shock when asked, and otherwise wait. Stops when it is finished, or at the step called `until`.
 */
async function play(page: Page, id: string, opts: { until?: string; budgetMs?: number; readMs?: number; resume?: boolean } = {}) {
  if (!opts.resume) await startLesson(page, id);
  const started = Date.now();
  const budget = opts.budgetMs ?? 150_000;
  let tapped = false;
  let shocked = false;
  while (Date.now() - started < budget) {
    const now = await page.evaluate(() => {
      const s = (window as unknown as { __lab: Lab }).__lab.runner.state;
      return { finished: s.finished, title: s.step?.title ?? null, waits: s.step?.waitFor !== undefined, fixed: s.step?.canSkip === false };
    });
    if (now.finished || (opts.until && now.title === opts.until)) {
      await page.waitForTimeout(250); // let the page's sampler, which runs once a frame, log the step too
      return Date.now() - started;
    }
    if (now.title === "Tap the heart" && !tapped) {
      await page.waitForTimeout(800); // reading
      tapped = true;
      await tapHeart(page);
    } else if (now.fixed && !shocked) {
      await page.waitForTimeout(1200); // reading
      shocked = true;
      await pressShock(page);
    } else if (!now.waits) {
      await page.waitForTimeout(opts.readMs ?? 600); // reading
      await lessonPanel(page).getByRole("button", { name: LESSON_UI.next, exact: true }).click();
    } else {
      await page.waitForTimeout(200);
    }
    if (now.title !== "Tap the heart") tapped = false;
    if (!now.fixed) shocked = false;
  }
  throw new Error(`the ${id} lesson did not finish within ${budget / 1000} s of real time`);
}

const readLog = (page: Page) => page.evaluate(() => (window as unknown as { lessonLog: Log }).lessonLog);
const labState = (page: Page) =>
  page.evaluate(() => {
    const e = (window as unknown as { __lab: Lab }).__lab.engine;
    return { pacemaker: e.pacemaker, tissue: { ...e.tissue }, inducer: e.inducer.state.status, simTime: e.simTime };
  });
const entered = (log: Log, lesson: string, title: string) => {
  const step = log.steps.find((s) => s.lesson === lesson && s.title === title);
  if (!step) throw new Error(`the ${lesson} lesson never showed "${title}": ${log.steps.filter((s) => s.lesson === lesson).map((s) => s.title).join(" > ")}`);
  return step;
};
const peakWithin = (log: Log, from: number, ms: number) => Math.max(0, ...log.excited.filter((x) => x.at >= from && x.at < from + ms).map((x) => x.value));
const path = (log: Log, lesson: string) => log.steps.filter((s) => s.lesson === lesson).map((s) => s.title).join(" > ");
/**
 * How wide each beat's QRS is on the page's own ECG, in ms from its stimulus: the twelve leads' summed steepness is
 * high while the wave spreads and falls to almost nothing in the flat stretch before the T wave. Each beat is judged
 * up to the next stimulus in `log` (a blocked steady beat right after an early one would otherwise be counted in),
 * from the monitor's samples (one every 4 ms of simulated time), so the stimuli must still be inside its window.
 */
async function qrsWidths(page: Page, log: Log, stimuli: number[]): Promise<number[]> {
  const beats = stimuli.map((at) => ({ at, until: Math.min(at + 450, ...log.beats.filter((b) => b.at > at + 4).map((b) => b.at)) }));
  return page.evaluate((beats) => {
    const monitor = (window as unknown as { __lab: { monitor: { getTrace(lead: number): { t: Float32Array; v: Float32Array } } } }).__lab.monitor;
    const leads = Array.from({ length: 12 }, (_, l) => monitor.getTrace(l));
    const t = leads[1].t;
    return beats.map(({ at, until }) => {
      const idx: number[] = [];
      for (let i = 1; i < t.length; i++) if (t[i] >= at && t[i] < until) idx.push(i);
      if (idx.length < 20) return Number.NaN; // no longer on the monitor
      const steep = idx.map((i) => leads.reduce((sum, lead) => sum + Math.abs(lead.v[i] - lead.v[i - 1]), 0));
      const peakAt = steep.indexOf(Math.max(...steep));
      const floor = 0.12 * steep[peakAt];
      // the QRS ends where the steepness has stayed under the floor for 20 ms (five samples), or for what is left of
      // the window when the next stimulus comes sooner (an early beat's window can close a few ms after its QRS)
      for (let k = peakAt; k < steep.length; k++) {
        const run = steep.slice(k, k + 5);
        if (run.length >= 2 && run.every((s) => s < floor)) return t[idx[k]] - at;
      }
      return Number.NaN;
    });
  }, beats);
}

test("one beat: the viewer's tap, then the steady beat beside it: the tap creeps from one spot, the steady beat sweeps through the wiring", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page);
  await play(page, "normal-beat", { until: "Two kinds of beat" });
  let log = await readLog(page);
  const tapStep = entered(log, "normal-beat", "Tap the heart");
  const steadyStep = entered(log, "normal-beat", "The steady beat");
  const held = entered(log, "normal-beat", "Two kinds of beat");
  // one beat, the viewer's, while the steady beat was paused; it captured the whole heart and was over before moving on
  const tap = log.beats.filter((b) => b.at > tapStep.at && b.at < steadyStep.at);
  expect(tap).toHaveLength(1);
  expect(tap[0].pacemaker).toBe(false);
  expect(peakWithin(log, tap[0].at, 800)).toBeGreaterThan(0.9);
  expect(steadyStep.at - tap[0].at).toBeGreaterThanOrEqual(S.waveMs);
  expect(steadyStep.excited).toBeLessThan(S.quietBelow);
  // the ECG is held once two steady beats have been drawn beside the tap
  const steady = log.beats.filter((b) => b.pacemaker && b.at > steadyStep.at && b.at + 150 <= held.at);
  expect(steady.length).toBeGreaterThanOrEqual(2);
  // and what the held step says is true on this heart's ECG: the tap drew a wide swing, the steady beats narrow spikes
  const [tapWidth, ...steadyWidths] = await qrsWidths(page, log, [tap[0].at, ...steady.map((b) => b.at)]);
  console.log(`one beat lesson: QRS of the tap ${tapWidth} ms, of the steady beats ${steadyWidths.join(", ")} ms`);
  for (const w of steadyWidths) {
    expect(w).toBeLessThanOrEqual(130);
    expect(tapWidth).toBeGreaterThan(w + 50);
  }
  // the rest of the lesson, and the steady rhythm left running
  const took = await play(page, "normal-beat", { resume: true });
  log = await readLog(page);
  console.log(`one beat lesson: ${(took / 1000).toFixed(1)} s more: ${path(log, "normal-beat")}`);
  const end = await labState(page);
  expect(end.pacemaker).toBe(true);
  expect(end.tissue).toEqual(R.NORMAL_TISSUE);
});

test("an early beat: with the steady beat running, one early beat captures, the next steady beat does nothing, and the pause follows", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page);
  await play(page, "extra-beat", { until: "What you saw" });
  const log = await readLog(page);
  const early = entered(log, "extra-beat", "An early beat");
  const saw = entered(log, "extra-beat", "What you saw");
  const i = log.beats.findIndex((b) => b.at >= early.at - 20);
  const [before, extra, blocked, after] = log.beats.slice(i - 1, i + 3);
  console.log(`early beat lesson: stimuli at ${[before, extra, blocked, after].map((b) => Math.round(b.at - before.at)).join(", ")} ms`);
  // The lesson fires it a frame or two after the moment comes (a frame is 16 to 33 ms of simulated time in real
  // time), so it lands a little after 550 ms, and well before the next steady beat.
  expect(extra.at - before.at).toBeGreaterThanOrEqual(R.PVC_EXTRA_BEAT_MS);
  expect(extra.at - before.at).toBeLessThan(R.PVC_EXTRA_BEAT_MS + 120);
  expect(peakWithin(log, extra.at, 400), "the early beat captured the heart").toBeGreaterThan(0.9);
  // the steady beat that fell while the muscle was still resetting did nothing: the heart went quiet and stayed quiet
  expect(Math.abs(blocked.at - before.at - PACEMAKER_PERIOD_MS)).toBeLessThan(40);
  const lastOfEarly = log.excited.filter((x) => x.at > blocked.at + 400 && x.at < after.at);
  expect(Math.max(0, ...lastOfEarly.map((x) => x.value)), "nothing fired between the early beat's wave and the next steady beat").toBeLessThan(S.quietBelow);
  // and the steady beat after that captured again, two steady gaps after the one before the early beat
  expect(Math.abs(after.at - before.at - 2 * PACEMAKER_PERIOD_MS)).toBeLessThan(40);
  expect(peakWithin(log, after.at, 400)).toBeGreaterThan(0.9);
  expect(saw.at, "the held steps come after the pause has been drawn").toBeGreaterThan(after.at + 200);
  // "it started from one spot, so it drew a wide, different shape": on this heart's ECG, beside a steady beat
  const [steadyWidth, extraWidth] = await qrsWidths(page, log, [before.at, extra.at]);
  console.log(`early beat lesson: QRS of the steady beat ${steadyWidth} ms, of the early beat ${extraWidth} ms`);
  expect(steadyWidth).toBeLessThanOrEqual(130);
  expect(extraWidth).toBeGreaterThan(steadyWidth + 50);
  // the rest of the lesson
  const took = await play(page, "extra-beat", { readMs: 1500, resume: true });
  console.log(`early beat lesson: ${(took / 1000).toFixed(1)} s more: ${path(await readLog(page), "extra-beat")}`);
});

for (const [id, kind, tissue, watchTitle, watchMs] of [
  ["tachycardia", "racing", R.TACHYCARDIA_TISSUE, "Watch it race", S.keepsGoingMs],
  ["fibrillation", "fibrillation", R.FIBRILLATION_TISSUE, "Watch the chaos", S.seeingMs],
] as const) {
  test(`${kind}: the lab starts it, the viewer watches it go on, Skip cannot pass the Shock step, and the viewer's Shock ends it`, async ({ page }) => {
    test.setTimeout(300_000);
    await open(page);
    await play(page, id, { until: "Fix it" });
    const log = await readLog(page);
    const watch = entered(log, id, watchTitle);
    expect(watch.excited).toBeGreaterThan(S.goingAbove);
    expect(entered(log, id, "Fix it").at - watch.at).toBeGreaterThanOrEqual(watchMs - 100);
    const during = await labState(page);
    expect(during.tissue).toEqual(tissue);
    expect(during.pacemaker).toBe(false);
    // Skip cannot pass this step, and the rhythm does not stop by itself
    await page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.runner.next());
    await page.waitForTimeout(2000);
    const stuck = await page.evaluate(() => {
      const w = window as unknown as { __lab: Lab };
      return { title: w.__lab.runner.state.step?.title, excited: w.__lab.engine.excited };
    });
    expect(stuck.title).toBe("Fix it");
    expect(stuck.excited).toBeGreaterThan(S.goingAbove);
    // the viewer presses Shock: the whole heart fires at once, goes quiet, and the lesson moves on
    const before = (await labState(page)).simTime;
    await pressShock(page);
    await page.waitForFunction(() => (window as unknown as { __lab: Lab }).__lab.runner.state.step?.title === "What you learned", undefined, { timeout: 15_000 });
    const after = await readLog(page);
    // How much of the heart a shock fires depends on the moment it lands (recovering muscle cannot fire), so the check
    // is that it fired far more of it than the rhythm ever had excited at once, and that everything then went quiet.
    const peak = peakWithin(after, before, 1000);
    const rhythmPeak = Math.max(0, ...after.excited.filter((x) => x.at >= before - 2000 && x.at < before).map((x) => x.value));
    console.log(`${kind}: the shock excited ${(peak * 100).toFixed(0)}% of the muscle at once; the rhythm itself at most ${(rhythmPeak * 100).toFixed(0)}%`);
    expect(peak, "the shock fired more of the heart than the rhythm ever did").toBeGreaterThan(rhythmPeak + 0.1);
    expect(peak).toBeGreaterThan(S.shockedAbove);
    expect(after.excited.some((x) => x.at > before && x.at < before + 1500 && x.value < S.quietBelow), "and then everything was quiet").toBe(true);
    const fixed = await labState(page);
    expect(fixed.tissue).toEqual(R.NORMAL_TISSUE);
    expect(fixed.pacemaker).toBe(true);
  });
}

test("shock it back: the viewer's Shock ends fibrillation, the steady rhythm returns, and a Shock on it is refused", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page);
  await play(page, "shock", { until: "Try it on a steady heart", readMs: 1500 });
  const log = await readLog(page);
  const shock = entered(log, "shock", "Shock");
  expect(shock.excited, "it was fibrillating when the viewer was asked to shock it").toBeGreaterThan(S.goingAbove);
  const happened = entered(log, "shock", "What just happened");
  expect(happened.excited, "and everything was still afterwards").toBeLessThan(S.quietBelow);
  // the steady beat comes back by itself (1.5 s of simulated time after the shock; a busy machine runs the simulation
  // slower than real time, so wait for it rather than for the clock on the wall)
  await page.waitForFunction(
    (since) => {
      const w = window as unknown as { lessonLog: Log };
      return w.lessonLog.beats.filter((b) => b.at > since && b.pacemaker).length >= 3;
    },
    happened.at,
    { timeout: 60_000 },
  );
  // the rhythm analyser reads a steady, pumping heart, so the lab's AED rule refuses the shock
  await page.waitForFunction(() => (window as unknown as { __lab: Lab }).__lab.analyzer.state.kind === "steady", undefined, { timeout: 30_000 });
  const refused = await page.evaluate(() => {
    const w = window as unknown as { __lab: Lab };
    return { kind: w.__lab.analyzer.state.kind, result: w.__lab.moves.shock(w.__lab.analyzer.state) };
  });
  expect(refused.kind).toBe("steady");
  expect(refused.result).toEqual({ fired: false, reason: "pumping" });
});
