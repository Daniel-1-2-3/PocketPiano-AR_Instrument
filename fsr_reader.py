import threading
import time


try:
    import serial
    import serial.tools.list_ports

    SERIAL_AVAILABLE = True

except Exception as error:
    print(f"pyserial import failed: {error}")
    SERIAL_AVAILABLE = False
    serial = None


BAUD_RATE = 9600
NUM_FINGERS = 5

FINGER_NAMES = ["thumb", "index", "middle", "ring", "pinky"]

ALL_FINGER_KEYS = [
    "left_thumb",
    "left_index",
    "left_middle",
    "left_ring",
    "left_pinky",
    "right_thumb",
    "right_index",
    "right_middle",
    "right_ring",
    "right_pinky",
]


class FSRReader:
    """
    Background serial reader for one or two Arduinos.

    Expected Arduino line format:
        index,value

    Example:
        1,537

    Mapping:
        index 0 -> thumb
        index 1 -> index
        index 2 -> middle
        index 3 -> ring
        index 4 -> pinky

    Left Arduino updates:
        left_thumb, left_index, ...

    Right Arduino updates:
        right_thumb, right_index, ...

    If Arduino ports are missing, the server still runs.
    """

    def __init__(
        self,
        left_port="COM9",
        right_port="COM10",
        threshold=120,
        autostart=True,
    ):
        self.left_port = left_port
        self.right_port = right_port
        self.threshold = threshold

        self.lock = threading.Lock()

        self.raw = self.empty_raw_state()
        self.connected = {
            "left": False,
            "right": False,
        }

        self.started = False

        if autostart:
            self.start()

    def empty_fsr_state(self):
        return {finger_key: False for finger_key in ALL_FINGER_KEYS}

    def empty_raw_state(self):
        return {finger_key: 0 for finger_key in ALL_FINGER_KEYS}

    def connection_state(self):
        with self.lock:
            return dict(self.connected)

    def list_available_ports(self):
        if not SERIAL_AVAILABLE:
            print("pyserial is not installed. FSR disabled.")
            return

        ports = list(serial.tools.list_ports.comports())

        print("Available serial ports:")

        if not ports:
            print("  No serial ports found.")
            return

        for port in ports:
            print(f"  {port.device} - {port.description}")

    def start(self):
        if self.started:
            return

        self.started = True

        self.list_available_ports()

        if not SERIAL_AVAILABLE:
            return

        print("\nFSR Arduino config:")
        print(f"  Left Arduino:  {self.left_port}")
        print(f"  Right Arduino: {self.right_port}")
        print(f"  Threshold:     {self.threshold}")
        print("")

        if self.left_port:
            left_thread = threading.Thread(
                target=self.read_from_arduino_forever,
                args=(self.left_port, "left"),
                daemon=True,
            )
            left_thread.start()

        if self.right_port:
            right_thread = threading.Thread(
                target=self.read_from_arduino_forever,
                args=(self.right_port, "right"),
                daemon=True,
            )
            right_thread.start()

    def set_connected(self, hand, value):
        with self.lock:
            self.connected[hand] = bool(value)

    def update_value(self, hand, finger_index, fsr_value):
        if not 0 <= finger_index < NUM_FINGERS:
            return

        finger_name = FINGER_NAMES[finger_index]
        finger_key = f"{hand}_{finger_name}"

        with self.lock:
            self.raw[finger_key] = int(fsr_value)

    def read_from_arduino_forever(self, port_name, hand):
        """
        Reconnect loop.

        This is hackathon-friendly:
        - start server before plugging Arduino
        - unplug/replug Arduino
        - server keeps trying
        """
        while True:
            try:
                self.read_from_arduino_once(port_name, hand)

            except Exception as error:
                print(f"{hand.capitalize()} Arduino disconnected/error on {port_name}: {error}")
                self.set_connected(hand, False)
                time.sleep(2)

    def read_from_arduino_once(self, port_name, hand):
        ser = serial.Serial(port_name, BAUD_RATE, timeout=1)
        time.sleep(2)

        self.set_connected(hand, True)
        print(f"{hand.capitalize()} Arduino connected on {port_name}")

        while True:
            raw_line = ser.readline().decode("utf-8", errors="ignore").strip()

            if not raw_line:
                continue

            parts = raw_line.split(",")

            if len(parts) != 2:
                continue

            try:
                finger_index = int(parts[0])
                fsr_value = int(parts[1])
            except ValueError:
                continue

            self.update_value(hand, finger_index, fsr_value)

    def get_snapshot(self):
        """
        Returns normalized FSR state:

        {
          fsr: {
            left_index: true,
            right_middle: false,
            ...
          },
          fsrRaw: {
            left_index: 530,
            ...
          },
          fsrConnected: {
            left: true,
            right: false
          }
        }
        """
        with self.lock:
            raw_copy = dict(self.raw)
            connected_copy = dict(self.connected)

        fsr_bool = {
            finger_key: raw_value >= self.threshold
            for finger_key, raw_value in raw_copy.items()
        }

        return {
            "fsr": fsr_bool,
            "fsrRaw": raw_copy,
            "fsrConnected": connected_copy,
        }