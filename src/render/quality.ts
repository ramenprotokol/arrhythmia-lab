export type QualityName = "high" | "medium" | "low";

export interface QualitySettings {
  /** Most sphere-tracing steps from the cut plane to the wall of a cavity. */
  steps: number;
  /** Taps into the wall under each point of the surface for the glow of deeper fronts (0 to 2). */
  taps: number;
  /** Fine surface detail (fat lobules, wet ripple, fibre grain): 0 plain to 1 full. */
  detail: number;
  /** Samples per pixel for the heart's edges (1 or 4). */
  msaa: 1 | 4;
  /** Levels in the bloom chain. */
  bloomLevels: number;
  /** Fraction of the device resolution to render at. */
  renderScale: number;
  /** Highest device pixel ratio honoured. */
  maxDpr: number;
  /** Cap on the backing store, in pixels. */
  maxPixels: number;
}

// high: the smooth (cubic) voltage samples, two taps into the wall, all the fine surface detail; its backing store is
// capped near 2.6 million pixels (a Retina canvas is drawn smaller and sharpened; the page's text stays crisp).
// medium: plain trilinear samples, one tap, less detail, a shorter bloom, at 0.85 of the resolution (sharpened): at
// least 30% cheaper than high at the same size. low: no taps, plainer still, at three-quarter resolution.
export const QUALITY: Record<QualityName, QualitySettings> = {
  high: { steps: 128, taps: 2, detail: 1, msaa: 4, bloomLevels: 6, renderScale: 1, maxDpr: 2, maxPixels: 2_600_000 },
  medium: { steps: 64, taps: 1, detail: 0.35, msaa: 4, bloomLevels: 3, renderScale: 0.85, maxDpr: 1.5, maxPixels: 2_000_000 },
  low: { steps: 32, taps: 0, detail: 0.2, msaa: 4, bloomLevels: 2, renderScale: 0.75, maxDpr: 1, maxPixels: 1_200_000 },
};

/** Size of the canvas backing store for a CSS size and device pixel ratio, within the tier's limits. */
export function backingSize(cssWidth: number, cssHeight: number, dpr: number, q: QualitySettings): { width: number; height: number; scale: number } {
  let scale = Math.min(Math.max(dpr, 0.25), q.maxDpr) * q.renderScale;
  const wanted = cssWidth * cssHeight * scale * scale;
  const capped = wanted > q.maxPixels;
  if (capped) scale *= Math.sqrt(q.maxPixels / wanted);
  // rounding to whole pixels must not take a capped size over the cap
  const whole = capped ? Math.floor : Math.round;
  return {
    width: Math.max(1, whole(cssWidth * scale)),
    height: Math.max(1, whole(cssHeight * scale)),
    scale,
  };
}
