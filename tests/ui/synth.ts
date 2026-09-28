// A repeating ECG-like beat for the UI tests: P, Q, R, S and T waves as Gaussians, scaled per lead.
// The shapes are only there to look like an ECG; they are not the output of the simulation.

/** Relative size of a beat in each lead, in the order I, II, III, aVR, aVL, aVF, V1 to V6. */
const SCALE = [1.0, 1.25, 0.45, -1.0, 0.35, 0.85, -0.55, 0.3, 0.8, 1.2, 1.1, 0.9];

const bump = (x: number, centre: number, width: number): number => Math.exp(-0.5 * ((x - centre) / width) ** 2);

/** One beat in mV for a lead-II sized signal. The R wave sits 300 ms into each period. */
export function beat(tMs: number, periodMs = 800): number {
  const x = ((tMs % periodMs) + periodMs) % periodMs;
  return (
    0.12 * bump(x, 140, 22) + // P
    -0.12 * bump(x, 278, 7) + // Q
    1.0 * bump(x, 300, 9) + // R
    -0.25 * bump(x, 322, 8) + // S
    0.3 * bump(x, 520, 45) // T
  );
}

export function synthLeads(tMs: number, out: Float32Array = new Float32Array(12), periodMs = 800): Float32Array {
  const b = beat(tMs, periodMs);
  for (let i = 0; i < 12; i++) out[i] = SCALE[i] * b;
  return out;
}
