"""Create a ready-to-run stray dog monitoring project on a running server.

    python scripts/setup_stray_demo.py                         # synthetic clip, bundled YOLOv8n ONNX model
    python scripts/setup_stray_demo.py --video street.mp4      # your own footage
    python scripts/setup_stray_demo.py --rtsp rtsp://user:pass@192.168.1.20:554/stream1
    python scripts/setup_stray_demo.py --model /path/to/best.onnx

It registers the model, adds a camera, attaches an "Unaccompanied dog" analytic
(dog with no person within 3 dog-heights for 3 seconds, people blurred) and starts the camera.
"""
import argparse
import base64
import json
import mimetypes
import os
import sys
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def call(base, method, path, body=None, files=None, fields=None):
    headers = {}
    data = None
    if files is not None:
        boundary = uuid.uuid4().hex
        parts = []
        for k, v in (fields or {}).items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        for k, p in files.items():
            ctype = mimetypes.guess_type(p)[0] or "application/octet-stream"
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{Path(p).name}"\r\n'
                         f"Content-Type: {ctype}\r\n\r\n".encode() + Path(p).read_bytes() + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        data = b"".join(parts)
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if os.environ.get("APP_PASSWORD"):
        token = f'{os.environ.get("APP_USER", "admin")}:{os.environ["APP_PASSWORD"]}'
        headers["Authorization"] = "Basic " + base64.b64encode(token.encode()).decode()
    req = urllib.request.Request(base.rstrip("/") + "/api" + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default="http://127.0.0.1:8000")
    ap.add_argument("--video", help="a video file to use as the camera")
    ap.add_argument("--rtsp", help="an RTSP URL to use as the camera")
    ap.add_argument("--model", default=str(ROOT / "docs" / "models" / "yolo" / "yolov8n-416.onnx"),
                    help="model path (.onnx, .pt, .engine) or rfdetr:medium")
    ap.add_argument("--conf", type=float, default=0.3)
    ap.add_argument("--name", default="Stray dog monitoring")
    a = ap.parse_args()

    if not a.video and not a.rtsp:
        a.video = str(ROOT / "data" / "stray_demo.mp4")
        if not Path(a.video).exists():
            sys.path.insert(0, str(ROOT / "scripts"))
            from make_stray_demo_video import main as make
            make(a.video)

    model = call(a.server, "POST", "/models", {"name": Path(a.model).name if ":" not in a.model[:8] else a.model,
                                                 "path": a.model, "notes": "Added by setup_stray_demo.py"})
    project = call(a.server, "POST", "/projects", {
        "name": a.name, "description": "Unaccompanied dog detection with hotspots and trends. People are blurred."})
    if a.rtsp:
        cam = call(a.server, "POST", f"/projects/{project['id']}/cameras",
                   {"name": "Street camera", "source_type": "rtsp", "source": a.rtsp, "fps_limit": 5})
    else:
        cam = call(a.server, "POST", f"/projects/{project['id']}/cameras/upload",
                   files={"file": a.video}, fields={"name": Path(a.video).stem.replace("_", " "), "fps_limit": "5"})
    call(a.server, "POST", f"/cameras/{cam['id']}/analytics", {
        "name": "Unaccompanied dog", "model_id": model["id"], "conf": a.conf, "classes": ["dog"],
        "rule": {"condition": "unaccompanied", "count": 1, "min_seconds": 3, "cooldown_seconds": 30,
                 "severity": "warning", "companions": ["person"], "companion_radius": 3, "blur_people": True}})
    call(a.server, "POST", f"/cameras/{cam['id']}/start")
    print(f"Ready. Open {a.server}/#/c/{cam['id']} for the live view "
          f"and {a.server}/#/p/{project['id']}?tab=insights for hotspots and trends.")


if __name__ == "__main__":
    main()
