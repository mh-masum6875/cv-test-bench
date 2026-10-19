"""CV Test Bench: projects, cameras (RTSP or video files), models, analytics and alerts."""
import json
import re
import shutil
import time
from pathlib import Path
from typing import List, Optional

import cv2
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db
from .db import DATA, DEFAULT_RULE, loads
from .runner import encode, manager, placeholder

db.init()
app = FastAPI(title="CV Test Bench")
STATIC = Path(__file__).resolve().parent.parent / "docs"


@app.on_event("startup")
def startup():
    manager.autostart()


def safe_name(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", Path(name).name) or "file"


def need(row, what):
    if not row:
        raise HTTPException(404, f"{what} not found")
    return row


# ---------------------------------------------------------------- projects
class ProjectIn(BaseModel):
    name: str
    description: str = ""


@app.get("/api/projects")
def projects():
    rows = db.q("SELECT * FROM projects ORDER BY id DESC")
    for p in rows:
        cams = db.q("SELECT id FROM cameras WHERE project_id=?", (p["id"],))
        p["cameras"] = len(cams)
        p["live"] = sum(1 for c in cams if manager.get(c["id"]) and manager.get(c["id"]).status == "live")
        p["alerts_open"] = db.one("SELECT COUNT(*) n FROM alerts WHERE project_id=? AND acked=0", (p["id"],))["n"]
    return rows


@app.post("/api/projects")
def project_create(p: ProjectIn):
    if not p.name.strip():
        raise HTTPException(400, "Name is required")
    pid = db.run("INSERT INTO projects(name,description,created_at) VALUES(?,?,?)", (p.name.strip(), p.description, time.time()))
    return db.one("SELECT * FROM projects WHERE id=?", (pid,))


@app.put("/api/projects/{pid}")
def project_update(pid: int, p: ProjectIn):
    need(db.one("SELECT id FROM projects WHERE id=?", (pid,)), "Project")
    db.run("UPDATE projects SET name=?, description=? WHERE id=?", (p.name.strip(), p.description, pid))
    return db.one("SELECT * FROM projects WHERE id=?", (pid,))


@app.delete("/api/projects/{pid}")
def project_delete(pid: int):
    for c in db.q("SELECT id FROM cameras WHERE project_id=?", (pid,)):
        camera_delete(c["id"])
    db.run("DELETE FROM alerts WHERE project_id=?", (pid,))
    db.run("DELETE FROM projects WHERE id=?", (pid,))
    return {"ok": True}


# ---------------------------------------------------------------- cameras
class CameraIn(BaseModel):
    name: str
    source_type: str = "rtsp"      # rtsp | file
    source: str
    fps_limit: float = 5


def camera_view(c):
    r = manager.get(c["id"])
    c["runtime"] = r.public() if r else {"status": "stopped", "message": "", "fps_in": 0, "fps_out": 0, "size": None, "analytics": []}
    c["analytics_count"] = db.one("SELECT COUNT(*) n FROM analytics WHERE camera_id=?", (c["id"],))["n"]
    c["alerts_open"] = db.one("SELECT COUNT(*) n FROM alerts WHERE camera_id=? AND acked=0", (c["id"],))["n"]
    return c


@app.get("/api/projects/{pid}/cameras")
def cameras(pid: int):
    return [camera_view(c) for c in db.q("SELECT * FROM cameras WHERE project_id=? ORDER BY id", (pid,))]


@app.get("/api/cameras/{cid}")
def camera_get(cid: int):
    return camera_view(need(db.one("SELECT * FROM cameras WHERE id=?", (cid,)), "Camera"))


@app.post("/api/projects/{pid}/cameras")
def camera_create(pid: int, c: CameraIn):
    need(db.one("SELECT id FROM projects WHERE id=?", (pid,)), "Project")
    if c.source_type not in ("rtsp", "file"):
        raise HTTPException(400, "source_type must be rtsp or file")
    if c.source_type == "rtsp" and not re.match(r"^(rtsp|rtsps|rtmp|http|https)://", c.source.strip(), re.I):
        raise HTTPException(400, "Use an rtsp://, rtmp:// or http(s):// URL")
    cid = db.run("INSERT INTO cameras(project_id,name,source_type,source,fps_limit,created_at) VALUES(?,?,?,?,?,?)",
                 (pid, c.name.strip(), c.source_type, c.source.strip(), c.fps_limit, time.time()))
    return camera_get(cid)


@app.post("/api/projects/{pid}/cameras/upload")
def camera_upload(pid: int, name: str = Form(...), fps_limit: float = Form(5), file: UploadFile = File(...)):
    need(db.one("SELECT id FROM projects WHERE id=?", (pid,)), "Project")
    dest = DATA / "videos" / f"{int(time.time())}_{safe_name(file.filename)}"
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    cap = cv2.VideoCapture(str(dest))
    ok = cap.isOpened()
    cap.release()
    if not ok:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "OpenCV could not read that video file")
    cid = db.run("INSERT INTO cameras(project_id,name,source_type,source,fps_limit,created_at) VALUES(?,?,?,?,?,?)",
                 (pid, name.strip(), "file", str(dest), fps_limit, time.time()))
    return camera_get(cid)


@app.put("/api/cameras/{cid}")
def camera_update(cid: int, c: CameraIn):
    need(db.one("SELECT id FROM cameras WHERE id=?", (cid,)), "Camera")
    db.run("UPDATE cameras SET name=?, source=?, fps_limit=? WHERE id=?", (c.name.strip(), c.source.strip(), c.fps_limit, cid))
    if manager.get(cid):
        manager.start(cid)
    return camera_get(cid)


@app.delete("/api/cameras/{cid}")
def camera_delete(cid: int):
    manager.stop(cid)
    cam = db.one("SELECT * FROM cameras WHERE id=?", (cid,))
    if cam and cam["source_type"] == "file":
        Path(cam["source"]).unlink(missing_ok=True)
    db.run("DELETE FROM analytics WHERE camera_id=?", (cid,))
    db.run("DELETE FROM alerts WHERE camera_id=?", (cid,))
    db.run("DELETE FROM cameras WHERE id=?", (cid,))
    return {"ok": True}


@app.post("/api/cameras/{cid}/start")
def camera_start(cid: int):
    need(manager.start(cid), "Camera")
    return camera_get(cid)


@app.post("/api/cameras/{cid}/stop")
def camera_stop(cid: int):
    manager.stop(cid)
    return camera_get(cid)


@app.get("/api/cameras/{cid}/status")
def camera_status(cid: int):
    return camera_get(cid)["runtime"]


def frame_for(cid):
    r = manager.get(cid)
    if r:
        return r.jpeg
    return encode(placeholder("Stopped. Press Start."))


@app.get("/api/cameras/{cid}/snapshot.jpg")
def camera_snapshot(cid: int, raw: bool = False):
    r = manager.get(cid)
    if raw and r and r.raw is not None:          # clean frame, used by the zone editor
        return Response(encode(r.raw), media_type="image/jpeg", headers={"Cache-Control": "no-store"})
    return Response(frame_for(cid), media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/api/cameras/{cid}/stream")
def camera_stream(cid: int):
    def gen():
        last = 0
        while True:
            r = manager.get(cid)
            if r and r.jpeg_ts == last:
                time.sleep(0.05)
                continue
            last = r.jpeg_ts if r else 0
            jpg = frame_for(cid)
            yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n"
            if not r:
                time.sleep(1)
    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")


class SourceTest(BaseModel):
    url: str


@app.post("/api/test-source")
def test_source(t: SourceTest):
    from .runner import open_capture
    cap = open_capture(t.url.strip(), False)
    if not cap.isOpened():
        return {"ok": False, "message": "Could not open the stream. Check the URL, credentials and network."}
    ok, frame = False, None
    for _ in range(40):                      # the first frames can be empty until a keyframe arrives
        ok, frame = cap.read()
        if ok:
            break
        time.sleep(0.1)
    cap.release()
    if not ok:
        return {"ok": False, "message": "Connected but no frame was received."}
    return {"ok": True, "message": f"Got a {frame.shape[1]}x{frame.shape[0]} frame."}


# ---------------------------------------------------------------- models
class ModelIn(BaseModel):
    name: str
    path: str
    notes: str = ""


@app.get("/api/models")
def models():
    rows = db.q("SELECT * FROM models ORDER BY id")
    for m in rows:
        m["exists"] = m["kind"] == "motion" or Path(m["path"]).exists()
        m["in_use"] = db.one("SELECT COUNT(*) n FROM analytics WHERE model_id=?", (m["id"],))["n"]
    return rows


@app.post("/api/models")
def model_register(m: ModelIn):
    p = Path(m.path).expanduser()
    if not p.exists():
        raise HTTPException(400, f"File not found on the server: {p}")
    mid = db.run("INSERT INTO models(name,kind,path,notes,created_at) VALUES(?,?,?,?,?)",
                 (m.name.strip(), "ultralytics", str(p), m.notes, time.time()))
    return db.one("SELECT * FROM models WHERE id=?", (mid,))


@app.post("/api/models/upload")
def model_upload(name: str = Form(...), notes: str = Form(""), file: UploadFile = File(...)):
    if not file.filename.lower().endswith((".pt", ".onnx", ".engine", ".torchscript")):
        raise HTTPException(400, "Upload a .pt, .onnx, .engine or .torchscript file")
    dest = DATA / "models" / f"{int(time.time())}_{safe_name(file.filename)}"
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    mid = db.run("INSERT INTO models(name,kind,path,notes,created_at) VALUES(?,?,?,?,?)",
                 (name.strip(), "ultralytics", str(dest), notes, time.time()))
    return db.one("SELECT * FROM models WHERE id=?", (mid,))


@app.delete("/api/models/{mid}")
def model_delete(mid: int):
    m = need(db.one("SELECT * FROM models WHERE id=?", (mid,)), "Model")
    if m["kind"] == "motion":
        raise HTTPException(400, "The built-in model cannot be removed")
    if db.one("SELECT 1 FROM analytics WHERE model_id=?", (mid,)):
        raise HTTPException(400, "This model is used by an analytic. Remove or change that analytic first")
    db.run("DELETE FROM models WHERE id=?", (mid,))
    return {"ok": True}


# ---------------------------------------------------------------- analytics
class AnalyticIn(BaseModel):
    name: str
    model_id: int
    conf: float = 0.4
    classes: List[str] = []
    roi: List[List[float]] = []
    enabled: bool = True
    rule: dict = {}
    webhook_url: str = ""


def analytic_view(a):
    a["classes"] = loads(a["classes"], [])
    a["roi"] = loads(a["roi"], [])
    a["rule"] = {**DEFAULT_RULE, **loads(a["rule"], {})}
    return a


@app.get("/api/cameras/{cid}/analytics")
def analytics(cid: int):
    return [analytic_view(a) for a in db.q("SELECT * FROM analytics WHERE camera_id=? ORDER BY id", (cid,))]


def check_analytic(a: AnalyticIn):
    if not a.name.strip():
        raise HTTPException(400, "Name is required")
    need(db.one("SELECT id FROM models WHERE id=?", (a.model_id,)), "Model")
    if not 0 < a.conf <= 1:
        raise HTTPException(400, "Confidence must be between 0 and 1")
    if a.roi and len(a.roi) < 3:
        raise HTTPException(400, "A zone needs at least 3 points")


@app.post("/api/cameras/{cid}/analytics")
def analytic_create(cid: int, a: AnalyticIn):
    need(db.one("SELECT id FROM cameras WHERE id=?", (cid,)), "Camera")
    check_analytic(a)
    aid = db.run("INSERT INTO analytics(camera_id,name,model_id,conf,classes,roi,enabled,rule,webhook_url,created_at)"
                 " VALUES(?,?,?,?,?,?,?,?,?,?)",
                 (cid, a.name.strip(), a.model_id, a.conf, json.dumps(a.classes), json.dumps(a.roi), int(a.enabled),
                  json.dumps({**DEFAULT_RULE, **a.rule}), a.webhook_url, time.time()))
    manager.reload(cid)
    return analytic_view(db.one("SELECT * FROM analytics WHERE id=?", (aid,)))


@app.put("/api/analytics/{aid}")
def analytic_update(aid: int, a: AnalyticIn):
    cur = need(db.one("SELECT * FROM analytics WHERE id=?", (aid,)), "Analytic")
    check_analytic(a)
    db.run("UPDATE analytics SET name=?,model_id=?,conf=?,classes=?,roi=?,enabled=?,rule=?,webhook_url=? WHERE id=?",
           (a.name.strip(), a.model_id, a.conf, json.dumps(a.classes), json.dumps(a.roi), int(a.enabled),
            json.dumps({**DEFAULT_RULE, **a.rule}), a.webhook_url, aid))
    manager.reload(cur["camera_id"])
    return analytic_view(db.one("SELECT * FROM analytics WHERE id=?", (aid,)))


@app.delete("/api/analytics/{aid}")
def analytic_delete(aid: int):
    cur = need(db.one("SELECT * FROM analytics WHERE id=?", (aid,)), "Analytic")
    db.run("DELETE FROM analytics WHERE id=?", (aid,))
    manager.reload(cur["camera_id"])
    return {"ok": True}


@app.get("/api/models/{mid}/classes")
def model_classes(mid: int):
    m = need(db.one("SELECT * FROM models WHERE id=?", (mid,)), "Model")
    if m["kind"] == "motion":
        return ["motion"]
    try:
        from .detectors import UltralyticsDetector
        return UltralyticsDetector(m["path"]).names
    except Exception as e:
        raise HTTPException(400, str(e))


# ---------------------------------------------------------------- alerts
@app.get("/api/alerts")
def alerts(project_id: Optional[int] = None, camera_id: Optional[int] = None, since_id: int = 0, limit: int = 100,
           open_only: bool = False):
    sql, args = "SELECT a.*, c.name camera_name FROM alerts a LEFT JOIN cameras c ON c.id=a.camera_id WHERE a.id>?", [since_id]
    if project_id:
        sql += " AND a.project_id=?"; args.append(project_id)
    if camera_id:
        sql += " AND a.camera_id=?"; args.append(camera_id)
    if open_only:
        sql += " AND a.acked=0"
    rows = db.q(sql + " ORDER BY a.id DESC LIMIT ?", (*args, limit))
    for r in rows:
        r["detail"] = loads(r["detail"], {})
        r.pop("snapshot", None)
    return rows


@app.get("/api/alerts/{aid}/snapshot.jpg")
def alert_snapshot(aid: int):
    a = need(db.one("SELECT snapshot FROM alerts WHERE id=?", (aid,)), "Alert")
    if not a["snapshot"] or not Path(a["snapshot"]).exists():
        raise HTTPException(404, "No snapshot")
    return FileResponse(a["snapshot"], media_type="image/jpeg")


@app.post("/api/alerts/{aid}/ack")
def alert_ack(aid: int):
    db.run("UPDATE alerts SET acked=1 WHERE id=?", (aid,))
    return {"ok": True}


@app.post("/api/projects/{pid}/alerts/ack-all")
def alert_ack_all(pid: int):
    db.run("UPDATE alerts SET acked=1 WHERE project_id=?", (pid,))
    return {"ok": True}


@app.delete("/api/projects/{pid}/alerts")
def alerts_clear(pid: int):
    for a in db.q("SELECT snapshot FROM alerts WHERE project_id=?", (pid,)):
        if a["snapshot"]:
            Path(a["snapshot"]).unlink(missing_ok=True)
    db.run("DELETE FROM alerts WHERE project_id=?", (pid,))
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True, "mode": "server"}


@app.get("/api/default-rule")
def default_rule():
    return DEFAULT_RULE


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
