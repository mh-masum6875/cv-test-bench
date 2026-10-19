"""One worker per camera: read frames, run each analytic, apply alert rules, keep a live JPEG."""
import collections
import datetime as dt
import json
import os
import threading
import time
import urllib.request

import cv2
import numpy as np

from . import db
from .detectors import build_detector, inside
from .rules import RuleState

os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

COLORS = [(46, 190, 170), (60, 140, 250), (250, 170, 60), (200, 90, 220), (90, 200, 90), (80, 80, 240)]


def placeholder(text, w=960, h=540):
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = (28, 22, 18)
    size = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.9, 2)[0]
    cv2.putText(img, text, ((w - size[0]) // 2, h // 2), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (190, 200, 205), 2, cv2.LINE_AA)
    return img


def encode(img, quality=80):
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes() if ok else b""


def open_capture(source, is_file):
    if is_file:
        return cv2.VideoCapture(source)
    try:
        return cv2.VideoCapture(source, cv2.CAP_FFMPEG,
                                [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 6000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 6000])
    except Exception:
        return cv2.VideoCapture(source)


class Analytic:
    """Runtime state for one configured analytic on a camera."""

    def __init__(self, row, color):
        self.row = row
        self.id = row["id"]
        self.color = color
        self.rule = db.loads(row["rule"], {})
        self.classes = [c.lower() for c in db.loads(row["classes"], [])]
        self.roi = db.loads(row["roi"], [])
        self.state = RuleState()
        self.detector = None
        self.error = None
        self.count = 0
        self.infer_ms = 0.0
        self.total = 0
        self.labels = collections.Counter()
        self.history = collections.deque(maxlen=180)    # (ts, count, infer_ms)
        model = db.one("SELECT * FROM models WHERE id=?", (row["model_id"],))
        try:
            if not model:
                raise RuntimeError("Model was deleted")
            self.detector = build_detector(model)
        except Exception as e:                           # keep the camera running, show the error
            self.error = str(e)

    def public(self):
        return {"id": self.id, "name": self.row["name"], "count": self.count,
                "infer_ms": round(self.infer_ms, 1), "total": self.total,
                "labels": dict(self.labels), "error": self.error,
                "history": [[round(t, 1), c, round(m, 1)] for t, c, m in self.history]}


class CameraRunner:
    def __init__(self, camera):
        self.cam = camera
        self.id = camera["id"]
        self.status = "stopped"
        self.message = ""
        self.fps_in = 0.0
        self.fps_out = 0.0
        self.size = None
        self.jpeg = encode(placeholder("Starting..."))
        self.jpeg_ts = time.time()
        self.raw = None
        self.analytics = []
        self._stop = threading.Event()
        self._reload = True
        self.fps_limit = 5.0
        self._frame = None
        self._frame_id = 0
        self._frame_lock = threading.Lock()
        self._threads = []

    # ---------- lifecycle ----------
    def start(self):
        self._stop.clear()
        self.status = "connecting"
        self._threads = [threading.Thread(target=self._read_loop, daemon=True),
                         threading.Thread(target=self._process_loop, daemon=True)]
        for t in self._threads:
            t.start()

    def stop(self):
        self._stop.set()
        self.status = "stopped"
        self.jpeg = encode(placeholder("Stopped"))
        self.jpeg_ts = time.time()

    def reload(self):
        self._reload = True

    # ---------- reading ----------
    def _read_loop(self):
        is_file = self.cam["source_type"] == "file"
        source = self.cam["source"]
        if is_file and not os.path.exists(source):
            self.status, self.message = "error", "Video file not found"
            return
        backoff = 1
        while not self._stop.is_set():
            cap = open_capture(source, is_file)
            if not cap.isOpened():
                self.status, self.message = "error", "Cannot open the source. Retrying..."
                cap.release()
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 15)
                continue
            backoff = 1
            fps = cap.get(cv2.CAP_PROP_FPS) or 25
            fps = fps if 1 <= fps <= 120 else 25
            last, count, t0, fails = time.time(), 0, time.time(), 0
            while not self._stop.is_set():
                ok, frame = cap.read()
                if not ok:
                    fails += 1
                    if is_file or fails > 60:       # file ended, or the stream really stopped
                        break
                    self._stop.wait(0.05)           # streams return empty reads until the first keyframe
                    continue
                fails = 0
                if self.status != "live":
                    self.status, self.message = "live", ""
                with self._frame_lock:
                    self._frame, self._frame_id = frame, self._frame_id + 1
                self.size = [frame.shape[1], frame.shape[0]]
                count += 1
                if time.time() - t0 >= 2:
                    self.fps_in, count, t0 = count / (time.time() - t0), 0, time.time()
                if is_file:                                  # play files at their own speed
                    delay = 1.0 / fps - (time.time() - last)
                    if delay > 0:
                        self._stop.wait(delay)
                    last = time.time()
            cap.release()
            if self._stop.is_set():
                return
            if not is_file:
                self.status, self.message = "error", "Stream dropped. Reconnecting..."
                self._stop.wait(2)
            # files simply loop

    # ---------- processing ----------
    def _load_analytics(self):
        rows = db.q("SELECT * FROM analytics WHERE camera_id=? AND enabled=1 ORDER BY id", (self.id,))
        self.analytics = [Analytic(r, COLORS[i % len(COLORS)]) for i, r in enumerate(rows)]
        cam = db.one("SELECT fps_limit FROM cameras WHERE id=?", (self.id,))
        self.fps_limit = max(0.5, float((cam or {}).get("fps_limit") or 5))
        self._reload = False

    def _process_loop(self):
        last_id, last_proc, n, t0 = -1, 0.0, 0, time.time()
        while not self._stop.is_set():
            if self._reload:
                self._load_analytics()
            fps_limit = self.fps_limit
            with self._frame_lock:
                frame, fid = self._frame, self._frame_id
            if frame is None or fid == last_id or time.time() - last_proc < 1.0 / fps_limit:
                self._stop.wait(0.01)
                continue
            last_id, last_proc = fid, time.time()
            try:
                self._process(frame.copy())
            except Exception as e:
                self.message = f"Processing error: {e}"
            n += 1
            if time.time() - t0 >= 2:
                self.fps_out, n, t0 = n / (time.time() - t0), 0, time.time()

    def _process(self, frame):
        h, w = frame.shape[:2]
        now_ts, now = time.time(), dt.datetime.now()
        for a in self.analytics:
            if a.detector is None:
                continue
            t = time.time()
            try:
                dets = a.detector.detect(frame, float(a.row["conf"]))
            except Exception as e:
                a.error = str(e)
                dets = []
            a.infer_ms = (time.time() - t) * 1000
            dets = [d for d in dets if (not a.classes or d["label"].lower() in a.classes)
                    and inside(d["box"], a.roi, w, h)]
            a.count = len(dets)
            a.total += len(dets)
            a.labels = collections.Counter(d["label"] for d in dets)
            a.history.append((now_ts, a.count, a.infer_ms))
            a.last_dets = dets
        self.raw = frame.copy()
        self._draw(frame)
        for a in self.analytics:
            if a.detector is None:
                continue
            fired = a.state.update(a.rule, a.count, now_ts, now)
            if fired:
                self._raise_alert(a, fired, frame)
        self.jpeg = encode(frame)
        self.jpeg_ts = time.time()

    def _draw(self, frame):
        h, w = frame.shape[:2]
        for a in self.analytics:
            if a.roi and len(a.roi) >= 3:
                pts = np.array([[int(p[0] * w), int(p[1] * h)] for p in a.roi], np.int32)
                overlay = frame.copy()
                cv2.fillPoly(overlay, [pts], a.color)
                cv2.addWeighted(overlay, 0.12, frame, 0.88, 0, frame)
                cv2.polylines(frame, [pts], True, a.color, 2, cv2.LINE_AA)
            for d in getattr(a, "last_dets", []):
                x1, y1, x2, y2 = [int(v) for v in d["box"]]
                cv2.rectangle(frame, (x1, y1), (x2, y2), a.color, 2)
                text = f'{d["label"]} {d["conf"]:.2f}'
                tw, th = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)[0]
                cv2.rectangle(frame, (x1, max(0, y1 - th - 8)), (x1 + tw + 8, y1), a.color, -1)
                cv2.putText(frame, text, (x1 + 4, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (15, 15, 15), 1, cv2.LINE_AA)
        stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cv2.putText(frame, stamp, (10, h - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)

    def _raise_alert(self, a, fired, frame):
        cam = self.cam
        detail = {"analytic": a.row["name"], "count": a.count, "labels": dict(a.labels), "held": fired["held"]}
        aid = db.run("INSERT INTO alerts(project_id,camera_id,analytics_id,created_at,severity,message,snapshot,detail)"
                     " VALUES(?,?,?,?,?,?,?,?)",
                     (cam["project_id"], cam["id"], a.id, time.time(), fired["severity"],
                      f'{a.row["name"]}: {fired["message"]}', "", json.dumps(detail)))
        path = db.DATA / "snapshots" / f"{aid}.jpg"
        path.write_bytes(encode(frame, 85))
        db.run("UPDATE alerts SET snapshot=? WHERE id=?", (str(path), aid))
        url = (a.row.get("webhook_url") or "").strip()
        if url:
            payload = json.dumps({"alert_id": aid, "camera": cam["name"], "analytic": a.row["name"],
                                  "message": fired["message"], "severity": fired["severity"],
                                  "time": dt.datetime.now().isoformat(), **detail}).encode()
            threading.Thread(target=_post, args=(url, payload), daemon=True).start()

    def public(self):
        return {"id": self.id, "status": self.status, "message": self.message,
                "fps_in": round(self.fps_in, 1), "fps_out": round(self.fps_out, 1), "size": self.size,
                "analytics": [a.public() for a in self.analytics]}


def _post(url, payload):
    try:
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=5).read()
    except Exception:
        pass


class Manager:
    def __init__(self):
        self.runners = {}
        self.lock = threading.Lock()

    def start(self, cam_id):
        with self.lock:
            cam = db.one("SELECT * FROM cameras WHERE id=?", (cam_id,))
            if not cam:
                return None
            old = self.runners.pop(cam_id, None)
            if old:
                old.stop()
            r = CameraRunner(cam)
            self.runners[cam_id] = r
            r.start()
            db.run("UPDATE cameras SET enabled=1 WHERE id=?", (cam_id,))
            return r

    def stop(self, cam_id):
        with self.lock:
            r = self.runners.pop(cam_id, None)
            if r:
                r.stop()
        db.run("UPDATE cameras SET enabled=0 WHERE id=?", (cam_id,))

    def get(self, cam_id):
        return self.runners.get(cam_id)

    def reload(self, cam_id):
        r = self.runners.get(cam_id)
        if r:
            r.reload()

    def autostart(self):
        for c in db.q("SELECT id FROM cameras WHERE enabled=1"):
            self.start(c["id"])


manager = Manager()
