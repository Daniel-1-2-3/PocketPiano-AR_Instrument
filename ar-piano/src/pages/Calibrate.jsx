import { useEffect, useRef, useState, useCallback } from "react";
import Webcam from "react-webcam";

const WS_URL = "ws://172.20.10.4:8000/ws";

// video recording settings
const VIDEO_MIME  = "video/webm;codecs=vp8";
const VIDEO_BPS   = 1_000_000; // 1 Mbps — enough quality for chessboard

export default function Calibrate() {
  const webcamRef      = useRef(null);
  const wsRef          = useRef(null);
  const mediaRecRef    = useRef(null);
  const chunksRef      = useRef([]);

  const [connected,  setConnected]  = useState(false);
  const [phase,      setPhase]      = useState("idle"); // idle | recording | sending | calibrating | done
  const [ping,       setPing]       = useState(null);

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
        const msg = JSON.parse(e.data);

        if (msg.type === "calibration_result") {
          // auto-download intrinsics.json
          const blob = new Blob(
            [JSON.stringify(msg.data, null, 2)],
            { type: "application/json" }
          );
          const url = URL.createObjectURL(blob);
          const a   = document.createElement("a");
          a.href = url; a.download = "intrinsics.json"; a.click();
          URL.revokeObjectURL(url);
          setPhase("done");
        }

        if (msg.type === "error") {
          alert(msg.message);
          setPhase("idle");
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

  // ── send video blob to server ──────────────────────────────────────────────
  const sendVideo = useCallback((blob) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    setPhase("sending");

    blob.arrayBuffer().then((buf) => {
      // prepend 4-byte type tag so server knows this is a video
      const tagged = new Uint8Array(4 + buf.byteLength);
      tagged.set([86, 73, 68, 0]); // "VID\0"
      tagged.set(new Uint8Array(buf), 4);

      ws.send(tagged.buffer);
      setPhase("calibrating");
    });
  }, []);

  // ── start recording ────────────────────────────────────────────────────────
  const startRecording = useCallback(() => {
    const webcam = webcamRef.current;
    if (!webcam?.video) return;

    const stream = webcam.video.srcObject;
    if (!stream) return;

    chunksRef.current = [];
    const rec = new MediaRecorder(stream, {
      mimeType:        VIDEO_MIME,
      videoBitsPerSecond: VIDEO_BPS,
    });

    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: VIDEO_MIME });
      console.log(`video blob: ${(blob.size / 1024).toFixed(0)}KB`);
      sendVideo(blob);
    };

    rec.start(100); // collect chunks every 100ms
    mediaRecRef.current = rec;
    setPhase("recording");
  }, [sendVideo]);

  // ── stop recording ─────────────────────────────────────────────────────────
  const stopRecording = useCallback(() => {
    mediaRecRef.current?.stop();
  }, []);

  const handleButton = useCallback(() => {
    if (phase === "idle" || phase === "done") {
      startRecording();
    } else if (phase === "recording") {
      stopRecording();
    }
  }, [phase, startRecording, stopRecording]);

  const btnStyle = {
    width: 68, height: 68,
    borderRadius: "50%",
    border: phase === "recording"
      ? "3px solid rgba(220,50,50,0.6)"
      : "3px solid rgba(255,255,255,0.5)",
    background: phase === "recording"
      ? "rgba(220,50,50,0.3)"
      : "rgba(255,255,255,0.95)",
    cursor: "pointer", outline: "none",
    boxShadow: phase === "recording" ? "0 0 0 6px rgba(220,50,50,0.2)" : "none",
    transition: "all 0.15s",
  };

  const statusLabel = {
    idle:        null,
    recording:   null,
    sending:     "Sending…",
    calibrating: "Calibrating…",
    done:        "Done",
  }[phase];

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden" }}>
      <Webcam
        ref={webcamRef}
        mirrored={true}
        audio={false}
        videoConstraints={{ facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />

      {/* centre status label */}
      {statusLabel && (
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
            {statusLabel}
          </span>
        </div>
      )}

      {/* top-left ping */}
      <div style={{
        position: "absolute", top: 20, left: 20,
        display: "flex", alignItems: "center", gap: 6,
        pointerEvents: "none",
      }}>
        <div style={{
          width: 7, height: 7, borderRadius: "50%",
          background: connected ? "#4ade80" : "#f87171",
        }} />
        <span style={pill}>{connected ? "connected" : "offline"}</span>
      </div>

      {/* bottom bar — only show button when idle/recording/done */}
      {(phase === "idle" || phase === "recording" || phase === "done") && (
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          height: 120,
          background: "rgba(0,0,0,0.4)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          paddingBottom: 12,
        }}>
          <button onClick={handleButton} disabled={!connected} style={btnStyle} />
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