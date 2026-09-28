export type QualityName = "high" | "medium" | "low";

export interface QualitySettings {
  /** Most ray steps per march (the marcher makes up to two marches per pixel). */
  steps: number;
  /** Step length inside tissue, mm. */
  fineStepMm: number;
  /** How far behind the shell the glow is marched, mm. */
  thicknessMm: number;
  /** Levels in the bloom chain. */
  bloomLevels: number;
  /** Fraction of the device resolution to render at. */
  renderScale: number;
  /** Highest device pixel ratio honoured. */
  maxDpr: number;
  /** Cap on the backing store, in pixels. */
  maxPixels: number;
}

export const QUALITY: Record<QualityName, QualitySettings> = {
  high: { steps: 128, fineStepMm: 0.6, thicknessMm: 34, bloomLevels: 6, renderScale: 1, maxDpr: 2, maxPixels: 4_000_000 },
  medium: { steps: 64, fineStepMm: 1.0, thicknessMm: 28, bloomLevels: 5, renderScale: 1, maxDpr: 1.5, maxPixels: 2_400_000 },
  low: { steps: 32, fineStepMm: 1.6, thicknessMm: 22, bloomLevels: 3, renderScale: 0.75, maxDpr: 1, maxPixels: 1_200_000 },
};

/** Size of the canvas backing store for a CSS size and device pixel ratio, within the tier's limits. */
export function backingSize(cssWidth: number, cssHeight: number, dpr: number, q: QualitySettings): { width: number; height: number; scale: number } {
  let scale = Math.min(Math.max(dpr, 0.25), q.maxDpr) * q.renderScale;
  const wanted = cssWidth * cssHeight * scale * scale;
  if (wanted > q.maxPixels) scale *= Math.sqrt(q.maxPixels / wanted);
  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
    scale,
  };
}
