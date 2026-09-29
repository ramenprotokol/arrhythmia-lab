import { frameWgsl } from "./commonShader";

// The last pass, straight onto the canvas: the HDR picture plus bloom, a gentle exposure that eases back while
// much of the heart is lit, a vignette, a filmic tone map that keeps reds red (the Khronos PBR Neutral curve,
// which holds hue and saturation until the highlights roll off to white), a light grade, then film grain and a
// dither so the dark gradients do not band. It writes display-encoded colour.
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

fn neutral(c0: vec3<f32>) -> vec3<f32> {
  let start = 0.76;
  let desat = 0.15;
  let x = min(c0.r, min(c0.g, c0.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  let c = c0 - vec3<f32>(offset);
  let peak = max(c.r, max(c.g, c.b));
  if (peak < start) { return c; }
  let d = 1.0 - start;
  let newPeak = 1.0 - d * d / (peak + d - start);
  let scaled = c * (newPeak / peak);
  let g = 1.0 - 1.0 / (desat * (peak - newPeak) + 1.0);
  return mix(scaled, vec3<f32>(newPeak), g);
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

@fragment
fn fsFinal(in: VOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let cen = uv - vec2<f32>(0.5);
  // a whisper of colour fringing toward the corners, as a real lens has
  let fringe = cen * dot(cen, cen) * 0.006;
  var hdr = vec3<f32>(
    textureSampleLevel(srcA, smp, uv + fringe, 0.0).r,
    textureSampleLevel(srcA, smp, uv, 0.0).g,
    textureSampleLevel(srcA, smp, uv - fringe, 0.0).b);
  // When the picture is drawn smaller than the screen (the pixel cap on a Retina display), sharpen it a little so it
  // holds up once the browser scales it up.
  let sharpen = F.march.z;
  if (sharpen > 0.0) {
    let px = 1.0 / F.view.xy;
    let around = 0.25 * (textureSampleLevel(srcA, smp, uv + vec2<f32>(px.x, 0.0), 0.0).rgb + textureSampleLevel(srcA, smp, uv - vec2<f32>(px.x, 0.0), 0.0).rgb
      + textureSampleLevel(srcA, smp, uv + vec2<f32>(0.0, px.y), 0.0).rgb + textureSampleLevel(srcA, smp, uv - vec2<f32>(0.0, px.y), 0.0).rgb);
    hdr = max(hdr + (hdr - around) * sharpen, vec3<f32>(0.0));
  }
  let excite = exciteFraction();
  hdr = hdr + textureSampleLevel(srcB, smp, uv, 0.0).rgb * (F.look.x * mix(1.0, 0.6, excite));
  hdr = hdr * (F.look.y * 1.05);

  let aspect = F.view.x / max(F.view.y, 1.0);
  let r = length(cen * vec2<f32>(mix(1.0, aspect, 0.35), 1.0)) * 1.45;
  hdr = hdr * (1.0 - 0.55 * smoothstep(0.35, 1.10, r));

  var col = neutral(max(hdr, vec3<f32>(0.0)));
  // grade: a touch of cool in the shadows, warmth in the highlights, a little more contrast in the mids
  let lum = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
  col = col * mix(vec3<f32>(0.95, 1.0, 1.06), vec3<f32>(1.03, 1.0, 0.97), smoothstep(0.03, 0.6, lum));
  col = clamp(col, vec3<f32>(0.0), vec3<f32>(1.0));
  // a little less saturation than the render, as a camera would give it, and a gentle S-curve
  col = mix(vec3<f32>(dot(col, vec3<f32>(0.2126, 0.7152, 0.0722))), col, 0.90);
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.18);
  var outc = toSrgb(col);

  // film grain, strongest in the darks, and a triangular dither of one code value
  let seed = in.pos.xy + vec2<f32>(F.view.w * 17.13, F.view.w * 9.71);
  let grain = ign(seed) - 0.5;
  let l2 = dot(outc, vec3<f32>(0.299, 0.587, 0.114));
  outc = outc + vec3<f32>(grain * (0.010 + 0.016 * (1.0 - l2)));
  outc = outc + vec3<f32>((ign(in.pos.xy + 31.7) - ign(in.pos.xy * 1.37 + 5.3)) / 255.0);
  return vec4<f32>(clamp(outc, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;
