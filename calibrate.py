import json

import cv2
import numpy as np

CHESSBOARD_SIZE = (8, 5)   # inner corners (cols, rows)
SQUARE_SIZE_MM  = 10.0


class Calibrator:
    def __init__(self):
        self.objpoints  = []
        self.imgpoints  = []
        self.image_size = None
        self.last_found = False
        self._subpix_crit = (
            cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001
        )

        objp = np.zeros(
            (CHESSBOARD_SIZE[0] * CHESSBOARD_SIZE[1], 3), np.float32
        )
        objp[:, :2] = (
            np.mgrid[0:CHESSBOARD_SIZE[0], 0:CHESSBOARD_SIZE[1]]
            .T.reshape(-1, 2)
        )
        objp *= SQUARE_SIZE_MM
        self._objp = objp

    def process_frame_bgr(self, bgr: np.ndarray):
        """
        Detect chessboard. Saves frame if found.
        Returns (bgr, found, corners_list_or_None)
        corners_list: [[x,y], ...] in full-res pixel coords
        """
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        self.image_size = (bgr.shape[1], bgr.shape[0])

        found, corners = cv2.findChessboardCorners(
            gray,
            CHESSBOARD_SIZE,
            cv2.CALIB_CB_ADAPTIVE_THRESH | cv2.CALIB_CB_NORMALIZE_IMAGE,
        )

        corners_out = None
        if found:
            corners = cv2.cornerSubPix(
                gray, corners, (11, 11), (-1, -1), self._subpix_crit
            )
            self.objpoints.append(self._objp.copy())
            self.imgpoints.append(corners)
            corners_out = corners.reshape(-1, 2).tolist()

        self.last_found = bool(found)
        return bgr, bool(found), corners_out

    def frame_count(self):
        return len(self.objpoints)

    def reset(self):
        self.objpoints  = []
        self.imgpoints  = []
        self.image_size = None
        self.last_found = False

    def calibrate(self):
        n = len(self.objpoints)
        if n < 5:
            raise RuntimeError(f"Need at least 5 valid frames, have {n}")

        rms, K, D, rvecs, tvecs = cv2.calibrateCamera(
            self.objpoints,
            self.imgpoints,
            self.image_size,
            None,
            None,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_MAX_ITER, 30, 1e-6),
        )

        result = {
            "rms_reprojection_error": float(rms),
            "camera_matrix": {
                "fx": float(K[0, 0]),
                "fy": float(K[1, 1]),
                "cx": float(K[0, 2]),
                "cy": float(K[1, 2]),
            },
            "camera_matrix_3x3": K.tolist(),
            "dist_coeffs": {
                "k1": float(D[0, 0]),
                "k2": float(D[0, 1]),
                "p1": float(D[0, 2]),
                "p2": float(D[0, 3]),
                "k3": float(D[0, 4]) if D.shape[1] > 4 else 0.0,
            },
            "dist_coeffs_array": D.flatten().tolist(),
            "image_size": {
                "width":  int(self.image_size[0]),
                "height": int(self.image_size[1]),
            },
            "num_frames": n,
        }

        # also save locally on the server
        with open("intrinsics.json", "w") as f:
            json.dump(result, f, indent=2)
        np.savez(
            "intrinsics.npz",
            camera_matrix=K,
            dist_coeffs=D,
        )
        print("saved intrinsics.json and intrinsics.npz")

        return result