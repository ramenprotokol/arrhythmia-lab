export function showFallback(root: HTMLElement): void {
  root.innerHTML = `
    <main style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #e8eef2">
      <h1>Arrhythmia Lab needs WebGPU</h1>
      <p>This lab runs a live heart simulation on your graphics card, and this browser doesn't offer WebGPU.</p>
      <p>It works in Chrome, Edge, Safari 26, Chrome on Android, and Firefox on Windows and Apple-silicon Macs.</p>
      <p>Educational simulation. Not a medical device.</p>
    </main>`;
}
