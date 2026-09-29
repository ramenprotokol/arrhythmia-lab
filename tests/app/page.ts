// Helpers shared by the page tests: open the lab, find the heart on screen, and do what a visitor does.
import { expect, type Page } from "@playwright/test";
import "./labHandle";

export async function start(page: Page, query = "debug&quality=low"): Promise<void> {
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, undefined, { timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__lab), undefined, { timeout: 5_000 });
}

/** A point on the heart muscle near the middle of what is on screen, in page pixels, found by asking the renderer. */
export async function heartPoint(page: Page): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(() => {
    const r = document.getElementById("heart")!.getBoundingClientRect();
    const hits: [number, number][] = [];
    for (let y = 8; y < r.height; y += 12) for (let x = 8; x < r.width; x += 12) if (window.__lab.renderer.pick(x, y)) hits.push([x, y]);
    if (hits.length === 0) return null;
    const cx = hits.reduce((a, h) => a + h[0], 0) / hits.length;
    const cy = hits.reduce((a, h) => a + h[1], 0) / hits.length;
    hits.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    return { x: hits[0][0] + r.x, y: hits[0][1] + r.y };
  });
  expect(p, "the heart is somewhere on screen").not.toBeNull();
  return p as { x: number; y: number };
}

/**
 * Where the heart is drawn, sampled every `step` pixels, and which of those points a visible panel covers. Returns the
 * share covered by each panel (0 means the panel never sits on the heart).
 */
export async function heartCoverage(page: Page, selectors: string[], step = 10): Promise<{ points: number; covered: Record<string, number> }> {
  return page.evaluate(
    ({ selectors, step }) => {
      const r = document.getElementById("heart")!.getBoundingClientRect();
      const pts: [number, number][] = [];
      for (let y = step / 2; y < r.height; y += step)
        for (let x = step / 2; x < r.width; x += step) {
          const px = x + r.x;
          const py = y + r.y;
          if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight) continue;
          if (window.__lab.renderer.pick(x, y)) pts.push([px, py]);
        }
      const covered: Record<string, number> = {};
      for (const sel of selectors) {
        const els = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((el) => {
          if (el.closest("[hidden]")) return false;
          const s = getComputedStyle(el);
          return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0;
        });
        let n = 0;
        for (const [x, y] of pts)
          if (
            els.some((el) => {
              const b = el.getBoundingClientRect();
              return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
            })
          )
            n++;
        covered[sel] = pts.length ? n / pts.length : 0;
      }
      return { points: pts.length, covered };
    },
    { selectors, step },
  );
}

/** Tap (or click) the heart itself. */
export async function tapHeart(page: Page, touch = false): Promise<void> {
  const p = await heartPoint(page);
  if (touch) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}

/** Open the lessons the way a visitor does. */
export async function openLessons(page: Page): Promise<void> {
  if (await page.locator(".lesson-list button, .lesson-row").first().isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: "Lessons", exact: true }).first().click();
  await expect(page.locator("#drawer")).toBeVisible();
}

/** Open Explore the way a visitor does. */
export async function openExplore(page: Page): Promise<void> {
  if (await page.locator("#s-conduction").isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: "Explore", exact: true }).first().click();
  await expect(page.locator("#s-conduction")).toBeVisible();
}

/**
 * Play a lesson through the page's own buttons: press Next when it is offered, tap the heart when asked to, press Shock
 * when a "Fix it" step waits for it, and otherwise let the lesson carry on by itself.
 */
export async function playLesson(page: Page, title: string, budgetMs = 240_000): Promise<string[]> {
  await openLessons(page);
  await page.locator(".lesson-list button", { hasText: title }).first().click();
  const seen: string[] = [];
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    const s = await page.evaluate(() => {
      const st = window.__lab.runner.state;
      return { done: st.finished, title: st.step?.title ?? "", waitsForViewer: st.step?.canSkip === false, kind: window.__lab.analyzer.state.kind };
    });
    if (s.done) return seen;
    if (seen[seen.length - 1] !== s.title) seen.push(s.title);
    // a step only the viewer can finish, with the heart racing or fibrillating, is waiting for Shock
    if (s.waitsForViewer && (s.kind === "racing" || s.kind === "chaotic")) {
      await page.getByRole("button", { name: "Shock", exact: true }).click();
    } else if (/tap the heart/i.test(s.title)) {
      await tapHeart(page);
    }
    const next = page.getByRole("button", { name: "Next", exact: true });
    if (await next.count()) await next.first().click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(700);
  }
  throw new Error(`the lesson "${title}" did not finish in ${budgetMs / 1000} s; steps seen: ${seen.join(" > ")}`);
}
