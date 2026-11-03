#!/usr/bin/python3
"""Optional CantripOS service. Root-only local control; no agent orchestration."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import subprocess
import sys
import tempfile
import time

VERSION = "0.1.0"
DEFAULT_CONFIG = "/etc/cantrip-os/workspaces.json"


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".state-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class Store:
    def __init__(self, config):
        self.config_path = str(Path(config).resolve())
        self.config = json.loads(Path(config).read_text())
        self.state = Path(self.config["state_dir"])
        self.runtime = Path(self.config["runtime_dir"])
        for directory in (self.state, self.runtime):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory.chmod(0o700)
        self.socket = self.runtime / "control.sock"
        self.settings = self.state / "settings.json"

    @contextlib.contextmanager
    def lock(self, name, blocking=True):
        with (self.runtime / (name + ".lock")).open("a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            yield

    def preferences(self):
        try:
            value = json.loads(self.settings.read_text())
        except FileNotFoundError:
            value = {"version": 1, "enabled": True}
            atomic_json(self.settings, value)
        if value.get("version") != 1 or type(value.get("enabled")) is not bool:
            raise ValueError("Unsupported workspace settings format; state was preserved")
        return value

    def enabled(self, enabled):
        value = self.preferences()
        value["enabled"] = enabled
        atomic_json(self.settings, value)


def request(store, command):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(str(store.socket))
        connection.sendall(json.dumps({"command": command}).encode() + b"\n")
        with connection.makefile("rb") as stream:
            line = stream.readline(1024 * 1024)
        result = json.loads(line)
        if "error" in result:
            raise RuntimeError(result["error"])
        return result


def running(store):
    try:
        return request(store, "status")
    except (FileNotFoundError, ConnectionRefusedError):
        # Observe the actual service lock, never trust a saved PID.
        try:
            with store.lock("service", blocking=False):
                return None
        except BlockingIOError:
            raise RuntimeError("Service owns its lock but control is unavailable")


def daemon(store):
    with store.lock("service", blocking=False):
        if not store.preferences()["enabled"]:
            print("Workspace management is disabled", flush=True)
            return
        store.socket.unlink(missing_ok=True)

        class Server(socketserver.UnixStreamServer):
            timeout = 0.25

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                self.connection.settimeout(5)
                try:
                    message = json.loads(self.rfile.readline(65536))
                    command = message.get("command")
                    if command == "status":
                        response = {"service": "running", "version": VERSION,
                                    "enabled": store.preferences()["enabled"],
                                    "state_dir": str(store.state)}
                    elif command == "shutdown":
                        server.stopping = True
                        response = {"service": "stopping"}
                    else:
                        raise ValueError("Unknown command")
                except (ValueError, OSError) as error:
                    response = {"error": str(error)}
                self.wfile.write(json.dumps(response).encode() + b"\n")

        with Server(str(store.socket), Handler) as server:
            store.socket.chmod(0o600)
            server.stopping = False

            def stop(signum, frame):
                server.stopping = True

            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            print("[CantripOS] Workspace service ready", flush=True)
            try:
                while not server.stopping:
                    server.handle_request()
            finally:
                store.socket.unlink(missing_ok=True)
                print("[CantripOS] Workspace service stopped", flush=True)


def service(store, action):
    # systemd is selected by its live runtime directory, not package presence.
    if Path("/run/systemd/system").exists():
        subprocess.run(["systemctl", action, "cantrip-os-workspaces.service"], check=True)
        return
    if action == "start":
        if running(store) or not store.preferences()["enabled"]:
            return
        log_path = "/proc/1/fd/1" if os.environ.get("CANTRIP_OS_CONTAINER") == "1" else "/var/log/cantrip-os-workspaces.log"
        with open(log_path, "a") as log:
            child = subprocess.Popen([sys.executable, __file__, "--config", store.config_path,
                                      "daemon"], start_new_session=True, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                if child.poll() is not None:
                    raise RuntimeError(f"Workspace service exited {child.returncode}")
                try:
                    request(store, "status")
                    return
                except (FileNotFoundError, ConnectionRefusedError):
                    time.sleep(0.05)
            raise RuntimeError("Workspace service did not become ready; inspect its logs")
        except BaseException:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=10)
            raise
    elif action == "stop":
        try:
            request(store, "shutdown")
        except (FileNotFoundError, ConnectionRefusedError):
            pass
        for _ in range(200):
            try:
                with store.lock("service", blocking=False):
                    return
            except BlockingIOError:
                time.sleep(0.05)
        raise RuntimeError("Workspace service has not stopped")
    else:
        raise ValueError("Unknown service action")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("command", choices=["daemon", "status", "enable", "disable", "service"])
    parser.add_argument("action", nargs="?", choices=["start", "stop", "restart", "status"])
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run with sudo (local service control requires root)")
    store = Store(args.config)
    if args.command == "daemon":
        daemon(store)
        return
    with store.lock("control"):
        if args.command == "status" or args.action == "status":
            print(json.dumps(running(store) or {"service": "stopped", "version": VERSION,
                                              "enabled": store.preferences()["enabled"],
                                              "state_dir": str(store.state)}))
        elif args.command in ("enable", "disable"):
            enable = args.command == "enable"
            store.enabled(enable)
            service(store, "start" if enable else "stop")
            print("Workspace management " + ("enabled" if enable else "disabled"))
        elif args.command == "service" and args.action:
            if args.action == "restart":
                service(store, "stop")
                service(store, "start")
            else:
                service(store, args.action)
        else:
            parser.error("service requires start, stop, restart, or status")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"cantrip-workspaces: {error}", file=sys.stderr)
        sys.exit(1)
