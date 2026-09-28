import { test, expect, type Page } from "@playwright/test";
import { consoleGuard } from "./consoleGuard";

const guard = consoleGuard();
test.beforeEach(({ page }) => guard.attach(page));
test.afterEach(() => guard.check());

async function open(page: Page) {
  await page.goto("/tests/ui/harness.html");
  await page.waitForFunction(() => Boolean(window.ui), undefined, { timeout: 10_000 });
}

test("records a composite of two changing canvases into a WebM clip that plays and shows both", async ({ page }, info) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const { ClipRecorder, createComposite } = await ui.loadRecorder();
    const left = ui.animatedCanvas(160, 120, 0); // red
    const right = ui.animatedCanvas(160, 120, 220); // blue
    const composite = createComposite({ width: 320, height: 120 }, [
      { source: left, rect: [0, 0, 160, 120] },
      { source: right, rect: [160, 0, 160, 120] },
    ]);
    const recorder = new ClipRecorder(composite.canvas, { fps: 30, maxSeconds: 10 });
    const started = recorder.recording;
    recorder.start();
    const whileRecording = recorder.recording;
    let second = "no error";
    try {
      recorder.start();
    } catch (e) {
      second = (e as Error).message;
    }
    await ui.sleep(1500);
    const blob = await recorder.stop();
    composite.stop();

    // does it play, and are both halves in it?
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.src = URL.createObjectURL(blob);
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("the clip does not load"));
    });
    await video.play();
    await ui.sleep(300);
    const probe = document.createElement("canvas");
    probe.width = video.videoWidth;
    probe.height = video.videoHeight;
    const ctx = probe.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    ctx.drawImage(video, 0, 0);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return {
      started,
      whileRecording,
      after: recorder.recording,
      second,
      type: blob.type,
      size: blob.size,
      width: video.videoWidth,
      height: video.videoHeight,
      // the stripes and square move, but the ground colour is the same everywhere else in each half
      leftPixel: px(40, 100),
      rightPixel: px(280, 100),
    };
  });
  const summary = `1.5 s clip of two animated canvases: ${r.type}, ${r.size} bytes, plays at ${r.width}x${r.height}`;
  console.log(summary);
  info.annotations.push({ type: "clip", description: summary });
  expect(r.started).toBe(false);
  expect(r.whileRecording).toBe(true);
  expect(r.after).toBe(false);
  expect(r.second).toMatch(/already recording/i);
  expect(r.type).toBe("video/webm");
  expect(r.size).toBeGreaterThan(2000);
  expect([r.width, r.height]).toEqual([320, 120]);
  // both layers are in the picture: red on the left, blue on the right
  expect(r.leftPixel[0]).toBeGreaterThan(r.leftPixel[2] + 20);
  expect(r.rightPixel[2]).toBeGreaterThan(r.rightPixel[0] + 20);
});

test("the composite draws its layers at their rectangles, later layers on top, and follows them until stopped", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const { createComposite } = await ui.loadRecorder();
    const solid = (w: number, h: number, colour: string) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d") as CanvasRenderingContext2D;
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, w, h);
      return { canvas: c, ctx, paint: (colour2: string) => { ctx.fillStyle = colour2; ctx.fillRect(0, 0, w, h); } };
    };
    const red = solid(50, 50, "#f00");
    const green = solid(10, 10, "#0f0");
    const blue = solid(20, 40, "#00f");
    const composite = createComposite({ width: 200, height: 100 }, [
      { source: red.canvas, rect: [0, 0, 100, 100] }, // scaled up 2x
      { source: green.canvas, rect: [40, 40, 30, 30] }, // on top of red
      { source: blue.canvas, rect: [150, 10, 20, 40] },
    ]);
    const read = () => {
      const ctx = composite.canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
      const at = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
      return { red: at(10, 10), green: at(55, 55), blue: at(160, 30), empty: at(120, 80), corner: at(199, 99) };
    };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const first = read();
    red.paint("#ff0"); // a source changes: the composite follows on the next frame
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const followed = read().red;
    composite.stop();
    red.paint("#0ff");
    await ui.sleep(120);
    const afterStop = read().red;
    red.paint("#f0f");
    composite.draw(); // draw() still works by hand after stop(), for a page that draws it in its own frame
    const manual = read().red;
    return { first, followed, afterStop, manual, size: [composite.canvas.width, composite.canvas.height], attached: composite.canvas.isConnected };
  });
  expect(r.size).toEqual([200, 100]);
  expect(r.attached).toBe(false); // it lives off screen
  expect(r.first.red).toEqual([255, 0, 0]);
  expect(r.first.green).toEqual([0, 255, 0]);
  expect(r.first.blue).toEqual([0, 0, 255]);
  expect(r.first.empty).toEqual([5, 10, 12]); // the background colour where no layer reaches
  expect(r.followed).toEqual([255, 255, 0]);
  expect(r.afterStop).toEqual([255, 255, 0]); // stop() ends the drawing loop
  expect(r.manual).toEqual([255, 0, 255]);
});

test("a layer that has no size yet, or a bad rectangle, does not stop the composite", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const { createComposite } = await ui.loadRecorder();
    const good = ui.animatedCanvas(40, 40, 120);
    const empty = document.createElement("canvas"); // 0 x 0: drawing it would throw
    empty.width = 0;
    empty.height = 0;
    const composite = createComposite({ width: 80, height: 40 }, [
      { source: empty, rect: [0, 0, 40, 40] },
      { source: good, rect: [40, 0, 40, 40] },
    ]);
    await ui.sleep(100);
    const ok = (() => {
      try {
        composite.draw();
        return true;
      } catch {
        return false;
      }
    })();
    const bad = (rect: [number, number, number, number]) => {
      try {
        createComposite({ width: 80, height: 40 }, [{ source: good, rect }]).stop();
        return "no error";
      } catch (e) {
        return `${(e as Error).name}`;
      }
    };
    const badSize = (() => {
      try {
        createComposite({ width: 0, height: 40 }, []).stop();
        return "no error";
      } catch (e) {
        return `${(e as Error).name}`;
      }
    })();
    composite.stop();
    return { ok, nan: bad([0, 0, Number.NaN, 10]), negative: bad([0, 0, -5, 10]), badSize };
  });
  expect(r.ok).toBe(true);
  expect(r.nan).toBe("RangeError");
  expect(r.negative).toBe("RangeError");
  expect(r.badSize).toBe("RangeError");
});

test("stop() when nothing is recording is refused, and start() works again after a take", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const { ClipRecorder } = await ui.loadRecorder();
    const canvas = ui.animatedCanvas(64, 48, 40);
    const recorder = new ClipRecorder(canvas, { fps: 20 });
    const idleStop = await recorder.stop().then(() => "resolved", (e: Error) => e.message);
    recorder.start();
    await ui.sleep(400);
    const first = await recorder.stop();
    const secondStop = await recorder.stop().then(() => "resolved", (e: Error) => e.message);
    recorder.start(); // a new take is allowed
    await ui.sleep(400);
    const second = await recorder.stop();
    return { idleStop, secondStop, firstType: first.type, secondType: second.type, firstSize: first.size, secondSize: second.size };
  });
  expect(r.idleStop).toMatch(/not recording/i);
  expect(r.secondStop).toMatch(/not recording/i);
  expect(r.firstType).toBe("video/webm");
  expect(r.secondType).toBe("video/webm");
  expect(r.firstSize).toBeGreaterThan(0);
  expect(r.secondSize).toBeGreaterThan(0);
});

test("stops by itself at maxSeconds, hands the clip to listeners, and keeps it for stop() if nobody listens", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const { ClipRecorder } = await ui.loadRecorder();
    const canvas = ui.animatedCanvas(64, 48, 40);

    const listened = new ClipRecorder(canvas, { fps: 20, maxSeconds: 0.6 });
    const heard: { type: string; size: number }[] = [];
    const off = listened.onAutoStop((blob) => heard.push({ type: blob.type, size: blob.size }));
    listened.start();
    await ui.sleep(1400);
    const listenedState = { recording: listened.recording, heard: heard.slice() };
    const afterListener = await listened.stop().then(() => "resolved", (e: Error) => e.message);
    off();

    const silent = new ClipRecorder(canvas, { fps: 20, maxSeconds: 0.6 });
    silent.start();
    await ui.sleep(1400);
    const silentRecording = silent.recording;
    const kept = await silent.stop();
    const keptTwice = await silent.stop().then(() => "resolved", (e: Error) => e.message);

    const unsubscribed = new ClipRecorder(canvas, { fps: 20, maxSeconds: 0.5 });
    let calls = 0;
    unsubscribed.onAutoStop(() => calls++)();
    unsubscribed.start();
    await ui.sleep(1200);
    const keptAfterUnsubscribe = await unsubscribed.stop().then((b) => b.size > 0, () => false);
    return { listenedState, afterListener, silentRecording, keptType: kept.type, keptSize: kept.size, keptTwice, calls, keptAfterUnsubscribe };
  });
  expect(r.listenedState.recording).toBe(false);
  expect(r.listenedState.heard).toHaveLength(1);
  expect(r.listenedState.heard[0].type).toBe("video/webm");
  expect(r.listenedState.heard[0].size).toBeGreaterThan(0);
  expect(r.afterListener).toMatch(/not recording/i); // the listener already took the clip
  expect(r.silentRecording).toBe(false);
  expect(r.keptType).toBe("video/webm");
  expect(r.keptSize).toBeGreaterThan(0);
  expect(r.keptTwice).toMatch(/not recording/i); // it can be collected once
  expect(r.calls).toBe(0);
  expect(r.keptAfterUnsubscribe).toBe(true);
});

test("picks the best supported WebM type, trying vp9, then vp8, then plain webm", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const { pickMimeType } = await ui.loadRecorder();
    const real = MediaRecorder.isTypeSupported;
    const run = (supported: string[]) => {
      const asked: string[] = [];
      MediaRecorder.isTypeSupported = (t: string) => {
        asked.push(t);
        return supported.includes(t);
      };
      try {
        return { picked: pickMimeType(), asked };
      } catch (e) {
        return { picked: `error: ${(e as Error).message}`, asked };
      } finally {
        MediaRecorder.isTypeSupported = real;
      }
    };
    return {
      all: run(["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]),
      vp8: run(["video/webm;codecs=vp8", "video/webm"]),
      plain: run(["video/webm"]),
      none: run([]),
      real: pickMimeType(),
    };
  });
  expect(r.all).toEqual({ picked: "video/webm;codecs=vp9", asked: ["video/webm;codecs=vp9"] });
  expect(r.vp8).toEqual({ picked: "video/webm;codecs=vp8", asked: ["video/webm;codecs=vp9", "video/webm;codecs=vp8"] });
  expect(r.plain).toEqual({ picked: "video/webm", asked: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"] });
  expect(r.none.picked).toMatch(/error: .*webm/i);
  expect(r.real).toMatch(/^video\/webm/);
});

test("says clearly that it cannot record when MediaRecorder or captureStream is missing", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const { ClipRecorder } = await ui.loadRecorder();
    const canvas = ui.animatedCanvas(64, 48, 40);
    const message = (f: () => void) => {
      try {
        f();
        return "no error";
      } catch (e) {
        return (e as Error).message;
      }
    };
    const win = window as unknown as { MediaRecorder: unknown };
    const real = win.MediaRecorder;
    const supportedNow = ClipRecorder.isSupported();

    win.MediaRecorder = undefined;
    const noRecorder = { supported: ClipRecorder.isSupported(), start: message(() => new ClipRecorder(canvas).start()) };
    win.MediaRecorder = real;

    const proto = HTMLCanvasElement.prototype as unknown as { captureStream: unknown };
    const realCapture = proto.captureStream;
    proto.captureStream = undefined;
    const noCapture = { supported: ClipRecorder.isSupported(), start: message(() => new ClipRecorder(canvas).start()) };
    proto.captureStream = realCapture;
    return { supportedNow, noRecorder, noCapture };
  });
  expect(r.supportedNow).toBe(true);
  expect(r.noRecorder.supported).toBe(false);
  expect(r.noRecorder.start).toMatch(/cannot record video/i);
  expect(r.noCapture.supported).toBe(false);
  expect(r.noCapture.start).toMatch(/cannot record video|capture/i);
});

test("the record button toggles, announces its state, and downloads a .webm through an object URL it then revokes", async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const { ui } = window;
    const { ClipRecorder, attachRecordButton } = await ui.loadRecorder();
    const canvas = ui.animatedCanvas(160, 96, 200);
    document.body.append(canvas);
    const button = document.createElement("button");
    button.id = "rec";
    document.body.append(button);
    // keep a record of the object URLs made and revoked
    const log = { created: [] as string[], revoked: [] as string[] };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (o: Blob | MediaSource) => {
      const u = create(o);
      log.created.push(u);
      return u;
    };
    URL.revokeObjectURL = (u: string) => {
      log.revoked.push(u);
      revoke(u);
    };
    (window as unknown as { urlLog: typeof log }).urlLog = log;
    attachRecordButton(button, new ClipRecorder(canvas, { fps: 30, maxSeconds: 20 }));
  });
  const button = page.locator("#rec");

  await expect(button).toHaveText("Record clip");
  await expect(button).toHaveAttribute("aria-pressed", "false");

  await button.click();
  await expect(button).toHaveText("Stop and save");
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(1200);

  const download = page.waitForEvent("download");
  await button.click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.webm$/);
  expect(file.suggestedFilename()).toBe("arrhythmia-lab-clip.webm");

  await expect(button).toHaveText("Record clip");
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await expect(button).toBeEnabled();

  // the URL is revoked afterwards, and only after the download had time to start
  await page.waitForFunction(() => (window as unknown as { urlLog: { revoked: string[] } }).urlLog.revoked.length > 0, undefined, { timeout: 5000 });
  const log = await page.evaluate(() => (window as unknown as { urlLog: { created: string[]; revoked: string[] } }).urlLog);
  expect(log.created).toHaveLength(1);
  expect(log.revoked).toEqual(log.created);

  // and the file is a real, non-trivial WebM
  const path = await file.path();
  const { statSync, readFileSync } = await import("node:fs");
  expect(statSync(path).size).toBeGreaterThan(2000);
  expect(readFileSync(path).subarray(0, 4).toString("hex")).toBe("1a45dfa3"); // the EBML header every WebM starts with

  // it can go round again
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  const again = page.waitForEvent("download");
  await page.waitForTimeout(500);
  await button.click();
  expect((await again).suggestedFilename()).toMatch(/\.webm$/);
});

test("the record button saves under the name it was given, and adds .webm if it is missing", async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const { ui } = window;
    const { ClipRecorder, attachRecordButton } = await ui.loadRecorder();
    const canvas = ui.animatedCanvas(64, 48, 10);
    document.body.append(canvas);
    for (const [id, name] of [["one", "my clip"], ["two", "already.webm"]] as const) {
      const button = document.createElement("button");
      button.id = id;
      document.body.append(button);
      attachRecordButton(button, new ClipRecorder(canvas, { fps: 20 }), name);
    }
  });
  const names: string[] = [];
  for (const id of ["one", "two"]) {
    await page.locator(`#${id}`).click();
    await page.waitForTimeout(500);
    const download = page.waitForEvent("download");
    await page.locator(`#${id}`).click();
    names.push((await download).suggestedFilename());
  }
  expect(names).toEqual(["my clip.webm", "already.webm"]);
});

test("the record button saves the clip by itself when the time limit stops the recording", async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const { ui } = window;
    const { ClipRecorder, attachRecordButton } = await ui.loadRecorder();
    const canvas = ui.animatedCanvas(64, 48, 10);
    document.body.append(canvas);
    const button = document.createElement("button");
    button.id = "rec";
    document.body.append(button);
    attachRecordButton(button, new ClipRecorder(canvas, { fps: 20, maxSeconds: 0.7 }));
  });
  const button = page.locator("#rec");
  const download = page.waitForEvent("download");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  const file = await download; // nobody pressed stop
  expect(file.suggestedFilename()).toMatch(/\.webm$/);
  await expect(button).toHaveText("Record clip");
  await expect(button).toHaveAttribute("aria-pressed", "false");
});

test("the record button is disabled with an explanation where recording is not possible, and copes with a failed start", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const { ClipRecorder, attachRecordButton } = await ui.loadRecorder();
    const canvas = ui.animatedCanvas(64, 48, 10);
    const win = window as unknown as { MediaRecorder: unknown };
    const real = win.MediaRecorder;

    win.MediaRecorder = undefined;
    const unsupported = document.createElement("button");
    attachRecordButton(unsupported, new ClipRecorder(canvas));
    win.MediaRecorder = real;

    // a start that fails part-way: the button must stay usable and say why
    const flaky = document.createElement("button");
    document.body.append(flaky);
    const failing = document.createElement("canvas");
    failing.captureStream = () => {
      throw new Error("the capture failed");
    };
    attachRecordButton(flaky, new ClipRecorder(failing));
    flaky.click();
    await ui.sleep(50);
    return {
      unsupported: { disabled: unsupported.disabled, text: unsupported.textContent, title: unsupported.title, pressed: unsupported.getAttribute("aria-pressed") },
      flaky: { disabled: flaky.disabled, text: flaky.textContent, title: flaky.title, pressed: flaky.getAttribute("aria-pressed") },
    };
  });
  expect(r.unsupported.disabled).toBe(true);
  expect(r.unsupported.text).toMatch(/not supported/i);
  expect(r.unsupported.title).toMatch(/cannot record video/i);
  expect(r.unsupported.pressed).toBe("false");
  expect(r.flaky).toEqual({ disabled: false, text: "Record clip", title: "the capture failed", pressed: "false" });
});

test("the composite can start paused and be started and stopped again without ever running two loops", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const { createComposite } = await ui.loadRecorder();
    const src = document.createElement("canvas");
    src.width = 20;
    src.height = 20;
    const ctx = src.getContext("2d") as CanvasRenderingContext2D;
    const paint = (colour: string) => {
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, 20, 20);
    };
    paint("#f00");
    const composite = createComposite({ width: 20, height: 20 }, [{ source: src, rect: [0, 0, 20, 20] }], { paused: true });
    const read = () => Array.from((composite.canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D).getImageData(5, 5, 1, 1).data).slice(0, 3);
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    await frames();
    const whilePaused = read(); // nothing has been drawn: it started paused
    composite.start();
    const drawnAtStart = read(); // start() draws at once
    paint("#0f0");
    await frames();
    const running = read();
    composite.start(); // starting again must not add a second loop
    composite.start();
    composite.stop();
    paint("#00f");
    await ui.sleep(150);
    const afterStop = read(); // a second loop would still be running and would show blue
    composite.start(); // and it can be started again
    paint("#ff0");
    await frames();
    const restarted = read();
    composite.stop();
    return { whilePaused, drawnAtStart, running, afterStop, restarted };
  });
  expect(r.whilePaused).toEqual([5, 10, 12]); // just the background
  expect(r.drawnAtStart).toEqual([255, 0, 0]);
  expect(r.running).toEqual([0, 255, 0]);
  expect(r.afterStop).toEqual([0, 255, 0]);
  expect(r.restarted).toEqual([255, 255, 0]);
});

test("a recorder switches its frame source on for the take and off again afterwards, whichever way the take ends", async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const { ui } = window;
    const { ClipRecorder } = await ui.loadRecorder();
    const canvas = ui.animatedCanvas(64, 48, 90);
    const log: string[] = [];
    const source = { start: () => log.push("start"), stop: () => log.push("stop") };
    const snapshot = () => log.splice(0);

    const byHand = new ClipRecorder(canvas, { fps: 20, frameSource: source });
    const idle = snapshot();
    byHand.start();
    const started = snapshot();
    let twice = "no error";
    try {
      byHand.start();
    } catch (e) {
      twice = (e as Error).message;
    }
    const afterSecondStart = snapshot(); // a refused start must not start the source again
    await ui.sleep(300);
    await byHand.stop();
    const stopped = snapshot();

    const limited = new ClipRecorder(canvas, { fps: 20, maxSeconds: 0.4, frameSource: source });
    limited.start();
    snapshot();
    await ui.sleep(1000);
    const atLimit = snapshot();
    await limited.stop();

    // a start that fails part-way rolls the source back
    const failing = document.createElement("canvas");
    failing.captureStream = () => {
      throw new Error("the capture failed");
    };
    const broken = new ClipRecorder(failing, { frameSource: source });
    let failure = "no error";
    try {
      broken.start();
    } catch (e) {
      failure = (e as Error).message;
    }
    return { idle, started, twice, afterSecondStart, stopped, atLimit, failure, afterFailure: snapshot(), stillRecording: broken.recording };
  });
  expect(r.idle).toEqual([]);
  expect(r.started).toEqual(["start"]);
  expect(r.twice).toMatch(/already recording/i);
  expect(r.afterSecondStart).toEqual([]);
  expect(r.stopped).toEqual(["stop"]);
  expect(r.atLimit).toEqual(["stop"]);
  expect(r.failure).toBe("the capture failed");
  expect(r.afterFailure).toEqual(["start", "stop"]);
  expect(r.stillRecording).toBe(false);
});

test("recording through a paused composite: it runs only during the take, and the saved clip has both views", async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const { ui } = window;
    const { ClipRecorder, attachRecordButton, createComposite } = await ui.loadRecorder();
    const heart = ui.animatedCanvas(160, 96, 0);
    const ecg = ui.animatedCanvas(160, 96, 220);
    const composite = createComposite({ width: 320, height: 96 }, [
      { source: heart, rect: [0, 0, 160, 96] },
      { source: ecg, rect: [160, 0, 160, 96] },
    ], { paused: true });
    const button = document.createElement("button");
    button.id = "rec";
    document.body.append(button);
    attachRecordButton(button, new ClipRecorder(composite.canvas, { fps: 30, frameSource: composite }));
    // A probe: does the composite's picture change over two frames? The sources animate every frame, so it does only
    // while the composite is drawing them.
    const ctx = composite.canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    const hash = () => {
      const data = ctx.getImageData(0, 0, 320, 96).data;
      let h = 0;
      for (let i = 0; i < data.length; i++) h = (h * 31 + data[i]) | 0;
      return h;
    };
    (window as unknown as { probe: () => Promise<boolean> }).probe = async () => {
      const before = hash();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return hash() !== before;
    };
  });
  const follows = () => page.evaluate(() => (window as unknown as { probe: () => Promise<boolean> }).probe());
  const button = page.locator("#rec");

  await page.waitForTimeout(200);
  expect(await follows(), "idle: the composite is not drawing").toBe(false);
  await button.click();
  await page.waitForTimeout(800);
  expect(await follows(), "recording: the composite is drawing").toBe(true);
  const download = page.waitForEvent("download");
  await button.click();
  const file = await download;
  await page.waitForTimeout(200);
  expect(await follows(), "afterwards: paused again").toBe(false);
  const { statSync } = await import("node:fs");
  expect(statSync(await file.path()).size).toBeGreaterThan(2000);
});
