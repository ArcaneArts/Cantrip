#!/usr/bin/python3
"""Destructive acceptance for an explicitly disposable, attached CantripOS."""
import argparse
import ctypes
import json
import os
from pathlib import Path
import select
import signal
import socket
import struct
import stat
import subprocess
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--package", required=True)
parser.add_argument("--workspace", default="cua-a")
parser.add_argument("--other-workspace", default="cua-b")
args = parser.parse_args()


def command(*argv, check=True):
    return subprocess.run(argv, check=check, capture_output=True, text=True)


def remote(*argv):
    return json.loads(command("cantrip-remote", *argv).stdout)


def wait(predicate):
    until = time.monotonic() + 30
    while True:
        try:
            if predicate():
                return
        except subprocess.CalledProcessError as error:
            # The service can own its lifetime lock before binding control.
            if "Resource temporarily unavailable" not in (error.stderr or ""):
                raise
        if time.monotonic() > until:
            raise RuntimeError("Actual remote state did not converge")
        time.sleep(.025)


class Native:
    def __init__(self, context):
        self.context = context
        self.connection_id = str(uuid.uuid4())
        self.child = subprocess.Popen(["cantrip-remote", "connect", context["workspace_id"], "--expect", json.dumps(context),
                                       "--connection-id", self.connection_id],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.sequence = 0
        inventory = self.call({"operation": "targets.list", "allowCantripApp": True})[0]["targets"]
        self.target = inventory[0]
        self.binding = {"sessionId": "remote-test-" + str(self.child.pid), "workerId": context["worker_id"],
                        "chatId": "fixture", "taskId": None, "threadId": None, "turnId": None}
        self.identity = {"binding": self.binding, "targetId": self.target["id"], "targetGeneration": self.target["generation"]}
        self.call({"operation": "target.attach", "allowCantripApp": True, **self.identity})
        helpers = command("pgrep", "-u", str(context["uid"]), "-f", "^/usr/lib/cantrip-os-remote/cantrip-cua ").stdout.split()
        assert len(helpers) == 1
        # Read as the actual helper UID: Docker root need not have CAP_SYS_PTRACE.
        command("runuser", "-u", context["user"], "--", "python3", "-c", """
import sys
from pathlib import Path
environment = dict(entry.split(b'=', 1) for entry in Path(sys.argv[1]).read_bytes().split(b'\\0') if entry)
assert environment[b'HOME'].decode() == sys.argv[2]
assert environment[b'DISPLAY'].decode() == sys.argv[3]
assert set(environment) <= {key.encode() for key in ('LANG', 'LC_ALL', 'TZ', 'HOME', 'USER', 'LOGNAME', 'PATH', 'DISPLAY', 'XDG_RUNTIME_DIR')}
""", "/proc/" + helpers[0] + "/environ", context["home"], ":" + str(context["display"]))

    def send(self, operation):
        self.sequence += 1
        header = json.dumps({"version": 1, "message": {"kind": "request", "requestId": self.sequence,
                                                       "operation": operation}}).encode()
        self.child.stdin.write(struct.pack("!II", len(header), 0) + header)
        self.child.stdin.flush()
        return self.sequence

    def read(self, size):
        result = bytearray()
        while len(result) < size:
            if not select.select([self.child.stdout], [], [], 30)[0]:
                raise RuntimeError("Native response timeout")
            chunk = os.read(self.child.stdout.fileno(), size - len(result))
            if not chunk:
                raise RuntimeError("Native carrier ended: " + self.child.stderr.read(2048).decode())
            result.extend(chunk)
        return bytes(result)

    def call(self, operation):
        request = self.send(operation)
        while True:
            header_size, payload_size = struct.unpack("!II", self.read(8))
            assert header_size <= 16 * 1024 * 1024 and payload_size <= 16 * 1024 * 1024
            message = json.loads(self.read(header_size))["message"]
            payload = self.read(payload_size)
            if message["kind"] != "response":
                continue
            assert message["requestId"] == request
            result = message["result"]
            assert result["status"] == "ok", result
            return result["data"], payload

    def hold(self):
        self.send({"operation": "input.perform", **self.identity,
                   "command": {"kind": "prepared-press", "point": {"x": 500, "y": 500}, "holdMs": 60000}})

    def close(self, killed=False):
        if killed:
            self.child.kill()
        else:
            self.child.stdin.close()
        self.child.wait(timeout=25)


class Pointer:
    def __init__(self, display):
        self.lib = ctypes.CDLL("libX11.so.6")
        self.lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        self.lib.XOpenDisplay.restype = ctypes.c_void_p
        self.lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        self.lib.XDefaultRootWindow.restype = ctypes.c_ulong
        self.lib.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong] + [ctypes.c_void_p] * 7
        self.display = self.lib.XOpenDisplay((":" + str(display)).encode())
        if not self.display:
            raise RuntimeError("The actual assigned X display could not be opened")
        self.root = self.lib.XDefaultRootWindow(self.display)

    def mask(self):
        windows = [ctypes.c_ulong(), ctypes.c_ulong()]
        points = [ctypes.c_int() for _ in range(4)]
        mask = ctypes.c_uint()
        assert self.lib.XQueryPointer(self.display, self.root, *[ctypes.byref(v) for v in windows + points], ctypes.byref(mask))
        return mask.value

    def position(self):
        windows = [ctypes.c_ulong(), ctypes.c_ulong()]
        points = [ctypes.c_int() for _ in range(4)]
        mask = ctypes.c_uint()
        assert self.lib.XQueryPointer(self.display, self.root, *[ctypes.byref(v) for v in windows + points], ctypes.byref(mask))
        return points[0].value, points[1].value


command("cantrip-executor", "status")
executor_state = Path(json.loads(Path("/etc/cantrip-os/executor.json").read_text())["state_dir"])
assert stat.S_IMODE(executor_state.stat().st_mode) == 0o700
context = remote("open", args.workspace)
assert stat.S_IMODE(executor_state.stat().st_mode) == 0o700
other = remote("open", args.other_workspace)
assert context["uid"] != other["uid"] and context["display"] != other["display"]
pointer = Pointer(context["display"])
second = Pointer(other["display"])
second_mask = second.mask()
first = Native(context)
_, image = first.call({"operation": "observation.snapshot", **first.identity})
assert image.startswith(b"\x89PNG\r\n\x1a\n")
other_native = Native(other)
text = "Cantrip clipboard 日本語 café 🦀\n" + "".join(chr(0x4e00 + i) for i in range(512)) + "x" * 70000
first.call({"operation": "clipboard.write", **first.identity, "text": text})
assert first.call({"operation": "clipboard.read", **first.identity})[0]["text"] == text
other_native.call({"operation": "clipboard.write", **other_native.identity, "text": "Other workspace clipboard"})
assert first.call({"operation": "clipboard.read", **first.identity})[0]["text"] == text
assert other_native.call({"operation": "clipboard.read", **other_native.identity})[0]["text"] == "Other workspace clipboard"
before_other = second.position()
first.call({"operation": "input.perform", **first.identity, "command": {"kind": "move", "point": {"x": 321, "y": 234}}})
wait(lambda: pointer.position() == (321, 234))
assert second.position() == before_other
old_target = first.target.copy()
resized = first.call({"operation": "desktop.resize", **first.identity, "width": 1280, "height": 720})[0]["session"]["target"]
assert (resized["pixelWidth"], resized["pixelHeight"]) == (1280, 720)
assert (resized["id"], resized["generation"]) == (old_target["id"], old_target["generation"])
_, resized_png = first.call({"operation": "observation.snapshot", **first.identity})
assert struct.unpack("!II", resized_png[16:24]) == (1280, 720)
other_shot, _ = other_native.call({"operation": "observation.snapshot", **other_native.identity})
assert other_shot["session"]["target"]["pixelWidth"] == other_native.target["pixelWidth"]
first.call({"operation": "desktop.resize", **first.identity, "width": 1440, "height": 900})
for operation in ({"operation": "clipboard.write", "text": "must not replace"},
                  {"operation": "desktop.resize", "width": 800, "height": 600}):
    try:
        first.call({**first.identity, **operation, "targetGeneration": first.target["generation"] + 1})
        raise RuntimeError("A stale desktop operation was accepted")
    except AssertionError as error:
        assert "stale-target" in str(error)
assert first.call({"operation": "clipboard.read", **first.identity})[0]["text"] == text
other_native.close()
print("PASS large Unicode clipboard isolation, physical pointer movement, live resize and stale operation rejection", flush=True)
first.hold()
wait(lambda: pointer.mask() & 256)
first.close()
wait(lambda: not pointer.mask() & 256)
wait(lambda: not remote("status")["connections"])
assert second.mask() == second_mask
print("PASS actual capture, EOF releases held button, other display unaffected", flush=True)

retired = Native(context)
retired.hold()
wait(lambda: pointer.mask() & 256)
command("cantrip-remote", "close", args.workspace, "--expect", json.dumps(context), "--connection-id", retired.connection_id)
retired.child.wait(timeout=25)
wait(lambda: not pointer.mask() & 256)
replacement_connection = Native(context)
replacement_connection.hold()
wait(lambda: pointer.mask() & 256)
late = command("cantrip-remote", "close", args.workspace, "--expect", json.dumps(context), "--connection-id", retired.connection_id, check=False)
assert late.returncode != 0 and "generation mismatch" in late.stderr
assert pointer.mask() & 256
replacement_connection.close()
wait(lambda: not pointer.mask() & 256)
wait(lambda: not remote("status")["connections"])
print("PASS exact connection retirement and late cleanup cannot stop its replacement", flush=True)

second_connection = Native(context)
second_connection.hold()
wait(lambda: pointer.mask() & 256)
second_connection.close(killed=True)
wait(lambda: not pointer.mask() & 256)
wait(lambda: not remote("status")["connections"])
print("PASS abrupt carrier death releases held button", flush=True)

third = Native(context)
third.hold()
wait(lambda: pointer.mask() & 256)
with socket.socket(socket.AF_UNIX) as control:
    control.connect("/run/cantrip-os-remote/control.sock")
    pid, uid, _ = struct.unpack("3i", control.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    assert uid == 0
    pidfd = os.pidfd_open(pid)
    try:
        signal.pidfd_send_signal(pidfd, signal.SIGKILL)
    finally:
        os.close(pidfd)
wait(lambda: not pointer.mask() & 256)
third.child.wait(timeout=25)
command("cantrip-remote", "service", "start")
new_context = remote("show", args.workspace)
assert new_context["remote_generation"] != context["remote_generation"]
stale = command("cantrip-remote", "connect", args.workspace, "--expect", json.dumps(context), check=False)
assert stale.returncode != 0 and "generation mismatch" in stale.stderr
print("PASS manager death guardian cleanup and actual stale generation rejection", flush=True)

idle = Native(new_context)
shell = subprocess.Popen(["runuser", "-u", new_context["user"], "--", "sleep", "120"],
                         start_new_session=True)
try:
    command("cantrip-workspaces", "stop", args.workspace)
    wait(lambda: idle.child.poll() is not None)
    wait(lambda: not remote("status")["connections"])
    assert shell.poll() is None
    assert second.mask() == second_mask
    expected = {key: new_context[key] for key in ("instance_id", "generation", "owner_id", "worker_id", "workspace_id", "uid", "gid", "home")}
    wrong = {**expected, "generation": str(uuid.uuid4())}
    denied = command("cantrip-remote", "open", args.workspace, "--expect-placement", json.dumps(wrong), check=False)
    assert denied.returncode != 0 and "generation mismatch" in denied.stderr
    assert json.loads(command("cantrip-workspaces", "show", args.workspace).stdout)["status"] == "stopped"
    context = remote("open", args.workspace, "--expect-placement", json.dumps(expected))
    assert context["desktop_generation"] != new_context["desktop_generation"]
    stale = command("cantrip-remote", "connect", args.workspace, "--expect", json.dumps(new_context), check=False)
    assert stale.returncode != 0 and "generation mismatch" in stale.stderr
finally:
    os.killpg(shell.pid, signal.SIGTERM)
    shell.wait(timeout=10)
pointer = Pointer(context["display"])
print("PASS desktop stop closes idle carrier, retains independent shell and rejects old desktop", flush=True)

for field in ("owner_id", "worker_id", "instance_id", "workspace_id", "generation", "desktop_generation", "remote_generation"):
    wrong = {**context, field: "not-the-selected-identity"}
    denied = command("cantrip-remote", "connect", args.workspace, "--expect", json.dumps(wrong), check=False)
    assert denied.returncode != 0 and "generation mismatch" in denied.stderr
assert not remote("status")["connections"]
print("PASS exact owner, Worker, instance, workspace and generation binding", flush=True)

runtime = Native(context)
runtime.hold()
wait(lambda: pointer.mask() & 256)
command("cantrip-executor", "service", "restart")
wait(lambda: runtime.child.poll() is not None)
wait(lambda: not pointer.mask() & 256)
wait(lambda: not remote("status")["connections"])
replacement = remote("show", args.workspace)
assert replacement["generation"] != context["generation"]
stale = command("cantrip-remote", "connect", args.workspace, "--expect", json.dumps(context), check=False)
assert stale.returncode != 0 and "generation mismatch" in stale.stderr
context = replacement
assert second.mask() == second_mask
print("PASS executor-service retirement closes carrier and releases held input without retargeting", flush=True)

sentinel = Path(context["home"]) / "Documents/remote-retained.txt"
sentinel.write_text("remote package retained workspace data\n")
command("cantrip-remote", "disable")
assert remote("status")["enabled"] is False
command("dpkg", "-r", "cantrip-os-remote")
assert sentinel.read_text() == "remote package retained workspace data\n"
assert pointer.mask() >= 0 and second.mask() == second_mask
command("dpkg", "-i", args.package)
assert remote("status")["enabled"] is False
command("cantrip-remote", "enable")
assert remote("status")["service"] == "running"
print("PASS disable/remove/reinstall preserves preference, data and desktops", flush=True)

command("dpkg", "-i", args.package)
wait(lambda: remote("status")["service"] == "running")
command("cantrip-remote", "disable")
state = Path(json.loads(Path("/etc/cantrip-os/remote.json").read_text())["state_dir"])
settings = state / "settings.json"
preference = settings.read_bytes()
command("dpkg", "--purge", "cantrip-os-remote")
assert settings.read_bytes() == preference
assert sentinel.read_text() == "remote package retained workspace data\n"
command("dpkg", "-i", args.package)
assert remote("status")["enabled"] is False
settings.write_text('{"version":99,"enabled":true}\n')
unsupported = command("cantrip-remote", "service", "start", check=False)
assert unsupported.returncode != 0
assert json.loads(settings.read_text())["version"] == 99
settings.write_bytes(preference)
command("cantrip-remote", "enable")
assert remote("status")["service"] == "running"
valid = settings.read_bytes()
settings.write_text('{"version":99,"enabled":true}\n')
command("cantrip-remote", "service", "stop")
assert json.loads(settings.read_text())["version"] == 99
settings.write_bytes(valid)
command("cantrip-remote", "service", "start")
nonroot = command("runuser", "-u", context["user"], "--", "cantrip-remote", "status", check=False)
assert nonroot.returncode != 0
assert stat.S_IMODE(executor_state.stat().st_mode) == 0o700
assert pointer.mask() >= 0 and second.mask() == second_mask
assert sentinel.read_text() == "remote package retained workspace data\n"
print("PASS running upgrade, purge/reinstall, preserved unknown state and root-only administration", flush=True)
