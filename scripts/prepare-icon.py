"""ICO из существующей иконки проекта; Pillow нужен только на сборочной машине."""

from pathlib import Path

from PIL import Image

root = Path(__file__).resolve().parents[1]
output = root / "desktop/resources/icon.ico"
output.parent.mkdir(parents=True, exist_ok=True)
with Image.open(root / "frontend/public/branding/icon-192.png") as image:
    image.convert("RGBA").resize((256, 256), Image.Resampling.LANCZOS).save(
        output, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )
