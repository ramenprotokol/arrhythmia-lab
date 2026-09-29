import type { LabApi, Lesson, LessonStep } from "./runner";
import * as R from "./recipes";

/**
 * The timings that only the lessons use, in simulated milliseconds, and the shares of the muscle they read as
 * "excited". Everything tuned on the heart itself (the apex, the tissue settings, the extra-beat timing) is in
 * recipes.ts and is used from there. The page runs in real time by default, so these are also seconds on screen.
 */
export const LESSON_SETTINGS = {
  /** The gap between steady beats: the pacemaker's period (a test checks it against the lab's). */
  steadyGapMs: 800,
  /**
   * One-beat lesson: after the steady beat is switched on (its first beat comes 400 ms later), long enough for the
   * second and third beats and their spikes to be drawn, since a nudge just before can block the first.
   */
  steadyShowMs: 2400,
  /** Extra-beat lesson: the steady rhythm is watched this long (two beats) before the early beat is fired. */
  steadyWatchMs: 1700,
  /** Extra-beat lesson: after the early beat, long enough for the pause and the next steady beat to be drawn. */
  pauseWatchMs: 1500,
  /** Racing lesson: how long the viewer watches the wave circling before the lesson explains it. */
  keepsGoingMs: 5000,
  /** Fibrillation lesson: how long the viewer watches the many small waves. */
  seeingMs: 5000,
  /** A step waiting for the lab to start a rhythm offers its hint after this long. */
  startingHintMs: 10_000,
  /** A step watching a rhythm offers its hint this soon if the rhythm has stopped. */
  stoppedHintMs: 1500,
  /**
   * After a tap, "quiet" is not taken to mean the wave is over until this long has passed: the excited share is read a
   * frame late, and a beat from one spot takes a few hundred ms to creep across the heart.
   */
  waveMs: 600,
  /** "The wave is over" means less than this share of the muscle is excited. */
  quietBelow: 0.01,
  /** A heart is "active" if more than this share of the muscle is excited. */
  activeAbove: 0.02,
  /** A rhythm is "going" if more than this share is excited. It is the lab's own test for a rhythm that took. */
  goingAbove: 0.05,
  /** A heart that is active this long after its last beat, with nothing left to drive it, is in a rhythm of its own. */
  sustainedAfterMs: 900,
  /**
   * A shock makes every cell that can fire do so at once, so for a moment most of the heart is excited. How much
   * depends on the moment it lands, because muscle still recovering from the last wave cannot fire: measured 0.58 to
   * 1.0 in the racing rhythm and in fibrillation. Those rhythms on their own stay lower (at most 0.46 racing, about 0.2
   * fibrillating), and while they run the steady beat is off, so nothing else does it. A shock that is missed here is
   * still caught by nothingToShockMs.
   */
  shockedAbove: 0.52,
  /** A Shock step lets a heart that has been quiet this long go on without a shock: there is nothing left to shock. */
  nothingToShockMs: 1500,
  /** The shock lesson shows the fibrillation it set up for this long before asking for the Shock. */
  watchBeforeShockMs: 2000,
};

const S = LESSON_SETTINGS;

const settled = (api: LabApi) => api.activeFraction() < S.quietBelow;
const going = (api: LabApi) => api.activeFraction() > S.goingAbove;
const always = () => true;
const succeeded = (api: LabApi) => api.induceStatus() === "success";
const sinceLastBeat = (api: LabApi) => api.simTimeMs() - api.lastBeatMs();

/** True when the heart is in a rhythm of its own: active a long time after anything drove it. */
const rhythmOfItsOwn = (api: LabApi) => sinceLastBeat(api) > S.sustainedAfterMs && api.activeFraction() > S.activeAbove;

/**
 * Begin from a heart at rest if the viewer left one in a rhythm of its own (a wave still circling from free play). A
 * healthy heart that is simply beating is never touched: a beat's wave is over well before the next one.
 */
const calm = (api: LabApi) => {
  if (rhythmOfItsOwn(api)) api.shock();
};

/**
 * The step that waits for the viewer's Shock. It moves on once the whole heart has fired at once (the shock) and then
 * gone quiet. A heart that has been quiet for a while with no shock (the lab could not start a rhythm, or the viewer
 * ended it another way) is not held either: Shock would be refused on a still heart, and the viewer would be stuck.
 */
function waitForShock(text: string, hint: string): LessonStep {
  let peak = 0;
  let quietSince: number | null = null;
  return {
    title: "Fix it",
    text,
    action: () => {
      peak = 0;
      quietSince = null;
    },
    waitFor: (api) => {
      peak = Math.max(peak, api.activeFraction());
      if (!settled(api)) quietSince = null;
      else quietSince ??= api.simTimeMs();
      const shocked = peak > S.shockedAbove && quietSince !== null;
      const nothingLeft = quietSince !== null && api.simTimeMs() - quietSince >= S.nothingToShockMs;
      return shocked || nothingLeft;
    },
    canSkip: false,
    hint,
  };
}

const HINT_STARTING = "Finding the right moment can take a few tries. If nothing starts, press Skip.";

// ---- 1. One beat ----------------------------------------------------------------------------------------------------

/** When the "Tap the heart" step began: a beat after this is the viewer's. */
let tapFrom = -Infinity;

const oneBeat: Lesson = {
  id: "normal-beat",
  title: "One beat",
  summary: "Start a beat yourself, then see how the ECG draws it.",
  steps: [
    {
      title: "Tap the heart",
      text: "We paused the steady beat. Tap anywhere on the heart to start one beat there. The glow is electricity.",
      action: (api) => {
        calm(api);
        api.setTissue({ ...R.NORMAL_TISSUE });
        api.setPacemaker(false);
        tapFrom = api.simTimeMs();
      },
      // the viewer tapped, and that beat's wave has crossed the heart and gone (the excited share is read a frame
      // late, so "quiet" only counts once the wave has had time to start)
      waitFor: (api) => api.lastBeatMs() > tapFrom && sinceLastBeat(api) > S.waveMs && settled(api),
      hint: "Tap or click anywhere on the heart. Or press Skip, and the lab fires a beat for you.",
    },
    {
      title: "The steady beat",
      text: "Now the steady beat comes back. It spreads through fast wiring, so the whole muscle fires almost together.",
      action: (api) => {
        // a viewer who pressed Skip still gets a beat from one spot to compare with: the lab nudges the tip
        if (api.lastBeatMs() <= tapFrom) api.pace([...R.APEX]);
        api.setPacemaker(true);
      },
      // long enough for two steady beats to be drawn after the first, which a nudge just before may have blocked
      waitFor: always,
      minMs: S.steadyShowMs,
    },
    {
      title: "Two kinds of beat",
      text:
        "The ECG is held. The first beat crept from one spot, cell to cell, so it drew a wide swing. " +
        "The steady beats use the wiring, so each draws a narrow spike.",
      holdEcg: true,
    },
    {
      title: "The ECG",
      text:
        "On the ECG each steady beat draws a quick spike as the wave spreads (the QRS complex), " +
        "then a rounder wave as the muscle resets (the T wave).",
    },
    {
      title: "Where beats start",
      text:
        "In a real heart, each beat starts at the top, in a small patch of pacemaker cells, and reaches the lower chambers " +
        "through fast wiring. Here it starts in that wiring.",
    },
    {
      title: "What is missing",
      text:
        "Real ECGs also show a small bump before each beat, the P wave, made by the upper chambers. " +
        "They are drawn here but not simulated, so it is missing.",
    },
    {
      title: "What you learned",
      text:
        "A heartbeat is a wave of electricity. Through the fast wiring it reaches the whole muscle almost at once and draws " +
        "a narrow spike; from one spot it creeps and draws a wide one.",
    },
  ],
};

// ---- 2. An early beat -----------------------------------------------------------------------------------------------

/** When the extra-beat lesson switched the steady beat on: the early beat waits for a steady beat after this. */
let steadyFrom = -Infinity;

const earlyBeat: Lesson = {
  id: "extra-beat",
  title: "An early beat (PVC)",
  summary: "An early extra beat, the pause after it, and the skipped beat people feel.",
  steps: [
    {
      title: "The steady rhythm",
      text: "The steady beat is on: one beat every 0.8 seconds. Watch the ECG.",
      action: (api) => {
        calm(api);
        api.setTissue({ ...R.NORMAL_TISSUE });
        // Switching a running steady beat "on" again would restart its clock and draw one short gap on the ECG, which
        // looks like an early beat: only switch it on if it is off.
        if (sinceLastBeat(api) > S.steadyGapMs + 100) api.setPacemaker(true);
        steadyFrom = api.simTimeMs();
      },
      // after a steady beat or two, at the moment the muscle has just finished resetting from the last one
      waitFor: (api) => api.lastBeatMs() > steadyFrom && sinceLastBeat(api) >= R.PVC_EXTRA_BEAT_MS - 2,
      minMs: S.steadyWatchMs,
      hint: "If no beats appear, switch the steady beat back on, or press Skip.",
    },
    {
      title: "An early beat",
      text: "Now one spot on the wall fires early. Watch for the gap after it.",
      action: (api) => api.prematureBeat(),
      // the next steady beat falls while the muscle is still resetting and does nothing; the one after it is drawn
      waitFor: always,
      minMs: S.pauseWatchMs,
    },
    {
      title: "What you saw",
      text:
        "The ECG is held. The early beat came before it was due. It started from one spot, so it drew a wide, different " +
        "shape. Then came a pause.",
      holdEcg: true,
    },
    {
      title: "Why the pause",
      text:
        "The next steady beat arrived while the muscle was still resetting, so it did nothing. " +
        "That early beat and pause is the skipped beat many people feel.",
      holdEcg: true,
    },
    {
      title: "What you learned",
      text:
        "An early extra beat is called a PVC, a premature ventricular contraction. " +
        "Occasional ones are common and often harmless, and the rhythm carries on by itself.",
    },
  ],
};

// ---- 3. Racing rhythm -----------------------------------------------------------------------------------------------

const racing: Lesson = {
  id: "tachycardia",
  title: "Racing rhythm (VT)",
  summary: "Break it: one wave chases its own tail. Then shock it back.",
  steps: [
    {
      title: "Break it",
      text: "The lab makes the tissue fragile, then fires one early beat at just the wrong moment.",
      action: (api) => api.induce("tachycardia"),
      waitFor: succeeded,
      hint: HINT_STARTING,
      hintAfterMs: S.startingHintMs,
    },
    {
      title: "Watch it race",
      text: "One wave is chasing its own tail around the heart. Each lap is a beat, far too fast for the heart to fill and pump.",
      waitFor: going,
      minMs: S.keepsGoingMs,
      hint: "If the glow has stopped, the wave did not keep going. Press Skip to carry on.",
      hintAfterMs: S.stoppedHintMs,
    },
    {
      title: "Why it can circle",
      text:
        "A wave usually dies out: the muscle behind it needs time to recover. " +
        "Fragile tissue carries the wave slower and recovers sooner, so the wave is short enough to fit in a loop.",
    },
    {
      title: "The trigger",
      text:
        "It still needed a trigger: one early beat that found part of the muscle ready and part still recovering, " +
        "so it could only go one way round.",
    },
    waitForShock(
      "Doctors call this ventricular tachycardia (VT), a racing rhythm from the lower chambers. In a person it is an emergency. Press Shock to stop it.",
      "Press the Shock button to stop the racing rhythm. This step waits for you.",
    ),
    {
      title: "What you learned",
      text:
        "A wave circles when fragile tissue makes waves short and one early beat sets it off. " +
        "A shock stops it. Treating the cause keeps it from coming back.",
    },
  ],
};

// ---- 4. Fibrillation ------------------------------------------------------------------------------------------------

const fibrillation: Lesson = {
  id: "fibrillation",
  title: "Chaos: fibrillation (VF)",
  summary: "Break it badly: the wave shatters and pumping stops. Then shock it.",
  steps: [
    {
      title: "Break it badly",
      text: "The lab makes the tissue very fragile, then fires a rapid burst of beats, about ten a second.",
      action: (api) => api.induce("fibrillation"),
      waitFor: succeeded,
      hint: HINT_STARTING,
      hintAfterMs: S.startingHintMs,
    },
    {
      title: "Watch the chaos",
      text:
        "The wave has shattered into many small waves that collide and wander. The ECG turns into uneven wiggles. " +
        "The muscle only quivers, so no blood moves.",
      waitFor: going,
      minMs: S.seeingMs,
      hint: "If the glow has stopped, the waves died out. Press Skip to carry on.",
      hintAfterMs: S.stoppedHintMs,
    },
    {
      title: "No pulse",
      text:
        "Doctors call this ventricular fibrillation (VF). In a person it is cardiac arrest: collapse within seconds, " +
        "and no pulse. With sound on, you hear nothing at all.",
    },
    waitForShock(
      "Only a defibrillator's shock can stop this. Press Shock now.",
      "Press the Shock button to stop the fibrillation. This step waits for you.",
    ),
    {
      title: "What you learned",
      text:
        "Very short waves can shatter into ventricular fibrillation, and the heart stops pumping. " +
        "In real life: call emergency services, start CPR (chest compressions), and use an AED, a public defibrillator.",
    },
  ],
};

// ---- 5. Shock it back -----------------------------------------------------------------------------------------------

/** When the fibrillation the shock lesson set up was first seen going, or null while it is not. */
let fibrillatingSince: number | null = null;

const shockItBack: Lesson = {
  id: "shock",
  title: "Shock it back",
  summary: "What a shock does, and why an AED will not shock a steady heart.",
  steps: [
    {
      title: "Setting up",
      text: "The lab starts fibrillation again: chaotic waves, no pumping. This takes a few seconds.",
      action: (api) => {
        fibrillatingSince = null;
        api.induce("fibrillation");
      },
      // The rhythm is shown for a moment before the viewer is asked to shock it; the page's reading of the rhythm,
      // which decides whether Shock is allowed, also needs that moment to catch up with a rhythm that has just begun.
      waitFor: (api) => {
        if (api.induceStatus() === "running" || !going(api)) {
          fibrillatingSince = null;
          return false;
        }
        fibrillatingSince ??= api.simTimeMs();
        return api.simTimeMs() - fibrillatingSince >= S.watchBeforeShockMs;
      },
      hint: HINT_STARTING,
      hintAfterMs: S.startingHintMs,
    },
    {
      ...waitForShock("Press Shock and watch the whole heart. A shock makes every cell fire at the same moment.", "Press the Shock button. This step waits for you."),
      title: "Shock",
    },
    {
      title: "What just happened",
      text: "Every cell fired together, so every cell had to recover together. The circling waves found no muscle ready to carry them, and died out.",
    },
    {
      title: "The rhythm returns",
      text:
        "After a pause the steady beat returns. In people, the heart's own pacemaker cells at the top often take over like this. " +
        "If not, chest compressions (CPR) continue.",
    },
    {
      title: "Try it on a steady heart",
      text: "Now press Shock again, on this steady rhythm, and see what happens. Then press Next.",
    },
    {
      title: "No shock advised",
      text:
        "A shock only helps racing or chaotic rhythms. A real AED, the public defibrillator, checks the rhythm first, " +
        "and will not shock a heart that is pumping, or one that is still.",
    },
    {
      title: "What you learned",
      text: "A shock makes every cell fire at once, which ends circling waves. It cannot start a still heart, and the cause still needs treating afterwards.",
    },
  ],
};

export const LESSONS: Lesson[] = [oneBeat, earlyBeat, racing, fibrillation, shockItBack];
