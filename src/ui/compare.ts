// The recorded-ECG comparison panel: pick one of a few real recordings, and see it beside the simulated lead II on
// the same scale. The caption and the credit are plain text in the panel, always shown, with no way to fold them away.
import "./compare.css";
import { CanvasDescription } from "./a11y";
import { FONT, INK, drawEcgGrid } from "./ecgPaper";

export type EcgSample = { id: string; label: string; lead: string; fs: number; mv: number[]; record: string };
export type EcgSamples = { samples: EcgSample[]; source: string; licence: string; url: string };
/** The simulation's lead II: times in ms (any epoch, only differences matter) and values in mV, oldest first. */
export type SimulatedTrace = () => { t: Float32Array; v: Float32Array };

export const COMPARE_CAPTION =
  "Recorded ECGs are shown for visual comparison only. This is an educational simulation, not a medical device and not a diagnostic tool.";
export const COMPARE_CREDIT = "Recorded ECGs: PTB-XL, CC BY 4.0; MIT-BIH Arrhythmia Database, ODC-By 1.0.";
const SCALE_NOTE =
  "Both traces are drawn on the same scale, like standard ECG paper: 25 mm per second across and 10 mm per millivolt up. " +
  "Each large square is 0.2 seconds by 0.5 millivolts.";

// ---- reading the data file ------------------------------------------------------------------------------------

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function fail(where: string, problem: string): never {
  throw new Error(`ecg samples: ${where} ${problem}`);
}

function text(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") fail(`${where}${key}`, "must be a non-empty string");
  return v;
}

/** Check that `json` has the shape of public/data/ecg-samples.json and return it typed. Throws, naming the problem, if not. */
export function parseEcgSamples(json: unknown): EcgSamples {
  if (!isObject(json)) fail("the file", "must be an object");
  const list = json.samples;
  if (!Array.isArray(list)) fail("samples", "must be a list");
  if (list.length === 0) fail("samples", "must hold at least one recording");

  const seen = new Set<string>();
  const samples = list.map((raw: unknown, i): EcgSample => {
    const where = `samples[${i}]`;
    if (!isObject(raw)) fail(where, "must be an object");
    const id = text(raw, "id", `${where}.`);
    if (seen.has(id)) fail(`${where}.id`, `is a duplicate id (${id})`);
    seen.add(id);
    const label = text(raw, "label", `${where}.`);
    const lead = text(raw, "lead", `${where}.`);
    const record = text(raw, "record", `${where}.`);
    const fs = raw.fs;
    if (typeof fs !== "number" || !Number.isFinite(fs) || fs <= 0) fail(`${where}.fs`, "must be a number above 0");
    const mv = raw.mv;
    if (!Array.isArray(mv) || mv.length === 0) fail(`${where}.mv`, "must be a non-empty list of numbers");
    mv.forEach((v: unknown, j) => {
      if (typeof v !== "number" || !Number.isFinite(v)) fail(`${where}.mv[${j}]`, "must be a finite number");
    });
    return { id, label, lead, fs, mv: mv as number[], record };
  });

  return { samples, source: text(json, "source", ""), licence: text(json, "licence", ""), url: text(json, "url", "") };
}

// ---- the panel ------------------------------------------------------------------------------------------------

/** Both plots are ECG paper at the standard 25 mm/s and 10 mm/mV, and show five seconds. */
const SPAN_S = 5;
const MM_PER_S = 25;
const MM_PER_MV = 10;
const MM_WIDE = SPAN_S * MM_PER_S;
/** The vertical range shown: from -1.5 mV up to +3.5 mV, which holds every recording shipped with the app. */
const TOP_MV = 3.5;
const BOTTOM_MV = -1.5;
const MM_TALL = (TOP_MV - BOTTOM_MV) * MM_PER_MV;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (content !== undefined) el.textContent = content;
  return el;
}

export class ComparePanel {
  private readonly root: HTMLElement;
  private readonly plots: HTMLElement;
  private readonly recordedCanvas: HTMLCanvasElement;
  private readonly simulatedCanvas: HTMLCanvasElement;
  private readonly recordedText: CanvasDescription;
  private readonly simulatedText: CanvasDescription;
  private readonly recordLine: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly samples = new Map<string, EcgSample>();
  private readonly observer: ResizeObserver | null;
  private current: string;

  constructor(
    container: HTMLElement,
    data: EcgSamples,
    private readonly simulated: SimulatedTrace,
  ) {
    for (const s of data.samples) this.samples.set(s.id, s);
    const first = data.samples[0];
    if (!first) throw new Error("ComparePanel needs at least one recorded sample.");
    this.current = first.id;

    this.root = element("section", "acl-compare");
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", "Recorded ECG comparison");

    const choices = element("div", "acl-compare__samples");
    choices.setAttribute("role", "group");
    choices.setAttribute("aria-label", "Recorded ECG to compare");
    for (const s of data.samples) choices.append(this.buildButton(s));

    this.recordedCanvas = element("canvas", "acl-compare__canvas");
    this.simulatedCanvas = element("canvas", "acl-compare__canvas");
    this.plots = element("div", "acl-compare__plots");
    this.plots.append(this.recordedCanvas, this.simulatedCanvas);

    const notes = element("div", "acl-compare__text");
    this.recordLine = element("p", "acl-compare__record");
    notes.append(
      element("p", "acl-compare__caption", COMPARE_CAPTION),
      this.recordLine,
      element("p", "acl-compare__scale", SCALE_NOTE),
      element("p", "acl-compare__credit", COMPARE_CREDIT),
    );

    this.root.append(choices, this.plots, notes);
    container.append(this.root);

    this.recordedText = new CanvasDescription(this.recordedCanvas, "", "");
    this.simulatedText = new CanvasDescription(
      this.simulatedCanvas,
      "Simulated lead II ECG from the live simulation, the most recent five seconds",
      "The most recent five seconds of lead II from the live simulation, drawn on the same scale as the recorded ECG above: " +
        "25 millimetres per second and 10 millimetres per millivolt. Simulated. Not a medical device.",
    );
    this.showChoice(first);

    this.observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.render());
    this.observer?.observe(this.plots);
    this.render();
  }

  get selectedId(): string {
    return this.current;
  }

  select(id: string): void {
    const sample = this.samples.get(id);
    if (!sample) throw new Error(`No recorded ECG with the id "${id}". The choices are: ${[...this.samples.keys()].join(", ")}.`);
    this.current = id;
    this.showChoice(sample);
    this.render();
  }

  /** Redraw both traces, asking the simulation for its latest. Call it as often as the simulated trace should refresh. */
  render(): void {
    const cssWidth = this.plots.clientWidth;
    if (cssWidth < 40) return; // hidden or collapsed: nothing to draw on yet
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(cssWidth * dpr);
    const height = Math.round((width * MM_TALL) / MM_WIDE);
    for (const canvas of [this.recordedCanvas, this.simulatedCanvas]) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    }
    const sample = this.samples.get(this.current);
    if (sample) this.paint(this.recordedCanvas, dpr, `Recorded ECG, lead ${sample.lead}`, (ctx, g) => this.recordedTrace(ctx, g, sample));
    this.paint(this.simulatedCanvas, dpr, "Simulated, lead II", (ctx, g) => this.simulatedTrace(ctx, g));
  }

  /** Take the panel out of the page again, leaving anything else in the container alone. */
  dispose(): void {
    this.observer?.disconnect();
    this.recordedText.remove();
    this.simulatedText.remove();
    this.root.remove();
  }

  private buildButton(sample: EcgSample): HTMLButtonElement {
    const button = element("button", "acl-compare__sample");
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    // "Name: what it is" is set on two lines, but the text stays exactly the label
    const colon = sample.label.indexOf(":");
    if (colon < 0) {
      button.append(element("span", "acl-compare__name", sample.label));
    } else {
      const rest = sample.label.slice(colon + 1);
      const gap = /^\s*/.exec(rest)?.[0] ?? "";
      button.append(element("span", "acl-compare__name", sample.label.slice(0, colon + 1)), document.createTextNode(gap), element("span", "acl-compare__desc", rest.slice(gap.length)));
    }
    button.addEventListener("click", () => this.select(sample.id));
    this.buttons.set(sample.id, button);
    return button;
  }

  private showChoice(sample: EcgSample): void {
    for (const [id, button] of this.buttons) button.setAttribute("aria-pressed", String(id === sample.id));
    this.recordLine.textContent = `Record: ${sample.record}`;
    this.recordedText.set(
      `Recorded ECG, lead ${sample.lead}: ${sample.label}`,
      `Five seconds of a recorded lead ${sample.lead} ECG from a public database (${sample.record}), on standard ECG paper at ` +
        "25 millimetres per second and 10 millimetres per millivolt. Shown for visual comparison only. Not a medical device and not a diagnostic tool.",
    );
  }

  private paint(canvas: HTMLCanvasElement, dpr: number, title: string, trace: (ctx: CanvasRenderingContext2D, g: Geometry) => void): void {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const { width, height } = canvas;
    const pitch = width / MM_WIDE;
    const g: Geometry = { dpr, width, pxPerSec: MM_PER_S * pitch, pxPerMv: MM_PER_MV * pitch, baseline: TOP_MV * MM_PER_MV * pitch };
    ctx.fillStyle = INK.paper;
    ctx.fillRect(0, 0, width, height);
    // the zero line is on a heavy grid line, as it is on the monitor
    drawEcgGrid(ctx, { x: 0, y: 0, w: width, h: height }, { x: 0, y: g.baseline }, pitch, dpr);
    const frame = Math.max(1, Math.round(dpr));
    ctx.strokeStyle = INK.rule;
    ctx.lineWidth = frame;
    ctx.strokeRect(frame / 2, frame / 2, width - frame, height - frame);
    trace(ctx, g);
    ctx.font = `700 ${11 * dpr}px ${FONT}`;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = INK.label;
    ctx.fillText(title.toUpperCase(), 10 * dpr, 17 * dpr);
  }

  private recordedTrace(ctx: CanvasRenderingContext2D, g: Geometry, sample: EcgSample): void {
    const path = new Path2D();
    sample.mv.forEach((mv, i) => {
      const x = (i / sample.fs) * g.pxPerSec;
      const y = g.baseline - mv * g.pxPerMv;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    stroke(ctx, path, g.dpr, INK.recGlow, INK.recCore);
  }

  /** The newest simulated sample sits at the right edge and older ones run back to the left. */
  private simulatedTrace(ctx: CanvasRenderingContext2D, g: Geometry): void {
    const { t, v } = this.simulated();
    const n = Math.min(t.length, v.length);
    if (n === 0) {
      ctx.font = `500 ${12 * g.dpr}px ${FONT}`;
      ctx.fillStyle = INK.note;
      ctx.textAlign = "center";
      ctx.fillText("Waiting for the simulation", g.width / 2, g.baseline - 12 * g.dpr);
      return;
    }
    const end = t[n - 1];
    const path = new Path2D();
    let started = false;
    for (let i = 0; i < n; i++) {
      const x = g.width - ((end - t[i]) / 1000) * g.pxPerSec;
      if (x < -10) continue; // older than the plot shows
      const y = g.baseline - v[i] * g.pxPerMv;
      if (started) path.lineTo(x, y);
      else path.moveTo(x, y);
      started = true;
    }
    stroke(ctx, path, g.dpr, INK.simGlow, INK.simCore);
  }
}

type Geometry = { dpr: number; width: number; pxPerSec: number; pxPerMv: number; baseline: number };

function stroke(ctx: CanvasRenderingContext2D, path: Path2D, dpr: number, glow: string, core: string): void {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = 5.5 * dpr;
  ctx.strokeStyle = glow;
  ctx.stroke(path);
  ctx.lineWidth = 1.6 * dpr;
  ctx.strokeStyle = core;
  ctx.stroke(path);
}
