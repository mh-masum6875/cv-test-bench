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
from .tracking import Tracker, crossing, group_sizes, groups, iou, is_alone, still_update

COAST = 1.0                  # seconds a missed track keeps its box on screen
ALONE = (60, 60, 235)        # BGR red for an unaccompanied target, a group or an object that stopped
WITH = (250, 140, 60)        # BGR blue for a target with a companion nearby
PACK = (40, 160, 250)        # BGR orange for the outline around a group

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
        self.rule = {**db.DEFAULT_RULE, **self.rule}
        self.companions = [c.lower() for c in self.rule.get("companions") or []]
        self.trk = None                                  # the TrackGroup this analytic belongs to
        self.tracks_now = 0
        self.alone_now = 0
        line = self.rule.get("line") or []
        self.line = line if len(line) == 2 else None
        self.n_in = self.n_out = 0                       # line crossings since start
        self.group_now = 0                               # largest group in the latest frame
        self.still_now, self.still_longest = 0, 0.0
        self.last_dets, self.last_companions, self.coast = [], [], []
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
                "tracks_now": self.tracks_now, "alone_now": self.alone_now, "unique": self.trk.unique if self.trk else 0,
                "n_in": self.n_in, "n_out": self.n_out, "group_now": self.group_now,
                "still_now": self.still_now, "still_longest": round(self.still_longest, 1),
                "history": [[round(t, 1), c, round(m, 1)] for t, c, m in self.history]}


class TrackGroup:
    """Analytics with the same model, threshold, classes and zone see the same objects. They share one
    tracker, so each object has one ID, one sighting row and one set of heatmap counts."""

    def __init__(self, key):
        self.key = key
        self.members = []
        self.tracker = Tracker()
        self.unique = 0                                  # confirmed tracks seen since start
        self._counted = set()
        self.heat = {}                                   # label -> counts per cell, this hour
        self.heat_hour = None
        self.last_flush = time.time()
        self.dets, self.confirmed, self.coast = [], [], []

    def rule_of(self, cond):
        return next((a.rule for a in self.members if a.rule.get("condition") == cond), None)

    @staticmethod
    def key_of(a):
        return (a.row["model_id"], float(a.row["conf"]), tuple(sorted(a.classes)), json.dumps(a.roi))


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
        self.groups = []
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
        self._close_groups()
        rows = db.q("SELECT * FROM analytics WHERE camera_id=? AND enabled=1 ORDER BY id", (self.id,))
        self.analytics = [Analytic(r, COLORS[i % len(COLORS)]) for i, r in enumerate(rows)]
        groups = {}
        for a in self.analytics:
            if a.detector is None:
                continue
            g = groups.setdefault(TrackGroup.key_of(a), TrackGroup(TrackGroup.key_of(a)))
            g.members.append(a)
            a.trk = g
        self.groups = list(groups.values())
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
        try:                                         # camera stopped: close open tracks and save the heatmap
            self._close_groups()
        except Exception:
            pass

    def _close_groups(self):
        if not db.one("SELECT 1 FROM cameras WHERE id=?", (self.id,)):
            self.groups = []                          # the camera was deleted: do not write rows for it again
            return
        for g in getattr(self, "groups", []):
            self._end_tracks(g, g.tracker.flush())
            self._flush_heat(g)
        self.groups = []

    def _process(self, frame):
        h, w = frame.shape[:2]
        now_ts, now = time.time(), dt.datetime.now()
        # analytics that use the same model share one detection per frame, at the lowest threshold among them
        lowest, shared = {}, {}
        for a in self.analytics:
            if a.detector is not None:
                k = a.row["model_id"]
                lowest[k] = min(lowest.get(k, 1.0), float(a.row["conf"]))
        for a in self.analytics:
            if a.detector is None:
                continue
            k = a.row["model_id"]
            if k not in shared:
                t = time.time()
                try:
                    shared[k] = (a.detector.detect(frame, lowest[k]), None, (time.time() - t) * 1000)
                except Exception as e:
                    shared[k] = ([], str(e), (time.time() - t) * 1000)
            found, error, a.infer_ms = shared[k]
            a.error = error
            dets = [dict(d) for d in found if d["conf"] >= float(a.row["conf"])]
            companions = [d for d in dets if d["label"].lower() in a.companions]
            a.dets = [d for d in dets if (not a.classes or d["label"].lower() in a.classes)
                      and inside(d["box"], a.roi, w, h)]
            a.last_companions = companions
        for g in self.groups:
            self._track_group(g, now_ts, w, h)
        for a in self.analytics:
            if a.detector is None:
                continue
            crossed = self._rules(a, a.trk, now_ts, w, h)
            dets = a.last_dets
            cond = a.rule.get("condition")
            a.count = (a.alone_now if cond == "unaccompanied" else a.group_now if cond == "group"
                       else a.still_now if cond == "still" else crossed if cond == "crossing" else len(dets))
            a.total += len(dets)
            a.labels = collections.Counter(d["label"] for d in dets)
            a.history.append((now_ts, a.count, a.infer_ms))
        for g in self.groups:
            for t in g.confirmed:
                t.last_foot = t.foot
            self._end_tracks(g, g.ended)
            if time.time() - g.last_flush > 30:
                self._flush_heat(g)
        self._blur_people(frame)
        self.raw = frame.copy()
        if time.time() - getattr(self, "_still_ts", 0) > 60:      # background picture for the heatmap
            self._still_ts = time.time()
            (db.DATA / "stills" / f"{self.id}.jpg").write_bytes(encode(self.raw, 80))
        self._draw(frame)
        for a in self.analytics:
            if a.detector is None:
                continue
            rule = {**a.rule, "target_name": a.classes[0] if a.classes else "object",
                    "still_for": a.still_longest, "direction": getattr(a, "last_direction", "in")}
            fired = a.state.update(rule, a.count, now_ts, now)
            if fired:
                self._raise_alert(a, fired, frame)
        self.jpeg = encode(frame)
        self.jpeg_ts = time.time()

    # ---------- tracking, sightings and heatmap ----------
    def _track_group(self, g, ts, w, h):
        """One tracker update for a group of analytics: IDs, foot points, still time and heatmap."""
        g.dets = g.members[0].dets                       # every member found the same boxes
        live, g.ended = g.tracker.update(g.dets, ts)
        g.confirmed = [t for t in live if t.hits >= g.tracker.min_hits]
        hour = int(ts // 3600)
        if g.heat_hour is not None and hour != g.heat_hour:
            self._flush_heat(g)
        g.heat_hour = hour
        still_rule = g.rule_of("still") or {}
        tolerance = float(still_rule.get("still_tolerance") or 3.0) / 100 * w
        plain_group = g.rule_of("group") is None
        for t in g.confirmed:
            if plain_group:                              # without a group rule: how many were in view together
                t.group_max = max(getattr(t, "group_max", 1), len(g.confirmed))
            t.foot = ((t.box[0] + t.box[2]) / 2, t.box[3])
            t.still_max = max(getattr(t, "still_max", 0.0), still_update(t, t.foot, ts, tolerance))
            fx, fy = min(max(t.foot[0] / w, 0.0), 0.9999), min(max(t.foot[1] / h, 0.0), 0.9999)
            t.points.append((fx, fy))
            cells = g.heat.setdefault(t.label.lower(), np.zeros(db.HEAT_W * db.HEAT_H, np.int64))
            cells[int(fy * db.HEAT_H) * db.HEAT_W + int(fx * db.HEAT_W)] += 1
            if t.id not in g._counted:
                g._counted.add(t.id)
                g.unique += 1
        # a tracked dog the detector missed for a moment keeps its last box for up to COAST seconds,
        # so boxes and counts do not blink when the score dips under the threshold for a frame or two
        live_ids = {t.id for t in live}
        g.coast = [t for t in g.tracker.tracks if t.hits >= g.tracker.min_hits and t.id not in live_ids
                   and ts - t.last_ts <= COAST and not any(iou(t.box, l.box) > 0.3 for l in live)]
        for t in g.coast:                                # a stopped dog the detector misses for a moment is still stopped
            t.still_seconds = ts - getattr(t, "still_since", ts)

    def _rules(self, a, g, ts, w, h):
        """What one analytic sees in its group's tracks: alone, groups, still time, line crossings.
        Returns the number of crossings in this frame that match the rule's direction."""
        cond = a.rule.get("condition")
        confirmed, coast = g.confirmed, g.coast
        shown = confirmed + coast
        alone_n, crossed = 0, 0
        if cond == "unaccompanied":
            radius = float(a.rule.get("companion_radius") or 3.0)
            people = [c["box"] for c in a.last_companions]
            for t in confirmed:
                was_alone, t.alone = t.alone, is_alone(t.box, people, radius)
                # what the screen shows changes only after the new state has held for a moment (1 s to show
                # alone, 0.5 s to show with a person), so a person seen or missed for one frame does not flip it
                want = "alone" if t.alone else "with"
                if want == getattr(t, "shown", None):
                    t.pending = None
                elif getattr(t, "pending", None) != want:
                    t.pending, t.pending_since = want, ts
                elif ts - t.pending_since >= (1.0 if want == "alone" else 0.5):
                    t.shown, t.pending = want, None
                t.frames_alone += int(t.alone)
                if t.alone and was_alone:
                    t.alone_seconds += min(ts - t.prev_ts, g.tracker.max_age)
                alone_n += int(t.alone)
        if a.line:
            line = [(p[0] * w, p[1] * h) for p in a.line]
            want = a.rule.get("line_direction") or "both"
            for t in confirmed:
                way = crossing(getattr(t, "last_foot", None), t.foot, line[0], line[1])
                if not way:
                    continue
                d = "in" if way > 0 else "out"
                t.crossed_in = getattr(t, "crossed_in", 0) + (d == "in")
                t.crossed_out = getattr(t, "crossed_out", 0) + (d == "out")
                a.n_in += d == "in"
                a.n_out += d == "out"
                t.flash = ts
                if want in ("both", d):
                    crossed += 1
                    a.last_direction = d
                self._save_crossing(a, t, ts, d)
        packs = []
        if cond == "group":
            # only boxes seen in this frame: a held box can belong to an object that already left
            radius = float(a.rule.get("group_radius") or 2.0)
            sizes = group_sizes([t.box for t in confirmed], radius)
            members = {}
            for t, root in zip(confirmed, groups([t.box for t in confirmed], radius)):
                members.setdefault(root, []).append(t.box)
            for boxes in members.values():               # one outline around each group big enough to alert on
                if len(boxes) >= max(2, int(a.rule.get("count") or 2)):
                    packs.append(([min(b[0] for b in boxes), min(b[1] for b in boxes),
                                   max(b[2] for b in boxes), max(b[3] for b in boxes)], len(boxes)))
            for t, n in zip(confirmed, sizes):
                t.group_now = n
                t.group_max = max(getattr(t, "group_max", 1), n)
            for t in coast:                              # a held box is not counted, so it shows no group either
                t.group_now = 1
            a.group_now = max(sizes, default=0)
        if packs or ts - getattr(a, "packs_ts", -9) > 0.5:    # keep the outline for half a second so it does not blink
            a.packs, a.packs_ts = packs, (ts if packs else getattr(a, "packs_ts", -9))
        hold = float(a.rule.get("min_seconds") or 0)
        a.still_longest = max([getattr(t, "still_seconds", 0.0) for t in shown], default=0.0)
        a.still_now = sum(1 for t in shown if getattr(t, "still_seconds", 0.0) >= hold) if cond == "still" else 0
        by_id = {t.id: t for t in confirmed}
        a.last_dets = []
        for d in g.dets:                                 # own copies, so each analytic can mark its boxes
            d = dict(d)
            t = by_id.get(d.get("track_id"))
            d["confirmed"] = t is not None
            # on screen a dog turns red only after a second alone, so a companion missed for a frame does not flash it
            state = getattr(t, "shown", None) if t and cond == "unaccompanied" else None
            d["alone"], d["with"] = state == "alone", state == "with"
            self._mark(d, t, cond, hold, a.rule, ts, a.line is not None)
            a.last_dets.append(d)
        a.coast = []
        for t in coast:
            d = {"label": t.label, "conf": t.conf, "box": t.box, "track_id": t.id, "confirmed": True,
                 "alone": cond == "unaccompanied" and getattr(t, "shown", None) == "alone",
                 "with": cond == "unaccompanied" and getattr(t, "shown", None) == "with"}
            self._mark(d, t, cond, hold, a.rule, ts, a.line is not None)
            a.coast.append(d)
        a.tracks_now = len(shown)
        a.alone_now = alone_n + (sum(1 for t in coast if t.alone) if cond == "unaccompanied" else 0)
        return crossed

    @staticmethod
    def _mark(d, t, cond, hold, rule, ts, has_line=False):
        """Extra state shown on a box: time without moving, a fresh line crossing. Groups get their own outline."""
        if t is None:
            return
        if cond == "still":
            sec = getattr(t, "still_seconds", 0.0)
            d["flag"] = sec >= hold
            d["note"] = f" still {sec:.0f}s" if sec >= max(2.0, hold / 2) else ""
        if has_line and ts - getattr(t, "flash", -9) < 1.0:
            d["note"] = d.get("note", "") + " crossed"

    def _save_crossing(self, a, t, ts, direction):
        db.run("INSERT INTO crossings(project_id,camera_id,analytics_id,track_id,label,ts,direction) VALUES(?,?,?,?,?,?,?)",
               (self.cam["project_id"], self.id, a.id, t.id, t.label, ts, direction))

    def _end_tracks(self, g, ended):
        cam = self.cam
        lone = g.rule_of("unaccompanied")
        hold = max(1.0, float((lone or {}).get("min_seconds") or 0))
        for t in ended:
            share = t.frames_alone / max(1, t.frames_seen)
            # a sighting is unaccompanied when the dog was alone for at least the rule's hold time,
            # or for most of the time it was in view
            unacc = lone is not None and (t.alone_seconds >= hold or share >= 0.5)
            pts = t.points or [((t.box[0] + t.box[2]) / 2 / max(1, (self.size or [1, 1])[0]), 0.5)]
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            db.run("INSERT INTO sightings(project_id,camera_id,analytics_id,track_id,label,first_ts,last_ts,duration,"
                   "alone_share,alone_seconds,unaccompanied,group_max,cx,cy,conf,crossed_in,crossed_out,still_max)"
                   " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (cam["project_id"], cam["id"], g.members[0].id, t.id, t.label, t.first_ts, t.last_ts, round(t.duration, 1),
                    round(share, 2), round(t.alone_seconds, 1), int(unacc), getattr(t, "group_max", 1),
                    round(cx, 4), round(cy, 4), t.conf, getattr(t, "crossed_in", 0), getattr(t, "crossed_out", 0),
                    round(getattr(t, "still_max", 0.0), 1)))

    def _flush_heat(self, g):
        g.last_flush = time.time()
        if g.heat_hour is None:
            return
        for label, cells in g.heat.items():
            for cell in np.nonzero(cells)[0]:
                db.run("INSERT INTO heat(camera_id,analytics_id,hour,label,cell,n) VALUES(?,?,?,?,?,?) "
                       "ON CONFLICT(camera_id,analytics_id,hour,label,cell) DO UPDATE SET n=n+excluded.n",
                       (self.id, g.members[0].id, g.heat_hour, label, int(cell), int(cells[cell])))
            cells[:] = 0

    def _blur_people(self, frame):
        """Privacy: blur the head area of every person (the top of each companion box)
        for analytics that ask for it. The rest of the person stays visible."""
        h, w = frame.shape[:2]
        for a in self.analytics:
            if not a.rule.get("blur_people"):
                continue
            for c in a.last_companions:
                bx1, by1, bx2, by2 = c["box"]
                bw, bh = bx2 - bx1, by2 - by1
                x1, x2 = int(bx1 + 0.12 * bw), int(bx2 - 0.12 * bw)             # head: middle of the box width,
                y1, y2 = int(by1), int(by1 + max(0.24 * bh, 0.7 * (x2 - x1)))   # top quarter of its height
                x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
                if x2 - x1 < 4 or y2 - y1 < 4:
                    continue
                roi = frame[y1:y2, x1:x2]
                k = max(9, (min(x2 - x1, y2 - y1) // 2) | 1)        # odd kernel, scaled to the head
                frame[y1:y2, x1:x2] = cv2.GaussianBlur(roi, (k, k), 0)

    def _draw(self, frame):
        h, w = frame.shape[:2]
        font, scale = cv2.FONT_HERSHEY_SIMPLEX, 0.5
        placed = []                 # label rectangles already drawn, so the next one can avoid them

        def tag(text, x1, y1, x2, y2, color, ink=(15, 15, 15)):
            """A filled label next to a box: above it, else below it, else inside its top edge."""
            tw, th = cv2.getTextSize(text, font, scale, 1)[0]
            tw, th = tw + 8, th + 8
            spots = [(x1, y1 - th), (x1, y2), (x1, y1)] + [(x1, y1 - th - k * th) for k in range(1, 4)] \
                + [(x1, y2 + k * th) for k in range(1, 4)]     # then further up or down, stacked
            free = lambda sx, sy: not any(sx < px2 and px1 < sx + tw and sy < py2 and py1 < sy + th
                                          for px1, py1, px2, py2 in placed)
            clamp = lambda sx, sy: (min(max(0, sx), w - tw), min(max(0, sy), h - th))
            sx, sy = next((clamp(*p) for p in spots if free(*clamp(*p))), clamp(*spots[0]))
            placed.append((sx, sy, sx + tw, sy + th))
            cv2.rectangle(frame, (sx, sy), (sx + tw, sy + th), color, -1)
            cv2.putText(frame, text, (sx + 4, sy + th - 6), font, scale, ink, 1, cv2.LINE_AA)

        marks = {}                  # analytics on the same model see the same box: draw it once
        packs, counters = [], []
        for a in self.analytics:
            if a.roi and len(a.roi) >= 3:
                pts = np.array([[int(p[0] * w), int(p[1] * h)] for p in a.roi], np.int32)
                overlay = frame.copy()
                cv2.fillPoly(overlay, [pts], a.color)
                cv2.addWeighted(overlay, 0.12, frame, 0.88, 0, frame)
                cv2.polylines(frame, [pts], True, a.color, 2, cv2.LINE_AA)
            if a.line:
                (ax, ay), (bx, by) = [(int(p[0] * w), int(p[1] * h)) for p in a.line]
                cv2.line(frame, (ax, ay), (bx, by), a.color, 3, cv2.LINE_AA)
                mx, my, dx, dy = (ax + bx) // 2, (ay + by) // 2, bx - ax, by - ay
                n = max(1.0, (dx * dx + dy * dy) ** 0.5)
                tip = (int(mx - dy / n * 28), int(my + dx / n * 28))   # arrow towards the "in" side
                cv2.arrowedLine(frame, (mx, my), tip, a.color, 2, cv2.LINE_AA, tipLength=0.35)
                counters.append((a, f"in {a.n_in}  out {a.n_out}"))
            unacc = a.rule.get("condition") == "unaccompanied"
            packs += getattr(a, "packs", [])
            for d in list(getattr(a, "last_dets", [])) + list(getattr(a, "coast", [])):
                if not d.get("confirmed"):               # a box seen once is not drawn, so single-frame flashes do not show
                    continue
                key = tuple(int(round(v / 4)) for v in d["box"])
                m = marks.setdefault(key, {"box": d["box"], "label": d["label"], "id": None, "notes": [], "color": a.color, "prio": 0})
                confirmed = d.get("confirmed")
                if m["id"] is None and confirmed:
                    m["id"] = d["track_id"]
                note = (" alone" if unacc and confirmed and d.get("alone") else "") + d.get("note", "")
                if note and note not in m["notes"]:
                    m["notes"].append(note)
                # red: alone, or still for too long. Blue: a companion is near. Otherwise the analytic's colour
                prio = 2 if (unacc and confirmed and d.get("alone")) or d.get("flag") else 1 if d.get("with") else 0
                if prio > m["prio"]:
                    m["prio"], m["color"] = prio, ALONE if prio == 2 else WITH
        for k, (a, text) in enumerate(counters):      # line counters in the top-left corner, where they do not move
            tw, th = cv2.getTextSize(text, font, scale, 1)[0]
            x, y = 8, 8 + k * (th + 14)
            cv2.rectangle(frame, (x, y), (x + tw + 22, y + th + 8), (30, 30, 30), -1)
            cv2.rectangle(frame, (x + 4, y + 5), (x + 12, y + th + 3), a.color, -1)
            cv2.putText(frame, text, (x + 16, y + th + 2), font, scale, (255, 255, 255), 1, cv2.LINE_AA)
            placed.append((x, y, x + tw + 22, y + th + 8))
        for box, n in packs:
            x1, y1, x2, y2 = [int(v) for v in box]
            x1, y1, x2, y2 = max(0, x1 - 10), max(0, y1 - 10), min(w - 1, x2 + 10), min(h - 1, y2 + 10)
            cv2.rectangle(frame, (x1, y1), (x2, y2), PACK, 2, cv2.LINE_AA)
        for m in marks.values():
            x1, y1, x2, y2 = [int(v) for v in m["box"]]
            cv2.rectangle(frame, (x1, y1), (x2, y2), m["color"], 2)
        for m in sorted(marks.values(), key=lambda m: (-m["prio"], m["id"] or 0)):   # important labels first, then by ID
            x1, y1, x2, y2 = [int(v) for v in m["box"]]
            idt = f' #{m["id"]}' if m["id"] is not None else ""
            tag(f'{m["label"]}{idt}{"".join(m["notes"])}', x1, y1, x2, y2, m["color"])
        for box, n in packs:
            x1, y1, x2, y2 = [int(v) for v in box]
            tag(f"pack of {n}", max(0, x1 - 10), max(0, y1 - 10), x2, y2 + 10, PACK)
        stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cv2.putText(frame, stamp, (10, h - 10), font, scale, (255, 255, 255), 1, cv2.LINE_AA)

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
