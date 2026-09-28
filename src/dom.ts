// The page's markup and every DOM update in one place, so app.ts stays about the simulation.
import type { Lesson, RunnerState } from "./lessons/runner";
import { SLIDER_LIMITS } from "./lessons/recipes";

export type PresetName = "healthy" | "racing" | "fragile";
type SpeedName = "slow" | "medium" | "real";

export interface Actions {
  beat(): void;
  extra(): void;
  shock(): void;
  burst(): void;
  pacemaker(on: boolean): void;
  tissue(t: { conduction?: number; recovery?: number }): void;
  preset(name: PresetName): void;
  cutaway(on: boolean, depth: number): void;
  labels(on: boolean): void;
  speed(name: SpeedName): void;
  ecgMode(mode: "twelve" | "single"): void;
  lessonStart(id: string): void;
  lessonNext(): void;
  lessonBack(): void;
  lessonRestart(): void;
  lessonStop(): void;
}

export interface Dom {
  stage: HTMLElement;
  panel: HTMLElement;
  dock: HTMLElement;
  heartCanvas: HTMLCanvasElement;
  monitorCanvas: HTMLCanvasElement;
  compareEl: HTMLElement;
  recordButton: HTMLButtonElement;
  setLoading(message: string): void;
  clearLoading(): void;
  showError(title: string, message: string): void;
  toast(message: string): void;
  showHud(simTimeMs: number, excited: number): void;
  showTissue(t: { conduction: number; recovery: number }): void;
  showPacemaker(on: boolean): void;
  showSpeed(name: SpeedName): void;
  showEcgMode(mode: "twelve" | "single"): void;
  flashShock(): void;
  dismissHint(): void;
  onAction(a: Actions): void;
  onCompareToggle(cb: (open: boolean) => void): void;
  renderLessons(lessons: readonly Lesson[], state: RunnerState): void;
  /** Small anatomy labels pinned to points on the heart. `place` is called every frame with the projected position. */
  addLabel(id: string, text: string): void;
  placeLabel(id: string, x: number, y: number, visible: boolean): void;
  labelsOn(): boolean;
}

const html = /* html */ `
<div class="lab" id="lab">
  <div class="stage" id="stage">
    <canvas id="heart" aria-label="A three-dimensional heart. Tap it to fire a beat at that spot, drag to turn it, scroll or pinch to zoom." role="img"></canvas>
    <div class="labels" id="labels" aria-hidden="true"></div>
    <div class="hud" id="hud" aria-live="off"></div>
  </div>
  <header class="brand">
    <h1>Arrhythmia Lab</h1>
    <p>A live heart you can break, and fix.</p>
  </header>
  <p class="banner" role="note">Educational simulation. Not a medical device.</p>
  <p class="hint" id="hint">Tap the heart to fire a beat there. Drag to turn it.</p>

  <aside class="panel" id="panel" aria-label="Lessons and controls">
    <section class="card" id="lessons" aria-live="polite"></section>

    <section class="card" aria-labelledby="h-controls">
      <h2 id="h-controls">Fire and stop</h2>
      <div class="row">
        <button class="btn btn-primary btn--primary" id="b-beat" title="Key: B">Beat at the tip</button>
        <button class="btn" id="b-extra" title="Key: E">Extra beat</button>
        <button class="btn" id="b-burst" title="Key: F">Fast pacing burst</button>
        <button class="btn btn--shock" id="b-shock" title="Key: S">Shock</button>
      </div>
      <div class="row">
        <button class="btn btn--ghost" id="b-pacemaker" aria-pressed="true">Pacemaker: on (75 per minute)</button>
      </div>
      <p class="muted">Tap anywhere on the heart to fire a beat right there.</p>
    </section>

    <section class="card" aria-labelledby="h-tissue">
      <h2 id="h-tissue">Tissue (idealised)</h2>
      <div class="field">
        <label for="s-conduction"><span>Conduction speed</span><span class="value" id="v-conduction">1.00x</span></label>
        <input type="range" id="s-conduction" min="${SLIDER_LIMITS.conduction.min}" max="${SLIDER_LIMITS.conduction.max}" step="${SLIDER_LIMITS.conduction.step}" value="1" />
        <p class="muted">How fast the wave spreads. A slower wave is a shorter wave.</p>
      </div>
      <div class="field">
        <label for="s-recovery"><span>Recovery time</span><span class="value" id="v-recovery">1.00x</span></label>
        <input type="range" id="s-recovery" min="${SLIDER_LIMITS.recovery.min}" max="${SLIDER_LIMITS.recovery.max}" step="${SLIDER_LIMITS.recovery.step}" value="1" />
        <p class="muted">How long each cell stays excited before it can fire again. Shorter recovery also means a shorter wave.</p>
      </div>
      <div class="row">
        <button class="btn btn--ghost" data-preset="healthy">Healthy</button>
        <button class="btn btn--ghost" data-preset="racing">Racing</button>
        <button class="btn btn--ghost" data-preset="fragile">Fragile</button>
      </div>
    </section>

    <section class="card" aria-labelledby="h-view">
      <h2 id="h-view">View</h2>
      <div class="row">
        <button class="btn btn--ghost" id="b-cutaway" aria-pressed="false">Cut the heart open</button>
        <button class="btn btn--ghost" id="b-labels" aria-pressed="true">Labels</button>
      </div>
      <div class="field" id="f-cut" hidden>
        <label for="s-cut"><span>Cut position</span></label>
        <input type="range" id="s-cut" min="-1" max="1" step="0.05" value="0" />
      </div>
      <div class="row">
        <span class="muted">Speed</span>
        <div class="seg" role="group" aria-label="Simulation speed">
          <button data-speed="slow" aria-pressed="false">1/4x</button>
          <button data-speed="medium" aria-pressed="true">1/2x</button>
          <button data-speed="real" aria-pressed="false">Real time</button>
        </div>
      </div>
    </section>
  </aside>

  <section class="dock" id="dock" aria-label="Simulated electrocardiogram">
    <div class="dock-bar">
      <span class="dock-title">Simulated ECG</span>
      <div class="seg" role="group" aria-label="ECG layout">
        <button data-ecg="twelve" aria-pressed="true">12 leads</button>
        <button data-ecg="single" aria-pressed="false">One lead</button>
      </div>
      <button class="btn btn--ghost" id="b-compare" aria-expanded="false" aria-controls="compare">Compare with a real ECG</button>
      <button class="btn btn--ghost" id="b-record">Record clip</button>
    </div>
    <canvas id="monitor" role="img" aria-label="Simulated electrocardiogram traces. This is an educational simulation, not a medical device."></canvas>
  </section>
  <div class="compare" id="compare" hidden></div>

  <footer class="foot">
    <span>Built with Claude Sonnet 5.5. Not affiliated with Anthropic.</span>
    <span>Heart geometry: Strocchi et al., CC BY 4.0.</span>
    <span>Recorded ECGs: PTB-XL, CC BY 4.0; MIT-BIH Arrhythmia Database, ODC-By 1.0.</span>
    <span>Cell model: Bueno-Orovio, Cherry and Fenton (2008).</span>
    <a href="https://github.com/ramenprotokol/arrhythmia-lab" rel="noopener">Source code</a>
  </footer>

  <div class="overlay" id="loading" role="status"><div><div class="spinner"></div><h2 id="loading-title">Loading</h2><p class="muted">Educational simulation. Not a medical device.</p></div></div>
  <p class="toast" id="toast" role="status" hidden></p>
</div>`;

function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`page markup is missing #${id}`);
  return el as T;
}

export function buildDom(root: HTMLElement): Dom {
  root.innerHTML = html;
  const stage = need("stage");
  const heartCanvas = need<HTMLCanvasElement>("heart");
  const monitorCanvas = need<HTMLCanvasElement>("monitor");
  const compareEl = need("compare");
  const recordButton = need<HTMLButtonElement>("b-record");
  const loading = need("loading");
  const loadingTitle = need("loading-title");
  const hint = need("hint");
  const hud = need("hud");
  const toastEl = need("toast");
  const lessonsEl = need("lessons");
  const pacemakerBtn = need<HTMLButtonElement>("b-pacemaker");
  const cutBtn = need<HTMLButtonElement>("b-cutaway");
  const cutField = need("f-cut");
  const cutSlider = need<HTMLInputElement>("s-cut");
  const conduction = need<HTMLInputElement>("s-conduction");
  const recovery = need<HTMLInputElement>("s-recovery");
  const compareBtn = need<HTMLButtonElement>("b-compare");
  const labelsBtn = need<HTMLButtonElement>("b-labels");
  const labelsEl = need("labels");
  const labelNodes = new Map<string, HTMLElement>();
  let actions: Actions | null = null;
  let toastTimer = 0;
  let hintTimer = 0;
  let stuckTimer = 0;
  let lastStepKey = "";

  hintTimer = window.setTimeout(() => hint.classList.add("gone"), 14000);

  const fmt = (v: number): string => `${v.toFixed(2)}x`;
  const press = (buttons: NodeListOf<HTMLElement>, attr: string, value: string): void =>
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === value)));

  const dom: Dom = {
    stage,
    panel: need("panel"),
    dock: need("dock"),
    heartCanvas,
    monitorCanvas,
    compareEl,
    recordButton,

    setLoading(message) {
      loading.hidden = false;
      loadingTitle.textContent = message;
    },
    clearLoading() {
      loading.hidden = true;
    },
    showError(title, message) {
      loading.hidden = false;
      loading.innerHTML = "";
      const box = document.createElement("div");
      const h = document.createElement("h2");
      h.textContent = title;
      const p = document.createElement("p");
      p.textContent = message;
      box.append(h, p);
      loading.append(box);
    },
    toast(message) {
      toastEl.textContent = message;
      toastEl.hidden = false;
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => (toastEl.hidden = true), 5000);
    },
    showHud(simTimeMs, excited) {
      hud.innerHTML = `<span>Simulated time <b>${(simTimeMs / 1000).toFixed(1)} s</b></span><span>Muscle excited <b>${Math.round(excited * 100)}%</b></span>`;
    },
    showTissue(t) {
      conduction.value = String(t.conduction);
      recovery.value = String(t.recovery);
      need("v-conduction").textContent = fmt(t.conduction);
      need("v-recovery").textContent = fmt(t.recovery);
    },
    showPacemaker(on) {
      pacemakerBtn.setAttribute("aria-pressed", String(on));
      pacemakerBtn.textContent = on ? "Pacemaker: on (75 per minute)" : "Pacemaker: off";
    },
    showSpeed(name) {
      press(document.querySelectorAll<HTMLElement>("[data-speed]"), "speed", name);
    },
    showEcgMode(mode) {
      press(document.querySelectorAll<HTMLElement>("[data-ecg]"), "ecg", mode);
    },
    flashShock() {
      stage.animate([{ boxShadow: "inset 0 0 0 100vmax rgba(255,255,255,0.55)" }, { boxShadow: "inset 0 0 0 100vmax rgba(255,255,255,0)" }], {
        duration: 420,
        easing: "ease-out",
      });
    },
    dismissHint() {
      window.clearTimeout(hintTimer);
      hint.classList.add("gone");
    },

    onAction(a) {
      actions = a;
      need("b-beat").addEventListener("click", () => a.beat());
      need("b-extra").addEventListener("click", () => a.extra());
      need("b-burst").addEventListener("click", () => a.burst());
      need("b-shock").addEventListener("click", () => a.shock());
      pacemakerBtn.addEventListener("click", () => a.pacemaker(pacemakerBtn.getAttribute("aria-pressed") !== "true"));
      conduction.addEventListener("input", () => {
        need("v-conduction").textContent = fmt(Number(conduction.value));
        a.tissue({ conduction: Number(conduction.value) });
      });
      recovery.addEventListener("input", () => {
        need("v-recovery").textContent = fmt(Number(recovery.value));
        a.tissue({ recovery: Number(recovery.value) });
      });
      document.querySelectorAll<HTMLElement>("[data-preset]").forEach((b) => b.addEventListener("click", () => a.preset(b.dataset.preset as PresetName)));
      cutBtn.addEventListener("click", () => {
        const on = cutBtn.getAttribute("aria-pressed") !== "true";
        cutBtn.setAttribute("aria-pressed", String(on));
        cutField.hidden = !on;
        a.cutaway(on, Number(cutSlider.value));
      });
      labelsBtn.addEventListener("click", () => {
        const on = labelsBtn.getAttribute("aria-pressed") !== "true";
        labelsBtn.setAttribute("aria-pressed", String(on));
        a.labels(on);
      });
      cutSlider.addEventListener("input", () => a.cutaway(cutBtn.getAttribute("aria-pressed") === "true", Number(cutSlider.value)));
      document.querySelectorAll<HTMLElement>("[data-speed]").forEach((b) =>
        b.addEventListener("click", () => {
          const name = b.dataset.speed as SpeedName;
          press(document.querySelectorAll<HTMLElement>("[data-speed]"), "speed", name);
          a.speed(name);
        }),
      );
      document.querySelectorAll<HTMLElement>("[data-ecg]").forEach((b) =>
        b.addEventListener("click", () => {
          const mode = b.dataset.ecg as "twelve" | "single";
          press(document.querySelectorAll<HTMLElement>("[data-ecg]"), "ecg", mode);
          a.ecgMode(mode);
        }),
      );
    },

    addLabel(id, text) {
      const el = document.createElement("span");
      el.className = "label";
      el.textContent = text;
      el.hidden = true;
      labelsEl.append(el);
      labelNodes.set(id, el);
    },
    placeLabel(id, x, y, visible) {
      const el = labelNodes.get(id);
      if (!el) return;
      const show = visible && labelsBtn.getAttribute("aria-pressed") === "true";
      if (el.hidden === show) el.hidden = !show;
      if (show) el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    },
    labelsOn() {
      return labelsBtn.getAttribute("aria-pressed") === "true";
    },

    onCompareToggle(cb) {
      compareBtn.addEventListener("click", () => {
        const open = compareEl.hidden === true;
        compareEl.hidden = !open;
        compareBtn.setAttribute("aria-expanded", String(open));
        cb(open);
      });
    },

    renderLessons(lessons, state) {
      lessonsEl.replaceChildren();
      const h = document.createElement("h2");
      h.textContent = "Guided lessons";
      lessonsEl.append(h);

      const button = (label: string, cls: string, onClick: () => void): HTMLButtonElement => {
        const b = document.createElement("button");
        b.className = `btn ${cls}`.trim();
        b.textContent = label;
        b.addEventListener("click", onClick);
        return b;
      };

      const lesson = lessons.find((l) => l.id === state.lessonId);
      if (!lesson || !actions) {
        window.clearTimeout(stuckTimer);
        const list = document.createElement("div");
        list.className = "lesson-list";
        lessons.forEach((l, i) => {
          const b = document.createElement("button");
          b.className = "btn";
          const num = document.createElement("span");
          num.className = "num";
          num.textContent = String(i + 1);
          b.append(num, document.createTextNode(l.title));
          b.title = l.summary;
          b.addEventListener("click", () => actions?.lessonStart(l.id));
          list.append(b);
        });
        const intro = document.createElement("p");
        intro.className = "muted";
        intro.textContent = "Five short lessons, from a normal heartbeat to fibrillation and the shock that stops it. Each one drives the same controls you have.";
        lessonsEl.append(intro, list);
        return;
      }

      const title = document.createElement("p");
      title.className = "step-title";
      title.textContent = lesson.title;
      lessonsEl.append(title);

      const total = lesson.steps.length;
      const bar = document.createElement("div");
      bar.className = "progress";
      for (let i = 0; i < total; i++) {
        const seg = document.createElement("i");
        if (i < state.stepIndex) seg.className = "done";
        else if (i === state.stepIndex && !state.finished) seg.className = "now";
        bar.append(seg);
      }
      lessonsEl.append(bar);

      if (state.finished || !state.step) {
        const p = document.createElement("p");
        p.textContent = "Lesson complete. Try it again, or pick another.";
        const row = document.createElement("div");
        row.className = "row";
        row.append(button("Back", "btn--ghost", () => actions?.lessonBack()), button("Restart", "", () => actions?.lessonRestart()), button("All lessons", "btn--primary", () => actions?.lessonStop()));
        lessonsEl.append(p, row);
        return;
      }

      const step = state.step;
      if (step.title) {
        const t = document.createElement("p");
        t.className = "step-title";
        t.textContent = step.title;
        lessonsEl.append(t);
      }
      step.text.split("\n\n").forEach((para) => {
        const p = document.createElement("p");
        p.textContent = para;
        lessonsEl.append(p);
      });

      const key = `${lesson.id}:${state.stepIndex}`;
      if (key !== lastStepKey) {
        lastStepKey = key;
        window.clearTimeout(stuckTimer);
        if (step.hint && step.waitFor !== undefined) {
          stuckTimer = window.setTimeout(() => {
            const line = document.createElement("p");
            line.className = "hintline";
            line.textContent = step.hint as string;
            lessonsEl.append(line);
          }, 12000);
        }
      }

      const waits = step.waitFor !== undefined;
      const row = document.createElement("div");
      row.className = "row";
      row.append(
        button("Back", "btn--ghost", () => actions?.lessonBack()),
        button(waits ? "Skip" : "Next", waits ? "btn--ghost" : "btn--primary", () => actions?.lessonNext()),
        button("Restart", "btn--ghost", () => actions?.lessonRestart()),
        button("Stop", "btn--ghost", () => actions?.lessonStop()),
      );
      lessonsEl.append(row);
    },
  };
  return dom;
}
