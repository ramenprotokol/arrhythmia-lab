// Record-a-clip: draw the heart view and the ECG monitor into one off-screen canvas, record that canvas as WebM
// with MediaRecorder, and hand the file to the browser as a download. The clip is made and kept in the page. It
// is never uploaded anywhere.
import { INK } from "./ecgPaper";

type Rect = [x: number, y: number, w: number, h: number];
/**
 * One picture in the clip. `rect` is where it goes. `crop` picks part of the source (in the source's own pixels; a
 * function is asked every frame, for a view that changes) and `fit` says how the picture meets `rect`: stretch it
 * (the default), fit all of it inside with empty bars, or fill the rectangle and trim the overflow.
 */
export type Layer = {
  source: HTMLCanvasElement;
  rect: Rect;
  crop?: Rect | (() => Rect);
  fit?: "stretch" | "contain" | "cover";
  /** With `fit: "contain"`, first fill the bars with a soft blurred copy of the same picture, so the edges melt into them. */
  backdrop?: boolean;
};

const finitePositive = (n: number): boolean => Number.isFinite(n) && n > 0;

/**
 * Draw `layers` into one off-screen canvas on every animation frame, in order, so later layers sit on top. A source
 * is scaled to its rectangle. Record `canvas` with a ClipRecorder.
 *
 * It draws two canvases every frame for as long as it runs, so a page that records only now and then should create it
 * with `paused: true` and let the recorder start it for the take (see `frameSource` on ClipRecorder), or call
 * `start()` and `stop()` itself. `draw()` paints one frame by hand. A WebGPU canvas only holds its picture for the
 * frame it was drawn in, so a page whose heart view is WebGPU should call `draw()` right after rendering it, in the
 * same frame.
 */
export function createComposite(
  size: { width: number; height: number },
  layers: readonly Layer[],
  opts: { paused?: boolean } = {},
): { canvas: HTMLCanvasElement; draw(): void; start(): void; stop(): void } {
  if (!finitePositive(size.width) || !finitePositive(size.height)) throw new RangeError(`composite size must be more than 0, got ${size.width} x ${size.height}`);
  for (const { rect } of layers) {
    if (!rect.every(Number.isFinite) || rect[2] <= 0 || rect[3] <= 0) throw new RangeError(`layer rectangle must be [x, y, width, height] with a positive size, got [${rect.join(", ")}]`);
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(size.width);
  canvas.height = Math.round(size.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Could not make a 2D canvas for the clip.");
  ctx.fillStyle = INK.paper;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const draw = (): void => {
    ctx.fillStyle = INK.paper;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const layer of layers) {
      const { source, rect } = layer;
      if (source.width === 0 || source.height === 0) continue; // a canvas with no size yet cannot be drawn
      const crop = typeof layer.crop === "function" ? layer.crop() : layer.crop;
      const [sx, sy, sw, sh] = crop ?? [0, 0, source.width, source.height];
      if (!(sw > 0 && sh > 0)) continue;
      const [dx, dy, dw, dh] = rect;
      const fit = layer.fit ?? "stretch";
      if (fit === "contain") {
        if (layer.backdrop) {
          const kb = Math.max(dw / sw, dh / sh);
          ctx.save();
          ctx.beginPath();
          ctx.rect(dx, dy, dw, dh);
          ctx.clip();
          ctx.filter = "blur(28px) brightness(0.75)";
          ctx.drawImage(source, sx + (sw - dw / kb) / 2, sy + (sh - dh / kb) / 2, dw / kb, dh / kb, dx - 40, dy - 40, dw + 80, dh + 80);
          ctx.restore();
        }
        const k = Math.min(dw / sw, dh / sh);
        ctx.drawImage(source, sx, sy, sw, sh, dx + (dw - sw * k) / 2, dy + (dh - sh * k) / 2, sw * k, sh * k);
      } else if (fit === "cover") {
        const k = Math.max(dw / sw, dh / sh);
        const cw = dw / k;
        const ch = dh / k;
        ctx.drawImage(source, sx + (sw - cw) / 2, sy + (sh - ch) / 2, cw, ch, dx, dy, dw, dh);
      } else {
        ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
      }
    }
  };

  let handle = 0;
  let running = false;
  const frame = (): void => {
    if (!running) return;
    draw();
    handle = requestAnimationFrame(frame);
  };
  const start = (): void => {
    if (running) return;
    running = true;
    frame();
  };
  const stop = (): void => {
    running = false;
    cancelAnimationFrame(handle);
  };
  if (!opts.paused) start();

  return { canvas, draw, start, stop };
}

const MIME_TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"] as const;

/** The best WebM type this browser can record: vp9, then vp8, then plain webm. Throws if there is none. */
export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") throw new Error("This browser cannot record video: MediaRecorder is not available.");
  for (const type of MIME_TYPES) if (MediaRecorder.isTypeSupported(type)) return type;
  throw new Error("This browser cannot record video: it cannot make WebM files.");
}

type Take = { recorder: MediaRecorder; done: Promise<Blob>; timer: number };

/** Something that draws the recorded canvas, and is switched on only while a recording is going: a composite. */
export type FrameSource = { start(): void; stop(): void };

export class ClipRecorder {
  private readonly fps: number;
  private readonly maxSeconds: number;
  private readonly frameSource: FrameSource | undefined;
  private take: Take | null = null;
  /** A clip that the time limit finished and nobody was waiting for. stop() hands it over once. */
  private pending: Promise<Blob> | null = null;
  private readonly listeners = new Set<{ fn: (clip: Blob) => void }>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    opts: { fps?: number; maxSeconds?: number; frameSource?: FrameSource } = {},
  ) {
    this.fps = opts.fps ?? 30;
    this.maxSeconds = opts.maxSeconds ?? 30;
    this.frameSource = opts.frameSource;
    if (!finitePositive(this.fps)) throw new RangeError(`fps must be more than 0, got ${this.fps}`);
    if (!finitePositive(this.maxSeconds)) throw new RangeError(`maxSeconds must be more than 0, got ${this.maxSeconds}`);
  }

  /** Why this browser cannot record, or null if it can. */
  static unsupportedReason(): string | null {
    if (typeof HTMLCanvasElement === "undefined" || typeof HTMLCanvasElement.prototype.captureStream !== "function") {
      return "This browser cannot record video: it cannot capture a canvas.";
    }
    try {
      pickMimeType();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  static isSupported(): boolean {
    return ClipRecorder.unsupportedReason() === null;
  }

  get recording(): boolean {
    return this.take !== null;
  }

  start(): void {
    if (this.take) throw new Error("Already recording. Call stop() first.");
    const reason = ClipRecorder.unsupportedReason();
    if (reason) throw new Error(reason);

    this.frameSource?.start(); // draws at once, so the stream has a picture from its first frame
    let stream: MediaStream | undefined;
    let recorder: MediaRecorder;
    try {
      stream = this.canvas.captureStream(this.fps);
      recorder = new MediaRecorder(stream, { mimeType: pickMimeType(), videoBitsPerSecond: 4_000_000 });
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      this.frameSource?.stop();
      throw e;
    }
    const liveStream = stream;

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const done = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => {
        liveStream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(chunks, { type: "video/webm" }));
      };
      recorder.onerror = (e) => {
        liveStream.getTracks().forEach((t) => t.stop());
        reject((e as Event & { error?: Error }).error ?? new Error("The recording failed."));
      };
    });
    done.catch(() => undefined); // if nobody collects a failed clip, that is not an unhandled rejection

    this.pending = null;
    recorder.start(250);
    this.take = { recorder, done, timer: window.setTimeout(() => this.finishAtLimit(), this.maxSeconds * 1000) };
  }

  /** Stop and resolve with the clip (type video/webm). Rejects if nothing is recording. */
  async stop(): Promise<Blob> {
    const take = this.take;
    if (!take) {
      const kept = this.pending;
      if (kept) {
        this.pending = null;
        return kept;
      }
      throw new Error("Not recording. Call start() first.");
    }
    this.take = null;
    window.clearTimeout(take.timer);
    if (take.recorder.state !== "inactive") take.recorder.stop();
    this.frameSource?.stop();
    return take.done;
  }

  /**
   * Called with the clip when the time limit stops a recording. While anyone is listening the clip goes to them and
   * not to stop(). Returns a function that removes the listener.
   */
  onAutoStop(listener: (clip: Blob) => void): () => void {
    const entry = { fn: listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  private finishAtLimit(): void {
    const take = this.take;
    if (!take) return;
    this.take = null;
    if (take.recorder.state !== "inactive") take.recorder.stop();
    this.frameSource?.stop();
    if (this.listeners.size === 0) {
      this.pending = take.done;
      return;
    }
    take.done.then(
      (clip) => [...this.listeners].forEach((l) => l.fn(clip)),
      () => undefined,
    );
  }
}

const RECORD_LABEL = "Record clip";
const STOP_LABEL = "Stop and save";
const DEFAULT_FILENAME = "arrhythmia-lab-clip.webm";

/** Hand a clip to the browser as a download. The object URL is revoked a moment later, once the download has started. */
function download(clip: Blob, filename: string): void {
  const url = URL.createObjectURL(clip);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Make `button` start and stop `recorder`, and save the clip as a download when it stops (or when the time limit
 * stops it). The button says what it will do and reports its state with aria-pressed. Where the browser cannot
 * record, the button is disabled and its title says why.
 */
export function attachRecordButton(button: HTMLButtonElement, recorder: ClipRecorder, filename: string = DEFAULT_FILENAME): void {
  const name = filename.toLowerCase().endsWith(".webm") ? filename : `${filename}.webm`;
  const show = (recording: boolean): void => {
    button.textContent = recording ? STOP_LABEL : RECORD_LABEL;
    button.setAttribute("aria-pressed", String(recording));
    button.disabled = false;
  };

  const reason = ClipRecorder.unsupportedReason();
  if (reason) {
    button.textContent = "Recording not supported";
    button.title = reason;
    button.setAttribute("aria-pressed", "false");
    button.disabled = true;
    return;
  }

  show(false);
  recorder.onAutoStop((clip) => {
    download(clip, name);
    show(false);
  });
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    try {
      if (!recorder.recording) {
        recorder.start();
        button.title = "";
        show(true);
        return;
      }
      button.disabled = true; // while the last chunk is written
      download(await recorder.stop(), name);
    } catch (e) {
      button.title = e instanceof Error ? e.message : "Recording failed.";
    } finally {
      if (!recorder.recording) show(false);
    }
  });
}
