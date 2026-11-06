#!/usr/bin/python3
"""Run as root in a disposable CantripOS with workspace package 0.4.0 installed."""
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import uuid


def cli(*args):
    return json.loads(subprocess.check_output(["cantrip-workspaces", *args], text=True))


def checked(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def request(action, name):
    return {"operation_id": str(uuid.uuid4()), "action": action,
            "scope_key": hashlib.sha256(b"disposable-desktop-acceptance").hexdigest(),
            "target": cli("desktop-target", name)}


def operation(command, value):
    return cli(command, json.dumps(value))


def xpid(target):
    return subprocess.check_output(["pgrep", "-u", str(target["uid"]), "-x", "Xtigervnc"], text=True).strip()


def eventually(observe, predicate):
    deadline = time.monotonic() + 40
    while True:
        try:
            value = observe()
            if predicate(value):
                return value
        except (subprocess.SubprocessError, ValueError, FileNotFoundError):
            pass
        if time.monotonic() >= deadline:
            raise AssertionError("Actual service did not reach its requested state")
        time.sleep(0.05)


root = Path(tempfile.mkdtemp(prefix="cantrip-desktop-acceptance-"))
root.chmod(0o700)
proof = {"root": str(root), "cases": []}
records = {record["id"]: record for record in cli("list")}
for name in ("desk-a", "desk-b"):
    if name not in records:
        cli("create", name)
    cli("open", name)
a, b = (cli("desktop-target", name) for name in ("desk-a", "desk-b"))
assert a["status"] == b["status"] == "running"
home = Path(a["home"])
marker = home / "Documents" / ("desktop-" + uuid.uuid4().hex)
marker.write_text("日本語 🖤 retained through desktop lifecycle\n")
marker.chmod(0o640)
os.chown(marker, a["uid"], a["gid"])
before_bytes = marker.read_bytes()
before_mode = marker.stat().st_mode & 0o777
# This shell has the selected account but no desktop ancestry or session bus.
shell = subprocess.Popen(["runuser", "-u", a["user"], "--", "sleep", "600"])

try:
    before_b = cli("desktop-target", "desk-b")
    before_b_pid = xpid(b)
    stop_request = request("stop", "desk-a")
    stopped = operation("desktop-execute", stop_request)
    assert stopped["state"] == "ready" and stopped["current"]["status"] == "stopped"
    assert shell.poll() is None
    assert cli("desktop-target", "desk-b") == before_b and xpid(b) == before_b_pid
    start_request = request("start", "desk-a")
    started = operation("desktop-execute", start_request)
    assert started["state"] == "ready" and started["current"]["status"] == "running"
    assert shell.poll() is None
    assert marker.read_bytes() == before_bytes and marker.stat().st_mode & 0o777 == before_mode
    assert marker.stat().st_uid == a["uid"] and marker.stat().st_gid == a["gid"]
    proof["cases"].append({"case": "independent-desktop-and-shell-lifetimes", "stop": stopped, "start": started})

    # Send the actual command then drop its socket, without consuming a receipt.
    restart_request = request("restart", "desk-a")
    config = json.loads(Path("/etc/cantrip-os/workspaces.json").read_text())
    with socket.socket(socket.AF_UNIX) as channel:
        channel.connect(str(Path(config["runtime_dir"]) / "control.sock"))
        channel.sendall(json.dumps({"command": "desktop-execute", "id": json.dumps(restart_request)}).encode() + b"\n")
    recovered = operation("desktop-observe", restart_request)
    assert recovered["state"] == "ready"
    assert recovered["current"]["generation"] == restart_request["target"]["generation"] + 1
    after_restart = recovered["current"]
    after_restart_pid = xpid(after_restart)
    for _ in range(2):
        assert operation("desktop-execute", restart_request)["receipt"] == recovered["receipt"]
        assert cli("desktop-target", "desk-a") == after_restart
        assert xpid(after_restart) == after_restart_pid
    assert cli("desktop-target", "desk-b") == before_b and xpid(b) == before_b_pid
    assert shell.poll() is None
    proof["cases"].append({"case": "actual-restart-dropped-reply-no-replay", "request": restart_request, "result": recovered})

    changed = {**restart_request, "action": "stop"}
    rejected = subprocess.run(["cantrip-workspaces", "desktop-execute", json.dumps(changed)], capture_output=True, text=True)
    assert rejected.returncode != 0 and "another admission" in rejected.stderr
    assert cli("desktop-target", "desk-a") == after_restart and xpid(after_restart) == after_restart_pid
    missing = request("restart", "desk-a")
    assert operation("desktop-observe", missing) is None
    damaged = Path(config["state_dir"]) / "desktop-operations" / (missing["operation_id"] + ".json")
    damaged.write_text("{damaged")
    damaged.chmod(0o600)
    rejected = subprocess.run(["cantrip-workspaces", "desktop-execute", json.dumps(missing)], capture_output=True)
    assert rejected.returncode != 0 and damaged.read_text() == "{damaged"
    assert cli("desktop-target", "desk-a") == after_restart and xpid(after_restart) == after_restart_pid
    proof["cases"].append({"case": "changed-missing-corrupt-admission-no-mutation", "damaged": str(damaged)})

    # Temporary QA-only injection kills the actual daemon after the desktop
    # restart finishes, immediately before it can save the successful receipt.
    checked("cantrip-workspaces", "service", "stop")
    armed = str(uuid.uuid4())
    wrapper = root / "fault-daemon.py"
    wrapper.write_text('''import os, signal, sys
sys.path.insert(0, "/usr/lib/cantrip-os-workspaces")
import service
original = service.atomic_json
def write(path, value, exclusive=False):
    if value.get("request", {}).get("operation_id") == sys.argv[1] and value.get("state") == "ready":
        os.kill(os.getpid(), signal.SIGKILL)
    return original(path, value, exclusive=exclusive)
service.atomic_json = write
sys.argv = [service.__file__, "daemon"]
service.main()
'''.replace('== sys.argv[1]', '== ' + repr(armed)))
    with (root / "fault-daemon.log").open("w") as log:
        daemon = subprocess.Popen(["python3", str(wrapper), armed], stdout=log, stderr=subprocess.STDOUT)
    eventually(lambda: cli("status"), lambda value: value["service"] == "running")
    interrupted_request = request("restart", "desk-a")
    interrupted_request["operation_id"] = armed
    failed_client = subprocess.run(["cantrip-workspaces", "desktop-execute", json.dumps(interrupted_request)], capture_output=True)
    assert failed_client.returncode != 0
    assert daemon.wait(timeout=15) == -signal.SIGKILL
    journal = Path(config["state_dir"]) / "desktop-operations" / (armed + ".json")
    assert json.loads(journal.read_text())["state"] == "dispatched"
    assert shell.poll() is None
    checked("cantrip-workspaces", "service", "start")
    result = operation("desktop-observe", interrupted_request)
    assert result["state"] == "ready" and result["receipt"]["completion"] == "observed-state"
    latest, latest_pid = result["current"], xpid(result["current"])
    assert operation("desktop-execute", interrupted_request)["receipt"] == result["receipt"]
    assert cli("desktop-target", "desk-a") == latest and xpid(latest) == latest_pid
    assert marker.read_bytes() == before_bytes and marker.stat().st_mode & 0o777 == before_mode
    assert shell.poll() is None
    checked("xdpyinfo", "-display", ":0", stdout=subprocess.DEVNULL)
    proof["cases"].append({"case": "actual-daemon-kill-after-mutation-observe-without-replay", "request": interrupted_request, "result": result})
    checked("cantrip-workspaces", "disable")
    offline = operation("desktop-observe", interrupted_request)
    assert offline["receipt"] == result["receipt"] and offline["state"] == "ready"
    assert offline["current"] is None and "unavailable" in offline["current_error"]
    refused_request = {**interrupted_request, "operation_id": str(uuid.uuid4()), "action": "start", "target": latest}
    refused = subprocess.run(["cantrip-workspaces", "desktop-execute", json.dumps(refused_request)], capture_output=True)
    assert refused.returncode != 0
    assert cli("status")["service"] == "stopped" and not cli("status")["enabled"]
    assert shell.poll() is None
    checked("cantrip-workspaces", "enable")
    assert operation("desktop-observe", interrupted_request)["receipt"] == result["receipt"]
    proof["cases"].append({"case": "disabled-service-retains-history-without-starting-desktop", "result": offline})
    proof["result"] = "pass"
finally:
    shell.terminate()
    shell.wait(timeout=10)
    output = root / "proof.json"
    output.write_text(json.dumps(proof, indent=2) + "\n")
    output.chmod(0o600)
    print("Desktop lifecycle proof: " + str(output), flush=True)

print("Durable desktop operations, retained files, independent shell/desktop and daemon recovery: PASS")
