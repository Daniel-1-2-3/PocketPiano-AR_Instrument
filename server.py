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
from hand_tracking import HandTracker
from fsr_reader import FSRReader


# ── SETTINGS ────────────────────────────────────────────────────────────────

VID_TAG = b"VID\x00"

# Measure the real black ArUco square, not the white paper around it.
TAG_SIZE_CM = 5.0

# Put this file beside server.py
MODEL_PATH = "hand_landmarker.task"

# If MediaPipe handedness is reversed, set this True.
# With a rear phone camera looking down at a table, usually keep False first.
SWAP_LEFT_RIGHT = False

# 1.0 = no smoothing. 0.35–0.55 = smoother.
FINGER_SMOOTHING = 0.45

# FSR Arduino ports.
# Change these to match your real ports.
# If one or both ports are wrong/missing, the server still runs.
LEFT_ARDUINO_PORT = "COM9"
RIGHT_ARDUINO_PORT = "COM10"

# FSR tap threshold.
# Raise this if your sensors fluctuate too much.
FSR_THRESHOLD = 120


# ── FASTAPI ─────────────────────────────────────────────────────────────────

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

renderer = Renderer()
calibrator = Calibrate()

# Single worker: OpenCV/MediaPipe processing is easier to keep stable this way.
executor = ThreadPoolExecutor(max_workers=1)

hand_tracker = HandTracker(
    model_path=MODEL_PATH,
    tag_size_cm=TAG_SIZE_CM,
    smoothing=FINGER_SMOOTHING,
    swap_left_right=SWAP_LEFT_RIGHT,
)

fsr_reader = FSRReader(
    left_port=LEFT_ARDUINO_PORT,
    right_port=RIGHT_ARDUINO_PORT,
    threshold=FSR_THRESHOLD,
    autostart=True,
)


# ── JSON HELPERS ─────────────────────────────────────────────────────────────

def to_builtin(value):
    """
    Converts numpy/OpenCV values into JSON-safe Python values.
    This keeps Renderer output safe for json.dumps().
    """
    if isinstance(value, np.ndarray):
        return value.tolist()

    if isinstance(value, (np.integer,)):
        return int(value)

    if isinstance(value, (np.floating,)):
        return float(value)

    if isinstance(value, dict):
        return {str(k): to_builtin(v) for k, v in value.items()}

    if isinstance(value, (list, tuple)):
        return [to_builtin(v) for v in value]

    return value


def normalize_bbox(bbox):
    """
    Frontend expects:
    {
      x1, y1, x2, y2
    }

    If your Renderer already returns that dict, this preserves it.
    If it returns a 4-list/tuple, this converts it.
    """
    if bbox is None:
        return None

    bbox = to_builtin(bbox)

    if isinstance(bbox, dict):
        return bbox

    if isinstance(bbox, list) and len(bbox) == 4:
        x1, y1, x2, y2 = bbox
        return {
            "x1": float(x1),
            "y1": float(y1),
            "x2": float(x2),
            "y2": float(y2),
        }

    return bbox


def normalize_marker(marker):
    """
    Normalizes marker output from Renderer.

    Required frontend fields:
    - id
    - corners: [[x,y], [x,y], [x,y], [x,y]]
      OpenCV ArUco order should be:
      top-left, top-right, bottom-right, bottom-left
    - center_px
    - side_px
    - cm_per_px
    """
    if marker is None:
        return None

    marker = to_builtin(marker)

    if not isinstance(marker, dict):
        return marker

    out = dict(marker)

    corners = out.get("corners")

    if corners is not None:
        pts = np.array(corners, dtype=np.float32).reshape(4, 2)

        tl, tr, br, bl = pts

        side_lengths = [
            np.linalg.norm(tr - tl),
            np.linalg.norm(br - tr),
            np.linalg.norm(bl - br),
            np.linalg.norm(tl - bl),
        ]

        side_px = float(np.mean(side_lengths))

        center = np.mean(pts, axis=0)

        out["corners"] = pts.tolist()
        out["center_px"] = [
            float(center[0]),
            float(center[1]),
        ]
        out["side_px"] = side_px

        if side_px > 1:
            out["cm_per_px"] = float(TAG_SIZE_CM / side_px)
        else:
            out["cm_per_px"] = None

    if "id" in out and out["id"] is not None:
        out["id"] = int(out["id"])

    return out


# ── FRAME DETECTION ─────────────────────────────────────────────────────────

def detect_sync(data: bytes):
    """
    Runs one frame through:
    1. OpenCV JPEG decode
    2. existing Renderer ArUco detection
    3. MediaPipe hand landmark detection
    4. FSR snapshot read
    """
    buf = np.frombuffer(data, dtype=np.uint8)
    frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)

    if frame is None:
        return {
            "found": False,
            "bbox": None,
            "marker": None,
            "hands": [],
            "fingers": {},
            "fsr": fsr_reader.empty_fsr_state(),
            "fsrRaw": fsr_reader.empty_raw_state(),
            "fsrConnected": fsr_reader.connection_state(),
            "keyEvents": [],
            "process_ms": 0,
            "error": "Could not decode JPEG frame",
        }

    t0 = time.perf_counter()

    found = False
    bbox = None
    marker = None

    try:
        # Keep your existing Renderer pipeline.
        _, found, bbox, raw_marker = renderer.process_frame_bgr(frame)

        found = bool(found)
        bbox = normalize_bbox(bbox)
        marker = normalize_marker(raw_marker) if found else None

    except Exception as error:
        print(f"Renderer error: {error}")
        found = False
        bbox = None
        marker = None

    # Run MediaPipe on the same frame.
    # If marker exists, hand tracker also adds ArUco-local x_cm/y_cm for fingertips.
    hand_result = hand_tracker.detect(frame, marker if found else None)

    # FSR reader runs in background threads.
    fsr_snapshot = fsr_reader.get_snapshot()

    ms = (time.perf_counter() - t0) * 1000

    if found and marker:
        finger_count = len(hand_result["fingers"])
        print(
            f"FOUND id={marker.get('id')} | "
            f"hands={len(hand_result['hands'])} | "
            f"fingers={finger_count} | "
            f"{ms:.1f}ms | "
            f"{len(data)//1024}KB"
        )
    else:
        print(
            f"no tag | "
            f"hands={len(hand_result['hands'])} | "
            f"{ms:.1f}ms | "
            f"{len(data)//1024}KB"
        )

    return {
        "found": found,
        "bbox": bbox,
        "marker": marker,
        "hands": hand_result["hands"],
        "fingers": hand_result["fingers"],
        "fsr": fsr_snapshot["fsr"],
        "fsrRaw": fsr_snapshot["fsrRaw"],
        "fsrConnected": fsr_snapshot["fsrConnected"],

        # We keep this field for your requested schema.
        # Actual key overlap + sound triggering happens in React because React
        # already owns the exact rendered key polygons.
        "keyEvents": [],

        "process_ms": round(ms, 1),
    }


def calibrate_sync(video_bytes: bytes):
    """
    Keeps your existing calibration flow.
    React sends calibration video bytes prefixed with VID_TAG.
    """
    result = calibrator.calibrate_from_video_bytes(video_bytes)
    renderer.update_intrinsics(result)
    return to_builtin(result)


# ── WEBSOCKET ───────────────────────────────────────────────────────────────

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

            # Calibration video flow: keep this working.
            if data[:4] == VID_TAG:
                print(f"calibration video | {len(data)//1024}KB")

                try:
                    result = await loop.run_in_executor(
                        executor,
                        calibrate_sync,
                        data[4:],
                    )

                    await websocket.send_text(json.dumps({
                        "type": "calibration_result",
                        "data": result,
                    }))

                except Exception as error:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "message": str(error),
                    }))

                continue

            # Normal detection frame.
            try:
                result = await loop.run_in_executor(
                    executor,
                    detect_sync,
                    data,
                )

                await websocket.send_text(json.dumps({
                    "type": "status",
                    **result,
                }))

            except Exception as error:
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "message": str(error),
                }))

    except WebSocketDisconnect:
        print("client disconnected")