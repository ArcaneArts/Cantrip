#!/usr/bin/python3
"""One root supervisor; the native executor and commands run as the workspace user."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time
from urllib.parse import urlsplit
from process_tree import cleanup, reap, supervise

parent, runtime, ready = sys.argv[1:]
data = json.load(sys.stdin)
record = data["workspace"]
stopping = False


def stop(*_):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
supervise(int(parent))
with (Path(runtime) / (record["id"] + ".lock")).open("a") as lock:
    while not stopping:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            time.sleep(.05)
    if stopping:
        sys.exit(0)
    env = {key: value for key, value in os.environ.items() if key in ("LANG", "LC_ALL", "TZ", "CANTRIP_OS_CONTAINER")}
    env.update(HOME=record["home"], USER=record["user"], LOGNAME=record["user"],
               PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
               CODEX_HOME=record["home"] + "/.local/state/cantrip-executor")
    digest = hashlib.sha256(data["token"].encode()).hexdigest()
    try:
        subprocess.run(["runuser", "-u", record["user"], "--", "mkdir", "-p", env["CODEX_HOME"]],
                       cwd=record["home"], env=env, check=True)
        child = subprocess.Popen(["runuser", "-u", record["user"], "--",
                                  "/usr/lib/cantrip-os-executor/runtime/codex-exec-server",
                                  "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token",
                                  "--ws-token-sha256", digest], cwd=record["home"], env=env,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
        deadline = time.monotonic() + 30
        while not stopping:
            if select.select([child.stdout], [], [], .1)[0]:
                url = child.stdout.readline(4096).decode().strip()
                parsed = urlsplit(url)
                if parsed.scheme != "ws" or parsed.hostname != "127.0.0.1" or not parsed.port:
                    raise RuntimeError("Executor did not publish its loopback endpoint")
                Path(ready).write_text(json.dumps({"url": url}))
                break
            if child.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError("Native executor did not start; inspect executor logs")
        while not stopping and child.poll() is None:
            reap((child.pid,))
            # stdout after the endpoint is diagnostic output, never transport.
            if select.select([child.stdout], [], [], .1)[0]:
                chunk = os.read(child.stdout.fileno(), 4096)
                if chunk:
                    os.write(1, chunk)
        if not stopping:
            raise RuntimeError(f"Native executor exited {child.returncode}")
    finally:
        cleanup()
