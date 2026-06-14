import { useEffect, useRef, useState } from "react";
import Webcam from "react-webcam";
import { unlockAudio, playFreq } from "./sounds";
import {
  KEY_W, V_TOP, V_BOT, RANGE,
  uL, uR, noteLetter, keyAtUV, freqForKey,
} from "./keyboardLayout";

// ── paste your ngrok URL here each session ────────────────────────────────────
const WS_URL = "wss://bfa4-2620-101-f000-7c2-00-39e.ngrok-free.app/ws";

// 16:9 at 240p — matches phone camera ratio so the server decodes undistorted
const SEND_WIDTH  = 426;
const SEND_HEIGHT = 240;
const JPEG_Q      = 0.5;

// Top-down WORN phone looking at the tag on a table. Rear camera is NOT mirrored,
// so the default is no flip. If your hand moving right shows up moving left, set
// this true. (Also flip SWAP_LEFT_RIGHT in hand_tracking.py if L/R are swapped.)
const FLIP_X = false;

// MediaPipe 21-point hand skeleton connections
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17],
];
const FINGERTIP_IDS = { 4:"thumb", 8:"index", 12:"middle", 16:"ring", 20:"pinky" };

// Only the right hand is used / in frame. Tracker forces every detected hand to
// "right", so we only ever look at right_* fingers here.
const ALL_FINGERS = [];
for (const f of ["thumb","index","middle","ring","pinky"])
  ALL_FINGERS.push(`right_${f}`);

// Heckbert unit-square → quad homography (maps tag-plane (u,v) → image).
function makeHomography(p0, p1, p2, p3) {
  const [x0,y0]=p0,[x1,y1]=p1,[x2,y2]=p2,[x3,y3]=p3;
  const dx1=x1-x2,dx2=x3-x2,dx3=x0-x1+x2-x3;
  const dy1=y1-y2,dy2=y3-y2,dy3=y0-y1+y2-y3;
  let a,b,c,d,e,f,g,h;
  if (Math.abs(dx3)<1e-9 && Math.abs(dy3)<1e-9) {
    g=0; h=0; a=x1-x0; b=x2-x1; c=x0; d=y1-y0; e=y2-y1; f=y0;
  } else {
    const den=dx1*dy2-dx2*dy1;
    if (Math.abs(den)<1e-9) return null;
    g=(dx3*dy2-dx2*dy3)/den; h=(dx1*dy3-dx3*dy1)/den;
    a=x1-x0+g*x1; b=x3-x0+h*x3; c=x0;
    d=y1-y0+g*y1; e=y3-y0+h*y3; f=y0;
  }
  return {a,b,c,d,e,f,g,h};
}

export default function Render() {
  const webcamRef   = useRef(null);
  const overlayRef  = useRef(null);
  const wsRef       = useRef(null);
  const waitingRef  = useRef(false);
  const sendTimeRef = useRef(0);
  const rafRef      = useRef(null);
  const offRef      = useRef(null);
  const lastMsgRef  = useRef(null);
  const pressedRef  = useRef({});   // finger -> key index currently sounding (edge detect)

  const [ping,      setPing]      = useState(null);
  const [connected, setConnected] = useState(false);
  const [started,   setStarted]   = useState(false);

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
    return () => { alive = false; clearTimeout(retryTimer); wsRef.current?.close(); };
  }, []);

  // ── capture + render loop ─────────────────────────────────────────────────────
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

      // ── send frame to server (camera stays internal; we never show it) ──────
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

      // ── set up overlay canvas ───────────────────────────────────────────────
      const canvas = overlayRef.current;
      if (!canvas) return;
      const rect  = video.getBoundingClientRect();
      const dispW = rect.width, dispH = rect.height;
      if (canvas.width  !== Math.round(dispW)) canvas.width  = Math.round(dispW);
      if (canvas.height !== Math.round(dispH)) canvas.height = Math.round(dispH);
      const ctx = canvas.getContext("2d");

      // transparent overlay — the live camera feed shows through underneath,
      // so your real hands are visible alongside the skeleton/keyboard
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const natW = video.videoWidth, natH = video.videoHeight;
      if (!natW || !natH) return;

      // send-frame px → display px (cover scaling + optional X flip)
      const scale     = Math.max(dispW / natW, dispH / natH);
      const renderedW = natW * scale, renderedH = natH * scale;
      const offsetX   = (dispW - renderedW) / 2, offsetY = (dispH - renderedH) / 2;
      const sxv = renderedW / SEND_WIDTH, syv = renderedH / SEND_HEIGHT;
      const toDispX = (x) => FLIP_X ? dispW - (x * sxv + offsetX) : (x * sxv + offsetX);
      const toDispY = (y) => y * syv + offsetY;

      const msg = lastMsgRef.current;

      // ── KEYBOARD + HIT DETECTION (needs the marker) ─────────────────────────
      const activeKeys = new Set();   // keys currently being played (for highlight)
      if (msg?.found && msg.marker) {
        const dc = msg.marker.corners.map(([x, y]) => [toDispX(x), toDispY(y)]);

        // auto-orient: keyboard long-axis = the more horizontal tag edge,
        // u→screen-right, v→screen-down (toward player / below the tag)
        const eA = [dc[1][0]-dc[0][0], dc[1][1]-dc[0][1]];
        const eB = [dc[3][0]-dc[0][0], dc[3][1]-dc[0][1]];
        const horiz = (e) => Math.abs(e[0]) / (Math.hypot(e[0],e[1]) + 1e-9);
        let [Q0,Q1,Q2,Q3] = horiz(eA) >= horiz(eB)
          ? [dc[0],dc[1],dc[2],dc[3]]
          : [dc[0],dc[3],dc[2],dc[1]];
        if (Q1[0] < Q0[0]) [Q0,Q1,Q2,Q3] = [Q1,Q0,Q3,Q2];
        if (Q3[1] < Q0[1]) [Q0,Q1,Q2,Q3] = [Q3,Q2,Q1,Q0];

        const H = makeHomography(Q0,Q1,Q2,Q3);
        if (H) {
          // forward: tag-plane (u,v) → screen
          const proj = (u,v) => {
            const w = H.g*u + H.h*v + 1;
            if (w <= 1e-3) return null;
            return [(H.a*u+H.b*v+H.c)/w, (H.d*u+H.e*v+H.f)/w];
          };
          // inverse: screen (X,Y) → tag-plane (u,v)  [used for finger hit-test]
          const invProj = (X,Y) => {
            const {a,b,c,d,e,f,g,h} = H;
            const A1=a-X*g, B1=b-X*h, C1=X-c;
            const A2=d-Y*g, B2=e-Y*h, C2=Y-f;
            const det = A1*B2 - B1*A2;
            if (Math.abs(det) < 1e-9) return null;
            return [(C1*B2 - B1*C2)/det, (A1*C2 - C1*A2)/det];
          };

          // ── figure out which key each tapping finger is over ─────────────────
          // PLAY RULE: a key sounds only when the SAME finger is (1) inside the
          // key region AND (2) its FSR registers a tap. Hover alone or tap alone
          // does nothing.
          const fingers = msg.fingers || {};
          const fsr     = msg.fsr || {};
          const nowKey  = {};        // finger -> key index it's currently playing (or null)

          for (const name of ALL_FINGERS) {
            const tip = fingers[name];
            let k = null;
            if (tip) {
              const uv = invProj(toDispX(tip.x_px), toDispY(tip.y_px));
              if (uv) {
                const cand = keyAtUV(uv[0], uv[1]);
                if (cand !== null && fsr[name]) k = cand;  // inside key AND tapping
              }
            }
            nowKey[name] = k;
            if (k !== null) activeKeys.add(k);
          }

          // ── edge-triggered sound: play only on a NEW press (no per-frame spam)
          for (const name of ALL_FINGERS) {
            const now  = nowKey[name];
            const prev = pressedRef.current[name] ?? null;
            if (now !== null && now !== prev) {
              playFreq(freqForKey(now));   // fires once on press / on slide to new key
            }
            pressedRef.current[name] = now;
          }

          // ── draw white keys (highlight the active ones) ──────────────────────
          for (let k = -RANGE; k < RANGE; k++) {
            const a = proj(uL(k), V_TOP), b = proj(uR(k), V_TOP);
            const c = proj(uR(k), V_BOT), d = proj(uL(k), V_BOT);
            if (!a || !b || !c || !d) continue;
            ctx.beginPath();
            ctx.moveTo(a[0],a[1]); ctx.lineTo(b[0],b[1]);
            ctx.lineTo(c[0],c[1]); ctx.lineTo(d[0],d[1]); ctx.closePath();
            ctx.fillStyle   = activeKeys.has(k) ? "rgba(90,200,255,0.95)"
                                                : "rgba(255,255,255,0.9)";
            ctx.fill();
            ctx.strokeStyle = "rgba(20,30,40,0.85)";
            ctx.lineWidth   = 1.5;
            ctx.stroke();

            const nearW = Math.hypot(c[0]-d[0], c[1]-d[1]);
            if (nearW > 14) {
              const lp = proj((uL(k)+uR(k))/2, (V_TOP+V_BOT)/2);
              if (lp) {
                ctx.font = `bold ${Math.max(11, Math.min(28, nearW*0.5))}px monospace`;
                ctx.fillStyle = "rgba(20,30,40,0.8)";
                ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillText(noteLetter(k), lp[0], lp[1]);
              }
            }
          }
        }
      } else {
        // tag lost → nothing is "pressed"; reset edge states so re-acquire is clean
        for (const name of ALL_FINGERS) pressedRef.current[name] = null;
      }

      // ── debug readout: confirms hand tracking + FSR wiring at a glance ──────
      // Drawn on the canvas (not React state) so it costs nothing extra per
      // frame and doesn't trigger re-renders. Right hand only now.
      {
        const fc  = msg?.fsr_connected || { right: false };
        const txt = `hands: ${(msg?.hands || []).length}  |  FSR R:${fc.right ? "✓" : "✗"}`;
        ctx.font = "12px monospace";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillText(txt, canvas.width - 11, 13);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillText(txt, canvas.width - 12, 12);
      }

      // ── HAND SKELETON on top of everything ──────────────────────────────────
      const hands = msg?.hands || [];
      for (const hand of hands) {
        const lm = hand.landmarks;
        if (!lm) continue;
        const pts = lm.map((p) => [toDispX(p.x_px), toDispY(p.y_px)]);

        // bones: dark outline + light core
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        for (const [i, j] of HAND_CONNECTIONS) {
          ctx.beginPath(); ctx.moveTo(pts[i][0],pts[i][1]); ctx.lineTo(pts[j][0],pts[j][1]);
          ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = 7; ctx.stroke();
          ctx.beginPath(); ctx.moveTo(pts[i][0],pts[i][1]); ctx.lineTo(pts[j][0],pts[j][1]);
          ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 3; ctx.stroke();
        }
        // joints
        for (let i = 0; i < pts.length; i++) {
          ctx.beginPath(); ctx.arc(pts[i][0],pts[i][1],5,0,Math.PI*2);
          ctx.fillStyle = "rgba(0,0,0,0.85)"; ctx.fill();
          ctx.beginPath(); ctx.arc(pts[i][0],pts[i][1],2.5,0,Math.PI*2);
          ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.fill();
        }
        // fingertip dots + debug labels (right_index, ...)
        const handLabel = hand.hand || "?";
        for (const id in FINGERTIP_IDS) {
          const p = pts[id];
          const tapping = (msg.fsr || {})[`${handLabel}_${FINGERTIP_IDS[id]}`];
          ctx.beginPath(); ctx.arc(p[0],p[1],7,0,Math.PI*2);
          ctx.fillStyle = tapping ? "rgba(255,60,60,0.95)" : "rgba(255,200,0,0.95)";
          ctx.fill();
          ctx.font = "10px monospace"; ctx.fillStyle = "rgba(0,0,0,0.8)";
          ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          ctx.fillText(`${handLabel[0]}_${FINGERTIP_IDS[id]}`, p[0], p[1] - 9);
        }
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden" }}>
      {/* live camera feed — visible, overlay drawn on top of it */}
      <Webcam
        ref={webcamRef}
        audio={false}
        mirrored={false}
        videoConstraints={{
          facingMode: "environment",
          width:  { ideal: 1280 },
          height: { ideal: 720 },
          aspectRatio: 16 / 9,
        }}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
                 objectFit: "cover", opacity: 1 }}
      />
      <canvas
        ref={overlayRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%",
                 pointerEvents: "none" }}
      />

      <span style={{
        position: "absolute", top: 16, left: 16,
        fontFamily: "monospace", fontSize: 12,
        color: "rgba(0,0,0,0.6)", background: "rgba(255,255,255,0.5)",
        padding: "2px 8px", borderRadius: 999, pointerEvents: "none",
      }}>
        {connected ? `${ping ?? "–"}ms` : "connecting…"}
      </span>

      {/* one-tap overlay: unlocks audio (required on mobile) and starts the demo */}
      {!started && (
        <button
          onClick={() => { unlockAudio(); setStarted(true); }}
          style={{
            position: "absolute", inset: 0, margin: "auto",
            width: 200, height: 60, borderRadius: 14, border: "none",
            background: "rgba(20,30,40,0.9)", color: "white",
            fontFamily: "monospace", fontSize: 18, cursor: "pointer",
          }}
        >
          Tap to start
        </button>
      )}
    </div>
  );
}