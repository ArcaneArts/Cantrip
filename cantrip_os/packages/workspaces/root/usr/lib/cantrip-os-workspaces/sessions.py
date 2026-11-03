"""Persistent workspace identity and desktop lifecycle, owned by the local daemon."""
import grp
import json
import os
from pathlib import Path
import pwd
import re
import signal
import subprocess
import sys
import time
import uuid

ID = re.compile(r"[a-z][a-z0-9-]{0,23}\Z")
HERE = Path(__file__).parent


class Sessions:
    def __init__(self, store, write_json):
        self.store = store
        self.write_json = write_json
        self.path = store.state / "workspaces.json"
        try:
            self.registry = json.loads(self.path.read_text())
        except FileNotFoundError:
            self.registry = {"version": 1, "workspaces": {}}
        if self.registry.get("version") != 1 or not isinstance(self.registry.get("workspaces"), dict):
            raise ValueError("Unsupported workspace registry; state was preserved")
        self.records = self.registry["workspaces"]
        self.children = {}
        self.is_stopping = lambda: False
        # Homes need traversal, while metadata files remain root-only (0600).
        store.state.chmod(0o711)
        (store.state / "homes").mkdir(exist_ok=True, mode=0o711)
        (store.state / "logs").mkdir(exist_ok=True, mode=0o700)
        for name, record in self.records.items():
            self.validate(name)
            try:
                self.account(record)
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                record["error"] = str(error)
                self.save()

    def save(self):
        self.write_json(self.path, self.registry)

    def validate(self, name):
        if not isinstance(name, str) or not ID.fullmatch(name):
            raise ValueError("Workspace ID must start with a lowercase letter, using up to 24 lowercase letters, digits or hyphens")

    def account(self, record):
        name, uid, home = record["user"], record["uid"], record["home"]
        gid = record.setdefault("gid", uid)
        try:
            grp.getgrnam("cantrip-workspaces")
        except KeyError:
            subprocess.run(["groupadd", "--system", "cantrip-workspaces"], check=True)
        try:
            group = grp.getgrnam(name)
        except KeyError:
            subprocess.run(["groupadd", "--gid", str(gid), name], check=True)
            group = grp.getgrnam(name)
        if group.gr_gid != gid:
            raise ValueError(f"Group {name} conflicts with recorded workspace identity")
        try:
            user = pwd.getpwnam(name)
        except KeyError:
            subprocess.run(["useradd", "--uid", str(uid), "--gid", name,
                            "--home-dir", home, "--shell", "/bin/bash",
                            "--groups", "cantrip-workspaces", "--no-create-home", name], check=True)
            user = pwd.getpwnam(name)
        if user.pw_uid != uid or user.pw_gid != gid or user.pw_dir != home:
            raise ValueError(f"Account {name} conflicts with recorded workspace identity")
        directory = Path(home)
        if not directory.exists():
            directory.mkdir(mode=0o700)
            os.chown(directory, uid, user.pw_gid)
        if directory.stat().st_uid != uid:
            raise ValueError(f"Home {home} has different ownership; it was not changed")
        for folder in ("Documents", "Downloads"):
            child = directory / folder
            if not child.exists():
                child.mkdir(mode=0o700)
                os.chown(child, uid, user.pw_gid)

    def create(self, name):
        self.validate(name)
        if name in self.records:
            raise ValueError(f"Workspace {name} already exists")
        allocated = {r["uid"] for r in self.records.values()} | {u.pw_uid for u in pwd.getpwall()} | {g.gr_gid for g in grp.getgrall()}
        uid = next(n for n in range(20000, 60000) if n not in allocated)
        displays = {r["display"] for r in self.records.values()}
        display = next(n for n in range(100, 1000) if n not in displays)
        record = {"id": name, "user": "ctw-" + name, "uid": uid, "gid": uid,
                  "home": str(self.store.state / "homes" / name), "display": display,
                  "vnc_port": 5900 + display, "desired_running": False,
                  "generation": 0, "error": None}
        # Record identity before account creation so recovery never allocates a new UID.
        self.records[name] = record
        self.save()
        try:
            self.account(record)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            record["error"] = str(error)
            self.save()
            raise
        return self.info(name)

    def info(self, name):
        self.validate(name)
        if name not in self.records:
            raise ValueError(f"Unknown workspace {name}")
        record = dict(self.records[name])
        child = self.children.get(name)
        record["status"] = "running" if child and child.poll() is None else "stopped"
        return record

    def tick(self):
        for name, child in list(self.children.items()):
            code = child.poll()
            if code is not None:
                del self.children[name]
                self.records[name]["error"] = f"Desktop exited {code}; see logs/{name}.log"
                self.records[name]["desired_running"] = False
                self.save()

    def open(self, name):
        record = self.info(name)
        if record["status"] == "running":
            return record
        self.account(record)
        ready = self.store.runtime / ("ready-" + uuid.uuid4().hex + ".json")
        with (self.store.state / "logs" / (name + ".log")).open("a") as log:
            child = subprocess.Popen([sys.executable, str(HERE / "desktop.py"),
                                      str(os.getpid()), str(self.store.runtime), str(ready),
                                      json.dumps(record)], stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.children[name] = child
        try:
            for _ in range(600):
                if self.is_stopping():
                    raise RuntimeError("Workspace manager is stopping")
                if child.poll() is not None:
                    raise RuntimeError(f"Desktop exited {child.returncode}; see logs/{name}.log")
                if ready.exists():
                    self.records[name]["generation"] += 1
                    self.records[name]["desired_running"] = True
                    self.records[name]["error"] = None
                    self.save()
                    return self.info(name)
                time.sleep(0.05)
            raise RuntimeError(f"Desktop did not become ready; see logs/{name}.log")
        except BaseException as error:
            self.stop(name)
            self.records[name]["error"] = str(error)
            self.save()
            raise
        finally:
            ready.unlink(missing_ok=True)

    def stop(self, name, remember=True):
        self.info(name)
        child = self.children.get(name)
        if child and child.poll() is None:
            child.send_signal(signal.SIGTERM)
            child.wait(timeout=15)
        self.children.pop(name, None)
        if remember:
            self.records[name]["desired_running"] = False
            self.save()
        return self.info(name)

    def resume(self):
        for name, record in self.records.items():
            if self.is_stopping():
                break
            if record["desired_running"]:
                try:
                    self.open(name)
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
                    record["error"] = str(error)
                    self.save()
                    print(f"Workspace {name}: {error}", flush=True)

    def close(self):
        for child in self.children.values():
            if child.poll() is None:
                child.send_signal(signal.SIGTERM)
        for name in list(self.children):
            self.stop(name, remember=False)

    def dispatch(self, command, name=None):
        self.tick()
        if command == "list":
            return [self.info(key) for key in self.records]
        if command == "create":
            return self.create(name)
        if command == "open":
            return self.open(name)
        if command == "stop":
            return self.stop(name)
        if command == "restart":
            self.stop(name)
            return self.open(name)
        if command == "show":
            return self.info(name)
        raise ValueError("Unknown workspace command")
