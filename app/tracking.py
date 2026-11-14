"""A small multi-object tracker: greedy IoU matching with a centre-distance fallback.

It is deliberately simple (no Kalman filter, no extra packages) because cameras here are usually
processed at 2 to 10 frames per second, where boxes move a lot between frames. Tracks are kept
alive for `max_age` seconds without a match, so short occlusions do not create a new ID.
"""
import itertools


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    if inter <= 0:
        return 0.0
    area = lambda r: max(0.0, r[2] - r[0]) * max(0.0, r[3] - r[1])
    return inter / (area(a) + area(b) - inter + 1e-9)


def centre(b):
    return (b[0] + b[2]) / 2, (b[1] + b[3]) / 2


class Track:
    def __init__(self, tid, det, ts):
        self.id = tid
        self.label = det["label"]
        self.box = list(det["box"])
        self.conf = det["conf"]
        self.first_ts = self.last_ts = ts
        self.hits = 1
        self.frames_alone = 0            # frames in which no companion (person) was near
        self.frames_seen = 1
        self.alone = False               # state in the latest frame
        self.alone_seconds = 0.0         # time spent with no companion nearby
        self.prev_ts = ts
        self.points = []                 # normalised foot points, for the heatmap

    @property
    def duration(self):
        return self.last_ts - self.first_ts

    def update(self, det, ts):
        self.box = list(det["box"])
        self.conf = det["conf"]
        self.prev_ts = self.last_ts
        self.last_ts = ts
        self.hits += 1
        self.frames_seen += 1


class Tracker:
    def __init__(self, iou_min=0.2, dist_max=1.5, max_age=3.0, min_hits=2):
        self.iou_min = iou_min           # minimum overlap to continue a track
        self.dist_max = dist_max         # centre distance, in box sizes, for the fallback match
        self.max_age = max_age           # seconds a track survives without being seen
        self.min_hits = min_hits         # detections needed before a track counts
        self.tracks = []
        self._ids = itertools.count(1)

    def confirmed(self):
        return [t for t in self.tracks if t.hits >= self.min_hits]

    def update(self, dets, ts):
        """Match detections to tracks. Returns (active tracks, tracks that just ended)."""
        pairs = []
        for ti, t in enumerate(self.tracks):
            for di, d in enumerate(dets):
                if d["label"] != t.label:
                    continue
                o = iou(t.box, d["box"])
                if o >= self.iou_min:
                    pairs.append((1.0 + o, ti, di))
                    continue
                (tx, ty), (dx, dy) = centre(t.box), centre(d["box"])
                size = max(t.box[2] - t.box[0], t.box[3] - t.box[1], 1.0)
                dist = ((tx - dx) ** 2 + (ty - dy) ** 2) ** 0.5 / size
                if dist <= self.dist_max:
                    pairs.append((1.0 - dist / (self.dist_max + 1e-9), ti, di))
        pairs.sort(reverse=True)
        used_t, used_d = set(), set()
        for _, ti, di in pairs:
            if ti in used_t or di in used_d:
                continue
            used_t.add(ti)
            used_d.add(di)
            self.tracks[ti].update(dets[di], ts)
            dets[di]["track_id"] = self.tracks[ti].id
        for di, d in enumerate(dets):
            if di not in used_d:
                t = Track(next(self._ids), d, ts)
                self.tracks.append(t)
                d["track_id"] = t.id
        ended = [t for t in self.tracks if ts - t.last_ts > self.max_age]
        self.tracks = [t for t in self.tracks if ts - t.last_ts <= self.max_age]
        live = [t for t in self.tracks if t.last_ts == ts]
        return live, [t for t in ended if t.hits >= self.min_hits]

    def flush(self):
        """End every track, for example when the camera stops."""
        ended = [t for t in self.tracks if t.hits >= self.min_hits]
        self.tracks = []
        return ended


def is_alone(box, companions, radius):
    """True when no companion box (for example a person) is within `radius` dog-heights of the dog."""
    if not companions:
        return True
    cx, cy = centre(box)
    reach = max(box[3] - box[1], box[2] - box[0], 1.0) * radius
    for c in companions:
        # distance from the dog's centre to the nearest point of the companion's box
        nx = min(max(cx, c[0]), c[2])
        ny = min(max(cy, c[1]), c[3])
        if ((cx - nx) ** 2 + (cy - ny) ** 2) ** 0.5 <= reach:
            return False
    return True
