"""Make a short synthetic test clip for the stray dog analytic.

It pastes real photos of a dog and a person onto a plain street-like background:
  0-6 s   a dog walks with a person next to it (accompanied, should stay grey)
  6-14 s  the person leaves and the dog keeps walking alone (unaccompanied, turns red)
  9-16 s  a second dog walks in from the other side (two unaccompanied dogs)

The photos are downloaded at run time from public repositories, so nothing is bundled here.
This is only for checking the pipeline end to end. Use real camera footage for any pitch or evaluation.

    python scripts/make_stray_demo_video.py stray_demo.mp4
"""
import sys
import urllib.request
from pathlib import Path

import cv2
import numpy as np

DOG_URL = "https://raw.githubusercontent.com/pjreddie/darknet/master/data/dog.jpg"
PERSON_URL = "https://raw.githubusercontent.com/ultralytics/assets/main/im/bus.jpg"
CACHE = Path(__file__).resolve().parent.parent / "data" / "demo_assets"


def fetch(url, name):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / name
    if not path.exists():
        urllib.request.urlretrieve(url, path)
    img = cv2.imread(str(path))
    if img is None:
        raise SystemExit(f"Could not read {path}")
    return img


def background(w, h):
    bg = np.zeros((h, w, 3), np.uint8)
    for y in range(h):                                   # sky-to-road gradient
        v = int(150 + 60 * y / h)
        bg[y] = (v - 10, v - 5, v)
    cv2.rectangle(bg, (0, int(h * 0.55)), (w, h), (95, 98, 100), -1)            # road
    cv2.rectangle(bg, (0, int(h * 0.50)), (w, int(h * 0.56)), (160, 165, 170), -1)  # kerb
    for x in range(0, w, 120):                                                     # lane marks
        cv2.rectangle(bg, (x, int(h * 0.8)), (x + 60, int(h * 0.81)), (225, 225, 225), -1)
    noise = np.random.default_rng(1).normal(0, 4, bg.shape)
    return np.clip(bg + noise, 0, 255).astype(np.uint8)


def paste(frame, sprite, x, y, flip=False):
    """Paste a sprite with its bottom-left corner at (x, y)."""
    s = cv2.flip(sprite, 1) if flip else sprite
    h, w = s.shape[:2]
    H, W = frame.shape[:2]
    x0, y0 = int(x), int(y) - h
    xs0, ys0 = max(0, -x0), max(0, -y0)
    x1, y1 = min(W, x0 + w), min(H, y0 + h)
    if x1 <= max(0, x0) or y1 <= max(0, y0):
        return
    frame[max(0, y0):y1, max(0, x0):x1] = s[ys0:ys0 + (y1 - max(0, y0)), xs0:xs0 + (x1 - max(0, x0))]


def main(out="stray_demo.mp4", w=960, h=540, fps=15, seconds=16):
    dog_img = fetch(DOG_URL, "dog.jpg")
    person_img = fetch(PERSON_URL, "bus.jpg")
    dog = dog_img[219:542, 129:312]                      # the dog in darknet's dog.jpg
    person = person_img[392:906, 50:243]                 # a person in Ultralytics' bus.jpg
    dog = cv2.resize(dog, (int(dog.shape[1] * 220 / dog.shape[0]), 220))  # small models miss it below ~200 px
    person = cv2.resize(person, (int(person.shape[1] * 260 / person.shape[0]), 260))
    bg = background(w, h)
    vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    for i in range(fps * seconds):
        t = i / fps
        f = bg.copy()
        x1 = 40 + t * 45                                 # dog 1 walks right
        paste(f, dog, x1, h * 0.92)
        if t < 6:                                        # the person walks beside it
            paste(f, person, x1 + 120, h * 0.92)
        elif t < 8:                                      # then walks off to the top right
            paste(f, person, x1 + 120 + (t - 6) * 260, h * 0.92)
        if 9 <= t:                                       # dog 2 enters from the right
            paste(f, dog, w - 200 - (t - 9) * 50, h * 0.80, flip=True)
        vw.write(f)
    vw.release()
    print(f"Wrote {out}: {seconds}s at {fps} fps, {w}x{h}")


if __name__ == "__main__":
    main(*(sys.argv[1:2] or ["stray_demo.mp4"]))
