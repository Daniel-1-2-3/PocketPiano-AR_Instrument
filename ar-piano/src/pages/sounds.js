// sounds.js
// ─────────────────────────────────────────────────────────────────────────────
// Dependency-free synth on the WebAudio API. Each note is a short triangle wave
// with an attack/decay envelope — no audio files to load, zero config.
//
// Mobile browsers block audio until a user gesture, so call unlockAudio() once
// from a tap (the "Tap to start" button does this).

let ctx = null;
let activeVoices = 0;
const MAX_VOICES = 16; // generous — 10 fingers + headroom; prevents runaway node buildup

function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

export function unlockAudio() {
  const c = audioCtx();
  if (c.state === "suspended") c.resume();
}

// Each call creates an independent oscillator+gain node, so multiple notes
// (one per finger, up to 10) play simultaneously — no shared/global voice.
export function playFreq(freq, dur = 0.5) {
  if (activeVoices >= MAX_VOICES) return; // safety valve, not a real limit in practice

  const c = audioCtx();
  if (c.state === "suspended") c.resume();
  const t = c.currentTime;

  const osc  = c.createOscillator();
  const gain = c.createGain();
  osc.type = "triangle";
  osc.frequency.value = freq;

  // quick attack, exponential decay → a soft "pluck"
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.45, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);

  activeVoices++;
  osc.onended = () => { activeVoices--; };
}