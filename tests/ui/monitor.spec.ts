import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { consoleGuard } from "./consoleGuard";

const guard = consoleGuard();
test.beforeEach(({ page }) => guard.attach(page));
test.afterEach(() => guard.check());

async function open(page: Page) {
  await page.goto("/tests/ui/harness.html");
  // If the harness fails to load (for example a module it imports is missing) fail at once, not after two minutes.
  await page.waitForFunction(() => Boolean(window.ui), undefined, { timeout: 10_000 });
}

// Other Playwright runs in this repo clear test-results/, so a second copy can be kept elsewhere by setting UI_SCREENS_DIR.
const SCREEN_DIRS = ["test-results/screens", process.env.UI_SCREENS_DIR].filter((d): d is string => Boolean(d));
async function saveScreenshot(page: Page, name: string) {
  const png = await page.screenshot();
  for (const dir of SCREEN_DIRS) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${name}`, png);
  }
}

test("draws every lead and the rhythm strip after 6 seconds, and clear() empties them again", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 1200, height: 700 });
    const canvas = ui.current!.canvas;
    m.render();
    const empty = ui.grab(canvas);
    ui.feed(m, 0, 6000);
    const full = ui.grab(canvas);
    const layout = m.getLayout()!;
    const perBox = layout.boxes.map((b) => {
      const rect: [number, number, number, number] = [b.x, b.y, b.w, b.h];
      return { id: b.id, kind: b.kind, changed: ui.diff(empty, full, rect).count, trace: ui.traceCount(full, rect) };
    });
    m.clear();
    const cleared = ui.grab(canvas);
    return { perBox, afterClear: ui.diff(empty, cleared) };
  });
  expect(r.perBox).toHaveLength(13);
  expect(r.perBox.filter((b) => b.kind === "cell")).toHaveLength(12);
  expect(r.perBox.filter((b) => b.kind === "strip")).toHaveLength(1);
  for (const b of r.perBox) {
    expect(b.trace, `${b.id} trace pixels`).toBeGreaterThan(150);
    expect(b.changed, `${b.id} changed pixels`).toBeGreaterThan(150);
  }
  // after clear() the picture is exactly the empty paper again
  expect(r.afterClear.count).toBe(0);
});

test("uses a fixed gain (5 mm per mV in the twelve-lead layout) and clips each trace to its own box", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 1200, height: 700 });
    const canvas = ui.current!.canvas;
    const empty = ui.grab(canvas);
    const leads = new Float32Array(12);
    leads[0] = 0.5; // lead I: half a millivolt
    leads[1] = 1; // lead II: one millivolt
    leads[2] = -0.5; // lead III: minus half a millivolt
    leads[10] = 0; // V5: flat
    leads[11] = 6; // V6: six millivolts, far enough up to reach into V5's box if it were not clipped
    for (let t = 0; t < 1000; t += 4) m.push(t, leads);
    m.render();
    const shot = ui.grab(canvas);
    const layout = m.getLayout()!;
    const box = (id: string) => layout.boxes.find((b) => b.id === id)!;
    // Where the trace sits in one column of a box: the brightness-weighted centre row, against the empty paper.
    const centre = (id: string) => {
      const b = box(id);
      const profile = ui.columnProfile(empty, shot, b.x + Math.floor(b.w / 3), b.y, b.y + b.h);
      const total = profile.reduce((a, v) => a + v, 0);
      const centreRow = profile.reduce((a, v, i) => a + (b.y + i + 0.5) * v, 0) / total;
      return { total, centreRow, baseline: b.baseline, rows: profile };
    };
    const V5 = centre("V5");
    const V6 = box("V6");
    return {
      pxPerMm: layout.pxPerMm,
      pxPerMv: layout.pxPerMv,
      gainMmPerMv: layout.gainMmPerMv,
      I: centre("I"),
      II: centre("II"),
      III: centre("III"),
      // anything more than 6 px from V5's own zero line would be spill from V6
      V5Spill: V5.rows.filter((v, i) => Math.abs(box("V5").y + i + 0.5 - V5.baseline) > 6 && v > 0).length,
      V5Own: V5.total,
      V6Changed: ui.diff(empty, shot, [V6.x, V6.y, V6.w, V6.h]).count,
    };
  });
  expect(r.pxPerMv).toBe(r.gainMmPerMv * r.pxPerMm);
  // an amplitude of v mV puts the trace v * gain mm above the zero line
  for (const [name, mv] of [["I", 0.5], ["II", 1], ["III", -0.5]] as const) {
    const c = r[name];
    expect(c.total, `${name} drawn`).toBeGreaterThan(50);
    expect(Math.abs(c.centreRow - (c.baseline - mv * r.pxPerMv)), `${name} position`).toBeLessThanOrEqual(1);
  }
  // V5 is flat, so it only has its own trace; nothing from V6 has leaked in
  expect(r.V5Own).toBeGreaterThan(50);
  expect(r.V5Spill).toBe(0);
  // V6 is off the top of its own box, so its box is left exactly as the empty paper
  expect(r.V6Changed).toBe(0);
});

test("leaves out the fine grid when its squares would be too small to see, and keeps the heavy lines", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const measure = async (width: number, height: number) => {
      const m = await ui.mountMonitor({ width, height });
      const paper = ui.grab(ui.current!.canvas); // nothing pushed: just the paper
      const layout = m.getLayout()!;
      const box = layout.boxes[5];
      const y = box.baseline + 3; // a row that is not on a horizontal grid line
      let background = 0;
      let total = 0;
      for (let x = box.x + 40; x < box.x + 140; x++, total++) {
        const p = ui.pixel(paper, x, y);
        if (p[0] === 5 && p[1] === 10 && p[2] === 12) background++;
      }
      return { pxPerMm: layout.pxPerMm, background: background / total };
    };
    return { small: await measure(1020, 226), big: await measure(1200, 700) };
  });
  // the twelve-lead layout in a short dock: 2 px squares would just be a mesh, so only every fifth line is drawn (10 px apart)
  expect(r.small.pxPerMm).toBeLessThan(2.5);
  expect(r.small.background).toBeGreaterThan(0.85);
  // with room, all the fine lines are there (every 5 px, one in five of them heavy)
  expect(r.big.pxPerMm).toBe(5);
  expect(r.big.background).toBeLessThan(0.85);
  expect(r.big.background).toBeGreaterThan(0.7);
});

test("draws a bright dot at the newest sample", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 1200, height: 700 });
    const canvas = ui.current!.canvas;
    ui.feed(m, 0, 9000); // last sample at 8996
    const shot = ui.grab(canvas);
    const strip = m.getLayout()!.boxes.find((b) => b.kind === "strip")!;
    const layout = m.getLayout()!;
    const hx = Math.round(strip.x + ((8996 % 6000) / 6000) * strip.w);
    const hy = Math.round(strip.baseline - ui.synthLeads(8996)[1] * layout.pxPerMv);
    // the dot is whiter than the trace core, which is (125, 255, 212)
    const at = (dx: number) => ui.pixel(shot, hx + dx, hy);
    return { centre: at(0), farBehind: ui.pixel(shot, hx - 30, Math.round(strip.baseline - ui.synthLeads(8996 - 30 * 6000 / strip.w)[1] * layout.pxPerMv)) };
  });
  expect(r.centre[0]).toBeGreaterThan(200); // near-white, not the green core
  expect(r.centre[1]).toBeGreaterThan(240);
  expect(r.farBehind[0]).toBeLessThan(200); // the trace behind it is green
});

test("never draws outside its boxes, however long it runs and however wild the signal", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 900, height: 620 });
    const canvas = ui.current!.canvas;
    const empty = ui.grab(canvas);
    const leads = new Float32Array(12);
    let t = 0;
    // 40 s of beats with an over-range lead thrown in, so traces run into the top and bottom of their boxes
    for (let frame = 0; frame < 2500; frame++) {
      for (let k = 0; k < 4; k++, t += 4) {
        ui.synthLeads(t, leads);
        leads[6] = 12 * Math.sin(t / 90); // V1: far over range
        leads[7] = -6 * Math.sin(t / 55); // V2: over range, the other way
        m.push(t, leads);
      }
      m.render();
    }
    const shot = ui.grab(canvas);
    const l = m.getLayout()!;
    const left = Math.min(...l.boxes.map((b) => b.x));
    const right = Math.max(...l.boxes.map((b) => b.x + b.w));
    const bottom = Math.max(...l.boxes.map((b) => b.y + b.h));
    const top = Math.min(...l.boxes.map((b) => b.y));
    return {
      gutter: ui.diff(empty, shot, [0, 0, left, l.height]).count,
      rightMargin: ui.diff(empty, shot, [right, 0, l.width - right, l.height]).count,
      footer: ui.diff(empty, shot, [0, bottom, l.width, l.height - bottom]).count,
      topMargin: ui.diff(empty, shot, [0, 0, l.width, top]).count,
    };
  });
  expect(r).toEqual({ gutter: 0, rightMargin: 0, footer: 0, topMargin: 0 });
});

test("sweeps: the newest data is at the sweep position, with an erased gap ahead of it", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 1200, height: 700 });
    const canvas = ui.current!.canvas;
    ui.feed(m, 0, 9000); // one full pass of the 6 s strip and half of the next: the sweep is at 3 s
    const shot = ui.grab(canvas);
    const strip = m.getLayout()!.boxes.find((b) => b.kind === "strip")!;
    const head = strip.x + Math.round((3000 / 6000) * strip.w);
    const count = (x0: number, x1: number) => ui.traceCount(shot, [Math.round(x0), strip.y, Math.max(1, Math.round(x1 - x0)), strip.h]);
    return {
      strip: { x: strip.x, w: strip.w },
      head,
      justBehind: count(head - 40, head - 4),
      inGap: count(head + 0.005 * strip.w, head + 0.032 * strip.w),
      beyondGap: count(head + 0.05 * strip.w, head + 0.05 * strip.w + 60),
      farRight: count(strip.x + strip.w - 60, strip.x + strip.w - 2),
      farLeft: count(strip.x + 4, strip.x + 60),
    };
  });
  expect(r.justBehind).toBeGreaterThan(20); // fresh trace right up to the sweep bar
  expect(r.inGap).toBe(0); // erased: about 4% of the width
  expect(r.beyondGap).toBeGreaterThan(20); // older data from the previous pass is still there
  expect(r.farRight).toBeGreaterThan(20);
  expect(r.farLeft).toBeGreaterThan(20);
});

test("draws only what changed: an incremental frame costs a fraction of a full redraw", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 1200, height: 700 });
    const end = ui.feed(m, 0, 8000);
    const leads = new Float32Array(12);
    const frame = ui.countCalls(() => {
      for (let k = 0; k < 4; k++) m.push(end + k * 4, ui.synthLeads(end + k * 4, leads));
      m.render();
    });
    const idle = ui.countCalls(() => m.render()); // nothing new since the last frame
    const full = ui.countCalls(() => {
      m.invalidate();
      m.render();
    });
    return { frame, idle, full };
  });
  expect(r.idle.stroke + r.idle.drawImage + r.idle.lineTo).toBe(0); // no new data: no drawing at all
  expect(r.frame.lineTo).toBeGreaterThan(0);
  expect(r.frame.lineTo).toBeLessThan(r.full.lineTo * 0.2);
  expect(r.frame.drawImage).toBeLessThan(r.full.drawImage + 30);
  expect(r.frame.stroke).toBeLessThan(120);
});

// This is exact, not approximate. An earlier version drew the head dot as a filled circle and differed from a full
// redraw by a few pixels: on a GPU canvas a filled circle leaks a little coverage past its clip edge.
test("an incremental picture is identical to a full redraw, whatever the frame rhythm", async ({ page }) => {
  await open(page);
  const runs = await page.evaluate(async () => {
    const { ui } = window;
    const out: { label: string; count: number; maxDelta: number; first: [number, number, number][] }[] = [];
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      const m = await ui.mountMonitor({ width: 900, height: 620, dpr });
      const canvas = ui.current!.canvas;
      const compare = (label: string) => {
        const before = ui.grab(canvas);
        m.invalidate();
        m.render();
        const after = ui.grab(canvas);
        out.push({ label: `dpr${dpr} ${label}`, ...ui.diff(before, after) });
      };
      let t = ui.feed(m, 0, 7000, 4, 16);
      compare("regular frames");
      t = ui.feed(m, t, t + 2000, 4, 100);
      compare("coarse frames");
      t = ui.feed(m, t, t + 300, 4, 4);
      compare("a render per sample");
      t = ui.feed(m, t, t + 9000, 4, 9000);
      compare("one huge frame");
      t = ui.feed(m, t, t + 1500, 4, 33);
      compare("back to normal");
      ui.feed(m, t, t + 40, 2, 2); // pushes closer than the ring's merge interval
      compare("merged pushes");
    }
    return out;
  });
  for (const r of runs) {
    expect(r.count, `${r.label}: differing pixels (biggest gap ${r.maxDelta}, first at ${JSON.stringify(r.first)})`).toBe(0);
  }
});

test("getTrace returns the stored samples of one lead within the window, oldest first", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 800, height: 500 });
    ui.feed(m, 0, 7000); // last sample at 6996
    const lead = 1;
    const tr = m.getTrace(lead);
    const expected: number[] = [];
    for (let t = 996; t <= 6996; t += 4) expected.push(ui.synthLeads(t)[lead]);
    return {
      first: tr.t[0],
      last: tr.t[tr.t.length - 1],
      n: tr.t.length,
      sorted: Array.from(tr.t).every((t, i, a) => i === 0 || t > a[i - 1]),
      typed: tr.t instanceof Float32Array && tr.v instanceof Float32Array,
      maxErr: Math.max(...Array.from(tr.v).map((v, i) => Math.abs(v - expected[i]))),
      others: [0, 3, 11].map((i) => Math.max(...Array.from(m.getTrace(i).v).map(Math.abs))),
    };
  });
  expect(r.typed).toBe(true);
  expect(r.sorted).toBe(true);
  expect(r.first).toBe(996);
  expect(r.last).toBe(6996);
  expect(r.n).toBe(1501);
  expect(r.maxErr).toBeLessThan(1e-5);
  expect(r.others.every((x) => x > 0.3)).toBe(true); // other leads are stored too
});

test("renders in well under 2 ms per frame for 12 leads x 6 s at 250 samples per second", async ({ page }, info) => {
  await open(page);
  const stats = await page.evaluate(async () => {
    const { ui } = window;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const summarise = (times: number[]) => {
      const t = [...times].sort((a, b) => a - b);
      const at = (q: number) => t[Math.min(t.length - 1, Math.floor(t.length * q))];
      return { mean: mean(t), p50: at(0.5), p95: at(0.95), max: t[t.length - 1] };
    };
    // a monitor that already holds 6 s of all 12 leads, on a fresh canvas
    const fresh = async (o: { softwareRaster?: boolean; dpr?: number }) => {
      const m = await ui.mountMonitor({ width: 1200, height: 700, dpr: o.dpr ?? 1, softwareRaster: o.softwareRaster ?? false });
      const end = ui.feed(m, 0, 6000);
      ui.timeRenders(m, end, 60); // warm up
      return { m, end: end + 240, canvas: ui.current!.canvas };
    };
    // A canvas records its drawing and the GPU (or the CPU rasteriser) does it later, so timing the render() call alone
    // misses that work. Batches of frames followed by one tiny readback include it, with the readback's own
    // latency shared between all the frames of the batch.
    const batched = async (o: { softwareRaster?: boolean; dpr?: number }) => {
      const c = await fresh(o);
      const perFrame = ui.timeBatches(c.m, c.canvas, c.end, 3, 200);
      const fullRepaint = ui.timeFullRepaints(c.m, c.canvas, 3, 20);
      return { frame: { mean: mean(perFrame), worst: Math.max(...perFrame) }, fullRepaint: { mean: mean(fullRepaint), worst: Math.max(...fullRepaint) } };
    };

    const a = await fresh({});
    const callOnly = summarise(ui.timeRenders(a.m, a.end, 600));
    const gpu = await batched({});
    const retina = await batched({ dpr: 2 });
    const cpu = await batched({ softwareRaster: true });

    // does a page that renders every frame keep up with the display?
    const d = await fresh({});
    const gaps = await ui.framePacing(d.m, d.end, 240);
    return { callOnly, gpu, retina, cpu, pacing: { ...summarise(gaps.slice(10)), over20ms: gaps.filter((g) => g > 20).length, frames: gaps.length } };
  });
  const f = (x: number) => x.toFixed(3);
  const line = (label: string, s: { frame: { mean: number; worst: number }; fullRepaint: { mean: number; worst: number } }) =>
    `  ${label} per frame mean ${f(s.frame.mean)} ms (worst batch ${f(s.frame.worst)}); one full repaint mean ${f(s.fullRepaint.mean)} ms (worst ${f(s.fullRepaint.worst)})`;
  const report = [
    "render() cost, 12 leads x 6 s at 250 samples/s, 1200x700, 4 new samples per frame:",
    `  the call alone (drawing is only recorded there): mean ${f(stats.callOnly.mean)} ms, p95 ${f(stats.callOnly.p95)}, max ${f(stats.callOnly.max)}   [timer resolution is 0.1 ms]`,
    "  including the drawing work itself, in 200-frame batches:",
    line("default canvas,        dpr 1:", stats.gpu),
    line("default canvas,        dpr 2:", stats.retina),
    line("CPU-backed canvas,     dpr 1:", stats.cpu),
    `  frame gaps with render() every frame: mean ${f(stats.pacing.mean)} ms, p95 ${f(stats.pacing.p95)}, max ${f(stats.pacing.max)}, ${stats.pacing.over20ms} of ${stats.pacing.frames} over 20 ms`,
  ].join("\n");
  console.log(report);
  info.annotations.push({ type: "render-time", description: report });
  expect(stats.callOnly.mean).toBeLessThan(2);
  for (const s of [stats.gpu, stats.retina, stats.cpu]) {
    expect(s.frame.mean).toBeLessThan(2);
    expect(s.fullRepaint.mean).toBeLessThan(16); // a rare full repaint (resize, mode change) still fits in one 60 Hz frame
  }
});

test("resize uses the device pixel ratio for a sharp picture and keeps the CSS size", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 1200, height: 700, dpr: 2 });
    const canvas = ui.current!.canvas;
    ui.feed(m, 0, 3000);
    const layout = m.getLayout()!;
    const one = await (async () => {
      const m1 = await ui.mountMonitor({ width: 1200, height: 700, dpr: 1 });
      return m1.getLayout()!.pxPerMm;
    })();
    return { w: canvas.width, h: canvas.height, styleW: canvas.style.width, styleH: canvas.style.height, pxPerMm: layout.pxPerMm, pxPerMmAtOne: one };
  });
  expect(r.w).toBe(2400);
  expect(r.h).toBe(1400);
  expect(r.styleW).toBe("1200px");
  expect(r.styleH).toBe("700px");
  expect(r.pxPerMm).toBe(2 * r.pxPerMmAtOne);
});

test("leaves the size of a canvas that the page sizes with CSS alone, so it keeps following its container", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const { Monitor } = await ui.loadMonitor();
    // like the real page: a flex child whose canvas fills it
    const box = document.createElement("div");
    box.style.cssText = "width:800px;height:300px;display:flex;flex-direction:column";
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "flex:1;min-height:0;width:100%;display:block";
    box.append(canvas);
    ui.stage().replaceChildren(box);
    const m = new Monitor(canvas);
    m.resize(canvas.clientWidth, canvas.clientHeight, 2);
    const first = { w: canvas.width, h: canvas.height, styleW: canvas.style.width, styleH: canvas.style.height, clientW: canvas.clientWidth, clientH: canvas.clientHeight };
    box.style.width = "500px"; // the container shrinks: the canvas must follow
    const followed = { clientW: canvas.clientWidth, clientH: canvas.clientHeight };
    m.resize(canvas.clientWidth, canvas.clientHeight, 2);
    const second = { w: canvas.width, styleW: canvas.style.width };
    return { first, followed, second };
  });
  // the page's own width:100% is still there, and no height has been added on top
  expect(r.first).toEqual({ w: 1600, h: 600, styleW: "100%", styleH: "", clientW: 800, clientH: 300 });
  expect(r.followed).toEqual({ clientW: 500, clientH: 300 });
  expect(r.second).toEqual({ w: 1000, styleW: "100%" });
});

test("draws at the canvas's own size if resize() was never called", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const { Monitor } = await ui.loadMonitor();
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 320;
    ui.stage().replaceChildren(canvas);
    const m = new Monitor(canvas);
    ui.feed(m, 0, 3000);
    const shot = ui.grab(canvas);
    const boxes = m.getLayout()!.boxes;
    return { boxes: boxes.length, traced: boxes.filter((b) => ui.traceCount(shot, [b.x, b.y, b.w, b.h]) > 20).length };
  });
  expect(r.boxes).toBe(13);
  expect(r.traced).toBe(13);
});

test("single mode shows lead II large, and switching modes keeps the data", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 390, height: 320, dpr: 2, mode: "single" });
    const canvas = ui.current!.canvas;
    ui.feed(m, 0, 6000);
    const traceIn = (shot: number) => m.getLayout()!.boxes.map((b) => ui.traceCount(shot, [b.x, b.y, b.w, b.h]));
    const single = { boxes: m.getLayout()!.boxes.map((b) => b.label), trace: traceIn(ui.grab(canvas)) };
    m.setMode("twelve");
    m.render();
    const twelve = { boxes: m.getLayout()!.boxes.length, trace: traceIn(ui.grab(canvas)) };
    m.setMode("single");
    m.render();
    const back = { boxes: m.getLayout()!.boxes.length, trace: traceIn(ui.grab(canvas)) };
    return { single, twelve, back };
  });
  expect(r.single.boxes).toEqual(["II"]);
  expect(r.single.trace[0]).toBeGreaterThan(300);
  expect(r.twelve.boxes).toBe(13);
  for (const n of r.twelve.trace) expect(n).toBeGreaterThan(10); // the stored samples are drawn without a new push
  expect(r.back.boxes).toBe(1);
  expect(r.back.trace[0]).toBeGreaterThan(300);
});

test("setStripLead puts another lead on the big trace and the rhythm strip, names it, and keeps every lead's data", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 900, height: 320, dpr: 1, mode: "single" });
    const canvas = ui.current!.canvas;
    ui.feed(m, 0, 6000);
    const before = ui.grab(canvas);
    const label = () => canvas.getAttribute("aria-label") ?? "";
    const was = { lead: m.stripLeadIndex, label: label() };
    m.setStripLead(7);
    m.render();
    const after = ui.grab(canvas);
    const box = m.getLayout()!.boxes[0];
    const single = { lead: m.stripLeadIndex, box: box.label, label: label(), changed: ui.diff(before, after).count, trace: ui.traceCount(after, [box.x, box.y, box.w, box.h]) };
    m.setMode("twelve");
    m.render();
    const strip = m.getLayout()!.boxes.find((b) => b.kind === "strip")!;
    const twelve = { strip: strip.lead, trace: ui.traceCount(ui.grab(canvas), [strip.x, strip.y, strip.w, strip.h]) };
    let refused = "";
    try {
      m.setStripLead(12);
    } catch (e) {
      refused = (e as Error).message;
    }
    return { was, single, twelve, refused };
  });
  expect(r.was.lead).toBe(1);
  expect(r.was.label).toMatch(/lead II/i);
  expect(r.single).toMatchObject({ lead: 7, box: "V2" });
  expect(r.single.label).toMatch(/lead V2/);
  expect(r.single.changed).toBeGreaterThan(100); // redrawn with the other lead's samples, which were kept
  expect(r.single.trace).toBeGreaterThan(300);
  expect(r.twelve.strip).toBe(7);
  expect(r.twelve.trace).toBeGreaterThan(100);
  expect(r.refused).toMatch(/lead must be/);
});

test("setWindowMs changes the sweep length and the stored window, without losing samples", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 1200, height: 700 });
    const canvas = ui.current!.canvas;
    ui.feed(m, 0, 8000); // last sample at 7996
    const spanOf = () => m.getLayout()!.boxes.find((b) => b.kind === "strip")!.spanMs;
    const defaults = { span: spanOf(), n: m.getTrace(1).t.length };
    m.setWindowMs(3000);
    m.render();
    const short = { span: spanOf(), first: m.getTrace(1).t[0] };
    m.setWindowMs(12000);
    m.render();
    const strip = m.getLayout()!.boxes.find((b) => b.kind === "strip")!;
    const long = { span: spanOf(), n: m.getTrace(1).t.length, trace: ui.traceCount(ui.grab(canvas), [strip.x, strip.y, strip.w, strip.h]) };
    return { defaults, short, long };
  });
  expect(r.defaults.span).toBe(6000);
  expect(r.defaults.n).toBe(1501);
  expect(r.short.span).toBe(3000);
  expect(r.short.first).toBeGreaterThanOrEqual(7996 - 3000);
  expect(r.long.span).toBe(12000);
  expect(r.long.n).toBe(2000); // everything that was ever stored is back in view
  expect(r.long.trace).toBeGreaterThan(300);
});

test("a simulation that restarts its clock does not get joined onto the old trace", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 1200, height: 700 });
    const canvas = ui.current!.canvas;
    ui.feed(m, 0, 5000);
    const leads = new Float32Array(12);
    m.push(0, ui.synthLeads(0, leads)); // the clock went back to zero
    const t0 = m.getTrace(1);
    ui.feed(m, 4, 1000);
    const strip = m.getLayout()!.boxes.find((b) => b.kind === "strip")!;
    const shot = ui.grab(canvas);
    return {
      n: t0.t.length,
      first: t0.t[0],
      right: ui.traceCount(shot, [strip.x + Math.round(strip.w * 0.5), strip.y, Math.round(strip.w * 0.5) - 2, strip.h]),
      left: ui.traceCount(shot, [strip.x, strip.y, Math.round(strip.w * 0.15), strip.h]),
    };
  });
  expect(r.n).toBe(1);
  expect(r.first).toBe(0);
  expect(r.right).toBe(0); // the old 5 s of trace is gone
  expect(r.left).toBeGreaterThan(20);
});

test("the canvas has an accessible name and a text alternative that follows the mode", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 1200, height: 700 });
    const canvas = ui.current!.canvas;
    const read = () => {
      const id = canvas.getAttribute("aria-describedby");
      const el = id ? document.getElementById(id) : null;
      const box = el?.getBoundingClientRect();
      return {
        role: canvas.getAttribute("role"),
        label: canvas.getAttribute("aria-label") ?? "",
        description: el?.textContent ?? "",
        descriptionHiddenFromSight: box ? box.width <= 2 && box.height <= 2 : false,
        descriptionDisplayed: el ? getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden" : false,
      };
    };
    const twelve = read();
    m.setMode("single");
    const single = read();
    return { twelve, single };
  });
  expect(r.twelve.role).toBe("img");
  expect(r.twelve.label).toMatch(/ECG/);
  expect(r.twelve.description).toMatch(/simulated/i);
  expect(r.twelve.description).toMatch(/not a medical device/i);
  expect(r.twelve.descriptionHiddenFromSight).toBe(true);
  expect(r.twelve.descriptionDisplayed).toBe(true); // hidden from sight, not from screen readers
  expect(r.single.label).not.toBe(r.twelve.label);
  expect(r.single.description).not.toBe(r.twelve.description);
  expect(r.single.label).toMatch(/lead II/i);
});

test("rejects input that would silently corrupt the display", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 600, height: 400 });
    const attempt = (f: () => void) => {
      try {
        f();
        return "no error";
      } catch (e) {
        return `${(e as Error).name}: ${(e as Error).message}`;
      }
    };
    return {
      short: attempt(() => m.push(0, new Float32Array(11))),
      lead: attempt(() => m.getTrace(12)),
      leadNeg: attempt(() => m.getTrace(-1)),
      window: attempt(() => m.setWindowMs(0)),
      windowNaN: attempt(() => m.setWindowMs(Number.NaN)),
      size: attempt(() => m.resize(-1, 100, 1)),
      dpr: attempt(() => m.resize(100, 100, 0)),
    };
  });
  for (const [what, message] of Object.entries(r)) expect(message, what).toMatch(/RangeError/);
});

test("survives non-finite and huge values without breaking the picture", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 900, height: 620 });
    const canvas = ui.current!.canvas;
    const leads = new Float32Array(12);
    for (let t = 0; t < 2000; t += 4) {
      ui.synthLeads(t, leads);
      if (t === 800) leads[1] = Number.NaN;
      if (t === 1200) leads[1] = Number.POSITIVE_INFINITY;
      if (t === 1600) leads[1] = -1e30;
      m.push(t, leads);
    }
    m.render();
    const shot = ui.grab(canvas);
    const strip = m.getLayout()!.boxes.find((b) => b.kind === "strip")!;
    const tr = m.getTrace(1);
    return { finite: Array.from(tr.v).every(Number.isFinite), trace: ui.traceCount(shot, [strip.x, strip.y, strip.w, strip.h]) };
  });
  expect(r.finite).toBe(true);
  expect(r.trace).toBeGreaterThan(100);
});

test.describe("screenshots for a human to look at", () => {
  test.describe("desktop, twelve leads", () => {
    test.use({ viewport: { width: 1200, height: 700 } });
    test("monitor-twelve-desktop.png", async ({ page }) => {
      await open(page);
      await page.evaluate(async () => {
        const { ui } = window;
        const m = await ui.mountMonitor({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio });
        ui.feed(m, 0, 11000);
      });
      await saveScreenshot(page, "monitor-twelve-desktop.png");
    });
  });

  test.describe("phone, single lead", () => {
    test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    test("monitor-single-phone.png", async ({ page }) => {
      await open(page);
      await page.evaluate(async () => {
        const { ui } = window;
        const m = await ui.mountMonitor({ width: innerWidth, height: 300, dpr: devicePixelRatio, mode: "single" });
        ui.feed(m, 0, 9000);
      });
      await saveScreenshot(page, "monitor-single-phone.png");
    });
  });
});

test("with automatic gain, lowers only the chest leads' gain when their waves would be cut flat, and raises it again once they fit", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 1200, height: 700 });
    m.setAutoGain(true);
    const leads = new Float32Array(12);
    // a beat every 800 ms: lead II reaches 0.5 mV and V5 4.5 mV, like the model's chest leads in a steady rhythm
    const beat = (t: number, chest: number) => {
      leads.fill(0);
      const k = t % 800 < 40 ? 1 : 0;
      leads[1] = 0.5 * k;
      leads[10] = chest * k;
      return leads;
    };
    for (let t = 0; t < 3000; t += 4) {
      m.push(t, beat(t, 4.5));
      m.render();
    }
    const tall = m.groupGains;
    const layout = m.getLayout()!;
    const V5 = layout.boxes.find((b) => b.id === "V5")!;
    const II = layout.boxes.find((b) => b.id === "II")!;
    const canvas = ui.current!.canvas;
    const said = document.getElementById(canvas.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
    // then 1 mV beats, for longer than the window and the wait before stepping up
    for (let t = 3000; t < 3000 + 6000 + 4000; t += 4) {
      m.push(t, beat(t, 1));
      m.render();
    }
    return { tall, V5Fits: 4.5 * V5.pxPerMv <= V5.baseline - V5.y, V5Gain: V5.gainMmPerMv, IIGain: II.gainMmPerMv, said, after: m.groupGains };
  });
  expect(r.tall).toEqual({ limb: 5, chest: 2.5 });
  expect(r.V5Gain).toBe(2.5);
  expect(r.IIGain).toBe(5);
  expect(r.V5Fits).toBe(true);
  expect(r.said).toContain("5 millimetres per millivolt for the limb leads and 2.5 millimetres per millivolt for the chest leads");
  expect(r.after).toEqual({ limb: 5, chest: 5 });
});

test("with automatic gain, a short strip showing a chest lead in a racing rhythm drops to 5 mm/mV instead of cutting the wave", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const m = await ui.mountMonitor({ width: 366, height: 96 });
    m.setMode("single");
    m.setStripLead(8); // V3
    m.setAutoGain(true);
    const leads = new Float32Array(12);
    for (let t = 0; t < 2000; t += 4) {
      leads.fill(0);
      leads[8] = 1.4 * Math.sin((2 * Math.PI * t) / 250); // swings 1.4 mV each way, four times a second
      m.push(t, leads);
      m.render();
    }
    const box = m.getLayout()!.boxes[0];
    const canvas = ui.current!.canvas;
    return {
      gains: m.groupGains,
      gain: box.gainMmPerMv,
      fits: 1.4 * box.pxPerMv <= Math.min(box.baseline - box.y, box.y + box.h - box.baseline),
      said: document.getElementById(canvas.getAttribute("aria-describedby") ?? "")?.textContent ?? "",
    };
  });
  expect(r.gain).toBe(5);
  expect(r.gains.chest).toBe(5);
  expect(r.fits).toBe(true);
  expect(r.said).toContain("lead V3");
  expect(r.said).toContain("5 millimetres per millivolt");
});

