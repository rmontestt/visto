"""Draw the extension icons (PNG, as Chrome requires) from the Visto logo geometry.

    python scripts/make_icons.py

Same shapes as worker/public/favicon.svg on its 32x32 grid: a red rounded rectangle
with a white triangle pointing down (the "V" of Visto). Pure standard library:
4x4 supersampling for anti-aliasing, zlib for the PNG.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
RED = (0xFF, 0x00, 0x33)
WHITE = (0xFF, 0xFF, 0xFF)
SS = 4  # samples per pixel side

# favicon.svg: <rect x="1" y="5" width="30" height="22" rx="7"/> and M11 11.75 h10 l-5 8.5 z
RECT = (1.0, 5.0, 31.0, 27.0, 7.0)
TRI = ((11.0, 11.75), (21.0, 11.75), (16.0, 20.25))


def in_rrect(x: float, y: float) -> bool:
    x0, y0, x1, y1, r = RECT
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_tri(x: float, y: float) -> bool:
    (ax, ay), (bx, by), (cx, cy) = TRI
    def side(px, py, qx, qy):
        return (qx - px) * (y - py) - (qy - py) * (x - px)
    d1, d2, d3 = side(ax, ay, bx, by), side(bx, by, cx, cy), side(cx, cy, ax, ay)
    return (d1 >= 0 and d2 >= 0 and d3 >= 0) or (d1 <= 0 and d2 <= 0 and d3 <= 0)


def render(size: int) -> bytes:
    scale = 32 / size
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG filter: none
        for px in range(size):
            red = white = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) * scale
                    y = (py + (sy + 0.5) / SS) * scale
                    if in_rrect(x, y):
                        if in_tri(x, y):
                            white += 1
                        else:
                            red += 1
            n = SS * SS
            a = (red + white) / n
            if a == 0:
                row += bytes(4)
                continue
            # colour of the covered part, alpha = coverage (straight alpha)
            col = [round((RED[i] * red + WHITE[i] * white) / (red + white)) for i in range(3)]
            row += bytes(col + [round(a * 255)])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        (OUT / f"icon{size}.png").write_bytes(render(size))
        print(f"extension/icons/icon{size}.png")
