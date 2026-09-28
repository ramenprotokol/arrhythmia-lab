// Runs inside the browser under Playwright. Exposes the GPU classes to tests as window.lab.
import { SheetSim } from "../../src/sim/SheetSim";
import { EPI } from "../../src/model/params";

declare global {
  interface Window {
    lab: { SheetSim: typeof SheetSim; EPI: typeof EPI; device: GPUDevice };
    labReady: Promise<void>;
  }
}

window.labReady = (async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  window.lab = { SheetSim, EPI, device };
})();
