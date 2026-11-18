"""Ready-made example projects for the server version, built from the sample clips and the YOLO model
that ship with the browser demo in docs/. The same examples as the hosted demo, so both versions can be
shown the same way. Adding them twice does nothing: projects are matched by name."""
import json
import time
from pathlib import Path

from . import db
from .db import DEFAULT_RULE

DOCS = Path(__file__).resolve().parent.parent / "docs"
YOLO = DOCS / "models" / "yolo" / "yolov8n-416.onnx"
VEHICLES = ["car", "truck", "bus", "motorcycle"]

# name, description, [(camera name, clip, fps limit, [(analytic name, conf, classes, roi, rule)])]
EXAMPLES = [
    ("Stray dog monitoring",
     "Alerts on lone dogs, packs and dogs that stop, counts road crossings and maps where dogs go. The clips are AI-generated.",
     [("Residential street (AI-generated footage)", "stray", 4, [
         ("Unaccompanied dog", 0.2, ["dog"], [], {"condition": "unaccompanied", "min_seconds": 2, "cooldown_seconds": 15,
                                                   "companions": ["person"], "companion_radius": 3, "blur_people": True}),
         ("Pack of dogs", 0.2, ["dog"], [], {"condition": "group", "count": 3, "group_radius": 2, "min_seconds": 1,
                                             "cooldown_seconds": 15}),
         ("Dog not moving", 0.2, ["dog"], [], {"condition": "still", "still_tolerance": 3, "min_seconds": 3,
                                               "cooldown_seconds": 20, "severity": "info"}),
         ("Dogs crossing the road", 0.2, ["dog"], [], {"condition": "crossing", "line": [[0.4, 0.98], [0.4, 0.42]],
                                                       "line_direction": "both", "min_seconds": 0, "cooldown_seconds": 5,
                                                       "severity": "info"})]),
      ("Street from a higher pole (AI-generated footage)", "stray2", 4, [
          ("Unaccompanied dog", 0.2, ["dog"], [], {"condition": "unaccompanied", "min_seconds": 2, "cooldown_seconds": 15,
                                                    "companions": ["person"], "companion_radius": 3, "blur_people": True})])]),
    ("Traffic", "Warns when the road is busy and counts vehicles in each direction.",
     [("Road from above", "traffic", 6, [
         ("Busy road", 0.3, VEHICLES, [], {"count": 2, "min_seconds": 2, "cooldown_seconds": 10}),
         ("Vehicles in each direction", 0.3, VEHICLES, [], {"condition": "crossing", "line": [[0.05, 0.55], [0.8, 0.55]],
                                                             "line_direction": "both", "min_seconds": 0,
                                                             "cooldown_seconds": 30, "severity": "info"})])]),
    ("Workplace safety", "Alerts when a person walks into a marked floor zone.",
     [("Warehouse floor", "safety", 4, [
         ("Person in the marked zone", 0.35, ["person"],
          [[0.06, 0.34], [0.58, 0.2], [0.93, 0.58], [0.5, 0.98], [0.02, 0.8]],
          {"min_seconds": 1, "cooldown_seconds": 8, "severity": "critical"})])]),
    ("Sorting and counting", "Counts bottles on a table.",
     [("Table", "bottles", 4, [
         ("Two or more bottles", 0.3, ["bottle"], [], {"count": 2, "min_seconds": 1, "cooldown_seconds": 10,
                                                        "severity": "info"})])]),
]


def model_id():
    """The bundled YOLOv8n model, registered once."""
    row = db.one("SELECT id FROM models WHERE path=?", (str(YOLO),))
    if row:
        return row["id"]
    return db.run("INSERT INTO models(name,kind,path,notes,created_at) VALUES(?,?,?,?,?)",
                  ("Object detector (80 everyday objects)", "onnx", str(YOLO),
                   "YOLOv8n at 416 pixels, the model the browser demo uses.", time.time()))


def add_examples():
    """Add the example projects that are missing. Returns the names that were added."""
    if not YOLO.exists():
        raise FileNotFoundError(f"The example model is missing: {YOLO}")
    mid, now, added = model_id(), time.time(), []
    for name, description, cameras in EXAMPLES:
        if db.one("SELECT id FROM projects WHERE name=?", (name,)):
            continue
        pid = db.run("INSERT INTO projects(name,description,created_at) VALUES(?,?,?)", (name, description, now))
        for cam_name, clip, fps, analytics in cameras:
            cid = db.run("INSERT INTO cameras(project_id,name,source_type,source,enabled,fps_limit,created_at)"
                         " VALUES(?,?,?,?,?,?,?)", (pid, cam_name, "file", str(DOCS / "samples" / f"{clip}.mp4"), 0, fps, now))
            for an_name, conf, classes, roi, rule in analytics:
                db.run("INSERT INTO analytics(camera_id,name,model_id,conf,classes,roi,enabled,rule,webhook_url,created_at)"
                       " VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (cid, an_name, mid, conf, json.dumps(classes), json.dumps(roi), 1,
                        json.dumps({**DEFAULT_RULE, **rule}), "", now))
        added.append(name)
    return added
