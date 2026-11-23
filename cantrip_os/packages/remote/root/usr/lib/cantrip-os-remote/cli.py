#!/usr/bin/python3
"""Optional desktop service and root-only protected stdio carrier."""
import argparse
import json
import os
from pathlib import Path
import signal
import select
import socket
import socketserver
import struct
import subprocess
import sys
import time
from context import CONFIG, VERSION, Store, request
from manager import Manager
from bridge import pump, stream_pump


def running(store):
    try:
        return request(store, "status")
    except (FileNotFoundError, ConnectionRefusedError):
        with store.lock("service", blocking=False):
            return {"service": "stopped", "version": VERSION, "enabled": store.preferences()["enabled"]}


def daemon(store):
    with store.lock("service", blocking=False):
        if not store.preferences()["enabled"]:
            return
        manager = Manager(store)

        def stop(*_):
            manager.stopping = True

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)

        class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
            timeout = .25
            daemon_threads = True
            request_queue_size = 32

        class Handler(socketserver.StreamRequestHandler):
            rbufsize = 0

            def handle(self):
                self.connection.settimeout(5)
                record = None
                carrier_pin = None
                streaming = False
                try:
                    data = json.loads(self.rfile.readline(65536))
                    command = data.get("command")
                    if command == "status":
                        result = manager.status()
                    elif command == "shutdown":
                        stop()
                        result = {"service": "stopping"}
                    elif command in ("open", "show"):
                        result = manager.inspect(data.get("workspace"), command == "open",
                                                 expected_placement=data.get("expectedPlacement"))
                    elif command == "close":
                        result = manager.close_workspace(data.get("workspace"), data.get("expected"), data.get("connectionId"))
                    elif command == "connect":
                        record = manager.connect(data.get("workspace"), data.get("expected"), data.get("connectionId"))
                        self.wfile.write(b'{"ready":true}\n')
                        self.wfile.flush()
                        streaming = True
                        self.connection.settimeout(None)
                        pump(self.connection.fileno(), self.connection.fileno(),
                             record.child.stdout.fileno(), record.child.stdin.fileno(),
                             lambda: manager.stopping or record.stopping.is_set())
                        return
                    elif command == "service-info":
                        result = manager.services.inspect(data.get("workspace"), data.get("service"),
                                                          expected_placement=data.get("expectedPlacement"))
                    elif command == "service-close":
                        result = manager.services.retire(data.get("workspace"), data.get("expected"),
                                                         data.get("connectionId"))
                    elif command == "service-connect":
                        peer, _, _ = struct.unpack("3i", self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                        carrier_pin = os.pidfd_open(peer)
                        record = manager.services.connect(data.get("workspace"), data.get("expected"),
                                                          data.get("connectionId"), data.get("publicKey"))
                        self.wfile.write(b'{"ready":true}\n')
                        self.wfile.flush()
                        streaming = True
                        self.connection.settimeout(None)
                        stream_pump(self.connection.fileno(), self.connection.fileno(),
                                    record.child.stdout.fileno(), record.child.stdin.fileno(),
                                    lambda: manager.stopping or record.stopping.is_set() or
                                    bool(select.select([carrier_pin], [], [], 0)[0]),
                                    close_left=lambda: self.connection.shutdown(socket.SHUT_WR),
                                    close_right=record.child.stdin.close)
                        return
                    else:
                        raise ValueError("Unknown remote command")
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                    if streaming:
                        return
                    result = {"failure": str(error)[:512]}
                finally:
                    if carrier_pin is not None:
                        os.close(carrier_pin)
                    if record is not None:
                        record.finished.set()
                        try:
                            if command == "service-connect":
                                manager.services.close(record)
                            else:
                                manager.close(record)
                        finally:
                            record.dispose()
                self.wfile.write(json.dumps(result).encode() + b"\n")

        store.socket.unlink(missing_ok=True)
        try:
            with Server(str(store.socket), Handler) as server:
                store.socket.chmod(0o600)
                print("[CantripOS] Remote control ready", flush=True)
                while not manager.stopping:
                    server.handle_request()
                    manager.tick()
        finally:
            manager.stopping = True
            manager.close_all()
            store.socket.unlink(missing_ok=True)


def service(store, action):
    if Path("/run/systemd/system").exists():
        subprocess.run(["systemctl", action, "cantrip-os-remote.service"], check=True)
        if action != "start" or not store.preferences()["enabled"]:
            return
    elif action == "start":
        if running(store)["service"] == "running" or not store.preferences()["enabled"]:
            return
        destination = "/proc/1/fd/1" if os.environ.get("CANTRIP_OS_CONTAINER") == "1" else "/var/log/cantrip-os-remote.log"
        with open(destination, "a") as log:
            child = subprocess.Popen([sys.executable, __file__, "--config", store.config_path, "daemon"],
                                     start_new_session=True, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError("Remote service exited during startup")
            try:
                request(store, "status")
                return
            except (FileNotFoundError, ConnectionRefusedError):
                time.sleep(.05)
        child.terminate()
        child.wait(timeout=20)
        raise RuntimeError("Remote control did not become ready")
    elif action == "stop":
        try:
            request(store, "shutdown")
        except (FileNotFoundError, ConnectionRefusedError):
            pass
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                with store.lock("service", blocking=False):
                    return
            except BlockingIOError:
                time.sleep(.05)
        raise RuntimeError("Remote service cleanup has not completed")
    else:
        raise ValueError("Unknown service action")
    # Installed-system start observes its actual control endpoint as well.
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        try:
            request(store, "status")
            return
        except (FileNotFoundError, ConnectionRefusedError):
            time.sleep(.05)
    raise RuntimeError("Remote control did not become ready; inspect its system journal")


def connect(store, workspace, expected, connection_id, service=False, public_key=None, notify_ready=False):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect(str(store.socket))
        connection.sendall(json.dumps({"command": "service-connect" if service else "connect",
                                       "workspace": workspace, "expected": expected,
                                       "connectionId": connection_id, "publicKey": public_key}).encode() + b"\n")
        with connection.makefile("rb", buffering=0) as stream:
            result = json.loads(stream.readline(65536))
        if result != {"ready": True}:
            raise RuntimeError(result.get("failure", "Remote connection failed"))
        if notify_ready:
            print("CANTRIP_OS_SERVICE_READY " + connection_id, file=sys.stderr, flush=True)
        if service and expected.get("service", {}).get("kind") in ("listen", "vnc"):
            # Listener multiplexes carry per-client FIN frames; a retired VNC
            # desktop ends its whole connection. Neither outer carrier has a
            # valid half-open state. Docker cannot propagate a stdout-only EOF
            # until this process exits, so do not wait for idle client input.
            pump(sys.stdin.fileno(), sys.stdout.fileno(), connection.fileno(), connection.fileno())
        elif service:
            stream_pump(sys.stdin.fileno(), sys.stdout.fileno(), connection.fileno(), connection.fileno(),
                        close_left=lambda: os.close(sys.stdout.fileno()),
                        close_right=lambda: connection.shutdown(socket.SHUT_WR))
        else:
            pump(sys.stdin.fileno(), sys.stdout.fileno(), connection.fileno(), connection.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=CONFIG)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("daemon", "status", "enable", "disable"):
        commands.add_parser(name)
    for name in ("open", "show", "close", "connect"):
        command = commands.add_parser(name)
        command.add_argument("workspace")
        if name in ("connect", "close"):
            command.add_argument("--expect", required=name == "connect", type=json.loads)
            command.add_argument("--connection-id")
        if name == "open":
            command.add_argument("--expect-placement", type=json.loads)
    command = commands.add_parser("service-info")
    command.add_argument("workspace")
    command.add_argument("--service", type=json.loads, required=True)
    command.add_argument("--expect-placement", type=json.loads)
    for name in ("service-connect", "service-close"):
        command = commands.add_parser(name)
        command.add_argument("workspace")
        command.add_argument("--expect", type=json.loads, required=True)
        command.add_argument("--connection-id", required=True)
        if name == "service-connect":
            command.add_argument("--public-key")
            command.add_argument("--notify-ready", action="store_true")
    commands.add_parser("service").add_argument("action", choices=("start", "stop", "restart"))
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Use sudo for remote administration and the protected carrier")
    store = Store(args.config)
    store.state.chmod(0o700)
    if args.command == "daemon":
        daemon(store)
    elif args.command in ("connect", "service-connect"):
        connect(store, args.workspace, args.expect, args.connection_id,
                service=args.command == "service-connect", public_key=getattr(args, "public_key", None),
                notify_ready=getattr(args, "notify_ready", False))
    else:
        with store.lock("control"):
            if args.command == "status":
                print(json.dumps(running(store)))
            elif args.command in ("open", "show", "close"):
                extra = {"expected": args.expect, "connectionId": args.connection_id} if args.command == "close" else \
                    {"expectedPlacement": args.expect_placement} if args.command == "open" else {}
                print(json.dumps(request(store, args.command, workspace=args.workspace, **extra)))
            elif args.command == "service-info":
                print(json.dumps(request(store, args.command, workspace=args.workspace, service=args.service,
                                         expectedPlacement=args.expect_placement)))
            elif args.command == "service-close":
                print(json.dumps(request(store, args.command, workspace=args.workspace, expected=args.expect,
                                         connectionId=args.connection_id)))
            elif args.command in ("enable", "disable"):
                store.enabled(args.command == "enable")
                if Path("/run/systemd/system").exists():
                    subprocess.run(["systemctl", args.command, "cantrip-os-remote.service"], check=True)
                service(store, "start" if args.command == "enable" else "stop")
            elif args.action == "restart":
                service(store, "stop")
                service(store, "start")
            else:
                service(store, args.action)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"cantrip-remote: {error}", file=sys.stderr)
        sys.exit(1)
