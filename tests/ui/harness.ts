// Runs inside the browser under Playwright. Exposes the UI modules and some pixel-probe helpers as window.ui.
// Modules load on demand, so a spec only depends on the module it tests.
import type { Monitor } from "../../src/ui/monitor";
import type { ComparePanel, EcgSamples } from "../../src/ui/compare";
import type { MonitorMode } from "../../src/ui/monitorLayout";
import { synthLeads } from "./synth";

export type Rect = [x: number, y: number, w: number, h: number];

const loadMonitor = () => import("../../src/ui/monitor");
const loadRecorder = () => import("../../src/ui/recorder");
const loadCompare = () => import("../../src/ui/compare");

const shots = new Map<number, ImageData>();
let nextShot = 1;

// The simulated trace is a bright green and a recorded one is amber; the grid, labels and glow are all much dimmer.
const isTrace = (r: number, g: number): boolean => g >= 215 && g - r >= 60;
const isAmber = (r: number, g: number, b: number): boolean => r >= 235 && g >= 180 && b <= 175 && r - b >= 70;
export type TraceKind = "teal" | "amber";
const matches = (kind: TraceKind, r: number, g: number, b: number): boolean => (kind === "teal" ? isTrace(r, g) : isAmber(r, g, b));

const COUNTED = ["lineTo", "moveTo", "stroke", "drawImage", "fill", "arc", "clip", "fillRect", "clearRect", "fillText"] as const;

let mountedPanel: { panel: ComparePanel; host: HTMLElement; data: EcgSamples } | null = null;

const stage = (): HTMLElement => {
  const el = document.getElementById("stage");
  if (!el) throw new Error("no #stage");
  return el;
};

export interface MountOptions {
  width: number;
  height: number;
  dpr?: number;
  mode?: MonitorMode;
  windowMs?: number;
  /** Ask for a CPU-backed canvas, to compare with the default. */
  softwareRaster?: boolean;
}

const ui = {
  loadMonitor,
  loadRecorder,
  loadCompare,
  synthLeads,
  stage,
  current: null as { monitor: Monitor; canvas: HTMLCanvasElement } | null,

  async mountMonitor(o: MountOptions): Promise<Monitor> {
    const { Monitor } = await loadMonitor();
    const canvas = document.createElement("canvas");
    if (o.softwareRaster) canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    stage().replaceChildren(canvas);
    const m = new Monitor(canvas);
    if (o.mode) m.setMode(o.mode);
    if (o.windowMs) m.setWindowMs(o.windowMs);
    m.resize(o.width, o.height, o.dpr ?? 1);
    m.render();
    ui.current = { monitor: m, canvas };
    return m;
  },

  /**
   * Push synthetic beats for simulated time [fromMs, toMs), one sample every stepMs, rendering about
   * every frameMs the way a running app would. Returns toMs so calls chain.
   */
  feed(m: Monitor, fromMs: number, toMs: number, stepMs = 4, frameMs = 16): number {
    const leads = new Float32Array(12);
    const n = Math.round((toMs - fromMs) / stepMs);
    let nextRender = fromMs + frameMs;
    for (let i = 0; i < n; i++) {
      const t = fromMs + i * stepMs;
      m.push(t, synthLeads(t, leads));
      if (t + stepMs >= nextRender) {
        m.render();
        nextRender = t + stepMs + frameMs;
      }
    }
    m.render();
    return toMs;
  },

  /** Time each render() call over `frames` frames of 4 new samples. */
  timeRenders(m: Monitor, startMs: number, frames: number): number[] {
    const leads = new Float32Array(12);
    const times: number[] = [];
    let t = startMs;
    for (let f = 0; f < frames; f++) {
      for (let k = 0; k < 4; k++, t += 4) m.push(t, synthLeads(t, leads));
      const t0 = performance.now();
      m.render();
      times.push(performance.now() - t0);
    }
    return times;
  },

  /**
   * The average cost of a frame including the GPU's work. A canvas records its drawing and the GPU does it later, so
   * timing render() alone misses that. Here `frames` frames run back to back and then one tiny readback forces
   * everything to finish, so the wait for the readback itself is shared between all of them. Returns ms per frame,
   * one value per batch.
   */
  timeBatches(m: Monitor, canvas: HTMLCanvasElement, startMs: number, batches: number, frames: number): number[] {
    const leads = new Float32Array(12);
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    const perFrame: number[] = [];
    let t = startMs;
    for (let b = 0; b < batches; b++) {
      const t0 = performance.now();
      for (let f = 0; f < frames; f++) {
        for (let k = 0; k < 4; k++, t += 4) m.push(t, synthLeads(t, leads));
        m.render();
      }
      ctx.getImageData(0, 0, 1, 1);
      perFrame.push((performance.now() - t0) / frames);
    }
    return perFrame;
  },

  /** Like timeBatches, but every step is a full repaint. Returns ms per repaint, one value per batch. */
  timeFullRepaints(m: Monitor, canvas: HTMLCanvasElement, batches: number, repaints: number): number[] {
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    const perRepaint: number[] = [];
    for (let b = 0; b < batches; b++) {
      const t0 = performance.now();
      for (let i = 0; i < repaints; i++) {
        m.invalidate();
        m.render();
      }
      ctx.getImageData(0, 0, 1, 1);
      perRepaint.push((performance.now() - t0) / repaints);
    }
    return perRepaint;
  },

  /** The gaps between animation frames while the monitor renders every frame, as a real page would. */
  framePacing(m: Monitor, startMs: number, frames: number): Promise<number[]> {
    return new Promise((resolve) => {
      const leads = new Float32Array(12);
      const gaps: number[] = [];
      let t = startMs;
      let last = 0;
      let n = 0;
      const step = (now: number) => {
        if (last) gaps.push(now - last);
        last = now;
        for (let k = 0; k < 4; k++, t += 4) m.push(t, synthLeads(t, leads));
        m.render();
        if (++n < frames) requestAnimationFrame(step);
        else resolve(gaps);
      };
      requestAnimationFrame(step);
    });
  },

  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),

  /** A canvas that repaints itself every animation frame: a solid colour with a moving square and some stripes. */
  animatedCanvas(width: number, height: number, hue: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    let frame = 0;
    const paint = () => {
      frame++;
      ctx.fillStyle = `hsl(${hue}, 80%, 35%)`;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "white";
      ctx.fillRect((frame * 5) % (width - 24), (frame * 3) % (height - 24), 24, 24);
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = `hsl(${(hue + frame * 7 + i * 30) % 360}, 90%, 60%)`;
        ctx.fillRect(0, ((frame * 2 + i * 9) % height), width, 2);
      }
      requestAnimationFrame(paint);
    };
    paint();
    return canvas;
  },

  /** Copy the canvas into memory and return a handle to compare later. */
  grab(canvas: HTMLCanvasElement): number {
    const scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const c = scratch.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    c.drawImage(canvas, 0, 0);
    shots.set(nextShot, c.getImageData(0, 0, scratch.width, scratch.height));
    return nextShot++;
  },

  /** How many pixels differ between two grabs (in a rectangle, or everywhere), the biggest channel gap, and where the first few are. */
  diff(a: number, b: number, rect?: Rect): { count: number; maxDelta: number; first: [number, number, number][] } {
    const A = shots.get(a);
    const B = shots.get(b);
    if (!A || !B || A.width !== B.width || A.height !== B.height) throw new Error("bad grabs");
    const [x0, y0, w, h] = rect ?? [0, 0, A.width, A.height];
    let count = 0;
    let maxDelta = 0;
    const first: [number, number, number][] = [];
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const i = 4 * (y * A.width + x);
        const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
        if (d > 0) {
          count++;
          if (d > maxDelta) maxDelta = d;
          if (first.length < 8) first.push([x, y, d]);
        }
      }
    return { count, maxDelta, first };
  },

  /** One pixel of a grab, as [r, g, b, a]. */
  pixel(id: number, x: number, y: number): number[] {
    const S = shots.get(id);
    if (!S) throw new Error("bad grab");
    const i = 4 * (y * S.width + x);
    return [S.data[i], S.data[i + 1], S.data[i + 2], S.data[i + 3]];
  },

  /** Number of trace-coloured pixels (green by default, or amber) in a rectangle of a grab. */
  traceCount(id: number, rect: Rect, kind: TraceKind = "teal"): number {
    const S = shots.get(id);
    if (!S) throw new Error("bad grab");
    const [x0, y0, w, h] = rect;
    let n = 0;
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const i = 4 * (y * S.width + x);
        if (matches(kind, S.data[i], S.data[i + 1], S.data[i + 2])) n++;
      }
    return n;
  },

  /**
   * The box around all the trace-coloured pixels of a grab, or null if there are none. Lenient about colour, so a thin
   * line that is spread over two rows of pixels still counts, and it ignores the top `skipTop` rows, where the label is.
   */
  traceBounds(id: number, kind: TraceKind, skipTop = 0): { left: number; right: number; top: number; bottom: number; count: number } | null {
    const S = shots.get(id);
    if (!S) throw new Error("bad grab");
    const lenient = (r: number, g: number, b: number) => (kind === "teal" ? g >= 150 && g - r >= 45 : r >= 150 && r - b >= 60);
    let left = Infinity, right = -1, top = Infinity, bottom = -1, count = 0;
    for (let y = skipTop; y < S.height; y++)
      for (let x = 0; x < S.width; x++) {
        const i = 4 * (y * S.width + x);
        if (!lenient(S.data[i], S.data[i + 1], S.data[i + 2])) continue;
        count++;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    return count === 0 ? null : { left, right, top, bottom, count };
  },

  /** The rows, from the top, where a column of a grab holds trace colour. */
  traceRowsAt(id: number, x: number, kind: TraceKind): number[] {
    const S = shots.get(id);
    if (!S) throw new Error("bad grab");
    const rows: number[] = [];
    for (let y = 0; y < S.height; y++) {
      const i = 4 * (y * S.width + x);
      if (matches(kind, S.data[i], S.data[i + 1], S.data[i + 2])) rows.push(y);
    }
    return rows;
  },

  /** WCAG contrast ratio between an element's text colour and the background actually behind it. */
  contrast(el: Element): number {
    const parse = (css: string): [number, number, number, number] => {
      const m = css.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1].split(",").map((x) => parseFloat(x));
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
    ];
    // the background: walk up until something opaque, then paint the translucent layers back down on it
    const layers: [number, number, number, number][] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] === 1) break;
    }
    let bg: [number, number, number] = [255, 255, 255];
    for (const layer of layers.reverse()) bg = over(layer, bg);
    const fg = over(parse(getComputedStyle(el).color), bg);
    const lum = ([r, g, b]: [number, number, number]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  },

  /** Build a comparison panel in a host box of the given inner width, from the shipped data unless others are given. */
  async mountCompare(o: { width: number; samples?: EcgSamples; simulated?: () => { t: Float32Array; v: Float32Array } }) {
    const { ComparePanel, parseEcgSamples } = await loadCompare();
    const data = o.samples ?? parseEcgSamples(await (await fetch("/data/ecg-samples.json")).json());
    const host = document.createElement("div");
    host.id = "compare-host";
    host.style.cssText = `width:${o.width}px;padding:12px;background:#0d1518;box-sizing:content-box`;
    stage().replaceChildren(host);
    const panel = new ComparePanel(host, data, o.simulated ?? (() => ui.simTrace(2000, 7000)));
    mountedPanel = { panel, host, data };
    return { data, panel, host };
  },

  panel(): { panel: ComparePanel; host: HTMLElement; data: EcgSamples } {
    if (!mountedPanel) throw new Error("no panel mounted");
    return mountedPanel;
  },

  /** Lead II from the synthetic beat as a { t, v } trace, one sample every 4 ms over [fromMs, toMs). */
  simTrace(fromMs: number, toMs: number): { t: Float32Array; v: Float32Array } {
    const n = Math.round((toMs - fromMs) / 4);
    const t = new Float32Array(n);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      t[i] = fromMs + 4 * i;
      v[i] = synthLeads(t[i])[1];
    }
    return { t, v };
  },

  /** For each row of one pixel column, from y0 up to y1 (exclusive), how much brighter `after` is than `before`. */
  columnProfile(before: number, after: number, x: number, y0: number, y1: number): number[] {
    const A = shots.get(before);
    const B = shots.get(after);
    if (!A || !B) throw new Error("bad grabs");
    const out: number[] = [];
    for (let y = y0; y < y1; y++) {
      const i = 4 * (y * A.width + x);
      out.push(Math.max(0, B.data[i] - A.data[i], B.data[i + 1] - A.data[i + 1], B.data[i + 2] - A.data[i + 2]));
    }
    return out;
  },

  /** Run `work` and count the 2D drawing calls it makes, on the context and on Path2D objects. */
  countCalls(work: () => void): Record<string, number> {
    type Method = (...a: unknown[]) => unknown;
    const targets: { proto: Record<string, Method>; names: readonly string[] }[] = [
      { proto: CanvasRenderingContext2D.prototype as unknown as Record<string, Method>, names: COUNTED },
      { proto: Path2D.prototype as unknown as Record<string, Method>, names: ["lineTo", "moveTo"] },
    ];
    const counts: Record<string, number> = {};
    const restore: (() => void)[] = [];
    for (const { proto, names } of targets)
      for (const name of names) {
        const original = proto[name];
        counts[name] ??= 0;
        proto[name] = function (this: unknown, ...args: unknown[]) {
          counts[name]++;
          return original.apply(this, args);
        };
        restore.push(() => {
          proto[name] = original;
        });
      }
    try {
      work();
    } finally {
      restore.forEach((r) => r());
    }
    return counts;
  },
};

declare global {
  interface Window {
    ui: typeof ui;
  }
}

window.ui = ui;
