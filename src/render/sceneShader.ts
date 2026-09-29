import { commonWgsl } from "./commonShader";

// Two draws in the heart's pass besides the surfaces.
//   - The backdrop (vsBack, fsBack): a full-screen triangle at the far plane, drawn after the heart so it only
//     fills what the heart leaves: a dark studio sweep, lighter behind the heart, and a floor that fades into it
//     with a soft contact shadow under the heart.
//   - The cut face (vsCut, fsCut), while the heart is cut open: a square on the cut plane. Where the plane passes
//     through muscle it is the cut face, lit as fresh-cut muscle with the wave across the wall; where it passes
//     through a cavity the ray goes on, sphere tracing the distance field to the wall beyond (the endocardium),
//     and draws that at its own depth. The volumes are sampled where each point is at rest: the moving heart is
//     mapped back with its mean contraction (the ventricles move with the mean while cut open, so the cut face
//     and the surfaces agree).
export const sceneWgsl = /* wgsl */ `
${commonWgsl}

@group(0) @binding(3) var sdfTex: texture_3d<f32>;
@group(0) @binding(6) var smoothTex: texture_3d<f32>;

struct BackOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vsBack(@builtin(vertex_index) i: u32) -> BackOut {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var o: BackOut;
  o.pos = vec4<f32>(p * 2.0 - 1.0, 1.0, 1.0);
  o.uv = vec2<f32>(p.x, 1.0 - p.y);
  return o;
}

fn viewRay(uv: vec2<f32>) -> vec3<f32> {
  return normalize(F.fwd.xyz + F.right.xyz * ((uv.x * 2.0 - 1.0 - F.boxMin.w) * F.right.w) + F.up.xyz * ((1.0 - uv.y * 2.0 - F.floorN.w) * F.up.w));
}

@fragment
fn fsBack(in: BackOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let ro = F.eye.xyz;
  let rd = viewRay(uv);
  // where the heart is on the canvas
  let hc = F.viewProj * vec4<f32>(F.scene.xyz, 1.0);
  let heartUv = vec2<f32>(hc.x / hc.w * 0.5 + 0.5, 0.5 - hc.y / hc.w * 0.5);
  let aspect = F.view.x / max(F.view.y, 1.0);
  let d = (uv - heartUv - vec2<f32>(0.0, -0.03)) * vec2<f32>(aspect, 1.0);
  let r2 = dot(d, d);
  // a dark sweep, a soft pool of light behind the heart, cooler and dimmer toward the top of the room
  let up = dot(rd, F.up.xyz);
  var col = mix(vec3<f32>(0.0055, 0.0065, 0.0085), vec3<f32>(0.013, 0.016, 0.022), smoothstep(-0.2, 0.5, up));
  col = col + vec3<f32>(0.030, 0.036, 0.044) * exp(-r2 * 2.6);
  col = col + vec3<f32>(0.012, 0.010, 0.009) * exp(-r2 * 9.0);

  // the floor: a plane under the heart that fades into the sweep, with a soft contact shadow
  let down = dot(rd, F.floorN.xyz);
  if (down < -0.0005) {
    let tf = (F.scene.w - dot(ro - F.scene.xyz, F.floorN.xyz)) / down;
    if (tf > 0.0) {
      let q = ro + rd * tf - F.shadowC.xyz;
      let x = dot(q, F.shadowA.xyz) / F.shadowA.w;
      let y = dot(q, F.shadowB.xyz) / F.shadowB.w;
      let e = x * x + y * y;
      let shadow = exp(-e * 1.6) * 0.78 + exp(-e * 5.0) * 0.18;
      let pool = exp(-e * 0.18);
      var floorCol = vec3<f32>(0.010, 0.0115, 0.0135) + vec3<f32>(0.020, 0.023, 0.027) * pool;
      floorCol = floorCol * (1.0 - shadow);
      let fade = smoothstep(0.0, 0.25, -down) * exp(-tf / 1400.0);
      col = mix(col, floorCol, fade);
    }
  }
  return vec4<f32>(col, 1.0);
}

// ---- the cut face -------------------------------------------------------------------------------------

struct CutOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) world: vec3<f32>,
};

@vertex
// The square is only as big as the heart's cross-section there (the renderer measures it): the face's shader writes
// depth, which turns off early tests, so every pixel it covers runs it.
fn vsCut(@builtin(vertex_index) i: u32) -> CutOut {
  let n = F.cut.xyz;
  let helper = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.y) > 0.9);
  let a = normalize(cross(n, helper));
  let b = cross(n, a);
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
  let k = corners[i];
  let w = n * F.cut.w + a * (F.cutQuad.x + k.x * F.cutQuad.z) + b * (F.cutQuad.y + k.y * F.cutQuad.w);
  var o: CutOut;
  o.pos = F.viewProj * vec4<f32>(w, 1.0);
  o.world = w;
  return o;
}

// Where a point of the moving heart was at rest, for mean contraction c (the squeeze gated as the surfaces are).
fn restOf(p: vec3<f32>, c: f32) -> vec3<f32> {
  let gate = squeezeGate(c);
  if (gate * c < 1e-3) { return p; }
  var r = p;
  for (var i = 0; i < 3; i = i + 1) { r = p - beatMove(r, c) * gate; }
  return r;
}

fn sdf(p: vec3<f32>) -> f32 {
  return textureSampleLevel(sdfTex, lin, toUvw(p), 0.0).r * SDF_MAX;
}

// Outward normal of the tissue: minus the gradient of a wide density, which does not show the voxel staircase.
fn tissueNormal(p: vec3<f32>) -> vec3<f32> {
  let e = 1.5 * F.vol.w;
  let g = vec3<f32>(
    textureSampleLevel(smoothTex, lin, toUvw(p + vec3<f32>(e, 0.0, 0.0)), 0.0).r - textureSampleLevel(smoothTex, lin, toUvw(p - vec3<f32>(e, 0.0, 0.0)), 0.0).r,
    textureSampleLevel(smoothTex, lin, toUvw(p + vec3<f32>(0.0, e, 0.0)), 0.0).r - textureSampleLevel(smoothTex, lin, toUvw(p - vec3<f32>(0.0, e, 0.0)), 0.0).r,
    textureSampleLevel(smoothTex, lin, toUvw(p + vec3<f32>(0.0, 0.0, e)), 0.0).r - textureSampleLevel(smoothTex, lin, toUvw(p - vec3<f32>(0.0, 0.0, e)), 0.0).r);
  let l = length(g);
  if (l < 1e-5) { return vec3<f32>(0.0, 1.0, 0.0); }
  return -g / l;
}

struct CutFrag {
  @location(0) colour: vec4<f32>,
  @builtin(frag_depth) depth: f32,
};

@fragment
fn fsCut(in: CutOut) -> CutFrag {
  let eye = F.eye.xyz;
  let rd = normalize(in.world - eye);
  let c = meanContraction();
  let glow = F.look.z;
  var out: CutFrag;
  let pr = restOf(in.world, c);
  let s = fieldCubic(pr);
  if (s.a > 0.5) {
    // fresh-cut muscle: dark, wet, finely grained, with the wave running across the wall
    var n = -F.cut.xyz;
    if (dot(n, rd) > 0.0) { n = -n; }
    let grain = vnoise(pr * vec3<f32>(0.9, 0.9, 0.9)) * 0.5 + vnoise(pr * 2.3 + 4.0) * 0.5;
    let edge = 1.0 - smoothstep(0.52, 0.80, s.a);
    var sf: Surface;
    sf.n = normalize(n + (vnoiseD(pr * 0.8).xyz - 0.5) * 0.10);
    sf.albedo = mix(vec3<f32>(0.16, 0.018, 0.020), vec3<f32>(0.24, 0.034, 0.034), grain);
    sf.albedo = mix(sf.albedo, sf.albedo * vec3<f32>(0.66, 0.80, 1.15), refractory(s.r) * 0.6);
    sf.scatter = vec3<f32>(0.9, 0.12, 0.08);
    sf.wrap = 0.4;
    sf.rough = 0.45;
    sf.coat = 0.8;
    sf.coatRough = 0.16;
    sf.ao = 1.0 - edge * 0.35;
    sf.thin = 0.0;
    var col = shade(sf, -rd);
    col = col + FRONT_CORE * (frontLight(s.r, s.g) * glow * 1.1 * (1.0 - shockFlash()));
    col = col + vec3<f32>(0.006, 0.026, 0.050) * (refractory(s.r) * glow);
    col = col + FLASH_COL * (shockFlash() * glow * 0.8);
    out.colour = vec4<f32>(col, 1.0);
    out.depth = in.pos.z;
    return out;
  }
  // a cavity: go on to the wall beyond
  var t = 0.0;
  var hit = false;
  let steps = i32(F.march.y);
  for (var i = 0; i < steps; i = i + 1) {
    let q = restOf(in.world + rd * t, c);
    if (any(q < F.boxMin.xyz) || any(q > F.boxMax.xyz)) { break; }
    let d = sdf(q);
    if (d < 0.9) {
      if (density(q) > 0.5) { hit = true; break; }
      t = t + 0.35;
    } else {
      t = t + max(0.5, 0.85 * (d - F.vol.w));
    }
    if (t > 220.0) { break; }
  }
  if (!hit) { discard; }
  // refine to the surface
  var lo = max(0.0, t - 0.6);
  var hi = t;
  for (var k = 0; k < 5; k = k + 1) {
    let m = 0.5 * (lo + hi);
    if (density(restOf(in.world + rd * m, c)) > 0.5) { hi = m; } else { lo = m; }
  }
  let pw = in.world + rd * hi;
  let q = restOf(pw, c);
  var n = tissueNormal(q);
  if (dot(n, rd) > 0.0) { n = -n; }
  let w = fieldCubic(q + n * -0.8);
  var sf: Surface;
  // the inner wall is not smooth: trabeculae, muscular ridges running roughly along the long axis, stronger toward
  // the apex
  let along = dot(q - F.apex.xyz, F.axis.xyz);
  let across = q - F.axis.xyz * along;
  let rq = across * 0.32 + F.axis.xyz * (along * 0.07);
  let rn = vnoiseD(rq);
  let ridge = 1.0 - abs(2.0 * rn.w - 1.0);
  let towardApex = smoothstep(-80.0, -10.0, along);
  let grad = rn.xyz * sign(0.5 - rn.w) * 2.0 * vec3<f32>(0.32);
  sf.n = normalize(n - (grad - n * dot(grad, n)) * (0.35 + 0.45 * towardApex) + (vnoiseD(q * 0.9).xyz - 0.5) * 0.03);
  sf.albedo = vec3<f32>(0.24, 0.042, 0.042) * (0.85 + 0.25 * vnoise(q * 0.2)) * (0.8 + 0.25 * ridge);
  sf.albedo = mix(sf.albedo, sf.albedo * vec3<f32>(0.70, 0.82, 1.12), refractory(w.r) * 0.5);
  sf.scatter = MUSCLE_SCATTER_CUT;
  sf.wrap = 0.5;
  sf.rough = 0.42;
  sf.coat = 0.7;
  sf.coatRough = 0.14;
  // deeper in the chamber is darker
  sf.ao = mix(0.30, 1.0, exp(-hi / 45.0));
  sf.thin = 0.0;
  var col = shade(sf, -rd);
  col = col + FRONT_CORE * (frontLight(w.r, w.g) * glow * sf.ao * (1.0 - shockFlash()));
  col = col + vec3<f32>(0.004, 0.020, 0.040) * (refractory(w.r) * glow * sf.ao);
  col = col + FLASH_COL * (shockFlash() * glow * 0.7 * sf.ao);
  out.colour = vec4<f32>(col, 1.0);
  let clip = F.viewProj * vec4<f32>(pw, 1.0);
  out.depth = clamp(clip.z / clip.w, 0.0, 1.0);
  return out;
}

const MUSCLE_SCATTER_CUT = vec3<f32>(0.95, 0.16, 0.10);

// Where the plane passes through the layer of fat over the muscle: fat in section, pale yellow and wet.
@fragment
fn fsCutFat(in: CutOut) -> @location(0) vec4<f32> {
  let rd = normalize(in.world - F.eye.xyz);
  var n = -F.cut.xyz;
  if (dot(n, rd) > 0.0) { n = -n; }
  let c = meanContraction();
  let pr = restOf(in.world, c);
  let lobe = vnoise(pr * 0.5 + 17.0) * 0.7 + vnoise(pr * 1.4) * 0.3;
  var sf: Surface;
  sf.n = normalize(n + (vnoiseD(pr * 0.6).xyz - 0.5) * 0.12);
  sf.albedo = mix(vec3<f32>(0.40, 0.32, 0.16), vec3<f32>(0.50, 0.43, 0.25), lobe);
  sf.scatter = vec3<f32>(1.0, 0.80, 0.52);
  sf.wrap = 0.7;
  sf.rough = 0.35;
  sf.coat = 0.8;
  sf.coatRough = 0.14;
  sf.ao = 0.9;
  sf.thin = 0.0;
  return vec4<f32>(shade(sf, -rd), 1.0);
}
`;
