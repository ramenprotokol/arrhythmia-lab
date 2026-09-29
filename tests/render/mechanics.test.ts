import { describe, it, expect } from "vitest";
import { BEAT, beatDisplacement, followWeight, restPoint, squeezeGate, type BeatFrame } from "../../src/render/mechanics";
import type { Vec3 } from "../../src/render/camera";

// The beat's displacement field, checked on a simple frame: the long axis along -y, apex at the origin, the base 100 mm up.
const frame: BeatFrame = { apex: [0, 0, 0], axis: [0, -1, 0], height: 100 };
const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

describe("the beat", () => {
  it("does not move anything while the muscle is relaxed", () => {
    expect(beatDisplacement(frame, [30, 80, -10], 0)).toEqual([0, 0, 0]);
  });

  it("brings the base down toward the apex and leaves the apex where it is", () => {
    const apex = beatDisplacement(frame, [0, 0, 0], 1);
    const base = beatDisplacement(frame, [0, 100, 0], 1);
    expect(len(apex)).toBeLessThan(1e-9);
    // a point on the axis at the base only shortens: down by the longitudinal share of its height
    expect(base[1]).toBeCloseTo(-BEAT.longitudinal * 100, 6);
    expect(Math.hypot(base[0], base[2])).toBeLessThan(1e-9);
  });

  it("draws the wall in toward the axis and wrings it, the apex one way and the base the other", () => {
    const low = beatDisplacement(frame, [30, 5, 0], 1);
    const high = beatDisplacement(frame, [30, 95, 0], 1);
    // radius shrinks at both ends
    expect(Math.hypot(30 + low[0], low[2])).toBeLessThan(30);
    expect(Math.hypot(30 + high[0], high[2])).toBeLessThan(30);
    // the twist turns the two ends in opposite senses about the axis
    expect(Math.sign(low[2])).toBe(-Math.sign(high[2]));
  });

  it("can be undone: restPoint finds where a moved point was", () => {
    for (const p of [[20, 40, 10], [-25, 90, 15], [5, 10, -30]] as Vec3[]) {
      for (const c of [0.3, 1]) {
        const d = beatDisplacement(frame, p, c);
        const moved: Vec3 = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
        const back = restPoint(frame, moved, c);
        expect(len([back[0] - p[0], back[1] - p[1], back[2] - p[2]])).toBeLessThan(0.05);
      }
    }
  });

  it("drags the rest of the heart fully near the seam and not at all far from it", () => {
    expect(followWeight(0)).toBe(1);
    expect(followWeight(BEAT.holdMm)).toBe(1);
    expect(followWeight(BEAT.freeMm)).toBe(0);
    expect(followWeight(100)).toBe(0);
    expect(followWeight((BEAT.holdMm + BEAT.freeMm) / 2)).toBeCloseTo(0.5, 6);
  });

  it("squeezes the whole heart only when the muscle contracts together", () => {
    // fibrillation: small patches out of step, the mean well below the gate: no squeeze at all
    expect(squeezeGate(0.25)).toBe(0);
    // a racing rhythm: part of the heart at a time, a weak twitch
    expect(squeezeGate(0.5)).toBeGreaterThan(0.1);
    expect(squeezeGate(0.5)).toBeLessThan(0.5);
    // a normal beat: all of it together, the full squeeze
    expect(squeezeGate(0.95)).toBe(1);
    // and the displacement scales with it
    const p: Vec3 = [30, 95, 0];
    const full = beatDisplacement(frame, p, 1, 1);
    const weak = beatDisplacement(frame, p, 1, 0.25);
    expect(len(weak)).toBeCloseTo(len(full) * 0.25, 6);
    expect(beatDisplacement(frame, p, 1, 0)).toEqual([0, 0, 0]);
  });
});
