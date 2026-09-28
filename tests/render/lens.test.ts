import { describe, it, expect } from "vitest";
import { OrbitCamera, type Vec3 } from "../../src/render/camera";
import { fitDistanceToPoints, freeRect, gridViewProjection, lensShift, projectToCanvas, unshiftPixel } from "../../src/render/lens";
import { poseRotation, rotate } from "../../src/render/orient";

const W = 1440;
const H = 900;
const none = { top: 0, right: 0, bottom: 0, left: 0 };
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

describe("freeRect", () => {
  it("is the whole canvas without insets", () => {
    expect(freeRect(W, H, none)).toMatchObject({ x0: 0, y0: 0, x1: W, y1: H, cx: 720, cy: 450, w: W, h: H });
  });

  it("is the canvas minus the panels", () => {
    const r = freeRect(W, H, { top: 0, right: 404, bottom: 300, left: 0 });
    expect(r).toMatchObject({ x0: 0, y0: 0, x1: 1036, y1: 600, cx: 518, cy: 300, w: 1036, h: 600 });
  });

  it("ignores insets that would leave almost nothing, on that axis only", () => {
    const r = freeRect(W, H, { top: 0, right: 900, bottom: 100, left: 600 });
    expect(r.w).toBe(W); // 1500 px of panels on a 1440 px canvas: ignored
    expect(r.h).toBe(800); // the vertical inset is fine
    expect(freeRect(W, H, { top: -5, right: NaN, bottom: 0, left: 0 })).toMatchObject({ w: W, h: H }); // nonsense is no inset
  });
});

describe("lensShift", () => {
  it("is zero without insets", () => {
    expect(lensShift(W, H, none)).toEqual([0, 0]);
  });

  it("moves the picture toward the middle of the free rectangle: left for a right panel, up for a bottom panel", () => {
    const [sx, sy] = lensShift(W, H, { top: 0, right: 400, bottom: 0, left: 0 });
    expect(sx).toBeCloseTo((2 * (520 - 720)) / W, 6); // the free centre is 200 px left of the canvas centre
    expect(sx).toBeLessThan(0);
    expect(sy).toBeCloseTo(0, 6);
    const [, up] = lensShift(W, H, { top: 0, right: 0, bottom: 300, left: 0 });
    expect(up).toBeCloseTo((2 * 150) / H, 6);
    expect(up).toBeGreaterThan(0);
  });
});

describe("fitDistanceToPoints", () => {
  const fov = (32 * Math.PI) / 180;
  const tan = Math.tan(fov / 2);
  // points as (across, up, along the line of sight, positive away from the camera) from the target
  const fit = (pts: number[], w: number, h: number, insets = none, margin = 1) => fitDistanceToPoints(Float32Array.from(pts), fov, w / h, w, h, insets, margin);

  it("puts a point at the target plane where its height just fills half the height", () => {
    expect(fit([0, 80, 0], 1000, 1000) * tan).toBeCloseTo(80, 3);
    expect(fit([0, -80, 0], 1000, 1000) * tan).toBeCloseTo(80, 3);
  });

  it("is limited by the width on a narrow screen", () => {
    const d = fit([60, 10, 0], 400, 800);
    expect(d * tan * (400 / 800)).toBeCloseTo(60, 3);
  });

  it("backs away for a point nearer the camera, which looks bigger, and less for one farther away", () => {
    const flat = fit([0, 80, 0], 1000, 1000);
    const near = fit([0, 80, -50], 1000, 1000); // 50 mm toward the camera
    const far = fit([0, 80, 50], 1000, 1000);
    expect(near).toBeCloseTo(flat + 50, 3);
    expect(far).toBeCloseTo(flat - 50, 3);
  });

  it("is set by the worst point, and grows with the margin", () => {
    const pts = [0, 30, 0, 20, 10, -10, -70, 0, 20, 5, 75, 30];
    const d = fit(pts, 1000, 1000);
    expect(d).toBeGreaterThan(fit([0, 30, 0], 1000, 1000));
    expect(fit(pts, 1000, 1000, none, 1.2)).toBeGreaterThan(d);
  });

  it("backs away as panels take room, in proportion to the free size", () => {
    const whole = fit([0, 80, 0], 1440, 900);
    const dock = fit([0, 80, 0], 1440, 900, { top: 0, right: 0, bottom: 300, left: 0 });
    expect(dock / whole).toBeCloseTo(900 / 600, 3); // height limited: the free height is two thirds
    const side = fit([60, 10, 0], 1440, 900, { top: 0, right: 404, bottom: 0, left: 0 });
    expect(side).toBeCloseTo(fit([60, 10, 0], 1440, 900) * (1440 / 1036), 3); // width limited
  });
});

describe("projection with the pose, the camera and the lens shift", () => {
  // a heart posed by an arbitrary rotation, the camera on its centre
  const pose = poseRotation({ apex: [0.6, -0.5, 0.62], rv: [-0.5, 0.4, 0.77] }, (30 * Math.PI) / 180);
  const pivot: Vec3 = [61, 52, 57];
  const centre: Vec3 = [62.5, 53, 58.5];
  const camera = new OrbitCamera({ target: centre, distance: 300, fovY: (32 * Math.PI) / 180, near: 8, far: 1500 });
  camera.aspect = W / H;
  camera.yaw = 0.6;
  camera.pitch = 0.14;

  it("sends the camera target to the middle of the canvas when nothing is shifted", () => {
    const vp = gridViewProjection(camera, pose, pivot, centre, [0, 0]);
    const s = projectToCanvas(vp, pivot, W, H);
    expect(s.x).toBeCloseTo(W / 2, 2);
    expect(s.y).toBeCloseTo(H / 2, 2);
    expect(s.w).toBeGreaterThan(0);
  });

  it("sends the camera target to the middle of the FREE rectangle when panels take a side", () => {
    const insets = { top: 0, right: 400, bottom: 0, left: 0 };
    const vp = gridViewProjection(camera, pose, pivot, centre, lensShift(W, H, insets));
    const s = projectToCanvas(vp, pivot, W, H);
    expect(s.x).toBeCloseTo((W - 400) / 2, 2); // 520
    expect(s.y).toBeCloseTo(H / 2, 2);
    const both = { top: 0, right: 404, bottom: 300, left: 0 };
    const t = projectToCanvas(gridViewProjection(camera, pose, pivot, centre, lensShift(W, H, both)), pivot, W, H);
    expect(t.x).toBeCloseTo(518, 2);
    expect(t.y).toBeCloseTo(300, 2);
  });

  it("puts a point off to one side off centre, in the right direction", () => {
    const vp = gridViewProjection(camera, pose, pivot, centre, [0, 0]);
    // display-frame directions: right is +x at yaw 0; step the grid point by the inverse pose of screen right and up
    const inverse = (d: Vec3): Vec3 => [pose[0] * d[0] + pose[3] * d[1] + pose[6] * d[2], pose[1] * d[0] + pose[4] * d[1] + pose[7] * d[2], pose[2] * d[0] + pose[5] * d[1] + pose[8] * d[2]];
    const m = camera.viewMatrix();
    const right = inverse([m[0], m[4], m[8]]); // camera right, as a grid-frame direction
    const up = inverse([m[1], m[5], m[9]]);
    const at = (a: Vec3, k: number): Vec3 => [pivot[0] + a[0] * k, pivot[1] + a[1] * k, pivot[2] + a[2] * k];
    const r = projectToCanvas(vp, at(right, 60), W, H);
    const l = projectToCanvas(vp, at(right, -60), W, H);
    const u = projectToCanvas(vp, at(up, 60), W, H);
    expect(r.x).toBeGreaterThan(W / 2 + 20);
    expect(l.x).toBeLessThan(W / 2 - 20);
    expect(near(r.y, H / 2, 0.5)).toBe(true);
    expect(u.y).toBeLessThan(H / 2 - 20); // canvas y grows downward
    expect(near(u.x, W / 2, 0.5)).toBe(true);
  });

  it("reports a point behind the camera with a depth of zero or less", () => {
    const vp = gridViewProjection(camera, pose, pivot, centre, [0, 0]);
    const eye = camera.position();
    // the eye in the display frame, taken back to the grid frame, then a step further away from the target
    const back = (v: Vec3): Vec3 => {
      const d: Vec3 = [v[0] - centre[0], v[1] - centre[1], v[2] - centre[2]];
      const g: Vec3 = [pose[0] * d[0] + pose[3] * d[1] + pose[6] * d[2], pose[1] * d[0] + pose[4] * d[1] + pose[7] * d[2], pose[2] * d[0] + pose[5] * d[1] + pose[8] * d[2]];
      return [g[0] + pivot[0], g[1] + pivot[1], g[2] + pivot[2]];
    };
    const e = back(eye);
    const away: Vec3 = [e[0] + (e[0] - pivot[0]) * 0.5, e[1] + (e[1] - pivot[1]) * 0.5, e[2] + (e[2] - pivot[2]) * 0.5];
    expect(projectToCanvas(vp, away, W, H).w).toBeLessThanOrEqual(0);
    void rotate;
  });

  it("gives the same pixel back through unshiftPixel: the camera pixel a shifted pixel really shows", () => {
    const shift = lensShift(W, H, { top: 0, right: 404, bottom: 300, left: 0 });
    const plain = gridViewProjection(camera, pose, pivot, centre, [0, 0]);
    const shifted = gridViewProjection(camera, pose, pivot, centre, shift);
    for (const p of [pivot, [80, 40, 30], [30, 70, 90], [95, 20, 75]] as Vec3[]) {
      const a = projectToCanvas(plain, p, W, H);
      const b = projectToCanvas(shifted, p, W, H);
      const [ux, uy] = unshiftPixel(b.x, b.y, W, H, shift);
      expect(near(ux, a.x, 1e-2)).toBe(true);
      expect(near(uy, a.y, 1e-2)).toBe(true);
    }
  });
});
