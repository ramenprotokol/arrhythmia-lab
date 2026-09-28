import { ELECTRODE_NAMES } from "./electrodes";

/** Threads per workgroup in both passes. A power of two, because the reduction halves it each round. */
export const ECG_WORKGROUP = 256;

const N = ELECTRODE_NAMES.length;
const WG = ECG_WORKGROUP;

// The ECG kernel: the potential at each electrode from the voltage field of the solver.
//
// Physics. The heart sits in an infinite, homogeneous conductor. Each muscle voxel p is a small current dipole
// q_p = D grad(u) (D is the same diffusion tensor the solver uses), and the potential of a distribution of
// current dipoles in such a medium is the textbook result (for example Malmivuo and Plonsey, Bioelectromagnetism)
//
//     phi(x_e) = -K * SUM over muscle voxels p of  (q_p . r) / |r|^3,      r = x_e - x_p  (mm)
//
// The minus sign matters: at a depolarisation front u falls from behind (high) to ahead (low), so grad(u) points
// backwards, away from the direction of travel. For an electrode the wave is heading toward, r points forward,
// q . r < 0, and phi > 0. A wave travelling toward an electrode gives a positive potential there, and one that
// runs away from it a negative one. K is applied on the CPU (see Ecg.ts); this kernel returns the bare sums.
//
// grad(u) is the masked central difference of the solver's tdiff: only muscle neighbours count, it is one-sided
// where only one side is muscle and zero where neither is, so the tissue edge creates no fake dipoles.
//
// Two passes. contribute: one thread per muscle voxel computes its nine electrode terms, a workgroup tree
// reduction adds them, and each workgroup writes nine partial sums. finish: one workgroup adds the partials into
// nine numbers and stores them in slot E.slot of a results ring. Only those numbers ever leave the GPU: nine
// floats (36 bytes) per sample.
export const ecgWgsl = /* wgsl */ `
struct Ecg {
  sx: u32, sy: u32, count: u32, groups: u32,
  invH: f32, dPar: f32, dPerp: f32, voxelMm: f32,
  slot: u32, pad0: u32, pad1: u32, pad2: u32,   // which slot of the results ring finish writes
  pos: array<vec4<f32>, ${N}>,                  // electrode positions in mm, w unused
};

@group(0) @binding(0) var<uniform> E: Ecg;
@group(0) @binding(1) var<storage, read> cells: array<u32>;    // tissue | fx | fy | fz, one byte each
@group(0) @binding(2) var<storage, read> muscle: array<u32>;   // padded linear index of every muscle voxel
@group(0) @binding(3) var<storage, read> volt: array<f32>;     // u, one per padded voxel
@group(0) @binding(4) var<storage, read_write> sums: array<f32>;   // ${N} partial sums per workgroup
@group(0) @binding(5) var<storage, read_write> total: array<f32>;  // the results ring: ${N} final sums per slot

var<workgroup> scratch: array<f32, ${N * WG}>;

// Same decoding as fibreOf in the solver kernel: int8 / 127.
fn fibreOf(w: u32) -> vec3<f32> {
  let fx = f32(bitcast<i32>(w << 16u) >> 24u);
  let fy = f32(bitcast<i32>(w << 8u) >> 24u);
  let fz = f32(bitcast<i32>(w) >> 24u);
  return vec3<f32>(fx, fy, fz) / 127.0;
}

// Derivative of u along one axis (stride st in the padded array) at voxel i, using only muscle neighbours.
fn diffAlong(i: i32, st: i32, u0: f32) -> f32 {
  let jp = u32(i + st);
  let jm = u32(i - st);
  let hasP = (cells[jp] & 255u) != 0u;
  let hasM = (cells[jm] & 255u) != 0u;
  if (hasP && hasM) { return (volt[jp] - volt[jm]) * (0.5 * E.invH); }
  if (hasP) { return (volt[jp] - u0) * E.invH; }
  if (hasM) { return (u0 - volt[jm]) * E.invH; }
  return 0.0;
}

// Adds up each of the ${N} columns of scratch (column e holds ${WG} values) and leaves the result in
// scratch[e * ${WG}]. Every thread of the workgroup must call it, so the barriers are reached uniformly.
fn reduceColumns(lid: u32) {
  for (var s = ${WG / 2}u; s > 0u; s = s >> 1u) {
    if (lid < s) {
      for (var e = 0u; e < ${N}u; e = e + 1u) {
        scratch[e * ${WG}u + lid] = scratch[e * ${WG}u + lid] + scratch[e * ${WG}u + lid + s];
      }
    }
    workgroupBarrier();
  }
}

@compute @workgroup_size(${WG})
fn contribute(@builtin(global_invocation_id) gid: vec3<u32>,
              @builtin(local_invocation_id) lid3: vec3<u32>,
              @builtin(workgroup_id) wid: vec3<u32>) {
  let lid = lid3.x;
  var acc: array<f32, ${N}>;
  for (var e = 0u; e < ${N}u; e = e + 1u) { acc[e] = 0.0; }

  // Threads past the end still take part in the reduction below, with zeros.
  if (gid.x < E.count) {
    let idx = muscle[gid.x];
    let i = i32(idx);
    let sx = i32(E.sx);
    let sxy = i32(E.sx * E.sy);
    let u0 = volt[idx];
    let g = vec3<f32>(diffAlong(i, 1, u0), diffAlong(i, sx, u0), diffAlong(i, sxy, u0));
    let f = fibreOf(cells[idx]);
    // q = D grad(u), with D = dPerp I + (dPar - dPerp) f f^T
    let q = E.dPerp * g + (E.dPar - E.dPerp) * dot(f, g) * f;
    // The voxel centre in mm: the padded index minus the one voxel of padding, times the voxel size.
    let px = f32(idx % E.sx) - 1.0;
    let py = f32((idx / E.sx) % E.sy) - 1.0;
    let pz = f32(idx / (E.sx * E.sy)) - 1.0;
    let xp = vec3<f32>(px, py, pz) * E.voxelMm;
    for (var e = 0u; e < ${N}u; e = e + 1u) {
      let r = E.pos[e].xyz - xp;
      let d2 = max(dot(r, r), 1.0e-6);
      acc[e] = -dot(q, r) / (d2 * sqrt(d2));
    }
  }

  for (var e = 0u; e < ${N}u; e = e + 1u) { scratch[e * ${WG}u + lid] = acc[e]; }
  workgroupBarrier();
  reduceColumns(lid);
  if (lid < ${N}u) { sums[wid.x * ${N}u + lid] = scratch[lid * ${WG}u]; }
}

@compute @workgroup_size(${WG})
fn finish(@builtin(local_invocation_id) lid3: vec3<u32>) {
  let lid = lid3.x;
  var acc: array<f32, ${N}>;
  for (var e = 0u; e < ${N}u; e = e + 1u) { acc[e] = 0.0; }
  for (var w = lid; w < E.groups; w = w + ${WG}u) {
    for (var e = 0u; e < ${N}u; e = e + 1u) { acc[e] = acc[e] + sums[w * ${N}u + e]; }
  }
  for (var e = 0u; e < ${N}u; e = e + 1u) { scratch[e * ${WG}u + lid] = acc[e]; }
  workgroupBarrier();
  reduceColumns(lid);
  if (lid < ${N}u) { total[E.slot * ${N}u + lid] = scratch[lid * ${WG}u]; }
}
`;
