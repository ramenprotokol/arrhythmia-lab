// Records the demo clip from the real page, with the heartbeat: a steady rhythm, an early beat, the racing wave,
// fibrillation, then the shock and the steady beat coming back. It clicks the page's own buttons, as a visitor would.
// Not a test: it is a build tool, skipped unless MAKE_DEMO=1. It writes the raw recording (with sound) to the folder in
// DEMO_OUT (default test-results/demo) and a converter (see docs/demo.md) makes the small files from it.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import "../app/labHandle";

test.skip(process.env.MAKE_DEMO !== "1", "build tool: run with MAKE_DEMO=1");

/** Wait until the lab has started a rhythm and the reading has caught up with it. */
async function waitForRhythm(page: Page, kind: "racing" | "chaotic") {
  await page.waitForFunction(
    (k) => {
      const l = window.__lab;
      return l.moves.starting === null && l.moves.settling === null && l.analyzer.state.kind === k;
    },
    kind,
    { timeout: 90_000 },
  );
}

test("record the demo clip", async ({ page }) => {
  test.setTimeout(300_000);
  const out = process.env.DEMO_OUT ?? "test-results/demo";
  mkdirSync(out, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?debug&quality=high&clipSeconds=90");
  await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, undefined, { timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__lab), undefined, { timeout: 5_000 });
  await page.waitForFunction(() => window.__lab.analyzer.state.kind === "steady", undefined, { timeout: 30_000 });

  // Sound on first (a click is a real gesture, so the browser lets audio start), then the clip, so both begin together.
  await page.getByRole("button", { name: /^Sound/ }).click();
  await page.waitForFunction(() => window.__lab.audio.state === "on", undefined, { timeout: 5_000 });
  await page.getByRole("button", { name: /Record clip/ }).click();
  await page.waitForTimeout(6500); // the steady rhythm: lub-dub, and the ECG filling in

  await page.getByRole("button", { name: /^Early extra beat/ }).click();
  await page.waitForTimeout(4500); // the early beat, the pause, the steady beat back

  await page.getByRole("button", { name: /^Make it race/ }).click();
  await waitForRhythm(page, "racing");
  await page.waitForTimeout(7000); // the wave chasing its tail

  await page.getByRole("button", { name: /^Make it fibrillate/ }).click();
  await waitForRhythm(page, "chaotic");
  await page.waitForTimeout(7000); // many wavefronts, and silence

  await page.getByRole("button", { name: /^Shock/ }).click();
  await page.waitForTimeout(9000); // the flash, the pause, and the steady beat coming back

  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.getByRole("button", { name: /Stop and save/ }).click()]);
  await download.saveAs(`${out}/demo-raw.webm`);
  expect(await download.failure()).toBeNull();
});
