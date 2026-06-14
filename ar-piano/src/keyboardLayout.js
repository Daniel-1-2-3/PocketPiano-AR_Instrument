export const KEYBOARD_CONFIG = {
  // Width of one white key in tag-width units.
  // Larger number = wider keys.
  keyWidth: 0.30,

  // v=1 is the near edge of the ArUco tag.
  // Keyboard is drawn below/toward the player.
  vTop: 1.08,
  vBottom: 1.78,

  // Number of keys to try each side.
  // Offscreen keys are culled.
  range: 40,
};

const WHITE_NOTES = ["C", "D", "E", "F", "G", "A", "B"];

function positiveMod(n, m) {
  return ((n % m) + m) % m;
}

/**
 * k = 0 is C4.
 * k = 1 is D4.
 * k = -1 is B3.
 */
export function getWhiteKeyForIndex(k) {
  const noteIndex = positiveMod(k, 7);
  const octave = 4 + Math.floor(k / 7);
  const noteName = WHITE_NOTES[noteIndex];
  const note = `${noteName}${octave}`;

  return {
    keyIndex: k,
    keyId: note,
    note,
    label: note,
  };
}