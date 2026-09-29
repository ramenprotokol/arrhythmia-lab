# Build receipts

Backs the README's "Who built it". Round 1 (one day, Claude Sonnet 5.5 with Sonnet helpers) comes first; round 2 (Sonnet 5.5 leading three Opus 5.5
specialist agents) is at the end. One line per task.

## Who did what (read this first)

- **Idea and research (Opus 5.5 session, before the switch to Sonnet):** three research agents (launch-day tactics on X, Sonnet 5.5
  launch facts, medical-app ideas) and the choice of "Arrhythmia Lab" from six concepts. No product code was written in that phase.
- **Design spec, implementation plan, every line of code, every test (Sonnet 5.5):** the main session, plus helper agents that ran
  on Sonnet 5.5 (cell model, heart data, ECG samples, heart frame and ECG, renderer, ECG monitor and lessons). The lead session
  re-ran and re-read each helper's work before committing it.
- **One Opus 5.5 consultation, on effort level only:** "stay at high, max only for the 3D diffusion design". No code. It also named the
  edge-of-tissue trap that the conservation test then proved.
- **The person** chose the idea, the scope (the full version first), the engine (WebGPU only), the features, the free-tier-only rule, and
  ran everything from the terminal.

## Log

- 2026-09-28 13:58 design approved by owner, spec written, plan written (Sonnet 5.5, main session)
- 2026-09-28 13:59 Task 1 done: scaffold, WebGPU check, headless GPU test. Finding: headless GPU needs installed Google Chrome (channel "chrome") and an https origin (navigator.gpu is absent on about:blank). (Sonnet 5.5, main session)
- 2026-09-28 14:00 Task 9 step 1 done: orbit camera maths with 6 passing tests (Sonnet 5.5, main session). Tasks 2, 3, 12 handed to three Sonnet 5.5 subagents.
- 2026-09-28 14:02 Task 2 done by Sonnet 5.5 subagent (task2-model), re-verified by the main session: 10/10 tests, constants verified against the 2008 paper Table 1, 1 Hz APD90 EPI 269 / ENDO 263 / MID 414 ms vs paper 269 / 260 / 410.
- 2026-09-28 14:09 Task 12 data done by Sonnet 5.5 subagent (task12-ecg), re-verified by the main session: 4 real traces (PTB-XL x2, MIT-BIH x2), 33 KB, 7/7 tests. Credits must name both PTB-XL and MIT-BIH.
- 2026-09-28 14:11 Task 3 done by Sonnet 5.5 subagent (task3-data), re-verified by the main session: real Strocchi heart 23 (EnSight Gold format), 125x106x117 grid at 1 mm, 182,253 muscle voxels, fibres unit length, shipped data 7.2 MB, 18/18 data tests.
- 2026-09-28 14:11 Task 4 done: heart loader, 7 tests incl. the real shipped files (Sonnet 5.5, main session).
- 2026-09-28 14:13 Advice (not code): asked Opus 5.5 only whether to raise effort. Answer: stay at high, max only for the Task 6 3D diffusion design and for any bug surviving two fix attempts; flagged the boundary-flux trap, now in the plan. All code and design remain Sonnet 5.5.
- 2026-09-28 14:16 Task 5 steps 1-3a done: 2D GPU sheet solver matches the CPU model to ~1e-6 (32-bit float). Finding: this GPU returns NaN for tanh(x) with x above ~40 (stimulated cells reach ~63); kernels must clamp the tanh argument to +-15. Applies to the 3D kernel too. (Sonnet 5.5, main session)
- 2026-09-28 14:19 Task 5 done: 2D sheet solver. Findings for Task 7: (1) stimulus must be a current pulse (amp*ms), not a forced voltage, or refractory cells fire and no vulnerable window exists; (2) normal APD 272 ms gives a wave as wide as the whole 80 mm sheet, so re-entry needs a shortened APD; tauWp x 1/0.7/0.5/0.35/0.25 gives APD 272/208/162/125/97 ms, smooth (tauSo scaling collapses the plateau instead); (3) with tauWp x 0.35, D 0.05 mm2/ms, dx 0.5, S2 amp 0.4: S2 before ~190 ms is absorbed, S2 after starts re-entry that circles for 10+ s with ~45% of cells excited; (4) shock ends it. GPU vs CPU gap ~1e-6. (Sonnet 5.5, main session)
- 2026-09-28 14:26 Task 6 step 0 (max effort): float64 CPU reference of the 3D face-flux diffusion + tests. Measured: conserves total voltage to 1.2e-15 on a jagged sealed block; the naive zero-the-neighbours scheme drifts 18% on the same block (negative control); Gaussian spreads along a 45-degree fibre with the analytic variances, and swaps axis with the fibre; stable at 0.95x the derived limit (limit is conservative: still stable at 1.6x). (Sonnet 5.5, main session)
- 2026-09-28 14:31 Task 6 done (max effort for the diffusion design, as advised). Face-flux 3D solver: only the ~182k muscle voxels are visited, each thread loads its 3x3x3 window once. Results: GPU conserves total voltage to 1.9e-8 on a jagged block and 3.7e-9 on the real heart (naive shortcut: 1.8e-1); GPU vs float64 CPU diffusion mean 3.9e-9 worst 1.7e-7; with reaction mean 5.5e-8 worst 2.5e-4; a Gaussian spreads along a 45-degree fibre with variances 24.07/9.00/9.00 vs analytic 24/9/9, and swaps with the fibre. Bugs found: (1) "active" is a reserved word in WGSL and the shader silently did nothing (0.00 drift and a large CPU mismatch gave it away), so Simulation.create now throws on compile errors and every GPU test fails on any uncaptured GPU error; (2) tests sampled activation too coarsely. Calibration on 1 mm grid (fibres along x, ratio 4 then 3): CV along scales with sqrt(D) (0.38/0.62/0.89/1.14/1.6 mm/ms at D 0.15/0.25/0.4/0.6/0.9); CV across FAILS below D-perp about 0.06 (coupling too weak at 1 mm). Chosen D-par 0.4, D-perp 0.13: along 1.0, across 0.33 mm/ms. Real heart from an apex stimulus: half the muscle fires by 130 ms, 99% by 200 ms. Speed: 0.034 ms per step at dt 0.05 = 0.73x real time with half a frame of GPU per frame. Next: Task 7 tuning (recovery via tauWp). (Sonnet 5.5, main session)
- 2026-09-28 Task 7 done (tuning), by the main session (Sonnet 5.5). What the search found, on the real heart:
  (1) Time step 0.1 ms gives the same action potential as 0.05 (APD90 272.0 vs 272.0 ms) and the same conduction within ~5%, at twice the speed; the app uses 0.1.
  (2) A wrong-apex catch: a geometry guess ("the narrower end is the apex") picked the BASE as the apex; helper A's frame file, built from the source labels (atria at the base), puts the true apex at voxel (119, 19, 23). Every recipe was re-tuned from the true apex, and tests/gpu/heartGeometry.ts now carries a warning; anatomy comes from heart-frame.json.
  (3) Normal tissue: a beat activates 100% of the muscle and everything is at rest by 700 ms; an extra beat 550 ms later is captured once (100%) and dies out.
  (4) Circling waves need a short wave: conduction 0.7 with recovery 0.3 (tauWp x 0.3). Timing windows are narrow and chaotic (e.g. 245/250/275 ms sustain, 255/265/235 do not), so the lab does not rely on one exact timing: src/lab/induce.ts tries a list of timings and keeps the first that takes. On this GPU tachycardia took on attempt 2 of 8 and then kept circling (excited fraction 0.28 to 0.38 for the next 4 s).
  (5) Fibrillation: rapid pacing from the apex (a burst of 16 beats, ~100 ms apart) at conduction 0.5, recovery 0.17 sustained chaotic activity at 6 of 6 timings tried (92 to 116 ms), mean 3.6 to 6.6 wavefronts, peaks up to 15. Lowering the sliders on a running tachycardia alone did NOT break it up (1 to 3 regions).
  (6) A shock ends both rhythms; with the pacemaker on, the regular rhythm resumes (5 beats in 5 s).
  (7) Simulation.excitedFraction(): a GPU count, 4 bytes read back, equals a full readback exactly.
- 2026-09-28 15:55 Task A done by Sonnet 5.5 subagent (taskA-ecg), re-verified by the main session: heart frame built from the source labels (true apex voxel 119,19,23), electrodes, leads, GPU ECG with batched queue()/flush(). 17/17 GPU tests + 69 unit tests; GPU vs float64 ECG error ~1e-6; wave toward an electrode reads positive; apex pacing gives a negative lead II (integral -72 mV.ms) and base pacing a positive one (+50 mV.ms).
- 2026-09-28 Task B done by Sonnet 5.5 subagent (taskB-render), re-verified by the main session: renderer (shell, wall glow marched through the muscle, cut-away, bloom, three quality tiers, orbit/zoom, picking, projection, lens-shift framing for panels). 24/24 GPU tests + 71 unit tests. Frame time at 1440x900, high quality, with 150 solver steps per frame: 6.95 ms (p95 7.40); renderer alone 1.96 ms. A broken shader is reported with its compiler message.
- 2026-09-28 16:18 App integration by the main session (Sonnet 5.5): page (src/app.ts, src/dom.ts), engine wiring, panel-aware framing via renderer.setInsets, anatomy labels via renderer.project, phone layout (ECG under the heart, one lead by default), clip recorder fixed (a WebGPU canvas only holds its picture during its own frame, so the clip copies it right after rendering; crop, contain and blurred backdrop added). Page tests in real Chrome: starts and beats, tap and buttons, all five lessons played to their end, clip saves a webm, desktop and phone layouts. Demo clip recorded from the real page (30 s, 2.3 MB webm).
- 2026-09-28 16:28 Freeze and verification by the main session: typecheck 0 errors, lint clean, 294 unit tests pass (23 files); full browser suite 133 of 134 on the first run (the one failure was the speed test running while another helper used the GPU: 0.073 ms per step vs 0.034 alone) and it passes alone; floor of that test loosened from 0.4x to 0.25x real time so a slower or shared GPU does not fail the suite. Measured at the app settings from the true apex: half the muscle excited by 98 ms, 90% by 146 ms, 99% by 178 ms; one simulated second costs 334 ms of GPU. Bundle: 148.5 KB of code (50 KB gzip), 9.1 MB of data including the 2.3 MB demo clip. GitHub repo created as ramenprotokol/arrhythmia-lab, Cloudflare Pages project arrhythmia-lab created.
- 2026-09-28 16:47 Correction after the helpers' late reports (main session): (1) the app now passes the anatomy frame to the renderer, so the heart is posed by its real anatomy (apex down and labelled, right ventricle on the left) instead of a shape guess that was 69 degrees off the true long axis; (2) the twelve-lead monitor uses half gain (5 mm/mV, labelled) because racing and fibrillating rhythms swing the chest leads past 2 mV and were cut flat at 10 mm/mV; the single big lead keeps 10 mm/mV; (3) screenshot, social image, demo clip and MP4 regenerated from the corrected app. Final counts on a quiet GPU: 295 unit tests, 135 browser tests, 0 failures.

## Round 2 (2026-09-28, evening): rebuilt around what the person said was wrong

The person looked at the live site and said: the heart is not realistic enough, the ECG panel covers half the screen, "a live heart you can
break and fix" is not understandable, and there is no sound. The brief was: a much more realistic heart, a heartbeat that follows the
rhythm in real time with an on/off icon, a page that explains itself, and specialist agents (interface, visuals, a cardiology teacher) to
work out what is wrong and fix it. The person also asked to judge the product on its own merits, not as a showcase for anyone.

### Who did what in round 2 (read this first)

- **Lead: Claude Sonnet 5.5** (the main session): the rhythm analyser and the synthesised heart sounds (`src/audio`), the break-it
  and fix-it moves (`src/lab/moves.ts`), the ordinary-beat conduction sweep (`src/lab/conduction.ts`, the solver's sweep stimulus,
  the engine changes), the whole-heart shock and the defibrillator rule, the automatic lead (`src/ecg/autoLead.ts`), the page
  wiring in `src/app.ts`, sound and caption in recorded clips, the launch tools, the tests for all of it, this build log and the
  README.
- **Three Opus 5.5 specialist agents**, used because the person prefers Opus for subagents: **ux** (page shell, status card,
  break/fix bar, ECG dock with Compare inside it, drawers, phone layout, fonts), **visual** (the renderer: the whole heart, fat,
  coronary vessels, great vessels, thin wavefront, contraction, and its cost), **educator** (a cardiology-teaching audit of the
  live site, every word on the page in `src/copy.ts`, the lessons, the real ventricular-fibrillation recording in Compare).
- **The Design canvas** (a private board) was used for the layout options before the interface agent built the page.
- **The person** chose the direction, said what was wrong, and asked for the sound.

### Findings that changed the design

1. **The ECG taught false things** (teaching audit). The "normal" beat was a paced beat: no fast wiring, a QRS of 0.18 to 0.20 s
   and pointing  down in lead II. And in racing and fibrillation lead II was nearly flat, which is the rhythm strip, the phone
   view and the Compare trace.  Fixes: the ordinary beat is now a conduction sweep (inner-wall cells fire in the order a fast
   front from the wall between the ventricles  would reach them), which measures about 100 ms in the page test with an upright
   lead II and T wave, against 196 ms for an early beat; and  the strip shows lead II while it has a clear signal, otherwise the
   chest lead that shows the rhythm best, and says which. The audit's own  fix for lead II (limb electrodes closer to the heart)
   was tried on paper and does not work: it scales lead II for every rhythm by the same  factor, and the ratio of racing to steady
   in lead II stays about 0.08 because the circling wave's net dipole is small.
2. **Shock worked on anything**, which teaches the worst television myth ("shock a flat line"). Now Shock follows the AED rule: it
   fires only  for a racing or chaotic rhythm and refuses, with the reason, for a pumping or a still heart. It is a whole-heart
   stimulus (every cell fires at  once; 100% of the muscle in one frame in the lesson tests), it ended every racing and
   fibrillation run in the tests, and the steady beat comes back  by itself after it.
3. **Compare had no ventricular fibrillation**, only atrial. A real ventricular-fibrillation excerpt (CU Ventricular
   Tachyarrhythmia Database)  was added, atrial fibrillation is labelled as a different condition, and each rhythm carries a
   caveat where the model differs.
4. **Nobody could find "break and fix".** Three plain buttons (Early extra beat, Make it race, Make it fibrillate), Shock beside
   them, a status  card that names the rhythm, and a first-run coach: tap the heart, break it, fix it.
5. **Every sound comes from a simulated event, never from a timer.** The *lub* is heard when a beat starts, the *dub* when the
   muscle has finished  squeezing (so it follows the rate and the recovery slider), an early beat is softer, a racing heart is one
   thump per turn, a shock is a thud and a  crackle, and fibrillation is silent. A beat that does not take makes no sound, which
   is what makes the pause after an early beat audible. The lab's  own jolts while it hunts for a rhythm are muted.
6. **The rhythm analyser was tuned on ECG recorded from the real simulation** (`tests/audio/fixtures`). What testing on recordings
   found and fixed: the  racing wave counted twice (483 a minute), the shock's flash read as a beat, fibrillation read as racing,
   early beats being seven times smaller than  ordinary ones (so the thresholds depend on the rhythm), a beat that fell in an
   early beat's recovery being counted, the pause after an early beat  being read as the rate, and, found only in the real page, a
   tap right after the page opens making two or three beats close together that were read  as "Racing rhythm" for a second and a
   half. Racing now needs four fast gaps in a row, and the rate of a steady heart is the gap most ordinary beats  agree on, so an
   early beat cannot move it.
7. **A deploy hazard**: the data files were cached for a day, so a returning visitor could meet new code with an old
   `heart-surface.bin` or  `ecg-samples.json` and the page would fail to start. The two files that changed shape are now fetched
   with a version in the address, and `/data/*`  revalidates instead of being cached.
8. **A wrong turn**: firing the inner wall patch by patch gave jagged, needle-thin spikes on the ECG. The sweep fires each cell at
   its own time  inside the solver instead.

### Log

- 2026-09-28 evening: the person's feedback and brief. Three Opus 5.5 specialist agents started (ux, visual, educator). All of them
  and the lead worked in one folder with strict file ownership (each lane owned its own files and sent the lead exact snippets for
  `src/app.ts`), and a private copy of the tree was used for experiments whenever another lane's half-finished edit broke the
  page.
- Teaching audit of the live site by the educator (Opus 5.5), at 1440 x 900 and 390 x 844, every lesson played through with the
  real buttons: 14 findings, 4 of them must-fix, plus a terminology list, status-card wording, a heart-sound specification and ten
  rewritten strings. Its evidence is one figure of real ECG next to the simulated one.
- Lead: `src/ecg/autoLead.ts` (finding 1). The audit's electrode idea was measured and dropped (see above); lead II is kept while
  it has at least 0.5 mV, then the strongest chest lead is shown, labelled, with a 600 ms hold so the strip does not flicker
  between leads.
- Lead: the ordinary-beat conduction sweep (finding 1). Inner-wall cells are fired by the solver at 1 ms slots inside its own
  chunks, in the order a front at 1.5 mm per ms from the wall between the ventricles (the right ventricle 10 ms later) would reach
  them. Patch-by-patch stimulation from outside the solver was tried first and gave jagged needle spikes, so it was dropped. A tap
  and an early beat stay single-site, so they look wide, as a paced beat does.
- Lead: the whole-heart shock and the defibrillator rule (finding 2), `src/lab/moves.ts`. Fix it is the shock plus healthy tissue
  plus the steady beat on; before, a shocked heart stayed silent.
- Educator: a real ventricular-fibrillation excerpt in Compare (finding 3), from the CU Ventricular Tachyarrhythmia Database
  (recording cu11, ODC-By 1.0), and the rewrite of the lessons: the racing and fibrillation lessons end with the viewer pressing
  Shock, and the pause after an early beat is shown, not hidden.
- Lead: the rhythm analyser and the heart sounds (findings 5 and 6), tuned on ECG recorded from the running simulation. Synthesis
  is Web Audio only: the *lub* is three sine partials gliding down from 78, 156 and 234 Hz, a triangle partial from 312 Hz and
  short bursts of noise, the *dub* is crisper and softer, everything goes through a 900 Hz low-pass and a limiter, and the volume
  is capped at half. Off until asked; the choice is remembered in the browser only. Recorded clips carry the sound and a caption
  naming the rhythm.
- UX (Opus 5.5): the page rebuilt: a status card that names the rhythm, the Break it and Fix it bar, the ECG dock with Compare and
  the 12 leads inside it instead of over the heart, drawers for lessons and controls, a first-run coach, the phone layout (the
  strip sits above the action bar and is fully visible on 390 x 844 and 360 x 740), fonts (Instrument Sans, Instrument Serif,
  JetBrains Mono, self-hosted, SIL OFL) and an automatic gain on the ECG paper that says what it uses.
- Visual (Opus 5.5): the renderer rebuilt: the whole heart (atria, aorta, pulmonary trunk and vein stumps from the same CT model,
  drawn and not simulated), raised epicardial fat, coronary arteries and veins (drawn for looks, not this heart's), wet studio
  shading, a thin bright wavefront with a soft glow deep in the wall, local contraction (a normal beat squeezes 0.99, racing 0.47
  to 0.56 with a 5 px twitch, fibrillation 0.23 to 0.31 with no squeeze and a fine quiver), an amber flush for the shock, and the
  full-screen ray march removed. Renderer cost, quiet GPU, old against new: high 1.98 to 1.52 ms, medium 1.93 to 1.01, low 1.79 to
  0.9 (1440 x 900), high on a double-density canvas 5.29 to 1.98. At real time the whole page holds 60 frames a second with the
  simulation at full speed at both densities (the old renderer managed 54 at double density).
- Lead, checks that found real bugs: a five-cycle break-and-fix run with sound on found the scramble of lubs and thumps while the
  lab hunts for a rhythm (now muted); a size sweep from phone to ultrawide found the ECG strip half hidden on a phone; watching
  the analyser's beats after an early tap found the false "Racing rhythm"; reading the deploy headers found the stale-data hazard;
  a mid-cycle beat fired with B was being named a PVC (it goes through the wiring, so the card stays with the steady rhythm).
- Final checks on a quiet GPU: typecheck 0 errors, lint clean, 421 unit tests in 33 files, 169 browser tests in real
  Chrome on a real GPU in 6.6 minutes with 0 failures (7 more are build and tuning tools that run only on
  request), `npm audit` 0 vulnerabilities and every package signature verified, the built site checked under its real security
  headers (no policy violation, no GPU error, no console message), the privacy gate passed.
