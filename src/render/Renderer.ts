import type { HeartAnatomy, HeartGrid, HeartSurface } from "../data/loadHeart";
import type { Simulation } from "../sim/Simulation";
import { bloomWgsl } from "./bloomShader";
import { OrbitCamera, type Vec3 } from "./camera";
import { FRAME_FLOATS } from "./commonShader";
import { buildFields, initialField, voltageCells } from "./fields";
import { fibreTensors } from "./fibres";
import { heartWgsl } from "./heartShader";
import { fitDistanceToPoints, gridViewProjection, lensShift, projectToCanvas, unshiftPixel, type Insets } from "./lens";
import { BEAT, beatDisplacement, followWeight, restPoint, shockLook, squeezeGate, type BeatFrame } from "./mechanics";
import { heartFrame, poseRotation, rotate, rotateBack, type Mat3 } from "./orient";
import { castRay } from "./pick";
import { postWgsl } from "./postShader";
import { QUALITY, backingSize, type QualityName, type QualitySettings } from "./quality";
import { sceneWgsl } from "./sceneShader";
import { capByClearance, extraFat, relaxFolds, thickenedNormals, ventricleFat } from "./fat";
import { findSeam, twinGroups, unifyTwins, vesselEnds } from "./seam";
import { buildVessels, sheathFat } from "./vessels";
import { voltageWgsl } from "./voltageShader";

export interface RendererOptions {
  quality?: QualityName;
  /**
   * The heart's anatomical frame (public/data/heart-frame.json, as read by loadFrame): the long axis toward the
   * apex, and the direction from the right to the left ventricle. The heart is stood up by it: the textbook
   * front view, apex down and a little to the right, right ventricle on the left. Without it the renderer
   * estimates an axis from the muscle, which is unreliable for a dilated heart. The anterior direction, the apex
   * voxel and the centroid, when given, place the grooves' vessels front and back and the beat's axis.
   */
  frame?: { longAxis: Vec3; leftDir: Vec3; anteriorDir?: Vec3; apexVoxel?: Vec3; centroid?: Vec3 };
  /**
   * The rest of the heart and the anatomy of the ventricles' surface (public/data/heart-anatomy.bin, as read by
   * loadAnatomy): atria, great vessels, fat and coronary vessels. Without it only the ventricles are drawn, bare.
   */
  anatomy?: HeartAnatomy;
  /** Turn slowly when nobody is dragging, for a showcase. Can be switched at run time through `autoRotate`. */
  autoRotate?: boolean;
  /**
   * Sway gently when left alone for a while (default on, unless the system asks for reduced motion). Can be switched at
   * run time through `drift`.
   */
  drift?: boolean;
}

const HDR: GPUTextureFormat = "rgba16float";
const DEPTH: GPUTextureFormat = "depth24plus-stencil8";

/** The view the heart opens in: yaw and pitch of the orbit camera, in the display frame. */
const DEFAULT_YAW = 0.4;
const DEFAULT_PITCH = 0.16;
/** Room left round the heart when it is fitted to the free area: the outermost point sits at 1 / this of the way out. */
const FRAME_MARGIN = 1.08;
/** Auto-rotation speed, radians per second. */
const AUTO_ROTATE_SPEED = 0.14;
/** A press and release that moves the pointer less than this many pixels is a tap. */
const TAP_SLOP_PX = 6;
/** How far below the lowest point of the heart the floor sits, mm. */
const FLOOR_GAP_MM = 10;
/** A point this much nearer the camera than the first muscle on the way to it is hidden behind the heart, mm. */
const OCCLUDER_TOLERANCE_MM = 3.5;
/** The idle sway: it starts this long after the last touch, eases in over the next few seconds, and its size. */
const DRIFT_AFTER_S = 6;
const DRIFT_EASE_S = 4;
const DRIFT_YAW = 0.22;
const DRIFT_PITCH = 0.05;

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
  samples: number;
  owned: Destroyable[];
  /** Where the heart's pass draws (multisampled when the tier asks for it), and its depth. */
  colourView: GPUTextureView;
  depthView: GPUTextureView;
  /** The resolved HDR picture. */
  sceneView: GPUTextureView;
  bloom: BloomPass[];
  finalBind: GPUBindGroup;
  pipelines: Pipelines;
}

/** The pipelines of the heart's pass, built for one sample count. */
interface Pipelines {
  vent: GPURenderPipeline;
  tube: GPURenderPipeline | null;
  extra: GPURenderPipeline | null;
  back: GPURenderPipeline;
  /**
   * The cut: first the surfaces again, into the stencil only, flipping bit 0 at each crossing of the surface with its
   * fat and bit 1 at each crossing of the bare muscle behind the plane; then the cut face where the plane is inside
   * both (muscle or a cavity), and fat in section where it is inside the fat only.
   */
  parity: { ventFat: GPURenderPipeline; ventBare: GPURenderPipeline; extraFat: GPURenderPipeline | null; extraBare: GPURenderPipeline | null };
  cut: GPURenderPipeline;
  cutFat: GPURenderPipeline;
}

/** The rest of the heart on the CPU, for picking: positions at rest, how much each vertex follows the beat, triangles. */
interface ExtraMesh {
  positions: Float32Array;
  follow: Float32Array;
  indices: Uint32Array;
  /** Positions moved for the contraction they were last moved for. */
  moved: Float32Array;
  movedFor: number;
}

async function checkCompiled(module: GPUShaderModule, name: string): Promise<void> {
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === "error");
  if (errors.length > 0) {
    throw new Error(`${name} shader failed to compile: ` + errors.map((m) => `line ${m.lineNum}: ${m.message}`).join("; "));
  }
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * The 3D heart on screen. Every frame it copies the solver's voltage into a 3D texture (with the muscle's
 * contraction, low-passed from it), then draws in one multisampled HDR pass: the ventricles, moved by their
 * contraction and lit as wet muscle with fat, coronary vessels and the wave on them; the rest of the heart (atria
 * and great vessels, drawn but not simulated); the cut face when the heart is cut open; and the studio behind.
 * Then bloom, and a tone map straight onto the canvas.
 *
 * Units are millimetres in the grid frame, the same as the mesh and the solver. Build it through `create`, which
 * throws with the compiler message if a shader fails to compile (a broken shader otherwise just draws nothing).
 */
export class Renderer {
  readonly camera: OrbitCamera;
  /**
   * Tuning knobs, read every frame: bloom strength, exposure, glow gain, how much the heart moves as it beats
   * (0 still, 1 normal), and a debug view (3 fat, 4 groove and base distances, 5 contraction, 6 flat colours: the
   * simulated ventricles and their vessels green, the rest of the heart blue).
   */
  readonly look = { bloom: 0.8, exposure: 1.0, glow: 1.0, beat: 1.0, debug: 0 };
  /** Called with the canvas position in CSS pixels when the pointer is pressed and released without dragging. */
  onTap: ((x: number, y: number) => void) | null = null;
  /** Turn slowly when nobody is dragging. */
  autoRotate: boolean;
  /** Sway gently after a while without a touch. */
  drift: boolean;

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
  /** Every point of the heart as the opening view sees it: across, up, along the line of sight, mm from the target. */
  private readonly viewPoints: Float32Array;
  /** The floor plane: dot(p - pivot, up) = floorH, with up the display "up" in the grid frame. */
  private readonly floorH: number;
  private readonly floorUp: Vec3;
  /** The heart's footprint on the floor, for the contact shadow: two axes (unit, grid frame) with half lengths, and the centre. */
  private readonly footprint: { a: Vec3; ha: number; b: Vec3; hb: number; c: Vec3 };
  /** The beat's axis, and the heart's anterior direction and centroid (mm). */
  private readonly beatFrame: BeatFrame;
  private readonly anterior: Vec3;
  private readonly leftward: Vec3;
  private readonly centroid: Vec3;
  /** Where the heart reaches, points of it at rest, for the cut's extent. */
  private readonly allPoints: Float32Array;

  private readonly owned: Destroyable[] = [];
  private readonly sampler: GPUSampler;
  private readonly frameBuf: GPUBuffer;
  private readonly frameData = new Float32Array(FRAME_FLOATS);
  private readonly fieldTextures: [GPUTexture, GPUTexture];
  private readonly fieldViews: [GPUTextureView, GPUTextureView];
  private readonly smoothView: GPUTextureView;
  private readonly fibreViews: [GPUTextureView, GPUTextureView];
  private readonly sdfView: GPUTextureView;
  private last = 0; // the field texture written most recently
  private readonly dimsBuf: GPUBuffer;
  private readonly dimsData = new ArrayBuffer(32);
  private readonly cellsBuf: GPUBuffer;
  private readonly cellCount: number;
  /** stats[0] is the number of excited muscle voxels this frame, stats[1] the muscle's summed contraction in 1/1024ths. */
  private readonly statsBuf: GPUBuffer;
  private readonly statsRead: GPUBuffer;
  private statsPending = false;
  /** The muscle's mean contraction as last read back (a frame or two old), times the beat gain: for pick and project. */
  private contraction = 0;
  /** Seconds since the last shock as last read back from the GPU, and when that reading came (ms, performance.now). */
  private shockAge = { age: 100, at: 0 };
  private readonly voltPipeline: GPUComputePipeline;
  private readonly settlePipeline: GPUComputePipeline;
  private readonly settleBind: GPUBindGroup;
  private readonly voltBinds = new WeakMap<GPUBuffer, [GPUBindGroup, GPUBindGroup]>();

  private readonly ventBuffers: GPUBuffer[];
  private readonly ventIndex: GPUBuffer;
  private readonly ventCount: number;
  private readonly tubeBuffers: GPUBuffer[] | null;
  private readonly tubeIndex: GPUBuffer | null;
  private readonly tubeCount: number;
  private readonly extraBuffers: GPUBuffer[] | null;
  private readonly extraIndex: GPUBuffer | null;
  private readonly extraCount: number;
  private readonly extraMesh: ExtraMesh | null;
  private readonly modules: { voltage: GPUShaderModule; heart: GPUShaderModule; scene: GPUShaderModule; bloom: GPUShaderModule; post: GPUShaderModule };
  private readonly heartLayout: GPUPipelineLayout;
  private readonly sceneLayout: GPUPipelineLayout;
  private readonly heartBinds: [GPUBindGroup, GPUBindGroup];
  private readonly sceneBinds: [GPUBindGroup, GPUBindGroup];
  private readonly pipelineCache = new Map<number, Pipelines>();
  private readonly brightPipeline: GPURenderPipeline;
  private readonly downPipeline: GPURenderPipeline;
  private readonly upPipeline: GPURenderPipeline;
  private readonly finalPipeline: GPURenderPipeline;
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
  /** Where the heart starts and ends along the cut direction, mm from the pivot. */
  private cutExtent: [number, number] = [-1, 1];
  /** The heart's cross-section in the cut plane (centre and half size in the plane's axes), and the plane it is for. */
  private cutQuad = { key: "", quad: [0, 0, 1, 1] as [number, number, number, number] };
  private userZoomed = false;
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private dragging = false;
  private spin = { x: 0, y: 0 };
  private lastMoveAt = 0;
  /** When the viewer last touched the heart (ms, performance.now), and the sway applied since. */
  private touchedAt = 0;
  private driftClock = 0;
  private driftApplied = { yaw: 0, pitch: 0 };
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
    // the sway is decoration: off for anyone who has asked their system for less motion
    this.drift = opts.drift ?? !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.touchedAt = performance.now();

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
    const anatomy = opts.anatomy && opts.anatomy.groove.length * 3 === surface.positions.length ? opts.anatomy : undefined;

    // Stand the heart up in a fixed pose: the textbook front view, apex down and a little to the right, right
    // ventricle on the left. The anatomical frame decides it when it is given.
    const estimated = opts.frame ? null : heartFrame(grid);
    const apexDir: Vec3 = opts.frame ? opts.frame.longAxis : estimated!.apex;
    const rvDir: Vec3 = opts.frame ? [-opts.frame.leftDir[0], -opts.frame.leftDir[1], -opts.frame.leftDir[2]] : estimated!.rv;
    this.pose = poseRotation({ apex: apexDir, rv: rvDir });
    this.leftward = [-rvDir[0], -rvDir[1], -rvDir[2]];
    this.anterior = opts.frame?.anteriorDir ?? unit3(cross3(apexDir, this.leftward));

    // Every point of the heart: the muscle voxels and the rest of the heart's vertices.
    const points: number[] = [];
    for (let z = 0; z < grid.nz; z++)
      for (let y = 0; y < grid.ny; y++)
        for (let x = 0; x < grid.nx; x++) if (grid.tissue[x + grid.nx * (y + grid.ny * z)] !== 0) points.push((x + 0.5) * h, (y + 0.5) * h, (z + 0.5) * h);
    const muscleCount = points.length / 3;
    if (anatomy) for (let i = 0; i < anatomy.extra.positions.length; i++) points.push(anatomy.extra.positions[i]);
    this.allPoints = Float32Array.from(points);

    // the muscle's centroid, its apex, and the height of the base above the apex along the long axis
    const c: Vec3 = [0, 0, 0];
    for (let i = 0; i < muscleCount; i++) for (let k = 0; k < 3; k++) c[k] += points[3 * i + k] / muscleCount;
    this.centroid = opts.frame?.centroid ? [(opts.frame.centroid[0] + 0.5) * h, (opts.frame.centroid[1] + 0.5) * h, (opts.frame.centroid[2] + 0.5) * h] : c;
    let apex: Vec3;
    if (opts.frame?.apexVoxel) {
      apex = [(opts.frame.apexVoxel[0] + 0.5) * h, (opts.frame.apexVoxel[1] + 0.5) * h, (opts.frame.apexVoxel[2] + 0.5) * h];
    } else {
      let best = -Infinity;
      apex = c;
      for (let i = 0; i < muscleCount; i++) {
        const d = (points[3 * i] - c[0]) * apexDir[0] + (points[3 * i + 1] - c[1]) * apexDir[1] + (points[3 * i + 2] - c[2]) * apexDir[2];
        if (d > best) {
          best = d;
          apex = [points[3 * i], points[3 * i + 1], points[3 * i + 2]];
        }
      }
    }
    let height = 1;
    for (let i = 0; i < surface.positions.length; i += 3) {
      const p: Vec3 = [surface.positions[i], surface.positions[i + 1], surface.positions[i + 2]];
      height = Math.max(height, -dot3(sub(p, apex), apexDir));
    }
    this.beatFrame = { apex, axis: unit3(apexDir), height };

    // Measure the heart in the display frame as the opening view shows it: across the screen, up it, and along the
    // line of sight. That gives the size to fit into the free area, and the point that should sit on the camera
    // target so that the heart's picture, not its 3D box, is centred.
    const cosP = Math.cos(DEFAULT_PITCH), sinP = Math.sin(DEFAULT_PITCH);
    const across: Vec3 = [Math.cos(DEFAULT_YAW), 0, -Math.sin(DEFAULT_YAW)];
    const upward: Vec3 = [-sinP * Math.sin(DEFAULT_YAW), cosP, -sinP * Math.cos(DEFAULT_YAW)];
    const along: Vec3 = [-cosP * Math.sin(DEFAULT_YAW), -sinP, -cosP * Math.cos(DEFAULT_YAW)];
    const lo: Vec3 = [Infinity, Infinity, Infinity]; // across, up, along
    const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    let lowest = Infinity; // the lowest the heart reaches in the display frame
    const n = points.length / 3;
    const view = new Float32Array(3 * n);
    const flat = new Float32Array(2 * n); // on the floor: display x and z
    for (let i = 0; i < n; i++) {
      const d = rotate(this.pose, [points[3 * i] - this.centre[0], points[3 * i + 1] - this.centre[1], points[3 * i + 2] - this.centre[2]]);
      lowest = Math.min(lowest, d[1]);
      flat[2 * i] = d[0];
      flat[2 * i + 1] = d[2];
      const v = [d[0] * across[0] + d[2] * across[2], d[0] * upward[0] + d[1] * upward[1] + d[2] * upward[2], d[0] * along[0] + d[1] * along[1] + d[2] * along[2]];
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], v[a]);
        hi[a] = Math.max(hi[a], v[a]);
        view[3 * i + a] = v[a];
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
    // the footprint: the spread of the heart seen from above, as an ellipse
    let mx = 0, mz = 0;
    for (let i = 0; i < n; i++) {
      mx += flat[2 * i] / n;
      mz += flat[2 * i + 1] / n;
    }
    let cxx = 0, czz = 0, cxz = 0;
    for (let i = 0; i < n; i++) {
      const dx = flat[2 * i] - mx, dz = flat[2 * i + 1] - mz;
      cxx += (dx * dx) / n;
      czz += (dz * dz) / n;
      cxz += (dx * dz) / n;
    }
    const tr = cxx + czz, det = cxx * czz - cxz * cxz;
    const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l2 = Math.max(1, tr - l1);
    const ang = 0.5 * Math.atan2(2 * cxz, cxx - czz);
    const floorPoint = rotateBack(this.pose, [mx, lowest - FLOOR_GAP_MM, mz]);
    this.footprint = {
      a: rotateBack(this.pose, [Math.cos(ang), 0, Math.sin(ang)]),
      ha: 1.9 * Math.sqrt(l1),
      b: rotateBack(this.pose, [-Math.sin(ang), 0, Math.cos(ang)]),
      hb: 1.9 * Math.sqrt(l2),
      c: [floorPoint[0] + this.centre[0], floorPoint[1] + this.centre[1], floorPoint[2] + this.centre[2]],
    };

    this.camera = new OrbitCamera({
      target: this.centre,
      distance: 300,
      minDistance: 85,
      maxDistance: 700,
      fovY: (30 * Math.PI) / 180,
      near: 8,
      far: 1500,
    });
    this.camera.yaw = DEFAULT_YAW;
    this.camera.pitch = DEFAULT_PITCH;

    // the static volumes are built on the CPU first, so nothing can throw inside the validation scope below
    const fields = buildFields(grid);
    const fibres = fibreTensors(grid);
    const cells = voltageCells(fields);
    const startField = initialField(fields.density);
    const seamInfo = anatomy ? findSeam(surface, anatomy) : null;
    const seam = seamInfo ? seamInfo.sides : new Float32Array((2 * surface.positions.length) / 3);

    // Everything below is created inside one validation scope, so a bad pipeline or binding is reported
    // as an error from create() instead of as a silent blank picture.
    device.pushErrorScope("validation");

    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    this.frameBuf = this.track(device.createBuffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));

    // static volumes, padded like the solver's buffer
    const staticVolume = (format: GPUTextureFormat, data: Uint8Array) => {
      const tex = this.track(device.createTexture({ size: [sx, sy, sz], dimension: "3d", format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
      device.queue.writeTexture({ texture: tex }, data as Uint8Array<ArrayBuffer>, { bytesPerRow: sx, rowsPerImage: sy }, { width: sx, height: sy, depthOrArrayLayers: sz });
      return tex.createView();
    };
    this.smoothView = staticVolume("r8unorm", fields.smooth);
    const tensorVolume = (data: Int8Array) => {
      const tex = this.track(device.createTexture({ size: [sx, sy, sz], dimension: "3d", format: "rgba8snorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
      device.queue.writeTexture({ texture: tex }, data as Int8Array<ArrayBuffer>, { bytesPerRow: 4 * sx, rowsPerImage: sy }, { width: sx, height: sy, depthOrArrayLayers: sz });
      return tex.createView();
    };
    this.fibreViews = [tensorVolume(fibres.a), tensorVolume(fibres.b)];
    this.sdfView = staticVolume("r8unorm", fields.distance);

    const fieldTex = [0, 1].map(() => {
      const t = this.track(device.createTexture({ size: [sx, sy, sz], dimension: "3d", format: HDR, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST }));
      device.queue.writeTexture({ texture: t }, startField as Uint16Array<ArrayBuffer>, { bytesPerRow: 8 * sx, rowsPerImage: sy }, { width: sx, height: sy, depthOrArrayLayers: sz });
      return t;
    }) as [GPUTexture, GPUTexture];
    this.fieldTextures = fieldTex;
    this.fieldViews = [fieldTex[0].createView(), fieldTex[1].createView()];

    this.cellCount = cells.length;
    this.cellsBuf = this.track(device.createBuffer({ size: Math.max(16, cells.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
    device.queue.writeBuffer(this.cellsBuf, 0, cells as Uint32Array<ArrayBuffer>);
    this.dimsBuf = this.track(device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    this.statsBuf = this.track(device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }));
    // stats[3], the seconds since the last shock, starts long past one
    device.queue.writeBuffer(this.statsBuf, 12, new Float32Array([100]));
    this.statsRead = this.track(device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));

    // meshes
    const vertexBuffer = (data: Float32Array) => {
      const b = this.track(device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }));
      device.queue.writeBuffer(b, 0, data as Float32Array<ArrayBuffer>);
      return b;
    };
    const indexBuffer = (data: Uint32Array) => {
      const b = this.track(device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST }));
      device.queue.writeBuffer(b, 0, data as Uint32Array<ArrayBuffer>);
      return b;
    };
    const V = surface.positions.length / 3;
    const ventAttr = new Float32Array(4 * V);
    const groove = anatomy ? smoothField(surface, anatomy.groove, 14) : new Float32Array(V).fill(60);
    const base = anatomy ? smoothField(surface, anatomy.base, 10) : new Float32Array(V).fill(60);
    // how far each vertex is from the seam, exactly 0 on it: what keeps the two meshes together there
    const fromSeam = seamInfo ? seamInfo.ventFromSeam : new Float32Array(V).fill(1000);
    for (let i = 0; i < V; i++) {
      ventAttr[4 * i] = groove[i];
      ventAttr[4 * i + 1] = fromSeam[i];
      ventAttr[4 * i + 2] = anatomy ? anatomy.ao[i] : 1;
      ventAttr[4 * i + 3] = anatomy ? anatomy.concavity[i] : 0;
    }
    // which way each vertex faces round the heart: 1 on the front, 0 on the back
    const front = new Float32Array(V);
    for (let i = 0; i < V; i++) {
      const d = (surface.positions[3 * i] - this.centroid[0]) * this.anterior[0] + (surface.positions[3 * i + 1] - this.centroid[1]) * this.anterior[1] + (surface.positions[3 * i + 2] - this.centroid[2]) * this.anterior[2];
      front[i] = Math.min(1, Math.max(0, 0.5 + d / 28));
    }
    let fat = anatomy ? ventricleFat(surface, groove, base, seam, front, fromSeam) : new Float32Array(V);
    let extraThickness: Float32Array | null = null;
    let extraTwins: number[][] = [];
    if (anatomy) {
      // the branches over the bare walls run in thin tracks of fat of their own
      const sheath = sheathFat({ surface, fat, groove, base, seam, centroid: this.centroid, anterior: this.anterior }, fromSeam);
      for (let i = 0; i < V; i++) fat[i] = Math.max(fat[i], sheath[i]);
      // room for it: no deeper than the gap to whatever lies in front (the rest of the heart included)
      const x = anatomy.extra;
      const xFromSeam = seamInfo ? seamInfo.extraFromSeam : x.dist;
      const twins = twinGroups(x.positions);
      const xfat = unifyTwins(extraFat(anatomy, xFromSeam), twins);
      capByClearance([
        { positions: surface.positions, normals: surface.normals, thickness: fat, fromSeam },
        { positions: x.positions, normals: x.normals, thickness: xfat, fromSeam: xFromSeam },
      ]);
      fat = relaxFolds(surface.positions, surface.normals, surface.indices, fat, fromSeam);
      extraThickness = relaxFolds(x.positions, x.normals, x.indices, unifyTwins(xfat, twins), xFromSeam, twins);
      extraTwins = twins;
    }
    const fatNormals = thickenedNormals(surface.positions, surface.normals, surface.indices, fat, fromSeam);
    const ventMore = new Float32Array(4 * V);
    for (let i = 0; i < V; i++) ventMore.set([seam[2 * i], seam[2 * i + 1], fat[i], front[i]], 4 * i);
    this.ventBuffers = [
      vertexBuffer(surface.positions),
      vertexBuffer(surface.normals),
      vertexBuffer(ventAttr),
      vertexBuffer(ventMore),
      vertexBuffer(surfaceGradient(surface, groove)),
      vertexBuffer(surfaceGradient(surface, base)),
      vertexBuffer(fatNormals),
    ];
    this.ventIndex = indexBuffer(surface.indices);
    this.ventCount = surface.indices.length;
    // the vessels lie on the fat
    const thick = Float32Array.from(surface.positions, (x, k) => x + surface.normals[k] * fat[Math.floor(k / 3)]);
    const onFat = { positions: thick, normals: fatNormals, indices: surface.indices };
    const tubes = anatomy ? buildVessels({ surface: onFat, fat, groove, base, seam, centroid: this.centroid, anterior: this.anterior }) : null;
    if (tubes && tubes.indices.length > 0) {
      this.tubeBuffers = [vertexBuffer(tubes.positions), vertexBuffer(tubes.normals), vertexBuffer(tubes.anchors), vertexBuffer(tubes.attrs), vertexBuffer(tubes.under)];
      this.tubeIndex = indexBuffer(tubes.indices);
      this.tubeCount = tubes.indices.length;
    } else {
      this.tubeBuffers = null;
      this.tubeIndex = null;
      this.tubeCount = 0;
    }
    if (anatomy && anatomy.extra.indices.length > 0) {
      const x = anatomy.extra;
      const E = x.positions.length / 3;
      const attr = new Float32Array(4 * E);
      const follow = new Float32Array(E);
      const xFromSeam = seamInfo ? seamInfo.extraFromSeam : x.dist;
      const twins = extraTwins;
      const xfat = extraThickness ?? new Float32Array(E);
      // how far from the seam in a straight line, not from the muscle: exactly 0 on the seam, so it moves with it, and the
      // same for the inner and outer walls of a vessel
      const nearSeam = seamInfo ? seamInfo.extraNearSeam : x.dist;
      for (let i = 0; i < E; i++) {
        attr.set([x.part[i], nearSeam[i], x.ao[i], xfat[i]], 4 * i);
        follow[i] = followWeight(nearSeam[i]);
      }
      const xNormals = thickenedNormals(x.positions, x.normals, x.indices, xfat, xFromSeam, twins);
      this.extraBuffers = [vertexBuffer(x.positions), vertexBuffer(x.normals), vertexBuffer(attr), vertexBuffer(xNormals), vertexBuffer(vesselEnds(anatomy))];
      this.extraIndex = indexBuffer(x.indices);
      this.extraCount = x.indices.length;
      this.extraMesh = { positions: x.positions, follow, indices: x.indices, moved: Float32Array.from(x.positions), movedFor: 0 };
    } else {
      this.extraBuffers = null;
      this.extraIndex = null;
      this.extraCount = 0;
      this.extraMesh = null;
    }

    // shaders and pipelines
    const modules = {
      voltage: device.createShaderModule({ label: "voltage", code: voltageWgsl }),
      heart: device.createShaderModule({ label: "heart", code: heartWgsl }),
      scene: device.createShaderModule({ label: "scene", code: sceneWgsl }),
      bloom: device.createShaderModule({ label: "bloom", code: bloomWgsl }),
      post: device.createShaderModule({ label: "post", code: postWgsl }),
    };
    this.modules = modules;
    this.voltPipeline = device.createComputePipeline({ layout: "auto", compute: { module: this.modules.voltage, entryPoint: "main" } });
    this.settlePipeline = device.createComputePipeline({ layout: "auto", compute: { module: this.modules.voltage, entryPoint: "settle" } });
    this.settleBind = device.createBindGroup({
      layout: this.settlePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.dimsBuf } },
        { binding: 6, resource: { buffer: this.statsBuf } },
      ],
    });

    const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const tex3d: GPUTextureBindingLayout = { sampleType: "float", viewDimension: "3d" };
    const heartGroup = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: both, buffer: { type: "uniform" } },
        { binding: 1, visibility: both, texture: tex3d },
        { binding: 2, visibility: both, sampler: { type: "filtering" } },
        { binding: 3, visibility: both, texture: tex3d },
        { binding: 4, visibility: both, texture: tex3d },
        { binding: 8, visibility: both, buffer: { type: "read-only-storage" } },
      ],
    });
    const sceneGroup = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: both, buffer: { type: "uniform" } },
        { binding: 1, visibility: both, texture: tex3d },
        { binding: 2, visibility: both, sampler: { type: "filtering" } },
        { binding: 3, visibility: both, texture: tex3d },
        { binding: 6, visibility: both, texture: tex3d },
        { binding: 8, visibility: both, buffer: { type: "read-only-storage" } },
      ],
    });
    this.heartLayout = device.createPipelineLayout({ bindGroupLayouts: [heartGroup] });
    this.sceneLayout = device.createPipelineLayout({ bindGroupLayouts: [sceneGroup] });
    const heartBind = (k: 0 | 1) =>
      device.createBindGroup({
        layout: heartGroup,
        entries: [
          { binding: 0, resource: { buffer: this.frameBuf } },
          { binding: 1, resource: this.fieldViews[k] },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: this.fibreViews[0] },
          { binding: 4, resource: this.fibreViews[1] },
          { binding: 8, resource: { buffer: this.statsBuf } },
        ],
      });
    const sceneBind = (k: 0 | 1) =>
      device.createBindGroup({
        layout: sceneGroup,
        entries: [
          { binding: 0, resource: { buffer: this.frameBuf } },
          { binding: 1, resource: this.fieldViews[k] },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: this.sdfView },
          { binding: 6, resource: this.smoothView },
          { binding: 8, resource: { buffer: this.statsBuf } },
        ],
      });
    this.heartBinds = [heartBind(0), heartBind(1)];
    this.sceneBinds = [sceneBind(0), sceneBind(1)];

    const add: GPUBlendComponent = { srcFactor: "one", dstFactor: "one", operation: "add" };
    const fullscreen = (module: GPUShaderModule, entry: string, format: GPUTextureFormat, additive = false): GPURenderPipeline =>
      device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: entry, targets: [{ format, blend: additive ? { color: add, alpha: add } : undefined }] },
        primitive: { topology: "triangle-list" },
      });
    this.brightPipeline = fullscreen(this.modules.bloom, "fsBright", HDR);
    this.downPipeline = fullscreen(this.modules.bloom, "fsDown", HDR);
    this.upPipeline = fullscreen(this.modules.bloom, "fsUp", HDR, true);
    this.finalPipeline = fullscreen(this.modules.post, "fsFinal", this.canvasFormat);
    this.pipelinesFor(this.quality.msaa);

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

  /** The heart's pass pipelines for a sample count, built once. */
  private pipelinesFor(samples: number): Pipelines {
    const cached = this.pipelineCache.get(samples);
    if (cached) return cached;
    const device = this.device;
    const multisample: GPUMultisampleState = { count: samples };
    const depth = (write: boolean, compare: GPUCompareFunction, stencil?: { ref: "flip" | "test"; mask: number }): GPUDepthStencilState => {
      const face: GPUStencilFaceState =
        stencil?.ref === "flip" ? { compare: "always", passOp: "invert", failOp: "keep", depthFailOp: "keep" } : stencil ? { compare: "equal", passOp: "keep", failOp: "keep", depthFailOp: "keep" } : {};
      return {
        format: DEPTH,
        depthWriteEnabled: write,
        depthCompare: compare,
        stencilFront: face,
        stencilBack: face,
        stencilReadMask: stencil?.ref === "test" ? stencil.mask : 0xff,
        stencilWriteMask: stencil?.ref === "flip" ? stencil.mask : 0,
      };
    };
    const f3 = (location: number): GPUVertexBufferLayout => ({ arrayStride: 12, attributes: [{ shaderLocation: location, offset: 0, format: "float32x3" }] });
    const f4 = (location: number): GPUVertexBufferLayout => ({ arrayStride: 16, attributes: [{ shaderLocation: location, offset: 0, format: "float32x4" }] });
    const heart = this.modules.heart;
    const vent = device.createRenderPipeline({
      layout: this.heartLayout,
      vertex: { module: heart, entryPoint: "vsVent", buffers: [f3(0), f3(1), f4(2), f4(3), f3(4), f3(5), f3(6)] },
      fragment: { module: heart, entryPoint: "fsVent", targets: [{ format: HDR }] },
      primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
      depthStencil: depth(true, "less"),
      multisample,
    });
    const tube = this.tubeBuffers
      ? device.createRenderPipeline({
          layout: this.heartLayout,
          vertex: { module: heart, entryPoint: "vsTube", buffers: [f3(0), f3(1), f3(2), f4(3), f3(4)] },
          fragment: { module: heart, entryPoint: "fsTube", targets: [{ format: HDR }] },
          primitive: { topology: "triangle-list", cullMode: "back", frontFace: "ccw" },
          depthStencil: depth(true, "less"),
          multisample,
        })
      : null;
    const extra = this.extraBuffers
      ? device.createRenderPipeline({
          layout: this.heartLayout,
          vertex: { module: heart, entryPoint: "vsExtra", buffers: [f3(0), f3(1), f4(2), f3(3), { arrayStride: 4, attributes: [{ shaderLocation: 4, offset: 0, format: "float32" }] }] },
          fragment: { module: heart, entryPoint: "fsExtra", targets: [{ format: HDR }] },
          primitive: { topology: "triangle-list", cullMode: "none", frontFace: "ccw" },
          depthStencil: depth(true, "less"),
          multisample,
        })
      : null;
    const scene = this.modules.scene;
    const back = device.createRenderPipeline({
      layout: this.sceneLayout,
      vertex: { module: scene, entryPoint: "vsBack" },
      fragment: { module: scene, entryPoint: "fsBack", targets: [{ format: HDR }] },
      primitive: { topology: "triangle-list" },
      depthStencil: depth(false, "less-equal"),
      multisample,
    });
    const cutFace = (entry: string) =>
      device.createRenderPipeline({
        layout: this.sceneLayout,
        vertex: { module: scene, entryPoint: "vsCut" },
        fragment: { module: scene, entryPoint: entry, targets: [{ format: HDR }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: depth(true, "less", { ref: "test", mask: 3 }),
        multisample,
      });
    const flip = (entry: string, buffers: GPUVertexBufferLayout[], mask: number) =>
      device.createRenderPipeline({
        layout: this.heartLayout,
        vertex: { module: heart, entryPoint: entry, buffers },
        fragment: { module: heart, entryPoint: "fsParity", targets: [{ format: HDR, writeMask: 0 }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: depth(false, "always", { ref: "flip", mask }),
        multisample,
      });
    // position only: the stencil passes need no normals
    const ventLayout = [f3(0), f3(1), f4(2), f4(3)];
    const extraLayout = [f3(0), f3(1), f4(2)];
    const parity = {
      ventFat: flip("vsVentParity", ventLayout, 1),
      ventBare: flip("vsVentBareParity", ventLayout, 2),
      extraFat: this.extraBuffers ? flip("vsExtraParity", extraLayout, 1) : null,
      extraBare: this.extraBuffers ? flip("vsExtraBareParity", extraLayout, 2) : null,
    };
    const p = { vent, tube, extra, back, parity, cut: cutFace("fsCut"), cutFat: cutFace("fsCutFat") };
    this.pipelineCache.set(samples, p);
    return p;
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
    if (force || !this.targets || b.width !== this.targets.width || b.height !== this.targets.height || this.targets.samples !== this.quality.msaa) {
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
    const samples = this.quality.msaa;
    device.pushErrorScope("validation");
    const target = (format: GPUTextureFormat, w: number, h: number, sampleCount = 1) => {
      const t = device.createTexture({
        size: [w, h],
        format,
        sampleCount,
        usage: sampleCount > 1 ? GPUTextureUsage.RENDER_ATTACHMENT : GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      owned.push(t);
      return t;
    };
    const sceneView = target(HDR, width, height).createView();
    const colourView = samples > 1 ? target(HDR, width, height, samples).createView() : sceneView;
    const depthView = target(DEPTH, width, height, samples).createView();

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
      device.queue.writeBuffer(params, 0, new Float32Array([texel[0], texel[1], 0.9, 0.6, mixAmt, 0, 0, 0]));
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
    const pipelines = this.pipelinesFor(samples);
    const verdict = device.popErrorScope();

    this.targets = { width, height, samples, owned, colourView, depthView, sceneView, bloom, finalBind, pipelines };
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
   * through 0 (a cut through the middle of the heart along that direction) to 1 (the plane is past
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

  /** The nearest and farthest the heart reaches along a direction, in mm from the pivot, with room for its beat. */
  private extentAlong(n: Vec3): [number, number] {
    const p = this.pivot;
    const pts = this.allPoints;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      const d = (pts[i] - p[0]) * n[0] + (pts[i + 1] - p[1]) * n[1] + (pts[i + 2] - p[2]) * n[2];
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    // a voxel is a box, not a point; and the fat, the vessels on it and the beat reach a little further out
    const h = this.grid.voxelMm;
    const reach = 0.87 * h + 9;
    return [lo - reach, hi + reach];
  }

  /**
   * The heart's cross-section in the cut plane: the centre and half size of the rectangle, in the plane's own axes (as
   * the cut's vertex shader builds them), that holds every point of the heart within a few millimetres of the plane,
   * with room for its fat and for the beat. Measured again only when the plane moves.
   */
  private cutSection(): [number, number, number, number] {
    const n = this.cutNormal;
    const off = this.cutOffset();
    const key = `${n.join(",")},${off.toFixed(2)}`;
    if (this.cutQuad.key === key) return this.cutQuad.quad;
    const helper: Vec3 = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const a = unit3(cross3(n, helper));
    const b = cross3(n, a);
    const pts = this.allPoints;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      const d = pts[i] * n[0] + pts[i + 1] * n[1] + pts[i + 2] * n[2] - off;
      if (d < -6 || d > 6) continue;
      const u = pts[i] * a[0] + pts[i + 1] * a[1] + pts[i + 2] * a[2];
      const v = pts[i] * b[0] + pts[i + 1] * b[1] + pts[i + 2] * b[2];
      if (u < x0) x0 = u;
      if (u > x1) x1 = u;
      if (v < y0) y0 = v;
      if (v > y1) y1 = v;
    }
    // no heart at the plane: a square that covers nothing
    const margin = 14;
    const quad: [number, number, number, number] =
      x0 <= x1 ? [(x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2 + margin, (y1 - y0) / 2 + margin] : [0, 0, 0, 0];
    this.cutQuad = { key, quad };
    return quad;
  }

  /** Offset of the cut plane: -1 at the near side of the heart, 1 at the far side, along the cut direction. */
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
      this.touched();
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
      this.touched();
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
      this.touched();
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
        this.touched();
        const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
        // a trackpad pinch arrives as a wheel event with ctrl held and small deltas
        this.camera.zoom(e.deltaY * unit * (e.ctrlKey ? 4 : 1));
        this.userZoomed = true;
      },
      { passive: false },
    );
  }

  /** The viewer is handling the heart: stop the idle sway where it is. */
  private touched(): void {
    this.touchedAt = performance.now();
    this.driftApplied = { yaw: 0, pitch: 0 };
    this.driftClock = 0;
  }

  /** The idle sway: a slow figure of eight round wherever the viewer left the camera, eased in and out. */
  private sway(now: number, dt: number): void {
    if (!this.drift || this.autoRotate || this.dragging) return;
    const idle = (now - this.touchedAt) / 1000 - DRIFT_AFTER_S;
    if (idle <= 0) return;
    const ease = Math.min(1, idle / DRIFT_EASE_S);
    const blend = ease * ease * (3 - 2 * ease);
    this.driftClock += dt;
    const t = this.driftClock;
    const yaw = blend * DRIFT_YAW * Math.sin((2 * Math.PI * t) / 46);
    const pitch = blend * DRIFT_PITCH * Math.sin((2 * Math.PI * t) / 31 + 0.8);
    this.camera.yaw += yaw - this.driftApplied.yaw;
    this.camera.pitch += pitch - this.driftApplied.pitch;
    this.driftApplied = { yaw, pitch };
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

  /** The contraction the surfaces are drawn with, as far as the CPU knows it (the mean of the muscle). */
  private shownContraction(): number {
    return Math.max(0, Math.min(1, this.contraction));
  }

  /**
   * The original-grid muscle voxel under a pixel of the canvas (CSS pixels from its top left), or
   * null if the ray misses the heart. With the cutaway on, only the part that is still there counts. The atria
   * and great vessels are not simulated: a ray that meets them before the muscle picks nothing.
   */
  pick(px: number, py: number): [number, number, number] | null {
    // the picture is shifted to sit in the free area, so the ray for a pixel is that of another camera pixel
    const [ux, uy] = unshiftPixel(px, py, this.cssWidth, this.cssHeight, this.shift());
    const view = this.camera.rayFromPixel(ux, uy, this.cssWidth, this.cssHeight);
    const at = rotateBack(this.pose, [view.origin[0] - this.centre[0], view.origin[1] - this.centre[1], view.origin[2] - this.centre[2]]);
    let origin: Vec3 = [at[0] + this.pivot[0], at[1] + this.pivot[1], at[2] + this.pivot[2]];
    const dir = rotateBack(this.pose, view.dir);
    let reach = Infinity;
    let skipped = 0;
    if (this.cutOn) {
      // keep the part of the ray on the far side of the plane: s is the signed distance to the plane
      const n = this.cutNormal;
      const s0 = origin[0] * n[0] + origin[1] * n[1] + origin[2] * n[2] - this.cutOffset();
      const dn = dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2];
      if (s0 < 0) {
        if (dn <= 1e-9) return null;
        const t = -s0 / dn;
        origin = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
        skipped = t;
      } else if (dn < 0) {
        reach = -s0 / dn;
      }
    }
    const c = this.shownContraction();
    const gain = this.shownGain();
    const hit = c * gain < 0.01 ? castRay(this.grid, origin, dir, this.grid.voxelMm, reach) : this.castMoved(origin, dir, reach, c, gain);
    if (!hit) return null;
    const blocker = this.extraHit(origin, dir, c, gain);
    if (blocker !== null && blocker < hit.distance - 0.5) return null;
    void skipped;
    return hit.voxel;
  }

  /** castRay through the heart as it is drawn now, moved by contraction c: march the ray and look up each point at rest. */
  private castMoved(origin: Vec3, dir: Vec3, reach: number, c: number, gain: number): { voxel: [number, number, number]; distance: number } | null {
    const g = this.grid;
    const h = g.voxelMm;
    const pad = 20;
    const box = [-pad, -pad, -pad, g.nx * h + pad, g.ny * h + pad, g.nz * h + pad];
    let t0 = 0, t1 = reach;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dir[a]) < 1e-12) {
        if (origin[a] < box[a] || origin[a] > box[a + 3]) return null;
        continue;
      }
      const ta = (box[a] - origin[a]) / dir[a], tb = (box[a + 3] - origin[a]) / dir[a];
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    }
    if (t0 > t1) return null;
    const step = 0.35 * h;
    for (let t = t0; t <= t1; t += step) {
      const p: Vec3 = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t];
      const r = restPoint(this.beatFrame, p, c, gain);
      const x = Math.floor(r[0] / h), y = Math.floor(r[1] / h), z = Math.floor(r[2] / h);
      if (x < 0 || y < 0 || z < 0 || x >= g.nx || y >= g.ny || z >= g.nz) continue;
      if (g.tissue[x + g.nx * (y + g.ny * z)] !== 0) return { voxel: [x, y, z], distance: t };
    }
    return null;
  }

  /** How far along a ray it first meets the rest of the heart as drawn (moved by contraction c), or null. */
  private extraHit(origin: Vec3, dir: Vec3, c: number, gain: number): number | null {
    const m = this.extraMesh;
    if (!m) return null;
    if (Math.abs(m.movedFor - c * gain) > 0.004) {
      for (let i = 0; i < m.follow.length; i++) {
        const p: Vec3 = [m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]];
        const d = beatDisplacement(this.beatFrame, p, c * m.follow[i], gain);
        m.moved[3 * i] = p[0] + d[0];
        m.moved[3 * i + 1] = p[1] + d[1];
        m.moved[3 * i + 2] = p[2] + d[2];
      }
      m.movedFor = c * gain;
    }
    const P = m.moved;
    const I = m.indices;
    const n = this.cutNormal;
    const off = this.cutOffset();
    let best = Infinity;
    for (let k = 0; k < I.length; k += 3) {
      const a = 3 * I[k], b = 3 * I[k + 1], cc = 3 * I[k + 2];
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[cc] - P[a], e2y = P[cc + 1] - P[a + 1], e2z = P[cc + 2] - P[a + 2];
      const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const tx = origin[0] - P[a], ty = origin[1] - P[a + 1], tz = origin[2] - P[a + 2];
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t <= 0 || t >= best) continue;
      if (this.cutOn) {
        const hx = origin[0] + dir[0] * t, hy = origin[1] + dir[1] * t, hz = origin[2] + dir[2] * t;
        if (hx * n[0] + hy * n[1] + hz * n[2] - off < 0) continue;
      }
      best = t;
    }
    return best < Infinity ? best : null;
  }

  /**
   * Where a point of the heart is on the canvas, for pinning labels to it. voxel is in voxel coordinates as
   * heart-frame.json and Simulation.stimulate use them: voxel (i, j, k) is centred at (i, j, k), and a float
   * is a point in between. x and y are canvas CSS pixels from the top left, the space of pick() and onTap. The
   * point moves with the beat as the muscle is drawn.
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
    const d = beatDisplacement(this.beatFrame, p, this.shownContraction(), this.shownGain());
    const moved: Vec3 = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
    const s = projectToCanvas(gridViewProjection(this.camera, this.pose, this.pivot, this.centre, this.shift()), moved, this.cssWidth, this.cssHeight);
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
    const q = this.quality;
    // The camera lives in the display frame; the shaders work in the grid frame. Bring the eye and the
    // camera axes into the grid frame, and fold the pose and the lens shift into the view-projection for the mesh.
    const eye = this.gridEye();
    const right = rotateBack(R, [m[0], m[4], m[8]]);
    const up = rotateBack(R, [m[1], m[5], m[9]]);
    const fwd = rotateBack(R, [-m[2], -m[6], -m[10]]);
    const beat = Math.max(0, Math.min(1.5, this.look.beat));
    const fp = this.footprint;
    const bf = this.beatFrame;
    f.set(gridViewProjection(cam, R, this.pivot, this.centre, shift), 0);
    f.set([eye[0], eye[1], eye[2], now / 1000], 16);
    f.set([right[0], right[1], right[2], tanHalf * cam.aspect], 20);
    f.set([up[0], up[1], up[2], tanHalf], 24);
    f.set([fwd[0], fwd[1], fwd[2], cam.near], 28);
    f.set([this.sx, this.sy, this.sz, h], 32);
    f.set([this.targets?.width ?? 1, this.targets?.height ?? 1, cam.far, this.frameNo], 36);
    f.set([this.cutNormal[0], this.cutNormal[1], this.cutNormal[2], this.cutOffset()], 40);
    // how much the browser will scale the picture up to the screen, and so how much to sharpen it
    const upscale = (this.cssWidth * this.dpr) / Math.max(1, this.targets?.width ?? 1);
    f.set([this.cutOn ? 1 : 0, q.steps, Math.min(0.35, Math.max(0, (upscale - 1.05) * 1.0)), q.detail], 44);
    f.set([this.pivot[0], this.pivot[1], this.pivot[2], this.floorH], 48);
    f.set([this.floorUp[0], this.floorUp[1], this.floorUp[2], shift[1]], 52);
    f.set([this.look.bloom, this.look.exposure, this.look.glow, this.look.debug], 56);
    f.set([-h, -h, -h, shift[0]], 60);
    f.set([(this.sx - 1) * h, (this.sy - 1) * h, (this.sz - 1) * h, 1 / this.sim.count], 64);
    f.set([bf.apex[0], bf.apex[1], bf.apex[2], bf.height], 68);
    // While the heart is cut open the muscle moves with its mean contraction, so the cut face (mapped back with that
    // mean) meets the surfaces; a cut that removes nothing yet changes nothing.
    const cutIn = this.cutOn ? Math.min(1, Math.max(0, (this.cutDepth + 0.92) / 0.3)) : 0;
    f.set([bf.axis[0], bf.axis[1], bf.axis[2], 1 - cutIn * cutIn * (3 - 2 * cutIn)], 72);
    f.set([this.anterior[0], this.anterior[1], this.anterior[2], beat], 76);
    f.set([this.leftward[0], this.leftward[1], this.leftward[2], q.taps], 80);
    f.set([this.centroid[0], this.centroid[1], this.centroid[2], 0], 84);
    f.set([fp.a[0], fp.a[1], fp.a[2], fp.ha], 88);
    f.set([fp.b[0], fp.b[1], fp.b[2], fp.hb], 92);
    f.set([fp.c[0], fp.c[1], fp.c[2], 0], 96);
    f.set(this.cutOn ? this.cutSection() : [0, 0, 1, 1], 100);
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
            { binding: 3, resource: { buffer: this.cellsBuf } },
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
   * voxel (u, trend, contraction, density), x fastest, in the solver's padded layout. Slow: for tests.
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

  /** The muscle's mean contraction, 0 relaxed .. 1 all contracted, as last read back from the GPU (a frame or two late). */
  get meanContraction(): number {
    return this.contraction;
  }

  /**
   * Show a shock now: a brief warm flush over the whole heart that fades together, the heart held still meanwhile. The
   * renderer does this by itself, on the GPU, in the frame it sees most of the muscle excited at once (which only a
   * whole-heart shock does); calling this is only needed to show one without that.
   */
  flash(): void {
    if (this.destroyed) return;
    this.device.queue.writeBuffer(this.statsBuf, 12, new Float32Array([0]));
    this.shockAge = { age: 0, at: performance.now() };
  }

  /** How strongly the whole-heart squeeze moves the heart now, as the CPU knows it (for pick and project). */
  private shownGain(): number {
    const age = this.shockAge.age + (performance.now() - this.shockAge.at) / 1000;
    return squeezeGate(this.shownContraction()) * shockLook(age).still;
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
      const keep = Math.exp(-dt / 0.45);
      this.spin = { x: this.spin.x * keep, y: this.spin.y * keep };
    } else if (this.autoRotate && !this.dragging) {
      this.camera.yaw += AUTO_ROTATE_SPEED * dt;
    } else {
      this.sway(now, dt);
    }
    this.writeFrame(now);
    // the contraction's lag: how far it moves toward its target this frame, up and down
    const dims = this.dimsData;
    new Uint32Array(dims, 0, 3).set([this.sx, this.sy, this.cellCount]);
    new Float32Array(dims, 12, 4).set([8, 1 - Math.exp(-dt / BEAT.riseS), 1 - Math.exp(-dt / BEAT.fallS), dt]);
    new Uint32Array(dims, 28, 1).set([this.sim.count]);
    this.device.queue.writeBuffer(this.dimsBuf, 0, dims);

    const device = this.device;
    const enc = device.createCommandEncoder();

    // 1. voltage buffer -> 3D texture, with the contraction (the buffer changes as the solver steps, so ask every frame)
    const prev = this.last as 0 | 1;
    const next = (1 - prev) as 0 | 1;
    enc.clearBuffer(this.statsBuf, 0, 12); // stats[3] carries over: the time since the last shock
    const cp = enc.beginComputePass();
    cp.setPipeline(this.voltPipeline);
    cp.setBindGroup(0, this.voltBind(this.sim.voltageBuffer(), prev));
    cp.dispatchWorkgroups(Math.ceil(this.cellCount / 64));
    cp.setPipeline(this.settlePipeline);
    cp.setBindGroup(0, this.settleBind);
    cp.dispatchWorkgroups(1);
    cp.end();
    this.last = next;

    // 2. the heart and its studio, multisampled, resolved into the HDR picture
    const multi = t.samples > 1;
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: t.colourView, resolveTarget: multi ? t.sceneView : undefined, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: multi ? "discard" : "store" }],
      depthStencilAttachment: { view: t.depthView, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard", stencilClearValue: 0, stencilLoadOp: "clear", stencilStoreOp: "discard" },
    });
    const P = t.pipelines;
    pass.setPipeline(P.vent);
    pass.setBindGroup(0, this.heartBinds[next]);
    this.ventBuffers.forEach((b, i) => pass.setVertexBuffer(i, b));
    pass.setIndexBuffer(this.ventIndex, "uint32");
    pass.drawIndexed(this.ventCount);
    if (P.tube && this.tubeBuffers && this.tubeIndex) {
      pass.setPipeline(P.tube);
      this.tubeBuffers.forEach((b, i) => pass.setVertexBuffer(i, b));
      pass.setIndexBuffer(this.tubeIndex, "uint32");
      pass.drawIndexed(this.tubeCount);
    }
    if (P.extra && this.extraBuffers && this.extraIndex) {
      pass.setPipeline(P.extra);
      this.extraBuffers.forEach((b, i) => pass.setVertexBuffer(i, b));
      pass.setIndexBuffer(this.extraIndex, "uint32");
      pass.drawIndexed(this.extraCount);
    }
    if (this.cutOn) {
      const surfaces = (vent: GPURenderPipeline, extra: GPURenderPipeline | null) => {
        pass.setPipeline(vent);
        this.ventBuffers.forEach((b, i) => pass.setVertexBuffer(i, b));
        pass.setIndexBuffer(this.ventIndex, "uint32");
        pass.drawIndexed(this.ventCount);
        if (extra && this.extraBuffers && this.extraIndex) {
          pass.setPipeline(extra);
          this.extraBuffers.forEach((b, i) => pass.setVertexBuffer(i, b));
          pass.setIndexBuffer(this.extraIndex, "uint32");
          pass.drawIndexed(this.extraCount);
        }
      };
      surfaces(P.parity.ventFat, P.parity.extraFat);
      surfaces(P.parity.ventBare, P.parity.extraBare);
      pass.setBindGroup(0, this.sceneBinds[next]);
      pass.setStencilReference(3);
      pass.setPipeline(P.cut);
      pass.draw(6);
      pass.setStencilReference(1);
      pass.setPipeline(P.cutFat);
      pass.draw(6);
    }
    pass.setBindGroup(0, this.sceneBinds[next]);
    pass.setPipeline(P.back);
    pass.draw(3);
    pass.end();

    const fullscreen = (pipeline: GPURenderPipeline, bind: GPUBindGroup, view: GPUTextureView, load: GPULoadOp = "clear") => {
      const p = enc.beginRenderPass({ colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: load, storeOp: "store" }] });
      p.setPipeline(pipeline);
      p.setBindGroup(0, bind);
      p.draw(3);
      p.end();
    };
    // 3. bloom
    for (const b of t.bloom) fullscreen(b.pipeline, b.bind, b.target, b.additive ? "load" : "clear");
    // 4. tone map, grade and grain onto the canvas
    fullscreen(this.finalPipeline, t.finalBind, screen);

    // the mean contraction back to the CPU for pick() and project(), one read at a time, never waited for
    const readNow = !this.statsPending;
    if (readNow) enc.copyBufferToBuffer(this.statsBuf, 0, this.statsRead, 0, 16);
    device.queue.submit([enc.finish()]);
    this.frameNo++;
    if (readNow) {
      this.statsPending = true;
      const gain = Math.max(0, Math.min(1.5, this.look.beat));
      this.statsRead
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          if (this.destroyed) return;
          const s = new Uint32Array(this.statsRead.getMappedRange(0, 16).slice(0));
          this.statsRead.unmap();
          this.contraction = Math.min(1, s[1] / 1024 / this.sim.count) * gain;
          this.shockAge = { age: new Float32Array(s.buffer, 12, 1)[0], at: performance.now() };
          this.statsPending = false;
        })
        .catch(() => {
          this.statsPending = false;
        });
    }
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

/** Each vertex's neighbours along the mesh's edges. */
function neighbourLists(surface: HeartSurface): number[][] {
  const V = surface.positions.length / 3;
  const out: number[][] = Array.from({ length: V }, () => []);
  const I = surface.indices;
  for (let k = 0; k < I.length; k += 3)
    for (let e = 0; e < 3; e++) {
      const a = I[k + e], b = I[k + ((e + 1) % 3)];
      if (!out[a].includes(b)) out[a].push(b);
      if (!out[b].includes(a)) out[b].push(a);
    }
  return out;
}

/** A per-vertex field relaxed toward the mean of its neighbours a few times: its level lines no longer zigzag along the triangles. */
function smoothField(surface: HeartSurface, f: Float32Array, iterations: number): Float32Array {
  const nb = neighbourLists(surface);
  let a = Float32Array.from(f);
  let b = new Float32Array(f.length);
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < a.length; v++) {
      const list = nb[v];
      if (list.length === 0) {
        b[v] = a[v];
        continue;
      }
      let sum = 0;
      for (const w of list) sum += a[w];
      b[v] = 0.5 * a[v] + (0.5 * sum) / list.length;
    }
    [a, b] = [b, a];
  }
  return a;
}

/**
 * The gradient along the surface of a per-vertex field, per vertex (area-weighted over the triangles round it), so
 * the shaders can tilt normals across the grooves' vessels smoothly instead of triangle by triangle.
 */
function surfaceGradient(surface: HeartSurface, f: Float32Array): Float32Array {
  const P = surface.positions;
  const I = surface.indices;
  const g = new Float32Array(P.length);
  for (let k = 0; k < I.length; k += 3) {
    const i0 = I[k], i1 = I[k + 1], i2 = I[k + 2];
    const p0: Vec3 = [P[3 * i0], P[3 * i0 + 1], P[3 * i0 + 2]];
    const p1: Vec3 = [P[3 * i1], P[3 * i1 + 1], P[3 * i1 + 2]];
    const p2: Vec3 = [P[3 * i2], P[3 * i2 + 1], P[3 * i2 + 2]];
    const nn = cross3(sub(p1, p0), sub(p2, p0));
    const twiceArea = Math.hypot(nn[0], nn[1], nn[2]);
    if (twiceArea < 1e-9) continue;
    const N: Vec3 = [nn[0] / twiceArea, nn[1] / twiceArea, nn[2] / twiceArea];
    // grad f = sum f_i (N x e_i) / 2A, e_i the edge opposite vertex i, counterclockwise
    const g0 = cross3(N, sub(p2, p1)), g1 = cross3(N, sub(p0, p2)), g2 = cross3(N, sub(p1, p0));
    // weighted by area, the sum over a vertex's triangles is (grad * 2A) / 2
    for (let a = 0; a < 3; a++) {
      const grad = (f[i0] * g0[a] + f[i1] * g1[a] + f[i2] * g2[a]) / twiceArea;
      const w = twiceArea;
      g[3 * i0 + a] += grad * w;
      g[3 * i1 + a] += grad * w;
      g[3 * i2 + a] += grad * w;
    }
  }
  const Nv = surface.normals;
  for (let v = 0; v < P.length / 3; v++) {
    const n: Vec3 = [Nv[3 * v], Nv[3 * v + 1], Nv[3 * v + 2]];
    const d: Vec3 = [g[3 * v], g[3 * v + 1], g[3 * v + 2]];
    const along = dot3(d, n);
    const t: Vec3 = [d[0] - along * n[0], d[1] - along * n[1], d[2] - along * n[2]];
    const len = Math.hypot(t[0], t[1], t[2]);
    // a distance field changes by 1 mm per mm: keep the direction, and the size where it is sensible
    const k = len > 1e-9 ? Math.min(1.5, len) / len : 0;
    const total = t.map((x) => x * k);
    g.set(total, 3 * v);
  }
  return g;
}
