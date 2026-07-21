from PIL import Image

src = Image.open("icon.png").convert("RGBA")
w, h = src.size
print("source size:", w, h)

# The source is a full banner (emblem + "APPLYORNOT" wordmark) on a dark background.
# Icons need just the emblem, tightly and evenly cropped, since the wordmark is
# illegible at 16-48px anyway. Based on visual inspection the emblem's bounding box
# is roughly x:380-805, y:145-565 (centered around x~592, y~355). Crop a square
# centered there with a bit of breathing room.
cx, cy = 592, 355
half = 235  # -> 470x470 crop, tight enough to exclude the wordmark text below

box = (cx - half, cy - half, cx + half, cy + half)
cropped = src.crop(box)
print("cropped size:", cropped.size)
cropped.save("/tmp/icon_test/cropped_preview.png")

for size in (16, 48, 128):
    resized = cropped.resize((size, size), Image.LANCZOS)
    resized.save(f"icons/icon{size}.png")
    print(f"wrote icons/icon{size}.png")
