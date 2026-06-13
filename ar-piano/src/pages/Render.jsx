import { useEffect, useRef, useState } from "react";
import Webcam from "react-webcam";

const WS_URL      = "ws://172.20.10.4:8000/ws";
const SEND_WIDTH  = 320;
const SEND_HEIGHT = 240;
const JPEG_Q      = 0.6;

export default function Render() {
  const webcamRef  = useRef(null);
  const overlayRef = useRef(null);
  const wsRef      = useRef(null);
  const waitingRef = useRef(false);
  const sendTimeRef = useRef(0);
  const rafRef     = useRef(null);
  const offRef     = useRef(null);

  const [ping,      setPing]      = useState(null);
  const [connected, setConnected] = useState(false);

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
        setPing(Math.round(performance.now() - sendTimeRef.current));
        waitingRef.current = false;

        const msg = JSON.parse(e.data);
        if (msg.type !== "status") return;

        const canvas = overlayRef.current;
        const webcam = webcamRef.current;
        if (!canvas || !webcam?.video) return;

        const video = webcam.video;
        const rect  = video.getBoundingClientRect();
        const dispW = rect.width;
        const dispH = rect.height;

        canvas.width  = Math.round(dispW);
        canvas.height = Math.round(dispH);

        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!msg.found || !msg.marker) return;

        const natW      = video.videoWidth;
        const natH      = video.videoHeight;
        const scale     = Math.max(dispW / natW, dispH / natH);
        const renderedW = natW * scale;
        const renderedH = natH * scale;
        const offsetX   = (dispW - renderedW) / 2;
        const offsetY   = (dispH - renderedH) / 2;

        const sx = renderedW / SEND_WIDTH;
        const sy = renderedH / SEND_HEIGHT;

        const toDispX = (x) => dispW - (x * sx + offsetX);
        const toDispY = (y) => y * sy + offsetY;

        const dc = msg.marker.corners.map(([x, y]) => [toDispX(x), toDispY(y)]);

        // corner dots
        ctx.fillStyle = "rgba(0,255,80,0.9)";
        for (const [x, y] of dc) {
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fill();
        }

        // bounding box + id
        if (msg.bbox) {
          const { x1, y1, x2, y2 } = msg.bbox;
          ctx.strokeStyle = "rgba(0,255,80,0.5)";
          ctx.lineWidth   = 1.5;
          ctx.strokeRect(toDispX(x2), toDispY(y1), (x2 - x1) * sx, (y2 - y1) * sy);
          ctx.font      = "bold 13px monospace";
          ctx.fillStyle = "rgba(0,255,80,0.9)";
          ctx.fillText(`id:${msg.marker.id}`, toDispX(x2), toDispY(y1) - 6);
        }

        // blue plane — extend from top edge away from camera
        const sorted = [...dc].sort((a, b) => b[1] - a[1]);
        const bot = sorted.slice(0, 2).sort((a, b) => a[0] - b[0]); // [bl, br]
        const top = sorted.slice(2, 4).sort((a, b) => a[0] - b[0]); // [tl, tr]
        const [tl, tr] = top;
        const [bl, br] = bot;

        // side vectors from bottom to top of tag (reversed)
        const lDx = tl[0] - bl[0],  lDy = tl[1] - bl[1];
        const rDx = tr[0] - br[0],  rDy = tr[1] - br[1];

        // extend top edge by one more side-vector (away from camera)
        const vTL = [tl[0] + lDx, tl[1] + lDy];
        const vTR = [tr[0] + rDx, tr[1] + rDy];

        ctx.beginPath();
        ctx.moveTo(tl[0],   tl[1]);
        ctx.lineTo(tr[0],   tr[1]);
        ctx.lineTo(vTR[0], vTR[1]);
        ctx.lineTo(vTL[0], vTL[1]);
        ctx.closePath();
        ctx.strokeStyle = "rgba(0,180,255,0.9)";
        ctx.lineWidth   = 2.5;
        ctx.stroke();
        ctx.fillStyle   = "rgba(0,180,255,0.15)";
        ctx.fill();
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

  useEffect(() => {
    const off  = document.createElement("canvas");
    off.width  = SEND_WIDTH;
    off.height = SEND_HEIGHT;
    offRef.current = off;
    const offCtx = off.getContext("2d", { alpha: false });

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);

      const ws     = wsRef.current;
      const webcam = webcamRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (waitingRef.current) return;
      if (!webcam?.video) return;

      const video = webcam.video;
      if (video.readyState < 2) return;

      offCtx.drawImage(video, 0, 0, SEND_WIDTH, SEND_HEIGHT);
      off.toBlob((blob) => {
        if (!blob) return;
        blob.arrayBuffer().then((buf) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          sendTimeRef.current = performance.now();
          waitingRef.current  = true;
          ws.send(buf);
        });
      }, "image/jpeg", JPEG_Q);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden" }}>
      <Webcam
        ref={webcamRef}
        audio={false}
        mirrored={true}
        videoConstraints={{ facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
      />
      <canvas
        ref={overlayRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      />
      <span style={{
        position: "absolute", top: 16, left: 16,
        fontFamily: "monospace", fontSize: 12,
        color: "rgba(255,255,255,0.6)",
        background: "rgba(0,0,0,0.35)",
        padding: "2px 8px", borderRadius: 999,
        pointerEvents: "none",
      }}>
        {connected ? `${ping ?? "–"}ms` : "connecting…"}
      </span>
    </div>
  );
}