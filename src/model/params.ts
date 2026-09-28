// Parameter sets for the minimal ventricular model of
//   Bueno-Orovio A, Cherry EM, Fenton FH (2008). "Minimal model for human
//   ventricular action potentials in tissue". J Theor Biol 253(3):544-560,
//   doi:10.1016/j.jtbi.2008.03.029  (Table 1, columns EPI, ENDO, M).
//
// Units: times in ms, u dimensionless (V_mV = 85.7 u - 84), k* dimensionless.
// A trailing "m" in a name is the paper's minus superscript (tauV1m = tau_v1^-),
// "p" is the plus superscript (tauVp = tau_v^+), "WInf" is tau_w-infinity and
// "wInfStar" is w-infinity-star.
//
// Verification (every constant below was checked, not recalled from memory):
//  1. Published Table 1 read from the paper itself, author-group hosted copy:
//     https://www.lehman.cuny.edu/academics/cmacs/documents/BuenoOrovio2008jtb.pdf
//     The PDF text extraction garbled one row (tau_o2 came out as "667 6 6"); it
//     reads 6, 6, 7 for EPI, ENDO, M in the yumpu copy of the same paper
//     (https://www.yumpu.com/en/document/view/17786039/the-fenton-cherry-minimal-model-lehman-college)
//     and in source 2.
//  2. Independent re-implementation, EPI / ENDO / Midwall sets, all 29 values
//     identical to source 1:
//     https://pigreads.readthedocs.io/en/latest/models/bueno2008minimal.html
//  3. svMultiPhysics BuenoOrovio class (references openCARP's Bueno model):
//     https://simvascular.github.io/svMultiPhysics/class_bueno_orovio.html
//     Identical to source 1 except the M-cell tau_s2, which it sets to 2 ms and
//     itself flags as a deviation from the paper. We use 4 ms, which is what
//     Table 1 (source 1) and source 2 give.
//  4. HandWiki table transcription (all three sets match source 1):
//     https://handwiki.org/wiki/Bueno-Orovio%E2%80%93Cherry%E2%80%93Fenton_model
// All three sets (EPI, ENDO, MID) are fully verified; no constant is unverified.
// Cross-check: steady-state 1 Hz APD90 of these sets is EPI 269, ENDO 263, M 414 ms
// (single cell), against the paper Table 2 values 269, 260, 410 ms (tissue).

export type Params = {
  uo: number;
  uu: number;
  thetaV: number;
  thetaW: number;
  thetaVm: number;
  thetaO: number;
  tauV1m: number;
  tauV2m: number;
  tauVp: number;
  tauW1m: number;
  tauW2m: number;
  kWm: number;
  uWm: number;
  tauWp: number;
  tauFi: number;
  tauO1: number;
  tauO2: number;
  tauSo1: number;
  tauSo2: number;
  kSo: number;
  uSo: number;
  tauS1: number;
  tauS2: number;
  kS: number;
  uS: number;
  tauSi: number;
  tauWInf: number;
  wInfStar: number;
};

/** Epicardial cell (paper Table 1, column EPI). */
export const EPI: Params = {
  uo: 0,
  uu: 1.55,
  thetaV: 0.3,
  thetaW: 0.13,
  thetaVm: 0.006,
  thetaO: 0.006,
  tauV1m: 60,
  tauV2m: 1150,
  tauVp: 1.4506,
  tauW1m: 60,
  tauW2m: 15,
  kWm: 65,
  uWm: 0.03,
  tauWp: 200,
  tauFi: 0.11,
  tauO1: 400,
  tauO2: 6,
  tauSo1: 30.0181,
  tauSo2: 0.9957,
  kSo: 2.0458,
  uSo: 0.65,
  tauS1: 2.7342,
  tauS2: 16,
  kS: 2.0994,
  uS: 0.9087,
  tauSi: 1.8875,
  tauWInf: 0.07,
  wInfStar: 0.94,
};

/** Endocardial cell (paper Table 1, column ENDO). */
export const ENDO: Params = {
  uo: 0,
  uu: 1.56,
  thetaV: 0.3,
  thetaW: 0.13,
  thetaVm: 0.2,
  thetaO: 0.006,
  tauV1m: 75,
  tauV2m: 10,
  tauVp: 1.4506,
  tauW1m: 6,
  tauW2m: 140,
  kWm: 200,
  uWm: 0.016,
  tauWp: 280,
  tauFi: 0.1,
  tauO1: 470,
  tauO2: 6,
  tauSo1: 40,
  tauSo2: 1.2,
  kSo: 2,
  uSo: 0.65,
  tauS1: 2.7342,
  tauS2: 2,
  kS: 2.0994,
  uS: 0.9087,
  tauSi: 2.9013,
  tauWInf: 0.0273,
  wInfStar: 0.78,
};

/** Mid-myocardial cell (paper Table 1, column M). */
export const MID: Params = {
  uo: 0,
  uu: 1.61,
  thetaV: 0.3,
  thetaW: 0.13,
  thetaVm: 0.1,
  thetaO: 0.005,
  tauV1m: 80,
  tauV2m: 1.4506,
  tauVp: 1.4506,
  tauW1m: 70,
  tauW2m: 8,
  kWm: 200,
  uWm: 0.016,
  tauWp: 280,
  tauFi: 0.078,
  tauO1: 410,
  tauO2: 7,
  tauSo1: 91,
  tauSo2: 0.8,
  kSo: 2.1,
  uSo: 0.6,
  tauS1: 2.7342,
  tauS2: 4,
  kS: 2.0994,
  uS: 0.9087,
  tauSi: 3.3849,
  tauWInf: 0.01,
  wInfStar: 0.5,
};
