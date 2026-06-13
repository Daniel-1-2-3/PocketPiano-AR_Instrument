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

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

renderer  = Renderer()
calibrate = Calibrate()
executor  = ThreadPoolExecutor(max_workers=1)

# ── global camera intrinsics — updated after calibration ──────────────────────
CAM_INTRINSICS: dict | None = None


def detect_sync(data: bytes):
    buf   = np.frombuffer(data, dtype=np.uint8)
    frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if frame is None:
        return False, None, None

    t0 = time.perf_counter()
    _, found, bbox, marker = renderer.process_frame_bgr(frame)
    ms = (time.perf_counter() - t0) * 1000
    print(
        f"{'FOUND id=' + str(marker['id']) if found else 'no tag'} | "
        f"detect={ms:.1f}ms | in={len(data)//1024}KB"
    )
    return found, bbox, marker


def calibrate_sync(video_bytes: bytes):
    return calibrate.calibrate_from_video_bytes(video_bytes)


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    global CAM_INTRINSICS
    await websocket.accept()
    print("client connected")

    loop = asyncio.get_event_loop()

    try:
        while True:
            msg = await websocket.receive()

            # ── binary: either a JPEG frame or a raw video blob ───────────────
            if "bytes" in msg and msg["bytes"]:
                data = msg["bytes"]

                # check 4-byte type tag prepended by frontend
                msg_type = data[:4]

                if msg_type == b"VID\x00":
                    # full video blob for calibration
                    video_bytes = data[4:]
                    print(f"received video: {len(video_bytes)//1024}KB — calibrating…")

                    try:
                        result = await loop.run_in_executor(
                            executor, calibrate_sync, video_bytes
                        )
                        CAM_INTRINSICS = result
                        renderer.update_intrinsics(result)
                        await websocket.send_text(json.dumps({
                            "type": "calibration_result",
                            "data": result,
                        }))
                        print(f"calibration done RMS={result['rms_reprojection_error']:.4f}")
                    except RuntimeError as e:
                        await websocket.send_text(json.dumps({
                            "type": "error", "message": str(e),
                        }))

                else:
                    # regular JPEG frame for live AR detection
                    found, bbox, marker = await loop.run_in_executor(
                        executor, detect_sync, data
                    )
                    await websocket.send_text(json.dumps({
                        "type":   "status",
                        "found":  found,
                        "bbox":   bbox,
                        "marker": marker,
                    }))

    except WebSocketDisconnect:
        print("client disconnected")