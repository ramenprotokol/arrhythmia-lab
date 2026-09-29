// The ordinary beat as a conduction sweep, against the real engine with a stand-in for the GPU simulation that only records.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHUNK_MS, LabEngine, SWEEP_SLOT_MS } from "../../src/lab/engine";
import { activationTimes } from "../../src/lab/conduction";
import { parseFrame } from "../../src/data/heartFrame";
import { parseHeart } from "../../src/data/loadHeart";
import { SWEEP_NEVER, type Simulation } from "../../src/sim/Simulation";

const file = readFileSync(new URL("../../public/data/heart.bin", import.meta.url));
const grid = parseHeart(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer);
const frame = parseFrame(JSON.parse(readFileSync(new URL("../../public/data/heart-frame.json", import.meta.url), "utf8")));
const muscle = grid.tissue.reduce((n, t) => n + (t > 0 ? 1 : 0), 0);

function setup() {
  const log: string[] = [];
  const slots: [number, number][] = [];
  let times: Float32Array | null = null;
  const sim = {
    step: (ms: number) => log.push(`step ${ms}`),
    stimulate: () => log.push("stimulate"),
    shock: () => log.push("shock"),
    setTissue: () => undefined,
    excitedFraction: async () => 0,
    setSweepTimes: (t: Float32Array) => (times = t),
    stimulateSweep: (from: number, to: number) => {
      slots.push([from, to]);
      log.push("sweep");
    },
  };
  const engine = new LabEngine(sim as unknown as Simulation);
  engine.setPacemaker(false);
  return { engine, log, slots, times: () => times };
}

describe("the activation times", () => {
  const times = activationTimes(grid, frame, { leftSpeedMmPerMs: 1.5, rightSpeedMmPerMs: 1.5, rightDelayMs: 10 });

  it("hold one value per muscle voxel, in the simulation's own order", () => {
    expect(times.length).toBe(muscle);
    const muscleTissue: number[] = [];
    for (let z = 0; z < grid.nz; z++) for (let y = 0; y < grid.ny; y++) for (let x = 0; x < grid.nx; x++) {
      const t = grid.tissue[x + grid.nx * (y + grid.ny * z)];
      if (t > 0) muscleTissue.push(t);
    }
    muscleTissue.forEach((t, i) => expect(times[i] < SWEEP_NEVER, `voxel ${i}, tissue ${t}`).toBe(t === 1));
  });

  it("reach the whole inner wall within about 100 ms, starting at once at the septum", () => {
    const finite = Array.from(times).filter((v) => v < SWEEP_NEVER);
    expect(finite.length).toBeGreaterThan(5000);
    expect(Math.min(...finite)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...finite)).toBeLessThan(2);
    expect(Math.max(...finite)).toBeGreaterThan(30);
    expect(Math.max(...finite)).toBeLessThan(130);
  });
});

describe("the ordinary beat", () => {
  it("is a single nudge at the tip until a sweep is configured", () => {
    const { engine, log } = setup();
    engine.normalBeat();
    expect(log).toEqual(["stimulate"]);
  });

  it("runs the sweep over the next chunks, in slots, taking the place of plain stepping and adding no time", () => {
    const { engine, log, slots, times } = setup();
    engine.useConductionSweep(grid, frame);
    expect(times()?.length).toBe(muscle);
    engine.normalBeat();
    expect(log).toEqual([]);
    const t0 = engine.simTime;
    let chunks = 0;
    while (log.filter((l) => l === "sweep").length === 0 || chunks < 200) {
      engine.advanceChunk();
      chunks++;
      if (log[log.length - 1] === "step 4") break;
    }
    expect(slots.length).toBeGreaterThan(30);
    slots.forEach(([from, to], i) => {
      expect(from).toBe(i * SWEEP_SLOT_MS);
      expect(to).toBe(from + SWEEP_SLOT_MS);
    });
    expect(log.slice(0, slots.length).every((l) => l === "sweep")).toBe(true);
    expect(engine.simTime - t0).toBe(chunks * CHUNK_MS);
    expect(engine.lastBeatAt).toBe(t0);
  });

  it("is fired by the pacemaker", () => {
    const { engine, log } = setup();
    engine.useConductionSweep(grid, frame);
    engine.setPacemaker(true);
    for (let t = 0; t < 700; t += CHUNK_MS) engine.advanceChunk();
    expect(log.includes("sweep")).toBe(true);
    expect(log.includes("stimulate")).toBe(false);
  });

  it("is cancelled by a shock in the middle of the sweep", () => {
    const { engine, log } = setup();
    engine.useConductionSweep(grid, frame);
    engine.normalBeat();
    engine.advanceChunk();
    engine.advanceChunk();
    engine.shock();
    const before = log.filter((l) => l === "sweep").length;
    engine.advanceChunk();
    expect(log.filter((l) => l === "sweep").length).toBe(before);
    expect(log[log.length - 1]).toBe("step 4");
  });
});
