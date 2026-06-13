import { useEffect, useRef, useState } from "react";
import Webcam from "react-webcam";

// change this to your server URL
const WS_URL = "https://6wpq8nps-8000.use.devtunnels.ms/";

const SEND_WIDTH  = 320;
const SEND_HEIGHT = 240;
const JPEG_QUALITY = 0.5;

export default function App() {
  const webcamRef    = useRef(null);
  const canvasRef    = useRef(null);  // shows the returned processed frame
  const wsRef        = useRef(null);
  const waitingRef   = useRef(false); // true while waiting for server response
  const sendTimeRef  = useRef(0);
  const rafRef       = useRef(null);

  const [ping,      setPing]      = useState(null);
  const [connected, setConnected] = useState(false);

  // ── WebSocket ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const connect = () => {
      const ws = new WebSocket(WS_URL);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        console.log("ws connected");
        setConnected(true);
      };

      ws.onmessage = (e) => {
        const rtt = performance.now() - sendTimeRef.current;
        setPing(Math.round(rtt));

        // decode returned JPEG into an ImageBitmap and draw onto canvas
        const blob = new Blob([e.data], { type: "image/jpeg" });
        createImageBitmap(blob).then((bmp) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext("2d");
          canvas.width  = bmp.width;
          canvas.height = bmp.height;
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
        });

        waitingRef.current = false; // ready to send next frame
      };

      ws.onerror = () => {
        setConnected(false);
      };

      ws.onclose = () => {
        setConnected(false);
        // reconnect after 1s
        setTimeout(connect, 1000);
      };

      wsRef.current = ws;
    };

    connect();
    return () => wsRef.current?.close();
  }, []);

  // ── capture + send loop ─────────────────────────────────────────────────────
  useEffect(() => {
    const off = document.createElement("canvas");
    off.width  = SEND_WIDTH;
    off.height = SEND_HEIGHT;
    const offCtx = off.getContext("2d");

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);

      const ws     = wsRef.current;
      const webcam = webcamRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (waitingRef.current) return; // don't send until last response arrives
      if (!webcam) return;

      const video = webcam.video;
      if (!video || video.readyState < 2) return;

      // draw scaled-down frame
      offCtx.drawImage(video, 0, 0, SEND_WIDTH, SEND_HEIGHT);

      // compress to JPEG blob and send as binary
      off.toBlob((blob) => {
        if (!blob) return;
        blob.arrayBuffer().then((buf) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          sendTimeRef.current = performance.now();
          waitingRef.current  = true;
          ws.send(buf);
        });
      }, "image/jpeg", JPEG_QUALITY);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
      {/* live webcam feed (muted, background) */}
      <Webcam
        ref={webcamRef}
        audio={false}
        videoConstraints={{ width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "environment" }}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.3 }}
      />

      {/* processed frame returned from server */}
      <canvas
        ref={canvasRef}
        style={{ position: "relative", zIndex: 1, width: "90vw", maxWidth: 480, borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)" }}
      />

      {/* stats */}
      <div style={{ position: "relative", zIndex: 1, fontFamily: "monospace", fontSize: 14, color: "rgba(255,255,255,0.6)", textAlign: "center" }}>
        <div style={{ color: connected ? "#68d391" : "#fc8181" }}>
          {connected ? "connected" : "connecting…"}
        </div>
        {ping !== null && <div>round-trip: {ping}ms</div>}
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>
          {SEND_WIDTH}×{SEND_HEIGHT} · JPEG {Math.round(JPEG_QUALITY * 100)}%
        </div>
      </div>
    </div>
  );
}