#!/usr/bin/python3
"""Bounded optional workspace capture/recovery, never an agent scheduler."""
import argparse
import json
import os
from pathlib import Path
import signal
import sys
import re

from state import Store, VERSION, sha256, workspace, process_identity, command
from maintenance import Maintenance
import archive


def verify_instance(expected):
    if expected is None:
        return
    config = json.loads(Path("/etc/cantrip-os/executor.json").read_text())
    actual = json.loads((Path(config["state_dir"]) / "instance.json").read_text())
    if actual.get("version") != 1 or actual["instance_id"] != expected["guestInstanceId"]:
        raise ValueError("The intended OS identity changed")
    if actual["attachment"] != {"owner_id": expected["ownerId"], "worker_id": expected["workerId"]}:
        raise ValueError("The intended OS attachment changed")
    if expected.get("runtimeGeneration") is not None:
        status = command("cantrip-executor", "status", json_output=True)
        if status.get("generation") != expected["runtimeGeneration"]:
            raise ValueError("The admitted OS runtime changed")


def capture(store, operation_id, name, request):
    selected = workspace(name, request.get("expected_workspace"))
    record, fresh = store.admit(operation_id, "capture", {**request, "workspace": name})
    if not fresh:
        return store.inspect(operation_id)
    roots, references = archive.roots_for(Path(selected["home"]), request.get("sources", []))
    maintenance = Maintenance(store, record, [root["path"] for root in roots])
    try:
        record["state"] = "capturing"
        store.save(record)
        maintenance.begin()
        modes = {entry["path"]: entry["mode"] for entry in record["maintenance"]["roots"]}
        record["receipt"] = archive.capture(store.directory(operation_id), selected, roots, references,
                                             request.get("exclusions", []), modes,
                                             {"scope": "all-cantrip-workspaces", "workspaces": record["maintenance"]["interrupted_workspaces"],
                                              "stopped_pids": record["maintenance"]["stopped_pids"]})
        record["state"] = "captured"
        store.save(record)
    except BaseException as error:
        if record["state"] != "captured":
            record["state"] = "failed"
        record["error"] = type(error).__name__
        store.save(record)
        raise
    finally:
        maintenance.finish()
    return store.inspect(operation_id)


def receive(store, operation_id, name, request):
    workspace(name, request.get("expected_workspace"))
    expected_bytes, expected_sha = request["archive_bytes"], request["archive_sha256"]
    if type(expected_bytes) is not int or expected_bytes < 0 or not isinstance(expected_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
        raise ValueError("An authenticated archive size and digest are required")
    record, fresh = store.admit(operation_id, "restore", {**request, "workspace": name})
    if not fresh:
        return store.inspect(operation_id)
    record["state"] = "receiving"
    store.save(record)
    destination = store.directory(operation_id) / "incoming.tar"
    try:
        with destination.open("xb") as output:
            received = 0
            for block in iter(lambda: sys.stdin.buffer.read(1024 * 1024), b""):
                received += len(block)
                if received > expected_bytes:
                    raise ValueError("Archive exceeds its authenticated size")
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
        if received != expected_bytes or sha256(destination) != expected_sha:
            raise ValueError("Archive transport checksum differs")
        record["state"] = "received"
        store.save(record)
        return store.inspect(operation_id)
    except BaseException as error:
        record["state"] = "failed"
        record["error"] = type(error).__name__
        store.save(record)
        raise


def export(store, operation_id, offset, length):
    record = store.read(operation_id)
    if record["action"] != "capture" or record["state"] != "captured":
        raise ValueError("No completed capture is available for this operation")
    path = store.directory(operation_id) / "archive.tar"
    if path.stat().st_size != record["receipt"]["archive_bytes"] or sha256(path) != record["receipt"]["archive_sha256"]:
        raise ValueError("The captured archive changed; no bytes were exported")
    if offset < 0 or offset > path.stat().st_size or (length is not None and length < 0):
        raise ValueError("Invalid archive range")
    with path.open("rb") as source:
        source.seek(offset)
        remaining = length
        while remaining is None or remaining:
            block = source.read(min(1024 * 1024, remaining) if remaining is not None else 1024 * 1024)
            if not block:
                break
            sys.stdout.buffer.write(block)
            if remaining is not None:
                remaining -= len(block)


def recover(store, operation_id):
    record = store.read(operation_id)
    identity = process_identity(record["pid"])
    if identity is not None and identity == record["process_identity"]:
        raise RuntimeError("The admitted recovery command is still running")
    if record["state"] == "restoring":
        from restore import reconcile
        reconcile(store, record)
    elif record["state"] in ("admitted", "capturing", "receiving"):
        # No capture/receive completion was committed, and activation cannot
        # begin from these states. Release the interruption without replaying.
        record["state"] = "failed"
        record["error"] = "The guest operation ended before committing completion"
        store.save(record)
    Maintenance(store, record, []).finish()
    return store.inspect(operation_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/cantrip-os/recovery.json")
    parser.add_argument("--expect", type=json.loads)
    parser.add_argument("--expect-workspace", type=json.loads)
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("status")
    actions.add_parser("release-maintenance")
    for action in ("capture", "receive"):
        sub = actions.add_parser(action)
        sub.add_argument("operation_id")
        sub.add_argument("workspace")
        sub.add_argument("--request", type=json.loads, default={})
    for action in ("inspect", "recover", "restore", "forget"):
        actions.add_parser(action).add_argument("operation_id")
    rollback = actions.add_parser("rollback")
    rollback.add_argument("operation_id")
    rollback.add_argument("restore_operation_id")
    output = actions.add_parser("export")
    output.add_argument("operation_id")
    output.add_argument("--offset", type=int, default=0)
    output.add_argument("--length", type=int)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Use sudo for local recovery administration")
    os.umask(0o077)
    store = Store(args.config)
    if args.action == "export":
        verify_instance(args.expect)
        export(store, args.operation_id, args.offset, args.length)
        return
    if args.action == "inspect":
        verify_instance(args.expect)
        result = store.inspect(args.operation_id)
    elif args.action == "status":
        verify_instance(args.expect)
        active = store.root / "active.json"
        result = {"version": VERSION, "active": store.inspect(json.loads(active.read_text())["operation_id"]) if active.exists() else None}
    else:
        with store.lock():
            # Check mutation authority under the same actual maintenance lock
            # that protects capture/activation. Observation/recovery can omit
            # runtime authority while retaining persistent instance/owner pins.
            verify_instance(args.expect)
            if args.action == "release-maintenance":
                active = store.root / "active.json"
                result = recover(store, json.loads(active.read_text())["operation_id"]) if active.exists() else {"released": True}
            elif args.action == "capture":
                request = {**args.request, "expected_workspace": args.expect_workspace} if args.expect_workspace is not None else args.request
                result = capture(store, args.operation_id, args.workspace, request)
            elif args.action == "receive":
                request = {**args.request, "expected_workspace": args.expect_workspace} if args.expect_workspace is not None else args.request
                result = receive(store, args.operation_id, args.workspace, request)
            elif args.action == "restore":
                from restore import activate
                result = activate(store, args.operation_id, args.expect_workspace)
            elif args.action == "recover":
                result = recover(store, args.operation_id)
            elif args.action == "rollback":
                from restore import rollback
                result = rollback(store, args.operation_id, args.restore_operation_id, args.expect_workspace)
            elif args.action == "forget":
                record = store.read(args.operation_id)
                if record.get("maintenance") and not record["maintenance"].get("released"):
                    raise ValueError("Recover the maintenance operation before forgetting its capture")
                # Retained original homes are never deleted by this command or
                # package removal. Only bounded transfer staging is discarded.
                for name in ("archive.tar", "incoming.tar", "files.jsonl", "manifest.json"):
                    (store.directory(args.operation_id) / name).unlink(missing_ok=True)
                # Spool availability is separate from the committed outcome.
                # Retain successful restore evidence needed by later rollback.
                if record["state"] not in ("captured", "restored", "rolled-back", "failed"):
                    record["state"] = "forgotten"
                record["spool_forgotten"] = True
                store.save(record)
                result = store.inspect(args.operation_id)
    print(json.dumps(result))


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise InterruptedError("Recovery command interrupted")
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(f"cantrip-recovery: {error}", file=sys.stderr)
        sys.exit(1)
