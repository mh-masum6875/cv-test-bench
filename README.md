# CV Test Bench

A small dashboard for testing computer vision models on live RTSP streams and recorded video.

Part of the portfolio of [Maidul Hasan Masum](https://mh-masum6875.github.io).

**Try it in your browser (no install): https://mh-masum6875.github.io/cv-test-bench/**
The hosted version runs entirely in your browser, with sample footage, your own video files, your
webcam or an HLS link, and two built-in detectors (motion and COCO-SSD). Nothing is uploaded.
For **RTSP streams and your own YOLO weights**, run the server version below. It is the same interface.

Create a **project**, add **cameras** (an RTSP URL or an uploaded video), attach one or more
**analytics** to each camera (a model, a confidence threshold, an optional detection zone and an
alert rule), and watch the annotated feed live. Alerts are saved with a snapshot and can also be
sent to a webhook.

## Run it

**Windows:** install Python 3.10 or newer, then double-click `run.bat`. The first start installs the packages and opens the browser.

**Mac or Linux:**

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pip install ultralytics            # only if you want to run your own YOLO weights
./scripts/dev.sh                   # then open http://127.0.0.1:8000
```

Or with Docker: `docker build -t cv-test-bench . && docker run -p 8000:8000 -v $PWD/data:/app/data cv-test-bench`

The app listens on `127.0.0.1` by default. Set `HOST=0.0.0.0` to reach it from other machines,
and put it behind a login or VPN first, because it has no user accounts.

## Try it without a camera

```bash
python scripts/make_demo_video.py demo.mp4
```

A ready-made copy is in `samples/demo.mp4`.

Make a project, choose **Add camera, Upload a video**, pick `demo.mp4`, add an analytic that uses
the built-in **Motion detector**, and press Start. Objects walk through the scene, so alerts fire
within seconds.

## Test your own model

1. Open **Models, Add model**, give the path to your weights (or upload the file). Any file that
   Ultralytics can load works: `.pt`, `.onnx`, `.engine`, `.torchscript`.
2. On a camera, **Add analytic**, pick the model, and choose which classes to count.
3. Draw a zone if you only care about part of the frame.
4. Set the alert rule and press Start on the camera.

Each analytic card shows objects now, milliseconds per frame, and a one-minute chart, so you can
compare models on the same footage.

## Alert rules

| Setting | Meaning |
| --- | --- |
| Alert when | `objects are present` (N or more) or `nothing is detected` |
| Must hold for | The condition has to stay true this many seconds before an alert fires (dwell time) |
| Wait between alerts | Cooldown, so one event does not flood you |
| Active on, From, Until | Days and a time window. Windows that cross midnight work, for example 22:00 to 06:00 |
| Severity | info, warning or critical |
| Webhook URL | Receives a JSON POST for every alert: camera, analytic, message, severity, counts, time |

## RTSP tips

* Use **Test connection** in the Add camera dialog first.
* Streams are read over TCP, which is more reliable than UDP on most networks.
* The newest frame is always processed. If your model is slower than the stream, frames are
  skipped instead of building up delay. **Process at most** sets the ceiling.
* If the stream drops, the camera shows `error` and reconnects by itself.
* Passwords in the URL are hidden in the tables.

## Where things are

```
app/main.py        API routes
app/runner.py      one worker per camera: read, detect, apply rules, draw
app/detectors.py   Motion detector and the Ultralytics wrapper. Add your own here
app/rules.py       dwell time, cooldown and schedule logic
app/db.py          SQLite tables
docs/              the web interface (plain JavaScript, no build step). Also what GitHub Pages serves
docs/demo.js       the in-browser backend used when no server is running
docs/vendor/       TensorFlow.js, COCO-SSD and hls.js, bundled so the site needs no CDN
docs/models/       the COCO-SSD weights used by the browser demo
data/              database, uploaded videos and models, alert snapshots
```

To use a model that is not Ultralytics, subclass `Detector` in `app/detectors.py`, return
`{label, conf, box}` dictionaries, and add it to `build_detector`.

## Check that it works

With the server running: `python tests/test_api.py http://127.0.0.1:8000 demo.mp4`

## Publish the browser demo on GitHub Pages

1. Create a public repository, for example `cv-test-bench`, and push this folder to it.
2. In the repository open **Settings, Pages**, choose **Deploy from a branch**, branch `main`, folder `/docs`.
3. The site appears at `https://<your-user>.github.io/cv-test-bench/` after a minute.

The page detects whether a Python server is behind it. On GitHub Pages there is none, so it switches to
the in-browser backend automatically.
