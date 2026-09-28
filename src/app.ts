// The page: loads the heart, runs the lab engine on the GPU, draws it, and wires up the controls.
import { loadHeart, loadSurface } from "./data/loadHeart";
import { loadFrame } from "./data/heartFrame";
import { pickVoxel } from "./render/pick";
import { Simulation } from "./sim/Simulation";
import { Ecg } from "./ecg/Ecg";
import { electrodePositions } from "./ecg/electrodes";
import { Renderer } from "./render/Renderer";
import type { QualityName } from "./render/quality";
import { Monitor } from "./ui/monitor";
import { ComparePanel, parseEcgSamples } from "./ui/compare";
import { ClipRecorder, attachRecordButton, createComposite } from "./ui/recorder";
import { LessonRunner, type LabApi, type RunnerState } from "./lessons/runner";
import { LESSONS } from "./lessons/lessons";
import * as R from "./lessons/recipes";
import { CHUNK_MS, DT_MS, LabEngine } from "./lab/engine";
import { buildDom } from "./dom";

const MAX_CHUNKS_PER_FRAME = 8;
const SPEEDS = { slow: 0.25, medium: 0.5, real: 1 } as const;

const url = (path: string): string => new URL(path, document.baseURI).href;

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error(`could not load ${path}: ${res.status}`);
  return res.json();
}

function pickQuality(): QualityName {
  const q = new URLSearchParams(location.search).get("quality");
  if (q === "high" || q === "medium" || q === "low") return q;
  const phone = window.matchMedia("(max-width: 860px)").matches || navigator.maxTouchPoints > 1;
  return phone ? "medium" : "high";
}

export async function startApp(root: HTMLElement): Promise<void> {
  const ui = buildDom(root);
  ui.setLoading("Loading the heart");

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("no graphics adapter");
  const device = await adapter.requestDevice();
  let deviceLost = false;
  const debug = new URLSearchParams(location.search).has("debug");
  if (debug) {
    // Recorded for the browser tests, which fail on any GPU error the page did not catch.
    const errors: string[] = ((window as unknown as { __labErrors?: string[] }).__labErrors = []);
    device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  }
  void device.lost.then((info) => {
    deviceLost = true;
    ui.showError("The graphics card stopped responding", `${info.message || info.reason}. Reload the page to start again.`);
  });

  const [grid, surface, frame, samplesJson] = await Promise.all([
    loadHeart(url("data/heart.bin")),
    loadSurface(url("data/heart-surface.bin")),
    loadFrame(url("data/heart-frame.json")),
    fetchJson("data/ecg-samples.json"),
  ]);
  const samples = parseEcgSamples(samplesJson);

  ui.setLoading("Starting the simulation");
  const sim = await Simulation.create(device, grid, { dt: DT_MS });
  const ecg = await Ecg.create(device, sim, { positions: electrodePositions(frame) });
  const renderer = await Renderer.create(ui.heartCanvas, device, surface, grid, sim, { quality: pickQuality() });
  const monitor = new Monitor(ui.monitorCanvas);

  // One ECG sample after every chunk and every stimulus; the readback happens once per frame.
  const pendingTimes: number[] = [];
  const engine = new LabEngine(sim, {
    afterAdvance: (t) => {
      ecg.queue();
      pendingTimes.push(t);
    },
    changed: () => {
      ui.showTissue(engine.tissue);
      ui.showPacemaker(engine.pacemaker);
    },
  });
  let speed: number = SPEEDS.medium;
  let carry = 0;

  // The controls a lesson may use.
  const api: LabApi = {
    pace: (voxel) => engine.deliver(voxel, R.APEX_STIM.radiusMm, R.APEX_STIM.amp),
    prematureBeat: () => engine.extraBeat(),
    shock: () => {
      engine.shock();
      ui.flashShock();
    },
    setTissue: (t) => engine.setTissue(t),
    activeFraction: () => engine.excited,
    simTimeMs: () => engine.simTime,
    setPacemaker: (on) => engine.setPacemaker(on),
    burstPace: (beats, periodMs) => engine.startBurst(beats, periodMs),
    lastBeatMs: () => engine.lastBeatAt,
    induce: (kind) => engine.induce(kind),
    induceStatus: () => engine.inducer.state.status,
  };
  const runner = new LessonRunner(LESSONS, api);

  // ---- the frame loop ----------------------------------------------------------------------------
  const flushEcg = (): void => {
    if (pendingTimes.length === 0) return;
    const times = pendingTimes.splice(0);
    ecg
      .flush()
      .then((rows) => rows.forEach((row, i) => monitor.push(times[i], row)))
      .catch((err: unknown) => console.error("ECG readback failed", err));
  };

  let last = performance.now();
  let slowFrames = 0;
  let lastHud = 0;
  const frame_ = (now: number): void => {
    requestAnimationFrame(frame_);
    if (deviceLost) return;
    const realMs = Math.min(50, now - last);
    last = now;
    if (!document.hidden) {
      // While the lab is starting a rhythm on its own, run it faster so the viewer is not left waiting.
      const boost = engine.inducer.state.status === "running" ? 3 : 1;
      carry += realMs * speed * boost;
      let chunks = 0;
      while (carry >= CHUNK_MS && chunks < MAX_CHUNKS_PER_FRAME) {
        carry -= CHUNK_MS;
        chunks++;
        engine.advanceChunk();
      }
      if (chunks === MAX_CHUNKS_PER_FRAME) carry = 0; // fell behind: drop the backlog rather than spiral
      // A slow device should slow the simulation down, not stutter.
      slowFrames = realMs > 34 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
      if (slowFrames > 45 && speed > SPEEDS.slow) {
        speed = SPEEDS.slow;
        slowFrames = 0;
        ui.showSpeed("slow");
        ui.toast("Slowed the simulation to keep it smooth on this device.");
      }
      engine.refreshExcited();
    }
    flushEcg();
    runner.tick();
    monitor.render();
    renderer.frame();
    if (clipRecorder.recording) composite.draw();
    if (ui.labelsOn()) {
      for (const l of labelSpots) {
        const p = renderer.project(l.voxel);
        ui.placeLabel(l.id, p.x, p.y, p.visible);
      }
    } else {
      for (const l of labelSpots) ui.placeLabel(l.id, 0, 0, false);
    }
    if (now - lastHud > 200) {
      lastHud = now;
      ui.showHud(engine.simTime, engine.excited);
    }
  };

  // ---- wire up the page --------------------------------------------------------------------------
  // The canvas fills the stage, but on a wide screen the control panel and the ECG sit on top of part of it. Tell the
  // renderer how much is covered so it frames the heart in what is left.
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const onResize = (): void => {
    const s = ui.stage.getBoundingClientRect();
    renderer.resize(s.width, s.height, window.devicePixelRatio || 1);
    const m = ui.monitorCanvas.getBoundingClientRect();
    monitor.resize(m.width, m.height, window.devicePixelRatio || 1);
    const p = ui.panel.getBoundingClientRect();
    const d = ui.dock.getBoundingClientRect();
    insets.right = p.width > 0 && p.left > s.left + s.width * 0.5 ? Math.max(0, s.right - p.left) + 8 : 0;
    insets.bottom = d.height > 0 && d.top > s.top + s.height * 0.4 ? Math.max(0, s.bottom - d.top) + 8 : 0;
    renderer.setInsets(insets);
  };
  new ResizeObserver(onResize).observe(ui.stage);
  new ResizeObserver(onResize).observe(ui.monitorCanvas);
  new ResizeObserver(onResize).observe(ui.panel);
  onResize();

  renderer.onTap = (x, y) => {
    const voxel = renderer.pick(x, y);
    if (voxel) {
      engine.deliver(voxel, 4, 2);
      ui.dismissHint();
    }
  };
  ui.stage.addEventListener("pointerdown", () => ui.dismissHint(), { once: true });

  const firstBurst = R.FIBRILLATION_BURSTS[0];
  // Anatomy labels, pinned to the heart. The ventricles' labels sit on the outer wall: walk in from outside toward each
  // ventricle's centre until the first muscle.
  const wallPoint = (toward: [number, number, number]): [number, number, number] => {
    const c = frame.centroid;
    const d = [toward[0] - c[0], toward[1] - c[1], toward[2] - c[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    const u: [number, number, number] = [d[0] / len, d[1] / len, d[2] / len];
    const origin: [number, number, number] = [c[0] + u[0] * 160, c[1] + u[1] * 160, c[2] + u[2] * 160];
    return pickVoxel(grid, origin, [-u[0], -u[1], -u[2]], grid.voxelMm) ?? (frame.apexVoxel as [number, number, number]);
  };
  const labelSpots: { id: string; text: string; voxel: [number, number, number] }[] = [
    { id: "apex", text: "Apex", voxel: frame.apexVoxel.map(Math.round) as [number, number, number] },
    { id: "base", text: "Base", voxel: frame.baseVoxel.map(Math.round) as [number, number, number] },
    { id: "lv", text: "Left ventricle", voxel: wallPoint(frame.lvCentroid) },
    { id: "rv", text: "Right ventricle", voxel: wallPoint(frame.rvCentroid) },
  ];
  labelSpots.forEach((l) => ui.addLabel(l.id, l.text));

  ui.onAction({
    labels: () => undefined,
    beat: () => engine.beatAtApex(),
    extra: () => engine.extraBeat(),
    shock: () => api.shock(),
    burst: () => engine.startBurst(firstBurst.beats, firstBurst.periodMs),
    pacemaker: (on) => engine.setPacemaker(on),
    tissue: (t) => engine.setTissue(t),
    preset: (name) => engine.setTissue(name === "healthy" ? R.NORMAL_TISSUE : name === "racing" ? R.TACHYCARDIA_TISSUE : R.FIBRILLATION_TISSUE),
    cutaway: (on, depth) => renderer.setCutaway(on, depth),
    speed: (name) => (speed = SPEEDS[name]),
    ecgMode: (mode) => monitor.setMode(mode),
    lessonStart: (id) => runner.start(id),
    lessonNext: () => runner.next(),
    lessonBack: () => runner.back(),
    lessonRestart: () => runner.restart(),
    lessonStop: () => runner.stop(),
  });
  ui.renderLessons(LESSONS, runner.state);
  runner.onChange(() => ui.renderLessons(LESSONS, runner.state as RunnerState));
  ui.showTissue(engine.tissue);
  ui.showPacemaker(engine.pacemaker);
  ui.showSpeed("medium");
  if (window.matchMedia("(max-width: 860px)").matches) {
    // twelve small traces do not fit a phone: start with the one big lead
    monitor.setMode("single");
    ui.showEcgMode("single");
  }
  engine.inducer.onChange(() => {
    const s = engine.inducer.state;
    if (s.status === "running" && s.attempt > 1) ui.toast(`That timing did not take. Trying another (${s.attempt} of ${s.attempts}).`);
    if (s.status === "failed") ui.toast("This computer did not start the rhythm. Try the Extra beat button at different moments.");
  });

  const compare = new ComparePanel(ui.compareEl, samples, () => monitor.getTrace(1));
  let compareTimer = 0;
  ui.onCompareToggle((open) => {
    window.clearInterval(compareTimer);
    if (open) {
      compare.render();
      compareTimer = window.setInterval(() => compare.render(), 250);
    }
  });

  const composite = createComposite({ width: 1280, height: 720 }, [
    {
      // only the part of the heart view that is not under a panel, at its own proportions
      source: ui.heartCanvas,
      rect: [0, 0, 1280, 470],
      fit: "contain",
      backdrop: true,
      crop: () => {
        const k = ui.heartCanvas.width / Math.max(1, ui.stage.getBoundingClientRect().width);
        const w = ui.heartCanvas.width - (insets.left + insets.right) * k;
        const h = ui.heartCanvas.height - (insets.top + insets.bottom) * k;
        return [insets.left * k, insets.top * k, Math.max(1, w), Math.max(1, h)];
      },
    },
    { source: ui.monitorCanvas, rect: [0, 480, 1280, 240], fit: "contain" },
  ], { paused: true });
  // A WebGPU canvas only holds its picture during the frame it was drawn in, so the composite's own loop would copy
  // a blank heart. Stop it, and copy by hand right after rendering, only while a clip is being recorded.
  // Visitors get 30 seconds; the tool that records the demo clip can ask for longer with ?clipSeconds= (at most 2 minutes).
  const maxClipSeconds = Math.min(120, Number(new URLSearchParams(location.search).get("clipSeconds")) || 30);
  const clipRecorder = new ClipRecorder(composite.canvas, { fps: 30, maxSeconds: maxClipSeconds });
  attachRecordButton(ui.recordButton, clipRecorder, "arrhythmia-lab-clip.webm");

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "b") engine.beatAtApex();
    else if (e.key === "e") engine.extraBeat();
    else if (e.key === "s") api.shock();
    else if (e.key === "f") engine.startBurst(firstBurst.beats, firstBurst.periodMs);
  });

  // A handle for the browser tests. It does nothing unless the page is opened with ?debug.
  if (debug) {
    (window as unknown as { __lab: unknown }).__lab = {
      engine, api, runner, monitor, renderer, sim, composite,
      setSpeed: (s: number) => (speed = s),
    };
  }

  ui.clearLoading();
  requestAnimationFrame((t) => {
    last = t;
    frame_(t);
  });
}
