"""Time the bundled detectors on the sample clips and write the numbers to results/.

    python scripts/bench.py

Each clip is decoded into memory first, so the timing covers detect() only: resize,
inference and box filtering, not video decoding. The first 20 frames of each clip are
run once as a warm-up and are not counted.
"""
import csv
import datetime as dt
import pathlib
import platform
import statistics
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402

from app.detectors import MotionDetector, OnnxDetector  # noqa: E402

CLIPS = ["people", "retail", "traffic", "safety", "bottles"]
MODELS = [
    ("Motion detector", lambda: MotionDetector()),
    ("YOLOv8n COCO, ONNX 416", lambda: OnnxDetector(str(ROOT / "docs/models/yolo/yolov8n-416.onnx"))),
    ("YOLOv8n Open Images V7, ONNX 416", lambda: OnnxDetector(str(ROOT / "docs/models/yolo/yolov8n-oiv7-416.onnx"))),
]
WARMUP = 20
CONF = 0.4


def frames_of(path):
    cap = cv2.VideoCapture(str(path))
    out = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        out.append(frame)
    cap.release()
    return out


def main():
    out_dir = ROOT / "results"
    out_dir.mkdir(exist_ok=True)
    rows, raw = [], []
    for clip in CLIPS:
        frames = frames_of(ROOT / "docs/samples" / f"{clip}.mp4")
        h, w = frames[0].shape[:2]
        for name, make in MODELS:
            det = make()
            for f in frames[:WARMUP]:
                det.detect(f, CONF)
            times, boxes = [], 0
            for i, f in enumerate(frames):
                t = time.perf_counter()
                found = det.detect(f, CONF)
                ms = (time.perf_counter() - t) * 1000
                times.append(ms)
                boxes += len(found)
                raw.append([clip, name, i, round(ms, 3), len(found)])
            times.sort()
            mean = statistics.fmean(times)
            row = {
                "clip": clip, "frame_size": f"{w}x{h}", "frames": len(frames), "model": name,
                "mean_ms": round(mean, 2), "median_ms": round(statistics.median(times), 2),
                "p95_ms": round(times[int(0.95 * (len(times) - 1))], 2),
                "fps": round(1000 / mean, 1), "boxes_per_frame": round(boxes / len(frames), 2),
            }
            rows.append(row)
            print(row)
    with open(out_dir / "bench.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=list(rows[0]))
        wr.writeheader()
        wr.writerows(rows)
    with open(out_dir / "bench_frames.csv", "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["clip", "model", "frame", "ms", "boxes"])
        wr.writerows(raw)
    with open(out_dir / "bench_env.txt", "w") as f:
        f.write(f"date: {dt.date.today().isoformat()}\n")
        f.write(f"cpu: {platform.processor()}\n")
        f.write(f"os: {platform.platform()}\n")
        f.write(f"python: {platform.python_version()}\n")
        f.write(f"onnxruntime: {ort.__version__} ({', '.join(ort.get_available_providers())})\n")
        f.write(f"opencv: {cv2.__version__}\n")
        f.write(f"numpy: {np.__version__}\n")
        f.write(f"confidence threshold: {CONF}, warm-up frames: {WARMUP}\n")


if __name__ == "__main__":
    main()
