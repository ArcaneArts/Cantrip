"""Root-owned desktop connections; no scheduler, project store or provider keys."""
import json
import os
from pathlib import Path
import signal
import select
import subprocess
import sys
import threading
import time
import uuid
from context import observe, identity, desktops, current_desktop, VERSION
from services import Services

HERE = Path(__file__).parent


class Connection:
    def __init__(self, workspace, context, child, ready, service_pins, connection_id):
        self.workspace = workspace
        self.context = context
        self.child = child
        self.ready = ready
        self.service_pins = service_pins
        self.connection_id = connection_id
        self.pidfd = os.pidfd_open(child.pid)
        self.lock = threading.RLock()
        self.disposed = False
        self.finished = threading.Event()
        self.stopping = threading.Event()

    def request_stop(self):
        with self.lock:
            self.stopping.set()
            if not self.disposed and self.child.poll() is None:
                try:
                    signal.pidfd_send_signal(self.pidfd, signal.SIGTERM)
                except ProcessLookupError:
                    pass

    def stop(self):
        with self.lock:
            self.request_stop()
            self.child.wait(timeout=18)

    def dispose(self):
        with self.lock:
            if self.disposed:
                return
            if self.child.poll() is None:
                raise RuntimeError("Native connection cleanup is unconfirmed")
            for stream in (self.child.stdin, self.child.stdout):
                stream.close()
            os.close(self.pidfd)
            for fd in self.service_pins:
                os.close(fd)
            self.ready.unlink(missing_ok=True)
            self.disposed = True


class Manager:
    def __init__(self, store):
        self.store = store
        self.generation = str(uuid.uuid4())
        self.connections = {}
        self.lock = threading.RLock()
        self.stopping = False
        self.services = Services(store, self.generation, Connection)

    def status(self):
        with self.lock:
            return {"service": "running", "version": VERSION,
                    "enabled": self.store.preferences()["enabled"], "remote_generation": self.generation,
                    "connections": {name: {"running": record.child.poll() is None,
                                            "stopping": record.stopping.is_set()}
                                    for name, record in self.connections.items()},
                    "service_connections": self.services.status()}

    def inspect(self, workspace, start=False, pins=None, expected_placement=None):
        if self.stopping:
            raise RuntimeError("Remote service is stopping")
        return {**observe(workspace, start, pins, expected_placement), "remote_generation": self.generation}

    def connect(self, workspace, expected, connection_id=None):
        connection_id = str(uuid.UUID(connection_id)) if connection_id is not None else str(uuid.uuid4())
        pins = []
        try:
            current = self.inspect(workspace, pins=pins)
            if current != expected:
                raise ValueError("Remote desktop attachment or generation mismatch")
            context = {key: value for key, value in current.items() if key != "remote_generation"}
            with self.lock:
                if self.stopping:
                    raise RuntimeError("Remote service is stopping")
                if workspace in self.connections:
                    raise RuntimeError("This desktop already has an active CUA connection; retire it first")
                if len(self.connections) >= 16:
                    raise RuntimeError("Remote desktop connection capacity reached")
                ready = self.store.runtime / (uuid.uuid4().hex + ".ready")
                with (self.store.state / "native.log").open("ab") as log:
                    child = subprocess.Popen([sys.executable, str(HERE / "supervisor.py"),
                                              str(os.getpid()), str(ready)], stdin=subprocess.PIPE,
                                             stdout=subprocess.PIPE, stderr=log, start_new_session=True,
                                             bufsize=0)
                record = Connection(workspace, context, child, ready, pins, connection_id)
                pins = []
                self.connections[workspace] = record
            try:
                child.stdin.write(json.dumps({"context": context}).encode() + b"\n")
                deadline = time.monotonic() + 35
                while not ready.exists():
                    if self.stopping or record.stopping.is_set() or child.poll() is not None:
                        raise RuntimeError("Native desktop connection ended during startup")
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Native desktop connection did not become ready")
                    time.sleep(.025)
                if self.inspect(workspace) != expected:
                    raise ValueError("Desktop changed during connection startup")
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
        # A late handler must never remove or stop its replacement connection.
        record.stop()
        with self.lock:
            if self.connections.get(record.workspace) is record:
                del self.connections[record.workspace]

    def close_workspace(self, workspace, expected=None, connection_id=None):
        with self.lock:
            record = self.connections.get(workspace)
            if record is not None and connection_id is not None and record.connection_id != connection_id:
                raise ValueError("Remote connection generation mismatch")
            if expected is not None:
                if not isinstance(expected, dict) or expected.get("remote_generation") != self.generation or \
                        (record is not None and expected != {**record.context, "remote_generation": self.generation}):
                    raise ValueError("Remote desktop attachment or generation mismatch")
        if record is not None:
            self.close(record)
        return {"workspace_id": workspace, "status": "closed"}

    def close_all(self):
        self.services.close_all()
        with self.lock:
            records = list(self.connections.values())
        # Begin cleanup together, so long gestures do not serialize shutdown.
        for record in records:
            record.request_stop()
        for record in records:
            self.close(record)

    def tick(self):
        self.services.tick()
        with self.lock:
            records = list(self.connections.values())
        if not records:
            return
        try:
            current = identity()
            registry = desktops()
        except (OSError, ValueError):
            current = None
            registry = {}
        for record in records:
            attached = current is not None and current.get("instance_id") == record.context["instance_id"] and \
                current.get("attachment") == {key: record.context[key] for key in ("owner_id", "worker_id")}
            with record.lock:
                if record.disposed:
                    continue
                retired = select.select(record.service_pins, [], [], 0)[0] or not current_desktop(record.context, registry)
                if record.child.poll() is not None or not attached or retired:
                    self.close(record)
                    if record.finished.is_set():
                        record.dispose()
