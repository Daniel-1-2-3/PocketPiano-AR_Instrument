import asyncio
import base64
import io
import time

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    print("client connected")
    try:
        while True:
            # receive compressed JPEG bytes
            data = await websocket.receive_bytes()
            t0 = time.perf_counter()

            # decode
            buf   = np.frombuffer(data, dtype=np.uint8)
            frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)

            if frame is not None:
                h, w = frame.shape[:2]
                # draw red square in center
                sq = min(w, h) // 4
                cx, cy = w // 2, h // 2
                cv2.rectangle(
                    frame,
                    (cx - sq, cy - sq),
                    (cx + sq, cy + sq),
                    (0, 0, 255),  # BGR red
                    3,
                )

                # re-encode at same small size
                _, enc = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 50])
                out = enc.tobytes()
            else:
                out = data  # pass through on error

            elapsed_ms = (time.perf_counter() - t0) * 1000
            print(f"processed in {elapsed_ms:.1f}ms  {len(data)/1024:.1f}KB → {len(out)/1024:.1f}KB")

            await websocket.send_bytes(out)

    except WebSocketDisconnect:
        print("client disconnected")