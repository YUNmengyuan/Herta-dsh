"""把 D 盘那份 Herta 应用图标做成符合 DSH 插件清单约束的 icon.png。

DSH 的约束（`@deepseek-ai/dsh-package-manifest/types` 的 `DshPackageManifest.icon`）：
  · SVG / PNG / JPEG / WebP
  · **不超过 256 KiB**
  · 必须位于 manifest 所在目录之内（realpath 解析后仍在里面）

源图是 1024×1024 / 1.16 MB，两条都不满足，所以要缩放重编码。
"""
from pathlib import Path
from PIL import Image

SRC = Path(r"D:\Herta\resources\app.asar.unpacked\resources\herta-icon.png")
DST = Path(r"E:\deepseek工作区\HerTa\dsh-herta\icon.png")
LIMIT = 256 * 1024

im = Image.open(SRC)
print(f"源图: {im.size} {im.mode} {SRC.stat().st_size} B")

# 有 alpha 就保留，没有就转 RGB（RGB 的 PNG 明显更小）
has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
im = im.convert("RGBA" if has_alpha else "RGB")
print(f"alpha: {has_alpha}  转换后模式: {im.mode}")

# 从大到小试，取第一个 ≤ 256 KiB 的档位 —— 宁可用更大的尺寸，也不要糊。
for size in (512, 384, 320, 256, 192, 128):
    out = im.resize((size, size), Image.LANCZOS)
    out.save(DST, format="PNG", optimize=True)
    n = DST.stat().st_size
    ok = "OK  " if n <= LIMIT else "OVER"
    print(f"{ok} {size}x{size}  {n:>8} B  ({n / 1024:.1f} KiB)")
    if n <= LIMIT:
        print(f"\n采用 {size}x{size} → {DST}")
        break
else:
    raise SystemExit("所有档位都超过 256 KiB")

print(f"最终: {Image.open(DST).size} {DST.stat().st_size} B")
