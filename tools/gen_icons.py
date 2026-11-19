#!/usr/bin/env python3
"""Generate VPN Tab Reaper icons (dark rounded square + green check) as PNGs.

Pure stdlib (zlib/struct) — no Pillow required. 2x2 supersampling for edges.
"""
import struct
import zlib
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "extension", "icons")

BG = (0x1C, 0x22, 0x2D, 0xFF)        # dark slate
CHECK = (0x4C, 0xD1, 0x7B, 0xFF)     # success green

# Check mark as two line segments in normalized coords
SEGMENTS = [
    ((0.27, 0.52), (0.43, 0.68)),
    ((0.43, 0.68), (0.74, 0.33)),
]


def write_png(path, size):
    def sample(x, y):
        # rounded-rect mask
        r = 0.22 * size
        cx = min(max(x, r), size - 1 - r)
        cy = min(max(y, r), size - 1 - r)
        if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
            return (0, 0, 0, 0)

        # distance to nearest check segment
        thickness = 0.075 * size
        best = 1e9
        for (x1, y1), (x2, y2) in SEGMENTS:
            ax, ay = x1 * size, y1 * size
            bx, by = x2 * size, y2 * size
            dx, dy = bx - ax, by - ay
            t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
            px, py = ax + t * dx, ay + t * dy
            best = min(best, ((x - px) ** 2 + (y - py) ** 2) ** 0.5)
        if best <= thickness:
            return CHECK
        return BG

    # supersample
    px = bytearray()
    for y in range(size):
        px.append(0)  # filter: none
        for x in range(size):
            acc = [0, 0, 0, 0]
            for oy in (0.25, 0.75):
                for ox in (0.25, 0.75):
                    c = sample(x + ox, y + oy)
                    for i in range(4):
                        acc[i] += c[i]
            px.extend(bytes(a // 4 for a in acc))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(px), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({size}x{size})")


os.makedirs(OUT, exist_ok=True)
for s in (16, 48, 128):
    write_png(os.path.join(OUT, f"icon{s}.png"), s)
