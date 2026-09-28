// A browser without WebGPU gets an explanation and the recorded clip, not a blank page or an error.
import { test, expect } from "@playwright/test";
import { consoleGuard } from "../ui/consoleGuard";

const guard = consoleGuard();
test.beforeEach(async ({ page }) => {
  guard.attach(page);
  // Pretend this browser has no WebGPU.
  await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { get: () => undefined }));
});
test.afterEach(() => guard.check());

test("without WebGPU the page explains why and plays the recorded clip", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Arrhythmia Lab needs WebGPU" })).toBeVisible();
  await expect(page.getByText("Educational simulation. Not a medical device.")).toBeVisible();
  await expect(page.getByText(/Chrome, Edge, Safari 26/)).toBeVisible();
  const clip = page.locator("#fallback-clip");
  await expect(clip).toBeVisible({ timeout: 15_000 }); // shown once the browser has loaded the clip's metadata
  const info = await clip.evaluate((v: HTMLVideoElement) => ({ duration: v.duration, w: v.videoWidth, h: v.videoHeight }));
  expect(info.duration).toBeGreaterThan(10);
  expect(info.w).toBeGreaterThan(600);
});
