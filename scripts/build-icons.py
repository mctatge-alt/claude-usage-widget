#!/usr/bin/env python3
"""Build macOS app icons (clean transparency, full canvas)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[1]
ASSETS = REPO / "assets"
MASTER = ASSETS / "icon-source.png"
ICONSET = ASSETS / "icon.iconset"
TARGET = 1024

# Claude-adjacent palette (original Gemini design)
BODY = (245, 244, 238)
BAR = (208, 113, 83)
# Inset so the squircle matches visual weight of system / Office dock icons.
INSET_RATIO = 0.115
MARGIN = int(TARGET * INSET_RATIO)
CORNER_RADIUS = int(226 * (TARGET - 2 * MARGIN) / TARGET)


def generate_icon(size: int = TARGET) -> Image.Image:
    """Draw the usage-meter icon: cream squircle + three coral bars."""
    img = np.zeros((size, size, 4), dtype=np.uint8)
    x0, y0 = MARGIN, MARGIN
    x1, y1 = size - MARGIN, size - MARGIN

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (x0, y0, x1, y1), radius=CORNER_RADIUS, fill=255
    )
    mask_arr = np.array(mask)
    img[:, :, :3] = BODY
    img[:, :, 3] = mask_arr

    bar_w = int((x1 - x0) * 0.58)
    bar_h = int((y1 - y0) * 0.095)
    bar_r = bar_h // 2
    gap = int(bar_h * 0.82)
    total = 3 * bar_h + 2 * gap
    bar_x = (size - bar_w) // 2
    start_y = (size - total) // 2

    slot_mask = np.zeros((size, size), dtype=np.uint8)
    slot_draw = ImageDraw.Draw(Image.fromarray(slot_mask))
    slots: list[tuple[int, int, int, int]] = []
    for i in range(3):
        y = start_y + i * (bar_h + gap)
        box = (bar_x, y, bar_x + bar_w, y + bar_h)
        slots.append(box)
        slot_draw.rounded_rectangle(box, radius=bar_r, fill=255)

    # Transparent slots through the squircle
    inside = mask_arr > 0
    img[:, :, 3] = np.where(slot_mask > 0, 0, img[:, :, 3])
    img[:, :, 3] = np.where(inside, img[:, :, 3], 0)

    canvas = Image.fromarray(img)
    draw = ImageDraw.Draw(canvas)
    # Bottom two bars — full width
    for box in slots[1:]:
        draw.rounded_rectangle(box, radius=bar_r, fill=(*BAR, 255))
    # Top bar — partial fill (~36%)
    top = slots[0]
    fill_w = max(bar_r * 2, int(bar_w * 0.36))
    draw.rounded_rectangle(
        (top[0], top[1], top[0] + fill_w, top[3]),
        radius=bar_r,
        fill=(*BAR, 255),
    )

    return canvas


def write_outputs(icon: Image.Image) -> None:
    icon.save(MASTER)
    ICONSET.mkdir(parents=True, exist_ok=True)
    specs = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for px, name in specs:
        icon.resize((px, px), Image.Resampling.LANCZOS).save(ICONSET / name)
    icon.resize((256, 256), Image.Resampling.LANCZOS).save(ASSETS / "logo.png")
    icon.resize((22, 22), Image.Resampling.LANCZOS).save(ASSETS / "tray-icon-mac.png")
    subprocess.run(
        ["iconutil", "-c", "icns", str(ICONSET), "-o", str(ASSETS / "icon.icns")],
        check=True,
    )
    print("Wrote icon-source.png, logo.png, tray-icon-mac.png, icon.icns, icon.iconset/")


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] not in ("--procedural", "-p"):
        raise SystemExit(
            "Photo-based icon cleanup is deprecated (checker artifacts).\n"
            "Run without arguments to generate a clean procedural icon,\n"
            "or pass --procedural explicitly."
        )
    icon = generate_icon()
    bbox = icon.getbbox()
    print(f"Generated {TARGET}x{TARGET} icon, opaque bbox: {bbox}")
    write_outputs(icon)


if __name__ == "__main__":
    main()
