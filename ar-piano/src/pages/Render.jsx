import { useEffect, useRef, useState } from "react";
import Webcam from "react-webcam";

import { KEYBOARD_CONFIG, getWhiteKeyForIndex } from "./keyboardLayout";
import { playNote, unlockAudio } from "./sounds";


// ── WebSocket URL ───────────────────────────────────────────────────────────
// Replace this each ngrok session.
const WS_URL = "wss://0dcf-2620-101-f000-7c2-00-39e.ngrok-free.app/ws";


// ── Camera frame sent to Python ─────────────────────────────────────────────
// Server coordinates are in this SEND_WIDTH x SEND_HEIGHT image.
const SEND_WIDTH = 426;
const SEND_HEIGHT = 240;
const JPEG_Q = 0.5;


// ── Mirror/orientation controls ─────────────────────────────────────────────
// Start with these false.
// With rear phone camera looking down at a table, mirrored=false is usually right.
// If left/right feels backwards, first try DISPLAY_MIRROR_X = true.
const DISPLAY_MIRROR_X = false;
const DISPLAY_FLIP_Y = false;

// If the keyboard note direction feels wrong but hand skeleton looks right,
// flip only the keyboard.
const KEYBOARD_MIRROR_X = false;

const DEBUG = true;


// ── MediaPipe hand skeleton connections ─────────────────────────────────────

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];


// ── Homography helper ───────────────────────────────────────────────────────
// Maps unit square (0,0),(1,0),(1,1),(0,1) to a marker quad.
// The keyboard extends beyond the tag using the same plane.

function makeHomography(p0, p1, p2, p3) {
  const [x0, y0] = p0;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;

  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;

  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;

  let a;
  let b;
  let c;
  let d;
  let e;
  let f;
  let g;
  let h;

  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    g = 0;
    h = 0;

    a = x1 - x0;
    b = x3 - x0;
    c = x0;

    d = y1 - y0;
    e = y3 - y0;
    f = y0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;

    if (Math.abs(den) < 1e-9) {
      return null;
    }

    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;

    a = x1 - x0 + g * x1;
    b = x3 - x0 + h * x3;
    c = x0;

    d = y1 - y0 + g * y1;
    e = y3 - y0 + h * y3;
    f = y0;
  }

  return { a, b, c, d, e, f, g, h };
}


function pointInPolygon(point, polygon) {
  const [px, py] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    const crosses =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;

    if (crosses) {
      inside = !inside;
    }
  }

  return inside;
}


function quadPath(ctx, p0, p1, p2, p3) {
  ctx.beginPath();
  ctx.moveTo(p0[0], p0[1]);
  ctx.lineTo(p1[0], p1[1]);
  ctx.lineTo(p2[0], p2[1]);
  ctx.lineTo(p3[0], p3[1]);
  ctx.closePath();
}


function drawCircle(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}


export default function Render() {
  const webcamRef = useRef(null);
  const overlayRef = useRef(null);
  const wsRef = useRef(null);

  const waitingRef = useRef(false);
  const sendTimeRef = useRef(0);
  const rafRef = useRef(null);

  const offscreenRef = useRef(null);
  const lastMsgRef = useRef(null);

  // Edge detection:
  // Stores finger:key pairs that were pressed last frame.
  const previousPressedRef = useRef(new Set());

  const [ping, setPing] = useState(null);
  const [connected, setConnected] = useState(false);
  const [audioReady, setAudioReady] = useState(false);

  // ── WebSocket ─────────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true;
    let retryTimer = null;

    const connect = () => {
      if (!alive) return;

      const ws = new WebSocket(WS_URL);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        if (alive) setConnected(true);
      };

      ws.onerror = () => {};

      ws.onclose = () => {
        if (!alive) return;

        setConnected(false);
        retryTimer = setTimeout(connect, 2000);
      };

      ws.onmessage = (event) => {
        setPing(Math.round(performance.now() - sendTimeRef.current));
        waitingRef.current = false;

        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "status") {
            lastMsgRef.current = msg;
          } else if (msg.type === "error") {
            console.error("Server error:", msg.message);
          } else if (msg.type === "calibration_result") {
            console.log("Calibration result:", msg.data);
          }
        } catch (error) {
          console.error("Could not parse server message:", error);
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

  // ── Render/send loop ──────────────────────────────────────────────────────

  useEffect(() => {
    const offscreen = document.createElement("canvas");
    offscreen.width = SEND_WIDTH;
    offscreen.height = SEND_HEIGHT;
    offscreenRef.current = offscreen;

    const offCtx = offscreen.getContext("2d", { alpha: false });

    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);

      const webcam = webcamRef.current;
      const video = webcam?.video;

      if (!video || video.readyState < 2) {
        return;
      }

      // Send JPEG frame to Python.
      const ws = wsRef.current;

      if (ws?.readyState === WebSocket.OPEN && !waitingRef.current) {
        waitingRef.current = true;

        offCtx.drawImage(video, 0, 0, SEND_WIDTH, SEND_HEIGHT);

        offscreen.toBlob(
          (blob) => {
            if (!blob || ws.readyState !== WebSocket.OPEN) {
              waitingRef.current = false;
              return;
            }

            blob.arrayBuffer().then((buf) => {
              sendTimeRef.current = performance.now();
              ws.send(buf);
            }).catch(() => {
              waitingRef.current = false;
            });
          },
          "image/jpeg",
          JPEG_Q,
        );
      }

      const canvas = overlayRef.current;

      if (!canvas) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const cssW = Math.round(rect.width);
      const cssH = Math.round(rect.height);

      if (canvas.width !== cssW) canvas.width = cssW;
      if (canvas.height !== cssH) canvas.height = cssH;

      const ctx = canvas.getContext("2d");

      // Main AR scene background.
      ctx.fillStyle = "#c8f7c5";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const msg = lastMsgRef.current;

      // Map Python SEND coords → visible canvas coords.
      const scale = Math.max(
        canvas.width / SEND_WIDTH,
        canvas.height / SEND_HEIGHT,
      );

      const renderedW = SEND_WIDTH * scale;
      const renderedH = SEND_HEIGHT * scale;

      const offsetX = (canvas.width - renderedW) / 2;
      const offsetY = (canvas.height - renderedH) / 2;

      const toCanvas = (x, y) => {
        let cx = x * scale + offsetX;
        let cy = y * scale + offsetY;

        if (DISPLAY_MIRROR_X) {
          cx = canvas.width - cx;
        }

        if (DISPLAY_FLIP_Y) {
          cy = canvas.height - cy;
        }

        return [cx, cy];
      };

      if (!msg?.found || !msg.marker?.corners) {
        previousPressedRef.current = new Set();

        drawStatus(ctx, {
          connected,
          ping,
          msg,
          audioReady,
          noMarker: true,
        });

        drawHandSkeletonAndLabels(ctx, msg, toCanvas);

        return;
      }

      // Marker corners in visible canvas coords.
      const dc = msg.marker.corners.map(([x, y]) => toCanvas(x, y));

      drawMarkerDebug(ctx, msg, dc, toCanvas);

      // ── Keyboard homography ───────────────────────────────────────────────
      // We auto-orient the marker so the piano runs left-right on screen.
      const eA = [dc[1][0] - dc[0][0], dc[1][1] - dc[0][1]];
      const eB = [dc[3][0] - dc[0][0], dc[3][1] - dc[0][1]];

      const horiz = (e) => Math.abs(e[0]) / (Math.hypot(e[0], e[1]) + 1e-9);

      let Q0;
      let Q1;
      let Q2;
      let Q3;

      if (horiz(eA) >= horiz(eB)) {
        [Q0, Q1, Q2, Q3] = [dc[0], dc[1], dc[2], dc[3]];
      } else {
        [Q0, Q1, Q2, Q3] = [dc[0], dc[3], dc[2], dc[1]];
      }

      // Force u increasing toward screen-right.
      if (Q1[0] < Q0[0]) {
        [Q0, Q1, Q2, Q3] = [Q1, Q0, Q3, Q2];
      }

      // Force v increasing toward screen-down.
      if (Q3[1] < Q0[1]) {
        [Q0, Q1, Q2, Q3] = [Q3, Q2, Q1, Q0];
      }

      if (KEYBOARD_MIRROR_X) {
        [Q0, Q1, Q2, Q3] = [Q1, Q0, Q3, Q2];
      }

      const H = makeHomography(Q0, Q1, Q2, Q3);

      if (!H) {
        previousPressedRef.current = new Set();
        return;
      }

      const proj = (u, v) => {
        const ww = H.g * u + H.h * v + 1;

        if (ww <= 1e-3) {
          return null;
        }

        return [
          (H.a * u + H.b * v + H.c) / ww,
          (H.d * u + H.e * v + H.f) / ww,
        ];
      };

      const visibleKeys = buildVisibleWhiteKeys({
        canvas,
        proj,
      });

      const fingerPoints = buildFingerCanvasPoints(msg, toCanvas);

      const hitResult = computePressedKeys({
        visibleKeys,
        fingerPoints,
        fsr: msg.fsr || {},
      });

      triggerSoundEdges(hitResult.currentPressed, previousPressedRef);
      drawKeyboard(ctx, visibleKeys, hitResult);

      // Draw skeleton last so it appears above the green background and piano.
      drawHandSkeletonAndLabels(ctx, msg, toCanvas);

      if (DEBUG) {
        drawKeyboardDebug(ctx, proj, visibleKeys.length);
      }

      drawStatus(ctx, {
        connected,
        ping,
        msg,
        audioReady,
        noMarker: false,
      });
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [connected, ping, audioReady]);

  const handleUnlockAudio = async () => {
    const ok = await unlockAudio();
    setAudioReady(ok);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#c8f7c5",
        overflow: "hidden",
      }}
    >
      {/* 
        Webcam is still active for frame capture, but visually hidden.
        Do NOT use display:none; some browsers pause the video.
      */}
      <Webcam
        ref={webcamRef}
        audio={false}
        mirrored={false}
        videoConstraints={{
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
          aspectRatio: 16 / 9,
        }}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: "none",
        }}
      />

      <canvas
        ref={overlayRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />

      {!audioReady && (
        <button
          onClick={handleUnlockAudio}
          style={{
            position: "absolute",
            left: 16,
            bottom: 16,
            zIndex: 10,
            fontFamily: "monospace",
            fontSize: 14,
            padding: "10px 14px",
            borderRadius: 999,
            border: "1px solid rgba(0,0,0,0.25)",
            background: "rgba(255,255,255,0.85)",
            color: "#102018",
          }}
        >
          Enable sound
        </button>
      )}
    </div>
  );
}


// ── Keyboard building/drawing ───────────────────────────────────────────────

function buildVisibleWhiteKeys({ canvas, proj }) {
  const {
    keyWidth,
    vTop,
    vBottom,
    range,
  } = KEYBOARD_CONFIG;

  const visibleKeys = [];

  const margin = 100;

  const onScreenQuad = (pts) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const p of pts) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }

    return !(
      maxX < -margin ||
      minX > canvas.width + margin ||
      maxY < -margin ||
      minY > canvas.height + margin
    );
  };

  const uLeft = (k) => 0.5 + (k - 0.5) * keyWidth;
  const uRight = (k) => 0.5 + (k + 0.5) * keyWidth;

  for (let k = -range; k <= range; k++) {
    const a = proj(uLeft(k), vTop);
    const b = proj(uRight(k), vTop);
    const c = proj(uRight(k), vBottom);
    const d = proj(uLeft(k), vBottom);

    if (!a || !b || !c || !d) {
      continue;
    }

    const polygon = [a, b, c, d];

    if (!onScreenQuad(polygon)) {
      continue;
    }

    const keyInfo = getWhiteKeyForIndex(k);

    visibleKeys.push({
      ...keyInfo,
      polygon,
      center: proj((uLeft(k) + uRight(k)) / 2, (vTop + vBottom) / 2),
      nearWidth: Math.hypot(c[0] - d[0], c[1] - d[1]),
    });
  }

  return visibleKeys;
}


function buildFingerCanvasPoints(msg, toCanvas) {
  const out = {};

  const fingers = msg?.fingers || {};

  for (const [fingerKey, finger] of Object.entries(fingers)) {
    if (
      typeof finger.x_px !== "number" ||
      typeof finger.y_px !== "number"
    ) {
      continue;
    }

    out[fingerKey] = {
      ...finger,
      point: toCanvas(finger.x_px, finger.y_px),
    };
  }

  return out;
}


function computePressedKeys({ visibleKeys, fingerPoints, fsr }) {
  const currentPressed = new Map();
  const keyPressed = new Set();
  const keyHovered = new Set();
  const fingerHits = {};

  for (const [fingerKey, finger] of Object.entries(fingerPoints)) {
    let hitKey = null;

    for (const key of visibleKeys) {
      if (pointInPolygon(finger.point, key.polygon)) {
        hitKey = key;
        break;
      }
    }

    if (!hitKey) {
      continue;
    }

    fingerHits[fingerKey] = hitKey;
    keyHovered.add(hitKey.keyId);

    // Critical rule:
    // Play only when SAME finger is inside key AND SAME finger's FSR is down.
    if (fsr[fingerKey] === true) {
      const pressId = `${fingerKey}:${hitKey.keyId}`;

      currentPressed.set(pressId, {
        fingerKey,
        key: hitKey,
      });

      keyPressed.add(hitKey.keyId);
    }
  }

  return {
    currentPressed,
    keyPressed,
    keyHovered,
    fingerHits,
  };
}


function triggerSoundEdges(currentPressed, previousPressedRef) {
  const previous = previousPressedRef.current;

  for (const [pressId, press] of currentPressed.entries()) {
    if (!previous.has(pressId)) {
      playNote(press.key.note);
    }
  }

  previousPressedRef.current = new Set(currentPressed.keys());
}


function drawKeyboard(ctx, visibleKeys, hitResult) {
  for (const key of visibleKeys) {
    const pressed = hitResult.keyPressed.has(key.keyId);
    const hovered = hitResult.keyHovered.has(key.keyId);

    const [a, b, c, d] = key.polygon;

    quadPath(ctx, a, b, c, d);

    if (pressed) {
      ctx.fillStyle = "rgba(45,140,255,0.92)";
    } else if (hovered) {
      ctx.fillStyle = "rgba(180,220,255,0.9)";
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.9)";
    }

    ctx.fill();

    ctx.strokeStyle = "rgba(20,30,40,0.88)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (key.center && key.nearWidth > 14) {
      ctx.font = `bold ${Math.max(11, Math.min(26, key.nearWidth * 0.36))}px monospace`;
      ctx.fillStyle = pressed ? "rgba(255,255,255,0.95)" : "rgba(20,30,40,0.82)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(key.label, key.center[0], key.center[1]);
    }
  }
}


// ── Skeleton drawing ────────────────────────────────────────────────────────

function drawHandSkeletonAndLabels(ctx, msg, toCanvas) {
  if (!msg?.hands) {
    return;
  }

  for (const hand of msg.hands) {
    const landmarks = hand.landmarks || [];

    if (landmarks.length < 21) {
      continue;
    }

    const pts = landmarks.map((lm) => toCanvas(lm.x_px, lm.y_px));

    ctx.strokeStyle = hand.hand === "left"
      ? "rgba(0,90,255,0.95)"
      : "rgba(170,0,255,0.95)";

    ctx.lineWidth = 3;

    for (const [a, b] of HAND_CONNECTIONS) {
      const p1 = pts[a];
      const p2 = pts[b];

      if (!p1 || !p2) continue;

      ctx.beginPath();
      ctx.moveTo(p1[0], p1[1]);
      ctx.lineTo(p2[0], p2[1]);
      ctx.stroke();
    }

    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];

      ctx.fillStyle = "rgba(255,255,255,0.95)";
      drawCircle(ctx, x, y, i === 4 || i === 8 || i === 12 || i === 16 || i === 20 ? 5 : 3);

      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Draw fingertip labels last.
  const fingers = msg.fingers || {};
  const fsr = msg.fsr || {};

  for (const [fingerKey, finger] of Object.entries(fingers)) {
    if (
      typeof finger.x_px !== "number" ||
      typeof finger.y_px !== "number"
    ) {
      continue;
    }

    const [x, y] = toCanvas(finger.x_px, finger.y_px);
    const tapping = fsr[fingerKey] === true;

    ctx.fillStyle = tapping
      ? "rgba(255,60,60,0.95)"
      : "rgba(0,0,0,0.78)";

    drawCircle(ctx, x, y, tapping ? 8 : 5);

    ctx.font = "bold 12px monospace";
    ctx.fillStyle = tapping
      ? "rgba(180,0,0,0.95)"
      : "rgba(0,0,0,0.8)";

    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(fingerKey, x + 8, y - 8);
  }
}


// ── Debug drawing ───────────────────────────────────────────────────────────

function drawMarkerDebug(ctx, msg, dc, toCanvas) {
  ctx.fillStyle = "rgba(0,120,40,0.95)";

  for (const [x, y] of dc) {
    drawCircle(ctx, x, y, 5);
  }

  if (msg.bbox) {
    const { x1, y1, x2, y2 } = msg.bbox;

    if (
      typeof x1 === "number" &&
      typeof y1 === "number" &&
      typeof x2 === "number" &&
      typeof y2 === "number"
    ) {
      const p1 = toCanvas(x1, y1);
      const p2 = toCanvas(x2, y2);

      const left = Math.min(p1[0], p2[0]);
      const top = Math.min(p1[1], p2[1]);
      const width = Math.abs(p2[0] - p1[0]);
      const height = Math.abs(p2[1] - p1[1]);

      ctx.strokeStyle = "rgba(0,120,40,0.45)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(left, top, width, height);

      ctx.font = "bold 13px monospace";
      ctx.fillStyle = "rgba(0,100,30,0.95)";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(`id:${msg.marker.id}`, left, top - 6);
    }
  }
}


function drawKeyboardDebug(ctx, proj, visibleKeyCount) {
  const { keyWidth, vTop } = KEYBOARD_CONFIG;

  const o = proj(0.5, vTop);
  const ur = proj(0.5 + 1.4 * keyWidth, vTop);

  if (o && ur) {
    ctx.strokeStyle = "rgba(255,0,200,0.95)";
    ctx.fillStyle = "rgba(255,0,200,0.95)";
    ctx.lineWidth = 3;

    ctx.beginPath();
    ctx.moveTo(o[0], o[1]);
    ctx.lineTo(ur[0], ur[1]);
    ctx.stroke();

    const ang = Math.atan2(ur[1] - o[1], ur[0] - o[0]);

    ctx.beginPath();
    ctx.moveTo(ur[0], ur[1]);
    ctx.lineTo(
      ur[0] - 12 * Math.cos(ang - 0.4),
      ur[1] - 12 * Math.sin(ang - 0.4),
    );
    ctx.lineTo(
      ur[0] - 12 * Math.cos(ang + 0.4),
      ur[1] - 12 * Math.sin(ang + 0.4),
    );
    ctx.closePath();
    ctx.fill();
  }

  ctx.font = "bold 14px monospace";
  ctx.fillStyle = "rgba(255,0,200,0.95)";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(`keys on screen: ${visibleKeyCount}`, 16, 58);
}


function drawStatus(ctx, { connected, ping, msg, audioReady, noMarker }) {
  const fsrConnected = msg?.fsrConnected || {};
  const activeFsr = Object.entries(msg?.fsr || {})
    .filter(([, value]) => value === true)
    .map(([key]) => key);

  ctx.font = "bold 12px monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  ctx.fillStyle = "rgba(0,0,0,0.48)";
  ctx.fillRect(12, 12, 390, 92);

  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fillText(connected ? `ws: ${ping ?? "–"}ms` : "ws: connecting…", 20, 20);
  ctx.fillText(audioReady ? "audio: ready" : "audio: click Enable sound", 20, 36);
  ctx.fillText(noMarker ? "marker: not found" : `marker: id ${msg?.marker?.id ?? "?"}`, 20, 52);
  ctx.fillText(
    `fsr L:${fsrConnected.left ? "on" : "off"} R:${fsrConnected.right ? "on" : "off"}`,
    20,
    68,
  );
  ctx.fillText(
    `tap: ${activeFsr.length ? activeFsr.join(", ") : "none"}`,
    20,
    84,
  );
}