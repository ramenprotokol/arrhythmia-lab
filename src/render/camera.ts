// Orbit camera: y is up, the camera circles a target point. All matrices are
// column-major Float32Array(16), and the projection uses WebGPU's 0..1 depth range.

export type Vec3 = [number, number, number];

export interface OrbitOptions {
  target?: Vec3;
  distance?: number;
  minDistance?: number;
  maxDistance?: number;
  fovY?: number; // radians
  near?: number;
  far?: number;
}

const PITCH_LIMIT = Math.PI / 2 - 0.02;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export class OrbitCamera {
  target: Vec3;
  distance: number;
  minDistance: number;
  maxDistance: number;
  fovY: number;
  near: number;
  far: number;
  yaw = 0.6;
  pitch = 0.25;
  aspect = 1;

  constructor(opts: OrbitOptions = {}) {
    this.target = opts.target ?? [0, 0, 0];
    this.minDistance = opts.minDistance ?? 60;
    this.maxDistance = opts.maxDistance ?? 600;
    this.distance = Math.min(this.maxDistance, Math.max(this.minDistance, opts.distance ?? 250));
    this.fovY = opts.fovY ?? (35 * Math.PI) / 180;
    this.near = opts.near ?? 1;
    this.far = opts.far ?? 2000;
  }

  /** Drag by (dx, dy) pixels. */
  orbit(dx: number, dy: number): void {
    this.yaw -= dx * 0.005;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dy * 0.005));
  }

  /** Wheel or pinch delta. Positive moves away, negative moves closer. */
  zoom(delta: number): void {
    this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance * Math.exp(delta * 0.001)));
  }

  position(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ];
  }

  private basis(): { eye: Vec3; f: Vec3; s: Vec3; u: Vec3 } {
    const eye = this.position();
    const f = normalize(sub(this.target, eye));
    const s = normalize(cross(f, [0, 1, 0]));
    const u = cross(s, f);
    return { eye, f, s, u };
  }

  viewMatrix(): Float32Array {
    const { eye, f, s, u } = this.basis();
    return new Float32Array([
      s[0], u[0], -f[0], 0,
      s[1], u[1], -f[1], 0,
      s[2], u[2], -f[2], 0,
      -dot(s, eye), -dot(u, eye), dot(f, eye), 1,
    ]);
  }

  projectionMatrix(): Float32Array {
    const f = 1 / Math.tan(this.fovY / 2);
    const { near, far } = this;
    return new Float32Array([
      f / this.aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, far / (near - far), -1,
      0, 0, (far * near) / (near - far), 0,
    ]);
  }

  viewProjection(): Float32Array {
    const a = this.projectionMatrix();
    const b = this.viewMatrix();
    const out = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
        out[col * 4 + row] = sum;
      }
    }
    return out;
  }

  /** World-space ray through a pixel of a width x height viewport. */
  rayFromPixel(px: number, py: number, width: number, height: number): { origin: Vec3; dir: Vec3 } {
    const { eye, f, s, u } = this.basis();
    const t = Math.tan(this.fovY / 2);
    const x = (2 * px) / width - 1;
    const y = 1 - (2 * py) / height;
    const aspect = width / height;
    const dir = normalize([
      s[0] * x * aspect * t + u[0] * y * t + f[0],
      s[1] * x * aspect * t + u[1] * y * t + f[1],
      s[2] * x * aspect * t + u[2] * y * t + f[2],
    ]);
    return { origin: eye, dir };
  }
}
