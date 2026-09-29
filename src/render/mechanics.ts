import type { Vec3 } from "./camera";

// How the heart moves when the muscle contracts. Each point of the muscle has a contraction c, from 0 (relaxed) to
// 1 (fully contracted), which the voltage pass low-passes from the local voltage on the GPU: it rises a little after
// the wave arrives and falls as the tissue recovers, the lag between electrical and mechanical activity. A point is
// then moved by a field built on the heart's long axis, the way a ventricle really shortens:
//   - the base descends toward the apex (long-axis shortening), in proportion to the height above the apex;
//   - the wall draws in toward the axis (radial shortening);
//   - the ventricle wrings: seen from the apex, the apex turns anticlockwise and the base clockwise.
// The heart squeezes as a whole only when it contracts together. How much of it does, the mean contraction, gates the
// squeeze: a normal beat (nearly all of it at once) pumps fully, a racing rhythm (a spiral wave: part of it at a
// time) only twitches weakly, and fibrillation (small patches, out of step) does not squeeze at all. What is left of
// the local contraction then only quivers the surface a little, in where a patch is tighter than the mean and out where
// it is looser, which averages to nothing. The same maths runs in WGSL (beatWgsl) for the surfaces and here for pick()
// and project().

export const BEAT = {
  /** Long-axis shortening at full contraction: the base moves toward the apex by this share of its height. */
  longitudinal: 0.085,
  /** Radial shortening at full contraction: share of the distance from the long axis. */
  radial: 0.075,
  /** Twist at full contraction, radians about the long axis (base toward apex), at the apex and at the base. */
  twistApex: 0.16,
  twistBase: -0.07,
  /** Mechanical lag, seconds of wall-clock time: how fast the contraction follows a rise and a fall of the voltage. */
  riseS: 0.035,
  fallS: 0.09,
  /** The mean contraction at which the whole-heart squeeze starts, and at which it is full. */
  gateLow: 0.3,
  gateHigh: 0.8,
  /** How far an out-of-step patch moves in or out along the surface, mm, at the most. */
  quiverMm: 1.4,
  /**
   * The rest of the heart (atria, great vessels) is dragged along by the ventricles near the seam and stays put far
   * from it: it moves fully within `holdMm` of the ventricles and not at all beyond `freeMm`.
   */
  holdMm: 3,
  freeMm: 38,
};

/**
 * A shock fires every muscle cell at once: the heart flushes warm and fades back as it recovers, and it is held still
 * meanwhile (no squeeze, no quiver). Seconds of wall-clock time: the flash's rise and fade, how long the heart is held,
 * and how long it takes to let go.
 */
export const SHOCK = { riseS: 0.04, fadeS: 0.11, stillS: 0.38, releaseS: 0.35 };

/** The flash (0..1) and how free the heart is to move (0 held .. 1) at a time since the shock, seconds. */
export function shockLook(ageS: number): { flash: number; still: number } {
  if (!(ageS >= 0)) return { flash: 0, still: 1 };
  const flash = ageS < SHOCK.riseS ? ageS / SHOCK.riseS : Math.exp(-(ageS - SHOCK.riseS) / SHOCK.fadeS);
  const r = Math.min(1, Math.max(0, (ageS - SHOCK.stillS) / SHOCK.releaseS));
  return { flash, still: r * r * (3 - 2 * r) };
}

/** The heart's long axis for the beat: the apex (mm, grid frame), the unit axis from base to apex, and the height of the base above the apex. */
export interface BeatFrame {
  apex: Vec3;
  axis: Vec3;
  height: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** How much of the whole-heart squeeze a mean contraction gives: nothing while the muscle is out of step. */
export function squeezeGate(meanContraction: number): number {
  const t = Math.min(1, Math.max(0, (meanContraction - BEAT.gateLow) / (BEAT.gateHigh - BEAT.gateLow)));
  return t * t * (3 - 2 * t);
}

/** The displacement of a point p (mm, grid frame, at rest) at contraction c, scaled by gain (the squeeze gate). */
export function beatDisplacement(f: BeatFrame, p: Vec3, c: number, gain = 1): Vec3 {
  if (!(c > 0) || !(gain > 0)) return [0, 0, 0];
  const L = f.axis;
  const rel: Vec3 = [p[0] - f.apex[0], p[1] - f.apex[1], p[2] - f.apex[2]];
  const h = -dot(rel, L); // height above the apex
  const q: Vec3 = [rel[0] + h * L[0], rel[1] + h * L[1], rel[2] + h * L[2]]; // from the axis, across it
  const s = Math.min(1.3, Math.max(0, h / f.height));
  const theta = c * (BEAT.twistApex + (BEAT.twistBase - BEAT.twistApex) * s);
  const cs = Math.cos(theta), sn = Math.sin(theta);
  const lxq: Vec3 = [L[1] * q[2] - L[2] * q[1], L[2] * q[0] - L[0] * q[2], L[0] * q[1] - L[1] * q[0]];
  const shrink = 1 - c * BEAT.radial;
  const along = c * BEAT.longitudinal * Math.max(0, h);
  const out: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) out[k] = (along * L[k] + (q[k] * cs + lxq[k] * sn) * shrink - q[k]) * gain;
  return out;
}

/** Where a point of the moved heart was at rest (the inverse of the displacement, by fixed-point iteration). */
export function restPoint(f: BeatFrame, p: Vec3, c: number, gain = 1): Vec3 {
  if (!(c > 0) || !(gain > 0)) return p;
  let r: Vec3 = p;
  for (let i = 0; i < 4; i++) {
    const d = beatDisplacement(f, r, c, gain);
    r = [p[0] - d[0], p[1] - d[1], p[2] - d[2]];
  }
  return r;
}

/** How much a vertex of the rest of the heart, dist mm from the ventricles, follows them. */
export function followWeight(distMm: number): number {
  const t = Math.min(1, Math.max(0, (distMm - BEAT.holdMm) / (BEAT.freeMm - BEAT.holdMm)));
  return 1 - t * t * (3 - 2 * t);
}

/**
 * The same field in WGSL. Needs the Frame uniforms (F.apex: apex and height, F.axis: unit long axis).
 * beatMove(p, c) is the displacement of the rest point p at contraction c.
 */
export const beatWgsl = /* wgsl */ `
const BEAT_LONG = ${BEAT.longitudinal.toFixed(4)};
const BEAT_RAD = ${BEAT.radial.toFixed(4)};
const BEAT_TWIST_APEX = ${BEAT.twistApex.toFixed(4)};
const BEAT_TWIST_BASE = ${BEAT.twistBase.toFixed(4)};
const BEAT_HOLD = ${BEAT.holdMm.toFixed(2)};
const BEAT_FREE = ${BEAT.freeMm.toFixed(2)};
const BEAT_GATE_LOW = ${BEAT.gateLow.toFixed(3)};
const BEAT_GATE_HIGH = ${BEAT.gateHigh.toFixed(3)};
const BEAT_QUIVER = ${BEAT.quiverMm.toFixed(3)};
const SHOCK_RISE = ${SHOCK.riseS.toFixed(3)};
const SHOCK_FADE = ${SHOCK.fadeS.toFixed(3)};
const SHOCK_STILL = ${SHOCK.stillS.toFixed(3)};
const SHOCK_RELEASE = ${SHOCK.releaseS.toFixed(3)};

fn beatMove(p: vec3<f32>, c: f32) -> vec3<f32> {
  let L = F.axis.xyz;
  let rel = p - F.apex.xyz;
  let h = -dot(rel, L);
  let q = rel + h * L;
  let s = clamp(h / F.apex.w, 0.0, 1.3);
  let theta = c * mix(BEAT_TWIST_APEX, BEAT_TWIST_BASE, s);
  let turned = q * cos(theta) + cross(L, q) * sin(theta);
  return (c * BEAT_LONG * max(h, 0.0)) * L + turned * (1.0 - c * BEAT_RAD) - q;
}

fn followWeight(dist: f32) -> f32 {
  return 1.0 - smoothstep(BEAT_HOLD, BEAT_FREE, dist);
}

// The seconds since a shock fired the whole heart (kept by the voltage pass in stats[3]), the flash it makes, and how
// free the heart is to move (0 held still just after it, 1).
fn shockAge() -> f32 {
  return bitcast<f32>(stats[3]);
}

fn shockFlash() -> f32 {
  let t = shockAge();
  if (t < SHOCK_RISE) { return t / SHOCK_RISE; }
  return exp(-(t - SHOCK_RISE) / SHOCK_FADE);
}

fn shockStill() -> f32 {
  return smoothstep(SHOCK_STILL, SHOCK_STILL + SHOCK_RELEASE, shockAge());
}

// How much of the whole-heart squeeze the mean contraction cM gives, times the stillness after a shock.
fn squeezeGate(cM: f32) -> f32 {
  return smoothstep(BEAT_GATE_LOW, BEAT_GATE_HIGH, cM) * shockStill();
}

// The quiver of a patch whose contraction c is out of step with the mean cM: in along -n where it is tighter, out
// where it is looser, only as far as the squeeze is not taking over, and not at all right after a shock.
fn quiverMove(n: vec3<f32>, c: f32, cM: f32, gate: f32) -> vec3<f32> {
  let still = shockStill();
  return -n * ((c - cM) * BEAT_QUIVER * (1.0 - gate / max(still, 1e-3)) * still);
}
`;
