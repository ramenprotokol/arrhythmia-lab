// The lead the strip shows, against ECG recorded from the real simulation (the same fixtures as the rhythm tests).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AutoLead } from "../../src/ecg/autoLead";

interface Segment {
  name: string;
  ecg: number[][];
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/rhythms.json", import.meta.url), "utf8")) as { scale: number; segments: Segment[] };

function run(name: string, stopAtMs = Infinity): { finalLead: number; leadAt: (t: number) => number; switches: number } {
  const seg = fixture.segments.find((s) => s.name === name);
  if (!seg) throw new Error(`no segment ${name}`);
  const auto = new AutoLead();
  const history: { t: number; lead: number }[] = [];
  let switches = 0;
  let last = auto.lead;
  for (const row of seg.ecg) {
    if (row[0] > stopAtMs) break;
    const lead = auto.push(row[0], row.slice(1).map((v) => v / fixture.scale));
    if (lead !== last) switches++;
    last = lead;
    history.push({ t: row[0], lead });
  }
  return { finalLead: auto.lead, switches, leadAt: (t) => history.reduce((b, h) => (h.t <= t ? h : b), history[0]).lead };
}

const II = 1;
const PRECORDIAL = [6, 7, 8, 9, 10, 11];

describe("the lead on the strip", () => {
  it("stays on lead II, the standard, while it has a real signal (a healthy beat)", () => {
    const r = run("sinus");
    expect(r.finalLead).toBe(II);
    expect(r.switches).toBe(0);
  });

  it("stays on lead II through an extra beat", () => {
    expect(run("extra beat, 550 ms").switches).toBe(0);
  });

  it("moves to a chest lead in the racing rhythm, where lead II is nearly flat, and stays there", () => {
    const r = run("racing, then a shock", 38000);
    expect(PRECORDIAL).toContain(r.finalLead);
    expect(r.switches).toBeLessThanOrEqual(2);
    expect(r.leadAt(37000)).toBe(r.finalLead);
  });

  it("moves to a chest lead in fibrillation too", () => {
    const r = run("fibrillation");
    expect(PRECORDIAL).toContain(r.finalLead);
    expect(r.switches).toBeLessThanOrEqual(2);
  });

  it("goes back to lead II when it has a real signal again, after a stretch on a chest lead (the steady beat after a shock)", () => {
    const auto = new AutoLead();
    const feed = (name: string, from: number) => {
      const seg = fixture.segments.find((x) => x.name === name) as Segment;
      for (const row of seg.ecg) if (row[0] > from) auto.push(row[0], row.slice(1).map((v) => v / fixture.scale));
    };
    feed("racing, then a shock", 0); // ends 0.8 s after the shock, still on a chest lead
    expect(PRECORDIAL).toContain(auto.lead);
    feed("recovery after a shock", 39000); // the pacemaker restarts at 39.7 s: steady beats, lead II swings again
    expect(auto.lead).toBe(II);
  });

  it("does not hop to a chest lead in the flat pause after a shock, whatever noise is left", () => {
    const auto = new AutoLead();
    // 1.5 s of a clear signal in V2 only, so the strip is on V2...
    for (let t = 0; t < 2400; t += 4) auto.push(t, [0, 0.05 * Math.sin(t / 30), 0, 0, 0, 0, 0, 2 * Math.sin(t / 30), 0, 0, 0, 0]);
    expect(auto.lead).toBe(7);
    // ...then a dead flat pause with a hair of noise in one lead
    for (let t = 2400; t < 6000; t += 4) auto.push(t, [0, 0, 0, 0, 0, 0, 0, 0, 2e-5 * Math.sin(t), 0, 0, 0]);
    expect(auto.lead).toBe(7);
  });

  it("goes back to lead II when reset, and does not move on too little evidence", () => {
    const auto = new AutoLead();
    auto.push(0, new Array(12).fill(0));
    expect(auto.lead).toBe(II);
    expect(auto.name).toBe("II");
    auto.reset();
    expect(auto.lead).toBe(II);
  });
});
