#!/usr/bin/env python3
"""Generate rounded-square gradient bookmark icons (16/48/128)."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')
os.makedirs(OUT, exist_ok=True)


def make_icon(size: int) -> Image.Image:
    s = size
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角方形渐变背景（浅色玻璃 + 蓝色渐变，模拟毛玻璃高光）
    radius = max(2, int(s * 0.22))
    top = (111, 182, 255)     # #6fb6ff
    bottom = (45, 118, 232)   # #2d76e8
    for y in range(s):
        t = y / (s - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        d.line([(0, y), (s, y)], fill=(r, g, b, 255))
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=None)

    # 白色书签符号（右侧小三角 + 顶部缺口）
    w = s * 0.5
    x0 = (s - w) / 2
    y0 = s * 0.22
    y1 = s * 0.78
    notch = s * 0.12
    d.polygon(
        [
            (x0, y0),
            (x0 + w, y0),
            (x0 + w, y1),
            (x0 + w / 2, y1 - notch),
            (x0, y1),
        ],
        fill=(255, 255, 255, 255),
    )

    # 顶部缺口镂空
    d.polygon(
        [
            (x0, y0),
            (x0 + w, y0),
            (x0 + w, y0 + notch),
            (x0 + w / 2, y0 + notch),
            (x0, y0 + notch),
        ],
        fill=None,
    )

    # 应用圆角蒙版
    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s, s], radius=radius, fill=255)
    img.putalpha(mask)
    return img


for size in (16, 48, 128):
    make_icon(size).save(os.path.join(OUT, f'icon{size}.png'))
    print('wrote', f'icon{size}.png')
