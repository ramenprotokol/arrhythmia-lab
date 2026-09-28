import { defineConfig } from "vitest/config";

export default defineConfig({
  // Several people edit files while browser tests run. Never push a live reload into an open test page;
  // a fresh page load still picks up the newest code.
  server: { hmr: false },
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/gpu/**", "node_modules/**"] },
});
