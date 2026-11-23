"""A root lifetime guardian; native CUA runs as the assigned workspace account."""
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time
from context import verify
from bridge import pump

sys.path.append("/usr/lib/cantrip-os-executor")
from process_tree import supervise, cleanup

parent, ready = sys.argv[1:]
configuration = json.loads(sys.stdin.buffer.readline(65536))
context = configuration["context"]
stopping = False


def stop(*_):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
supervise(int(parent))
lock = (Path(ready).parent / (context["workspace_id"] + ".lock")).open("a")
while not stopping:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        time.sleep(.05)
if stopping:
    sys.exit(0)
record = verify(context["workspace_id"], context)
env = {key: value for key, value in os.environ.items() if key in ("LANG", "LC_ALL", "TZ")}
env.update(HOME=record["home"], USER=record["user"], LOGNAME=record["user"],
           PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
           DISPLAY=":" + str(record["display"]), XDG_RUNTIME_DIR="/run/user/" + str(record["uid"]))
read_fd, write_fd = os.pipe()
child = None
try:
    child = subprocess.Popen(["/usr/lib/cantrip-os-remote/cantrip-cua", "--x11-display", env["DISPLAY"],
                              "--desktop-generation", record["desktop_generation"], "--ready-fd", str(write_fd)],
                             cwd=record["home"], env=env, user=record["uid"], group=record["gid"],
                             extra_groups=os.getgrouplist(record["user"], record["gid"]), pass_fds=(write_fd,),
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
    os.close(write_fd)
    write_fd = None
    deadline = time.monotonic() + 30
    while not stopping:
        if select.select([read_fd], [], [], .05)[0]:
            if os.read(read_fd, 1) != b"1":
                raise RuntimeError("Native desktop connection failed")
            # The helper already holds its X connection. A simultaneous desktop
            # replacement must fail before any caller frames are forwarded.
            verify(record["workspace_id"], record)
            Path(ready).write_text('{"ready":true}\n')
            break
        if child.poll() is not None or time.monotonic() >= deadline:
            raise RuntimeError("Native desktop did not open its assigned X connection")
    if not stopping:
        pump(sys.stdin.fileno(), sys.stdout.fileno(), child.stdout.fileno(), child.stdin.fileno(),
             lambda: stopping or child.poll() is not None)

finally:
    os.close(read_fd)
    if write_fd is not None:
        os.close(write_fd)
    if child is not None:
        # EOF gives the native runtime time to cancel jobs and release held
        # input. Forced termination is fallback cleanup, never a replay.
        try:
            child.stdin.close()
        except (OSError, BrokenPipeError):
            pass
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.terminate()
    cleanup()
    Path(ready).unlink(missing_ok=True)
