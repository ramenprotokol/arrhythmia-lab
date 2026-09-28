// Takes the README screenshot and the social-preview image from the real page. Not a test: a build tool,
// skipped unless MAKE_SHOTS=1. Writes docs/screenshot.png and public/og.png.
import { test } from "@playwright/test";
import "../app/labHandle";

test.skip(process.env.MAKE_SHOTS !== "1", "build tool: run with MAKE_SHOTS=1");

async function open(page: import("@playwright/test").Page, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto("/?debug&quality=high");
  await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, undefined, { timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__lab), undefined, { timeout: 5_000 });
}

test("screenshots for the README and the social preview", async ({ page }) => {
  test.setTimeout(240_000);
  await open(page, 1440, 900);
  await page.evaluate(() => window.__lab.setSpeed(0.5));
  // a racing wave circling: the most striking single frame
  await page.getByRole("button", { name: "Racing" }).click();
  await page.evaluate(() => window.__lab.engine.induce("tachycardia"));
  await page.waitForFunction(() => window.__lab.engine.inducer.state.status === "success", undefined, { timeout: 60_000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: "docs/screenshot.png" });
  // the social preview: 1200 x 630, the same scene
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "public/og.png" });
});
