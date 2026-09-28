import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseEcgSamples, COMPARE_CAPTION, COMPARE_CREDIT } from "../../src/ui/compare";

const sample = (over: Record<string, unknown> = {}) => ({
  id: "normal-sinus",
  label: "Normal sinus rhythm: steady, regular heartbeat",
  lead: "II",
  fs: 250,
  mv: [0, 0.1, 0.9, 0.1, 0, -0.1],
  record: "PTB-XL ecg_id 33",
  ...over,
});
const file = (over: Record<string, unknown> = {}) => ({
  samples: [sample(), sample({ id: "pvc", record: "MIT-BIH 119" })],
  source: "PhysioNet: PTB-XL 1.0.3 and MIT-BIH Arrhythmia Database 1.0.0",
  licence: "PTB-XL: CC BY 4.0. MIT-BIH Arrhythmia Database: ODC-By 1.0.",
  url: "https://physionet.org/content/ptb-xl/1.0.3/",
  ...over,
});

describe("parseEcgSamples", () => {
  it("accepts the shipped file and keeps every sample", () => {
    const raw = JSON.parse(readFileSync("public/data/ecg-samples.json", "utf8")) as unknown;
    const data = parseEcgSamples(raw);
    expect(data.samples.length).toBeGreaterThanOrEqual(3);
    for (const s of data.samples) {
      expect(s.mv.length).toBeGreaterThan(0);
      expect(s.mv.every(Number.isFinite)).toBe(true);
      expect(s.record.length).toBeGreaterThan(0);
    }
    expect(data.url).toMatch(/^https:\/\//);
  });

  it("returns the fields it was given", () => {
    const data = parseEcgSamples(file());
    expect(data.samples.map((s) => s.id)).toEqual(["normal-sinus", "pvc"]);
    expect(data.samples[0]).toEqual(sample());
    expect(data.licence).toMatch(/CC BY 4\.0/);
  });

  it.each([
    ["null", null, /object/],
    ["a string", "text", /object/],
    ["an array", [], /object/],
    ["no samples", { ...file(), samples: undefined }, /samples/],
    ["samples that is not a list", file({ samples: {} }), /samples/],
    ["an empty list of samples", file({ samples: [] }), /at least one/],
    ["a sample that is not an object", file({ samples: [7] }), /samples\[0\]/],
    ["a missing id", file({ samples: [sample({ id: undefined })] }), /samples\[0\]\.id/],
    ["an empty id", file({ samples: [sample({ id: "" })] }), /samples\[0\]\.id/],
    ["a missing label", file({ samples: [sample({ label: undefined })] }), /samples\[0\]\.label/],
    ["an empty label", file({ samples: [sample({ label: "  " })] }), /samples\[0\]\.label/],
    ["a numeric lead", file({ samples: [sample({ lead: 2 })] }), /samples\[0\]\.lead/],
    ["a missing record", file({ samples: [sample({ record: undefined })] }), /samples\[0\]\.record/],
    ["a zero sampling rate", file({ samples: [sample({ fs: 0 })] }), /samples\[0\]\.fs/],
    ["a negative sampling rate", file({ samples: [sample({ fs: -250 })] }), /samples\[0\]\.fs/],
    ["a sampling rate that is a string", file({ samples: [sample({ fs: "250" })] }), /samples\[0\]\.fs/],
    ["a sampling rate of NaN", file({ samples: [sample({ fs: Number.NaN })] }), /samples\[0\]\.fs/],
    ["mv that is not a list", file({ samples: [sample({ mv: "0 1 2" })] }), /samples\[0\]\.mv/],
    ["an empty mv", file({ samples: [sample({ mv: [] })] }), /samples\[0\]\.mv/],
    ["a string in mv", file({ samples: [sample({ mv: [0, "1", 2] })] }), /samples\[0\]\.mv\[1\]/],
    ["NaN in mv", file({ samples: [sample({ mv: [0, 1, Number.NaN] })] }), /samples\[0\]\.mv\[2\]/],
    ["Infinity in mv", file({ samples: [sample({ mv: [Number.POSITIVE_INFINITY] })] }), /samples\[0\]\.mv\[0\]/],
    ["a second sample that is bad", file({ samples: [sample(), sample({ id: "b", mv: [1, null] })] }), /samples\[1\]\.mv\[1\]/],
    ["two samples with the same id", file({ samples: [sample(), sample()] }), /duplicate.*normal-sinus/i],
    ["a missing source", file({ source: undefined }), /source/],
    ["a missing licence", file({ licence: "" }), /licence/],
    ["a url that is not a string", file({ url: 5 }), /url/],
  ])("throws on %s, and names the problem", (_name, input, message) => {
    expect(() => parseEcgSamples(input)).toThrow(message);
  });

  it("does not modify its input", () => {
    const input = file();
    const before = JSON.stringify(input);
    parseEcgSamples(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("the fixed panel text", () => {
  it("is exactly the wording the project requires", () => {
    expect(COMPARE_CAPTION).toBe(
      "Recorded ECGs are shown for visual comparison only. This is an educational simulation, not a medical device and not a diagnostic tool.",
    );
    expect(COMPARE_CREDIT).toBe("Recorded ECGs: PTB-XL, CC BY 4.0; MIT-BIH Arrhythmia Database, ODC-By 1.0.");
  });
});
