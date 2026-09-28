import { test, expect } from "@playwright/test";

// Proves a real WebGPU compute shader runs in headless Chromium and can be read back.
test("compute shader writes 1..64 and reads back", async ({ page }) => {
  // navigator.gpu only exists in a secure context, so serve a blank page from an https origin.
  await page.route("https://gpu.test/", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>t</title>" }));
  await page.goto("https://gpu.test/");
  const out = await page.evaluate(async () => {
    if (!navigator.gpu) return { error: "navigator.gpu missing" };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { error: "no adapter" };
    const device = await adapter.requestDevice();
    const n = 64;
    const buf = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const read = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const module = device.createShaderModule({
      code: `@group(0) @binding(0) var<storage, read_write> o: array<u32>;
             @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) { o[id.x] = id.x + 1u; }`,
    });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(buf, 0, read, 0, n * 4);
    device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    return { values: Array.from(new Uint32Array(read.getMappedRange())), info: adapter.info?.description ?? "adapter" };
  });
  expect(out).not.toHaveProperty("error");
  expect((out as { values: number[] }).values).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
});
