"""Versioned workspace files, ownership and Git metadata, never live processes."""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import tarfile

from maintenance import ChangeWatch
from state import sha256, sync_directory

META = ".cantrip-backup"


def within(path, root):
    return path == root or root in path.parents


def mountpoints():
    def decode(value):
        for escaped, replacement in (("\\040", " "), ("\\011", "\t"), ("\\012", "\n"), ("\\134", "\\")):
            value = value.replace(escaped, replacement)
        return value
    return {Path(decode(line.split()[4])) for line in Path("/proc/self/mountinfo").read_text().splitlines()}


def roots_for(home, sources):
    roots = [{"key": "home", "path": str(home)}]
    references = []
    declared = [home]
    for source in sources:
        if source.get("mode") == "linux-owned":
            declared.append(Path(source["guestPath"]).resolve(strict=True))
            declared.extend(Path(path).resolve(strict=True) for path in source.get("gitMetadataPaths", []))
    for source in sources:
        if source.get("mode") not in ("linked", "linux-owned"):
            raise ValueError("Unknown source ownership mode")
        if source.get("mode") == "linked":
            references.append({**source, "included": False, "reason": "linked-host-source"})
            continue
        path = Path(source["guestPath"]).resolve(strict=True)
        candidates = [path, *(Path(value).resolve(strict=True) for value in source.get("gitMetadataPaths", []))]
        # Read only administrative pointers; do not invoke repository hooks or
        # assume every repository is healthy enough to run Git commands.
        git = path / ".git"
        try:
            if git.is_file():
                text = git.read_text()
                if text.startswith("gitdir: "):
                    git = (path / text[8:].strip()).resolve(strict=True)
            if git.is_dir():
                common = git / "commondir"
                metadata = (git / common.read_text().strip()).resolve(strict=True) if common.is_file() else git.resolve()
                if (metadata / "HEAD").is_file() and (metadata / "objects").is_dir():
                    if any(within(metadata, root) for root in declared):
                        candidates.append(metadata)
                    else:
                        references.append({"guestPath": str(metadata), "included": False, "reason": "external-git-metadata-requires-explicit-root"})
                else:
                    references.append({"guestPath": str(metadata), "included": False, "reason": "unrecognized-git-metadata"})
        except (OSError, UnicodeError):
            # Broken pointers remain backed-up files, not a reason to lose
            # the user's data. Unavailable external Git data is explicit.
            references.append({"guestPath": str(git), "included": False, "reason": "unreadable-git-pointer"})
        for candidate in candidates:
            if any(within(candidate, Path(root["path"])) for root in roots):
                continue
            if within(home, candidate):
                raise ValueError("A source root cannot include the workspace home's ancestors")
            roots = [root for root in roots if not within(Path(root["path"]), candidate)]
            roots.append({"key": f"extra-{len(roots)}", "path": str(candidate)})
    # Keep keys unique even when a later root subsumes an earlier one.
    for number, root in enumerate(roots[1:], 1):
        root["key"] = f"extra-{number}"
    return roots, references


def walk(root, excluded, mounts, skipped):
    root = Path(root)
    yield root
    stack = [root]
    while stack:
        directory = stack.pop()
        with os.scandir(directory) as entries:
            ordered = sorted(entries, key=lambda entry: entry.name)
        for entry in ordered:
            path = Path(entry.path)
            relative = path.relative_to(root).as_posix()
            if relative in excluded:
                skipped.append({"path": str(path), "reason": "explicit-exclusion"})
                continue
            if path in mounts:
                skipped.append({"path": str(path), "reason": "external-mount", "included": False})
                continue
            details = path.lstat()
            if not (stat.S_ISREG(details.st_mode) or stat.S_ISDIR(details.st_mode) or stat.S_ISLNK(details.st_mode)):
                skipped.append({"path": str(path), "reason": "runtime-special-file"})
                continue
            yield path
            if stat.S_ISDIR(details.st_mode):
                stack.append(path)


def exclusions(values):
    result = []
    for value in values:
        path = PurePosixPath(value)
        if not value or path.is_absolute() or ".." in path.parts or ".git" in path.parts or str(path) != value:
            raise ValueError("Exclusions must be explicit relative paths and retain Git metadata")
        result.append(value)
    return result


def attributes(path):
    result = {}
    for name in os.listxattr(path, follow_symlinks=False):
        result[name] = base64.b64encode(os.getxattr(path, name, follow_symlinks=False)).decode()
    return result


def capture(directory, workspace, roots, references, excluded, original_modes, interruption):
    directory = Path(directory)
    skipped = []
    mounts = mountpoints()
    mounts.update(Path(reference["guestPath"]) for reference in references
                  if reference.get("reason") == "linked-host-source")
    excluded = exclusions(excluded)
    def directories():
        # Install the parent's watch before enumerating its children. A new
        # directory cannot slip between a completed scan and watch setup.
        for root in roots:
            for path in walk(Path(root["path"]), excluded if root["key"] == "home" else [], mounts, []):
                if path.is_dir() and not path.is_symlink():
                    yield path
    inventory = directory / "files.jsonl"
    archive = directory / "archive.tar"
    if any(within(directory, Path(root["path"])) for root in roots):
        raise ValueError("Capture output cannot be inside an included data root")
    watcher = ChangeWatch(directories())
    count = 0
    try:
        with inventory.open("w") as records, tarfile.open(archive, "w", format=tarfile.PAX_FORMAT, dereference=False) as output:
            for root in roots:
                source = Path(root["path"])
                for path in walk(source, excluded if root["key"] == "home" else [], mounts, skipped):
                    relative = path.relative_to(source).as_posix()
                    name = root["key"] if relative == "." else f"{root['key']}/{relative}"
                    before = path.lstat()
                    info = output.gettarinfo(str(path), arcname=name)
                    mode = original_modes.get(str(path), stat.S_IMODE(before.st_mode))
                    info.mode = mode
                    entry = {"path": name, "mode": mode, "uid": before.st_uid,
                             "gid": before.st_gid, "mtime_ns": before.st_mtime_ns,
                             "xattrs": attributes(path), "sha256": None}
                    if info.isreg():
                        entry["sha256"] = sha256(path)
                        with path.open("rb") as stream:
                            output.addfile(info, stream)
                    else:
                        output.addfile(info)
                        if info.islnk():
                            entry["sha256"] = sha256(path)
                    after = path.lstat()
                    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                        raise RuntimeError("A file changed while being captured")
                    records.write(json.dumps(entry, sort_keys=True) + "\n")
                    count += 1
            records.flush()
            os.fsync(records.fileno())
            manifest = {"version": 1, "workspace": {key: workspace[key] for key in ("id", "user", "uid", "gid", "home")}, "roots": roots,
                        "references": references, "exclusions": excluded, "skipped": skipped,
                        "entries": count, "inventory_sha256": sha256(inventory),
                        "consistency": "coordinated-writers-with-filesystem-change-observation",
                        "interruption": interruption, "live_processes_included": False,
                        "browser_authentication_portability_promised": False}
            manifest_path = directory / "manifest.json"
            manifest_path.write_text(json.dumps(manifest, sort_keys=True) + "\n")
            output.add(manifest_path, arcname=f"{META}/manifest.json", recursive=False)
            output.add(inventory, arcname=f"{META}/files.jsonl", recursive=False)
        with archive.open("rb") as stream:
            os.fsync(stream.fileno())
        watcher.verify()
        sync_directory(directory)
        return {"manifest": manifest, "archive_sha256": sha256(archive), "archive_bytes": archive.stat().st_size}
    finally:
        watcher.close()


def member_name(value):
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or not path.parts or "\0" in value or str(path) != value:
        raise ValueError("Unsafe archive path")
    return str(path)


def extract(archive, stage):
    """Validate the entire member graph before extracting into a root-private
    directory. External symlinks may be retained as references, never followed
    by an archive member; hard links must name archived regular files."""
    stage = Path(stage)
    with tarfile.open(archive, "r:") as source:
        members = source.getmembers()
        named = {}
        links = set()
        for member in members:
            name = member_name(member.name)
            if name in named:
                raise ValueError("Duplicate archive member")
            if not (member.isdir() or member.isreg() or member.issym() or member.islnk()):
                raise ValueError("Archive contains a runtime or device entry")
            named[name] = member
            if member.issym():
                links.add(name)
        manifest_member = named.get(f"{META}/manifest.json")
        inventory_member = named.get(f"{META}/files.jsonl")
        if not manifest_member or not manifest_member.isreg() or not inventory_member or not inventory_member.isreg():
            raise ValueError("Missing backup manifest or inventory")
        manifest = json.load(source.extractfile(manifest_member))
        if manifest.get("version") != 1:
            raise ValueError("Unsupported backup version")
        roots = manifest["roots"]
        keys = [root["key"] for root in roots]
        if not keys or keys[0] != "home" or len(set(keys)) != len(keys):
            raise ValueError("Invalid backup data roots")
        for number, root in enumerate(roots):
            if root["key"] != ("home" if number == 0 else f"extra-{number}") or not Path(root["path"]).is_absolute():
                raise ValueError("Invalid backup data root identity")
            member = named.get(root["key"])
            if member is None or not member.isdir():
                raise ValueError("Backup data root is not a real directory")
        if manifest["workspace"]["home"] != roots[0]["path"]:
            raise ValueError("Backup home identity differs from its manifest")
        allowed = set(keys) | {META}
        for name, member in named.items():
            if PurePosixPath(name).parts[0] not in allowed:
                raise ValueError("Archive member is outside its declared data roots")
            if any(str(parent) in links for parent in PurePosixPath(name).parents):
                raise ValueError("Archive traverses a symlink")
            if member.islnk():
                target = named.get(member_name(member.linkname))
                if not target or not target.isreg():
                    raise ValueError("Archive hard link is not an archived regular file")
        source.extractall(stage, members=members, filter="fully_trusted")
    if sha256(stage / META / "files.jsonl") != manifest["inventory_sha256"]:
        raise ValueError("Backup inventory checksum differs")
    with (stage / META / "files.jsonl").open() as records:
        seen = set()
        for line in records:
            entry = json.loads(line)
            name = member_name(entry["path"])
            if name not in named or PurePosixPath(name).parts[0] == META or name in seen:
                raise ValueError("Inventory does not name a data member")
            path = stage / name
            if any(parent.is_symlink() for parent in path.parents if within(parent, stage)):
                raise ValueError("Inventory traverses a symlink")
            if entry["sha256"] is not None and (not path.is_file() or path.is_symlink() or sha256(path) != entry["sha256"]):
                raise ValueError("Restored file checksum differs")
            seen.add(name)
        expected = {name for name in named if PurePosixPath(name).parts[0] != META}
        if len(seen) != manifest["entries"] or seen != expected:
            raise ValueError("Backup inventory entry count differs")
    return manifest
