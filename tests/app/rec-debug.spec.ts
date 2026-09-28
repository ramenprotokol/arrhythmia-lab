import { test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import "./labHandle";
test("rec debug", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/?debug&quality=high");
  await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, undefined, { timeout: 90_000 });
  await page.evaluate(() => window.__lab.setSpeed(1));
  await page.waitForTimeout(2500);
  const r = await page.evaluate(async () => {
    const lab = window.__lab as unknown as { composite: { canvas: HTMLCanvasElement; draw(): void }; renderer: { frame(): void } };
    lab.renderer.frame();
    lab.composite.draw();
    const stage = document.getElementById("stage") as HTMLElement;
    const heart = document.getElementById("heart") as HTMLCanvasElement;
    return { dataUrl: lab.composite.canvas.toDataURL("image/png"), stage: JSON.stringify(stage.getBoundingClientRect()), heart: [heart.width, heart.height] };
  });
  console.log("RECDBG " + r.stage + " heart " + r.heart);
  writeFileSync(process.env.REC_PNG ?? "/tmp/rec.png", Buffer.from(r.dataUrl.split(",")[1], "base64"));
});
