// The part of the monitor that never changes while it runs: paper, grid, lead names, calibration pulses
// and the notice. It is painted once onto its own canvas, and the monitor copies pieces of it back
// wherever it needs to erase old trace.
import { FONT, INK, drawEcgGrid } from "./ecgPaper";
import type { Box, MonitorLayout } from "./monitorLayout";

export const NOTICE = "Simulated. Not a medical device.";

export function paintPaper(ctx: CanvasRenderingContext2D, layout: MonitorLayout): void {
  const { width, height, dpr, pxPerMm, boxes, footer, gutter } = layout;
  ctx.fillStyle = INK.paper;
  ctx.fillRect(0, 0, width, height);

  // One band of grid per row, with the zero line on a heavy grid line so the calibration pulse lines up.
  const left = Math.min(...boxes.map((b) => b.x));
  const rows = new Map<number, Box>();
  for (const b of boxes) if (!rows.has(b.row)) rows.set(b.row, b);
  for (const b of rows.values()) drawEcgGrid(ctx, { x: 0, y: b.y, w: width, h: b.h }, { x: left, y: b.baseline }, pxPerMm, dpr);

  paintRules(ctx, layout);
  for (const b of boxes) paintLabel(ctx, b, dpr);
  for (const b of boxes) if (b.calibration) paintCalibration(ctx, b, gutter, pxPerMm, b.pxPerMv, dpr);
  paintFooter(ctx, footer, layout);
}

/** Thin lines between rows, and between the columns of the twelve-lead layout. */
function paintRules(ctx: CanvasRenderingContext2D, layout: MonitorLayout): void {
  const { boxes, dpr } = layout;
  const lw = Math.max(1, Math.round(dpr));
  ctx.strokeStyle = INK.rule;
  ctx.lineWidth = lw;
  ctx.beginPath();
  for (const b of boxes) {
    if (b.row > 0) {
      ctx.moveTo(b.x, b.y + lw / 2);
      ctx.lineTo(b.x + b.w, b.y + lw / 2);
    }
    if (b.kind === "cell" && b.col > 0) {
      ctx.moveTo(b.x + lw / 2, b.y);
      ctx.lineTo(b.x + lw / 2, b.y + b.h);
    }
  }
  ctx.stroke();
}

function paintLabel(ctx: CanvasRenderingContext2D, b: Box, dpr: number): void {
  const x = b.x + 8 * dpr;
  const y = b.y + 16 * dpr;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.font = `700 ${12 * dpr}px ${FONT}`;
  ctx.fillStyle = INK.label;
  const name = b.kind === "single" ? `Lead ${b.label}` : b.label;
  ctx.fillText(name, x, y);
  if (b.kind === "strip") {
    const w = ctx.measureText(name).width;
    ctx.font = `500 ${10 * dpr}px ${FONT}`;
    ctx.fillStyle = INK.note;
    ctx.fillText("rhythm strip", x + w + 6 * dpr, y);
  }
}

/** A 1 mV square pulse in the gutter, the way an ECG printout marks its gain. */
function paintCalibration(ctx: CanvasRenderingContext2D, b: Box, gutter: { x: number; w: number }, pxPerMm: number, pxPerMv: number, dpr: number): void {
  const x = gutter.x + 3 * dpr;
  const lead = 3 * dpr;
  const width = Math.min(4 * pxPerMm, gutter.w - lead - 6 * dpr);
  const y = b.baseline;
  ctx.strokeStyle = INK.simCore;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1.5 * dpr;
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(gutter.x, y);
  ctx.lineTo(x + lead, y);
  ctx.lineTo(x + lead, y - pxPerMv);
  ctx.lineTo(x + lead + width, y - pxPerMv);
  ctx.lineTo(x + lead + width, y);
  ctx.lineTo(gutter.x + gutter.w - 2 * dpr, y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.font = `600 ${9 * dpr}px ${FONT}`;
  ctx.fillStyle = INK.label;
  ctx.textAlign = "left";
  ctx.fillText("1 mV", gutter.x + 2 * dpr, y + 12 * dpr);
}

/**
 * The gain and the window along the bottom, with the notice on the right. When the limb and chest leads run at
 * different gains both are named; on a narrow canvas the words shorten rather than run into the notice.
 */
function paintFooter(ctx: CanvasRenderingContext2D, footer: { x: number; y: number; w: number; h: number }, layout: MonitorLayout): void {
  const { dpr, windowMs, groupGains } = layout;
  const y = footer.y + footer.h / 2 + 3.5 * dpr;
  ctx.font = `500 ${10.5 * dpr}px ${FONT}`;
  ctx.fillStyle = INK.note;
  const split = layout.mode === "twelve" && groupGains.limb !== groupGains.chest;
  const span = `${windowMs / 1000} s window`;
  const choices = split
    ? [`Limb leads ${groupGains.limb} mm/mV  ·  chest leads ${groupGains.chest} mm/mV  ·  ${span}`, `Limb ${groupGains.limb}, chest ${groupGains.chest} mm/mV`, `${groupGains.limb}/${groupGains.chest} mm/mV`]
    : [`${layout.gainMmPerMv} mm/mV  ·  ${span}`, `${layout.gainMmPerMv} mm/mV`];
  const room = footer.w - ctx.measureText(NOTICE).width - 12 * dpr;
  const text = choices.find((c) => ctx.measureText(c).width <= room) ?? choices[choices.length - 1];
  ctx.textAlign = "left";
  ctx.fillText(text, footer.x, y);
  ctx.textAlign = "right";
  ctx.fillText(NOTICE, footer.x + footer.w, y);
  ctx.textAlign = "left";
}
