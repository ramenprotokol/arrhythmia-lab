# Arrhythmia Lab: design

Status: approved by the owner on 2026-09-28. Written and built by Claude Sonnet 5.5.

## What it is

A free browser lab. You pace a real 3D heart. A badly timed extra beat starts a spiral wave, which can break into fibrillation. Twelve ECG leads are computed live from the simulated voltage, not played back. Then you press Shock.

It is an educational simulation. It is not a medical device and never interprets a user's own data.

## Decisions (all confirmed by the owner)

- Scope: the full version first (3D heart wall, 12 leads). Post when it is done.
- Engine: WebGPU only. Browsers without it see a fallback page with a recorded clip.
- Heart: one real heart from the Strocchi dataset (CC BY 4.0), processed offline into a small file.
- Features: tap-to-pace, premature beat, Shock, guided lessons, tissue sliders, a record-a-clip button, and a real-ECG comparison panel with a fixed disclaimer.
- Budget: free tier only. Static site on Cloudflare Pages. No live model calls.
- Names: no "Claude" in the app name and no Claude logo. The footer says "Built with Claude Sonnet 5.5. Not affiliated with Anthropic."

## Architecture

Five units. Each has one job and a plain interface.

1. `tools/` (offline, runs on the maker's Mac, never shipped). Turns one Strocchi heart into the site's data.
   - Input: the downloaded mesh files.
   - Output: `public/data/heart.bin` (a grid of about 1 mm cells: muscle mask, fibre direction, wall layer) and `public/data/heart-surface.bin` (a smooth outer mesh).
2. `src/model/` (pure TypeScript, no GPU). The Bueno-Orovio-Cherry-Fenton four-variable minimal model, written from the 2008 paper. It is the reference that the GPU solver is tested against.
3. `src/sim/` (WebGPU compute). Runs the same model on every muscle cell, with wave spread that is faster along fibres than across them. Exposes `step(dt)`, `stimulate(position, radius)`, `shock()` and `setTissue({ conduction, recovery })`.
4. `src/ecg/` (WebGPU compute plus TypeScript). Computes the 12 leads from the voltage field at standard electrode positions, using a uniform-body approximation. Output is labelled "simulated, qualitative".
5. `src/render/` and `src/ui/` (WebGPU render plus DOM). A glowing wave raymarched through the heart wall, an anatomical shell, a cutaway slice, bloom, a monitor-style ECG panel, a lessons panel and a clip recorder.

Data flow: input (tap, sliders) -> `sim` -> voltage field -> `ecg` and `render` -> screen. The lessons script the inputs. Nothing flows back to a server.

## Model and solver

- Four variables per cell: u (voltage), v, w, s. Three parameter sets for inner, middle and outer wall.
- Wave spread uses an anisotropic diffusion tensor built from the stored fibre direction.
- Explicit time stepping, several small steps per frame, with the step size kept under the stability limit. The limit is checked in a test.
- Grid size is chosen so a mid-range GPU holds 60 frames per second. A quality setting lowers the grid resolution on weaker devices.

## ECG

- Standard 12-lead layout from 9 electrode positions.
- Each lead is a weighted sum of voltage gradients across the muscle. It is computed on the GPU and read back at a low rate.
- Real recordings from PTB-XL (CC BY 4.0) sit beside it. Fixed caption: "Recorded ECGs are shown for visual comparison only. This is an educational simulation, not a medical device and not a diagnostic tool."

## Guided lessons

Short scripted scenarios, each with plain-English steps: normal beat, extra beat (PVC), sustained tachycardia, break into fibrillation, shock it back. Each lesson only drives the same controls a user has.

## Look

Dark, clinical and cinematic. Glow follows the wave. The heart can be rotated, cut away and zoomed. The ECG panel looks like a hospital monitor.

## Guardrails

- A visible banner: "Educational simulation. Not a medical device."
- Idealized tissue only. No uploads of ECGs, scans or labs. No patient-specific numbers.
- Credit lines for the heart data (Strocchi et al., CC BY 4.0) and the ECG data (PTB-XL, CC BY 4.0).
- The model equations are implemented from the published papers and cited. No GPL code is copied.

## Testing

- The CPU model reproduces published action-potential shape and duration within a stated tolerance.
- The GPU solver matches the CPU model on a small test grid.
- The stability limit holds at every slider extreme.
- A normal beat gives a QRS complex and T wave with the expected polarity in lead II.
- Type check, lint and production build pass.
- Screenshot checks at desktop and phone sizes, on the running site.
- The privacy gate passes before every push.

## Out of scope for the first release

- Uploading data, accounts, backend, live model calls.
- Any diagnostic feature.
- A WebGL2 fallback solver.

## Risks

- Spiral waves may need parameter tuning before they look right. The solver is built and checked on a flat sheet first.
- Full-version scope may miss the launch-roundup window. The owner accepted this.
