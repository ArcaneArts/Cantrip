#!/usr/bin/python3
"""Run as root in a disposable, booted CantripOS with recovery installed.

Uses real package commands, accounts, service shutdown, Linux filesystem
metadata and atomic directory exchange. Deliberate process exits exercise the
admission boundary without shipping fault-injection switches in the package.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, "/usr/lib/cantrip-os-recovery")
from maintenance import ChangeWatch
from state import workspace, Store, process_identity

RECOVERY_ROOT = Path(json.loads(Path("/etc/cantrip-os/recovery.json").read_text())["state_dir"])


def run(*arguments, input=None, check=True):
    result = subprocess.run(arguments, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        raise RuntimeError(f"{arguments[0]} exited {result.returncode}: {result.stderr.decode()}")
    return result


def cli(*arguments, input=None, check=True):
    result = run("cantrip-recovery", *arguments, input=input, check=check)
    return json.loads(result.stdout) if check else result


def operation():
    return str(uuid.uuid4())


def create():
    name = "bkt-" + uuid.uuid4().hex[:10]
    run("cantrip-workspaces", "create", name)
    return workspace(name)


def home(account):
    return Path(account["home"])


def capture(account, request=None):
    return cli("capture", operation(), account["id"], "--request", json.dumps(request or {}))


def receive(account, snapshot, replace=False, data=None):
    original = RECOVERY_ROOT / "operations" / snapshot["operation_id"] / "archive.tar"
    data = original.read_bytes() if data is None else data
    admission = operation()
    cli("receive", admission, account["id"], "--request", json.dumps({
        "archive_bytes": len(data), "archive_sha256": hashlib.sha256(data).hexdigest(), "replace": replace,
    }), input=data)
    return admission


def git(path, *arguments):
    return run("git", "-c", "safe.directory=*", "-C", str(path), *arguments).stdout.decode()


class Recovery(unittest.TestCase):
    def test_files_git_profiles_ownership_and_linked_references(self):
        source, target = create(), create()
        root = home(source)
        repository = root / "repo"
        repository.mkdir()
        git(repository, "init")
        (repository / ".gitignore").write_text(".env\nnode_modules/\n")
        (repository / "tracked.txt").write_text("committed\n")
        git(repository, "add", ".")
        git(repository, "-c", "user.name=Backup fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture")
        (repository / "tracked.txt").write_text("dirty\n")
        (repository / ".env").write_text("DUMMY_PRIVATE=retained\n")
        (repository / "雪-😀.txt").write_text("untracked Unicode\n")
        cache = repository / "node_modules"
        cache.mkdir()
        (cache / "dependency").write_text("explicitly excluded")
        profile = root / ".config/chromium/Default"
        profile.mkdir(parents=True)
        with sqlite3.connect(profile / "History") as connection:
            connection.execute("create table visits (url text)")
            connection.execute("insert into visits values ('https://example.invalid/backup')")
        (root / ".workspace-config").write_text("fixture-settings")
        owned = root / "permissions"
        owned.write_bytes(b"private\0bytes")
        owned.chmod(0o640)
        os.setxattr(owned, "user.cantrip-proof", b"xattr")
        acl = struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in (
            (1, 6, 0xffffffff), (2, 4, source["uid"]), (4, 4, 0xffffffff),
            (8, 4, source["gid"]), (16, 4, 0xffffffff), (32, 0, 0xffffffff),
        ))
        os.setxattr(owned, "system.posix_acl_access", acl)
        os.link(owned, root / "hardlink")
        os.symlink("permissions", root / "relative-link")
        linked = root / "linked-host"
        linked.mkdir()
        (linked / "not-in-backup").write_text("external-reference-only")
        external = Path(tempfile.mkdtemp(prefix="cantrip-unrelated-"))
        (external / "unrelated-secret").write_text("not followed")
        os.symlink(external, root / "external-link")
        for directory, folders, files in os.walk(root):
            for path in [Path(directory), *(Path(directory) / name for name in files)]:
                os.lchown(path, source["uid"], source["gid"])
        (root / "root-owned").write_text("root configuration")
        (root / "root-owned").chmod(0o600)
        # Include a genuine external Git worktree plus its explicitly selected
        # common metadata, and verify relocation using Git after activation.
        worktree = external / "linux-worktree"
        git(repository, "worktree", "add", "-b", "backup-branch", str(worktree))
        (worktree / "dirty.txt").write_text("dirty linked Git worktree")
        os.chown(worktree, source["uid"], source["gid"])
        before = {name: json.loads(run(name, "status").stdout) for name in ("cantrip-workspaces", "cantrip-executor", "cantrip-remote")}
        snapshot = capture(source, {"exclusions": ["repo/node_modules"], "sources": [
            {"mode": "linked", "guestPath": str(linked)},
            {"mode": "linux-owned", "guestPath": str(worktree), "gitMetadataPaths": [str(repository / ".git")]},
        ]})
        self.assertEqual(snapshot["state"], "captured")
        self.assertTrue(snapshot["maintenance"]["released"])
        for name, status in before.items():
            after = json.loads(run(name, "status").stdout)
            self.assertEqual((after["service"], after["enabled"]), (status["service"], status["enabled"]))
        manifest = snapshot["receipt"]["manifest"]
        self.assertNotIn("view_token", manifest["workspace"])
        self.assertTrue(any(item["reason"] == "linked-host-source" for item in manifest["references"]))
        archive = RECOVERY_ROOT / "operations" / snapshot["operation_id"] / "archive.tar"
        self.assertEqual(stat.S_IMODE(archive.stat().st_mode), 0o600)
        with tarfile.open(archive) as contents:
            names = contents.getnames()
            self.assertIn("home/repo/.env", names)
            self.assertFalse(any("not-in-backup" in name or "unrelated-secret" in name for name in names))
        admitted = receive(target, snapshot)
        result = cli("restore", admitted)
        self.assertEqual(result["state"], "restored")
        restored = home(target)
        self.assertEqual((restored / "repo/.env").read_text(), "DUMMY_PRIVATE=retained\n")
        self.assertEqual((restored / "repo/雪-😀.txt").read_text(), "untracked Unicode\n")
        self.assertFalse((restored / "repo/node_modules").exists())
        self.assertEqual((restored / "permissions").stat().st_uid, target["uid"])
        self.assertEqual(stat.S_IMODE((restored / "permissions").stat().st_mode), 0o640)
        self.assertEqual(os.getxattr(restored / "permissions", "user.cantrip-proof"), b"xattr")
        restored_acl = os.getxattr(restored / "permissions", "system.posix_acl_access")
        entries = [struct.unpack_from("<HHI", restored_acl, offset) for offset in range(4, len(restored_acl), 8)]
        self.assertIn((2, 4, target["uid"]), entries)
        self.assertIn((8, 4, target["gid"]), entries)
        self.assertEqual((restored / "permissions").stat().st_ino, (restored / "hardlink").stat().st_ino)
        self.assertEqual(os.readlink(restored / "relative-link"), "permissions")
        self.assertEqual((restored / "root-owned").stat().st_uid, 0)
        self.assertIn(" M tracked.txt", git(restored / "repo", "status", "--porcelain"))
        extra = restored / f".cantrip-restored-sources-{admitted}/extra-1"
        self.assertIn("?? dirty.txt", git(extra, "status", "--porcelain"))
        self.assertTrue(git(extra, "rev-parse", "--git-common-dir").strip().startswith(str(restored)))
        with sqlite3.connect(restored / ".config/chromium/Default/History") as connection:
            self.assertEqual(connection.execute("select url from visits").fetchone()[0], "https://example.invalid/backup")
        # Same operation is observation only, even after the live source changes.
        (repository / ".env").write_text("changed later")
        repeated = cli("capture", snapshot["operation_id"], source["id"], "--request", json.dumps({"exclusions": ["repo/node_modules"], "sources": [
            {"mode": "linked", "guestPath": str(linked)},
            {"mode": "linux-owned", "guestPath": str(worktree), "gitMetadataPaths": [str(repository / ".git")]},
        ]}))
        self.assertEqual(repeated["receipt"]["archive_sha256"], snapshot["receipt"]["archive_sha256"])

    def test_replacement_requires_explicit_intent_and_rollback_retains_both(self):
        source, target = create(), create()
        (home(source) / "new").write_text("restored data")
        (home(target) / "original").write_text("usable original")
        snapshot = capture(source)
        refused = receive(target, snapshot)
        self.assertNotEqual(cli("restore", refused, check=False).returncode, 0)
        self.assertEqual((home(target) / "original").read_text(), "usable original")
        admitted = receive(target, snapshot, replace=True)
        restored = cli("restore", admitted)
        retained = Path(restored["receipt"]["retained_original_home"])
        self.assertEqual((retained / "original").read_text(), "usable original")
        rolled_back = cli("rollback", operation(), admitted)
        self.assertEqual(rolled_back["state"], "rolled-back")
        self.assertEqual((home(target) / "original").read_text(), "usable original")
        self.assertEqual((retained / "new").read_text(), "restored data")
        self.assertTrue(rolled_back["maintenance"]["released"])

    def test_omitted_external_git_metadata_cannot_follow_original_after_restore(self):
        source, target = create(), create()
        external = Path(tempfile.mkdtemp(prefix="cantrip-external-git-"))
        git(external, "init")
        (external / "tracked").write_text("external original")
        git(external, "add", ".")
        git(external, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture")
        worktree = home(source) / "worktree"
        git(external, "worktree", "add", "-b", "saved", str(worktree))
        snapshot = capture(source, {"sources": [{"mode": "linux-owned", "guestPath": str(worktree)}]})
        self.assertTrue(any(reference["reason"] == "external-git-metadata-requires-explicit-root"
                            for reference in snapshot["receipt"]["manifest"]["references"]))
        admitted = receive(target, snapshot)
        result = cli("restore", admitted)
        self.assertTrue(result["receipt"]["unresolved_metadata"])
        pointer = (home(target) / "worktree/.git").read_text().strip()
        self.assertIn(".cantrip-unresolved-git/", pointer)
        self.assertEqual((home(target) / "worktree/tracked").read_text(), "external original")
        self.assertTrue(git(worktree, "rev-parse", "HEAD").strip())

    def test_spool_cleanup_preserves_rollback_including_legacy_forgotten_receipts(self):
        for legacy in (False, True):
            with self.subTest(legacy_forgotten=legacy):
                source, target = create(), create()
                (home(source) / "replacement").write_text("backup data")
                (home(target) / "original").write_text("original data")
                admitted = receive(target, capture(source), replace=True)
                cli("restore", admitted)
                cleaned = cli("forget", admitted)
                self.assertEqual(cleaned["state"], "restored")
                self.assertFalse((RECOVERY_ROOT / "operations" / admitted / "archive.tar").exists())
                if legacy:
                    # Version 0.1.0 discarded the final state when forgetting
                    # spool files, but retained its receipt and inode evidence.
                    store = Store()
                    with store.lock():
                        record = store.read(admitted)
                        record["state"] = "forgotten"
                        record.pop("spool_forgotten", None)
                        store.save(record)
                result = cli("rollback", operation(), admitted)
                self.assertEqual(result["state"], "rolled-back")
                self.assertEqual((home(target) / "original").read_text(), "original data")

    def test_corrupt_archive_cannot_activate(self):
        source, target = create(), create()
        (home(source) / "payload").write_bytes(b"original payload")
        (home(target) / "keep").write_text("still usable")
        snapshot = capture(source)
        original = RECOVERY_ROOT / "operations" / snapshot["operation_id"] / "archive.tar"
        buffer = io.BytesIO()
        with tarfile.open(original) as archive, tarfile.open(fileobj=buffer, mode="w") as changed:
            for member in archive:
                content = archive.extractfile(member) if member.isreg() else None
                if member.name == "home/payload":
                    content = io.BytesIO(b"corrupt payload!")
                    member.size = len(content.getvalue())
                changed.addfile(member, content)
        admitted = receive(target, snapshot, replace=True, data=buffer.getvalue())
        self.assertNotEqual(cli("restore", admitted, check=False).returncode, 0)
        self.assertEqual((home(target) / "keep").read_text(), "still usable")
        self.assertTrue(cli("inspect", admitted)["maintenance"]["released"])

    def test_interruption_before_and_after_actual_exchange(self):
        for after in (False, True):
            with self.subTest(after_exchange=after):
                source, target = create(), create()
                (home(source) / "new").write_text("new data")
                (home(target) / "original").write_text("original data")
                admitted = receive(target, capture(source), replace=True)
                script = '''import os, sys
sys.path.insert(0, "/usr/lib/cantrip-os-recovery")
import restore
from state import Store
real = restore.exchange
def interrupted(first, second):
    if sys.argv[2] == "True":
        real(first, second)
    os._exit(91)
restore.exchange = interrupted
os.umask(0o077)
store = Store()
with store.lock():
    restore.activate(store, sys.argv[1])
'''
                result = run("python3", "-c", script, admitted, str(after), check=False)
                self.assertEqual(result.returncode, 91, result.stderr.decode())
                self.assertEqual(cli("inspect", admitted)["state"], "unknown")
                recovered = cli("recover", admitted)
                self.assertEqual(recovered["state"], "restored" if after else "failed")
                self.assertTrue(recovered["maintenance"]["released"])
                self.assertEqual((home(target) / ("new" if after else "original")).read_text(), "new data" if after else "original data")
                self.assertEqual(stat.S_IMODE(home(target).stat().st_mode), 0o700)

    def test_killed_capture_releases_real_maintenance_without_replay(self):
        source = create()
        original = home(source)
        (original / "keep").write_text("intact")
        admitted = operation()
        script = '''import os, signal, sys
sys.path.insert(0, "/usr/lib/cantrip-os-recovery")
import main
from state import Store
def stopped(*args):
    os.kill(os.getpid(), signal.SIGKILL)
main.archive.capture = stopped
os.umask(0o077)
store = Store()
with store.lock():
    main.capture(store, sys.argv[1], sys.argv[2], {})
'''
        result = run("python3", "-c", script, admitted, source["id"], check=False)
        self.assertEqual(result.returncode, -9)
        self.assertEqual(stat.S_IMODE(original.stat().st_mode), 0)
        unknown = cli("inspect", admitted)
        self.assertEqual(unknown["state"], "unknown")
        self.assertIsNone(unknown["receipt"])
        recovered = cli("recover", admitted)
        self.assertTrue(recovered["maintenance"]["released"])
        self.assertIsNone(recovered["receipt"])
        self.assertEqual((original / "keep").read_text(), "intact")
        self.assertEqual(stat.S_IMODE(original.stat().st_mode), 0o700)

    def test_real_change_watch_rejects_concurrent_modification(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            watcher = ChangeWatch([path])
            try:
                (path / "changed").write_text("a real write")
                with self.assertRaises(RuntimeError):
                    watcher.verify()
            finally:
                watcher.close()

    def test_actual_workspace_writer_stops_before_capture(self):
        source = create()
        marker = home(source) / "writer"
        process = subprocess.Popen(["runuser", "-u", source["user"], "--", "python3", "-c",
            "import os,time,sys; from pathlib import Path; p=Path(sys.argv[1]); "
            "p.write_text(str(os.getpid())); "
            "exec('while True:\\n p.write_text(str(os.getpid()))\\n time.sleep(.01)')", str(marker)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 10
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(marker.exists())
            writer = int(marker.read_text())
            result = capture(source)
            self.assertIn(writer, result["maintenance"]["stopped_pids"])
            process.wait(timeout=10)
            self.assertFalse(Path(f"/proc/{writer}").exists())
            self.assertEqual(result["state"], "captured")
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)

    def test_lost_shutdown_acknowledgement_is_observed_without_repeating_stop(self):
        source = create()
        admitted = operation()
        script = '''import json, os, subprocess, sys
sys.path.insert(0, "/usr/lib/cantrip-os-recovery")
import main, maintenance
from state import Store
real = maintenance.command
stops = []
def uncertain(program, *arguments, **options):
    result = real(program, *arguments, **options)
    if program == "cantrip-remote" and arguments == ("service", "stop"):
        stops.append(program)
        raise subprocess.CalledProcessError(17, [program, *arguments])
    return result
maintenance.command = uncertain
os.umask(0o077)
store = Store()
with store.lock():
    result = main.capture(store, sys.argv[1], sys.argv[2], {})
assert len(stops) == 1
print(json.dumps(result))
'''
        result = json.loads(run("python3", "-c", script, admitted, source["id"]).stdout)
        self.assertEqual(result["state"], "captured")
        remote = result["maintenance"]["services"][0]
        self.assertEqual(remote["stop_exit_code"], 17)
        self.assertTrue(remote["stop_confirmed_after_error"])


    def test_expected_workspace_rejects_stale_account_before_capture_effects(self):
        source = create()
        expected = {key: source[key] for key in ("uid", "gid", "home")}
        expected["uid"] += 1
        admitted = operation()
        before = json.loads(run("cantrip-executor", "status").stdout)["generation"]
        result = cli("--expect-workspace", json.dumps(expected), "capture", admitted, source["id"], check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("admitted workspace account changed", result.stderr.decode())
        self.assertFalse((RECOVERY_ROOT / "operations" / admitted).exists())
        self.assertEqual(json.loads(run("cantrip-executor", "status").stdout)["generation"], before)

    def test_saved_and_current_target_identity_are_checked_before_restore(self):
        source, target = create(), create()
        (home(source) / "new").write_text("new workspace data")
        (home(target) / "original").write_text("original data")
        snapshot = capture(source)
        archive = RECOVERY_ROOT / "operations" / snapshot["operation_id"] / "archive.tar"
        expected = {key: target[key] for key in ("uid", "gid", "home")}
        admitted = operation()
        cli("--expect-workspace", json.dumps(expected), "receive", admitted, target["id"], "--request", json.dumps({
            "archive_bytes": archive.stat().st_size, "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "replace": True,
        }), input=archive.read_bytes())
        wrong = {**expected, "gid": expected["gid"] + 1}
        result = cli("--expect-workspace", json.dumps(wrong), "restore", admitted, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(cli("inspect", admitted)["state"], "received")
        self.assertEqual((home(target) / "original").read_text(), "original data")
        self.assertEqual(cli("--expect-workspace", json.dumps(expected), "restore", admitted)["state"], "restored")

    def test_stale_runtime_is_rejected_under_the_maintenance_lock(self):
        source = create()
        status = json.loads(run("cantrip-executor", "status").stdout)
        if status["attachment"] is None:
            status = json.loads(run("cantrip-executor", "attach", "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002").stdout)
        expected = {"guestInstanceId": status["instance_id"], "ownerId": status["attachment"]["owner_id"],
                    "workerId": status["attachment"]["worker_id"], "runtimeGeneration": operation()}
        admitted = operation()
        result = cli("--expect", json.dumps(expected), "capture", admitted, source["id"], check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("admitted OS runtime changed", result.stderr.decode())
        self.assertFalse((RECOVERY_ROOT / "operations" / admitted).exists())
        self.assertEqual(json.loads(run("cantrip-executor", "status").stdout)["generation"], status["generation"])

    def test_previous_boot_cannot_appear_live_when_pid_and_start_ticks_match(self):
        store = Store()
        with store.lock():
            record, fresh = store.admit(operation(), "capture", {})
            self.assertTrue(fresh)
            identity = process_identity(os.getpid())
            record["process_identity"] = operation() + ":" + identity.split(":", 1)[1]
            record["state"] = "capturing"
            store.save(record)
        observed = cli("inspect", record["operation_id"])
        self.assertFalse(observed["active"])
        self.assertEqual(observed["state"], "unknown")


class RecoveryRemoval(unittest.TestCase):
    def test_removal_releases_interrupted_maintenance_and_retains_ordinary_os(self):
        source = create()
        marker = home(source) / "retained-after-removal"
        marker.write_text("retained workspace files")
        admitted = operation()
        script = '''import os, signal, sys
sys.path.insert(0, "/usr/lib/cantrip-os-recovery")
import main
from state import Store
def stopped(*args):
    os.kill(os.getpid(), signal.SIGKILL)
main.archive.capture = stopped
os.umask(0o077)
store = Store()
with store.lock():
    main.capture(store, sys.argv[1], sys.argv[2], {})
'''
        self.assertEqual(run("python3", "-c", script, admitted, source["id"], check=False).returncode, -9)
        self.assertEqual(stat.S_IMODE(home(source).stat().st_mode), 0)
        settings_path = Path("/etc/cantrip-os/recovery.json")
        settings = json.loads(settings_path.read_text())
        settings["fixture_preference"] = "preserved through reinstall"
        settings_path.write_text(json.dumps(settings))
        run("dpkg", "-r", "cantrip-os-recovery")
        self.assertEqual(stat.S_IMODE(home(source).stat().st_mode), 0o700)
        self.assertEqual(marker.read_text(), "retained workspace files")
        for program in ("cantrip-workspaces", "cantrip-executor", "cantrip-remote"):
            self.assertEqual(json.loads(run(program, "status").stdout)["service"], "running")
        run("runuser", "-u", "cantrip", "--", "xdpyinfo", "-display", ":0")
        if os.environ.get("CANTRIP_OS_CONTAINER") == "1":
            run("curl", "-fsS", "http://127.0.0.1:6080/")
        run("dpkg", "-i", "/tmp/recovery.deb")
        self.assertEqual(json.loads(settings_path.read_text())["fixture_preference"], "preserved through reinstall")
        self.assertTrue(cli("inspect", admitted)["maintenance"]["released"])
        self.assertEqual(marker.read_text(), "retained workspace files")


if __name__ == "__main__":
    unittest.main(verbosity=2)
