import cv2
import numpy as np

# ==========================
# SETTINGS
# ==========================

CAMERA_INDEX = 0

# If your physical board has 9 x 6 squares, inner corners are 8 x 5
CHESSBOARD_SIZE = (8, 5)

# If your board has 9 x 6 INNER CORNERS, use this instead:
# CHESSBOARD_SIZE = (9, 6)

SQUARE_SIZE_MM = 10
NUM_CAPTURES_NEEDED = 20

# ==========================
# OBJECT POINTS
# ==========================

objp = np.zeros((CHESSBOARD_SIZE[0] * CHESSBOARD_SIZE[1], 3), np.float32)
objp[:, :2] = np.mgrid[
    0:CHESSBOARD_SIZE[0],
    0:CHESSBOARD_SIZE[1]
].T.reshape(-1, 2)
objp *= SQUARE_SIZE_MM

object_points = []
image_points = []

criteria = (
    cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER,
    30,
    0.001
)

cap = cv2.VideoCapture(CAMERA_INDEX)

if not cap.isOpened():
    raise RuntimeError("Could not open camera.")

print("Press SPACE to save a detected chessboard frame.")
print("Press C to calibrate once enough frames are saved.")
print("Press Q to quit.")

last_gray = None

while True:
    ret, frame = cap.read()
    if not ret:
        print("Could not read frame.")
        break

    display = frame.copy()
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    last_gray = gray

    found, corners = cv2.findChessboardCorners(gray, CHESSBOARD_SIZE, None)

    if found:
        refined_corners = cv2.cornerSubPix(
            gray,
            corners,
            (11, 11),
            (-1, -1),
            criteria
        )

        cv2.drawChessboardCorners(display, CHESSBOARD_SIZE, refined_corners, found)

        cv2.putText(
            display,
            "Chessboard detected - press SPACE to capture",
            (20, 40),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (0, 255, 0),
            2
        )
    else:
        refined_corners = None
        cv2.putText(
            display,
            "No chessboard detected",
            (20, 40),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (0, 0, 255),
            2
        )

    cv2.putText(
        display,
        f"Captured: {len(object_points)}/{NUM_CAPTURES_NEEDED}",
        (20, 80),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (255, 255, 255),
        2
    )

    cv2.imshow("Live Chessboard Calibration", display)

    key = cv2.waitKey(1) & 0xFF

    if key == ord("q"):
        break

    elif key == ord(" ") and found:
        object_points.append(objp.copy())
        image_points.append(refined_corners.copy())
        print(f"Captured frame {len(object_points)}")

    elif key == ord("c"):
        if len(object_points) < 10:
            print("Need at least 10 good captures before calibration.")
            continue

        ret, camera_matrix, dist_coeffs, rvecs, tvecs = cv2.calibrateCamera(
            object_points,
            image_points,
            last_gray.shape[::-1],
            None,
            None
        )

        print("\nCalibration complete.")
        print("Reprojection error:", ret)

        print("\nCamera Matrix:")
        print(camera_matrix)

        print("\nDistortion Coefficients:")
        print(dist_coeffs)

        np.savez(
            "camera_calibration.npz",
            camera_matrix=camera_matrix,
            dist_coeffs=dist_coeffs,
            rvecs=rvecs,
            tvecs=tvecs
        )

        print("\nSaved to camera_calibration.npz")
        break

cap.release()
cv2.destroyAllWindows()