// Where everything goes on the monitor canvas. Pure numbers, all in device pixels, so it can be tested
// without a browser. The canvas is one sheet of ECG paper divided into boxes, one lead per box.

/** In the order the ECG computation returns them. */
export const LEAD_NAMES = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"] as const;

export type MonitorMode = "twelve" | "single";

/**
 * The starting gain, as on an ECG printout, in mm of paper per millivolt. The single big lead uses the standard 10. The
 * twelve small rows use the half-standard 5, which printouts use for large voltages: a racing or fibrillating rhythm
 * swings the chest leads by 2 mV or more, and at 10 that would be cut flat at the edge of a 47 px row. The monitor can
 * step a lead group lower (GAIN_STEPS), and always marks the gain it draws at.
 */
export const GAIN_MM_PER_MV: Record<MonitorMode, number> = { twelve: 5, single: 10 };

/**
 * The limb leads (I to aVF) and the chest leads (V1 to V6) can run at different gains, as ECG machines allow (their
 * "10/5" setting halves the chest leads): the chest leads sit much closer to the heart and swing far more.
 */
export type LeadGroup = "limb" | "chest";
export const groupOf = (lead: number): LeadGroup => (lead < 6 ? "limb" : "chest");

/** The gains a group may be stepped down to when its swings would be cut flat at the edge of its boxes, largest first. */
export const GAIN_STEPS: Record<MonitorMode, readonly number[]> = { twelve: [5, 2.5], single: [10, 5, 2.5] };

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
  /** This box's gain in mm of paper per millivolt: its lead group's. */
  gainMmPerMv: number;
  pxPerMv: number;
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
  /** The gain in mm of paper per millivolt: the single box's, or the limb leads' in the twelve-lead layout (5 or 10 unless changed). */
  gainMmPerMv: number;
  pxPerMv: number;
  /** Each lead group's gain, in mm per mV. */
  groupGains: Record<LeadGroup, number>;
  /** Simulated milliseconds per pixel, the same in every box. */
  msPerPx: number;
};

/**
 * `stripLead` is the lead the rhythm strip and the single big trace show (an index into LEAD_NAMES). Lead II is the
 * standard choice and the default; the page switches it when lead II has no clear signal (see src/ecg/autoLead.ts).
 * `gains` sets a lead group's gain in mm per mV; a group left out gets the mode's standard gain.
 */
export function computeLayout(o: {
  mode: MonitorMode;
  width: number;
  height: number;
  dpr: number;
  windowMs: number;
  stripLead?: number;
  gains?: Partial<Record<LeadGroup, number>>;
}): MonitorLayout | null {
  const { mode, dpr, windowMs } = o;
  const strip = o.stripLead ?? LEAD_II;
  if (!Number.isInteger(strip) || strip < 0 || strip >= LEAD_NAMES.length) throw new RangeError(`stripLead must be a whole number from 0 to ${LEAD_NAMES.length - 1}, got ${strip}`);
  const groupGains: Record<LeadGroup, number> = { limb: o.gains?.limb ?? GAIN_MM_PER_MV[mode], chest: o.gains?.chest ?? GAIN_MM_PER_MV[mode] };
  for (const [group, gain] of Object.entries(groupGains)) {
    if (!Number.isFinite(gain) || gain <= 0) throw new RangeError(`the ${group} leads' gain must be more than 0 mm/mV, got ${gain}`);
  }
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
  // A row holds 26 mm of paper in the twelve-lead layout; the one big lead gets 22, so a short dock still draws it at 3 px per mm.
  const pxPerMm = Math.max(2, Math.min(Math.round(5 * dpr), Math.floor(rowH / (mode === "single" ? 22 : 26))));

  const box = (kind: Box["kind"], id: string, lead: number, row: number, col: number, x: number, w: number, spanMs: number): Box => {
    const y = margin + row * rowH;
    // Lead II is mostly upright; any other lead on the single strip (a chest lead, in a racing or fibrillating rhythm)
    // swings as far down as up.
    const baseline = y + Math.floor(rowH * (kind === "single" && lead === LEAD_II ? SINGLE_BASELINE : 0.5));
    const gainMmPerMv = groupGains[groupOf(lead)];
    return { id, label: LEAD_NAMES[lead], lead, kind, row, col, x, y, w, h: rowH, spanMs, baseline, calibration: col === 0, gainMmPerMv, pxPerMv: gainMmPerMv * pxPerMm };
  };

  const boxes: Box[] = [];
  if (mode === "twelve") {
    CLINICAL.forEach((leads, row) =>
      leads.forEach((lead, col) => boxes.push(box("cell", LEAD_NAMES[lead], lead, row, col, x0 + col * cellW, cellW, windowMs / COLUMNS))),
    );
    boxes.push(box("strip", "rhythm", strip, 3, 0, x0, plotW, windowMs));
  } else {
    boxes.push(box("single", LEAD_NAMES[strip], strip, 0, 0, x0, plotW, windowMs));
  }

  const gainMmPerMv = mode === "single" ? boxes[0].gainMmPerMv : groupGains.limb;
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
    gainMmPerMv,
    pxPerMv: gainMmPerMv * pxPerMm,
    groupGains,
    msPerPx: windowMs / plotW,
  };
}
