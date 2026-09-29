import { commonWgsl } from "./commonShader";

// The heart's surfaces. Two meshes share this module:
//   - the ventricles (vsVent, fsVent): the simulated muscle. It moves with its own contraction, and its skin shows
//     the wave: a thin line of light where the voltage is climbing, the glow of fronts deeper in the wall, and a
//     faint cool tint on excited muscle. Fat fills the grooves and the coronary arteries and veins run in it,
//     placed from the per-vertex distances to the interventricular grooves and to the base.
//   - the rest of the heart (vsExtra, fsExtra): atria, great vessels and vein stumps, drawn but not simulated. It
//     is dragged along by the ventricles near the seam and stays put far from it; drawn from both sides, so its
//     inner walls show through the cutaway.
// The vertex shaders move the surface; the fragment shaders sample the voltage at the point's place at rest.
export const heartWgsl = /* wgsl */ `
${commonWgsl}

@group(0) @binding(3) var fibreA: texture_3d<f32>;
@group(0) @binding(4) var fibreB: texture_3d<f32>;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) rest: vec3<f32>,     // where the point is at rest (grid mm): the volumes are sampled here
  @location(1) nRest: vec3<f32>,
  @location(2) world: vec3<f32>,    // where it is now
  @location(3) nrm: vec3<f32>,
  @location(4) attr: vec4<f32>,     // ventricles: groove, distance from the seam, ao, concavity; the rest: part, distance from the seam, ao, fat mm
  @location(5) seam: vec2<f32>,     // ventricles: 1 where the nearest seam is with the left atrium (x) or the right (y)
  @location(6) contraction: f32,
  @location(7) gradG: vec3<f32>,    // ventricles: the directions along the surface in which g and b grow
  @location(8) gradB: vec3<f32>,
  @location(9) fat: vec2<f32>,      // the fat's thickness here, mm; how far toward the front of the heart (ventricles)
};

fn tangentOf(n: vec3<f32>) -> vec3<f32> {
  let helper = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.y) > 0.9);
  return normalize(cross(n, helper));
}

// The contraction that moves a point of the ventricles: its own, sampled just under the surface, blended toward the
// mean near the base (where the rest of the heart hangs on) and everywhere while the heart is cut open.
fn ventContraction(p: vec3<f32>, n: vec3<f32>, cMean: f32, localW: f32) -> f32 {
  let local = textureSampleLevel(fieldTex, lin, toUvw(p - n * 2.0), 0.0).b * F.ante.w;
  return mix(cMean, local, localW);
}

// A vertex of the ventricles: the muscle surface pushed out by its fat, moved by the contraction of the muscle under it.
@vertex
fn vsVent(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) a: vec4<f32>, @location(3) more: vec4<f32>,
          @location(4) gradG: vec3<f32>, @location(5) gradB: vec3<f32>, @location(6) fatN: vec3<f32>) -> VOut {
  let cMean = meanContraction();
  let localW = F.axis.w * smoothstep(3.0, 20.0, a.y);
  let thick = more.z;
  let ns = fatN;
  let pd = p + n * thick;
  let t = tangentOf(ns);
  let b = cross(ns, t);
  let e = 1.5;
  // the normal of the moved surface from two nearby points moved the same way: sampling the contraction at them
  // could land just outside a thin, curved wall, where there is none, and tip the normal over
  let c0 = ventContraction(p, n, cMean, localW);
  let gate = squeezeGate(cMean);
  let quiver = quiverMove(n, c0, cMean, gate);
  let w0 = pd + beatMove(pd, c0) * gate + quiver;
  let w1 = pd + t * e + beatMove(pd + t * e, c0) * gate + quiver;
  let w2 = pd + b * e + beatMove(pd + b * e, c0) * gate + quiver;
  var o: VOut;
  o.pos = F.viewProj * vec4<f32>(w0, 1.0);
  o.rest = p;
  o.nRest = n;
  o.world = w0;
  o.nrm = normalize(cross(w1 - w0, w2 - w0));
  o.attr = a;
  o.seam = more.xy;
  o.contraction = c0;
  o.gradG = gradG;
  o.gradB = gradB;
  o.fat = vec2<f32>(more.z, more.w);
  return o;
}

// A vertex of the rest of the heart: dragged along by the ventricles near the seam, still far from it. endDist is how
// far it is from the edge of the nearest vessel's cap (see vesselEnds).
@vertex
fn vsExtra(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) a: vec4<f32>, @location(3) fatN: vec3<f32>,
           @location(4) endDist: f32) -> VOut {
  let cMean = meanContraction();
  let gate = squeezeGate(cMean);
  let c = cMean * followWeight(a.y);
  let thick = a.w;
  let ns = fatN;
  let pd = p + n * thick;
  let t = tangentOf(ns);
  let b = cross(ns, t);
  let e = 1.5;
  let w0 = pd + beatMove(pd, c) * gate;
  let w1 = pd + t * e + beatMove(pd + t * e, c) * gate;
  let w2 = pd + b * e + beatMove(pd + b * e, c) * gate;
  var o: VOut;
  o.pos = F.viewProj * vec4<f32>(w0, 1.0);
  o.rest = p;
  o.nRest = n;
  o.world = w0;
  o.nrm = normalize(cross(w1 - w0, w2 - w0));
  o.attr = a;
  o.seam = vec2<f32>(endDist, 0.0);
  o.contraction = c;
  o.gradG = vec3<f32>(0.0);
  o.gradB = vec3<f32>(0.0);
  o.fat = vec2<f32>(a.w, 0.0);
  return o;
}

// The same surfaces, position only, for the stencil passes below (no normals, no shading).
@vertex
fn vsVentParity(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) a: vec4<f32>, @location(3) more: vec4<f32>) -> VOut {
  let cMean = meanContraction();
  let c0 = ventContraction(p, n, cMean, F.axis.w * smoothstep(3.0, 20.0, a.y));
  let gate = squeezeGate(cMean);
  let pd = p + n * more.z;
  var o: VOut;
  o.world = pd + beatMove(pd, c0) * gate + quiverMove(n, c0, cMean, gate);
  o.pos = F.viewProj * vec4<f32>(o.world, 1.0);
  return o;
}

@vertex
fn vsVentBareParity(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) a: vec4<f32>) -> VOut {
  let cMean = meanContraction();
  let c0 = ventContraction(p, n, cMean, F.axis.w * smoothstep(3.0, 20.0, a.y));
  let gate = squeezeGate(cMean);
  var o: VOut;
  o.world = p + beatMove(p, c0) * gate + quiverMove(n, c0, cMean, gate);
  o.pos = F.viewProj * vec4<f32>(o.world, 1.0);
  return o;
}

@vertex
fn vsExtraParity(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) a: vec4<f32>) -> VOut {
  let cMean = meanContraction();
  let pd = p + n * a.w;
  var o: VOut;
  o.world = pd + beatMove(pd, cMean * followWeight(a.y)) * squeezeGate(cMean);
  o.pos = F.viewProj * vec4<f32>(o.world, 1.0);
  return o;
}

@vertex
fn vsExtraBareParity(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) a: vec4<f32>) -> VOut {
  let cMean = meanContraction();
  var o: VOut;
  o.world = p + beatMove(p, cMean * followWeight(a.y)) * squeezeGate(cMean);
  o.pos = F.viewProj * vec4<f32>(o.world, 1.0);
  return o;
}

// While the heart is cut open, the surfaces are drawn once more into the stencil only, each crossing behind the cut
// flipping a bit: where an odd number lie behind the plane, the plane is inside the heart there.
@fragment
fn fsParity(in: VOut) -> @location(0) vec4<f32> {
  if (dot(in.world, F.cut.xyz) - F.cut.w < 0.0) { discard; }
  return vec4<f32>(0.0);
}

// The coronary vessels' tubes: they move with the muscle under them (anchor is the surface normal there).
@vertex
fn vsTube(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>, @location(2) anchor: vec3<f32>, @location(3) a: vec4<f32>,
          @location(4) centre: vec3<f32>) -> VOut {
  let cMean = meanContraction();
  let localW = F.axis.w * smoothstep(3.0, 20.0, a.y);
  // the tubes lie on the fat; the muscle under the middle of each ring decides how the whole ring moves
  let under = centre - anchor * (a.w + 2.0);
  let c = mix(cMean, textureSampleLevel(fieldTex, lin, toUvw(under), 0.0).b * F.ante.w, localW);
  let gate = squeezeGate(cMean);
  let quiver = quiverMove(anchor, c, cMean, gate);
  let t = tangentOf(n);
  let b = cross(n, t);
  let e = 0.5;
  let w0 = p + beatMove(p, c) * gate + quiver;
  let w1 = p + t * e + beatMove(p + t * e, c) * gate + quiver;
  let w2 = p + b * e + beatMove(p + b * e, c) * gate + quiver;
  var o: VOut;
  o.pos = F.viewProj * vec4<f32>(w0, 1.0);
  o.rest = p;
  o.nRest = n;
  o.world = w0;
  o.nrm = normalize(cross(w1 - w0, w2 - w0));
  o.attr = a;
  o.seam = vec2<f32>(0.0);
  o.contraction = c;
  o.gradG = anchor;
  o.gradB = vec3<f32>(0.0);
  o.fat = vec2<f32>(0.0);
  return o;
}

// ---- surface detail --------------------------------------------------------------------------------

// Tilt a normal by a height gradient (mm per mm), keeping the tilt in the tangent plane.
fn bump(n: vec3<f32>, grad: vec3<f32>) -> vec3<f32> {
  return normalize(n - (grad - n * dot(grad, n)));
}

// The direction of the muscle fibre along the surface, from the fibre tensor under it (zero where the fibre dives).
fn fibreAlong(p: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  let uvw = toUvw(p - n * 1.5);
  let a = textureSampleLevel(fibreA, lin, uvw, 0.0);
  let b = textureSampleLevel(fibreB, lin, uvw, 0.0);
  let tensor = mat3x3<f32>(vec3<f32>(a.x, a.w, b.x), vec3<f32>(a.w, a.y, b.y), vec3<f32>(b.x, b.y, a.z));
  let t1 = tangentOf(n);
  let t2 = cross(n, t1);
  let a11 = dot(t1, tensor * t1);
  let a12 = dot(t1, tensor * t2);
  let a22 = dot(t2, tensor * t2);
  let theta = 0.5 * atan2(2.0 * a12, a11 - a22);
  return (t1 * cos(theta) + t2 * sin(theta)) * smoothstep(0.30, 0.70, a11 + a22);
}

// ---- materials ---------------------------------------------------------------------------------------

const MUSCLE = vec3<f32>(0.22, 0.042, 0.038);
const MUSCLE_DARK = vec3<f32>(0.12, 0.022, 0.024);
const MUSCLE_BROWN = vec3<f32>(0.17, 0.044, 0.030);
const MUSCLE_PINK = vec3<f32>(0.26, 0.055, 0.056);
const MUSCLE_SCATTER = vec3<f32>(0.85, 0.12, 0.07);
// Epicardial fat: a pale cream-yellow, lit to about #e6d29c to #efe0b0, a little warmer in places, and slightly
// translucent: where the layer is thin the muscle's red shows through it.
const FAT = vec3<f32>(0.46, 0.38, 0.19);
const FAT_PALE = vec3<f32>(0.52, 0.46, 0.27);
const FAT_WARM = vec3<f32>(0.50, 0.36, 0.16);
const FAT_CREVICE = vec3<f32>(0.33, 0.23, 0.10);
const FAT_SCATTER = vec3<f32>(1.00, 0.80, 0.52);
const ARTERY = vec3<f32>(0.40, 0.12, 0.10);
const VEIN = vec3<f32>(0.070, 0.030, 0.068);

struct Look { albedo: vec3<f32>, scatter: vec3<f32>, wrap: f32, rough: f32, coat: f32, coatRough: f32, thin: f32 };

// The lobules of fat: rounded bumps a few millimetres across with smaller ones on them; w is how high the surface
// is there (0 in the crevices between lobules, 1 on top), xyz the slope for the normal.
fn fatLobes(p: vec3<f32>) -> vec4<f32> {
  let big = vnoiseD(p * 0.36 + 17.0);
  if (F.march.w <= 0.75) { return vec4<f32>(big.xyz * 0.22, saturate(big.w * 0.75 + 0.17)); }
  let small = vnoiseD(p * 0.95 + 3.0);
  let tiny = vnoiseD(p * 2.4 + 9.0);
  return vec4<f32>(big.xyz * 0.22 + small.xyz * 0.06 + tiny.xyz * 0.014, saturate(big.w * 0.75 + small.w * 0.35));
}

fn fatLook(p: vec3<f32>, lobes: vec4<f32>) -> Look {
  var l: Look;
  // broad patches of paler and warmer fat, then the lobules: a little darker and warmer down in the crevices
  let tone = vnoise(p * 0.07 + 11.0);
  let warmth = vnoise(p * 0.21 + 4.0);
  l.albedo = mix(FAT, FAT_PALE, smoothstep(0.2, 0.8, tone));
  l.albedo = mix(l.albedo, FAT_WARM, smoothstep(0.55, 0.9, warmth) * 0.6);
  l.albedo = mix(FAT_CREVICE, l.albedo, 0.55 + 0.45 * smoothstep(0.05, 0.45, lobes.w));
  l.scatter = FAT_SCATTER;
  l.wrap = 0.9;
  l.rough = 0.36;
  l.coat = 0.8;
  l.coatRough = 0.15;
  l.thin = 0.0;
  return l;
}

// Fine vessels in a thin wall: thin wandering lines where two smooth noises cross their middle value, faded out when
// they would be thinner than a pixel. Returns (venules, arterioles), 0..1. (Over the atria, where the wall is thin
// enough for them to show.)
fn fineVessels(p: vec3<f32>) -> vec2<f32> {
  let a = vnoise(p * 0.15 + 21.0);
  let b = vnoise(p * 0.38 + 7.0);
  let fa = max(fwidth(a), 1e-4);
  let fb = max(fwidth(b), 1e-4);
  let wa = 0.030;
  let wb = 0.045;
  let la = (1.0 - smoothstep(wa, wa + fa, abs(a - 0.5))) * saturate(wa / fa - 0.4);
  let lb = (1.0 - smoothstep(wb, wb + fb, abs(b - 0.5))) * saturate(wb / fb - 0.4);
  return vec2<f32>(la, lb);
}

fn muscleLook(p: vec3<f32>, streak: f32) -> Look {
  var l: Look;
  // patches of browner and pinker muscle a few centimetres across, and finer mottling
  let big = vnoise(p * 0.045 + 13.0);
  let m = vnoise(p * 0.07) * 0.65 + vnoise(p * 0.23 + 5.0) * 0.35;
  var base = mix(MUSCLE_BROWN, MUSCLE_PINK, smoothstep(0.25, 0.75, big));
  base = mix(MUSCLE_DARK, base, 0.55 + 0.45 * m);
  l.albedo = base * (1.0 - 0.07 * streak);
  l.scatter = MUSCLE_SCATTER;
  l.wrap = 0.40;
  l.rough = 0.36 + 0.05 * streak;
  l.coat = 1.0;
  l.coatRough = 0.06;
  l.thin = 0.0;
  return l;
}

// Blend two looks.
fn mixLook(a: Look, b: Look, t: f32) -> Look {
  var l: Look;
  l.albedo = mix(a.albedo, b.albedo, t);
  l.scatter = mix(a.scatter, b.scatter, t);
  l.wrap = mix(a.wrap, b.wrap, t);
  l.rough = mix(a.rough, b.rough, t);
  l.coat = mix(a.coat, b.coat, t);
  l.coatRough = mix(a.coatRough, b.coatRough, t);
  l.thin = mix(a.thin, b.thin, t);
  return l;
}

// Roughness widened where the normal changes fast across a pixel, so highlights do not sparkle.
fn aaRough(r: f32, n: vec3<f32>) -> f32 {
  let dn = max(dot(dpdxFine(n), dpdxFine(n)), dot(dpdyFine(n), dpdyFine(n)));
  return sqrt(min(1.0, r * r + 2.0 * dn));
}

fn surfaceOf(l: Look, n: vec3<f32>, ao: f32) -> Surface {
  var s: Surface;
  s.n = n;
  s.albedo = l.albedo;
  s.scatter = l.scatter;
  s.wrap = l.wrap;
  s.rough = l.rough;
  s.coat = l.coat;
  s.coatRough = l.coatRough;
  s.ao = ao;
  s.thin = l.thin;
  return s;
}

@fragment
fn fsVent(in: VOut) -> @location(0) vec4<f32> {
  if (F.march.x > 0.5 && dot(in.world, F.cut.xyz) - F.cut.w < 0.0) { discard; }
  let debug = i32(F.look.w + 0.5);
  let v = normalize(F.eye.xyz - in.world);
  let n0 = normalize(in.nrm);
  let nr = normalize(in.nRest);
  let p = in.rest;
  // how many millimetres of surface a pixel covers, for fading detail that would only shimmer
  let pxMm = 0.5 * (length(dpdxFine(in.world)) + length(dpdyFine(in.world)));

  // fat where its layer is thick enough to show, with a wandering, lobed edge that fades in over a millimetre or so
  let edge = ((vnoise(p * 0.45) - 0.5) * 0.7 + (vnoise(p * 1.3 + 2.0) - 0.5) * 0.3) * smoothstep(0.05, 0.6, in.fat.x);
  let fat = smoothstep(0.15, 1.25, in.fat.x + edge);

  // the finest detail only on the best tier (F.march.w is the tier's detail, 0 plain .. 1 full)
  let fine = F.march.w > 0.75;

  // the grain of the muscle along its fibres, faint under the epicardium
  var streak = 0.0;
  if (fine) {
    let along = fibreAlong(p, nr);
    if (dot(along, along) > 0.01) {
      // fine ridges along the fibres, like the small vessels and bundles seen through the epicardium
      let across = cross(nr, along);
      let q = vec3<f32>(dot(p, across) * 0.9, dot(p, along) * 0.09, 3.0);
      let r1 = 1.0 - abs(2.0 * vnoise(q) - 1.0);
      let r2 = 1.0 - abs(2.0 * vnoise(q * 2.1 + 5.0) - 1.0);
      streak = (r1 * r1 * 0.7 + r2 * r2 * 0.3 - 0.35) * 1.6;
    }
  }

  // the surface normal: a fine wet ripple on the muscle, rounded lobules on the fat
  var n = n0;
  if (F.march.w > 0.4) {
    let ripple = vnoiseD(p * 0.9 + 3.0);
    n = bump(n, ripple.xyz * 0.012 * F.march.w);
  }
  if (fine) {
    let glints = vnoiseD(p * 2.2 + 11.0);
    n = bump(n, glints.xyz * 0.010);
  }
  var look = muscleLook(p, streak);
  if (fine) {
    // a very fine grain in the muscle's colour, faded out before it would be smaller than a pixel
    let g = vnoise(p * 3.1 + 7.0) - 0.5;
    look.albedo = look.albedo * (1.0 + g * 0.09 * saturate(1.6 - pxMm * 5.0));
  }
  if (fat > 0.01) {
    let lobes = fatLobes(p);
    n = normalize(mix(n, bump(n, lobes.xyz * F.march.w), fat));
    var fl = fatLook(p, lobes);
    // thin fat is translucent: the muscle's red shows through it toward its edge
    let see = exp(-in.fat.x / 0.9) * 0.75;
    fl.albedo = mix(fl.albedo, look.albedo * vec3<f32>(1.35, 1.1, 1.05) + vec3<f32>(0.06, 0.045, 0.025), see);
    look = mixLook(look, fl, fat);
  }

  // ---- the wave: sampled at the point's place at rest, just under the skin and deeper in the wall (smoothly on the
  // best tier; the cheaper tiers take the plain trilinear sample)
  let taps = i32(F.left.w + 0.5);
  var s0: vec4<f32>;
  if (taps >= 2) { s0 = fieldCubic(p - nr * 1.2); } else { s0 = field(p - nr * 1.2); }
  let glowFront = frontLight(s0.r, s0.g);
  let excited = refractory(s0.r);
  var deep = 0.0;
  if (taps >= 2) {
    // the smooth sampling on the best tier: trilinear shows the voxels as speckles in the glow
    let s1 = fieldCubic(p - nr * 3.6);
    deep = deep + frontLight(s1.r, s1.g) * 0.60;
  } else if (taps >= 1) {
    let s1 = field(p - nr * 3.6);
    deep = deep + frontLight(s1.r, s1.g) * 0.60;
  }
  if (taps >= 2) {
    let s2 = fieldCubic(p - nr * 7.0);
    deep = deep + frontLight(s2.r, s2.g) * 0.32;
  }
  // excited muscle is a touch darker and cooler; fat over it hides it, the thicker the more
  let cover = fat * mix(0.6, 0.92, smoothstep(0.5, 2.5, in.fat.x));
  look.albedo = mix(look.albedo, look.albedo * vec3<f32>(0.88, 0.92, 1.0), excited * 0.5 * (1.0 - cover));

  var sf = surfaceOf(look, n, in.attr.z * mix(1.0, 0.8, saturate(in.attr.w * 4.0)));
  sf.rough = aaRough(sf.rough, n);
  sf.coatRough = aaRough(sf.coatRough, n);
  var col = shade(sf, v);

  let glow = F.look.z;
  // under fat the front shows only as a soft glow, so a big sweep never turns the fat white
  let through = 1.0 - 0.85 * cover;
  // a shock fires everything at once: there is no front to show then, only the flash
  let flash = shockFlash();
  let fronts = glow * through * (1.0 - flash);
  col = col + FRONT_CORE * (glowFront * fronts);
  col = col + FRONT_DEEP * (deep * fronts * 0.55);
  col = col + vec3<f32>(0.002, 0.009, 0.020) * (excited * glow * (1.0 - cover));
  // the whole heart firing at once after a shock: a flush over all the muscle, strongest where it faces the light
  col = col + FLASH_COL * (flash * glow * (1.0 - 0.6 * cover) * (0.55 + 0.45 * saturate(dot(n, v))));

  if (debug == 3) { col = vec3<f32>(fat, in.fat.x / 4.0, 0.0); }
  if (debug == 4) { col = vec3<f32>(saturate(-in.attr.x / 40.0), saturate(in.attr.x / 40.0), saturate(1.0 - in.attr.y / 20.0)) * 0.5; }
  if (debug == 5) { col = vec3<f32>(in.contraction); }
  if (debug == 6) { col = vec3<f32>(0.0, 0.7, 0.0); }
  return vec4<f32>(col, 1.0);
}

// ---- the rest of the heart -------------------------------------------------------------------------

const ATRIUM = vec3<f32>(0.11, 0.022, 0.034);
const ATRIUM_LIGHT = vec3<f32>(0.17, 0.036, 0.048);
const AORTA = vec3<f32>(0.56, 0.38, 0.30);
const TRUNK = vec3<f32>(0.50, 0.31, 0.27);
const VEINWALL = vec3<f32>(0.15, 0.032, 0.036);
// the lumen of a cut vessel, at its edge and deep in its middle, and the pale cut face of its wall
const LUMEN_NEAR = vec3<f32>(0.20, 0.022, 0.018);
const LUMEN = vec3<f32>(0.030, 0.0025, 0.0025);
const LIP = vec3<f32>(0.34, 0.16, 0.14);
const LIP_MM = 0.85;

@fragment
fn fsExtra(in: VOut, @builtin(front_facing) facing: bool) -> @location(0) vec4<f32> {
  if (F.march.x > 0.5 && dot(in.world, F.cut.xyz) - F.cut.w < 0.0) { discard; }
  let v = normalize(F.eye.xyz - in.world);
  var n = normalize(in.nrm);
  let p = in.rest;
  let part = i32(in.attr.x + 0.5);
  let inside = !facing;
  // (screen derivatives are taken here, while every pixel of the quad is running; only on the best tier)
  var fine = vec2<f32>(0.0);
  if (F.march.w > 0.75) { fine = fineVessels(p); }
  if (inside) { n = -n; }
  var l: Look;
  l.scatter = MUSCLE_SCATTER;
  l.wrap = 0.55;
  l.rough = 0.38;
  l.coat = 1.0;
  l.coatRough = 0.09;
  l.thin = 0.0;
  if (part == 1 || part == 2) {
    // atrial muscle: thin, darker and more purple than the ventricles, crinkled over the appendages
    let m = vnoise(p * 0.08 + 2.0);
    l.albedo = mix(ATRIUM, ATRIUM_LIGHT, m);
    l.albedo = mix(l.albedo, l.albedo * vec3<f32>(0.70, 0.76, 1.05), fine.x * 0.35 * F.march.w);
    l.thin = 0.9;
    l.wrap = 0.65;
    l.rough = 0.50;
    l.coat = 0.75;
    l.coatRough = 0.15;
    let w = vnoiseD(p * 0.21 + 5.0);
    n = bump(n, w.xyz * 0.12 * F.march.w);
    if (F.march.w > 0.75) {
      let w2 = vnoiseD(p * 0.6 + 9.0);
      n = bump(n, w2.xyz * 0.04);
    }
  } else if (part == 3 || part == 4) {
    // the aorta and the pulmonary trunk: pale, tough, glossy walls, with fat round their roots
    l.albedo = select(TRUNK, AORTA, part == 3) * (0.92 + 0.12 * vnoise(p * 0.15));
    l.scatter = vec3<f32>(0.95, 0.55, 0.45);
    l.wrap = 0.45;
    l.rough = 0.32;
    l.thin = 0.25;
    let w = vnoiseD(p * 0.35 + 1.0);
    n = bump(n, w.xyz * 0.04 * F.march.w);
  } else if (part == 5) {
    // the stumps of the veins: thin, dark red walls
    l.albedo = VEINWALL * (0.9 + 0.2 * vnoise(p * 0.2));
    l.scatter = vec3<f32>(0.60, 0.10, 0.12);
    l.thin = 0.35;
    l.rough = 0.40;
    l.coatRough = 0.12;
  } else {
    // a cap: the cut through a vessel, seen end on. Blood fills its lumen: dark red, darker toward the middle, as the
    // light that gets in dies away down the vessel; wet and glossy.
    let depth = smoothstep(LIP_MM, 7.0, in.seam.x);
    l.albedo = mix(LUMEN_NEAR, LUMEN, depth);
    l.scatter = vec3<f32>(0.6, 0.03, 0.03);
    l.wrap = 0.3;
    l.rough = 0.30;
    l.coat = 1.0;
    l.coatRough = 0.06;
  }
  // the cut edge of every vessel: the wall's own thickness in section, a pale band on each side of the edge
  let lip = 1.0 - smoothstep(LIP_MM * 0.6, LIP_MM * 1.4, in.seam.x);
  if (lip > 0.01) {
    var cut: Look;
    cut.albedo = LIP * (0.9 + 0.2 * vnoise(p * 0.9));
    cut.scatter = vec3<f32>(0.9, 0.3, 0.25);
    cut.wrap = 0.6;
    cut.rough = 0.48;
    cut.coat = 0.5;
    cut.coatRough = 0.14;
    cut.thin = 0.0;
    l = mixLook(l, cut, lip);
  }
  // the fat collar round the seam, as thick as the layer drawn there
  let edge = ((vnoise(p * 0.45) - 0.5) * 0.7 + (vnoise(p * 1.3 + 2.0) - 0.5) * 0.3) * smoothstep(0.05, 0.6, in.fat.x);
  let fat = smoothstep(0.15, 1.25, in.fat.x + edge) * select(1.0, 0.0, inside || part >= 5) * (1.0 - lip);
  if (fat > 0.01) {
    let lobes = fatLobes(p);
    l = mixLook(l, fatLook(p, lobes), fat);
    n = normalize(mix(n, bump(n, lobes.xyz * F.march.w), fat));
  }
  var ao = in.attr.z;
  if (part == 6) {
    // down the vessel, less of the room's light gets in
    ao = ao * mix(1.0, 0.35, smoothstep(LIP_MM, 9.0, in.seam.x));
  }
  if (inside) {
    // the inside of a chamber or vessel wall: darker, redder, no fat, and duller
    l.albedo = select(l.albedo * vec3<f32>(0.55, 0.38, 0.40), vec3<f32>(0.20, 0.12, 0.11), part == 3 || part == 4);
    l.coat = 0.5;
    ao = ao * 0.55;
  }
  var sf = surfaceOf(l, n, ao);
  sf.rough = aaRough(sf.rough, n);
  sf.coatRough = aaRough(sf.coatRough, n);
  if (i32(F.look.w + 0.5) == 6) { return vec4<f32>(0.0, 0.0, 0.7, 1.0); }
  if (i32(F.look.w + 0.5) == 9) {
    var pc = array<vec3<f32>, 7>(vec3<f32>(0.3), vec3<f32>(0.8, 0.1, 0.1), vec3<f32>(0.1, 0.7, 0.1), vec3<f32>(0.1, 0.2, 0.9),
      vec3<f32>(0.8, 0.7, 0.1), vec3<f32>(0.7, 0.1, 0.7), vec3<f32>(0.1, 0.8, 0.8));
    return vec4<f32>(pc[clamp(part, 0, 6)] * select(1.0, 0.35, inside), 1.0);
  }
  return vec4<f32>(shade(sf, v), 1.0);
}

// ---- the coronary vessels ------------------------------------------------------------------------------

@fragment
fn fsTube(in: VOut) -> @location(0) vec4<f32> {
  if (F.march.x > 0.5 && dot(in.world, F.cut.xyz) - F.cut.w < 0.0) { discard; }
  let v = normalize(F.eye.xyz - in.world);
  let n = normalize(in.nrm);
  let up = dot(n, normalize(in.gradG));
  let vein = in.attr.x > 0.5;
  let p = in.rest;
  var l: Look;
  l.wrap = 0.5;
  l.thin = 0.0;
  l.coat = 1.0;
  if (vein) {
    // thin-walled, full of dark blood: deep purple with a bright wet sheen
    l.albedo = VEIN * (0.85 + 0.3 * vnoise(p * 0.3));
    l.scatter = vec3<f32>(0.30, 0.06, 0.20);
    l.rough = 0.24;
    l.coatRough = 0.055;
  } else {
    // a thick muscular wall over bright blood: redder and paler than the muscle round it
    l.albedo = ARTERY * (0.9 + 0.2 * vnoise(p * 0.25 + 3.0));
    l.scatter = vec3<f32>(0.95, 0.20, 0.14);
    l.rough = 0.30;
    l.coatRough = 0.06;
  }
  // where the tube meets the surface it sits in its own shadow
  let ao = mix(0.25, 1.0, smoothstep(-0.7, 0.45, up));
  var sf = surfaceOf(l, n, ao);
  sf.rough = aaRough(sf.rough, n);
  sf.coatRough = aaRough(sf.coatRough, n);
  if (i32(F.look.w + 0.5) == 6) { return vec4<f32>(0.0, 0.7, 0.0, 1.0); }
  return vec4<f32>(shade(sf, v), 1.0);
}
`;
