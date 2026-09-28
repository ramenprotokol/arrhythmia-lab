// CPU reference for the minimal ventricular model of Bueno-Orovio, Cherry and
// Fenton (2008), J Theor Biol 253:544-560. This is the truth the GPU solver is
// tested against, so it mirrors the paper's equations term by term.
// Equations are implemented from the paper; constants live in params.ts.
// Diffusion is not part of the cell: the solver adds it to du/dt.
import type { Params } from "./params";

export { EPI, ENDO, MID } from "./params";
export type { Params } from "./params";

export type Cell = { u: number; v: number; w: number; s: number };

/** Heaviside step, 1 when the argument is >= 0. */
const H = (x: number): number => (x >= 0 ? 1 : 0);

export function restingCell(): Cell {
  return { u: 0, v: 1, w: 1, s: 0 };
}

/**
 * One explicit Euler step. dt in ms, iStim in u per ms (added to du/dt).
 * Returns a new cell.
 */
export function stepCell(c: Cell, p: Params, dt: number, iStim: number): Cell {
  const { u, v, w, s } = c;

  const hV = H(u - p.thetaV);
  const hW = H(u - p.thetaW);
  const hVm = H(u - p.thetaVm);
  const hO = H(u - p.thetaO);

  const tauVm = (1 - hVm) * p.tauV1m + hVm * p.tauV2m;
  const tauWm = p.tauW1m + ((p.tauW2m - p.tauW1m) * (1 + Math.tanh(p.kWm * (u - p.uWm)))) / 2;
  const tauSo = p.tauSo1 + ((p.tauSo2 - p.tauSo1) * (1 + Math.tanh(p.kSo * (u - p.uSo)))) / 2;
  const tauS = (1 - hW) * p.tauS1 + hW * p.tauS2;
  const tauO = (1 - hO) * p.tauO1 + hO * p.tauO2;

  const vInf = 1 - hVm;
  const wInf = (1 - hO) * (1 - u / p.tauWInf) + hO * p.wInfStar;

  const jFi = (-v * hV * (u - p.thetaV) * (p.uu - u)) / p.tauFi;
  const jSo = ((u - p.uo) * (1 - hW)) / tauO + hW / tauSo;
  const jSi = (-hW * w * s) / p.tauSi;

  const dv = ((1 - hV) * (vInf - v)) / tauVm - (hV * v) / p.tauVp;
  const dw = ((1 - hW) * (wInf - w)) / tauWm - (hW * w) / p.tauWp;
  const ds = ((1 + Math.tanh(p.kS * (u - p.uS))) / 2 - s) / tauS;
  const du = -(jFi + jSo + jSi) + iStim;

  return { u: u + dt * du, v: v + dt * dv, w: w + dt * dw, s: s + dt * ds };
}

/**
 * Action potential duration to 90% repolarisation, in ms, for one beat from
 * rest. A 1 ms suprathreshold stimulus fires the cell. The clock starts when u
 * crosses half of the peak amplitude on the upstroke and stops when u falls to
 * 10% of the peak (90% repolarised); both crossings are linearly interpolated.
 * Returns NaN if the cell never fires or never repolarises within 3 s.
 */
export function measureApd90(p: Params): number {
  const dt = 0.05;
  const maxSteps = Math.round(3000 / dt);
  const trace = new Float64Array(maxSteps + 1);
  let c = restingCell();
  let peak = 0;
  let peakStep = 0;
  for (let i = 0; i < maxSteps; i++) {
    c = stepCell(c, p, dt, i * dt < 1 ? 1 : 0);
    trace[i + 1] = c.u;
    if (c.u > peak) {
      peak = c.u;
      peakStep = i + 1;
    }
    // Stop once the cell has clearly repolarised: nothing more to measure.
    if (peak > 0.5 && i > peakStep && c.u < 0.05 * peak) break;
  }
  if (peak < 0.5) return NaN;

  const cross = (level: number, from: number, rising: boolean): number => {
    for (let i = from; i < trace.length - 1; i++) {
      const a = trace[i], b = trace[i + 1];
      if (rising ? a < level && b >= level : a > level && b <= level) {
        return (i + (level - a) / (b - a)) * dt;
      }
    }
    return NaN;
  };

  const tUp = cross(0.5 * peak, 0, true);
  const tDown = cross(0.1 * peak, peakStep, false);
  return tDown - tUp;
}
