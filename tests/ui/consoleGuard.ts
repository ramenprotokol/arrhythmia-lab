import { expect, type Page } from "@playwright/test";

// Every UI spec uses this so that any browser console error or uncaught page error fails the test.
export function consoleGuard() {
  const errors: string[] = [];
  return {
    attach(page: Page): void {
      errors.length = 0;
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
      });
    },
    check(): void {
      expect(errors).toEqual([]);
    },
  };
}
