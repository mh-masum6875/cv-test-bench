"""Make a short synthetic test clip for the stray dog analytic.

It pastes a photo of a dog and a person onto a plain street-like background:
  0-7 s    a dog walks with a person next to it (accompanied, should stay grey)
  7-9 s    the person walks off
  9-24 s   the dog keeps walking alone (unaccompanied, turns red)
  12-24 s  a second dog walks in from the other side and stops (two unaccompanied dogs)

The dog is from darknet's data/dog.jpg (downloaded at run time). The person is cut from the
Intel IoT DevKit retail sample in docs/samples (CC BY 4.0). This clip only checks the pipeline.
Use real camera footage for any pitch or evaluation.

    python scripts/make_stray_demo_video.py stray_demo.mp4            # 960x540
    python scripts/make_stray_demo_video.py stray.mp4 640 360         # size used by the hosted demo
"""
import sys
import urllib.request
from pathlib import Path

import cv2
import numpy as np

DOG_URL = "https://raw.githubusercontent.com/pjreddie/darknet/master/data/dog.jpg"
PERSON_CLIP = Path(__file__).resolve().parent.parent / "docs" / "samples" / "retail.mp4"
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


def person_sprite():
    cap = cv2.VideoCapture(str(PERSON_CLIP))
    cap.set(cv2.CAP_PROP_POS_FRAMES, 210)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise SystemExit(f"Could not read {PERSON_CLIP}")
    return frame[84:311, 312:428]                        # a shopper in the CC BY 4.0 retail sample


def main(out="stray_demo.mp4", w=960, h=540, fps=15, seconds=24):
    w, h = int(w), int(h)
    k = h / 540                                          # sprite sizes follow the frame height
    dog_img = fetch(DOG_URL, "dog.jpg")
    dog = dog_img[219:542, 129:312]                      # the dog in darknet's dog.jpg
    person = person_sprite()
    dh, ph = int(220 * k), int(260 * k)                  # small models miss the dog below ~40% of frame height
    dog = cv2.resize(dog, (int(dog.shape[1] * dh / dog.shape[0]), dh))
    person = cv2.resize(person, (int(person.shape[1] * ph / person.shape[0]), ph))
    bg = background(w, h)
    vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    for i in range(fps * seconds):
        t = i / fps
        f = bg.copy()
        x1 = 30 * k + t * 20 * k                         # dog 1 walks right, slowly
        paste(f, dog, x1, h * 0.92)
        if t < 7:                                        # the person walks beside it
            paste(f, person, x1 + 120 * k, h * 0.92)
        elif t < 9:                                      # then walks off to the right
            paste(f, person, x1 + 120 * k + (t - 7) * 420 * k, h * 0.92)
        if 12 <= t:                                      # dog 2 walks in from the right and stops, the dogs never overlap
            paste(f, dog, w - min(t - 12, 3.0) * (w - 720 * k) / 3.0, h * 0.86)
        cv2.putText(f, "Synthetic test clip", (int(10 * k) + 2, int(28 * k) + 2), cv2.FONT_HERSHEY_SIMPLEX, 0.8 * k, (0, 0, 0), 2, cv2.LINE_AA)
        cv2.putText(f, "Synthetic test clip", (int(10 * k), int(28 * k)), cv2.FONT_HERSHEY_SIMPLEX, 0.8 * k, (255, 255, 255), 2, cv2.LINE_AA)
        vw.write(f)
    vw.release()
    print(f"Wrote {out}: {seconds}s at {fps} fps, {w}x{h}")


if __name__ == "__main__":
    main(*(sys.argv[1:4] or ["stray_demo.mp4"]))
