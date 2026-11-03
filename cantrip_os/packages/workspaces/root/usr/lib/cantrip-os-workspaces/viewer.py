#!/usr/bin/python3
"""Package-owned local workspace UI and generation-bound noVNC gateway."""
import ctypes
import json
import os
from pathlib import Path
import signal
import sys
from urllib.parse import parse_qs, urlsplit
from websockify.websocketproxy import ProxyRequestHandler, WebSocketProxy
from service import Store, request

store = Store(sys.argv[2])
parent = int(sys.argv[1])
libc = ctypes.CDLL(None, use_errno=True)
libc.prctl.argtypes = [ctypes.c_int] + [ctypes.c_ulong] * 4


def parent_signal(pid):
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "PR_SET_PDEATHSIG")
    if os.getppid() != pid:
        raise RuntimeError("Parent exited during viewer startup")


class Targets:
    def lookup(self, token):
        name, separator, secret = token.partition(".")
        if not separator:
            return None
        try:
            record = request(store, "show", name)
            if record["status"] == "running" and secret == record.get("view_token"):
                return ("unix_socket", record["vnc_socket"])
        except (OSError, ValueError, RuntimeError):
            pass
        return None


class Handler(ProxyRequestHandler):
    def __init__(self, *args, **kwargs):
        parent_signal(server.owner_pid)
        super().__init__(*args, **kwargs)

    def allowed(self):
        host = self.headers.get("Host", "")
        try:
            if urlsplit("http://" + host).hostname not in ("localhost", "127.0.0.1", "::1"):
                return False
        except ValueError:
            return False
        origin = self.headers.get("Origin")
        return (not origin or origin in ("http://" + host, "https://" + host)) and self.headers.get("Sec-Fetch-Site") != "cross-site"

    def validate_connection(self):
        if not self.allowed() or urlsplit(self.path).path != "/websockify":
            raise self.server.EClose("Local origin and selected workspace required")
        super().validate_connection()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "frame-ancestors 'self'")
        super().end_headers()

    def json(self, value, code=200):
        content = json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        if not self.allowed():
            self.send_error(403)
            return
        url = urlsplit(self.path)
        if url.path.startswith("/api/"):
            command = url.path.removeprefix("/api/")
            if command not in ("list", "show", "status"):
                self.send_error(404)
                return
            try:
                self.json(request(store, command, parse_qs(url.query).get("id", [None])[0]))
            except (OSError, ValueError, RuntimeError) as error:
                self.json({"error": str(error)}, 400)
        else:
            super().do_GET()

    def do_HEAD(self):
        if not self.allowed():
            self.send_error(403)
            return
        super().do_HEAD()

    def do_POST(self):
        if not self.allowed():
            self.send_error(403)
            return
        command = urlsplit(self.path).path.removeprefix("/api/")
        if command not in ("create", "open", "stop", "restart"):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4096 or self.headers.get("Content-Type") != "application/json":
                raise ValueError("A small JSON request is required")
            data = json.loads(self.rfile.read(length))
            self.json(request(store, command, data.get("id")))
        except (OSError, ValueError, RuntimeError, AttributeError) as error:
            self.json({"error": str(error)}, 400)


class Gateway(WebSocketProxy):
    def started(self):
        (store.runtime / "viewer.ready").write_text("ready\n")


parent_signal(parent)
bind = "0.0.0.0" if os.environ.get("CANTRIP_OS_CONTAINER") == "1" else store.config.get("viewer_bind", "127.0.0.1")
server = Gateway(Handler, listen_host=bind, listen_port=store.config.get("viewer_port", 6081),
                 web="/usr/share/cantrip-os-workspaces/www", file_only=True, token_plugin=Targets())
server.owner_pid = os.getpid()
server.start_server()
