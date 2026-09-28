# Build receipts

Backs the claim "designed, built and tested by Claude Sonnet 5.5". One line per task.

- 2026-09-28 13:58 design approved by owner, spec written, plan written (Sonnet 5.5, main session)
- 2026-09-28 13:59 Task 1 done: scaffold, WebGPU check, headless GPU test. Finding: headless GPU needs installed Google Chrome (channel "chrome") and an https origin (navigator.gpu is absent on about:blank). (Sonnet 5.5, main session)
- 2026-09-28 14:00 Task 9 step 1 done: orbit camera maths with 6 passing tests (Sonnet 5.5, main session). Tasks 2, 3, 12 handed to three Sonnet 5.5 subagents.
- 2026-09-28 14:02 Task 2 done by Sonnet 5.5 subagent (task2-model), re-verified by the main session: 10/10 tests, constants verified against the 2008 paper Table 1, 1 Hz APD90 EPI 269 / ENDO 263 / MID 414 ms vs paper 269 / 260 / 410.
- 2026-09-28 14:09 Task 12 data done by Sonnet 5.5 subagent (task12-ecg), re-verified by the main session: 4 real traces (PTB-XL x2, MIT-BIH x2), 33 KB, 7/7 tests. Credits must name both PTB-XL and MIT-BIH.
