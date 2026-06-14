# fsr_reader.py
# ─────────────────────────────────────────────────────────────────────────────
# Reads FSR (force-sensitive resistor) tap states from one or two Arduinos over
# serial, in background threads, and exposes:
#   states() -> a 10-boolean dict   (above threshold = a "tap", used for note-ON)
#   levels() -> a 10-float   dict   (0..1 press hardness, used for VELOCITY)
#
# Each Arduino streams lines of "index,value":
#     index = 0..4  (thumb, index, middle, ring, pinky)
#     value = 0..1023 (analogRead)
#
# FAIL-SAFE: if pyserial isn't installed or the ports aren't there, the server
# still runs — every finger just reads False / 0.0. Threads retry connection
# forever, so you can plug the Arduino in after starting the server.

import threading
import time
from collections import deque

try:
    import serial
    import serial.tools.list_ports
    HAVE_SERIAL = True
except ImportError:
    HAVE_SERIAL = False

BAUD = 9600
NUM_FINGERS  = 5
FINGER_NAMES = ["thumb", "index", "middle", "ring", "pinky"]

# ── SET YOUR PORTS HERE ──────────────────────────────────────────────────────
#   Windows:  "COM9"   Mac/Linux: "/dev/ttyACM0" or "/dev/ttyUSB0"
#   Set a port to None to disable that hand.
#
# Only the right glove is connected. Left disabled (left_* will read False / 0).
LEFT_PORT  = None
RIGHT_PORT = "COM5"

# analog reading above this counts as a "tap" — tune to your FSRs
TAP_THRESHOLD = 300

# ── velocity / dynamics ──────────────────────────────────────────────────────
# Analog reading that maps to FULL velocity (1.0). FSRs rarely reach the full
# 1023, so a ceiling around 850-950 usually gives the best dynamic range. Lower
# it if even medium presses already sound at max volume; raise it if you can
# never reach max. levels() normalises (value - TAP_THRESHOLD) / (FSR_MAX -
# TAP_THRESHOLD) into 0..1.
FSR_MAX = 900

# We report the PEAK value over a short window rather than the instantaneous
# one. The frontend only samples the FSR at the moment a key edge-triggers, and
# at sparse network frame rates that single sample can land mid-press (too
# quiet). Peak-hold over ~150 ms captures the hardest part of the strike so the
# velocity reflects how hard you actually hit, not which frame happened to land.
PEAK_WINDOW_S = 0.15


def list_available_ports():
    if not HAVE_SERIAL:
        print("[fsr] pyserial not installed")
        return
    ports = list(serial.tools.list_ports.comports())
    print("[fsr] available serial ports:",
          ", ".join(p.device for p in ports) if ports else "none")


class FSRReader:
    def __init__(self, left_port=LEFT_PORT, right_port=RIGHT_PORT,
                 threshold=TAP_THRESHOLD):
        self.threshold = threshold
        self.values    = {"left": [0] * 5, "right": [0] * 5}   # latest raw value
        self.connected = {"left": False, "right": False}
        self._ports    = {"left": left_port, "right": right_port}
        self._lock     = threading.Lock()
        # rolling (timestamp, value) samples per finger, for peak-hold velocity
        self.samples = {
            "left":  [deque() for _ in range(NUM_FINGERS)],
            "right": [deque() for _ in range(NUM_FINGERS)],
        }

    def start(self):
        if not HAVE_SERIAL:
            print("[fsr] running WITHOUT serial — all taps = False, levels = 0.0")
            return self
        list_available_ports()
        for hand, port in self._ports.items():
            if port is None:
                continue
            threading.Thread(target=self._reader, args=(hand, port),
                             daemon=True).start()
        return self

    def _reader(self, hand, port):
        # retry loop so a missing/late Arduino never kills the server
        while True:
            try:
                ser = serial.Serial(port, BAUD, timeout=1)
                time.sleep(2)  # let the board reset
                with self._lock:
                    self.connected[hand] = True
                print(f"[fsr] {hand} connected on {port}")
                while True:
                    line = ser.readline().decode("utf-8", "ignore").strip()
                    if not line:
                        continue
                    parts = line.split(",")
                    if len(parts) != 2:
                        continue
                    try:
                        idx, val = int(parts[0]), int(parts[1])
                    except ValueError:
                        continue
                    if 0 <= idx < NUM_FINGERS:
                        now = time.monotonic()
                        with self._lock:
                            self.values[hand][idx] = val
                            dq = self.samples[hand][idx]
                            dq.append((now, val))
                            while dq and (now - dq[0][0]) > PEAK_WINDOW_S:
                                dq.popleft()
            except Exception as e:
                with self._lock:
                    self.connected[hand] = False
                print(f"[fsr] {hand} on {port} unavailable ({e}); retry in 3s")
                time.sleep(3)

    def connected_status(self):
        """Return {left: bool, right: bool} — for a debug readout on the
        frontend so you can see at a glance whether each Arduino is wired up."""
        with self._lock:
            return dict(self.connected)

    def states(self):
        """Return {left_thumb: bool, ..., right_pinky: bool} — the note-ON taps."""
        out = {}
        with self._lock:
            for hand in ("left", "right"):
                for i, fname in enumerate(FINGER_NAMES):
                    out[f"{hand}_{fname}"] = self.values[hand][i] > self.threshold
        return out

    def levels(self):
        """Return {left_thumb: 0..1, ..., right_pinky: 0..1} — press hardness for
        velocity. 0 at the tap threshold, 1 at FSR_MAX, peak-held over a short
        window so it survives sparse frame sampling."""
        out  = {}
        span = max(1, FSR_MAX - self.threshold)
        now  = time.monotonic()
        with self._lock:
            for hand in ("left", "right"):
                for i, fname in enumerate(FINGER_NAMES):
                    dq = self.samples[hand][i]
                    while dq and (now - dq[0][0]) > PEAK_WINDOW_S:
                        dq.popleft()
                    peak = max((v for (_, v) in dq), default=0)
                    lvl  = (peak - self.threshold) / span
                    out[f"{hand}_{fname}"] = max(0.0, min(1.0, lvl))
        return out