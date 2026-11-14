"""SQLite storage. One small file, no ORM, so it is easy to read and change."""
import json
import sqlite3
import threading
import time
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
for sub in ("videos", "models", "snapshots", "stills"):
    (DATA / sub).mkdir(parents=True, exist_ok=True)

_lock = threading.RLock()
_conn = sqlite3.connect(DATA / "dashboard.db", check_same_thread=False)
_conn.row_factory = sqlite3.Row

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', created_at REAL);
CREATE TABLE IF NOT EXISTS models(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, path TEXT DEFAULT '',
  notes TEXT DEFAULT '', created_at REAL);
CREATE TABLE IF NOT EXISTS cameras(
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, name TEXT NOT NULL,
  source_type TEXT NOT NULL, source TEXT NOT NULL, enabled INTEGER DEFAULT 0,
  fps_limit REAL DEFAULT 5, created_at REAL);
CREATE TABLE IF NOT EXISTS analytics(
  id INTEGER PRIMARY KEY, camera_id INTEGER NOT NULL, name TEXT NOT NULL,
  model_id INTEGER NOT NULL, conf REAL DEFAULT 0.4, classes TEXT DEFAULT '[]',
  roi TEXT DEFAULT '[]', enabled INTEGER DEFAULT 1, rule TEXT DEFAULT '{}',
  webhook_url TEXT DEFAULT '', created_at REAL);
CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY, project_id INTEGER, camera_id INTEGER, analytics_id INTEGER,
  created_at REAL, severity TEXT, message TEXT, snapshot TEXT, acked INTEGER DEFAULT 0,
  detail TEXT DEFAULT '{}');
CREATE INDEX IF NOT EXISTS alerts_project ON alerts(project_id, id);
CREATE TABLE IF NOT EXISTS sightings(
  id INTEGER PRIMARY KEY, project_id INTEGER, camera_id INTEGER, analytics_id INTEGER,
  track_id INTEGER, label TEXT, first_ts REAL, last_ts REAL, duration REAL,
  alone_share REAL, alone_seconds REAL DEFAULT 0, unaccompanied INTEGER DEFAULT 0, group_max INTEGER DEFAULT 1,
  cx REAL, cy REAL, conf REAL);
CREATE INDEX IF NOT EXISTS sightings_project ON sightings(project_id, first_ts);
CREATE INDEX IF NOT EXISTS sightings_camera ON sightings(camera_id, first_ts);
CREATE TABLE IF NOT EXISTS heat(
  camera_id INTEGER, analytics_id INTEGER, hour INTEGER, cell INTEGER, n INTEGER DEFAULT 0,
  PRIMARY KEY(camera_id, analytics_id, hour, cell));
"""

DEFAULT_RULE = {
    "condition": "count_gte",   # count_gte: N or more objects, absent: nothing detected,
                                # unaccompanied: N or more targets with no companion nearby
    "count": 1,
    "min_seconds": 3,           # condition must hold this long before alerting (dwell time)
    "cooldown_seconds": 30,     # minimum gap between two alerts
    "severity": "warning",
    "days": [0, 1, 2, 3, 4, 5, 6],   # Monday = 0
    "start": "00:00",
    "end": "23:59",
    # used by the "unaccompanied" condition: a target (for example a dog) counts only when
    # no companion (for example a person) is within `companion_radius` target-heights of it
    "companions": ["person"],
    "companion_radius": 3.0,
    "blur_people": False,       # blur people in the live view and alert snapshots (privacy)
}

HEAT_W, HEAT_H = 32, 18         # heatmap grid, cells across and down


def init():
    with _lock:
        _conn.executescript(SCHEMA)
        cols = {r[1] for r in _conn.execute("PRAGMA table_info(sightings)").fetchall()}
        if "alone_seconds" not in cols:                 # databases made by an earlier build
            _conn.execute("ALTER TABLE sightings ADD COLUMN alone_seconds REAL DEFAULT 0")
        if not _conn.execute("SELECT 1 FROM models LIMIT 1").fetchone():
            _conn.execute(
                "INSERT INTO models(name,kind,path,notes,created_at) VALUES(?,?,?,?,?)",
                ("Motion detector (built in)", "motion", "",
                 "Background subtraction. Needs no weights, good for testing the pipeline.", time.time()))
        _conn.commit()


def q(sql, args=()):
    with _lock:
        return [dict(r) for r in _conn.execute(sql, args).fetchall()]


def one(sql, args=()):
    rows = q(sql, args)
    return rows[0] if rows else None


def run(sql, args=()):
    with _lock:
        cur = _conn.execute(sql, args)
        _conn.commit()
        return cur.lastrowid


def loads(value, default):
    try:
        return json.loads(value) if value else default
    except Exception:
        return default
