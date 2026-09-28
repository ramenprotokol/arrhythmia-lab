import { defineConfig } from "@playwright/test";

// GPU tests run in real Chromium with WebGPU switched on.
export default defineConfig({
  testDir: "tests/gpu",
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  use: {
    channel: "chrome",
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal", "--ignore-gpu-blocklist"],
    },
  },
});
