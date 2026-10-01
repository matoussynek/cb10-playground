#!/usr/bin/env python3
"""Generates the app icons in icons/ with no dependencies: python3 tools/make_icons.py

Design: two "knobs" (motor A blue, motor B green) above a dark display bar, on the chassis grey.
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"

CHASSIS = (0xE9, 0xE8, 0xE3)
BLUE = (0x4A, 0x6F, 0xC2)
GREEN = (0x3E, 0x8C, 0x66)
INK = (0x1C, 0x1C, 0x1E)


def rounded_rect(x0, y0, x1, y1, r):
    def inside(x, y):
        if not (x0 <= x <= x1 and y0 <= y <= y1):
            return False
        cx = min(max(x, x0 + r), x1 - r)
        cy = min(max(y, y0 + r), y1 - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    return inside


def circle(cx, cy, r):
    return lambda x, y: (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def shapes(full_bleed, scale):
    def s(v):  # scale artwork around the centre (maskable icons need a safe zone)
        return 0.5 + (v - 0.5) * scale
    bg = (lambda x, y: True) if full_bleed else rounded_rect(0.02, 0.02, 0.98, 0.98, 0.22)
    return [
        (bg, CHASSIS),
        (circle(s(0.32), s(0.42), 0.15 * scale), BLUE),
        (circle(s(0.68), s(0.42), 0.15 * scale), GREEN),
        (rounded_rect(s(0.22), s(0.68), s(0.78), s(0.79), 0.055 * scale), INK),
    ]


def render(size, full_bleed=False, scale=1.0, ss=4):
    layers = shapes(full_bleed, scale)
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG filter: none
        for px in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size
                    color = None
                    for test, c in layers:
                        if test(x, y):
                            color = c
                    if color:
                        r += color[0]
                        g += color[1]
                        b += color[2]
                        a += 255
            n = ss * ss
            covered = a // 255
            if covered:
                row += bytes((r // covered, g // covered, b // covered, a // n))
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return png(size, b"".join(rows))


def png(size, raw):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="2" y="2" width="96" height="96" rx="22" fill="#e9e8e3"/>
  <circle cx="32" cy="42" r="15" fill="#4a6fc2"/>
  <circle cx="68" cy="42" r="15" fill="#3e8c66"/>
  <rect x="22" y="68" width="56" height="11" rx="5.5" fill="#1c1c1e"/>
</svg>
"""


def main():
    OUT.mkdir(exist_ok=True)
    (OUT / "icon.svg").write_text(SVG)
    for name, size, full, scale in [
        ("icon-192.png", 192, False, 1.0),
        ("icon-512.png", 512, False, 1.0),
        ("maskable-512.png", 512, True, 0.82),  # content inside the 80 % safe circle
        ("apple-touch-icon.png", 180, True, 0.9),  # iOS rounds the corners itself
    ]:
        (OUT / name).write_bytes(render(size, full, scale))
        print("wrote", name)


if __name__ == "__main__":
    main()
