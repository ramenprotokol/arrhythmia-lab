// The whole page, in real Chrome with the real GPU: it starts, beats, draws the ECG, takes taps and buttons,
// runs the lessons, records a clip, and works on a phone-sized screen.
import { test, expect, type Page } from "@playwright/test";
import { consoleGuard } from "../ui/consoleGuard";
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

async function start(page: Page, query = "debug&quality=low") {
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, undefined, { timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__lab), undefined, { timeout: 5_000 });
}

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
  await expect(page.getByText("Educational simulation. Not a medical device.").first()).toBeVisible();
  await expect(page.getByText("Built with Claude Sonnet 5.5. Not affiliated with Anthropic.")).toBeVisible();
});

test("a tap on the heart fires a beat there, and the buttons work", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await page.evaluate(() => (window.__lab.engine.pacemaker = false));
  const before = await page.evaluate(() => window.__lab.engine.lastBeatAt);
  const box = (await page.locator("#heart").boundingBox()) as { x: number; y: number; width: number; height: number };
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.waitForFunction((b) => window.__lab.engine.lastBeatAt > b, before, { timeout: 5_000 });
  await page.getByRole("button", { name: "Extra beat", exact: true }).click();
  await page.getByRole("button", { name: "Beat at the tip" }).click();
  await page.getByRole("button", { name: "Shock", exact: true }).click();
  const excited = await page.evaluate(() => window.__lab.sim.excitedFraction());
  expect(excited).toBe(0);
  // the tissue sliders and presets drive the simulation
  await page.getByRole("button", { name: "Fragile" }).click();
  const t = await page.evaluate(() => window.__lab.engine.tissue);
  expect(t.conduction).toBeCloseTo(0.5, 2);
  expect(t.recovery).toBeCloseTo(0.17, 2);
  await page.getByRole("button", { name: "Healthy" }).click();
  expect(await page.evaluate(() => window.__lab.engine.tissue)).toEqual({ conduction: 1, recovery: 1 });
});

test("the guided lessons run from the page, including starting a tachycardia", async ({ page }) => {
  test.setTimeout(240_000);
  await start(page);
  await page.evaluate(() => window.__lab.setSpeed(1));
  await page.getByRole("button", { name: /Sustained tachycardia/ }).click();
  await expect(page.getByText("Sustained tachycardia").first()).toBeVisible();
  // walk the lesson with the Next button, letting waiting steps carry on by themselves
  for (let i = 0; i < 30; i++) {
    const done = await page.evaluate(() => window.__lab.runner.state.finished);
    if (done) break;
    const next = page.getByRole("button", { name: "Next" });
    if (await next.count()) await next.first().click().catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  const state = await page.evaluate(() => ({ status: window.__lab.engine.inducer.state.status, tissue: window.__lab.engine.tissue }));
  console.log(`lesson end: inducer ${state.status}, tissue ${JSON.stringify(state.tissue)}`);
  expect(["success", "idle"]).toContain(state.status);
});

for (const [n, title] of [[1, "Normal beat"], [2, "An extra beat (PVC)"], [3, "Sustained tachycardia"], [4, "Break into fibrillation"], [5, "Shock it back"]] as const) {
  test(`lesson ${n} (${title}) can be played through to the end in the real app`, async ({ page }) => {
    test.setTimeout(300_000);
    await start(page);
    await page.evaluate(() => window.__lab.setSpeed(1));
    await page.getByRole("button", { name: title }).first().click();
    const seen: string[] = [];
    for (let i = 0; i < 120; i++) {
      const st = await page.evaluate(() => ({ done: window.__lab.runner.state.finished, idx: window.__lab.runner.state.stepIndex, excited: window.__lab.engine.excited }));
      if (st.done) break;
      seen.push(`${st.idx}`);
      // The viewer's part: press Next when it is offered; in the shock lesson also press the amber Shock button when asked.
      const shockAsked = await page.getByText(/press the (amber )?shock button/i).count();
      if (shockAsked && st.excited > 0.02) await page.getByRole("button", { name: "Shock", exact: true }).click();
      const next = page.getByRole("button", { name: "Next", exact: true });
      if (await next.count()) await next.first().click().catch(() => undefined);
      await page.waitForTimeout(1200);
    }
    const end = await page.evaluate(() => ({ done: window.__lab.runner.state.finished, inducer: window.__lab.engine.inducer.state.status }));
    console.log(`lesson ${n}: finished ${end.done}, steps visited ${[...new Set(seen)].join(",")}, inducer ${end.inducer}`);
    expect(end.done).toBe(true);
    await expect(page.getByText(/Lesson complete/)).toBeVisible();
  });
}

test("recording a clip saves a webm file", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await page.evaluate(() => window.__lab.setSpeed(1));
  await page.getByRole("button", { name: "Record clip" }).click();
  await page.waitForTimeout(2500);
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20_000 }), page.getByRole("button", { name: /Stop and save/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.webm$/);
  const path = await download.path();
  const { statSync } = await import("node:fs");
  expect(statSync(path).size).toBeGreaterThan(5_000);
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
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? "test-results/screens"}/app-${name}.png`, fullPage: name === "phone" });
  });
}
