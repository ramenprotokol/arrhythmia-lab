// Words the page needs that src/copy.ts (the teaching review's module) does not have. They are the design boards'
// draft wording. Anything here that speaks about the heart should move into src/copy.ts once it has been reviewed.
export const UI_TEXT = {
  tagline: "A live heart you can break, and fix.",
  breakIt: "Break it",
  fixIt: "Fix it",
  next: "Next",
  medicalName: "Medical name:",
  starting: "Finding the right moment…",
  /** In place of "a minute" while a beating rhythm's rate is still being counted. */
  countingBeats: "counting beats",
  /** Starting fibrillation is a burst of beats, not a hunt for the right moment. */
  startingFibrillation: "Starting fibrillation…",
  /** Beside the Shock button, pointing at it, while there is something to fix. */
  pressShock: "Press Shock",
  coachTitle: "Try this",
  coachHide: "Hide these tips",
  coachFinished: "You broke it and fixed it. The lessons show why it works.",
  /** Step 2 of the coach when the person went straight to fibrillation (copy.ts's "done" line is about racing). */
  coachBrokeChaotic: "It is fibrillating: the wave has shattered into many, and nothing pumps.",
  openLessons: "Open the lessons",
  tapMarker: "Tap the heart to make it beat",
  tapMiss: "Tap on the heart itself",
  heartName: "The heart. Press Enter or Space to fire one steady beat; tap or click it to start a beat from that spot; drag to turn it.",
  soundNudge: "Turn on sound to hear the heartbeat.",
  soundUnavailable: "This browser cannot play sound.",
  more: "More options",
  close: "Close",
  credits: "Credits and sources",
  leadAuto: "Lead {lead}, chosen automatically",
  leadPlain: "Lead {lead}",
  liveStrip: "Live strip",
  twelveLeads: "12 leads",
  compareShort: "Compare",
  compareTitle: "Compare with a real recording",
  backToLive: "Back to the live view",
  fireOne: "Fire one beat",
  rapidBurst: "Rapid burst",
  rapidBurstTip: "Ten nudges a second, the way researchers start fibrillation.",
  shockFirst: "Shock first. Damaged muscle does not heal in a second.",
  lessonBusy: "A lesson is running. Stop it to break the heart yourself.",
  alreadyBroken: "It is already broken this way. Press Shock to fix it.",
  keysTitle: "Keyboard",
  termsTitle: "Words used here",
  guideTitle: "What am I looking at?",
  tissueTitle: "Tissue",
  triggersTitle: "Beats by hand",
  viewTitle: "View",
  cutDepth: "Cut position",
  record: "Record clip",
  recordSound: "Includes the heartbeat sound if it is on.",
  stopRecording: "Stop and save",
  recording: "REC",
  savedClip: "Saved the clip to your downloads.",
  stepOf: "Step {n} of {total}",
  /** The page for a lab that could not start (a file would not load, the graphics card refused something). That is not the same as a browser without WebGPU. */
  startFailedTitle: "Arrhythmia Lab could not start",
  startFailed: "Something went wrong while starting the lab, so it cannot run right now. Reload the page to try again. If it keeps happening, check your connection or try another browser.",
  startFailedReason: "What went wrong: {reason}",
} as const;

/** Put values into a "{name}" template. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}
