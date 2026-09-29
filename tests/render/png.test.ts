import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { decodePng, meanLuminance, waveFraction } from "./png";

// A tiny PNG writer for the tests: 8-bit RGBA, every row filtered with the given filter type.
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

function encodePng(width: number, height: number, rgba: Uint8Array, filters: number[], colorType = 6): Buffer {
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const px = (y: number, i: number) => {
    // source pixel bytes in the file's channel layout
    const p = (y * width + Math.floor(i / channels)) * 4 + (i % channels);
    return rgba[p];
  };
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length];
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = px(y, i);
      const a = i >= channels ? px(y, i - channels) : 0;
      const b = y > 0 ? px(y - 1, i) : 0;
      const c = y > 0 && i >= channels ? px(y - 1, i - channels) : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]);
}

function pattern(width: number, height: number): Uint8Array {
  const d = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      d[i] = (x * 37 + y * 11) & 255;
      d[i + 1] = (x * x + y * 5) & 255;
      d[i + 2] = (y * y * 3 + x) & 255;
      d[i + 3] = 255 - ((x + y) & 63);
    }
  return d;
}

describe("decodePng", () => {
  it("reads back RGBA pixels through every filter type", () => {
    const src = pattern(23, 17);
    for (const filters of [[0], [1], [2], [3], [4], [0, 1, 2, 3, 4]]) {
      const img = decodePng(encodePng(23, 17, src, filters));
      expect([img.width, img.height]).toEqual([23, 17]);
      expect(Array.from(img.data)).toEqual(Array.from(src));
    }
  });

  it("reads RGB and gives it an opaque alpha", () => {
    const src = pattern(9, 6);
    const img = decodePng(encodePng(9, 6, src, [4], 2));
    for (let i = 0; i < 9 * 6; i++) {
      expect([img.data[4 * i], img.data[4 * i + 1], img.data[4 * i + 2], img.data[4 * i + 3]]).toEqual([src[4 * i], src[4 * i + 1], src[4 * i + 2], 255]);
    }
  });

  it("refuses something that is not a PNG", () => {
    expect(() => decodePng(Buffer.from("not a png at all"))).toThrow(/PNG/);
  });
});

describe("image statistics", () => {
  const solid = (r: number, g: number, b: number, n = 100) => {
    const data = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) data.set([r, g, b, 255], 4 * i);
    return { width: 10, height: n / 10, data };
  };

  it("takes the mean luminance", () => {
    expect(meanLuminance(solid(0, 0, 0))).toBe(0);
    expect(meanLuminance(solid(255, 255, 255))).toBeCloseTo(255, 6);
    expect(meanLuminance(solid(255, 0, 0))).toBeCloseTo(0.2126 * 255, 3);
  });

  it("counts a pixel as lit by the wave when it turns much bluer than at rest, and nothing else", () => {
    const tissue = solid(110, 30, 28);
    expect(waveFraction(solid(190, 235, 255), tissue)).toBe(1); // the front: blue-white over red muscle
    expect(waveFraction(solid(60, 110, 170), tissue)).toBe(1); // its bloom
    expect(waveFraction(tissue, tissue)).toBe(0); // nothing changed
    expect(waveFraction(solid(250, 240, 235), tissue)).toBe(0); // a white highlight moved onto it
    expect(waveFraction(solid(95, 26, 30), tissue)).toBe(0); // the faint tint of excited muscle
    expect(waveFraction(solid(150, 190, 210), solid(6, 28, 40))).toBe(0); // a pale reflection over the dark room
  });
});
