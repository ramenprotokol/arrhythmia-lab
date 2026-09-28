import { commonWgsl } from "./commonShader";

// The scene pass. One full-screen pass builds the whole HDR picture front to back along each camera ray:
//   - the room: a dark blue-teal backdrop and a floor with a pool of light under the heart
//   - the shell, drawn earlier into a colour and depth target, met at its depth as a translucent skin
//   - the muscle behind it (or the cut face, or the cavity walls when they are exposed), marched with
//     emission from the voltage and absorption by the tissue, so the wave glows through the wall.
// Empty space is crossed by sphere tracing against a distance field; inside tissue the step is fine.
export const sceneWgsl = /* wgsl */ `
${commonWgsl}

@group(0) @binding(3) var sdfTex: texture_3d<f32>;
@group(0) @binding(4) var shellTex: texture_2d<f32>;
@group(0) @binding(5) var depthTex: texture_depth_2d;
@group(0) @binding(6) var smoothTex: texture_3d<f32>;

// Outward normal of the tissue surface: minus the gradient of a wide density, which does not show the
// voxel staircase.
fn tissueNormal(p: vec3<f32>) -> vec3<f32> {
  let e = 1.5 * F.vol.w;
  let ex = vec3<f32>(e, 0.0, 0.0);
  let ey = vec3<f32>(0.0, e, 0.0);
  let ez = vec3<f32>(0.0, 0.0, e);
  let g = vec3<f32>(
    textureSampleLevel(smoothTex, lin, toUvw(p + ex), 0.0).r - textureSampleLevel(smoothTex, lin, toUvw(p - ex), 0.0).r,
    textureSampleLevel(smoothTex, lin, toUvw(p + ey), 0.0).r - textureSampleLevel(smoothTex, lin, toUvw(p - ey), 0.0).r,
    textureSampleLevel(smoothTex, lin, toUvw(p + ez), 0.0).r - textureSampleLevel(smoothTex, lin, toUvw(p - ez), 0.0).r);
  let l = length(g);
  if (l < 1e-5) { return vec3<f32>(0.0, 1.0, 0.0); }
  return -g / l;
}

// Tissue optics. Absorption per mm of full-density tissue, emission per mm, and how much of the light
// behind the shell survives its skin.
const SIGMA = 0.30;
const VOL_GAIN = 0.20;
const SHELL_OPACITY = 0.52;
const SURFACE_OPACITY = 0.88;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

fn rayBox(ro: vec3<f32>, rd: vec3<f32>) -> vec2<f32> {
  let inv = 1.0 / select(rd, vec3<f32>(1e-6), abs(rd) < vec3<f32>(1e-6));
  let a = (F.boxMin.xyz - ro) * inv;
  let b = (F.boxMax.xyz - ro) * inv;
  let lo = min(a, b);
  let hi = max(a, b);
  return vec2<f32>(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
}

fn backdrop(ro: vec3<f32>, rd: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
  let excite = exciteFraction();
  // a deep blue-teal room that lightens gently behind the heart, wherever the heart is on the canvas, and
  // more so while the heart is lit up
  let hc = F.viewProj * vec4<f32>(F.scene.xyz, 1.0);
  let heartUv = vec2<f32>(hc.x / hc.w * 0.5 + 0.5, 0.5 - hc.y / hc.w * 0.5);
  let r = length((uv - heartUv - vec2<f32>(0.0, 0.02)) * vec2<f32>(1.0, 0.85));
  var col = mix(vec3<f32>(0.016, 0.046, 0.062), vec3<f32>(0.002, 0.006, 0.010), smoothstep(0.0, 0.8, r));
  col = col + vec3<f32>(0.004, 0.030, 0.046) * (excite * exp(-r * r * 5.0));
  // a glossy floor under the heart: a pool of teal light that fades into the dark far away, and grows
  // brighter and bluer with the excitation
  let down = dot(rd, F.floorN.xyz);
  if (down < -0.0005) {
    let tf = (F.scene.w - dot(ro - F.scene.xyz, F.floorN.xyz)) / down;
    if (tf > 0.0) {
      let q = ro + rd * tf - F.scene.xyz;
      let d = q - F.floorN.xyz * dot(q, F.floorN.xyz);
      let pool = exp(-dot(d, d) / (2.0 * 62.0 * 62.0));
      let ring = exp(-pow((length(d) - 92.0) / 26.0, 2.0));
      let dist = exp(-tf / 1100.0);
      let floorCol = vec3<f32>(0.004, 0.011, 0.016)
        + vec3<f32>(0.017, 0.061, 0.080) * pool * (1.0 + 1.4 * excite)
        + vec3<f32>(0.004, 0.018, 0.024) * ring * (1.0 + 2.0 * excite)
        + vec3<f32>(0.0, 0.035, 0.060) * (pool * excite);
      col = mix(col, floorCol, smoothstep(0.0, 0.35, -down) * dist);
    }
  }
  return col;
}

// What a ray sees where it first reaches tissue that has no shell over it: the cut face, the walls of
// the cavities, the open base. th is the ray distance of the surface, air the length already crossed
// in empty space.
fn surfaceHit(ro: vec3<f32>, rd: vec3<f32>, th: f32, isCut: bool, air: f32) -> vec3<f32> {
  let ph = ro + rd * th;
  var n = tissueNormal(ph);
  var edge = 0.0;
  if (isCut) {
    n = -F.cut.xyz;
    // the outline of the cross-section: bright where the cut plane leaves the tissue
    edge = 1.0 - smoothstep(0.52, 0.92, density(ph));
  }
  if (dot(n, rd) > 0.0) { n = -n; }
  let s = fieldCubic(ph + rd * 0.9);
  let layer = s.b * 3.0;
  // endo, mid and epi differ only slightly: a faint banding across the wall
  var albedo = vec3<f32>(0.19, 0.050, 0.044);
  albedo = albedo * (1.0 + 0.16 * (1.0 - abs(layer - 2.0)) - 0.10 * step(2.5, layer));
  let excited = smoothstep(0.08, 0.7, s.r);
  albedo = mix(albedo, albedo * vec3<f32>(0.30, 0.55, 0.85), excited);
  // deeper into a cavity is darker
  let cavity = mix(0.22, 1.0, exp(-air / 40.0));
  // the cut face and the cavity walls are glossy too, but less: a big reflection would wash out the wave
  var col = shadeTissue(n, -rd, albedo, 0.50, cavity, 0.40);
  let glow = waveColour(s.r, s.g) * F.look.z;
  col = col + glow * select(0.85, 1.15, isCut);
  col = col + vec3<f32>(0.06, 0.42, 0.55) * (edge * edge * 0.55);
  return col;
}

// Marches the ray between ta and tb, adding to the running colour c and transmittance t.
// tCut is where the cut plane starts this stretch (or -1). surfFrom is the distance before which no
// surface is drawn. inWall is true for the stretch just behind the shell: it is the wall's own glow, so
// it ends where the ray leaves the muscle instead of running on through the cavity to the far wall.
// cutOnly is for the stretch in front of a shell: the shell is the surface there, so the only one drawn
// is the cut face itself.
fn marchRange(ro: vec3<f32>, rd: vec3<f32>, ta: f32, tb: f32, jit: f32, tCut: f32, surfFrom: f32, inWall: bool, cutOnly: bool,
              trans: ptr<function, f32>, c: ptr<function, vec3<f32>>, air: ptr<function, f32>) {
  if (tb <= ta) { return; }
  let dtFine = F.march.z;
  let maxSteps = i32(F.march.y);
  var t = ta + jit * dtFine;
  var prevT = ta;
  var prevIn = false;
  var wasIn = false;
  for (var i = 0; i < maxSteps; i = i + 1) {
    if (t > tb || *trans < 0.015) { break; }
    let p = ro + rd * t;
    let s = field(p);
    let inside = s.a > 0.5;
    if (inWall) {
      if (s.a > 0.3) { wasIn = true; }
      if (wasIn && s.a < 0.06) { break; }
    }

    if (inside && !prevIn) {
      // entered tissue between prevT and t: find the surface
      var lo = prevT;
      var hi = t;
      for (var k = 0; k < 4; k = k + 1) {
        let mid = 0.5 * (lo + hi);
        if (density(ro + rd * mid) > 0.5) { hi = mid; } else { lo = mid; }
      }
      let isCut = tCut >= 0.0 && abs(hi - tCut) < 0.75 * dtFine + 0.05;
      if (hi >= surfFrom && (isCut || !cutOnly)) {
        let sc = surfaceHit(ro, rd, hi, isCut, *air);
        *c = *c + *trans * sc * SURFACE_OPACITY;
        *trans = *trans * (1.0 - SURFACE_OPACITY);
      }
    }
    prevIn = inside;
    prevT = t;

    var dt = dtFine;
    if (s.a < 0.04) {
      // empty space: leap by the distance to the nearest muscle, less a safety margin of a voxel
      let dAir = textureSampleLevel(sdfTex, lin, toUvw(p), 0.0).r * SDF_MAX;
      dt = max(dtFine, 0.85 * (dAir - F.vol.w));
      *air = *air + dt;
    } else {
      let sigma = SIGMA * s.a;
      if (s.r > 0.015) {
        // only from inside the tissue: its surface has its own emission, and the thin fringe just outside
        // it would count the same light twice
        let e = waveColour(s.r, s.g) * smoothstep(0.45, 0.85, s.a);
        *c = *c + *trans * e * (VOL_GAIN * F.look.z * dt);
      }
      *trans = *trans * exp(-sigma * dt);
    }
    t = t + dt;
  }
}

@fragment
fn fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let px = vec2<i32>(frag.xy);
  let uv = frag.xy / F.view.xy;
  let ro = F.eye.xyz;
  let rd = normalize(F.fwd.xyz + F.right.xyz * ((uv.x * 2.0 - 1.0 - F.boxMin.w) * F.right.w) + F.up.xyz * ((1.0 - uv.y * 2.0 - F.floorN.w) * F.up.w));
  let jit = ign(frag.xy + vec2<f32>(F.view.w * 5.588238, F.view.w * 3.1416));
  let debug = i32(F.look.w + 0.5);

  // the shell: its distance along this ray and its lit colour
  var shellDist = 1e9;
  var shell = vec3<f32>(0.0);
  let dz = textureLoad(depthTex, px, 0);
  if (dz < 1.0 && debug != 2) {
    let zNear = F.fwd.w;
    let zFar = F.view.z;
    shellDist = (zNear * zFar / (zFar - dz * (zFar - zNear))) / dot(rd, F.fwd.xyz);
    shell = textureLoad(shellTex, px, 0).rgb;
  }
  let haveShell = shellDist < 1e8;

  var c = vec3<f32>(0.0);
  var trans = 1.0;
  var air = 0.0;

  let box = rayBox(ro, rd);
  var tA = max(box.x, 0.0);
  var tB = box.y;
  var tCut = -1.0;
  let cutOn = F.march.x > 0.5;
  if (cutOn) {
    // keep only the far side of the plane
    let dn = dot(rd, F.cut.xyz);
    let s0 = dot(ro, F.cut.xyz) - F.cut.w;
    if (abs(dn) < 1e-5) {
      if (s0 < 0.0) { tB = -1.0; }
    } else {
      let tc = -s0 / dn;
      if (dn > 0.0) {
        if (tc > tA) { tA = tc; tCut = tc; }
      } else {
        tB = min(tB, tc);
      }
    }
  }

  if (debug != 1) {
    // The stretch in front of the shell holds only tissue exposed by the cut, the open base or the
    // cavities. Where there is a shell the shell is the surface, so march ahead of it only when the cut
    // plane itself slices through the muscle there; otherwise the muscle is met at the shell.
    if (!haveShell) {
      marchRange(ro, rd, tA, tB, jit, tCut, 0.0, false, false, &trans, &c, &air);
    } else if (cutOn && tCut >= 0.0 && density(ro + rd * (tCut + 0.3)) > 0.5) {
      // stop a little short of the shell, which is where its own skin is drawn
      marchRange(ro, rd, tA, min(tB, shellDist - 1.5), jit, tCut, 0.0, false, true, &trans, &c, &air);
    }
  }
  if (haveShell && trans > 0.015 && shellDist >= tA - 0.5) {
    c = c + trans * shell;
    trans = trans * (1.0 - SHELL_OPACITY);
    if (debug != 1) {
      marchRange(ro, rd, shellDist, min(tB, shellDist + F.march.w), jit, -1.0, shellDist + 1.6, true, false, &trans, &c, &air);
    }
  }

  // alpha is how much of the picture the heart covers, so the reflection can be kept off it
  let coverage = 1.0 - trans;
  c = c + trans * backdrop(ro, rd, uv);
  return vec4<f32>(c, coverage);
}
`;
