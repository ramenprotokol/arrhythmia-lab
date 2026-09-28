// Runs inside the browser under Playwright. Loads the real heart, builds the solver and the renderer on a
// full-window canvas, and exposes them to the tests as window.renderLab. Nothing draws by itself: tests call
// renderLab.draw(), so every frame is one they asked for. Any GPU error the page does not catch is recorded in
// window.renderGpuErrors, and the tests fail if there is one.
import { loadFrame, type HeartFrame } from "../../src/data/heartFrame";
import { loadHeart, loadSurface, type HeartGrid, type HeartSurface } from "../../src/data/loadHeart";
import { Renderer } from "../../src/render/Renderer";
import type { QualityName } from "../../src/render/quality";
import { Simulation } from "../../src/sim/Simulation";

export interface Lab {
  device: GPUDevice;
  canvas: HTMLCanvasElement;
  grid: HeartGrid;
  surface: HeartSurface;
  sim: Simulation;
  renderer: Renderer;
  /** The heart's anatomical frame, as public/data/heart-frame.json gives it. */
  frame: HeartFrame;
  /** The true apex voxel, from that frame. */
  apex: [number, number, number];
  /** Size the renderer to the window and its pixel ratio. */
  fit(): void;
  /** Draw one frame and wait until the GPU has finished it and the browser has shown it. */
  draw(): Promise<void>;
  /** Run the solver for ms of simulated time, drawing a frame every `each` ms as the app would. Nothing is awaited. */
  play(ms: number, each?: number): void;
  /** Build another renderer on a fresh canvas that is not on the page, for tests of set-up and tear-down. */
  spawn(quality?: QualityName): Promise<Renderer>;
  Renderer: typeof Renderer;
  /** Frame time in ms, averaged over n frames (after a warm-up), with the solver stepping simMs each frame. */
  measure(n: number, simMs: number): Promise<{ mean: number; min: number; max: number; p95: number; gpuMs: number | null }>;
}

declare global {
  interface Window {
    renderLab: Lab;
    renderReady: Promise<void>;
    renderGpuErrors: string[];
  }
}

window.renderGpuErrors = [];

window.renderReady = (async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter");
  const requiredFeatures: GPUFeatureName[] = adapter.features.has("timestamp-query") ? ["timestamp-query"] : [];
  const device = await adapter.requestDevice({ requiredFeatures });
  device.addEventListener("uncapturederror", (e) => window.renderGpuErrors.push((e as GPUUncapturedErrorEvent).error.message));
  void device.lost.then((info) => window.renderGpuErrors.push("device lost: " + info.message));

  const [grid, surface, frame] = await Promise.all([loadHeart("/data/heart.bin"), loadSurface("/data/heart-surface.bin"), loadFrame("/data/heart-frame.json")]);
  const sim = await Simulation.create(device, grid, { dt: 0.05 });
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const quality = (new URLSearchParams(location.search).get("quality") ?? "high") as QualityName;
  const renderer = await Renderer.create(canvas, device, surface, grid, sim, { quality, frame });
  const fit = () => renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
  fit();
  window.addEventListener("resize", fit);

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const draw = async () => {
    renderer.frame();
    await device.queue.onSubmittedWorkDone();
    await nextFrame();
  };

  const play: Lab["play"] = (ms, each = 6) => {
    for (let t = 0; t < ms; t += each) {
      sim.step(each);
      renderer.frame();
    }
  };

  const spawn: Lab["spawn"] = (q = "high") => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 200;
    return Renderer.create(c, device, surface, grid, sim, { quality: q, frame });
  };

  const measure: Lab["measure"] = async (n, simMs) => {
    for (let i = 0; i < 20; i++) {
      sim.step(simMs);
      renderer.frame();
    }
    await device.queue.onSubmittedWorkDone();
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      sim.step(simMs);
      renderer.frame();
      await device.queue.onSubmittedWorkDone();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const mean = times.reduce((s, x) => s + x, 0) / times.length;
    return { mean, min: times[0], max: times[times.length - 1], p95: times[Math.floor(times.length * 0.95)], gpuMs: null };
  };

  window.renderLab = { device, canvas, grid, surface, sim, renderer, frame, apex: frame.apexVoxel, fit, draw, play, spawn, Renderer, measure };
})();
