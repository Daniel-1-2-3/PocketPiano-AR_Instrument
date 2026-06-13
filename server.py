import asyncio
import json
import time
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from calibrate import Calibrator

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

calibrator = Calibrator()
executor   = ThreadPoolExecutor(max_workers=1)


def detect_sync(data: bytes):
    buf   = np.frombuffer(data, dtype=np.uint8)
    frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if frame is None:
        return False, None, None

    t0 = time.perf_counter()
    _, found, bbox, marker = calibrator.process_frame_bgr(frame)
    ms = (time.perf_counter() - t0) * 1000
    print(
        f"{'FOUND id=' + str(marker['id']) if found else 'no tag'} | "
        f"detect={ms:.1f}ms | in={len(data)//1024}KB"
    )
    return found, bbox, marker


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("client connected")

    loop = asyncio.get_event_loop()

    try:
        while True:
            msg = await websocket.receive()

            if "bytes" in msg and msg["bytes"]:
                found, bbox, marker = await loop.run_in_executor(
                    executor, detect_sync, msg["bytes"]
                )
                await websocket.send_text(json.dumps({
                    "type":   "status",
                    "found":  found,
                    "bbox":   bbox,
                    "marker": marker,
                }))

            elif "text" in msg and msg["text"]:
                cmd    = json.loads(msg["text"])
                action = cmd.get("action")

                if action == "calibrate":
                    try:
                        result = await loop.run_in_executor(
                            executor, calibrator.calibrate
                        )
                        await websocket.send_text(json.dumps({
                            "type": "calibration_result",
                            "data": result,
                        }))
                        print(f"calibrated — RMS: {result['rms_reprojection_error']:.4f}")
                    except RuntimeError as e:
                        await websocket.send_text(json.dumps({
                            "type": "error", "message": str(e),
                        }))

                elif action == "reset":
                    calibrator.reset()
                    await websocket.send_text(json.dumps({"type": "reset"}))
                    print("reset")

    except WebSocketDisconnect:
        print("client disconnected")