import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { consoleGuard } from "./consoleGuard";

const guard = consoleGuard();
test.beforeEach(({ page }) => guard.attach(page));
test.afterEach(() => guard.check());

const CAPTION = "Recorded ECGs are shown for visual comparison only. This is an educational simulation, not a medical device and not a diagnostic tool.";
const CREDIT = "Recorded ECGs: PTB-XL, CC BY 4.0; MIT-BIH Arrhythmia Database, ODC-By 1.0.";

// Other Playwright runs in this repo clear test-results/, so a second copy can be kept elsewhere by setting UI_SCREENS_DIR.
const SCREEN_DIRS = ["test-results/screens", process.env.UI_SCREENS_DIR].filter((d): d is string => Boolean(d));
async function saveScreenshot(page: Page, name: string) {
  const png = await page.screenshot();
  for (const dir of SCREEN_DIRS) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${name}`, png);
  }
}

async function open(page: Page) {
  await page.goto("/tests/ui/harness.html");
  await page.waitForFunction(() => Boolean(window.ui), undefined, { timeout: 10_000 });
}

/** Mount the panel on the shipped data and report what it was given. */
async function mountShipped(page: Page, width = 640) {
  return page.evaluate(async (width) => {
    const { data } = await window.ui.mountCompare({ width });
    return data.samples.map((s) => ({ id: s.id, label: s.label, record: s.record }));
  }, width);
}

test("shows the fixed caption, the credit and the record id for every sample, and redraws on every selection", async ({ page }) => {
  await open(page);
  const samples = await mountShipped(page);
  expect(samples.length).toBeGreaterThanOrEqual(3);

  const caption = page.locator(".acl-compare__caption");
  const credit = page.locator(".acl-compare__credit");
  const record = page.locator(".acl-compare__record");
  let previousRecorded: number | null = null;
  let firstSimulated: number | null = null;

  for (const s of samples) {
    await page.getByRole("button", { name: s.label, exact: true }).click();
    // the wording is exact and can be seen, whichever sample is chosen
    await expect(caption).toHaveText(CAPTION);
    await expect(caption).toBeVisible();
    await expect(credit).toHaveText(CREDIT);
    await expect(credit).toBeVisible();
    await expect(record).toHaveText(`Record: ${s.record}`);
    await expect(record).toBeVisible();

    const r = await page.evaluate(async (id) => {
      const { ui } = window;
      const { panel, host } = ui.panel();
      const canvases = host.querySelectorAll("canvas");
      const recorded = ui.grab(canvases[0]);
      const simulated = ui.grab(canvases[1]);
      const pressed = Array.from(host.querySelectorAll("button")).filter((b) => b.getAttribute("aria-pressed") === "true").length;
      return {
        selected: panel.selectedId === id,
        pressed,
        recordedPixels: ui.traceCount(recorded, [0, 0, canvases[0].width, canvases[0].height], "amber"),
        simulatedPixels: ui.traceCount(simulated, [0, 0, canvases[1].width, canvases[1].height], "teal"),
        recordedShot: recorded,
        simulatedShot: simulated,
      };
    }, s.id);
    expect(r.selected, `${s.id} is the selected id`).toBe(true);
    expect(r.pressed, "exactly one button is pressed").toBe(1);
    expect(r.recordedPixels, `${s.id}: recorded trace drawn`).toBeGreaterThan(300);
    expect(r.simulatedPixels, `${s.id}: simulated trace drawn`).toBeGreaterThan(300);

    // a different recording draws a different picture; the simulation beside it does not change
    if (previousRecorded !== null) {
      const changed = await page.evaluate(({ a, b }) => window.ui.diff(a, b).count, { a: previousRecorded, b: r.recordedShot });
      expect(changed, `${s.id} redraws the recorded trace`).toBeGreaterThan(200);
    }
    if (firstSimulated !== null) {
      const same = await page.evaluate(({ a, b }) => window.ui.diff(a, b).count, { a: firstSimulated, b: r.simulatedShot });
      expect(same, "the simulated trace is untouched by choosing a recording").toBe(0);
    }
    previousRecorded = r.recordedShot;
    firstSimulated ??= r.simulatedShot;
  }
});

test("draws both traces on one scale: the same seconds and the same millivolts per pixel", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const value = (ms: number) => (ms >= 2000 && ms < 3000 ? 1 : ms >= 4000 && ms < 4020 ? -1 : 0);
    const recorded = { id: "square", label: "A square pulse", lead: "II", fs: 250, mv: Array.from({ length: 1250 }, (_, i) => value(i * 4)), record: "test record" };
    const t = new Float32Array(1250);
    const v = new Float32Array(1250);
    for (let i = 0; i < 1250; i++) {
      t[i] = 10_000 + i * 4; // the simulation's clock is far from zero, as it is in a long session
      v[i] = value(i * 4);
    }
    await ui.mountCompare({
      width: 625,
      samples: { samples: [recorded], source: "test", licence: "test", url: "https://example.org/" },
      simulated: () => ({ t, v }),
    });
    const [rec, sim] = Array.from(ui.panel().host.querySelectorAll("canvas"));
    const recBounds = ui.traceBounds(ui.grab(rec), "amber", 30);
    const simBounds = ui.traceBounds(ui.grab(sim), "teal", 30);
    return { recBounds, simBounds, pitch: rec.width / 125, sameSize: rec.width === sim.width && rec.height === sim.height, width: rec.width, height: rec.height };
  });
  expect(r.sameSize).toBe(true);
  expect(r.recBounds).not.toBeNull();
  expect(r.simBounds).not.toBeNull();
  const a = r.recBounds!;
  const b = r.simBounds!;
  // the same extent left, right, top and bottom, to within a pixel or two: same time scale, same gain, same zero line
  for (const side of ["left", "right", "top", "bottom"] as const) expect(Math.abs(a[side] - b[side]), side).toBeLessThanOrEqual(2);
  // that scale is a standard ECG paper: 25 mm per second and 10 mm per millivolt
  const pxPerMm = r.pitch;
  expect(pxPerMm).toBeCloseTo(5, 1);
  // +1 mV up to -1 mV down is 20 mm, and the recorded pulse (1 s = 25 mm) spans 25 mm horizontally on its own
  expect(Math.abs(a.bottom - a.top - 20 * pxPerMm)).toBeLessThanOrEqual(4);
});

test("is keyboard accessible: Tab reaches the samples, Enter and Space choose one", async ({ page }) => {
  await open(page);
  const samples = await mountShipped(page);
  await page.keyboard.press("Tab");
  const focused = () => page.evaluate(() => document.activeElement?.textContent ?? "");
  expect(await focused()).toBe(samples[0].label);
  await page.keyboard.press("Tab");
  expect(await focused()).toBe(samples[1].label);
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => window.ui.panel().panel.selectedId)).toBe(samples[1].id);
  await expect(page.locator(".acl-compare__record")).toHaveText(`Record: ${samples[1].record}`);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  expect(await page.evaluate(() => window.ui.panel().panel.selectedId)).toBe(samples[2].id);
  // the chosen button says so, and keeps focus
  await expect(page.getByRole("button", { name: samples[2].label, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: samples[2].label, exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: samples[1].label, exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("the caption, credit and record line cannot be hidden: always visible, readable, and no control to collapse them", async ({ page }) => {
  await open(page);
  const samples = await mountShipped(page, 560);
  const check = () =>
    page.evaluate(() => {
      const { ui } = window;
      const { host } = ui.panel();
      return [".acl-compare__caption", ".acl-compare__credit", ".acl-compare__record"].map((sel) => {
        const el = host.querySelector(sel) as HTMLElement;
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const hiddenAncestor = (() => {
          for (let e: Element | null = el; e; e = e.parentElement) {
            const s = getComputedStyle(e);
            if (s.display === "none" || s.visibility === "hidden" || e.hasAttribute("hidden") || e.getAttribute("aria-hidden") === "true") return true;
          }
          return false;
        })();
        return {
          sel,
          hiddenAncestor,
          opacity: Number(style.opacity),
          fontSize: parseFloat(style.fontSize),
          contrast: ui.contrast(el),
          inside: box.left >= host.getBoundingClientRect().left - 1 && box.right <= host.getBoundingClientRect().right + 1,
          height: box.height,
        };
      });
    });
  const expectVisible = async (when: string) => {
    for (const r of await check()) {
      expect(r.hiddenAncestor, `${when}: ${r.sel} hidden`).toBe(false);
      expect(r.opacity, `${when}: ${r.sel} opacity`).toBeGreaterThanOrEqual(0.99);
      expect(r.fontSize, `${when}: ${r.sel} font size`).toBeGreaterThanOrEqual(12);
      expect(r.contrast, `${when}: ${r.sel} contrast`).toBeGreaterThanOrEqual(4.5);
      expect(r.inside, `${when}: ${r.sel} inside the panel`).toBe(true);
      expect(r.height, `${when}: ${r.sel} has room`).toBeGreaterThan(10);
    }
  };
  await expectVisible("at the start");
  for (const s of samples) {
    await page.getByRole("button", { name: s.label, exact: true }).click();
    await expectVisible(`after choosing ${s.id}`);
  }
  await page.evaluate(() => {
    window.ui.panel().host.style.width = "300px";
  });
  await page.waitForTimeout(100);
  await expectVisible("in a narrow container");

  // nothing in the panel collapses, and the only buttons are the samples
  const controls = await page.evaluate(() => {
    const { host } = window.ui.panel();
    return {
      details: host.querySelectorAll("details, [aria-expanded], [hidden]").length,
      buttons: host.querySelectorAll("button").length,
      hide: typeof (window.ui.panel().panel as unknown as { hide?: unknown }).hide,
    };
  });
  expect(controls).toEqual({ details: 0, buttons: samples.length, hide: "undefined" });
});

test("has an accessible structure: a labelled region, real buttons, and canvases with a name and a text alternative", async ({ page }) => {
  await open(page);
  const samples = await mountShipped(page);
  const r = await page.evaluate(() => {
    const { host } = window.ui.panel();
    const region = host.querySelector("[role=region]");
    const canvases = Array.from(host.querySelectorAll("canvas"));
    return {
      region: region?.getAttribute("aria-label") ?? null,
      buttons: Array.from(host.querySelectorAll("button")).map((b) => ({ type: b.type, tag: b.tagName, text: b.textContent })),
      canvases: canvases.map((c) => {
        const id = c.getAttribute("aria-describedby");
        const el = id ? document.getElementById(id) : null;
        return { role: c.getAttribute("role"), label: c.getAttribute("aria-label") ?? "", description: el?.textContent ?? "" };
      }),
    };
  });
  expect(r.region).toMatch(/recorded ECG/i);
  expect(r.buttons.map((b) => b.text)).toEqual(samples.map((s) => s.label)); // the plain-English label, exactly
  for (const b of r.buttons) expect([b.tag, b.type]).toEqual(["BUTTON", "button"]);
  expect(r.canvases).toHaveLength(2);
  for (const c of r.canvases) {
    expect(c.role).toBe("img");
    expect(c.label.length).toBeGreaterThan(10);
    expect(c.description.length).toBeGreaterThan(40);
  }
  expect(r.canvases[0].label).toContain(samples[0].label);
  expect(r.canvases[0].description).toContain(samples[0].record);
  expect(r.canvases[1].label).toMatch(/simulated/i);
  expect(r.canvases[1].description).toMatch(/not a medical device/i);

  // choosing another recording updates what a screen reader is told
  await page.getByRole("button", { name: samples[1].label, exact: true }).click();
  const after = await page.evaluate(() => {
    const c = window.ui.panel().host.querySelectorAll("canvas")[0];
    const el = document.getElementById(c.getAttribute("aria-describedby") ?? "");
    return { label: c.getAttribute("aria-label") ?? "", description: el?.textContent ?? "" };
  });
  expect(after.label).toContain(samples[1].label);
  expect(after.description).toContain(samples[1].record);
});

test("select() and selectedId: the first sample is chosen to begin with, and an unknown id is refused", async ({ page }) => {
  await open(page);
  const samples = await mountShipped(page);
  const r = await page.evaluate((samples) => {
    const { panel } = window.ui.panel();
    const start = panel.selectedId;
    panel.select(samples[2].id);
    const after = panel.selectedId;
    panel.select(samples[2].id); // choosing it again is harmless
    let unknown = "no error";
    try {
      panel.select("no-such-recording");
    } catch (e) {
      unknown = (e as Error).message;
    }
    return { start, after, still: panel.selectedId, unknown };
  }, samples);
  expect(r.start).toBe(samples[0].id);
  expect(r.after).toBe(samples[2].id);
  expect(r.still).toBe(samples[2].id);
  expect(r.unknown).toMatch(/no-such-recording/);
  await expect(page.locator(".acl-compare__record")).toHaveText(`Record: ${samples[2].record}`);
});

test("render() asks the simulation for its trace every time, and follows what it gets", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    let calls = 0;
    let trace: { t: Float32Array; v: Float32Array } = { t: new Float32Array(0), v: new Float32Array(0) };
    await ui.mountCompare({ width: 500, simulated: () => (calls++, trace) });
    const sim = () => ui.panel().host.querySelectorAll("canvas")[1];
    const count = () => ui.traceCount(ui.grab(sim()), [0, 0, sim().width, sim().height], "teal");
    const callsAfterMount = calls;
    const empty = count(); // an empty trace is fine, and draws nothing
    trace = ui.simTrace(0, 5000);
    ui.panel().panel.render();
    const drawn = count();
    const callsAfterRender = calls;
    // arrays of different lengths must not break it either
    trace = { t: new Float32Array(100), v: new Float32Array(10) };
    ui.panel().panel.render();
    return { callsAfterMount, callsAfterRender, empty, drawn, survived: true };
  });
  expect(r.callsAfterMount).toBeGreaterThanOrEqual(1);
  expect(r.callsAfterRender).toBe(r.callsAfterMount + 1);
  expect(r.empty).toBe(0);
  expect(r.drawn).toBeGreaterThan(300);
  expect(r.survived).toBe(true);
});

test("follows its container when it is resized, keeping both traces on the same scale", async ({ page }) => {
  await open(page);
  await mountShipped(page, 700);
  const size = () =>
    page.evaluate(() => {
      const { host } = window.ui.panel();
      const [a, b] = Array.from(host.querySelectorAll("canvas"));
      const box = a.getBoundingClientRect();
      return { cssW: Math.round(box.width), cssH: Math.round(box.height), aw: a.width, ah: a.height, bw: b.width, bh: b.height, dpr: devicePixelRatio, host: Math.round(host.clientWidth - 24) };
    });
  const wide = await size();
  expect(wide.cssW).toBe(700);
  expect([wide.aw, wide.ah]).toEqual([wide.bw, wide.bh]);
  expect(wide.cssH).toBeCloseTo(0.4 * 700, -1); // 50 mm tall on paper where 5 s is 125 mm wide

  await page.evaluate(() => {
    window.ui.panel().host.style.width = "420px";
  });
  await page.waitForFunction(() => Math.round(window.ui.panel().host.querySelector("canvas")!.getBoundingClientRect().width) === 420 && window.ui.panel().host.querySelector("canvas")!.width === 420 * devicePixelRatio);
  const narrow = await size();
  expect(narrow.cssW).toBe(420);
  expect([narrow.aw, narrow.ah]).toEqual([narrow.bw, narrow.bh]);
  const drawn = await page.evaluate(() => {
    const { ui } = window;
    const [a, b] = Array.from(ui.panel().host.querySelectorAll("canvas"));
    return { rec: ui.traceCount(ui.grab(a), [0, 0, a.width, a.height], "amber"), sim: ui.traceCount(ui.grab(b), [0, 0, b.width, b.height], "teal") };
  });
  expect(drawn.rec).toBeGreaterThan(200);
  expect(drawn.sim).toBeGreaterThan(200);
});

test("keeps its content when built into a container that already has content, and dispose() removes only itself", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const { ComparePanel, parseEcgSamples } = await ui.loadCompare();
    const data = parseEcgSamples(await (await fetch("/data/ecg-samples.json")).json());
    const host = document.createElement("div");
    host.innerHTML = "<h2 id='mine'>My heading</h2>";
    ui.stage().replaceChildren(host);
    const panel = new ComparePanel(host, data, () => ({ t: new Float32Array(0), v: new Float32Array(0) }));
    const during = { mine: !!host.querySelector("#mine"), panel: !!host.querySelector(".acl-compare"), descriptions: document.querySelectorAll("[id^=acl-canvas-description]").length };
    panel.dispose();
    const after = { mine: !!host.querySelector("#mine"), panel: !!host.querySelector(".acl-compare"), descriptions: document.querySelectorAll("[id^=acl-canvas-description]").length };
    return { during, after };
  });
  expect(r.during).toEqual({ mine: true, panel: true, descriptions: 2 });
  expect(r.after).toEqual({ mine: true, panel: false, descriptions: 0 });
});

test.describe("on a high-density screen", () => {
  test.use({ deviceScaleFactor: 2 });
  test("draws at twice the pixels for a sharp picture, at the same CSS size", async ({ page }) => {
    await open(page);
    await mountShipped(page, 500);
    const r = await page.evaluate(() => {
      const c = window.ui.panel().host.querySelector("canvas") as HTMLCanvasElement;
      return { w: c.width, cssW: Math.round(c.getBoundingClientRect().width), h: c.height, cssH: Math.round(c.getBoundingClientRect().height) };
    });
    expect(r.cssW).toBe(500);
    expect(r.w).toBe(1000);
    expect(r.h).toBeGreaterThanOrEqual(2 * r.cssH - 1);
    expect(r.h).toBeLessThanOrEqual(2 * r.cssH + 1);
  });
});

test.describe("screenshots for a human to look at", () => {
  test.describe("desktop", () => {
    test.use({ viewport: { width: 760, height: 900 } });
    test("compare-desktop.png", async ({ page }) => {
      await open(page);
      await mountShipped(page, 640);
      await page.getByRole("button", { name: /Premature ventricular/ }).click();
      await saveScreenshot(page, "compare-desktop.png");
    });
  });
  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    test("compare-phone.png", async ({ page }) => {
      await open(page);
      await mountShipped(page, 342);
      await page.getByRole("button", { name: /Ventricular tachycardia/ }).click();
      await saveScreenshot(page, "compare-phone.png");
    });
  });
});
