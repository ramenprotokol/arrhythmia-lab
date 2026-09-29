// The recorded-ECG comparison: two lanes, the live simulation over a real recording, drawn on one shared scale so the
// shapes and the spacing can be compared by eye. It lives inside the ECG dock and never covers the heart. The
// caption, the record line and the credit are plain text in the panel, always shown, with no way to fold them away.
import "./compare.css";
import { CanvasDescription } from "./a11y";
import { FONT, INK } from "./ecgPaper";

/** `caption` is an optional line about the recording: its lead, and anything a viewer could mistake it for. */
export type EcgSample = { id: string; label: string; lead: string; fs: number; mv: number[]; record: string; caption?: string };
export type EcgSamples = { samples: EcgSample[]; source: string; licence: string; url: string };
/** The simulated lead on show: times in ms (any epoch, only differences matter) and values in mV, oldest first. */
export type SimulatedTrace = () => { t: Float32Array; v: Float32Array };

export const COMPARE_CAPTION =
  "Recorded ECGs are shown for visual comparison only. This is an educational simulation, not a medical device and not a diagnostic tool.";
export const COMPARE_CREDIT = "Recorded ECGs: PTB-XL, CC BY 4.0; MIT-BIH Arrhythmia Database and CU Ventricular Tachyarrhythmia Database, ODC-By 1.0.";
export const SCALE_NOTE = "Both traces are drawn on the same scale: five seconds across, and the same millivolts per pixel up.";

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
    const caption = typeof raw.caption === "string" && raw.caption.trim() !== "" ? raw.caption : undefined;
    return { id, label, lead, fs, mv: mv as number[], record, ...(caption ? { caption } : {}) };
  });

  return { samples, source: text(json, "source", ""), licence: text(json, "licence", ""), url: text(json, "url", "") };
}

// ---- the panel ------------------------------------------------------------------------------------------------

/** Both lanes show this many seconds across. */
export const SPAN_S = 5;
/** The height shown never covers less than this many millivolts, so a small trace is not blown up into noise. */
const MIN_SPAN_MV = 2;
/** Room left above and below the tallest swings, as a share of the range. */
const MARGIN = 0.12;
/** The range is only narrowed again once what is needed is less than this share of what is shown, so it does not twitch. */
const SHRINK_BELOW = 0.6;

/** A recording's lead in words: MIT-BIH's "MLII" is a modified lead II, and some recordings do not say. */
export function leadInWords(lead: string): string {
  if (lead === "unspecified") return "lead not stated";
  if (lead === "MLII") return "modified lead II";
  return `lead ${lead}`;
}

/** The part of a label before its colon (the name), and the rest (what it is). */
function splitLabel(label: string): { name: string; desc: string } {
  const colon = label.indexOf(":");
  return colon < 0 ? { name: label, desc: "" } : { name: label.slice(0, colon).trim(), desc: label.slice(colon + 1).trim() };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (content !== undefined) el.textContent = content;
  return el;
}

type Scale = { dpr: number; width: number; height: number; pxPerSec: number; pxPerMv: number; baseline: number; lo: number; hi: number };

export type ComparePanelOptions = {
  /** Words under "Your simulation": which lead is shown, and what the heart is doing. */
  simulatedLabel?: string;
  /** A note about the simulated lane, shown under the lanes (which lead, and why). */
  simulatedNote?: string;
};

export class ComparePanel {
  private readonly root: HTMLElement;
  private readonly simCanvas: HTMLCanvasElement;
  private readonly recCanvas: HTMLCanvasElement;
  private readonly simPlot: HTMLElement;
  private readonly simText: CanvasDescription;
  private readonly recText: CanvasDescription;
  private readonly picker: HTMLSelectElement;
  private readonly simSub: HTMLElement;
  private readonly recSub: HTMLElement;
  private readonly recordLine: HTMLElement;
  private readonly recCaption: HTMLElement;
  private readonly noteLine: HTMLElement;
  private readonly caveatLine: HTMLElement;
  private readonly samples = new Map<string, EcgSample>();
  private readonly observer: ResizeObserver | null;
  private current: string;
  private range: { lo: number; hi: number } | null = null;

  constructor(
    container: HTMLElement,
    data: EcgSamples,
    private readonly simulated: SimulatedTrace,
    opts: ComparePanelOptions = {},
  ) {
    for (const s of data.samples) this.samples.set(s.id, s);
    const first = data.samples[0];
    if (!first) throw new Error("ComparePanel needs at least one recorded sample.");
    this.current = first.id;

    this.root = element("section", "acl-compare");
    this.root.setAttribute("role", "region");
    this.root.setAttribute("aria-label", "Recorded ECG comparison");

    // lane 1: the live simulation
    const simLane = element("div", "acl-compare__lane acl-compare__lane--sim");
    const simMeta = element("div", "acl-compare__meta");
    this.simSub = element("div", "acl-compare__sub", opts.simulatedLabel ?? "Live");
    simMeta.append(element("div", "acl-compare__title", "Your simulation"), this.simSub);
    this.simCanvas = element("canvas", "acl-compare__canvas");
    this.simPlot = element("div", "acl-compare__plot");
    this.simPlot.append(this.simCanvas);
    simLane.append(simMeta, this.simPlot);

    // lane 2: the real recording, and the choice of which one
    const recLane = element("div", "acl-compare__lane acl-compare__lane--rec");
    const recMeta = element("div", "acl-compare__meta");
    const pick = element("label", "acl-compare__pick");
    const pickName = element("span", "acl-compare__sr", "Recorded ECG to compare");
    this.picker = element("select", "acl-compare__select");
    for (const s of data.samples) {
      const option = element("option", "", splitLabel(s.label).name);
      option.value = s.id;
      this.picker.append(option);
    }
    this.picker.addEventListener("change", () => this.select(this.picker.value));
    const chevron = element("span", "acl-compare__chevron");
    chevron.setAttribute("aria-hidden", "true");
    pick.append(pickName, this.picker, chevron);
    this.recSub = element("div", "acl-compare__sub");
    recMeta.append(element("div", "acl-compare__title", "Real recording"), pick, this.recSub);
    this.recCanvas = element("canvas", "acl-compare__canvas");
    const recPlot = element("div", "acl-compare__plot acl-compare__plot--rec");
    recPlot.append(this.recCanvas);
    recLane.append(recMeta, recPlot);

    // Two groups of notes: what the picture is (left on a wide panel), and where the recording comes from (right).
    const notes = element("div", "acl-compare__text");
    const about = element("div", "acl-compare__about");
    const source = element("div", "acl-compare__source");
    this.noteLine = element("p", "acl-compare__note", opts.simulatedNote ?? "");
    this.noteLine.hidden = !opts.simulatedNote;
    this.caveatLine = element("p", "acl-compare__caveat");
    this.caveatLine.hidden = true;
    this.recordLine = element("p", "acl-compare__record");
    this.recCaption = element("p", "acl-compare__rec-caption");
    about.append(element("p", "acl-compare__caption", COMPARE_CAPTION), element("p", "acl-compare__scale", SCALE_NOTE), this.noteLine, this.caveatLine);
    source.append(this.recordLine, this.recCaption, element("p", "acl-compare__credit", COMPARE_CREDIT));
    notes.append(about, source);

    this.root.append(simLane, recLane, notes);
    container.append(this.root);

    this.simText = new CanvasDescription(
      this.simCanvas,
      "Simulated ECG from the live simulation, the most recent five seconds",
      "The most recent five seconds of the simulated ECG, drawn on the same scale as the recorded ECG below it. Simulated. Not a medical device.",
    );
    this.recText = new CanvasDescription(this.recCanvas, "", "");
    this.showChoice(first);

    this.observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.render());
    this.observer?.observe(this.simPlot);
    this.render();
  }

  get selectedId(): string {
    return this.current;
  }

  select(id: string): void {
    const sample = this.samples.get(id);
    if (!sample) throw new Error(`No recorded ECG with the id "${id}". The choices are: ${[...this.samples.keys()].join(", ")}.`);
    this.current = id;
    this.range = null;
    this.showChoice(sample);
    this.render();
  }

  /**
   * Say which lead the simulated lane shows and what the heart is doing, for example "Lead V2, live, racing rhythm", with
   * a note about the lane (which lead, and why) and a caveat: how this model's rhythm differs from real recordings of it.
   */
  setSimulatedLabel(label: string, note = "", caveat = ""): void {
    if (this.simSub.textContent !== label) this.simSub.textContent = label;
    if (this.noteLine.textContent !== note) this.noteLine.textContent = note;
    this.noteLine.hidden = note === "";
    if (this.caveatLine.textContent !== caveat) this.caveatLine.textContent = caveat;
    this.caveatLine.hidden = caveat === "";
  }

  /** Redraw both lanes, asking the simulation for its latest. Call it as often as the simulated trace should refresh. */
  render(): void {
    const cssWidth = this.simPlot.clientWidth;
    const cssHeight = this.simPlot.clientHeight;
    if (cssWidth < 40 || cssHeight < 20) return; // hidden or collapsed: nothing to draw on yet
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(cssWidth * dpr);
    const height = Math.round(cssHeight * dpr);
    for (const canvas of [this.simCanvas, this.recCanvas]) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    }
    const sample = this.samples.get(this.current);
    const trace = this.simulated();
    const scale = this.scaleFor(sample, trace, dpr, width, height);
    this.paint(this.simCanvas, scale, INK.gridMajor, INK.gridMinor, (ctx) => this.simulatedTrace(ctx, scale, trace));
    if (sample) this.paint(this.recCanvas, scale, "rgba(255, 181, 71, 0.16)", "rgba(255, 181, 71, 0.07)", (ctx) => this.recordedTrace(ctx, scale, sample));
  }

  /** Take the panel out of the page again, leaving anything else in the container alone. */
  dispose(): void {
    this.observer?.disconnect();
    this.simText.remove();
    this.recText.remove();
    this.root.remove();
  }

  private showChoice(sample: EcgSample): void {
    if (this.picker.value !== sample.id) this.picker.value = sample.id;
    const { desc } = splitLabel(sample.label);
    this.recSub.textContent = desc;
    const lead = leadInWords(sample.lead);
    this.recordLine.textContent = `Record: ${sample.record}, ${lead}.`;
    this.recCaption.textContent = sample.caption ?? "";
    this.recCaption.hidden = !sample.caption;
    this.recText.set(
      `Recorded ECG, ${lead}: ${sample.label}`,
      `Five seconds of a recorded ECG (${lead}) from a public database (${sample.record}), drawn on the same scale as the ` +
        "simulated ECG above it. Shown for visual comparison only. Not a medical device and not a diagnostic tool.",
    );
  }

  /** One scale for both lanes: five seconds across, and a height that fits the recording and the live trace. */
  private scaleFor(sample: EcgSample | undefined, trace: { t: Float32Array; v: Float32Array }, dpr: number, width: number, height: number): Scale {
    let lo = Infinity;
    let hi = -Infinity;
    if (sample) {
      for (const v of sample.mv) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    const n = Math.min(trace.t.length, trace.v.length);
    if (n > 0) {
      const end = trace.t[n - 1];
      for (let i = 0; i < n; i++) {
        if (end - trace.t[i] > SPAN_S * 1000) continue;
        lo = Math.min(lo, trace.v[i]);
        hi = Math.max(hi, trace.v[i]);
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = -1;
      hi = 1;
    }
    const pad = (hi - lo) * MARGIN;
    let wantLo = Math.min(lo - pad, 0);
    let wantHi = Math.max(hi + pad, 0);
    if (wantHi - wantLo < MIN_SPAN_MV) {
      const grow = (MIN_SPAN_MV - (wantHi - wantLo)) / 2;
      wantLo -= grow;
      wantHi += grow;
    }
    const r = this.range;
    const fits = r !== null && wantLo >= r.lo && wantHi <= r.hi;
    const tooLoose = r !== null && wantHi - wantLo < SHRINK_BELOW * (r.hi - r.lo);
    if (r === null || !fits || tooLoose) this.range = { lo: wantLo, hi: wantHi };
    const { lo: shownLo, hi: shownHi } = this.range as { lo: number; hi: number };
    const pxPerMv = height / (shownHi - shownLo);
    return { dpr, width, height, pxPerSec: width / SPAN_S, pxPerMv, baseline: shownHi * pxPerMv, lo: shownLo, hi: shownHi };
  }

  private paint(canvas: HTMLCanvasElement, g: Scale, major: string, minor: string, trace: (ctx: CanvasRenderingContext2D) => void): void {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    ctx.fillStyle = INK.paper;
    ctx.fillRect(0, 0, g.width, g.height);
    grid(ctx, g, major, minor);
    calibration(ctx, g);
    trace(ctx);
  }

  private recordedTrace(ctx: CanvasRenderingContext2D, g: Scale, sample: EcgSample): void {
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
  private simulatedTrace(ctx: CanvasRenderingContext2D, g: Scale, trace: { t: Float32Array; v: Float32Array }): void {
    const { t, v } = trace;
    const n = Math.min(t.length, v.length);
    if (n === 0) {
      ctx.font = `500 ${12 * g.dpr}px ${FONT}`;
      ctx.fillStyle = INK.note;
      ctx.textAlign = "center";
      ctx.fillText("Waiting for the simulation", g.width / 2, g.height / 2);
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

/** Grid lines every 0.2 s and every 0.5 mV, with finer ones between when they are far enough apart to read. */
function grid(ctx: CanvasRenderingContext2D, g: Scale, major: string, minor: string): void {
  const lw = Math.max(1, Math.round(g.dpr));
  const off = (lw % 2) / 2;
  const majorPath = new Path2D();
  const minorPath = new Path2D();
  const fineX = 0.04 * g.pxPerSec >= 3 * g.dpr;
  const fineY = 0.1 * g.pxPerMv >= 3 * g.dpr;
  for (let k = 0; k * 0.04 <= SPAN_S + 1e-9; k++) {
    const isMajor = k % 5 === 0;
    if (!isMajor && !fineX) continue;
    const x = Math.round(k * 0.04 * g.pxPerSec) + off;
    (isMajor ? majorPath : minorPath).moveTo(x, 0);
    (isMajor ? majorPath : minorPath).lineTo(x, g.height);
  }
  for (let k = Math.ceil(g.lo / 0.1); k * 0.1 <= g.hi + 1e-9; k++) {
    const isMajor = k % 5 === 0;
    if (!isMajor && !fineY) continue;
    const y = Math.round(g.baseline - k * 0.1 * g.pxPerMv) + off;
    (isMajor ? majorPath : minorPath).moveTo(0, y);
    (isMajor ? majorPath : minorPath).lineTo(g.width, y);
  }
  ctx.lineWidth = lw;
  ctx.strokeStyle = minor;
  ctx.stroke(minorPath);
  ctx.strokeStyle = major;
  ctx.stroke(majorPath);
}

/** A 1 mV step at the left edge (half that when 1 mV does not fit), the way an ECG printout marks its scale. */
function calibration(ctx: CanvasRenderingContext2D, g: Scale): void {
  const mv = g.pxPerMv * 1.05 <= g.baseline ? 1 : 0.5;
  const x = 8 * g.dpr;
  const w = 6 * g.dpr;
  ctx.strokeStyle = INK.label;
  ctx.lineWidth = Math.max(1, 1.5 * g.dpr);
  ctx.beginPath();
  ctx.moveTo(x - 4 * g.dpr, g.baseline);
  ctx.lineTo(x, g.baseline);
  ctx.lineTo(x, g.baseline - mv * g.pxPerMv);
  ctx.lineTo(x + w, g.baseline - mv * g.pxPerMv);
  ctx.lineTo(x + w, g.baseline);
  ctx.lineTo(x + w + 4 * g.dpr, g.baseline);
  ctx.stroke();
  ctx.font = `600 ${10 * g.dpr}px ${FONT}`;
  ctx.fillStyle = INK.label;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const labelY = Math.min(g.height - 3 * g.dpr, g.baseline + 12 * g.dpr);
  ctx.fillText(`${mv} mV`, x - 2 * g.dpr, labelY);
}

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
