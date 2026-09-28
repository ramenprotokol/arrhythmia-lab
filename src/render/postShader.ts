import { frameWgsl } from "./commonShader";

// The last two passes. fsFinal: HDR scene plus bloom, tone mapped (an ACES fit), with a soft vignette and
// a whisper of colour fringing at the corners; it writes display-encoded colour. fsFxaa: edge smoothing
// on that image, then film grain and a dither to keep the dark gradients free of banding.
export const postWgsl = /* wgsl */ `
${frameWgsl}
@group(0) @binding(1) var srcA: texture_2d<f32>;
@group(0) @binding(2) var srcB: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;
@group(0) @binding(8) var<storage, read> stats: array<u32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2<f32>(p.x, 1.0 - p.y);
  return o;
}

fn aces(x: vec3<f32>) -> vec3<f32> {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn toSrgb(c: vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

// The excited share of the muscle, 0 at rest to 1 when all of it is up.
fn exciteFraction() -> f32 {
  return saturate(f32(stats[0]) * F.boxMax.w);
}

fn ign(p: vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// A soft reflection of the heart on the glossy floor: the picture flipped about the line where the heart
// meets the floor, blurred more the farther it is from that line, and fading away. It only shows where the
// heart itself is not in front.
fn floorReflection(uv: vec2<f32>, coverage: f32, pixel: vec2<f32>) -> vec3<f32> {
  let base = F.scene.xyz + F.floorN.xyz * F.scene.w;
  let clip = F.viewProj * vec4<f32>(base, 1.0);
  if (clip.w <= 0.0) { return vec3<f32>(0.0); }
  let contact = vec2<f32>(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
  let below = uv.y - contact.y;
  if (below <= 0.0) { return vec3<f32>(0.0); }
  // how tall the heart looks on the canvas (twice the way from its middle to the floor), so the reflection
  // is the same size for the heart at any screen shape and with any panels over the canvas
  let centreClip = F.viewProj * vec4<f32>(F.scene.xyz, 1.0);
  let heartHeight = max(2.0 * (contact.y - (0.5 - centreClip.y / centreClip.w * 0.5)), 0.05);
  let blur = 0.006 + below * 0.14;
  let jitter = ign(pixel + vec2<f32>(F.view.w * 3.7, 0.0));
  var sum = vec3<f32>(0.0);
  for (var k = 0; k < 8; k = k + 1) {
    let off = ((f32(k) + jitter) / 8.0 - 0.5) * 2.0 * blur;
    let m = vec2<f32>(uv.x + off * 0.35, contact.y - below * 0.92 + off);
    // only the heart's own light is mirrored, not the room behind it: weight by how much of the picture
    // is heart there
    let tap = textureSampleLevel(srcA, smp, m, 0.0);
    sum = sum + tap.rgb * tap.a;
  }
  let fade = exp(-below / (0.15 * heartHeight)) * smoothstep(0.0, 0.015, below);
  return sum * (0.125 * 0.24) * fade * (1.0 - coverage);
}

@fragment
fn fsFinal(in: VOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let cen = uv - vec2<f32>(0.5);
  let fringe = cen * dot(cen, cen) * 0.010;
  let centre = textureSampleLevel(srcA, smp, uv, 0.0);
  var hdr = vec3<f32>(
    textureSampleLevel(srcA, smp, uv + fringe, 0.0).r,
    centre.g,
    textureSampleLevel(srcA, smp, uv - fringe, 0.0).b);
  hdr = hdr + floorReflection(uv, centre.a, in.pos.xy);
  // When most of the muscle is lit the bloom adds up over a huge area and washes the picture out, so it
  // is eased back as the excitation grows, a little like an auto-exposure.
  let excite = exciteFraction();
  hdr = hdr + textureSampleLevel(srcB, smp, uv, 0.0).rgb * (F.look.x * mix(1.0, 0.42, excite));
  hdr = hdr * (F.look.y * mix(1.0, 0.88, excite));

  let r = length(cen * vec2<f32>(1.0, 0.92)) * 1.55;
  hdr = hdr * (1.0 - 0.62 * smoothstep(0.30, 1.05, r));

  var col = aces(hdr);
  // grade: a touch of cool in the shadows, a touch of warmth in the highlights
  let lum = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
  col = col * mix(vec3<f32>(0.94, 1.0, 1.06), vec3<f32>(1.03, 1.0, 0.97), smoothstep(0.05, 0.8, lum));
  return vec4<f32>(toSrgb(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0))), 1.0);
}

fn fx(uv: vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(srcA, smp, uv, 0.0).rgb;
}

fn luma(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

@fragment
fn fsFxaa(in: VOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let px = 1.0 / F.view.xy;
  let rgbM = fx(uv);
  let lNW = luma(fx(uv + vec2<f32>(-1.0, -1.0) * px));
  let lNE = luma(fx(uv + vec2<f32>(1.0, -1.0) * px));
  let lSW = luma(fx(uv + vec2<f32>(-1.0, 1.0) * px));
  let lSE = luma(fx(uv + vec2<f32>(1.0, 1.0) * px));
  let lM = luma(rgbM);
  let lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  let lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  var dir = vec2<f32>(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  let reduce = max((lNW + lNE + lSW + lSE) * (0.25 / 8.0), 1.0 / 128.0);
  let rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, vec2<f32>(-6.0), vec2<f32>(6.0)) * px;
  let rgbA = 0.5 * (fx(uv + dir * (1.0 / 3.0 - 0.5)) + fx(uv + dir * (2.0 / 3.0 - 0.5)));
  let rgbB = rgbA * 0.5 + 0.25 * (fx(uv + dir * -0.5) + fx(uv + dir * 0.5));
  let lB = luma(rgbB);
  var col = select(rgbB, rgbA, lB < lMin || lB > lMax);

  // film grain, strongest in the darks, and a triangular dither of one code value
  let seed = in.pos.xy + vec2<f32>(F.view.w * 17.13, F.view.w * 9.71);
  let grain = ign(seed) - 0.5;
  col = col + vec3<f32>(grain * (0.012 + 0.018 * (1.0 - luma(col))));
  col = col + vec3<f32>((ign(in.pos.xy + 31.7) - ign(in.pos.xy * 1.37 + 5.3)) / 255.0);
  return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;
