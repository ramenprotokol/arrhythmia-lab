import type { Simulation } from "../sim/Simulation";
import { electrodePositions, ELECTRODE_NAMES, type ElectrodeName } from "./electrodes";
import type { HeartFrame, Vec3 } from "../data/heartFrame";
import { ecgWgsl, ECG_WORKGROUP } from "./ecgKernel";
import { leadsFromElectrodes } from "./leads";

/**
 * Millivolts per unit of the raw dipole sum, per mm^3 of muscle (the sum is multiplied by the voxel volume, so
 * the same number serves any grid resolution).
 *
 * THE ECG IS SIMULATED AND QUALITATIVE. This constant is not derived from tissue conductivities. It was chosen
 * so that pacing the real heart at the apex (radius 3 mm, the default tissue) gives a lead II about 1.5 mV peak to
 * peak over the whole beat, the size of a real limb lead: at gain 1 that peak to peak measured 0.017673, and
 * 1.5 / 0.017673 = 84.9. The model's units are dimensionless (u runs from 0 to about 1) and the heart is
 * idealised, so the shapes and signs of the leads carry the teaching, the millivolts do not. If the solver's
 * diffusion or cell constants are retuned, the amplitude moves with them and this needs recalibrating
 * (tests/ecg/ecg.spec.ts checks it).
 */
export const ECG_GAIN_MV = 85;

/** Slots in the results ring: the most samples queue() can hold before flush() has to collect them. */
export const ECG_RING_SLOTS = 64;

export interface EcgOptions {
  /** Electrode positions in millimetres, grid coordinates. electrodePositions(frame) gives the standard ones. */
  positions?: Record<ElectrodeName, Vec3>;
  /** The heart frame. Used for the standard positions when `positions` is left out. */
  frame?: HeartFrame;
  /** Millivolts per unit of the raw dipole sum (per mm^3). Default ECG_GAIN_MV. */
  gainMvPerUnit?: number;
}

const N = ELECTRODE_NAMES.length;
/** One slot of the ring: the nine electrode sums as f32. */
const SLOT_BYTES = 4 * N;
/** The slot sample() and electrodePotentials() use. It sits after the ring proper, so a one-off read never disturbs queued samples. */
const SCRATCH_SLOT = ECG_RING_SLOTS;
/** Uniform layout: two rows of four numbers, a row for the slot, then one vec4 per electrode. */
const UNIFORM_BYTES = 48 + 16 * N;

/**
 * Compile a shader and throw if it does not compile. A shader that fails to compile does not throw by itself:
 * every dispatch of it silently does nothing. The error scope keeps a broken module from also raising an
 * uncaptured GPU error, so the failure arrives here, as the rejection, and nowhere else.
 */
export async function createCheckedModule(device: GPUDevice, code: string, label: string): Promise<GPUShaderModule> {
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ code, label });
  const scope = device.popErrorScope();
  const [info, scoped] = await Promise.all([module.getCompilationInfo(), scope]);
  const errors = info.messages.filter((m) => m.type === "error").map((m) => `line ${m.lineNum}: ${m.message}`);
  if (scoped && errors.length === 0) errors.push(scoped.message);
  if (errors.length > 0) throw new Error(`${label} shader failed to compile: ${errors.join("; ")}`);
  return module;
}

/**
 * The 12-lead ECG of a running Simulation, computed on the GPU from its voltage field. Each muscle voxel is a
 * current dipole D grad(u); the potential at nine electrodes is the sum of the dipole fields in an infinite
 * homogeneous conductor (src/ecg/ecgKernel.ts has the physics and the sign convention). The sums are reduced on
 * the GPU and only nine numbers (36 bytes) come back per sample.
 *
 * Two ways to read it:
 *  - sample() reads the ECG of the voltage the solver holds right now and resolves with the 12 leads.
 *  - queue() and flush() take several samples per frame and read them back together. queue() reduces the CURRENT
 *    voltage into the next slot of a small results ring and submits at once, so it can sit between simulation
 *    steps; flush() copies every slot queued since the last flush into a staging buffer of its own, maps it once,
 *    and resolves with one 12-lead vector per slot, in the order queued. A frame looks like
 *    `sim.step(4); ecg.queue();` a few times and then one `ecg.flush()`, whose result may be awaited a frame
 *    later: overlapping flushes are safe and resolve in the order they were made.
 */
export class Ecg {
  private readonly bufUniform: GPUBuffer;
  private readonly bufSums: GPUBuffer;
  private readonly bufRing: GPUBuffer;
  private readonly finishBind: GPUBindGroup;
  private readonly uniform = new ArrayBuffer(UNIFORM_BYTES);
  // The solver ping-pongs its voltage between two buffers, so bind groups are made per buffer, once.
  private readonly contributeBinds = new WeakMap<GPUBuffer, GPUBindGroup>();
  private readonly idleStaging: GPUBuffer[] = [];
  private readonly groups: number;
  /** mV per unit of a raw sum: the gain per mm^3 times the volume of one voxel. */
  private readonly scale: number;
  /** Slots filled by queue() since the last flush(). */
  private queued = 0;
  /** Settles once the previous flush() has been delivered, so overlapping flushes resolve in order. */
  private previousFlush: Promise<void> = Promise.resolve();

  /**
   * Build the ECG for a simulation and wait until its shader has compiled. Throws if it does not compile.
   * Pass `positions` (or a `frame`, for the standard ones): the electrodes have to be placed relative to the heart.
   */
  static async create(device: GPUDevice, sim: Simulation, opts: EcgOptions = {}): Promise<Ecg> {
    const positions = opts.positions ?? (opts.frame ? electrodePositions(opts.frame) : undefined);
    if (!positions) throw new Error("Ecg.create needs electrode positions: pass opts.positions (see electrodePositions) or opts.frame");
    for (const name of ELECTRODE_NAMES) {
      const p = positions[name];
      if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) throw new Error(`Ecg.create: electrode ${name} needs three finite coordinates in mm`);
    }
    const module = await createCheckedModule(device, ecgWgsl, "ECG");
    const [contribute, finish] = await Promise.all([
      device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "contribute" } }),
      device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "finish" } }),
    ]);
    return new Ecg(device, sim, positions, opts.gainMvPerUnit ?? ECG_GAIN_MV, contribute, finish);
  }

  private constructor(
    private readonly device: GPUDevice,
    private readonly sim: Simulation,
    readonly positions: Record<ElectrodeName, Vec3>,
    gain: number,
    private readonly contributePipeline: GPUComputePipeline,
    private readonly finishPipeline: GPUComputePipeline,
  ) {
    this.groups = Math.ceil(sim.muscleCount() / ECG_WORKGROUP);
    if (this.groups > 65535) throw new Error("too many muscle voxels for one ECG dispatch");
    this.scale = gain * sim.layout.voxelMm ** 3;

    const pos = new Float32Array(this.uniform, 48, 4 * N);
    ELECTRODE_NAMES.forEach((name, e) => pos.set([...positions[name], 0], 4 * e));

    this.bufUniform = device.createBuffer({ size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bufSums = device.createBuffer({ size: Math.max(16, this.groups * N * 4), usage: GPUBufferUsage.STORAGE });
    this.bufRing = device.createBuffer({ size: (ECG_RING_SLOTS + 1) * SLOT_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.finishBind = device.createBindGroup({
      layout: this.finishPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.bufUniform } },
        { binding: 4, resource: { buffer: this.bufSums } },
        { binding: 5, resource: { buffer: this.bufRing } },
      ],
    });
  }

  private contributeBind(volt: GPUBuffer): GPUBindGroup {
    let bind = this.contributeBinds.get(volt);
    if (!bind) {
      bind = this.device.createBindGroup({
        layout: this.contributePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.bufUniform } },
          { binding: 1, resource: { buffer: this.sim.cellsBuffer() } },
          { binding: 2, resource: { buffer: this.sim.muscleBuffer() } },
          { binding: 3, resource: { buffer: volt } },
          { binding: 4, resource: { buffer: this.bufSums } },
        ],
      });
      this.contributeBinds.set(volt, bind);
    }
    return bind;
  }

  /**
   * Reduce the CURRENT voltage into one slot of the ring and submit at once, optionally copying that slot to a
   * staging buffer in the same submission. The uniform is rewritten first; the queue runs a write and the
   * submissions after it in the order they were made, so every reduction sees its own slot number and the tissue
   * setting in force when it was made.
   */
  private reduce(slot: number, copyTo?: GPUBuffer): void {
    const { sx, sy, voxelMm } = this.sim.layout;
    const { dPar, dPerp } = this.sim.diffusion(); // already multiplied by the conduction setting
    new Uint32Array(this.uniform, 0, 4).set([sx, sy, this.sim.muscleCount(), this.groups]);
    new Float32Array(this.uniform, 16, 4).set([1 / voxelMm, dPar, dPerp, voxelMm]);
    new Uint32Array(this.uniform, 32, 4).set([slot, 0, 0, 0]);
    this.device.queue.writeBuffer(this.bufUniform, 0, this.uniform);

    // The buffer that holds the voltage changes as the solver steps: ask for it every time.
    const bind = this.contributeBind(this.sim.voltageBuffer());
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.contributePipeline);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(this.groups);
    pass.setPipeline(this.finishPipeline);
    pass.setBindGroup(0, this.finishBind);
    pass.dispatchWorkgroups(1);
    pass.end();
    if (copyTo) enc.copyBufferToBuffer(this.bufRing, slot * SLOT_BYTES, copyTo, 0, SLOT_BYTES);
    this.device.queue.submit([enc.finish()]);
  }

  /** A staging buffer nobody is using, big enough for the whole ring. Each read owns one until it is done. */
  private takeStaging(): GPUBuffer {
    return this.idleStaging.pop() ?? this.device.createBuffer({ size: ECG_RING_SLOTS * SLOT_BYTES, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  }

  /** Map the first `bytes` of a staging buffer, copy the sums out and hand the buffer back. */
  private async collect(staging: GPUBuffer, bytes: number): Promise<Float32Array> {
    await staging.mapAsync(GPUMapMode.READ, 0, bytes);
    const sums = new Float32Array(staging.getMappedRange(0, bytes).slice(0));
    staging.unmap();
    this.idleStaging.push(staging);
    return sums;
  }

  private potentials(sums: Float32Array, slot: number): Record<ElectrodeName, number> {
    const out = {} as Record<ElectrodeName, number>;
    ELECTRODE_NAMES.forEach((name, e) => (out[name] = sums[slot * N + e] * this.scale));
    return out;
  }

  /** The nine raw sums of the voltage the solver holds right now, through the scratch slot. */
  private async readNow(): Promise<Float32Array> {
    const staging = this.takeStaging();
    this.reduce(SCRATCH_SLOT, staging);
    return this.collect(staging, SLOT_BYTES);
  }

  /** The potential at each electrode in millivolts, for the voltage the solver holds right now. */
  async electrodePotentials(): Promise<Record<ElectrodeName, number>> {
    return this.potentials(await this.readNow(), 0);
  }

  /** The 12 leads in millivolts (I, II, III, aVR, aVL, aVF, V1 to V6), for the voltage the solver holds right now. */
  async sample(): Promise<Float32Array> {
    return leadsFromElectrodes(this.potentials(await this.readNow(), 0));
  }

  /**
   * Take a sample of the voltage the solver holds right now into the next slot of the results ring and submit it
   * at once, so it can sit between simulation steps. Nothing is read back until flush(). Throws if all
   * ECG_RING_SLOTS slots are already waiting for a flush().
   */
  queue(): void {
    if (this.queued >= ECG_RING_SLOTS) {
      throw new Error(`Ecg.queue: all ${ECG_RING_SLOTS} slots of the results ring are waiting to be read, call flush() before queueing more`);
    }
    this.reduce(this.queued);
    this.queued++;
  }

  /**
   * Collect every sample queued since the previous flush: one 12-lead Float32Array in millivolts per queue()
   * call, in the order queued (an empty list if there were none). The copy out of the ring is submitted before
   * flush() returns, so the slots are free for new queue() calls at once, and each flush maps a staging buffer of
   * its own, so a second flush may start before the first resolves. Flushes resolve in the order they were made.
   */
  flush(): Promise<Float32Array[]> {
    const count = this.queued;
    this.queued = 0;
    let own: Promise<Float32Array[]> = Promise.resolve([]);
    if (count > 0) {
      const bytes = count * SLOT_BYTES;
      const staging = this.takeStaging();
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(this.bufRing, 0, staging, 0, bytes);
      this.device.queue.submit([enc.finish()]);
      own = this.collect(staging, bytes).then((sums) => Array.from({ length: count }, (_, k) => leadsFromElectrodes(this.potentials(sums, k))));
    }
    const ordered = Promise.all([this.previousFlush, own]).then(([, leads]) => leads);
    this.previousFlush = ordered.then(
      () => undefined,
      () => undefined,
    );
    return ordered;
  }

  /** Release the GPU buffers. The instance cannot be used afterwards. */
  destroy(): void {
    this.bufUniform.destroy();
    this.bufSums.destroy();
    this.bufRing.destroy();
    for (const b of this.idleStaging) b.destroy();
    this.idleStaging.length = 0;
  }
}
