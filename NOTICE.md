# Credits and licences

My own code in this repository is released under the MIT licence (see `LICENSE`).
Everything below was made by other people and keeps its own licence.

| What | Where | Licence |
| --- | --- | --- |
| YOLOv8n (COCO) and YOLOv8n Open Images V7, exported to ONNX at 416 pixels | `docs/models/yolo/` | AGPL-3.0, Ultralytics. https://github.com/ultralytics/ultralytics |
| Sample footage: worker zone, car, store aisle, bottle and people clips (shortened and re-encoded) | `docs/samples/` | CC BY 4.0, Intel IoT DevKit. https://github.com/intel-iot-devkit/sample-videos |
| MediaPipe Tasks Vision runtime, models and sample pictures | `docs/lab/` | Apache-2.0, Google. https://github.com/google-ai-edge/mediapipe |
| TensorFlow.js and COCO-SSD (model and runtime) | `docs/vendor/`, `docs/models/coco-ssd/` | Apache-2.0, Google |
| ONNX Runtime Web | `docs/vendor/ort/` | MIT, Microsoft |
| hls.js | `docs/vendor/hls.min.js` | Apache-2.0 |
| Synthetic stray dog test clip (`docs/samples/stray.mp4`, `stray.webm`, made by `scripts/make_stray_demo_video.py`) | `docs/samples/` | Built from the dog in darknet's `data/dog.jpg` (https://github.com/pjreddie/darknet, public domain licence) and a shopper cut from the Intel IoT DevKit retail sample (CC BY 4.0). The street is drawn by the script |

The browser demo is a showcase of general open models. It is not my own research or client work.
