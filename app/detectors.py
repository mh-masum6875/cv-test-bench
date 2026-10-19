"""Detectors. Each returns a list of {label, conf, box:[x1,y1,x2,y2]} in pixels.

Add your own by subclassing Detector and registering it in `build_detector`.
"""
import threading

import cv2
import numpy as np


class Detector:
    names = []

    def detect(self, frame, conf):
        raise NotImplementedError


class MotionDetector(Detector):
    """Moving-object detector (background subtraction). No weights needed."""

    names = ["motion"]

    def __init__(self):
        self.bg = cv2.createBackgroundSubtractorMOG2(history=300, varThreshold=32, detectShadows=False)
        self.warm = 0
        self.kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))

    def detect(self, frame, conf):
        h, w = frame.shape[:2]
        scale = 480.0 / w if w > 480 else 1.0
        small = cv2.resize(frame, (int(w * scale), int(h * scale))) if scale != 1.0 else frame
        mask = self.bg.apply(small)
        self.warm += 1
        if self.warm < 20:
            return []
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, self.kernel)
        mask = cv2.dilate(mask, self.kernel, iterations=2)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        area_total = small.shape[0] * small.shape[1]
        out = []
        for c in contours:
            area = cv2.contourArea(c)
            if area < 0.004 * area_total:
                continue
            score = float(min(1.0, 0.4 + area / (0.05 * area_total)))
            if score < conf:
                continue
            x, y, bw, bh = cv2.boundingRect(c)
            out.append({"label": "motion", "conf": round(score, 2),
                        "box": [x / scale, y / scale, (x + bw) / scale, (y + bh) / scale]})
        return out


class UltralyticsDetector(Detector):
    """Any Ultralytics YOLO weights (.pt) or exported model (.onnx, .engine ...)."""

    _cache = {}
    _cache_lock = threading.Lock()

    def __init__(self, path):
        try:
            from ultralytics import YOLO
        except ImportError as e:
            raise RuntimeError("ultralytics is not installed. Run: pip install ultralytics") from e
        with self._cache_lock:
            if path not in self._cache:
                self._cache[path] = (YOLO(path), threading.Lock())
        self.model, self.lock = self._cache[path]
        names = getattr(self.model, "names", {})
        self.names = list(names.values()) if isinstance(names, dict) else list(names)

    def detect(self, frame, conf):
        with self.lock:
            res = self.model.predict(frame, conf=conf, verbose=False)[0]
        out = []
        if res.boxes is None:
            return out
        xyxy = res.boxes.xyxy.cpu().numpy()
        cls = res.boxes.cls.cpu().numpy().astype(int)
        scores = res.boxes.conf.cpu().numpy()
        for b, c, s in zip(xyxy, cls, scores):
            out.append({"label": self.names[c] if c < len(self.names) else str(c),
                        "conf": round(float(s), 2), "box": [float(v) for v in b]})
        return out


def build_detector(model):
    if model["kind"] == "motion":
        return MotionDetector()
    if model["kind"] == "ultralytics":
        return UltralyticsDetector(model["path"])
    raise RuntimeError(f"Unknown model kind: {model['kind']}")


def inside(box, polygon, w, h):
    """True when the centre of the box lies inside a polygon of normalised points."""
    if not polygon or len(polygon) < 3:
        return True
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    pts = np.array([[p[0] * w, p[1] * h] for p in polygon], dtype=np.float32)
    return cv2.pointPolygonTest(pts, (float(cx), float(cy)), False) >= 0
