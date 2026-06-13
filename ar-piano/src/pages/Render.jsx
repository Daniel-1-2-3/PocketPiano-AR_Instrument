import { useEffect, useRef, useState } from "react";
import Webcam from "react-webcam";

// ── paste your ngrok URL here each session ────────────────────────────────────
// e.g. "wss://abc123.ngrok-free.app/ws"
const WS_URL = "wss://7182-129-97-124-217.ngrok-free.app/ws";

// 16:9 at 240p — matches phone camera ratio so server decodes undistorted
const SEND_WIDTH  = 426;
const SEND_HEIGHT = 240;
const JPEG_Q      = 0.5;   // ArUco only needs edges, not colour fidelity

export default function Render() {
  const webcamRef   = useRef(null);
  const overlayRef  = useRef(null);
  const wsRef       = useRef(null);
  const waitingRef  = useRef(false);
  const sendTimeRef = useRef(0);
  const rafRef      = useRef(null);
  const offRef      = useRef(null);
  const lastMsgRef  = useRef(null);

  const [ping,      setPing]      = useState(null);
  const [connected, setConnected] = useState(false);

  // ── WebSocket ───────────────────────────────────────────────────────────────
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
        retryTimer = setTimeout(connect, 2000);
      };
      ws.onmessage = (e) => {
        setPing(Math.round(performance.now() - sendTimeRef.current));
        waitingRef.current = false;
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "status") lastMsgRef.current = msg;
        } catch (_) {}
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

  // ── render loop ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const off  = document.createElement("canvas");
    off.width  = SEND_WIDTH;
    off.height = SEND_HEIGHT;
    offRef.current = off;
    const offCtx = off.getContext("2d", { alpha: false });

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);

      const webcam = webcamRef.current;
      if (!webcam?.video) return;
      const video = webcam.video;
      if (video.readyState < 2) return;

      // ── send frame ──────────────────────────────────────────────────────────
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN && !waitingRef.current) {
        offCtx.drawImage(video, 0, 0, SEND_WIDTH, SEND_HEIGHT);
        off.toBlob((blob) => {
          if (!blob || ws.readyState !== WebSocket.OPEN) return;
          blob.arrayBuffer().then((buf) => {
            sendTimeRef.current = performance.now();
            waitingRef.current  = true;
            ws.send(buf);
          });
        }, "image/jpeg", JPEG_Q);
      }

      // ── draw overlay ────────────────────────────────────────────────────────
      const canvas = overlayRef.current;
      if (!canvas) return;

      const rect  = video.getBoundingClientRect();
      const dispW = rect.width;
      const dispH = rect.height;
      if (canvas.width !== Math.round(dispW))  canvas.width  = Math.round(dispW);
      if (canvas.height !== Math.round(dispH)) canvas.height = Math.round(dispH);

      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const natW = video.videoWidth;
      const natH = video.videoHeight;
      if (!natW || !natH) return;

      // cover scaling — matches objectFit:cover on the <video>
      const scale     = Math.max(dispW / natW, dispH / natH);
      const renderedW = natW * scale;
      const renderedH = natH * scale;
      const offsetX   = (dispW - renderedW) / 2;
      const offsetY   = (dispH - renderedH) / 2;

      // map from SEND coords → display coords
      // x is mirrored because <Webcam mirrored={true}>
      const sx = renderedW / SEND_WIDTH;
      const sy = renderedH / SEND_HEIGHT;
      const toDispX = (x) => dispW - (x * sx + offsetX);
      const toDispY = (y) => y * sy + offsetY;

      const msg = lastMsgRef.current;
      if (!msg?.found || !msg.marker) return;

      // corner dots
      const dc = msg.marker.corners.map(([x, y]) => [toDispX(x), toDispY(y)]);
      ctx.fillStyle = "rgba(0,255,80,0.9)";
      for (const [x, y] of dc) {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }

      // bounding box + id label
      if (msg.bbox) {
        const { x1, y1, x2, y2 } = msg.bbox;
        ctx.strokeStyle = "rgba(0,255,80,0.5)";
        ctx.lineWidth   = 1.5;
        ctx.strokeRect(toDispX(x2), toDispY(y1), (x2 - x1) * sx, (y2 - y1) * sy);
        ctx.font      = "bold 13px monospace";
        ctx.fillStyle = "rgba(0,255,80,0.9)";
        ctx.fillText(`id:${msg.marker.id}`, toDispX(x2), toDispY(y1) - 6);
      }

      // piano keyboard — drawn onto the same footprint as before
      // (same size as the tag, phone → keyboard → tag).
      // bot = the two corners nearest the viewer (largest screen-y),
      // top = the two corners nearest the tag's far edge.
      // Extend bot outward by the top→bot edge vectors to get a same-size
      // quad sitting between the viewer and the tag — this becomes the
      // keyboard's footprint.
      const sorted = [...dc].sort((a, b) => b[1] - a[1]);
      const bot = sorted.slice(0, 2).sort((a, b) => a[0] - b[0]);
      const top = sorted.slice(2, 4).sort((a, b) => a[0] - b[0]);
      const [tl, tr] = top;
      const [bl, br] = bot;
      const lDx = bl[0] - tl[0], lDy = bl[1] - tl[1];
      const rDx = br[0] - tr[0], rDy = br[1] - tr[1];
      const vBL = [bl[0] + lDx, bl[1] + lDy];
      const vBR = [br[0] + rDx, br[1] + rDy];

      // bilinear map of the keyboard quad: u in [0,1] left→right,
      // v in [0,1] near edge (phone side) → far edge (tag side)
      const lerpPt = (u, v) => [
        (1 - u) * (1 - v) * bl[0] + u * (1 - v) * br[0] + (1 - u) * v * vBL[0] + u * v * vBR[0],
        (1 - u) * (1 - v) * bl[1] + u * (1 - v) * br[1] + (1 - u) * v * vBL[1] + u * v * vBR[1],
      ];
      const quadPath = (p1, p2, p3, p4) => {
        ctx.beginPath();
        ctx.moveTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]);
        ctx.lineTo(p3[0], p3[1]);
        ctx.lineTo(p4[0], p4[1]);
        ctx.closePath();
      };

      const NUM_WHITE   = 7;                // one octave: C D E F G A B
      const BLACK_AFTER = [0, 1, 3, 4, 5];  // white-key index followed by a black key
      const BLACK_W     = 0.55;             // black key width, fraction of one white key
      const BLACK_DEPTH = 0.62;             // how far black keys extend from the far edge

      // white keys
      for (let i = 0; i < NUM_WHITE; i++) {
        const u0 = i / NUM_WHITE, u1 = (i + 1) / NUM_WHITE;
        quadPath(lerpPt(u0, 0), lerpPt(u1, 0), lerpPt(u1, 1), lerpPt(u0, 1));
        ctx.fillStyle   = "rgba(255,255,255,0.85)";
        ctx.fill();
        ctx.strokeStyle = "rgba(0,180,255,0.7)";
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      }

      // outer border
      quadPath(bl, br, vBR, vBL);
      ctx.strokeStyle = "rgba(0,180,255,0.9)";
      ctx.lineWidth   = 2.5;
      ctx.stroke();

      // black keys — sit toward the far edge (tag side), on top of white keys
      for (const i of BLACK_AFTER) {
        const centerU = (i + 1) / NUM_WHITE;
        const halfW   = (BLACK_W / NUM_WHITE) / 2;
        const u0 = centerU - halfW, u1 = centerU + halfW;
        const v0 = 1 - BLACK_DEPTH;
        quadPath(lerpPt(u0, v0), lerpPt(u1, v0), lerpPt(u1, 1), lerpPt(u0, 1));
        ctx.fillStyle = "rgba(15,15,20,0.95)";
        ctx.fill();
      }

      // note labels on the exposed front strip of each white key
      ctx.save();
      ctx.font         = "11px monospace";
      ctx.fillStyle    = "rgba(0,0,0,0.55)";
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      const NOTE_NAMES = ["C", "D", "E", "F", "G", "A", "B"];
      for (let i = 0; i < NUM_WHITE; i++) {
        const p = lerpPt((i + 0.5) / NUM_WHITE, 0.18);
        ctx.fillText(NOTE_NAMES[i], p[0], p[1]);
      }
      ctx.restore();
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
        videoConstraints={{
          facingMode: "environment",
          width:  { ideal: 1280 },
          height: { ideal: 720 },
          aspectRatio: 16 / 9,
        }}
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