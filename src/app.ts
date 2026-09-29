// The page: loads the heart, runs the lab engine on the GPU, draws it, and wires up the controls.
import { loadAnatomy, loadHeart, loadSurface } from "./data/loadHeart";
import { loadFrame } from "./data/heartFrame";
import { pickVoxel } from "./render/pick";
import { Simulation } from "./sim/Simulation";
import { Ecg } from "./ecg/Ecg";
import { electrodePositions } from "./ecg/electrodes";
import { AutoLead } from "./ecg/autoLead";
import { Renderer } from "./render/Renderer";
import type { QualityName } from "./render/quality";
import { Monitor } from "./ui/monitor";
import { ComparePanel, parseEcgSamples } from "./ui/compare";
import { ClipRecorder, attachRecordButton, clipSecondsFromQuery, createComposite } from "./ui/recorder";
import { NO_RATE, statusView, type StatusView } from "./ui/status";
import { Coach } from "./ui/coach";
import { UI_TEXT, fill } from "./ui/text";
import { LessonRunner, type LabApi, type RunnerState } from "./lessons/runner";
import { LESSONS } from "./lessons/lessons";
import * as R from "./lessons/recipes";
import { AFTER_SHOCK_MS, CHUNK_MS, DT_MS, LabEngine } from "./lab/engine";
import { LabMoves, type ShockResult } from "./lab/moves";
import { BLANK_AFTER_DEFIBRILLATION_MS, RhythmAnalyzer } from "./audio/rhythm";
import { HeartAudio, soundPreference } from "./audio/heartAudio";
import { ANATOMY_LABELS, DISCLAIMER, LEAD_CAPTIONS, SHOCK_REFUSAL, SIM_ECG_NOTES, TOASTS, type RhythmKey } from "./copy";
import { buildDom, type Dom, type EcgView } from "./dom";
import { NoWebGpuError } from "./fallback";

const MAX_CHUNKS_PER_FRAME = 8;
const SPEEDS = { slow: 0.25, medium: 0.5, real: 1 } as const;
/** How long the card says "Early extra beat" after one is seen, in real ms. */
const EXTRA_BEAT_SHOWN_MS = 2500;
/** A beat the analyser sees within this long after one fired by hand through the wiring is that beat. */
const WIRING_BEAT_MATCH_MS = 250;
/** The status card and the buttons are refreshed this often, in real ms. */
const STATUS_EVERY_MS = 150;
/** A second Shock this soon after one that fired is ignored (a double click): never more than two flashes a second. */
const SHOCK_GAP_MS = 500;
const SOUND_USED_KEY = "arrhythmia-lab:sound-used";
/** How long a shock's own spike lasts on the ECG, in simulated ms: the monitor's automatic gain leaves it out. */
const SHOCK_SPIKE_MS = 500;
const LEAD_II = 1;

const url = (path: string): string => new URL(path, document.baseURI).href;
/** Bump when a file in public/data changes shape. A returning visitor may still have the old one cached, and the new code cannot read it. */
const DATA_VERSION = "2";

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

/** localStorage can be missing or throw (private windows, blocked storage); nothing here may. */
const remember = {
  get(key: string): string | null {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // not remembered, that is all
    }
  },
};

export async function startApp(root: HTMLElement): Promise<void> {
  const ui = buildDom(root);
  ui.setLoading("Loading the heart");

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new NoWebGpuError();
  const device = await adapter.requestDevice();
  try {
    await startLab(ui, device);
  } catch (err) {
    // The start failed, so nothing is left running that could use the device: give the graphics card its memory back.
    device.destroy();
    throw err;
  }
}

/** Everything that happens once there is a graphics device. Throws if any part of the start fails. */
async function startLab(ui: Dom, device: GPUDevice): Promise<void> {
  let deviceLost = false;
  const debug = new URLSearchParams(location.search).has("debug");
  if (debug) {
    // Recorded for the browser tests, which fail on any GPU error the page did not catch.
    const errors: string[] = ((window as unknown as { __labErrors?: string[] }).__labErrors = []);
    device.addEventListener("uncapturederror", (e) => errors.push((e as GPUUncapturedErrorEvent).error.message));
  }
  void device.lost.then((info) => {
    if (info.reason === "destroyed") return; // on purpose, after a start that failed: not a fault to report
    deviceLost = true;
    ui.showError("The graphics card stopped responding", `${info.message || info.reason}. Reload the page to start again.`);
  });

  const surfaceLoaded = loadSurface(url(`data/heart-surface.bin?v=${DATA_VERSION}`));
  // The atria, great vessels, fat and coronary vessels (drawn, not simulated), fetched with the rest of the data as soon
  // as the surface says how many points they hang on. Without them the ventricles are drawn alone.
  const anatomyLoaded = surfaceLoaded.then((s) =>
    loadAnatomy(url(`data/heart-anatomy.bin?v=${DATA_VERSION}`), s.positions.length / 3).catch((err: unknown) => {
      console.warn("The atria and vessels could not be loaded, so the ventricles are drawn alone.", err);
      return undefined;
    }),
  );
  const [grid, surface, frame, samplesJson, anatomy] = await Promise.all([
    loadHeart(url("data/heart.bin")),
    surfaceLoaded,
    loadFrame(url("data/heart-frame.json")),
    fetchJson(`data/ecg-samples.json?v=${DATA_VERSION}`),
    anatomyLoaded,
  ]);
  const samples = parseEcgSamples(samplesJson);

  ui.setLoading("Starting the simulation");
  const sim = await Simulation.create(device, grid, { dt: DT_MS });
  const ecg = await Ecg.create(device, sim, { positions: electrodePositions(frame) });
  // The frame stands the heart up by its real anatomy (apex down, right ventricle on the left). Without it the renderer would
  // guess the axis from the shape of the muscle, which is 69 degrees off for this heart.
  const renderer = await Renderer.create(ui.heartCanvas, device, surface, grid, sim, { quality: pickQuality(), frame, anatomy });
  const monitor = new Monitor(ui.monitorCanvas);
  // The chest leads swing several times as far as the limb leads: the monitor lowers a group's gain rather than cut its
  // waves flat at the edge of their boxes, and marks the gain it uses on the paper.
  monitor.setAutoGain(true);

  // What the heart is doing, worked out from the ECG as it is drawn, and the sound that follows it.
  const analyzer = new RhythmAnalyzer();
  const audio = new HeartAudio();
  // The lead on the big strip: lead II while it has a clear signal, otherwise the lead that shows the rhythm best.
  const autoLead = new AutoLead();
  const coach = new Coach();
  /** Real time until which the card says "Early extra beat". */
  let extraUntil = 0;
  /**
   * Simulated time of the last beat fired by hand through the wiring (B, Enter or Space on the heart, a lesson's "fire a
   * beat"). Fired between two steady beats it is early, but it is not an extra beat from the muscle (a PVC), so the card
   * does not call it one.
   */
  let wiringBeatAt = -Infinity;
  /** Simulated time of the person's last shock, while the heart has not beaten again since; else null. */
  let resettingSince: number | null = null;
  let lastShockAt = -Infinity;
  // The second heart sound comes from the simulation too: when the muscle has finished contracting after a beat.
  // While the lab hunts for the moment that starts a rhythm it jolts the heart and runs three times faster: those jolts are not heartbeats to hear.
  analyzer.onSecondSound((e) => {
    if (moves.starting === null) audio.secondSound(e, analyzer.state);
  });
  analyzer.onBeat((e) => {
    if (moves.starting === null) audio.beat(e, analyzer.state);
    const fromWiring = e.tMs - wiringBeatAt >= 0 && e.tMs - wiringBeatAt < WIRING_BEAT_MATCH_MS;
    if (e.premature && !fromWiring) extraUntil = performance.now() + EXTRA_BEAT_SHOWN_MS;
    // The shock's own whole-heart firing is not the heart coming back: wait for a beat once the pause is nearly over.
    if (resettingSince !== null && e.tMs - resettingSince >= AFTER_SHOCK_MS - 500) resettingSince = null;
  });

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
    // Every shock, the lab's own resets between induction attempts included, empties the analyser's memory and puts the
    // strip back on lead II until another lead is clearly better.
    shocked: (t, wholeHeart) => {
      // A whole-heart shock makes a flash and a recovery blip that must not be read as a heartbeat.
      analyzer.reset(t, wholeHeart ? BLANK_AFTER_DEFIBRILLATION_MS : undefined);
      monitor.ignoreForGain(t - 20, t + SHOCK_SPIKE_MS);
      autoLead.reset();
      extraUntil = 0;
      showLead();
    },
  });
  const moves = new LabMoves(engine);
  const fireWiringBeat = (): void => {
    engine.normalBeat();
    wiringBeatAt = engine.simTime;
  };
  // The ordinary beat sweeps over the inner wall like the heart's conduction fibres do (a narrow QRS, upright in lead II),
  // instead of crawling up from a single nudge at the tip.
  engine.useConductionSweep(grid, frame);
  let speed: number = SPEEDS.real;
  let carry = 0;

  // The controls a lesson may use.
  const api: LabApi = {
    pace: (voxel) => engine.deliver(voxel, R.APEX_STIM.radiusMm, R.APEX_STIM.amp),
    prematureBeat: () => engine.extraBeat(),
    shock: () => {
      engine.shock();
      ui.flashShock();
    },
    normalBeat: () => fireWiringBeat(),
    defibrillate: () => {
      engine.defibrillate();
      resettingSince = engine.simTime;
      ui.flashShock();
      audio.shock();
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
  const lessonRunning = (): boolean => runner.state.lessonId !== null && !runner.state.finished;

  // ---- the ECG and the strip's lead ----------------------------------------------------------------------------------
  function showLead(): void {
    const name = autoLead.name;
    const automatic = autoLead.lead !== LEAD_II;
    if (monitor.stripLeadIndex !== autoLead.lead) monitor.setStripLead(autoLead.lead);
    ui.showLead(name, automatic, automatic ? fill(LEAD_CAPTIONS.switched, { lead: name }) : "");
  }
  const flushEcg = (): void => {
    if (pendingTimes.length === 0) return;
    const times = pendingTimes.splice(0);
    ecg
      .flush()
      .then((rows) => {
        const before = autoLead.lead;
        rows.forEach((row, i) => {
          monitor.push(times[i], row);
          analyzer.push(times[i], row);
          autoLead.push(times[i], row);
        });
        if (autoLead.lead !== before) showLead();
      })
      .catch((err: unknown) => console.error("ECG readback failed", err));
  };

  // ---- the status card and the buttons -------------------------------------------------------------------------------
  let view: StatusView | null = null;
  const refreshStatus = (): void => {
    const rhythm = analyzer.state;
    const starting = moves.starting;
    // For a moment after the lab has started a rhythm the analyser can still read "quiet" (or, after the burst of fast beats
    // that starts fibrillation, "racing"). We know what was started, so the card names that until the reading has caught up.
    const settling = moves.settling;
    if (resettingSince !== null && engine.simTime - resettingSince > AFTER_SHOCK_MS + 3000) resettingSince = null; // no beat came: stop waiting
    const before = view?.key;
    view = statusView({ rhythm, extra: performance.now() < extraUntil, resetting: resettingSince !== null, starting, settling, pacing: engine.pacemaker });
    ui.showStatus(view);
    // A refusal answers the rhythm it saw: once the card shows another state it is out of date.
    if (before !== undefined && before !== view.key) ui.clearRhythmToast();
    const racing = starting === "racing" || view.key === "racing";
    const fibrillating = starting === "fibrillation" || view.key === "chaotic";
    // Shock is lit up once there is something to fix: not while the lab is still setting the rhythm up.
    const armed = starting === null && (view.key === "racing" || view.key === "chaotic");
    ui.showMoves({ racing, fibrillating, extra: view.key === "extra", armed, locked: lessonRunning() });
    ui.showSound(audio.state, view.key === "chaotic", audio.unavailable);
    ui.showShockFirst(view.key === "racing" || view.key === "chaotic");
    ui.showReadout(engine.excited, engine.simTime);
    if (!starting && (view.key === "racing" || view.key === "chaotic")) coach.brokeIt(view.key);
    if (clipRecorder.recording) ui.showRecording(true, performance.now() - recordingSince, maxClipSeconds * 1000);
  };

  // ---- the frame loop ------------------------------------------------------------------------------------------------
  let last = performance.now();
  let slowFrames = 0;
  let saidSlowed = false;
  let lastStatus = 0;
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
      // A slow device should slow the simulation down, not stutter: first to half speed, then to a quarter.
      slowFrames = realMs > 34 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
      if (slowFrames > 45 && speed > SPEEDS.slow) {
        speed = speed > SPEEDS.medium ? SPEEDS.medium : SPEEDS.slow;
        slowFrames = 0;
        ui.showSpeed(speed === SPEEDS.medium ? "medium" : "slow");
        if (!saidSlowed) ui.toast(TOASTS.slowed);
        saidSlowed = true;
      }
      engine.refreshExcited();
      analyzer.pushFraction(engine.simTime, engine.excited);
    }
    flushEcg();
    runner.tick();
    // A lesson step can hold the trace still while its words point at what the trace shows.
    const held = lessonRunning() && runner.state.step?.holdEcg === true;
    if (!held) monitor.render();
    ui.showEcgHeld(held);
    renderer.frame();
    if (clipRecorder.recording) composite.draw();
    const labelsOn = ui.labelsOn();
    for (const l of labelSpots) {
      if (!labelsOn) {
        ui.placeLabel(l.id, 0, 0, false);
        continue;
      }
      const p = renderer.project(l.voxel);
      ui.placeLabel(l.id, p.x, p.y, p.visible);
    }
    const firstRunTip = !coach.hidden && !coach.done[0] && !lessonRunning();
    const lessonWantsTap = lessonRunning() && tapStepSince !== null && lastTapAt < tapStepSince;
    if ((firstRunTip || lessonWantsTap) && view?.tone !== "alarm") {
      const p = renderer.project(centre);
      ui.placeTapMarker(p.x, p.y, true);
    } else ui.placeTapMarker(0, 0, false);
    if (now - lastStatus > STATUS_EVERY_MS) {
      lastStatus = now;
      refreshStatus();
    }
  };

  // ---- the heart's free area -----------------------------------------------------------------------------------------
  // The canvas fills the window, and the panels take room at its edges. Tell the renderer how much, so it frames the
  // heart in what is left and nothing ever sits on top of it.
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const onResize = (): void => {
    // Panels that size themselves to their words first, so everything measured below is final.
    ui.fitPanels();
    const s = ui.stage.getBoundingClientRect();
    renderer.resize(s.width, s.height, window.devicePixelRatio || 1);
    const m = ui.monitorCanvas.getBoundingClientRect();
    monitor.resize(m.width, m.height, window.devicePixelRatio || 1);
    const b = ui.blockers();
    const box = (el: HTMLElement): DOMRect | null => {
      if (el.hidden || getComputedStyle(el).display === "none") return null;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right <= s.left || r.left >= s.right || r.bottom <= s.top || r.top >= s.bottom) return null;
      return r;
    };
    const pad = 12;
    insets.top = insets.right = insets.bottom = insets.left = 0;
    for (const el of b.top) {
      const r = box(el);
      if (r && r.top < s.top + s.height * 0.3) insets.top = Math.max(insets.top, r.bottom - s.top + 4);
    }
    for (const el of b.left) {
      const r = box(el);
      if (r && r.left < s.left + s.width * 0.4) insets.left = Math.max(insets.left, r.right - s.left + pad);
    }
    for (const el of b.right) {
      const r = box(el);
      if (r && r.right > s.right - s.width * 0.4) insets.right = Math.max(insets.right, s.right - r.left + pad);
    }
    for (const el of b.bottom) {
      const r = box(el);
      if (r && r.top > s.top + s.height * 0.35) insets.bottom = Math.max(insets.bottom, s.bottom - r.top + pad);
    }
    renderer.setInsets(insets);
    ui.setFreeArea(insets);
    const st = ui.stage.style;
    st.setProperty("--free-top", `${insets.top}px`);
    st.setProperty("--free-right", `${insets.right}px`);
    st.setProperty("--free-bottom", `${insets.bottom}px`);
    st.setProperty("--free-left", `${insets.left}px`);
  };
  const observer = new ResizeObserver(() => onResize());
  for (const el of [...ui.watched, ui.monitorCanvas]) observer.observe(el);
  window.addEventListener("resize", onResize);
  onResize();

  // ---- the heart itself: tap to fire a beat, drag to turn it -----------------------------------------------------------
  /** When the person last fired a beat from the heart itself (a tap, or Enter on it), in real ms. */
  let lastTapAt = Number.NEGATIVE_INFINITY;
  renderer.onTap = (x, y) => {
    const voxel = renderer.pick(x, y);
    if (voxel) {
      engine.deliver(voxel, 4, 2);
      lastTapAt = performance.now();
      ui.ripple(x, y);
      coach.tapped();
    } else {
      ui.missHint(x, y);
    }
  };
  // The pointer shows what a press will do: fire a beat on the muscle, turn the heart anywhere else.
  let hoverQueued = false;
  let dragging = false;
  let hoverAt: [number, number] = [0, 0];
  ui.heartCanvas.addEventListener("pointerdown", () => {
    dragging = true;
    ui.heartCanvas.style.cursor = "grabbing";
  });
  window.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    ui.heartCanvas.style.cursor = "grab";
  });
  ui.heartCanvas.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || dragging) return;
    const r = ui.heartCanvas.getBoundingClientRect();
    hoverAt = [e.clientX - r.left, e.clientY - r.top];
    if (hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      if (!dragging) ui.heartCanvas.style.cursor = renderer.pick(hoverAt[0], hoverAt[1]) ? "pointer" : "grab";
    });
  });
  // With the keyboard: Enter or Space on the heart fires one steady beat, through the wiring.
  ui.heartCanvas.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    fireWiringBeat();
    lastTapAt = performance.now();
    coach.tapped();
  });

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
    { id: "apex", text: ANATOMY_LABELS.apex, voxel: frame.apexVoxel.map(Math.round) as [number, number, number] },
    { id: "base", text: ANATOMY_LABELS.base, voxel: frame.baseVoxel.map(Math.round) as [number, number, number] },
    { id: "lv", text: ANATOMY_LABELS.lv, voxel: wallPoint(frame.lvCentroid) },
    { id: "rv", text: ANATOMY_LABELS.rv, voxel: wallPoint(frame.rvCentroid) },
  ];
  labelSpots.forEach((l) => ui.addLabel(l.id, l.text));
  /** The middle of the muscle: where the "tap the heart" marker sits. */
  const centre = frame.centroid.map(Math.round) as [number, number, number];

  // ---- the moves: break it, fix it -------------------------------------------------------------------------------------
  const breakMove = (kind: "extra" | "racing" | "fibrillation"): void => {
    if (lessonRunning()) return ui.toast(UI_TEXT.lessonBusy);
    ui.clearRhythmToast();
    if (kind === "extra") return moves.extraBeat();
    const shown = view?.key;
    const already = kind === "racing" ? moves.starting === "racing" || shown === "racing" : moves.starting === "fibrillation" || shown === "chaotic";
    if (already) return ui.toast(UI_TEXT.alreadyBroken, true);
    if (kind === "racing") moves.race();
    else moves.fibrillate();
    refreshStatus();
  };

  // The person's own shock (the button or the S key). Like a defibrillator it checks the rhythm first; if it fires it
  // flashes and makes the thud and crackle. A lesson resetting the heart silently does not come through here.
  function userShock(): ShockResult | null {
    if (performance.now() - lastShockAt < SHOCK_GAP_MS) return null;
    const result = moves.shock(analyzer.state);
    if (result.fired) {
      lastShockAt = performance.now();
      resettingSince = engine.simTime;
      ui.flashShock();
      audio.shock();
      coach.fixedIt();
    } else {
      ui.toast(SHOCK_REFUSAL[result.reason], true);
    }
    refreshStatus();
    return result;
  }

  // ---- sound ---------------------------------------------------------------------------------------------------------
  let soundUsed = remember.get(SOUND_USED_KEY) === "1" || soundPreference.load();
  const refreshSound = (): void => {
    ui.showSound(audio.state, view?.key === "chaotic", audio.unavailable);
    ui.showSoundNudge(!soundUsed && audio.state === "off" && !audio.unavailable);
  };
  // Turning sound on needs a click or a key press, or the browser keeps audio blocked; both count.
  const toggleSound = (): void => {
    if (audio.unavailable) return ui.toast(UI_TEXT.soundUnavailable);
    const turningOn = audio.state === "off";
    if (!soundUsed) {
      soundUsed = true;
      remember.set(SOUND_USED_KEY, "1");
    }
    if (turningOn && speed !== SPEEDS.real) {
      // heart sounds only make sense in a real rhythm
      speed = SPEEDS.real;
      ui.showSpeed("real");
      ui.toast(TOASTS.realTimeForSound);
    }
    void audio.setOn(turningOn).then(() => {
      soundPreference.save(audio.state !== "off");
      refreshSound();
    });
    refreshSound();
  };
  // Someone who had the sound on last time gets it back at their first click or key press (browsers allow no sooner).
  if (soundPreference.load()) {
    const firstGesture = (e: Event): void => {
      window.removeEventListener("pointerup", firstGesture, true);
      window.removeEventListener("keydown", firstGesture, true);
      const onSoundControl = (e.target instanceof Element && e.target.closest("#b-sound")) || (e instanceof KeyboardEvent && e.key.toLowerCase() === "m");
      if (!onSoundControl && audio.state === "off") void audio.setOn(true).then(refreshSound);
    };
    window.addEventListener("pointerup", firstGesture, true);
    window.addEventListener("keydown", firstGesture, true);
  }

  // ---- the ECG views -------------------------------------------------------------------------------------------------
  const compare = new ComparePanel(ui.compareEl, samples, () => monitor.getTrace(autoLead.lead), { simulatedNote: DISCLAIMER.ecgLine });
  // The dock fits Compare's words: when they change (another recording, a caveat, a narrower window), fit it again.
  const compareContent = ui.compareEl.firstElementChild;
  if (compareContent instanceof HTMLElement) observer.observe(compareContent);
  /** When Compare opens, it starts on the recording of the rhythm on show (if there is one). */
  const matchingRecording: Record<string, string> = { steady: "normal-sinus", extra: "pvc", racing: "vtach", chaotic: "vfib" };
  const describeCompare = (): void => {
    const name = autoLead.name;
    const what = view && !view.busy ? `, ${view.name.toLowerCase()}` : "";
    const note = autoLead.lead !== LEAD_II ? fill(LEAD_CAPTIONS.compare, { lead: name }) : DISCLAIMER.ecgLine;
    const caveat = view && !view.busy ? (SIM_ECG_NOTES[view.key as RhythmKey] ?? "") : "";
    compare.setSimulatedLabel(`Lead ${name}, live${what}`, note, caveat);
  };
  let compareTimer = 0;
  let ecgView: EcgView = "single";
  const setEcgView = (next: EcgView): void => {
    const opening = next === "compare" && ecgView !== "compare";
    ecgView = next;
    ui.showEcgView(next);
    window.clearInterval(compareTimer);
    if (next === "compare") {
      monitor.setMode("single");
      const want = view ? matchingRecording[view.key] : undefined;
      if (opening && want && samples.samples.some((s) => s.id === want)) compare.select(want);
      describeCompare();
      compare.render();
      compareTimer = window.setInterval(() => {
        describeCompare();
        compare.render();
      }, 250);
    } else {
      monitor.setMode(next);
    }
    requestAnimationFrame(onResize);
  };

  // ---- recording a clip ----------------------------------------------------------------------------------------------
  // A recorded clip carries the rhythm as a caption, so it explains itself when it is shared, and the words that keep it honest.
  const CAPTION_TONE: Record<StatusView["tone"], string> = { ok: "#6bf2c0", notice: "#ffc46b", alarm: "#ff9aa4", idle: "#dbe8ee", info: "#63e8ff" };
  const drawCaption = (ctx: CanvasRenderingContext2D, width: number): void => {
    ctx.save();
    if (view) {
      const text = [view.name, view.value !== NO_RATE ? `${view.value} ${view.unit}` : "", view.busy ? "" : view.pumping].filter(Boolean).join("   ·   ");
      ctx.font = '600 26px "Instrument Sans", system-ui, sans-serif';
      ctx.fillStyle = "rgba(6, 10, 14, 0.80)";
      ctx.strokeStyle = CAPTION_TONE[view.tone];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(24, 24, ctx.measureText(text).width + 64, 52, 26);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = CAPTION_TONE[view.tone];
      ctx.beginPath();
      ctx.arc(52, 50, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(text, 72, 59);
    }
    ctx.font = '500 16px "Instrument Sans", system-ui, sans-serif';
    ctx.fillStyle = "rgba(219, 232, 238, 0.75)";
    ctx.textAlign = "right";
    ctx.fillText("Simulation. Not a medical device.  arrhythmia-lab.pages.dev", width - 24, 40);
    ctx.restore();
  };
  const CLIP_PICTURE = { width: 1280, height: 540 };
  const composite = createComposite({ width: 1280, height: 720 }, [
    {
      // The heart is framed in the part of the view that is not under a panel. The panels are not in the clip, so widen
      // that part to the clip's shape and let the dark space behind them show: the heart fills the frame, with no box round it.
      source: ui.heartCanvas,
      rect: [0, 0, CLIP_PICTURE.width, CLIP_PICTURE.height],
      fit: "contain",
      backdrop: true,
      crop: () => {
        const full = { w: ui.heartCanvas.width, h: ui.heartCanvas.height };
        const k = full.w / Math.max(1, ui.stage.getBoundingClientRect().width);
        let x = insets.left * k;
        const y = insets.top * k;
        let w = Math.max(1, full.w - (insets.left + insets.right) * k);
        const h = Math.max(1, full.h - (insets.top + insets.bottom) * k);
        const wanted = CLIP_PICTURE.width / CLIP_PICTURE.height;
        if (w / h < wanted) {
          const wider = Math.min(full.w, h * wanted);
          x = Math.max(0, Math.min(full.w - wider, x + w / 2 - wider / 2));
          w = wider;
        }
        // a little room round the heart, so the caption never sits on a vessel
        const room = 1.12;
        const cx = x + w / 2;
        const cy = y + h / 2;
        w = Math.min(full.w, w * room);
        const hh = Math.min(full.h, h * room);
        return [Math.max(0, Math.min(full.w - w, cx - w / 2)), Math.max(0, Math.min(full.h - hh, cy - hh / 2)), w, hh];
      },
    },
    { source: ui.monitorCanvas, rect: [0, 552, 1280, 150], fit: "contain" },
  ], { paused: true, overlay: (ctx, width) => drawCaption(ctx, width) });
  // A WebGPU canvas only holds its picture during the frame it was drawn in, so the composite's own loop would copy
  // a blank heart. Stop it, and copy by hand right after rendering, only while a clip is being recorded.
  // Visitors get 30 seconds; the tool that records the demo clip can ask for longer with ?clipSeconds= (at most 2 minutes).
  const maxClipSeconds = clipSecondsFromQuery(location.search);
  // The heartbeat is recorded with the picture. Clicking Record makes the audio path (silent while the sound is off), so a
  // person who turns the sound on part way through the clip gets it too.
  const clipRecorder = new ClipRecorder(composite.canvas, {
    fps: 30,
    maxSeconds: maxClipSeconds,
    audio: () => {
      audio.prepare();
      return audio.captureStream;
    },
  });
  let recordingSince = 0;
  attachRecordButton(ui.recordButton, clipRecorder, "arrhythmia-lab-clip.webm", {
    label: ui.recordLabel,
    onChange: (recording, saved) => {
      if (recording) recordingSince = performance.now();
      ui.showRecording(recording, 0, maxClipSeconds * 1000);
      if (saved) ui.toast(UI_TEXT.savedClip);
    },
  });

  // ---- wire up the page ----------------------------------------------------------------------------------------------
  ui.onAction({
    extra: () => breakMove("extra"),
    race: () => breakMove("racing"),
    fibrillate: () => breakMove("fibrillation"),
    shock: () => void userShock(),
    beat: () => {
      fireWiringBeat();
      coach.tapped();
    },
    burst: () => engine.startBurst(firstBurst.beats, firstBurst.periodMs),
    pacemaker: (on) => engine.setPacemaker(on),
    tissue: (t) => engine.setTissue(t),
    preset: (name) => engine.setTissue(name === "healthy" ? R.NORMAL_TISSUE : name === "fragile" ? R.TACHYCARDIA_TISSUE : R.FIBRILLATION_TISSUE),
    cutaway: (on, depth) => renderer.setCutaway(on, depth),
    labels: () => undefined,
    speed: (name) => (speed = SPEEDS[name]),
    ecgView: (v) => setEcgView(v),
    sound: () => toggleSound(),
    lessonStart: (id) => runner.start(id),
    lessonNext: () => runner.next(),
    lessonBack: () => runner.back(),
    lessonRestart: () => runner.restart(),
    lessonStop: () => {
      runner.stop();
      // Back to free play with a beating heart: a lesson pauses the steady beat, and stopping it early would leave it off.
      if (!engine.pacemaker) engine.setPacemaker(true);
    },
    layout: () => requestAnimationFrame(onResize),
  });
  ui.onCoachHide(() => coach.hide());
  coach.onChange(() => {
    ui.showCoach(coach);
    requestAnimationFrame(onResize);
  });
  ui.showCoach(coach);
  ui.renderLessons(LESSONS, runner.state);
  /** Real time when the running lesson's "tap the heart" step began, or null when it is not on one. */
  let tapStepSince: number | null = null;
  runner.onChange(() => {
    const state = runner.state as RunnerState;
    ui.renderLessons(LESSONS, state);
    const asksForTap = lessonRunning() && /\btap\b/i.test(state.step?.title ?? "");
    if (!asksForTap) tapStepSince = null;
    else if (tapStepSince === null) tapStepSince = performance.now();
  });
  ui.showTissue(engine.tissue);
  ui.showPacemaker(engine.pacemaker);
  ui.showSpeed("real");
  showLead();
  setEcgView("single");
  engine.inducer.onChange(() => {
    refreshStatus();
    if (engine.inducer.state.status === "failed") ui.toast(TOASTS.startFailed);
  });
  refreshSound();

  // ---- the keyboard --------------------------------------------------------------------------------------------------
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (ui.closeTopmost()) e.preventDefault();
      return;
    }
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const key = e.key.toLowerCase();
    if (key === "e") breakMove("extra");
    else if (key === "r") breakMove("racing");
    else if (key === "f") breakMove("fibrillation");
    else if (key === "s") userShock();
    else if (key === "m") toggleSound();
    else if (key === "b") {
      fireWiringBeat();
      coach.tapped();
    } else if (e.key === "?") {
      if (ui.drawerTab() === "help") ui.closeDrawer();
      else ui.openDrawer("help");
    }
  });

  // A handle for the browser tests. It does nothing unless the page is opened with ?debug.
  if (debug) {
    (window as unknown as { __lab: unknown }).__lab = {
      engine, api, runner, monitor, renderer, sim, composite, analyzer, audio, moves, toggleSound, autoLead, coach,
      setSpeed: (s: number) => (speed = s),
    };
  }

  ui.clearLoading();
  refreshStatus();
  requestAnimationFrame((t) => {
    last = t;
    frame_(t);
  });
}
