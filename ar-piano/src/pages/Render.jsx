import { useEffect, useRef, useState } from "react";
import Webcam from "react-webcam";
import { unlockAudio, playFreq } from "./sounds";
import {
  KEY_W, V_TOP, V_BOT, RANGE,
  uL, uR, noteLetter, keyAtUV, freqForKey,
} from "./keyboardLayout";

// ── paste your ngrok URL here each session ────────────────────────────────────
const WS_URL = "wss://7255-2620-101-f000-7c2-00-39e.ngrok-free.app/ws";

// 16:9 at 240p — matches phone camera ratio so the server decodes undistorted
const SEND_WIDTH  = 426;
const SEND_HEIGHT = 240;
const JPEG_Q      = 0.5;

// Top-down WORN phone looking at the tag on a table. Rear camera is NOT mirrored,
// so the default is no flip. If your hand moving right shows up moving left, set
// this true. (Also flip SWAP_LEFT_RIGHT in hand_tracking.py if L/R are swapped.)
const FLIP_X = false;

// ── VR (split-screen stereo) tuning ───────────────────────────────────────────
// Always-on. Phone is HORIZONTAL in the headset: the centre of the frame is
// cropped and drawn into a left + right half (one per eye).
//   VR_ZOOM 1.0 = largest centre crop that fills each eye (square-ish, so the
//                 far edges of a wide keyboard get cut — inherent to a landscape
//                 phone split in two). >1.0 zooms in further.
//   EYE_GAP    = px of black divider between the two eyes (0 = none).
const VR_ZOOM = 1.0;
const EYE_GAP = 0;

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

// Only the right hand is used / in frame.
const ALL_FINGERS = [];
for (const f of ["thumb","index","middle","ring","pinky"])
  ALL_FINGERS.push(`right_${f}`);

// Heckbert unit-square → quad homography (tag-plane (u,v) → image), built in
// SEND-FRAME coords so the hit-test runs ONCE regardless of how we draw it.
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

// cover-fit a SEND crop rect into a display viewport rect (centred, clipped).
function placeCover(vp, crop) {
  const scale = Math.max(vp.w / crop.w, vp.h / crop.h);
  const dw = crop.w * scale, dh = crop.h * scale;
  const dx = vp.x + (vp.w - dw) / 2;
  const dy = vp.y + (vp.h - dh) / 2;
  return { scale, dw, dh, dx, dy };
}

// centred crop of the SEND frame, matched to a viewport's aspect ratio.
function centerCropForViewport(vp, zoom) {
  const arV = vp.w / vp.h;
  const arS = SEND_WIDTH / SEND_HEIGHT;
  let cw, ch;
  if (arV <= arS) { ch = SEND_HEIGHT; cw = SEND_HEIGHT * arV; }
  else            { cw = SEND_WIDTH;  ch = SEND_WIDTH / arV; }
  cw = Math.min(SEND_WIDTH,  cw / zoom);
  ch = Math.min(SEND_HEIGHT, ch / zoom);
  return { x: (SEND_WIDTH - cw) / 2, y: (SEND_HEIGHT - ch) / 2, w: cw, h: ch };
}

// hide the browser address bar / chrome (needs a user gesture to call).
function goFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen
            || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (req) { try { req.call(el); } catch (_) {} }
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

  // ── capture + render loop (always split-screen stereo) ────────────────────────
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

      // ── send frame to server ────────────────────────────────────────────────
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

      // ── set up overlay canvas (device-res + even width = crisp, exact split) ──
      const canvas = overlayRef.current;
      if (!canvas) return;
      const rect  = canvas.getBoundingClientRect();
      const dispW = rect.width, dispH = rect.height;
      const dpr   = window.devicePixelRatio || 1;
      let bw = Math.round(dispW * dpr);
      let bh = Math.round(dispH * dpr);
      bw -= bw % 2;                          // even → half is a whole pixel
      if (canvas.width  !== bw) canvas.width  = bw;
      if (canvas.height !== bh) canvas.height = bh;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const natW = video.videoWidth, natH = video.videoHeight;
      if (!natW || !natH) return;

      const msg = lastMsgRef.current;

      // ── LOGIC (ONCE, in SEND-frame coords): homography + hit-test + sound ────
      // Display-independent, so the two eyes never double-fire a note.
      let H = null, projS = null;
      const activeKeys = new Set();
      if (msg?.found && msg.marker) {
        const mc = msg.marker.corners;   // [[x,y]*4] in SEND px

        const eA = [mc[1][0]-mc[0][0], mc[1][1]-mc[0][1]];
        const eB = [mc[3][0]-mc[0][0], mc[3][1]-mc[0][1]];
        const horiz = (e) => Math.abs(e[0]) / (Math.hypot(e[0],e[1]) + 1e-9);
        let [Q0,Q1,Q2,Q3] = horiz(eA) >= horiz(eB)
          ? [mc[0],mc[1],mc[2],mc[3]]
          : [mc[0],mc[3],mc[2],mc[1]];
        if (Q1[0] < Q0[0]) [Q0,Q1,Q2,Q3] = [Q1,Q0,Q3,Q2];
        if (Q3[1] < Q0[1]) [Q0,Q1,Q2,Q3] = [Q3,Q2,Q1,Q0];

        H = makeHomography(Q0,Q1,Q2,Q3);
        if (H) {
          projS = (u,v) => {
            const w = H.g*u + H.h*v + 1;
            if (w <= 1e-3) return null;
            return [(H.a*u+H.b*v+H.c)/w, (H.d*u+H.e*v+H.f)/w];
          };
          const invS = (X,Y) => {
            const {a,b,c,d,e,f,g,h} = H;
            const A1=a-X*g, B1=b-X*h, C1=X-c;
            const A2=d-Y*g, B2=e-Y*h, C2=Y-f;
            const det = A1*B2 - B1*A2;
            if (Math.abs(det) < 1e-9) return null;
            return [(C1*B2 - B1*C2)/det, (A1*C2 - C1*A2)/det];
          };

          // PLAY RULE: a key sounds only when the SAME finger is inside the key
          // region AND its FSR registers a tap.
          const fingers = msg.fingers || {};
          const fsr     = msg.fsr || {};
          const nowKey  = {};

          for (const name of ALL_FINGERS) {
            const tip = fingers[name];
            let k = null;
            if (tip) {
              const uv = invS(tip.x_px, tip.y_px);
              if (uv) {
                const cand = keyAtUV(uv[0], uv[1]);
                if (cand !== null && fsr[name]) k = cand;
              }
            }
            nowKey[name] = k;
            if (k !== null) activeKeys.add(k);
          }

          for (const name of ALL_FINGERS) {
            const now  = nowKey[name];
            const prev = pressedRef.current[name] ?? null;
            if (now !== null && now !== prev) playFreq(freqForKey(now));
            pressedRef.current[name] = now;
          }
        }
      } else {
        for (const name of ALL_FINGERS) pressedRef.current[name] = null;
      }

      // ── DRAW: two viewports, left eye + right eye ───────────────────────────
      const half = canvas.width / 2;        // exact integer (width forced even)
      const viewports = [
        { x: 0,                y: 0, w: half - EYE_GAP/2, h: canvas.height },
        { x: half + EYE_GAP/2, y: 0, w: half - EYE_GAP/2, h: canvas.height },
      ];

      for (const vp of viewports) {
        const crop = centerCropForViewport(vp, VR_ZOOM);
        const pl   = placeCover(vp, crop);

        // SEND px → display px for THIS viewport
        const T = (sx, sy) => {
          let X = pl.dx + (sx - crop.x) * pl.scale;
          const Y = pl.dy + (sy - crop.y) * pl.scale;
          if (FLIP_X) X = 2 * vp.x + vp.w - X;
          return [X, Y];
        };

        // cropped camera into this eye
        {
          const k  = natW / SEND_WIDTH;   // SEND→native (same AR both axes)
          const sX = crop.x * k, sY = crop.y * k, sW = crop.w * k, sH = crop.h * k;
          ctx.save();
          ctx.beginPath(); ctx.rect(vp.x, vp.y, vp.w, vp.h); ctx.clip();
          if (FLIP_X) { ctx.translate(2 * vp.x + vp.w, 0); ctx.scale(-1, 1); }
          ctx.drawImage(video, sX, sY, sW, sH, pl.dx, pl.dy, pl.dw, pl.dh);
          ctx.restore();
        }

        // clip overlay so the halves never bleed into each other
        ctx.save();
        ctx.beginPath(); ctx.rect(vp.x, vp.y, vp.w, vp.h); ctx.clip();

        // ── white keys (highlight active) ─────────────────────────────────────
        if (H && projS) {
          for (let k = -RANGE; k < RANGE; k++) {
            const a = projS(uL(k), V_TOP), b = projS(uR(k), V_TOP);
            const c = projS(uR(k), V_BOT), d = projS(uL(k), V_BOT);
            if (!a || !b || !c || !d) continue;
            const A = T(a[0],a[1]), B = T(b[0],b[1]), C = T(c[0],c[1]), D = T(d[0],d[1]);
            ctx.beginPath();
            ctx.moveTo(A[0],A[1]); ctx.lineTo(B[0],B[1]);
            ctx.lineTo(C[0],C[1]); ctx.lineTo(D[0],D[1]); ctx.closePath();
            ctx.fillStyle   = activeKeys.has(k) ? "rgba(90,200,255,0.95)"
                                                : "rgba(255,255,255,0.9)";
            ctx.fill();
            ctx.strokeStyle = "rgba(20,30,40,0.85)";
            ctx.lineWidth   = 1.5;
            ctx.stroke();

            const nearW = Math.hypot(C[0]-D[0], C[1]-D[1]);
            if (nearW > 14) {
              const lpS = projS((uL(k)+uR(k))/2, (V_TOP+V_BOT)/2);
              if (lpS) {
                const lp = T(lpS[0], lpS[1]);
                ctx.font = `bold ${Math.max(11, Math.min(28, nearW*0.5))}px monospace`;
                ctx.fillStyle = "rgba(20,30,40,0.8)";
                ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillText(noteLetter(k), lp[0], lp[1]);
              }
            }
          }
        }

        // ── debug readout (drawn into each eye) ───────────────────────────────
        {
          const fc  = msg?.fsr_connected || { right: false };
          const txt = `hands: ${(msg?.hands || []).length}  |  FSR R:${fc.right ? "✓" : "✗"}`;
          ctx.font = "12px monospace";
          ctx.textAlign = "right";
          ctx.textBaseline = "top";
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillText(txt, vp.x + vp.w - 11, vp.y + 13);
          ctx.fillStyle = "rgba(255,255,255,0.9)";
          ctx.fillText(txt, vp.x + vp.w - 12, vp.y + 12);
        }

        // ── hand skeleton ─────────────────────────────────────────────────────
        const hands = msg?.hands || [];
        for (const hand of hands) {
          const lm = hand.landmarks;
          if (!lm) continue;
          const pts = lm.map((p) => T(p.x_px, p.y_px));

          ctx.lineJoin = "round"; ctx.lineCap = "round";
          for (const [i, j] of HAND_CONNECTIONS) {
            ctx.beginPath(); ctx.moveTo(pts[i][0],pts[i][1]); ctx.lineTo(pts[j][0],pts[j][1]);
            ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = 7; ctx.stroke();
            ctx.beginPath(); ctx.moveTo(pts[i][0],pts[i][1]); ctx.lineTo(pts[j][0],pts[j][1]);
            ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 3; ctx.stroke();
          }
          for (let i = 0; i < pts.length; i++) {
            ctx.beginPath(); ctx.arc(pts[i][0],pts[i][1],5,0,Math.PI*2);
            ctx.fillStyle = "rgba(0,0,0,0.85)"; ctx.fill();
            ctx.beginPath(); ctx.arc(pts[i][0],pts[i][1],2.5,0,Math.PI*2);
            ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.fill();
          }
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

        ctx.restore();
      }

      if (EYE_GAP > 0) {
        ctx.fillStyle = "#000";
        ctx.fillRect(half - EYE_GAP/2, 0, EYE_GAP, canvas.height);
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000",
                  overflow: "hidden", touchAction: "none" }}>
      {/* kill document-level scroll / pan / rubber-band on mobile */}
      <style>{`
        html, body {
          margin: 0; padding: 0;
          width: 100%; height: 100%;
          overflow: hidden;
          position: fixed; inset: 0;
          overscroll-behavior: none;
          touch-action: none;
        }
      `}</style>

      {/* camera is the frame source only — never shown directly (canvas draws both eyes) */}
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
                 objectFit: "cover", opacity: 0 }}
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

      {/* re-enter fullscreen if the address bar comes back (e.g. after rotating) */}
      {started && (
        <button
          onClick={goFullscreen}
          style={{
            position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)",
            fontFamily: "monospace", fontSize: 14, padding: "6px 14px",
            borderRadius: 999, border: "none", cursor: "pointer", zIndex: 5,
            background: "rgba(20,30,40,0.8)", color: "white",
          }}
        >
          ⛶ Fullscreen
        </button>
      )}

      {/* one-tap overlay: unlocks audio, hides the address bar, starts the demo */}
      {!started && (
        <button
          onClick={() => { unlockAudio(); goFullscreen(); setStarted(true); }}
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