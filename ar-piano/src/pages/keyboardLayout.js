// keyboardLayout.js
// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for the piano geometry on the ArUco tag plane.
//
// Coordinates are in TAG-PLANE units (u, v): the tag occupies the unit square
// u∈[0,1], v∈[0,1]. The keyboard sits in a band BELOW the tag (v > 1 = toward
// the player). Because BOTH the renderer and the fingertip hit-test use these
// functions, the region you can "play" is exactly the key you see.

export const KEY_W = 0.30;   // white-key width in tag-widths (bigger = wider keys)
export const V_TOP = 1.08;   // near edge of the keyboard band (just below tag)
export const V_BOT = 1.78;   // far edge of the keyboard band
export const RANGE = 40;     // how many keys to try each side of centre (culled)

const NOTE_NAMES = ["A", "B", "C", "D", "E", "F", "G"];

// key index k → left / right u-edges. k = 0 is centred on the tag centre (u=0.5)
export const uL = (k) => 0.5 + (k - 0.5) * KEY_W;
export const uR = (k) => 0.5 + (k + 0.5) * KEY_W;

// key index → note letter (cycles A..G in both directions)
export const noteLetter = (k) => NOTE_NAMES[((k % 7) + 7) % 7];

// Given a tag-plane point (u, v), return the key index if it falls inside the
// keyboard band, otherwise null. This is the hit-test used for FSR taps.
export function keyAtUV(u, v) {
  if (v < V_TOP || v > V_BOT) return null;     // above/below the key band
  return Math.round((u - 0.5) / KEY_W);        // which white-key column
}

// key index → frequency (Hz). White keys are diatonic, so map each letter to its
// semitone offset above A and add 12 semitones per 7-key octave. Pitch then rises
// monotonically left→right, with k = 0 = A4 (440 Hz).
const SEMI = [0, 2, 3, 5, 7, 8, 10]; // semitones above A for A,B,C,D,E,F,G
export function freqForKey(k) {
  const within = ((k % 7) + 7) % 7;
  const group  = Math.floor(k / 7);
  const semis  = 12 * group + SEMI[within];
  return 440 * Math.pow(2, semis / 12);
}