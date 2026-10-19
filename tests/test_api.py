"""End-to-end check against a running server:  python tests/test_api.py http://127.0.0.1:8000"""
import sys
import time
import requests

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
VIDEO = sys.argv[2] if len(sys.argv) > 2 else "data/demo.mp4"


def ok(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        sys.exit(1)


p = requests.post(f"{BASE}/api/projects", json={"name": "Test project", "description": "smoke"}).json()
ok(p["id"], "create project")
with open(VIDEO, "rb") as f:
    cam = requests.post(f"{BASE}/api/projects/{p['id']}/cameras/upload", data={"name": "Demo video", "fps_limit": 8},
                        files={"file": ("demo.mp4", f, "video/mp4")}).json()
ok(cam["source_type"] == "file", "upload video as a camera")
bad = requests.post(f"{BASE}/api/projects/{p['id']}/cameras", json={"name": "x", "source_type": "rtsp", "source": "not-a-url"})
ok(bad.status_code == 400, "reject a bad RTSP url")
models = requests.get(f"{BASE}/api/models").json()
ok(models and models[0]["kind"] == "motion", "built-in motion model exists")
rule = {"condition": "count_gte", "count": 1, "min_seconds": 1, "cooldown_seconds": 4, "severity": "critical"}
an = requests.post(f"{BASE}/api/cameras/{cam['id']}/analytics",
                   json={"name": "Movement", "model_id": models[0]["id"], "conf": 0.4, "rule": rule}).json()
ok(an["id"], "add analytic with a rule")
bad = requests.post(f"{BASE}/api/cameras/{cam['id']}/analytics",
                    json={"name": "Zone", "model_id": models[0]["id"], "roi": [[0, 0], [1, 1]]})
ok(bad.status_code == 400, "reject a zone with fewer than 3 points")
requests.post(f"{BASE}/api/cameras/{cam['id']}/start")
t0, st = time.time(), {}
while time.time() - t0 < 25:
    st = requests.get(f"{BASE}/api/cameras/{cam['id']}/status").json()
    if st["status"] == "live" and st["fps_out"] > 0:
        break
    time.sleep(1)
ok(st["status"] == "live", f"camera goes live ({st['fps_in']} fps in, {st['fps_out']} fps processed)")
snap = requests.get(f"{BASE}/api/cameras/{cam['id']}/snapshot.jpg")
ok(snap.headers["content-type"] == "image/jpeg" and len(snap.content) > 5000, "annotated snapshot served")
t0 = time.time()
alerts = []
while time.time() - t0 < 40 and not alerts:
    alerts = requests.get(f"{BASE}/api/alerts", params={"project_id": p["id"]}).json()
    time.sleep(2)
ok(len(alerts) > 0, f"alert raised ({alerts[0]['message'] if alerts else ''})")
img = requests.get(f"{BASE}/api/alerts/{alerts[0]['id']}/snapshot.jpg")
ok(img.status_code == 200 and len(img.content) > 5000, "alert snapshot saved")
requests.post(f"{BASE}/api/alerts/{alerts[0]['id']}/ack")
open_alerts = requests.get(f"{BASE}/api/alerts", params={"project_id": p["id"], "open_only": True}).json()
ok(all(a["id"] != alerts[0]["id"] for a in open_alerts), "acknowledge an alert")
# a zone that covers a corner nobody walks through should not count anything
requests.put(f"{BASE}/api/analytics/{an['id']}", json={"name": "Corner", "model_id": models[0]["id"], "conf": 0.4,
             "roi": [[0, 0], [0.1, 0], [0.1, 0.1]], "rule": rule})
time.sleep(4)
st = requests.get(f"{BASE}/api/cameras/{cam['id']}/status").json()
ok(st["analytics"][0]["count"] == 0, "zone filtering excludes objects outside the zone")
requests.post(f"{BASE}/api/cameras/{cam['id']}/stop")
requests.delete(f"{BASE}/api/projects/{p['id']}")
ok(not [x for x in requests.get(f"{BASE}/api/projects").json() if x["id"] == p["id"]], "delete project")
print("ALL PASSED")
