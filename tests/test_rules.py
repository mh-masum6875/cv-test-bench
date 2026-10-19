"""Unit tests for the alert rules:  python tests/test_rules.py"""
import datetime as dt
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from app.rules import RuleState, in_schedule  # noqa: E402

MON_NOON = dt.datetime(2026, 10, 19, 12, 0)     # a Monday


def test_dwell_time():
    s, rule = RuleState(), {"min_seconds": 3, "cooldown_seconds": 0, "count": 1}
    assert s.update(rule, 1, 0, MON_NOON) is None
    assert s.update(rule, 1, 2, MON_NOON) is None
    assert s.update(rule, 1, 3, MON_NOON)["held"] == 3


def test_dwell_resets_when_condition_breaks():
    s, rule = RuleState(), {"min_seconds": 3, "cooldown_seconds": 0}
    s.update(rule, 1, 0, MON_NOON)
    s.update(rule, 0, 2, MON_NOON)            # object left, timer restarts
    assert s.update(rule, 1, 4, MON_NOON) is None
    assert s.update(rule, 1, 7, MON_NOON) is not None


def test_cooldown():
    s, rule = RuleState(), {"min_seconds": 0, "cooldown_seconds": 10}
    assert s.update(rule, 1, 0, MON_NOON) is not None
    assert s.update(rule, 1, 5, MON_NOON) is None
    assert s.update(rule, 1, 11, MON_NOON) is not None


def test_count_threshold():
    s, rule = RuleState(), {"min_seconds": 0, "cooldown_seconds": 0, "count": 3}
    assert s.update(rule, 2, 0, MON_NOON) is None
    assert s.update(rule, 3, 1, MON_NOON) is not None


def test_absent_condition():
    s, rule = RuleState(), {"condition": "absent", "min_seconds": 2, "cooldown_seconds": 0}
    assert s.update(rule, 0, 0, MON_NOON) is None
    assert "Nothing detected" in s.update(rule, 0, 2, MON_NOON)["message"]
    assert s.update(rule, 1, 3, MON_NOON) is None


def test_schedule_days_and_hours():
    rule = {"days": [0, 1], "start": "09:00", "end": "17:00"}
    assert in_schedule(rule, MON_NOON)
    assert not in_schedule(rule, dt.datetime(2026, 10, 21, 12, 0))      # Wednesday
    assert not in_schedule(rule, dt.datetime(2026, 10, 19, 18, 0))      # too late


def test_schedule_across_midnight():
    rule = {"days": list(range(7)), "start": "22:00", "end": "06:00"}
    assert in_schedule(rule, dt.datetime(2026, 10, 19, 23, 30))
    assert in_schedule(rule, dt.datetime(2026, 10, 19, 5, 0))
    assert not in_schedule(rule, dt.datetime(2026, 10, 19, 12, 0))


def test_outside_schedule_never_alerts():
    s, rule = RuleState(), {"min_seconds": 0, "cooldown_seconds": 0, "days": [5]}
    assert s.update(rule, 5, 0, MON_NOON) is None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("PASS", name)
    print("ALL PASSED")
