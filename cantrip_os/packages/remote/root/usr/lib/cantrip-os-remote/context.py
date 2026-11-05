"""Observe canonical package identities; never accept caller-supplied UID/display."""
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import sys

sys.path.insert(0, "/usr/lib/cantrip-os-workspaces")
from service import Store, atomic_json

CONFIG = "/etc/cantrip-os/remote.json"
VERSION = "0.2.0"


def request(store, command, pins=None, **arguments):
    if isinstance(store, (str, Path)):
        configuration = json.loads(Path(store).read_text())
        endpoint = Path(configuration["runtime_dir"]) / "control.sock"
    else:
        endpoint = store.socket
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(60)
        connection.connect(str(endpoint))
        if pins is not None:
            pid, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != 0:
                raise ValueError("Package control endpoint is not root-owned")
            pins.append(os.pidfd_open(pid))
        connection.sendall(json.dumps({"command": command, **arguments}).encode() + b"\n")
        with connection.makefile("rb") as stream:
            result = json.loads(stream.readline(65536))
    if isinstance(result, dict) and "failure" in result:
        raise RuntimeError(result["failure"])
    return result


def placement(executor, record):
    return {"instance_id": executor["instance_id"], "generation": executor["generation"],
            **executor["attachment"], "workspace_id": record["id"], "uid": record["uid"],
            "gid": record["gid"], "home": record["home"]}


def observe(workspace, start=False, pins=None, expected_placement=None):
    executor = request("/etc/cantrip-os/executor.json", "status", pins=pins)
    attachment = executor.get("attachment")
    if not attachment:
        raise ValueError("Attach an owning Worker before opening remote access")
    record = request("/etc/cantrip-os/workspaces.json", "show", pins=pins, id=workspace)
    if expected_placement is not None and placement(executor, record) != expected_placement:
        raise ValueError("Remote desktop attachment or generation mismatch")
    if start:
        record = request("/etc/cantrip-os/workspaces.json", "open", id=workspace)
    if record["status"] != "running":
        raise ValueError("The selected desktop is not running; explicitly open it first")
    generation = hashlib.sha256(record["view_token"].encode()).hexdigest()
    public = {**placement(executor, record), "desktop_generation": generation,
              "user": record["user"], "display": record["display"]}
    return public


def verify(workspace, expected):
    actual = observe(workspace)
    if not isinstance(expected, dict) or actual != expected:
        raise ValueError("Remote desktop attachment or generation mismatch")
    return actual


def identity():
    # This is the executor package's actual persistent attachment authority,
    # not an availability guess about its administrative request queue.
    configuration = json.loads(Path("/etc/cantrip-os/executor.json").read_text())
    state = Path(configuration["state_dir"])
    value = json.loads((state / "instance.json").read_text())
    if value.get("version") != 1:
        raise ValueError("Unsupported instance identity; state was preserved")
    return value


def desktops():
    configuration = json.loads(Path("/etc/cantrip-os/workspaces.json").read_text())
    value = json.loads((Path(configuration["state_dir"]) / "workspaces.json").read_text())
    if value.get("version") != 1:
        raise ValueError("Unsupported workspace registry; state was preserved")
    return value["workspaces"]


def current_desktop(context, registry):
    record = registry.get(context["workspace_id"], {})
    return record.get("desired_running") is True and \
        hashlib.sha256(record.get("view_token", "").encode()).hexdigest() == context["desktop_generation"]
