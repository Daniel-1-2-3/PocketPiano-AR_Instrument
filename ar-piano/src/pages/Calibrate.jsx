import { useEffect, useRef, useState, useCallback } from "react";
import Webcam from "react-webcam";

const WS_URL      = "ws://172.20.10.4:8000/ws";
const SEND_WIDTH  = 320;
const SEND_HEIGHT = 240;
const JPEG_Q      = 0.6;
const FRAME_BUFFER_SIZE = 30; // hold last N frames
const BOARD_COLS  = 8;
const BOARD_ROWS  = 5;

export default function Calibrate() {
  const webcamRef    = useRef(null);
  const overlayRef   = useRef(null);
  const offRef       = useRef(null);
  const wsRef        = useRef(null);
  const waitingRef   = useRef(false);
  const sendTimeRef  = useRef(0);
  const rafRef       = useRef(null);
  const recordingRef = useRef(false);
  const frameIdRef   = useRef(0);
  // ring buffer: id → ImageData of that frame
  const frameBufferRef = useRef(new Map());

  const [connected,   setConnected]   = useState(false);
  const [recording,   setRecording]   = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [frames,      setFrames]      = useState(0);
  const [ping,        setPing]        = useState(null);

  // ── WebSocket ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    let retryTimer = null;

    const connect = () => {
      if (!alive) return;
      const ws = new WebSocket(WS_URL);
      ws.binaryType = "arraybuffer";

      ws.onopen  = () => { if (alive) setConnected(true); };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (!alive) return;
        setConnected(false);
        retryTimer = setTimeout(connect, 1000);
      };

      ws.onmessage = (e) => {
        const rtt = performance.now() - sendTimeRef.current;
        setPing(Math.round(rtt));
        waitingRef.current = false;

        const msg = JSON.parse(e.data);

        if (msg.type === "status") {
          setFrames(msg.frames);

          const canvas  = overlayRef.current;
          if (!canvas) return;

          // get the frame this response corresponds to
          const buf     = frameBufferRef.current;
          const stored  = buf.get(msg.frame_id);

          const W = canvas.width  = SEND_WIDTH;
          const H = canvas.height = SEND_HEIGHT;
          const ctx = canvas.getContext("2d");
          ctx.clearRect(0, 0, W, H);

          // draw the original frame first
          if (stored) {
            ctx.putImageData(stored, 0, 0);
            buf.delete(msg.frame_id);
          }

          // draw corners on top if found
          if (msg.found && msg.corners) {
            const pts = msg.corners;
            ctx.strokeStyle = "#00ff50";
            ctx.lineWidth   = 1.5;
            // rows
            for (let r = 0; r < BOARD_ROWS; r++) {
              ctx.beginPath();
              for (let c = 0; c < BOARD_COLS; c++) {
                const [x, y] = pts[r * BOARD_COLS + c];
                c === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
              }
              ctx.stroke();
            }
            // cols
            for (let c = 0; c < BOARD_COLS; c++) {
              ctx.beginPath();
              for (let r = 0; r < BOARD_ROWS; r++) {
                const [x, y] = pts[r * BOARD_COLS + c];
                r === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
              }
              ctx.stroke();
            }
            // dots
            ctx.fillStyle = "#00ff50";
            for (const [x, y] of pts) {
              ctx.beginPath();
              ctx.arc(x, y, 2.5, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }

        if (msg.type === "calibration_result") {
          const blob = new Blob([JSON.stringify(msg.data, null, 2)], { type: "application/json" });
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement("a");
          a.href = url; a.download = "intrinsics.json"; a.click();
          URL.revokeObjectURL(url);
          setCalibrating(false);
          setFrames(0);
        }

        if (msg.type === "error") {
          alert(msg.message);
          setCalibrating(false);
        }

        if (msg.type === "reset") {
          setFrames(0);
          const canvas = overlayRef.current;
          if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
        }
      };

      wsRef.current = ws;
    };

    connect();
    return () => {
      alive = false;
      clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, []);

  // ── send loop ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const off    = document.createElement("canvas");
    off.width    = SEND_WIDTH;
    off.height   = SEND_HEIGHT;
    offRef.current = off;
    const offCtx = off.getContext("2d", { alpha: false });

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);

      const ws     = wsRef.current;
      const webcam = webcamRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!recordingRef.current) return;
      if (waitingRef.current) return;
      if (!webcam) return;

      const video = webcam.video;
      if (!video || video.readyState < 2) return;

      offCtx.drawImage(video, 0, 0, SEND_WIDTH, SEND_HEIGHT);

      // snapshot this frame's pixels before sending
      const frameId  = frameIdRef.current++;
      const imgData  = offCtx.getImageData(0, 0, SEND_WIDTH, SEND_HEIGHT);

      // keep buffer bounded
      const buf = frameBufferRef.current;
      buf.set(frameId, imgData);
      if (buf.size > FRAME_BUFFER_SIZE) {
        const oldest = buf.keys().next().value;
        buf.delete(oldest);
      }

      off.toBlob((blob) => {
        if (!blob) return;
        blob.arrayBuffer().then((rawBuf) => {
          if (ws.readyState !== WebSocket.OPEN) return;

          // prepend 4-byte frame_id header so server echoes it back
          const header  = new ArrayBuffer(4);
          new DataView(header).setUint32(0, frameId, false);
          const payload = new Uint8Array(4 + rawBuf.byteLength);
          payload.set(new Uint8Array(header), 0);
          payload.set(new Uint8Array(rawBuf), 4);

          sendTimeRef.current = performance.now();
          waitingRef.current  = true;
          ws.send(payload.buffer);
        });
      }, "image/jpeg", JPEG_Q);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const handleButton = useCallback(() => {
    if (calibrating) return;
    if (recording) {
      recordingRef.current = false;
      setRecording(false);
      setCalibrating(true);
      wsRef.current?.send(JSON.stringify({ action: "calibrate" }));
    } else {
      wsRef.current?.send(JSON.stringify({ action: "reset" }));
      frameBufferRef.current.clear();
      recordingRef.current = true;
      setRecording(true);
    }
  }, [recording, calibrating]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden" }}>
      {/* live webcam — always full screen */}
      <Webcam
        ref={webcamRef}
        audio={false}
        videoConstraints={{ facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />

      {/* overlay canvas — matched frame + corners drawn on it */}
      <canvas
        ref={overlayRef}
        style={{
          position: "absolute", inset: 0,
          width: "100%", height: "100%",
          objectFit: "cover",
          pointerEvents: "none",
          display: recording ? "block" : "none",
        }}
      />

      {/* calibrating label */}
      {calibrating && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          pointerEvents: "none",
        }}>
          <span style={{
            fontFamily: "monospace", fontSize: 18,
            color: "rgba(255,255,255,0.9)",
            background: "rgba(0,0,0,0.5)",
            padding: "10px 24px", borderRadius: 999,
          }}>
            Calibrating…
          </span>
        </div>
      )}

      {/* top-left HUD */}
      <div style={{
        position: "absolute", top: 20, left: 20,
        display: "flex", flexDirection: "column", gap: 4,
        pointerEvents: "none",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{
            width: 7, height: 7, borderRadius: "50%",
            background: connected ? "#4ade80" : "#f87171",
          }} />
          <span style={pill}>{connected ? `${ping ?? "–"}ms` : "offline"}</span>
        </div>
        {recording && frames > 0 && (
          <span style={pill}>{frames} frames</span>
        )}
      </div>

      {/* bottom bar */}
      {!calibrating && (
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          height: 120,
          background: "rgba(0,0,0,0.4)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          paddingBottom: 12,
        }}>
          <button onClick={handleButton} style={{
            width: 68, height: 68,
            borderRadius: "50%",
            border: recording ? "3px solid rgba(220,50,50,0.6)" : "3px solid rgba(255,255,255,0.5)",
            background: recording ? "rgba(220,50,50,0.3)" : "rgba(255,255,255,0.95)",
            cursor: "pointer", outline: "none",
            boxShadow: recording ? "0 0 0 6px rgba(220,50,50,0.2)" : "none",
            transition: "all 0.15s",
          }} />
        </div>
      )}
    </div>
  );
}

const pill = {
  fontFamily: "monospace", fontSize: 12,
  color: "rgba(255,255,255,0.8)",
  background: "rgba(0,0,0,0.4)",
  padding: "2px 8px", borderRadius: 999,
};