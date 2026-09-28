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
      expect(Object.keys(s).sort()).toEqual(["fs", "id", "label", "lead", "mv", "record"]);
      expect(s.id.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.record.length).toBeGreaterThan(0);
      expect(s.lead).toBe("II");
      expect(Number.isFinite(s.fs)).toBe(true);
      expect(s.mv.length).toBeGreaterThan(0);
      expect(s.mv.every((v) => Number.isFinite(v))).toBe(true);
    }
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
