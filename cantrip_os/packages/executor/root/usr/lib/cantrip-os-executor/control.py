#!/usr/bin/python3
"""Optional native executor lifecycle and root-only worker attachment control."""
import argparse
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import socketserver
import subprocess
import sys
import time
import uuid

sys.path.insert(0, "/usr/lib/cantrip-os-workspaces")
from service import Store, atomic_json, request as workspace_request

VERSION = "0.5.0"
CONFIG = "/etc/cantrip-os/executor.json"
HERE = Path(__file__).parent


def request(store, command, **arguments):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(60)
        connection.connect(str(store.socket))
        connection.sendall(json.dumps({"command": command, **arguments}).encode() + b"\n")
        with connection.makefile("rb") as stream:
            result = json.loads(stream.readline(1024 * 1024))
        if "failure" in result:
            raise RuntimeError(result["failure"])
        return result


def stopped(store):
    try:
        return request(store, "status")
    except (FileNotFoundError, ConnectionRefusedError):
        with store.lock("service", blocking=False):
            return {"service": "stopped", "version": VERSION, "enabled": store.preferences()["enabled"]}


class Manager:
    def __init__(self, store):
        self.store = store
        self.path = store.state / "instance.json"
        try:
            self.identity = json.loads(self.path.read_text())
        except FileNotFoundError:
            self.identity = {"version": 1, "instance_id": str(uuid.uuid4()), "attachment": None}
            atomic_json(self.path, self.identity)
        if not isinstance(self.identity, dict) or self.identity.get("version") != 1:
            raise ValueError("Unsupported executor identity; state was preserved")
        try:
            uuid.UUID(self.identity["instance_id"])
            attachment = self.identity["attachment"]
            if attachment is not None and (not isinstance(attachment, dict) or
                    set(attachment) != {"owner_id", "worker_id"} or
                    any(not isinstance(v, str) or not v or len(v) > 200 or "\0" in v for v in attachment.values())):
                raise ValueError("Invalid stored executor attachment")
        except (KeyError, TypeError, AttributeError) as error:
            raise ValueError("Invalid executor identity; state was preserved") from error
        self.generation = str(uuid.uuid4())
        self.children = {}
        self.endpoints = {}
        self.is_stopping = lambda: False

    def status(self):
        return {"service": "running", "version": VERSION, "enabled": self.store.preferences()["enabled"],
                "instance_id": self.identity["instance_id"], "generation": self.generation,
                "attachment": self.identity["attachment"],
                "workspaces": {name: {"status": "running" if child.poll() is None else "exited",
                                      "executor_generation": self.endpoints[name]["executor_generation"]}
                               for name, child in self.children.items()}}

    def attach(self, owner_id, worker_id):
        for value in (owner_id, worker_id):
            if not isinstance(value, str) or not value or len(value) > 200 or "\0" in value:
                raise ValueError("Owner and worker identities are required")
        attachment = {"owner_id": owner_id, "worker_id": worker_id}
        if self.identity["attachment"] not in (None, attachment):
            raise ValueError("Instance belongs to another attachment; explicitly detach first")
        self.identity["attachment"] = attachment
        atomic_json(self.path, self.identity)
        return self.status()

    def close(self, name):
        child = self.children.get(name)
        if child and child.poll() is None:
            child.terminate()
            child.wait(timeout=15)
        self.children.pop(name, None)
        self.endpoints.pop(name, None)
        return {"workspace_id": name, "status": "stopped"}

    def close_all(self):
        for child in self.children.values():
            if child.poll() is None:
                child.terminate()
        for name in list(self.children):
            self.close(name)

    def open(self, name):
        if not self.identity["attachment"]:
            raise ValueError("Attach an owning worker before opening an executor")
        if name in self.children and self.children[name].poll() is None:
            return self.public(name)
        self.close(name)
        workspace = workspace_request(Store("/etc/cantrip-os/workspaces.json"), "show", name)
        ready = self.store.runtime / (uuid.uuid4().hex + ".json")
        token = secrets.token_urlsafe(32)
        with (self.store.state / (name + ".log")).open("a") as log:
            child = subprocess.Popen([sys.executable, str(HERE / "supervisor.py"), str(os.getpid()),
                                      str(self.store.runtime), str(ready)], stdin=subprocess.PIPE,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.children[name] = child
        try:
            child.stdin.write(json.dumps({"workspace": workspace, "token": token}).encode())
            child.stdin.close()
            for _ in range(600):
                if self.is_stopping():
                    raise RuntimeError("Executor manager is stopping")
                if child.poll() is not None:
                    raise RuntimeError(f"Executor exited {child.returncode}; see {name}.log")
                if ready.exists():
                    self.endpoints[name] = {**json.loads(ready.read_text()), "token": token,
                        "instance_id": self.identity["instance_id"], "generation": self.generation,
                        **self.identity["attachment"], "workspace_id": name,
                        "executor_generation": str(uuid.uuid4()), "uid": workspace["uid"], "home": workspace["home"]}
                    return self.public(name)
                time.sleep(.05)
            raise RuntimeError("Executor startup timed out; inspect workspace executor log")
        except BaseException:
            self.close(name)
            raise
        finally:
            ready.unlink(missing_ok=True)

    def public(self, name):
        return {key: value for key, value in self.endpoints[name].items() if key != "token"}

    def connect(self, name, expected):
        if name not in self.children or self.children[name].poll() is not None:
            raise ValueError("Selected executor is not running; explicitly open it first")
        current = self.public(name)
        for key in ("instance_id", "generation", "owner_id", "worker_id", "workspace_id", "executor_generation"):
            if not isinstance(expected, dict) or expected.get(key) != current[key]:
                raise ValueError("Executor attachment or generation mismatch")
        return self.endpoints[name]


def daemon(store):
    with store.lock("service", blocking=False):
        if not store.preferences()["enabled"]:
            return
        manager = Manager(store)
        stopping = False

        def stop(*_):
            nonlocal stopping
            stopping = True

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        manager.is_stopping = lambda: stopping

        class Server(socketserver.UnixStreamServer):
            timeout = .25

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                self.connection.settimeout(5)
                try:
                    data = json.loads(self.rfile.readline(65536))
                    command = data.get("command")
                    if command == "status":
                        result = manager.status()
                    elif command == "shutdown":
                        stop()
                        result = {"service": "stopping"}
                    elif command == "attach":
                        result = manager.attach(data.get("owner_id"), data.get("worker_id"))
                    elif command == "detach":
                        manager.close_all()
                        manager.identity["attachment"] = None
                        atomic_json(manager.path, manager.identity)
                        result = manager.status()
                    elif command == "open":
                        result = manager.open(data.get("workspace"))
                    elif command == "close":
                        result = manager.close(data.get("workspace"))
                    elif command == "connect":
                        result = manager.connect(data.get("workspace"), data.get("expected"))
                    else:
                        raise ValueError("Unknown executor command")
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                    result = {"failure": str(error)}
                self.wfile.write(json.dumps(result).encode() + b"\n")

        store.socket.unlink(missing_ok=True)
        try:
            with Server(str(store.socket), Handler) as server:
                store.socket.chmod(0o600)
                print("[CantripOS] Executor control ready", flush=True)
                while not stopping:
                    server.handle_request()
        finally:
            manager.close_all()
            store.socket.unlink(missing_ok=True)


def service(store, action):
    if Path("/run/systemd/system").exists():
        subprocess.run(["systemctl", action, "cantrip-os-executor.service"], check=True)
        if action == "start" and store.preferences()["enabled"]:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                try:
                    request(store, "status")
                    return
                except (FileNotFoundError, ConnectionRefusedError):
                    time.sleep(.05)
            raise RuntimeError("Executor control did not become ready; inspect journalctl -u cantrip-os-executor")
    elif action == "start":
        if stopped(store)["service"] == "running" or not store.preferences()["enabled"]:
            return
        path = "/proc/1/fd/1" if os.environ.get("CANTRIP_OS_CONTAINER") == "1" else "/var/log/cantrip-os-executor.log"
        with open(path, "a") as log:
            child = subprocess.Popen([sys.executable, __file__, "--config", store.config_path, "daemon"],
                                     start_new_session=True, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        for _ in range(600):
            if child.poll() is not None:
                raise RuntimeError(f"Executor service exited {child.returncode}")
            try:
                request(store, "status")
                return
            except (FileNotFoundError, ConnectionRefusedError):
                time.sleep(.05)
        child.terminate()
        child.wait(timeout=15)
        raise RuntimeError("Executor control did not become ready")
    elif action == "stop":
        if stopped(store)["service"] == "running":
            request(store, "shutdown")
        for _ in range(600):
            try:
                with store.lock("service", blocking=False):
                    return
            except BlockingIOError:
                time.sleep(.05)
        raise RuntimeError("Executor service did not stop")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=CONFIG)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("daemon", "status", "enable", "disable", "detach"):
        commands.add_parser(name)
    attach = commands.add_parser("attach")
    attach.add_argument("owner_id")
    attach.add_argument("worker_id")
    for name in ("open", "close", "connect"):
        command = commands.add_parser(name)
        command.add_argument("workspace")
        if name == "connect":
            command.add_argument("--expect", required=True, type=json.loads)
    commands.add_parser("service").add_argument("action", choices=("start", "stop", "restart"))
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Use sudo for local executor administration")
    store = Store(args.config)
    store.state.chmod(0o700)
    if args.command == "daemon":
        daemon(store)
    elif args.command == "connect":
        from bridge import bridge
        bridge(request(store, "connect", workspace=args.workspace, expected=args.expect))
    else:
        with store.lock("control"):
            if args.command == "status":
                print(json.dumps(stopped(store)))
            elif args.command in ("enable", "disable"):
                store.enabled(args.command == "enable")
                if Path("/run/systemd/system").exists():
                    subprocess.run(["systemctl", args.command, "cantrip-os-executor.service"], check=True)
                service(store, "start" if args.command == "enable" else "stop")
            elif args.command == "service":
                if args.action == "restart":
                    service(store, "stop")
                    service(store, "start")
                else:
                    service(store, args.action)
            elif args.command == "attach":
                print(json.dumps(request(store, "attach", owner_id=args.owner_id, worker_id=args.worker_id)))
            else:
                print(json.dumps(request(store, args.command, workspace=getattr(args, "workspace", None))))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"cantrip-executor: {error}", file=sys.stderr)
        sys.exit(1)
