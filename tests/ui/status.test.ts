// What the status card says for each state of the heart (src/ui/status.ts). The words themselves come from src/copy.ts,
// so these check which words are picked, and the numbers and the colour family around them.
import { describe, it, expect } from "vitest";
import { NO_RATE, statusKey, statusView, type StatusInput } from "../../src/ui/status";
import { HUD, RHYTHM_COPY, STARTING_MESSAGE } from "../../src/copy";
import { UI_TEXT } from "../../src/ui/text";
import type { RhythmState } from "../../src/audio/rhythm";

const rhythm = (kind: RhythmState["kind"], bpm: number | null = null, output = 0): RhythmState => ({ kind, bpm, output, sinceMs: 0 });
const input = (over: Partial<StatusInput> = {}): StatusInput => ({ rhythm: rhythm("steady", 75, 1), extra: false, resetting: false, starting: null, settling: null, pacing: true, ...over });

describe("which state the card shows", () => {
  it("names the rhythm the analyser reads", () => {
    expect(statusKey(input())).toBe("steady");
    expect(statusKey(input({ rhythm: rhythm("racing", 268, 0.1) }))).toBe("racing");
    expect(statusKey(input({ rhythm: rhythm("chaotic") }))).toBe("chaotic");
    expect(statusKey(input({ rhythm: rhythm("quiet"), pacing: false }))).toBe("quiet");
  });

  it("puts the lab setting a rhythm up first, then the pause after a shock, then an extra beat", () => {
    expect(statusKey(input({ starting: "racing", resetting: true, extra: true }))).toBe("starting");
    expect(statusKey(input({ resetting: true, extra: true }))).toBe("resetting");
    expect(statusKey(input({ extra: true }))).toBe("extra");
  });

  it("does not call a racing or fibrillating heart an extra beat", () => {
    expect(statusKey(input({ rhythm: rhythm("racing", 268, 0.1), extra: true }))).toBe("racing");
    expect(statusKey(input({ rhythm: rhythm("chaotic"), extra: true }))).toBe("chaotic");
  });

  it("names a rhythm the lab has just started before the analyser has caught up, but not over a shock or a start", () => {
    expect(statusKey(input({ settling: "racing", rhythm: rhythm("quiet") }))).toBe("racing");
    expect(statusKey(input({ settling: "fibrillation", rhythm: rhythm("steady", 75, 1) }))).toBe("chaotic");
    expect(statusKey(input({ settling: "racing", resetting: true }))).toBe("resetting");
    expect(statusKey(input({ settling: "racing", starting: "fibrillation" }))).toBe("starting");
  });

  it("does not say the steady beat is off while it is on and the analyser is only waiting for its first beats", () => {
    expect(statusKey(input({ rhythm: rhythm("quiet"), pacing: true }))).toBe("steady");
    expect(statusKey(input({ rhythm: rhythm("quiet"), pacing: false }))).toBe("quiet");
  });
});

describe("what the card says", () => {
  it("a steady rhythm: its name, the rate, five bars, the teacher's sentence and what to try", () => {
    const v = statusView(input());
    expect(v).toMatchObject({ key: "steady", tone: "ok", name: RHYTHM_COPY.steady.name, value: "75", unit: HUD.rateUnit, bars: 5, pumping: RHYTHM_COPY.steady.pumping, busy: false });
    expect(v.sentence).toBe(RHYTHM_COPY.steady.sentence);
    expect(v.next).toBe(RHYTHM_COPY.steady.next);
    expect(v.medicalName).toBeNull();
  });

  it("a beating rhythm whose rate is not counted yet shows a dash and says it is counting beats", () => {
    const v = statusView(input({ rhythm: rhythm("steady", null, 1) }));
    expect(v.value).toBe(NO_RATE);
    expect(v.unit).toBe(UI_TEXT.countingBeats);
    // the steady beat on, the analyser still quiet: the same
    expect(statusView(input({ rhythm: rhythm("quiet"), pacing: true })).unit).toBe(UI_TEXT.countingBeats);
    // once there is a rate, it is per minute
    expect(statusView(input()).unit).toBe(HUD.rateUnit);
  });

  it("an early extra beat is amber, still pumping, with its medical name", () => {
    const v = statusView(input({ extra: true }));
    expect(v).toMatchObject({ key: "extra", tone: "notice", name: RHYTHM_COPY.extra.name, medicalName: RHYTHM_COPY.extra.medicalName, value: "75", bars: 4 });
  });

  it("a racing rhythm is red, shows its rate and at most one bar", () => {
    const v = statusView(input({ rhythm: rhythm("racing", 267.6, 0.12) }));
    expect(v).toMatchObject({ key: "racing", tone: "alarm", name: RHYTHM_COPY.racing.name, medicalName: RHYTHM_COPY.racing.medicalName, value: "268", unit: HUD.rateUnit });
    expect(v.bars).toBeLessThanOrEqual(1);
    expect(v.next).toBe(RHYTHM_COPY.racing.next);
  });

  it("fibrillation is red with no countable beats and no bars", () => {
    const v = statusView(input({ rhythm: rhythm("chaotic", null, 0.02) }));
    expect(v).toMatchObject({ key: "chaotic", tone: "alarm", name: RHYTHM_COPY.chaotic.name, value: NO_RATE, unit: HUD.noRate, bars: 0, pumping: RHYTHM_COPY.chaotic.pumping });
  });

  it("after a shock: grey, no rate yet, not pumping yet", () => {
    const v = statusView(input({ rhythm: rhythm("quiet"), resetting: true }));
    expect(v).toMatchObject({ key: "resetting", tone: "idle", name: RHYTHM_COPY.resetting.name, value: NO_RATE, unit: HUD.noRate, bars: 0, pumping: RHYTHM_COPY.resetting.pumping });
  });

  it("no beats: grey, with the teacher's words about the steady beat being off", () => {
    const v = statusView(input({ rhythm: rhythm("quiet"), pacing: false }));
    expect(v).toMatchObject({ key: "quiet", tone: "idle", name: RHYTHM_COPY.quiet.name, sentence: RHYTHM_COPY.quiet.sentence, value: NO_RATE });
  });

  it("while the lab sets a rhythm up: busy, cyan, the starting message for that rhythm, no rate and no next step", () => {
    for (const kind of ["racing", "fibrillation"] as const) {
      const v = statusView(input({ starting: kind }));
      expect(v).toMatchObject({ key: "starting", tone: "info", busy: true, value: "", next: "", sentence: STARTING_MESSAGE[kind] });
    }
    // a racing rhythm is started by timing one beat; fibrillation by a burst of them
    expect(statusView(input({ starting: "racing" })).name).toBe(UI_TEXT.starting);
    expect(statusView(input({ starting: "fibrillation" })).name).toBe(UI_TEXT.startingFibrillation);
  });

  it("a rhythm that is still settling gets its own card, with no rate until the analyser reads it", () => {
    const racing = statusView(input({ settling: "racing", rhythm: rhythm("steady", 75, 1) }));
    expect(racing).toMatchObject({ key: "racing", tone: "alarm", name: RHYTHM_COPY.racing.name, value: NO_RATE, unit: UI_TEXT.countingBeats, next: RHYTHM_COPY.racing.next });
    const read = statusView(input({ settling: "racing", rhythm: rhythm("racing", 240, 0.2) }));
    expect(read.value).toBe("240");
    const fib = statusView(input({ settling: "fibrillation", rhythm: rhythm("quiet") }));
    expect(fib).toMatchObject({ key: "chaotic", tone: "alarm", name: RHYTHM_COPY.chaotic.name, value: NO_RATE, unit: HUD.noRate, bars: 0 });
  });

  it("never shows a rate for a rhythm with no countable beats, whatever the analyser's last number was", () => {
    expect(statusView(input({ rhythm: rhythm("chaotic", 300, 0) })).value).toBe(NO_RATE);
    expect(statusView(input({ rhythm: rhythm("quiet", 75, 0), pacing: false })).value).toBe(NO_RATE);
  });
});
