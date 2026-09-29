// The page around the heart, in real Chrome with the real GPU: the status card, the break-it and fix-it buttons, the
// sound button, the ECG dock and Compare, the drawer, the first-run coach, the keyboard, the phone layout and the
// contrast of the words. The rule under all of it: nothing ever sits on top of the heart.
import { test, expect, type Page } from "@playwright/test";
import { consoleGuard } from "../ui/consoleGuard";
import { HUD, LEAD_CAPTIONS, RHYTHM_COPY, SHOCK_REFUSAL, SIM_ECG_NOTES, SOUND_SILENCE, SOUND_STATE, STARTING_MESSAGE } from "../../src/copy";
import { fill } from "../../src/ui/text";
import { heartCoverage, openExplore, openLessons, start, tapHeart } from "./page";
import "./labHandle";

const guard = consoleGuard();
test.beforeEach(({ page }) => guard.attach(page));
test.afterEach(async ({ page }) => {
  guard.check();
  const gpuErrors = await page.evaluate(() => window.__labErrors ?? []);
  expect(gpuErrors).toEqual([]);
});

/** Everything that is not the heart and could sit on it. */
const PANELS = ["#topbar", "#status", "#coach", "#actions", "#shock-callout", "#dock", "#drawer", "#credits", "#toast", ".nudge", ".hero-chip", ".rec-chip", ".silence-note"];

const card = (page: Page) => page.locator("#status");
const kind = (page: Page, want: string, timeout = 60_000) => page.waitForFunction((k) => window.__lab.analyzer.state.kind === k, want, { timeout });
const induced = (page: Page) => page.waitForFunction(() => window.__lab.engine.inducer.state.status === "success", undefined, { timeout: 90_000 });
const statusKey = (page: Page) => page.locator("#lab").getAttribute("data-status");

/** Every wave on the monitor fits its box at the gain in use: nothing is cut flat at a box's edge. */
const cutWaves = (page: Page) =>
  page.evaluate(() => {
    const m = window.__lab.monitor;
    const cut: string[] = [];
    for (const b of m.getLayout()?.boxes ?? []) {
      const { v } = m.getTrace(b.lead);
      let hi = 0;
      let lo = 0;
      for (const x of v) {
        hi = Math.max(hi, x);
        lo = Math.min(lo, x);
      }
      const up = (b.baseline - b.y) / b.pxPerMv;
      const down = (b.y + b.h - b.baseline) / b.pxPerMv;
      if (hi > up || -lo > down) cut.push(`${b.id}: ${lo.toFixed(2)} to ${hi.toFixed(2)} mV, room ${(-down).toFixed(2)} to ${up.toFixed(2)}`);
    }
    return cut;
  });

async function expectHeartClear(page: Page, when: string) {
  const c = await heartCoverage(page, PANELS);
  expect(c.points, `${when}: the heart is on screen`).toBeGreaterThan(100);
  for (const [sel, share] of Object.entries(c.covered)) expect(share, `${when}: ${sel} sits on the heart`).toBe(0);
}

test.describe("the status card", () => {
  test("says what the heart is doing in every state: steady, an extra beat, starting, racing, fibrillation, after the shock, no beats", async ({ page }) => {
    test.setTimeout(400_000);
    await start(page);
    await page.evaluate(() => window.__lab.setSpeed(1));

    // steady, with its rate
    await kind(page, "steady");
    await page.waitForFunction(() => (window.__lab.analyzer.state.bpm ?? 0) > 60, undefined, { timeout: 30_000 });
    await expect(card(page).locator(".status-name")).toHaveText(RHYTHM_COPY.steady.name);
    await expect(card(page)).toHaveAttribute("data-tone", "ok");
    await expect(card(page).locator(".status-num")).toHaveText(/^(7[0-9]|8[0-2])$/);
    await expect(card(page).locator(".status-unit")).toHaveText(HUD.rateUnit);
    await expect(card(page).locator(".status-text")).toHaveText(RHYTHM_COPY.steady.sentence);
    await expect(card(page).locator(".meter i.on")).toHaveCount(5);

    // an early extra beat
    await page.keyboard.press("e");
    await expect.poll(() => statusKey(page), { timeout: 10_000 }).toBe("extra");
    await expect(card(page).locator(".status-name")).toHaveText(RHYTHM_COPY.extra.name);
    await expect(card(page)).toHaveAttribute("data-tone", "notice");
    // ...for a moment, then the steady rhythm again
    await expect.poll(() => statusKey(page), { timeout: 10_000 }).toBe("steady");

    // the lab setting a racing rhythm up, then the racing rhythm
    await page.getByRole("button", { name: "Make it race" }).click();
    await expect.poll(() => statusKey(page), { timeout: 5_000 }).toBe("starting");
    await expect(card(page)).toHaveAttribute("data-busy", "true");
    await expect(card(page).locator(".status-text")).toHaveText(STARTING_MESSAGE.racing);
    await induced(page);
    await kind(page, "racing");
    await expect.poll(() => statusKey(page), { timeout: 10_000 }).toBe("racing");
    await expect(card(page).locator(".status-name")).toHaveText(RHYTHM_COPY.racing.name);
    await expect(card(page)).toHaveAttribute("data-tone", "alarm");
    await expect(card(page).locator(".status-medical")).toContainText(RHYTHM_COPY.racing.medicalName as string);

    // fibrillation
    await page.getByRole("button", { name: "Make it fibrillate" }).click();
    await induced(page);
    await kind(page, "chaotic");
    await expect.poll(() => statusKey(page), { timeout: 10_000 }).toBe("chaotic");
    await expect(card(page).locator(".status-name")).toHaveText(RHYTHM_COPY.chaotic.name);
    await expect(card(page).locator(".status-unit")).toHaveText(HUD.noRate);
    await expect(card(page).locator(".meter i.on")).toHaveCount(0);

    // the shock, then the pause, then the steady beat again
    await page.getByRole("button", { name: "Shock", exact: true }).click();
    await expect.poll(() => statusKey(page), { timeout: 5_000 }).toBe("resetting");
    await expect(card(page).locator(".status-name")).toHaveText(RHYTHM_COPY.resetting.name);
    await expect.poll(() => statusKey(page), { timeout: 20_000 }).toBe("steady");

    // no beats: the steady beat switched off in Explore
    await openExplore(page);
    await page.getByRole("switch", { name: "Steady beat" }).click();
    await expect(page.getByRole("switch", { name: "Steady beat" })).toHaveAttribute("aria-checked", "false");
    await expect.poll(() => statusKey(page), { timeout: 15_000 }).toBe("quiet");
    await expect(card(page).locator(".status-name")).toHaveText(RHYTHM_COPY.quiet.name);
    await page.getByRole("switch", { name: "Steady beat" }).click();
    await expect.poll(() => statusKey(page), { timeout: 15_000 }).toBe("steady");
  });
});

test.describe("break it and fix it", () => {
  test("the buttons show which rhythm is on, Shock lights up only when there is something to fix, and a healthy heart is not shocked", async ({ page }) => {
    test.setTimeout(300_000);
    await start(page);
    await page.evaluate(() => window.__lab.setSpeed(1));
    await kind(page, "steady");
    const race = page.getByRole("button", { name: "Make it race" });
    const fib = page.getByRole("button", { name: "Make it fibrillate" });
    const shock = page.getByRole("button", { name: "Shock", exact: true });
    await expect(race).toHaveAttribute("aria-pressed", "false");
    await expect(fib).toHaveAttribute("aria-pressed", "false");
    await expect(shock).not.toHaveClass(/armed/);

    // a healthy heart: Shock is refused, with the teacher's reason, and no shock sound
    const shocks = await page.evaluate(() => window.__lab.audio.stats.shock);
    await shock.click();
    await expect(page.locator("#toast")).toHaveText(SHOCK_REFUSAL.pumping);
    expect(await page.evaluate(() => window.__lab.audio.stats.shock)).toBe(shocks);

    await race.click();
    await expect(race).toHaveAttribute("aria-pressed", "true");
    // the refusal answered a pumping heart: it goes as soon as the heart is being broken
    await expect(page.locator("#toast")).toBeHidden();
    await expect(shock).not.toHaveClass(/armed/); // not while the lab is still setting it up
    await induced(page);
    await kind(page, "racing");
    await expect(shock).toHaveClass(/armed/);
    // "Press Shock" beside the bar: not while the first-run tips are up (they say it already), then there
    await expect(page.locator("#coach")).toBeVisible();
    await expect(page.locator("#shock-callout")).toBeHidden();
    await page.getByRole("button", { name: "Hide these tips" }).click();
    await expect(page.locator("#shock-callout")).toBeVisible();
    await expect(page.locator("#lab")).toHaveAttribute("data-tone", "alarm");
    // the "tap the heart" marker is for a heart a tap can change: not over a racing one
    await expect(page.locator("#tap-marker")).toBeHidden();
    await expectHeartClear(page, "racing");

    await shock.click();
    await expect(race).toHaveAttribute("aria-pressed", "false");
    await expect(shock).not.toHaveClass(/armed/);
    await kind(page, "steady", 30_000);
    expect(await page.evaluate(() => window.__lab.engine.tissue)).toEqual({ conduction: 1, recovery: 1 });
    expect(await page.evaluate(() => window.__lab.engine.pacemaker)).toBe(true);
  });
});

test.describe("sound", () => {
  test("the button says off, on or blocked, nudges until first used, and the choice is remembered", async ({ page }) => {
    test.setTimeout(120_000);
    await start(page);
    const button = page.locator("#b-sound");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(button).toContainText(SOUND_STATE.off);
    await expect(page.locator("#sound-nudge")).toBeVisible();
    await expect(button).toHaveClass(/nudging/);

    await button.click();
    await page.waitForFunction(() => window.__lab.audio.state === "on", undefined, { timeout: 5_000 });
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button).toContainText(SOUND_STATE.on);
    await expect(page.locator("#sound-nudge")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("arrhythmia-lab:sound"))).toBe("on");

    // next visit: no nudge, and the sound comes back at the first click anywhere (not before: browsers do not allow it)
    await page.reload();
    await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, undefined, { timeout: 90_000 });
    await page.waitForFunction(() => Boolean(window.__lab), undefined, { timeout: 5_000 });
    expect(await page.evaluate(() => window.__lab.audio.state)).toBe("off");
    await expect(page.locator("#sound-nudge")).toBeHidden();
    await page.locator("#status").click();
    await page.waitForFunction(() => window.__lab.audio.state === "on", undefined, { timeout: 5_000 });
    await expect(button).toContainText(SOUND_STATE.on);

    // off again, and remembered as off
    await button.click();
    await page.waitForFunction(() => window.__lab.audio.state === "off", undefined, { timeout: 5_000 });
    expect(await page.evaluate(() => localStorage.getItem("arrhythmia-lab:sound"))).toBe("off");
  });

  test("turning sound on in slow motion goes back to real time, so the beats keep a real rhythm", async ({ page }) => {
    test.setTimeout(120_000);
    await start(page);
    await openExplore(page);
    await page.getByRole("button", { name: "¼×" }).click();
    await expect(page.getByRole("button", { name: "¼×" })).toHaveAttribute("aria-pressed", "true");
    await page.locator("#b-sound").click();
    await expect(page.getByRole("button", { name: "Real time" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#toast")).toBeVisible();
  });
});

test.describe("the ECG dock", () => {
  test("Compare opens inside the dock, never on the heart; Back and Esc close it; the strip names its lead", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await start(page);
    await page.evaluate(() => window.__lab.setSpeed(1));
    await kind(page, "steady");
    await expect(page.locator("#dock-lead")).toHaveText("Lead II");

    await page.getByRole("button", { name: "Compare with a real ECG" }).click();
    await expect(page.locator(".acl-compare")).toBeVisible();
    await expect(page.locator(".acl-compare__caption")).toBeVisible();
    await expect(page.locator(".acl-compare__credit")).toBeVisible();
    // the dock grew and the heart was framed again above it: the whole heart is still there, and nothing is on it
    const dock = await page.locator("#dock").boundingBox();
    expect(dock!.y + dock!.height).toBeLessThanOrEqual(900);
    await page.waitForTimeout(600);
    await expectHeartClear(page, "Compare open");
    // the recording that matches the rhythm on show is chosen
    expect(await page.getByLabel("Recorded ECG to compare").inputValue()).toBe("normal-sinus");

    await page.getByRole("button", { name: "Back to the live view" }).click();
    await expect(page.locator(".acl-compare")).toBeHidden();
    await page.getByRole("button", { name: "Compare with a real ECG" }).click();
    await expect(page.locator(".acl-compare")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".acl-compare")).toBeHidden();

    // in a racing rhythm lead II is nearly flat, so the strip moves to the lead that shows it, and says so
    await page.evaluate(() => window.__lab.moves.race());
    await induced(page);
    await kind(page, "racing");
    await page.waitForFunction(() => window.__lab.autoLead.lead !== 1, undefined, { timeout: 15_000 });
    const name = await page.evaluate(() => window.__lab.autoLead.name);
    await expect(page.locator("#dock-lead")).toContainText(`Lead ${name}, chosen automatically`);
    // why, as a hover tip and read out after the lead's name
    const why = fill(LEAD_CAPTIONS.switched, { lead: name });
    await expect(page.locator("#dock-lead")).toHaveAttribute("title", why);
    await expect(page.locator("#dock-lead .lead-why")).toContainText(why);
    await page.getByRole("button", { name: "Compare with a real ECG" }).click();
    await expect(page.locator(".acl-compare__lane--sim .acl-compare__sub")).toContainText(`Lead ${name}`);
    await expect(page.locator(".acl-compare__note")).toBeVisible();
    expect(await page.getByLabel("Recorded ECG to compare").inputValue()).toBe("vtach");
    // the honest line about this model's racing rhythm, and the recording's own caption
    await expect(page.locator(".acl-compare__caveat")).toHaveText(SIM_ECG_NOTES.racing as string);
    await expect(page.locator(".acl-compare__rec-caption")).toBeVisible();
    // the dock fits every line of Compare, the card keeps what to do next, and still nothing is on the heart
    await page.waitForTimeout(600);
    await expect.poll(() => page.evaluate(() => document.getElementById("compare")!.scrollHeight - document.getElementById("compare")!.clientHeight)).toBeLessThanOrEqual(1);
    await expect(card(page).locator(".status-next")).toBeVisible();
    await expectHeartClear(page, "Compare open, racing");
    // atrial fibrillation is shown with what sets it apart from the fibrillation the lab makes
    await page.getByLabel("Recorded ECG to compare").selectOption("afib");
    await expect(page.locator(".acl-compare__rec-caption")).toContainText("different from VF");
  });

  test("12 leads grows the dock and re-frames the heart above it, and no wave is cut flat", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await start(page);
    const before = (await page.locator("#dock").boundingBox())!.height;
    await page.getByRole("button", { name: "12 leads" }).click();
    await expect(page.getByRole("button", { name: "12 leads" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await page.locator("#dock").boundingBox())!.height).toBeGreaterThan(before + 100);
    await page.waitForTimeout(600);
    await expectHeartClear(page, "12 leads");
    // the chest leads swing far more than the limb leads: no wave is cut flat at the edge of its box, in a steady
    // rhythm or a racing one (the monitor lowers a group's gain instead, and says so on the paper)
    await page.evaluate(() => window.__lab.setSpeed(1));
    await kind(page, "steady");
    await page.waitForTimeout(3000);
    await expect.poll(() => cutWaves(page), { timeout: 10_000 }).toEqual([]);
    await page.evaluate(() => window.__lab.moves.race());
    await induced(page);
    await kind(page, "racing");
    await page.waitForTimeout(2000);
    await expect.poll(() => cutWaves(page), { timeout: 10_000 }).toEqual([]);
  });
});

test.describe("the drawer", () => {
  test("Lessons, Explore and What is this? open beside the heart and push it over, never on top; Esc and the close button shut it", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await start(page);
    await expectHeartClear(page, "closed");
    await openLessons(page);
    await expect(page.locator(".lesson-list button")).toHaveCount(5);
    await page.waitForTimeout(600);
    await expectHeartClear(page, "Lessons open");

    await page.locator(".drawer-tabs").getByRole("button", { name: "Explore" }).click();
    await expect(page.locator("#s-conduction")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Steady beat" })).toBeVisible();
    await page.locator(".drawer-tabs").getByRole("button", { name: "What is this?" }).click();
    await expect(page.locator(".terms")).toBeVisible();
    await expect(page.locator(".keys")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#drawer")).toBeHidden();

    await page.getByRole("button", { name: "Explore", exact: true }).click();
    await expect(page.locator("#drawer")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).first().click();
    await expect(page.locator("#drawer")).toBeHidden();
  });
});

test.describe("the first-run coach", () => {
  test("ticks tap, break and fix as they happen, and stays away afterwards", async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await start(page);
    await page.evaluate(() => window.__lab.setSpeed(1));
    const steps = page.locator(".coach-step");
    await expect(page.locator("#coach")).toBeVisible();
    await expect(page.locator("#tap-marker .tap-label")).toBeVisible();
    await expect(steps.nth(0)).toHaveAttribute("data-state", "current");

    await tapHeart(page);
    await expect(steps.nth(0)).toHaveAttribute("data-state", "done");
    await expect(steps.nth(1)).toHaveAttribute("data-state", "current");
    await expect(page.locator("#tap-marker .tap-label")).toBeHidden();

    await page.getByRole("button", { name: "Make it race" }).click();
    await induced(page);
    await kind(page, "racing");
    await expect(steps.nth(1)).toHaveAttribute("data-state", "done");
    await expect(steps.nth(2)).toHaveAttribute("data-state", "current");

    await page.getByRole("button", { name: "Shock", exact: true }).click();
    await expect(steps.nth(2)).toHaveAttribute("data-state", "done");
    await expect(page.locator(".coach-finished")).toBeVisible();

    await page.reload();
    await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, undefined, { timeout: 90_000 });
    await expect(page.locator("#coach")).toBeHidden();
  });

  test("a lesson's \"Tap the heart\" step shows the tap marker until the heart is tapped", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await start(page);
    await page.getByRole("button", { name: "Hide these tips" }).click();
    await expect(page.locator("#tap-marker")).toBeHidden();
    await openLessons(page);
    await page.locator(".lesson-list button", { hasText: "One beat" }).click();
    await page.waitForFunction(() => /tap the heart/i.test(window.__lab.runner.state.step?.title ?? ""), undefined, { timeout: 10_000 });
    await expect(page.locator("#tap-marker .tap-label")).toBeVisible();
    await tapHeart(page);
    await expect(page.locator("#tap-marker")).toBeHidden();
  });

  test("can be dismissed, and stays dismissed", async ({ page }) => {
    test.setTimeout(120_000);
    await start(page);
    await page.getByRole("button", { name: "Hide these tips" }).click();
    await expect(page.locator("#coach")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("arrhythmia-lab:first-run"))).toBe("hidden");
    await page.reload();
    await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, undefined, { timeout: 90_000 });
    await expect(page.locator("#coach")).toBeHidden();
  });
});

test.describe("the keyboard", () => {
  test("E, R, F, S, M, B and ? do what the key list says, and Esc closes what is open", async ({ page }) => {
    test.setTimeout(300_000);
    await start(page);
    await page.evaluate(() => window.__lab.setSpeed(1));
    await kind(page, "steady");

    const beat = await page.evaluate(() => window.__lab.engine.lastBeatAt);
    await page.keyboard.press("b");
    await page.waitForFunction((b) => window.__lab.engine.lastBeatAt > b, beat, { timeout: 5_000 });
    // "early" is judged against the usual gap, which the analyser only knows once two steady gaps agree again after
    // that extra beat (it shows as a rate)
    await page.waitForFunction(() => window.__lab.analyzer.state.bpm !== null, undefined, { timeout: 15_000 });

    await page.keyboard.press("e");
    await expect.poll(() => statusKey(page), { timeout: 10_000 }).toBe("extra");

    await page.keyboard.press("m");
    await page.waitForFunction(() => window.__lab.audio.state === "on", undefined, { timeout: 5_000 });
    await page.keyboard.press("m");
    await page.waitForFunction(() => window.__lab.audio.state === "off", undefined, { timeout: 5_000 });

    await page.keyboard.press("r");
    expect(await page.evaluate(() => window.__lab.moves.starting)).toBe("racing");
    await induced(page);
    await page.keyboard.press("f");
    expect(await page.evaluate(() => window.__lab.moves.starting)).toBe("fibrillation");
    await induced(page);
    await kind(page, "chaotic");
    const shocks = await page.evaluate(() => window.__lab.audio.stats.shock);
    await page.keyboard.press("s");
    await expect.poll(() => statusKey(page), { timeout: 5_000 }).toBe("resetting");
    // the shock sound is only counted while sound is on; the shock itself happened
    expect(await page.evaluate(() => window.__lab.audio.stats.shock)).toBe(shocks);

    await page.keyboard.press("?");
    await expect(page.locator(".terms")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#drawer")).toBeHidden();
  });

  test("the heart itself takes the keyboard: Tab reaches it, Enter fires a beat", async ({ page }) => {
    test.setTimeout(120_000);
    await start(page);
    await page.evaluate(() => (window.__lab.engine.pacemaker = false));
    await page.locator("#heart").focus();
    const beat = await page.evaluate(() => window.__lab.engine.lastBeatAt);
    await page.keyboard.press("Enter");
    await page.waitForFunction((b) => window.__lab.engine.lastBeatAt > b, beat, { timeout: 5_000 });
    const keys = await page.evaluate(() => Array.from(document.querySelectorAll("button[aria-keyshortcuts]")).map((b) => b.getAttribute("aria-keyshortcuts")));
    expect(keys).toEqual(expect.arrayContaining(["E", "R", "F", "S", "M", "?"]));
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

  test("the heart and Shock are on screen together, every control is a 44 px target, and nothing scrolls sideways", async ({ page }) => {
    test.setTimeout(120_000);
    await start(page, "debug&quality=medium");
    const layout = await page.evaluate(() => {
      const box = (el: Element | null) => {
        const r = el!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
      };
      const small = Array.from(document.querySelectorAll<HTMLElement>("button, select, input, a"))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[hidden]");
        })
        .map((el) => ({ name: (el.getAttribute("aria-label") || el.textContent || el.id).trim().slice(0, 30), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), tag: el.tagName }))
        .filter((t) => t.tag !== "INPUT" && (t.h < 44 || t.w < 44));
      return { heart: box(document.getElementById("heart")), shock: box(document.getElementById("b-shock")), vh: innerHeight, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, small };
    });
    expect(layout.overflow).toBeLessThanOrEqual(1);
    expect(layout.small, "every tap target is at least 44 px").toEqual([]);
    expect(layout.shock.top).toBeGreaterThanOrEqual(0);
    expect(layout.shock.bottom).toBeLessThanOrEqual(layout.vh);
    const heartOnScreen = Math.min(layout.heart.bottom, layout.vh) - Math.max(layout.heart.top, 0);
    expect(heartOnScreen / layout.heart.height).toBeGreaterThan(0.95);
    await expectHeartClear(page, "phone");
    // the whole ECG strip shows at first sight, above the Break/Fix bar, and the page's end clears the bar
    const r = await stripAgainstBar(page);
    expect(r.first.stripBottom, "the strip's bottom edge is above the bar").toBeLessThanOrEqual(r.first.barTop);
    expect(r.end.lastBottom, "the end of the page scrolls clear of the bar").toBeLessThanOrEqual(r.end.barTop);
  });

  test("in fibrillation with the sound on, the silence line sits in the card and nothing floats over the page", async ({ page }) => {
    test.setTimeout(240_000);
    await start(page, "debug&quality=medium");
    await page.evaluate(() => window.__lab.setSpeed(1));
    await page.locator("#b-sound").tap();
    await page.waitForFunction(() => window.__lab.audio.state === "on", undefined, { timeout: 5_000 });
    await page.evaluate(() => window.__lab.moves.fibrillate());
    await induced(page);
    await kind(page, "chaotic");
    await expect(page.locator("#status-silence")).toHaveText(SOUND_SILENCE.chaotic);
    await expect(page.locator("#status-silence")).toBeVisible();
    await expect(page.locator("#silence-note")).toBeHidden();
    await expect(page.locator("#shock-callout")).toBeHidden();
    await expect(page.getByRole("button", { name: "Shock", exact: true })).toHaveClass(/armed/);
  });

  test("the part names wait until the \"tap the heart\" ring has gone, so they do not sit on it", async ({ page }) => {
    test.setTimeout(120_000);
    await start(page, "debug&quality=medium");
    await expect(page.locator("#tap-marker .tap-label")).toBeVisible();
    await expect(page.locator("#labels")).toBeHidden();
    await tapHeart(page, true);
    await expect(page.locator("#tap-marker")).toBeHidden();
    await expect(page.locator("#labels")).toBeVisible();
  });

  test("a swipe up that starts on the heart scrolls the page instead of being trapped", async ({ page }) => {
    test.setTimeout(120_000);
    await start(page, "debug&quality=medium");
    expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
    const cdp = await page.context().newCDPSession(page);
    const x = 195;
    const y0 = 320;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
    for (let i = 1; i <= 12; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 - i * 22 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(40);
  });

  test("tapping the heart fires a beat, and Lessons opens under the heart, which stays in view", async ({ page }) => {
    test.setTimeout(120_000);
    await start(page, "debug&quality=medium");
    await page.evaluate(() => (window.__lab.engine.pacemaker = false));
    const before = await page.evaluate(() => window.__lab.engine.lastBeatAt);
    await tapHeart(page, true);
    await page.waitForFunction((b) => window.__lab.engine.lastBeatAt > b, before, { timeout: 5_000 });
    await page.getByRole("button", { name: "Lessons", exact: true }).click();
    await expect(page.locator(".lesson-list button").first()).toBeVisible();
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => {
      const h = document.getElementById("heart")!.getBoundingClientRect();
      return { visible: Math.min(h.bottom, innerHeight) - Math.max(h.top, 0), height: h.height };
    });
    expect(r.visible / r.height).toBeGreaterThan(0.95);
  });
});

/** At first sight (no scrolling), where the ECG strip is against the fixed Break/Fix bar, and whether the page's end clears it. */
async function stripAgainstBar(page: Page) {
  const first = await page.evaluate(() => {
    const strip = document.getElementById("monitor")!.getBoundingClientRect();
    const bar = document.getElementById("actions-wrap")!.getBoundingClientRect();
    return { scrollY: window.scrollY, stripTop: strip.top, stripBottom: strip.bottom, barTop: bar.top };
  });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(300);
  const end = await page.evaluate(() => {
    const bar = document.getElementById("actions-wrap")!.getBoundingClientRect();
    const blocks = Array.from(document.getElementById("lab")!.children).filter((e) => e.id !== "actions-wrap" && getComputedStyle(e).position !== "fixed" && e.getBoundingClientRect().height > 0);
    return { lastBottom: Math.max(...blocks.map((e) => e.getBoundingClientRect().bottom)), barTop: bar.top };
  });
  return { first, end };
}

test.describe("on a small phone", () => {
  test.use({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });

  test("the whole ECG strip is above the Break/Fix bar at first sight, and nothing ever sits under the bar", async ({ page }) => {
    test.setTimeout(120_000);
    await start(page, "debug&quality=medium");
    await page.waitForTimeout(800);
    const r = await stripAgainstBar(page);
    expect(r.first.scrollY).toBe(0);
    expect(r.first.stripTop).toBeGreaterThan(0);
    expect(r.first.stripBottom, "the strip's bottom edge is above the bar").toBeLessThanOrEqual(r.first.barTop);
    expect(r.end.lastBottom, "the end of the page scrolls clear of the bar").toBeLessThanOrEqual(r.end.barTop);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
});

test.describe("contrast", () => {
  test("the words on the panels are readable: at least 4.5:1 against what is really behind them (3:1 for large text)", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await start(page);
    await page.waitForTimeout(1500);
    const shot = await page.screenshot();
    const rows = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const x = c.getContext("2d", { willReadFrequently: true })!;
      x.drawImage(img, 0, 0);
      const k = img.width / innerWidth;
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a: number[], b: number[]) => {
        const [l1, l2] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (l1 + 0.05) / (l2 + 0.05);
      };
      const out: { sel: string; ratio: number; px: number }[] = [];
      // "around": text on a panel, measured against the panel just outside the text. "within": a pill with its own
      // background, measured against that background, in its padding.
      const selectors: [string, "around" | "within"][] = [
        [".tagline", "around"], [".status-name", "around"], [".status-unit", "around"], [".status-pumping", "around"], [".status-text", "around"], [".next-text", "around"],
        [".next-label", "around"], [".coach-title", "around"], [".coach-step-title", "around"], [".coach-step-body", "around"], [".act-label--break", "around"],
        [".act-label--fix", "around"], ["#b-extra .act-text", "around"], ["#b-shock .act-text", "around"], [".dock-title", "around"], [".dock-lead", "around"],
        [".dock-note", "within"], [".seg button", "within"], [".sound-label", "around"], [".label:not([hidden])", "within"], [".tap-label", "within"],
      ];
      for (const [sel, mode] of selectors) {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el || el.closest("[hidden]")) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2) continue;
        const fg = (getComputedStyle(el).color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const pts = (
          mode === "around"
            ? [
                [r.left - 3, r.top + r.height / 2],
                [r.right + 3, r.top + r.height / 2],
                [r.left + r.width / 2, r.top - 2],
                [r.left + r.width / 2, r.bottom + 2],
              ]
            : [
                [r.left + 4, r.top + r.height / 2],
                [r.right - 4, r.top + r.height / 2],
              ]
        ).filter(([px, py]) => px > 0 && py > 0 && px < innerWidth && py < innerHeight);
        const worst = Math.min(...pts.map(([px, py]) => ratio(fg, Array.from(x.getImageData(Math.round(px * k), Math.round(py * k), 1, 1).data).slice(0, 3))));
        out.push({ sel, ratio: +worst.toFixed(2), px: parseFloat(getComputedStyle(el).fontSize) });
      }
      return out;
    }, shot.toString("base64"));
    console.log(rows.map((r) => `${r.sel} ${r.ratio}:1 at ${r.px}px`).join("\n"));
    expect(rows.length).toBeGreaterThan(12);
    for (const r of rows) expect(r.ratio, `${r.sel} (${r.px}px)`).toBeGreaterThanOrEqual(r.px >= 18 ? 3 : 4.5);
  });
});
