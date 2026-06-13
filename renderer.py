import cv2
import numpy as np

ARUCO_DICT   = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
ARUCO_PARAMS = cv2.aruco.DetectorParameters()
DETECTOR     = cv2.aruco.ArucoDetector(ARUCO_DICT, ARUCO_PARAMS)

K = np.array([
    [200.0,   0.0, 160.0],
    [  0.0, 200.0, 120.0],
    [  0.0,   0.0,   1.0],
], dtype=np.float64)

DIST = np.zeros((5, 1), dtype=np.float64)

TAG_SIZE = 120.0
h        = TAG_SIZE / 2.0

TAG_OBJ_PTS = np.array([
    [-h, -h, 0],
    [ h, -h, 0],
    [ h,  h, 0],
    [-h,  h, 0],
], dtype=np.float32)


def make_ar_rect(rvec, tvec):
    """
    Compute AR square corners in object space, offset toward the camera
    along the table plane (Z=0 in tag-local space).

    Steps:
      1. Find the direction from the tag center to the camera, in camera space.
      2. Rotate that into tag-local space using the inverse rotation.
      3. Zero out the Z component (flatten onto the table plane).
      4. Normalize and scale by TAG_SIZE to get the offset vector.
      5. Place a TAG_SIZE x TAG_SIZE square flush against the tag's near edge.
    """
    R, _ = cv2.Rodrigues(rvec)          # 3x3 rotation: tag-local → camera
    R_inv = R.T                          # camera → tag-local

    # vector from tag center to camera, in camera space
    toward_cam_cam = -tvec.flatten()

    # rotate into tag-local space
    toward_cam_local = R_inv @ toward_cam_cam

    # flatten onto tag plane (kill Z component)
    toward_cam_local[2] = 0.0

    norm = np.linalg.norm(toward_cam_local)
    if norm < 1e-6:
        return None

    # unit vector in tag-local space pointing toward camera along the table
    d = toward_cam_local / norm

    # offset: move one full tag width from tag edge to square far edge (flush)
    # TAG_SIZE/2 gets us to the tag edge, then TAG_SIZE more for the square
    near_edge  = d * h                        # tag's near edge
    far_edge   = d * (h + TAG_SIZE)           # square's far edge (away from cam)

    # perpendicular direction in tag plane (cross with Z-up)
    perp = np.array([-d[1], d[0], 0.0])      # 90deg rotation in XY plane

    p0 = near_edge + perp * h   # TL  (near-left)
    p1 = near_edge - perp * h   # TR  (near-right)
    p2 = far_edge  - perp * h   # BR  (far-right)
    p3 = far_edge  + perp * h   # BL  (far-left)

    return np.array([p0, p1, p2, p3], dtype=np.float32)


class Renderer:
    def __init__(self):
        self.detections = []
        self.K    = K.copy()
        self.dist = DIST.copy()

    def update_intrinsics(self, result: dict):
        # Keys here MUST match what calibrate.py writes into its result dict:
        #   camera_matrix_3x3  -> full 3x3 K
        #   dist_coeffs_array  -> flat [k1, k2, p1, p2, k3]
        self.K    = np.array(result["camera_matrix_3x3"], dtype=np.float64)
        self.dist = np.array(result["dist_coeffs_array"], dtype=np.float64).reshape(-1, 1)
        print(f"intrinsics updated: fx={self.K[0,0]:.1f} fy={self.K[1,1]:.1f}")

    def process_frame_bgr(self, bgr: np.ndarray):
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        corners, ids, _ = DETECTOR.detectMarkers(gray)

        if ids is None or len(ids) == 0:
            return bgr, False, None, None

        c         = corners[0].reshape(4, 2).astype(np.float32)
        marker_id = int(ids[0][0])

        x1   = float(c[:, 0].min())
        y1   = float(c[:, 1].min())
        x2   = float(c[:, 0].max())
        y2   = float(c[:, 1].max())
        bbox = {"x1": x1, "y1": y1, "x2": x2, "y2": y2}

        img_pts = c.reshape(4, 1, 2)
        ok, rvec, tvec = cv2.solvePnP(
            TAG_OBJ_PTS, img_pts, self.K, self.dist,
            flags=cv2.SOLVEPNP_IPPE_SQUARE,
        )

        ar_rect = None
        if ok:
            ar_obj_pts = make_ar_rect(rvec, tvec)
            if ar_obj_pts is not None:
                proj, _ = cv2.projectPoints(ar_obj_pts, rvec, tvec, self.K, self.dist)
                ar_rect = proj.reshape(4, 2).tolist()

        self.detections.append({"corners": c.tolist(), "id": marker_id})

        return bgr, True, bbox, {
            "corners": c.tolist(),
            "id":      marker_id,
            "ar_rect": ar_rect,
        }

    def frame_count(self):
        return len(self.detections)

    def reset(self):
        self.detections = []