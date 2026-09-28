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
  root.textContent = "WebGPU ready.";
}

void boot();
