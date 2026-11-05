#!/usr/bin/python3
"""Actual protected service acceptance in an explicitly disposable attached guest."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import shlex
import signal
import socket
import struct
import subprocess
import tempfile
import threading
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--workspace", default="cua-a")
parser.add_argument("--other-workspace", default="cua-b")
args = parser.parse_args()


def command(*argv, check=True, **options):
    return subprocess.run(argv, check=check, capture_output=True, text=True, timeout=40, **options)


def remote(*argv):
    return json.loads(command("cantrip-remote", *argv).stdout)


def wait(predicate):
    deadline = time.monotonic() + 30
    while not predicate():
        if time.monotonic() > deadline:
            raise RuntimeError("Actual service state did not converge")
        time.sleep(.025)


def info(kind, **extra):
    return remote("service-info", args.workspace, "--service", json.dumps({"kind": kind, **extra}))


def carrier(context, key=None, connection_id=None):
    argv = ["cantrip-remote", "service-connect", args.workspace, "--expect", json.dumps(context),
            "--connection-id", connection_id or str(uuid.uuid4())]
    if key is not None:
        argv.extend(("--public-key", key))
    return argv


def read_exact(stream, count):
    result = bytearray()
    while len(result) < count:
        if not select.select([stream], [], [], 30)[0]:
            raise RuntimeError("Service response timed out")
        data = os.read(stream.fileno(), count - len(result))
        if not data:
            raise RuntimeError("Unexpected service EOF")
        result.extend(data)
    return bytes(result)


command("cantrip-workspaces", "stop", args.workspace)
ssh_context = info("ssh")
assert "desktop_generation" not in ssh_context
with tempfile.TemporaryDirectory(prefix="cantrip-service-test-") as directory:
    directory = Path(directory)
    key = directory / "client"
    command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key))
    public = " ".join(Path(str(key) + ".pub").read_text().split()[:2])
    known = directory / "known_hosts"
    known.write_text("cantrip-os-test " + ssh_context["ssh_host_key"] + "\n")

    def ssh_options(context=ssh_context, connection_id=None):
        return ["-F", "/dev/null", "-i", str(key), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
                "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + str(known),
                "-o", "HostKeyAlias=cantrip-os-test", "-o", "ConnectTimeout=15", "-o", "ForwardAgent=no",
                "-o", "ProxyCommand=" + shlex.join(carrier(context, public, connection_id))]

    user = ssh_context["user"] + "@cantrip-os-test"
    result = command("ssh", *ssh_options(), user, "id -u; sudo -n id -u; printf '%s\\n' \"$HOME\"")
    assert result.stdout.splitlines() == [str(ssh_context["uid"]), "0", ssh_context["home"]], result
    assert json.loads(command("cantrip-workspaces", "show", args.workspace).stdout)["status"] == "stopped"
    print("PASS actual public-key SSH, exact workspace UID/home, unrestricted sudo, desktop stays stopped", flush=True)

    source = directory / "sftp-source.txt"
    source.write_text("Cantrip SFTP café 日本語 🦀\n")
    downloaded = directory / "sftp-result.txt"
    target = ssh_context["home"] + "/Documents/remote-sftp-proof.txt"
    batch = directory / "batch"
    batch.write_text(f'put "{source}" "{target}"\nget "{target}" "{downloaded}"\n')
    command("sftp", *ssh_options(), "-b", str(batch), user)
    assert downloaded.read_bytes() == source.read_bytes() == Path(target).read_bytes()
    print("PASS real OpenSSH SFTP upload/download preserves Unicode file bytes", flush=True)

    other_user = json.loads(command("cantrip-workspaces", "show", args.other_workspace).stdout)["user"]
    denied = command("ssh", *ssh_options(), other_user + "@cantrip-os-test", "id", check=False)
    assert denied.returncode != 0 and "Permission denied" in denied.stderr, denied
    other_key = directory / "wrong-client"
    command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(other_key))
    options = ssh_options()
    options[options.index(str(key))] = str(other_key)
    denied = command("ssh", *options, user, "id", check=False)
    assert denied.returncode != 0 and "Permission denied" in denied.stderr, denied
    assert "/usr/lib/systemd/system/ssh.service" not in command("dpkg", "-L", "cantrip-os-remote").stdout.splitlines()
    print("PASS wrong account/key denied; optional package installs no system SSH listener", flush=True)

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    tcp_context = info("tcp", port=listener.getsockname()[1])
    payload = os.urandom(1024 * 1024 + 37)
    reply = payload[::-1] + hashlib.sha256(payload).digest()
    errors = []

    def serve():
        try:
            with listener:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(30)
                    body = bytearray()
                    while True:
                        chunk = connection.recv(65536)
                        if not chunk:
                            break
                        body.extend(chunk)
                    assert bytes(body) == payload
                    connection.sendall(reply)
        except BaseException as error:
            errors.append(error)

    server = threading.Thread(target=serve)
    server.start()
    child = subprocess.Popen(carrier(tcp_context), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    output, error = child.communicate(payload, timeout=40)
    server.join(timeout=40)
    assert not server.is_alive() and not errors, errors
    assert child.returncode == 0 and output == reply, (child.returncode, len(output), error)
    print("PASS actual guest-loopback TCP: >1 MiB binary transfer and reply after request half-close", flush=True)

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    hung_context = info("tcp", port=listener.getsockname()[1])
    child = subprocess.Popen(carrier(hung_context), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    connection, _ = listener.accept()
    try:
        child.kill()
        child.wait(timeout=30)
        wait(lambda: not remote("status")["service_connections"])
        connection.settimeout(10)
        assert connection.recv(1) == b""
    finally:
        connection.close()
        listener.close()
    print("PASS abrupt carrier process death closes idle TCP without waiting for its server", flush=True)

    refused = subprocess.run(carrier(tcp_context), input=b"", capture_output=True, timeout=40)
    assert refused.returncode != 0
    assert json.loads(command("cantrip-workspaces", "show", args.workspace).stdout)["status"] == "stopped"
    for field in ("owner_id", "worker_id", "instance_id", "workspace_id", "generation", "remote_generation", "uid", "home"):
        wrong = {**ssh_context, field: "wrong"}
        rejected = subprocess.run(carrier(wrong, public), input=b"", capture_output=True, timeout=40)
        assert rejected.returncode != 0 and b"generation mismatch" in rejected.stderr, (field, rejected.stderr)
    print("PASS actual refused TCP port and stale/mismatched placement fail without desktop start or fallback", flush=True)

    remote("open", args.workspace)
    vnc_context = info("vnc")
    vnc = subprocess.Popen(carrier(vnc_context), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert read_exact(vnc.stdout, 12) == b"RFB 003.008\n"
    vnc.stdin.write(b"RFB 003.008\n")
    vnc.stdin.flush()
    count = read_exact(vnc.stdout, 1)[0]
    assert 1 in read_exact(vnc.stdout, count)
    vnc.stdin.write(b"\x01")
    vnc.stdin.flush()
    assert read_exact(vnc.stdout, 4) == b"\x00" * 4
    vnc.stdin.write(b"\x01")
    vnc.stdin.flush()
    init = read_exact(vnc.stdout, 24)
    width, height = struct.unpack("!HH", init[:4])
    assert width >= 800 and height >= 600
    read_exact(vnc.stdout, struct.unpack("!I", init[20:24])[0])
    command("cantrip-workspaces", "stop", args.workspace)
    vnc.stdin.close()
    vnc.wait(timeout=30)
    rejected = subprocess.run(carrier(vnc_context), input=b"", capture_output=True, timeout=40)
    assert rejected.returncode != 0
    assert command("ssh", *ssh_options(), user, "id -u").stdout.strip() == str(ssh_context["uid"])
    print("PASS actual VNC 3.8 negotiation pins workspace desktop; desktop stop retires VNC while SSH remains usable", flush=True)

    pid_file = Path(ssh_context["home"]) / "Documents/remote-service-process.pid"

    def long_ssh():
        pid_file.unlink(missing_ok=True)
        connection_id = str(uuid.uuid4())
        # A detached grandchild must still belong to this connection guardian.
        script = "import os,time; pid=os.fork(); os._exit(0) if pid else None; os.setsid(); " + \
            "pid=os.fork(); os._exit(0) if pid else None; " + \
            "open(" + repr(str(pid_file)) + ",'w').write(str(os.getpid())); time.sleep(120)"
        child = subprocess.Popen(["ssh", *ssh_options(info("ssh"), connection_id), user,
                                  "python3 -c " + shlex.quote(script)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            wait(pid_file.exists)
        except BaseException:
            child.kill()
            _, error = child.communicate(timeout=30)
            raise RuntimeError("SSH descendant fixture failed: " + error.decode())
        process = os.pidfd_open(int(pid_file.read_text()))
        return child, process, connection_id

    child, process, connection_id = long_ssh()
    command("cantrip-remote", "service-close", args.workspace, "--expect", json.dumps(ssh_context),
            "--connection-id", connection_id)
    child.stdin.close()
    child.wait(timeout=30)
    assert select.select([process], [], [], 20)[0]
    os.close(process)
    wait(lambda: not remote("status")["service_connections"])
    print("PASS exact service retirement reaps detached SSH descendants", flush=True)

    child, process, _ = long_ssh()
    with socket.socket(socket.AF_UNIX) as control:
        control.connect("/run/cantrip-os-remote/control.sock")
        manager_pid, manager_uid, _ = struct.unpack("3i", control.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        assert manager_uid == 0
        manager = os.pidfd_open(manager_pid)
        try:
            signal.pidfd_send_signal(manager, signal.SIGKILL)
        finally:
            os.close(manager)
    child.stdin.close()
    child.wait(timeout=30)
    assert select.select([process], [], [], 20)[0]
    os.close(process)
    command("cantrip-remote", "service", "start")
    assert info("ssh")["ssh_host_key"] == ssh_context["ssh_host_key"]
    print("PASS abrupt manager death cleans up detached SSH descendants", flush=True)

    child, process, _ = long_ssh()
    old_runtime = info("ssh")
    command("cantrip-executor", "service", "restart")
    child.stdin.close()
    child.wait(timeout=30)
    assert select.select([process], [], [], 20)[0]
    os.close(process)
    rejected = subprocess.run(carrier(old_runtime, public), input=b"", capture_output=True, timeout=40)
    assert rejected.returncode != 0 and b"generation mismatch" in rejected.stderr
    print("PASS executor retirement closes live SSH and prevents reconnect with its old runtime", flush=True)

    child, process, _ = long_ssh()
    command("cantrip-remote", "disable")
    child.stdin.close()
    child.wait(timeout=30)
    assert select.select([process], [], [], 20)[0]
    os.close(process)
    assert Path(target).read_bytes() == source.read_bytes()
    command("cantrip-remote", "enable")
    next_context = info("ssh")
    assert next_context["ssh_host_key"] == ssh_context["ssh_host_key"]
    assert next_context["remote_generation"] != ssh_context["remote_generation"]
    rejected = subprocess.run(carrier(ssh_context, public), input=b"", capture_output=True, timeout=40)
    assert rejected.returncode != 0 and b"generation mismatch" in rejected.stderr
    print("PASS disable kills service processes, retains files/SSH host identity, and old descriptor cannot reconnect", flush=True)

print("PASS protected services acceptance", flush=True)
