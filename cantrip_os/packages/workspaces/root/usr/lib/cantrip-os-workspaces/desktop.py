#!/usr/bin/python3
"""One workspace's root supervisor. Reaps and stops only its own descendants."""
import ctypes
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time

parent, runtime, ready, data = sys.argv[1:]
record = json.loads(data)
stopping = False


def stop(signum, frame):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
libc = ctypes.CDLL(None, use_errno=True)
libc.prctl.argtypes = [ctypes.c_int] + [ctypes.c_ulong] * 4
for option, value in ((36, 1), (1, signal.SIGTERM)):  # SUBREAPER, PDEATHSIG
    if libc.prctl(option, value, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl")
if os.getppid() != int(parent):
    sys.exit("Workspace manager exited during startup")


def descendants():
    # Linux supplies the live child identities, including adopted double forks.
    found = []
    pending = [os.getpid()]
    while pending:
        pid = pending.pop()
        try:
            children = set()
            for task in Path(f"/proc/{pid}/task").iterdir():
                try:
                    children.update((task / "children").read_text().split())
                except FileNotFoundError:
                    pass
        except FileNotFoundError:
            continue
        for value in children:
            child = int(value)
            found.append(child)
            pending.append(child)
    return found


def cleanup():
    for sig, duration in ((signal.SIGTERM, 5), (signal.SIGKILL, 5)):
        deadline = time.monotonic() + duration
        while True:
            for pid in reversed(descendants()):
                try:
                    fd = os.pidfd_open(pid)
                    try:
                        # Pin the process first, then verify its live ancestry.
                        # A recycled PID must never receive our cleanup signal.
                        ancestor = pid
                        while ancestor != os.getpid() and ancestor > 1:
                            text = Path(f"/proc/{ancestor}/status").read_text()
                            ancestor = int(next(line.split()[1] for line in text.splitlines() if line.startswith("PPid:")))
                        if ancestor == os.getpid():
                            signal.pidfd_send_signal(fd, sig)
                    finally:
                        os.close(fd)
                except (ProcessLookupError, FileNotFoundError):
                    pass
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                    if not pid:
                        break
                except ChildProcessError:
                    return
            if time.monotonic() >= deadline:
                break
            time.sleep(0.05)
    raise RuntimeError("Workspace children did not exit")


with (Path(runtime) / (record["id"] + ".lock")).open("a") as lock:
    # Wait for the preceding supervisor's actual cleanup after a manager crash.
    while not stopping:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            time.sleep(0.05)
    if stopping:
        sys.exit(0)
    directory = Path("/run/user") / str(record["uid"])
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chown(directory, record["uid"], -1)
    directory.chmod(0o700)
    inherited = {key: value for key, value in os.environ.items()
                 if key in ("LANG", "LC_ALL", "TZ", "CANTRIP_OS_CONTAINER",
                            "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy")}
    env = dict(inherited, HOME=record["home"], USER=record["user"], LOGNAME=record["user"],
               PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
               DISPLAY=":" + str(record["display"]), XDG_RUNTIME_DIR=str(directory),
               XDG_SESSION_TYPE="x11", XDG_CURRENT_DESKTOP="ICEWM")
    for key in ("DBUS_SESSION_BUS_ADDRESS", "DBUS_SESSION_BUS_PID", "SESSION_MANAGER", "XAUTHORITY"):
        env.pop(key, None)
    read_fd = None
    try:
        read_fd, write_fd = os.pipe()
        try:
            vnc = subprocess.Popen(["runuser", "-u", record["user"], "--", "Xtigervnc",
                                    env["DISPLAY"], "-geometry", "1440x900", "-depth", "24",
                                    "-SecurityTypes", "None", "-localhost", "yes", "-AlwaysShared",
                                    "-ac", "-noreset", "-nolisten", "tcp", "-rfbport", str(record["vnc_port"]),
                                    "-rfbunixpath", record["vnc_socket"], "-rfbunixmode", "0600",
                                    "-displayfd", str(write_fd)], env=env, pass_fds=(write_fd,))
        finally:
            os.close(write_fd)
        try:
            deadline = time.monotonic() + 25
            while not stopping:
                if select.select([read_fd], [], [], 0.1)[0]:
                    actual = os.read(read_fd, 64).decode().strip()
                    if actual != str(record["display"]):
                        raise RuntimeError(f"X server did not open its assigned display: {actual!r}")
                    break
                if vnc.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("X server failed to open its assigned display")
        except BaseException:
            os.close(read_fd)
            read_fd = None
            raise
        if stopping:
            sys.exit(0)
        child = subprocess.Popen(["runuser", "-u", record["user"], "--", "dbus-run-session", "--",
                                  str(Path(__file__).with_name("desktop.sh"))], env=env)
        while not stopping and child.poll() is None and vnc.poll() is None:
            # X servers can notify again during initialization/reset. Keep the
            # reader alive for the server's lifetime and drain later notices.
            if select.select([read_fd], [], [], 0)[0]:
                os.read(read_fd, 4096)
            direct = Path(f"/proc/{os.getpid()}/task/{os.getpid()}/children").read_text().split()
            for value in direct:
                pid = int(value)
                if pid not in (child.pid, vnc.pid):
                    try:
                        os.waitpid(pid, os.WNOHANG)
                    except ChildProcessError:
                        pass
            if not Path(ready).exists():
                result = subprocess.run(["xprop", "-display", env["DISPLAY"], "-root", "_NET_SUPPORTING_WM_CHECK"],
                                        capture_output=True, text=True, timeout=5, env=dict(env, LC_ALL="C"))
                if result.returncode == 0 and "window id # 0x" in result.stdout:
                    Path(ready).write_text('{"ready":true}\n')
            time.sleep(0.1)
        if not stopping:
            raise RuntimeError(f"Desktop or X server exited (session={child.poll()}, X={vnc.poll()})")
    finally:
        try:
            cleanup()
        finally:
            if read_fd is not None:
                os.close(read_fd)
            Path(record["vnc_socket"]).unlink(missing_ok=True)
