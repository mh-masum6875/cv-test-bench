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


class OnnxDetector(Detector):
    """YOLO detection models exported to ONNX, run with ONNX Runtime. Needs no PyTorch.

    Handles both export layouts: the classic (1, 4 + classes, N) output that still needs NMS
    (YOLOv5u, YOLOv8, YOLO11) and the end-to-end (1, N, 6) output with boxes already filtered
    (YOLO26, or any export made with nms=True).
    """

    _cache = {}
    _cache_lock = threading.Lock()

    def __init__(self, path):
        try:
            import onnxruntime as ort
        except ImportError as e:
            raise RuntimeError("onnxruntime is not installed. Run: pip install onnxruntime") from e
        with self._cache_lock:
            if path not in self._cache:
                providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider")
                             if p in ort.get_available_providers()]
                sess = ort.InferenceSession(path, providers=providers)
                self._cache[path] = (sess, threading.Lock())
        self.sess, self.lock = self._cache[path]
        meta = self.sess.get_modelmeta().custom_metadata_map
        self.names = _parse_names(meta.get("names", ""))
        shape = self.sess.get_inputs()[0].shape
        size = [s if isinstance(s, int) else 640 for s in shape[2:4]]
        self.in_h, self.in_w = size
        self.input_name = self.sess.get_inputs()[0].name

    def _letterbox(self, frame):
        h, w = frame.shape[:2]
        r = min(self.in_w / w, self.in_h / h)
        nw, nh = int(round(w * r)), int(round(h * r))
        img = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)
        top, left = (self.in_h - nh) // 2, (self.in_w - nw) // 2
        canvas = np.full((self.in_h, self.in_w, 3), 114, np.uint8)
        canvas[top:top + nh, left:left + nw] = img
        blob = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        return np.ascontiguousarray(blob), r, left, top

    def detect(self, frame, conf):
        blob, r, left, top = self._letterbox(frame)
        with self.lock:
            out = self.sess.run(None, {self.input_name: blob})[0][0]
        h, w = frame.shape[:2]
        if out.ndim == 2 and out.shape[1] == 6 and out.shape[0] > out.shape[1]:   # end-to-end: x1,y1,x2,y2,score,class
            boxes, scores, cls = out[:, :4], out[:, 4], out[:, 5].astype(int)
            keep = scores >= conf
            boxes, scores, cls = boxes[keep], scores[keep], cls[keep]
        else:                                                                    # raw: (4 + classes, N)
            if out.shape[0] > out.shape[1]:
                out = out.T
            cls_scores = out[4:]
            cls = cls_scores.argmax(0)
            scores = cls_scores[cls, np.arange(cls_scores.shape[1])]
            keep = scores >= conf
            xywh, scores, cls = out[:4, keep].T, scores[keep], cls[keep]
            boxes = (np.stack([xywh[:, 0] - xywh[:, 2] / 2, xywh[:, 1] - xywh[:, 3] / 2,
                               xywh[:, 0] + xywh[:, 2] / 2, xywh[:, 1] + xywh[:, 3] / 2], 1)
                     if len(xywh) else np.zeros((0, 4)))
            if len(boxes):
                idx = cv2.dnn.NMSBoxesBatched(
                    [[float(b[0]), float(b[1]), float(b[2] - b[0]), float(b[3] - b[1])] for b in boxes],
                    scores.tolist(), cls.tolist(), conf, 0.5)
                idx = np.array(idx, dtype=int).reshape(-1)
                boxes, scores, cls = boxes[idx], scores[idx], cls[idx]
        result = []
        for b, s, c in zip(boxes, scores, cls):
            x1 = float(np.clip((b[0] - left) / r, 0, w))
            y1 = float(np.clip((b[1] - top) / r, 0, h))
            x2 = float(np.clip((b[2] - left) / r, 0, w))
            y2 = float(np.clip((b[3] - top) / r, 0, h))
            if x2 - x1 < 2 or y2 - y1 < 2:
                continue
            c = int(c)
            result.append({"label": self.names[c] if 0 <= c < len(self.names) else str(c),
                           "conf": round(float(s), 2), "box": [x1, y1, x2, y2]})
        return result


def _parse_names(text):
    """Ultralytics stores class names in the ONNX metadata as a Python dict literal."""
    import ast
    try:
        names = ast.literal_eval(text)
        if isinstance(names, dict):
            return [names[k] for k in sorted(names)]
        return list(names)
    except Exception:
        return []


class RFDETRDetector(Detector):
    """Roboflow RF-DETR (Apache 2.0 code and COCO weights).

    `path` is a size name such as rfdetr:medium, or rfdetr:medium:/path/to/checkpoint.pth
    for your own fine-tuned weights."""

    _cache = {}
    _cache_lock = threading.Lock()
    SIZES = {"nano": "RFDETRNano", "small": "RFDETRSmall", "medium": "RFDETRMedium",
             "base": "RFDETRBase", "large": "RFDETRLarge"}

    def __init__(self, path):
        try:
            import rfdetr
        except ImportError as e:
            raise RuntimeError("rfdetr is not installed. Run: pip install rfdetr") from e
        parts = path.split(":", 2)
        size = parts[1] if len(parts) > 1 and parts[1] else "medium"
        weights = parts[2] if len(parts) > 2 else None
        cls_name = self.SIZES.get(size.lower())
        if not cls_name or not hasattr(rfdetr, cls_name):
            raise RuntimeError(f"Unknown RF-DETR size '{size}'. Use one of: {', '.join(self.SIZES)}")
        with self._cache_lock:
            if path not in self._cache:
                kwargs = {"pretrain_weights": weights} if weights else {}
                self._cache[path] = (getattr(rfdetr, cls_name)(**kwargs), threading.Lock())
        self.model, self.lock = self._cache[path]
        names = getattr(self.model, "class_names", None)
        if not names:
            try:
                from rfdetr.util.coco_classes import COCO_CLASSES
                names = COCO_CLASSES
            except Exception:
                names = {}
        self._names = names if isinstance(names, dict) else dict(enumerate(names))
        self.names = [self._names[k] for k in sorted(self._names)]

    def detect(self, frame, conf):
        from PIL import Image
        img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        with self.lock:
            dets = self.model.predict(img, threshold=conf)
        out = []
        for b, c, s in zip(dets.xyxy, dets.class_id, dets.confidence):
            out.append({"label": str(self._names.get(int(c), int(c))), "conf": round(float(s), 2),
                        "box": [float(v) for v in b]})
        return out


def kind_for(path):
    """Which detector class loads this model path."""
    p = str(path).lower()
    if p.startswith("rfdetr:"):
        return "rfdetr"
    if p.endswith(".onnx"):
        return "onnx"
    return "ultralytics"


def build_detector(model):
    if model["kind"] == "motion":
        return MotionDetector()
    if model["kind"] == "ultralytics":
        return UltralyticsDetector(model["path"])
    if model["kind"] == "onnx":
        return OnnxDetector(model["path"])
    if model["kind"] == "rfdetr":
        return RFDETRDetector(model["path"])
    raise RuntimeError(f"Unknown model kind: {model['kind']}")


def inside(box, polygon, w, h):
    """True when the centre of the box lies inside a polygon of normalised points."""
    if not polygon or len(polygon) < 3:
        return True
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    pts = np.array([[p[0] * w, p[1] * h] for p in polygon], dtype=np.float32)
    return cv2.pointPolygonTest(pts, (float(cx), float(cy)), False) >= 0
