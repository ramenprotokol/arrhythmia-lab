import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const file = resolve(__dirname, "../../public/data/ecg-samples.json");

interface Sample {
  id: string;
  label: string;
  lead: string;
  fs: number;
  mv: number[];
  record: string;
  caption?: string;
}
interface EcgFile {
  samples: Sample[];
  source: string;
  licence: string;
  url: string;
}

const data = JSON.parse(readFileSync(file, "utf8")) as EcgFile;

describe("ecg-samples.json", () => {
  it("has the top-level fields", () => {
    expect(typeof data.source).toBe("string");
    expect(typeof data.licence).toBe("string");
    expect(typeof data.url).toBe("string");
    expect(data.url).toMatch(/^https:\/\/physionet\.org\//);
    expect(Array.isArray(data.samples)).toBe(true);
  });

  it("licence names CC BY 4.0 or ODC-By", () => {
    expect(data.licence).toMatch(/CC BY 4\.0|ODC-By/);
  });

  it("has at least 3 samples with unique ids", () => {
    expect(data.samples.length).toBeGreaterThanOrEqual(3);
    expect(new Set(data.samples.map((s) => s.id)).size).toBe(data.samples.length);
  });

  it("every sample has the exact shape, a record id and finite numbers", () => {
    for (const s of data.samples) {
      expect(Object.keys(s).sort()).toEqual(["caption", "fs", "id", "label", "lead", "mv", "record"]);
      expect(s.id.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.record.length).toBeGreaterThan(0);
      // The lead each recording really has: lead II, MIT-BIH's modified lead II (chest electrodes), or not stated.
      expect(["II", "MLII", "unspecified"]).toContain(s.lead);
      expect(Number.isFinite(s.fs)).toBe(true);
      expect(s.mv.length).toBeGreaterThan(0);
      expect(s.mv.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  it("every sample has a caption of at most 140 characters that names its lead", () => {
    for (const s of data.samples) {
      expect(s.caption!.length).toBeGreaterThan(0);
      expect(s.caption!.length).toBeLessThanOrEqual(140);
      if (s.lead === "MLII") expect(s.caption).toMatch(/modified lead II/i);
      if (s.lead === "unspecified") expect(s.caption).toMatch(/does not say which/i);
    }
  });

  it("every trace fits the Compare panel, which draws -1.5 mV to +3.5 mV", () => {
    for (const s of data.samples) {
      expect(Math.min(...s.mv)).toBeGreaterThanOrEqual(-1.5);
      expect(Math.max(...s.mv)).toBeLessThanOrEqual(3.5);
    }
  });

  it("has a real ventricular fibrillation, and tells atrial fibrillation apart from it", () => {
    const vf = data.samples.find((s) => s.id === "vfib");
    expect(vf?.label).toMatch(/^Ventricular fibrillation:/);
    const af = data.samples.find((s) => s.id === "afib");
    if (af) expect(af.caption).toMatch(/different from VF/);
  });

  it("is at most 250 Hz and at most 5 seconds per sample", () => {
    for (const s of data.samples) {
      expect(s.fs).toBeGreaterThan(0);
      expect(s.fs).toBeLessThanOrEqual(250);
      expect(s.mv.length / s.fs).toBeLessThanOrEqual(5 + 1e-9);
    }
  });

  it("traces are not flat", () => {
    for (const s of data.samples) {
      const range = Math.max(...s.mv) - Math.min(...s.mv);
      expect(range).toBeGreaterThan(0.2);
    }
  });

  it("file is under 200 KB", () => {
    expect(statSync(file).size).toBeLessThan(200 * 1024);
  });
});
