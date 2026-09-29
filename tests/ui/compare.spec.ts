import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { consoleGuard } from "./consoleGuard";

const guard = consoleGuard();
test.beforeEach(({ page }) => guard.attach(page));
test.afterEach(() => guard.check());

const CAPTION = "Recorded ECGs are shown for visual comparison only. This is an educational simulation, not a medical device and not a diagnostic tool.";
const CREDIT = "Recorded ECGs: PTB-XL, CC BY 4.0; MIT-BIH Arrhythmia Database and CU Ventricular Tachyarrhythmia Database, ODC-By 1.0.";
/** How the record line names a recording's lead (MIT-BIH's MLII is a modified lead II; some recordings do not say). */
const leadWords = (lead: string) => (lead === "unspecified" ? "lead not stated" : lead === "MLII" ? "modified lead II" : `lead ${lead}`);

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
async function mountShipped(page: Page, width = 900) {
  return page.evaluate(async (width) => {
    const { data } = await window.ui.mountCompare({ width });
    return data.samples.map((s) => ({ id: s.id, label: s.label, record: s.record, lead: s.lead, caption: s.caption }));
  }, width);
}

/** The two lanes' canvases: the live simulation first, the recording second. */
const lanes = (page: Page) =>
  page.evaluate(() => {
    const [sim, rec] = Array.from(window.ui.panel().host.querySelectorAll("canvas"));
    return { sim: { w: sim.width, h: sim.height }, rec: { w: rec.width, h: rec.height } };
  });

const chooser = (page: Page) => page.getByLabel("Recorded ECG to compare");

test("shows the fixed caption, the credit and the record line for every recording, and redraws on every choice", async ({ page }) => {
  await open(page);
  const samples = await mountShipped(page);
  expect(samples.length).toBeGreaterThanOrEqual(3);

  const caption = page.locator(".acl-compare__caption");
  const credit = page.locator(".acl-compare__credit");
  const record = page.locator(".acl-compare__record");
  let previousRecorded: number | null = null;
  let firstSimulated: number | null = null;

  for (const s of samples) {
    await chooser(page).selectOption(s.id);
    // the wording is exact and can be seen, whichever recording is chosen
    await expect(caption).toHaveText(CAPTION);
    await expect(caption).toBeVisible();
    await expect(credit).toHaveText(CREDIT);
    await expect(credit).toBeVisible();
    await expect(record).toHaveText(`Record: ${s.record}, ${leadWords(s.lead)}.`);
    await expect(record).toBeVisible();
    // the recording's own caption (its lead, and what it could be mistaken for) is shown with it
    const recCaption = page.locator(".acl-compare__rec-caption");
    if (s.caption) {
      await expect(recCaption).toHaveText(s.caption);
      await expect(recCaption).toBeVisible();
    } else {
      await expect(recCaption).toBeHidden();
    }

    const r = await page.evaluate(async (id) => {
      const { ui } = window;
      const { panel, host } = ui.panel();
      const [simCanvas, recCanvas] = Array.from(host.querySelectorAll("canvas"));
      const recorded = ui.grab(recCanvas);
      const simulated = ui.grab(simCanvas);
      return {
        selected: panel.selectedId === id,
        chosen: (host.querySelector("select") as HTMLSelectElement).value,
        recordedPixels: ui.traceCount(recorded, [0, 0, recCanvas.width, recCanvas.height], "amber"),
        simulatedPixels: ui.traceCount(simulated, [0, 0, simCanvas.width, simCanvas.height], "teal"),
        recordedShot: recorded,
        simulatedShot: simulated,
      };
    }, s.id);
    expect(r.selected, `${s.id} is the selected id`).toBe(true);
    expect(r.chosen).toBe(s.id);
    expect(r.recordedPixels, `${s.id}: recorded trace drawn`).toBeGreaterThan(200);
    expect(r.simulatedPixels, `${s.id}: simulated trace drawn`).toBeGreaterThan(200);

    // a different recording draws a different picture
    if (previousRecorded !== null) {
      const changed = await page.evaluate(({ a, b }) => window.ui.diff(a, b).count, { a: previousRecorded, b: r.recordedShot });
      expect(changed, `${s.id} redraws the recorded trace`).toBeGreaterThan(200);
    }
    firstSimulated ??= r.simulatedShot;
    previousRecorded = r.recordedShot;
  }
  expect(firstSimulated).not.toBeNull();
});

test("draws both lanes on one scale: the same seconds and the same millivolts per pixel", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const value = (ms: number) => (ms >= 2000 && ms < 3000 ? 1 : ms >= 4000 && ms < 4020 ? -1 : 0);
    const recorded = { id: "square", label: "A square pulse: one second at 1 mV", lead: "II", fs: 250, mv: Array.from({ length: 1250 }, (_, i) => value(i * 4)), record: "test record" };
    const t = new Float32Array(1250);
    const v = new Float32Array(1250);
    for (let i = 0; i < 1250; i++) {
      t[i] = 10_000 + i * 4; // the simulation's clock is far from zero, as it is in a long session
      v[i] = value(i * 4);
    }
    await ui.mountCompare({
      width: 900,
      samples: { samples: [recorded], source: "test", licence: "test", url: "https://example.org/" },
      simulated: () => ({ t, v }),
    });
    const [sim, rec] = Array.from(ui.panel().host.querySelectorAll("canvas"));
    const recBounds = ui.traceBounds(ui.grab(rec), "amber", 0);
    const simBounds = ui.traceBounds(ui.grab(sim), "teal", 0);
    return { recBounds, simBounds, sameSize: rec.width === sim.width && rec.height === sim.height, width: rec.width };
  });
  expect(r.sameSize).toBe(true);
  expect(r.recBounds).not.toBeNull();
  expect(r.simBounds).not.toBeNull();
  const a = r.recBounds!;
  const b = r.simBounds!;
  // the same extent left, right, top and bottom, to within a pixel or two: same time scale, same gain, same zero line
  for (const side of ["left", "right", "top", "bottom"] as const) expect(Math.abs(a[side] - b[side]), side).toBeLessThanOrEqual(2);
  // five seconds across the whole lane
  expect(a.right - a.left).toBeGreaterThan(0.9 * r.width);
});

test("the recording is chosen from a labelled list, with the keyboard as well as the mouse", async ({ page }) => {
  await open(page);
  const samples = await mountShipped(page);
  const select = chooser(page);
  await expect(select).toBeVisible();
  await select.focus();
  // typing the start of a name picks it, on every platform (arrow keys open the list on some)
  await page.keyboard.type(samples[1].label.slice(0, 1));
  await expect(page.locator(".acl-compare__record")).toHaveText(`Record: ${samples[1].record}, ${leadWords(samples[1].lead)}.`);
  expect(await page.evaluate(() => window.ui.panel().panel.selectedId)).toBe(samples[1].id);
  // every recording is offered, by its plain name
  const names = await select.locator("option").allInnerTexts();
  expect(names).toEqual(samples.map((s) => s.label.split(":")[0].trim()));
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
    await chooser(page).selectOption(s.id);
    await expectVisible(`after choosing ${s.id}`);
  }
  await page.evaluate(() => {
    window.ui.panel().host.style.width = "300px";
  });
  await page.waitForTimeout(100);
  await expectVisible("in a narrow container");

  // nothing in the panel collapses, and the only control is the choice of recording (the note, the caveat and a
  // recording's caption are hidden only while they have nothing to say)
  const controls = await page.evaluate(() => {
    const { host } = window.ui.panel();
    return {
      details: host.querySelectorAll("details, [aria-expanded], [hidden]:not(.acl-compare__note, .acl-compare__caveat, .acl-compare__rec-caption)").length,
      buttons: host.querySelectorAll("button").length,
      selects: host.querySelectorAll("select").length,
      hide: typeof (window.ui.panel().panel as unknown as { hide?: unknown }).hide,
    };
  });
  expect(controls).toEqual({ details: 0, buttons: 0, selects: 1, hide: "undefined" });
});

test("has an accessible structure: a labelled region, a labelled choice, and canvases with a name and a text alternative", async ({ page }) => {
  await open(page);
  const samples = await mountShipped(page);
  const r = await page.evaluate(() => {
    const { host } = window.ui.panel();
    const region = host.querySelector("[role=region]");
    const canvases = Array.from(host.querySelectorAll("canvas"));
    return {
      region: region?.getAttribute("aria-label") ?? null,
      canvases: canvases.map((c) => {
        const id = c.getAttribute("aria-describedby");
        const el = id ? document.getElementById(id) : null;
        return { role: c.getAttribute("role"), label: c.getAttribute("aria-label") ?? "", description: el?.textContent ?? "" };
      }),
    };
  });
  expect(r.region).toMatch(/recorded ECG/i);
  await expect(chooser(page)).toHaveCount(1);
  expect(r.canvases).toHaveLength(2);
  for (const c of r.canvases) {
    expect(c.role).toBe("img");
    expect(c.label.length).toBeGreaterThan(10);
    expect(c.description.length).toBeGreaterThan(40);
  }
  expect(r.canvases[0].label).toMatch(/simulated/i);
  expect(r.canvases[0].description).toMatch(/not a medical device/i);
  expect(r.canvases[1].label).toContain(samples[0].label);
  expect(r.canvases[1].description).toContain(samples[0].record);

  // choosing another recording updates what a screen reader is told
  await chooser(page).selectOption(samples[1].id);
  const after = await page.evaluate(() => {
    const c = window.ui.panel().host.querySelectorAll("canvas")[1];
    const el = document.getElementById(c.getAttribute("aria-describedby") ?? "");
    return { label: c.getAttribute("aria-label") ?? "", description: el?.textContent ?? "" };
  });
  expect(after.label).toContain(samples[1].label);
  expect(after.description).toContain(samples[1].record);
});

test("says which lead the simulated lane shows, and why, when the page tells it", async ({ page }) => {
  await open(page);
  await mountShipped(page);
  const note = page.locator(".acl-compare__note");
  await expect(note).toBeHidden();
  await page.evaluate(() => window.ui.panel().panel.setSimulatedLabel("Lead V2, live, racing rhythm", "The recording is lead II. The simulated lane shows V2."));
  await expect(page.locator(".acl-compare__lane--sim .acl-compare__sub")).toHaveText("Lead V2, live, racing rhythm");
  await expect(note).toHaveText("The recording is lead II. The simulated lane shows V2.");
  await expect(note).toBeVisible();
  // the caveat: how this model's rhythm differs from real recordings of it, only when there is one
  const caveat = page.locator(".acl-compare__caveat");
  await expect(caveat).toBeHidden();
  await page.evaluate(() => window.ui.panel().panel.setSimulatedLabel("Lead V2, live, racing rhythm", "", "This model's racing rhythm runs faster than most real ventricular tachycardia."));
  await expect(caveat).toHaveText("This model's racing rhythm runs faster than most real ventricular tachycardia.");
  await expect(caveat).toBeVisible();
  await expect(note).toBeHidden();
  await page.evaluate(() => window.ui.panel().panel.setSimulatedLabel("Lead II, live, steady rhythm"));
  await expect(caveat).toBeHidden();
});

test("select() and selectedId: the first recording is chosen to begin with, and an unknown id is refused", async ({ page }) => {
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
    return { start, after, still: panel.selectedId, unknown, shown: (window.ui.panel().host.querySelector("select") as HTMLSelectElement).value };
  }, samples);
  expect(r.start).toBe(samples[0].id);
  expect(r.after).toBe(samples[2].id);
  expect(r.still).toBe(samples[2].id);
  expect(r.shown).toBe(samples[2].id);
  expect(r.unknown).toMatch(/no-such-recording/);
  await expect(page.locator(".acl-compare__record")).toHaveText(`Record: ${samples[2].record}, ${leadWords(samples[2].lead)}.`);
});

test("render() asks the simulation for its trace every time, and follows what it gets", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    let calls = 0;
    let trace: { t: Float32Array; v: Float32Array } = { t: new Float32Array(0), v: new Float32Array(0) };
    await ui.mountCompare({ width: 700, simulated: () => (calls++, trace) });
    const sim = () => ui.panel().host.querySelectorAll("canvas")[0];
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
  expect(r.drawn).toBeGreaterThan(200);
  expect(r.survived).toBe(true);
});

test("follows its container when it is resized, keeping both lanes the same size, and stacks them when narrow", async ({ page }) => {
  await open(page);
  await mountShipped(page, 1000);
  const wide = await lanes(page);
  expect(wide.sim).toEqual(wide.rec);
  const wideCss = await page.evaluate(() => Math.round(window.ui.panel().host.querySelector("canvas")!.getBoundingClientRect().width));
  // beside a column of words, so narrower than the panel
  expect(wideCss).toBeGreaterThan(600);
  expect(wideCss).toBeLessThan(1000);

  await page.evaluate(() => {
    window.ui.panel().host.style.width = "420px";
  });
  // narrow: the words go above each lane and the trace takes the full width
  await page.waitForFunction(() => Math.round(window.ui.panel().host.querySelector("canvas")!.getBoundingClientRect().width) === 420);
  await page.waitForFunction(() => window.ui.panel().host.querySelector("canvas")!.width === Math.round(420 * devicePixelRatio));
  const narrow = await lanes(page);
  expect(narrow.sim).toEqual(narrow.rec);
  const drawn = await page.evaluate(() => {
    const { ui } = window;
    const [sim, rec] = Array.from(ui.panel().host.querySelectorAll("canvas"));
    return { rec: ui.traceCount(ui.grab(rec), [0, 0, rec.width, rec.height], "amber"), sim: ui.traceCount(ui.grab(sim), [0, 0, sim.width, sim.height], "teal") };
  });
  expect(drawn.rec).toBeGreaterThan(150);
  expect(drawn.sim).toBeGreaterThan(150);
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
    await mountShipped(page, 700);
    const r = await page.evaluate(() => {
      const c = window.ui.panel().host.querySelector("canvas") as HTMLCanvasElement;
      const b = c.getBoundingClientRect();
      return { w: c.width, cssW: b.width, h: c.height, cssH: b.height };
    });
    expect(Math.abs(r.w - 2 * r.cssW)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.h - 2 * r.cssH)).toBeLessThanOrEqual(1);
  });
});

test.describe("screenshots for a human to look at", () => {
  test.describe("desktop", () => {
    test.use({ viewport: { width: 1200, height: 700 } });
    test("compare-desktop.png", async ({ page }) => {
      await open(page);
      await mountShipped(page, 1100);
      await chooser(page).selectOption({ index: 1 });
      await saveScreenshot(page, "compare-desktop.png");
    });
  });
  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    test("compare-phone.png", async ({ page }) => {
      await open(page);
      await mountShipped(page, 342);
      await chooser(page).selectOption({ index: 2 });
      await saveScreenshot(page, "compare-phone.png");
    });
  });
});
