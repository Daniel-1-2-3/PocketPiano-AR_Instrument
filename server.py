import json
import time

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


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("client connected")

    try:
        while True:
            msg = await websocket.receive()

            # ── binary: JPEG frame with 4-byte frame_id header ────────────────
            if "bytes" in msg and msg["bytes"]:
                data = msg["bytes"]
                t0   = time.perf_counter()

                # parse header
                frame_id = int.from_bytes(data[:4], "big")
                jpeg     = data[4:]

                buf   = np.frombuffer(jpeg, dtype=np.uint8)
                frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)

                if frame is None:
                    continue

                _, found, corners = calibrator.process_frame_bgr(frame)

                ms = (time.perf_counter() - t0) * 1000
                print(
                    f"{'FOUND' if found else 'no board'} | "
                    f"{ms:.1f}ms | in={len(jpeg)//1024}KB | "
                    f"frames={calibrator.frame_count()}"
                )

                # send back coords only — tiny JSON
                await websocket.send_text(json.dumps({
                    "type":     "status",
                    "frame_id": frame_id,
                    "frames":   calibrator.frame_count(),
                    "found":    found,
                    "corners":  corners,  # [[x,y], ...] in SEND_WIDTH x SEND_HEIGHT space or null
                }))

            # ── text: JSON command ────────────────────────────────────────────
            elif "text" in msg and msg["text"]:
                cmd    = json.loads(msg["text"])
                action = cmd.get("action")

                if action == "calibrate":
                    try:
                        result = calibrator.calibrate()
                        await websocket.send_text(json.dumps({
                            "type": "calibration_result",
                            "data": result,
                        }))
                        print(f"calibrated — RMS: {result['rms_reprojection_error']:.4f}")
                    except RuntimeError as e:
                        await websocket.send_text(json.dumps({
                            "type":    "error",
                            "message": str(e),
                        }))

                elif action == "reset":
                    calibrator.reset()
                    await websocket.send_text(json.dumps({"type": "reset"}))
                    print("reset")

    except WebSocketDisconnect:
        print("client disconnected")