import { useEffect, useRef, useState, useCallback } from "react";
import Webcam from "react-webcam";

const WS_URL      = "ws://172.20.10.4:8000/ws";
const SEND_WIDTH  = 320;
const SEND_HEIGHT = 240;
const JPEG_Q      = 0.6;

export default function Calibrate() {
  const webcamRef    = useRef(null);
  const overlayRef   = useRef(null);
  const offRef       = useRef(null);
  const wsRef        = useRef(null);
  const waitingRef   = useRef(false);
  const sendTimeRef  = useRef(0);
  const rafRef       = useRef(null);
  const recordingRef = useRef(false);

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
          setFrames(msg.found ? frames + 1 : frames);

          const canvas = overlayRef.current;
          const webcam = webcamRef.current;
          if (!canvas || !webcam?.video) return;
          const video = webcam.video;
          const rect  = video.getBoundingClientRect();
          canvas.width  = Math.round(rect.width);
          canvas.height = Math.round(rect.height);

          const sx = canvas.width  / SEND_WIDTH;
          const sy = canvas.height / SEND_HEIGHT;

          const ctx = canvas.getContext("2d");
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          if (msg.found && msg.bbox && msg.marker) {
            const { x1, y1, x2, y2 } = msg.bbox;

            // bounding box
            ctx.strokeStyle = "#00ff50";
            ctx.lineWidth   = 2;
            ctx.strokeRect(x1 * sx, y1 * sy, (x2 - x1) * sx, (y2 - y1) * sy);

            // corner dots
            ctx.fillStyle = "#00ff50";
            for (const [x, y] of msg.marker.corners) {
              ctx.beginPath();
              ctx.arc(x * sx, y * sy, 4, 0, Math.PI * 2);
              ctx.fill();
            }

            // marker id label
            ctx.font      = "bold 14px monospace";
            ctx.fillStyle = "#00ff50";
            ctx.fillText(`id:${msg.marker.id}`, x1 * sx, y1 * sy - 6);
          }

          waitingRef.current = false;
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

      off.toBlob((blob) => {
        if (!blob) return;
        blob.arrayBuffer().then((rawBuf) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          sendTimeRef.current = performance.now();
          waitingRef.current  = true;
          ws.send(rawBuf);
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