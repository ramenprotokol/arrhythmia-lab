import { describe, expect, it } from "vitest";
import { LEAD_NAMES, leadsFromElectrodes } from "../../src/ecg/leads";
import { ELECTRODE_NAMES, type ElectrodeName } from "../../src/ecg/electrodes";

function electrodes(values: Partial<Record<ElectrodeName, number>>): Record<ElectrodeName, number> {
  const e = {} as Record<ElectrodeName, number>;
  for (const n of ELECTRODE_NAMES) e[n] = values[n] ?? 0;
  return e;
}

const lead = (l: Float32Array, name: (typeof LEAD_NAMES)[number]): number => l[LEAD_NAMES.indexOf(name)];

describe("leadsFromElectrodes", () => {
  it("returns twelve leads in the standard order", () => {
    expect(LEAD_NAMES).toEqual(["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]);
    const l = leadsFromElectrodes(electrodes({}));
    expect(l).toBeInstanceOf(Float32Array);
    expect(l.length).toBe(12);
  });

  it("builds every lead from its definition (small whole numbers, so the arithmetic is exact)", () => {
    const l = leadsFromElectrodes(electrodes({ RA: 1, LA: 4, LL: 10, V1: 8, V2: 9, V3: 11, V4: 13, V5: 2, V6: -1 }));
    // Wilson central terminal = (1 + 4 + 10) / 3 = 5
    expect(lead(l, "I")).toBe(3); //   LA - RA
    expect(lead(l, "II")).toBe(9); //  LL - RA
    expect(lead(l, "III")).toBe(6); // LL - LA
    expect(lead(l, "aVR")).toBe(-6); //  RA - (LA + LL) / 2 = 1 - 7
    expect(lead(l, "aVL")).toBe(-1.5); // LA - (RA + LL) / 2 = 4 - 5.5
    expect(lead(l, "aVF")).toBe(7.5); //  LL - (RA + LA) / 2 = 10 - 2.5
    expect(lead(l, "V1")).toBe(3); //   8 - 5
    expect(lead(l, "V2")).toBe(4);
    expect(lead(l, "V3")).toBe(6);
    expect(lead(l, "V4")).toBe(8);
    expect(lead(l, "V5")).toBe(-3);
    expect(lead(l, "V6")).toBe(-6);
  });

  it("obeys Einthoven's law exactly: I + III = II", () => {
    for (const [ra, la, ll] of [[1, 4, 10], [-3, 7, 2], [0.5, -0.25, 8], [100, 100, 100]]) {
      const l = leadsFromElectrodes(electrodes({ RA: ra, LA: la, LL: ll }));
      expect(lead(l, "I") + lead(l, "III")).toBe(lead(l, "II"));
    }
  });

  it("obeys Goldberger's identity exactly: aVR + aVL + aVF = 0", () => {
    for (const [ra, la, ll] of [[1, 4, 10], [-3, 7, 2], [0.5, -0.25, 8], [100, 100, 100]]) {
      const l = leadsFromElectrodes(electrodes({ RA: ra, LA: la, LL: ll }));
      expect(lead(l, "aVR") + lead(l, "aVL") + lead(l, "aVF")).toBe(0);
    }
  });

  it("keeps both identities within float32 rounding on arbitrary numbers", () => {
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    for (let k = 0; k < 200; k++) {
      const e = electrodes({ RA: rnd() * 5, LA: rnd() * 5, LL: rnd() * 5, V1: rnd() * 5 });
      const l = leadsFromElectrodes(e);
      const scale = Math.abs(e.RA) + Math.abs(e.LA) + Math.abs(e.LL);
      expect(Math.abs(lead(l, "I") + lead(l, "III") - lead(l, "II"))).toBeLessThan(1e-6 * scale);
      expect(Math.abs(lead(l, "aVR") + lead(l, "aVL") + lead(l, "aVF"))).toBeLessThan(1e-6 * scale);
    }
  });

  it("is zero everywhere when every electrode sees the same potential", () => {
    const l = leadsFromElectrodes(electrodes(Object.fromEntries(ELECTRODE_NAMES.map((n) => [n, 7]))));
    for (const x of l) expect(x).toBe(0);
  });

  it("ignores a potential common to all electrodes and scales linearly", () => {
    const base = electrodes({ RA: 1, LA: 4, LL: 10, V1: 8, V2: 9, V3: 11, V4: 13, V5: 2, V6: -1 });
    const shifted = electrodes(Object.fromEntries(ELECTRODE_NAMES.map((n) => [n, base[n] + 3])));
    const doubled = electrodes(Object.fromEntries(ELECTRODE_NAMES.map((n) => [n, 2 * base[n]])));
    const a = leadsFromElectrodes(base);
    const b = leadsFromElectrodes(shifted);
    const c = leadsFromElectrodes(doubled);
    for (let i = 0; i < 12; i++) {
      expect(b[i]).toBeCloseTo(a[i], 5);
      expect(c[i]).toBe(2 * a[i]);
    }
  });
});
