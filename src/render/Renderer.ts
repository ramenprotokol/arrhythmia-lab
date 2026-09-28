import type { HeartGrid, HeartSurface } from "../data/loadHeart";
import type { Simulation } from "../sim/Simulation";
import { bloomWgsl } from "./bloomShader";
import { OrbitCamera, type Vec3 } from "./camera";
import { buildFields } from "./fields";
import { fibreTensors } from "./fibres";
import { fitDistanceToPoints, gridViewProjection, lensShift, projectToCanvas, unshiftPixel, type Insets } from "./lens";
import { heartFrame, poseRotation, rotate, rotateBack, type Mat3 } from "./orient";
import { castRay, pickVoxel } from "./pick";
import { postWgsl } from "./postShader";
import { QUALITY, backingSize, type QualityName, type QualitySettings } from "./quality";
import { sceneWgsl } from "./sceneShader";
import { shellWgsl } from "./shellShader";
import { voltageWgsl } from "./voltageShader";

export interface RendererOptions {
  quality?: QualityName;
  /**
   * The heart's anatomical frame (public/data/heart-frame.json, as read by loadFrame): the long axis toward the
   * apex, and the direction from the right to the left ventricle. The heart is stood up by it: the textbook
   * front view, apex down and a little to the right, right ventricle on the left. Without it the renderer
   * estimates an axis from the muscle, which is unreliable for a dilated heart.
   */
  frame?: { longAxis: Vec3; leftDir: Vec3 };
  /** Turn slowly when nobody is dragging, for a showcase. Can be switched at run time through `autoRotate`. */
  autoRotate?: boolean;
}

const HDR: GPUTextureFormat = "rgba16float";
const LDR: GPUTextureFormat = "rgba8unorm";
const DEPTH: GPUTextureFormat = "depth32float";

/** The view the heart opens in: yaw and pitch of the orbit camera, in the display frame. */
const DEFAULT_YAW = 0.4;
const DEFAULT_PITCH = 0.16;
/** Room left round the heart when it is fitted to the free area: the outermost muscle sits at 1 / this of the way out. */
const FRAME_MARGIN = 1.12;
/** Auto-rotation speed, radians per second. */
const AUTO_ROTATE_SPEED = 0.14;
/** A press and release that moves the pointer less than this many pixels is a tap. */
const TAP_SLOP_PX = 6;
/** How far below the lowest muscle the floor sits, mm. */
const FLOOR_GAP_MM = 8;
/** A point this much nearer the camera than the first muscle on the way to it is hidden behind the heart, mm. */
const OCCLUDER_TOLERANCE_MM = 3.5;

interface Destroyable {
  destroy(): void;
}

/** A bloom pass: what it reads, where it draws, and whether it adds onto what is there. */
interface BloomPass {
  pipeline: GPURenderPipeline;
  bind: GPUBindGroup;
  target: GPUTextureView;
  additive: boolean;
}

/** Everything that depends on the canvas size. */
interface Targets {
  width: number;
  height: number;
  owned: Destroyable[];
  shellView: GPUTextureView;
  depthView: GPUTextureView;
  sceneView: GPUTextureView;
  ldrView: GPUTextureView;
  bloom: BloomPass[];
  sceneBinds: [GPUBindGroup, GPUBindGroup];
  finalBind: GPUBindGroup;
  fxaaBind: GPUBindGroup;
}

async function checkCompiled(module: GPUShaderModule, name: string): Promise<void> {
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === "error");
  if (errors.length > 0) {
    throw new Error(`${name} shader failed to compile: ` + errors.map((m) => `line ${m.lineNum}: ${m.message}`).join("; "));
  }
}

/**
 * The 3D heart on screen. Every frame it copies the solver's voltage into a 3D texture, draws the
 * epicardial shell, then one full-screen pass builds the HDR picture (room, shell, and the muscle behind
 * it marched with emission from the voltage), then bloom, tone mapping and edge smoothing.
 *
 * Units are millimetres in the grid frame, the same as the mesh and the solver. Build it through
 * `create`, which throws with the compiler message if a shader fails to compile (a broken shader
 * otherwise just draws nothing).
 */
export class Renderer {
  readonly camera: OrbitCamera;
  /** Tuning knobs, read every frame: bloom strength, exposure, glow gain, and a debug view (1 shell only, 2 volume only). */
  readonly look = { bloom: 0.9, exposure: 1.0, glow: 1.0, debug: 0 };
  /** Called with the canvas position in CSS pixels when the pointer is pressed and released without dragging. */
  onTap: ((x: number, y: number) => void) | null = null;
  /** Turn slowly when nobody is dragging. */
  autoRotate: boolean;

  private readonly canvas: HTMLCanvasElement;
  private readonly device: GPUDevice;
  private readonly grid: HeartGrid;
  private readonly sim: Simulation;
  private readonly context: GPUCanvasContext;
  private readonly canvasFormat: GPUTextureFormat;
  private quality: QualitySettings;
  private readonly ready: Promise<void>;

  private readonly sx: number;
  private readonly sy: number;
  private readonly sz: number;
  /** The grid centre, mm: the camera target, and the centre of the display frame. */
  private readonly centre: Vec3;
  /** Grid frame to display frame: the rotation that stands the heart up, and the grid point that lands on the target. */
  private readonly pose: Mat3;
  private readonly pivot: Vec3;
  /**
   * The point the camera looks at, in voxel coordinates as heart-frame.json and Simulation.stimulate use them
   * (voxel (i, j, k) is centred at (i, j, k)). It projects to the middle of the free area.
   */
  readonly focus: Vec3;
  /** Every muscle voxel as the opening view sees it: across, up, along the line of sight, mm from the target. */
  private readonly viewPoints: Float32Array;
  /** The floor plane: dot(p - pivot, up) = floorH, with up the display "up" in the grid frame. */
  private readonly floorH: number;
  private readonly floorUp: Vec3;

  private readonly owned: Destroyable[] = [];
  private readonly sampler: GPUSampler;
  private readonly frameBuf: GPUBuffer;
  private readonly frameData = new Float32Array(72);
  private readonly fieldTextures: [GPUTexture, GPUTexture];
  private readonly fieldViews: [GPUTextureView, GPUTextureView];
  private readonly tissueView: GPUTextureView;
  private readonly densityView: GPUTextureView;
  private readonly smoothView: GPUTextureView;
  private readonly fibreViews: [GPUTextureView, GPUTextureView];
  private readonly sdfView: GPUTextureView;
  private last = 0; // the field texture written most recently
  private readonly dimsBuf: GPUBuffer;
  /** stats[0] is the number of excited muscle voxels this frame, counted by the voltage pass. */
  private readonly statsBuf: GPUBuffer;
  private readonly voltPipeline: GPUComputePipeline;
  private readonly voltBinds = new WeakMap<GPUBuffer, [GPUBindGroup, GPUBindGroup]>();

  private readonly posBuf: GPUBuffer;
  private readonly nrmBuf: GPUBuffer;
  private readonly idxBuf: GPUBuffer;
  private readonly indexCount: number;
  private readonly shellPipeline: GPURenderPipeline;
  private readonly shellBinds: [GPUBindGroup, GPUBindGroup];
  private readonly scenePipeline: GPURenderPipeline;
  private readonly brightPipeline: GPURenderPipeline;
  private readonly downPipeline: GPURenderPipeline;
  private readonly upPipeline: GPURenderPipeline;
  private readonly finalPipeline: GPURenderPipeline;
  private readonly fxaaPipeline: GPURenderPipeline;
  private targets: Targets | null = null;

  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private frameNo = 0;
  private lastTime = 0;
  private destroyed = false;

  private cutOn = false;
  private cutDepth = 0;
  private cutNormal: Vec3 = [0, 0, -1];
  /** Where the muscle starts and ends along the cut direction, mm from the pivot. */
  private cutExtent: [number, number] = [-1, 1];
  private userZoomed = false;
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private dragging = false;
  private spin = { x: 0, y: 0 };
  private lastMoveAt = 0;
  private readonly unlisten: (() => void)[] = [];

  static async create(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    surface: HeartSurface,
    grid: HeartGrid,
    sim: Simulation,
    opts: RendererOptions = {},
  ): Promise<Renderer> {
    const r = new Renderer(canvas, device, surface, grid, sim, opts);
    try {
      await r.ready;
      await r.applySize(canvas.clientWidth || canvas.width || 1, canvas.clientHeight || canvas.height || 1, window.devicePixelRatio || 1);
    } catch (e) {
      r.destroy();
      throw e;
    }
    return r;
  }

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice, surface: HeartSurface, grid: HeartGrid, sim: Simulation, opts: RendererOptions) {
    this.canvas = canvas;
    this.device = device;
    this.grid = grid;
    this.sim = sim;
    this.quality = QUALITY[opts.quality ?? "high"];
    this.autoRotate = opts.autoRotate ?? false;

    const ctx = canvas.getContext("webgpu");
    if (!ctx) throw new Error("could not get a WebGPU context from the canvas");
    this.context = ctx;
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format: this.canvasFormat, alphaMode: "opaque" });

    const { sx, sy, sz } = sim.layout;
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    const h = grid.voxelMm;
    this.centre = [(grid.nx * h) / 2, (grid.ny * h) / 2, (grid.nz * h) / 2];

    // Stand the heart up in a fixed pose: the textbook front view, apex down and a little to the right, right
    // ventricle on the left. The anatomical frame decides it when it is given.
    const anatomy = opts.frame
      ? { apex: opts.frame.longAxis, rv: [-opts.frame.leftDir[0], -opts.frame.leftDir[1], -opts.frame.leftDir[2]] as Vec3 }
      : heartFrame(grid);
    this.pose = poseRotation(anatomy);

    // Measure the muscle in the display frame as the opening view shows it: across the screen, up it, and
    // along the line of sight. That gives the size to fit into the free area, and the point that should sit on
    // the camera target so that the heart's picture, not its 3D box, is centred.
    const cosP = Math.cos(DEFAULT_PITCH), sinP = Math.sin(DEFAULT_PITCH);
    const across: Vec3 = [Math.cos(DEFAULT_YAW), 0, -Math.sin(DEFAULT_YAW)];
    const upward: Vec3 = [-sinP * Math.sin(DEFAULT_YAW), cosP, -sinP * Math.cos(DEFAULT_YAW)];
    const along: Vec3 = [-cosP * Math.sin(DEFAULT_YAW), -sinP, -cosP * Math.cos(DEFAULT_YAW)];
    const lo: Vec3 = [Infinity, Infinity, Infinity]; // across, up, along
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    let lowest = Infinity; // the lowest the muscle reaches in the display frame
    const view = new Float32Array(3 * sim.count);
    let at = 0;
    for (let z = 0; z < grid.nz; z++)
      for (let y = 0; y < grid.ny; y++)
        for (let x = 0; x < grid.nx; x++) {
          if (grid.tissue[x + grid.nx * (y + grid.ny * z)] === 0) continue;
          const d = rotate(this.pose, [(x + 0.5) * h - this.centre[0], (y + 0.5) * h - this.centre[1], (z + 0.5) * h - this.centre[2]]);
          lowest = Math.min(lowest, d[1]);
          const v = [d[0] * across[0] + d[2] * across[2], d[0] * upward[0] + d[1] * upward[1] + d[2] * upward[2], d[0] * along[0] + d[1] * along[1] + d[2] * along[2]];
          for (let a = 0; a < 3; a++) {
            lo[a] = Math.min(lo[a], v[a]);
            hi[a] = Math.max(hi[a], v[a]);
            view[at++] = v[a];
          }
        }
    const mid: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    for (let i = 0; i < view.length; i += 3) for (let a = 0; a < 3; a++) view[i + a] -= mid[a]; // from the target
    this.viewPoints = view;
    // the display-frame point at the middle of that view, and the grid point it is
    const onTarget: Vec3 = [
      across[0] * mid[0] + upward[0] * mid[1] + along[0] * mid[2],
      across[1] * mid[0] + upward[1] * mid[1] + along[1] * mid[2],
      across[2] * mid[0] + upward[2] * mid[1] + along[2] * mid[2],
    ];
    const back = rotateBack(this.pose, onTarget);
    this.pivot = [this.centre[0] + back[0], this.centre[1] + back[1], this.centre[2] + back[2]];
    this.focus = [this.pivot[0] / h - 0.5, this.pivot[1] / h - 0.5, this.pivot[2] / h - 0.5];
    this.floorUp = rotateBack(this.pose, [0, 1, 0]);
    this.floorH = lowest - onTarget[1] - FLOOR_GAP_MM;

    this.camera = new OrbitCamera({
      target: this.centre,
      distance: 300,
      minDistance: 85,
      maxDistance: 700,
      fovY: (32 * Math.PI) / 180,
      near: 8,
      far: 1500,
    });
    this.camera.yaw = DEFAULT_YAW;
    this.camera.pitch = DEFAULT_PITCH;

    // the static volumes are built on the CPU first, so nothing can throw inside the validation scope below
    const fields = buildFields(grid);
    const fibres = fibreTensors(grid);

    // Everything below is created inside one validation scope, so a bad pipeline or binding is reported
    // as an error from create() instead of as a silent blank picture.
    device.pushErrorScope("validation");

    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.frameBuf = this.track(device.createBuffer({ size: 288, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));

    // static volumes, padded like the solver's buffer
    const staticVolume = (format: GPUTextureFormat, data: Uint8Array) => {
      const tex = this.track(device.createTexture({ size: [sx, sy, sz], dimension: "3d", format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
      device.queue.writeTexture({ texture: tex }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: sx, rowsPerImage: sy }, { width: sx, height: sy, depthOrArrayLayers: sz });
      return tex.createView();
    };
    this.tissueView = staticVolume("r8uint", fields.tissue);
    this.densityView = staticVolume("r8unorm", fields.density);
    this.smoothView = staticVolume("r8unorm", fields.smooth);
    const tensorVolume = (data: Int8Array) => {
      const tex = this.track(device.createTexture({ size: [sx, sy, sz], dimension: "3d", format: "rgba8snorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
      device.queue.writeTexture({ texture: tex }, data as Int8Array<ArrayBuffer>, { bytesPerRow: 4 * sx, rowsPerImage: sy }, { width: sx, height: sy, depthOrArrayLayers: sz });
      return tex.createView();
    };
    this.fibreViews = [tensorVolume(fibres.a), tensorVolume(fibres.b)];
    this.sdfView = staticVolume("r8unorm", fields.distance);

    const fieldTex = [0, 1].map(() =>
      this.track(device.createTexture({ size: [sx, sy, sz], dimension: "3d", format: HDR, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC })),
    ) as [GPUTexture, GPUTexture];
    this.fieldTextures = fieldTex;
    this.fieldViews = [fieldTex[0].createView(), fieldTex[1].createView()];

    // grid size and how strongly a change in voltage between frames counts as rising or falling
    const dims = new ArrayBuffer(16);
    new Uint32Array(dims, 0, 3).set([sx, sy, sz]);
    new Float32Array(dims, 12, 1).set([8]);
    this.dimsBuf = this.track(device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    device.queue.writeBuffer(this.dimsBuf, 0, dims);
    this.statsBuf = this.track(device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));

    // mesh
    const vertexBuffer = (data: Float32Array) => {
      const b = this.track(device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }));
      device.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
      return b;
    };
    this.posBuf = vertexBuffer(surface.positions);
    this.nrmBuf = vertexBuffer(surface.normals);
    this.idxBuf = this.track(device.createBuffer({ size: surface.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST }));
    device.queue.writeBuffer(this.idxBuf, 0, surface.indices as Uint32Array<ArrayBuffer>);
    this.indexCount = surface.indices.length;

    // shaders and pipelines
    const modules = {
      voltage: device.createShaderModule({ label: "voltage", code: voltageWgsl }),
      shell: device.createShaderModule({ label: "shell", code: shellWgsl }),
      scene: device.createShaderModule({ label: "scene", code: sceneWgsl }),
      bloom: device.createShaderModule({ label: "bloom", code: bloomWgsl }),
      post: device.createShaderModule({ label: "post", code: postWgsl }),
    };
    this.voltPipeline = device.createComputePipeline({ layout: "auto", compute: { module: modules.voltage, entryPoint: "main" } });
    this.shellPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: modules.shell,
        entryPoint: "vs",
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
          { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }] },
        ],
      },
      fragment: { module: modules.shell, entryPoint: "fs", targets: [{ format: HDR }] },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: "less" },
    });
    const add: GPUBlendComponent = { srcFactor: "one", dstFactor: "one", operation: "add" };
    const fullscreen = (module: GPUShaderModule, entry: string, format: GPUTextureFormat, additive = false): GPURenderPipeline =>
      device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: entry, targets: [{ format, blend: additive ? { color: add, alpha: add } : undefined }] },
        primitive: { topology: "triangle-list" },
      });
    this.scenePipeline = fullscreen(modules.scene, "fs", HDR);
    this.brightPipeline = fullscreen(modules.bloom, "fsBright", HDR);
    this.downPipeline = fullscreen(modules.bloom, "fsDown", HDR);
    this.upPipeline = fullscreen(modules.bloom, "fsUp", HDR, true);
    this.finalPipeline = fullscreen(modules.post, "fsFinal", LDR);
    this.fxaaPipeline = fullscreen(modules.post, "fsFxaa", this.canvasFormat);

    const shellBind = (k: 0 | 1) =>
      device.createBindGroup({
        layout: this.shellPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.frameBuf } },
          { binding: 1, resource: this.fieldViews[k] },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: this.fibreViews[0] },
          { binding: 4, resource: this.fibreViews[1] },
          { binding: 8, resource: { buffer: this.statsBuf } },
        ],
      });
    this.shellBinds = [shellBind(0), shellBind(1)];

    const validation = device.popErrorScope();
    this.ready = (async () => {
      for (const [name, module] of Object.entries(modules)) await checkCompiled(module, name);
      const err = await validation;
      if (err) throw new Error("renderer setup failed: " + err.message);
    })();

    this.attachInput();
  }

  private track<T extends Destroyable>(x: T): T {
    this.owned.push(x);
    return x;
  }

  // ---- size ------------------------------------------------------------------------------------

  /**
   * Set the canvas size in CSS pixels and the device pixel ratio. Sizes the backing store within the quality
   * limits. Safe to call as often as you like, with any size, including zero (it is treated as one pixel).
   */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    if (this.destroyed) return;
    void this.applySize(cssWidth, cssHeight, devicePixelRatio).catch((e) => console.error(e));
  }

  /**
   * Tell the renderer which part of the canvas panels cover, in CSS pixels. The canvas stays full-bleed: the
   * room, the vignette, the floor and the bloom still fill all of it. The heart is fitted to what is left and
   * centred in it, by shifting the picture (a lens shift), not by resizing anything. pick(), project() and
   * onTap use the same pixels either way. Call it again whenever the panels change; all zero (the default)
   * frames the heart for the whole canvas.
   */
  setInsets(insets: { top: number; right: number; bottom: number; left: number }): void {
    if (this.destroyed) return;
    this.insets = { top: insets.top, right: insets.right, bottom: insets.bottom, left: insets.left };
    this.refit();
  }

  private async applySize(cssWidth: number, cssHeight: number, dpr: number, force = false): Promise<void> {
    if (this.destroyed) return;
    this.cssWidth = Math.max(1, Number.isFinite(cssWidth) ? cssWidth : 1);
    this.cssHeight = Math.max(1, Number.isFinite(cssHeight) ? cssHeight : 1);
    this.dpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    const b = backingSize(this.cssWidth, this.cssHeight, this.dpr, this.quality);
    this.camera.aspect = b.width / b.height;
    this.refit();
    if (force || !this.targets || b.width !== this.targets.width || b.height !== this.targets.height) {
      this.canvas.width = b.width;
      this.canvas.height = b.height;
      await this.allocate(b.width, b.height);
    }
  }

  /** Change the quality tier at run time. Safe to call repeatedly. */
  setQuality(name: QualityName): void {
    if (this.destroyed) return;
    this.quality = QUALITY[name];
    void this.applySize(this.cssWidth, this.cssHeight, this.dpr, true).catch((e) => console.error(e));
  }

  /** Fit the heart to the free area again (unless the user has zoomed): after a resize or new insets. */
  private refit(): void {
    const d = this.fitDistance();
    this.camera.maxDistance = Math.max(700, d * 1.5);
    if (!this.userZoomed) this.camera.distance = d;
  }

  /** Distance from the target at which the heart fits the free area, both ways, with perspective. */
  private fitDistance(): number {
    return fitDistanceToPoints(this.viewPoints, this.camera.fovY, this.camera.aspect, this.cssWidth, this.cssHeight, this.insets, FRAME_MARGIN);
  }

  /**
   * Build the size-dependent targets. They are in place, and the old ones released, before this returns;
   * the promise it gives back is only the wait for the GPU's verdict on them.
   */
  private allocate(width: number, height: number): Promise<void> {
    const device = this.device;
    const old = this.targets;
    const owned: Destroyable[] = [];
    device.pushErrorScope("validation");
    const target = (format: GPUTextureFormat, w: number, h: number) => {
      const t = device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      owned.push(t);
      return t;
    };
    const shellView = target(HDR, width, height).createView();
    const depthView = target(DEPTH, width, height).createView({ aspect: "depth-only" });
    const sceneView = target(HDR, width, height).createView();
    const ldrView = target(LDR, width, height).createView();

    // bloom chain: level i is 2^(i+1) times smaller than the picture
    const levels = this.quality.bloomLevels;
    const sizes: [number, number][] = [];
    const views: GPUTextureView[] = [];
    for (let i = 0; i < levels; i++) {
      const w = Math.max(1, width >> (i + 1));
      const h = Math.max(1, height >> (i + 1));
      sizes.push([w, h]);
      views.push(target(HDR, w, h).createView());
    }
    const bloom: BloomPass[] = [];
    const bloomPass = (pipeline: GPURenderPipeline, src: GPUTextureView, dst: GPUTextureView, texel: [number, number], mixAmt: number, additive: boolean) => {
      const params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      owned.push(params);
      // texel size, threshold, knee, mix amount
      device.queue.writeBuffer(params, 0, new Float32Array([texel[0], texel[1], 0.55, 0.5, mixAmt, 0, 0, 0]));
      bloom.push({
        pipeline,
        target: dst,
        additive,
        bind: device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: params } },
            { binding: 1, resource: src },
            { binding: 2, resource: this.sampler },
          ],
        }),
      });
    };
    bloomPass(this.brightPipeline, sceneView, views[0], [1 / width, 1 / height], 1, false);
    for (let i = 1; i < levels; i++) bloomPass(this.downPipeline, views[i - 1], views[i], [1 / sizes[i - 1][0], 1 / sizes[i - 1][1]], 1, false);
    for (let i = levels - 1; i >= 1; i--) bloomPass(this.upPipeline, views[i], views[i - 1], [1 / sizes[i][0], 1 / sizes[i][1]], 0.85, true);

    const sceneBind = (k: 0 | 1) =>
      device.createBindGroup({
        layout: this.scenePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.frameBuf } },
          { binding: 1, resource: this.fieldViews[k] },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: this.sdfView },
          { binding: 4, resource: shellView },
          { binding: 5, resource: depthView },
          { binding: 6, resource: this.smoothView },
          { binding: 8, resource: { buffer: this.statsBuf } },
        ],
      });
    const finalBind = device.createBindGroup({
      layout: this.finalPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: sceneView },
        { binding: 2, resource: views[0] },
        { binding: 3, resource: this.sampler },
        { binding: 8, resource: { buffer: this.statsBuf } },
      ],
    });
    const fxaaBind = device.createBindGroup({
      layout: this.fxaaPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: ldrView },
        { binding: 3, resource: this.sampler },
      ],
    });
    const sceneBinds: [GPUBindGroup, GPUBindGroup] = [sceneBind(0), sceneBind(1)];
    const verdict = device.popErrorScope();

    this.targets = { width, height, owned, shellView, depthView, sceneView, ldrView, bloom, sceneBinds, finalBind, fxaaBind };
    // a frame already submitted may still be reading the old targets; destroying them is safe, the GPU finishes that work first
    if (old) for (const o of old.owned) o.destroy();
    return verdict.then((err) => {
      if (err) throw new Error("renderer targets failed: " + err.message);
    });
  }

  // ---- camera and input --------------------------------------------------------------------------

  /**
   * Cut the heart open. The plane is perpendicular to the way the camera was looking when the cutaway
   * was switched on, and stays fixed in the heart from then on, so you can orbit round the cut.
   * depth runs from -1 (the plane just clears the near side of the heart, so nothing is removed)
   * through 0 (a cut through the middle of the muscle along that direction) to 1 (the plane is past
   * the far side, so everything is removed). Turn it off and on again to cut from a new direction.
   */
  setCutaway(on: boolean, depth = 0): void {
    if (on && !this.cutOn) {
      this.cutNormal = rotateBack(this.pose, this.viewForward());
      this.cutExtent = this.extentAlong(this.cutNormal);
    }
    this.cutOn = on;
    this.cutDepth = Math.max(-1, Math.min(1, depth));
  }

  private viewForward(): Vec3 {
    const m = this.camera.viewMatrix();
    return [-m[2], -m[6], -m[10]];
  }

  /** The nearest and farthest the muscle reaches along a direction, in mm from the pivot. */
  private extentAlong(n: Vec3): [number, number] {
    const { nx, ny, nz, voxelMm: h, tissue } = this.grid;
    const p = this.pivot;
    let lo = Infinity;
    let hi = -Infinity;
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          if (tissue[x + nx * (y + ny * z)] === 0) continue;
          const d = ((x + 0.5) * h - p[0]) * n[0] + ((y + 0.5) * h - p[1]) * n[1] + ((z + 0.5) * h - p[2]) * n[2];
          if (d < lo) lo = d;
          if (d > hi) hi = d;
        }
    // a voxel is a box, not a point
    return [lo - 0.87 * h, hi + 0.87 * h];
  }

  /** Offset of the cut plane: -1 at the near side of the muscle, 1 at the far side, along the cut direction. */
  private cutOffset(): number {
    const n = this.cutNormal;
    const c = this.pivot;
    const [lo, hi] = this.cutExtent;
    return n[0] * c[0] + n[1] * c[1] + n[2] * c[2] + (lo + hi) / 2 + (this.cutDepth * (hi - lo)) / 2;
  }

  private attachInput(): void {
    const c = this.canvas;
    c.style.touchAction = "none";
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    let travelled = 0;
    let downAt = 0;
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      c.addEventListener(type, fn as EventListener, opts);
      this.unlisten.push(() => c.removeEventListener(type, fn as EventListener));
    };

    on("pointerdown", (e) => {
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        // a synthetic pointer has nothing to capture; the gesture still works
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        travelled = 0;
        downAt = performance.now();
        this.dragging = true;
        this.spin = { x: 0, y: 0 };
        this.lastMoveAt = 0;
      }
      if (pointers.size === 2) pinch = spread();
    });
    on("pointermove", (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      travelled += Math.abs(dx) + Math.abs(dy);
      if (pointers.size === 1) {
        this.camera.orbit(dx, dy);
        // remember the recent motion, in pixels per second, so the heart keeps turning after release
        const dt = Math.max(1, e.timeStamp - (this.lastMoveAt || e.timeStamp - 16)) / 1000;
        this.spin = { x: 0.7 * this.spin.x + 0.3 * (dx / dt), y: 0.7 * this.spin.y + 0.3 * (dy / dt) };
        this.lastMoveAt = e.timeStamp;
      } else if (pointers.size === 2) {
        const d = spread();
        this.camera.zoom(-(d - pinch) * 2.2);
        this.userZoomed = true;
        pinch = d;
      }
    });
    const release = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      if (pointers.size === 0) {
        this.dragging = false;
        if (e.type === "pointerup" && travelled < TAP_SLOP_PX && performance.now() - downAt < 600) {
          const r = c.getBoundingClientRect();
          this.spin = { x: 0, y: 0 };
          this.onTap?.(e.clientX - r.left, e.clientY - r.top);
        }
      }
      if (pointers.size === 1) pinch = 0;
    };
    on("pointerup", release);
    on("pointercancel", release);
    on(
      "wheel",
      (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
        // a trackpad pinch arrives as a wheel event with ctrl held and small deltas
        this.camera.zoom(e.deltaY * unit * (e.ctrlKey ? 4 : 1));
        this.userZoomed = true;
      },
      { passive: false },
    );
  }

  /** The eye in the grid frame, mm. */
  private gridEye(): Vec3 {
    const c = this.centre;
    const e = this.camera.position();
    const g = rotateBack(this.pose, [e[0] - c[0], e[1] - c[1], e[2] - c[2]]);
    return [g[0] + this.pivot[0], g[1] + this.pivot[1], g[2] + this.pivot[2]];
  }

  private shift(): [number, number] {
    return lensShift(this.cssWidth, this.cssHeight, this.insets);
  }

  /**
   * The original-grid muscle voxel under a pixel of the canvas (CSS pixels from its top left), or
   * null if the ray misses the heart. With the cutaway on, only the part that is still there counts.
   */
  pick(px: number, py: number): [number, number, number] | null {
    // the picture is shifted to sit in the free area, so the ray for a pixel is that of another camera pixel
    const [ux, uy] = unshiftPixel(px, py, this.cssWidth, this.cssHeight, this.shift());
    const view = this.camera.rayFromPixel(ux, uy, this.cssWidth, this.cssHeight);
    const at = rotateBack(this.pose, [view.origin[0] - this.centre[0], view.origin[1] - this.centre[1], view.origin[2] - this.centre[2]]);
    let origin: Vec3 = [at[0] + this.pivot[0], at[1] + this.pivot[1], at[2] + this.pivot[2]];
    const ray = { dir: rotateBack(this.pose, view.dir) };
    let reach = Infinity;
    if (this.cutOn) {
      // keep the part of the ray on the far side of the plane: s is the signed distance to the plane
      const n = this.cutNormal;
      const s0 = origin[0] * n[0] + origin[1] * n[1] + origin[2] * n[2] - this.cutOffset();
      const dn = ray.dir[0] * n[0] + ray.dir[1] * n[1] + ray.dir[2] * n[2];
      if (s0 < 0) {
        if (dn <= 1e-9) return null;
        const t = -s0 / dn;
        origin = [origin[0] + ray.dir[0] * t, origin[1] + ray.dir[1] * t, origin[2] + ray.dir[2] * t];
      } else if (dn < 0) {
        reach = -s0 / dn;
      }
    }
    return pickVoxel(this.grid, origin, ray.dir, this.grid.voxelMm, reach);
  }

  /**
   * Where a point of the heart is on the canvas, for pinning labels to it. voxel is in voxel coordinates as
   * heart-frame.json and Simulation.stimulate use them: voxel (i, j, k) is centred at (i, j, k), and a float
   * is a point in between. x and y are canvas CSS pixels from the top left, the space of pick() and onTap.
   *
   * visible is true when the point is in front of the camera, inside the canvas, and not hidden behind the
   * heart: a ray from the camera to the point, walked through the muscle grid, must not enter muscle more than
   * a few millimetres before it gets there. It respects the cutaway (a point on the cut-away side is hidden,
   * and the part of the ray on that side does not count). So a point on the heart's surface facing you is
   * visible, one on the far side is not, and a point in a cavity is visible only through a cut. When the
   * point is behind the camera x and y are far off screen.
   */
  project(voxel: [number, number, number]): { x: number; y: number; visible: boolean } {
    const h = this.grid.voxelMm;
    const p: Vec3 = [(voxel[0] + 0.5) * h, (voxel[1] + 0.5) * h, (voxel[2] + 0.5) * h];
    const s = projectToCanvas(gridViewProjection(this.camera, this.pose, this.pivot, this.centre, this.shift()), p, this.cssWidth, this.cssHeight);
    if (!(s.w > this.camera.near)) return { x: -1e4, y: -1e4, visible: false };
    const inside = s.x >= 0 && s.x <= this.cssWidth && s.y >= 0 && s.y <= this.cssHeight;
    return { x: s.x, y: s.y, visible: inside && !this.hiddenBehindHeart(p) };
  }

  /** Is the point hidden from the eye by muscle in front of it (or cut away)? */
  private hiddenBehindHeart(p: Vec3): boolean {
    const eye = this.gridEye();
    let origin = eye;
    if (this.cutOn) {
      const n = this.cutNormal;
      const off = this.cutOffset();
      if (p[0] * n[0] + p[1] * n[1] + p[2] * n[2] - off < 0) return true; // the point itself is cut away
      const se = eye[0] * n[0] + eye[1] * n[1] + eye[2] * n[2] - off;
      if (se < 0) {
        // the eye is on the removed side: the ray only counts from where it comes out of the cut
        const d: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
        const t = -se / (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]);
        origin = [eye[0] + d[0] * t, eye[1] + d[1] * t, eye[2] + d[2] * t];
      }
    }
    const d: Vec3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    const dist = Math.hypot(d[0], d[1], d[2]);
    if (dist < 1e-6) return false;
    const hit = castRay(this.grid, origin, [d[0] / dist, d[1] / dist, d[2] / dist], this.grid.voxelMm, dist);
    return hit !== null && hit.distance < dist - OCCLUDER_TOLERANCE_MM;
  }

  // ---- drawing ---------------------------------------------------------------------------------

  private writeFrame(now: number): void {
    const cam = this.camera;
    const f = this.frameData;
    const R = this.pose;
    const m = cam.viewMatrix();
    const tanHalf = Math.tan(cam.fovY / 2);
    const h = this.grid.voxelMm;
    const shift = this.shift();
    // The camera lives in the display frame; the shaders work in the grid frame. Bring the eye and the
    // camera axes into the grid frame, and fold the pose and the lens shift into the view-projection for the mesh.
    const eye = this.gridEye();
    const right = rotateBack(R, [m[0], m[4], m[8]]);
    const up = rotateBack(R, [m[1], m[5], m[9]]);
    const fwd = rotateBack(R, [-m[2], -m[6], -m[10]]);
    f.set(gridViewProjection(cam, R, this.pivot, this.centre, shift), 0);
    f.set([eye[0], eye[1], eye[2], now / 1000], 16);
    f.set([right[0], right[1], right[2], tanHalf * cam.aspect], 20);
    f.set([up[0], up[1], up[2], tanHalf], 24);
    f.set([fwd[0], fwd[1], fwd[2], cam.near], 28);
    f.set([this.sx, this.sy, this.sz, h], 32);
    f.set([this.targets?.width ?? 1, this.targets?.height ?? 1, cam.far, this.frameNo], 36);
    f.set([this.cutNormal[0], this.cutNormal[1], this.cutNormal[2], this.cutOffset()], 40);
    f.set([this.cutOn ? 1 : 0, this.quality.steps, this.quality.fineStepMm, this.quality.thicknessMm], 44);
    f.set([this.pivot[0], this.pivot[1], this.pivot[2], this.floorH], 48);
    f.set([this.floorUp[0], this.floorUp[1], this.floorUp[2], shift[1]], 52);
    f.set([this.look.bloom, this.look.exposure, this.look.glow, this.look.debug], 56);
    f.set([-h, -h, -h, shift[0]], 60);
    f.set([(this.sx - 1) * h, (this.sy - 1) * h, (this.sz - 1) * h, 1 / this.sim.count], 64);
    this.device.queue.writeBuffer(this.frameBuf, 0, f);
  }

  private voltBind(buffer: GPUBuffer, prev: 0 | 1): GPUBindGroup {
    let pair = this.voltBinds.get(buffer);
    if (!pair) {
      const make = (p: 0 | 1) =>
        this.device.createBindGroup({
          layout: this.voltPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.dimsBuf } },
            { binding: 1, resource: { buffer } },
            { binding: 2, resource: this.fieldViews[p] },
            { binding: 3, resource: this.tissueView },
            { binding: 4, resource: this.densityView },
            { binding: 5, resource: this.fieldViews[1 - p] },
            { binding: 6, resource: { buffer: this.statsBuf } },
          ],
        });
      pair = [make(0), make(1)];
      this.voltBinds.set(buffer, pair);
    }
    return pair[prev];
  }

  /**
   * Diagnostics: the voltage volume as the shaders see it after the last frame, four numbers per padded
   * voxel (u, trend, tissue class / 3, density), x fastest, in the solver's padded layout. Slow: for tests.
   */
  async readField(): Promise<Float32Array> {
    const { sx, sy, sz } = this;
    const rowBytes = Math.ceil((8 * sx) / 256) * 256;
    const staging = this.device.createBuffer({ size: rowBytes * sy * sz, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.fieldTextures[this.last] }, { buffer: staging, bytesPerRow: rowBytes, rowsPerImage: sy }, [sx, sy, sz]);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(staging.getMappedRange().slice(0));
    staging.destroy();
    const half = (h: number) => {
      const e = (h >> 10) & 31;
      const m = h & 1023;
      const v = e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15);
      return h & 32768 ? -v : v;
    };
    const dv = new DataView(bytes.buffer);
    const out = new Float32Array(4 * sx * sy * sz);
    for (let z = 0; z < sz; z++)
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++)
          for (let c = 0; c < 4; c++) out[4 * (x + sx * (y + sy * z)) + c] = half(dv.getUint16(z * rowBytes * sy + y * rowBytes + x * 8 + c * 2, true));
    return out;
  }

  /**
   * Draw one frame from the solver's current voltage. Does nothing, and never throws, once destroyed or while
   * the canvas has no size (a page may hide it for a moment).
   */
  frame(): void {
    const t = this.targets;
    if (!t || this.destroyed || this.canvas.width < 1 || this.canvas.height < 1) return;
    let screen: GPUTextureView;
    try {
      screen = this.context.getCurrentTexture().createView();
    } catch {
      return; // the browser has no drawing surface for the canvas right now
    }
    const now = performance.now();
    const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 0;
    this.lastTime = now;
    if (!this.dragging && (Math.abs(this.spin.x) > 1 || Math.abs(this.spin.y) > 1)) {
      this.camera.orbit(this.spin.x * dt, this.spin.y * dt);
      const keep = Math.exp(-dt / 0.35);
      this.spin = { x: this.spin.x * keep, y: this.spin.y * keep };
    } else if (this.autoRotate && !this.dragging) {
      this.camera.yaw += AUTO_ROTATE_SPEED * dt;
    }
    this.writeFrame(now);

    const device = this.device;
    const enc = device.createCommandEncoder();

    // 1. voltage buffer -> 3D texture (the buffer changes as the solver steps, so ask every frame)
    const prev = this.last as 0 | 1;
    const next = (1 - prev) as 0 | 1;
    enc.clearBuffer(this.statsBuf);
    const cp = enc.beginComputePass();
    cp.setPipeline(this.voltPipeline);
    cp.setBindGroup(0, this.voltBind(this.sim.voltageBuffer(), prev));
    cp.dispatchWorkgroups(Math.ceil(this.sx / 8), Math.ceil(this.sy / 4), Math.ceil(this.sz / 2));
    cp.end();
    this.last = next;

    // 2. the shell, with its depth
    const sp = enc.beginRenderPass({
      colorAttachments: [{ view: t.shellView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" }],
      depthStencilAttachment: { view: t.depthView, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
    });
    sp.setPipeline(this.shellPipeline);
    sp.setBindGroup(0, this.shellBinds[next]);
    sp.setVertexBuffer(0, this.posBuf);
    sp.setVertexBuffer(1, this.nrmBuf);
    sp.setIndexBuffer(this.idxBuf, "uint32");
    sp.drawIndexed(this.indexCount);
    sp.end();

    const fullscreen = (pipeline: GPURenderPipeline, bind: GPUBindGroup, view: GPUTextureView, load: GPULoadOp = "clear") => {
      const p = enc.beginRenderPass({ colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: load, storeOp: "store" }] });
      p.setPipeline(pipeline);
      p.setBindGroup(0, bind);
      p.draw(3);
      p.end();
    };
    // 3. the scene: room, shell skin, and the glowing muscle behind it
    fullscreen(this.scenePipeline, t.sceneBinds[next], t.sceneView);
    // 4. bloom
    for (const b of t.bloom) fullscreen(b.pipeline, b.bind, b.target, b.additive ? "load" : "clear");
    // 5. tone map, then edge smoothing and grain onto the canvas
    fullscreen(this.finalPipeline, t.finalBind, t.ldrView);
    fullscreen(this.fxaaPipeline, t.fxaaBind, screen);

    device.queue.submit([enc.finish()]);
    this.frameNo++;
  }

  /** Release everything. Safe to call more than once; the renderer does nothing afterwards. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.unlisten) off();
    this.unlisten.length = 0;
    if (this.targets) for (const o of this.targets.owned) o.destroy();
    this.targets = null;
    for (const o of this.owned) o.destroy();
    this.owned.length = 0;
    this.context.unconfigure();
  }
}
