"""Generate zoomed reference crops from design/reference/*.png.

Crops are 2x-upscaled (LANCZOS) so implementers can read fine detail.
Run: python scripts/crop_reference.py   (requires Pillow)
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / "design" / "reference"
OUT = REF / "crops"

# name: (source image, (left, top, right, bottom)) in source pixels (736x920 images)
CROPS = {
    "rail":          ("home-left.png",  (112, 100, 178, 850)),
    "sidebar":       ("home-left.png",  (168, 100, 364, 785)),
    "sidebar-top":   ("home-left.png",  (168, 100, 364, 420)),
    "integrations":  ("home-left.png",  (168, 415, 364, 560)),
    "capacity-card": ("home-left.png",  (170, 775, 364, 840)),
    "tabs-topbar":   ("home-left.png",  (360, 110, 736, 165)),
    "canvas-header": ("home-left.png",  (362, 160, 736, 215)),
    "hero":          ("home-left.png",  (362, 200, 736, 440)),
    "pinned-cards":  ("home-left.png",  (400, 435, 736, 590)),
    "chips":         ("home-left.png",  (400, 650, 736, 700)),
    "composer-left": ("home-left.png",  (400, 685, 736, 830)),
    "topbar-right":  ("home-right.png", (0, 105, 450, 165)),
    "canvas-right":  ("home-right.png", (0, 160, 215, 470)),
    "composer-right":("home-right.png", (0, 640, 215, 830)),
    "right-panel":   ("home-right.png", (205, 160, 440, 830)),
}

def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (src, box) in CROPS.items():
        img = Image.open(REF / src).convert("RGB").crop(box)
        img = img.resize((img.width * 2, img.height * 2), Image.LANCZOS)
        img.save(OUT / f"{name}.png", optimize=True)
        print(f"{name}.png {img.size}")

if __name__ == "__main__":
    main()
