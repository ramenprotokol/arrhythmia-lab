import { describe, it, expect } from "vitest";
import { computeLayout, LEAD_NAMES, type Box, type MonitorLayout } from "../../src/ui/monitorLayout";

const twelve = (width = 1200, height = 700, dpr = 1, windowMs = 6000): MonitorLayout => {
  const l = computeLayout({ mode: "twelve", width, height, dpr, windowMs });
  if (!l) throw new Error("no layout");
  return l;
};
const single = (width = 390, height = 260, dpr = 1, windowMs = 6000): MonitorLayout => {
  const l = computeLayout({ mode: "single", width, height, dpr, windowMs });
  if (!l) throw new Error("no layout");
  return l;
};
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("lead names", () => {
  it("are the twelve standard leads in the order the ECG computation returns them", () => {
    expect(LEAD_NAMES).toEqual(["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]);
  });
});

describe("twelve-lead layout", () => {
  it("has 12 lead boxes in the clinical arrangement, plus a lead II rhythm strip", () => {
    const l = twelve();
    const cells = l.boxes.filter((b) => b.kind === "cell");
    expect(l.boxes).toHaveLength(13);
    expect(cells).toHaveLength(12);
    const grid = [0, 1, 2].map((row) => cells.filter((b) => b.row === row).sort((a, b) => a.col - b.col).map((b) => b.label));
    expect(grid).toEqual([
      ["I", "aVR", "V1", "V4"],
      ["II", "aVL", "V2", "V5"],
      ["III", "aVF", "V3", "V6"],
    ]);
    const strip = l.boxes.filter((b) => b.kind === "strip");
    expect(strip).toHaveLength(1);
    expect(strip[0].lead).toBe(1);
    expect(strip[0].row).toBe(3);
  });

  it("points every box at the right lead index", () => {
    for (const b of twelve().boxes.filter((x) => x.kind === "cell")) expect(LEAD_NAMES[b.lead]).toBe(b.label);
  });

  it("keeps boxes on whole pixels, inside the canvas, and never overlapping", () => {
    for (const [w, h, dpr] of [
      [1200, 700, 1],
      [1440, 900, 2],
      [700, 520, 1],
      [390, 500, 3],
    ] as const) {
      const l = twelve(w, h, dpr);
      for (const b of l.boxes) {
        for (const v of [b.x, b.y, b.w, b.h]) expect(Number.isInteger(v)).toBe(true);
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(Math.round(w * dpr));
        expect(b.y + b.h).toBeLessThanOrEqual(Math.round(h * dpr));
      }
      for (let i = 0; i < l.boxes.length; i++)
        for (let j = i + 1; j < l.boxes.length; j++) expect(overlap(l.boxes[i], l.boxes[j])).toBe(false);
    }
  });

  it("uses one time scale everywhere: the strip shows the whole window, each lead a quarter of it", () => {
    const l = twelve(1200, 700, 1, 6000);
    const strip = l.boxes.find((b) => b.kind === "strip") as Box;
    const cells = l.boxes.filter((b) => b.kind === "cell");
    expect(strip.spanMs).toBe(6000);
    for (const c of cells) expect(c.spanMs).toBe(1500);
    expect(strip.w).toBe(cells.filter((c) => c.row === 0).reduce((n, c) => n + c.w, 0));
    for (const b of l.boxes) expect(b.spanMs / b.w).toBeCloseTo(l.msPerPx, 9);
  });

  it("changing the window changes the time scale but not where anything is", () => {
    const a = twelve(1200, 700, 1, 6000);
    const b = twelve(1200, 700, 1, 12000);
    expect(b.boxes.map(({ x, y, w, h }) => [x, y, w, h])).toEqual(a.boxes.map(({ x, y, w, h }) => [x, y, w, h]));
    expect(b.msPerPx).toBeCloseTo(a.msPerPx * 2, 9);
    expect([a.windowMs, b.windowMs]).toEqual([6000, 12000]);
  });

  it("puts the calibration pulse at the left end of each row only", () => {
    const l = twelve();
    for (const b of l.boxes) expect(b.calibration).toBe(b.col === 0);
    expect(l.boxes.filter((b) => b.calibration)).toHaveLength(4);
  });

  it("puts the zero line in the middle of each box", () => {
    for (const b of twelve().boxes) expect(Math.abs(b.baseline - (b.y + b.h / 2))).toBeLessThanOrEqual(0.5);
  });

  it("uses one fixed gain in every box (5 mm/mV for the twelve small rows, 10 for the single lead), on a whole number of pixels per mm", () => {
    for (const [w, h, dpr] of [
      [1200, 700, 1],
      [1440, 900, 2],
      [700, 520, 1],
    ] as const) {
      const l = twelve(w, h, dpr);
      expect(Number.isInteger(l.pxPerMm)).toBe(true);
      expect(l.gainMmPerMv).toBe(l.mode === "twelve" ? 5 : 10);
      expect(l.pxPerMv).toBe(l.gainMmPerMv * l.pxPerMm);
      expect(l.pxPerMm).toBeGreaterThanOrEqual(2);
      // one millivolt (10 mm) is a good part of a row but leaves room either side
      const row = l.boxes[0].h;
      expect(l.pxPerMv).toBeLessThan(row * 0.5);
    }
  });

  it("leaves room in a twelve-lead row for a 2.4 mV swing either way, so a racing rhythm is not cut flat", () => {
    for (const [w, h, dpr] of [
      [1200, 700, 1],
      [1440, 900, 2],
      [860, 500, 1],
    ] as const) {
      const l = twelve(w, h, dpr);
      for (const b of l.boxes) {
        const half = b.h / 2;
        expect(2.4 * l.pxPerMv, `${b.id} at ${w}x${h}@${dpr}`).toBeLessThanOrEqual(half);
      }
    }
  });

  it("scales with the device pixel ratio", () => {
    const a = twelve(1200, 700, 1);
    const b = twelve(1200, 700, 2);
    expect(b.pxPerMm).toBe(2 * a.pxPerMm);
    expect(b.boxes[0].w).toBeGreaterThanOrEqual(2 * a.boxes[0].w - 2);
  });

  it("leaves a gutter on the left for the calibration pulse and a footer for the notice", () => {
    const l = twelve();
    const left = Math.min(...l.boxes.map((b) => b.x));
    expect(left).toBeGreaterThanOrEqual(l.gutter.w);
    const bottom = Math.max(...l.boxes.map((b) => b.y + b.h));
    expect(l.footer.y).toBeGreaterThanOrEqual(bottom);
    expect(l.footer.y + l.footer.h).toBeLessThanOrEqual(700);
  });

  it("gives up cleanly when the canvas is too small to draw on", () => {
    expect(computeLayout({ mode: "twelve", width: 0, height: 0, dpr: 1, windowMs: 6000 })).toBeNull();
    expect(computeLayout({ mode: "twelve", width: 120, height: 80, dpr: 1, windowMs: 6000 })).toBeNull();
  });
});

describe("single-lead layout", () => {
  it("is one large lead II box that shows the whole window", () => {
    const l = single(390, 260, 1, 6000);
    expect(l.boxes).toHaveLength(1);
    const b = l.boxes[0];
    expect(b).toMatchObject({ kind: "single", label: "II", lead: 1, spanMs: 6000, calibration: true });
    expect(b.spanMs / b.w).toBeCloseTo(l.msPerPx, 9);
  });

  it("fills the canvas apart from the margin, the gutter and the footer", () => {
    const l = single(390, 260, 1);
    const b = l.boxes[0];
    expect(b.x).toBeGreaterThanOrEqual(l.gutter.w);
    expect(b.x + b.w).toBeLessThanOrEqual(390);
    expect(b.h).toBeGreaterThan(260 * 0.7);
    expect(b.y + b.h).toBeLessThanOrEqual(l.footer.y);
  });

  it("puts the zero line below the middle, because lead II is mostly upright", () => {
    const b = single(390, 260).boxes[0];
    expect(Math.abs(b.baseline - (b.y + 0.58 * b.h))).toBeLessThanOrEqual(1);
  });

  it("keeps the same gain as the twelve-lead layout, so amplitudes match between modes", () => {
    expect(single(1200, 700).pxPerMm).toBe(twelve(1200, 700).pxPerMm);
  });

  it("draws a short strip at 3 px per mm, so the one big lead stays readable in a low dock", () => {
    expect(single(1300, 92).pxPerMm).toBe(3);
  });
});

describe("the strip's lead", () => {
  it("is lead II unless another is asked for, in both layouts", () => {
    expect(single().boxes[0].lead).toBe(1);
    expect(twelve().boxes.find((b) => b.kind === "strip")?.lead).toBe(1);
  });

  it("follows stripLead in the single box and the twelve-lead rhythm strip, and names it", () => {
    const one = computeLayout({ mode: "single", width: 390, height: 260, dpr: 1, windowMs: 6000, stripLead: 7 });
    expect(one?.boxes[0]).toMatchObject({ lead: 7, label: "V2", kind: "single" });
    const all = computeLayout({ mode: "twelve", width: 1200, height: 700, dpr: 1, windowMs: 6000, stripLead: 6 });
    const strip = all?.boxes.find((b) => b.kind === "strip");
    expect(strip).toMatchObject({ lead: 6, label: "V1" });
    // the twelve small boxes keep their own leads
    expect(all?.boxes.filter((b) => b.kind === "cell").map((b) => b.lead).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("refuses a lead that does not exist", () => {
    expect(() => computeLayout({ mode: "single", width: 390, height: 260, dpr: 1, windowMs: 6000, stripLead: 12 })).toThrow(/stripLead/);
    expect(() => computeLayout({ mode: "single", width: 390, height: 260, dpr: 1, windowMs: 6000, stripLead: 1.5 })).toThrow(/stripLead/);
  });
});

describe("gains by lead group", () => {
  const withGains = (mode: "twelve" | "single", gains: { limb?: number; chest?: number }, stripLead = 1) =>
    computeLayout({ mode, width: 1200, height: 700, dpr: 1, windowMs: 6000, stripLead, gains })!;

  it("starts every box at the mode's standard gain", () => {
    for (const b of twelve().boxes) expect(b.gainMmPerMv).toBe(5);
    expect(single().boxes[0].gainMmPerMv).toBe(10);
    expect(twelve().groupGains).toEqual({ limb: 5, chest: 5 });
  });

  it("draws the chest leads at their own gain, and the rhythm strip at its lead's", () => {
    const l = withGains("twelve", { chest: 2.5 });
    for (const b of l.boxes) {
      const chest = b.lead >= 6;
      expect(b.gainMmPerMv, b.id).toBe(chest ? 2.5 : 5);
      expect(b.pxPerMv, b.id).toBe(b.gainMmPerMv * l.pxPerMm);
    }
    expect(l.groupGains).toEqual({ limb: 5, chest: 2.5 });
    // the layout's own gain is the limb leads'
    expect(l.gainMmPerMv).toBe(5);
    const onChest = withGains("twelve", { chest: 2.5 }, 8);
    expect(onChest.boxes.find((b) => b.kind === "strip")?.gainMmPerMv).toBe(2.5);
  });

  it("gives the single box its lead's gain", () => {
    expect(withGains("single", { chest: 5 }, 7).boxes[0].gainMmPerMv).toBe(5);
    expect(withGains("single", { chest: 5 }, 1).boxes[0].gainMmPerMv).toBe(10);
    expect(withGains("single", { chest: 5 }, 7).gainMmPerMv).toBe(5);
  });

  it("refuses a gain that is not a positive number", () => {
    expect(() => withGains("twelve", { chest: 0 })).toThrow(/gain/);
    expect(() => withGains("twelve", { limb: Number.NaN })).toThrow(/gain/);
  });

  it("puts the zero line in the middle of the single box for any lead but lead II, which is mostly upright", () => {
    const b = withGains("single", {}, 8).boxes[0];
    expect(Math.abs(b.baseline - (b.y + b.h / 2))).toBeLessThanOrEqual(1);
  });
});
