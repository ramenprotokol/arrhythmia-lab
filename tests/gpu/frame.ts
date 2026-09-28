// The real heart's anatomy for tests, read from the frame file built from the source labels
// (the atria sit at the base). Do not guess the apex from the shape: "the narrower end" picks the wrong one.
import { readFileSync } from "node:fs";

const frame = JSON.parse(readFileSync("public/data/heart-frame.json", "utf8"));

export const APEX = frame.apexVoxel.map(Math.round) as [number, number, number];
export const BASE = frame.baseVoxel.map(Math.round) as [number, number, number];
