"""Captured workspace service connections behind the root-only carrier."""
import base64
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import threading
import time
import uuid
from context import observe_workspace, observe, identity, desktops, current_workspace, current_desktop

HERE = Path(__file__).parent


def service_spec(value):
    if value in ({"kind": "ssh"}, {"kind": "vnc"}):
        return dict(value)
    if isinstance(value, dict) and set(value) == {"kind", "port"} and value["kind"] == "tcp" and \
            type(value["port"]) is int and 1 <= value["port"] <= 65535:
        return dict(value)
    raise ValueError("Select SSH, VNC, or a guest loopback TCP port")


def public_key(value):
    # A single public key, with no authorized_keys options or caller commands.
    if not isinstance(value, str) or len(value) > 512:
        raise ValueError("Supply one Ed25519 SSH public key")
    fields = value.split()
    if len(fields) != 2 or fields[0] != "ssh-ed25519":
        raise ValueError("Supply one Ed25519 SSH public key without options or comments")
    try:
        decoded = base64.b64decode(fields[1], validate=True)
    except ValueError as error:
        raise ValueError("Invalid SSH public key") from error
    if len(decoded) != 51 or decoded[:19] != b'\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20':
        raise ValueError("Invalid Ed25519 SSH public key")
    return " ".join(fields)


class Services:
    def __init__(self, store, generation, connection_factory):
        self.store = store
        self.generation = generation
        self.connection_factory = connection_factory
        self.connections = {}
        self.lock = threading.RLock()
        self.stopping = False

    def host_key(self):
        with self.lock:
            path = self.store.state / "ssh_host_ed25519_key"
            if not path.exists():
                subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(path)], check=True)
            path.chmod(0o600)
            return public_key(" ".join(Path(str(path) + ".pub").read_text().split()[:2]))

    def inspect(self, workspace, service, pins=None, expected_placement=None):
        if self.stopping:
            raise RuntimeError("Remote service is stopping")
        service = service_spec(service)
        context, _ = observe_workspace(workspace, pins, expected_placement)
        if service["kind"] == "vnc":
            # No automatic desktop start and no unpinned personal-console access.
            context = observe(workspace, expected_placement=expected_placement)
        result = {**context, "remote_generation": self.generation, "service": service}
        if service["kind"] == "ssh":
            result["ssh_host_key"] = self.host_key()
        return result

    def connect(self, workspace, expected, connection_id, key=None):
        if not isinstance(connection_id, str):
            raise ValueError("Supply a service connection UUID")
        connection_id = str(uuid.UUID(connection_id))
        if not isinstance(expected, dict):
            raise ValueError("Supply the captured service descriptor")
        pins = []
        try:
            current = self.inspect(workspace, expected.get("service"), pins)
            if current != expected:
                raise ValueError("Remote service attachment or generation mismatch")
            kind = current["service"]["kind"]
            key = public_key(key) if kind == "ssh" else None
            with self.lock:
                if self.stopping:
                    raise RuntimeError("Remote service is stopping")
                if connection_id in self.connections:
                    raise ValueError("This service connection ID is already active")
                if len(self.connections) >= 64:
                    raise RuntimeError("Remote service connection capacity reached")
                ready = self.store.runtime / (uuid.uuid4().hex + ".ready")
                with (self.store.state / "access.log").open("ab") as log:
                    child = subprocess.Popen([sys.executable, str(HERE / "service_supervisor.py"),
                                              str(os.getpid()), str(ready)], stdin=subprocess.PIPE,
                                             stdout=subprocess.PIPE, stderr=log, start_new_session=True, bufsize=0)
                record = self.connection_factory(workspace, current, child, ready, pins, connection_id)
                pins = []
                self.connections[connection_id] = record
            try:
                child.stdin.write(json.dumps({"context": current, "public_key": key,
                                             "host_key": str(self.store.state / "ssh_host_ed25519_key")}).encode() + b"\n")
                deadline = time.monotonic() + 35
                while not ready.exists():
                    if self.stopping or record.stopping.is_set() or child.poll() is not None:
                        raise RuntimeError("Service connection ended during startup; inspect remote access.log")
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Service connection did not become ready")
                    time.sleep(.025)
                if self.inspect(workspace, current["service"]) != expected:
                    raise ValueError("Remote service changed during connection startup")
                return record
            except BaseException:
                record.finished.set()
                self.close(record)
                record.dispose()
                raise
        finally:
            for fd in pins:
                os.close(fd)

    def close(self, record):
        record.stop()
        with self.lock:
            if self.connections.get(record.connection_id) is record:
                del self.connections[record.connection_id]

    def retire(self, workspace, expected, connection_id):
        if not isinstance(connection_id, str):
            raise ValueError("Supply a service connection UUID")
        connection_id = str(uuid.UUID(connection_id))
        with self.lock:
            record = self.connections.get(connection_id)
            if not isinstance(expected, dict) or expected.get("remote_generation") != self.generation or \
                    expected.get("workspace_id") != workspace or \
                    (record is not None and (record.workspace != workspace or record.context != expected)):
                raise ValueError("Remote service attachment or generation mismatch")
        if record is not None:
            self.close(record)
        return {"connection_id": connection_id, "status": "closed"}

    def status(self):
        with self.lock:
            return {key: {"workspace_id": record.workspace, "service": record.context["service"],
                          "running": record.child.poll() is None, "stopping": record.stopping.is_set()}
                    for key, record in self.connections.items()}

    def close_all(self):
        with self.lock:
            self.stopping = True
            records = list(self.connections.values())
        for record in records:
            record.request_stop()
        for record in records:
            self.close(record)

    def tick(self):
        with self.lock:
            records = list(self.connections.values())
        if not records:
            return
        try:
            current, registry = identity(), desktops()
        except (OSError, ValueError):
            current, registry = None, {}
        for record in records:
            context = record.context
            attached = current is not None and current.get("instance_id") == context["instance_id"] and \
                current.get("attachment") == {key: context[key] for key in ("owner_id", "worker_id")}
            with record.lock:
                if record.disposed:
                    continue
                retired = select.select(record.service_pins, [], [], 0)[0] or not current_workspace(context, registry)
                if context["service"]["kind"] == "vnc":
                    retired = retired or not current_desktop(context, registry)
                # Normal child EOF is drained by the handler, including replies
                # after a request half-close. Retirement aborts immediately.
                if not attached or retired:
                    self.close(record)
                    if record.finished.is_set():
                        record.dispose()
