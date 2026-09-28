// Runs inside the browser under Playwright. Exposes the GPU classes to tests as window.lab.
import { SheetSim } from "../../src/sim/SheetSim";
import { EPI } from "../../src/model/params";
import { Simulation } from "../../src/sim/Simulation";
import { loadHeart } from "../../src/data/loadHeart";
import { blockGrid, jaggedGrid } from "./synthGrid";

declare global {
  interface Window {
    lab: {
      SheetSim: typeof SheetSim;
      Simulation: typeof Simulation;
      EPI: typeof EPI;
      device: GPUDevice;
      loadHeart: typeof loadHeart;
      blockGrid: typeof blockGrid;
      jaggedGrid: typeof jaggedGrid;
    };
    labReady: Promise<void>;
    gpuErrors: string[];
  }
}

window.gpuErrors = [];

window.labReady = (async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  // Any GPU error the page does not catch is recorded, and the tests fail if there is one.
  device.addEventListener("uncapturederror", (e) => window.gpuErrors.push((e as GPUUncapturedErrorEvent).error.message));
  window.lab = { SheetSim, Simulation, EPI, device, loadHeart, blockGrid, jaggedGrid };
})();
