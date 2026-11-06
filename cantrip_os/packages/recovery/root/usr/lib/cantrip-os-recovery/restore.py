"""Verify in private staging, then atomically exchange homes with rollback data."""
import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
import stat
import struct

import archive
from maintenance import Maintenance
from state import sha256, sync_directory, workspace


def identity(path):
    info = Path(path).stat()
    return [info.st_dev, info.st_ino]


def exchange(first, second):
    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.renameat2(-100, os.fsencode(first), -100, os.fsencode(second), 2)
    if result != 0:
        raise OSError(ctypes.get_errno(), "Atomic home exchange failed")
    sync_directory(Path(first).parent)
    sync_directory(Path(second).parent)


def map_acl(value, uid, gid, target_uid, target_gid):
    data = bytearray(value)
    if len(data) < 4 or struct.unpack_from("<I", data)[0] != 2 or (len(data) - 4) % 8:
        raise ValueError("Unsupported stored POSIX ACL")
    for offset in range(4, len(data), 8):
        tag, permissions, owner = struct.unpack_from("<HHI", data, offset)
        if tag == 2 and owner == uid:
            struct.pack_into("<I", data, offset + 4, target_uid)
        elif tag == 8 and owner == gid:
            struct.pack_into("<I", data, offset + 4, target_gid)
    return bytes(data)


def restore_attributes(stage, manifest, target):
    source = manifest["workspace"]
    with (stage / archive.META / "files.jsonl").open() as stream:
        entries = [json.loads(line) for line in stream]
    # Apply directory times after children; ownership changes precede xattrs so
    # chown cannot silently clear restored capabilities or ACL ownership.
    for entry in reversed(entries):
        path = stage / archive.member_name(entry["path"])
        uid = target["uid"] if entry["uid"] == source["uid"] else entry["uid"]
        gid = target["gid"] if entry["gid"] == source["gid"] else entry["gid"]
        os.lchown(path, uid, gid)
        if not path.is_symlink():
            path.chmod(entry["mode"])
        for name, encoded in entry["xattrs"].items():
            value = base64.b64decode(encoded, validate=True)
            if name in ("system.posix_acl_access", "system.posix_acl_default"):
                value = map_acl(value, source["uid"], source["gid"], target["uid"], target["gid"])
            os.setxattr(path, name, value, follow_symlinks=False)
        os.utime(path, ns=(entry["mtime_ns"], entry["mtime_ns"]), follow_symlinks=False)


def relocate_git(home, mappings, locations):
    changed, unresolved = [], []

    def mapped(value):
        for old, new in sorted(mappings, key=lambda pair: len(pair[0]), reverse=True):
            if value == old or value.startswith(old.rstrip("/") + "/"):
                return new + value[len(old):]
        return None

    def original_location(path):
        for location, original in sorted(locations, key=lambda pair: len(str(pair[0])), reverse=True):
            if path == location or location in path.parents:
                return Path(original) / path.relative_to(location)
        raise ValueError("Git metadata is outside its staged roots")

    def relocated(value, path):
        original = os.path.normpath(str(original_location(path.parent) / value))
        destination = mapped(original)
        if destination is None:
            # An omitted/external reference must never keep operating on the
            # source workspace after restore. Preserve its original value in
            # the private receipt and point Git at an intentionally absent path.
            unresolved.append({"path": str(path.relative_to(home)), "original_target": original})
            return str(Path(mappings[0][1]) / ".cantrip-unresolved-git" / hashlib.sha256(original.encode()).hexdigest())
        return destination

    for directory, folders, files in os.walk(home, followlinks=False):
        folders[:] = [name for name in folders if not (Path(directory) / name).is_symlink()]
        for name in files:
            path = Path(directory) / name
            if path.is_symlink() or not path.is_file():
                continue
            administrative = name == ".git" or (name in ("gitdir", "commondir") and path.parent.parent.name == "worktrees")
            configuration = name in ("config", "config.worktree") and ((path.parent / "objects").is_dir() or path.parent.parent.name == "worktrees")
            if not administrative and not configuration:
                continue
            try:
                original = path.read_text()
            except UnicodeError:
                unresolved.append(str(path.relative_to(home)))
                continue
            replacement = original
            if administrative:
                prefix = "gitdir: " if original.startswith("gitdir: ") else ""
                value = original[len(prefix):].strip()
                replacement = prefix + relocated(value, path) + "\n"
            else:
                lines = []
                section = None
                for line in original.splitlines(keepends=True):
                    stripped = line.strip()
                    if stripped.startswith("[") and stripped.endswith("]"):
                        section = stripped[1:-1].strip().lower()
                    if section == "core" and "=" in line and line.split("=", 1)[0].strip().lower() == "worktree":
                        key, value = line.split("=", 1)
                        raw = value.strip()
                        if raw.startswith('"'):
                            try:
                                raw = json.loads(raw)
                                if not isinstance(raw, str):
                                    raise ValueError("Invalid quoted Git path")
                            except (ValueError, TypeError):
                                unresolved.append({"path": str(path.relative_to(home)), "original_target": value.strip()})
                                raw = "/.cantrip-unparsed-git/" + hashlib.sha256(value.encode()).hexdigest()
                        line = key + "= " + json.dumps(relocated(raw, path), ensure_ascii=False) + "\n"
                    lines.append(line)
                replacement = "".join(lines)
            if replacement != original:
                path.write_text(replacement)
                changed.append(str(path.relative_to(home)))
    return {"relocated_metadata": changed, "unresolved_metadata": unresolved}


def prepare_home(stage, manifest, target, operation_id):
    home = stage / "home"
    if home.is_symlink() or not home.is_dir():
        raise ValueError("Backup does not contain a real workspace home")
    restore_attributes(stage, manifest, target)
    mappings = [(manifest["workspace"]["home"], target["home"])]
    locations = [(home, manifest["workspace"]["home"])]
    extras = [root for root in manifest["roots"] if root["key"] != "home"]
    if extras:
        folder = f".cantrip-restored-sources-{operation_id}"
        destination = home / folder
        destination.mkdir(mode=0o700)
        os.chown(destination, target["uid"], target["gid"])
        for root in extras:
            key = root["key"]
            if not key.startswith("extra-") or not key[6:].isdigit():
                raise ValueError("Invalid additional data root")
            (stage / key).rename(destination / key)
            mappings.append((root["path"], str(Path(target["home"]) / folder / key)))
            locations.append((destination / key, root["path"]))
    repairs = relocate_git(home, mappings, locations)
    return home, repairs


def empty_workspace(home):
    for child in home.iterdir():
        if child.is_symlink() or not child.is_dir() or child.name not in ("Documents", "Downloads") or any(child.iterdir()):
            return False
    return True


def sync_tree(home):
    for directory, folders, files in os.walk(home, topdown=False, followlinks=False):
        for name in files:
            path = Path(directory) / name
            if path.is_symlink():
                continue
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        sync_directory(directory)


def observe_exchange(store, record):
    swap = record.get("swap")
    if not swap:
        return False
    current = identity(swap["home"])
    retained = identity(swap["staged_home"])
    if current == swap["new_identity"] and retained == swap["old_identity"]:
        record["state"] = "rolled-back" if record["action"] == "rollback" else "restored"
        record["receipt"] = record["proposed_receipt"]
        for root in record["maintenance"]["roots"]:
            if root["path"] == swap["home"]:
                root["device"], root["inode"] = current
                root["mode"] = swap["new_mode"]
        Path(swap["staged_home"]).chmod(swap["old_mode"])
        store.save(record)
        return True
    if current == swap["old_identity"] and retained == swap["new_identity"]:
        Path(swap["staged_home"]).chmod(swap["new_mode"])
        record["state"] = "failed"
        record["error"] = "Home exchange was not observed; original data remains active"
        store.save(record)
        return False
    raise RuntimeError("Home exchange outcome is unknown; both retained paths were preserved")


def reconcile(store, record):
    if not record.get("swap"):
        record["state"] = "failed"
        record["error"] = "Restore did not reach its admitted home exchange"
        store.save(record)
        return
    observe_exchange(store, record)


def activate(store, operation_id):
    record = store.read(operation_id)
    if record["action"] != "restore":
        raise ValueError("This operation is not a workspace restore")
    if record["state"] != "received":
        return store.inspect(operation_id)
    target = workspace(record["request"]["workspace"])
    home = Path(target["home"])
    incoming = store.directory(operation_id) / "incoming.tar"
    if sha256(incoming) != record["request"]["archive_sha256"]:
        raise ValueError("Received archive checksum differs")
    stage = home.parent / f".cantrip-restore-{operation_id}"
    maintenance = Maintenance(store, record, [home])
    record["stage"] = str(stage)
    record["state"] = "restoring"
    record["pid"] = os.getpid()
    from state import process_identity
    record["process_identity"] = process_identity(os.getpid())
    store.save(record)
    try:
        stage.mkdir(mode=0o700)
        sync_directory(stage.parent)
        maintenance.begin()
        if not record["request"].get("replace", False) and not empty_workspace(home):
            raise ValueError("Default restore requires a new empty workspace; existing data was preserved")
        manifest = archive.extract(incoming, stage)
        restored, repairs = prepare_home(stage, manifest, target, operation_id)
        sync_tree(restored)
        sync_directory(stage)
        mode = stat.S_IMODE(restored.stat().st_mode)
        record["swap"] = {"home": str(home), "staged_home": str(restored),
                          "old_identity": identity(home), "new_identity": identity(restored),
                          "old_mode": record["maintenance"]["roots"][0]["mode"], "new_mode": mode}
        record["proposed_receipt"] = {"workspace": {key: target[key] for key in ("id", "uid", "gid", "home")},
                                      "archive_sha256": record["request"]["archive_sha256"],
                                      "retained_original_home": str(restored),
                                      "uid_mapping": {str(manifest["workspace"]["uid"]): target["uid"]},
                                      "gid_mapping": {str(manifest["workspace"]["gid"]): target["gid"]},
                                      "source_roots": manifest["roots"], "references": manifest["references"],
                                      **repairs, "runtime_handles_restored": False}
        store.save(record)
        restored.chmod(0)
        exchange(home, restored)
        observe_exchange(store, record)
    except BaseException as error:
        if record.get("swap"):
            observe_exchange(store, record)
        else:
            record["state"] = "failed"
            record["error"] = type(error).__name__
            store.save(record)
        raise
    finally:
        maintenance.finish()
    return store.inspect(operation_id)


def rollback(store, operation_id, restore_operation_id):
    previous = store.read(restore_operation_id)
    if previous["action"] != "restore" or previous["state"] != "restored" or not previous["maintenance"].get("released"):
        raise ValueError("Rollback requires a completed, released restore")
    target = workspace(previous["request"]["workspace"])
    record, fresh = store.admit(operation_id, "rollback", {"restore_operation_id": restore_operation_id, "workspace": target["id"]})
    if not fresh:
        return store.inspect(operation_id)
    old = previous["swap"]
    home, retained = Path(target["home"]), Path(old["staged_home"])
    if identity(home) != old["new_identity"] or identity(retained) != old["old_identity"]:
        record["state"] = "failed"
        record["error"] = "The restore's retained directories changed; no rollback was performed"
        store.save(record)
        raise ValueError(record["error"])
    maintenance = Maintenance(store, record, [home])
    record["state"] = "restoring"
    store.save(record)
    try:
        maintenance.begin()
        mode = stat.S_IMODE(retained.stat().st_mode)
        record["swap"] = {"home": str(home), "staged_home": str(retained),
                          "old_identity": identity(home), "new_identity": identity(retained),
                          "old_mode": record["maintenance"]["roots"][0]["mode"], "new_mode": mode}
        record["proposed_receipt"] = {"restore_operation_id": restore_operation_id, "workspace": target["id"],
                                      "retained_replaced_home": str(retained), "runtime_handles_restored": False}
        store.save(record)
        retained.chmod(0)
        exchange(home, retained)
        observe_exchange(store, record)
    except BaseException as error:
        if record.get("swap"):
            observe_exchange(store, record)
        else:
            record["state"] = "failed"
            record["error"] = type(error).__name__
            store.save(record)
        raise
    finally:
        maintenance.finish()
    return store.inspect(operation_id)
