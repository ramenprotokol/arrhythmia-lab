// What a person can do to the heart in free play, in four plain moves: an early beat, make it race, make it
// fibrillate, and fix it. The engine has the parts (extra beats, the inducer, the shock, the tissue settings, the
// pacemaker); this puts them together the way a person expects, so the page does not have to know how.
import type { LabEngine } from "./engine";
import type { RhythmState } from "../audio/rhythm";
import * as R from "../lessons/recipes";

export type Starting = "racing" | "fibrillation" | null;

/** What happened when the person pressed Shock. `reason` says why nothing was shocked. */
export type ShockResult = { fired: true } | { fired: false; reason: "pumping" | "still" };

/** After the lab reports that a rhythm has started, the analyser needs about this long (simulated ms) to read it; until then it may still say "quiet". */
const SETTLE_AFTER_SUCCESS_MS = 1500;
/** A "quiet" reading with muscle firing is not a still heart, unless the firing is the aftermath of a shock this recent. */
const SHOCK_AFTERMATH_MS = 700;
const SOMETHING_FIRING = 0.05;

/** A racing rhythm is shockable when it pumps less than this (0 to 1)... */
const SHOCKABLE_OUTPUT = 0.5;
/** ...or when it is this fast, whatever the last second of pumping still says (a fresh racing rhythm looks organised for a moment). */
const SHOCKABLE_BPM = 200;

export class LabMoves {
  constructor(private readonly engine: LabEngine) {}

  private successSeenAt: number | null = null;

  private kindOf(): Starting {
    const kind = this.engine.inducer.state.kind;
    return kind === "tachycardia" ? "racing" : kind === "fibrillation" ? "fibrillation" : null;
  }

  /** Set while the lab is finding a timing that starts the racing or fibrillating rhythm: it takes a few seconds, and the heart resets and jolts on the way. */
  get starting(): Starting {
    return this.engine.inducer.state.status === "running" ? this.kindOf() : null;
  }

  /**
   * Set for a moment after the rhythm has started, while the rhythm analyser catches up (its first reading of a new rhythm
   * can still be "quiet" for up to a second, though the muscle is visibly firing). The page can show "reading the rhythm"
   * instead of a wrong name, and a Shock pressed now is not refused.
   */
  get settling(): Starting {
    if (this.engine.inducer.state.status !== "success") {
      this.successSeenAt = null;
      return null;
    }
    if (this.successSeenAt === null) this.successSeenAt = this.engine.simTime;
    return this.engine.simTime - this.successSeenAt < SETTLE_AFTER_SUCCESS_MS ? this.kindOf() : null;
  }

  /** One early beat. It waits for the right moment after the last beat, so it always shows, instead of doing nothing when pressed too soon. */
  extraBeat(): void {
    this.engine.scheduleExtraBeat();
  }

  /** Start the racing rhythm (ventricular tachycardia): one wave circling the heart, fast and regular. */
  race(): void {
    this.successSeenAt = null;
    this.engine.induce("tachycardia");
  }

  /** Start fibrillation: many waves breaking up and colliding, so the muscle quivers and does not pump. */
  fibrillate(): void {
    this.successSeenAt = null;
    this.engine.induce("fibrillation");
  }

  /**
   * The person presses Shock. Like a real defibrillator it looks at the rhythm first: a shock only helps a rhythm that
   * is not pumping, the racing wave or fibrillation. A steady, pumping heart is left alone, and so is a still one (a
   * shock stops chaos; it cannot start a still heart). `rhythm` is the rhythm analyser's reading. While the lab is
   * still setting a rhythm up (or has only just set it up), Shock cancels that and puts the heart right.
   */
  shock(rhythm: RhythmState): ShockResult {
    const shockable = rhythm.kind === "chaotic" || (rhythm.kind === "racing" && (rhythm.output < SHOCKABLE_OUTPUT || (rhythm.bpm ?? 0) >= SHOCKABLE_BPM));
    // The analyser can lag a fresh rhythm: a "quiet" reading while muscle is firing (and it is not just the aftermath of a shock) is not a still heart.
    const firingNotShockAftermath = this.engine.excited > SOMETHING_FIRING && this.engine.simTime - this.engine.lastShockAt > SHOCK_AFTERMATH_MS;
    if (this.starting !== null || this.settling !== null || shockable || (rhythm.kind === "quiet" && firingNotShockAftermath)) {
      this.fix();
      return { fired: true };
    }
    return { fired: false, reason: rhythm.kind === "quiet" ? "still" : "pumping" };
  }

  /**
   * Fix it: shock the heart, put the tissue back to healthy, and switch the natural pacemaker on again, so a
   * regular beat returns a moment later. (A real heart's own pacemaker restarts by itself after a shock; the lab's
   * pacemaker is switched off while a rhythm is started, so it has to be switched back on here.)
   */
  fix(): void {
    this.successSeenAt = null;
    this.engine.setTissue(R.NORMAL_TISSUE);
    // Pacemaker first, then the shock: the shock is what sets the pause before the first beat comes back.
    this.engine.setPacemaker(true);
    this.engine.defibrillate();
  }
}
