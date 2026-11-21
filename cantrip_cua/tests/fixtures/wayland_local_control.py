"""Exercise the framed helper on a disposable two-output Sway desktop.

Run as a non-root user with Sway, Xwayland, xev and wl-clipboard installed.
A local datagram socket records the ydotoold protocol without a uinput device.
"""

import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time


COPIED = "selected λ🚋\n"
PASTED = "pasted λ🚋\n"


def wait(predicate):
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.03)
    raise AssertionError("Timed out waiting for the local Sway fixture")


class Helper:
    def __init__(self, process):
        self.process = process
        self.sequence = 0

    def call(self, operation, **fields):
        self.sequence += 1
        header = json.dumps({"version": 1, "message": {
            "kind": "request", "requestId": self.sequence,
            "operation": {"operation": operation, **fields},
        }}).encode()
        self.process.stdin.write(struct.pack("!II", len(header), 0) + header)
        self.process.stdin.flush()
        while True:
            size, payload = struct.unpack("!II", self.process.stdout.read(8))
            message = json.loads(self.process.stdout.read(size))["message"]
            data = self.process.stdout.read(payload)
            if message["kind"] == "response":
                assert message["requestId"] == self.sequence
                return message["result"], data

    def ok(self, operation, **fields):
        result, data = self.call(operation, **fields)
        assert result["status"] == "ok", result
        return result["data"], data


def exercise(helper, keyboard, env, root):
    events = []
    sources = []
    acknowledge_copy = threading.Event()
    acknowledge_copy.set()
    stop = threading.Event()

    def receive_keys():
        keyboard.settimeout(0.1)
        while not stop.is_set():
            try:
                event = keyboard.recv(32)
            except TimeoutError:
                continue
            kind, key, state = struct.unpack("=HHi", event[-8:])
            events.append((kind, key, state))
            if (kind, key, state) == (1, 46, 1) and acknowledge_copy.is_set():
                acknowledge_copy.clear()
                copy = subprocess.Popen(["wl-copy", "--foreground"], env=env, stdin=subprocess.PIPE)
                sources.append(copy)
                copy.stdin.write(COPIED.encode())
                copy.stdin.close()

    receiver = threading.Thread(target=receive_keys)
    receiver.start()
    try:
        with subprocess.Popen([helper], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as child:
            try:
                verify(Helper(child), events, env, root)
                child.stdin.close()
                assert child.wait(timeout=5) == 0
            finally:
                if child.poll() is None:
                    child.kill()
    finally:
        stop.set()
        receiver.join(timeout=2)
        for source in sources:
            source.terminate()
            source.wait(timeout=3)


def verify(cua, keys, env, root):
    assert cua.ok("capabilities.get")[0]["hostMonitorInput"]
    monitors = [t for t in cua.ok("targets.list")[0]["targets"] if t["kind"] == "monitor"]
    assert len(monitors) == 2, monitors
    selected = next(t for t in monitors if t["bounds"]["x"] == 640)
    other = next(t for t in monitors if t["bounds"]["x"] == 0)
    scope = {"workerId": "fixture", "surfaceId": "surface", "attachmentId": "viewer", "participantId": "viewer"}
    waiting = dict(scope, attachmentId="other", participantId="other")

    def target_fields(target):
        return {"targetId": target["id"], "targetGeneration": target["generation"]}

    capture, _ = cua.ok("capture.request", request={"type": "open", "binding": scope, **target_fields(selected)})
    _, image = cua.ok("capture.request", request={"type": "frame", "binding": scope, "handle": capture["handle"]})
    assert image.startswith(b"\x89PNG")
    opened, _ = cua.ok("interaction.request", request={"type": "open", "binding": scope, **target_fields(selected)})
    request_for_other = {"type": "open", "binding": waiting, **target_fields(other)}
    denied, _ = cua.call("interaction.request", request=request_for_other)
    assert denied["error"]["code"] == "ownership-mismatch", denied

    def send(sequence, kind, **data):
        cua.ok("interaction.request", request={"type": "input", "binding": scope, "handle": opened["handle"],
            "sequence": sequence, "event": {"type": kind, "data": data}})

    def copy(sequence):
        result, _ = cua.ok("interaction.request", request={"type": "clipboardCopy", "binding": scope,
            "handle": opened["handle"], "sequence": sequence})
        return result["text"]

    def delivered(pattern):
        return re.search(pattern, (root / "xev.log").read_text(), re.DOTALL)

    point = {"x": 240, "y": 160}
    send(1, "pointerDown", point=point, button="left", modifiers=[])
    wait(lambda: delivered(r"ButtonPress event[^\n]*\n[^\n]*root:\(880,160\)[^\n]*\n[^\n]*button 1,"))
    assert copy(3) == COPIED
    assert copy(5) is None
    send(6, "text", type="commit", data=PASTED)
    assert subprocess.check_output(["wl-paste", "--no-newline"], env=env).decode() == PASTED
    send(7, "keyDown", key="Shift", repeat=False, modifiers=[])
    cua.ok("interaction.request", request={"type": "closeBinding", "binding": scope})
    wait(lambda: (1, 42, 0) in keys and delivered(r"ButtonRelease event[^\n]*\n[^\n]*root:\(880,160\)[^\n]*\n[^\n]*button 1,"))
    assert [entry for entry in keys if entry[0] == 1] == [
        (1, 29, 1), (1, 46, 1), (1, 46, 0), (1, 29, 0),
        (1, 29, 1), (1, 46, 1), (1, 46, 0), (1, 29, 0),
        (1, 29, 1), (1, 47, 1), (1, 47, 0), (1, 29, 0),
        (1, 42, 1), (1, 42, 0),
    ], keys
    assert keys[1::2] == [(0, 0, 0)] * (len(keys) // 2), keys
    cua.ok("interaction.request", request=request_for_other)
    cua.ok("interaction.request", request={"type": "closeBinding", "binding": waiting})


def main(helper):
    with tempfile.TemporaryDirectory() as directory, socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as keyboard:
        root = Path(directory)
        keyboard.bind(str(root / "keyboard"))
        env = {key: value for key, value in os.environ.items()
            if key not in ("DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "SWAYSOCK")}
        env.update(XDG_RUNTIME_DIR=directory, XDG_SESSION_TYPE="wayland", YDOTOOL_SOCKET=str(root / "keyboard"),
            WLR_BACKENDS="headless", WLR_RENDERER="pixman", WLR_LIBINPUT_NO_DEVICES="1", WLR_HEADLESS_OUTPUTS="2")
        config = root / "sway.conf"
        config.write_text(f"""output HEADLESS-1 mode 640x480 position 0 0
output HEADLESS-2 mode 640x480 position 640 0
workspace one output HEADLESS-1
workspace two output HEADLESS-2
assign [title=\"Cantrip fixture\"] workspace two
default_border none
exec stdbuf -o0 xev -name 'Cantrip fixture' > {root}/xev.log 2>&1
""")
        with (root / "sway.log").open("wb") as log:
            with subprocess.Popen(["sway", "-c", str(config)], env=env, stdout=log, stderr=log) as sway:
                try:
                    wayland = wait(lambda: next((p for p in root.glob("wayland-*") if p.is_socket()), None))
                    env["WAYLAND_DISPLAY"] = wayland.name
                    wait(lambda: (root / "xev.log").exists() and "MapNotify" in (root / "xev.log").read_text())
                    exercise(helper, keyboard, env, root)
                except Exception:
                    for name in ("sway.log", "xev.log"):
                        path = root / name
                        if path.exists():
                            print(path.read_text()[-5000:], file=sys.stderr)
                    raise
                finally:
                    sway.terminate()
    print("Wayland local capture, pointer, clipboard and input ownership checks passed.")


if __name__ == "__main__":
    main(sys.argv[1])
