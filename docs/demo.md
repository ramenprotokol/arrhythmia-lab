# Making the demo clip, the screenshot and the social image

`public/data/demo.webm` is what a browser without WebGPU sees, and the source of the launch clip.
It is recorded from the real page by a Playwright script (`tests/tools/record-demo.spec.ts`) that clicks the page's own
buttons: a steady rhythm, an early beat, the racing rhythm, fibrillation, the shock, and the steady beat coming back. It
turns the sound on first, so the raw recording has the heartbeat in it, and the page's own caption ("Racing rhythm, 268 a
minute, Barely pumping") is drawn into every frame. It needs Chrome installed and the dev server running
(`npx vite --port 5199 --strictPort`).

```sh
MAKE_DEMO=1 npx playwright test tests/tools/record-demo.spec.ts        # writes test-results/demo/demo-raw.webm (with sound)
# small silent webm for the fallback page (about 1 MB; the fallback page has no sound):
ffmpeg -y -i test-results/demo/demo-raw.webm -an -c:v libvpx-vp9 -b:v 0 -crf 38 -vf scale=960:-2 public/data/demo.webm
# mp4 for social posts, with the heartbeat (X does not take webm):
ffmpeg -y -i test-results/demo/demo-raw.webm -c:v libx264 -pix_fmt yuv420p -crf 20 -c:a aac -b:a 128k -movflags +faststart demo.mp4
```

## The screenshot and the social image

```sh
SHOT_DIR=/tmp/shots MAKE_SHOTS=1 npx playwright test tests/tools/screenshots.spec.ts   # docs/screenshot.png + heart-clean.png
python3 tools/make_og.py /tmp/shots/heart-clean.png docs/screenshot.png public/og.png  # the 1200 x 630 link preview
```

The screenshot taps the heart first (which clears the "tap the heart" hint), then presses Make it race, so it shows the
racing rhythm with the status card and the lit Shock button. The heart-only shot hides the page's cards and buttons one by
one (never `#hero`, which holds the canvas). If you rename those ids in `src/dom.ts`, change the list in the spec.
