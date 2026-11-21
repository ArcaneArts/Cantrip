"""Framed helper check with a real Weston output and a controlled portal.

Run inside a disposable D-Bus session with Weston and python3-dbus installed.
"""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time
import zlib

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib


NAME = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
REMOTE = "org.freedesktop.portal.RemoteDesktop"
CAST = "org.freedesktop.portal.ScreenCast"
REQUEST = "org.freedesktop.portal.Request"
SESSION = "org.freedesktop.portal.Session"
CLIPBOARD = "org.freedesktop.portal.Clipboard"
FIXTURE = "org.cantrip.PortalFixture"
COPIED = "selected λ🚋\n"


class Request(dbus.service.Object):
    def __init__(self, portal, path):
        super().__init__(portal.name, path)
        self.portal = portal
        self.closed = False

    @dbus.service.signal(REQUEST, signature="ua{sv}")
    def Response(self, status, results):
        pass

    @dbus.service.method(REQUEST)
    def Close(self):
        self.closed = True
        self.portal.events.append(["request-close"])


class Session(dbus.service.Object):
    def __init__(self, portal, path):
        super().__init__(portal.name, path)
        self.portal = portal

    @dbus.service.method(SESSION)
    def Close(self):
        self.portal.events.append(["session-close"])

    @dbus.service.signal(SESSION, signature="a{sv}")
    def Closed(self, details):
        pass


class Portal(dbus.service.Object):
    def __init__(self, root):
        self.name = dbus.service.BusName(NAME, dbus.SessionBus())
        super().__init__(self.name, PATH)
        self.root = root
        self.events = []
        self.requests = []
        self.sessions = []
        self.mode = "allow"

    def request(self, sender, options):
        path = self.path("request", sender, options["handle_token"])
        request = Request(self, path)
        self.requests.append(request)
        return path, request

    @staticmethod
    def path(scope, sender, token):
        return f"{PATH}/{scope}/{sender.lstrip(':').replace('.', '_')}/{token}"

    @dbus.service.method(FIXTURE, in_signature="s")
    def SetMode(self, mode):
        self.mode = str(mode)

    @dbus.service.method(FIXTURE, out_signature="s")
    def Events(self):
        return json.dumps(self.events)

    @dbus.service.method(FIXTURE, in_signature="b")
    def CloseFromPortal(self, unrelated):
        if unrelated:
            session = Session(self, f"{PATH}/session/foreign/unused")
            session.Closed({})
            session.remove_from_connection()
        else:
            self.events.append(["host-close"])
            self.sessions[-1].Closed({})

    @dbus.service.method("org.freedesktop.DBus.Properties", in_signature="ss", out_signature="v")
    def Get(self, interface, name):
        assert (interface, name) == (REMOTE, "AvailableDeviceTypes")
        return dbus.UInt32(3)

    @dbus.service.method(REMOTE, in_signature="a{sv}", out_signature="o", sender_keyword="sender")
    def CreateSession(self, options, sender=None):
        path = self.path("session", sender, options["session_handle_token"])
        self.sessions.append(Session(self, path))
        request_path, request = self.request(sender, options)
        self.events.append(["create"])
        request.Response(0, {"session_handle": dbus.String(path)})
        return request_path

    @dbus.service.method(REMOTE, in_signature="oa{sv}", out_signature="o", sender_keyword="sender")
    def SelectDevices(self, session, options, sender=None):
        assert options["types"] == 3
        return self.accept(sender, options)

    @dbus.service.method(CAST, in_signature="oa{sv}", out_signature="o", sender_keyword="sender")
    def SelectSources(self, session, options, sender=None):
        assert options["types"] == 1 and not options["multiple"]
        return self.accept(sender, options)

    def accept(self, sender, options):
        path, request = self.request(sender, options)
        request.Response(0, {})
        return path

    @dbus.service.method(CLIPBOARD, in_signature="oa{sv}")
    def RequestClipboard(self, session, options):
        self.events.append(["clipboard-request"])

    @dbus.service.method(REMOTE, in_signature="osa{sv}", out_signature="o", sender_keyword="sender")
    def Start(self, session, parent, options, sender=None):
        path, request = self.request(sender, options)
        decision = self.mode
        self.events.append(["start", decision])

        def answer():
            if request.closed:
                return False
            if decision == "deny":
                request.Response(1, {})
                return False
            position = dbus.Struct((400, 0) if decision == "wrong" else (0, 0), signature="ii")
            stream = dbus.Dictionary({
                "position": position,
                "size": dbus.Struct((640, 480), signature="ii"),
                "source_type": dbus.UInt32(1),
            }, signature="sv")
            request.Response(0, {
                "devices": dbus.UInt32(3),
                "clipboard_enabled": dbus.Boolean(True),
                "streams": dbus.Array([(dbus.UInt32(71), stream)], signature="(ua{sv})"),
            })
            return False

        GLib.timeout_add(1400 if decision in ("allow", "cancel") else 5, answer)
        return path

    @dbus.service.method("org.freedesktop.portal.Screenshot", in_signature="sa{sv}", out_signature="o", sender_keyword="sender")
    def Screenshot(self, parent, options, sender=None):
        def chunk(kind, data):
            return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))

        output = self.root / "frame.png"
        image = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!2I5B", 640, 480, 8, 2, 0, 0, 0))
        image += chunk(b"IDAT", zlib.compress((b"\x00" + b"\x29\x62\xa3" * 640) * 480))
        output.write_bytes(image + chunk(b"IEND", b""))
        path, request = self.request(sender, options)
        request.Response(0, {"uri": dbus.String(output.as_uri())})
        return path

    @dbus.service.method(REMOTE, in_signature="oa{sv}udd")
    def NotifyPointerMotionAbsolute(self, session, options, stream, x, y):
        self.events.append(["motion", int(stream), float(x), float(y)])

    @dbus.service.method(REMOTE, in_signature="oa{sv}iu")
    def NotifyPointerButton(self, session, options, button, state):
        self.events.append(["button", int(button), int(state)])

    @dbus.service.method(REMOTE, in_signature="oa{sv}dd")
    def NotifyPointerAxis(self, session, options, x, y):
        self.events.append(["scroll", float(x), float(y), bool(options["finish"])])

    @dbus.service.signal(CLIPBOARD, signature="oa{sv}")
    def SelectionOwnerChanged(self, session, options):
        pass

    @dbus.service.method(REMOTE, in_signature="oa{sv}iu")
    def NotifyKeyboardKeysym(self, session, options, key, state):
        self.events.append(["key", int(key), int(state)])
        if self.mode == "allow" and key == ord("c") and state:
            formats = {"mime_types": dbus.Array(["text/plain;charset=utf-8"], signature="s")}
            self.SelectionOwnerChanged(dbus.ObjectPath(f"{PATH}/session/foreign/unused"), formats)
            self.SelectionOwnerChanged(session, formats)

    @dbus.service.method(CLIPBOARD, in_signature="os", out_signature="h")
    def SelectionRead(self, session, mime):
        assert mime == "text/plain;charset=utf-8"
        self.events.append(["clipboard-read"])
        reader, writer = os.pipe()
        os.write(writer, COPIED.encode())
        os.close(writer)
        fd = dbus.types.UnixFd(reader)
        os.close(reader)
        return fd


def wait(async_condition):
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        value = async_condition()
        if value:
            return value
        time.sleep(0.04)
    raise AssertionError("Timed out waiting for the expected local portal request")


def exercise(helper, control, root, env):
    with subprocess.Popen([helper], env={**env, "PATH": ""}, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as child:
        request_id = 0

        def call(operation, **fields):
            nonlocal request_id
            request_id += 1
            header = json.dumps({"version": 1, "message": {
                "kind": "request", "requestId": request_id, "operation": {"operation": operation, **fields}
            }}).encode()
            child.stdin.write(struct.pack("!II", len(header), 0) + header)
            child.stdin.flush()
            while True:
                size, payload = struct.unpack("!II", child.stdout.read(8))
                message = json.loads(child.stdout.read(size))["message"]
                pixels = child.stdout.read(payload)
                if message["kind"] == "response":
                    assert message["requestId"] == request_id
                    return message["result"], pixels

        def ok(operation, **fields):
            result, pixels = call(operation, **fields)
            assert result["status"] == "ok", result
            return result["data"], pixels

        def events():
            return json.loads(control.Events())

        assert ok("capabilities.get")[0]["hostMonitorInput"]
        target = next(t for t in ok("targets.list")[0]["targets"] if t["kind"] == "monitor")
        scope = {"workerId": "fixture", "surfaceId": "surface", "attachmentId": "viewer", "participantId": "viewer"}
        other = dict(scope, attachmentId="other")
        target_fields = {"targetId": target["id"], "targetGeneration": target["generation"]}

        def attach(binding):
            return call("interaction.request", request={"type": "open", "binding": binding, **target_fields})[0]

        def terminal(binding):
            result = attach(binding)
            return result if result.get("error", {}).get("code") not in ("input-pending", "ownership-mismatch") else None

        def close(binding):
            ok("interaction.request", request={"type": "closeBinding", "binding": binding})

        assert attach(scope)["error"]["code"] == "input-pending"
        wait(lambda: ["start", "allow"] in events())
        assert attach(other)["error"]["code"] == "ownership-mismatch"
        capture, _ = ok("capture.request", request={"type": "open", "binding": scope, **target_fields})
        _, png = ok("capture.request", request={"type": "frame", "binding": scope, "handle": capture["handle"]})
        assert png.startswith(b"\x89PNG")
        assert not (root / "frame.png").exists()

        opened = wait(lambda: terminal(scope))
        assert opened["status"] == "ok", opened
        handle = opened["data"]["handle"]
        assert attach(other)["error"]["code"] == "ownership-mismatch"

        def input_event(sequence, kind, **data):
            ok("interaction.request", request={"type": "input", "binding": scope, "handle": handle,
                "sequence": sequence, "event": {"type": kind, "data": data}})

        point = {"x": 18.5, "y": 24.5}
        input_event(1, "pointerDown", point=point, button="left", modifiers=[])
        input_event(2, "scroll", point=point, deltaX=7, deltaY=-12, modifiers=[])
        input_event(3, "text", type="commit", data="λ")
        copied, _ = ok("interaction.request", request={"type": "clipboardCopy", "binding": scope, "handle": handle, "sequence": 5})
        assert copied["text"] == COPIED
        control.SetMode("no-new-clipboard")
        copied, _ = ok("interaction.request", request={"type": "clipboardCopy", "binding": scope, "handle": handle, "sequence": 7})
        assert copied["text"] is None
        input_event(8, "keyDown", key="Shift", repeat=False, modifiers=[])
        close(scope)
        log = events()
        assert ["motion", 71, 18.5, 24.5] in log
        assert ["scroll", 7.0, -12.0, True] in log
        assert ["key", 0x010003BB, 1] in log
        assert log.count(["clipboard-read"]) == 1
        assert log.index(["button", 272, 0]) < log.index(["session-close"])
        assert log.index(["key", 0xFFE1, 0]) < log.index(["session-close"])

        control.SetMode("allow")
        assert attach(scope)["error"]["code"] == "input-pending"
        opened = wait(lambda: terminal(scope))
        assert opened["status"] == "ok", opened
        handle = opened["data"]["handle"]
        control.CloseFromPortal(True)
        assert attach(other)["error"]["code"] == "ownership-mismatch"
        input_event(1, "keyDown", key="Shift", repeat=False, modifiers=[])

        control.CloseFromPortal(False)

        def replacement_open():
            result = attach(other)
            return result if result.get("error", {}).get("code") != "ownership-mismatch" else None

        assert wait(replacement_open)["error"]["code"] == "input-pending"
        retired, _ = call("interaction.request", request={
            "type": "input", "binding": scope, "handle": handle, "sequence": 2,
            "event": {"type": "keyUp", "data": {"key": "Shift"}},
        })
        assert retired["error"]["code"] == "session-not-found"
        _, png = ok("capture.request", request={"type": "frame", "binding": scope, "handle": capture["handle"]})
        assert png.startswith(b"\x89PNG")
        replacement = wait(lambda: terminal(other))
        assert replacement["status"] == "ok", replacement
        assert replacement["data"]["handle"] != handle
        close(other)
        log = events()
        assert ["key", 0xFFE1, 0] not in log[log.index(["host-close"]):]

        control.SetMode("deny")
        assert attach(scope)["error"]["code"] == "input-pending"
        assert wait(lambda: terminal(scope))["error"]["code"] == "permission-denied"
        close(scope)
        control.SetMode("wrong")
        assert attach(scope)["error"]["code"] == "input-pending"
        assert wait(lambda: terminal(scope))["error"]["code"] == "permission-denied"
        close(scope)
        control.SetMode("cancel")
        assert attach(scope)["error"]["code"] == "input-pending"
        wait(lambda: ["start", "cancel"] in events())
        close(scope)
        wait(lambda: ["request-close"] in events() and events().count(["session-close"]) == 5)
        assert events().count(["create"]) == 6
        child.stdin.close()
        assert child.wait(timeout=5) == 0


if __name__ == "__main__":
    DBusGMainLoop(set_as_default=True)
    if sys.argv[1] == "--portal":
        portal = Portal(Path(sys.argv[2]))
        GLib.MainLoop().run()
    else:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {key: value for key, value in os.environ.items() if key not in ("DISPLAY", "WAYLAND_SOCKET")}
            env.update(XDG_RUNTIME_DIR=directory, WAYLAND_DISPLAY="portal-fixture", XDG_SESSION_TYPE="wayland")
            with subprocess.Popen(["weston", "--backend=headless", "--renderer=pixman", "--width=640",
                "--height=480", "--idle-time=0", "--socket=portal-fixture", "--log=" + str(root / "weston.log")], env=env) as weston:
                with subprocess.Popen([sys.executable, __file__, "--portal", directory], env=env) as portal:
                    try:
                        wait(lambda: (root / "portal-fixture").exists() and dbus.SessionBus().name_has_owner(NAME))
                        control = dbus.Interface(dbus.SessionBus().get_object(NAME, PATH), FIXTURE)
                        exercise(sys.argv[1], control, root, env)
                        print("Wayland portal control and screenshot checks passed.")
                    finally:
                        portal.terminate()
                        weston.terminate()
