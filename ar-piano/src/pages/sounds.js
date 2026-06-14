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

const PEAK_GAIN = 0.45; // loudness at full velocity (1.0)

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
//
// SIGNATURE CHANGE: the 2nd arg is now `velocity` (0..1, from FSR press
// hardness), not duration. Velocity scales the note's peak loudness so a hard
// press is louder than a light one. `dur` moved to the 3rd arg (default 0.5).
export function playFreq(freq, velocity = 1, dur = 0.5) {
  if (activeVoices >= MAX_VOICES) return; // safety valve, not a real limit in practice

  const c = audioCtx();
  if (c.state === "suspended") c.resume();
  const t = c.currentTime;

  // velocity -> loudness. Clamp the peak above 0 so the exponential ramp (which
  // can't target exactly 0) stays valid even at velocity 0.
  const v    = Math.max(0, Math.min(1, velocity));
  const peak = Math.max(0.0002, PEAK_GAIN * v);

  const osc  = c.createOscillator();
  const gain = c.createGain();
  osc.type = "triangle";
  osc.frequency.value = freq;

  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);

  activeVoices++;
  osc.onended = () => { activeVoices--; };
}