import json

import cv2
import numpy as np

ARUCO_DICT    = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
ARUCO_PARAMS  = cv2.aruco.DetectorParameters()
DETECTOR      = cv2.aruco.ArucoDetector(ARUCO_DICT, ARUCO_PARAMS)


class Calibrator:
    def __init__(self):
        self.detections = []  # list of detected corner arrays for future use

    def process_frame_bgr(self, bgr: np.ndarray):
        """
        Detect ArUco tag. Returns (bgr, found, bbox_or_None)
        bbox: {x, y, w, h} bounding box in pixel coords of the input frame
        also returns corners: [[x,y], ...] of the 4 tag corners
        """
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

        corners, ids, _ = DETECTOR.detectMarkers(gray)

        if ids is None or len(ids) == 0:
            return bgr, False, None, None

        # use first detected marker
        c      = corners[0].reshape(4, 2)
        x1     = float(c[:, 0].min())
        y1     = float(c[:, 1].min())
        x2     = float(c[:, 0].max())
        y2     = float(c[:, 1].max())
        bbox   = {"x1": x1, "y1": y1, "x2": x2, "y2": y2}
        pts    = c.tolist()  # [[x,y], [x,y], [x,y], [x,y]] TL TR BR BL
        marker_id = int(ids[0][0])

        self.detections.append({"corners": pts, "id": marker_id})

        return bgr, True, bbox, {"corners": pts, "id": marker_id}

    def frame_count(self):
        return len(self.detections)

    def reset(self):
        self.detections = []