# Arrhythmia Lab

**A live heart you can break, and fix.** Tap a real 3D heart to fire a beat, start a wave that chases its own tail,
watch it shatter into fibrillation, and press Shock. A twelve-lead ECG is computed from the simulation as it runs.
Free, in your browser, on your graphics card. Nothing is uploaded, nothing is tracked.

**Live: https://arrhythmia-lab.pages.dev**

> **Educational simulation. Not a medical device.** It never reads your ECG, your scans or your health data, it gives
> no advice, and its tissue is idealised. See [What it is not](#what-it-is-not).

![The lab: a 3D heart with a wave crossing it, and the ECG below](docs/screenshot.png)

## What you can do

- **Tap the heart** to fire a beat at that spot and watch the wave spread through the wall.
- **Guided lessons** (five short ones): a normal beat, an extra beat, a sustained racing rhythm, fibrillation, and the shock that stops it.
- **Two tissue sliders**: how fast the wave travels, and how long each cell stays excited. Together they set how long the wave is, and that decides whether it can chase its own tail.
- **Cut the heart open** to see the wave move through the wall, not just over it.
- **Compare with real ECGs**: recorded traces (normal rhythm, extra beats, ventricular tachycardia, atrial fibrillation) next to the simulated one.
- **Record a clip** of the heart and the ECG together, saved on your computer.

## How it works, in plain English

1. **A real heart.** The shape comes from a CT scan of a real heart, published with permission as an anonymised model
   ([Strocchi et al., CC BY 4.0](https://zenodo.org/records/3890034)). Its ventricles are cut into 182,253 one-millimetre
   cubes, each knowing which way its muscle fibres run. Electricity travels about three times faster along the fibres than across them.
2. **A real cell model.** Every cube runs the minimal ventricular cell model of
   [Bueno-Orovio, Cherry and Fenton (2008)](https://doi.org/10.1016/j.jtbi.2008.03.029), written here from the paper: four
   numbers per cell that rise and fall like a real heart cell's voltage. Inner, middle and outer layers of the wall get different settings.
3. **A live solver on the graphics card.** Neighbouring cubes pass current to each other through the faces they share.
   Each face's flow is worked out once and added to one cube and taken from the other, so no current is created or lost at the
   edge of the muscle. A test proves it: a sealed, unstimulated heart keeps its total voltage to within rounding error.
4. **An ECG computed, not played back.** Each frame the lab adds up how the moving voltage would look from nine electrode
   positions on an idealised body and turns them into the twelve standard leads. It is qualitative: the shape and direction are
   right, the exact millivolts are not a measurement.
5. **A renderer that shows the wave.** The wave is drawn on the heart's surface and marched through its wall, with glow,
   so you can see it travel around the cavities.

The whole thing is a static site. There is no server, no account, and no model call: everything runs in your browser.

## Why a circling wave needs a short wave

A wave can only chase its tail if the loop is longer than the wave. Wave length is speed times how long cells stay excited.
A healthy heart's wave is too long to fit a loop inside it. Slow the conduction and shorten the recovery, and now an extra beat
at just the wrong moment (early enough to be blocked one way, late enough to slip through the other) can start a wave that
keeps going. That is the idea behind the "Racing" and "Fragile" presets. How precisely the timing matters is also why the lab
tries a few timings and keeps the first that takes (the behaviour is chaotic, so tiny rounding differences between graphics cards
change which ones work).

## What it is not

- It is not a medical device, and nothing in it is diagnostic. It cannot interpret a real ECG and it will not accept one.
- The heart is one anonymised heart and the tissue is idealised: there is no Purkinje network, no valves, no blood, no drugs.
  A beat from the tip takes about 180 ms to cross the muscle; in a real heart the wiring is faster.
- The ECG is computed from a simplified body model. Treat its shape as qualitative.
- The arrhythmias are what this model does at these settings. They illustrate ideas; they do not predict what would happen in a person.
- It needs WebGPU (Chrome, Edge, Safari 26, Chrome on Android, Firefox on Windows and Apple-silicon Macs). Elsewhere you get an
  explanation and a recorded clip.

## Numbers

Measured on one Apple-silicon Mac, with nothing else using the graphics card. Other machines will differ.

| What | Number |
|---|---|
| Muscle simulated live | 182,253 one-millimetre cubes (a 125 x 106 x 117 grid), three wall layers, a fibre direction in each |
| Solver speed | 0.034 ms of GPU time per 0.1 ms step: one simulated second costs about a third of a second of GPU, so real time takes a third of the card |
| A frame | about 7 ms at 1440 x 900, high quality, with the solver running (the renderer alone is 2 ms) |
| A beat from the tip | half the muscle is excited by 98 ms, 90% by 146 ms, 99% by 178 ms |
| Cell model against the paper | action potential at 1 Hz: 269 / 263 / 414 ms (outer / inner / middle wall) against the paper's 269 / 260 / 410 |
| Nothing created or lost at the edge | a sealed, unstimulated heart keeps its total voltage to 4e-9; the tempting shortcut loses 18% on a test block |
| GPU against a float64 reference | diffusion 2e-7, the whole cell model 2.5e-4 at the wavefront, the ECG 8e-6, all at worst |
| A racing wave | 28 to 44% of the muscle excited, steadily, still going after every check (up to 10 seconds) |
| Fibrillation | about 5 separate wavefronts on average, up to 11 at once, still going after 5 seconds |
| Shock | ended both rhythms in every test run |
| Shipped | 9 MB of data (a 2 MB demo clip among it), 149 KB of code (50 KB compressed), no server |
| Tests | 294 unit tests and 134 browser tests in real Chrome on a real GPU, all passing |

The browser tests need a real graphics card, and one of them measures speed, so run them one at a time (the config does) and
with nothing else busy on the GPU.

## Run it yourself

```sh
npm ci
npm run dev          # http://localhost:5173, needs a browser with WebGPU
npm test             # 100% CPU: the model, the data, the lessons, the engine, the ECG maths
npm run test:gpu     # real Chrome and a real GPU; start the dev server first on port 5199:
                     #   npx vite --port 5199 --strictPort
npm run build        # a static site in dist/
```

The heart data and recorded ECGs in `public/data/` are already processed. To rebuild them from the sources, see
[tools/README.md](tools/README.md). To find the lesson settings again after changing the data, see [docs/tuning.md](docs/tuning.md).

## What is in here

| Folder | What |
|---|---|
| `src/model` | The cell model in plain TypeScript: the reference the GPU solver is tested against. |
| `src/sim` | The GPU solver (WGSL): face-flux diffusion on the real heart, stimulus, shock, tissue sliders. |
| `src/ecg` | The live twelve-lead ECG: electrode positions, GPU sum, lead maths. |
| `src/render` | The renderer: shell, wall glow, cut-away, bloom, camera, picking. |
| `src/lab` | The lab's clock and rules, and the inducer that starts a rhythm reliably. |
| `src/lessons` | The lesson engine, the lessons, and the tuned settings. |
| `src/ui` | The ECG monitor, the recorded-ECG comparison, the clip recorder. |
| `tools` | Offline scripts that turned the source heart and ECGs into the shipped files. |
| `tests` | Unit tests, GPU tests, page tests, and the tuning tools. |
| `docs` | The design, the plan, the build log (`receipts.md`) and how to re-tune. |

## Built with Claude Sonnet 5.5

The design, the code and the tests were written by Claude Sonnet 5.5 (released 28 September 2026), directed by a person, in one day.
`docs/receipts.md` is the build log: what was done, in what order, what went wrong, and the measured numbers. It is not affiliated with,
endorsed by or sponsored by Anthropic.

## Credits and licences

- Code: MIT (see `LICENSE`).
- Heart geometry: Strocchi et al., *A Publicly Available Virtual Cohort of Four-chamber Heart Meshes for Cardiac Electro-mechanics Simulations* (Zenodo, 2020, [doi:10.5281/zenodo.3890034](https://doi.org/10.5281/zenodo.3890034)). CC BY 4.0. One heart (archive 23), ventricles only, resampled and smoothed by the scripts in `tools/`.
- Recorded ECGs: [PTB-XL](https://physionet.org/content/ptb-xl/1.0.3/) (Wagner et al., CC BY 4.0) and the [MIT-BIH Arrhythmia Database](https://physionet.org/content/mitdb/1.0.0/) (Moody and Mark, ODC-By 1.0), via PhysioNet.
- Cell model: Bueno-Orovio A, Cherry EM, Fenton FH. Minimal model for human ventricular action potentials in tissue. *J Theor Biol* 253:544-560 (2008). Written from the paper; no code was copied.
