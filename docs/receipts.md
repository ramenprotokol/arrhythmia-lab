# Build receipts

Backs the claim "designed, built and tested by Claude Sonnet 5.5". One line per task.

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
