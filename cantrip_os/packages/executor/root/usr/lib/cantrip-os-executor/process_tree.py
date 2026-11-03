"""Linux child ownership for the executor supervisor, including double forks."""
import ctypes
import os
from pathlib import Path
import signal
import time


def supervise(parent):
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int] + [ctypes.c_ulong] * 4
    for option, value in ((36, 1), (1, signal.SIGTERM)):
        if libc.prctl(option, value, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "prctl")
    if os.getppid() != parent:
        raise RuntimeError("Executor manager exited during startup")


def descendants():
    found, pending = [], [os.getpid()]
    while pending:
        pid = pending.pop()
        try:
            for task in Path(f"/proc/{pid}/task").iterdir():
                try:
                    children = [int(p) for p in (task / "children").read_text().split()]
                    found.extend(children)
                    pending.extend(children)
                except FileNotFoundError:
                    pass
        except FileNotFoundError:
            pass
    return found


def reap(exclude=()):
    if exclude:
        children = Path(f"/proc/{os.getpid()}/task/{os.getpid()}/children").read_text().split()
        for value in children:
            pid = int(value)
            if pid not in exclude:
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass
        return
    while True:
        try:
            if not os.waitpid(-1, os.WNOHANG)[0]:
                return
        except ChildProcessError:
            return


def cleanup():
    for sig in (signal.SIGTERM, signal.SIGKILL):
        deadline = time.monotonic() + 5
        while True:
            for pid in reversed(descendants()):
                try:
                    fd = os.pidfd_open(pid)
                    try:
                        ancestor = pid
                        while ancestor > 1 and ancestor != os.getpid():
                            text = Path(f"/proc/{ancestor}/status").read_text()
                            ancestor = int(next(s.split()[1] for s in text.splitlines() if s.startswith("PPid:")))
                        if ancestor == os.getpid():
                            signal.pidfd_send_signal(fd, sig)
                    finally:
                        os.close(fd)
                except (ProcessLookupError, FileNotFoundError):
                    pass
            reap()
            if not descendants():
                return
            if time.monotonic() >= deadline:
                break
            time.sleep(.05)
    raise RuntimeError("Executor descendants did not exit")
