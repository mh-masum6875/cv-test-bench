"""Create a small synthetic test video: objects walk through the scene, with quiet gaps.

Use it to try the dashboard without a camera:  python scripts/make_demo_video.py
"""
import sys
import cv2
import numpy as np

out = sys.argv[1] if len(sys.argv) > 1 else "demo.mp4"
W, H, FPS, SECONDS = 640, 360, 15, 40
vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
rng = np.random.default_rng(3)
noise = rng.integers(0, 6, (H, W, 3), dtype=np.uint8)
# (start_s, end_s, y, speed_px_per_s, size, colour)
walkers = [(4, 14, 200, 70, (46, 90), (60, 90, 230)), (8, 20, 250, -60, (50, 100), (230, 160, 60)),
           (26, 37, 180, 90, (60, 110), (90, 200, 120)), (29, 38, 260, -80, (44, 88), (200, 90, 200))]
for i in range(FPS * SECONDS):
    t = i / FPS
    img = np.full((H, W, 3), (74, 82, 88), np.uint8)
    cv2.rectangle(img, (0, 280), (W, H), (58, 64, 70), -1)               # floor
    cv2.line(img, (0, 280), (W, 280), (96, 104, 110), 2)
    img = cv2.add(img, noise)
    for s, e, y, v, (bw, bh), col in walkers:
        if s <= t <= e:
            x = int((t - s) * v) if v > 0 else int(W - (t - s) * -v)
            cv2.rectangle(img, (x, y - bh // 2), (x + bw, y + bh // 2 + 20), col, -1)
            cv2.circle(img, (x + bw // 2, y - bh // 2 - 12), 12, col, -1)
    vw.write(img)
vw.release()
print("wrote", out)
