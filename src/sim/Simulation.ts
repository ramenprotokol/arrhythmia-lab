import type { HeartGrid } from "../data/loadHeart";
import { ENDO, EPI, MID, type Params } from "../model/params";
import { packParams, PARAMS_BYTES } from "./paramPack";
import { heartWgsl } from "./heartKernel";
import { BASE_D_PAR, BASE_D_PERP } from "./tissue";

export interface SimOptions {
  /** Time step, ms. */
  dt?: number;
  /** Diffusion along and across the fibre at conduction = 1, mm^2 per ms. */
  dPar?: number;
  dPerp?: number;
  /** False switches the cell model off, leaving pure diffusion. For tests. */
  reaction?: boolean;
}

/** Default stimulus: 2 u/ms for 2 ms, strong enough to capture resting tissue. */
const STIM_AMP = 2;
const STIM_MS = 2;
/** Explicit Euler is stable for the cell model up to about 0.2 ms; stay well inside. */
const MAX_REACTION_DT = 0.1;

// The 3D heart on the GPU. The grid is stored dense, padded by one empty voxel on every side, and only
// the muscle voxels are visited. u lives in two ping-pong buffers; the gating variables (v, w, s) are
// updated in place because only their own voxel ever reads them.
/**
 * The sweep time of a voxel the sweep never reaches. A large finite number, not Infinity: the shader language only loosely
 * defines comparisons with infinity, and some graphics cards treat it differently.
 */
export const SWEEP_NEVER = 1e30;

export class Simulation {
  /** Padded dimensions. Voxel (x, y, z) of the original grid is at padded (x+1, y+1, z+1). */
  readonly layout: { nx: number; ny: number; nz: number; sx: number; sy: number; sz: number; voxelMm: number };
  readonly count: number;
  private readonly dt: number;
  private readonly dPar: number;
  private readonly dPerp: number;
  private readonly reaction: boolean;
  private conduction = 1;
  private recovery = 1;

  private readonly device: GPUDevice;
  private readonly bufU: [GPUBuffer, GPUBuffer];
  private readonly bufGates: GPUBuffer;
  private readonly bufParams: GPUBuffer;
  private readonly bufSim: GPUBuffer;
  private readonly bufApply: GPUBuffer;
  private readonly stepPipeline: GPUComputePipeline;
  private readonly applyPipeline: GPUComputePipeline;
  private readonly stepBinds: [GPUBindGroup, GPUBindGroup];
  private readonly applyBinds: [GPUBindGroup, GPUBindGroup];
  private readonly bufSweep: GPUBuffer;
  private readonly countPipeline: GPUComputePipeline;
  private readonly countBinds: [GPUBindGroup, GPUBindGroup];
  private readonly bufCounter: GPUBuffer;
  private current = 0;
  private readonly groups: number;
  private readonly paddedCells: number;
  private readonly shaderReady: Promise<void>;

  /**
   * Build a simulation and wait until its shader has compiled. A shader that fails to compile does
   * not throw by itself, it just makes every dispatch do nothing, so always build through this.
   */
  static async create(device: GPUDevice, grid: HeartGrid, opts: SimOptions = {}): Promise<Simulation> {
    const sim = new Simulation(device, grid, opts);
    await sim.shaderReady;
    return sim;
  }

  private constructor(device: GPUDevice, grid: HeartGrid, opts: SimOptions = {}) {
    this.device = device;
    this.dt = opts.dt ?? 0.05;
    this.dPar = opts.dPar ?? BASE_D_PAR;
    this.dPerp = opts.dPerp ?? BASE_D_PERP;
    this.reaction = opts.reaction ?? true;
    if (this.reaction && this.dt > MAX_REACTION_DT) {
      throw new Error(`time step ${this.dt} ms is too large for the cell model (limit ${MAX_REACTION_DT} ms)`);
    }

    const { nx, ny, nz, voxelMm } = grid;
    const sx = nx + 2, sy = ny + 2, sz = nz + 2;
    this.layout = { nx, ny, nz, sx, sy, sz, voxelMm };
    this.checkStability(this.dPar * this.conduction);
    this.paddedCells = sx * sy * sz;

    // Pack tissue and fibre into one word per voxel, and list the muscle voxels.
    const cells = new Uint32Array(this.paddedCells);
    const activeList: number[] = [];
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const i = x + nx * (y + ny * z);
          const t = grid.tissue[i];
          if (t === 0) continue;
          const p = x + 1 + sx * (y + 1 + sy * (z + 1));
          cells[p] =
            (t & 255) |
            ((grid.fibre[3 * i] & 255) << 8) |
            ((grid.fibre[3 * i + 1] & 255) << 16) |
            ((grid.fibre[3 * i + 2] & 255) << 24);
          activeList.push(p);
        }
    const active = Uint32Array.from(activeList);
    this.count = active.length;
    if (this.count === 0) throw new Error("the heart grid has no muscle voxels");
    this.groups = Math.ceil(this.count / 64);
    if (this.groups > 65535) throw new Error("too many muscle voxels for one dispatch");

    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const make = (data: ArrayBufferView<ArrayBuffer>, usage: number) => {
      const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage });
      device.queue.writeBuffer(b, 0, data);
      return b;
    };
    const bufCells = make(cells, storage);
    const bufActive = make(active, storage);
    // Until a conduction sweep is set, no voxel ever reaches its time.
    this.bufSweep = make(new Float32Array(this.count).fill(SWEEP_NEVER), storage);
    this.bufCellsRef = bufCells;
    this.bufMuscleRef = bufActive;
    const uUsage = storage | GPUBufferUsage.COPY_SRC;
    this.bufU = [
      device.createBuffer({ size: this.paddedCells * 4, usage: uUsage }),
      device.createBuffer({ size: this.paddedCells * 4, usage: uUsage }),
    ];
    const gates = new Float32Array(this.paddedCells * 4);
    for (const p of active) gates.set([1, 1, 0, 0], p * 4);
    this.bufGates = make(gates, uUsage);

    this.bufParams = device.createBuffer({ size: 3 * PARAMS_BYTES, usage: storage });
    this.writeParams();
    this.bufSim = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.writeSim();
    this.bufApply = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const module = device.createShaderModule({ code: heartWgsl });
    this.shaderReady = module.getCompilationInfo().then((info) => {
      const errors = info.messages.filter((m) => m.type === "error");
      if (errors.length > 0) {
        throw new Error("heart shader failed to compile: " + errors.map((m) => `line ${m.lineNum}: ${m.message}`).join("; "));
      }
    });
    this.stepPipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "step" } });
    this.applyPipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "apply" } });

    const stepBind = (i: 0 | 1) =>
      device.createBindGroup({
        layout: this.stepPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.bufParams } },
          { binding: 1, resource: { buffer: this.bufSim } },
          { binding: 2, resource: { buffer: bufCells } },
          { binding: 3, resource: { buffer: bufActive } },
          { binding: 4, resource: { buffer: this.bufU[i] } },
          { binding: 5, resource: { buffer: this.bufU[1 - i] } },
          { binding: 6, resource: { buffer: this.bufGates } },
        ],
      });
    this.stepBinds = [stepBind(0), stepBind(1)];
    const applyBind = (i: 0 | 1) =>
      device.createBindGroup({
        layout: this.applyPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 2, resource: { buffer: bufCells } },
          { binding: 3, resource: { buffer: bufActive } },
          { binding: 6, resource: { buffer: this.bufGates } },
          { binding: 7, resource: { buffer: this.bufApply } },
          { binding: 8, resource: { buffer: this.bufU[i] } },
          { binding: 10, resource: { buffer: this.bufSweep } },
        ],
      });
    this.applyBinds = [applyBind(0), applyBind(1)];

    this.countPipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "countExcited" } });
    this.bufCounter = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const countBind = (i: 0 | 1) =>
      device.createBindGroup({
        layout: this.countPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 1, resource: { buffer: this.bufSim } },
          { binding: 3, resource: { buffer: bufActive } },
          { binding: 4, resource: { buffer: this.bufU[i] } },
          { binding: 9, resource: { buffer: this.bufCounter } },
        ],
      });
    this.countBinds = [countBind(0), countBind(1)];
  }

  /** Explicit diffusion is stable while dt <= h^2 / (6 D), with D the largest coefficient. */
  private checkStability(dMax: number): void {
    const h = this.layout.voxelMm;
    const limit = (h * h) / (6 * dMax);
    if (this.dt > limit) {
      throw new Error(`time step ${this.dt} ms breaks the diffusion stability limit of ${limit.toFixed(3)} ms`);
    }
  }

  private writeParams(): void {
    const sets: Params[] = [ENDO, MID, EPI].map((p) => ({ ...p, tauWp: p.tauWp * this.recovery }));
    const data = new Float32Array((3 * PARAMS_BYTES) / 4);
    sets.forEach((p, i) => data.set(packParams(p), (i * PARAMS_BYTES) / 4));
    this.device.queue.writeBuffer(this.bufParams, 0, data);
  }

  private writeSim(): void {
    const { sx, sy, voxelMm } = this.layout;
    const buf = new ArrayBuffer(32);
    new Uint32Array(buf, 0, 4).set([sx, sy, this.count, this.reaction ? 1 : 0]);
    new Float32Array(buf, 16, 4).set([this.dt, 1 / voxelMm, this.dPar * this.conduction, this.dPerp * this.conduction]);
    this.device.queue.writeBuffer(this.bufSim, 0, buf);
  }

  /**
   * conduction scales both diffusion coefficients, recovery scales the slow gating time constant
   * tauWp (which sets how long the action potential lasts). Both 1 is normal tissue.
   */
  setTissue(t: { conduction?: number; recovery?: number }): void {
    const conduction = t.conduction ?? this.conduction;
    const recovery = t.recovery ?? this.recovery;
    if (!(conduction > 0) || !(recovery > 0)) throw new Error("conduction and recovery must be positive");
    this.checkStability(this.dPar * conduction);
    this.conduction = conduction;
    this.recovery = recovery;
    this.writeParams();
    this.writeSim();
  }

  /** Run ms of simulated time (a whole number of time steps). */
  step(ms: number): void {
    const steps = Math.round(ms / this.dt);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.stepPipeline);
    for (let s = 0; s < steps; s++) {
      pass.setBindGroup(0, this.stepBinds[this.current]);
      pass.dispatchWorkgroups(this.groups);
      this.current = 1 - this.current;
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  private writeApply(mode: 0 | 1 | 2 | 3, c: [number, number, number], radiusVoxels: number, add: number, p0 = 0, p1 = 0): void {
    const { sx, sy } = this.layout;
    const buf = new ArrayBuffer(48);
    new Uint32Array(buf, 0, 4).set([this.count, mode, sx, sy]);
    new Float32Array(buf, 16, 8).set([c[0] + 1, c[1] + 1, c[2] + 1, radiusVoxels * radiusVoxels, add, p0, p1, 0]);
    this.device.queue.writeBuffer(this.bufApply, 0, buf);
  }

  /**
   * Stimulate the muscle inside a ball centred on voxel (x, y, z) of the original grid with a current
   * pulse. The pulse advances the simulation by `ms`, because the tissue keeps evolving during it.
   * Voxels that are not muscle are never touched.
   */
  stimulate(voxel: [number, number, number], radiusMm: number, opts: { amp?: number; ms?: number } = {}): void {
    this.pulse(0, voxel, radiusMm, opts);
  }

  /**
   * Like stimulate, but only the inner wall (the endocardium, tissue label 1) inside the ball is stimulated. A ball as
   * wide as a ventricle switches its whole inner surface on together, and the wave then crosses the wall from the inside
   * out, as it does when the heart's conduction fibres deliver the beat.
   */
  stimulateInnerWall(voxel: [number, number, number], radiusMm: number, opts: { amp?: number; ms?: number } = {}): void {
    this.pulse(2, voxel, radiusMm, opts);
  }

  /**
   * Set when a conduction sweep switches each muscle voxel on: `times` holds one value per muscle voxel, in ms after the
   * sweep begins, in the order the grid's muscle voxels are listed (z, then y, then x, skipping empty voxels), and
   * SWEEP_NEVER for a voxel the sweep never reaches. See src/lab/conduction.ts.
   */
  setSweepTimes(times: Float32Array): void {
    if (times.length !== this.count) throw new RangeError(`expected ${this.count} sweep times, got ${times.length}`);
    this.device.queue.writeBuffer(this.bufSweep, 0, times as Float32Array<ArrayBuffer>);
  }

  /**
   * One slot of a conduction sweep: give the stimulus current to every voxel whose sweep time is in [fromMs, toMs), and
   * advance the simulation by `ms` (the length of the slot). Call it slot after slot to run the sweep.
   */
  stimulateSweep(fromMs: number, toMs: number, opts: { amp?: number; ms?: number } = {}): void {
    this.pulse(3, [0, 0, 0], 0, opts, fromMs, toMs);
  }

  private pulse(mode: 0 | 2 | 3, voxel: [number, number, number], radiusMm: number, opts: { amp?: number; ms?: number }, p0 = 0, p1 = 0): void {
    const amp = opts.amp ?? STIM_AMP;
    const ms = opts.ms ?? STIM_MS;
    this.writeApply(mode, voxel, radiusMm / this.layout.voxelMm, amp * this.dt, p0, p1);
    const count = Math.ceil(ms / this.dt);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    for (let s = 0; s < count; s++) {
      pass.setPipeline(this.applyPipeline);
      pass.setBindGroup(0, this.applyBinds[this.current]);
      pass.dispatchWorkgroups(this.groups);
      pass.setPipeline(this.stepPipeline);
      pass.setBindGroup(0, this.stepBinds[this.current]);
      pass.dispatchWorkgroups(this.groups);
      this.current = 1 - this.current;
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Every muscle voxel back to rest, as a defibrillation shock does. */
  shock(): void {
    this.writeApply(1, [0, 0, 0], 0, 0);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.applyPipeline);
    pass.setBindGroup(0, this.applyBinds[this.current]);
    pass.dispatchWorkgroups(this.groups);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Set the voltage of every voxel from an array in the original (unpadded) layout. */
  writeVoltage(u: Float32Array): void {
    const { nx, ny, nz, sx, sy } = this.layout;
    const padded = new Float32Array(this.paddedCells);
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) padded[x + 1 + sx * (y + 1 + sy * (z + 1))] = u[x + nx * (y + ny * z)];
    this.device.queue.writeBuffer(this.bufU[this.current], 0, padded);
  }

  /**
   * The current voltage, one f32 per padded voxel (layout gives the strides). The buffer that holds the
   * current voltage changes as the simulation steps, so ask for it again after every step().
   */
  voltageBuffer(): GPUBuffer {
    return this.bufU[this.current];
  }

  private async readBuffer(buf: GPUBuffer, bytes: number): Promise<ArrayBuffer> {
    const staging = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(buf, 0, staging, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = staging.getMappedRange().slice(0);
    staging.destroy();
    return out;
  }

  /**
   * The fraction of muscle voxels that are excited (voltage above 0.5), counted on the GPU so the
   * whole volume never has to be read back. Only 4 bytes cross to the CPU.
   */
  async excitedFraction(): Promise<number> {
    this.device.queue.writeBuffer(this.bufCounter, 0, new Uint32Array([0, 0, 0, 0]));
    const staging = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.countPipeline);
    pass.setBindGroup(0, this.countBinds[this.current]);
    pass.dispatchWorkgroups(this.groups);
    pass.end();
    enc.copyBufferToBuffer(this.bufCounter, 0, staging, 0, 16);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const n = new Uint32Array(staging.getMappedRange().slice(0))[0];
    staging.destroy();
    return n / this.count;
  }

  /** Voltage per voxel in the original (unpadded) layout. */
  async readU(): Promise<Float32Array> {
    const { nx, ny, nz, sx, sy } = this.layout;
    const padded = new Float32Array(await this.readBuffer(this.bufU[this.current], this.paddedCells * 4));
    const out = new Float32Array(nx * ny * nz);
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) out[x + nx * (y + ny * z)] = padded[x + 1 + sx * (y + 1 + sy * (z + 1))];
    return out;
  }

  /** The three gating variables (v, w, s) per voxel, interleaved, in the original layout. */
  async readGates(): Promise<Float32Array> {
    const { nx, ny, nz, sx, sy } = this.layout;
    const padded = new Float32Array(await this.readBuffer(this.bufGates, this.paddedCells * 16));
    const out = new Float32Array(nx * ny * nz * 3);
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const p = x + 1 + sx * (y + 1 + sy * (z + 1));
          const i = x + nx * (y + ny * z);
          out[3 * i] = padded[4 * p];
          out[3 * i + 1] = padded[4 * p + 1];
          out[3 * i + 2] = padded[4 * p + 2];
        }
    return out;
  }

  // ---- read-only accessors for src/ecg: the ECG kernel reads the same buffers the solver uses -----------
  private readonly bufCellsRef: GPUBuffer;
  private readonly bufMuscleRef: GPUBuffer;

  /** Tissue and fibre, one u32 per padded voxel: tissue | fx << 8 | fy << 16 | fz << 24 (fibre int8, scaled by 127). */
  cellsBuffer(): GPUBuffer {
    return this.bufCellsRef;
  }

  /** Padded linear index of every muscle voxel, muscleCount() entries. */
  muscleBuffer(): GPUBuffer {
    return this.bufMuscleRef;
  }

  muscleCount(): number {
    return this.count;
  }

  /** The diffusion coefficients in force now, mm^2 per ms, already multiplied by the conduction setting. */
  diffusion(): { dPar: number; dPerp: number } {
    return { dPar: this.dPar * this.conduction, dPerp: this.dPerp * this.conduction };
  }
}
