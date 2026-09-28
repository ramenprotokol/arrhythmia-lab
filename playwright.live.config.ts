import { defineConfig } from "@playwright/test";

// The page tests, run against a deployed site instead of the local dev server:
//   LIVE_URL=https://arrhythmia-lab.pages.dev npx playwright test -c playwright.live.config.ts
// The deployed site has the real security headers (a strict content policy), which the dev server does not.
export default defineConfig({
  testDir: "tests/app",
  testMatch: /.*\.spec\.ts/,
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.LIVE_URL ?? "https://arrhythmia-lab.pages.dev",
    channel: "chrome",
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal", "--ignore-gpu-blocklist"],
    },
  },
});
