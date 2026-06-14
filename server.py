import asyncio
import json
import time
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from renderer import Renderer
from calibrate import Calibrate
from fsr_reader import FSRReader

# Hand tracking is optional: if the model file is missing or mediapipe isn't
# installed, the server still runs (ArUco + keyboard work, just no hands).
try:
    from hand_tracking import HandTracker
    _HAND_IMPORT_OK = True
except Exception as _e:        # noqa
    print(f"[hands] import failed: {_e}")
    _HAND_IMPORT_OK = False

# Real size of the black ArUco square (cm). Only used to report cm/px scale.
TAG_SIZE_CM = 5.0

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

renderer   = Renderer()
calibrator = Calibrate()
fsr        = FSRReader().start()

tracker = None
if _HAND_IMPORT_OK:
    try:
        tracker = HandTracker()
        print("[hands] MediaPipe hand tracker ready")
    except Exception as e:
        print(f"[hands] disabled: {e}")
        tracker = None

# single-purpose executors so ArUco + MediaPipe run CONCURRENTLY per frame
# (previously one executor ran them sequentially -> latency = sum of both;
#  now latency = max of both)
executor_aruco = ThreadPoolExecutor(max_workers=1)
executor_hands = ThreadPoolExecutor(max_workers=1)

VID_TAG = b"VID\x00"


def _marker_extra(corners):
    """center_px + cm/px from the 4 corners (Renderer stays untouched)."""
    pts    = np.array(corners, dtype=np.float32)
    center = pts.mean(axis=0)
    sides  = [float(np.linalg.norm(pts[(i + 1) % 4] - pts[i])) for i in range(4)]
    avg    = float(np.mean(sides))
    cm_per_px = (TAG_SIZE_CM / avg) if avg > 1 else 0.0
    return [float(center[0]), float(center[1])], cm_per_px


async def detect_async(data: bytes, loop):
    buf   = np.frombuffer(data, dtype=np.uint8)
    frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if frame is None:
        return {"found": False, "bbox": None, "marker": None,
                "hands": [], "fingers": {}, "process_ms": 0.0}

    t0 = time.perf_counter()

    # Launch BOTH detectors at once — they run on independent copies of the
    # decoded frame in separate threads, so wall-clock time is max(t_aruco,
    # t_hands) instead of t_aruco + t_hands. This is the main latency win.
    aruco_fut = loop.run_in_executor(executor_aruco, renderer.process_frame_bgr, frame)
    hands_fut = (loop.run_in_executor(executor_hands, tracker.process, frame)
                 if tracker else None)

    _, found, bbox, marker = await aruco_fut
    hands, fingers = (await hands_fut) if hands_fut is not None else ([], {})

    ms = (time.perf_counter() - t0) * 1000

    out = {
        "found":      bool(found),
        "bbox":       bbox,
        "marker":     None,
        "hands":      hands,
        "fingers":    fingers,
        "process_ms": round(ms, 1),
    }
    if found and marker:
        center_px, cm_per_px = _marker_extra(marker["corners"])
        out["marker"] = {
            "id":         marker["id"],
            "corners":    marker["corners"],
            "center_px":  center_px,
            "cm_per_px":  round(cm_per_px, 5),
        }

    tag = ("id=" + str(marker["id"])) if found else "no tag"
    print(f"{tag} | hands={len(hands)} | fingers={len(fingers)} | {ms:.1f}ms")
    return out


executor_calib = ThreadPoolExecutor(max_workers=1)


def calibrate_sync(video_bytes: bytes):
    result = calibrator.calibrate_from_video_bytes(video_bytes)
    renderer.update_intrinsics(result)
    return result


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("client connected")
    loop = asyncio.get_running_loop()

    try:
        while True:
            msg = await websocket.receive()
            if not msg.get("bytes"):
                continue
            data = msg["bytes"]

            # ── calibration video (VID\0 prefix) — unchanged ──
            if data[:4] == VID_TAG:
                print(f"calibration video | {len(data)//1024}KB")
                try:
                    result = await loop.run_in_executor(executor_calib, calibrate_sync, data[4:])
                    await websocket.send_text(json.dumps({
                        "type": "calibration_result", "data": result}))
                except Exception as e:
                    await websocket.send_text(json.dumps({
                        "type": "error", "message": str(e)}))
                continue

            # ── normal detection frame ──
            result = await detect_async(data, loop)

            # FSR snapshot is cheap + thread-safe — read it here, not in a worker
            result["fsr"]           = fsr.states()
            result["fsr_connected"] = fsr.connected_status()

            # Overlap detection / key events are computed CLIENT-SIDE, where the
            # keyboard geometry (homography + key layout) lives. We send the raw
            # ingredients (fingertips + fsr) and leave keyEvents empty here.
            result["keyEvents"] = []

            await websocket.send_text(json.dumps({"type": "status", **result}))

    except WebSocketDisconnect:
        print("client disconnected")