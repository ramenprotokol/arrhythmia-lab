import { paramsWgsl } from "./paramPack";

// One thread per cell. State per cell is vec4(u, v, w, s). Diffusion is a 5-point stencil
// where a missing neighbour is replaced by the cell itself, which is a no-flux edge.
// The reaction terms mirror stepCell in src/model/bocf.ts term by term.
export const sheetWgsl = /* wgsl */ `
${paramsWgsl()}

struct Sim { n: u32, dt: f32, k: f32, pad: f32 };

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<uniform> S: Sim;
@group(0) @binding(2) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec4<f32>>;

fn H(x: f32) -> f32 { return select(0.0, 1.0, x >= 0.0); }

// GPU tanh returns NaN for arguments above about 40 (a stimulated cell reaches about 63).
// tanh(15) is already exactly 1 in 32-bit float, so clamping loses nothing.
fn tanhSafe(x: f32) -> f32 { return tanh(clamp(x, -15.0, 15.0)); }

@compute @workgroup_size(8, 8)
fn step(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = S.n;
  if (gid.x >= n || gid.y >= n) { return; }
  let i = gid.y * n + gid.x;
  let c = src[i];
  let u = c.x; let v = c.y; let w = c.z; let s = c.w;

  let xm = select(gid.x - 1u, gid.x, gid.x == 0u);
  let xp = select(gid.x + 1u, gid.x, gid.x == n - 1u);
  let ym = select(gid.y - 1u, gid.y, gid.y == 0u);
  let yp = select(gid.y + 1u, gid.y, gid.y == n - 1u);
  let lap = src[gid.y * n + xm].x + src[gid.y * n + xp].x
          + src[ym * n + gid.x].x + src[yp * n + gid.x].x - 4.0 * u;
  let iDiff = S.k * lap;

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

  dst[i] = vec4<f32>(u + S.dt * du, v + S.dt * dv, w + S.dt * dw, s + S.dt * ds);
}

struct Apply { n: u32, mode: u32, cx: f32, cy: f32, r: f32, x1: f32, y1: f32, add: f32 };
@group(0) @binding(4) var<uniform> A: Apply;
@group(0) @binding(5) var<storage, read_write> state: array<vec4<f32>>;

// mode 0: add the current step of a stimulus to a disc: u += add. Cells that cannot fire
//         (refractory) do not, which is what makes a vulnerable window exist.
// mode 1: shock (everything back to rest).
// mode 2: the same current, on the rectangle from (cx, cy) to (x1, y1), corners included.
@compute @workgroup_size(8, 8)
fn apply(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = A.n;
  if (gid.x >= n || gid.y >= n) { return; }
  let i = gid.y * n + gid.x;
  if (A.mode == 1u) {
    state[i] = vec4<f32>(0.0, 1.0, 1.0, 0.0);
    return;
  }
  if (A.mode == 2u) {
    let fx = f32(gid.x); let fy = f32(gid.y);
    if (fx >= A.cx && fx <= A.x1 && fy >= A.cy && fy <= A.y1) {
      var c = state[i];
      c.x = c.x + A.add;
      state[i] = c;
    }
    return;
  }
  let dx = f32(gid.x) - A.cx;
  let dy = f32(gid.y) - A.cy;
  if (sqrt(dx * dx + dy * dy) <= A.r) {
    var c = state[i];
    c.x = c.x + A.add;
    state[i] = c;
  }
}
`;
