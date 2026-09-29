// Every word the page shows about the heart, in one place, so the wording stays plain, honest and consistent. No
// logic lives here: the page picks the string. The limits in the comments (characters or words) are checked by
// tests/ui/lessons.test.ts, because a longer string breaks the layout or stops being read.
//
// Clinical ground rules for anything added here:
//  - This model simulates only the lower chambers (the ventricles). Its steady beat starts in a stand-in for the fast
//    wiring, in the wall between them (the septum), so it looks like a normal beat; a tap or an extra beat starts at one
//    spot and creeps cell to cell, so it looks wide. Never call its rhythm "sinus", never promise a P wave, and never
//    say a beat starts at the tip in a real heart: real beats start at the top.
//  - A shock makes every cell fire at once. It stops racing (VT) and chaotic (VF) rhythms; it cannot start a still
//    heart, and a real AED will not shock a heart that is pumping.
//  - Fibrillation here is ventricular fibrillation (cardiac arrest). Atrial fibrillation is a different, common
//    condition, and this model cannot show it.

/** The states the status card can show. */
export type RhythmKey = "steady" | "extra" | "racing" | "chaotic" | "resetting" | "quiet";

export interface RhythmCopy {
  /** At most 22 characters. */
  name: string;
  /** The term a clinician would use, when there is an honest one. */
  medicalName?: string;
  /** At most 25 words. */
  sentence: string;
  /** Short: "Pumping well", "Barely pumping", "Not pumping". */
  pumping: string;
  /** What to try next. */
  next: string;
}

export const RHYTHM_COPY: Record<RhythmKey, RhythmCopy> = {
  steady: {
    name: "Steady rhythm",
    sentence: "Each beat races through the heart's wiring, so the whole muscle fires almost together, then resets.",
    pumping: "Pumping well",
    next: "Try an early extra beat. Or break it: make it race.",
  },
  extra: {
    name: "Early extra beat",
    medicalName: "Premature ventricular contraction (PVC)",
    sentence: "One spot in the muscle fired early. A pause follows, then the steady rhythm carries on by itself.",
    pumping: "Still pumping",
    next: "Nothing to fix. Occasional extra beats are common and often harmless.",
  },
  racing: {
    name: "Racing rhythm",
    medicalName: "Ventricular tachycardia (VT)",
    sentence: "One wave is circling the heart, restarting each beat far too fast for it to fill. In a person, an emergency.",
    pumping: "Barely pumping",
    next: "Fix it: press Shock. Or make it worse: make it fibrillate.",
  },
  chaotic: {
    name: "Fibrillation",
    medicalName: "Ventricular fibrillation (VF)",
    sentence: "The wave has shattered into many. The muscle quivers instead of squeezing, so no blood moves. In a person: cardiac arrest.",
    pumping: "Not pumping",
    next: "Shock now. In real life: call emergency services, start CPR, use an AED.",
  },
  resetting: {
    name: "After the shock",
    medicalName: "Post-shock pause",
    sentence: "The shock made every cell fire at once, so the circling waves had nowhere left to go. The steady beat returns after a pause.",
    pumping: "Not pumping yet",
    next: "Watch the steady beat come back. The lab also healed the tissue, which stands for treating the cause.",
  },
  quiet: {
    name: "No beats",
    sentence: "Nothing is firing. The steady beat is switched off, so the heart waits for a nudge.",
    pumping: "Not pumping",
    next: "Tap the heart, or switch the steady beat back on.",
  },
};

/** Shown instead of shocking, the way an AED refuses. At most 120 characters each. */
export const SHOCK_REFUSAL = {
  pumping: "No shock advised: this heart is pumping. A real AED checks the rhythm first and would not shock it.",
  still: "No shock advised: nothing is firing. Shocks stop chaotic rhythms; they cannot start a still heart.",
};

/** Shown while the lab finds the moment that starts a rhythm (it takes a few seconds, and the heart may jolt). */
export const STARTING_MESSAGE = {
  racing: "Finding the right moment for an early beat. The heart may jolt while the lab tries.",
  fibrillation: "Firing a rapid burst of beats to shatter the wave. This takes a few seconds.",
};

/** The three-step first run: tap, break, fix. */
export const FIRST_RUN_STEPS: { title: string; body: string; done: string }[] = [
  {
    title: "Tap the heart",
    body: "Tap anywhere on the muscle to start a beat from that spot. Watch the glow spread and the ECG draw it.",
    done: "That glow is electricity. Every squeeze of a real heart follows a wave like it.",
  },
  {
    title: "Break it",
    body: "Press Make it race. The lab times an early beat so that one wave starts chasing its own tail.",
    done: "It is racing: one wave circling, far too fast for the heart to fill and pump.",
  },
  {
    title: "Fix it",
    body: "Press Shock. Every cell fires at once, so the circling wave has nowhere left to go.",
    done: "Fixed. After a pause the steady beat returns. That is what a defibrillator does.",
  },
];

export type TooltipKey =
  | "extraBeat"
  | "racing"
  | "fibrillation"
  | "shock"
  | "sound"
  | "labels"
  | "cutOpen"
  | "record"
  | "help"
  | "lessons"
  | "explore"
  | "compare"
  | "stripLead"
  | "speed"
  | "pacemaker"
  | "conduction"
  | "recovery"
  | "presetHealthy"
  | "presetFragile"
  | "presetVeryFragile";

export const TOOLTIPS: Record<TooltipKey, string> = {
  extraBeat: "One early beat from a spot on the wall, before the next is due. It settles by itself.",
  racing: "Starts ventricular tachycardia: fragile tissue, then one early beat at just the wrong moment.",
  fibrillation: "Starts ventricular fibrillation: very fragile tissue, then a rapid burst of beats. Pumping stops.",
  shock: "Defibrillate: every cell fires at once. Only for racing or chaotic rhythms, never for a heart that is pumping or still.",
  sound: "Heart sounds made live from the simulated beats. Not a recording.",
  labels: "Show the names of the heart's parts.",
  cutOpen: "Slice the heart to see the wave travel through the wall, not just over it.",
  record: "Save a clip of the heart and the ECG to your computer.",
  help: "What am I looking at? A short guide to this lab.",
  lessons: "Five short guided lessons, from one beat to fibrillation and the shock that stops it.",
  explore: "Every control: beats, tissue settings, the view and the speed.",
  compare: "Put a real recorded ECG next to the simulated one.",
  stripLead: "The strip shows lead II while it has a clear signal, otherwise the lead that shows the rhythm best.",
  speed: "Slow motion lets you follow the wave. Real time keeps the true rhythm and sounds.",
  pacemaker: "Steady beat: 75 a minute, started in the heart's wiring, standing in for its own pacemaker at the top.",
  conduction: "How fast the electrical wave travels through the muscle.",
  recovery: "How long each cell needs before it can fire again.",
  presetHealthy: "Healthy tissue: each wave is too long to fit a loop, so circling waves die out.",
  presetFragile: "A slower wave and a quicker reset, like muscle starved of blood. One wave can now circle.",
  presetVeryFragile: "Even shorter waves: one can break into many, which is fibrillation.",
};

/** Names for the controls that the tooltips describe, so a label and its tooltip always agree. */
export const LABELS: Record<TooltipKey, string> = {
  extraBeat: "Early extra beat",
  racing: "Make it race",
  fibrillation: "Make it fibrillate",
  shock: "Shock",
  sound: "Sound",
  labels: "Labels",
  cutOpen: "Cut it open",
  record: "Record clip",
  help: "What is this?",
  lessons: "Lessons",
  explore: "Explore",
  compare: "Compare with a real ECG",
  stripLead: "Lead",
  speed: "Speed",
  pacemaker: "Steady beat",
  conduction: "Conduction speed",
  recovery: "Recovery time",
  presetHealthy: "Healthy",
  presetFragile: "Fragile",
  presetVeryFragile: "Very fragile",
};

/** Each thing said once. banner at most 60 characters, ecgLine at most 140. */
export const DISCLAIMER = {
  banner: "Educational simulation. Not a medical device.",
  ecgLine: "Simulated from a model with no upper chambers (so no P wave) and simplified wiring, so shapes differ from a real ECG.",
  explore:
    "The shape is one real person's heart scan. Only the two lower chambers are simulated. The upper chambers are drawn from the scan; " +
    "the fat and the blood vessels on the surface are added for looks. The tissue is idealised.",
};

/**
 * One honest line under the simulated lane in Compare, for a rhythm whose simulated trace differs from real ones in a
 * way the viewer can see. At most 100 characters each.
 */
export const SIM_ECG_NOTES: Partial<Record<RhythmKey, string>> = {
  racing: "This model's racing rhythm runs faster than most real ventricular tachycardia.",
  chaotic: "This model's fibrillation looks more regular than most real fibrillation.",
};

/** When the strip or the Compare lane leaves lead II. "{lead}" is replaced by the lead's name. */
export const LEAD_CAPTIONS = {
  switched: "Lead II is nearly flat in this rhythm, so the strip shows {lead}, where it is clearest.",
  compare: "The simulated lane shows {lead}: in this rhythm the model's lead II is nearly flat and would show almost nothing.",
};

/** The credit line for the recorded ECGs (the footer and the Compare panel). */
export const RECORDING_CREDIT =
  "Recorded ECGs: PTB-XL, CC BY 4.0; MIT-BIH Arrhythmia Database and CU Ventricular Tachyarrhythmia Database, ODC-By 1.0.";

/** Plain definitions, at most 15 words each. */
export const TERMS: Record<string, string> = {
  Ventricles: "The two lower chambers. They pump blood to the lungs and the body.",
  Atria: "The two upper chambers. Shown here, but not simulated.",
  Apex: "The pointed bottom tip of the heart.",
  "Coronary vessels": "The heart's own blood supply, on its surface. Drawn here for looks, not simulated.",
  "Epicardial fat": "Fat on the heart's surface, normal in adults. Drawn here for looks.",
  Base: "The top of the ventricles, where the valves and upper chambers join.",
  "Sinus node": "The heart's own pacemaker, at the top of the right atrium.",
  "Fast wiring": "Special fibres that spread each beat through the ventricles within a tenth of a second.",
  Septum: "The wall between the two lower chambers. Each steady beat here starts in its wiring.",
  ECG: "The heart's electricity seen from the skin, drawn as a line over time.",
  Lead: "One viewpoint on the heart's electricity. Twelve leads give twelve viewpoints.",
  "Rhythm strip": "One lead drawn long, for reading the rhythm.",
  "P wave": "A small bump from the upper chambers firing. Missing here: they are not simulated.",
  "QRS complex": "The spike: the wave spreading through the ventricles. Narrow when it uses the wiring.",
  "T wave": "The rounder bump after the spike: the ventricles resetting.",
  "Millivolt (mV)": "The unit of ECG height. The small step at the left edge is 1 mV.",
  PVC: "Premature ventricular contraction: an early beat that starts in the ventricle muscle.",
  "Compensatory pause": "The longer gap after an extra beat, while the steady rhythm catches up.",
  Tachycardia: "Any heart rate over 100 a minute. Exercise causes a normal one.",
  "Ventricular tachycardia (VT)": "A wave circling the ventricles, forcing very fast, weak beats.",
  "Ventricular fibrillation (VF)": "Chaotic waves: the ventricles quiver and pump nothing. Cardiac arrest.",
  "Atrial fibrillation": "Chaos in the upper chambers. Common, and a different condition from VF.",
  "Re-entry": "A wave that loops back into muscle that has recovered, and keeps going.",
  Wavelength: "How far a wave stretches: its speed times the cells' recovery time.",
  Defibrillator: "A device whose strong shock makes every cell fire at once, stopping VT or VF.",
  AED: "A public defibrillator that checks the rhythm itself and talks you through it.",
  "Cardiac arrest": "The heart stops pumping. The person collapses and has no pulse.",
  CPR: "Pushing hard and fast on the chest to keep blood moving until help arrives.",
  Pacemaker: "A small implanted device that fires beats when the heart's own are too slow.",
  Idealised: "Simplified on purpose, not measured from a real person.",
};

export const SOUND_NOTE = "The heart sounds are synthesised from the simulated beats, not recorded.";

export const SOUND_STATE = {
  off: "Sound off",
  on: "Sound on",
  blocked: "Tap to allow sound",
};

/** Said instead of playing anything, when silence is the true sound. */
export const SOUND_SILENCE = {
  chaotic: "No heart sounds: the heart is quivering, not pumping.",
};

export const HUD = {
  firing: "Muscle firing now",
  time: "Simulated time",
  rateUnit: "a minute",
  noRate: "No countable beats",
};

export const ANATOMY_LABELS = {
  apex: "Apex",
  base: "Base",
  lv: "Left ventricle",
  rv: "Right ventricle",
  la: "Left atrium",
  ra: "Right atrium",
  aorta: "Aorta",
  pulmonary: "Pulmonary artery",
};

export const LESSON_UI = {
  title: "Guided lessons",
  intro: "Five short lessons: one beat, an early beat, a racing rhythm, fibrillation, and the shock that fixes it.",
  complete: "Lesson complete. Try it again, or pick another.",
  back: "Back",
  next: "Next",
  skip: "Skip",
  restart: "Restart",
  stop: "Stop",
  allLessons: "All lessons",
};

export const TOASTS = {
  slowed: "Switched to slow motion to keep it smooth on this device.",
  startFailed: "The rhythm did not start on this computer. Press the button again to retry.",
  realTimeForSound: "Real time, so the sounds keep a real rhythm.",
};
