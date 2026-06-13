import json
import cv2
import numpy as np

CHESSBOARD_SIZE = (8, 5)
SQUARE_SIZE_MM  = 10.0


class Calibrate:
    def __init__(self):
        self._subpix_crit = (
            cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001
        )
        objp = np.zeros((CHESSBOARD_SIZE[0] * CHESSBOARD_SIZE[1], 3), np.float32)
        objp[:, :2] = (
            np.mgrid[0:CHESSBOARD_SIZE[0], 0:CHESSBOARD_SIZE[1]]
            .T.reshape(-1, 2)
        )
        objp *= SQUARE_SIZE_MM
        self._objp = objp

    def calibrate_from_video_bytes(self, video_bytes: bytes) -> dict:
        """
        Accepts raw video bytes, extracts frames, detects chessboard,
        runs calibrateCamera, returns intrinsics dict.
        """
        import tempfile, os
        # write to temp file so VideoCapture can read it
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(video_bytes)
            tmp_path = f.name

        try:
            cap = cv2.VideoCapture(tmp_path)
            if not cap.isOpened():
                raise RuntimeError("Could not open video")

            objpoints = []
            imgpoints = []
            image_size = None
            frame_idx  = 0
            sampled    = 0

            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                frame_idx += 1
                # sample every 5th frame to avoid near-duplicate captures
                if frame_idx % 5 != 0:
                    continue

                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                if image_size is None:
                    image_size = (frame.shape[1], frame.shape[0])

                small  = cv2.resize(gray, (0, 0), fx=0.5, fy=0.5)
                found, corners = cv2.findChessboardCorners(
                    small, CHESSBOARD_SIZE,
                    cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE,
                )
                if found:
                    cv2.cornerSubPix(small, corners, (5, 5), (-1, -1), self._subpix_crit)
                    corners_full = corners * 2.0
                    objpoints.append(self._objp.copy())
                    imgpoints.append(corners_full)
                    sampled += 1

            cap.release()
        finally:
            os.unlink(tmp_path)

        print(f"calibrate: {frame_idx} frames read, {sampled} valid chessboard captures")

        if sampled < 5:
            raise RuntimeError(
                f"Not enough valid chessboard frames: {sampled}. "
                "Move the board to more angles."
            )

        rms, K, D, _, _ = cv2.calibrateCamera(
            objpoints, imgpoints, image_size, None, None,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_MAX_ITER, 30, 1e-6),
        )

        result = {
            "rms_reprojection_error": float(rms),
            "camera_matrix": {
                "fx": float(K[0, 0]), "fy": float(K[1, 1]),
                "cx": float(K[0, 2]), "cy": float(K[1, 2]),
            },
            "camera_matrix_3x3": K.tolist(),
            "dist_coeffs": {
                "k1": float(D[0, 0]), "k2": float(D[0, 1]),
                "p1": float(D[0, 2]), "p2": float(D[0, 3]),
                "k3": float(D[0, 4]) if D.shape[1] > 4 else 0.0,
            },
            "dist_coeffs_array": D.flatten().tolist(),
            "image_size": {"width": image_size[0], "height": image_size[1]},
            "num_frames": sampled,
        }

        with open("intrinsics.json", "w") as f:
            json.dump(result, f, indent=2)
        np.savez("intrinsics.npz", camera_matrix=K, dist_coeffs=D)
        print(f"saved intrinsics.json  RMS={rms:.4f}")

        return result