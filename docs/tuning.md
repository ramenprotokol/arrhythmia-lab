# Re-tuning the lesson recipes

The lessons rest on a handful of numbers found by running the real simulation on the shipped heart
(`public/data/heart.bin`): where the beats are delivered, which sliders make a short-enough wave, and which
timings start a circling wave or fibrillation. They live in `src/lessons/recipes.ts` and `src/lab/plans.ts`
and are pinned by `tests/gpu/lab.spec.ts`. If the heart data is ever rebuilt they have to be found again.

The search tools are in `tests/tuning/`. They take minutes, print numbers, and are skipped unless `TUNING=1`.
They need the dev server (`npx vite --port 5199 --strictPort`) and real Chrome, like the GPU tests.

```sh
# Which extra-beat timings start a circling wave, for a set of (conduction, recovery) settings and sites:
TUNING=1 TUNE_CFG='{"combos":[[0.7,0.3]],"cis":[240,250,260],"sites":["h0.35-e1"]}' \
  npx playwright test tests/tuning/tune.spec.ts -g scan

# Fast pacing bursts from the apex (a route to fibrillation):
TUNING=1 BURST_CFG='{"combos":[[0.5,0.17]],"periods":[92,100,108],"beats":16,"tail":5000}' \
  npx playwright test tests/tuning/burst.spec.ts

# A time series of the excited fraction after an extra beat, for judging how regular a rhythm is:
TUNING=1 SERIES_CFG='{"c":0.7,"r":0.3,"ci":250,"site":[79,47,11],"tail":8000}' \
  npx playwright test tests/tuning/series.spec.ts
```

What to look for: a rhythm that is still going seconds after the last stimulus, and how many separate
excited regions it has. About one region that rises and falls with a steady period is a regular circling
wave; many regions that come and go irregularly is fibrillation.

Two hard-won rules: place anything anatomical from `public/data/heart-frame.json` (the true apex is voxel
[119, 19, 23], read from the source labels), never from the shape of the muscle; and never depend on one exact
timing, because tiny rounding differences between graphics cards change which timings take. The inducer in
`src/lab/induce.ts` tries several and keeps the first that works.
