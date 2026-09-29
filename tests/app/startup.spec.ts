// What a visitor gets when the lab does not start the ordinary way, in real Chrome with the real GPU: a page that says what
// really went wrong (only a missing WebGPU is blamed on the browser), the graphics device let go after a failed start, the
// atria and vessels that will not load as a warning, and a clip length in the address that cannot break the page.
import { test, expect } from "@playwright/test";
import { UI_TEXT } from "../../src/ui/text";
import { consoleGuard } from "../ui/consoleGuard";
import { start } from "./page";
import "./labHandle";

const NO_WEBGPU = "Arrhythmia Lab needs WebGPU";

type Ends = { __deviceEnds: string[] };

test("a data file that will not load says the lab could not start, and does not blame WebGPU", async ({ page }) => {
  const uncaught: string[] = [];
  page.on("pageerror", (e) => uncaught.push(e.message));
  await page.route("**/data/heart.bin*", (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: UI_TEXT.startFailedTitle })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(UI_TEXT.startFailed)).toBeVisible();
  await expect(page.getByText(/What went wrong: could not load .*heart\.bin.*: 404/)).toBeVisible();
  await expect(page.getByText(NO_WEBGPU)).toHaveCount(0);
  await expect(page.getByText("does not offer WebGPU")).toHaveCount(0);
  expect(uncaught).toEqual([]);
});

test("a graphics card that gives no adapter still gets the WebGPU explanation", async ({ page }) => {
  // the first look (is there WebGPU at all?) finds an adapter; the lab's own request, a moment later, does not
  await page.addInitScript(() => {
    const real = navigator.gpu.requestAdapter.bind(navigator.gpu);
    let calls = 0;
    navigator.gpu.requestAdapter = (options) => (++calls === 1 ? real(options) : Promise.resolve(null));
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: NO_WEBGPU })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("(no graphics adapter)")).toBeVisible();
  await expect(page.getByText(UI_TEXT.startFailedTitle)).toHaveCount(0);
});

test("a start that fails lets the graphics device go", async ({ page }) => {
  await page.addInitScript(() => {
    const ends: string[] = ((window as unknown as Ends).__deviceEnds = []);
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (this: GPUAdapter, descriptor?: GPUDeviceDescriptor) {
      const device = await request.call(this, descriptor);
      void device.lost.then((info) => ends.push(info.reason));
      return device;
    };
  });
  await page.route("**/data/heart.bin*", (route) => route.fulfill({ status: 404, body: "not found" }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: UI_TEXT.startFailedTitle })).toBeVisible({ timeout: 60_000 });
  // "destroyed" is the device let go on purpose; a device left alone never reports an end
  await expect.poll(() => page.evaluate(() => (window as unknown as Ends).__deviceEnds), { timeout: 10_000 }).toEqual(["destroyed"]);
  // and that is not shown to the visitor as a fault
  await expect(page.getByText("The graphics card stopped responding")).toHaveCount(0);
});

test("atria and vessels that will not load are logged as a warning, and the lab starts with the ventricles alone", async ({ page }) => {
  test.setTimeout(120_000);
  const warnings: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "warning") warnings.push(m.text());
  });
  await page.route("**/data/heart-anatomy.bin*", (route) => route.fulfill({ status: 404, body: "not found" }));
  await start(page);
  expect(warnings.some((w) => /atria and vessels could not be loaded/.test(w))).toBe(true);
  // the lab is running: the heart beats by itself, and the graphics card reported no error drawing it
  await page.waitForFunction(() => window.__lab.engine.lastBeatAt > 0, undefined, { timeout: 30_000 });
  expect(await page.evaluate(() => window.__labErrors ?? [])).toEqual([]);
});

test("an impossible ?clipSeconds= does not stop the lab starting, and still gives a clip", async ({ page }) => {
  test.setTimeout(120_000);
  const guard = consoleGuard();
  guard.attach(page);
  await start(page, "debug&quality=low&clipSeconds=-1"); // used to end on the "needs WebGPU" page
  await page.waitForFunction(() => window.__lab.engine.simTime > 500, undefined, { timeout: 30_000 });
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20_000 }), page.getByRole("button", { name: "Record clip" }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.webm$/); // the limit (one second) stopped it, and the clip was saved
  await expect(page.getByRole("button", { name: "Record clip" })).toHaveAttribute("aria-pressed", "false");
  guard.check();
});
