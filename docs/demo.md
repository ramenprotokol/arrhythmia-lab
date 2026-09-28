# Making the demo clip

`public/data/demo.webm` is what a browser without WebGPU sees, and the source of the launch clip.
It is recorded from the real page by a Playwright script (`tests/tools/record-demo.spec.ts`), then shrunk.
The dev server must be running (`npx vite --port 5199 --strictPort`) and Chrome installed.

```sh
MAKE_DEMO=1 npx playwright test tests/tools/record-demo.spec.ts
# small webm for the fallback page (about 1 MB):
ffmpeg -y -i test-results/demo/demo-raw.webm -an -c:v libvpx-vp9 -b:v 0 -crf 38 -vf scale=960:-2 public/data/demo.webm
# mp4 for social posts (X does not take webm):
ffmpeg -y -i test-results/demo/demo-raw.webm -an -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart demo.mp4
```
