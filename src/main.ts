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
