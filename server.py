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

renderer   = Renderer()
calibrator = Calibrate()
# single worker: cv2 detector isn't thread-safe; one thread avoids any locking overhead
executor = ThreadPoolExecutor(max_workers=1)

VID_TAG = b"VID\x00"


def detect_sync(data: bytes):
    buf   = np.frombuffer(data, dtype=np.uint8)
    frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if frame is None:
        return False, None, None
    t0 = time.perf_counter()
    _, found, bbox, marker = renderer.process_frame_bgr(frame)
    ms = (time.perf_counter() - t0) * 1000
    print(f"{'FOUND id='+str(marker['id']) if found else 'no tag'} | {ms:.1f}ms | {len(data)//1024}KB")
    return found, bbox, marker


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

            # calibration video
            if data[:4] == VID_TAG:
                print(f"calibration video | {len(data)//1024}KB")
                try:
                    result = await loop.run_in_executor(executor, calibrate_sync, data[4:])
                    await websocket.send_text(json.dumps({"type": "calibration_result", "data": result}))
                except Exception as e:
                    await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
                continue

            # detection frame
            found, bbox, marker = await loop.run_in_executor(executor, detect_sync, data)
            await websocket.send_text(json.dumps({
                "type": "status", "found": found, "bbox": bbox, "marker": marker,
            }))

    except WebSocketDisconnect:
        print("client disconnected")