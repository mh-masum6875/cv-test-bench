"""Tests for groups, still time, line crossings and their alert rules. Run: python -m pytest tests/test_analytics.py"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.rules import RuleState                                          # noqa: E402
from app.tracking import Track, crossing, group_sizes, groups, still_update  # noqa: E402

MON_NOON = dt.datetime(2026, 10, 19, 12, 0)


def box(x, y, w=60, h=50):
    return [x, y, x + w, y + h]


# ---------------------------------------------------------------- groups
def test_three_dogs_close_together_are_one_group():
    boxes = [box(100, 100), box(160, 110), box(220, 100)]
    assert group_sizes(boxes, 2.0) == [3, 3, 3]


def test_far_dog_is_its_own_group():
    boxes = [box(100, 100), box(160, 100), box(900, 100)]
    sizes = group_sizes(boxes, 2.0)
    assert sizes[:2] == [2, 2] and sizes[2] == 1


def test_group_chains_through_a_middle_dog():
    # first and last are 180 px apart (more than 2 heights of 50), but both are near the middle one
    boxes = [box(100, 100), box(190, 100), box(280, 100)]
    assert len(set(groups(boxes, 2.0))) == 1


def test_radius_controls_the_group():
    boxes = [box(100, 100), box(200, 100)]                   # centres 100 px apart, heights 50
    assert group_sizes(boxes, 1.5) == [1, 1]
    assert group_sizes(boxes, 2.5) == [2, 2]


def test_a_near_dog_and_a_far_dog_are_not_a_group():
    near = [300, 250, 400, 330]                              # 80 px tall
    far = [330, 200, 345, 215]                               # 15 px tall, up the street, close on screen
    assert group_sizes([near, far], 2.0) == [1, 1]


def test_no_boxes():
    assert group_sizes([], 2.0) == []


def test_group_rule_alerts_with_the_group_size():
    s, rule = RuleState(), {"condition": "group", "count": 3, "min_seconds": 2, "cooldown_seconds": 0, "target_name": "dog"}
    assert s.update(rule, 2, 0, MON_NOON) is None           # two dogs is not a pack
    assert s.update(rule, 3, 1, MON_NOON) is None           # three, but not for long enough yet
    fired = s.update(rule, 4, 3, MON_NOON)
    assert fired and "Group of 4 dogs" in fired["message"]


# ---------------------------------------------------------------- still
def test_still_time_grows_while_the_dog_lies_still():
    t = Track(1, {"label": "dog", "conf": 0.9, "box": box(100, 100)}, 0)
    for i in range(11):                                     # 10 seconds, wobbling by 2 px
        sec = still_update(t, (130 + (i % 2) * 2, 150), i, tolerance=10)
    assert sec == 10


def test_still_time_resets_when_the_dog_walks_off():
    t = Track(1, {"label": "dog", "conf": 0.9, "box": box(100, 100)}, 0)
    for i in range(6):
        still_update(t, (130, 150), i, tolerance=10)
    assert still_update(t, (180, 150), 6, tolerance=10) == 0
    assert still_update(t, (182, 151), 9, tolerance=10) == 3


def test_still_rule_uses_the_time_per_object():
    s = RuleState()
    rule = {"condition": "still", "min_seconds": 30, "cooldown_seconds": 0, "target_name": "dog", "still_for": 34}
    assert s.update(rule, 0, 0, MON_NOON) is None           # no dog has been still for 30 s
    fired = s.update(rule, 1, 1, MON_NOON)                  # the runner counts one, alert straight away
    assert fired and "1 dog not moving for 34s" in fired["message"]


# ---------------------------------------------------------------- line crossing
LINE = ((100, 0), (100, 200))                               # a vertical line, seen from top to bottom


def test_crossing_each_way():
    assert crossing((80, 100), (120, 100), *LINE) == -1     # left to right on screen
    assert crossing((120, 100), (80, 100), *LINE) == 1


def test_no_crossing_on_the_same_side():
    assert crossing((60, 100), (90, 100), *LINE) == 0
    assert crossing(None, (90, 100), *LINE) == 0


def test_passing_beyond_the_end_of_the_line_is_not_a_crossing():
    assert crossing((80, 300), (120, 300), *LINE) == 0


def test_touching_the_line_is_not_a_crossing():
    assert crossing((80, 100), (100, 100), *LINE) == 0


def test_crossing_rule_alerts_at_once():
    s, rule = RuleState(), {"condition": "crossing", "min_seconds": 5, "cooldown_seconds": 0, "target_name": "dog",
                            "direction": "in"}
    assert s.update(rule, 0, 0, MON_NOON) is None
    fired = s.update(rule, 1, 1, MON_NOON)
    assert fired and "crossed the line (in)" in fired["message"]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("PASS", name)
    print("ALL PASSED")
