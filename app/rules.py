"""Alert rules: dwell time, cooldown, schedule and condition."""
import datetime as dt

from .db import DEFAULT_RULE


def parse_hm(value, fallback):
    try:
        h, m = value.split(":")
        return int(h) * 60 + int(m)
    except Exception:
        return fallback


def in_schedule(rule, now: dt.datetime) -> bool:
    if now.weekday() not in rule.get("days", range(7)):
        return False
    start = parse_hm(rule.get("start", "00:00"), 0)
    end = parse_hm(rule.get("end", "23:59"), 1439)
    minute = now.hour * 60 + now.minute
    if start <= end:
        return start <= minute <= end
    return minute >= start or minute <= end      # window that runs past midnight


class RuleState:
    """Tracks how long a condition has held and when the last alert fired."""

    def __init__(self):
        self.since = None
        self.last_alert = None

    def update(self, rule, count, ts, now):
        rule = {**DEFAULT_RULE, **(rule or {})}
        if not in_schedule(rule, now):
            self.since = None
            return None
        if rule["condition"] == "absent":
            holds = count == 0
        else:
            holds = count >= max(1, int(rule.get("count", 1)))
        if not holds:
            self.since = None
            return None
        if self.since is None:
            self.since = ts
        held = ts - self.since
        if held < float(rule["min_seconds"]):
            return None
        if self.last_alert is not None and ts - self.last_alert < float(rule["cooldown_seconds"]):
            return None
        self.last_alert = ts
        if rule["condition"] == "absent":
            msg = f"Nothing detected for {held:.0f}s"
        else:
            msg = f"{count} object(s) present for {held:.0f}s"
        return {"message": msg, "severity": rule["severity"], "held": round(held, 1)}
