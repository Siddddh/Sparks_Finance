"""
make_icons.py — generate the Sparks Finance PWA icon set from the official brand kit.

Source of truth: ../../logo-assets/ (the sparksfinance.ai brand assets). This script
composes the exact PWA outputs the app references from that art, so deploy needs no
build step and every surface stays in sync with the brand.

Brand mark: #445BFB rounded square, white upward line-chart, #FFC042 spark.

Outputs:
  firebase_hosting/icons/icon-192.png          (any)        <- app-icon-192
  firebase_hosting/icons/icon-512.png          (any)        <- app-icon-512
  firebase_hosting/icons/icon-512-maskable.png (maskable)   <- app-icon-512 on full-bleed blue
  firebase_hosting/icons/apple-touch-icon.png  (180, opaque)<- app-icon-512 flattened on blue
  firebase_hosting/favicon.ico                 (16/32/48)   <- favicon mark

Run:  pip install pillow && python KV/make_icons.py
"""
import os
from PIL import Image

BRAND_BLUE = (68, 91, 251, 255)   # #445BFB — the app-icon background

BASE = os.path.dirname(os.path.abspath(__file__))
ICONS_DIR = os.path.join(BASE, "firebase_hosting", "icons")
ROOT_DIR = os.path.join(BASE, "firebase_hosting")
ASSETS = os.path.abspath(os.path.join(BASE, "..", "..", "logo-assets"))


def load(name):
    p = os.path.join(ASSETS, name)
    if not os.path.exists(p):
        raise SystemExit("Brand asset not found: " + p)
    return Image.open(p).convert("RGBA")


def main():
    os.makedirs(ICONS_DIR, exist_ok=True)
    icon192 = load("sparksfinance-app-icon-192.png")
    icon512 = load("sparksfinance-app-icon-512.png")

    # Standard "any" icons — straight from the brand kit (rounded, transparent corners).
    icon192.save(os.path.join(ICONS_DIR, "icon-192.png"))
    icon512.save(os.path.join(ICONS_DIR, "icon-512.png"))

    # Maskable — composite onto a full-bleed brand-blue square so platform masks
    # (circle/squircle) crop the corners cleanly; the chart+spark sit well inside the
    # ~80% safe zone, so nothing important is clipped.
    maskable = Image.new("RGBA", icon512.size, BRAND_BLUE)
    maskable.alpha_composite(icon512)
    maskable.save(os.path.join(ICONS_DIR, "icon-512-maskable.png"))

    # Apple touch icon — 180x180 opaque (iOS ignores transparency and rounds corners).
    apple = Image.new("RGBA", (180, 180), BRAND_BLUE)
    apple.alpha_composite(icon512.resize((180, 180), Image.LANCZOS))
    apple.convert("RGB").save(os.path.join(ICONS_DIR, "apple-touch-icon.png"))

    # Favicon — multi-resolution .ico from the full app mark (chart + spark) so the browser tab matches the in-app logo.
    icon192.save(os.path.join(ROOT_DIR, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])

    print("Icons written to:", ICONS_DIR)
    for f in ["icon-192.png", "icon-512.png", "icon-512-maskable.png", "apple-touch-icon.png"]:
        print("  ", f)
    print("Favicon:", os.path.join(ROOT_DIR, "favicon.ico"))


if __name__ == "__main__":
    main()
