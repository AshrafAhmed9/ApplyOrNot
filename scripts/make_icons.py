import struct, zlib, os

def make_png(path, size, rgb=(37, 99, 235)):
    width = height = size
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)

    raw = bytearray()
    r, g, b = rgb
    cx, cy, radius = width / 2, height / 2, width * 0.42
    for y in range(height):
        raw.append(0)  # filter type none
        for x in range(width):
            d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5
            if d <= radius:
                raw += bytes([r, g, b])
            else:
                raw += bytes([250, 250, 250])
    compressed = zlib.compress(bytes(raw), 9)

    with open(path, "wb") as f:
        f.write(sig)
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", compressed))
        f.write(chunk(b"IEND", b""))

os.makedirs("icons", exist_ok=True)
for size in (16, 48, 128):
    make_png(f"icons/icon{size}.png", size)
print("done")
