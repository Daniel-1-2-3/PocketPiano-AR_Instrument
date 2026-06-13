import { useEffect, useRef, useState } from "react";

export default function CameraCalibration() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const [cvReady, setCvReady] = useState(false);
  const [detected, setDetected] = useState(false);
  const [captures, setCaptures] = useState(0);
  const [cameraMatrix, setCameraMatrix] = useState(null);
  const [distCoeffs, setDistCoeffs] = useState(null);

  // If board has 9 x 6 SQUARES, OpenCV sees 8 x 5 INNER CORNERS
  const CHESSBOARD_COLS = 8;
  const CHESSBOARD_ROWS = 5;
  const SQUARE_SIZE_MM = 10;
  const NUM_CAPTURES_NEEDED = 20;

  const objectPointsRef = useRef([]);
  const imagePointsRef = useRef([]);
  const lastCornersRef = useRef(null);
  const lastGraySizeRef = useRef(null);

  useEffect(() => {
    const checkCv = setInterval(() => {
      if (window.cv && window.cv.Mat) {
        clearInterval(checkCv);
        window.cv.onRuntimeInitialized = () => {
          setCvReady(true);
        };

        if (window.cv.getBuildInformation) {
          setCvReady(true);
        }
      }
    }, 100);

    return () => clearInterval(checkCv);
  }, []);

  useEffect(() => {
    async function startCamera() {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });

      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }

    startCamera();

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    if (!cvReady) return;

    const cv = window.cv;
    let animationId;

    function processFrame() {
      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (!video || !canvas || video.videoWidth === 0) {
        animationId = requestAnimationFrame(processFrame);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const src = cv.imread(canvas);
      const gray = new cv.Mat();

      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      const patternSize = new cv.Size(CHESSBOARD_COLS, CHESSBOARD_ROWS);
      const corners = new cv.Mat();

      const found = cv.findChessboardCorners(gray, patternSize, corners);

      setDetected(found);

      if (found) {
        const criteria = new cv.TermCriteria(
          cv.TermCriteria_EPS + cv.TermCriteria_MAX_ITER,
          30,
          0.001
        );

        cv.cornerSubPix(
          gray,
          corners,
          new cv.Size(11, 11),
          new cv.Size(-1, -1),
          criteria
        );

        cv.drawChessboardCorners(src, patternSize, corners, found);
        cv.imshow(canvas, src);

        if (lastCornersRef.current) {
          lastCornersRef.current.delete();
        }

        lastCornersRef.current = corners.clone();
        lastGraySizeRef.current = gray.size();
      } else {
        cv.imshow(canvas, src);
      }

      src.delete();
      gray.delete();
      corners.delete();

      animationId = requestAnimationFrame(processFrame);
    }

    processFrame();

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [cvReady]);

  function createObjectPoints() {
    const cv = window.cv;

    const objp = new cv.Mat(
      CHESSBOARD_COLS * CHESSBOARD_ROWS,
      1,
      cv.CV_32FC3
    );

    for (let row = 0; row < CHESSBOARD_ROWS; row++) {
      for (let col = 0; col < CHESSBOARD_COLS; col++) {
        const i = row * CHESSBOARD_COLS + col;

        objp.data32F[i * 3] = col * SQUARE_SIZE_MM;
        objp.data32F[i * 3 + 1] = row * SQUARE_SIZE_MM;
        objp.data32F[i * 3 + 2] = 0;
      }
    }

    return objp;
  }

  function captureFrame() {
    if (!detected || !lastCornersRef.current) {
      alert("No chessboard detected.");
      return;
    }

    const objp = createObjectPoints();
    const corners = lastCornersRef.current.clone();

    objectPointsRef.current.push(objp);
    imagePointsRef.current.push(corners);

    setCaptures(objectPointsRef.current.length);
  }

  function calibrateCamera() {
    const cv = window.cv;

    if (objectPointsRef.current.length < 10) {
      alert("Need at least 10 good captures.");
      return;
    }

    const objectPoints = new cv.MatVector();
    const imagePoints = new cv.MatVector();

    objectPointsRef.current.forEach((p) => objectPoints.push_back(p));
    imagePointsRef.current.forEach((p) => imagePoints.push_back(p));

    const cameraMat = new cv.Mat();
    const distMat = new cv.Mat();
    const rvecs = new cv.MatVector();
    const tvecs = new cv.MatVector();

    const imageSize = lastGraySizeRef.current;

    const reprojectionError = cv.calibrateCamera(
      objectPoints,
      imagePoints,
      imageSize,
      cameraMat,
      distMat,
      rvecs,
      tvecs
    );

    console.log("Reprojection error:", reprojectionError);
    console.log("Camera Matrix:", cameraMat.data64F);
    console.log("Distortion Coefficients:", distMat.data64F);

    setCameraMatrix(Array.from(cameraMat.data64F));
    setDistCoeffs(Array.from(distMat.data64F));

    objectPoints.delete();
    imagePoints.delete();
    cameraMat.delete();
    distMat.delete();
    rvecs.delete();
    tvecs.delete();
  }

  return (
    <div>
      <h2>Live Chessboard Camera Calibration</h2>

      {!cvReady && <p>Loading OpenCV.js...</p>}

      <video ref={videoRef} style={{ display: "none" }} />

      <canvas
        ref={canvasRef}
        style={{
          width: "640px",
          maxWidth: "100%",
          border: "1px solid black",
        }}
      />

      <p>
        Status:{" "}
        <strong style={{ color: detected ? "green" : "red" }}>
          {detected ? "Chessboard detected" : "No chessboard"}
        </strong>
      </p>

      <p>
        Captured: {captures}/{NUM_CAPTURES_NEEDED}
      </p>

      <button onClick={captureFrame} disabled={!detected}>
        Capture Frame
      </button>

      <button onClick={calibrateCamera} disabled={captures < 10}>
        Calibrate
      </button>

      {cameraMatrix && (
        <div>
          <h3>Camera Matrix</h3>
          <pre>{JSON.stringify(cameraMatrix, null, 2)}</pre>

          <h3>Distortion Coefficients</h3>
          <pre>{JSON.stringify(distCoeffs, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}