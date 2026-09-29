"""Compose the 1200 x 630 social-preview image (public/og.png) from two real captures of the app:
a heart-only shot and the README screenshot (for the ECG strip). See docs/demo.md.
Both are 1440 x 900 captures of the page; the crops below are for that size.

    python3 tools/make_og.py <heart-clean.png> docs/screenshot.png public/og.png
"""
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

heart_path, shot_path, out_path = sys.argv[1:4]
W, H = 1200, 630
shot = Image.open(shot_path).convert("RGB")      # 1440 x 900
heart_full = Image.open(heart_path).convert("RGB")  # 1440 x 900, overlays hidden

yy, xx = np.mgrid[0:H, 0:W]
d = np.sqrt(((xx - 840) / 640) ** 2 + ((yy - 300) / 430) ** 2)
glow = np.clip(1 - d, 0, 1) ** 1.6
arr = np.full((H, W, 3), (4, 8, 11), dtype=float)
arr[..., 0] += glow * 6
arr[..., 1] += glow * 34
arr[..., 2] += glow * 44
bg = Image.fromarray(np.clip(arr, 0, 255).astype("uint8"))

# the heart, cropped tight to where it is, with a soft edge so it melts into the background
heart = heart_full.crop((390, 70, 1070, 690))
scale = 545 / heart.height
heart = heart.resize((int(heart.width * scale), 545), Image.LANCZOS)
mask = Image.new("L", heart.size, 0)
ImageDraw.Draw(mask).ellipse((10, 4, heart.width - 10, heart.height - 4), fill=255)
mask = mask.filter(ImageFilter.GaussianBlur(48))
bg.paste(heart, (W - heart.width - 16, 50), mask)

# the live ECG strip, from the README screenshot (bottom of the page)
ecg = shot.crop((30, 752, 620, 884))
ecg = ecg.resize((520, int(ecg.height * 520 / ecg.width)), Image.LANCZOS)
emask = Image.new("L", ecg.size, 0)
ImageDraw.Draw(emask).rounded_rectangle((2, 2, ecg.width - 2, ecg.height - 2), radius=14, fill=255)
bg.paste(ecg, (60, 450), emask)


def font(size, bold=False):
    for path in ("/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf"):
        try:
            return ImageFont.truetype(path, size, index=1 if (bold and path.endswith("ttc")) else 0)
        except Exception:
            continue
    return ImageFont.load_default()


draw = ImageDraw.Draw(bg)
draw.text((62, 62), "ARRHYTHMIA", font=font(78, True), fill=(232, 242, 246))
draw.text((62, 144), "LAB", font=font(78, True), fill=(87, 224, 255))
draw.text((64, 254), "A live heart you can break, and fix.", font=font(31), fill=(190, 214, 224))
draw.text((64, 312), "Real 3D heart  |  live ECG  |  heartbeat sound  |  free", font=font(19), fill=(140, 170, 182))
draw.text((64, 350), "Educational simulation. Not a medical device.", font=font(19), fill=(255, 205, 140))
bg.save(out_path, optimize=True)
print("wrote", out_path, bg.size)
