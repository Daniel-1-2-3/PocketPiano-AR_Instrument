import os
import cv2
import numpy as np


try:
    import mediapipe as mp
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision

    MEDIAPIPE_AVAILABLE = True

except Exception as error:
    print(f"MediaPipe import failed: {error}")
    MEDIAPIPE_AVAILABLE = False
    mp = None
    python = None
    vision = None


FINGERTIPS = {
    "thumb": 4,
    "index": 8,
    "middle": 12,
    "ring": 16,
    "pinky": 20,
}

FINGER_ORDER = ["thumb", "index", "middle", "ring", "pinky"]


class HandTracker:
    """
    MediaPipe Tasks hand tracker.

    Output:
    {
      hands: [
        {
          hand: "left",
          score: 0.95,
          landmarks: [
            { id, x_px, y_px, z },
            ...
          ]
        }
      ],
      fingers: {
        left_index: {
          hand,
          finger,
          x_px,
          y_px,
          x_cm,
          y_cm
        }
      }
    }

    x_cm/y_cm are ArUco-local only when marker corners are available.
    """

    def __init__(
        self,
        model_path="hand_landmarker.task",
        tag_size_cm=5.0,
        smoothing=0.45,
        swap_left_right=False,
        x_sign=1,
    ):
        self.model_path = model_path
        self.tag_size_cm = tag_size_cm
        self.smoothing = smoothing
        self.swap_left_right = swap_left_right
        self.x_sign = x_sign

        self.frame_counter = 0
        self.landmarker = None

        # Smooth only fingertip positions, not the full skeleton.
        self.smoothed_tip_px = {}

        if not MEDIAPIPE_AVAILABLE:
            print("MediaPipe unavailable. Hand tracking disabled.")
            return

        if not os.path.exists(model_path):
            print(
                f"MediaPipe model not found: {model_path}. "
                "Hand tracking disabled until you add hand_landmarker.task."
            )
            return

        BaseOptions = python.BaseOptions
        HandLandmarker = vision.HandLandmarker
        HandLandmarkerOptions = vision.HandLandmarkerOptions
        VisionRunningMode = vision.RunningMode

        options = HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=model_path),
            running_mode=VisionRunningMode.VIDEO,
            num_hands=2,
            min_hand_detection_confidence=0.55,
            min_hand_presence_confidence=0.55,
            min_tracking_confidence=0.55,
        )

        self.landmarker = HandLandmarker.create_from_options(options)

        print("MediaPipe hand tracker loaded.")

    def normalize_hand_label(self, label):
        """
        MediaPipe returns 'Left' or 'Right'.
        For a rear phone camera looking down at a table, usually this is okay.

        If it feels reversed, set SWAP_LEFT_RIGHT=True in server.py.
        """
        if label is None:
            return "unknown"

        label = label.lower()

        if self.swap_left_right:
            if label == "left":
                return "right"
            if label == "right":
                return "left"

        return label

    def marker_basis(self, marker):
        """
        Converts marker corners into a local coordinate basis.

        ArUco corner order:
        [top-left, top-right, bottom-right, bottom-left]

        x axis: tag left → tag right
        y axis: tag top → tag bottom

        This lets each fingertip get x_cm/y_cm relative to the marker.
        """
        if not marker:
            return None

        corners = marker.get("corners")

        if corners is None:
            return None

        pts = np.array(corners, dtype=np.float32).reshape(4, 2)

        tl, tr, br, bl = pts

        center = np.mean(pts, axis=0)

        x_axis = ((tr - tl) + (br - bl)) / 2.0
        y_axis = ((bl - tl) + (br - tr)) / 2.0

        x_norm = np.linalg.norm(x_axis)
        y_norm = np.linalg.norm(y_axis)

        if x_norm <= 1 or y_norm <= 1:
            return None

        x_unit = x_axis / x_norm
        y_unit = y_axis / y_norm

        cm_per_px = marker.get("cm_per_px")

        if cm_per_px is None:
            side_lengths = [
                np.linalg.norm(tr - tl),
                np.linalg.norm(br - tr),
                np.linalg.norm(bl - br),
                np.linalg.norm(tl - bl),
            ]

            avg_side_px = float(np.mean(side_lengths))

            if avg_side_px <= 1:
                return None

            cm_per_px = self.tag_size_cm / avg_side_px

        return {
            "center": center,
            "x_unit": x_unit,
            "y_unit": y_unit,
            "cm_per_px": float(cm_per_px),
        }

    def local_cm_from_px(self, x_px, y_px, basis):
        """
        Projects a fingertip pixel onto the ArUco tag's local x/y axes.
        """
        if basis is None:
            return None, None

        point = np.array([x_px, y_px], dtype=np.float32)
        offset = point - basis["center"]

        x_px_local = float(np.dot(offset, basis["x_unit"]))
        y_px_local = float(np.dot(offset, basis["y_unit"]))

        x_cm = self.x_sign * x_px_local * basis["cm_per_px"]
        y_cm = y_px_local * basis["cm_per_px"]

        return x_cm, y_cm

    def smooth_tip(self, finger_key, x_px, y_px):
        previous = self.smoothed_tip_px.get(finger_key)

        if previous is None:
            smoothed = (x_px, y_px)
        else:
            old_x, old_y = previous

            smoothed = (
                self.smoothing * x_px + (1.0 - self.smoothing) * old_x,
                self.smoothing * y_px + (1.0 - self.smoothing) * old_y,
            )

        self.smoothed_tip_px[finger_key] = smoothed
        return smoothed

    def detect(self, frame_bgr, marker=None):
        if self.landmarker is None:
            return {
                "hands": [],
                "fingers": {},
            }

        h, w = frame_bgr.shape[:2]

        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

        mp_image = mp.Image(
            image_format=mp.ImageFormat.SRGB,
            data=frame_rgb,
        )

        # VIDEO mode requires a strictly increasing timestamp.
        self.frame_counter += 1
        timestamp_ms = self.frame_counter * 33

        result = self.landmarker.detect_for_video(
            mp_image,
            timestamp_ms,
        )

        if not result.hand_landmarks:
            return {
                "hands": [],
                "fingers": {},
            }

        basis = self.marker_basis(marker)

        hands_out = []
        fingers_out = {}

        for hand_index, hand_landmarks in enumerate(result.hand_landmarks):
            hand_label = f"hand_{hand_index + 1}"
            hand_score = None

            # Handedness classification: left or right.
            if result.handedness and hand_index < len(result.handedness):
                if len(result.handedness[hand_index]) > 0:
                    category = result.handedness[hand_index][0]
                    hand_label = self.normalize_hand_label(category.category_name)
                    hand_score = float(category.score)

            landmarks_out = []

            for landmark_id, lm in enumerate(hand_landmarks):
                x_px = float(lm.x * w)
                y_px = float(lm.y * h)

                landmarks_out.append({
                    "id": int(landmark_id),
                    "x_px": round(x_px, 2),
                    "y_px": round(y_px, 2),
                    "z": round(float(lm.z), 5),
                })

            hands_out.append({
                "hand": hand_label,
                "score": round(hand_score, 3) if hand_score is not None else None,
                "landmarks": landmarks_out,
            })

            # Extract fingertips only.
            for finger_name, landmark_id in FINGERTIPS.items():
                lm = hand_landmarks[landmark_id]

                raw_x_px = float(lm.x * w)
                raw_y_px = float(lm.y * h)

                finger_key = f"{hand_label}_{finger_name}"

                smooth_x_px, smooth_y_px = self.smooth_tip(
                    finger_key,
                    raw_x_px,
                    raw_y_px,
                )

                x_cm, y_cm = self.local_cm_from_px(
                    smooth_x_px,
                    smooth_y_px,
                    basis,
                )

                fingers_out[finger_key] = {
                    "hand": hand_label,
                    "hand_score": round(hand_score, 3) if hand_score is not None else None,
                    "finger": finger_name,
                    "finger_index": FINGER_ORDER.index(finger_name),

                    # Smoothed position used by frontend for hit detection.
                    "x_px": round(smooth_x_px, 2),
                    "y_px": round(smooth_y_px, 2),

                    # Raw MediaPipe fingertip position for debugging.
                    "raw_x_px": round(raw_x_px, 2),
                    "raw_y_px": round(raw_y_px, 2),

                    # ArUco-local coordinates. Null when marker is not found.
                    "x_cm": round(x_cm, 2) if x_cm is not None else None,
                    "y_cm": round(y_cm, 2) if y_cm is not None else None,
                }

        return {
            "hands": hands_out,
            "fingers": fingers_out,
        }