// The clip recorder's rules that do not need a real browser: what ?clipSeconds= may ask for, a start that fails part-way, and
// the record button in the moment after the time limit has stopped a take. The browser's own parts (the canvas, MediaRecorder,
// the clock, the page) are stand-ins here, so the moment the last chunk arrives is the test's to choose.
// tests/ui/recorder.spec.ts records real clips in real Chrome.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipRecorder, attachRecordButton, clipSecondsFromQuery } from "../../src/ui/recorder";

class FakeTrack {
  readyState: "live" | "ended" = "live";
  stop(): void {
    this.readyState = "ended";
  }
  clone(): FakeTrack {
    return new FakeTrack();
  }
}

class FakeStream {
  readonly tracks: FakeTrack[] = [new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return [];
  }
  addTrack(track: FakeTrack): void {
    this.tracks.push(track);
  }
}

/** A MediaRecorder that does what it is told and nothing on its own: the last chunk arrives when a test calls finish(). */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static startThrows: Error | null = null;
  static isTypeSupported(): boolean {
    return true;
  }
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly stream: FakeStream) {
    FakeMediaRecorder.instances.push(this);
  }
  start(): void {
    if (FakeMediaRecorder.startThrows) throw FakeMediaRecorder.startThrows;
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
  }
  /** The browser hands over the last chunk and says the recorder has stopped. */
  finish(): void {
    this.ondataavailable?.({ data: new Blob(["webm"]) });
    this.onstop?.();
  }
}

/** Just the parts of a button that the record button uses. */
class FakeButton {
  textContent = "";
  title = "";
  disabled = false;
  private readonly attributes = new Map<string, string>();
  private readonly handlers: (() => Promise<void> | void)[] = [];
  readonly classes = new Set<string>();
  readonly classList = { toggle: (name: string, on: boolean): void => void (on ? this.classes.add(name) : this.classes.delete(name)) };
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(_type: "click", handler: () => Promise<void> | void): void {
    this.handlers.push(handler);
  }
  /** A click, resolved once everything the click handler does has finished. */
  async click(): Promise<void> {
    for (const handler of this.handlers) await handler();
  }
}

const downloads: { href: string; download: string }[] = [];
/** Let the promise callbacks that are already waiting run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.startThrows = null;
  downloads.length = 0;
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("HTMLCanvasElement", class { captureStream(): void {} }); // only its shape is looked at
  vi.stubGlobal("window", globalThis); // the recorder asks window for its timers
  vi.stubGlobal("document", {
    createElement: () => ({
      style: {},
      href: "",
      download: "",
      click() {
        downloads.push({ href: this.href, download: this.download });
      },
      remove() {},
    }),
    body: { append() {} },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const canvasOf = (stream: FakeStream = new FakeStream()): HTMLCanvasElement => ({ captureStream: () => stream }) as unknown as HTMLCanvasElement;
const asButton = (button: FakeButton): HTMLButtonElement => button as unknown as HTMLButtonElement;

describe("?clipSeconds= (how long a clip may run)", () => {
  it("is 30 seconds unless the address asks for something else", () => {
    expect(clipSecondsFromQuery("")).toBe(30);
    expect(clipSecondsFromQuery("?debug&quality=low")).toBe(30);
    expect(clipSecondsFromQuery("?clipSeconds=")).toBe(30);
  });

  it("takes a number of seconds, up to 2 minutes", () => {
    expect(clipSecondsFromQuery("?clipSeconds=90")).toBe(90);
    expect(clipSecondsFromQuery("?debug&quality=high&clipSeconds=45.5")).toBe(45.5);
    expect(clipSecondsFromQuery("?clipSeconds=120")).toBe(120);
    expect(clipSecondsFromQuery("?clipSeconds=600")).toBe(120);
    expect(clipSecondsFromQuery("?clipSeconds=Infinity")).toBe(120);
  });

  it("raises a number below one second to one second, so a clip is never too short to record", () => {
    for (const asked of ["-1", "0", "0.2", "-Infinity"]) expect(clipSecondsFromQuery(`?clipSeconds=${asked}`), asked).toBe(1);
  });

  it("ignores anything that is not a number", () => {
    for (const asked of ["abc", "NaN", "12abc", "1,5", "%20"]) expect(clipSecondsFromQuery(`?clipSeconds=${asked}`), asked).toBe(30);
  });

  it("always gives the recorder a length it accepts (a bad address used to stop the whole page from starting)", () => {
    for (const asked of ["-1", "0", "abc", "", "1e400", "-1e400", "0.0001"]) {
      const maxSeconds = clipSecondsFromQuery(`?clipSeconds=${asked}`);
      expect(() => new ClipRecorder(canvasOf(), { maxSeconds }), asked).not.toThrow();
    }
  });
});

describe("a take that cannot start", () => {
  it("stops the capture's tracks and the frame source, and leaves no time limit running", () => {
    const stream = new FakeStream();
    const log: string[] = [];
    const recorder = new ClipRecorder(canvasOf(stream), { frameSource: { start: () => log.push("start"), stop: () => log.push("stop") } });
    FakeMediaRecorder.startThrows = new Error("the recorder would not start");
    expect(() => recorder.start()).toThrow("the recorder would not start");
    expect(stream.tracks.map((t) => t.readyState)).toEqual(["ended"]); // an open capture would keep the canvas being copied
    expect(log).toEqual(["start", "stop"]);
    expect(recorder.recording).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can be tried again, and the clip the last take left is still there for stop()", async () => {
    const recorder = new ClipRecorder(canvasOf(), { maxSeconds: 1 });
    recorder.start();
    vi.advanceTimersByTime(1000); // the time limit; nobody is listening, so stop() will hand the clip over
    FakeMediaRecorder.instances[0].finish();
    FakeMediaRecorder.startThrows = new Error("the recorder would not start");
    expect(() => recorder.start()).toThrow();
    FakeMediaRecorder.startThrows = null;
    expect((await recorder.stop()).size).toBeGreaterThan(0);
    recorder.start(); // and a start that works still works
    expect(recorder.recording).toBe(true);
  });
});

describe("the record button", () => {
  const setUp = (maxSeconds = 1) => {
    const recorder = new ClipRecorder(canvasOf(), { maxSeconds });
    const button = new FakeButton();
    attachRecordButton(asButton(button), recorder, "clip.webm");
    return { recorder, button, take: (n = 0) => FakeMediaRecorder.instances[n] };
  };

  it("starts a take with a click, and saves it and goes back to 'Record clip' with the next", async () => {
    const { recorder, button, take } = setUp(30);
    expect(button.textContent).toBe("Record clip");
    await button.click();
    expect(recorder.recording).toBe(true);
    expect(button.textContent).toBe("Stop and save");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    const stopping = button.click(); // waits for the last chunk
    expect(button.disabled).toBe(true);
    take().finish();
    await stopping;
    expect(downloads).toEqual([{ href: expect.stringMatching(/^blob:/) as string, download: "clip.webm" }]);
    expect(button.textContent).toBe("Record clip");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.disabled).toBe(false);
    expect(recorder.recording).toBe(false);
  });

  it("ignores a click in the moment after the time limit has stopped the take, then saves that clip and says 'Record clip'", async () => {
    const { recorder, button, take } = setUp();
    await button.click();
    vi.advanceTimersByTime(1000); // the time limit: the take is stopped, and its last chunk is still on the way
    expect(recorder.recording).toBe(false);
    expect(button.textContent).toBe("Stop and save"); // the button cannot know yet

    await button.click(); // a click in that moment must not start another take
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(recorder.recording).toBe(false);
    expect(button.textContent).toBe("Stop and save");

    take().finish(); // the last chunk arrives
    await settle();
    expect(downloads).toHaveLength(1);
    expect(button.textContent).toBe("Record clip");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.disabled).toBe(false);
    expect(recorder.recording).toBe(false);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it("takes a click again once that clip is saved", async () => {
    const { recorder, button, take } = setUp();
    await button.click();
    vi.advanceTimersByTime(1000);
    take().finish();
    await settle();
    await button.click();
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(recorder.recording).toBe(true);
    expect(button.textContent).toBe("Stop and save");
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("is not left deaf to clicks when the last chunk never comes (the recorder failed)", async () => {
    const { recorder, button, take } = setUp();
    await button.click();
    vi.advanceTimersByTime(1000);
    take().onerror?.({ error: new Error("the encoder failed") });
    await settle();
    expect(recorder.saving).toBe(false);
    await button.click(); // nothing is being saved any more, so this is a new take
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(recorder.recording).toBe(true);
  });
});
