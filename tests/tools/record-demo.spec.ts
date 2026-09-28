// Records the demo clip from the real page: a normal rhythm, a racing wave, fibrillation, then the shock.
// Not a test: it is a build tool, skipped unless MAKE_DEMO=1. It writes the raw recording to the folder in
// DEMO_OUT (default test-results/demo) and a converter (see docs/demo.md) makes the small files from it.
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import "../app/labHandle";

test.skip(process.env.MAKE_DEMO !== "1", "build tool: run with MAKE_DEMO=1");

test("record the demo clip", async ({ page }) => {
  test.setTimeout(240_000);
  const out = process.env.DEMO_OUT ?? "test-results/demo";
  mkdirSync(out, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?debug&quality=high&clipSeconds=90");
  await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, undefined, { timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__lab), undefined, { timeout: 5_000 });
  await page.evaluate(() => window.__lab.setSpeed(0.5));

  await page.getByRole("button", { name: "Record clip" }).click();
  await page.waitForTimeout(4500); // the pacemaker's normal rhythm, and the ECG filling in

  await page.getByRole("button", { name: "Racing" }).click();
  await page.evaluate(() => window.__lab.engine.induce("tachycardia"));
  await page.waitForFunction(() => window.__lab.engine.inducer.state.status === "success", undefined, { timeout: 60_000 });
  await page.waitForTimeout(6000); // the wave chasing its tail

  await page.getByRole("button", { name: "Fragile" }).click();
  await page.evaluate(() => window.__lab.engine.induce("fibrillation"));
  await page.waitForFunction(() => window.__lab.engine.inducer.state.status === "success", undefined, { timeout: 60_000 });
  await page.waitForTimeout(6000); // many wavefronts

  await page.getByRole("button", { name: "Shock", exact: true }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Healthy" }).click();
  await page.getByRole("button", { name: "Pacemaker: off" }).click();
  await page.waitForTimeout(5000); // the normal rhythm returns

  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.getByRole("button", { name: /Stop and save/ }).click()]);
  await download.saveAs(`${out}/demo-raw.webm`);
  expect(await download.failure()).toBeNull();
});
