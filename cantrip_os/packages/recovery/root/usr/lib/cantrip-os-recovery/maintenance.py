"""Coordinate actual managed writers; retain an explicit interruption record."""
import ctypes
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import time

from state import command, write_json, process_identity, sync_directory


def profiles():
    config = json.loads(Path("/etc/cantrip-os/workspaces.json").read_text())
    registry = json.loads((Path(config["state_dir"]) / "workspaces.json").read_text())
    if registry.get("version") != 1:
        raise ValueError("Unsupported workspace registry; state was preserved")
    return list(registry["workspaces"].values())


class Maintenance:
    def __init__(self, store, record, roots):
        self.store, self.record, self.roots = store, record, roots

    def begin(self):
        state = {"services": [], "roots": [], "interrupted_workspaces": [], "stopped_pids": []}
        self.record["maintenance"] = state
        self.store.save(self.record)
        write_json(self.store.root / "active.json", {"operation_id": self.record["operation_id"]})
        accounts = profiles()
        state["interrupted_workspaces"] = [record["id"] for record in accounts]
        for program in ("cantrip-remote", "cantrip-executor", "cantrip-workspaces"):
            try:
                status = command(program, "status", json_output=True)
            except FileNotFoundError:
                if program != "cantrip-remote":
                    raise
                continue
            entry = {"program": program, "was_running": status["service"] == "running", "stopped": False}
            state["services"].append(entry)
            self.store.save(self.record)
            # Explicit service stop preserves both boot enablement and the
            # user's saved enable/disable preference. The package waits on its
            # real service lock before acknowledging physical shutdown.
            try:
                command(program, "service", "stop")
            except subprocess.CalledProcessError as error:
                entry["stop_exit_code"] = error.returncode
                self.store.save(self.record)
                # A terminating control daemon can lose its final reply. Do
                # not repeat shutdown: observe its actual endpoint/lock via
                # the package's status command before accepting stopped state.
                observed = command(program, "status", json_output=True)
                if observed["service"] != "stopped":
                    raise
                entry["stop_confirmed_after_error"] = True
            entry["stopped"] = True
            self.store.save(self.record)
        for root in self.roots:
            path = Path(root)
            details = path.stat()
            state["roots"].append({"path": str(path), "mode": stat.S_IMODE(details.st_mode),
                                   "device": details.st_dev, "inode": details.st_ino})
            self.store.save(self.record)
            path.chmod(0)
        uids = {record["uid"] for record in accounts}
        # Services own native/root descendants. Also stop unmanaged processes
        # running as workspace accounts so an ordinary SSH shell or cron job
        # cannot continue writing after its desktop/executor was stopped.
        remaining = self.workspace_processes(uids)
        state["stopped_pids"] = sorted(remaining)
        self.store.save(self.record)
        for sig, timeout in ((signal.SIGTERM, 2), (signal.SIGKILL, 5)):
            for pid, identity in remaining.items():
                try:
                    if process_identity(pid) == identity:
                        os.kill(pid, sig)
                except ProcessLookupError:
                    pass
            deadline = time.monotonic() + timeout
            while remaining and time.monotonic() < deadline:
                remaining = self.workspace_processes(uids)
                if remaining:
                    time.sleep(.025)
        if remaining:
            raise RuntimeError("Workspace writers did not stop; no consistent capture was accepted")
        state["writers_stopped"] = True
        self.store.save(self.record)

    @staticmethod
    def workspace_processes(uids):
        result = {}
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                status = (entry / "status").read_text()
                values = next(line for line in status.splitlines() if line.startswith("Uid:")).split()[1:]
                process_state = next(line for line in status.splitlines() if line.startswith("State:")).split()[1]
                if process_state != "Z" and any(int(value) in uids for value in values):
                    identity = process_identity(int(entry.name))
                    if identity is not None:
                        result[int(entry.name)] = identity
            except (FileNotFoundError, ProcessLookupError, StopIteration):
                pass
        return result

    def finish(self):
        state = self.record.get("maintenance")
        if not state:
            return
        # Restore only the exact directories whose permissions this admission
        # changed. Replacement restore records update these identities after
        # the atomic exchange; unknown paths are never guessed or chmodded.
        for root in ([] if state.get("released") else state["roots"]):
            path = Path(root["path"])
            details = path.stat()
            if details.st_dev != root["device"] or details.st_ino != root["inode"]:
                raise RuntimeError("A maintenance directory changed; explicit recovery is required")
            path.chmod(root["mode"])
        errors = []
        for entry in ([] if state.get("released") else reversed(state["services"])):
            if entry["was_running"]:
                try:
                    command(entry["program"], "service", "start")
                except Exception as error:
                    errors.append(f"{entry['program']}: {type(error).__name__}")
        if errors:
            state["restart_errors"] = errors
            self.store.save(self.record)
            raise RuntimeError("Managed services could not all restart; use the recovery operation's saved record")
        state["released"] = True
        self.store.save(self.record)
        active = self.store.root / "active.json"
        if active.exists() and json.loads(active.read_text())["operation_id"] == self.record["operation_id"]:
            active.unlink()
            sync_directory(self.store.root)


class ChangeWatch:
    """Observe real Linux filesystem changes while the stopped writers' data
    is copied. Access/open events from the capture itself are not changes."""
    MASK = 0x00000002 | 0x00000004 | 0x00000008 | 0x00000040 | 0x00000080 | 0x00000100 | 0x00000200 | 0x00000400 | 0x00000800

    def __init__(self, directories):
        libc = ctypes.CDLL(None, use_errno=True)
        self.fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), "Cannot observe capture consistency")
        try:
            for path in directories:
                if libc.inotify_add_watch(self.fd, os.fsencode(path), self.MASK) < 0:
                    raise OSError(ctypes.get_errno(), "Cannot observe a capture directory")
        except BaseException:
            self.close()
            raise

    def verify(self):
        try:
            changes = os.read(self.fd, 1024 * 1024)
        except BlockingIOError:
            return
        if changes:
            # Includes IN_Q_OVERFLOW: unavailable coverage is never described
            # as a consistent copy. No user data or original state is deleted.
            raise RuntimeError("Files changed during capture; no consistent backup was accepted")

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
