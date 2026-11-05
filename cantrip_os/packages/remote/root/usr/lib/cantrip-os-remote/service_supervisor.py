"""Root lifetime guardian for one protected SSH/VNC/TCP connection."""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
from context import observe_workspace, observe
from services import public_key
from bridge import stream_pump

sys.path.append("/usr/lib/cantrip-os-executor")
from process_tree import supervise, cleanup

HERE = Path(__file__).parent
parent, ready = sys.argv[1:]
configuration = json.loads(sys.stdin.buffer.readline(65536))
context = configuration["context"]
stopping = False


def stop(*_):
    global stopping
    stopping = True


def verify():
    actual, record = observe_workspace(context["workspace_id"])
    if context["service"]["kind"] == "vnc":
        actual = observe(context["workspace_id"])
    if any(context.get(key) != value for key, value in actual.items()):
        raise ValueError("Remote service attachment or generation mismatch")
    return record


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
supervise(int(parent))
connection = None
child = None
auth = Path(ready + ".keys")
try:
    record = verify()
    kind = context["service"]["kind"]
    if kind == "ssh":
        Path("/run/sshd").mkdir(mode=0o755, exist_ok=True)
        auth.write_text(public_key(configuration["public_key"]) + "\n")
        auth.chmod(0o600)
        # inetd mode owns exactly this connection. No guest port is published.
        # A real connected socket supplies OpenSSH's peer-address semantics.
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            connection = socket.create_connection(listener.getsockname(), timeout=10)
            accepted, _ = listener.accept()
        options = {
            "HostKey": configuration["host_key"],
            "SshdSessionPath": str(HERE / "openssh/sshd-session"),
            "SshdAuthPath": str(HERE / "openssh/sshd-auth"),
            "PAMServiceName": "cantrip-os-remote", "UsePAM": "yes",
            "AllowUsers": context["user"], "PermitRootLogin": "no",
            "AuthenticationMethods": "publickey", "PubkeyAuthentication": "yes",
            "AuthorizedKeysFile": "none", "AuthorizedKeysCommand": "/usr/bin/cat " + str(auth),
            "AuthorizedKeysCommandUser": "root", "PasswordAuthentication": "no",
            "KbdInteractiveAuthentication": "no", "PermitEmptyPasswords": "no",
            "DisableForwarding": "yes", "PermitUserEnvironment": "no", "PermitUserRC": "no",
            "PrintMotd": "no", "PrintLastLog": "no", "LoginGraceTime": "30",
            "Subsystem": "sftp internal-sftp", "LogLevel": "ERROR",
        }
        argv = [str(HERE / "openssh/sshd"), "-i", "-e", "-f", "/dev/null"]
        for key, value in options.items():
            argv.extend(("-o", key + "=" + value))
        env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"}
        try:
            child = subprocess.Popen(argv, stdin=accepted, stdout=accepted, env=env)
        finally:
            accepted.close()
    elif kind == "vnc":
        connection = socket.socket(socket.AF_UNIX)
        connection.settimeout(10)
        connection.connect(record["vnc_socket"])
    else:
        connection = socket.create_connection(("127.0.0.1", context["service"]["port"]), timeout=10)
    verify()
    Path(ready).write_text('{"ready":true}\n')
    stream_pump(sys.stdin.fileno(), sys.stdout.fileno(), connection.fileno(), connection.fileno(),
                lambda: stopping, close_left=lambda: os.close(sys.stdout.fileno()),
                close_right=lambda: connection.shutdown(socket.SHUT_WR))
finally:
    if connection is not None:
        connection.close()
    cleanup()
    Path(ready).unlink(missing_ok=True)
    auth.unlink(missing_ok=True)
