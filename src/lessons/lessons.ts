import type { LabApi, Lesson } from "./runner";
import * as R from "./recipes";

/**
 * The timings that only the lessons use, in simulated milliseconds, and the shares of the muscle they read as
 * "excited". Everything tuned on the heart itself (the apex, the tissue settings, the extra-beat timing) is in
 * recipes.ts and is used from there.
 */
export const LESSON_SETTINGS = {
  /** How long a "watch this" caption stays up. A normal beat is over in under 500 ms. */
  captionMs: 2000,
  /** The gap between steady beats: the pacemaker's period (a test checks it against the lab's). */
  steadyGapMs: 800,
  /** Tachycardia lesson: how long the viewer watches the wave circling before the lesson sums it up. */
  keepsGoingMs: 5000,
  /** Fibrillation lesson: how long the viewer watches the many small waves. */
  seeingMs: 4000,
  /** Shock lesson: how long the regular rhythm is shown after it resumes, about four beats. */
  rhythmMs: 3500,
  /** "The wave is over" means less than this share of the muscle is excited. */
  quietBelow: 0.01,
  /** A heart is "active" if more than this share of the muscle is excited. */
  activeAbove: 0.02,
  /** A rhythm is "going" if more than this share is excited. It is the lab's own test for a rhythm that took. */
  goingAbove: 0.05,
  /** A heart that is active this long after its last beat, with nothing left to drive it, is in a rhythm of its own. */
  sustainedAfterMs: 900,
};

const S = LESSON_SETTINGS;

const settled = (api: LabApi) => api.activeFraction() < S.quietBelow;
const going = (api: LabApi) => api.activeFraction() > S.goingAbove;
const always = () => true;
const succeeded = (api: LabApi) => api.induceStatus() === "success";
const setTissue = (recipe: R.Tissue) => (api: LabApi) => api.setTissue({ ...recipe });
const paceApex = (api: LabApi) => api.pace([...R.APEX]);
const sinceLastBeat = (api: LabApi) => api.simTimeMs() - api.lastBeatMs();

/** True when the heart is in a rhythm of its own: active a long time after anything drove it. */
const rhythmOfItsOwn = (api: LabApi) => sinceLastBeat(api) > S.sustainedAfterMs && api.activeFraction() > S.activeAbove;

/**
 * Begin from a heart at rest if the viewer left one in a rhythm of its own (a wave still circling from an earlier
 * lesson). A healthy heart that is simply beating is never touched: a beat's wave is over well before the next one.
 */
const calm = (api: LabApi) => {
  if (rhythmOfItsOwn(api)) api.shock();
};

/** Every lesson starts by pausing the pacemaker: the lab boots with it running, and the lessons give the beats. */
const pausePacemaker = (api: LabApi) => api.setPacemaker(false);

const HINT_TIMER = "This step carries on by itself. Press Skip to move on.";
const HINT_TIMINGS =
  "The lab is trying a few different timings for the early beat until one takes on this computer, because the exact moment matters. If it does not start, press Skip.";
const HINT_BURSTS = "The lab is trying a few different bursts until one takes. If nothing starts, press Skip.";
const HINT_STILL_GOING = "If the glow fades away, the wave did not keep going. Press Skip to carry on.";
const PACEMAKER_NOTE = "We have paused the pacemaker, the part that fires a steady beat";

const normalBeat: Lesson = {
  id: "normal-beat",
  title: "Normal beat",
  summary: "Watch one beat cross the model heart and draw its wave on the ECG.",
  steps: [
    {
      title: "The model heart",
      text:
        "This is an idealised simulation of the two main pumping chambers of a heart (the ventricles). " +
        "It is a teaching model, not a real patient. The glow is electricity moving through the muscle. " +
        "The ECG panel draws that electricity as a line. We have paused the pacemaker, the part that normally fires a steady beat, so the heart is still. " +
        "Press Next and we will fire one beat.",
      action: (api) => {
        calm(api);
        pausePacemaker(api);
        setTissue(R.NORMAL_TISSUE)(api);
      },
    },
    {
      title: "One beat",
      text: "A small electrical nudge at the tip of the heart. Watch the glow spread out from the tip.",
      action: paceApex,
      waitFor: settled,
      minMs: S.captionMs,
      hint: HINT_TIMER,
    },
    {
      title: "What you just saw",
      text:
        "The wave crossed the whole muscle in a fraction of a second. On the ECG it drew a sharp swing " +
        "(doctors call it the QRS complex). Then the muscle reset, and the ECG drew a smaller, rounder wave " +
        "(the T wave). Tap the heart to send another beat and watch again.",
    },
    {
      title: "What you learned",
      text:
        "A heartbeat is a wave of electricity that starts in one spot and spreads through the muscle. " +
        "The ECG line is drawn by that wave: a sharp swing as it crosses, then a rounder wave as the muscle resets. " +
        "The pacemaker is back on. All of this is an idealised simulation, not a real patient.",
      action: (api) => api.setPacemaker(true),
    },
  ],
};

const extraBeat: Lesson = {
  id: "extra-beat",
  title: "An extra beat (PVC)",
  summary: "See what an early extra beat does to the ECG.",
  steps: [
    {
      title: "Early beats",
      text:
        "This is an idealised simulation, not a real patient. Sometimes a spot in the heart muscle fires early, " +
        "before the next normal beat is due. Doctors call this a PVC, short for premature ventricular contraction. " +
        "It just means an early extra beat that starts in the main pumping chambers. " +
        `${PACEMAKER_NOTE}, and will give the beats ourselves.`,
      action: (api) => {
        calm(api);
        pausePacemaker(api);
        setTissue(R.NORMAL_TISSUE)(api);
      },
    },
    {
      title: "Beat one",
      text: "Beat one, a normal beat.",
      action: paceApex,
      // the next beat is due one steady gap after this one
      waitFor: (api) => sinceLastBeat(api) >= S.steadyGapMs - 2,
      hint: HINT_TIMER,
    },
    {
      title: "Beat two",
      text: "Beat two, a steady beat later.",
      action: paceApex,
      // the extra beat comes as soon as the muscle has finished resetting from this one
      waitFor: (api) => sinceLastBeat(api) >= R.PVC_EXTRA_BEAT_MS - 2,
      hint: HINT_TIMER,
    },
    {
      title: "An early beat",
      text: "Now an extra beat, well before the next one is due.",
      action: (api) => api.prematureBeat(),
      waitFor: settled,
      minMs: S.captionMs,
      hint: HINT_TIMER,
    },
    {
      title: "What you just saw",
      text:
        "The first two beats were 0.8 seconds apart. The extra beat came only about half a second after the second one, " +
        "so on the ECG it sits closer to the beat before it. Its shape can also look different. " +
        "That happens when an early beat starts from a different spot and crosses the muscle a different way.",
    },
    {
      title: "What you learned",
      text:
        "A PVC is a beat that arrives before it is due. Because it can start from a different spot, its wave " +
        "crosses the muscle by a different route, so its shape on the ECG can look different. " +
        "The pacemaker is back on. This is an idealised simulation.",
      action: (api) => api.setPacemaker(true),
    },
  ],
};

const tachycardia: Lesson = {
  id: "tachycardia",
  title: "Sustained tachycardia",
  summary: "Make the waves shorter, then start one that keeps circling by itself.",
  steps: [
    {
      title: "A wave that chases itself",
      text:
        "This is an idealised simulation, not a real patient. Normally each wave dies out after it crosses the heart, " +
        "because the muscle it has just passed needs a moment to recover. " +
        "But if a wave is short enough, it can circle round and meet muscle that has already recovered. " +
        "Then it can keep going, lap after lap. A fast rhythm like this is called tachycardia. " +
        `${PACEMAKER_NOTE}.`,
      action: (api) => {
        calm(api);
        pausePacemaker(api);
      },
    },
    {
      title: "Making the wave shorter",
      text:
        "We moved two sliders. Recovery time is now shorter, so muscle gets ready to fire again sooner. " +
        "Conduction speed is now lower, so the wave travels more slowly. " +
        "A wave that travels slowly and leaves muscle ready sooner is shorter, so it fits inside the heart more easily.",
      action: setTissue(R.TACHYCARDIA_TISSUE),
    },
    {
      title: "The timing matters",
      text:
        "An early beat at the wrong moment, in a heart with short waves, can start a wave that keeps circling. " +
        "The exact moment matters, so the lab tries a few different timings for you until one works. " +
        "Press Next to begin.",
    },
    {
      title: "A beat, then an early one",
      text: "One ordinary beat, then an early extra beat at just the wrong moment. Watch the wave.",
      action: (api) => api.induce("tachycardia"),
      waitFor: succeeded,
      hint: HINT_TIMINGS,
    },
    {
      title: "A wave that keeps going",
      text:
        "The early beat came when part of the muscle was ready to fire and part was not, so the wave found a way round. " +
        "On the ECG you now see a fast run of small waves.",
      waitFor: going,
      minMs: S.keepsGoingMs,
      hint: HINT_STILL_GOING,
    },
    {
      title: "What you learned",
      text:
        "A wave can keep circling when it is short enough to fit inside the heart and finds muscle that has recovered. " +
        "A shorter recovery time and slower conduction both make the wave shorter. " +
        "One badly timed early beat was enough to start it. Nobody is nudging the heart now, and the Shock button can end it. " +
        "Real hearts are far more complicated than this idealised simulation.",
    },
  ],
};

const fibrillation: Lesson = {
  id: "fibrillation",
  title: "Break into fibrillation",
  summary: "Shorten the waves further, then watch a burst of fast beats break into many waves.",
  steps: [
    {
      title: "When the wave breaks",
      text:
        "This is an idealised simulation, not a real patient. A single circling wave is orderly. " +
        "If the waves get even shorter, a wave can start to split into pieces. " +
        "Many small waves then wander over the heart in every direction. This is called fibrillation. " +
        `${PACEMAKER_NOTE}.`,
      action: (api) => {
        calm(api);
        pausePacemaker(api);
      },
    },
    {
      title: "Shorter still",
      text:
        "We lowered both sliders much further, so the waves are shorter than before. " +
        "With a shorter wave there is room for several of them in the heart at once. " +
        "Next the lab gives a burst of very fast beats from the tip of the heart, about ten a second. " +
        "That is how fibrillation is started in the lab.",
      action: setTissue(R.FIBRILLATION_TISSUE),
    },
    {
      title: "A burst of fast beats",
      text: "A burst of very fast beats from the tip. Watch the wave.",
      action: (api) => api.induce("fibrillation"),
      waitFor: succeeded,
      hint: HINT_BURSTS,
    },
    {
      title: "What you are seeing",
      text:
        "The orderly wave has split into many small waves. The ECG is now small, uneven wobbles with no neat repeating pattern. " +
        "A real heart like this only quivers. The model heart shows only electricity, so it stays still.",
      waitFor: going,
      minMs: S.seeingMs,
      hint: HINT_STILL_GOING,
    },
    {
      title: "What you learned",
      text:
        "When waves become short enough, a burst of fast beats can break one wave into many. " +
        "The electricity turns chaotic and the ECG loses its regular pattern. " +
        "A real heart in this state only quivers. The last lesson shows how to stop it. " +
        "This is an idealised simulation, not a real patient.",
    },
  ],
};

const shockIt: Lesson = {
  id: "shock",
  title: "Shock it back",
  summary: "Reset a fibrillating heart with the Shock button, then bring back the regular rhythm.",
  steps: [
    {
      title: "Resetting the heart",
      text:
        "This is an idealised simulation, not a real patient. Fibrillation is when many small waves wander over the heart at once, so it only quivers. " +
        "To stop it, the whole heart has to be reset at the same moment. " +
        "In this lab the Shock button does that: it is a very simplified picture of a defibrillator. " +
        `${PACEMAKER_NOTE}. First the lab sets up a heart in fibrillation, which takes a few seconds.`,
      action: (api) => {
        pausePacemaker(api);
        setTissue(R.NORMAL_TISSUE)(api);
      },
    },
    {
      title: "Setting up",
      text: "Getting the heart into fibrillation. The lab sets short waves, then gives a burst of fast beats.",
      // A rhythm the viewer left going is kept. A normal beat's wave that is merely in flight is not a rhythm: that
      // heart is set up like any other.
      action: (api) => {
        if (!rhythmOfItsOwn(api)) api.induce("fibrillation");
      },
      waitFor: (api) => api.induceStatus() !== "running" && going(api),
      hint: HINT_BURSTS,
    },
    {
      title: "Shock",
      text: "Now press the amber Shock button, or the S key. It resets every cell at once.",
      // the viewer does it: the step moves on once everything has gone quiet
      waitFor: settled,
      hint: "Press the amber Shock button on the right. Skip only moves the lesson on; it does not shock the heart.",
    },
    {
      title: "What just happened",
      text:
        "Every cell was reset at the same moment, so all the small waves vanished together. " +
        "With nothing left to spread, the glow is gone and the ECG line is flat. " +
        "Next we switch the pacemaker back on, so the steady beat starts again.",
    },
    {
      title: "Back to normal",
      text: "Healthy settings, and the pacemaker on again. Watch the regular rhythm come back.",
      // the normal rhythm resumes by itself: the lesson gives no beat of its own
      action: (api) => {
        setTissue(R.NORMAL_TISSUE)(api);
        api.setPacemaker(true);
      },
      waitFor: always,
      minMs: S.rhythmMs,
      hint: HINT_TIMER,
    },
    {
      title: "What you learned",
      text:
        "A shock resets every cell at once, which ends the chaos. In this lab that is what Shock does: " +
        "it puts all the muscle back to rest. After that, the regular rhythm can start again. " +
        "Remember, this is an idealised simulation, not a real patient.",
    },
  ],
};

export const LESSONS: Lesson[] = [normalBeat, extraBeat, tachycardia, fibrillation, shockIt];
