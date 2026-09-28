// Where everything goes on the monitor canvas. Pure numbers, all in device pixels, so it can be tested
// without a browser. The canvas is one sheet of ECG paper divided into boxes, one lead per box.

/** In the order the ECG computation returns them. */
export const LEAD_NAMES = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"] as const;

export type MonitorMode = "twelve" | "single";

/** Fixed gain, as on an ECG printout: 10 mm of paper per millivolt. */
export const GAIN_MM_PER_MV = 10;

const COLUMNS = 4;
/** The standard clinical arrangement, by lead index: I aVR V1 V4 / II aVL V2 V5 / III aVF V3 V6. */
const CLINICAL = [
  [0, 3, 6, 9],
  [1, 4, 7, 10],
  [2, 5, 8, 11],
] as const;
const LEAD_II = 1;
/** Where the zero line sits in the single-lead box, as a share of its height from the top. */
const SINGLE_BASELINE = 0.58;

export type Box = {
  id: string;
  label: string;
  /** Index into the 12 lead values. */
  lead: number;
  kind: "cell" | "strip" | "single";
  row: number;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** How much time the box's full width shows. */
  spanMs: number;
  /** Row of pixels where 0 mV is drawn: the middle of the box, or lower in the single-lead box, where lead II is mostly upright. */
  baseline: number;
  /** True when the 1 mV calibration pulse is drawn in the gutter to the left of this box. */
  calibration: boolean;
};

export type MonitorLayout = {
  mode: MonitorMode;
  width: number;
  height: number;
  dpr: number;
  windowMs: number;
  boxes: Box[];
  gutter: { x: number; w: number };
  /** The strip under the boxes that holds the "Simulated" notice. */
  footer: { x: number; y: number; w: number; h: number };
  pxPerMm: number;
  pxPerMv: number;
  /** Simulated milliseconds per pixel, the same in every box. */
  msPerPx: number;
};

export function computeLayout(o: { mode: MonitorMode; width: number; height: number; dpr: number; windowMs: number }): MonitorLayout | null {
  const { mode, dpr, windowMs } = o;
  const width = Math.round(o.width * dpr);
  const height = Math.round(o.height * dpr);
  const margin = Math.round(4 * dpr);
  const gutterW = Math.round(34 * dpr);
  const footerH = Math.round(18 * dpr);
  const rows = mode === "twelve" ? 4 : 1;
  const cols = mode === "twelve" ? COLUMNS : 1;

  const x0 = margin + gutterW;
  const cellW = Math.floor((width - x0 - margin) / cols);
  const rowH = Math.floor((height - 2 * margin - footerH) / rows);
  if (!(cellW >= 20 * dpr) || !(rowH >= 24 * dpr)) return null;

  const plotW = cellW * cols;
  const pxPerMm = Math.max(2, Math.min(Math.round(5 * dpr), Math.floor(rowH / 26)));

  const box = (kind: Box["kind"], id: string, lead: number, row: number, col: number, x: number, w: number, spanMs: number): Box => {
    const y = margin + row * rowH;
    const baseline = y + Math.floor(rowH * (kind === "single" ? SINGLE_BASELINE : 0.5));
    return { id, label: LEAD_NAMES[lead], lead, kind, row, col, x, y, w, h: rowH, spanMs, baseline, calibration: col === 0 };
  };

  const boxes: Box[] = [];
  if (mode === "twelve") {
    CLINICAL.forEach((leads, row) =>
      leads.forEach((lead, col) => boxes.push(box("cell", LEAD_NAMES[lead], lead, row, col, x0 + col * cellW, cellW, windowMs / COLUMNS))),
    );
    boxes.push(box("strip", "rhythm", LEAD_II, 3, 0, x0, plotW, windowMs));
  } else {
    boxes.push(box("single", LEAD_NAMES[LEAD_II], LEAD_II, 0, 0, x0, plotW, windowMs));
  }

  return {
    mode,
    width,
    height,
    dpr,
    windowMs,
    boxes,
    gutter: { x: margin, w: gutterW },
    footer: { x: x0, y: margin + rows * rowH, w: plotW, h: footerH },
    pxPerMm,
    pxPerMv: GAIN_MM_PER_MV * pxPerMm,
    msPerPx: windowMs / plotW,
  };
}
