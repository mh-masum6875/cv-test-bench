# Stray dog monitoring

This adds what a council-style stray dog pilot needs on top of the test bench. The hosted demo has a ready
**Stray dog monitoring** project (press **Start live demo** on the Projects page). Its two cameras play AI-generated
sample footage of residential streets, labelled as such, so it shows how the system works, not how accurate it is on real cameras.

**Quick start** (with the server running, see [Run it](../README.md#run-it)):

```bash
python scripts/setup_stray_demo.py                    # synthetic test clip and the bundled YOLOv8n ONNX model
python scripts/setup_stray_demo.py --video street.mp4 # your own footage
python scripts/setup_stray_demo.py --rtsp rtsp://user:pass@192.168.1.20:554/stream1
```

It creates a project, a camera and an **Unaccompanied dog** analytic, starts it, and prints the links.

What is new:

| Feature | Where | Notes |
| --- | --- | --- |
| Tracking with IDs | `app/tracking.py` | IoU matching with a centre-distance fallback, no extra packages. Gives a count of tracked visits and time in view per dog. A dog hidden for more than a few seconds comes back with a new ID |
| "An object is alone" rule | Analytic editor, `condition: unaccompanied` | A dog counts only when no person is within N dog-heights (default 3). Red box = alone, blue = with a person |
| Sightings log | `sightings` table | One row per tracked visit: first and last seen, time in view, time alone, largest group, longest time still, line crossings, position. Analytics with the same model, classes and zone share one tracker, so a dog is logged once however many rules watch it |
| Pack alert | Analytic editor, `condition: group` | N or more dogs within R dog-heights of each other, chained through neighbours. The alert says the group size |
| Dog not moving | Analytic editor, `condition: still` | A dog whose feet stay within a set share of the frame width (default 3%) for the hold time, for example a dog lying in the road |
| Road crossings | Counting line in the analytic editor, `condition: crossing` | Counts each tracked dog crossing the line, in each direction. Per hour on the Insights tab and in `GET /api/projects/{id}/crossings.csv` |
| Hotspot heatmap | Insights tab, `GET /api/cameras/{id}/heatmap?label=dog` | Where dogs stood (foot point) over the last day, week or month. The class picker on the Insights tab limits the whole tab to one class |
| Trends | Insights tab, `GET /api/projects/{id}/insights` | Totals, by hour of day, by day, per camera. In the hosted demo the same data is kept in your browser |
| CSV export | `GET /api/projects/{id}/sightings.csv` | For council reports |
| Privacy | "Blur faces" option on the analytic | The head area of each detected person is blurred in the live view, the stored stills and alert pictures. People stay visible otherwise |
| Login | `APP_PASSWORD=... APP_USER=...` environment variables | HTTP Basic login on every page and API call. Use HTTPS or a VPN in front of it |
| ONNX models without PyTorch | `app/detectors.py`, `OnnxDetector` | `.onnx` exports of YOLOv5u/v8/11 and end-to-end exports (YOLO26) run with ONNX Runtime |
| RF-DETR | Register a model with path `rfdetr:medium` (or `rfdetr:medium:/path/best.pth`) | Apache 2.0, safe for a commercial product. Needs `pip install rfdetr`. Written against the rfdetr package API but **not yet tested** in this branch |

How a sighting is classed as **unaccompanied**: the dog was alone for at least the rule's
"must hold for" time, or for most of the time it was in view. Sightings are written when a track
ends (the dog leaves the view for more than 3 seconds) or when the camera stops.

Limits:

* A camera cannot see ownership. "Unaccompanied" means no person near the dog, which is what the
  San Antonio roaming dog study also used. A loose pet dog will count too.
* The bundled `yolov8n` model is small and sometimes calls a dog a cat at a distance. For a pilot,
  fine-tune a detector on local day and night footage at the council's camera heights.
* Night performance depends on the camera. Report day and night accuracy separately.
* The bundled YOLOv8 weights are AGPL-3.0. Use RF-DETR (Apache 2.0) or an Ultralytics licence for a commercial product.
* The synthetic clip from `scripts/make_stray_demo_video.py` only checks the pipeline. Do not use it as evidence of accuracy.

* On the example clip "Dog not moving" is set to 3 seconds because the clip is 10 seconds long. On a
  real street use 30 seconds or more.

Tests (from the repository root): `python -m pytest tests/test_tracking.py tests/test_rules.py tests/test_analytics.py`
