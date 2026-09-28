// Runs inside the browser under Playwright. Exposes what the ECG tests need as window.ecgLab.
// Deliberately separate from tests/gpu/harness.ts (own page, own global names) so the two never collide.
import { Simulation } from "../../src/sim/Simulation";
import { Ecg, ECG_GAIN_MV, ECG_RING_SLOTS, createCheckedModule } from "../../src/ecg/Ecg";
import { electrodePositions } from "../../src/ecg/electrodes";
import { leadsFromElectrodes } from "../../src/ecg/leads";
import { loadHeart } from "../../src/data/loadHeart";
import { loadFrame } from "../../src/data/heartFrame";
import { blockGrid, jaggedGrid, mulberry32 } from "../gpu/synthGrid";
import { referencePotentials } from "./ecgReference";

declare global {
  interface Window {
    ecgLab: {
      Simulation: typeof Simulation;
      Ecg: typeof Ecg;
      ECG_GAIN_MV: number;
      ECG_RING_SLOTS: number;
      createCheckedModule: typeof createCheckedModule;
      electrodePositions: typeof electrodePositions;
      leadsFromElectrodes: typeof leadsFromElectrodes;
      loadHeart: typeof loadHeart;
      loadFrame: typeof loadFrame;
      blockGrid: typeof blockGrid;
      jaggedGrid: typeof jaggedGrid;
      mulberry32: typeof mulberry32;
      referencePotentials: typeof referencePotentials;
      device: GPUDevice;
    };
    ecgReady: Promise<void>;
    ecgGpuErrors: string[];
  }
}

window.ecgGpuErrors = [];

window.ecgReady = (async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const device = await adapter.requestDevice();
  // A shader or pipeline error does not throw, it makes the GPU do nothing. Any GPU error the page does
  // not catch is recorded here, and every test fails if there is one.
  device.addEventListener("uncapturederror", (e) => window.ecgGpuErrors.push((e as GPUUncapturedErrorEvent).error.message));
  window.ecgLab = {
    Simulation,
    Ecg,
    ECG_GAIN_MV,
    ECG_RING_SLOTS,
    createCheckedModule,
    electrodePositions,
    leadsFromElectrodes,
    loadHeart,
    loadFrame,
    blockGrid,
    jaggedGrid,
    mulberry32,
    referencePotentials,
    device,
  };
})();
