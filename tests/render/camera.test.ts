import { describe, it, expect } from "vitest";
import { OrbitCamera } from "../../src/render/camera";

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

describe("OrbitCamera", () => {
  it("clamps pitch so the camera never flips over the poles", () => {
    const c = new OrbitCamera();
    c.orbit(0, -100000);
    expect(c.pitch).toBeLessThan(Math.PI / 2);
    c.orbit(0, 100000);
    expect(c.pitch).toBeGreaterThan(-Math.PI / 2);
  });

  it("clamps zoom between the minimum and maximum distance", () => {
    const c = new OrbitCamera({ minDistance: 50, maxDistance: 400 });
    c.zoom(-1e6);
    expect(c.distance).toBe(50);
    c.zoom(1e6);
    expect(c.distance).toBe(400);
  });

  it("puts the camera the set distance from the target", () => {
    const c = new OrbitCamera({ target: [10, 20, 30], distance: 120 });
    const p = c.position();
    const d = Math.hypot(p[0] - 10, p[1] - 20, p[2] - 30);
    expect(near(d, 120)).toBe(true);
  });

  it("sends the centre-pixel ray from the camera through the target", () => {
    const c = new OrbitCamera({ target: [5, -3, 8], distance: 200 });
    c.orbit(0.4, 0.2);
    const ray = c.rayFromPixel(400, 300, 800, 600);
    const p = c.position();
    expect(near(ray.origin[0], p[0]) && near(ray.origin[1], p[1]) && near(ray.origin[2], p[2])).toBe(true);
    const t = 200;
    const hit = [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, ray.origin[2] + ray.dir[2] * t];
    expect(near(hit[0], 5, 1e-2) && near(hit[1], -3, 1e-2) && near(hit[2], 8, 1e-2)).toBe(true);
    expect(near(Math.hypot(...ray.dir), 1)).toBe(true);
  });

  it("projects the target to the middle of the screen with depth in 0..1", () => {
    const c = new OrbitCamera({ target: [0, 0, 0], distance: 150 });
    c.aspect = 16 / 9;
    const m = c.viewProjection();
    // column-major: clip = M * [0,0,0,1] is the last column
    const x = m[12], y = m[13], z = m[14], w = m[15];
    expect(near(x / w, 0)).toBe(true);
    expect(near(y / w, 0)).toBe(true);
    expect(z / w).toBeGreaterThan(0);
    expect(z / w).toBeLessThan(1);
  });

  it("keeps a ray's direction pointing away from the camera on the right side of the screen", () => {
    const c = new OrbitCamera({ target: [0, 0, 0], distance: 100 });
    const right = c.rayFromPixel(700, 300, 800, 600);
    const left = c.rayFromPixel(100, 300, 800, 600);
    // the two rays must diverge horizontally
    const dot = right.dir[0] * left.dir[0] + right.dir[1] * left.dir[1] + right.dir[2] * left.dir[2];
    expect(dot).toBeLessThan(1);
    expect(dot).toBeGreaterThan(0);
  });
});
