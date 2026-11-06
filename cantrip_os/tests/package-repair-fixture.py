"""Root-only fixture for disposable Docker/installed-VM package acceptance."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import time


def run(*args, check=True):
    result = subprocess.run(args, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr.decode())
    return result


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def identity(pid):
    try:
        value = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "start": value[19], "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip()} if value[0] != "Z" else None
    except FileNotFoundError:
        return None


def package(path):
    return {"name": "cantrip-os-recovery", "version": run("dpkg-deb", "-f", str(path), "Version").stdout.decode().strip(),
            "architecture": "all", "sha256": sha(path), "bytes": path.stat().st_size}


def observe(root):
    account = json.loads((root / "account.json").read_text())
    home = Path(account["home"])
    files = [home / "repo/tracked", home / "repo/.env", home / "repo/雪-😀", home / "repo/node_modules/dependency", home / ".config/chromium/History", root / "root-marker"]
    return {"account": {key: account[key] for key in ("id", "uid", "gid", "home")},
            "homeInode": home.stat().st_ino,
            "files": [{"path": str(p), "sha256": sha(p), "mode": p.stat().st_mode, "uid": p.stat().st_uid, "gid": p.stat().st_gid} for p in files],
            "rootMarker": sha(Path((root / "root-marker").read_text())),
            "helperSha256": sha("/usr/lib/cantrip-os-recovery/main.py"),
            "git": run("git", "-c", "safe.directory=*", "-C", str(home / "repo"), "status", "--porcelain=v1", "--untracked-files=all").stdout.decode(),
            "instance": json.loads(run("cantrip-executor", "status").stdout)["instance_id"]}


action, location, *args = sys.argv[1:]
root = Path(location)
config = Path("/etc/cantrip-os/recovery.json")
if action == "prepare":
    root.mkdir(mode=0o700)
    shutil.copyfile(args[0], root / "good.deb")
    (root / "original-config").write_bytes(config.read_bytes())
    custom = json.dumps(json.loads(config.read_bytes()), indent=8).encode() + b"\n\n"
    config.write_bytes(custom)
    (root / "custom-config").write_bytes(custom)
    stage = root / "defaults"
    run("dpkg-deb", "-x", str(root / "good.deb"), str(stage))
    (root / "default-config").write_bytes((stage / "etc/cantrip-os/recovery.json").read_bytes())
    name = "pkg-" + root.name[-12:]
    run("cantrip-workspaces", "create", name)
    sys.path.insert(0, "/usr/lib/cantrip-os-recovery")
    from state import workspace
    account = workspace(name)
    (root / "account.json").write_text(json.dumps(account))
    home = Path(account["home"])
    repo = home / "repo"
    repo.mkdir()
    def git(*argv):
        return run("git", "-c", "safe.directory=*", "-C", str(repo), *argv)
    git("init")
    (repo / "tracked").write_text("committed")
    (repo / ".gitignore").write_text(".env\nnode_modules/\n")
    git("add", ".")
    git("-c", "user.name=Package fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture")
    (repo / "tracked").write_text("dirty package-upgrade proof")
    (repo / ".env").write_text("DUMMY_PRIVATE=retained")
    (repo / "雪-😀").write_text("Unicode data")
    (repo / "node_modules").mkdir()
    (repo / "node_modules/dependency").write_text("ignored dependency")
    profile = home / ".config/chromium"
    profile.mkdir(parents=True)
    with sqlite3.connect(profile / "History") as db:
        db.execute("CREATE TABLE visits (url text)")
        db.execute("INSERT INTO visits VALUES ('https://example.invalid/package')")
    for directory, _, files in os.walk(home):
        for path in [Path(directory), *(Path(directory) / name for name in files)]:
            os.chown(path, account["uid"], account["gid"])
    (repo / ".env").chmod(0o640)
    marker = Path("/etc") / root.name
    marker.write_bytes(b"arbitrary root customization\0\xff")
    (root / "root-marker").write_text(str(marker))
    print(json.dumps(observe(root)))
elif action == "build":
    kind = args[0]
    stage = root / kind
    run("dpkg-deb", "-R", str(root / "good.deb"), str(stage))
    control = stage / "DEBIAN/control"
    original_version = package(root / "good.deb")["version"]
    version = original_version + "-test" + kind
    control.write_text(control.read_text().replace("Version: " + original_version, "Version: " + version))
    if kind == "bad":
        for name in ("main.py", "package_job.py"):
            (stage / "usr/lib/cantrip-os-recovery" / name).write_text("raise RuntimeError('deliberately broken installed helper')\n")
        # A different shipped default makes --force-confold meaningful.
        (stage / "etc/cantrip-os/recovery.json").write_text('{"version":1,"state_dir":"/var/lib/cantrip-os-executor/recovery","fixtureDefault":true}\n')
        # Debian can recover a failed old prerm with the new prerm's
        # failed-upgrade fallback. A genuinely broken postrm, absent from the
        # good package, leaves a real failed upgrade requiring explicit repair.
        postrm = stage / "DEBIAN/postrm"
        postrm.write_text("#!/bin/sh\nexit 78\n")
        postrm.chmod(0o755)
    counter = root / (kind + "-counter")
    postinst = stage / "DEBIAN/postinst"
    waiting = ("n=0\nwhile [ ! -e '" + str(root / "orphan-release") + "' ] && [ \"$n\" -lt 300 ]; do sleep 0.1; n=$((n + 1)); done\ntest -e '" + str(root / "orphan-release") + "'\n") if kind == "orphan" else "sleep 8\n"
    postinst.write_text("#!/bin/sh\nset -eu\nif [ \"$1\" = configure ]; then\nprintf '%s\\n' \"$$\" >> '" + str(counter) + "'\n" + ("exit 79\nfi\nexit 0\n" if kind == "bad" else waiting + "fi\n" + postinst.read_text().removeprefix("#!/bin/sh\n")))
    postinst.chmod(0o755)
    archive = root / (kind + ".deb")
    run("dpkg-deb", "--root-owner-group", "-b", str(stage), str(archive))
    print(json.dumps({"package": package(archive), "archive": base64.b64encode(archive.read_bytes()).decode()}))
elif action == "probe":
    helpers = [run("cantrip-recovery", "status", check=False), run("cantrip-package", "inspect", args[0], check=False)]
    naive = run("dpkg", "--force-confold", "--install", str(root / "good.deb"), check=False)
    print(json.dumps({"helpers": [p.returncode for p in helpers], "naiveExit": naive.returncode, "naiveDiagnostic": naive.stderr.decode()[-4096:], "configSha256": sha(config)}))
elif action == "inspect":
    print(json.dumps({**observe(root), "configSha256": sha(config), "customSha256": sha(root / "custom-config"), "defaultSha256": sha(root / "default-config"),
                      "counters": {name: (root / (name + "-counter")).read_text().splitlines() if (root / (name + "-counter")).exists() else [] for name in ("bad", "slow", "orphan", "staged", "abandoned")}}))
elif action == "corrupt-config":
    config.write_bytes(b"invalid customized configuration\n")
    print(json.dumps({"sha256": sha(config)}))
elif action == "saved":
    record = json.loads(Path(args[0]).read_text())
    originals = record["before"]["configuration"]
    original = next(p for p in originals if p["path"] == str(config))
    print(json.dumps({"beforeSha256": original["sha256"], "retainedSha256": sha(original["retainedOriginal"])}))
elif action == "kill":
    expected = json.loads(args[0])
    if identity(expected["pid"]) != expected:
        raise RuntimeError("Acceptance process identity changed")
    os.kill(expected["pid"], signal.SIGKILL)
    print("{}")
elif action == "carrier":
    expected = json.loads((root / "carrier.json").read_text())
    print(json.dumps({"identity": expected, "active": identity(expected["pid"]) == expected}))
elif action == "maintenance":
    settings = json.loads(config.read_bytes())
    lock = (Path(settings["state_dir"]) / "maintenance.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    pid = os.fork()
    if pid == 0:
        os.setsid()
        null = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(null, fd)
        time.sleep(60)
        os._exit(0)
    lock.close()
    print(json.dumps(identity(pid)))
elif action == "release":
    (root / "orphan-release").touch()
    print("{}")
elif action == "identity-change":
    path = Path(args[0])
    shutil.copy2(path, root / "original-identity")
    (root / "identity-path").write_text(str(path))
    value = json.loads(path.read_bytes())
    value["attachment"]["owner_id"] = "00000000-0000-4000-8000-999999999999"
    temporary = path.with_name(path.name + "." + root.name)
    temporary.write_text(json.dumps(value))
    temporary.chmod(path.stat().st_mode & 0o777)
    os.replace(temporary, path)
    print("{}")
elif action == "identity-restore":
    path = Path((root / "identity-path").read_text())
    temporary = path.with_name(path.name + "." + root.name)
    shutil.copy2(root / "original-identity", temporary)
    os.replace(temporary, path)
    print("{}")
elif action == "identity-relocate":
    path = Path("/etc/cantrip-os/executor.json")
    shutil.copy2(path, root / "original-executor-config")
    settings = json.loads(path.read_bytes())
    current = Path(settings["state_dir"])
    relocated = root / "executor-state"
    relocated.mkdir(mode=0o700)
    shutil.copy2(current / "instance.json", relocated / "instance.json")
    settings["state_dir"] = str(relocated)
    temporary = path.with_name(path.name + "." + root.name)
    temporary.write_text(json.dumps(settings))
    temporary.chmod(path.stat().st_mode & 0o777)
    os.replace(temporary, path)
    print(json.dumps({"identityPath": str(relocated / "instance.json")}))
elif action == "identity-unrelocate":
    path = Path("/etc/cantrip-os/executor.json")
    temporary = path.with_name(path.name + "." + root.name)
    shutil.copy2(root / "original-executor-config", temporary)
    os.replace(temporary, path)
    print("{}")
elif action == "executor-break":
    path = Path("/usr/bin/cantrip-executor")
    shutil.copy2(path, root / "original-executor")
    temporary = path.with_name(".cantrip-executor-" + root.name)
    temporary.write_text("#!/bin/sh\nexit 76\n")
    temporary.chmod(0o755)
    os.replace(temporary, path)
    print(json.dumps({"exitCode": run(str(path), "status", check=False).returncode}))
elif action == "executor-restore":
    path = Path("/usr/bin/cantrip-executor")
    temporary = path.with_name(".cantrip-executor-" + root.name)
    shutil.copy2(root / "original-executor", temporary)
    os.replace(temporary, path)
    print(json.dumps({"exitCode": run(str(path), "status", check=False).returncode}))
elif action == "record-exists":
    print(json.dumps({"exists": (Path("/var/lib/cantrip-os-executor/package-operations") / args[0] / "record.json").exists()}))
elif action == "cleanup":
    config.write_bytes((root / "original-config").read_bytes())
    print("{}")
else:
    raise ValueError("Unknown acceptance action")
