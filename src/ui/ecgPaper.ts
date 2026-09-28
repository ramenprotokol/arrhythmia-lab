// The look shared by the monitor and the comparison panel: dark ECG paper with a faint teal grid, a heavier
// line every five small squares, and phosphor traces.

export const INK = {
  paper: "#050a0c",
  gridMinor: "rgba(52, 214, 168, 0.075)",
  gridMajor: "rgba(52, 214, 168, 0.17)",
  rule: "rgba(120, 220, 190, 0.24)",
  /** The simulated trace: a thin bright core over a wide, faint glow. */
  simCore: "#7dffd4",
  simGlow: "rgba(30, 235, 160, 0.20)",
  /** The bright dot at the head of a trace. */
  dot: "#eafff7",
  /** Recorded traces are amber, so they can never be mistaken for the simulation. */
  recCore: "#ffd08a",
  recGlow: "rgba(255, 176, 80, 0.20)",
  label: "rgba(150, 225, 200, 0.8)",
  note: "rgba(150, 195, 185, 0.75)",
} as const;

export const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

export type Area = { x: number; y: number; w: number; h: number };

/** Below this, in CSS pixels, a small square is too small to see as a square, so only the heavy lines are drawn. */
const MIN_FINE_PITCH = 2.5;

/**
 * Draw the grid inside `area`. `pitch` is one small square in device pixels and every fifth line is heavier.
 * `origin` is where a heavy line is anchored. Each line is placed on a whole pixel, so it stays sharp even when
 * the pitch is not a whole number. When the squares would be under 2.5 CSS pixels only the heavy lines are drawn:
 * finer than that the grid is a mesh that hides the trace instead of guiding the eye.
 */
export function drawEcgGrid(ctx: CanvasRenderingContext2D, area: Area, origin: { x: number; y: number }, pitch: number, dpr: number): void {
  const lw = Math.max(1, Math.round(dpr));
  const off = (lw % 2) / 2;
  const minor = new Path2D();
  const major = new Path2D();
  const isMajor = (k: number) => ((k % 5) + 5) % 5 === 0;
  const fine = pitch >= MIN_FINE_PITCH * dpr;

  for (let k = Math.ceil((area.x - origin.x) / pitch); ; k++) {
    const col = Math.round(origin.x + k * pitch);
    if (col >= area.x + area.w) break;
    if (col < area.x || (!fine && !isMajor(k))) continue;
    (isMajor(k) ? major : minor).moveTo(col + off, area.y);
    (isMajor(k) ? major : minor).lineTo(col + off, area.y + area.h);
  }
  for (let k = Math.ceil((area.y - origin.y) / pitch); ; k++) {
    const row = Math.round(origin.y + k * pitch);
    if (row >= area.y + area.h) break;
    if (row < area.y || (!fine && !isMajor(k))) continue;
    (isMajor(k) ? major : minor).moveTo(area.x, row + off);
    (isMajor(k) ? major : minor).lineTo(area.x + area.w, row + off);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();
  ctx.lineWidth = lw;
  ctx.strokeStyle = INK.gridMinor;
  ctx.stroke(minor);
  ctx.strokeStyle = INK.gridMajor;
  ctx.stroke(major);
  ctx.restore();
}
