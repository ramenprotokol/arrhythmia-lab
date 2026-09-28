import { commonWgsl } from "./commonShader";

// The anatomical shell: the epicardial surface mesh, lit like wet muscle, with the voltage sampled just
// under the surface and added as glow. Draws into an HDR target with a depth buffer; the scene pass
// reads that depth to know where the surface is along each ray.
export const shellWgsl = /* wgsl */ `
${commonWgsl}

@group(0) @binding(3) var fibreA: texture_3d<f32>;
@group(0) @binding(4) var fibreB: texture_3d<f32>;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) nrm: vec3<f32>,
};

@vertex
fn vs(@location(0) p: vec3<f32>, @location(1) n: vec3<f32>) -> VsOut {
  var o: VsOut;
  o.pos = F.viewProj * vec4<f32>(p, 1.0);
  o.wpos = p;
  o.nrm = n;
  return o;
}

// Occlusion from the tissue around the point: density taps in a cone around the normal, so the groove
// between the ventricles and the folds near the base sit a little darker. The taps are fixed, not
// jittered, so the result is smooth rather than grainy.
fn occlusion(p: vec3<f32>, n: vec3<f32>) -> f32 {
  let helper = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.y) > 0.9);
  let t = normalize(cross(n, helper));
  let b = cross(n, t);
  var sum = 0.0;
  for (var k = 0; k < 6; k = k + 1) {
    let a = 1.0471976 * f32(k);
    let d = normalize(n * 0.55 + (t * cos(a) + b * sin(a)) * 0.83);
    sum = sum + density(p + d * 2.5) + density(p + d * 6.0);
  }
  return 1.0 - 0.6 * saturate(sum / 12.0 * 1.5);
}

// The grain of the muscle: noise smeared along the local fibre direction, so the surface shows the real
// fibre field as fine streaks. The fibre comes as the tensor f f^T; its strongest direction in the
// tangent plane is where the streaks run. Returns the direction across the streaks in xyz and the
// streak value, about -1 to 1, in w. Where the fibre does not lie along the surface there is no grain.
fn fibreGrain(p: vec3<f32>, n: vec3<f32>) -> vec4<f32> {
  let uvw = toUvw(p - n * 1.5);
  let a = textureSampleLevel(fibreA, lin, uvw, 0.0);
  let b = textureSampleLevel(fibreB, lin, uvw, 0.0);
  let tensor = mat3x3<f32>(vec3<f32>(a.x, a.w, b.x), vec3<f32>(a.w, a.y, b.y), vec3<f32>(b.x, b.y, a.z));
  let helper = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.y) > 0.9);
  let t1 = normalize(cross(n, helper));
  let t2 = cross(n, t1);
  let a11 = dot(t1, tensor * t1);
  let a12 = dot(t1, tensor * t2);
  let a22 = dot(t2, tensor * t2);
  let theta = 0.5 * atan2(2.0 * a12, a11 - a22);
  let along = t1 * cos(theta) + t2 * sin(theta);
  let inPlane = smoothstep(0.30, 0.70, a11 + a22);
  var sum = 0.0;
  for (var k = -4; k <= 4; k = k + 1) {
    sum = sum + vnoise((p + along * (f32(k) * 1.4)) * 0.95);
  }
  return vec4<f32>(cross(n, along), clamp((sum / 9.0 - 0.5) * 5.5, -1.0, 1.0) * inPlane);
}

// How much excited muscle lies around a surface point, within a few centimetres along the surface: the
// wave lights the tissue ahead of it. Taps sit a little under the surface, spread around the normal.
fn nearGlow(p: vec3<f32>, n: vec3<f32>) -> f32 {
  let helper = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.y) > 0.9);
  let t = normalize(cross(n, helper));
  let b = cross(n, t);
  var sum = 0.0;
  for (var k = 0; k < 8; k = k + 1) {
    let a = 0.7853982 * f32(k);
    let d = t * cos(a) + b * sin(a);
    let q = p - n * 2.0;
    sum = sum + 1.0 * smoothstep(0.7, 1.2, field(q + d * 5.0).r) + 0.7 * smoothstep(0.7, 1.2, field(q + d * 12.0).r)
              + 0.4 * smoothstep(0.7, 1.2, field(q + d * 22.0).r);
  }
  return sum / 17.0;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  if (F.march.x > 0.5 && dot(in.wpos, F.cut.xyz) - F.cut.w < 0.0) { discard; }

  var n = normalize(in.nrm);
  let v = normalize(F.eye.xyz - in.wpos);
  let grain = fibreGrain(in.wpos, n);
  n = normalize(n + grain.xyz * (grain.w * 0.12));

  // fine surface detail: a faint, slow undulation and mottling, so the gloss breaks up like wet tissue
  let q = in.wpos * 0.30;
  let e = 0.5;
  let g = vec3<f32>(
    vnoise(q + vec3<f32>(e, 0.0, 0.0)) - vnoise(q - vec3<f32>(e, 0.0, 0.0)),
    vnoise(q + vec3<f32>(0.0, e, 0.0)) - vnoise(q - vec3<f32>(0.0, e, 0.0)),
    vnoise(q + vec3<f32>(0.0, 0.0, e)) - vnoise(q - vec3<f32>(0.0, 0.0, e)));
  n = normalize(n - (g - n * dot(g, n)) * 0.08);
  let mottle = vnoise(in.wpos * 0.09) * 0.7 + vnoise(in.wpos * 0.31 + 5.0) * 0.3;

  // voltage just under the surface (the mesh can sit a little outside the voxel edge)
  let s = fieldCubic(in.wpos - normalize(in.nrm) * 1.0);
  let excited = smoothstep(0.08, 0.7, s.r);

  var albedo = mix(vec3<f32>(0.105, 0.022, 0.020), vec3<f32>(0.150, 0.045, 0.031), mottle) * (1.0 + 0.18 * grain.w);
  // excited tissue reflects less red, so the blue glow is not muddied
  albedo = mix(albedo, albedo * vec3<f32>(0.30, 0.55, 0.85), excited);

  let occl = occlusion(in.wpos, normalize(in.nrm));
  let rough = mix(0.26, 0.40, mottle) + 0.07 * grain.w;
  var col = shadeTissue(n, v, albedo, rough, occl, 1.0);

  // The glow comes from inside a rounded body, so it is shaded too: brighter toward the key light and
  // where the surface turns to the edge, dimmer in the folds and on the far side, with a little
  // organic variation.
  let form = mix(0.50, 1.15, saturate(dot(n, keyDirection()) * 0.5 + 0.5));
  let edge = 0.85 + 0.75 * pow(1.0 - saturate(dot(n, v)), 2.0);
  let organic = (0.95 + 0.10 * vnoise(in.wpos * 0.25)) * (1.0 + 0.14 * grain.w);
  col = col + waveColour(s.r, s.g) * (F.look.z * form * edge * organic * mix(0.6, 1.0, occl));
  // the light of the wave on the wet surface ahead of it: a cool sheen that grows toward the edge
  let halo = nearGlow(in.wpos, normalize(in.nrm)) * (1.0 - excited);
  col = col + vec3<f32>(0.02, 0.14, 0.22) * halo * (0.5 + 1.2 * pow(1.0 - saturate(dot(n, v)), 2.0));
  return vec4<f32>(col, 1.0);
}
`;
