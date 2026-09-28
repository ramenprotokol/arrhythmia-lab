import { describe, it, expect } from "vitest";
import { SampleRing } from "../../src/ui/sampleRing";

// Two channels; channel 0 holds the time * 10 and channel 1 holds -time, so a read-back is easy to check.
function filled(capacity: number, times: number[], minDt = 0.5): SampleRing {
  const r = new SampleRing(2, capacity, minDt);
  for (const t of times) r.push(t, [t * 10, -t]);
  return r;
}
const times = (r: SampleRing) => Array.from({ length: r.length }, (_, i) => r.timeAt(i));

describe("SampleRing", () => {
  it("starts empty", () => {
    const r = new SampleRing(2, 8);
    expect(r.length).toBe(0);
    expect(r.lastTime).toBe(-Infinity);
    expect(r.lowerBound(0)).toBe(0);
    expect(r.upperBound(0)).toBe(0);
  });

  it("keeps samples in time order and reads every channel back", () => {
    const r = filled(8, [0, 4, 8, 12]);
    expect(times(r)).toEqual([0, 4, 8, 12]);
    expect(r.valueAt(0, 2)).toBe(80);
    expect(r.valueAt(1, 3)).toBe(-12);
    expect(r.lastTime).toBe(12);
  });

  it("drops the oldest samples once it is full", () => {
    const r = filled(4, [0, 4, 8, 12, 16, 20]);
    expect(r.length).toBe(4);
    expect(times(r)).toEqual([8, 12, 16, 20]);
    expect(r.valueAt(0, 0)).toBe(80);
    expect(r.valueAt(1, 3)).toBe(-20);
  });

  it("finds positions by time with lowerBound and upperBound, also after wrapping", () => {
    const r = filled(4, [0, 4, 8, 12, 16, 20]); // holds 8, 12, 16, 20
    expect(r.lowerBound(12)).toBe(1);
    expect(r.upperBound(12)).toBe(2);
    expect(r.lowerBound(13)).toBe(2);
    expect(r.upperBound(13)).toBe(2);
    expect(r.lowerBound(-100)).toBe(0);
    expect(r.upperBound(-100)).toBe(0);
    expect(r.lowerBound(20)).toBe(3);
    expect(r.upperBound(20)).toBe(4);
    expect(r.lowerBound(1e9)).toBe(4);
  });

  it("merges samples that arrive within minDt of the one that opened the bucket, keeping the newest values", () => {
    // dyadic times, so the arithmetic is exact
    const r = new SampleRing(2, 8, 0.5);
    r.push(10, [1, 1]);
    r.push(10.25, [2, 2]);
    r.push(10.375, [3, 3]);
    expect(r.length).toBe(1);
    expect(r.timeAt(0)).toBe(10.375);
    expect(r.valueAt(0, 0)).toBe(3);
    r.push(10.5, [4, 4]); // exactly minDt after the bucket opened: a new sample
    expect(r.length).toBe(2);
    expect(r.timeAt(1)).toBe(10.5);
  });

  it("still stores samples at the maximum rate when pushes come much faster than that", () => {
    // 800 pushes 0.125 ms apart cover 100 ms: with minDt 0.5 that is 200 samples, not one
    const r = new SampleRing(1, 1000, 0.5);
    for (let i = 0; i < 800; i++) r.push(i * 0.125, [i]);
    expect(r.length).toBe(200);
    expect(r.timeAt(1) - r.timeAt(0)).toBeGreaterThanOrEqual(0.5);
  });

  it("keeps every sample when minDt is zero", () => {
    const r = new SampleRing(1, 8, 0);
    r.push(1, [1]);
    r.push(1, [2]);
    expect(r.length).toBe(2);
  });

  it("refuses samples that go back in time", () => {
    const r = filled(8, [0, 4, 8]);
    expect(() => r.push(7, [0, 0])).toThrow(/backwards/i);
    expect(r.length).toBe(3);
  });

  it("refuses a sample with too few values", () => {
    const r = new SampleRing(2, 8);
    expect(() => r.push(0, [1])).toThrow(/2 values/);
  });

  it("clear empties it and accepts earlier times afterwards", () => {
    const r = filled(8, [100, 104]);
    r.clear();
    expect(r.length).toBe(0);
    expect(r.lastTime).toBe(-Infinity);
    r.push(0, [0, 0]);
    expect(times(r)).toEqual([0]);
  });

  it("grows without losing samples, and shrinks keeping the newest", () => {
    const r = filled(4, [0, 4, 8, 12, 16, 20]); // holds 8..20
    r.resize(8);
    expect(r.capacity).toBe(8);
    expect(times(r)).toEqual([8, 12, 16, 20]);
    r.push(24, [240, -24]);
    r.resize(2);
    expect(times(r)).toEqual([20, 24]);
    expect(r.valueAt(0, 0)).toBe(200);
    expect(r.valueAt(1, 1)).toBe(-24);
  });

  it("returns a window of one channel as typed arrays, oldest first", () => {
    const r = filled(8, [0, 4, 8, 12, 16]);
    const w = r.window(1, 8);
    expect(w.t).toBeInstanceOf(Float32Array);
    expect(w.v).toBeInstanceOf(Float32Array);
    expect(Array.from(w.t)).toEqual([8, 12, 16]);
    expect(Array.from(w.v)).toEqual([-8, -12, -16]);
    expect(r.window(0, 1000).t.length).toBe(0);
  });

  it("copes with a long run of pushes, the way a running monitor does", () => {
    const r = new SampleRing(1, 1500, 0.5);
    for (let i = 0; i < 100_000; i++) r.push(i * 4, [i]);
    expect(r.length).toBe(1500);
    expect(r.timeAt(0)).toBe((100_000 - 1500) * 4);
    expect(r.valueAt(0, 1499)).toBe(99_999);
    expect(r.lowerBound((100_000 - 100) * 4)).toBe(1400);
  });
});
