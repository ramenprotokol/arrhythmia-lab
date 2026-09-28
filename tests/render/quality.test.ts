import { describe, it, expect } from "vitest";
import { QUALITY, backingSize } from "../../src/render/quality";

describe("quality tiers", () => {
  it("orders the tiers by cost", () => {
    expect(QUALITY.high.steps).toBe(128);
    expect(QUALITY.medium.steps).toBe(64);
    expect(QUALITY.low.steps).toBe(32);
    expect(QUALITY.high.bloomLevels).toBeGreaterThan(QUALITY.medium.bloomLevels);
    expect(QUALITY.medium.bloomLevels).toBeGreaterThan(QUALITY.low.bloomLevels);
    expect(QUALITY.high.maxPixels).toBeGreaterThan(QUALITY.medium.maxPixels);
    expect(QUALITY.low.renderScale).toBe(0.75);
    expect(QUALITY.high.maxDpr).toBe(2);
  });
});

describe("backingSize", () => {
  it("uses the device pixel ratio on high, up to 2", () => {
    expect(backingSize(800, 500, 1, QUALITY.high)).toMatchObject({ width: 800, height: 500 });
    expect(backingSize(800, 500, 2, QUALITY.high)).toMatchObject({ width: 1600, height: 1000 });
    // a ratio of 3 is capped at 2
    expect(backingSize(390, 844, 3, QUALITY.high)).toMatchObject({ width: 780, height: 1688 });
  });

  it("caps the backing store at the pixel budget and keeps the aspect ratio", () => {
    const s = backingSize(1440, 900, 2, QUALITY.high); // 2880 x 1800 = 5.2 MP wanted
    expect(s.width * s.height).toBeLessThanOrEqual(QUALITY.high.maxPixels);
    expect(s.width * s.height).toBeGreaterThan(QUALITY.high.maxPixels * 0.95);
    expect(s.width / s.height).toBeCloseTo(1440 / 900, 2);
  });

  it("renders the low tier at 0.75 scale", () => {
    const s = backingSize(1000, 600, 1, QUALITY.low);
    expect(s).toMatchObject({ width: 750, height: 450 });
  });

  it("never returns a zero size", () => {
    expect(backingSize(0, 0, 1, QUALITY.low)).toMatchObject({ width: 1, height: 1 });
    expect(backingSize(3, 2, 0.1, QUALITY.medium).width).toBeGreaterThanOrEqual(1);
  });
});
