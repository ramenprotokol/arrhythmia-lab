// The four free-play moves, against the real engine with a stand-in for the GPU simulation that only records what it is told.
import { describe, expect, it } from "vitest";
import { AFTER_SHOCK_MS, CHUNK_MS, LabEngine, PACEMAKER_PERIOD_MS, WHOLE_HEART_MM } from "../../src/lab/engine";
import type { RhythmState } from "../../src/audio/rhythm";
import { LabMoves } from "../../src/lab/moves";
import type { Simulation } from "../../src/sim/Simulation";
import * as R from "../../src/lessons/recipes";

function setup() {
  const calls: { kind: string; at: number; detail?: unknown }[] = [];
  let simTime = 0;
  const sim = {
    step: () => undefined,
    stimulate: (voxel: unknown, radius: number, opts: unknown) => calls.push({ kind: "stimulate", at: simTime, detail: { voxel, radius, opts } }),
    shock: () => calls.push({ kind: "shock", at: simTime }),
    setTissue: (t: unknown) => calls.push({ kind: "tissue", at: simTime, detail: { ...(t as object) } }),
    excitedFraction: async () => 0,
  };
  const shocks: number[] = [];
  const engine = new LabEngine(sim as unknown as Simulation, { afterAdvance: (t) => (simTime = t), shocked: (t) => shocks.push(t) });
  const moves = new LabMoves(engine);
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += CHUNK_MS) engine.advanceChunk();
  };
  const beatsAt = () => calls.filter((c) => c.kind === "stimulate").map((c) => c.at);
  return { engine, moves, calls, shocks, run, beatsAt };
}

describe("an early beat", () => {
  it("waits until the muscle has rested long enough after the last beat, then fires once", () => {
    const { moves, run, beatsAt } = setup();
    run(400); // the pacemaker's first beat comes at 300 ms
    const before = beatsAt().length;
    moves.extraBeat();
    run(200);
    expect(beatsAt().length, "fired too soon: it would have been swallowed by the recovering muscle").toBe(before);
    run(400);
    const fired = beatsAt().slice(before);
    expect(fired.length).toBeGreaterThanOrEqual(1);
    // the extra beat came R.PVC_EXTRA_BEAT_MS after the paced one at ~300 ms
    expect(fired[0] - 300).toBeGreaterThanOrEqual(R.PVC_EXTRA_BEAT_MS - CHUNK_MS);
    expect(fired[0] - 300).toBeLessThanOrEqual(R.PVC_EXTRA_BEAT_MS + 2 * CHUNK_MS + 2);
  });

  it("fires at once when nothing has beaten for a long time (the pacemaker is off)", () => {
    const { engine, moves, run, beatsAt } = setup();
    engine.setPacemaker(false);
    run(2000);
    expect(beatsAt()).toEqual([]);
    moves.extraBeat();
    run(CHUNK_MS * 2);
    expect(beatsAt().length).toBe(1);
  });

  it("is forgotten if the heart is shocked before it fires", () => {
    const { moves, engine, run, beatsAt } = setup();
    engine.setPacemaker(false);
    engine.simTime = 1000;
    engine.lastBeatAt = 900; // a beat 100 ms ago: the extra has to wait
    moves.extraBeat();
    engine.shock();
    run(1500);
    expect(beatsAt()).toEqual([]);
  });
});

describe("making it race or fibrillate", () => {
  it("starts the lab's own induction and says so while it is setting up", () => {
    const { moves, engine } = setup();
    expect(moves.starting).toBeNull();
    moves.race();
    expect(moves.starting).toBe("racing");
    expect(engine.pacemaker).toBe(false);
    expect(engine.tissue).toEqual(R.TACHYCARDIA_TISSUE);
    moves.fibrillate();
    expect(moves.starting).toBe("fibrillation");
    expect(engine.tissue).toEqual(R.FIBRILLATION_TISSUE);
  });
});

describe("fixing it", () => {
  it("fires the whole heart at once, restores healthy tissue, and brings the pacemaker back after the pause a shock leaves", () => {
    const { moves, engine, run, shocks, beatsAt, calls } = setup();
    moves.race();
    run(100);
    const shocksBefore = shocks.length;
    moves.fix();
    expect(shocks.length).toBe(shocksBefore + 1);
    const wholeHeart = calls.filter((c) => c.kind === "stimulate").pop();
    expect((wholeHeart?.detail as { radius: number }).radius, "the shock has to reach every cell").toBeGreaterThanOrEqual(WHOLE_HEART_MM);
    expect(moves.starting, "the induction must be cancelled, or it would carry on and undo the fix").toBeNull();
    expect(engine.tissue).toEqual(R.NORMAL_TISSUE);
    expect(engine.pacemaker).toBe(true);
    const shockAt = engine.simTime;
    const beatsBefore = beatsAt().length;
    run(AFTER_SHOCK_MS - 100);
    expect(beatsAt().length, "a beat came back too soon: the heart should rest a moment after a shock").toBe(beatsBefore);
    run(200 + PACEMAKER_PERIOD_MS);
    const next = beatsAt()[beatsBefore];
    expect(next - shockAt).toBeGreaterThanOrEqual(AFTER_SHOCK_MS - CHUNK_MS);
    expect(next - shockAt).toBeLessThanOrEqual(AFTER_SHOCK_MS + 2 * CHUNK_MS);
  });

  it("tells the shock hook about every shock, including the lab's own resets", () => {
    const { moves, shocks } = setup();
    moves.race(); // the inducer shocks the heart to start from rest
    expect(shocks.length).toBe(1);
  });
});

describe("the shock rule: like a defibrillator, it only shocks a rhythm that is not pumping", () => {
  const reading = (kind: RhythmState["kind"], bpm: number | null, output: number): RhythmState => ({ kind, bpm, output, sinceMs: 0 });

  it("shocks fibrillation and a racing rhythm that pumps little", () => {
    for (const r of [reading("chaotic", null, 0.02), reading("racing", 268, 0.15), reading("racing", 230, 0.3)]) {
      const { moves, shocks } = setup();
      expect(moves.shock(r)).toEqual({ fired: true });
      expect(shocks.length).toBe(1);
    }
  });

  it("shocks a very fast rhythm even while the last second still looks organised (a racing rhythm has just started)", () => {
    const { moves } = setup();
    expect(moves.shock(reading("racing", 268, 0.8))).toEqual({ fired: true });
  });

  it("leaves a steady, pumping heart alone, and says why", () => {
    const { moves, shocks, calls } = setup();
    expect(moves.shock(reading("steady", 75, 1))).toEqual({ fired: false, reason: "pumping" });
    expect(shocks).toEqual([]);
    expect(calls.filter((c) => c.kind === "stimulate")).toEqual([]);
  });

  it("leaves an organised fast rhythm that pumps well alone (that is not the racing rhythm)", () => {
    const { moves, shocks } = setup();
    expect(moves.shock(reading("racing", 160, 0.9))).toEqual({ fired: false, reason: "pumping" });
    expect(shocks).toEqual([]);
  });

  it("leaves a still heart alone: a shock cannot start it", () => {
    const { moves, shocks } = setup();
    expect(moves.shock(reading("quiet", null, 0))).toEqual({ fired: false, reason: "still" });
    expect(shocks).toEqual([]);
  });

  it("does not call a heart 'still' while muscle is firing, whatever a lagging reading says", () => {
    const { moves, engine, shocks } = setup();
    engine.simTime = 10_000;
    engine.excited = 0.3; // fibrillating, but the analyser has not caught up: it still reads quiet
    expect(moves.shock(reading("quiet", null, 0))).toEqual({ fired: true });
    expect(shocks.length).toBe(1);
  });

  it("still refuses a genuinely still heart, and the muscle firing in the aftermath of a shock is not a new rhythm", () => {
    const { moves, engine } = setup();
    engine.simTime = 10_000;
    engine.excited = 0;
    expect(moves.shock(reading("quiet", null, 0))).toEqual({ fired: false, reason: "still" });
    engine.defibrillate(); // the whole heart fires and then recovers together
    engine.excited = 1;
    expect(moves.shock(reading("quiet", null, 0))).toEqual({ fired: false, reason: "still" });
  });

  it("cancels a rhythm the lab is still setting up, whatever the reading says", () => {
    const { moves, engine, shocks } = setup();
    moves.race();
    const before = shocks.length;
    expect(moves.shock(reading("steady", 75, 1))).toEqual({ fired: true });
    expect(shocks.length).toBe(before + 1);
    expect(moves.starting).toBeNull();
    expect(engine.pacemaker).toBe(true);
  });
});

describe("settling after a rhythm starts", () => {
  it("stays set for a moment after the lab reports success, so the page does not show a wrong name while the reading catches up", () => {
    const { moves, engine, run } = setup();
    moves.race();
    expect(moves.settling).toBeNull(); // still setting it up: that is `starting`, not settling
    // pretend the inducer succeeded
    (engine.inducer as unknown as { status: string }).status = "success";
    expect(moves.starting).toBeNull();
    expect(moves.settling).toBe("racing");
    run(800);
    expect(moves.settling).toBe("racing");
    run(1000);
    expect(moves.settling).toBeNull();
  });
});
