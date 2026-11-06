#!/usr/bin/python3
"""One admitted Debian package operation. No scheduler, agent or network listener.

The optional recovery package installs this CLI. The owning Worker can also send
these same bytes through its authenticated carrier when guest helpers are broken.
"""
import argparse
import contextlib
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import uuid

FORMAT = "cantrip-os-package-operation"
ALLOWED = {"cantrip-os-workspaces", "cantrip-os-executor", "cantrip-os-remote", "cantrip-os-recovery"}
SCRIPTS = ("preinst", "postinst", "prerm", "postrm")
DEFAULT_ROOT = "/var/lib/cantrip-os-executor/package-operations"
BOOT_ID = Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex)
    try:
        with temporary.open("x") as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def canonical_id(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("A canonical operation UUID is required")
    return value


def validate_request(value):
    fields = {"version", "operationId", "scopeKey", "action", "configuration", "packages"}
    if isinstance(value, dict) and value.get("version") == 2:
        fields.add("expected")
        validate_expected(value["expected"], require_boot=True)
    if not isinstance(value, dict) or set(value) != fields or type(value["version"]) is not int or value["version"] not in (1, 2):
        raise ValueError("Unsupported package admission; original state was preserved")
    canonical_id(value["operationId"])
    if not isinstance(value["scopeKey"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["scopeKey"]):
        raise ValueError("A pinned package-operation scope is required")
    if value["action"] not in ("upgrade", "repair") or value["configuration"] not in ("preserve", "package-defaults"):
        raise ValueError("Unsupported package action or configuration policy")
    if value["action"] == "upgrade" and value["configuration"] != "preserve":
        raise ValueError("Replacing configuration requires an explicit repair admission")
    packages = value["packages"]
    if not isinstance(packages, list) or not 1 <= len(packages) <= len(ALLOWED):
        raise ValueError("Select optional Cantrip packages explicitly")
    names = set()
    for package in packages:
        if not isinstance(package, dict) or set(package) != {"name", "version", "architecture", "sha256", "bytes"}:
            raise ValueError("Incomplete package artifact identity")
        if package["name"] not in ALLOWED or package["name"] in names:
            raise ValueError("Unsupported or duplicate optional package")
        names.add(package["name"])
        if not isinstance(package["version"], str) or not re.fullmatch(r"[A-Za-z0-9.+:~_-]{1,200}", package["version"]):
            raise ValueError("Invalid Debian package version")
        if not isinstance(package["architecture"], str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", package["architecture"]):
            raise ValueError("Invalid Debian architecture")
        if not isinstance(package["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", package["sha256"]):
            raise ValueError("A package SHA-256 is required")
        if type(package["bytes"]) is not int or not 0 < package["bytes"] <= 2 * 1024**3:
            raise ValueError("Invalid package byte length")
    return value


def validate_expected(value, require_boot=False):
    fields = {"guestInstanceId", "ownerId", "workerId", "identityPath"}
    if require_boot:
        fields.add("bootId")
        fields.add("initStart")
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("An exact persistent package target is required")
    canonical_id(value["guestInstanceId"])
    if require_boot:
        canonical_id(value["bootId"])
        if not isinstance(value["initStart"], str) or not re.fullmatch(r"[0-9]{1,30}", value["initStart"]):
            raise ValueError("An actual init-process boot identity is required")
    for key in ("ownerId", "workerId"):
        if not isinstance(value[key], str) or not 1 <= len(value[key]) <= 200 or "\0" in value[key]:
            raise ValueError("Invalid package attachment identity")
    path = value["identityPath"]
    if not isinstance(path, str) or not path.startswith("/") or ".." in PurePosixPath(path).parts or str(PurePosixPath(path)) != path:
        raise ValueError("A canonical pinned guest identity path is required")
    return value


def configured_identity_path():
    config = json.loads(Path("/etc/cantrip-os/executor.json").read_text())
    state = Path(config["state_dir"])
    if not state.is_absolute():
        raise ValueError("The configured executor state location is not absolute")
    return str(state.resolve() / "instance.json")


def actual_identity(expected=None):
    try:
        path = configured_identity_path()
    except (FileNotFoundError, ValueError, UnicodeDecodeError, KeyError, TypeError):
        if expected is None:
            raise
        path = expected["identityPath"]
    try:
        actual = json.loads(Path(path).read_text())
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
        if expected is None or path == expected["identityPath"]:
            raise
        path = expected["identityPath"]
        actual = json.loads(Path(path).read_text())
    return path, actual


def verify_expected(value, require_boot=False):
    if value is None:
        return
    validate_expected(value, require_boot)
    # Read the actual configured identity, including a deliberate state-dir
    # relocation. Only a broken configuration/read can use the known locator;
    # a valid foreign identity never falls back to an old matching file.
    path, actual = actual_identity(value)
    if not isinstance(actual, dict) or actual.get("version") != 1 or actual.get("instance_id") != value["guestInstanceId"]:
        raise ValueError("The package target's persistent OS identity changed")
    if actual.get("attachment") != {"owner_id": value["ownerId"], "worker_id": value["workerId"]}:
        raise ValueError("The package target's owning attachment changed")
    if require_boot and (value["bootId"] != BOOT_ID or value["initStart"] != process_identity(1)["start"]):
        raise ValueError("The admitted package target boot changed")
    return {key: val for key, val in {**value, "identityPath": path}.items() if key not in ("bootId", "initStart")}


def probe(expected):
    if expected is None:
        path, actual = actual_identity()
        attachment = actual["attachment"]
        expected = {"guestInstanceId": actual["instance_id"], "ownerId": attachment["owner_id"],
                    "workerId": attachment["worker_id"], "identityPath": path}
    expected = verify_expected(expected)
    return {"version": 1, "expected": expected, "bootId": BOOT_ID, "initStart": process_identity(1)["start"],
            "architecture": subprocess.check_output(["/usr/bin/dpkg", "--print-architecture"], text=True).strip(),
            "packages": package_status([{"name": name} for name in sorted(ALLOWED)])}


def process_identity(pid):
    try:
        value = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "start": value[19], "boot": BOOT_ID} if value[0] != "Z" else None
    except (FileNotFoundError, ProcessLookupError):
        return None


def request_hash(request):
    return hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)

    def directory(self, operation):
        return self.root / canonical_id(operation)

    @contextlib.contextmanager
    def lock(self, operation):
        with (self.directory(operation) / "operation.lock").open("a") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            yield

    def read(self, operation):
        value = json.loads((self.directory(operation) / "record.json").read_text())
        if value.get("format") != FORMAT or value.get("version") != 1:
            raise ValueError("Unsupported package journal; state was preserved")
        request = validate_request(value["request"])
        if request["operationId"] != operation or value["requestSha256"] != request_hash(request):
            raise ValueError("The saved package admission changed")
        expected = request.get("expected")
        verify_expected({key: val for key, val in expected.items() if key not in ("bootId", "initStart")} if expected else None)
        return value

    def save(self, record):
        record["updatedAt"] = time.time()
        write_json(self.directory(record["request"]["operationId"]) / "record.json", record)

    def inspect(self, operation):
        value = self.read(operation)
        driver, installer = (bool(identity and process_identity(identity["pid"]) == identity)
                             for identity in (value.get("process"), value.get("installer")))
        if (value["state"] == "running" and not driver) or (value["state"] == "staged" and (self.directory(operation) / "start.claim").exists()):
            value["state"] = "unknown"
            value["error"] = "The package coordinator ended without a committed outcome; no installation was repeated"
        value["active"] = driver or installer
        value["installerActive"] = installer
        log = self.directory(operation) / "install.log"
        if log.exists():
            with log.open("rb") as stream:
                stream.seek(max(0, log.stat().st_size - 8192))
                value["diagnostics"] = stream.read().decode("utf-8", "replace")
        else:
            value["diagnostics"] = ""
        return value

    def admit(self, request):
        request = validate_request(request)
        verify_expected(request.get("expected"), require_boot=request["version"] == 2)
        directory = self.directory(request["operationId"])
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            previous = self.read(request["operationId"])
            if previous["request"] != request:
                raise ValueError("The operation ID belongs to a different package admission")
            return self.inspect(request["operationId"])
        sync_directory(self.root)
        now = time.time()
        value = {"format": FORMAT, "version": 1, "request": request,
                 "requestSha256": request_hash(request), "state": "staged", "phase": "admitted",
                 "createdAt": now, "updatedAt": now, "received": [], "process": None,
                 "installer": None, "receipt": None, "error": None}
        self.save(value)
        return self.inspect(request["operationId"])

    def receive(self, operation, sha256):
        with self.lock(operation):
            value = self.read(operation)
            verify_expected(value["request"].get("expected"), require_boot=value["request"]["version"] == 2)
            package = next((p for p in value["request"]["packages"] if p["sha256"] == sha256), None)
            if package is None:
                raise ValueError("Artifact is not in this package admission")
            if value["state"] != "staged" or (self.directory(operation) / "start.claim").exists():
                raise ValueError("Package staging closed before installation")
            destination = self.directory(operation) / (sha256 + ".deb")
            if destination.exists():
                if destination.stat().st_size != package["bytes"] or digest(destination) != sha256:
                    raise ValueError("The retained package artifact changed")
            temporary = destination.with_suffix(".partial-" + uuid.uuid4().hex)
            try:
                length = 0
                with temporary.open("xb") as output:
                    for block in iter(lambda: sys.stdin.buffer.read(1024 * 1024), b""):
                        length += len(block)
                        if length > package["bytes"]:
                            raise ValueError("Package exceeds its admitted byte length")
                        output.write(block)
                    output.flush()
                    os.fsync(output.fileno())
                if length != package["bytes"] or digest(temporary) != sha256:
                    raise ValueError("Package transport checksum differs")
                actual = {field: subprocess.check_output(["dpkg-deb", "--field", str(temporary), field], text=True).strip()
                          for field in ("Package", "Version", "Architecture")}
                if actual != {"Package": package["name"], "Version": package["version"], "Architecture": package["architecture"]}:
                    raise ValueError("The Debian artifact differs from its admitted package/version/architecture")
                if not destination.exists():
                    os.link(temporary, destination)
                sync_directory(destination.parent)
                if sha256 not in value["received"]:
                    value["received"].append(sha256)
                value["phase"] = "ready-to-install" if len(value["received"]) == len(value["request"]["packages"]) else "receiving"
                self.save(value)
            finally:
                temporary.unlink(missing_ok=True)
            return self.inspect(operation)

    def start(self, operation):
        with self.lock(operation):
            value = self.read(operation)
            claim = self.directory(operation) / "start.claim"
            if claim.exists() or value["state"] != "staged":
                return self.inspect(operation)
            verify_expected(value["request"].get("expected"), require_boot=value["request"]["version"] == 2)
            if value["phase"] != "ready-to-install":
                raise ValueError("The admitted artifacts have not all been received")
            # This reservation precedes the only fork. A crash in this boundary
            # stays unknown; repeating start never starts another installer.
            with claim.open("x") as stream:
                stream.write(value["requestSha256"] + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            sync_directory(claim.parent)
            value.update(state="unknown", phase="start-requested")
            self.save(value)
            pid = os.fork()
            if pid == 0:
                try:
                    os.setsid()
                    null = os.open(os.devnull, os.O_RDONLY)
                    log = os.open(str(self.directory(operation) / "install.log"), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                    os.dup2(null, 0)
                    os.dup2(log, 1)
                    os.dup2(log, 2)
                    os.closerange(3, 4096)
                    execute_job(self, operation)
                finally:
                    os._exit(0)
        return self.inspect(operation)

    def abandon(self, operation):
        with self.lock(operation):
            value = self.read(operation)
            claim = self.directory(operation) / "start.claim"
            if claim.exists() or value["state"] != "staged":
                return self.inspect(operation)
            with claim.open("x") as stream:
                stream.write(value["requestSha256"] + "\nabandoned\n")
                stream.flush()
                os.fsync(stream.fileno())
            sync_directory(claim.parent)
            value.update(state="failed", phase="abandoned", error="Staged installation explicitly abandoned; no installer was launched")
            self.save(value)
            return self.inspect(operation)


def package_control(archive):
    raw = subprocess.check_output(["dpkg-deb", "--ctrl-tarfile", str(archive)])
    with tarfile.open(fileobj=io.BytesIO(raw)) as control:
        result = {}
        for item in control:
            name = item.name.removeprefix("./")
            if name in (*SCRIPTS, "conffiles"):
                if not item.isfile() or item.size > 1024 * 1024:
                    raise ValueError("Unsupported package control entry")
                result[name] = control.extractfile(item).read()
    return result


def conffile_paths(package, control):
    result = set()
    old = subprocess.run(["dpkg-query", "--show", "--showformat=${Conffiles}", package["name"]], capture_output=True, text=True)
    if old.returncode == 0:
        for line in old.stdout.splitlines():
            match = re.fullmatch(r" (.+) [0-9a-f]{32}(?: obsolete)?", line)
            if match:
                result.add(match.group(1))
    for line in control.get("conffiles", b"").decode().splitlines():
        if line:
            result.add(line.removeprefix("remove-on-upgrade "))
    for name in result:
        path = PurePosixPath(name)
        if not name.startswith("/") or ".." in path.parts or str(path) != name:
            raise ValueError("Unsupported package conffile path")
    return result


def parent_directories(path):
    for parent in reversed(path.parents):
        if parent.is_symlink():
            raise ValueError("Package repair cannot traverse a symlink directory: " + str(parent))
        if parent.exists() and not parent.is_dir():
            raise ValueError("Package repair parent is not a directory: " + str(parent))
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)


def snapshot(path, directory):
    path = Path(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {"path": str(path), "kind": "missing"}
    result = {"path": str(path), "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid}
    if stat.S_ISLNK(info.st_mode):
        result.update(kind="symlink", target=os.readlink(path))
    elif stat.S_ISREG(info.st_mode):
        result.update(kind="file", sha256=digest(path), bytes=info.st_size)
        if directory is not None:
            directory.mkdir(exist_ok=True, mode=0o700)
            saved = directory / hashlib.sha256(str(path).encode()).hexdigest()
            if not saved.exists():
                with path.open("rb") as source, saved.open("xb") as output:
                    shutil.copyfileobj(source, output)
                    output.flush()
                    os.fsync(output.fileno())
                sync_directory(directory)
            result["retainedOriginal"] = str(saved)
    elif stat.S_ISDIR(info.st_mode):
        result["kind"] = "directory"
    else:
        result["kind"] = "special"
    return result


def replace_file(path, source, mode):
    parent_directories(path)
    temporary = path.with_name(".cantrip-package-" + uuid.uuid4().hex)
    try:
        with temporary.open("xb") as output:
            shutil.copyfileobj(source, output)
            output.flush()
            os.fsync(output.fileno())
        temporary.chmod(mode)
        os.chown(temporary, 0, 0)
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def repair_payload(archive, package, control, configs, policy, directory, retain):
    # dpkg remains the installer. Rescue restores trusted payload/control bytes
    # first because the old prerm can call a broken installed helper. Conffiles
    # are preserved unless replacing them was explicitly admitted.
    raw = subprocess.Popen(["dpkg-deb", "--fsys-tarfile", str(archive)], stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=raw.stdout, mode="r|") as payload:
            for item in payload:
                relative = PurePosixPath(item.name)
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("Package repair payload escapes the guest root")
                if str(relative) == ".":
                    continue
                path = Path("/") / str(relative)
                if str(path) in configs and policy == "preserve":
                    continue
                if item.isdir():
                    parent_directories(path)
                    if not path.exists():
                        path.mkdir(mode=item.mode)
                    continue
                parent_directories(path)
                before = snapshot(path, directory / "saved")
                if before["kind"] in ("directory", "special"):
                    raise ValueError("Package repair will not discard a directory or special entry: " + str(path))
                # The original bytes AND their path/metadata must be durable
                # before any replacement, including an interrupted rescue.
                retain(before)
                if item.isfile():
                    replace_file(path, payload.extractfile(item), item.mode)
                elif item.issym():
                    parent_directories(path)
                    temporary = path.with_name(".cantrip-package-" + uuid.uuid4().hex)
                    try:
                        temporary.symlink_to(item.linkname)
                        os.replace(temporary, path)
                        sync_directory(path.parent)
                    finally:
                        temporary.unlink(missing_ok=True)
                else:
                    raise ValueError("Unsupported package repair payload type: " + str(path))
        if raw.wait() != 0:
            raise RuntimeError("Unable to read the trusted package payload")
    finally:
        if raw.stdout:
            raw.stdout.close()
        if raw.poll() is None:
            raw.kill()
        raw.wait()
    for name in SCRIPTS:
        path = Path("/var/lib/dpkg/info") / (package["name"] + "." + name)
        parent_directories(path)
        before = snapshot(path, directory / "saved")
        if before["kind"] in ("directory", "special"):
            raise ValueError("Unsupported installed maintainer script: " + str(path))
        retain(before)
        if name in control:
            replace_file(path, io.BytesIO(control[name]), 0o755)
        else:
            path.unlink(missing_ok=True)
            sync_directory(path.parent)


def package_status(packages):
    result = []
    for package in packages:
        actual = subprocess.run(["dpkg-query", "--show", "--showformat=${Status}\t${Version}\t${Architecture}", package["name"]], capture_output=True, text=True)
        result.append({"name": package["name"], "exitCode": actual.returncode, "status": actual.stdout.strip(), "diagnostic": actual.stderr[-2048:]})
    return result


def helper_status(packages):
    result = []
    for package in packages:
        program = "/usr/bin/" + package["name"].replace("-os-", "-")
        actual = subprocess.run([program, "status"], capture_output=True)
        result.append({"name": package["name"], "exitCode": actual.returncode,
                       "diagnostic": actual.stderr[-4096:].decode("utf-8", "replace")})
    return result


@contextlib.contextmanager
def repair_locks():
    # Use dpkg's actual POSIX record locks while restoring payload/scripts.
    # An orphaned installer may outlive this operation's coordinator/flock.
    with contextlib.ExitStack() as stack:
        for path in ("/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/lock"):
            stream = stack.enter_context(open(path, "a"))
            fcntl.lockf(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        roots = {"/var/lib/cantrip-os-executor/recovery"}
        try:
            settings = json.loads(Path("/etc/cantrip-os/recovery.json").read_text())
            configured = settings.get("state_dir") if isinstance(settings, dict) else None
            if isinstance(configured, str) and Path(configured).is_absolute():
                roots.add(configured)
        except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
            # Explicit repair must still work with a missing/invalid conffile.
            pass
        for root in sorted(roots):
            Path(root).mkdir(parents=True, exist_ok=True, mode=0o700)
            stream = stack.enter_context(open(Path(root) / "maintenance.lock", "a"))
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def execute_job(store, operation):
    record = store.read(operation)
    record.update(state="running", phase="queued", process=process_identity(os.getpid()))
    store.save(record)
    directory = store.directory(operation)
    installer_started = False
    try:
        with (store.root / "package.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            verify_expected(record["request"].get("expected"), require_boot=record["request"]["version"] == 2)
            packages = record["request"]["packages"]
            archives = [(package, directory / (package["sha256"] + ".deb")) for package in packages]
            for package, archive in archives:
                if archive.stat().st_size != package["bytes"] or digest(archive) != package["sha256"]:
                    raise ValueError("The staged package artifact changed before installation")
            controls = [(package, archive, package_control(archive)) for package, archive in archives]
            configs = set().union(*(conffile_paths(package, control) for package, _, control in controls))
            repairing = record["request"]["action"] == "repair"
            with repair_locks() if repairing else contextlib.nullcontext():
                record["before"] = {"packages": package_status(packages), "configuration": [snapshot(Path(path), directory / "saved") for path in sorted(configs)]}
                record["repaired"] = []
                store.save(record)
                if repairing:
                    record["phase"] = "repairing-payload"
                    store.save(record)
                    def retain(before):
                        record["repaired"].append(before)
                        store.save(record)
                    for package, archive, control in controls:
                        repair_payload(archive, package, control, configs, record["request"]["configuration"], directory, retain)
            record["phase"] = "installing"
            store.save(record)
            environment = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
            child = subprocess.Popen(["dpkg", "--force-confold", "--install", *(str(path) for _, path in archives)], env=environment)
            installer_started = True
            record["installer"] = process_identity(child.pid)
            store.save(record)
            code = child.wait()
            os.fsync(1)
            helpers = helper_status(packages) if code == 0 else []
            errors = [entry["name"] for entry in helpers if entry["exitCode"] != 0]
            record["receipt"] = {"exitCode": code, "packages": package_status(packages),
                                 "helpers": helpers,
                                 "configurationPolicy": record["request"]["configuration"],
                                 "configuration": [snapshot(Path(path), None) for path in sorted(configs)],
                                 "retainedOriginals": str(directory / "saved"), "runtimeHandlesRestored": False}
            error = (f"dpkg exited {code}; partial package state and original configuration were retained" if code != 0
                     else "Installed helper status failed: " + ", ".join(errors) if errors else None)
            record.update(state="ready" if error is None else "failed", phase="complete", error=error)
            store.save(record)
    except BaseException as error:
        # A carrier/coordinator failure is not evidence that dpkg failed or
        # stopped. Keep its identity and never launch a second installer.
        record.update(state="unknown" if installer_started else "failed", phase="recovery-required", error=f"{type(error).__name__}: {error}")
        store.save(record)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", default=DEFAULT_ROOT)
    parser.add_argument("--expect", type=json.loads)
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("probe")
    actions.add_parser("admit").add_argument("request", type=json.loads)
    receive = actions.add_parser("receive")
    receive.add_argument("operation")
    receive.add_argument("sha256")
    for action in ("start", "inspect", "abandon"):
        actions.add_parser(action).add_argument("operation")
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Use sudo for guest package administration")
    os.umask(0o077)
    verify_expected(args.expect)
    if args.action == "probe":
        print(json.dumps(probe(args.expect)))
        return
    store = Store(args.state_dir)
    if args.action == "admit":
        value = store.admit(args.request)
    elif args.action == "receive":
        value = store.receive(args.operation, args.sha256)
    elif args.action == "start":
        value = store.start(args.operation)
    elif args.action == "abandon":
        value = store.abandon(args.operation)
    else:
        value = store.inspect(args.operation)
    print(json.dumps(value))


if __name__ == "__main__":
    main()
