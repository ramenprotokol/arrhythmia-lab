// Copies the solver's voltage buffer into a 3D rgba16float texture every frame so the shaders can
// sample it with trilinear filtering (r32float cannot be filtered). Two textures ping-pong: this
// frame's is written from the buffer and the previous frame's, so the change since the last frame is
// known. That change, scaled and clamped, is the "trend" that tells a rising front from a falling tail.
//
// Output texel: r = u, g = trend, b = tissue class / 3, a = smoothed tissue density.
// Also counts the excited voxels into stats[0], which the render passes use to light the room.
// Voxels outside the muscle take the mean of their muscle neighbours' voltage (one voxel of
// extension), so trilinear sampling right at the tissue surface never blends the wave with rest.
export const voltageWgsl = /* wgsl */ `
struct Dims { sx: u32, sy: u32, sz: u32, trendGain: f32 };

@group(0) @binding(0) var<uniform> D: Dims;
@group(0) @binding(1) var<storage, read> volt: array<f32>;
@group(0) @binding(2) var prevField: texture_3d<f32>;
@group(0) @binding(3) var tissue: texture_3d<u32>;
@group(0) @binding(4) var dens: texture_3d<f32>;
@group(0) @binding(5) var outField: texture_storage_3d<rgba16float, write>;
@group(0) @binding(6) var<storage, read_write> stats: array<atomic<u32>>;

fn isMuscle(p: vec3<i32>) -> bool {
  if (p.x < 0 || p.y < 0 || p.z < 0 || p.x >= i32(D.sx) || p.y >= i32(D.sy) || p.z >= i32(D.sz)) { return false; }
  return textureLoad(tissue, p, 0).r != 0u;
}

fn voltAt(p: vec3<i32>) -> f32 {
  return volt[u32(p.x) + D.sx * (u32(p.y) + D.sy * u32(p.z))];
}

// How many muscle voxels are excited (u above 0.7) this frame: counted per workgroup first, so the
// single global counter is touched once per workgroup rather than once per voxel.
var<workgroup> partial: atomic<u32>;

@compute @workgroup_size(8, 4, 2)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  if (li == 0u) { atomicStore(&partial, 0u); }
  workgroupBarrier();

  if (gid.x < D.sx && gid.y < D.sy && gid.z < D.sz) {
    let p = vec3<i32>(gid);
    let cls = textureLoad(tissue, p, 0).r;

    var u = 0.0;
    if (cls != 0u) {
      u = voltAt(p);
      if (u > 0.7) { atomicAdd(&partial, 1u); }
    } else {
      var sum = 0.0;
      var count = 0.0;
      for (var a = 0; a < 6; a = a + 1) {
        var q = p;
        let s = select(-1, 1, (a & 1) == 0);
        if (a < 2) { q.x = q.x + s; } else if (a < 4) { q.y = q.y + s; } else { q.z = q.z + s; }
        if (isMuscle(q)) {
          sum = sum + voltAt(q);
          count = count + 1.0;
        }
      }
      if (count > 0.0) { u = sum / count; }
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

    let layer = f32(cls) / 3.0;
    textureStore(outField, p, vec4<f32>(u, trend, layer, textureLoad(dens, p, 0).r));
  }

  workgroupBarrier();
  if (li == 0u) {
    let c = atomicLoad(&partial);
    if (c > 0u) { atomicAdd(&stats[0], c); }
  }
}
`;
