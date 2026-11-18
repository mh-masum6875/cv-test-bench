"""Tests for the tracker and the unaccompanied check. Run: python -m pytest tests/test_tracking.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.rules import RuleState                       # noqa: E402
from app.tracking import Tracker, is_alone, iou       # noqa: E402
import datetime as dt                                 # noqa: E402


def det(x, y, w=60, h=50, label="dog"):
    return {"label": label, "conf": 0.8, "box": [x, y, x + w, y + h]}


def test_a_distant_person_is_not_a_companion():
    dog = [336, 204, 434, 275]                        # 71 px tall, close to the camera
    far = [262, 115, 273, 139]                        # 24 px tall and 120 px away: far down the street
    near = [300, 120, 360, 280]                       # a person standing next to the dog
    assert is_alone(dog, [far], 3.0)
    assert not is_alone(dog, [near], 3.0)


def test_iou():
    assert abs(iou([0, 0, 10, 10], [0, 0, 10, 10]) - 1.0) < 1e-6
    assert iou([0, 0, 10, 10], [20, 20, 30, 30]) == 0.0
    assert 0.1 < iou([0, 0, 10, 10], [5, 0, 15, 10]) < 0.5


def test_same_dog_keeps_its_id_while_moving():
    tr = Tracker()
    ids = set()
    for i in range(20):                       # 20 frames, moving 15 px per frame
        d = [det(100 + 15 * i, 200)]
        tr.update(d, ts=i * 0.2)
        ids.add(d[0]["track_id"])
    assert len(ids) == 1


def test_two_dogs_get_two_ids():
    tr = Tracker()
    for i in range(10):
        d = [det(100 + 5 * i, 200), det(600 - 5 * i, 220)]
        tr.update(d, ts=i * 0.2)
    assert len(tr.confirmed()) == 2
    assert d[0]["track_id"] != d[1]["track_id"]


def test_short_gap_keeps_id_long_gap_ends_track():
    tr = Tracker(max_age=3.0)
    d = [det(100, 200)]
    tr.update(d, 0.0); tr.update([det(105, 200)], 0.2)
    first = d[0]["track_id"]
    tr.update([], 1.0)                         # missed for a moment
    d2 = [det(112, 200)]
    tr.update(d2, 2.0)
    assert d2[0]["track_id"] == first
    _, ended = tr.update([], 6.0)              # gone for longer than max_age
    assert [t.id for t in ended] == [first]
    assert tr.tracks == []


def test_single_detection_is_not_confirmed():
    tr = Tracker(min_hits=2)
    tr.update([det(100, 200)], 0.0)
    assert tr.confirmed() == []
    _, ended = tr.update([], 10.0)
    assert ended == []                         # a one-frame blip is never logged as a sighting


def test_labels_do_not_mix():
    tr = Tracker()
    a = [det(100, 200, label="dog")]
    tr.update(a, 0.0)
    b = [det(102, 200, label="cat")]
    tr.update(b, 0.2)
    assert a[0]["track_id"] != b[0]["track_id"]


def test_is_alone():
    dog = [100, 300, 160, 350]                 # 50 px tall
    assert is_alone(dog, [], 3.0)
    assert not is_alone(dog, [[170, 200, 220, 360]], 3.0)      # person right next to it
    assert is_alone(dog, [[600, 200, 650, 360]], 3.0)          # person far away
    assert not is_alone(dog, [[260, 200, 300, 360]], 3.0)      # 100 px away, inside 3 x 50 px
    assert is_alone(dog, [[260, 200, 300, 360]], 1.0)          # same person, tighter radius


def test_unaccompanied_rule_message():
    st = RuleState()
    rule = {"condition": "unaccompanied", "count": 1, "min_seconds": 2, "cooldown_seconds": 30,
            "target_name": "dog"}
    now = dt.datetime(2026, 11, 14, 23, 0)
    assert st.update(rule, 1, 0.0, now) is None
    fired = st.update(rule, 2, 2.5, now)
    assert fired and fired["message"] == "2 unaccompanied dogs for 2s"
