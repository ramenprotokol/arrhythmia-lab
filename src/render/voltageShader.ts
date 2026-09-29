// Copies the solver's voltage into a 3D rgba16float texture every frame so the shaders can sample it with
// trilinear filtering (r32float cannot be filtered). Two textures ping-pong: this frame's is written from the
// buffer and the previous frame's, so the change since the last frame is known. That change, scaled and
// clamped, is the "trend" that tells a rising front from a falling tail.
//
// Output texel: r = u, g = trend, b = contraction, a = smoothed tissue density (static).
//
// Only the voxels that can change are visited: the muscle, and the empty voxels touching it (a list built once on
// the CPU). Every other texel keeps the value both textures were created with: no voltage, no contraction, and the
// density. An empty voxel next to the muscle takes the mean of its muscle neighbours' voltage (one voxel of
// extension), so trilinear sampling right at the tissue surface never blends the wave with rest.
//
// The contraction follows the voltage with a lag, the way muscle tension follows the action potential: it
// rises a little after the upstroke and relaxes as the tissue repolarises. It is a first-order low-pass in
// wall-clock time, faster on the way up than on the way down.
//
// Also counts, per frame: stats[0] the excited muscle voxels (u above 0.7), stats[1] the sum of the muscle's
// contraction in 1/1024ths, stats[2] the muscle voxels that were at rest last frame and are excited now. A second, tiny
// pass (settle) then keeps stats[3], which is not cleared between frames: the seconds since the whole heart fired at
// once (a shock: most of the muscle excited within one frame, which no beat does), as the bits of a float.
export const voltageWgsl = /* wgsl */ `
struct Dims { sx: u32, sy: u32, count: u32, trendGain: f32, rise: f32, fall: f32, dt: f32, muscle: u32 };

@group(0) @binding(0) var<uniform> D: Dims;
@group(0) @binding(1) var<storage, read> volt: array<f32>;
@group(0) @binding(2) var prevField: texture_3d<f32>;
@group(0) @binding(3) var<storage, read> cells: array<u32>;
@group(0) @binding(5) var outField: texture_storage_3d<rgba16float, write>;
@group(0) @binding(6) var<storage, read_write> stats: array<atomic<u32>>;

var<workgroup> excitedHere: atomic<u32>;
var<workgroup> tensionHere: atomic<u32>;
var<workgroup> freshHere: atomic<u32>;

// A list entry: the padded linear index in the low 24 bits, bit 24 set for muscle, and for an empty voxel bits
// 25-30 say which of its six neighbours (-x, +x, -y, +y, -z, +z) are muscle.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) {
    atomicStore(&excitedHere, 0u);
    atomicStore(&tensionHere, 0u);
    atomicStore(&freshHere, 0u);
  }
  workgroupBarrier();

  if (gid.x < D.count) {
    let e = cells[gid.x];
    let idx = e & 0xFFFFFFu;
    let muscle = (e & (1u << 24u)) != 0u;
    let sxy = D.sx * D.sy;
    let p = vec3<i32>(i32(idx % D.sx), i32((idx / D.sx) % D.sy), i32(idx / sxy));

    var u = 0.0;
    if (muscle) {
      u = volt[idx];
    } else {
      var sum = 0.0;
      var n = 0.0;
      var strides = array<u32, 3>(1u, D.sx, sxy);
      for (var a = 0u; a < 6u; a = a + 1u) {
        if ((e & (1u << (25u + a))) != 0u) {
          let s = strides[a / 2u];
          let q = select(idx + s, idx - s, (a & 1u) == 0u);
          sum = sum + volt[q];
          n = n + 1.0;
        }
      }
      if (n > 0.0) { u = sum / n; }
    }

    let prev = textureLoad(prevField, p, 0);
    // The texture keeps u in half precision, so compare with u as it will be stored: a voxel that has not
    // moved then shows no change at all, up to a rounding step (well under 0.0015).
    let stored = unpack2x16float(pack2x16float(vec2<f32>(u, 0.0))).x;
    let du = stored - prev.r;
    // No change means the solver did not step: keep the last trend instead of forgetting it.
    // Otherwise the trend follows the change, but fades over a few frames rather than dropping at once.
    var trend = prev.g;
    if (abs(du) > 0.0015) {
      // new evidence wins when it is stronger than the fading memory: a voxel that repolarised and is now
      // excited again shows a rising front at once
      let now = clamp(du * D.trendGain, -1.0, 1.0);
      let held = prev.g * 0.6;
      trend = select(held, now, abs(now) > abs(held));
    }

    let goal = smoothstep(0.18, 0.95, u);
    let k = select(D.fall, D.rise, goal > prev.b);
    let tension = clamp(prev.b + (goal - prev.b) * k, 0.0, 1.0);

    textureStore(outField, p, vec4<f32>(u, trend, tension, prev.a));
    if (muscle) {
      if (u > 0.7) {
        atomicAdd(&excitedHere, 1u);
        if (prev.r < 0.3) { atomicAdd(&freshHere, 1u); }
      }
      atomicAdd(&tensionHere, u32(tension * 1024.0 + 0.5));
    }
  }

  workgroupBarrier();
  if (li == 0u) {
    let c = atomicLoad(&excitedHere);
    if (c > 0u) { atomicAdd(&stats[0], c); }
    let t = atomicLoad(&tensionHere);
    if (t > 0u) { atomicAdd(&stats[1], t); }
    let f = atomicLoad(&freshHere);
    if (f > 0u) { atomicAdd(&stats[2], f); }
  }
}

// After the counts: a shock fired the whole heart this frame if most of the muscle was at rest a frame ago and is
// excited now (a beat, however fast, spreads over several frames).
@compute @workgroup_size(1)
fn settle() {
  var age = bitcast<f32>(atomicLoad(&stats[3]));
  if (f32(atomicLoad(&stats[2])) > 0.6 * f32(D.muscle)) {
    age = 0.0;
  } else {
    age = min(age + D.dt, 100.0);
  }
  atomicStore(&stats[3], bitcast<u32>(age));
}
`;
