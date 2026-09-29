// The fonts are served from this site with the page (the strict content policy allows nothing else): latin only.
import "@fontsource/instrument-sans/latin-400.css";
import "@fontsource/instrument-sans/latin-600.css";
import "@fontsource/instrument-sans/latin-700.css";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./style.css";
import { showFallback } from "./fallback";

export async function hasWebGPU(): Promise<boolean> {
  if (!("gpu" in navigator)) return false;
  try {
    return (await navigator.gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) return;
  if (!(await hasWebGPU())) {
    showFallback(root);
    return;
  }
  try {
    // The whole lab is loaded only when the browser can run it, so the fallback page stays tiny.
    const { startApp } = await import("./app");
    await startApp(root);
  } catch (err) {
    console.error(err);
    showFallback(root, err instanceof Error ? err.message : String(err));
  }
}

void boot();
