import { defineConfig } from "vitest/config";

export default defineConfig({
  // The browser tests load pages from this dev server while files may be changing. Never push a live reload
  // into an open test page; a fresh page load still picks up the newest code.
  server: { hmr: false },
  // Some tests read the whole 1.5-million-cell heart grid; a slow machine (a hosted CI runner) needs more than 5 s.
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/gpu/**", "node_modules/**"], testTimeout: 30_000 },
});
