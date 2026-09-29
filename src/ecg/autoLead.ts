// Which lead to show on the single big trace and the rhythm strip. Lead II is the standard choice, and it stays the
// choice while it has a real signal. But in the racing rhythm and in fibrillation this heart's lead II is nearly flat
// (the wave circles at right angles to it), so the strip would show a flat line while the wave rages. When lead II is
// weak, this picks the lead that is moving most instead, and it only changes its mind after the new lead has been
// clearly better for a while, so the trace does not jump about. When lead II gets its signal back it wins again at once
// (after the same short wait), because it is the standard rhythm-strip lead.
import { LEAD_NAMES } from "../ui/monitorLayout";

const LEAD_II = 1;
/** The trace is judged over this many ms. */
const WINDOW_MS = 1200;
/** Lead II is kept while it moves at least this much (peak to peak, millivolts) over the window. */
const KEEP_LEAD_II_MV = 0.5;
/** Another lead has to move this many times as much as the one on show to take over... */
const CLEARLY_BETTER = 1.6;
/** ...and at least this much (peak to peak, millivolts), so a flat pause with a trace of noise never counts as "better". */
const MIN_TO_TAKE_OVER_MV = 0.05;
/** ...and stay that way this long. */
const HOLD_MS = 600;

export class AutoLead {
  private readonly times: number[] = [];
  private readonly rows: Float64Array[] = [];
  private shown = LEAD_II;
  private candidate = LEAD_II;
  private candidateSinceMs = 0;

  /** The lead to show now, as an index into the twelve lead values. */
  get lead(): number {
    return this.shown;
  }

  get name(): string {
    return LEAD_NAMES[this.shown];
  }

  /** Back to lead II, forgetting the last second. Call after a shock. */
  reset(): void {
    this.times.length = 0;
    this.rows.length = 0;
    this.shown = LEAD_II;
    this.candidate = LEAD_II;
  }

  /** One 12-lead sample at simulated time tMs. Returns the lead to show. */
  push(tMs: number, leads: ArrayLike<number>): number {
    this.times.push(tMs);
    this.rows.push(Float64Array.from(leads));
    while (this.times.length > 0 && tMs - this.times[0] > WINDOW_MS) {
      this.times.shift();
      this.rows.shift();
    }
    if (this.times.length < 20) return this.shown;

    const spread = this.spreads();
    // Lead II is the standard: it wins outright whenever it has a real signal, including when it comes back after a
    // stretch on a chest lead. Only when it is weak does another lead take over, and then only if clearly better.
    let wanted = this.shown;
    if (spread[LEAD_II] >= KEEP_LEAD_II_MV) {
      wanted = LEAD_II;
    } else {
      const best = spread.reduce((b, v, i) => (v > spread[b] ? i : b), LEAD_II);
      if (best !== this.shown && spread[best] >= MIN_TO_TAKE_OVER_MV && spread[best] > CLEARLY_BETTER * Math.max(spread[this.shown], 1e-6)) wanted = best;
    }
    if (wanted !== this.candidate) {
      this.candidate = wanted;
      this.candidateSinceMs = tMs;
    }
    if (this.candidate !== this.shown && tMs - this.candidateSinceMs >= HOLD_MS) this.shown = this.candidate;
    return this.shown;
  }

  /** Peak to peak of each lead over the window. */
  private spreads(): number[] {
    const n = this.rows[0].length;
    const lo = new Float64Array(n).fill(Infinity);
    const hi = new Float64Array(n).fill(-Infinity);
    for (const row of this.rows) {
      for (let k = 0; k < n; k++) {
        if (row[k] < lo[k]) lo[k] = row[k];
        if (row[k] > hi[k]) hi[k] = row[k];
      }
    }
    return Array.from(hi, (h, k) => h - lo[k]);
  }
}
