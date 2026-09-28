// Bloom on a chain of half-size targets (the "next generation post processing" scheme: a 13-tap
// downsample that keeps fireflies down, a 9-tap tent on the way back up).
//   fsBright: scene to the first level, keeping only what is brighter than the threshold (soft knee)
//   fsDown:   level to the next smaller level
//   fsUp:     level to the next larger level, drawn additively onto what is already there
export const bloomWgsl = /* wgsl */ `
struct Params {
  texel: vec2<f32>,    // size of one source texel in uv units
  threshold: f32,
  knee: f32,
  mixAmt: f32,         // how much of the level below is added going up
  pad0: f32,
  pad1: f32,
  pad2: f32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;

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

fn tap(uv: vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(src, smp, uv, 0.0).rgb;
}

fn prefilter(c: vec3<f32>) -> vec3<f32> {
  let br = max(c.r, max(c.g, c.b));
  var soft = clamp(br - P.threshold + P.knee, 0.0, 2.0 * P.knee);
  soft = soft * soft / (4.0 * P.knee + 1e-5);
  return c * (max(soft, br - P.threshold) / max(br, 1e-5));
}

fn karis(c: vec3<f32>) -> f32 {
  return 1.0 / (1.0 + dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)));
}

@fragment
fn fsBright(in: VOut) -> @location(0) vec4<f32> {
  let d = P.texel;
  let uv = in.uv;
  let a = prefilter(tap(uv + d * vec2<f32>(-2.0, -2.0)));
  let b = prefilter(tap(uv + d * vec2<f32>(0.0, -2.0)));
  let c = prefilter(tap(uv + d * vec2<f32>(2.0, -2.0)));
  let dd = prefilter(tap(uv + d * vec2<f32>(-2.0, 0.0)));
  let e = prefilter(tap(uv));
  let f = prefilter(tap(uv + d * vec2<f32>(2.0, 0.0)));
  let g = prefilter(tap(uv + d * vec2<f32>(-2.0, 2.0)));
  let h = prefilter(tap(uv + d * vec2<f32>(0.0, 2.0)));
  let i = prefilter(tap(uv + d * vec2<f32>(2.0, 2.0)));
  let j = prefilter(tap(uv + d * vec2<f32>(-1.0, -1.0)));
  let k = prefilter(tap(uv + d * vec2<f32>(1.0, -1.0)));
  let l = prefilter(tap(uv + d * vec2<f32>(-1.0, 1.0)));
  let m = prefilter(tap(uv + d * vec2<f32>(1.0, 1.0)));
  // five overlapping boxes, each weighted down by its brightness so one hot pixel cannot dominate
  let g0 = (a + b + dd + e) * 0.25;
  let g1 = (b + c + e + f) * 0.25;
  let g2 = (dd + e + g + h) * 0.25;
  let g3 = (e + f + h + i) * 0.25;
  let g4 = (j + k + l + m) * 0.25;
  let w0 = 0.125 * karis(g0);
  let w1 = 0.125 * karis(g1);
  let w2 = 0.125 * karis(g2);
  let w3 = 0.125 * karis(g3);
  let w4 = 0.5 * karis(g4);
  return vec4<f32>((g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4), 1.0);
}

@fragment
fn fsDown(in: VOut) -> @location(0) vec4<f32> {
  let d = P.texel;
  let uv = in.uv;
  let a = tap(uv + d * vec2<f32>(-2.0, -2.0));
  let b = tap(uv + d * vec2<f32>(0.0, -2.0));
  let c = tap(uv + d * vec2<f32>(2.0, -2.0));
  let dd = tap(uv + d * vec2<f32>(-2.0, 0.0));
  let e = tap(uv);
  let f = tap(uv + d * vec2<f32>(2.0, 0.0));
  let g = tap(uv + d * vec2<f32>(-2.0, 2.0));
  let h = tap(uv + d * vec2<f32>(0.0, 2.0));
  let i = tap(uv + d * vec2<f32>(2.0, 2.0));
  let j = tap(uv + d * vec2<f32>(-1.0, -1.0));
  let k = tap(uv + d * vec2<f32>(1.0, -1.0));
  let l = tap(uv + d * vec2<f32>(-1.0, 1.0));
  let m = tap(uv + d * vec2<f32>(1.0, 1.0));
  let col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + dd + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  return vec4<f32>(col, 1.0);
}

@fragment
fn fsUp(in: VOut) -> @location(0) vec4<f32> {
  let d = P.texel;
  let uv = in.uv;
  let a = tap(uv + d * vec2<f32>(-1.0, 1.0));
  let b = tap(uv + d * vec2<f32>(0.0, 1.0));
  let c = tap(uv + d * vec2<f32>(1.0, 1.0));
  let dd = tap(uv + d * vec2<f32>(-1.0, 0.0));
  let e = tap(uv);
  let f = tap(uv + d * vec2<f32>(1.0, 0.0));
  let g = tap(uv + d * vec2<f32>(-1.0, -1.0));
  let h = tap(uv + d * vec2<f32>(0.0, -1.0));
  let i = tap(uv + d * vec2<f32>(1.0, -1.0));
  let col = (e * 4.0 + (b + dd + f + h) * 2.0 + (a + c + g + i)) / 16.0;
  return vec4<f32>(col * P.mixAmt, 1.0);
}
`;
