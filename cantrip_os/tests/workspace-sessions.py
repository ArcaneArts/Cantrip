#!/usr/bin/python3
"""Run in a disposable CantripOS instance with the package installed/enabled."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def cli(*args):
    return json.loads(subprocess.check_output(["cantrip-workspaces", *args], text=True))


def run(*args, **options):
    return subprocess.run(args, check=True, **options)


records = {r["id"]: r for r in cli("list")}
for name in ("alpha", "beta", "shell"):
    if name not in records:
        records[name] = cli("create", name)
    cli("stop", name)
    if name != "shell":
        record = records[name]
        startup = Path(record["home"], ".icewm/startup")
        startup.parent.mkdir(exist_ok=True)
        os.chown(startup.parent, record["uid"], -1)
        startup.write_text('#!/bin/sh\ncantrip-browser about:blank >"$HOME/Documents/browser-test.log" 2>&1 &\n')
        startup.chmod(0o700)
        os.chown(startup, record["uid"], -1)
assert cli("show", "shell")["status"] == "stopped"
a = cli("open", "alpha")
b = cli("open", "beta")
assert a["uid"] != b["uid"] and a["display"] != b["display"]
for record in (a, b):
    for _ in range(200):
        if subprocess.run(["pgrep", "-u", str(record["uid"]), "-x", "chromium"], capture_output=True).returncode == 0:
            break
        time.sleep(0.05)
    else:
        raise AssertionError(Path(record["home"], "Documents/browser-test.log").read_text())
for record in (a, b):
    run("runuser", "-u", record["user"], "--", "sudo", "-n", "true")
    run("runuser", "-u", record["user"], "--", "sh", "-c",
        'printf "%s" "$1" > "$HOME/Documents/session-test.txt"', "sh", record["id"],
        env=dict(os.environ, HOME=record["home"]))
    run("xdpyinfo", "-display", ":" + str(record["display"]), stdout=subprocess.DEVNULL)
before = subprocess.check_output(["pgrep", "-u", str(b["uid"]), "-x", "icewm"], text=True)
cli("stop", "alpha")
assert subprocess.run(["pgrep", "-u", str(a["uid"])], capture_output=True).returncode == 1
assert subprocess.check_output(["pgrep", "-u", str(b["uid"]), "-x", "icewm"], text=True) == before
assert cli("show", "beta")["generation"] == b["generation"]
a = cli("open", "alpha")
# Two independent session buses must actually be in the process environments.
buses = []
for record in (a, b):
    pids = subprocess.check_output(["pgrep", "-u", str(record["uid"]), "-x", "icewm"], text=True).split()
    assert len(pids) == 1
    env = subprocess.check_output(["runuser", "-u", record["user"], "--", "cat", "/proc/" + pids[0] + "/environ"]).split(b"\0")
    assert not any(item.startswith(b"DPKG_") for item in env)
    buses.append(next(v for v in env if v.startswith(b"DBUS_SESSION_BUS_ADDRESS=")))
assert buses[0] != buses[1]
run("cantrip-workspaces", "service", "restart")
for record in (a, b):
    current = cli("show", record["id"])
    assert current["status"] == "running" and current["generation"] > record["generation"]
    assert Path(record["home"], "Documents/session-test.txt").read_text() == record["id"]
assert cli("show", "shell")["status"] == "stopped"
# A conflicting display must fail, without touching it or selecting another.
cli("stop", "alpha")
read_fd, write_fd = os.pipe()
foreign = subprocess.Popen(["Xtigervnc", ":" + str(a["display"]), "-SecurityTypes", "None",
                            "-localhost", "yes", "-noreset", "-ac", "-rfbport", str(a["vnc_port"]),
                            "-displayfd", str(write_fd)], pass_fds=(write_fd,),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
os.close(write_fd)
try:
    assert os.read(read_fd, 64).strip() == str(a["display"]).encode()
    result = subprocess.run(["cantrip-workspaces", "open", "alpha"], capture_output=True)
    assert result.returncode != 0 and foreign.poll() is None
    assert cli("show", "alpha")["display"] == a["display"]
    run("xdpyinfo", "-display", ":" + str(b["display"]), stdout=subprocess.DEVNULL)
finally:
    foreign.terminate()
    foreign.wait(timeout=10)
    os.close(read_fd)
cli("open", "alpha")
# Crash the actual daemon. Helpers must clean up their own user processes.
pids = subprocess.check_output(["pgrep", "-f", "/usr/lib/cantrip-os-workspaces/service.py.*daemon"], text=True).split()
assert len(pids) == 1, pids
os.kill(int(pids[0]), signal.SIGKILL)
for _ in range(200):
    if all(subprocess.run(["pgrep", "-u", str(r["uid"])], capture_output=True).returncode == 1 for r in (a, b)):
        break
    time.sleep(0.05)
else:
    raise AssertionError("Workspace descendants survived manager crash")
run("cantrip-workspaces", "service", "start")
assert all(cli("show", r["id"])["status"] == "running" for r in (a, b))
run("xdpyinfo", "-display", ":0", stdout=subprocess.DEVNULL)
print("Workspace identity, separation, stop/restart and manager-crash recovery: PASS")
