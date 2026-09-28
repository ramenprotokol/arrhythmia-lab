// Packs the model constants for the GPU. The WGSL struct is generated from the same
// key list that packs the numbers, so the two can never drift apart.
import { EPI, type Params } from "../model/params";

export const PARAM_KEYS = Object.keys(EPI) as (keyof Params)[];

/** WGSL source for `struct Params { ... }` with one f32 per model constant. */
export function paramsWgsl(): string {
  return `struct Params {\n${PARAM_KEYS.map((k) => `  ${k}: f32,`).join("\n")}\n};`;
}

/** Bytes for a uniform buffer holding one Params struct, padded to 16 bytes. */
export function packParams(p: Params): Float32Array<ArrayBuffer> {
  const padded = Math.ceil(PARAM_KEYS.length / 4) * 4;
  const out = new Float32Array(padded);
  PARAM_KEYS.forEach((k, i) => (out[i] = p[k]));
  return out;
}

/** Bytes of one uniform buffer for a Params struct. */
export const PARAMS_BYTES = Math.ceil(PARAM_KEYS.length / 4) * 16;
