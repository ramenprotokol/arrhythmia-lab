// The five lessons played on the real page, in real Chrome with the real GPU, the way a viewer plays them: start a
// lesson with its button, press Next when a step has no waiting in it, and let the waiting steps move on by
// themselves. Nothing is skipped, so every waiting condition has to be satisfied by the real simulation.
//
// Needs the page's ?debug handle (window.__lab, see src/app.ts). The unit tests in lessons.test.ts cover the same
// flows against a stand-in lab; this shows the real one agrees.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { consoleGuard } from "./consoleGuard";
import * as R from "../../src/lessons/recipes";
import { LESSONS } from "../../src/lessons/lessons";

// The page runs at half speed unless told otherwise. LESSON_SPEED=0.5 plays the lessons at that pace (they take about twice as long).
const SPEED = Number(process.env.LESSON_SPEED ?? 1);

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
  runner: { state: { lessonId: string | null; stepIndex: number; finished: boolean } };
  setSpeed(s: number): void;
};
type Log = {
  beats: { at: number; pacemaker: boolean }[];
  steps: { step: number; lesson: string | null; at: number; pacemaker: boolean; excited: number }[];
  /** How much of the muscle was excited, on every frame. */
  excited: { at: number; value: number }[];
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
    const log: Log = { beats: [], steps: [], excited: [] };
    let lastBeat = lab().engine.lastBeatAt;
    let lastStep = -2;
    const sample = () => {
      const e = lab().engine;
      log.excited.push({ at: e.simTime, value: e.excited });
      if (e.lastBeatAt !== lastBeat) {
        lastBeat = e.lastBeatAt;
        log.beats.push({ at: lastBeat, pacemaker: e.pacemaker });
      }
      const s = lab().runner.state;
      const step = s.finished ? 999 : s.stepIndex;
      if (step !== lastStep || s.lessonId !== log.steps[log.steps.length - 1]?.lesson) {
        lastStep = step;
        log.steps.push({ step, lesson: s.lessonId, at: e.simTime, pacemaker: e.pacemaker, excited: e.excited });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    (window as unknown as { lessonLog: Log }).lessonLog = log;
  }, SPEED);
}

/** Play the lesson: its Next button when a step has one, and patience when the step moves on by itself. */
async function play(page: Page, title: RegExp, opts: { budgetMs?: number } = {}) {
  await page.getByRole("button", { name: title }).click();
  const started = Date.now();
  const budget = opts.budgetMs ?? 200_000;
  while (Date.now() - started < budget) {
    const finished = await page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.runner.state.finished);
    if (finished) return Date.now() - started;
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

test("normal beat: the pacemaker pauses, one beat crosses the heart, the pacemaker comes back", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page);
  const took = await play(page, /Normal beat/);
  const log = await readLog(page);
  const running = log.steps.filter((s) => s.lesson === "normal-beat");
  console.log(`normal beat lesson: ${(took / 1000).toFixed(1)} s, steps ${running.map((s) => s.step).join(">")}`);
  const oneBeat = running.find((s) => s.step === 1)!;
  const seen = running.find((s) => s.step === 2)!;
  expect(oneBeat.pacemaker).toBe(false); // paused before the beat
  // exactly one beat was given while the pacemaker was paused
  const whilePaused = log.beats.filter((b) => !b.pacemaker && b.at >= oneBeat.at - 50);
  expect(whilePaused.length).toBe(1);
  expect(seen.excited).toBeLessThan(0.01); // and its wave was over before the lesson moved on
  const end = await page.evaluate(() => {
    const e = (window as unknown as { __lab: Lab }).__lab.engine;
    return { pacemaker: e.pacemaker, tissue: e.tissue };
  });
  expect(end.pacemaker).toBe(true);
  expect(end.tissue).toEqual(R.NORMAL_TISSUE);
});

test("extra beat: steady beats first, then one that comes early, and the muscle copes with it", async ({ page }) => {
  test.setTimeout(300_000);
  await open(page);
  const took = await play(page, /An extra beat \(PVC\)/);
  const log = await readLog(page);
  const started = log.steps.find((s) => s.lesson === "extra-beat")!.at;
  const beats = log.beats.map((b) => b.at).filter((t) => t >= started - 50);
  const gaps = beats.slice(1).map((t, i) => t - beats[i]);
  console.log(`extra beat lesson: ${(took / 1000).toFixed(1)} s, gaps between beats (ms): ${gaps.map((g) => Math.round(g)).join(", ")}`);
  const early = gaps.findIndex((g) => g > R.PVC_EXTRA_BEAT_MS - 60 && g < 800 - 60);
  expect(early, "a gap that is clearly shorter than the steady 800 ms, but long enough for the muscle to have recovered").toBeGreaterThanOrEqual(2);
  // before it the rhythm is steady
  for (const g of gaps.slice(0, early)) expect(Math.abs(g - 800)).toBeLessThan(40);
  // The early beat is a real beat: it captured the whole heart, as the steady ones before it did. (With the pacemaker
  // still running there is always some wave about, so "quiet afterwards" is not something to ask of this lesson.)
  const peakWithin = (from: number, ms: number) => Math.max(...log.excited.filter((x) => x.at >= from && x.at < from + ms).map((x) => x.value));
  const steady = peakWithin(beats[early - 1], 400);
  const extra = peakWithin(beats[early + 1], 400);
  console.log(`extra beat lesson: the whole heart was excited ${(steady * 100).toFixed(0)}% after a steady beat and ${(extra * 100).toFixed(0)}% after the early one`);
  expect(steady).toBeGreaterThan(0.9);
  expect(extra).toBeGreaterThan(0.9);
});

test("sustained tachycardia: the lab starts a wave that keeps circling after the lesson has moved on", async ({ page }) => {
  test.setTimeout(400_000);
  await open(page);
  const took = await play(page, /Sustained tachycardia/);
  const log = await readLog(page);
  const running = log.steps.filter((s) => s.lesson === "tachycardia");
  const status = await page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.engine.inducer.state.status);
  const tissue = await page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.engine.tissue);
  console.log(`tachycardia lesson: ${(took / 1000).toFixed(1)} s, steps ${running.map((s) => s.step).join(">")}, inducer ${status}`);
  expect(status).toBe("success");
  expect(tissue).toEqual(R.TACHYCARDIA_TISSUE);
  // the step that says "the wave keeps going" was entered while it did, and it still does a few seconds later
  const keeps = running.find((s) => s.step === 3)!;
  expect(keeps.excited).toBeGreaterThan(0.05);
  const series: number[] = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(500);
    series.push(await excitedNow(page));
  }
  console.log(`tachycardia: excited fraction over the next 4 s: ${series.map((x) => x.toFixed(2)).join(" ")}`);
  expect(Math.min(...series)).toBeGreaterThan(0.03);
  expect(await page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.engine.pacemaker)).toBe(false); // the lab switched it off, as the lesson says
});

test("break into fibrillation: a burst of fast beats breaks into many waves that go on", async ({ page }) => {
  test.setTimeout(400_000);
  await open(page);
  const took = await play(page, /Break into fibrillation/);
  const log = await readLog(page);
  const running = log.steps.filter((s) => s.lesson === "fibrillation");
  const status = await page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.engine.inducer.state.status);
  console.log(`fibrillation lesson: ${(took / 1000).toFixed(1)} s, steps ${running.map((s) => s.step).join(">")}, inducer ${status}`);
  expect(status).toBe("success");
  expect(await page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.engine.tissue)).toEqual(R.FIBRILLATION_TISSUE);
  expect(running.find((s) => s.step === 3)!.excited).toBeGreaterThan(0.05);
  const series: number[] = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(500);
    series.push(await excitedNow(page));
  }
  console.log(`fibrillation: excited fraction over the next 4 s: ${series.map((x) => x.toFixed(2)).join(" ")}`);
  expect(Math.min(...series)).toBeGreaterThan(0.03);
});

test("shock it back: fibrillation, one shock, silence, then the regular rhythm returns", async ({ page }) => {
  test.setTimeout(400_000);
  await open(page);
  const took = await play(page, /Shock it back/);
  const log = await readLog(page);
  const running = log.steps.filter((s) => s.lesson === "shock");
  console.log(`shock lesson: ${(took / 1000).toFixed(1)} s, steps ${running.map((s) => s.step).join(">")}`);
  const before = running.find((s) => s.step === 2)!; // entered when the shock is about to be given
  const after = running.find((s) => s.step === 3)!; // "What just happened"
  expect(before.excited, "it was fibrillating when the shock came").toBeGreaterThan(0.05);
  expect(after.excited, "and everything was still afterwards").toBeLessThan(0.01);
  const end = await page.evaluate(() => {
    const e = (window as unknown as { __lab: Lab }).__lab.engine;
    return { pacemaker: e.pacemaker, tissue: e.tissue };
  });
  expect(end.pacemaker).toBe(true);
  expect(end.tissue).toEqual(R.NORMAL_TISSUE);
  // the regular beats did come back before the lesson ended
  const shockAt = after.at;
  const back = log.beats.filter((b) => b.at > shockAt && b.pacemaker);
  console.log(`shock lesson: ${back.length} steady beats after the shock`);
  expect(back.length).toBeGreaterThanOrEqual(2);
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
  /** Play a lesson until it reaches a step, and stay there. */
  const playTo = async (title: RegExp, step: number) => {
    await page.getByRole("button", { name: title }).click();
    for (let i = 0; i < 400; i++) {
      const at = await page.evaluate(() => (window as unknown as { __lab: Lab }).__lab.runner.state.stepIndex);
      if (at >= step) return;
      const next = page.getByRole("button", { name: "Next", exact: true });
      if (await next.count()) {
        await page.waitForTimeout(500);
        await next.first().click({ timeout: 2000 }).catch(() => undefined);
      } else await page.waitForTimeout(300);
    }
    throw new Error("the lesson did not reach the step");
  };
  const stop = () => page.getByRole("button", { name: "Stop", exact: true }).click();

  await playTo(/Normal beat/, 2); // "What you just saw"
  await page.waitForTimeout(300);
  await save("1-one-normal-beat");
  await stop();

  await playTo(/An extra beat \(PVC\)/, 3); // "What you just saw"
  await page.waitForTimeout(800);
  await save("2-an-early-extra-beat");
  await stop();

  await playTo(/Sustained tachycardia/, 3); // "A wave that keeps going"
  await page.waitForTimeout(4500);
  await save("3-tachycardia");
  await stop();

  await playTo(/Break into fibrillation/, 3); // "What you are seeing"
  await page.waitForTimeout(4500);
  await save("4-fibrillation");
  await stop();

  await playTo(/Shock it back/, 3); // "What just happened"
  await page.waitForTimeout(2200);
  await save("5-after-the-shock");
});
