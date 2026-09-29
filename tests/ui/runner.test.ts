import { describe, it, expect, vi } from "vitest";
import { HINT_AFTER_MS, LessonRunner, type LabApi, type Lesson, type LessonStep } from "../../src/lessons/runner";

// A fake lab with a clock and an "active" reading the test controls by hand.
function fakeLab() {
  const log: string[] = [];
  const lab = { now: 0, active: 0 };
  const api: LabApi = {
    pace: (v) => log.push(`pace ${v.join(",")}`),
    prematureBeat: () => log.push("premature"),
    shock: () => log.push("shock"),
    normalBeat: () => log.push("normal beat"),
    defibrillate: () => log.push("defibrillate"),
    setTissue: (t) => log.push(`tissue ${JSON.stringify(t)}`),
    activeFraction: () => lab.active,
    simTimeMs: () => lab.now,
    setPacemaker: (on) => log.push(`pacemaker ${on}`),
    burstPace: (beats, periodMs) => log.push(`burst ${beats} ${periodMs}`),
    lastBeatMs: () => -Infinity,
    induce: (kind) => log.push(`induce ${kind}`),
    induceStatus: () => "idle",
  };
  return { api, log, lab };
}

const lesson = (id: string, steps: LessonStep[]): Lesson => ({ id, title: `Title ${id}`, summary: `Summary ${id}`, steps });
const plain = (text: string, extra: Partial<LessonStep> = {}): LessonStep => ({ text, ...extra });

describe("LessonRunner: starting", () => {
  it("throws on an unknown lesson id", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("x")])], api);
    expect(() => runner.start("nope")).toThrow(/unknown lesson/i);
  });

  it("refuses two lessons with the same id", () => {
    const { api } = fakeLab();
    expect(() => new LessonRunner([lesson("a", [plain("x")]), lesson("a", [plain("y")])], api)).toThrow(/duplicate/i);
  });

  it("is idle until started", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("x")])], api);
    expect(runner.state).toEqual({ lessonId: null, stepIndex: 0, step: null, finished: false, running: false, hint: null });
  });

  it("shows the first step on start, and runs its action only on the first tick", () => {
    const { api, log } = fakeLab();
    const first = plain("one", { action: (a) => a.shock() });
    const runner = new LessonRunner([lesson("a", [first, plain("two")])], api);
    runner.start("a");
    expect(runner.state).toEqual({ lessonId: "a", stepIndex: 0, step: first, finished: false, running: true, hint: null });
    expect(log).toEqual([]);
    runner.tick();
    expect(log).toEqual(["shock"]);
  });

  it("switching to another lesson drops the old one", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("a1"), plain("a2")]), lesson("b", [plain("b1")])], api);
    runner.start("a");
    runner.next();
    runner.start("b");
    expect(runner.state.lessonId).toBe("b");
    expect(runner.state.stepIndex).toBe(0);
  });

  it("finishes at once when a lesson has no steps", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([lesson("empty", [])], api);
    runner.start("empty");
    expect(runner.state).toMatchObject({ lessonId: "empty", finished: true, running: false, step: null });
  });
});

describe("LessonRunner: actions", () => {
  it("runs an action exactly once however many ticks pass", () => {
    const { api } = fakeLab();
    const action = vi.fn();
    const runner = new LessonRunner([lesson("a", [plain("one", { action }), plain("two")])], api);
    runner.start("a");
    for (let i = 0; i < 20; i++) runner.tick();
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(api);
  });

  it("runs an action again when the step is re-entered with back()", () => {
    const { api } = fakeLab();
    const action = vi.fn();
    const runner = new LessonRunner([lesson("a", [plain("one"), plain("two", { action })])], api);
    runner.start("a");
    runner.tick();
    runner.next();
    runner.tick();
    expect(action).toHaveBeenCalledTimes(1);
    runner.back();
    runner.tick(); // step one again
    runner.next();
    runner.tick(); // step two again
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("does not run an action twice when a tick and next() both happen on the same step", () => {
    const { api } = fakeLab();
    const action = vi.fn();
    const runner = new LessonRunner([lesson("a", [plain("one", { action }), plain("two")])], api);
    runner.start("a");
    runner.tick();
    runner.next();
    runner.tick();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("runs the pending action of a step the viewer skips with next() before any tick", () => {
    // Later steps may depend on what an earlier action set up (for example the tissue settings).
    const { api, log } = fakeLab();
    const runner = new LessonRunner(
      [lesson("a", [plain("one", { action: (x) => x.setTissue({ recovery: 0.4 }) }), plain("two")])],
      api,
    );
    runner.start("a");
    runner.next();
    expect(log).toEqual(['tissue {"recovery":0.4}']);
    expect(runner.state.stepIndex).toBe(1);
  });

  it("drops the pending action of a step the viewer leaves backwards", () => {
    const { api } = fakeLab();
    const action = vi.fn();
    const runner = new LessonRunner([lesson("a", [plain("one"), plain("two", { action })])], api);
    runner.start("a");
    runner.tick();
    runner.next(); // now on step two, action pending
    runner.back(); // leave it before any tick
    runner.tick();
    expect(action).not.toHaveBeenCalled();
  });

  it("does not run an action again after it threw", () => {
    const { api } = fakeLab();
    const action = vi.fn(() => {
      throw new Error("boom");
    });
    const runner = new LessonRunner([lesson("a", [plain("one", { action }), plain("two")])], api);
    runner.start("a");
    expect(() => runner.tick()).toThrow("boom");
    expect(() => runner.tick()).not.toThrow();
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe("LessonRunner: advancing", () => {
  it("never advances a step without waitFor by itself", () => {
    const { api, lab } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("one"), plain("two")])], api);
    runner.start("a");
    for (let i = 0; i < 50; i++) {
      lab.now += 100;
      runner.tick();
    }
    expect(runner.state.stepIndex).toBe(0);
    runner.next();
    expect(runner.state.stepIndex).toBe(1);
  });

  it("does not advance a step with only minMs (waitFor is what switches automatic advance on)", () => {
    const { api, lab } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("one", { minMs: 100 }), plain("two")])], api);
    runner.start("a");
    runner.tick();
    lab.now += 10_000;
    runner.tick();
    expect(runner.state.stepIndex).toBe(0);
  });

  it("holds a step until waitFor is true, then moves on", () => {
    const { api, lab } = fakeLab();
    const waitFor = vi.fn((a: LabApi) => a.activeFraction() > 0.5);
    const runner = new LessonRunner([lesson("a", [plain("one", { waitFor }), plain("two")])], api);
    runner.start("a");
    runner.tick();
    runner.tick();
    expect(runner.state.stepIndex).toBe(0);
    expect(waitFor).toHaveBeenCalledWith(api);
    lab.active = 0.51;
    runner.tick();
    expect(runner.state.stepIndex).toBe(1);
  });

  it("runs the action before waitFor is first asked", () => {
    const { api } = fakeLab();
    const order: string[] = [];
    const runner = new LessonRunner(
      [
        lesson("a", [
          plain("one", {
            action: () => order.push("action"),
            waitFor: () => {
              order.push("waitFor");
              return false;
            },
          }),
          plain("two"),
        ]),
      ],
      api,
    );
    runner.start("a");
    runner.tick();
    runner.tick();
    expect(order).toEqual(["action", "waitFor", "waitFor"]);
  });

  it("holds a step for minMs of simulated time, counted from when its action ran", () => {
    const { api, lab } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("one", { waitFor: () => true, minMs: 500 }), plain("two")])], api);
    lab.now = 1000;
    runner.start("a");
    lab.now = 1200; // time passing between start() and the first tick does not count
    runner.tick(); // the step is entered here, at 1200
    expect(runner.state.stepIndex).toBe(0);
    lab.now = 1699;
    runner.tick();
    expect(runner.state.stepIndex).toBe(0);
    lab.now = 1700;
    runner.tick();
    expect(runner.state.stepIndex).toBe(1);
  });

  it("needs both waitFor and minMs", () => {
    const { api, lab } = fakeLab();
    const runner = new LessonRunner(
      [lesson("a", [plain("one", { waitFor: (a) => a.activeFraction() > 0.5, minMs: 300 }), plain("two")])],
      api,
    );
    runner.start("a");
    runner.tick();
    lab.active = 1; // ready, but too early
    lab.now = 299;
    runner.tick();
    expect(runner.state.stepIndex).toBe(0);
    lab.now = 300;
    lab.active = 0; // enough time, but not ready
    runner.tick();
    expect(runner.state.stepIndex).toBe(0);
    lab.active = 1;
    runner.tick();
    expect(runner.state.stepIndex).toBe(1);
  });

  it("does not wedge if the simulation clock jumps back", () => {
    const { api, lab } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("one", { waitFor: () => true, minMs: 200 }), plain("two")])], api);
    lab.now = 50_000;
    runner.start("a");
    runner.tick(); // entered at 50 000
    lab.now = 0; // the simulation restarted its clock
    runner.tick();
    expect(runner.state.stepIndex).toBe(0);
    lab.now = 200;
    runner.tick();
    expect(runner.state.stepIndex).toBe(1);
  });

  it("moves at most one step per tick", () => {
    const { api } = fakeLab();
    const actions = [vi.fn(), vi.fn(), vi.fn()];
    const runner = new LessonRunner(
      [lesson("a", actions.map((action, i) => plain(`s${i}`, { action, waitFor: () => true })))],
      api,
    );
    runner.start("a");
    runner.tick();
    expect(runner.state.stepIndex).toBe(1);
    expect(actions.map((a) => a.mock.calls.length)).toEqual([1, 0, 0]);
    runner.tick();
    expect(runner.state.stepIndex).toBe(2);
    expect(actions.map((a) => a.mock.calls.length)).toEqual([1, 1, 0]);
    runner.tick();
    expect(runner.state.finished).toBe(true);
    expect(actions.map((a) => a.mock.calls.length)).toEqual([1, 1, 1]);
  });
});

describe("LessonRunner: back, restart, stop, finish", () => {
  const three = () => lesson("a", [plain("one"), plain("two"), plain("three")]);

  it("goes back one step, and stays put on the first step", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([three()], api);
    runner.start("a");
    runner.back();
    expect(runner.state.stepIndex).toBe(0);
    runner.next();
    runner.next();
    runner.back();
    expect(runner.state.stepIndex).toBe(1);
  });

  it("finishes after next() on the last step", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([three()], api);
    runner.start("a");
    runner.next();
    runner.next();
    expect(runner.state).toMatchObject({ stepIndex: 2, finished: false, running: true });
    runner.next();
    expect(runner.state).toEqual({ lessonId: "a", stepIndex: 3, step: null, finished: true, running: false, hint: null });
  });

  it("finishes when the last step's waitFor is satisfied", () => {
    const { api, lab } = fakeLab();
    const runner = new LessonRunner(
      [lesson("a", [plain("one"), plain("two", { waitFor: (a) => a.activeFraction() === 0 })])],
      api,
    );
    runner.start("a");
    runner.next();
    lab.active = 0.3;
    runner.tick();
    expect(runner.state.finished).toBe(false);
    lab.active = 0;
    runner.tick();
    expect(runner.state.finished).toBe(true);
  });

  it("ignores next(), back() and tick() once finished, except that back() returns to the last step", () => {
    const { api } = fakeLab();
    const action = vi.fn();
    const runner = new LessonRunner([lesson("a", [plain("one"), plain("two", { action })])], api);
    runner.start("a");
    runner.next();
    runner.next();
    expect(runner.state.finished).toBe(true);
    runner.next();
    runner.tick();
    expect(runner.state.finished).toBe(true);
    expect(action).toHaveBeenCalledTimes(1); // the skipped step's pending action still ran once, on next()
    runner.back();
    expect(runner.state).toMatchObject({ stepIndex: 1, finished: false, running: true });
    runner.tick();
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("restart returns to the first step and runs its action again", () => {
    const { api } = fakeLab();
    const action = vi.fn();
    const runner = new LessonRunner([lesson("a", [plain("one", { action }), plain("two")])], api);
    runner.start("a");
    runner.tick();
    runner.next();
    runner.restart();
    expect(runner.state).toMatchObject({ lessonId: "a", stepIndex: 0, finished: false, running: true });
    runner.tick();
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("restart works after the lesson has finished", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("one")])], api);
    runner.start("a");
    runner.next();
    expect(runner.state.finished).toBe(true);
    runner.restart();
    expect(runner.state).toMatchObject({ lessonId: "a", stepIndex: 0, finished: false, running: true });
  });

  it("restart with no lesson loaded does nothing", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([three()], api);
    runner.restart();
    expect(runner.state.lessonId).toBeNull();
  });

  it("stop leaves the lesson, and later ticks run nothing", () => {
    const { api } = fakeLab();
    const action = vi.fn();
    const runner = new LessonRunner([lesson("a", [plain("one", { action })])], api);
    runner.start("a");
    runner.stop();
    runner.tick();
    expect(action).not.toHaveBeenCalled();
    expect(runner.state).toEqual({ lessonId: null, stepIndex: 0, step: null, finished: false, running: false, hint: null });
  });
});

describe("LessonRunner: hints, and steps that cannot be skipped", () => {
  const waiting = (extra: Partial<LessonStep> = {}) =>
    lesson("a", [plain("one", { waitFor: (a) => a.activeFraction() > 0.5, hint: "Do the thing, or press Skip.", ...extra }), plain("two")]);

  it("offers a hint only once the step has lasted HINT_AFTER_MS of simulated time, and only while waitFor is false", () => {
    const { api, lab } = fakeLab();
    const runner = new LessonRunner([waiting()], api);
    runner.start("a");
    runner.tick(); // entered at 0
    lab.now = HINT_AFTER_MS - 1;
    runner.tick();
    expect(runner.state.hint).toBeNull();
    lab.now = HINT_AFTER_MS;
    runner.tick();
    expect(runner.state.hint).toBe("Do the thing, or press Skip.");
    lab.active = 1; // the promised state arrives: the step moves on, and the hint goes with it
    runner.tick();
    expect(runner.state.stepIndex).toBe(1);
    expect(runner.state.hint).toBeNull();
  });

  it("never offers the hint while the promised state holds, however long the step lasts", () => {
    const { api, lab } = fakeLab();
    const runner = new LessonRunner([waiting({ minMs: 60_000 })], api);
    runner.start("a");
    runner.tick();
    lab.active = 1; // already true, but the step is held by minMs
    for (let t = 0; t <= 30_000; t += 500) {
      lab.now = t;
      runner.tick();
      expect(runner.state.hint).toBeNull();
    }
    lab.active = 0; // it stops being true: now the hint is offered
    runner.tick();
    expect(runner.state.hint).toBe("Do the thing, or press Skip.");
  });

  it("counts hintAfterMs in simulated time from when the action ran", () => {
    const { api, lab } = fakeLab();
    const runner = new LessonRunner([waiting({ hintAfterMs: 1500 })], api);
    lab.now = 10_000;
    runner.start("a");
    lab.now = 11_000; // time before the first tick does not count
    runner.tick();
    lab.now = 12_499;
    runner.tick();
    expect(runner.state.hint).toBeNull();
    lab.now = 12_500;
    runner.tick();
    expect(runner.state.hint).not.toBeNull();
  });

  it("tells listeners when a hint appears, and forgets it when the step is re-entered", () => {
    const { api, lab } = fakeLab();
    const runner = new LessonRunner([waiting({ hintAfterMs: 100 })], api);
    const listener = vi.fn();
    runner.start("a");
    runner.onChange(listener);
    runner.tick();
    lab.now = 100;
    runner.tick();
    expect(listener).toHaveBeenCalledTimes(1);
    runner.tick(); // nothing new
    expect(listener).toHaveBeenCalledTimes(1);
    runner.restart();
    expect(runner.state.hint).toBeNull();
  });

  it("offers no hint on a step that has none, or that does not wait", () => {
    const { api, lab } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("one", { waitFor: () => false }), plain("two", { hint: "never" })])], api);
    runner.start("a");
    runner.tick();
    lab.now = 60_000;
    runner.tick();
    expect(runner.state.hint).toBeNull();
    runner.next();
    runner.tick();
    lab.now = 120_000;
    runner.tick();
    expect(runner.state.hint).toBeNull();
  });

  it("does not ask waitFor before minMs has passed unless a hint is due", () => {
    const { api, lab } = fakeLab();
    const waitFor = vi.fn(() => false);
    const runner = new LessonRunner([lesson("a", [plain("one", { waitFor, minMs: 5000, hint: "h", hintAfterMs: 2000 }), plain("two")])], api);
    runner.start("a");
    runner.tick();
    lab.now = 1999;
    runner.tick();
    expect(waitFor).not.toHaveBeenCalled();
    lab.now = 2000;
    runner.tick();
    expect(waitFor).toHaveBeenCalledTimes(1);
  });

  it("does not let next() skip a step with canSkip false until its waitFor is true", () => {
    const { api, lab } = fakeLab();
    const action = vi.fn();
    const runner = new LessonRunner([lesson("a", [plain("one", { action, waitFor: (a) => a.activeFraction() > 0.5, canSkip: false }), plain("two")])], api);
    runner.start("a");
    runner.next(); // runs the pending action, but stays
    expect(action).toHaveBeenCalledTimes(1);
    expect(runner.state.stepIndex).toBe(0);
    runner.next();
    expect(runner.state.stepIndex).toBe(0);
    lab.active = 1;
    runner.next();
    expect(runner.state.stepIndex).toBe(1);
  });

  it("still lets back(), restart() and stop() leave a step that cannot be skipped", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("zero"), plain("one", { waitFor: () => false, canSkip: false })])], api);
    runner.start("a");
    runner.next();
    expect(runner.state.stepIndex).toBe(1);
    runner.back();
    expect(runner.state.stepIndex).toBe(0);
    runner.next();
    runner.restart();
    expect(runner.state.stepIndex).toBe(0);
    runner.next();
    runner.stop();
    expect(runner.state.lessonId).toBeNull();
  });
});

describe("LessonRunner: change notification", () => {
  it("tells listeners when the lesson starts, moves, finishes and stops", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("one"), plain("two")])], api);
    const seen: string[] = [];
    runner.onChange(() => seen.push(`${runner.state.lessonId}:${runner.state.stepIndex}:${runner.state.finished}`));
    runner.start("a");
    runner.next();
    runner.next();
    runner.restart();
    runner.stop();
    expect(seen).toEqual(["a:0:false", "a:1:false", "a:2:true", "a:0:false", "null:0:false"]);
  });

  it("does not notify for ticks that change nothing", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("one", { action: () => undefined }), plain("two")])], api);
    const listener = vi.fn();
    runner.start("a");
    runner.onChange(listener);
    runner.tick();
    runner.tick();
    runner.tick();
    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies when a tick advances the step", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("one", { waitFor: () => true }), plain("two")])], api);
    const listener = vi.fn();
    runner.start("a");
    runner.onChange(listener);
    runner.tick();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying a listener after it unsubscribes, and leaves the others alone", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("one"), plain("two")])], api);
    const first = vi.fn();
    const second = vi.fn();
    const off = runner.onChange(first);
    runner.onChange(second);
    runner.start("a");
    off();
    off(); // calling it twice is harmless
    runner.next();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("gives a listener a fully updated state, and lets it call back into the runner", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("one"), plain("two"), plain("three")])], api);
    const indexes: number[] = [];
    runner.onChange(() => {
      indexes.push(runner.state.stepIndex);
      if (runner.state.stepIndex === 1) runner.next(); // e.g. a UI that skips a step
    });
    runner.start("a");
    runner.next();
    expect(runner.state.stepIndex).toBe(2);
    expect(indexes).toEqual([0, 1, 2]);
  });

  it("keeps the same state object until something changes", () => {
    const { api } = fakeLab();
    const runner = new LessonRunner([lesson("a", [plain("one"), plain("two")])], api);
    runner.start("a");
    const before = runner.state;
    runner.tick();
    expect(runner.state).toBe(before);
    runner.next();
    expect(runner.state).not.toBe(before);
  });
});
