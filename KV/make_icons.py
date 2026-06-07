"""
make_icons.py — generate the Sparks Finance PWA icon set.

Draws the brand "spark" (lightning bolt) in white on a #1a73e8 rounded square and
exports the PNG sizes a PWA needs, plus a multi-size favicon.ico.

Outputs (committed to git so deploy needs no build step):
  firebase_hosting/icons/icon-192.png          (any)
  firebase_hosting/icons/icon-512.png          (any)
  firebase_hosting/icons/icon-512-maskable.png (maskable — extra safe-zone padding)
  firebase_hosting/icons/apple-touch-icon.png  (180x180, opaque)
  firebase_hosting/favicon.ico                 (16/32/48)

Run once:  pip install pillow && python KV/make_icons.py
"""
import os
from PIL import Image, ImageDraw

BLUE = (26, 115, 232, 255)   # --blue #1a73e8
WHITE = (255, 255, 255, 255)

BASE = os.path.dirname(os.path.abspath(__file__))
ICONS_DIR = os.path.join(BASE, "firebase_hosting", "icons")
ROOT_DIR = os.path.join(BASE, "firebase_hosting")

# Spark polygon, decoded from the SVG path "M13 2 3 14h9l-1 8 10-12h-9l1-8z"
# in a 24x24 viewBox. Points: (13,2)(3,14)(12,14)(11,22)(21,10)(12,10).
SPARK_24 = [(13, 2), (3, 14), (12, 14), (11, 22), (21, 10), (12, 10)]
VIEWBOX = 24.0


def rounded_square(size, radius_frac, bg):
    """Solid rounded-square background on a transparent canvas."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * radius_frac)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=bg)
    return img


def draw_spark(img, content_frac):
    """Center the spark, scaled to content_frac of the canvas."""
    size = img.size[0]
    d = ImageDraw.Draw(img)
    content = size * content_frac
    scale = content / VIEWBOX
    offset = (size - content) / 2.0
    pts = [(x * scale + offset, y * scale + offset) for (x, y) in SPARK_24]
    d.polygon(pts, fill=WHITE)
    return img


def make(size, radius_frac, content_frac, bg=BLUE):
    img = rounded_square(size, radius_frac, bg)
    return draw_spark(img, content_frac)


def main():
    os.makedirs(ICONS_DIR, exist_ok=True)

    # Standard "any" icons — rounded square, generous spark.
    make(192, 0.22, 0.56).save(os.path.join(ICONS_DIR, "icon-192.png"))
    make(512, 0.22, 0.56).save(os.path.join(ICONS_DIR, "icon-512.png"))

    # Maskable — full-bleed bg (no corner rounding) + smaller spark inside the
    # ~80% safe zone so platform masks (circle/squircle) never clip it.
    make(512, 0.0, 0.46).save(os.path.join(ICONS_DIR, "icon-512-maskable.png"))

    # Apple touch icon — opaque (iOS ignores transparency), square corners.
    apple = Image.new("RGBA", (180, 180), BLUE)
    draw_spark(apple, 0.56)
    apple.convert("RGB").save(os.path.join(ICONS_DIR, "apple-touch-icon.png"))

    # Favicon — multi-resolution .ico.
    fav = make(64, 0.18, 0.6)
    fav.save(os.path.join(ROOT_DIR, "favicon.ico"),
             sizes=[(16, 16), (32, 32), (48, 48)])

    print("Icons written to:", ICONS_DIR)
    for f in ["icon-192.png", "icon-512.png", "icon-512-maskable.png", "apple-touch-icon.png"]:
        print("  ", f)
    print("Favicon:", os.path.join(ROOT_DIR, "favicon.ico"))


if __name__ == "__main__":
    main()
