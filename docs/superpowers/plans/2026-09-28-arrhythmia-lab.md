# Arrhythmia Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A free browser lab where a live GPU simulation of a real 3D heart produces spiral waves, fibrillation and a computed 12-lead ECG, with guided lessons and a Shock button.

**Architecture:** An offline tool turns one real heart into a small grid file. A pure-TypeScript reference model of the cardiac cells is the truth that a WebGPU compute solver is tested against. Voltage on the GPU feeds both an ECG computation and a raymarched renderer. UI and lessons only drive the same controls a user has.

**Tech Stack:** TypeScript, Vite, Vitest, raw WebGPU (WGSL), Playwright (headless Chromium with WebGPU) for GPU tests, Python 3 with numpy/scipy/meshio for the offline tool, Cloudflare Pages.

## Global Constraints

- WebGPU only. No WebGL2 solver. Browsers without WebGPU get a fallback page with a recorded clip.
- Free tier only: static site on Cloudflare Pages, no backend, no live model calls, no paid services.
- Educational simulation. Never a medical device. No uploads of ECGs, scans or labs. No patient-specific numbers. Idealized tissue only.
- A visible banner on the app: "Educational simulation. Not a medical device."
- Real-ECG panel caption, verbatim: "Recorded ECGs are shown for visual comparison only. This is an educational simulation, not a medical device and not a diagnostic tool."
- Footer, verbatim: "Built with Claude Sonnet 5.5. Not affiliated with Anthropic." No Claude logo. No "Claude" in the app name (working name: Arrhythmia Lab).
- Credits, visible in the app: "Heart geometry: Strocchi et al., CC BY 4.0." and "Recorded ECGs: PTB-XL, CC BY 4.0."
- Model equations are implemented from the published papers (Bueno-Orovio, Cherry, Fenton 2008, J Theor Biol 253:544) and cited. No GPL code is copied (do not port ECGSYN).
- All authored by Claude Sonnet 5.5. Subagents must run on Sonnet 5.5. Maximum 3 subagents at once.
- Nothing private in the repo: no personal names, no private folder paths, no AI session or thread IDs. Run `~/RamenProtocol/_ops/infra/privacy-check.sh` before every push.
- Cloudflare Pages limits: at most 20,000 files, at most 25 MiB per file. Target well under 10 MiB of data in total.
- Commits: identity is already ramenprotokol. End each commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Receipts: append one line per task to `docs/receipts.md` (task, start time, end time, subagent used or not). These back the public "designed, built and tested by Sonnet 5.5" claim.

## File Structure

```
arrhythmia-lab/
  package.json, tsconfig.json, vite.config.ts, index.html, eslint config
  tools/                       offline only, never shipped
    fetch_heart.sh             downloads one Strocchi heart
    build_heart.py             mesh -> heart.bin + heart-surface.bin
    build_ecg_samples.py       PTB-XL records -> public/data/ecg-samples.json
    README.md                  how to rerun
  public/data/
    heart.bin, heart-surface.bin, ecg-samples.json, credits.json
    demo.webm                  fallback clip (made late)
  src/
    main.ts                    boot: WebGPU check, load data, start app
    fallback.ts                no-WebGPU page
    data/loadHeart.ts          parse heart.bin / heart-surface.bin
    model/params.ts            BOCF parameter sets (endo, mid, epi)
    model/bocf.ts              CPU reference: one cell step, plus sheet solver
    sim/sheet.wgsl             2D solver kernel (first target)
    sim/heart.wgsl             3D anisotropic solver kernel
    sim/Simulation.ts          GPU orchestration: step, stimulate, shock, setTissue
    ecg/ecg.wgsl               lead reduction kernel
    ecg/Ecg.ts                 12-lead assembly and readback
    render/                    surface shell, raymarch, slice, bloom
    ui/                        controls, sliders, ECG monitor, lessons, recorder, banner
    lessons/lessons.ts         scripted scenarios
  tests/                       vitest (CPU) and playwright (GPU) tests
  docs/receipts.md
```

## Parallel groups (max 3 subagents at once)

- Group A (independent, start immediately): Task 2 (CPU model), Task 3 (data pipeline), Task 12 (ECG sample data).
- Group B (after Task 1 and Task 4): Task 5 (sheet solver) with Task 8 (renderer against a fake voltage texture).
- Everything else runs in sequence.

---

### Task 1: Scaffold, WebGPU check and headless GPU test spike

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts`, `src/fallback.ts`, `tests/gpu/spike.test.ts`, `playwright.config.ts`
- Test: `tests/gpu/spike.test.ts`

**Interfaces:**
- Produces: `hasWebGPU(): Promise<boolean>` exported from `src/main.ts`; npm scripts `dev`, `build`, `typecheck`, `lint`, `test` (vitest, CPU), `test:gpu` (playwright).

- [ ] **Step 1:** `npm init`, add vite, typescript, vitest, `@webgpu/types`, eslint, typescript-eslint, playwright. Set `"test": "vitest run"`, `"test:gpu": "playwright test"`, `"typecheck": "tsc --noEmit"`, `"build": "tsc --noEmit && vite build"`.
- [ ] **Step 2:** Write the spike test: launch Chromium with `--enable-unsafe-webgpu --use-angle=metal` (also try `--enable-features=Vulkan` if needed), open a blank page, run a compute shader that writes 1..64 into a buffer, read it back, assert equality.
- [ ] **Step 3:** Run `npm run test:gpu`. If headless WebGPU fails after two flag attempts, switch the GPU tests to headed Chromium and record the finding in `docs/receipts.md`. Expected: PASS with a real adapter.
- [ ] **Step 4:** Implement `hasWebGPU()` (`navigator.gpu` present and `requestAdapter()` non-null) and render `fallback.ts` when false.
- [ ] **Step 5:** Run `npm run typecheck && npm run lint && npm test && npm run build`. Commit: `feat: scaffold, WebGPU check, GPU test spike`.

### Task 2: CPU reference model (Bueno-Orovio-Cherry-Fenton)

**Files:**
- Create: `src/model/params.ts`, `src/model/bocf.ts`, `tests/model/bocf.test.ts`

**Interfaces:**
- Produces: `type Params`, `EPI: Params`, `ENDO: Params`, `MID: Params`; `type Cell = { u: number; v: number; w: number; s: number }`; `restingCell(): Cell`; `stepCell(c: Cell, p: Params, dt: number, iStim: number): Cell` (dt in ms; returns a new cell); `measureApd90(p: Params): number` (ms).

Equations (from the 2008 paper; the implementer MUST confirm every constant against the paper's parameter table or the authors' reference code before trusting them, and record the source in `params.ts`). H is the Heaviside step (1 when its argument is >= 0):

```
J_fi = -v * H(u-θv) * (u-θv) * (uu-u) / τfi
J_so = (u-uo) * (1-H(u-θw)) / τo + H(u-θw) / τso
J_si = -H(u-θw) * w * s / τsi
dv/dt = (1-H(u-θv)) * (v∞-v)/τv⁻ - H(u-θv) * v/τv⁺
dw/dt = (1-H(u-θw)) * (w∞-w)/τw⁻ - H(u-θw) * w/τw⁺
ds/dt = ((1+tanh(ks*(u-us)))/2 - s) / τs
du/dt = -(J_fi + J_so + J_si) + iStim          (diffusion term added by the solver)
τv⁻ = (1-H(u-θv⁻))*τv1⁻ + H(u-θv⁻)*τv2⁻
τw⁻ = τw1⁻ + (τw2⁻-τw1⁻)*(1+tanh(kw⁻*(u-uw⁻)))/2
τso = τso1 + (τso2-τso1)*(1+tanh(kso*(u-uso)))/2
τs  = (1-H(u-θw))*τs1 + H(u-θw)*τs2
τo  = (1-H(u-θo))*τo1 + H(u-θo)*τo2
v∞ = 1 if u<θv⁻ else 0
w∞ = (1-H(u-θo))*(1-u/τw∞) + H(u-θo)*w∞*
```

- [ ] **Step 1: Write failing tests** in `tests/model/bocf.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EPI, restingCell, stepCell, measureApd90 } from "../../src/model/bocf";

describe("BOCF cell", () => {
  it("stays at rest with no stimulus", () => {
    let c = restingCell();
    for (let i = 0; i < 20000; i++) c = stepCell(c, EPI, 0.05, 0);
    expect(Math.abs(c.u)).toBeLessThan(1e-3);
  });
  it("fires an action potential when stimulated, then recovers", () => {
    let c = restingCell(), peak = 0;
    for (let i = 0; i < 40000; i++) {
      c = stepCell(c, EPI, 0.05, i * 0.05 < 1 ? 1 : 0); // 1 ms stimulus
      peak = Math.max(peak, c.u);
    }
    expect(peak).toBeGreaterThan(1.0);
    expect(Math.abs(c.u)).toBeLessThan(0.02);
  });
  it("gives an action potential duration in the physiological range", () => {
    const apd = measureApd90(EPI);
    expect(apd).toBeGreaterThan(200);
    expect(apd).toBeLessThan(400);
  });
  it("does not fire below threshold", () => {
    let c = restingCell(), peak = 0;
    for (let i = 0; i < 4000; i++) {
      c = stepCell(c, EPI, 0.05, i * 0.05 < 1 ? 0.02 : 0);
      peak = Math.max(peak, c.u);
    }
    expect(peak).toBeLessThan(0.3);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/model`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `params.ts` and `bocf.ts` from the equations above with explicit Euler. Resting cell is `{u:0, v:1, w:1, s:0}`. Implement `measureApd90` by pacing one action potential and timing the interval from upstroke to 90% repolarisation. Add a comment citing Bueno-Orovio, Cherry, Fenton (2008).
- [ ] **Step 4:** Run tests. If the APD range fails, first re-check the constants against the paper, do not widen the test range to make it pass. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: CPU reference model for cardiac cells`.

### Task 3: Offline data pipeline (real heart to small grid)

**Files:**
- Create: `tools/fetch_heart.sh`, `tools/build_heart.py`, `tools/README.md`, `tests/data/heart-format.test.ts`
- Output: `public/data/heart.bin`, `public/data/heart-surface.bin`, `public/data/credits.json`

**Interfaces:**
- Produces the binary format read by Task 4. Write the exact layout in `tools/README.md` and in `src/data/loadHeart.ts` comments so both sides match.
  - `heart.bin`: header (magic `HRT1`, uint32 nx, ny, nz, float32 voxelSizeMm), then per voxel: uint8 tissue (0 = outside, 1 = endo, 2 = mid, 3 = epi), then three int8 fibre-direction components scaled by 127. Gzip is handled by the server, not the file.
  - `heart-surface.bin`: magic `SRF1`, uint32 vertexCount, uint32 indexCount, float32 positions, float32 normals, uint32 indices, all in the same millimetre coordinates as the grid.

- [ ] **Step 1:** `fetch_heart.sh` downloads one archive (`zenodo.org/records/3890034`, file `01.tar.gz` or the smallest that lists as one heart, about 1 GB) into `~/heart-data/` outside the repo, extracts it, and prints the file list. Never commit raw data.
- [ ] **Step 2:** Inspect the extracted files and record the actual format (VTK, CARP or other), the tissue labels and whether fibre directions are per element. Write findings in `tools/README.md`. Adapt Step 3 to the real format.
- [ ] **Step 3:** `build_heart.py`: read the mesh, keep only ventricular muscle (drop atria, vessels, valves), voxelise at about 1 mm, compute the wall layer (endo/mid/epi) from distance to the inner cavity and outer surface, transfer fibre directions, write `heart.bin`. Extract and smooth the outer surface, decimate to about 40,000 triangles, write `heart-surface.bin`. Write `credits.json` with the dataset title, authors, licence (CC BY 4.0) and record URL.
- [ ] **Step 4:** Write a vitest that reads the produced files and asserts: magic bytes, total size under 8 MiB, muscle voxel count between 100,000 and 2,000,000, every fibre vector has length between 0.9 and 1.1 after decoding, surface indices all below vertexCount.
- [ ] **Step 5:** Run `npx vitest run tests/data`. Expected: PASS. Commit tools and the small data files: `feat: heart data pipeline and processed heart`.

### Task 4: Browser data loader

**Files:**
- Create: `src/data/loadHeart.ts`, `tests/data/loadHeart.test.ts`

**Interfaces:**
- Consumes: the binary formats from Task 3.
- Produces: `type HeartGrid = { nx: number; ny: number; nz: number; voxelMm: number; tissue: Uint8Array; fibre: Int8Array }`; `type HeartSurface = { positions: Float32Array; normals: Float32Array; indices: Uint32Array }`; `loadHeart(url: string): Promise<HeartGrid>`; `loadSurface(url: string): Promise<HeartSurface>`.

- [ ] **Step 1:** Write tests that build a tiny in-memory `HRT1` buffer by hand and assert the parsed fields, plus one that rejects a bad magic number.
- [ ] **Step 2:** Run, expect FAIL. Implement the parsers. Run, expect PASS.
- [ ] **Step 3:** Commit: `feat: heart data loader`.

### Task 5: GPU solver on a 2D sheet (first target)

**Files:**
- Create: `src/sim/sheet.wgsl`, `src/sim/SheetSim.ts`, `tests/gpu/sheet.test.ts`

**Interfaces:**
- Consumes: `EPI`, `stepCell` from Task 2.
- Produces: `class SheetSim { constructor(device: GPUDevice, n: number); step(steps: number): void; stimulate(x: number, y: number, r: number): void; shock(): void; readU(): Promise<Float32Array> }`. Diffusion uses a 5-point stencil with a diffusion coefficient `D` and grid spacing `dx`, explicit time step `dt` satisfying `dt <= dx*dx / (4*D)`; the class throws if the caller violates it.

- [ ] **Step 1:** Write a Playwright test: a 64x64 sheet, stimulate the centre, run 200 ms of simulated time, run the same on the CPU (Task 2 model plus a matching CPU diffusion loop written in the test helper), assert the mean absolute difference of `u` is below 0.02 and the wavefront radius matches within one cell.
- [ ] **Step 2:** Run `npm run test:gpu`. Expected: FAIL.
- [ ] **Step 3:** Implement the WGSL kernel (ping-pong storage buffers, one thread per cell, all four state variables in the buffer) and the class. Add a test that a cross-field stimulus (S1-S2 protocol) produces a spiral: after 600 ms, the number of cells with `u > 0.5` is between 1% and 40% and is still nonzero at 1000 ms.
- [ ] **Step 4:** Run, expect PASS. Commit: `feat: GPU solver on a 2D sheet`.

### Task 6: 3D anisotropic solver on the heart grid

**Files:**
- Create: `src/sim/heart.wgsl`, `src/sim/Simulation.ts`, `tests/gpu/heart.test.ts`

**Interfaces:**
- Consumes: `HeartGrid` from Task 4, the model from Task 2.
- Produces (as built): `class Simulation { static create(device: GPUDevice, grid: HeartGrid, opts?: { dt?: number; dPar?: number; dPerp?: number; reaction?: boolean }): Promise<Simulation>; layout: { nx, ny, nz, sx, sy, sz, voxelMm }; step(ms: number): void; stimulate(voxel: [number, number, number], radiusMm: number, opts?: { amp?: number; ms?: number }): void; shock(): void; setTissue(t: { conduction?: number; recovery?: number }): void; writeVoltage(u: Float32Array): void; voltageBuffer(): GPUBuffer; readU(): Promise<Float32Array>; readGates(): Promise<Float32Array> }`. Always build through `create`, which throws if the shader fails to compile (a broken shader otherwise makes every dispatch silently do nothing). The voltage lives in a dense f32 buffer padded by one empty voxel on every side (indexes use `layout.sx`, `layout.sy`), and the buffer changes as the simulation steps, so the renderer asks for `voltageBuffer()` every frame and copies it into a 3D texture itself.
  - Wave spread: diffusion tensor `D = D_perp * I + (D_par - D_perp) * f fᵀ` where `f` is the voxel's fibre direction, computed with a 27-point or 7-point stencil that respects the muscle mask (no-flux at the boundary). Tissue layer chooses the parameter set (ENDO, MID, EPI).
  - Stability: `step()` splits `ms` into sub-steps with `dt <= min(0.05, dx*dx / (6*D_par_max))`.

- [ ] **Step 0 (max effort for this task's diffusion design):** Compute diffusion as fluxes across cell FACES, not by zeroing non-muscle neighbours. Any flux that crosses the muscle mask is set to exactly zero, including the cross-fibre (off-diagonal) terms that reach diagonal neighbours. Zeroing neighbours instead leaks or injects current at the tissue edge and creates fake waves that look like fibrillation. Check `dt` against the explicit stability limit using the LARGEST diffusion value, not the average.
- [ ] **Step 1:** Write tests on a small synthetic grid (a 32x32x32 block with uniform fibres along x): the wave speed along x must exceed the speed along y by a factor between 1.5 and 4; a stimulus outside the mask does nothing; `shock()` sets `u` to 0 everywhere and resets gating variables to rest. Conservation test: with diffusion only (reaction switched off), a closed jagged mask with an uneven initial `u` and no stimulus must keep the total of `u` constant to within 1e-6 relative, on a mask with concave corners and oblique fibres. Also run it on the real heart mask.
- [ ] **Step 2:** Run, expect FAIL. Implement kernel and class. Run, expect PASS.
- [ ] **Step 3:** Load the real heart in a test, stimulate the apex, and assert the wave reaches the base within 60 to 200 ms of simulated time (a physiologically plausible activation time) and that the run holds at least 30 steps of 1 ms per second of real time on this machine (record the number in `docs/receipts.md`).
- [ ] **Step 4:** Commit: `feat: 3D anisotropic heart solver`.

### Task 7: Arrhythmia behaviours (tuning)

**Files:**
- Create: `tests/gpu/arrhythmia.test.ts`; Modify: `src/model/params.ts`, `src/sim/Simulation.ts`

- [ ] **Step 1:** Write tests on the real heart: (a) a normal paced beat activates all tissue and ends with `u` near 0; (b) an S1-S2 premature stimulus inside the vulnerable window starts a wave that is still active 2000 ms later (re-entry); (c) with reduced recovery time (slider) that activity breaks into at least 3 separate wavefronts (fibrillation-like); (d) `shock()` ends all activity within 500 ms.
- [ ] **Step 2:** Run, expect FAIL where tuning is needed. Adjust the tissue slider ranges and the S2 timing window (not the test thresholds) until all pass. Document the working values and the slider limits in `docs/receipts.md`.
- [ ] **Step 3:** Commit: `feat: tuned arrhythmia behaviours`.

### Task 8: ECG computation

**Files:**
- Create: `src/ecg/ecg.wgsl`, `src/ecg/Ecg.ts`, `tests/gpu/ecg.test.ts`

**Interfaces:**
- Consumes: `Simulation.voltageBuffer()`, `HeartGrid`.
- Produces: `class Ecg { constructor(device: GPUDevice, sim: Simulation, grid: HeartGrid); sample(): Promise<Float32Array> }` returning 12 values in the order I, II, III, aVR, aVL, aVF, V1 to V6. Electrodes: limb leads at the two shoulders and the left hip, chest leads at standard positions relative to the heart's centre and axis (constants in `src/ecg/electrodes.ts`, with a comment that positions are idealised). Each electrode signal is the sum over muscle voxels of `∇u · ∇(1/r)`, then the standard lead combinations.

- [ ] **Step 1:** Write tests: after a normal paced beat from the apex, lead II shows a positive QRS deflection followed by a T wave of the same sign (record a 400 ms window, assert max above min magnitude and the T sign); aVR is opposite to lead II in sign; the sum I + III equals II within 1e-3 (Einthoven's law); flat before any stimulus.
- [ ] **Step 2:** Run, expect FAIL. Implement. Run, expect PASS. If the QRS polarity is inverted, fix the electrode positions or the sign convention, not the test.
- [ ] **Step 3:** Commit: `feat: live 12-lead ECG`.

### Task 9: Renderer

**Files:**
- Create: `src/render/Renderer.ts`, `src/render/shell.wgsl`, `src/render/volume.wgsl`, `src/render/bloom.wgsl`, `src/render/camera.ts`, `tests/render/camera.test.ts`

**Interfaces:**
- Consumes: `Simulation.voltageTexture()`, `HeartSurface`, `HeartGrid`.
- Produces: `class Renderer { constructor(canvas: HTMLCanvasElement, device: GPUDevice, surface: HeartSurface, grid: HeartGrid, volume: GPUTexture); frame(): void; setCutaway(on: boolean, depth: number): void; pick(x: number, y: number): [number, number, number] | null }`.
- Look: anatomical shell with soft lighting, voltage sampled onto the shell, a raymarched glow through the muscle wall, optional cutaway plane, bloom. Orbit camera with pointer drag and pinch or wheel zoom.

- [ ] **Step 1:** Write camera-math unit tests (orbit clamps, zoom limits, ray from a pixel). Run, expect FAIL. Implement `camera.ts`. Run, expect PASS.
- [ ] **Step 2:** Build the shell pass first and check it against a fake voltage texture (a moving sphere) with screenshots. Then the volume glow pass, then bloom.
- [ ] **Step 3:** `pick()` casts a ray against the grid and returns the first muscle voxel; test it on the synthetic block.
- [ ] **Step 4:** Take screenshots at 1440x900 and 390x844 with Playwright and view them. Fix anything unreadable. Commit: `feat: WebGPU renderer`.

### Task 10: UI, controls and lessons

**Files:**
- Create: `src/ui/App.ts`, `src/ui/controls.ts`, `src/ui/monitor.ts`, `src/ui/lessons.ts`, `src/lessons/lessons.ts`, `src/ui/banner.ts`, `src/ui/credits.ts`, `src/style.css`, `tests/ui/lessons.test.ts`

**Interfaces:**
- Consumes: `Simulation`, `Ecg`, `Renderer`.
- Produces: `type Lesson = { id: string; title: string; steps: { text: string; action?: (api: LabApi) => void; waitFor?: (api: LabApi) => boolean }[] }`; `type LabApi = { pace(voxel: [number, number, number]): void; prematureBeat(): void; shock(): void; setTissue(t: { conduction: number; recovery: number }): void; activeFraction(): number }`.
- Lessons: Normal beat; Extra beat (PVC); Sustained tachycardia; Break into fibrillation; Shock it back. Each is plain English at a general-reader level.

- [ ] **Step 1:** Write a lesson-runner unit test with a fake `LabApi`: steps advance when `waitFor` is true, and each lesson ends. Run, expect FAIL. Implement. Run, expect PASS.
- [ ] **Step 2:** Build the layout: canvas centre, monitor-style ECG panel bottom, lessons panel side, tissue sliders (conduction, recovery) with idealised-tissue labels, Shock button, cutaway toggle, pointer tap to pace, the banner, the credits, the footer line. All required copy comes verbatim from Global Constraints.
- [ ] **Step 3:** Screenshot desktop and phone. Fix layout problems. Commit: `feat: UI, controls and guided lessons`.

### Task 11: Record-a-clip button

**Files:**
- Create: `src/ui/recorder.ts`, `tests/ui/recorder.test.ts`

**Interfaces:**
- Produces: `class ClipRecorder { constructor(canvas: HTMLCanvasElement); start(): void; stop(): Promise<Blob> }`, using `canvas.captureStream(60)` and `MediaRecorder` with `video/webm`. A button toggles it and downloads the file. No upload anywhere.

- [ ] **Step 1:** Test with a stubbed `MediaRecorder` that `start` then `stop` returns a Blob of type `video/webm` and rejects if `stop` is called twice. Run, expect FAIL, implement, expect PASS.
- [ ] **Step 2:** Verify in a real browser that a 3-second clip downloads and plays. Commit: `feat: record-a-clip button`.

### Task 12: Real ECG comparison data and panel

**Files:**
- Create: `tools/build_ecg_samples.py`, `public/data/ecg-samples.json`, `src/ui/compare.ts`, `tests/data/ecg-samples.test.ts`

**Interfaces:**
- Produces: `ecg-samples.json`: `{ samples: [{ id, label, lead: "II", fs: number, mv: number[] }], source: "PTB-XL", licence: "CC BY 4.0", url: string }` with 4 labelled examples (normal sinus rhythm, premature ventricular beats, ventricular tachycardia if a clean record exists in PTB-XL or MIT-BIH, otherwise omit it and note why). Downsample to at most 250 samples per second and 5 seconds per sample so the file is under 200 KB.

- [ ] **Step 1:** Download only the specific records needed from PhysioNet (not the whole dataset). Choose records by their published diagnostic labels, and write the record IDs and labels into `tools/README.md`.
- [ ] **Step 2:** Write the vitest for the JSON shape and size. Run, expect FAIL, build the file, expect PASS.
- [ ] **Step 3:** Build the comparison panel: a toggle shows the recorded trace beside the simulated lead II, always with the verbatim caption from Global Constraints. Commit: `feat: recorded ECG comparison with disclaimer`.

### Task 13: Fallback page and demo clip

**Files:**
- Modify: `src/fallback.ts`; Create: `public/data/demo.webm`

- [ ] **Step 1:** Fallback text explains which browsers work (Chrome, Edge, Safari 26, Firefox on Windows and Apple-silicon Macs) and plays `demo.webm`.
- [ ] **Step 2:** Record the demo clip with the built-in recorder once Task 11 is done. Keep it under 3 MiB. Commit.

### Task 14: Performance, phone and full QA

- [ ] **Step 1:** Add a quality setting that halves grid resolution for weaker GPUs (auto-detected by a 1-second frame-time probe). Test that both quality levels still pass the Task 6 and Task 7 tests.
- [ ] **Step 2:** Run everything: `npm run typecheck && npm run lint && npm test && npm run test:gpu && npm run build`. Record results in `docs/receipts.md`.
- [ ] **Step 3:** Drive the built site in a real browser through every lesson and control, screenshot at desktop and phone size, check the console for errors, and confirm the total shipped size and the biggest file are under the Cloudflare limits.
- [ ] **Step 4:** Commit: `test: full QA pass`.

### Task 15: README, privacy gate, deploy

- [ ] **Step 1:** `README.md`: what it is, the safety framing, how it works in plain English, how to run, data sources and licences, the model paper citations, the honest limits ("idealised tissue, qualitative ECG"), and the credit line. No private info, no session IDs.
- [ ] **Step 2:** Run `~/RamenProtocol/_ops/infra/privacy-check.sh`. Expected: PASS. Fix anything it reports.
- [ ] **Step 3:** Create the GitHub repo as ramenprotokol, set description, homepage and topics (`webgpu cardiology ecg simulation medical-education spiral-waves wgsl typescript ai-assisted-development cloudflare-pages`), then push.
- [ ] **Step 4:** Deploy: `~/RamenProtocol/_ops/infra/ramen-deploy.sh pages dist --project-name arrhythmia-lab --branch main`. Open the live URL in a real browser and repeat the Task 14 Step 3 checks on the live site.
- [ ] **Step 5:** Commit any fixes. Report the live URL, total build time from `docs/receipts.md`, and any gaps.
