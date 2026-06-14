# fsr_reader.py
# ─────────────────────────────────────────────────────────────────────────────
# Reads FSR (force-sensitive resistor) tap states from one or two Arduinos over
# serial, in background threads, and exposes states() -> a 10-boolean dict.
#
# Each Arduino streams lines of "index,value":
#     index = 0..4  (thumb, index, middle, ring, pinky)
#     value = 0..1023 (analogRead)
#
# FAIL-SAFE: if pyserial isn't installed or the ports aren't there, the server
# still runs — every finger just reads False. Threads retry connection forever,
# so you can plug the Arduino in after starting the server.

import threading
import time

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
# Only the right glove is connected. Left disabled (left_* will read False).
# Make sure RIGHT_PORT matches the port your one Arduino enumerates as — watch
# the "[fsr] available serial ports:" line at startup to confirm.
LEFT_PORT  = None
RIGHT_PORT = "COM10"

# analog reading above this counts as a "tap" — tune to your FSRs
TAP_THRESHOLD = 300


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
        self.values    = {"left": [0] * 5, "right": [0] * 5}
        self.connected = {"left": False, "right": False}
        self._ports    = {"left": left_port, "right": right_port}
        self._lock     = threading.Lock()

    def start(self):
        if not HAVE_SERIAL:
            print("[fsr] running WITHOUT serial — all taps = False")
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
                        with self._lock:
                            self.values[hand][idx] = val
            except Exception as e:
                with self._lock:
                    self.connected[hand] = False
                print(f"[fsr] {hand} on {port} unavailable ({e}); retry in 3s")
                time.sleep(3)

    def connected_status(self):
        """Return {left: bool, right: bool} — for a debug readout on the
        frontend so you can see at a glance whether each Arduino is wired up.
        Runs fine (returns all False) if no serial / no Arduino is present."""
        with self._lock:
            return dict(self.connected)

    def states(self):
        """Return {left_thumb: bool, ..., right_pinky: bool}."""
        out = {}
        with self._lock:
            for hand in ("left", "right"):
                for i, fname in enumerate(FINGER_NAMES):
                    out[f"{hand}_{fname}"] = self.values[hand][i] > self.threshold
        return out