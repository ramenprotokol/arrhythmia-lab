import { describe, it, expect } from "vitest";
import { Inducer, type InduceHost, type Plan } from "../../src/lab/induce";

// A fake lab with a controllable clock and a controllable "does the rhythm take" switch.
function fakeLab(takes: (attemptNumber: number) => boolean) {
  const log: string[] = [];
  let now = 0;
  let attempt = -1; // the shock that clears the heart when induction starts brings this to 0
  let excited = 0;
  const host: InduceHost = {
    simTimeMs: () => now,
    activeFraction: () => excited,
    apexBeat: () => log.push(`apex@${now}`),
    extraBeat: () => {
      log.push(`extra@${now}`);
      excited = takes(attempt) ? 0.3 : 0;
    },
    shock: () => {
      log.push(`shock@${now}`);
      excited = 0;
      attempt++;
    },
    setTissue: (t) => log.push(`tissue ${t.conduction}/${t.recovery}`),
    setPacemaker: (on) => log.push(`pacemaker ${on}`),
  };
  return { host, log, advance: (ms: number) => (now += ms), now: () => now };
}

const plan = (n: number): Plan => ({
  tissue: { conduction: 0.7, recovery: 0.3 },
  minFraction: 0.05,
  attempts: Array.from({ length: n }, (_, i) => ({
    stimuli: [
      { atMs: 0, kind: "apex" as const },
      { atMs: 250 + 10 * i, kind: "extra" as const },
    ],
    checkAtMs: 250 + 10 * i + 2000,
  })),
});

function run(lab: ReturnType<typeof fakeLab>, inducer: Inducer, maxMs = 60000) {
  for (let t = 0; t < maxMs && inducer.state.status === "running"; t += 4) {
    inducer.tick();
    lab.advance(4);
  }
}

describe("Inducer", () => {
  it("delivers the beat and the extra beat at the planned times and stops at the first attempt that takes", () => {
    const lab = fakeLab(() => true);
    const inducer = new Inducer(lab.host, { tachycardia: plan(3), fibrillation: plan(1) });
    inducer.start("tachycardia");
    run(lab, inducer);
    expect(inducer.state.status).toBe("success");
    expect(inducer.state.attempt).toBe(1);
    expect(lab.log.slice(0, 4)).toEqual(["pacemaker false", "shock@0", "tissue 0.7/0.3", "apex@400"]);
    expect(lab.log).toContain("extra@652"); // the first chunk boundary at or after 400 + 250, 4 ms grid
    expect(lab.log.filter((l) => l.startsWith("shock")).length).toBe(1); // only the reset at the start: a success is never shocked away
  });

  it("shocks a failed attempt back to rest and tries the next timing", () => {
    const lab = fakeLab((a) => a === 2); // only the third attempt takes
    const inducer = new Inducer(lab.host, { tachycardia: plan(5), fibrillation: plan(1) });
    inducer.start("tachycardia");
    run(lab, inducer);
    expect(inducer.state.status).toBe("success");
    expect(inducer.state.attempt).toBe(3);
    expect(lab.log.filter((l) => l.startsWith("shock")).length).toBe(3); // the reset at the start, then two failed attempts
    expect(lab.log.filter((l) => l.startsWith("extra")).length).toBe(3);
  });

  it("reports failure, and leaves the heart at rest, when no timing takes", () => {
    const lab = fakeLab(() => false);
    const inducer = new Inducer(lab.host, { tachycardia: plan(3), fibrillation: plan(1) });
    inducer.start("tachycardia");
    run(lab, inducer);
    expect(inducer.state.status).toBe("failed");
    expect(inducer.state.attempts).toBe(3);
    expect(lab.log.filter((l) => l.startsWith("shock")).length).toBe(4); // the reset, then three failed attempts
  });

  it("can be cancelled, and does nothing more afterwards", () => {
    const lab = fakeLab(() => true);
    const inducer = new Inducer(lab.host, { tachycardia: plan(2), fibrillation: plan(1) });
    inducer.start("fibrillation");
    lab.advance(500);
    inducer.tick();
    inducer.cancel();
    const before = lab.log.length;
    run(lab, inducer, 5000);
    lab.advance(5000);
    inducer.tick();
    expect(inducer.state.status).toBe("idle");
    expect(lab.log.length).toBe(before);
  });

  it("notifies listeners on progress and lets them unsubscribe", () => {
    const lab = fakeLab(() => true);
    const inducer = new Inducer(lab.host, { tachycardia: plan(1), fibrillation: plan(1) });
    let calls = 0;
    const off = inducer.onChange(() => calls++);
    inducer.start("tachycardia");
    run(lab, inducer);
    expect(calls).toBeGreaterThanOrEqual(2); // started, then succeeded
    off();
    const n = calls;
    inducer.start("tachycardia");
    expect(calls).toBe(n);
  });

  it("waits for the heart to settle before the first stimulus", () => {
    const lab = fakeLab(() => true);
    const inducer = new Inducer(lab.host, { tachycardia: plan(1), fibrillation: plan(1) });
    lab.advance(1000);
    inducer.start("tachycardia");
    for (let i = 0; i < 120; i++) { inducer.tick(); lab.advance(4); } // 480 ms
    expect(lab.log.filter((l) => l.startsWith("apex"))[0]).toBe("apex@1400"); // 1000 + 400 settling
  });
});
