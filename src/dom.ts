// The page's markup and every DOM update in one place, so app.ts stays about the simulation. The heart is the hero:
// every panel sits beside it or below it, and app.ts tells the renderer which parts of the canvas the panels take, so
// the heart is always framed in what is left. Words come from src/copy.ts (the teaching review) and src/ui/text.ts.
import type { Lesson, RunnerState } from "./lessons/runner";
import { SLIDER_LIMITS } from "./lessons/recipes";
import { DISCLAIMER, FIRST_RUN_STEPS, HUD, LABELS, LESSON_UI, SOUND_NOTE, SOUND_SILENCE, SOUND_STATE, TERMS, TOOLTIPS } from "./copy";
import type { SoundState } from "./audio/heartAudio";
import { NO_RATE, type StatusView } from "./ui/status";
import type { Coach } from "./ui/coach";
import { ICON } from "./ui/icons";
import { UI_TEXT, fill } from "./ui/text";

export type PresetName = "healthy" | "fragile" | "veryFragile";
export type SpeedName = "slow" | "medium" | "real";
export type EcgView = "single" | "twelve" | "compare";
export type DrawerTab = "lessons" | "explore" | "help";

export interface Actions {
  extra(): void;
  race(): void;
  fibrillate(): void;
  shock(): void;
  /** One steady beat, through the heart's wiring. */
  beat(): void;
  /** Ten quick beats at the tip. */
  burst(): void;
  pacemaker(on: boolean): void;
  tissue(t: { conduction?: number; recovery?: number }): void;
  preset(name: PresetName): void;
  cutaway(on: boolean, depth: number): void;
  labels(on: boolean): void;
  speed(name: SpeedName): void;
  ecgView(view: EcgView): void;
  /** Must run inside the click, or the browser keeps audio blocked. */
  sound(): void;
  lessonStart(id: string): void;
  lessonNext(): void;
  lessonBack(): void;
  lessonRestart(): void;
  lessonStop(): void;
  /** A panel opened or closed: the heart's free area changed. */
  layout(): void;
}

/** The parts of the page that take room from the heart, for the renderer's insets. */
export interface Blockers {
  top: HTMLElement[];
  left: HTMLElement[];
  right: HTMLElement[];
  bottom: HTMLElement[];
}

export interface Dom {
  root: HTMLElement;
  stage: HTMLElement;
  heartCanvas: HTMLCanvasElement;
  monitorCanvas: HTMLCanvasElement;
  compareEl: HTMLElement;
  recordButton: HTMLButtonElement;
  recordLabel: HTMLElement;
  /** Elements that are watched for size changes, so the heart can be re-framed. */
  watched: HTMLElement[];
  blockers(): Blockers;
  /** Where the heart's free area ends on each side, so labels near an edge can turn to face inward. */
  setFreeArea(insets: { top: number; right: number; bottom: number; left: number }): void;
  setLoading(message: string): void;
  clearLoading(): void;
  showError(title: string, message: string): void;
  /** A short message in the status card. `aboutRhythm` marks one that answers the rhythm on show (a refusal), which goes stale when it changes. */
  toast(message: string, aboutRhythm?: boolean): void;
  /** Take down a message that answered the rhythm on show, if one is up. */
  clearRhythmToast(): void;
  /**
   * Fit the panels that size themselves to their words: the dock grows to show all of Compare, and in the tall-dock views
   * the card keeps its "Next" line for an alarm where it clears the moves. Call it before measuring the heart's free area.
   */
  fitPanels(): void;
  showStatus(view: StatusView): void;
  /** What the action bar shows: which rhythm is on, whether Shock would fire, whether a lesson has the controls. */
  showMoves(s: { racing: boolean; fibrillating: boolean; extra: boolean; armed: boolean; locked: boolean }): void;
  /** `unavailable`: the browser cannot play sound at all, so the button says so. */
  showSound(state: SoundState, chaotic: boolean, unavailable?: boolean): void;
  showSoundNudge(on: boolean): void;
  showLead(name: string, automatic: boolean, note: string): void;
  showEcgView(view: EcgView): void;
  /** A lesson is holding the trace still. */
  showEcgHeld(held: boolean): void;
  showTissue(t: { conduction: number; recovery: number }): void;
  showPacemaker(on: boolean): void;
  showSpeed(name: SpeedName): void;
  showReadout(firing: number, simTimeMs: number): void;
  showShockFirst(on: boolean): void;
  showRecording(recording: boolean, elapsedMs: number, maxMs: number): void;
  flashShock(): void;
  ripple(x: number, y: number): void;
  missHint(x: number, y: number): void;
  placeTapMarker(x: number, y: number, visible: boolean): void;
  showCoach(coach: Coach): void;
  openDrawer(tab: DrawerTab): void;
  closeDrawer(): void;
  drawerTab(): DrawerTab | null;
  /** Close the topmost open thing (credits, the menu, Compare, the drawer). False when nothing was open. */
  closeTopmost(): boolean;
  onAction(a: Actions): void;
  onCoachHide(cb: () => void): void;
  renderLessons(lessons: readonly Lesson[], state: RunnerState): void;
  addLabel(id: string, text: string): void;
  placeLabel(id: string, x: number, y: number, visible: boolean): void;
  labelsOn(): boolean;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const KEYS: [string, string][] = [
  ["E", LABELS.extraBeat],
  ["R", LABELS.racing],
  ["F", LABELS.fibrillation],
  ["S", LABELS.shock],
  ["B", UI_TEXT.fireOne],
  ["M", LABELS.sound],
  ["?", LABELS.help],
  ["Esc", UI_TEXT.close],
];

const CREDITS: string[] = [
  "Built with Claude Sonnet 5.5. Not affiliated with Anthropic.",
  "Heart shape: one heart from Strocchi et al., CC BY 4.0. The fat and surface blood vessels are drawn by the lab, not taken from the scan.",
  "Recorded ECGs: PTB-XL, CC BY 4.0; MIT-BIH Arrhythmia Database and CU Ventricular Tachyarrhythmia Database, ODC-By 1.0.",
  "Cell model: Bueno-Orovio, Cherry and Fenton (2008).",
  "Fonts: Instrument Sans, Instrument Serif, JetBrains Mono, SIL OFL 1.1.",
];

const RECORD_TIP = `${TOOLTIPS.record} ${UI_TEXT.recordSound}`;
/** Room "Press Shock" needs beside the action bar, in CSS px: the pill and the gap before it. */
const CALLOUT_ROOM = 150;

const tool = (id: string, key: keyof typeof TOOLTIPS, icon: string, attrs = ""): string =>
  `<button class="tool tool--icon" id="${id}" ${attrs} aria-describedby="tip-${id}" data-tip="${esc(TOOLTIPS[key])}">${icon}<span class="tool-text">${esc(LABELS[key])}</span></button>` +
  `<span class="sr-only" id="tip-${id}">${esc(TOOLTIPS[key])}</span>`;

const act = (id: string, key: "extraBeat" | "racing" | "fibrillation", kbd: string, pressable: boolean): string =>
  `<button class="act act--break" id="${id}" ${pressable ? 'aria-pressed="false"' : ""} aria-keyshortcuts="${kbd}" aria-describedby="tip-${id}">` +
  `<span class="act-text">${esc(LABELS[key])}</span><kbd aria-hidden="true">${kbd}</kbd></button><span class="sr-only" id="tip-${id}">${esc(TOOLTIPS[key])}</span>`;

const html = /* html */ `
<div class="lab" id="lab" data-status="quiet" data-tone="idle" data-view="single" data-drawer="closed">
  <div class="hero" id="hero">
    <div class="stage" id="stage">
      <canvas id="heart" tabindex="0" role="img" aria-label="${esc(UI_TEXT.heartName)}"></canvas>
      <div class="vignette" aria-hidden="true"></div>
      <div class="labels" id="labels" aria-hidden="true"></div>
      <div class="tap-marker" id="tap-marker" aria-hidden="true" hidden><span class="tap-ring"></span><span class="tap-label">${esc(UI_TEXT.tapMarker)}</span></div>
      <div class="flash" id="flash" aria-hidden="true"></div>
      <div class="focus-ring" aria-hidden="true"></div>
    </div>

    <header class="topbar" id="topbar">
      <div class="brand">
        <h1 class="wordmark">Arrhythmia Lab</h1>
        <p class="tagline">${esc(UI_TEXT.tagline)}</p>
      </div>
      <div class="tools">
        <button class="tool tool--text only-wide" id="b-lessons" aria-expanded="false" aria-controls="drawer" aria-describedby="tip-b-lessons">${ICON.lessons()}<span>${esc(LABELS.lessons)}</span></button>
        <span class="sr-only" id="tip-b-lessons">${esc(TOOLTIPS.lessons)}</span>
        <button class="tool tool--text only-wide" id="b-explore" aria-expanded="false" aria-controls="drawer" aria-describedby="tip-b-explore">${ICON.explore()}<span>${esc(LABELS.explore)}</span></button>
        <span class="sr-only" id="tip-b-explore">${esc(TOOLTIPS.explore)}</span>
        <div class="sound-wrap">
          <button class="tool tool--sound" id="b-sound" aria-pressed="false" aria-keyshortcuts="M" aria-describedby="tip-b-sound"><span class="sound-icon">${ICON.soundOff()}</span><span class="sound-label">${esc(SOUND_STATE.off)}</span></button>
          <span class="sr-only" id="tip-b-sound">${esc(TOOLTIPS.sound)}</span>
          <p class="nudge" id="sound-nudge" hidden>${esc(UI_TEXT.soundNudge)}</p>
          <p class="silence-note" id="silence-note" role="status" hidden>${esc(SOUND_SILENCE.chaotic)}</p>
        </div>
        <div class="tools-more" id="tools-more">
          ${tool("b-labels", "labels", ICON.labels(), 'aria-pressed="true"')}
          ${tool("b-cutaway", "cutOpen", ICON.cut(), 'aria-pressed="false"')}
          <button class="tool tool--icon" id="b-record" aria-pressed="false" aria-describedby="tip-b-record" data-tip="${esc(RECORD_TIP)}"><span class="rec-icon">${ICON.record()}</span><span class="rec-time" id="rec-time-button" aria-hidden="true"></span><span class="tool-text" id="record-label">${esc(LABELS.record)}</span></button>
          <span class="sr-only" id="tip-b-record">${esc(RECORD_TIP)}</span>
          ${tool("b-help", "help", ICON.help(), 'aria-expanded="false" aria-controls="drawer" aria-keyshortcuts="?"')}
          <button class="tool tool--text only-narrow" id="b-credits-menu" aria-controls="drawer">${esc(UI_TEXT.credits)}</button>
        </div>
        <button class="tool tool--icon only-narrow" id="b-more" aria-expanded="false" aria-controls="tools-more" aria-label="${esc(UI_TEXT.more)}">${ICON.more()}</button>
      </div>
    </header>
    <p class="rec-chip" id="rec-chip" hidden><span class="rec-dot" aria-hidden="true"></span><span id="rec-time">${UI_TEXT.recording} 0:00 / 0:30</span></p>

    <div class="hero-chip" id="hero-chip" aria-hidden="true"><span class="chip-mark"></span><span class="hero-chip-text"></span></div>
  </div>

  <section class="status" id="status" aria-label="Heart status">
    <div class="status-head">
      <div class="status-chip"><span class="chip-mark"></span><span class="status-name"></span></div>
      <div class="status-medical"></div>
      <div class="status-rate"><span class="status-num"></span><span class="status-unit"></span></div>
      <div class="status-busy" aria-hidden="true"><span></span></div>
    </div>
    <div class="status-pump"><span class="meter" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="status-pumping"></span></div>
    <p class="status-medical-phone"></p>
    <p class="status-text"></p>
    <p class="status-next"><span class="next-label">${esc(UI_TEXT.next)}</span><span class="next-text"></span></p>
    <p class="status-silence" id="status-silence" hidden>${esc(SOUND_SILENCE.chaotic)}</p>
    <p class="toast" id="toast" role="status" hidden></p>
  </section>
  <p class="sr-only" id="status-live" aria-live="polite" aria-atomic="true"></p>
  <p class="sr-only" id="lesson-live" aria-live="polite" aria-atomic="true"></p>

  <div class="actions-wrap" id="actions-wrap">
    <div class="actions" id="actions" role="group" aria-label="${esc(UI_TEXT.breakIt)} or ${esc(UI_TEXT.fixIt.toLowerCase())}">
      <span class="act-label act-label--break" aria-hidden="true">${esc(UI_TEXT.breakIt)}</span>
      <div class="act-row">
        ${act("b-extra", "extraBeat", "E", true)}
        ${act("b-race", "racing", "R", true)}
        ${act("b-fib", "fibrillation", "F", true)}
      </div>
      <span class="act-spacer" aria-hidden="true"></span>
      <span class="act-divider" aria-hidden="true"></span>
      <span class="act-label act-label--fix" aria-hidden="true">${esc(UI_TEXT.fixIt)}</span>
      <button class="act act--shock" id="b-shock" aria-keyshortcuts="S" aria-describedby="tip-b-shock">${ICON.bolt()}<span class="act-text">${esc(LABELS.shock)}</span><span class="shock-suffix" aria-hidden="true">: ${esc(UI_TEXT.fixIt.toLowerCase())}</span><kbd aria-hidden="true">S</kbd></button>
      <span class="sr-only" id="tip-b-shock">${esc(TOOLTIPS.shock)}</span>
      <p class="shock-callout" id="shock-callout" hidden>${esc(UI_TEXT.pressShock)}</p>
    </div>
  </div>

  <section class="dock" id="dock" aria-label="Simulated electrocardiogram">
    <div class="dock-bar">
      <div class="dock-id">
        <span class="dock-title">ECG</span>
        <span class="dock-lead" id="dock-lead" title="${esc(TOOLTIPS.stripLead)}"><span class="lead-name">${esc(fill(UI_TEXT.leadPlain, { lead: "II" }))}</span><span class="lead-more"></span><span class="sr-only lead-why"></span></span>
        <span class="dock-note">${esc(DISCLAIMER.banner)}</span>
      </div>
      <div class="dock-compare-title">
        <span class="dock-title">ECG</span>
        <span class="dock-lead">${esc(UI_TEXT.compareTitle)}</span>
      </div>
      <div class="dock-tools">
        <div class="seg" role="group" aria-label="ECG view">
          <button data-ecg="single" aria-pressed="true">${esc(UI_TEXT.liveStrip)}</button>
          <button data-ecg="twelve" aria-pressed="false">${esc(UI_TEXT.twelveLeads)}</button>
          <button data-ecg="compare" aria-pressed="false" aria-label="${esc(LABELS.compare)}" title="${esc(TOOLTIPS.compare)}">${esc(UI_TEXT.compareShort)}</button>
        </div>
        <button class="dock-btn dock-back" id="b-back" type="button">${ICON.close(16)}<span>${esc(UI_TEXT.backToLive)}</span></button>
        <button class="dock-btn only-wide" id="b-credits" aria-controls="drawer">${esc(UI_TEXT.credits)}</button>
      </div>
    </div>
    <div class="dock-body">
      <canvas id="monitor"></canvas>
      <div class="compare" id="compare" hidden></div>
    </div>
  </section>

  <nav class="phone-row only-narrow" aria-label="${esc(LABELS.lessons)} and ${esc(LABELS.explore.toLowerCase())}">
    <button class="row-btn" data-open="lessons">${ICON.lessons(18)}<span>${esc(LABELS.lessons)}</span></button>
    <button class="row-btn" data-open="explore">${ICON.explore(18)}<span>${esc(LABELS.explore)}</span></button>
  </nav>

  <section class="coach" id="coach" aria-label="Getting started" hidden>
    <div class="coach-head">
      <span class="coach-title">${esc(UI_TEXT.coachTitle)}</span>
      <button class="coach-hide" id="b-coach-hide" aria-label="${esc(UI_TEXT.coachHide)}">${ICON.close()}</button>
    </div>
    <ol class="coach-steps">
      ${FIRST_RUN_STEPS.map(
        (s, i) =>
          `<li class="coach-step" data-state="todo"><span class="coach-num" aria-hidden="true">${i + 1}</span><div class="coach-words"><div class="coach-step-title">${esc(s.title)}</div><div class="coach-step-body">${esc(s.body)}</div></div></li>`,
      ).join("")}
    </ol>
    <div class="coach-finished" hidden><p>${esc(UI_TEXT.coachFinished)}</p><button class="btn btn--primary" id="b-coach-lessons">${esc(UI_TEXT.openLessons)}</button></div>
  </section>

  <aside class="drawer" id="drawer" aria-label="${esc(LABELS.lessons)}, ${esc(LABELS.explore.toLowerCase())} and help" hidden>
    <div class="drawer-head">
      <div class="drawer-tabs" role="group" aria-label="Panel">
        <button data-tab="lessons" aria-pressed="true">${esc(LABELS.lessons)}</button>
        <button data-tab="explore" aria-pressed="false">${esc(LABELS.explore)}</button>
        <button data-tab="help" aria-pressed="false">${esc(LABELS.help)}</button>
      </div>
      <button class="drawer-close" id="b-drawer-close" aria-label="${esc(UI_TEXT.close)}">${ICON.close()}</button>
    </div>
    <div class="drawer-body">
      <section class="panel" data-panel="lessons" id="lessons"></section>

      <section class="panel" data-panel="explore" hidden>
        <p class="panel-note">${esc(DISCLAIMER.explore)}</p>
        <button class="switch" id="b-pacemaker" role="switch" aria-checked="true" aria-describedby="help-pacemaker">
          <span class="switch-words"><span class="switch-name">${esc(LABELS.pacemaker)}</span><span class="switch-state" id="pacemaker-state"></span></span>
          <span class="switch-track" aria-hidden="true"><span class="switch-knob"></span></span>
        </button>
        <p class="help" id="help-pacemaker">${esc(TOOLTIPS.pacemaker)}</p>

        <h3 class="panel-h">${esc(UI_TEXT.triggersTitle)}</h3>
        <div class="row">
          <button class="btn" id="b-beat" aria-keyshortcuts="B">${esc(UI_TEXT.fireOne)}<kbd aria-hidden="true">B</kbd></button>
          <button class="btn" id="b-burst" aria-describedby="help-burst">${esc(UI_TEXT.rapidBurst)}</button>
        </div>
        <p class="help" id="help-burst">${esc(UI_TEXT.rapidBurstTip)}</p>

        <h3 class="panel-h">${esc(UI_TEXT.tissueTitle)}</h3>
        <div class="field">
          <label for="s-conduction"><span>${esc(LABELS.conduction)}</span><span class="value" id="v-conduction">1.00x</span></label>
          <input type="range" id="s-conduction" min="${SLIDER_LIMITS.conduction.min}" max="${SLIDER_LIMITS.conduction.max}" step="${SLIDER_LIMITS.conduction.step}" value="1" aria-describedby="help-conduction" />
          <p class="help" id="help-conduction">${esc(TOOLTIPS.conduction)}</p>
        </div>
        <div class="field">
          <label for="s-recovery"><span>${esc(LABELS.recovery)}</span><span class="value" id="v-recovery">1.00x</span></label>
          <input type="range" id="s-recovery" min="${SLIDER_LIMITS.recovery.min}" max="${SLIDER_LIMITS.recovery.max}" step="${SLIDER_LIMITS.recovery.step}" value="1" aria-describedby="help-recovery" />
          <p class="help" id="help-recovery">${esc(TOOLTIPS.recovery)}</p>
        </div>
        <div class="seg seg--full" role="group" aria-label="Tissue presets">
          <button data-preset="healthy" aria-pressed="true" title="${esc(TOOLTIPS.presetHealthy)}">${esc(LABELS.presetHealthy)}</button>
          <button data-preset="fragile" aria-pressed="false" title="${esc(TOOLTIPS.presetFragile)}">${esc(LABELS.presetFragile)}</button>
          <button data-preset="veryFragile" aria-pressed="false" title="${esc(TOOLTIPS.presetVeryFragile)}">${esc(LABELS.presetVeryFragile)}</button>
        </div>
        <p class="help" id="preset-help">${esc(TOOLTIPS.presetHealthy)}</p>
        <p class="warn-note" id="shock-first" role="status" hidden>${esc(UI_TEXT.shockFirst)}</p>

        <h3 class="panel-h">${esc(UI_TEXT.viewTitle)}</h3>
        <div class="field">
          <span class="field-label" id="speed-label">${esc(LABELS.speed)}</span>
          <div class="seg seg--full" role="group" aria-labelledby="speed-label">
            <button data-speed="real" aria-pressed="true">Real time</button>
            <button data-speed="medium" aria-pressed="false">½×</button>
            <button data-speed="slow" aria-pressed="false">¼×</button>
          </div>
          <p class="help">${esc(TOOLTIPS.speed)}</p>
        </div>
        <div class="field" id="f-cut">
          <label for="s-cut"><span>${esc(UI_TEXT.cutDepth)}</span></label>
          <input type="range" id="s-cut" min="-1" max="1" step="0.05" value="0" disabled />
          <p class="help">${esc(TOOLTIPS.cutOpen)}</p>
        </div>
        <p class="readout" id="readout"></p>
      </section>

      <section class="panel" data-panel="help" hidden>
        <h3 class="panel-h">${esc(UI_TEXT.guideTitle)}</h3>
        <p>${esc(DISCLAIMER.explore)}</p>
        <p>${esc(DISCLAIMER.ecgLine)}</p>
        <p>${esc(SOUND_NOTE)}</p>
        <h3 class="panel-h only-fine">${esc(UI_TEXT.keysTitle)}</h3>
        <dl class="keys only-fine">${KEYS.map(([k, v]) => `<div><dt><kbd>${esc(k)}</kbd></dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
        <h3 class="panel-h">${esc(UI_TEXT.termsTitle)}</h3>
        <dl class="terms">${Object.entries(TERMS)
          .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
          .join("")}</dl>
        <h3 class="panel-h" id="credits" tabindex="-1">${esc(UI_TEXT.credits)}</h3>
        <ul class="credits-list">${CREDITS.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
        <p><a class="credits-link" href="https://github.com/ramenprotokol/arrhythmia-lab" rel="noopener">Source code</a></p>
      </section>
    </div>
  </aside>

  <div class="overlay" id="loading" role="status"><div><div class="spinner"></div><h2 id="loading-title">Loading</h2><p class="muted">${esc(DISCLAIMER.banner)}</p></div></div>
</div>`;

function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`page markup is missing #${id}`);
  return el as T;
}

const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function buildDom(root: HTMLElement): Dom {
  root.innerHTML = html;
  const lab = need("lab");
  const stage = need("stage");
  const heartCanvas = need<HTMLCanvasElement>("heart");
  const monitorCanvas = need<HTMLCanvasElement>("monitor");
  const compareEl = need("compare");
  const recordButton = need<HTMLButtonElement>("b-record");
  const recordLabel = need("record-label");
  const loading = need("loading");
  const loadingTitle = need("loading-title");
  const toastEl = need("toast");
  const lessonsEl = need("lessons");
  const pacemakerBtn = need<HTMLButtonElement>("b-pacemaker");
  const pacemakerState = need("pacemaker-state");
  const cutBtn = need<HTMLButtonElement>("b-cutaway");
  const cutSlider = need<HTMLInputElement>("s-cut");
  const conduction = need<HTMLInputElement>("s-conduction");
  const recovery = need<HTMLInputElement>("s-recovery");
  const labelsBtn = need<HTMLButtonElement>("b-labels");
  const labelsEl = need("labels");
  const soundBtn = need<HTMLButtonElement>("b-sound");
  const nudge = need("sound-nudge");
  const silenceNote = need("silence-note");
  const statusSilence = need("status-silence");
  const recChip = need("rec-chip");
  const recTime = need("rec-time");
  const status = need("status");
  const statusLive = need("status-live");
  const heroChip = need("hero-chip");
  const actionsWrap = need("actions-wrap");
  const shockCallout = need("shock-callout");
  const dock = need("dock");
  const dockLead = need("dock-lead");
  const drawer = need("drawer");
  const coachEl = need("coach");
  const toolsMore = need("tools-more");
  const moreBtn = need<HTMLButtonElement>("b-more");
  const tapMarker = need("tap-marker");
  const flash = need("flash");
  const topbar = need("topbar");
  const labelNodes = new Map<string, HTMLElement>();
  let actions: Actions | null = null;
  let toastTimer = 0;
  /** The message up now answers the rhythm on show. */
  let toastAboutRhythm = false;
  let lastStepKey = "";
  let lastStatusKey = "";
  let drawerOpener: HTMLElement | null = null;
  let view: EcgView = "single";
  let free = { top: 0, right: 0, bottom: 0, left: 0 };

  const fmt = (v: number): string => `${v.toFixed(2)}x`;
  const press = (buttons: NodeListOf<HTMLElement>, attr: string, value: string): void =>
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === value)));
  const setText = (el: Element | null, text: string): void => {
    if (el && el.textContent !== text) el.textContent = text;
  };

  // ---- drawer --------------------------------------------------------------------------------------------------
  const tabs = document.querySelectorAll<HTMLButtonElement>("[data-tab]");
  const panels = document.querySelectorAll<HTMLElement>("[data-panel]");
  const openers: Record<DrawerTab, HTMLElement[]> = {
    lessons: [need("b-lessons"), ...document.querySelectorAll<HTMLElement>('[data-open="lessons"]')],
    explore: [need("b-explore"), ...document.querySelectorAll<HTMLElement>('[data-open="explore"]')],
    help: [need("b-help")],
  };
  const currentTab = (): DrawerTab | null => (drawer.hidden ? null : ((drawer.dataset.tab as DrawerTab | undefined) ?? "lessons"));
  const syncOpeners = (): void => {
    const tab = currentTab();
    for (const [name, els] of Object.entries(openers) as [DrawerTab, HTMLElement[]][]) els.forEach((el) => el.setAttribute("aria-expanded", String(tab === name)));
  };
  const openDrawer = (tab: DrawerTab, opener?: HTMLElement): void => {
    const wasOpen = !drawer.hidden;
    drawer.hidden = false;
    drawer.dataset.tab = tab;
    lab.dataset.drawer = "open";
    tabs.forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.tab === tab)));
    panels.forEach((p) => (p.hidden = p.dataset.panel !== tab));
    if (opener) {
      drawerOpener = opener;
      // a visitor who opened it lands in it, on the tab they asked for
      if (!wasOpen) Array.from(tabs).find((t) => t.dataset.tab === tab)?.focus({ preventScroll: true });
    }
    syncOpeners();
    closeMenu();
    if (!wasOpen) actions?.layout();
    if (window.matchMedia("(max-width: 860px)").matches) drawer.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
  };
  const closeDrawer = (): void => {
    if (drawer.hidden) return;
    drawer.hidden = true;
    lab.dataset.drawer = "closed";
    syncOpeners();
    actions?.layout();
    drawerOpener?.focus({ preventScroll: true });
  };
  const toggleDrawer = (tab: DrawerTab, opener: HTMLElement): void => {
    if (currentTab() === tab) closeDrawer();
    else openDrawer(tab, opener);
  };
  for (const [name, els] of Object.entries(openers) as [DrawerTab, HTMLElement[]][]) els.forEach((el) => el.addEventListener("click", () => toggleDrawer(name, el)));
  tabs.forEach((t) => t.addEventListener("click", () => openDrawer(t.dataset.tab as DrawerTab)));
  need("b-drawer-close").addEventListener("click", () => closeDrawer());

  // ---- the phone's "more" menu and the credits ---------------------------------------------------------------
  const closeMenu = (): void => {
    if (lab.dataset.more !== "open") return;
    lab.dataset.more = "closed";
    moreBtn.setAttribute("aria-expanded", "false");
  };
  moreBtn.addEventListener("click", () => {
    const open = lab.dataset.more !== "open";
    lab.dataset.more = open ? "open" : "closed";
    moreBtn.setAttribute("aria-expanded", String(open));
    if (open) toolsMore.querySelector<HTMLElement>("button")?.focus();
  });
  toolsMore.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button") && window.matchMedia("(max-width: 860px)").matches) closeMenu();
  });
  // The credits are a section of "What is this?": the drawer opens beside the heart, never on it.
  for (const b of [need("b-credits"), need("b-credits-menu")]) {
    b.addEventListener("click", () => {
      openDrawer("help", b);
      const heading = need("credits");
      heading.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
      heading.focus({ preventScroll: true });
    });
  }
  // A click anywhere outside the phone's "more" menu closes it.
  document.addEventListener("click", (e) => {
    if (lab.dataset.more !== "open") return;
    const t = e.target as Element | null;
    if (t && (t.closest("#tools-more") || t.closest("#b-more"))) return;
    closeMenu();
  });

  // ---- ECG views ----------------------------------------------------------------------------------------------
  const setView = (next: EcgView): void => {
    view = next;
    lab.dataset.view = next;
    compareEl.hidden = next !== "compare";
    press(document.querySelectorAll<HTMLElement>("[data-ecg]"), "ecg", next);
  };
  document.querySelectorAll<HTMLElement>("[data-ecg]").forEach((b) => b.addEventListener("click", () => actions?.ecgView(b.dataset.ecg as EcgView)));
  need("b-back").addEventListener("click", () => actions?.ecgView("single"));

  // ---- the lessons --------------------------------------------------------------------------------------------
  const button = (label: string, cls: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = `btn ${cls}`.trim();
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  };

  const dom: Dom = {
    root: lab,
    stage,
    heartCanvas,
    monitorCanvas,
    compareEl,
    recordButton,
    recordLabel,
    watched: [stage, dock, drawer, status, coachEl, actionsWrap, topbar],

    blockers() {
      return { top: [topbar, heroChip], left: [status], right: [coachEl, drawer], bottom: [actionsWrap, dock] };
    },
    setFreeArea(insets) {
      free = { ...insets };
    },

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
    toast(message, aboutRhythm = false) {
      toastEl.textContent = message;
      toastEl.hidden = false;
      toastAboutRhythm = aboutRhythm;
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => (toastEl.hidden = true), 5000);
    },
    clearRhythmToast() {
      if (!toastAboutRhythm || toastEl.hidden) return;
      window.clearTimeout(toastTimer);
      toastEl.hidden = true;
    },

    fitPanels() {
      const wide = !window.matchMedia("(max-width: 860px)").matches;
      // Compare: the dock grows to show every line of the panel, up to half the window (past that, the panel scrolls).
      const content = compareEl.firstElementChild as HTMLElement | null;
      if (wide && view === "compare" && content) {
        const bar = dock.querySelector(".dock-bar") as HTMLElement;
        const border = dock.offsetHeight - dock.clientHeight;
        const want = Math.ceil(bar.offsetHeight + content.offsetHeight + border);
        const h = `${Math.min(want, Math.round(window.innerHeight * 0.5))}px`;
        if (lab.style.getPropertyValue("--dock-h") !== h) lab.style.setProperty("--dock-h", h);
      } else if (lab.style.getPropertyValue("--dock-h") !== "") {
        lab.style.removeProperty("--dock-h");
      }
      // A phone's fixed Break/Fix bar: the page keeps that much room at its end, so nothing ever sits underneath it.
      const barH = wide ? "" : `${Math.ceil(actionsWrap.offsetHeight)}px`;
      if (lab.style.getPropertyValue("--bar-h") !== barH) {
        if (barH) lab.style.setProperty("--bar-h", barH);
        else lab.style.removeProperty("--bar-h");
      }
      // "Press Shock" goes beside the bar when there is room for it there (inside the bar's own lane, clear of the drawer).
      const bar = need("actions").getBoundingClientRect();
      const lane = actionsWrap.getBoundingClientRect();
      const callout = wide && lane.right - bar.right >= CALLOUT_ROOM ? "beside" : "none";
      if (lab.dataset.callout !== callout) lab.dataset.callout = callout;
      // In the tall-dock views the card keeps its "Next" line for an alarm (it says what to do), where it clears the moves.
      if (wide && view !== "single" && status.dataset.tone === "alarm") {
        lab.dataset.nextFits = "true";
        const card = status.getBoundingClientRect();
        const meets = card.left < bar.right && bar.left < card.right && card.bottom > bar.top - 8;
        if (meets) lab.dataset.nextFits = "false";
      } else if (lab.dataset.nextFits !== undefined) {
        delete lab.dataset.nextFits;
      }
    },

    showStatus(v) {
      const toneChanged = status.dataset.tone !== v.tone;
      lab.dataset.status = v.key;
      lab.dataset.tone = v.tone;
      status.dataset.tone = v.tone;
      status.dataset.busy = String(v.busy);
      status.dataset.norate = String(v.value === NO_RATE);
      setText(status.querySelector(".status-name"), v.name);
      const medical = v.medicalName ? `${UI_TEXT.medicalName} ${v.medicalName}` : "";
      setText(status.querySelector(".status-medical"), medical);
      // a phone hides the card's head (the chip over the heart names the rhythm), so the medical name has its own line
      setText(status.querySelector(".status-medical-phone"), medical);
      setText(status.querySelector(".status-num"), v.value);
      setText(status.querySelector(".status-unit"), v.unit);
      setText(status.querySelector(".status-pumping"), v.pumping);
      setText(status.querySelector(".status-text"), v.sentence);
      setText(status.querySelector(".next-text"), v.next);
      (status.querySelector(".status-next") as HTMLElement).hidden = v.next === "";
      status.querySelectorAll<HTMLElement>(".meter i").forEach((bar, i) => bar.classList.toggle("on", i < v.bars));
      heroChip.dataset.tone = v.tone;
      setText(heroChip.querySelector(".hero-chip-text"), v.busy || v.value === NO_RATE ? v.name : `${v.name} · ${v.value} ${v.unit}`);
      if (v.key !== lastStatusKey) {
        lastStatusKey = v.key;
        statusLive.textContent = v.busy ? `${v.name} ${v.sentence}` : `${v.name}. ${v.pumping}.`;
      }
      // the card's "Next" line in the tall-dock views depends on the tone: fit again, now the card holds the new words
      if (toneChanged && view !== "single") dom.fitPanels();
    },

    showMoves(s) {
      const race = need<HTMLButtonElement>("b-race");
      const fib = need<HTMLButtonElement>("b-fib");
      const extra = need<HTMLButtonElement>("b-extra");
      race.setAttribute("aria-pressed", String(s.racing));
      fib.setAttribute("aria-pressed", String(s.fibrillating));
      extra.setAttribute("aria-pressed", String(s.extra));
      for (const b of [race, fib, extra]) {
        b.setAttribute("aria-disabled", String(s.locked));
        b.title = s.locked ? UI_TEXT.lessonBusy : "";
      }
      const shock = need("b-shock");
      shock.classList.toggle("armed", s.armed);
      shockCallout.hidden = !s.armed;
      lab.dataset.armed = String(s.armed);
    },

    showSound(state, chaotic, unavailable = false) {
      if ((soundBtn.getAttribute("aria-disabled") === "true") !== unavailable) {
        // still focusable and clickable, so a keyboard or a click can learn why
        soundBtn.setAttribute("aria-disabled", String(unavailable));
        soundBtn.title = unavailable ? UI_TEXT.soundUnavailable : "";
        setText(need("tip-b-sound"), unavailable ? UI_TEXT.soundUnavailable : TOOLTIPS.sound);
      }
      soundBtn.setAttribute("aria-pressed", String(state !== "off"));
      soundBtn.dataset.state = state;
      setText(soundBtn.querySelector(".sound-label"), SOUND_STATE[state]);
      const icon = soundBtn.querySelector(".sound-icon") as HTMLElement;
      const want = state === "off" ? "off" : "on";
      if (icon.dataset.kind !== want) {
        icon.dataset.kind = want;
        icon.innerHTML = state === "off" ? ICON.soundOff() : ICON.soundOn();
      }
      const silent = state === "on" && chaotic;
      silenceNote.hidden = !silent;
      statusSilence.hidden = !silent;
    },
    showSoundNudge(on) {
      nudge.hidden = !on;
      soundBtn.classList.toggle("nudging", on);
    },

    showLead(name, automatic, note) {
      // "Lead V2" always shows; ", chosen automatically" gives way on narrow screens.
      const full = fill(automatic ? UI_TEXT.leadAuto : UI_TEXT.leadPlain, { lead: name });
      const short = fill(UI_TEXT.leadPlain, { lead: name });
      setText(dockLead.querySelector(".lead-name"), short);
      setText(dockLead.querySelector(".lead-more"), full.slice(short.length));
      // why the strip left lead II: a hover tip, and read out after the lead's name
      setText(dockLead.querySelector(".lead-why"), note ? `. ${note}` : "");
      dockLead.title = note || TOOLTIPS.stripLead;
    },
    showEcgView(next) {
      setView(next);
    },
    showEcgHeld(held) {
      if ((dock.dataset.held === "true") !== held) dock.dataset.held = String(held);
    },

    showTissue(t) {
      conduction.value = String(t.conduction);
      recovery.value = String(t.recovery);
      setText(need("v-conduction"), fmt(t.conduction));
      setText(need("v-recovery"), fmt(t.recovery));
      const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
      const preset: PresetName | null = near(t.conduction, 1) && near(t.recovery, 1) ? "healthy" : near(t.conduction, 0.7) && near(t.recovery, 0.3) ? "fragile" : near(t.conduction, 0.5) && near(t.recovery, 0.17) ? "veryFragile" : null;
      document.querySelectorAll<HTMLElement>("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === preset)));
      const tip = preset === "fragile" ? TOOLTIPS.presetFragile : preset === "veryFragile" ? TOOLTIPS.presetVeryFragile : TOOLTIPS.presetHealthy;
      setText(need("preset-help"), tip);
    },
    showPacemaker(on) {
      pacemakerBtn.setAttribute("aria-checked", String(on));
      setText(pacemakerState, on ? `On · 75 ${HUD.rateUnit}` : "Off");
    },
    showSpeed(name) {
      press(document.querySelectorAll<HTMLElement>("[data-speed]"), "speed", name);
    },
    showReadout(firing, simTimeMs) {
      setText(need("readout"), `${HUD.firing} ${Math.round(firing * 100)}% · ${HUD.time} ${(simTimeMs / 1000).toFixed(1)} s`);
    },
    showShockFirst(on) {
      need("shock-first").hidden = !on;
    },
    showRecording(recording, elapsedMs, maxMs) {
      recChip.hidden = !recording;
      lab.dataset.recording = String(recording);
      const icon = recordButton.querySelector(".rec-icon") as HTMLElement;
      if (icon.dataset.kind !== String(recording)) {
        icon.dataset.kind = String(recording);
        icon.innerHTML = recording ? ICON.stop() : ICON.record();
      }
      if (!recording) return;
      const mmss = (ms: number) => {
        const s = Math.max(0, Math.floor(ms / 1000));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      };
      setText(recTime, `${UI_TEXT.recording} ${mmss(elapsedMs)} / ${mmss(maxMs)}`);
      setText(need("rec-time-button"), `${mmss(elapsedMs)} / ${mmss(maxMs)}`);
    },

    flashShock() {
      if (reducedMotion()) {
        flash.animate(
          [
            { opacity: 1, background: "transparent", boxShadow: "inset 0 0 0 3px rgba(255, 196, 107, 0.9)" },
            { opacity: 1, background: "transparent", boxShadow: "inset 0 0 0 3px rgba(255, 196, 107, 0)" },
          ],
          { duration: 450, easing: "ease-out" },
        );
        return;
      }
      // A light, short veil over the page: the heart's own amber flush (drawn by the renderer) carries the shock, and a
      // strong white veil on top of it washed the heart out for the first tenth of a second.
      flash.animate([{ opacity: 0 }, { opacity: 0.2, offset: 0.15 }, { opacity: 0 }], { duration: 200, easing: "ease-out" });
    },
    ripple(x, y) {
      const r = document.createElement("span");
      r.className = "ripple";
      r.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      stage.append(r);
      const done = () => r.remove();
      if (reducedMotion()) {
        r.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 400 }).finished.then(done, done);
      } else {
        r.animate(
          [
            { opacity: 0.95, scale: "0.15" },
            { opacity: 0, scale: "1" },
          ],
          { duration: 650, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
        ).finished.then(done, done);
      }
    },
    missHint(x, y) {
      const tip = document.createElement("span");
      tip.className = "miss-hint";
      tip.textContent = UI_TEXT.tapMiss;
      tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      stage.append(tip);
      const done = () => tip.remove();
      tip.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 1600 }).finished.then(done, done);
    },
    placeTapMarker(x, y, show) {
      if (tapMarker.hidden === show) tapMarker.hidden = !show;
      if (show) tapMarker.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    },

    showCoach(coach) {
      coachEl.hidden = coach.hidden;
      lab.dataset.coach = coach.hidden ? "hidden" : "shown";
      if (coach.hidden) return;
      const current = coach.current;
      coachEl.querySelectorAll<HTMLElement>(".coach-step").forEach((li, i) => {
        const state = coach.done[i] ? "done" : i === current ? "current" : "todo";
        li.dataset.state = state;
        li.dataset.step = String(i);
        const num = li.querySelector(".coach-num") as HTMLElement;
        const want = coach.done[i] ? ICON.check() : String(i + 1);
        if (num.dataset.shown !== (coach.done[i] ? "check" : "num")) {
          num.dataset.shown = coach.done[i] ? "check" : "num";
          num.innerHTML = want;
        }
        const body = FIRST_RUN_STEPS[i];
        // What a finished step taught stays under it until the next one is done; older ones fold to their title.
        const latestDone = coach.done[i] && (i === 2 || !coach.done[i + 1]);
        li.dataset.latest = String(latestDone);
        let words = body.body;
        if (coach.done[i]) words = i === 1 && coach.broke === "chaotic" ? UI_TEXT.coachBrokeChaotic : body.done;
        setText(li.querySelector(".coach-step-body"), words);
      });
      (coachEl.querySelector(".coach-finished") as HTMLElement).hidden = !coach.finished;
    },

    openDrawer: (tab) => openDrawer(tab),
    closeDrawer,
    drawerTab: currentTab,

    closeTopmost() {
      if (lab.dataset.more === "open") {
        closeMenu();
        moreBtn.focus();
        return true;
      }
      if (view === "compare") {
        actions?.ecgView("single");
        return true;
      }
      if (!drawer.hidden) {
        closeDrawer();
        return true;
      }
      return false;
    },

    onAction(a) {
      actions = a;
      need("b-extra").addEventListener("click", () => a.extra());
      need("b-race").addEventListener("click", () => a.race());
      need("b-fib").addEventListener("click", () => a.fibrillate());
      need("b-shock").addEventListener("click", () => a.shock());
      need("b-beat").addEventListener("click", () => a.beat());
      need("b-burst").addEventListener("click", () => a.burst());
      soundBtn.addEventListener("click", () => a.sound());
      pacemakerBtn.addEventListener("click", () => a.pacemaker(pacemakerBtn.getAttribute("aria-checked") !== "true"));
      conduction.addEventListener("input", () => {
        setText(need("v-conduction"), fmt(Number(conduction.value)));
        a.tissue({ conduction: Number(conduction.value) });
      });
      recovery.addEventListener("input", () => {
        setText(need("v-recovery"), fmt(Number(recovery.value)));
        a.tissue({ recovery: Number(recovery.value) });
      });
      document.querySelectorAll<HTMLElement>("[data-preset]").forEach((b) => b.addEventListener("click", () => a.preset(b.dataset.preset as PresetName)));
      cutBtn.addEventListener("click", () => {
        const on = cutBtn.getAttribute("aria-pressed") !== "true";
        cutBtn.setAttribute("aria-pressed", String(on));
        cutSlider.disabled = !on;
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
      need("b-coach-lessons").addEventListener("click", () => openDrawer("lessons", need("b-coach-lessons")));
    },
    onCoachHide(cb) {
      need("b-coach-hide").addEventListener("click", cb);
    },

    addLabel(id, text) {
      const el = document.createElement("span");
      el.className = "label";
      el.textContent = text;
      el.hidden = true;
      labelsEl.append(el);
      labelNodes.set(id, el);
    },
    placeLabel(id, x, y, show) {
      const el = labelNodes.get(id);
      if (!el) return;
      const on = show && labelsBtn.getAttribute("aria-pressed") === "true";
      if (el.hidden === on) el.hidden = !on;
      if (!on) return;
      // A label sits to the right of its point; near the right edge of the free area it turns to sit on the left.
      const width = el.offsetWidth;
      const flip = x + 12 + width > stage.clientWidth - free.right;
      if (el.classList.contains("flip") !== flip) el.classList.toggle("flip", flip);
      el.style.transform = `translate(${Math.round(flip ? x - width : x)}px, ${Math.round(y)}px)`;
    },
    labelsOn() {
      return labelsBtn.getAttribute("aria-pressed") === "true";
    },

    renderLessons(lessons, state) {
      lessonsEl.replaceChildren();
      const h = document.createElement("h2");
      h.className = "panel-title";
      h.textContent = LESSON_UI.title;
      lessonsEl.append(h);

      const lesson = lessons.find((l) => l.id === state.lessonId);
      lab.dataset.lesson = lesson && !state.finished ? "running" : "none";
      if (!lesson || !actions) {
        const intro = document.createElement("p");
        intro.className = "panel-note";
        intro.textContent = LESSON_UI.intro;
        const list = document.createElement("div");
        list.className = "lesson-list";
        lessons.forEach((l, i) => {
          const b = document.createElement("button");
          b.className = "btn lesson-btn";
          const num = document.createElement("span");
          num.className = "num";
          num.textContent = String(i + 1);
          b.append(num, document.createTextNode(l.title));
          b.title = l.summary;
          b.addEventListener("click", () => actions?.lessonStart(l.id));
          list.append(b);
        });
        lessonsEl.append(intro, list);
        return;
      }

      const title = document.createElement("p");
      title.className = "lesson-title";
      title.textContent = lesson.title;
      lessonsEl.append(title);

      const total = lesson.steps.length;
      const bar = document.createElement("div");
      bar.className = "progress";
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", fill(UI_TEXT.stepOf, { n: Math.min(state.stepIndex + 1, total), total }));
      for (let i = 0; i < total; i++) {
        const seg = document.createElement("i");
        if (i < state.stepIndex) seg.className = "done";
        else if (i === state.stepIndex && !state.finished) seg.className = "now";
        bar.append(seg);
      }
      lessonsEl.append(bar);

      if (state.finished || !state.step) {
        const p = document.createElement("p");
        p.className = "lesson-done";
        p.textContent = LESSON_UI.complete;
        const row = document.createElement("div");
        row.className = "row";
        row.append(
          button(LESSON_UI.back, "btn--ghost", () => actions?.lessonBack()),
          button(LESSON_UI.restart, "", () => actions?.lessonRestart()),
          button(LESSON_UI.allLessons, "btn--primary", () => actions?.lessonStop()),
        );
        lessonsEl.append(p, row);
        return;
      }

      const step = state.step;
      const words = document.createElement("div");
      words.className = "lesson-step";
      if (step.title) {
        const t = document.createElement("p");
        t.className = "step-title";
        t.textContent = step.title;
        words.append(t);
      }
      step.text.split("\n\n").forEach((para) => {
        const p = document.createElement("p");
        p.textContent = para;
        words.append(p);
      });
      lessonsEl.append(words);

      const key = `${lesson.id}:${state.stepIndex}`;
      if (key !== lastStepKey) {
        lastStepKey = key;
        need("lesson-live").textContent = `${step.title ? `${step.title}. ` : ""}${step.text}`;
      }
      // The runner offers the step's hint once the viewer seems stuck (timed in simulated time, and only while the
      // step's condition is still unmet, so it never contradicts what is on screen).
      if (state.hint) {
        const line = document.createElement("p");
        line.className = "hintline";
        line.textContent = state.hint;
        lessonsEl.append(line);
      }

      const waits = step.waitFor !== undefined;
      const row = document.createElement("div");
      row.className = "row lesson-row";
      row.append(button(LESSON_UI.back, "btn--ghost", () => actions?.lessonBack()));
      // A step only the viewer can finish (pressing Shock) has no Skip.
      if (!waits || step.canSkip !== false) row.append(button(waits ? LESSON_UI.skip : LESSON_UI.next, waits ? "btn--ghost" : "btn--primary", () => actions?.lessonNext()));
      row.append(
        button(LESSON_UI.restart, "btn--ghost", () => actions?.lessonRestart()),
        button(LESSON_UI.stop, "btn--ghost", () => actions?.lessonStop()),
      );
      lessonsEl.append(row);
    },
  };
  return dom;
}
