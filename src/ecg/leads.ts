import type { ElectrodeName } from "./electrodes";

/** The twelve leads, in the order leadsFromElectrodes returns them. */
export const LEAD_NAMES = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"] as const;

/**
 * The standard 12 leads from the potential at nine electrodes.
 *   limb leads      I = LA - RA, II = LL - RA, III = LL - LA
 *   augmented       aVR = RA - (LA + LL) / 2, aVL = LA - (RA + LL) / 2, aVF = LL - (RA + LA) / 2
 *   chest leads     Vk = Ck - (RA + LA + LL) / 3      (the mean of the three limb electrodes, Wilson's terminal)
 * So I + III = II and aVR + aVL + aVF = 0 hold by construction.
 */
export function leadsFromElectrodes(e: Record<ElectrodeName, number>): Float32Array {
  const wilson = (e.RA + e.LA + e.LL) / 3;
  return Float32Array.of(
    e.LA - e.RA,
    e.LL - e.RA,
    e.LL - e.LA,
    e.RA - (e.LA + e.LL) / 2,
    e.LA - (e.RA + e.LL) / 2,
    e.LL - (e.RA + e.LA) / 2,
    e.V1 - wilson,
    e.V2 - wilson,
    e.V3 - wilson,
    e.V4 - wilson,
    e.V5 - wilson,
    e.V6 - wilson,
  );
}
