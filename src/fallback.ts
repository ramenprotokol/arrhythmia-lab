// Shown when the browser has no WebGPU. The lab runs a live heart simulation on the graphics card,
// so there is nothing to fall back to except an explanation and a recorded clip of the real thing.
// A lab that fails to start for any other reason gets its own, plainer page (showStartupFailure).
import { UI_TEXT, fill } from "./ui/text";

/** The graphics card gave no adapter: the one failure while starting that really is WebGPU being unavailable. */
export class NoWebGpuError extends Error {
  constructor(message = "no graphics adapter") {
    super(message);
    this.name = "NoWebGpuError";
  }
}

export function showFallback(root: HTMLElement, reason?: string): void {
  root.innerHTML = `
    <main class="overlay" role="main">
      <div>
        <h2>Arrhythmia Lab needs WebGPU</h2>
        <p>This lab runs a live heart simulation on your graphics card, and this browser does not offer WebGPU${reason ? ` (${escapeHtml(reason)})` : ""}.</p>
        <p>It works in Chrome, Edge, Safari 26, Chrome on Android, and Firefox on Windows and Apple-silicon Macs.</p>
        <video id="fallback-clip" controls muted loop playsinline preload="metadata" aria-label="A recorded clip of the lab: a wave crossing the heart, breaking into fibrillation, and a shock stopping it" hidden>
          <source src="data/demo.webm" type="video/webm" />
        </video>
        <p class="muted" id="fallback-note" hidden>Above: a recorded clip of the lab.</p>
        <p class="muted">Educational simulation. Not a medical device.</p>
      </div>
    </main>`;
  // Only reveal the clip if the browser can play it and the file really exists.
  const video = root.querySelector<HTMLVideoElement>("#fallback-clip");
  const note = root.querySelector<HTMLElement>("#fallback-note");
  if (video && video.canPlayType("video/webm") !== "") {
    video.addEventListener("loadedmetadata", () => {
      video.hidden = false;
      if (note) note.hidden = false;
    });
    video.load();
  }
}

/**
 * The page for a lab that failed to start. Only a missing WebGPU gets the "needs WebGPU" explanation; anything else (a
 * file that would not load, a shader the graphics card refused) says the lab could not start, and why.
 */
export function showStartupFailure(root: HTMLElement, err: unknown): void {
  const reason = err instanceof Error ? err.message || err.name : String(err);
  if (err instanceof NoWebGpuError) showFallback(root, reason);
  else showCouldNotStart(root, reason);
}

/** The console has the whole message; the page only needs enough to say what went wrong. */
const MAX_REASON_LENGTH = 200;

function showCouldNotStart(root: HTMLElement, reason: string): void {
  const shown = reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH)}…` : reason;
  root.innerHTML = `
    <main class="overlay" role="main">
      <div>
        <h2>${escapeHtml(UI_TEXT.startFailedTitle)}</h2>
        <p>${escapeHtml(UI_TEXT.startFailed)}</p>
        <p class="muted">${escapeHtml(fill(UI_TEXT.startFailedReason, { reason: shown }))}</p>
      </div>
    </main>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
