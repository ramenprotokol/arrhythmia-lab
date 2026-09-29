// Takes the README screenshot and the social-preview picture from the real page. Not a test: a build tool, skipped
// unless MAKE_SHOTS=1. Writes docs/screenshot.png and a heart-only shot (SHOT_DIR); the social image is composed from
// it (see docs/demo.md).
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
  // what a visitor does first: tap the heart (that also clears the "tap the heart" hint), then break it
  await page.mouse.click(760, 430);
  await page.waitForTimeout(1500);
  // a racing wave circling: the most striking single frame
  await page.getByRole("button", { name: /^Make it race/ }).click();
  await page.waitForFunction(
    () => {
      const l = window.__lab;
      return l.moves.starting === null && l.moves.settling === null && l.analyzer.state.kind === "racing";
    },
    undefined,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "docs/screenshot.png" });
  // the heart alone: the title bar, cards, buttons, labels and marker hidden (the canvas lives inside #hero, so hide its
  // siblings one by one, never #hero itself)
  await page.evaluate(() =>
    document
      .querySelectorAll("#topbar, #rec-chip, #hero-chip, #status, #actions-wrap, #dock, .phone-row, #coach, #drawer, #labels, #tap-marker, #flash")
      .forEach((e) => ((e as HTMLElement).style.visibility = "hidden")),
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${process.env.SHOT_DIR ?? "test-results/screens"}/heart-clean.png` });
});
