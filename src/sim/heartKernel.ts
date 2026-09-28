import { paramsWgsl } from "./paramPack";

// 3D solver kernel. One thread per muscle voxel (the list in `muscle`), on a dense grid padded by
// one empty voxel on every side, so no bounds checks are needed.
//
// Diffusion is computed as fluxes through voxel FACES. The flux through the face between voxels A and
// B is one number, computed from A, B and their transverse neighbours, and A adds it while B subtracts
// it. A face with no muscle on one side carries exactly zero. That makes the total voltage conserved by
// construction. The shortcut of zeroing non-muscle neighbours leaks current at the tissue edge.
//
// Every value a thread needs lies inside its 3x3x3 window, so the window is loaded once.
// The reaction terms mirror stepCell in src/model/bocf.ts term by term.
export const heartWgsl = /* wgsl */ `
${paramsWgsl()}

struct Sim {
  sx: u32, sy: u32, count: u32, reaction: u32,
  dt: f32, invH: f32, dPar: f32, dPerp: f32,
};

@group(0) @binding(0) var<storage, read> PS: array<Params>;   // ENDO, MID, EPI
@group(0) @binding(1) var<uniform> S: Sim;
@group(0) @binding(2) var<storage, read> cells: array<u32>;   // tissue | fx | fy | fz, one byte each
@group(0) @binding(3) var<storage, read> muscle: array<u32>;  // padded linear index of every muscle voxel
@group(0) @binding(4) var<storage, read> srcU: array<f32>;
@group(0) @binding(5) var<storage, read_write> dstU: array<f32>;
@group(0) @binding(6) var<storage, read_write> gates: array<vec4<f32>>; // (v, w, s, unused), updated in place

fn H(x: f32) -> f32 { return select(0.0, 1.0, x >= 0.0); }

// GPU tanh returns NaN for arguments above about 40; tanh(15) is already exactly 1 in 32-bit float.
fn tanhSafe(x: f32) -> f32 { return tanh(clamp(x, -15.0, 15.0)); }

fn tissueOf(w: u32) -> u32 { return w & 255u; }

fn fibreOf(w: u32) -> vec3<f32> {
  let fx = f32(bitcast<i32>(w << 16u) >> 24u);
  let fy = f32(bitcast<i32>(w << 8u) >> 24u);
  let fz = f32(bitcast<i32>(w) >> 24u);
  return vec3<f32>(fx, fy, fz) / 127.0;
}

// Index into the 3x3x3 window for an offset with components in -1..1.
fn wi(o: vec3<i32>) -> i32 { return (o.z + 1) * 9 + (o.y + 1) * 3 + (o.x + 1); }

// Central difference of u along axis j at window voxel c, using only muscle neighbours.
fn tdiff(pu: ptr<function, array<f32, 27>>, pc: ptr<function, array<u32, 27>>, c: vec3<i32>, j: i32) -> f32 {
  var e = vec3<i32>(0);
  e[j] = 1;
  let ip = wi(c + e);
  let im = wi(c - e);
  let hasP = tissueOf((*pc)[ip]) != 0u;
  let hasM = tissueOf((*pc)[im]) != 0u;
  let u0 = (*pu)[wi(c)];
  let up = (*pu)[ip];
  let um = (*pu)[im];
  if (hasP && hasM) { return (up - um) * (0.5 * S.invH); }
  if (hasP) { return (up - u0) * S.invH; }
  if (hasM) { return (u0 - um) * S.invH; }
  return 0.0;
}

// Flux of D grad(u) along the axis through the face between window voxel a and a + e_axis.
fn faceFlux(pu: ptr<function, array<f32, 27>>, pc: ptr<function, array<u32, 27>>, a: vec3<i32>, axis: i32) -> f32 {
  var e = vec3<i32>(0);
  e[axis] = 1;
  let b = a + e;
  let wa = (*pc)[wi(a)];
  let wb = (*pc)[wi(b)];
  if (tissueOf(wa) == 0u || tissueOf(wb) == 0u) { return 0.0; }
  var g = vec3<f32>(0.0);
  g[axis] = ((*pu)[wi(b)] - (*pu)[wi(a)]) * S.invH;
  for (var j = 0; j < 3; j = j + 1) {
    if (j != axis) { g[j] = 0.5 * (tdiff(pu, pc, a, j) + tdiff(pu, pc, b, j)); }
  }
  let fa = fibreOf(wa);
  let fb = fibreOf(wb);
  let dd = S.dPar - S.dPerp;
  let da = dot(fa, g);
  let db = dot(fb, g);
  return S.dPerp * g[axis] + 0.5 * dd * (fa[axis] * da + fb[axis] * db);
}

@compute @workgroup_size(64)
fn step(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= S.count) { return; }
  let idx = muscle[gid.x];
  let sx = i32(S.sx);
  let sxy = i32(S.sx * S.sy);

  var wu: array<f32, 27>;
  var wc: array<u32, 27>;
  var n = 0;
  for (var dz = -1; dz <= 1; dz = dz + 1) {
    for (var dy = -1; dy <= 1; dy = dy + 1) {
      for (var dx = -1; dx <= 1; dx = dx + 1) {
        let j = u32(i32(idx) + dx + dy * sx + dz * sxy);
        wu[n] = srcU[j];
        wc[n] = cells[j];
        n = n + 1;
      }
    }
  }

  let dq = faceFlux(&wu, &wc, vec3<i32>(0, 0, 0), 0) - faceFlux(&wu, &wc, vec3<i32>(-1, 0, 0), 0)
         + faceFlux(&wu, &wc, vec3<i32>(0, 0, 0), 1) - faceFlux(&wu, &wc, vec3<i32>(0, -1, 0), 1)
         + faceFlux(&wu, &wc, vec3<i32>(0, 0, 0), 2) - faceFlux(&wu, &wc, vec3<i32>(0, 0, -1), 2);
  let iDiff = dq * S.invH;

  let u = wu[13];
  if (S.reaction == 0u) {
    dstU[idx] = u + S.dt * iDiff;
    return;
  }

  let P = PS[tissueOf(wc[13]) - 1u];
  let gt = gates[idx];
  let v = gt.x; let w = gt.y; let s = gt.z;

  let hV = H(u - P.thetaV);
  let hW = H(u - P.thetaW);
  let hVm = H(u - P.thetaVm);
  let hO = H(u - P.thetaO);

  let tauVm = (1.0 - hVm) * P.tauV1m + hVm * P.tauV2m;
  let tauWm = P.tauW1m + (P.tauW2m - P.tauW1m) * (1.0 + tanhSafe(P.kWm * (u - P.uWm))) / 2.0;
  let tauSo = P.tauSo1 + (P.tauSo2 - P.tauSo1) * (1.0 + tanhSafe(P.kSo * (u - P.uSo))) / 2.0;
  let tauS = (1.0 - hW) * P.tauS1 + hW * P.tauS2;
  let tauO = (1.0 - hO) * P.tauO1 + hO * P.tauO2;

  let vInf = 1.0 - hVm;
  let wInf = (1.0 - hO) * (1.0 - u / P.tauWInf) + hO * P.wInfStar;

  let jFi = -v * hV * (u - P.thetaV) * (P.uu - u) / P.tauFi;
  let jSo = (u - P.uo) * (1.0 - hW) / tauO + hW / tauSo;
  let jSi = -hW * w * s / P.tauSi;

  let dv = (1.0 - hV) * (vInf - v) / tauVm - hV * v / P.tauVp;
  let dw = (1.0 - hW) * (wInf - w) / tauWm - hW * w / P.tauWp;
  let ds = ((1.0 + tanhSafe(P.kS * (u - P.uS))) / 2.0 - s) / tauS;
  let du = -(jFi + jSo + jSi) + iDiff;

  dstU[idx] = u + S.dt * du;
  gates[idx] = vec4<f32>(v + S.dt * dv, w + S.dt * dw, s + S.dt * ds, 0.0);
}

struct Apply {
  count: u32, mode: u32, sx: u32, sy: u32,
  cx: f32, cy: f32, cz: f32, r2: f32,
  add: f32, p0: f32, p1: f32, p2: f32,
};
@group(0) @binding(7) var<uniform> A: Apply;
@group(0) @binding(8) var<storage, read_write> curU: array<f32>;

// mode 0: add one step of a stimulus current (u += add) to the muscle voxels inside a ball.
// mode 1: shock, every muscle voxel back to rest.
@compute @workgroup_size(64)
fn apply(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= A.count) { return; }
  let idx = muscle[gid.x];
  if (A.mode == 1u) {
    curU[idx] = 0.0;
    gates[idx] = vec4<f32>(1.0, 1.0, 0.0, 0.0);
    return;
  }
  let x = idx % A.sx;
  let y = (idx / A.sx) % A.sy;
  let z = idx / (A.sx * A.sy);
  let d = vec3<f32>(f32(x) - A.cx, f32(y) - A.cy, f32(z) - A.cz);
  if (dot(d, d) <= A.r2) { curU[idx] = curU[idx] + A.add; }
}
`;
