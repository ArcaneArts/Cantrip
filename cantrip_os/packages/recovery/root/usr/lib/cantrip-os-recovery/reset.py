"""Explicit home-state reset with verified staging and a retained undo home."""
import os
from pathlib import Path, PurePosixPath
import shutil
import stat

import archive
from maintenance import Maintenance
import restore
from state import sync_directory, workspace


def paths_for(request):
    if not isinstance(request, dict) or set(request) - {"paths", "expected_workspace"}:
        raise ValueError("Reset accepts only explicit home-relative paths")
    paths = request.get("paths")
    if not isinstance(paths, list) or not 1 <= len(paths) <= 128:
        raise ValueError('Select reset paths explicitly; ["."] means the entire home')
    for value in paths:
        if not isinstance(value, str) or not value or len(value) > 8192 or "\0" in value:
            raise ValueError("Invalid reset path")
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or str(path) != value:
            raise ValueError("Reset paths must be canonical and home-relative")
    if len(set(paths)) != len(paths) or ("." in paths and len(paths) != 1):
        raise ValueError("Reset paths must be distinct and cannot overlap")
    for value in paths:
        if any(str(parent) in paths for parent in PurePosixPath(value).parents):
            raise ValueError("Reset paths cannot contain one another")
    return paths


def inside_selection(relative, paths):
    return "." in paths or any(relative == value or PurePosixPath(value) in PurePosixPath(relative).parents for value in paths)


def checked_path(home, relative):
    path = home
    for component in PurePosixPath(relative).parts[:-1]:
        path = path / component
        if path.is_symlink():
            raise ValueError("A reset path traverses a symlink; select the link itself instead")
        if path.exists() and not path.is_dir():
            raise ValueError("A reset path traverses a non-directory")
    return home / relative


def defaults(home, target):
    # Match the actual workspace package's new-account home. Shared desktop,
    # shell and application defaults remain in the installed OS, outside home.
    home.mkdir(mode=0o700)
    os.chown(home, target["uid"], target["gid"])
    for name in ("Documents", "Downloads"):
        child = home / name
        child.mkdir(mode=0o700)
        os.chown(child, target["uid"], target["gid"])


def apply_paths(home, paths, target):
    changes = []
    for relative in paths:
        path = checked_path(home, relative)
        existed = path.exists() or path.is_symlink()
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
        elif existed:
            raise ValueError("The selected reset entry is not a file, directory or symlink")
        if relative in ("Documents", "Downloads"):
            path.mkdir(mode=0o700)
            os.chown(path, target["uid"], target["gid"])
        changes.append({"path": relative, "previously_present": existed,
                        "result": "workspace-default-directory" if relative in ("Documents", "Downloads") else "absent"})
    return changes


def reset(store, operation_id, name, request):
    paths = paths_for(request)
    target = workspace(name, request.get("expected_workspace"))
    record, fresh = store.admit(operation_id, "reset", {**request, "workspace": name})
    if not fresh:
        return store.inspect(operation_id)
    home = Path(target["home"])
    stage = home.parent / f".cantrip-reset-{operation_id}"
    maintenance = Maintenance(store, record, [home])
    record.update(state="restoring", stage=str(stage))
    store.save(record)
    try:
        stage.mkdir(mode=0o700)
        sync_directory(stage.parent)
        maintenance.begin()
        # A home exchange would displace these real mount attachments even
        # when their underlying bytes were not copied. Never do that implicitly.
        if any(archive.within(mount, home) for mount in archive.mountpoints()):
            raise ValueError("The home contains a mounted filesystem; detach its explicit mount before resetting home state")
        present = {}
        for relative in paths:
            path = checked_path(home, relative)
            try:
                path.lstat()
                present[relative] = True
            except FileNotFoundError:
                present[relative] = False
        if paths == ["."]:
            prepared = stage / "home"
            defaults(prepared, target)
            changes = [{"path": ".", "previously_present": True, "result": "workspace-default-home"}]
            snapshot = None
            skipped = []
        else:
            # Reuse the backup's actual writer coordination, change watches,
            # hard-link/ACL/xattr preservation and complete extraction checks.
            snapshot = archive.capture(store.directory(operation_id), target,
                [{"key": "home", "path": str(home)}], [], [],
                {str(home): record["maintenance"]["roots"][0]["mode"]},
                {"scope": "all-cantrip-workspaces", "workspaces": record["maintenance"]["interrupted_workspaces"],
                 "stopped_pids": record["maintenance"]["stopped_pids"]})
            skipped = snapshot["manifest"]["skipped"]
            if any(not inside_selection(Path(entry["path"]).relative_to(home).as_posix(), paths) for entry in skipped):
                raise ValueError("An unselected entry cannot be preserved by reset staging; the original home remains active")
            manifest = archive.extract(store.directory(operation_id) / "archive.tar", stage)
            prepared = stage / "home"
            # The account and absolute home do not change. Preserve existing Git
            # pointers verbatim rather than performing restore-to-another-home repairs.
            restore.restore_attributes(stage, manifest, target)
            changes = apply_paths(prepared, paths, target)
            for change in changes:
                change["previously_present"] = present[change["path"]]
        restore.sync_tree(prepared)
        sync_directory(stage)
        mode = stat.S_IMODE(prepared.stat().st_mode)
        record["swap"] = {"home": str(home), "staged_home": str(prepared),
                          "old_identity": restore.identity(home), "new_identity": restore.identity(prepared),
                          "old_mode": record["maintenance"]["roots"][0]["mode"], "new_mode": mode}
        record["proposed_receipt"] = {
            "workspace": {key: target[key] for key in ("id", "uid", "gid", "home")},
            "reset_paths": paths, "changes": changes, "retained_original_home": str(prepared),
            "snapshot": {"archive_sha256": snapshot["archive_sha256"], "archive_bytes": snapshot["archive_bytes"]} if snapshot else None,
            "skipped_reset_entries": skipped, "shared_system_state_changed": False,
            "runtime_handles_restored": False,
        }
        store.save(record)
        prepared.chmod(0)
        restore.exchange(home, prepared)
        restore.observe_exchange(store, record)
    except BaseException as error:
        if record.get("swap"):
            restore.observe_exchange(store, record)
        else:
            record["state"] = "failed"
            record["error"] = type(error).__name__
            store.save(record)
        raise
    finally:
        maintenance.finish()
    return store.inspect(operation_id)
