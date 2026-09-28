import { EPI, type Params } from "../model/params";
import { packParams, PARAMS_BYTES } from "./paramPack";
import { sheetWgsl } from "./sheetKernel";

export interface SheetOptions {
  /** Diffusion coefficient, mm^2 per ms. */
  D: number;
  /** Cell spacing, mm. */
  dx: number;
  /** Time step, ms. */
  dt: number;
  params?: Params;
}

// 2D sheet of cardiac tissue on the GPU. State per cell is (u, v, w, s), stored as vec4<f32>.
export class SheetSim {
  private readonly n: number;
  private readonly device: GPUDevice;
  private readonly cellBytes: number;
  private readonly bufs: [GPUBuffer, GPUBuffer];
  private readonly stepPipeline: GPUComputePipeline;
  private readonly applyPipeline: GPUComputePipeline;
  private readonly stepBinds: [GPUBindGroup, GPUBindGroup];
  private readonly applyBinds: [GPUBindGroup, GPUBindGroup];
  private readonly applyUniform: GPUBuffer;
  private current = 0;
  private readonly groups: number;

  constructor(device: GPUDevice, n: number, opts: SheetOptions) {
    const { D, dx, dt } = opts;
    const limit = (dx * dx) / (4 * D);
    if (dt > limit) {
      throw new Error(`time step ${dt} ms breaks the diffusion stability limit of ${limit.toFixed(4)} ms`);
    }
    this.device = device;
    this.n = n;
    this.groups = Math.ceil(n / 8);
    this.cellBytes = n * n * 16;

    const module = device.createShaderModule({ code: sheetWgsl });
    this.stepPipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "step" } });
    this.applyPipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "apply" } });

    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.bufs = [device.createBuffer({ size: this.cellBytes, usage }), device.createBuffer({ size: this.cellBytes, usage })];

    const params = device.createBuffer({ size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(params, 0, packParams(opts.params ?? EPI));

    const sim = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(16);
    new Uint32Array(simData, 0, 1)[0] = n;
    new Float32Array(simData, 4, 2).set([dt, D / (dx * dx)]);
    device.queue.writeBuffer(sim, 0, simData);

    const bind = (i: 0 | 1) =>
      device.createBindGroup({
        layout: this.stepPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: { buffer: sim } },
          { binding: 2, resource: { buffer: this.bufs[i] } },
          { binding: 3, resource: { buffer: this.bufs[1 - i] } },
        ],
      });
    this.stepBinds = [bind(0), bind(1)];

    this.applyUniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const applyBind = (i: 0 | 1) =>
      device.createBindGroup({
        layout: this.applyPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 4, resource: { buffer: this.applyUniform } },
          { binding: 5, resource: { buffer: this.bufs[i] } },
        ],
      });
    this.applyBinds = [applyBind(0), applyBind(1)];

    this.reset();
  }

  /** Every cell back to rest. */
  private reset(): void {
    const rest = new Float32Array(this.n * this.n * 4);
    for (let i = 0; i < this.n * this.n; i++) rest.set([0, 1, 1, 0], i * 4);
    this.device.queue.writeBuffer(this.bufs[0], 0, rest);
    this.current = 0;
  }

  /** Run `steps` time steps. Consecutive dispatches in one pass see each other's writes. */
  step(steps: number): void {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.stepPipeline);
    for (let s = 0; s < steps; s++) {
      pass.setBindGroup(0, this.stepBinds[this.current]);
      pass.dispatchWorkgroups(this.groups, this.groups);
      this.current = 1 - this.current;
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  private apply(mode: 0 | 1, cx: number, cy: number, r: number): void {
    const data = new ArrayBuffer(32);
    new Uint32Array(data, 0, 2).set([this.n, mode]);
    new Float32Array(data, 8, 3).set([cx, cy, r]);
    this.device.queue.writeBuffer(this.applyUniform, 0, data);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.applyPipeline);
    pass.setBindGroup(0, this.applyBinds[this.current]);
    pass.dispatchWorkgroups(this.groups, this.groups);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Push the voltage above threshold inside a disc, centred on cell (x, y), radius in cells. */
  stimulate(x: number, y: number, r: number): void {
    this.apply(0, x, y, r);
  }

  /** Reset every cell to rest, as a defibrillation shock does. */
  shock(): void {
    this.apply(1, 0, 0, 0);
  }

  /** All four state variables per cell, interleaved (u, v, w, s). */
  async readState(): Promise<Float32Array> {
    const staging = this.device.createBuffer({ size: this.cellBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.bufs[this.current], 0, staging, 0, this.cellBytes);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    staging.destroy();
    return out;
  }

  /** Voltage per cell. */
  async readU(): Promise<Float32Array> {
    const s = await this.readState();
    const u = new Float32Array(this.n * this.n);
    for (let i = 0; i < u.length; i++) u[i] = s[i * 4];
    return u;
  }
}
