// A small PNG reader for the screenshot tests, so the pictures can be measured in Node without a
// dependency: 8-bit grey, grey and alpha, RGB and RGBA, not interlaced (what the browser writes).
import { inflateSync } from "node:zlib";

export interface Picture {
  width: number;
  height: number;
  /** RGBA, 4 bytes a pixel, rows from the top. */
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodePng(file: Buffer): Picture {
  if (file.length < 8 || SIGNATURE.some((b, i) => file[i] !== b)) throw new Error("not a PNG file");
  let width = 0, height = 0, colorType = 0;
  const parts: Buffer[] = [];
  for (let at = 8; at + 8 <= file.length; ) {
    const len = file.readUInt32BE(at);
    const type = file.toString("ascii", at + 4, at + 8);
    const body = file.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
      if (body[8] !== 8) throw new Error(`PNG bit depth ${body[8]} is not supported`);
      if (body[12] !== 0) throw new Error("interlaced PNG is not supported");
    } else if (type === "IDAT") parts.push(body);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error(`PNG colour type ${colorType} is not supported`);

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? rows[dst + i - channels] : 0;
      const b = y > 0 ? rows[dst - stride + i] : 0;
      const c = y > 0 && i >= channels ? rows[dst - stride + i - channels] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`bad PNG filter type ${filter}`);
      rows[dst + i] = (raw[src + i] + pred) & 255;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * channels;
    const grey = colorType === 0 || colorType === 4;
    data[4 * p] = rows[s];
    data[4 * p + 1] = grey ? rows[s] : rows[s + 1];
    data[4 * p + 2] = grey ? rows[s] : rows[s + 2];
    data[4 * p + 3] = channels === 4 ? rows[s + 3] : channels === 2 ? rows[s + 1] : 255;
  }
  return { width, height, data };
}

/** Mean luminance, 0 to 255 (Rec. 709 weights on the display values). */
export function meanLuminance(img: Picture): number {
  let sum = 0;
  for (let i = 0; i < img.data.length; i += 4) sum += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
  return sum / (img.data.length / 4);
}

/**
 * True where a pixel is lit by the electrical wave, judged against the same pixel of a picture of the heart at rest
 * from the same camera: much bluer than it was, not merely brighter (a white highlight brightens every channel alike,
 * and the muscle stays muscle-coloured away from the front). i is the byte offset of the pixel.
 */
export function isWaveLit(img: Picture, rest: Picture, i: number): boolean {
  const dr = img.data[i] - rest.data[i];
  const db = img.data[i + 2] - rest.data[i + 2];
  return db > 60 && db - dr > 50 && img.data[i + 2] > img.data[i] + 30;
}

/** Share of the picture lit by the wave, against the picture at rest. */
export function waveFraction(img: Picture, rest: Picture): number {
  if (img.width !== rest.width || img.height !== rest.height) throw new Error("pictures differ in size");
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) if (isWaveLit(img, rest, i)) n++;
  return n / (img.data.length / 4);
}

/** The middle of the pixels lit by the wave, or null if none are. */
export function waveCentre(img: Picture, rest: Picture): [number, number] | null {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (isWaveLit(img, rest, (y * img.width + x) * 4)) {
        sx += x;
        sy += y;
        n++;
      }
  return n ? [sx / n, sy / n] : null;
}

/** Mean absolute difference per channel between two pictures of the same size, 0 to 255. */
export function meanAbsDiff(a: Picture, b: Picture): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error("pictures differ in size");
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
  return sum / ((a.data.length / 4) * 3);
}
