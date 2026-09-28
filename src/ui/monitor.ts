// The hospital-monitor style ECG panel: 12 leads (or just lead II) drawn as phosphor traces that sweep across
// dark ECG paper, with a short gap erased just ahead of the sweep bar.
//
// Drawing is incremental. Each frame only the columns around the sweep bar change, so render() repaints just
// those columns of every box, straight from the stored samples, and leaves the rest of the canvas alone. A
// full repaint (resize, mode change, clear) uses the same code over the whole box, and a test checks that the
// two give the same picture.
import { CanvasDescription } from "./a11y";
import { INK } from "./ecgPaper";
import { computeLayout, type Box, type MonitorLayout, type MonitorMode } from "./monitorLayout";
import { paintPaper } from "./monitorPaper";
import { SampleRing } from "./sampleRing";

const LEADS = 12;
/** Share of a box's width that is erased just ahead of the sweep bar. */
const SWEEP_GAP = 0.04;
/** Nothing real is this big, so a larger value is a fault. It is clamped so it cannot wreck the drawing. */
const MAX_MV = 50;
const MIN_WINDOW_MS = 500;
const MAX_WINDOW_MS = 120_000;
/** The ring keeps at most one sample per 0.5 ms, so this many per ms of window is always enough. */
const MAX_SAMPLES_PER_MS = 2;

const capacityFor = (windowMs: number): number => Math.ceil(windowMs * MAX_SAMPLES_PER_MS) + 8;

/** A soft glow with a bright core, drawn once. Half its width is never more than the monitor's redraw margin. */
function makeDot(dpr: number): HTMLCanvasElement {
  const glow = 6 * dpr;
  const size = Math.ceil(2 * glow) + 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = INK.simGlow;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, glow, 0, 2 * Math.PI);
    ctx.fill();
    ctx.fillStyle = INK.dot;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, 2.3 * dpr, 0, 2 * Math.PI);
    ctx.fill();
  }
  return canvas;
}

const LABEL: Record<MonitorMode, string> = {
  twelve: "Simulated 12-lead ECG monitor",
  single: "Simulated ECG monitor, lead II",
};
const DESCRIPTION: Record<MonitorMode, string> = {
  twelve:
    "Live traces from the simulated heart: the twelve standard ECG leads (I, II, III, aVR, aVL, aVF and V1 to V6) " +
    "in three rows of four, with a long lead II rhythm strip along the bottom. Traces sweep from left to right and " +
    "are redrawn as new data arrives. The gain is fixed at 5 millimetres per millivolt, half the standard, so large swings fit. Simulated. Not a medical device.",
  single:
    "Live trace of lead II from the simulated heart, sweeping from left to right and redrawn as new data arrives. " +
    "The gain is fixed at 10 millimetres per millivolt. Simulated. Not a medical device.",
};

export class Monitor {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly description: CanvasDescription;
  private readonly ring = new SampleRing(LEADS, capacityFor(6000));
  private readonly scratch = new Float32Array(LEADS);
  private mode: MonitorMode = "twelve";
  private windowMs = 6000;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private sized = false;
  private layout: MonitorLayout | null = null;
  private paper: HTMLCanvasElement | null = null;
  /** The bright dot at the head of a trace, pre-rendered. */
  private dot: HTMLCanvasElement | null = null;
  /** How far past a region's edge samples are still drawn, so joins and glow at the edge come out right. */
  private pad = 7;
  private needsFull = true;
  /** Bumped by every push, so render() can tell whether there is anything new to draw. */
  private version = 0;
  private paintedVersion = -1;
  /** Time of the newest sample when the canvas was last painted, or NaN if no trace has been painted. */
  private paintedT = Number.NaN;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Monitor needs a 2D canvas, and this one already has a different kind of context.");
    this.ctx = ctx;
    this.description = new CanvasDescription(canvas, LABEL.twelve, DESCRIPTION.twelve);
  }

  /** One sample of all 12 leads in mV (I, II, III, aVR, aVL, aVF, V1 to V6) at simulated time `tMs`. */
  push(tMs: number, leads: Float32Array): void {
    if (leads.length < LEADS) throw new RangeError(`push expects ${LEADS} lead values (I, II, III, aVR, aVL, aVF, V1 to V6), got ${leads.length}`);
    if (!Number.isFinite(tMs)) throw new RangeError("push expects a finite time in milliseconds");
    if (tMs < this.ring.lastTime) this.reset(); // the simulation's clock went back: start a fresh trace
    for (let i = 0; i < LEADS; i++) {
      const v = leads[i];
      this.scratch[i] = Number.isFinite(v) ? Math.max(-MAX_MV, Math.min(MAX_MV, v)) : 0;
    }
    this.ring.push(tMs, this.scratch);
    this.version++;
  }

  setMode(mode: MonitorMode): void {
    if (mode !== "twelve" && mode !== "single") throw new RangeError(`mode must be "twelve" or "single", got ${String(mode)}`);
    if (mode === this.mode) return;
    this.mode = mode;
    this.description.set(LABEL[mode], DESCRIPTION[mode]);
    if (this.sized) {
      this.rebuild();
      this.render();
    }
  }

  /** How much time the sweep covers. Any value from 0.5 s to 2 minutes; 6 s to 12 s reads best. */
  setWindowMs(ms: number): void {
    if (!Number.isFinite(ms) || ms < MIN_WINDOW_MS || ms > MAX_WINDOW_MS) {
      throw new RangeError(`window must be between ${MIN_WINDOW_MS} and ${MAX_WINDOW_MS} ms, got ${ms}`);
    }
    this.windowMs = ms;
    this.ring.resize(capacityFor(ms));
    if (this.sized) {
      this.rebuild();
      this.render();
    }
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    this.applySize(cssWidth, cssHeight, devicePixelRatio);
    this.render();
  }

  /** Draw whatever changed since the last call. Call it once per frame. */
  render(): void {
    const layout = this.ensureLayout();
    if (!layout || !this.paper) return;
    const hasData = this.ring.length > 0;
    if (!this.needsFull && (!hasData || this.version === this.paintedVersion)) return;

    if (this.needsFull || Number.isNaN(this.paintedT)) this.paintAll(layout, this.paper);
    else this.paintChanged(layout);

    this.needsFull = false;
    this.paintedVersion = this.version;
    this.paintedT = hasData ? this.ring.lastTime : Number.NaN;
  }

  /** Forget all samples and show empty paper. */
  clear(): void {
    this.reset();
    this.render();
  }

  /** The stored samples of one lead that fall inside the window, oldest first. Times are simulated ms as pushed. */
  getTrace(lead: number): { t: Float32Array; v: Float32Array } {
    if (!Number.isInteger(lead) || lead < 0 || lead >= LEADS) throw new RangeError(`lead must be a whole number from 0 to ${LEADS - 1}, got ${lead}`);
    return this.ring.window(lead, this.ring.lastTime - this.windowMs);
  }

  /** Make the next render() repaint everything. */
  invalidate(): void {
    this.needsFull = true;
  }

  /** Where the boxes are, in device pixels. Null while the canvas is too small to draw on. */
  getLayout(): MonitorLayout | null {
    return this.ensureLayout();
  }

  dispose(): void {
    this.description.remove();
  }

  private reset(): void {
    this.ring.clear();
    this.needsFull = true;
    this.paintedT = Number.NaN;
    this.version++;
  }

  private ensureLayout(): MonitorLayout | null {
    if (!this.sized) {
      const dpr = window.devicePixelRatio || 1;
      this.applySize(this.canvas.clientWidth || this.canvas.width / dpr, this.canvas.clientHeight || this.canvas.height / dpr, dpr);
    }
    this.description.attach();
    return this.layout;
  }

  private applySize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || cssWidth < 0 || cssHeight < 0) {
      throw new RangeError(`size must be zero or more, got ${cssWidth} x ${cssHeight}`);
    }
    if (!Number.isFinite(dpr) || dpr <= 0) throw new RangeError(`devicePixelRatio must be more than 0, got ${dpr}`);
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    this.sized = true;
    const canvas = this.canvas;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    // Leave the CSS size to the page whenever the page already gives the canvas the size asked for: a stylesheet
    // that sizes it (flex, 100%) would stop following its container if an inline size were set on top. Only a canvas
    // whose box does not come out right, such as one with no size of its own, is given one.
    if (Math.abs(canvas.clientWidth - cssWidth) > 1 || Math.abs(canvas.clientHeight - cssHeight) > 1) {
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
    this.rebuild();
  }

  private rebuild(): void {
    this.layout = computeLayout({ mode: this.mode, width: this.cssWidth, height: this.cssHeight, dpr: this.dpr, windowMs: this.windowMs });
    this.pad = Math.ceil(7 * this.dpr);
    this.dot = makeDot(this.dpr);
    this.paper = null;
    if (this.layout) {
      const paper = document.createElement("canvas");
      paper.width = this.layout.width;
      paper.height = this.layout.height;
      const ctx = paper.getContext("2d");
      if (ctx) {
        paintPaper(ctx, this.layout);
        this.paper = paper;
      }
    }
    this.needsFull = true;
  }

  private paintAll(layout: MonitorLayout, paper: HTMLCanvasElement): void {
    this.ctx.drawImage(paper, 0, 0);
    for (const box of layout.boxes) this.paintColumns(box, 0, box.w, false);
  }

  private paintChanged(layout: MonitorLayout): void {
    const now = this.ring.lastTime;
    for (const box of layout.boxes) for (const [x0, x1] of this.changedColumns(box, this.paintedT, now)) this.paintColumns(box, x0, x1, true);
  }

  /**
   * The columns of a box (as [from, to) pairs, in pixels from its left edge) that look different now that the
   * newest sample has moved from `prevT` to `nowT`: from just behind the old sweep bar to just past the gap
   * that is now ahead of the new one. Wraps around the right edge if the sweep did.
   */
  private changedColumns(box: Box, prevT: number, nowT: number): [number, number][] {
    const msPerPx = box.spanMs / box.w;
    const gapPx = Math.round(SWEEP_GAP * box.w);
    const length = (nowT - prevT) / msPerPx + gapPx + 2 * this.pad + 2;
    if (length >= box.w) return [[0, box.w]];
    const phase = ((prevT % box.spanMs) + box.spanMs) % box.spanMs;
    let start = (phase / msPerPx - this.pad - 1) % box.w;
    if (start < 0) start += box.w;
    const end = start + length;
    if (end <= box.w) return [[Math.floor(start), Math.min(box.w, Math.ceil(end))]];
    return [
      [Math.floor(start), box.w],
      [0, Math.min(box.w, Math.ceil(end - box.w))],
    ];
  }

  /** Repaint columns [x0, x1) of a box: fresh paper (unless the whole canvas was just painted), then the traces. */
  private paintColumns(box: Box, x0: number, x1: number, freshPaper: boolean): void {
    if (x1 <= x0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x + x0, box.y, x1 - x0, box.h);
    ctx.clip();
    if (freshPaper && this.paper) ctx.drawImage(this.paper, box.x + x0, box.y, x1 - x0, box.h, box.x + x0, box.y, x1 - x0, box.h);
    this.strokeTrace(box, x0, x1);
    ctx.restore();
  }

  /**
   * Draw the part of the box's trace that lies in columns [x0, x1). Samples from the current pass end at the
   * sweep bar; samples from the previous pass start a gap beyond it, and the two are never joined.
   */
  private strokeTrace(box: Box, x0: number, x1: number): void {
    const { ring, ctx, layout } = this;
    if (!layout || ring.length === 0) return;
    const dpr = layout.dpr;
    const span = box.spanMs;
    const msPerPx = span / box.w;
    const now = ring.lastTime;
    const passStart = Math.floor(now / span) * span;
    const gapMs = Math.round(SWEEP_GAP * box.w) * msPerPx;
    const firstOfPass = ring.lowerBound(passStart);
    const firstVisibleOfPrevious = ring.lowerBound(now - span + gapMs);
    const limit = 2 * box.h;
    const gain = layout.pxPerMv;
    const yOf = (i: number) => box.baseline - Math.max(-limit, Math.min(limit, ring.valueAt(box.lead, i) * gain));

    const path = new Path2D();
    const addRun = (base: number, first: number, last: number) => {
      // only the samples that fall in, or just beside, the columns being drawn
      const a = Math.max(first, ring.lowerBound(base + (x0 - this.pad) * msPerPx) - 1);
      const b = Math.min(last, ring.upperBound(base + (x1 + this.pad) * msPerPx));
      for (let i = a; i <= b; i++) {
        const x = box.x + (ring.timeAt(i) - base) / msPerPx;
        if (i === a) path.moveTo(x, yOf(i));
        else path.lineTo(x, yOf(i));
      }
    };
    addRun(passStart - span, firstVisibleOfPrevious, firstOfPass - 1);
    addRun(passStart, firstOfPass, ring.length - 1);

    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = 5.5 * dpr;
    ctx.strokeStyle = INK.simGlow;
    ctx.stroke(path);
    ctx.lineWidth = 1.6 * dpr;
    ctx.strokeStyle = INK.simCore;
    ctx.stroke(path);

    // The bright dot at the sweep bar is a pre-rendered sprite blitted at a whole pixel. Blits are exact: a filled
    // circle leaks a little coverage past the clip edge on a GPU canvas (and nothing ever erases that), and a very
    // short round-capped stroke is antialiased slightly differently depending on the clip.
    const dot = this.dot;
    if (dot) {
      const hx = box.x + (now - passStart) / msPerPx;
      ctx.drawImage(dot, Math.round(hx - dot.width / 2), Math.round(yOf(ring.length - 1) - dot.height / 2));
    }
  }
}
