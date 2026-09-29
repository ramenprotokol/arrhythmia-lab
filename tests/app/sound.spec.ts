// What the heartbeat sound and the rhythm reading do in the real page, in real Chrome with the real GPU. A test cannot
// listen, so it reads what the page asked the sound system for (window.__lab.audio.stats) and what the rhythm analyser
// says (window.__lab.analyzer.state). The sounds themselves are measured in tests/audio/voices.spec.ts.
import { test, expect, type Page } from "@playwright/test";
import { consoleGuard } from "../ui/consoleGuard";
import "./labHandle";

const guard = consoleGuard();

test.beforeEach(async ({ page }) => {
  guard.attach(page);
});
test.afterEach(async ({ page }) => {
  guard.check();
  const gpuErrors = await page.evaluate(() => window.__labErrors ?? []);
  expect(gpuErrors).toEqual([]);
});

async function start(page: Page) {
  await page.goto("/?debug&quality=low");
  await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, undefined, { timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__lab), undefined, { timeout: 5_000 });
  await page.evaluate(() => window.__lab.setSpeed(1));
}

const kind = (page: Page) => page.evaluate(() => window.__lab.analyzer.state.kind);

async function waitForKind(page: Page, want: string, timeout: number) {
  await page.waitForFunction((k) => window.__lab.analyzer.state.kind === k, want, { timeout });
}

async function waitForInduction(page: Page) {
  await page.waitForFunction(() => window.__lab.engine.inducer.state.status === "success", undefined, { timeout: 90_000 });
}

test("the rhythm reading follows the live heart: steady at 75 a minute, and slow motion does not change the rate", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await page.waitForFunction(
    () => {
      const s = window.__lab.analyzer.state;
      return s.kind === "steady" && s.bpm !== null && s.bpm > 72 && s.bpm < 78 && s.output > 0.9;
    },
    undefined,
    { timeout: 30_000 },
  );
  // Half speed: the beats come twice as far apart in real time, but the simulated rate is still 75.
  await page.evaluate(() => window.__lab.setSpeed(0.5));
  const t0 = await page.evaluate(() => window.__lab.engine.simTime);
  await page.waitForFunction((t) => window.__lab.engine.simTime > t + 5000, t0, { timeout: 60_000 });
  const s = await page.evaluate(() => window.__lab.analyzer.state);
  expect(s.kind).toBe("steady");
  expect(s.bpm).toBeGreaterThan(72);
  expect(s.bpm).toBeLessThan(78);
});

test("sound is off until asked; then each beat is a lub and a dub; off means silent again", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  expect(await page.evaluate(() => window.__lab.audio.state)).toBe("off");
  await waitForKind(page, "steady", 30_000);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__lab.audio.stats)).toEqual({ first: 0, second: 0, thump: 0, shock: 0 });

  // a key press is a real user gesture, so the browser lets audio start
  await page.keyboard.press("m");
  await page.waitForFunction(() => window.__lab.audio.state === "on", undefined, { timeout: 5_000 });
  await page.waitForFunction(() => window.__lab.audio.stats.first >= 3 && window.__lab.audio.stats.second >= 3, undefined, { timeout: 15_000 });
  const stats = await page.evaluate(() => window.__lab.audio.stats);
  expect(stats.thump).toBe(0);
  expect(stats.shock).toBe(0);
  expect(Math.abs(stats.first - stats.second)).toBeLessThanOrEqual(1);

  await page.keyboard.press("m");
  await page.waitForFunction(() => window.__lab.audio.state === "off", undefined, { timeout: 5_000 });
  const off = await page.evaluate(() => window.__lab.audio.stats);
  await page.waitForTimeout(3000);
  expect(await page.evaluate(() => window.__lab.audio.stats)).toEqual(off);
});

test("racing reads racing and thumps, fibrillation reads chaotic, a shock reads quiet, and fix it brings the steady beat back", async ({ page }) => {
  test.setTimeout(300_000);
  await start(page);
  await page.keyboard.press("m");
  await page.waitForFunction(() => window.__lab.audio.state === "on", undefined, { timeout: 5_000 });
  await waitForKind(page, "steady", 30_000);

  // break it: a racing rhythm
  await page.evaluate(() => window.__lab.moves.race());
  expect(await page.evaluate(() => window.__lab.moves.starting)).toBe("racing");
  await waitForInduction(page);
  await waitForKind(page, "racing", 30_000);
  // "how much it pumps" looks back over the last 1.6 s, so it takes a moment to catch up with the change
  await page.waitForFunction(() => window.__lab.analyzer.state.output < 0.4, undefined, { timeout: 10_000 });
  const rate = await page.evaluate(() => window.__lab.analyzer.state);
  expect(rate.kind).toBe("racing");
  expect(rate.bpm).toBeGreaterThan(230);
  expect(rate.bpm).toBeLessThan(300);
  const thumps = await page.evaluate(() => window.__lab.audio.stats.thump);
  await page.waitForFunction((n) => window.__lab.audio.stats.thump >= n + 5, thumps, { timeout: 10_000 });

  // break it further: fibrillation
  await page.evaluate(() => window.__lab.moves.fibrillate());
  await waitForInduction(page);
  await waitForKind(page, "chaotic", 30_000);
  expect((await page.evaluate(() => window.__lab.analyzer.state)).bpm).toBeNull();
  // fibrillation has no heartbeat to hear: no beat sounds are asked for while it lasts
  const quiet = await page.evaluate(() => ({ ...window.__lab.audio.stats }));
  await page.waitForTimeout(3000);
  expect(await page.evaluate(() => window.__lab.audio.stats)).toEqual(quiet);

  // the shock, from the keyboard: the whole heart fires at once, it reads quiet, it makes its sound, and then the steady beat comes back by itself
  const shocks = await page.evaluate(() => window.__lab.audio.stats.shock);
  await page.keyboard.press("s");
  await waitForKind(page, "quiet", 2_000);
  expect(await page.evaluate(() => window.__lab.audio.stats.shock)).toBe(shocks + 1);
  await waitForKind(page, "steady", 20_000);
  // the rate needs three beats before it can be stated
  await page.waitForFunction(() => (window.__lab.analyzer.state.bpm ?? 0) > 70, undefined, { timeout: 15_000 });

  // fix it, from a racing rhythm: shock, healthy tissue, pacemaker back, a steady beat again
  await page.evaluate(() => window.__lab.moves.race());
  await waitForInduction(page);
  await waitForKind(page, "racing", 30_000);
  await page.evaluate(() => window.__lab.moves.fix());
  await waitForKind(page, "steady", 20_000);
  const after = await page.evaluate(() => ({ tissue: window.__lab.engine.tissue, pacemaker: window.__lab.engine.pacemaker, moves: window.__lab.moves.starting }));
  expect(after.tissue).toEqual({ conduction: 1, recovery: 1 });
  expect(after.pacemaker).toBe(true);
  expect(after.moves).toBeNull();
  expect(await kind(page)).toBe("steady");
});

test("while the lab is finding the moment that starts a rhythm it makes no beat sounds, and the thumps begin once the heart is racing", async ({ page }) => {
  test.setTimeout(180_000);
  await start(page);
  await page.keyboard.press("m");
  await page.waitForFunction(() => window.__lab.audio.state === "on", undefined, { timeout: 5_000 });
  await waitForKind(page, "steady", 30_000);
  // The lab jolts the heart and runs three times faster while it hunts for a timing; the analyser reads jolts as beats,
  // and those must not be played as a scramble of lubs and thumps.
  const during = await page.evaluate(
    () =>
      new Promise<{ starting: boolean; sounds: number }>((resolve) => {
        const L = window.__lab;
        const total = () => L.audio.stats.first + L.audio.stats.second + L.audio.stats.thump;
        L.moves.race();
        const starting = L.moves.starting !== null;
        const base = total();
        const id = setInterval(() => {
          if (L.moves.starting !== null) return;
          clearInterval(id);
          resolve({ starting, sounds: total() - base });
        }, 5);
      }),
  );
  expect(during.starting).toBe(true);
  expect(during.sounds).toBe(0);
  await waitForKind(page, "racing", 30_000);
  const thumps = await page.evaluate(() => window.__lab.audio.stats.thump);
  await page.waitForFunction((n) => window.__lab.audio.stats.thump >= n + 5, thumps, { timeout: 10_000 });
});

test("a tap right after the page opens is never read as a racing rhythm, and the card never shows a wrong rate", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await waitForKind(page, "steady", 30_000);
  // The tap lands between two steady beats. Its beat, the steady beat that follows it and an echo in the tissue make three
  // beats within about a second, which used to be read as the racing wave for a second and a half.
  const point = await page.evaluate(() => {
    const L = window.__lab;
    const spots = [[680, 300], [640, 300], [700, 340], [600, 280], [660, 260]];
    return spots.find(([x, y]) => L.renderer.pick(x, y) !== null) ?? null;
  });
  expect(point, "no spot on the heart to tap").not.toBeNull();
  await page.mouse.click((point as number[])[0], (point as number[])[1]);
  const seen = await page.evaluate(
    () =>
      new Promise<{ kind: string; bpm: number | null }[]>((resolve) => {
        const out: { kind: string; bpm: number | null }[] = [];
        const t0 = performance.now();
        const id = setInterval(() => {
          const s = window.__lab.analyzer.state;
          out.push({ kind: s.kind, bpm: s.bpm });
          if (performance.now() - t0 > 6000) {
            clearInterval(id);
            resolve(out);
          }
        }, 50);
      }),
  );
  expect(seen.some((s) => s.kind === "racing")).toBe(false);
  for (const s of seen) {
    if (s.kind !== "steady" || s.bpm === null) continue;
    expect(s.bpm).toBeGreaterThan(70);
    expect(s.bpm).toBeLessThan(80);
  }
  expect(seen[seen.length - 1].kind).toBe("steady");
  expect(seen[seen.length - 1].bpm).not.toBeNull();
});

test("like a defibrillator, Shock leaves a healthy pumping heart alone, and says so", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await page.keyboard.press("m");
  await page.waitForFunction(() => window.__lab.audio.state === "on", undefined, { timeout: 5_000 });
  await waitForKind(page, "steady", 30_000);
  const before = await page.evaluate(() => ({ shock: window.__lab.audio.stats.shock, tissue: { ...window.__lab.engine.tissue } }));
  await page.keyboard.press("s");
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({ shock: window.__lab.audio.stats.shock, tissue: { ...window.__lab.engine.tissue }, kind: window.__lab.analyzer.state.kind }));
  expect(after.shock, "no thud for a shock that was not given").toBe(before.shock);
  expect(after.kind).toBe("steady");
  expect(after.tissue).toEqual(before.tissue);
  // and the same rule at the API the buttons use
  const refusal = await page.evaluate(() => window.__lab.moves.shock(window.__lab.analyzer.state));
  expect(refusal).toEqual({ fired: false, reason: "pumping" });
});

test("an early extra beat is recognised as early, and the beat that falls in its recovery is not counted", async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  await waitForKind(page, "steady", 30_000);
  await page.waitForFunction(() => (window.__lab.analyzer.state.bpm ?? 0) > 70, undefined, { timeout: 15_000 });
  const result = await page.evaluate(
    () =>
      new Promise<{ early: number; total: number; gaps: number[] }>((resolve) => {
        const L = window.__lab;
        const seen: { tMs: number; premature: boolean }[] = [];
        const off = L.analyzer.onBeat((e) => seen.push({ tMs: e.tMs, premature: e.premature }));
        L.moves.extraBeat();
        // watch for about 3.2 s of simulated time: the early beat, the pause, and the beats after it
        const start = L.engine.simTime;
        const id = setInterval(() => {
          if (L.engine.simTime - start < 3200) return;
          clearInterval(id);
          off();
          const gaps = seen.slice(1).map((b, i) => b.tMs - seen[i].tMs);
          resolve({ early: seen.filter((b) => b.premature).length, total: seen.length, gaps });
        }, 50);
      }),
  );
  expect(result.early).toBe(1);
  // the pause: the gap from the early beat to the next beat is longer than a normal one (the pacemaker's beat in between did not take)
  expect(result.gaps[0]).toBeGreaterThan(900);
});
