# hand_tracking.py
# ─────────────────────────────────────────────────────────────────────────────
# Thin wrapper around the MediaPipe Tasks HandLandmarker. Keeps all MediaPipe
# setup out of server.py.
#
# tracker.process(frame_bgr) returns (hands, fingers):
#   hands   = [ { "hand": "left"/"right", "score": float,
#                 "landmarks": [ {id, x_px, y_px, z}, ... 21 points ] }, ... ]
#   fingers = { "left_index": {hand, finger, finger_index, x_px, y_px}, ... }
#
# The fingertip names (left_index, right_thumb, ...) are exactly the keys the
# FSR reader uses, so the two line up with no extra mapping.

import cv2
import numpy as np
import mediapipe as mp
import os
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

# Put hand_landmarker.task next to THIS FILE.
#   download: https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
#
# IMPORTANT: resolved relative to this file's own directory, NOT the current
# working directory. A bare "hand_landmarker.task" only worked if uvicorn
# happened to be launched from this exact folder — if it was launched from
# anywhere else, HandLandmarker.create_from_options() throws, server.py
# catches it and sets tracker = None, and EVERY frame after that silently
# returns 0 hands no matter what's in view. Check the startup console for
# "[hands] disabled: ..." — that's this failure.
_THIS_DIR  = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(_THIS_DIR, "hand_landmarker.task")

# If MediaPipe reports left/right swapped (common with a NON-mirrored rear
# camera looking down), flip this. It must match how your gloves are wired,
# because the FSR mapping keys off "left"/"right".
SWAP_LEFT_RIGHT = False

# exponential smoothing for fingertip pixels (1.0 = none, lower = smoother)
SMOOTHING = 0.5

# Detection thresholds. 0.55 is fairly strict — top-down views, gloves, or
# motion blur can all push confidence below this and result in 0 hands even
# when a hand is clearly in frame. Lowered to 0.3 as a starting point; raise
# back toward 0.5+ once you confirm detection works, to cut false positives.
MIN_DETECTION_CONF = 0.3
MIN_PRESENCE_CONF  = 0.3
MIN_TRACKING_CONF  = 0.3

# Print one line every N frames: frame size/brightness + raw landmark count.
# This tells you definitively whether process() runs and what MediaPipe sees.
# Set to 0 to disable.
DEBUG_EVERY_N_FRAMES = 30

# the 5 fingertip landmark ids in MediaPipe's 21-point hand model
FINGERTIPS   = {"thumb": 4, "index": 8, "middle": 12, "ring": 16, "pinky": 20}
FINGER_ORDER = ["thumb", "index", "middle", "ring", "pinky"]

BaseOptions           = python.BaseOptions
HandLandmarker        = vision.HandLandmarker
HandLandmarkerOptions = vision.HandLandmarkerOptions
RunningMode           = vision.RunningMode


class HandTracker:
    def __init__(self, model_path: str = MODEL_PATH):
        if not os.path.exists(model_path):
            raise FileNotFoundError(
                f"hand_landmarker.task not found at: {model_path}\n"
                f"  -> download it and place it next to hand_tracking.py:\n"
                f"     https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
            )
        opts = HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=model_path),
            running_mode=RunningMode.VIDEO,   # VIDEO mode = temporal tracking
            num_hands=2,
            min_hand_detection_confidence=MIN_DETECTION_CONF,
            min_hand_presence_confidence=MIN_PRESENCE_CONF,
            min_tracking_confidence=MIN_TRACKING_CONF,
        )
        self.landmarker = HandLandmarker.create_from_options(opts)
        self._frame = 0
        self._smooth = {}   # finger_key -> (x, y)

    def _label(self, name):
        if name is None:
            return "unknown"
        n = name.lower()
        if SWAP_LEFT_RIGHT:
            if n == "left":  return "right"
            if n == "right": return "left"
        return n

    def process(self, frame_bgr):
        h, w = frame_bgr.shape[:2]
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

        # VIDEO mode requires a monotonically increasing timestamp (ms)
        self._frame += 1
        ts_ms = self._frame * 33
        res = self.landmarker.detect_for_video(mp_img, ts_ms)

        # ── DIAGNOSTIC: proves process() runs every frame and shows exactly
        # what MediaPipe returns. If "process() called" never prints, the
        # tracker isn't being invoked at all (check server.py wiring). If it
        # prints but raw_hands=0 forever with a visible hand and reasonable
        # brightness, it's a detection-quality issue (angle/lighting/gloves),
        # not a wiring issue.
        if DEBUG_EVERY_N_FRAMES and self._frame % DEBUG_EVERY_N_FRAMES == 0:
            brightness = float(rgb.mean())
            print(f"[hands] process() called | frame={w}x{h} "
                  f"brightness={brightness:.1f} | raw_hands={len(res.hand_landmarks)}")

        hands, fingers = [], {}
        if not res.hand_landmarks:
            return hands, fingers

        for i, lms in enumerate(res.hand_landmarks):
            # ── handedness label + score ──
            label, score = "unknown", None
            if res.handedness and i < len(res.handedness) and res.handedness[i]:
                cat   = res.handedness[i][0]
                label = self._label(cat.category_name)
                score = float(cat.score)

            # ── full 21-point skeleton in pixels ──
            landmarks = [{
                "id":   j,
                "x_px": float(lm.x * w),
                "y_px": float(lm.y * h),
                "z":    float(lm.z),
            } for j, lm in enumerate(lms)]
            hands.append({"hand": label, "score": score, "landmarks": landmarks})

            # ── named fingertips (smoothed) ──
            for fname, lid in FINGERTIPS.items():
                lm = lms[lid]
                x, y = float(lm.x * w), float(lm.y * h)
                key  = f"{label}_{fname}"
                prev = self._smooth.get(key)
                if prev is None:
                    sx, sy = x, y
                else:
                    sx = SMOOTHING * x + (1.0 - SMOOTHING) * prev[0]
                    sy = SMOOTHING * y + (1.0 - SMOOTHING) * prev[1]
                self._smooth[key] = (sx, sy)
                fingers[key] = {
                    "hand":         label,
                    "finger":       fname,
                    "finger_index": FINGER_ORDER.index(fname),
                    "x_px":         round(sx, 1),
                    "y_px":         round(sy, 1),
                }

        return hands, fingers