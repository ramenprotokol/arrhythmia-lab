import { describe, it, expect } from "vitest";
import { EPI, ENDO, MID, restingCell, stepCell, measureApd90 } from "../../src/model/bocf";
import type { Params } from "../../src/model/bocf";

// APD90 at steady state under 1 Hz pacing (single cell, dt 0.05 ms).
function steadyApd90At1Hz(p: Params): number {
  const dt = 0.05, n = 1000 / dt;
  let c = restingCell(), apd = NaN;
  for (let beat = 0; beat < 30; beat++) {
    const trace: number[] = [];
    for (let i = 0; i < n; i++) {
      c = stepCell(c, p, dt, i * dt < 1 ? 1 : 0);
      trace.push(c.u);
    }
    const peak = Math.max(...trace);
    const up = trace.findIndex((u) => u >= 0.5 * peak);
    let down = trace.indexOf(peak);
    while (trace[down] > 0.1 * peak) down++;
    apd = (down - up) * dt;
  }
  return apd;
}

describe("BOCF cell", () => {
  it("stays at rest with no stimulus", () => {
    let c = restingCell();
    for (let i = 0; i < 20000; i++) c = stepCell(c, EPI, 0.05, 0);
    expect(Math.abs(c.u)).toBeLessThan(1e-3);
  });
  it("fires an action potential when stimulated, then recovers", () => {
    let c = restingCell(), peak = 0;
    for (let i = 0; i < 40000; i++) {
      c = stepCell(c, EPI, 0.05, i * 0.05 < 1 ? 1 : 0); // 1 ms stimulus
      peak = Math.max(peak, c.u);
    }
    expect(peak).toBeGreaterThan(1.0);
    expect(Math.abs(c.u)).toBeLessThan(0.02);
  });
  it("gives an action potential duration in the physiological range", () => {
    const apd = measureApd90(EPI);
    expect(apd).toBeGreaterThan(200);
    expect(apd).toBeLessThan(400);
  });
  it("does not fire below threshold", () => {
    let c = restingCell(), peak = 0;
    for (let i = 0; i < 4000; i++) {
      c = stepCell(c, EPI, 0.05, i * 0.05 < 1 ? 0.02 : 0);
      peak = Math.max(peak, c.u);
    }
    expect(peak).toBeLessThan(0.3);
  });

  it.each([
    ["EPI", EPI],
    ["ENDO", ENDO],
    ["MID", MID],
  ] as const)("%s cell fires and recovers", (_name, p) => {
    let c = restingCell(), peak = 0;
    for (let i = 0; i < 60000; i++) {
      c = stepCell(c, p, 0.05, i * 0.05 < 1 ? 1 : 0);
      peak = Math.max(peak, c.u);
    }
    expect(peak).toBeGreaterThan(1.0);
    expect(Math.abs(c.u)).toBeLessThan(0.02);
  });
  // Published tissue values at 1 Hz (Bueno-Orovio et al. 2008, Table 2):
  // EPI 269 ms, ENDO 260 ms, M 410 ms. A single cell is not tissue, so allow 10 ms.
  it.each([
    ["EPI", EPI, 269],
    ["ENDO", ENDO, 260],
    ["MID", MID, 410],
  ] as const)("%s steady-state APD90 at 1 Hz matches the paper", (_name, p, paperMs) => {
    expect(Math.abs(steadyApd90At1Hz(p) - paperMs)).toBeLessThan(10);
  });
});
