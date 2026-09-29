import { defineConfig } from "@playwright/test";

// Several people can work in this folder at once, each with their own dev server: LAB_PORT picks the port.
const PORT = process.env.LAB_PORT ?? "5199";

// GPU tests run in real Chromium with WebGPU switched on.
export default defineConfig({
  testDir: "tests",
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  // One at a time: the GPU tests share one graphics card and some of them measure speed.
  fullyParallel: false,
  workers: 1,
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/tests/gpu/harness.html`,
    reuseExistingServer: true,
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: "chrome",
    launchOptions: {
      args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=metal", "--ignore-gpu-blocklist"],
    },
  },
});
