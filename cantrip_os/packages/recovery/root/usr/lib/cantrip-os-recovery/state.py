"""Private, versioned records for bounded root recovery commands."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid

VERSION = "0.5.0"
BOOT_ID = Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def write_json(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".record-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def sync_directory(path):
    descriptor = os.open(path, os.O_DIRECTORY | os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def process_identity(pid):
    try:
        started = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
        return f"{BOOT_ID}:{started}"
    except (FileNotFoundError, ProcessLookupError):
        return None


def command(program, *arguments, json_output=False):
    completed = subprocess.run([program, *arguments], check=True, capture_output=True)
    return json.loads(completed.stdout) if json_output else completed.stdout


def workspace(name, expected=None):
    if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,23}", name):
        raise ValueError("Invalid workspace identity")
    config = json.loads(Path("/etc/cantrip-os/workspaces.json").read_text())
    registry = json.loads((Path(config["state_dir"]) / "workspaces.json").read_text())
    if registry.get("version") != 1:
        raise ValueError("Unsupported workspace registry; state was preserved")
    record = registry["workspaces"][name]
    if record["id"] != name:
        raise ValueError("Workspace identity differs from its registry")
    home = Path(record["home"])
    # The real directory and recorded account must agree; no path is inferred
    # from an untrusted archive or a display name.
    import pwd
    account = pwd.getpwnam(record["user"])
    if account.pw_uid != record["uid"] or account.pw_gid != record["gid"] or account.pw_dir != str(home):
        raise ValueError("The recorded workspace account changed")
    if home.is_symlink() or home.stat().st_uid != record["uid"]:
        raise ValueError("The workspace home identity changed")
    if expected is not None and expected != {key: record[key] for key in ("uid", "gid", "home")}:
        raise ValueError("The admitted workspace account changed")
    return record


class Store:
    def __init__(self, config="/etc/cantrip-os/recovery.json"):
        settings = json.loads(Path(config).read_text())
        if settings.get("version") != 1:
            raise ValueError("Unsupported recovery configuration; state was preserved")
        self.root = Path(settings["state_dir"])
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        (self.root / "operations").mkdir(exist_ok=True, mode=0o700)

    @contextlib.contextmanager
    def lock(self):
        with (self.root / "maintenance.lock").open("a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def directory(self, operation_id):
        if str(uuid.UUID(operation_id)) != operation_id:
            raise ValueError("A canonical operation ID is required")
        return self.root / "operations" / operation_id

    def read(self, operation_id):
        record = json.loads((self.directory(operation_id) / "record.json").read_text())
        if record.get("version") not in (1, 2) or record.get("operation_id") != operation_id:
            raise ValueError("Unsupported recovery record; state was preserved")
        allowed = {"capture", "restore", "rollback"} if record["version"] == 1 else {"reset"}
        if record.get("action") not in allowed:
            raise ValueError("Unsupported recovery action version; state was preserved")
        if record["version"] == 2 and record.get("state") not in ("admitted", "restoring", "reset", "failed"):
            raise ValueError("Unsupported reset record state; state was preserved")
        return record

    def save(self, record):
        record["updated_at"] = time.time()
        write_json(self.directory(record["operation_id"]) / "record.json", record)

    def admit(self, operation_id, action, request):
        if action not in ("capture", "restore", "rollback", "reset"):
            raise ValueError("Unsupported recovery action")
        directory = self.directory(operation_id)
        active = self.root / "active.json"
        if active.exists():
            previous_id = json.loads(active.read_text())["operation_id"]
            if previous_id != operation_id:
                previous = self.read(previous_id)
                if not (previous.get("maintenance") or {}).get("released"):
                    raise RuntimeError("Recover the preceding maintenance admission before starting another recovery operation")
                active.unlink()
                sync_directory(self.root)
        fingerprint = hashlib.sha256(json.dumps([action, request], sort_keys=True).encode()).hexdigest()
        try:
            directory.mkdir(mode=0o700)
            sync_directory(directory.parent)
        except FileExistsError:
            previous = self.read(operation_id)
            if previous["fingerprint"] != fingerprint or previous["action"] != action:
                raise ValueError("Operation ID belongs to another recovery admission")
            return previous, False
        record = {"version": 2 if action == "reset" else 1, "operation_id": operation_id, "action": action,
                  "fingerprint": fingerprint, "request": request, "state": "admitted",
                  "pid": os.getpid(), "process_identity": process_identity(os.getpid()),
                  "created_at": time.time(), "receipt": None, "maintenance": None}
        self.save(record)
        return record, True

    def inspect(self, operation_id):
        record = self.read(operation_id)
        identity = process_identity(record["pid"])
        alive = identity is not None and identity == record["process_identity"]
        result = {key: record.get(key) for key in ("version", "operation_id", "action", "state", "receipt", "error", "maintenance")}
        result["active"] = alive
        if record["state"] in ("admitted", "capturing", "receiving", "restoring") and not alive:
            result["state"] = "unknown"
        return result
