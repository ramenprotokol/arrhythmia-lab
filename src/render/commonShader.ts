import { SDF_MAX_MM } from "./fields";

// WGSL shared by the render passes. Everything is in millimetres in the grid frame.

// The per-frame uniforms, on their own for the post passes that need no volume.
export const frameWgsl = /* wgsl */ `
struct Frame {
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,      // camera position, w = seconds
  right: vec4<f32>,    // camera right (unit), w = tan(fovY / 2) * aspect
  up: vec4<f32>,       // camera up (unit), w = tan(fovY / 2)
  fwd: vec4<f32>,      // camera forward (unit), w = near
  vol: vec4<f32>,      // padded volume size in voxels, w = voxel size
  view: vec4<f32>,     // canvas width and height in pixels, far, frame counter
  cut: vec4<f32>,      // unit normal, w = offset: the kept side is dot(p, n) - w >= 0
  march: vec4<f32>,    // cut on, max steps, fine step, thickness behind the shell
  scene: vec4<f32>,    // pivot of the pose in the grid frame, w = floor height above (negative) that pivot
  floorN: vec4<f32>,   // the floor's normal (up in the picture), in the grid frame; w = lens shift up, in clip units
  look: vec4<f32>,     // bloom strength, exposure, glow gain, debug view
  boxMin: vec4<f32>,   // bounds of the padded volume; w = lens shift right, in clip units
  boxMax: vec4<f32>,
};

@group(0) @binding(0) var<uniform> F: Frame;
`;

// For the shell and scene passes: the uniforms, the voltage volume, noise, the electrophysiology colour
// map and the tissue lighting. The voltage volume (binding 1) is rgba16float and padded by one voxel like
// the solver's buffer:
//   r = u, g = trend (signed, clamped to -1..1: rising is positive, falling negative),
//   b = tissue class / 3, a = smoothed tissue density (0.5 is the tissue surface).
export const commonWgsl = /* wgsl */ `
${frameWgsl}
@group(0) @binding(1) var fieldTex: texture_3d<f32>;
@group(0) @binding(2) var lin: sampler;
@group(0) @binding(8) var<storage, read> stats: array<u32>;

// The excited share of the muscle, 0 at rest to 1 when all of it is up: the room lights up with it.
fn exciteFraction() -> f32 {
  return saturate(f32(stats[0]) * F.boxMax.w);
}

const SDF_MAX = ${SDF_MAX_MM.toFixed(1)};

fn toUvw(p: vec3<f32>) -> vec3<f32> {
  return (p / F.vol.w + vec3<f32>(1.0)) / F.vol.xyz;
}

fn field(p: vec3<f32>) -> vec4<f32> {
  return textureSampleLevel(fieldTex, lin, toUvw(p), 0.0);
}

fn density(p: vec3<f32>) -> f32 {
  return field(p).a;
}

// The same volume sampled with a cubic B-spline (eight trilinear fetches). Trilinear filtering leaves
// visible facets along a front that is only a voxel or two thick; this is smooth to the second derivative.
fn fieldCubic(p: vec3<f32>) -> vec4<f32> {
  let dims = F.vol.xyz;
  let tc = toUvw(p) * dims - vec3<f32>(0.5);
  let ic = floor(tc);
  let f = tc - ic;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
  let w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  let w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let o0 = (ic + vec3<f32>(0.5) - vec3<f32>(1.0) + w1 / g0) / dims;
  let o1 = (ic + vec3<f32>(0.5) + vec3<f32>(1.0) + w3 / g1) / dims;
  let a = textureSampleLevel(fieldTex, lin, vec3<f32>(o0.x, o0.y, o0.z), 0.0);
  let b = textureSampleLevel(fieldTex, lin, vec3<f32>(o1.x, o0.y, o0.z), 0.0);
  let c = textureSampleLevel(fieldTex, lin, vec3<f32>(o0.x, o1.y, o0.z), 0.0);
  let d = textureSampleLevel(fieldTex, lin, vec3<f32>(o1.x, o1.y, o0.z), 0.0);
  let e = textureSampleLevel(fieldTex, lin, vec3<f32>(o0.x, o0.y, o1.z), 0.0);
  let g = textureSampleLevel(fieldTex, lin, vec3<f32>(o1.x, o0.y, o1.z), 0.0);
  let h = textureSampleLevel(fieldTex, lin, vec3<f32>(o0.x, o1.y, o1.z), 0.0);
  let i = textureSampleLevel(fieldTex, lin, vec3<f32>(o1.x, o1.y, o1.z), 0.0);
  let lo = mix(mix(a, b, g1.x / (g0.x + g1.x)), mix(c, d, g1.x / (g0.x + g1.x)), g1.y / (g0.y + g1.y));
  let hi = mix(mix(e, g, g1.x / (g0.x + g1.x)), mix(h, i, g1.x / (g0.x + g1.x)), g1.y / (g0.y + g1.y));
  return mix(lo, hi, g1.z / (g0.z + g1.z));
}

// ---- noise ---------------------------------------------------------------------------------------

fn hash13(p: vec3<f32>) -> f32 {
  var q = fract(p * 0.1031);
  q = q + dot(q, q.zyx + vec3<f32>(31.32));
  return fract((q.x + q.y) * q.z);
}

fn vnoise(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n000 = hash13(i);
  let n100 = hash13(i + vec3<f32>(1.0, 0.0, 0.0));
  let n010 = hash13(i + vec3<f32>(0.0, 1.0, 0.0));
  let n110 = hash13(i + vec3<f32>(1.0, 1.0, 0.0));
  let n001 = hash13(i + vec3<f32>(0.0, 0.0, 1.0));
  let n101 = hash13(i + vec3<f32>(1.0, 0.0, 1.0));
  let n011 = hash13(i + vec3<f32>(0.0, 1.0, 1.0));
  let n111 = hash13(i + vec3<f32>(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

// Interleaved gradient noise (Jimenez): cheap, well spread, and it dithers a ray start nicely.
fn ign(p: vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// ---- the colour of the wave --------------------------------------------------------------------
// Voltage u in this model: rest 0, upstroke overshoot to about 1.5 that relaxes over some 20 mm behind the
// front to a dome near 1.3, which lasts most of the action potential, then repolarisation back to 0.
// So the colour follows u itself: the overshoot runs to near white and cools into the electric cyan of
// the dome, and as the voltage falls the cyan cools to teal and fades. Only the brief rising foot of the
// front, where u is low but climbing, needs the trend to tell it from the falling tail. Emission is HDR,
// for the bloom.
fn waveColour(u: f32, trend: f32) -> vec3<f32> {
  let x = max(u, 0.0);
  // the dome is a little brighter just after the overshoot and settles as it ages
  let dome = vec3<f32>(0.0, 0.27, 0.40) * (0.80 + 0.45 * smoothstep(1.15, 1.45, x));
  // repolarising side (and everything below the dome that is not rising): cyan cools to teal, then to a
  // deep blue-green
  var fall = mix(vec3<f32>(0.0), vec3<f32>(0.0, 0.03, 0.10), smoothstep(0.03, 0.16, x));
  fall = mix(fall, vec3<f32>(0.0, 0.10, 0.16), smoothstep(0.14, 0.45, x));
  fall = mix(fall, vec3<f32>(0.0, 0.21, 0.22), smoothstep(0.40, 0.85, x));
  fall = mix(fall, dome, smoothstep(0.85, 1.10, x));
  // the rising foot of the front: violet, blue, then cyan
  var rise = mix(vec3<f32>(0.0), vec3<f32>(0.09, 0.03, 0.36), smoothstep(0.03, 0.22, x));
  rise = mix(rise, vec3<f32>(0.01, 0.12, 0.52), smoothstep(0.18, 0.55, x));
  rise = mix(rise, dome, smoothstep(0.50, 1.00, x));
  let c = mix(fall, rise, smoothstep(0.15, 0.60, trend));
  // the overshoot behind the front runs to near white
  let hot = smoothstep(1.31, 1.50, x);
  return mix(c, vec3<f32>(0.80, 1.50, 2.00), hot);
}

// ---- lighting ------------------------------------------------------------------------------------
// A rig that follows the camera: a soft warm key from the upper left, a cool fill, a back light for the
// silhouette. The tissue itself is dark, desaturated crimson, wet and slightly translucent.

fn ggx(ndh: f32, rough: f32) -> f32 {
  let a = rough * rough;
  let a2 = a * a;
  let d = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d);
}

fn keyDirection() -> vec3<f32> {
  return normalize(-0.60 * F.right.xyz + 0.70 * F.up.xyz - 0.50 * F.fwd.xyz);
}

// A studio softbox seen in a mirror: a rectangle of light with soft edges. c is the direction of the box,
// ax and ay span it, halfW and halfH are its half sizes as slopes, and soft blurs the edge.
fn softbox(r: vec3<f32>, c: vec3<f32>, ax: vec3<f32>, ay: vec3<f32>, halfW: f32, halfH: f32, soft: f32) -> f32 {
  let d = dot(r, c);
  if (d <= 0.05) { return 0.0; }
  let x = dot(r, ax) / d;
  let y = dot(r, ay) / d;
  return (1.0 - smoothstep(halfW - soft, halfW + soft, abs(x))) * (1.0 - smoothstep(halfH - soft, halfH + soft, abs(y)));
}

fn shadeTissue(n: vec3<f32>, v: vec3<f32>, albedo: vec3<f32>, rough: f32, occl: f32, gloss: f32) -> vec3<f32> {
  let keyDir = keyDirection();
  let fillDir = normalize(0.85 * F.right.xyz - 0.30 * F.up.xyz - 0.35 * F.fwd.xyz);
  let backDir = normalize(0.45 * F.right.xyz + 0.40 * F.up.xyz + 0.85 * F.fwd.xyz);
  let ndv = saturate(dot(n, v));
  let kd = dot(n, keyDir);
  let excite = exciteFraction();

  // wrapped diffuse: soft but with a real shadow side
  let wrap = saturate((kd + 0.22) / 1.22);
  var col = albedo * vec3<f32>(1.00, 0.84, 0.70) * (1.55 * wrap * wrap);
  // light bleeding through the thin edge of the tissue, red and orange across the terminator
  let bleed = smoothstep(-0.30, 0.10, kd) * (1.0 - smoothstep(0.10, 0.60, kd));
  col = col + vec3<f32>(0.60, 0.09, 0.03) * albedo.r * bleed * 0.75;
  // cool fill and a faint ambient so the shadow side is never flat black
  col = col + albedo * vec3<f32>(0.16, 0.36, 0.55) * (0.32 * saturate(dot(n, fillDir) * 0.5 + 0.5));
  col = col + albedo * vec3<f32>(0.03, 0.07, 0.10) * (0.4 + 0.6 * saturate(dot(n, F.up.xyz) * 0.5 + 0.5));
  col = col * occl;

  // wet gloss. The mirror image of a studio: a big soft key box up and to the left, a tall strip light
  // behind to the right, a wide soft box overhead. Fresnel makes them strongest at grazing angles.
  let r = 2.0 * n * dot(n, v) - v;
  let fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  let soft = 0.06 + rough * 0.40;
  let kAx = normalize(cross(keyDir, F.up.xyz));
  let kAy = cross(kAx, keyDir);
  let stripDir = normalize(0.80 * F.right.xyz + 0.10 * F.up.xyz + 0.60 * F.fwd.xyz);
  let sAx = normalize(cross(stripDir, F.up.xyz));
  let topDir = normalize(0.15 * F.right.xyz + 1.0 * F.up.xyz - 0.25 * F.fwd.xyz);
  let tAx = normalize(cross(topDir, F.fwd.xyz));
  let tAy = cross(tAx, topDir);
  var env = vec3<f32>(1.0, 0.93, 0.85) * (4.6 * softbox(r, keyDir, kAx, kAy, 0.50, 0.32, soft));
  env = env + vec3<f32>(0.55, 0.85, 1.0) * (2.6 * softbox(r, stripDir, sAx, F.up.xyz, 0.13, 0.85, soft * 1.6));
  env = env + vec3<f32>(0.85, 0.95, 1.0) * (1.6 * softbox(r, topDir, tAx, tAy, 0.9, 0.55, soft * 1.5));
  col = col + env * (fres * (1.0 - 0.5 * rough) * mix(0.35, 1.0, occl) * gloss);
  // a tight point highlight from the key on top, so the gloss has a hot core
  let hk = normalize(keyDir + v);
  col = col + vec3<f32>(1.0, 0.93, 0.86) * (ggx(saturate(dot(n, hk)), rough) * (0.04 + 0.96 * pow(1.0 - saturate(dot(hk, v)), 5.0)) * saturate(kd + 0.05) * (0.45 * gloss));

  // cool rim on the silhouette, strongest where the back light grazes the surface, and stronger
  // and bluer while the heart is lit up
  let rim = pow(1.0 - ndv, 3.0) * (0.15 + 0.85 * saturate(dot(n, backDir) * 0.5 + 0.5));
  col = col + mix(vec3<f32>(0.10, 0.34, 0.46), vec3<f32>(0.08, 0.55, 0.78), excite) * (rim * (0.85 + 1.6 * excite)) * occl;
  return col;
}
`;
