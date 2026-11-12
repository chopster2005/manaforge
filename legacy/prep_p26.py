#!/usr/bin/env python3
"""Pass 26 reproduction composites — hand-held geometry for the two
2026-11-10 11:56/11:58 EST panels (taken on the Pass 24c build).

Defect 1 (Swamp panel, 1000044672): hand-held card, NOT the box —
card angled in hand near a desk edge, bright background ABOVE the
card. Panel: rect detected (0.03,0.00)-(0.78,0.73), frame retained;
straightened card clean and complete, yet BOTH published band
thumbnails pure uniform white; bottom classified 'band bleached —
no text' pre-OCR; title burned 2.1s for raw read 'R'. The card is a
regular-frame basic land: its lower ~35% is the near-uniform
text-box/symbol area (very low texture), so the texture-slab
detector + aspect growth can displace the read rect off the card's
text rows while the dewarp (a resample of the same crop) still
LOOKS clean and the image channel's rect hypotheses still match.

Defect 2 (Eye of Jace panel, 1000044674): Eye of Jace FRA #170 at
rect (0.00,0.13)-(0.68,0.82); title band thumbnail visibly clean,
pooled read '1 Eye ol lace To', title stage 123ms, top suggestion
'Eye to Eye · 76%'.

v2: LARGE Scryfall images, a slight keystone (hand-held perspective),
a TEXTURED background (sensor noise + a horizontal desk edge behind
the card — the panel shows one), and gentler blur: v1's clean
gradient let detection nail the card and its heavy blur killed the
glyphs, so neither panel shape reproduced.

Outputs .cache/p26/<id>.rgba + .json + manifest.json (prep.py shape:
trueRect = the card's axis-aligned bbox in frame fractions,
titleCentroidCard from the ink-centroid method, panelRect = the
rect the device reported, for the forced-rect band-stage run).
"""
import json
import os
import random
import urllib.request

from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, ".cache", "p26")
os.makedirs(OUT, exist_ok=True)

FRAME_W, FRAME_H = 1080, 1920


def fetch_card_image(url: str, name: str) -> Image.Image:
    path = os.path.join(OUT, name + ".jpg")
    if not os.path.exists(path):
        req = urllib.request.Request(url, headers={"User-Agent": "manabox-harness/1.0"})
        with urllib.request.urlopen(req) as r, open(path, "wb") as f:
            f.write(r.read())
    return Image.open(path).convert("RGB")


def scryfall_image(set_code: str, number: str, name: str) -> Image.Image:
    api = f"https://api.scryfall.com/cards/{set_code}/{number}"
    req = urllib.request.Request(api, headers={"User-Agent": "manabox-harness/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req) as r:
        card = json.load(r)
    return fetch_card_image(card["image_uris"]["large"], name)


def title_centroid(im: Image.Image) -> float:
    w, h = im.size
    gray = im.convert("L")
    px = gray.load()
    y0, y1 = int(h * 0.015), int(h * 0.14)
    total, weighted = 0.0, 0.0
    for y in range(y0, y1):
        row = sorted(px[x, y] for x in range(0, w, 3))
        med = row[len(row) // 2]
        for x in range(0, w, 2):
            if abs(px[x, y] - med) > 36:
                total += 1
                weighted += y
    if total < 20:
        return 0.072
    return (weighted / total) / h


def textured_background(top, bottom, desk_edge_y: float, seed: int) -> Image.Image:
    """Vertical gradient + per-pixel sensor noise + a soft horizontal
    desk edge (a darker band) behind where the card will sit."""
    rnd = random.Random(seed)
    frame = Image.new("RGB", (FRAME_W, FRAME_H))
    fp = frame.load()
    edge_yc = FRAME_H * desk_edge_y
    for y in range(FRAME_H):
        t = y / FRAME_H
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        # Desk edge: a smooth darker step around edge_yc.
        import math
        step = 1.0 - 0.16 / (1.0 + math.exp(-(y - edge_yc) / 14.0))
        for x in range(FRAME_W):
            n = rnd.randint(-7, 7)
            fp[x, y] = (
                max(0, min(255, int(r * step) + n)),
                max(0, min(255, int(g * step) + n)),
                max(0, min(255, int(b * step) + n)),
            )
    return frame


def keystone(card: Image.Image, top_frac: float) -> Image.Image:
    """Taper the top edge to top_frac of the width (hand-held
    perspective: the far edge reads narrower)."""
    w, h = card.size
    inset = int(w * (1 - top_frac) / 2)

    def find_coeffs(target, source):
        import numpy as np
        matrix = []
        for p1, p2 in zip(source, target):
            matrix.append([p1[0], p1[1], 1, 0, 0, 0, -p2[0] * p1[0], -p2[0] * p1[1]])
            matrix.append([0, 0, 0, p1[0], p1[1], 1, -p2[1] * p1[0], -p2[1] * p1[1]])
        a = np.matrix(matrix, dtype=float)
        b = np.array(target).reshape(8)
        res = np.linalg.solve(a, b)
        return np.array(res).reshape(8)

    coeffs = find_coeffs(
        [(inset, 0), (w - inset, 0), (w, h), (0, h)],
        [(0, 0), (w, 0), (w, h), (0, h)],
    )
    return card.transform((w, h), Image.PERSPECTIVE, coeffs, Image.BICUBIC)


def composite(card: Image.Image, bg: Image.Image, angle_deg: float,
              centre: tuple, card_w_frac: float) -> tuple:
    cw = int(FRAME_W * card_w_frac)
    ch = int(cw * 88 / 63)
    card_r = keystone(card.resize((cw, ch), Image.LANCZOS), 0.94)
    rot = card_r.rotate(angle_deg, resample=Image.BICUBIC, expand=True,
                        fillcolor=(238, 233, 224))
    cx, cy = int(FRAME_W * centre[0]), int(FRAME_H * centre[1])
    ox, oy = cx - rot.width // 2, cy - rot.height // 2
    frame = bg.copy()
    frame.paste(rot, (ox, oy))
    frame = frame.filter(ImageFilter.GaussianBlur(0.35))
    rect = {
        "x0": ox / FRAME_W, "y0": oy / FRAME_H,
        "x1": (ox + rot.width) / FRAME_W, "y1": (oy + rot.height) / FRAME_H,
    }
    return frame, rect


def emit(fid: str, frame: Image.Image, rect: dict, centroid: float,
         expected: dict, notes: str, panel_rect: dict):
    rgba = frame.convert("RGBA")
    with open(os.path.join(OUT, fid + ".rgba"), "wb") as f:
        f.write(rgba.tobytes())
    with open(os.path.join(OUT, fid + ".json"), "w") as f:
        json.dump({"width": frame.width, "height": frame.height}, f)
    return {
        "id": fid,
        "file": fid,
        "expected": expected,
        "trueRect": rect,
        "titleCentroidCard": centroid,
        "panelRect": panel_rect,
        "mode": {"type": "photo"},
        "notes": notes,
    }


def main():
    manifest = []
    # Defect 1 — regular-frame Swamp (MDD 296: the big near-uniform
    # text-box/symbol area fills the lower card), hand-held against a
    # bright textured wall/desk, top tilted ~5 degrees, desk edge
    # crossing behind the card's upper third.
    swamp = scryfall_image("mdd", "296", "swamp-mdd-296")
    bg = textured_background((242, 238, 230), (198, 190, 176), desk_edge_y=0.30, seed=26)
    frame, rect = composite(swamp, bg, angle_deg=-2.0, centre=(0.40, 0.44), card_w_frac=0.71)
    manifest.append(emit(
        "p26-swamp-hand", frame, rect, title_centroid(swamp),
        {"name": "Swamp", "set": "mdd", "number": "296"},
        "Pass 26 Defect 1: hand-held regular-frame Swamp, bright textured background + desk edge, ~5deg tilt + keystone. Panel rect (0.03,0.00)-(0.78,0.73); bands pure white on-device.",
        {"x0": 0.03, "y0": 0.00, "x1": 0.78, "y1": 0.73},
    ))
    # Defect 2 — Eye of Jace FRA #170, smaller in frame, mid-tone desk.
    eye = scryfall_image("fra", "170", "eye-of-jace-fra-170")
    bg2 = textured_background((116, 108, 100), (76, 68, 62), desk_edge_y=0.62, seed=27)
    frame, rect = composite(eye, bg2, angle_deg=1.5, centre=(0.35, 0.47), card_w_frac=0.64)
    manifest.append(emit(
        "p26-eye-hand", frame, rect, title_centroid(eye),
        {"name": "Eye of Jace", "set": "fra", "number": "170"},
        "Pass 26 Defect 2: hand-held Eye of Jace FRA 170. Panel rect (0.00,0.13)-(0.68,0.82); pooled read '1 Eye ol lace To', top 'Eye to Eye'.",
        {"x0": 0.00, "y0": 0.13, "x1": 0.68, "y1": 0.82},
    ))
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    for m in manifest:
        r = m["trueRect"]
        print(m["id"], "trueRect", {k: round(v, 3) for k, v in r.items()},
              "titleCentroid", round(m["titleCentroidCard"], 3))


if __name__ == "__main__":
    main()
