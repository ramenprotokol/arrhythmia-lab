// The five lessons played on the real page, in real Chrome with the real GPU, the way a viewer plays them: start a
// lesson with its button, press Next when a step has one, press the Shock button when the lesson asks for it, and
// let the waiting steps move on by themselves. Nothing is skipped, so every waiting condition has to be satisfied
// by the real simulation.
//
// Needs the page's ?debug handle (window.__lab, see src/app.ts). The unit tests in lessons.test.ts cover the same
// flows against a stand-in lab; this shows the real one agrees.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { consoleGuard } from "./consoleGuard";
import * as R from "../../src/lessons/recipes";
import { LESSONS, LESSON_SETTINGS } from "../../src/lessons/lessons";

// The page runs at half speed unless told otherwise. LESSON_SPEED=0.5 plays the lessons at that pace (they take about twice as long).
const SPEED = Number(process.env.LESSON_SPEED ?? 1);
const S = LESSON_SETTINGS;

const guard = consoleGuard();
test.beforeEach(({ page }) => guard.attach(page));
test.afterEach(async ({ page }) => {
  guard.check();
  const gpuErrors = await page.evaluate(() => (window as unknown as { __labErrors?: string[] }).__labErrors ?? []);
  expect(gpuErrors).toEqual([]);
});
test.describe.configure({ mode: "serial" });

type Lab = {
  engine: { simTime: number; lastBeatAt: number; excited: number; pacemaker: boolean; tissue: { conduction: number; recovery: number }; inducer: { state: { status: string } } };
  sim: { excitedFraction(): Promise<number> };
  runner: { state: { lessonId: string | null; stepIndex: number; step: { title?: string } | null; finished: boolean } };
  setSpeed(s: number): void;
};
type Log = {
  beats: { at: number; pacemaker: boolean }[];
  steps: { title: string; lesson: string | null; at: number; pacemaker: boolean; excited: number }[];
  /** How much of the muscle was excited, on every frame. */
  excited: { at: number; value: number }[];
  /** The simulated time at which this test pressed the Shock button. */
  shocks: number[];
};
// Inside page.evaluate the callbacks run in the page, so each one reads the handle for itself.

async function open(page: Page) {
  await page.goto("/?debug&quality=low");
  await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, undefined, { timeout: 90_000 });
  await page.waitForFunction(() => Boolean((window as unknown as { __lab?: unknown }).__lab), undefined, { timeout: 5_000 });
  await page.evaluate((speed) => {
    const lab = () => (window as unknown as { __lab: Lab }).__lab;
    lab().setSpeed(speed);
    // a sampler that notes every beat and every change of step, as the lessons run
    const log: Log = { beats: [], steps: [], excited: [], shocks: [] };
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
        log.steps.push({ title, lesson: s.lessonId, at: e.simTime, pacemaker: e.pacemaker, excited: e.excited });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    (window as unknown as { lessonLog: Log }).lessonLog = log;
  }, SPEED);
}

/**
 * Start a lesson and play it: press Next when a step has one, press the Shock button when the lesson says to, and
 * otherwise wait. Stops when the lesson is finished, or when it reaches the step called `until`.
 */
async function play(page: Page, title: RegExp, opts: { until?: string; budgetMs?: number } = {}) {
  await page.getByRole("button", { name: title }).click();
  const started = Date.now();
  const budget = opts.budgetMs ?? 200_000;
  let pressed = false;
  while (Date.now() - started < budget) {
    const now = await page.evaluate(() => {
      const s = (window as unknown as { __lab: Lab }).__lab.runner.state;
      return { finished: s.finished, title: s.step?.title ?? null };
    });
    if (now.finished || (opts.until && now.title === opts.until)) return Date.now() - started;
    if (now.title === "Shock" && !pressed) {
      await page.waitForTimeout(1200); // reading
      pressed = true;
      await page.evaluate(() => {
        const w = window as unknown as { __lab: Lab; lessonLog: Log };
        w.lessonLog.shocks.push(w.__lab.engine.simTime);
      });
      await page.getByRole("button", { name: "Shock", exact: true }).click();
      continue;
    }
    const next = page.getByRole("button", { name: "Next", exact: true });
    if (await next.count()) {
      await page.waitForTimeout(700); // reading
      await next.first().click({ timeout: 2000 }).catch(() => undefined);
    } else {
      await page.waitForTimeout(400);
    }
  }
  throw new Error(`the lesson did not finish within ${budget / 1000} s of real time`);
}

const readLog = (page: Page) => page.evaluate(() => (window as unknown as { lessonLog: Log }).lessonLog);
const excitedNow = (page: Page) => page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.sim.excitedFraction());
const labState = (page: Page) =>
  page.evaluate(() => {
    const e = (window as unknown as { __lab: Lab }).__lab.engine;
    return { pacemaker: e.pacemaker, tissue: e.tissue, inducer: e.inducer.state.status };
  });
/** When a lesson's step was first shown, from the sampler's log. */
const entered = (log: Log, lesson: string, title: string) => {
  const step = log.steps.find((s) => s.lesson === lesson && s.title === title);
  if (!step) throw new Error(`the ${lesson} lesson never showed "${title}": ${log.steps.filter((s) => s.lesson === lesson).map((s) => s.title).join(" > ")}`);
  return step;
};
const peakWithin = (log: Log, from: number, ms: number) => Math.max(...log.excited.filter((x) => x.at >= from && x.at < from + ms).map((x) => x.value));
const path = (log: Log, lesson: string) => log.steps.filter((s) => s.lesson === lesson).map((s) => s.title).join(" > ");

test("normal beat: the pacemaker pauses, one beat crosses the heart, the pacemaker comes back", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page);
  const took = await play(page, /Normal beat/);
  const log = await readLog(page);
  console.log(`normal beat lesson: ${(took / 1000).toFixed(1)} s: ${path(log, "normal-beat")}`);
  const oneBeat = entered(log, "normal-beat", "One beat");
  const seen = entered(log, "normal-beat", "What you just saw");
  expect(oneBeat.pacemaker).toBe(false); // paused before the beat
  // exactly one beat was given while the pacemaker was paused
  const whilePaused = log.beats.filter((b) => !b.pacemaker && b.at >= oneBeat.at - 50);
  expect(whilePaused.length).toBe(1);
  expect(seen.excited).toBeLessThan(0.01); // and its wave was over before the lesson moved on
  const end = await labState(page);
  expect(end.pacemaker).toBe(true);
  expect(end.tissue).toEqual(R.NORMAL_TISSUE);
});

test("extra beat: two steady beats, then an early one, all given by the lesson with the pacemaker paused", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page);
  const took = await play(page, /An extra beat \(PVC\)/);
  const log = await readLog(page);
  const beatOne = entered(log, "extra-beat", "Beat one");
  const learned = entered(log, "extra-beat", "What you learned");
  const given = log.beats.filter((b) => b.at >= beatOne.at - 60 && b.at < learned.at);
  console.log(`extra beat lesson: ${(took / 1000).toFixed(1)} s: ${path(log, "extra-beat")}`);
  expect(given, "the lesson's own three beats and nothing else").toHaveLength(3);
  expect(given.every((b) => !b.pacemaker)).toBe(true);
  const [one, two, extra] = given.map((b) => b.at);
  console.log(`extra beat lesson: beats ${Math.round(two - one)} ms and ${Math.round(extra - two)} ms apart`);
  expect(Math.abs(two - one - S.steadyGapMs)).toBeLessThan(40);
  expect(extra - two).toBeGreaterThanOrEqual(R.PVC_EXTRA_BEAT_MS);
  expect(extra - two).toBeLessThan(R.PVC_EXTRA_BEAT_MS + 40);
  // every one of them, the early one included, captured the whole heart
  const peaks = [one, two, extra].map((at) => peakWithin(log, at, 400));
  console.log(`extra beat lesson: the excited share of the heart peaked at ${peaks.map((p) => `${(p * 100).toFixed(0)}%`).join(", ")}`);
  for (const p of peaks) expect(p).toBeGreaterThan(0.9);
  // and the heart was quiet again before the lesson moved on, and the pacemaker came back
  expect(entered(log, "extra-beat", "What you just saw").excited).toBeLessThan(0.01);
  expect((await labState(page)).pacemaker).toBe(true);
});

test("sustained tachycardia: the lab starts a wave that keeps circling after the lesson has moved on", async ({ page }) => {
  test.setTimeout(400_000);
  await open(page);
  const took = await play(page, /Sustained tachycardia/);
  const log = await readLog(page);
  const state = await labState(page);
  console.log(`tachycardia lesson: ${(took / 1000).toFixed(1)} s: ${path(log, "tachycardia")}; inducer ${state.inducer}`);
  expect(state.inducer).toBe("success");
  expect(state.tissue).toEqual(R.TACHYCARDIA_TISSUE);
  expect(state.pacemaker).toBe(false); // the lab switched it off, as the lesson says
  // the step that says "the wave keeps going" is shown while it does, and stays for as long as it says
  const keeps = entered(log, "tachycardia", "A wave that keeps going");
  expect(keeps.excited).toBeGreaterThan(S.goingAbove);
  expect(entered(log, "tachycardia", "What you learned").at - keeps.at).toBeGreaterThanOrEqual(S.keepsGoingMs - 100);
  const series: number[] = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(500);
    series.push(await excitedNow(page));
  }
  console.log(`tachycardia: excited fraction over the next 4 s: ${series.map((x) => x.toFixed(2)).join(" ")}`);
  expect(Math.min(...series)).toBeGreaterThan(0.03);
});

test("break into fibrillation: a burst of fast beats breaks into many waves that go on", async ({ page }) => {
  test.setTimeout(400_000);
  await open(page);
  const took = await play(page, /Break into fibrillation/);
  const log = await readLog(page);
  const state = await labState(page);
  console.log(`fibrillation lesson: ${(took / 1000).toFixed(1)} s: ${path(log, "fibrillation")}; inducer ${state.inducer}`);
  expect(state.inducer).toBe("success");
  expect(state.tissue).toEqual(R.FIBRILLATION_TISSUE);
  const seeing = entered(log, "fibrillation", "What you are seeing");
  expect(seeing.excited).toBeGreaterThan(S.goingAbove);
  expect(entered(log, "fibrillation", "What you learned").at - seeing.at).toBeGreaterThanOrEqual(S.seeingMs - 100);
  const series: number[] = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(500);
    series.push(await excitedNow(page));
  }
  console.log(`fibrillation: excited fraction over the next 4 s: ${series.map((x) => x.toFixed(2)).join(" ")}`);
  expect(Math.min(...series)).toBeGreaterThan(0.03);
});

test("shock it back: the lab sets up fibrillation, the viewer presses Shock, and the regular rhythm returns", async ({ page }) => {
  test.setTimeout(400_000);
  await open(page);
  const took = await play(page, /Shock it back/);
  const log = await readLog(page);
  console.log(`shock lesson: ${(took / 1000).toFixed(1)} s: ${path(log, "shock")}`);
  const before = entered(log, "shock", "Shock"); // shown when the viewer is asked to press the button
  const after = entered(log, "shock", "What just happened");
  expect(before.excited, "it was fibrillating when the viewer was asked to shock it").toBeGreaterThan(S.goingAbove);
  expect(log.shocks, "the test, as the viewer, pressed Shock once").toHaveLength(1);
  expect(after.at, "the lesson moved on because of that press, not before").toBeGreaterThanOrEqual(log.shocks[0]);
  expect(after.excited, "and everything was still afterwards").toBeLessThan(S.quietBelow);
  const end = await labState(page);
  expect(end.pacemaker).toBe(true);
  expect(end.tissue).toEqual(R.NORMAL_TISSUE);
  // the regular beats did come back before the lesson ended, and the lesson gave none of its own
  const back = log.beats.filter((b) => b.at > after.at && b.pacemaker);
  console.log(`shock lesson: ${back.length} steady beats after the shock`);
  expect(back.length).toBeGreaterThanOrEqual(2);
});

test("shock it back: the Shock step waits for the viewer, and after a while says which button to press", async ({ page }) => {
  test.setTimeout(400_000);
  await open(page);
  await play(page, /Shock it back/, { until: "Shock" });
  const stillThere = async () =>
    page.evaluate(() => {
      const s = (window as unknown as { __lab: Lab }).__lab.runner.state;
      return { title: s.step?.title ?? null, finished: s.finished };
    });
  // nothing moves the lesson on while the heart is still fibrillating
  await page.waitForTimeout(3000);
  expect(await stillThere()).toEqual({ title: "Shock", finished: false });
  expect(await excitedNow(page)).toBeGreaterThan(S.goingAbove);
  // after about twelve seconds stuck, the page shows the step's hint
  const hint = page.locator(".hintline");
  await expect(hint).toBeVisible({ timeout: 20_000 });
  await expect(hint).toContainText("amber Shock button");
  expect(await stillThere()).toEqual({ title: "Shock", finished: false });
  // and the button really is there and does it
  await page.getByRole("button", { name: "Shock", exact: true }).click();
  await page.waitForFunction(() => (window as unknown as { __lab: Lab }).__lab.runner.state.step?.title === "What just happened", undefined, { timeout: 10_000 });
  expect(await excitedNow(page)).toBe(0);
});

test("every lesson played on the real page is one the data lists, in the order the panel shows them", async ({ page }) => {
  await open(page);
  const titles = await page.locator(".lesson-list button").allInnerTexts();
  expect(titles.map((t) => t.replace(/^\d+\s*/, "").trim())).toEqual(LESSONS.map((l) => l.title));
});

// Not a check: pictures of the real ECG at the moments the lessons describe, so the words can be compared with what is
// drawn. Other Playwright runs clear test-results/, so a second copy can be kept elsewhere by setting UI_SCREENS_DIR.
const SCREEN_DIRS = ["test-results/screens", process.env.UI_SCREENS_DIR].filter((d): d is string => Boolean(d));

test("pictures of the real ECG at the moments the lessons describe", async ({ page }) => {
  test.setTimeout(400_000);
  await open(page);
  await page.getByRole("button", { name: "One lead" }).click();
  const save = async (name: string) => {
    const png = await page.locator("#monitor").screenshot();
    for (const dir of SCREEN_DIRS) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/lesson-ecg-${name}.png`, png);
    }
  };
  const stop = () => page.getByRole("button", { name: "Stop", exact: true }).click();

  await play(page, /Normal beat/, { until: "What you just saw" });
  await page.waitForTimeout(300);
  await save("1-one-normal-beat");
  await stop();

  await play(page, /An extra beat \(PVC\)/, { until: "What you just saw" });
  await page.waitForTimeout(800);
  await save("2-an-early-extra-beat");
  await stop();

  await play(page, /Sustained tachycardia/, { until: "A wave that keeps going" });
  await page.waitForTimeout(4500);
  await save("3-tachycardia");
  await stop();

  await play(page, /Break into fibrillation/, { until: "What you are seeing" });
  await page.waitForTimeout(4000);
  await save("4-fibrillation");
  await stop();

  await play(page, /Shock it back/, { until: "What just happened" });
  await page.waitForTimeout(2200);
  await save("5-after-the-shock");
});
