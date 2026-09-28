// Shown when the browser has no WebGPU. The lab runs a live heart simulation on the graphics card,
// so there is nothing to fall back to except an explanation and a recorded clip of the real thing.

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
