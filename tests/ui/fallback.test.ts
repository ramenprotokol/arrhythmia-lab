// The page a visitor gets when the lab does not run. The WebGPU explanation is for a browser that has no WebGPU; every other
// failure (a file that would not load, a shader the graphics card refused) says the lab could not start, in plain words,
// and does not blame the browser. tests/app/startup.spec.ts checks this in the real page.
import { describe, expect, it } from "vitest";
import { NoWebGpuError, showFallback, showStartupFailure } from "../../src/fallback";
import { UI_TEXT, fill } from "../../src/ui/text";

/** Just enough of a page element for its words to be read back: the fallback writes its markup and looks in it for a clip. */
const page = () => {
  const root = { innerHTML: "", querySelector: () => null };
  return { root: root as unknown as HTMLElement, html: () => root.innerHTML };
};

const NO_WEBGPU_TITLE = "Arrhythmia Lab needs WebGPU";
const NO_WEBGPU_CLAIM = "does not offer WebGPU";

describe("the page for a browser without WebGPU", () => {
  it("explains that the browser does not offer WebGPU, and where the lab does run", () => {
    const { root, html } = page();
    showFallback(root);
    expect(html()).toContain(NO_WEBGPU_TITLE);
    expect(html()).toContain(NO_WEBGPU_CLAIM);
    expect(html()).toContain("Chrome, Edge, Safari 26");
    expect(html()).not.toContain(UI_TEXT.startFailedTitle);
  });

  it("is also what a graphics card that gives no adapter gets, with that as its reason", () => {
    const { root, html } = page();
    showStartupFailure(root, new NoWebGpuError());
    expect(html()).toContain(NO_WEBGPU_TITLE);
    expect(html()).toContain("(no graphics adapter)");
    expect(html()).not.toContain(UI_TEXT.startFailedTitle);
  });
});

describe("the page for a lab that could not start", () => {
  const failures: [string, unknown, string][] = [
    ["a data file that would not load", new Error("could not load https://example.test/data/heart.bin: 404"), "could not load https://example.test/data/heart.bin: 404"],
    ["a shader the graphics card refused", new Error("Shader module compilation failed"), "Shader module compilation failed"],
    ["a device that could not be made", new DOMException("Failed to create the device", "OperationError"), "Failed to create the device"],
    ["something thrown that is not an Error", "the heart is missing", "the heart is missing"],
  ];

  for (const [name, err, reason] of failures) {
    it(`says so for ${name}, gives the reason, and does not say the browser lacks WebGPU`, () => {
      const { root, html } = page();
      showStartupFailure(root, err);
      expect(html()).toContain(UI_TEXT.startFailedTitle);
      expect(html()).toContain(UI_TEXT.startFailed);
      expect(html()).toContain(fill(UI_TEXT.startFailedReason, { reason }));
      expect(html()).not.toContain(NO_WEBGPU_TITLE);
      expect(html()).not.toContain(NO_WEBGPU_CLAIM);
    });
  }

  it("writes a reason as text, never as markup", () => {
    const { root, html } = page();
    showStartupFailure(root, new Error('<img src=x onerror="alert(1)">'));
    expect(html()).not.toContain("<img");
    expect(html()).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("keeps a long reason to a few lines (the console has all of it)", () => {
    const { root, html } = page();
    showStartupFailure(root, new Error("x".repeat(5000)));
    expect(html().length).toBeLessThan(1500);
    expect(html()).toContain("…");
  });

  it("keeps its words in the same place as the page's other words, in plain English", () => {
    expect(UI_TEXT.startFailedTitle).toBe("Arrhythmia Lab could not start");
    expect(UI_TEXT.startFailed).toMatch(/Reload the page/);
    expect(UI_TEXT.startFailedReason).toContain("{reason}");
  });
});
