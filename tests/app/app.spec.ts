// The whole page, in real Chrome with the real GPU: it starts, beats, draws the ECG, takes taps and buttons,
// runs the lessons, records a clip, and works on a phone-sized screen.
import { test, expect } from "@playwright/test";
import { consoleGuard } from "../ui/consoleGuard";
import { LESSONS } from "../../src/lessons/lessons";
import { DISCLAIMER, SHOCK_REFUSAL } from "../../src/copy";
import { openExplore, playLesson, start, tapHeart } from "./page";
import "./labHandle";

const guard = consoleGuard();

test.beforeEach(async ({ page }) => {
  guard.attach(page);
});
test.afterEach(async ({ page }) => {
  guard.check();
  const gpuErrors = await page.evaluate(() => window.__labErrors ?? []);
  expect(gpuErrors).toEqual([]);
});

test("the lab starts, the heart beats by itself, and the ECG fills in", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await page.evaluate(() => window.__lab.setSpeed(1));
  await page.waitForFunction(() => window.__lab.engine.simTime > 2500, undefined, { timeout: 60_000 });
  const r = await page.evaluate(() => {
    const t = window.__lab.monitor.getTrace(1);
    let max = 0;
    for (const v of t.v) max = Math.max(max, Math.abs(v));
    return { beat: window.__lab.engine.lastBeatAt, samples: t.t.length, max };
  });
  console.log(`started: last beat at ${r.beat.toFixed(0)} ms, lead II has ${r.samples} samples, peak ${r.max.toFixed(2)} mV`);
  expect(r.beat).toBeGreaterThan(0);
  expect(r.samples).toBeGreaterThan(200);
  expect(r.max).toBeGreaterThan(0.2); // a real deflection, not a flat line
  // one short disclaimer is always on show
  await expect(page.getByText(DISCLAIMER.banner).first()).toBeVisible();
  // the credits are kept, one click away
  const credit = page.getByText("Built with Claude Sonnet 5.5. Not affiliated with Anthropic.");
  await expect(credit).toBeHidden();
  await page.getByRole("button", { name: "What is this?" }).first().click();
  await page.getByRole("button", { name: "Credits and sources" }).first().click();
  await expect(credit).toBeVisible();
  await expect(page.getByText("Fonts: Instrument Sans, Instrument Serif, JetBrains Mono, SIL OFL 1.1.")).toBeVisible();
});

test("a tap on the heart fires a beat there, and the buttons work", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await page.evaluate(() => (window.__lab.engine.pacemaker = false));
  const before = await page.evaluate(() => window.__lab.engine.lastBeatAt);
  await tapHeart(page);
  await page.waitForFunction((b) => window.__lab.engine.lastBeatAt > b, before, { timeout: 5_000 });
  // an early extra beat is timed by the lab, so it fires a moment later
  const beforeExtra = await page.evaluate(() => window.__lab.engine.lastBeatAt);
  await page.getByRole("button", { name: "Early extra beat", exact: true }).click();
  await page.waitForFunction((b) => window.__lab.engine.lastBeatAt > b, beforeExtra, { timeout: 5_000 });
  // Shock, like a defibrillator, will not shock a heart that is not in a shockable rhythm, and says why
  const shocks = await page.evaluate(() => window.__lab.audio.stats.shock);
  await page.getByRole("button", { name: "Shock", exact: true }).click();
  await expect(page.locator("#toast")).toBeVisible();
  expect([SHOCK_REFUSAL.pumping, SHOCK_REFUSAL.still]).toContain(await page.locator("#toast").textContent());
  expect(await page.evaluate(() => window.__lab.audio.stats.shock)).toBe(shocks);
  // the tissue sliders and presets drive the simulation
  await openExplore(page);
  await page.getByRole("button", { name: "Very fragile" }).click();
  const t = await page.evaluate(() => window.__lab.engine.tissue);
  expect(t.conduction).toBeCloseTo(0.5, 2);
  expect(t.recovery).toBeCloseTo(0.17, 2);
  await page.getByRole("button", { name: "Fragile", exact: true }).click();
  expect(await page.evaluate(() => window.__lab.engine.tissue)).toEqual({ conduction: 0.7, recovery: 0.3 });
  await page.getByRole("button", { name: "Healthy" }).click();
  expect(await page.evaluate(() => window.__lab.engine.tissue)).toEqual({ conduction: 1, recovery: 1 });
  // one beat at the tip, from Explore
  const beforeTip = await page.evaluate(() => window.__lab.engine.lastBeatAt);
  await page.getByRole("button", { name: "Fire one beat" }).click();
  await page.waitForFunction((b) => window.__lab.engine.lastBeatAt > b, beforeTip, { timeout: 5_000 });
});

for (const lesson of LESSONS) {
  test(`the lesson "${lesson.title}" can be played through to the end in the real app`, async ({ page }) => {
    test.setTimeout(300_000);
    await start(page);
    await page.evaluate(() => window.__lab.setSpeed(1));
    const seen = await playLesson(page, lesson.title);
    console.log(`${lesson.title}: ${seen.join(" > ")}`);
    await expect(page.getByText(/Lesson complete/)).toBeVisible();
  });
}

test("recording a clip saves a webm file, the page shows that it is recording, and with the sound on the clip has the heartbeat", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await page.evaluate(() => window.__lab.setSpeed(1));
  await page.getByRole("button", { name: "Record clip" }).click();
  await expect(page.getByRole("button", { name: "Stop and save" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#b-record")).toHaveClass(/recording/);
  await expect(page.locator("#rec-time-button")).toHaveText(/^0:0\d \/ 0:30$/);
  await page.waitForTimeout(2500);
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20_000 }), page.getByRole("button", { name: /Stop and save/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.webm$/);
  const path = await download.path();
  const { readFileSync, statSync } = await import("node:fs");
  expect(statSync(path).size).toBeGreaterThan(5_000);
  await expect(page.getByRole("button", { name: "Record clip" })).toHaveAttribute("aria-pressed", "false");

  // with the sound on, the clip carries the heartbeat: its audio decodes, and it is not silent
  await page.locator("#b-sound").click();
  await page.waitForFunction(() => window.__lab.audio.state === "on", undefined, { timeout: 5_000 });
  await page.getByRole("button", { name: "Record clip" }).click();
  await page.waitForTimeout(3500); // four or five beats at 75 a minute
  const [withSound] = await Promise.all([page.waitForEvent("download", { timeout: 20_000 }), page.getByRole("button", { name: /Stop and save/ }).click()]);
  const bytes = readFileSync(await withSound.path()).toString("base64");
  const sound = await page.evaluate(async (b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const decoded = await new AudioContext().decodeAudioData(data.buffer);
    let peak = 0;
    for (let c = 0; c < decoded.numberOfChannels; c++) for (const v of decoded.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
    return { seconds: decoded.duration, peak };
  }, bytes);
  console.log(`clip with sound: ${sound.seconds.toFixed(1)} s of audio, peak ${sound.peak.toFixed(3)}`);
  expect(sound.seconds).toBeGreaterThan(2);
  expect(sound.peak).toBeGreaterThan(0.01);
});

for (const [name, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]] as const) {
  test(`looks right on a ${name} screen, with no page-wide sideways scrolling`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height });
    await start(page, "debug&quality=medium");
    await page.evaluate(() => window.__lab.setSpeed(1));
    await page.waitForTimeout(1800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? "test-results/screens"}/app-${name}.png` });
  });
}
