import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { decodePng, glowFraction, isGlow, meanAbsDiff, meanLuminance, type Picture } from "./png";

// The renderer on the real heart, in real Chrome with WebGPU. Pictures are taken from the page as the
// user would see them, decoded here and measured. Review screenshots are written to test-results/screens.

test.use({ viewport: { width: 1440, height: 900 } });

const SCREENS = "test-results/screens";

test.afterEach(async ({ page }) => {
  // A shader or pipeline error does not throw, it makes the GPU draw nothing. Fail on any.
  const errors = await page.evaluate(() => window.renderGpuErrors ?? []);
  expect(errors).toEqual([]);
});

async function open(page: Page, quality = "high") {
  await page.goto(`/tests/render/harness.html?quality=${quality}`);
  await page.evaluate(() => window.renderReady);
}

/** Draw a frame and take the picture of the page, decoded. Optionally keep it as a review screenshot. */
async function shot(page: Page, name?: string): Promise<Picture> {
  await page.evaluate(() => window.renderLab.draw());
  const png = await page.screenshot();
  if (name) {
    mkdirSync(SCREENS, { recursive: true }); // the runner empties test-results when a run starts
    writeFileSync(`${SCREENS}/${name}.png`, png);
  }
  return decodePng(png);
}

/** Excite the apex and run the solver for ms, drawing as the app does. */
async function fire(page: Page, ms: number) {
  await page.evaluate((ms) => {
    const lab = window.renderLab;
    lab.sim.stimulate(lab.apex, 3);
    lab.play(ms);
  }, ms);
}

test("the resting heart is drawn: not blank, sensible brightness, nothing glowing", async ({ page }) => {
  await open(page);
  const img = await shot(page, "desktop-1-rest");
  const lum = meanLuminance(img);
  console.log(`rest: mean luminance ${lum.toFixed(1)}, glow ${(glowFraction(img) * 100).toFixed(4)}%`);
  expect(lum).toBeGreaterThan(8);
  expect(lum).toBeLessThan(120);
  expect(glowFraction(img)).toBe(0);
  // the heart is really there: a good share of the picture is warm, reddish tissue
  let tissue = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] > 60 && img.data[i] > 1.5 * img.data[i + 1]) tissue++;
  expect(tissue / (img.width * img.height)).toBeGreaterThan(0.05);
});

test("60 ms after a stimulus the excited tissue glows", async ({ page }) => {
  await open(page);
  const rest = await shot(page);
  await fire(page, 60);
  const img = await shot(page, "desktop-2-after-60ms");
  const g = glowFraction(img);
  console.log(`after 60 ms: glow ${(g * 100).toFixed(2)}% of the picture, mean luminance ${meanLuminance(img).toFixed(1)}`);
  expect(glowFraction(rest)).toBe(0);
  expect(g).toBeGreaterThan(0.01);
  expect(meanLuminance(img)).toBeGreaterThan(meanLuminance(rest) + 3);
});

test("two frames a few milliseconds of simulated time apart differ", async ({ page }) => {
  await open(page);
  await fire(page, 60);
  const a = await shot(page);
  await page.evaluate(() => window.renderLab.play(12));
  const b = await shot(page);
  const d = meanAbsDiff(a, b);
  console.log(`60 ms vs 72 ms: mean difference ${d.toFixed(2)} of 255`);
  expect(d).toBeGreaterThan(1);
  // the wave has spread: more of the picture glows
  expect(glowFraction(b)).toBeGreaterThan(glowFraction(a));
});

test("a phone-sized screen renders the heart, sharply and not blank", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  try {
    const page = await ctx.newPage();
    await open(page);
    const size = await page.evaluate(() => [window.renderLab.canvas.width, window.renderLab.canvas.height]);
    const rest = await shot(page);
    await fire(page, 70);
    const img = await shot(page, "phone-after-70ms");
    console.log(`phone: backing store ${size.join("x")}, glow ${(glowFraction(img) * 100).toFixed(2)}%`);
    expect(size).toEqual([780, 1688]);
    expect(img.width).toBe(780);
    expect(meanLuminance(rest)).toBeGreaterThan(5);
    expect(glowFraction(img)).toBeGreaterThan(0.01);
    // the heart fills a good part of the width: tissue or glow reaches across the middle band
    let leftmost = img.width, rightmost = 0;
    for (let y = Math.floor(img.height * 0.3); y < Math.floor(img.height * 0.6); y++)
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        if (isGlow(img.data[i], img.data[i + 1], img.data[i + 2]) || (img.data[i] > 60 && img.data[i] > 1.5 * img.data[i + 1])) {
          leftmost = Math.min(leftmost, x);
          rightmost = Math.max(rightmost, x);
        }
      }
    expect(rightmost - leftmost).toBeGreaterThan(img.width * 0.45);
    // this page is not the test's own, so the shared check does not see it
    expect(await page.evaluate(() => window.renderGpuErrors)).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test("the cutaway shows a different picture from the whole heart", async ({ page }) => {
  await open(page);
  await fire(page, 60);
  const whole = await shot(page);
  await page.evaluate(() => window.renderLab.renderer.setCutaway(true, 0));
  const cut = await shot(page, "desktop-3-cutaway");
  const d = meanAbsDiff(whole, cut);
  console.log(`cutaway vs whole: mean difference ${d.toFixed(2)} of 255`);
  expect(d).toBeGreaterThan(4);

  // depth -1 leaves the heart whole (film grain and ray jitter alone make two frames differ by about 1 to 2
  // of 255); deeper cuts remove more of it
  await page.evaluate(() => window.renderLab.renderer.setCutaway(true, -1));
  const barely = await shot(page);
  console.log(`cutaway at -1 vs whole: mean difference ${meanAbsDiff(whole, barely).toFixed(2)} of 255`);
  expect(meanAbsDiff(whole, barely)).toBeLessThan(4);
  // Coverage: pixels that differ from the empty room. The room alone is what a cut at +1 leaves. The part of
  // the heart that remains shrinks as the cut goes deeper, so the area it covers can only shrink too.
  await page.evaluate(() => window.renderLab.renderer.setCutaway(true, 1));
  const empty = await shot(page);
  const covered = (img: Picture) => {
    let n = 0;
    for (let i = 0; i < img.data.length; i += 4)
      if (Math.abs(img.data[i] - empty.data[i]) + Math.abs(img.data[i + 1] - empty.data[i + 1]) + Math.abs(img.data[i + 2] - empty.data[i + 2]) > 45) n++;
    return n;
  };
  await page.evaluate(() => window.renderLab.renderer.setCutaway(true, 0.6));
  const deep = await shot(page);
  await page.evaluate(() => window.renderLab.renderer.setCutaway(true, 1));
  const gone = await shot(page);
  console.log(`covered pixels: whole ${covered(whole)}, cut at 0 ${covered(cut)}, at 0.6 ${covered(deep)}, at 1 ${covered(gone)}`);
  expect(covered(deep)).toBeLessThan(covered(cut));
  expect(covered(cut)).toBeLessThan(covered(whole));
  expect(covered(gone)).toBeLessThan(covered(whole) * 0.01); // +1 removes it all

  // turning it off restores the whole heart
  await page.evaluate(() => window.renderLab.renderer.setCutaway(false));
  const back = await shot(page);
  expect(meanAbsDiff(whole, back)).toBeLessThan(4);
});

test("pick finds the muscle voxel under a pixel, and nothing outside the heart", async ({ page }) => {
  await open(page);
  const img = await shot(page);
  const r = await page.evaluate(
    ({ w, h, pixels }) => {
      const lab = window.renderLab;
      let hits = 0, muscle = 0;
      for (const [x, y] of pixels) {
        const v = lab.renderer.pick(x, y);
        if (v) {
          hits++;
          if (lab.grid.tissue[v[0] + lab.grid.nx * (v[1] + lab.grid.ny * v[2])] > 0) muscle++;
        }
      }
      return { hits, muscle, corner: lab.renderer.pick(2, 2), farCorner: lab.renderer.pick(w - 3, h - 3) };
    },
    { w: img.width, h: img.height, pixels: samplePixels(img, (r, g) => r > 60 && r > 1.8 * g, 200) },
  );
  console.log(`pick: ${r.hits} of 200 tissue-coloured pixels hit muscle, ${r.muscle} of them muscle voxels`);
  expect(r.muscle).toBe(r.hits);
  expect(r.hits).toBeGreaterThan(190);
  expect(r.corner).toBeNull();
  expect(r.farCorner).toBeNull();
});

test("pick follows the cutaway: only what is left of the heart can be picked", async ({ page }) => {
  await open(page);
  const img = await shot(page);
  const pixels = samplePixels(img, (r, g) => r > 60 && r > 1.8 * g, 300);
  const r = await page.evaluate((pixels) => {
    const renderer = window.renderLab.renderer;
    const at = () => pixels.map(([x, y]) => renderer.pick(x, y));
    const whole = at();
    renderer.setCutaway(true, -1);
    const barely = at();
    renderer.setCutaway(true, 0);
    const middle = at();
    renderer.setCutaway(true, 1);
    const gone = at();
    renderer.setCutaway(false);
    const back = at();
    const same = (a: (number[] | null)[], b: (number[] | null)[]) => a.filter((v, i) => JSON.stringify(v) === JSON.stringify(b[i])).length;
    return {
      n: pixels.length,
      wholeHits: whole.filter(Boolean).length,
      barelySame: same(whole, barely),
      middleSame: same(whole, middle),
      middleHits: middle.filter(Boolean).length,
      goneHits: gone.filter(Boolean).length,
      backSame: same(whole, back),
    };
  }, pixels);
  console.log(`pick with the cut: ${r.n} pixels; whole ${r.wholeHits} hits; cut -1 gives the same voxel for ${r.barelySame}; cut 0 for ${r.middleSame} (${r.middleHits} hits); cut +1 hits ${r.goneHits}; cut off again same for ${r.backSame}`);
  expect(r.wholeHits).toBe(r.n);
  expect(r.barelySame).toBe(r.n); // -1 removes nothing
  expect(r.goneHits).toBe(0); // +1 removes everything
  expect(r.middleSame).toBeLessThan(r.n * 0.2); // 0 removes the near half: the ray goes on to what is behind
  expect(r.middleHits).toBeGreaterThan(r.n * 0.5);
  expect(r.backSame).toBe(r.n);
});

test("pacing at a picked pixel lights that place on the screen", async ({ page }) => {
  await open(page);
  const img = await shot(page);
  // the middle of the visible tissue
  const pts = samplePixels(img, (r, g) => r > 60 && r > 1.8 * g, 4000);
  const cx = Math.round(pts.reduce((s, p) => s + p[0], 0) / pts.length);
  const cy = Math.round(pts.reduce((s, p) => s + p[1], 0) / pts.length);
  const at = await page.evaluate(
    ({ cx, cy }) => {
      const lab = window.renderLab;
      const v = lab.renderer.pick(cx, cy);
      if (!v) return null;
      lab.sim.stimulate(v, 4);
      lab.play(10);
      return v;
    },
    { cx, cy },
  );
  expect(at).not.toBeNull();
  const lit = await shot(page, "desktop-4-paced-at-pixel");
  let near = 0, far = 0;
  for (let y = 0; y < lit.height; y++)
    for (let x = 0; x < lit.width; x++) {
      const i = (y * lit.width + x) * 4;
      if (!isGlow(lit.data[i], lit.data[i + 1], lit.data[i + 2])) continue;
      if (Math.hypot(x - cx, y - cy) < 90) near++;
      else if (Math.hypot(x - cx, y - cy) > 260) far++;
    }
  console.log(`paced at pixel (${cx}, ${cy}) = voxel ${at}: ${near} glowing pixels within 90 px, ${far} beyond 260 px`);
  expect(near).toBeGreaterThan(300);
  expect(far).toBe(0);
});

// ---- project(): pinning labels to the heart ------------------------------------------------------------

test("project pins the anatomy to the canvas: apex low and to the right, base high, target in the middle", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(() => {
    const lab = window.renderLab;
    const rd = lab.renderer;
    return { apex: rd.project(lab.frame.apexVoxel), base: rd.project(lab.frame.baseVoxel), focus: rd.project(rd.focus), w: window.innerWidth, h: window.innerHeight };
  });
  console.log(`apex (${r.apex.x.toFixed(0)}, ${r.apex.y.toFixed(0)}) visible ${r.apex.visible}; base (${r.base.x.toFixed(0)}, ${r.base.y.toFixed(0)}) visible ${r.base.visible}; target (${r.focus.x.toFixed(1)}, ${r.focus.y.toFixed(1)})`);
  expect(r.apex.x).toBeGreaterThan(r.w / 2); // the textbook pose: the apex points down and to the right
  expect(r.apex.y).toBeGreaterThan(r.h / 2);
  expect(r.apex.visible).toBe(true);
  expect(r.base.y).toBeLessThan(r.h / 2);
  expect(r.focus.x).toBeCloseTo(r.w / 2, 0);
  expect(r.focus.y).toBeCloseTo(r.h / 2, 0);
  expect(r.focus.visible).toBe(false); // it is inside the heart, behind the wall
});

test("project agrees with pick, hides what the heart hides, and follows the cut", async ({ page }) => {
  await open(page);
  const img = await shot(page);
  const pixels = samplePixels(img, (r, g) => r > 60 && r > 1.8 * g, 200);
  const r = await page.evaluate((pixels) => {
    const rd = window.renderLab.renderer;
    // every picked voxel projects back to about the pixel it was picked at, and is visible
    let worst = 0, seen = 0, picked = 0;
    for (const [x, y] of pixels) {
      const v = rd.pick(x, y);
      if (!v) continue;
      picked++;
      const p = rd.project(v);
      worst = Math.max(worst, Math.hypot(p.x - x, p.y - y));
      if (p.visible) seen++;
    }
    // a voxel on the front hides when the camera goes round to the back, and comes back with it
    const front = rd.pick(720, 450);
    if (!front) throw new Error("nothing at the middle of the picture");
    const before = rd.project(front).visible;
    rd.camera.yaw += Math.PI;
    const behind = rd.project(front).visible;
    rd.camera.yaw -= Math.PI;
    const again = rd.project(front).visible;
    // cut the near half away: the voxel goes with it, and returns when the cut does
    rd.setCutaway(true, 0);
    const cut = rd.project(front).visible;
    rd.setCutaway(false);
    // a corner of the grid, with the camera as close as it goes: off the canvas
    const distance = rd.camera.distance;
    rd.camera.distance = 90;
    const corner = rd.project([0, 0, 0]);
    rd.camera.distance = distance;
    return { picked, worst, seen, before, behind, again, cut, restored: rd.project(front).visible, corner };
  }, pixels);
  console.log(`project vs pick: ${r.picked} voxels, worst distance ${r.worst.toFixed(1)} px, ${r.seen} visible`);
  expect(r.picked).toBeGreaterThan(190);
  expect(r.worst).toBeLessThan(8); // a voxel is about 5 pixels across
  expect(r.seen).toBeGreaterThanOrEqual(r.picked * 0.97);
  expect(r.before).toBe(true);
  expect(r.behind).toBe(false);
  expect(r.again).toBe(true);
  expect(r.cut).toBe(false);
  expect(r.restored).toBe(true);
  expect(r.corner.visible).toBe(false);
});

// ---- setInsets(): the heart in the free area of a full-bleed canvas ---------------------------------------

test("panels over the canvas: the heart is fitted to the free area and centred in it", async ({ page }) => {
  await open(page);
  await fire(page, 70);
  const W = 1440, H = 900;
  const r = await page.evaluate(() => {
    const lab = window.renderLab;
    const rd = lab.renderer;
    const whole = rd.camera.distance;
    const rightOnly = (() => {
      rd.setInsets({ top: 0, right: 400, bottom: 0, left: 0 });
      const p = rd.project(rd.focus);
      const v = rd.pick(520, 450);
      return { x: p.x, y: p.y, voxel: v };
    })();
    rd.setInsets({ top: 0, right: 404, bottom: 300, left: 0 });
    const p = rd.project(rd.focus);
    const v = rd.pick(518, 300);
    return { whole, distance: rd.camera.distance, rightOnly, target: { x: p.x, y: p.y }, voxel: v, focus: rd.focus, grid: { nx: lab.grid.nx, ny: lab.grid.ny } };
  });
  console.log(`right 400: target at (${r.rightOnly.x.toFixed(1)}, ${r.rightOnly.y.toFixed(1)}); right 404 + bottom 300: target at (${r.target.x.toFixed(1)}, ${r.target.y.toFixed(1)}), camera ${r.whole.toFixed(0)} -> ${r.distance.toFixed(0)} mm`);
  // the point the camera looks at lands in the middle of the free rectangle
  expect(r.rightOnly.x).toBeCloseTo((W - 400) / 2, 0);
  expect(r.rightOnly.y).toBeCloseTo(H / 2, 0);
  expect(r.target.x).toBeCloseTo((W - 404) / 2, 0);
  expect(r.target.y).toBeCloseTo((H - 300) / 2, 0);
  expect(r.distance).toBeGreaterThan(r.whole); // backed away to fit the smaller area
  // and picking there finds muscle near the middle of the heart
  for (const v of [r.rightOnly.voxel, r.voxel]) {
    expect(v).not.toBeNull();
    expect(Math.hypot(v![0] - r.focus[0], v![1] - r.focus[1], v![2] - r.focus[2])).toBeLessThan(65);
  }

  // the picture: the heart sits inside the free rectangle, with a little margin, near its middle
  const img = await shot(page, "desktop-5-panels-right404-bottom300");
  let x0 = W, x1 = 0, y0 = H, y1 = 0;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const [pr, pg, pb] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      if (isGlow(pr, pg, pb) || (pr > 60 && pr > 1.5 * pg)) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
  console.log(`heart pixels span x ${x0}-${x1}, y ${y0}-${y1} in a free area of x 0-${W - 404}, y 0-${H - 300}`);
  expect(x0).toBeGreaterThanOrEqual(4);
  expect(y0).toBeGreaterThanOrEqual(4);
  expect(x1).toBeLessThanOrEqual(W - 404 - 4);
  expect(y1).toBeLessThanOrEqual(H - 300 - 4);
  expect((y1 - y0) / (H - 300)).toBeGreaterThan(0.72); // it uses the room: not lost in the middle
  expect(Math.abs((x0 + x1) / 2 - (W - 404) / 2)).toBeLessThan(70);
  expect(Math.abs((y0 + y1) / 2 - (H - 300) / 2)).toBeLessThan(45);
  // the canvas itself is still full-bleed: the room fills the covered part too
  let dark = 0;
  for (let y = H - 250; y < H - 50; y += 10) for (let x = W - 380; x < W - 20; x += 10) dark += img.data[(y * img.width + x) * 4 + 2] > 8 ? 1 : 0;
  expect(dark).toBeGreaterThan(200); // the backdrop's teal is there, behind where the panels would be

  // a tap at that spot is reported at those canvas pixels, and picks the same voxel
  const tapped = await page.evaluate(() => {
    (window as unknown as { tap: number[] | null }).tap = null;
    window.renderLab.renderer.onTap = (x, y) => ((window as unknown as { tap: number[] | null }).tap = [x, y]);
    return true;
  });
  expect(tapped).toBe(true);
  await page.mouse.click(518, 300);
  const tap = await page.evaluate(() => (window as unknown as { tap: number[] | null }).tap);
  expect(tap).toEqual([518, 300]);

  // clearing the insets puts it back in the middle, and a resize keeps whatever is set
  const back = await page.evaluate(() => {
    const rd = window.renderLab.renderer;
    rd.setInsets({ top: 0, right: 0, bottom: 0, left: 0 });
    const whole = rd.project(rd.focus);
    rd.setInsets({ top: 0, right: 404, bottom: 300, left: 0 });
    rd.resize(1000, 700, 1);
    const smaller = rd.project(rd.focus);
    rd.setInsets({ top: 0, right: 0, bottom: 0, left: 0 });
    rd.resize(1440, 900, 1);
    return { whole, smaller };
  });
  expect(back.whole.x).toBeCloseTo(W / 2, 0);
  expect(back.whole.y).toBeCloseTo(H / 2, 0);
  expect(back.smaller.x).toBeCloseTo((1000 - 404) / 2, 0);
  expect(back.smaller.y).toBeCloseTo((700 - 300) / 2, 0);
});

test("silly insets are harmless", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const lab = window.renderLab;
    const rd = lab.renderer;
    const out: { x: number; y: number }[] = [];
    for (const i of [
      { top: -50, right: NaN, bottom: 0, left: Infinity },
      { top: 5000, right: 5000, bottom: 5000, left: 5000 },
      { top: 0, right: 1435, bottom: 0, left: 0 },
      { top: 0, right: 0, bottom: 0, left: 0 },
    ]) {
      rd.setInsets(i);
      await lab.draw();
      const p = rd.project(rd.focus);
      out.push({ x: p.x, y: p.y });
    }
    return { out, distance: rd.camera.distance };
  });
  for (const p of r.out) {
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(1440);
  }
  expect(Number.isFinite(r.distance)).toBe(true);
});

// ---- safety ---------------------------------------------------------------------------------------------

test("resize, setQuality and destroy are safe to repeat, and a canvas with no size does not throw", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const lab = window.renderLab;
    const rd = lab.renderer;
    const sizes: [number, number, number][] = [[1440, 900, 1], [0, 0, 1], [1, 1, 0.5], [390, 844, 3], [0, 300, 2], [800, 0, 1], [1440, 900, 2], [NaN, 5, 1]];
    for (let i = 0; i < 24; i++) {
      const [w, h, d] = sizes[i % sizes.length];
      rd.resize(w, h, d);
      rd.resize(w, h, d); // the same again
      rd.setQuality((["low", "medium", "high"] as const)[i % 3]);
      rd.setQuality((["low", "medium", "high"] as const)[i % 3]);
      rd.frame();
    }
    await lab.device.queue.onSubmittedWorkDone();
    // a canvas that the page has shrunk to nothing: frame() just does nothing
    lab.canvas.width = 0;
    lab.canvas.height = 0;
    let threw = false;
    try {
      rd.frame();
      rd.frame();
    } catch {
      threw = true;
    }
    rd.resize(1440, 900, 1);
    rd.setQuality("high");
    await lab.draw();
    const restored = [lab.canvas.width, lab.canvas.height];
    // a renderer that is destroyed twice, then poked
    const extra = await lab.spawn();
    extra.destroy();
    extra.destroy();
    let poked = true;
    try {
      extra.resize(300, 200, 1);
      extra.setQuality("low");
      extra.setInsets({ top: 0, right: 10, bottom: 0, left: 0 });
      extra.setCutaway(true, 0);
      extra.frame();
      extra.destroy();
    } catch {
      poked = false;
    }
    await lab.device.queue.onSubmittedWorkDone();
    return { threw, restored, poked };
  });
  expect(r.threw).toBe(false);
  expect(r.restored).toEqual([1440, 900]);
  expect(r.poked).toBe(true);
});

// The voltage volume the shaders see keeps, besides u, a "trend": positive where the voltage just rose
// (the front), negative where it just fell (the tail). These tests read it back.

test("the rising front is remembered while the solver stands still", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const lab = window.renderLab;
    lab.sim.stimulate(lab.apex, 3);
    lab.play(30);
    const count = async () => {
      const f = await lab.renderer.readField();
      let excited = 0, front = 0, peak = -2;
      for (let i = 0; i < f.length; i += 4)
        if (f[i] > 1.0) {
          excited++;
          if (f[i + 1] > 0.3) front++;
          peak = Math.max(peak, f[i + 1]);
        }
      return { excited, front, peak };
    };
    const running = await count();
    for (let k = 0; k < 8; k++) await lab.draw(); // eight frames, the solver idle
    const idle = await count();
    return { running, idle };
  });
  console.log(`front voxels: ${r.running.front} of ${r.running.excited} excited, peak trend ${r.running.peak.toFixed(2)}; after 8 idle frames ${r.idle.front}, peak ${r.idle.peak.toFixed(2)}`);
  expect(r.running.front).toBeGreaterThan(100);
  expect(r.running.peak).toBeGreaterThan(0.9);
  // nothing fades while nothing moves (half precision storage must not look like change)
  expect(r.idle.front).toBe(r.running.front);
  expect(r.idle.peak).toBeCloseTo(r.running.peak, 2);
});

test("only the newly excited band counts as the front, not the whole excited region", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const lab = window.renderLab;
    lab.sim.stimulate(lab.apex, 3);
    lab.play(90);
    const f = await lab.renderer.readField();
    let excited = 0, front = 0;
    for (let i = 0; i < f.length; i += 4)
      if (f[i] > 1.0) {
        excited++;
        if (f[i + 1] > 0.3) front++;
      }
    return { excited, front };
  });
  console.log(`after 90 ms: ${r.front} of ${r.excited} excited voxels are the front (${((100 * r.front) / r.excited).toFixed(1)}%)`);
  expect(r.excited).toBeGreaterThan(20000);
  expect(r.front / r.excited).toBeGreaterThan(0.01);
  expect(r.front / r.excited).toBeLessThan(0.5);
});

test("the foot of a second front still counts as rising where the tissue has just recovered", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const lab = window.renderLab;
    lab.sim.setTissue({ recovery: 0.3 }); // a short action potential, so the tissue is soon ready again
    lab.sim.stimulate(lab.apex, 3);
    lab.play(300); // the first wave crosses and the heart recovers, every voxel remembered as falling
    const first = await lab.renderer.readField();
    let remembered = 0, resting = 0;
    for (let i = 0; i < first.length; i += 4)
      if (first[i + 2] > 0 && Math.abs(first[i]) < 0.1) {
        resting++;
        if (first[i + 1] < -0.005) remembered++;
      }
    lab.sim.stimulate(lab.apex, 3);
    lab.play(30); // the second wave
    const f = await lab.renderer.readField();
    // the foot of the front: the voltage climbing, not yet at the dome
    let foot = 0, rising = 0;
    for (let i = 0; i < f.length; i += 4)
      if (f[i + 2] > 0 && f[i] > 0.1 && f[i] < 0.9) {
        foot++;
        if (f[i + 1] > 0.3) rising++;
      }
    return { resting, remembered, foot, rising };
  });
  console.log(`after the first wave ${r.remembered} of ${r.resting} resting voxels still remember falling; second wave: ${r.rising} of ${r.foot} foot voxels are rising`);
  expect(r.remembered / r.resting).toBeGreaterThan(0.5); // the scenario is the hard one
  expect(r.foot).toBeGreaterThan(200);
  expect(r.rising / r.foot).toBeGreaterThan(0.8);
});

test("drag orbits, the wheel and a pinch zoom, a tap is reported", async ({ page }) => {
  await open(page);
  const cam = () => page.evaluate(() => ({ yaw: window.renderLab.renderer.camera.yaw, pitch: window.renderLab.renderer.camera.pitch, distance: window.renderLab.renderer.camera.distance }));
  const start = await cam();

  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(800, 480, { steps: 6 });
  await page.mouse.up();
  const dragged = await cam();
  expect(dragged.yaw).toBeLessThan(start.yaw - 0.3);
  expect(dragged.pitch).toBeGreaterThan(start.pitch + 0.05);
  expect(dragged.distance).toBeCloseTo(start.distance, 6);

  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(50);
  const zoomedIn = await cam();
  expect(zoomedIn.distance).toBeLessThan(dragged.distance * 0.8);
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(50);
  expect((await cam()).distance).toBeGreaterThan(zoomedIn.distance * 1.3);

  // two fingers moving apart zoom in, then together zoom out
  const before = await cam();
  await page.evaluate(() => {
    const c = window.renderLab.canvas;
    const touch = (type: string, id: number, x: number, y: number) =>
      c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: x, clientY: y, bubbles: true }));
    touch("pointerdown", 1, 620, 450);
    touch("pointerdown", 2, 720, 450);
    touch("pointermove", 1, 560, 450);
    touch("pointermove", 2, 780, 450);
    touch("pointerup", 1, 560, 450);
    touch("pointerup", 2, 780, 450);
  });
  const pinched = await cam();
  expect(pinched.distance).toBeLessThan(before.distance * 0.9);
  expect(pinched.yaw).toBeCloseTo(before.yaw, 6); // a pinch does not orbit

  // a tap (press and release without moving) is reported in canvas pixels; a drag is not
  await page.evaluate(() => {
    (window as unknown as { taps: number[][] }).taps = [];
    window.renderLab.renderer.onTap = (x, y) => (window as unknown as { taps: number[][] }).taps.push([x, y]);
  });
  await page.mouse.click(500, 300);
  await page.mouse.move(600, 400);
  await page.mouse.down();
  await page.mouse.move(700, 420, { steps: 4 });
  await page.mouse.up();
  const taps = await page.evaluate(() => (window as unknown as { taps: number[][] }).taps);
  expect(taps).toEqual([[500, 300]]);
});

test("resize follows the device pixel ratio and caps the backing store", async ({ page }) => {
  await open(page);
  const sizes = await page.evaluate(async () => {
    const lab = window.renderLab;
    const out: Record<string, number[]> = {};
    const size = () => [lab.canvas.width, lab.canvas.height];
    lab.renderer.resize(1440, 900, 1);
    out.dpr1 = size();
    lab.renderer.resize(1440, 900, 2); // 2880 x 1800 = 5.2 MP wanted, the high tier allows 4 MP
    out.dpr2 = size();
    lab.renderer.resize(390, 844, 3); // a ratio of 3 is capped at 2
    out.phone = size();
    lab.renderer.setQuality("low");
    lab.renderer.resize(1000, 600, 1);
    out.low = size();
    await lab.draw();
    lab.renderer.setQuality("high");
    lab.renderer.resize(1440, 900, 1);
    await lab.draw();
    return out;
  });
  expect(sizes.dpr1).toEqual([1440, 900]);
  expect(sizes.dpr2[0] * sizes.dpr2[1]).toBeLessThanOrEqual(4_000_000);
  expect(sizes.dpr2[0] * sizes.dpr2[1]).toBeGreaterThan(3_800_000);
  expect(sizes.dpr2[0] / sizes.dpr2[1]).toBeCloseTo(1.6, 1);
  expect(sizes.phone).toEqual([780, 1688]);
  expect(sizes.low).toEqual([750, 450]);
});

for (const tier of ["low", "medium", "high"]) {
  test(`the ${tier} quality tier draws a lit heart with no GPU errors`, async ({ page }) => {
    await open(page, tier);
    const rest = await shot(page);
    await fire(page, 60);
    const img = await shot(page, `tier-${tier}`);
    expect(meanLuminance(rest)).toBeGreaterThan(8);
    expect(glowFraction(rest)).toBe(0);
    expect(glowFraction(img)).toBeGreaterThan(0.01);
  });
}

test("create throws the compiler message when a shader is broken, and leaks no GPU error", async ({ page }) => {
  await open(page);
  const message = await page.evaluate(async () => {
    const lab = window.renderLab;
    const original = lab.device.createShaderModule.bind(lab.device);
    lab.device.createShaderModule = (d) => original(d.label === "scene" ? { ...d, code: d.code + "\nfn broken( {" } : d);
    try {
      await lab.spawn();
      return "created without error";
    } catch (e) {
      return String(e);
    } finally {
      lab.device.createShaderModule = original;
    }
  });
  console.log(`broken shader: ${message.slice(0, 160)}`);
  expect(message).toMatch(/scene shader failed to compile/);
  // and a working renderer can still be built afterwards
  const ok = await page.evaluate(async () => {
    const r = await window.renderLab.spawn();
    r.destroy();
    return true;
  });
  expect(ok).toBe(true);
});

test("destroy releases the renderer, and another can be built on the same device", async ({ page }) => {
  await open(page);
  await fire(page, 30);
  const r = await page.evaluate(async () => {
    const lab = window.renderLab;
    const extra = await lab.spawn("medium");
    extra.resize(320, 200, 1);
    extra.frame();
    await lab.device.queue.onSubmittedWorkDone();
    extra.destroy();
    extra.frame(); // a destroyed renderer ignores frame()
    lab.renderer.destroy();
    const again = await lab.spawn();
    again.frame();
    await lab.device.queue.onSubmittedWorkDone();
    again.destroy();
    return true;
  });
  expect(r).toBe(true);
});

test("frame time at 1440x900 with the solver running", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const lab = window.renderLab;
    lab.sim.stimulate(lab.apex, 3);
    lab.play(120);
    await lab.device.queue.onSubmittedWorkDone();
    // 150 solver steps (7.5 ms of simulated time) a frame, as the app runs
    const withSolver = await lab.measure(120, 7.5);
    const rendererOnly = await lab.measure(120, 0);
    return { withSolver, rendererOnly };
  });
  console.log(`frame time, high, 1440x900: ${r.withSolver.mean.toFixed(2)} ms (p95 ${r.withSolver.p95.toFixed(2)}) with 150 solver steps a frame; renderer alone ${r.rendererOnly.mean.toFixed(2)} ms`);
  expect(r.withSolver.mean).toBeLessThan(16.6); // 60 fps
  expect(r.rendererOnly.mean).toBeLessThan(8);
});

/** Up to n canvas pixels, evenly spread through the picture, that pass a test on their red and green. */
function samplePixels(img: Picture, keep: (r: number, g: number) => boolean, n: number): [number, number][] {
  const all: [number, number][] = [];
  for (let y = 0; y < img.height; y += 3)
    for (let x = 0; x < img.width; x += 3) {
      const i = (y * img.width + x) * 4;
      if (keep(img.data[i], img.data[i + 1])) all.push([x, y]);
    }
  const step = Math.max(1, Math.floor(all.length / n));
  return all.filter((_, i) => i % step === 0).slice(0, n);
}
