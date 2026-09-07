#!/usr/bin/env python3
"""Generate the PWA icon set (pure stdlib, no image libraries required).

The mark is a stylised won sign on a rounded green square. Re-run after
changing COLORS or GEOMETRY:

    python3 tools/make_icons.py
"""

import math
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "icons"

BG = (22, 163, 74, 255)  # green-600
FG = (255, 255, 255, 255)

# Won sign geometry, expressed in a 0..100 box so it scales to any size.
W_STROKE = 9.0
W_POINTS = [(18, 28), (33, 75), (50, 38), (67, 75), (82, 28)]
BARS = [(12, 88, 47, 6.0), (12, 88, 58, 6.0)]  # x0, x1, y, thickness


def dist_to_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def coverage(ux, uy, radius_scale):
    """Signed coverage of the won mark at unit-box point (ux, uy)."""
    best = min(
        dist_to_segment(ux, uy, *W_POINTS[i], *W_POINTS[i + 1])
        for i in range(len(W_POINTS) - 1)
    )
    for x0, x1, y, thickness in BARS:
        best = min(best, dist_to_segment(ux, uy, x0, y, x1, y) - (thickness - W_STROKE) / 2)
    return (W_STROKE / 2) * radius_scale - best


def blend(dst, src, alpha):
    return tuple(round(d + (s - d) * alpha) for d, s in zip(dst, src))


def render(size, *, maskable=False):
    """Return raw RGBA rows for one icon."""
    # Maskable icons must survive an aggressive circular crop, so the mark is
    # shrunk into the safe zone and the background bleeds to the full square.
    inset = 0.0 if maskable else size * 0.06
    corner = 0.0 if maskable else size * 0.22
    mark_scale = 0.72 if maskable else 1.0

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            px, py = x + 0.5, y + 0.5

            # Rounded-square background with an antialiased edge.
            bg_alpha = rounded_square_alpha(px, py, size, inset, corner)
            if bg_alpha <= 0:
                row += bytes((0, 0, 0, 0))
                continue

            # Map into the 0..100 unit box, centred and scaled.
            centre = size / 2
            ux = (px - centre) / (size * mark_scale) * 100 + 50
            uy = (py - centre) / (size * mark_scale) * 100 + 50

            pixel = BG
            if 0 <= ux <= 100 and 0 <= uy <= 100:
                # coverage() is in unit-box distance; convert to pixels for AA.
                px_per_unit = size * mark_scale / 100
                fg_alpha = max(0.0, min(1.0, coverage(ux, uy, 1.0) * px_per_unit + 0.5))
                if fg_alpha > 0:
                    pixel = blend(BG, FG, fg_alpha)

            row += bytes((*pixel[:3], round(pixel[3] * bg_alpha)))
        rows.append(bytes(row))
    return rows


def rounded_square_alpha(px, py, size, inset, corner):
    left, top = inset, inset
    right, bottom = size - inset, size - inset
    if corner <= 0:
        return 1.0 if left <= px <= right and top <= py <= bottom else 0.0

    cx = min(max(px, left + corner), right - corner)
    cy = min(max(py, top + corner), bottom - corner)
    d = math.hypot(px - cx, py - cy)
    return max(0.0, min(1.0, corner - d + 0.5))


def write_png(path, rows):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    size = len(rows)
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    raw = b"".join(b"\x00" + row for row in rows)  # filter type 0 per scanline
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
        ("apple-touch-icon.png", 180, True),
    ]
    for name, size, maskable in targets:
        write_png(OUT_DIR / name, render(size, maskable=maskable))
        print(f"wrote icons/{name} ({size}x{size})")


if __name__ == "__main__":
    main()
