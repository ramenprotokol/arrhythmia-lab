import { defineConfig } from "@playwright/test";

// GPU tests run in real Chromium with WebGPU switched on.
export default defineConfig({
  testDir: "tests",
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  webServer: {
    command: "npx vite --port 5199 --strictPort",
    url: "http://localhost:5199/tests/gpu/harness.html",
    reuseExistingServer: true,
  },
  use: {
    baseURL: "http://localhost:5199",
    channel: "chrome",
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal", "--ignore-gpu-blocklist"],
    },
  },
});
