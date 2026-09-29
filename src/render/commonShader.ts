import { SDF_MAX_MM } from "./fields";
import { beatWgsl } from "./mechanics";

// WGSL shared by the render passes. Everything is in millimetres in the grid frame.

/** Floats in the per-frame uniform block (26 vec4, the first four the matrix). */
export const FRAME_FLOATS = 104;

// The per-frame uniforms, on their own for the post passes that need no volume.
export const frameWgsl = /* wgsl */ `
struct Frame {
  viewProj: mat4x4<f32>, // grid frame (at rest) to clip: the pose, the orbit camera and the lens shift
  eye: vec4<f32>,      // camera position, w = seconds
  right: vec4<f32>,    // camera right (unit), w = tan(fovY / 2) * aspect
  up: vec4<f32>,       // camera up (unit), w = tan(fovY / 2)
  fwd: vec4<f32>,      // camera forward (unit), w = near
  vol: vec4<f32>,      // padded volume size in voxels, w = voxel size
  view: vec4<f32>,     // canvas width and height in pixels, far, frame counter
  cut: vec4<f32>,      // unit normal, w = offset: the kept side is dot(p, n) - w >= 0
  march: vec4<f32>,    // cut on, max steps, sharpening (0 none), surface detail (0 plain .. 1 full)
  scene: vec4<f32>,    // pivot of the pose in the grid frame, w = floor height above (negative) that pivot
  floorN: vec4<f32>,   // the floor's normal (up in the picture), in the grid frame; w = lens shift up, in clip units
  look: vec4<f32>,     // bloom strength, exposure, glow gain, debug view
  boxMin: vec4<f32>,   // bounds of the padded volume; w = lens shift right, in clip units
  boxMax: vec4<f32>,   // w = 1 / muscle voxel count
  apex: vec4<f32>,     // the apex, mm; w = height of the base above it along the long axis
  axis: vec4<f32>,     // unit long axis from base to apex; w = how much the local contraction counts (0 in the cutaway)
  ante: vec4<f32>,     // unit anterior direction of the heart; w = beat gain (0 holds the heart still)
  left: vec4<f32>,     // unit direction from the right ventricle to the left; w = sub-surface taps
  centre: vec4<f32>,   // the muscle's centroid, mm; w = spare
  shadowA: vec4<f32>,  // the heart's footprint on the floor: first axis (unit), w = its half length, mm
  shadowB: vec4<f32>,  // second axis (unit), w = its half length, mm
  shadowC: vec4<f32>,  // centre of the footprint on the floor, mm; w = spare
  cutQuad: vec4<f32>,  // where the heart crosses the cut plane, in the plane's own axes: centre (x, y), half size (z, w)
};

@group(0) @binding(0) var<uniform> F: Frame;
`;

// For the heart passes: the uniforms, the voltage volume, noise, the electrophysiology colour map and the
// studio lighting. The voltage volume (binding 1) is rgba16float and padded by one voxel like the solver's buffer:
//   r = u, g = trend (signed, clamped to -1..1: rising is positive, falling negative),
//   b = contraction (0..1), a = smoothed tissue density (0.5 is the tissue surface).
export const commonWgsl = /* wgsl */ `
${frameWgsl}
@group(0) @binding(1) var fieldTex: texture_3d<f32>;
@group(0) @binding(2) var lin: sampler;
@group(0) @binding(8) var<storage, read> stats: array<u32>;

${beatWgsl}

// The excited share of the muscle, 0 at rest to 1 when all of it is up.
fn exciteFraction() -> f32 {
  return saturate(f32(stats[0]) * F.boxMax.w);
}

// The mean contraction of the muscle, 0 relaxed .. 1 all contracted, times the beat gain.
fn meanContraction() -> f32 {
  return saturate(f32(stats[1]) / 1024.0 * F.boxMax.w) * F.ante.w;
}

const SDF_MAX = ${SDF_MAX_MM.toFixed(1)};
const PI = 3.14159265;

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

// Value noise with its gradient (the derivative of the smooth interpolation), for bump mapping without extra taps.
fn vnoiseD(p: vec3<f32>) -> vec4<f32> {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let du = 6.0 * f * (1.0 - f);
  let a = hash13(i);
  let b = hash13(i + vec3<f32>(1.0, 0.0, 0.0));
  let c = hash13(i + vec3<f32>(0.0, 1.0, 0.0));
  let d = hash13(i + vec3<f32>(1.0, 1.0, 0.0));
  let e = hash13(i + vec3<f32>(0.0, 0.0, 1.0));
  let g = hash13(i + vec3<f32>(1.0, 0.0, 1.0));
  let h = hash13(i + vec3<f32>(0.0, 1.0, 1.0));
  let k = hash13(i + vec3<f32>(1.0, 1.0, 1.0));
  let k1 = b - a;
  let k2 = c - a;
  let k3 = e - a;
  let k4 = a - b - c + d;
  let k5 = a - c - e + h;
  let k6 = a - b - e + g;
  let k7 = -a + b + c - d + e - g - h + k;
  let v = a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
  let grad = du * vec3<f32>(
    k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
    k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
    k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
  return vec4<f32>(grad, v);
}


// ---- the electrical wave ---------------------------------------------------------------------------
// Voltage u in this model: rest 0, a fast upstroke to about 1.5, which relaxes over some 20 mm behind the
// front to a dome near 1.3 that lasts most of the action potential, then repolarisation back to 0. The picture
// keeps tissue looking like tissue: only the front itself, where the voltage is climbing, is a thin line of
// light; the overshoot just behind it is a softer afterglow; the rest of the excited (refractory) muscle gets
// a faint cool tint that fades as it recovers.

// How much of the front is here: 1 on the rising edge, a fainter afterglow on the overshoot behind it.
fn frontLight(u: f32, trend: f32) -> f32 {
  // the upstroke's foot only: the epicardial action potential dips after its spike and climbs again to the dome,
  // and that second climb is not the front
  let rising = smoothstep(0.08, 0.35, trend) * smoothstep(0.03, 0.22, u) * (1.0 - smoothstep(0.75, 1.05, u));
  let after = smoothstep(1.36, 1.52, u) * 0.22;
  return max(rising, after);
}

// How excited (refractory) the tissue is, for the tint: 1 on the dome, fading as it repolarises.
fn refractory(u: f32) -> f32 {
  return smoothstep(0.25, 0.95, u);
}

// The colour of the light of the front, HDR for the bloom.
const FRONT_CORE = vec3<f32>(0.62, 1.55, 2.30);
const FRONT_DEEP = vec3<f32>(0.05, 0.42, 1.00);
// A shock fires the whole heart at once: a brief warm-white flush, the amber of the Shock control, fading together.
const FLASH_COL = vec3<f32>(0.46, 0.24, 0.06);

// ---- the studio --------------------------------------------------------------------------------------
// A rig that follows the camera, as in a product shot: a big warm key box up and to the left, a cool strip
// light behind to the right that draws the silhouette, a soft box overhead, a faint cool kicker from behind on
// the left, and a dark room. Diffuse light comes from the same boxes treated as broad lights.

fn keyDir() -> vec3<f32> { return normalize(-0.58 * F.right.xyz + 0.62 * F.up.xyz - 0.52 * F.fwd.xyz); }
fn rimDir() -> vec3<f32> { return normalize(0.72 * F.right.xyz + 0.30 * F.up.xyz + 0.62 * F.fwd.xyz); }
fn topDir() -> vec3<f32> { return normalize(0.12 * F.right.xyz + 1.0 * F.up.xyz + 0.05 * F.fwd.xyz); }
fn kickDir() -> vec3<f32> { return normalize(-0.80 * F.right.xyz + 0.05 * F.up.xyz + 0.60 * F.fwd.xyz); }
fn fillDir() -> vec3<f32> { return normalize(0.70 * F.right.xyz - 0.10 * F.up.xyz - 0.70 * F.fwd.xyz); }

const KEY_COL = vec3<f32>(1.00, 0.90, 0.80);
const RIM_COL = vec3<f32>(0.62, 0.84, 1.00);
const TOP_COL = vec3<f32>(0.90, 0.95, 1.00);
const KICK_COL = vec3<f32>(0.55, 0.75, 1.00);
const FILL_COL = vec3<f32>(0.75, 0.82, 0.95);

// A soft-edged rectangle of light seen in a mirror: c is the direction of the box, ax and ay span it, halfW and
// halfH are its half sizes as slopes, soft blurs its edge.
fn softbox(r: vec3<f32>, c: vec3<f32>, ax: vec3<f32>, ay: vec3<f32>, halfW: f32, halfH: f32, soft: f32) -> f32 {
  let d = dot(r, c);
  if (d <= 0.05) { return 0.0; }
  let x = dot(r, ax) / d;
  let y = dot(r, ay) / d;
  return (1.0 - smoothstep(halfW - soft, halfW + soft, abs(x))) * (1.0 - smoothstep(halfH - soft, halfH + soft, abs(y)));
}

// The room around the heart as a mirror sees it: dim above, darker below.
fn room(r: vec3<f32>) -> vec3<f32> {
  return mix(vec3<f32>(0.010, 0.008, 0.007), vec3<f32>(0.030, 0.036, 0.045), smoothstep(-0.4, 0.8, dot(r, F.up.xyz)));
}

// The studio as the tissue's own sheen sees it: the key and top boxes and a faint cool rim, all broad and soft (rough
// is the tissue's roughness; their edges widen with it, so a slightly faceted surface shows no steps in them).
fn studioBroad(r: vec3<f32>, rough: f32) -> vec3<f32> {
  let soft = 0.12 + rough * 0.7;
  let k = keyDir();
  let kx = normalize(cross(k, F.up.xyz));
  let ky = cross(kx, k);
  let s = rimDir();
  let sx = normalize(cross(s, F.up.xyz));
  let t = topDir();
  let tx = normalize(cross(t, F.fwd.xyz));
  let ty = cross(tx, t);
  var e = KEY_COL * (5.0 * softbox(r, k, kx, ky, 0.50, 0.34, soft));
  e = e + TOP_COL * (1.2 * softbox(r, t, tx, ty, 1.0, 0.60, soft * 1.2));
  e = e + RIM_COL * (0.9 * softbox(r, s, sx, F.up.xyz, 0.14, 0.95, soft * 1.2));
  return e + room(r);
}

// The one crisp reflection of the wet film: a long thin strip light up and to the left, tilted a little, with a smooth
// (Gaussian) profile across it so its edges never show the mesh's facets. It gets wider and dimmer with roughness.
fn studioSharp(r: vec3<f32>, rough: f32) -> vec3<f32> {
  let k = normalize(-0.50 * F.right.xyz + 0.58 * F.up.xyz - 0.64 * F.fwd.xyz);
  let h = normalize(cross(k, F.up.xyz));
  let v = cross(h, k);
  // the strip's long axis, turned 25 degrees from the horizontal
  let along = h * 0.906 + v * 0.423;
  let across = cross(along, k);
  let d = dot(r, k);
  if (d <= 0.05) { return room(r); }
  let x = dot(r, along) / d;
  let y = dot(r, across) / d;
  let w = 0.032 + rough * 0.30;
  let strip = exp(-(y * y) / (w * w)) * (1.0 - smoothstep(0.9, 1.5, abs(x)));
  return KEY_COL * (19.0 * strip * (0.032 / w)) + room(r);
}

fn fresnel(f0: f32, c: f32) -> f32 {
  return f0 + (1.0 - f0) * pow(1.0 - saturate(c), 5.0);
}

// Wet tissue: a wrapped, colour-bleeding diffuse (light scatters through the flesh, red farthest), a broad
// sheen of the tissue itself, and a sharp clear coat (the film of fluid on it) that mirrors the studio.
struct Surface {
  n: vec3<f32>,        // shading normal
  albedo: vec3<f32>,
  scatter: vec3<f32>,  // colour of light that has travelled through the tissue
  wrap: f32,           // how far light wraps round the terminator (0 hard .. 1 very soft)
  rough: f32,          // the tissue's own specular roughness
  coat: f32,           // clear-coat strength
  coatRough: f32,
  ao: f32,
  thin: f32,           // light passing right through a thin wall (atria, vessel walls)
};

fn shade(s: Surface, v: vec3<f32>) -> vec3<f32> {
  let n = s.n;
  let ndv = max(dot(n, v), 1e-3);
  var col = vec3<f32>(0.0);

  // diffuse from the key, the fill and the top, wrapped more in red than in blue, like skin
  let wrapRgb = vec3<f32>(s.wrap, s.wrap * 0.55, s.wrap * 0.45);
  let kd = dot(n, keyDir());
  let dk = saturate((vec3<f32>(kd) + wrapRgb) / (1.0 + wrapRgb));
  col = col + s.albedo * KEY_COL * (dk * dk) * 2.2;
  let df = saturate((dot(n, fillDir()) + 0.3) / 1.3);
  col = col + s.albedo * FILL_COL * (df * df) * 0.20;
  let dt = saturate((dot(n, topDir()) + 0.2) / 1.2);
  col = col + s.albedo * TOP_COL * (dt * 0.20);
  // light that entered near the terminator and scattered out on the dark side: warm and deep
  let across = smoothstep(-0.55, 0.05, kd) * (1.0 - smoothstep(0.05, 0.55, kd));
  col = col + s.scatter * s.albedo.r * across * (0.55 * s.wrap);
  // light through a thin wall from the rim and kicker behind
  let back = saturate(dot(-n, rimDir())) + 0.6 * saturate(dot(-n, kickDir()));
  col = col + s.scatter * (back * s.thin * 0.35);
  // a dim ambient so the shadow side is never flat black, and a warm glow of light that has travelled through the
  // tissue: in the shadow, and most of all along the silhouette where the surface turns away from the light
  col = col + s.albedo * mix(vec3<f32>(0.020, 0.018, 0.017), vec3<f32>(0.050, 0.058, 0.070), saturate(dot(n, F.up.xyz) * 0.5 + 0.5));
  let away = 1.0 - ndv;
  let unlit = saturate(0.35 - kd);
  col = col + s.scatter * (s.wrap * (away * away * (0.10 + 0.30 * unlit) + unlit * 0.035));
  col = col * s.ao;

  // the tissue's own broad, soft sheen: wet tissue under a big soft box shows a big soft glow of it
  let r = reflect(-v, n);
  let fr = fresnel(0.05, ndv);
  let rough2 = max(s.rough, 0.08);
  col = col + studioBroad(r, rough2) * (fr * (1.45 - rough2) * mix(0.25, 1.0, s.ao));

  // the wet film: one thin, crisp reflection, strongest at grazing angles
  let fc = fresnel(0.022, ndv) * s.coat;
  col = col * (1.0 - fc);
  col = col + studioSharp(r, s.coatRough) * (fc * mix(0.20, 1.0, s.ao));
  return col;
}
`;
