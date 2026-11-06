#!/usr/bin/python3
"""Actual reset/undo acceptance. Run as root only in a disposable CantripOS."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, "/usr/lib/cantrip-os-recovery")
from state import Store, workspace


def run(*argv, check=True):
    result = subprocess.run(argv, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(f"{argv[0]} exited {result.returncode}: {result.stderr.decode()}")
    return result


def cli(*argv, check=True):
    result = run("cantrip-recovery", *argv, check=check)
    return json.loads(result.stdout) if check else result


def identifier():
    return str(uuid.uuid4())


def create():
    name = "rst-" + uuid.uuid4().hex[:10]
    run("cantrip-workspaces", "create", name)
    return workspace(name)


def reset(account, paths, operation=None):
    return cli("reset", operation or identifier(), account["id"], "--request", json.dumps({"paths": paths}))


class WorkspaceReset(unittest.TestCase):
    def test_selected_state_preserves_dirty_git_ignored_files_links_metadata_and_undo(self):
        account, other = create(), create()
        home, other_home = Path(account["home"]), Path(other["home"])
        (other_home / "untouched").write_text("other workspace retained")
        repo = home / "repo"
        repo.mkdir()
        def git(*args):
            return run("git", "-c", "safe.directory=*", "-C", str(repo), *args).stdout
        git("init")
        (repo / "tracked").write_text("committed")
        (repo / ".gitignore").write_text(".env\nnode_modules/\n")
        git("add", ".")
        git("-c", "user.name=Reset fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture")
        (repo / "tracked").write_text("dirty")
        (repo / ".env").write_text("DUMMY_PRIVATE=retained")
        (repo / "雪-😀").write_text("untracked Unicode")
        (repo / "node_modules").mkdir()
        (repo / "node_modules/dependency").write_text("ignored but retained")
        profile = home / ".config/chromium"
        profile.mkdir(parents=True)
        with sqlite3.connect(profile / "History") as connection:
            connection.execute("CREATE TABLE visits (url text)")
            connection.execute("INSERT INTO visits VALUES ('https://example.invalid/reset')")
        (home / "Documents/note").write_text("old document")
        (home / "private").write_bytes(b"retained\0bytes")
        (home / "private").chmod(0o640)
        os.setxattr(home / "private", "user.cantrip-reset-proof", b"retained")
        os.link(home / "private", home / "hardlink")
        external = Path(tempfile.mkdtemp(prefix="cantrip-reset-external-"))
        (external / "keep").write_text("outside data untouched")
        os.symlink(external, home / "external-link")
        for directory, folders, files in os.walk(home, followlinks=False):
            for path in [Path(directory), *(Path(directory) / name for name in files)]:
                os.lchown(path, account["uid"], account["gid"])
        root_owned = home / "root-owned"
        root_owned.write_text("root-owned configuration")
        root_owned.chmod(0o600)
        before_git = git("status", "--porcelain=v1", "--untracked-files=all")
        before_head = git("rev-parse", "HEAD")
        operation = identifier()
        paths = [".config/chromium", "Documents", "external-link"]
        completed = reset(account, paths, operation)
        self.assertEqual(completed["version"], 2)
        self.assertEqual(completed["state"], "reset")
        self.assertTrue(completed["maintenance"]["released"])
        self.assertIn(other["id"], completed["maintenance"]["interrupted_workspaces"])
        self.assertEqual(workspace(account["id"])["uid"], account["uid"])
        self.assertFalse(profile.exists())
        self.assertEqual(list((home / "Documents").iterdir()), [])
        self.assertEqual(stat.S_IMODE((home / "Documents").stat().st_mode), 0o700)
        self.assertFalse((home / "external-link").is_symlink())
        self.assertEqual((external / "keep").read_text(), "outside data untouched")
        self.assertEqual(git("status", "--porcelain=v1", "--untracked-files=all"), before_git)
        self.assertEqual(git("rev-parse", "HEAD"), before_head)
        self.assertEqual((repo / ".env").read_text(), "DUMMY_PRIVATE=retained")
        self.assertEqual((repo / "node_modules/dependency").read_text(), "ignored but retained")
        self.assertEqual((home / "private").stat().st_ino, (home / "hardlink").stat().st_ino)
        self.assertEqual(os.getxattr(home / "private", "user.cantrip-reset-proof"), b"retained")
        self.assertEqual((home / "private").stat().st_uid, account["uid"])
        self.assertEqual(root_owned.stat().st_uid, 0)
        self.assertEqual(stat.S_IMODE(root_owned.stat().st_mode), 0o600)
        (home / "written-after-reset").write_text("later work must survive in the retained replacement")
        inode = home.stat().st_ino
        self.assertEqual(reset(account, paths, operation)["receipt"], completed["receipt"])
        self.assertEqual(home.stat().st_ino, inode)
        self.assertTrue((home / "written-after-reset").exists())
        mismatch = cli("reset", operation, account["id"], "--request", '{"paths":["."]}', check=False)
        self.assertNotEqual(mismatch.returncode, 0)
        cli("forget", operation)
        undone = cli("rollback", identifier(), operation)
        self.assertEqual(undone["state"], "rolled-back")
        self.assertEqual((home / "Documents/note").read_text(), "old document")
        with sqlite3.connect(profile / "History") as connection:
            self.assertEqual(connection.execute("SELECT url FROM visits").fetchone()[0], "https://example.invalid/reset")
        self.assertTrue((home / "external-link").is_symlink())
        self.assertTrue((Path(undone["receipt"]["retained_replaced_home"]) / "written-after-reset").exists())
        self.assertEqual((other_home / "untouched").read_text(), "other workspace retained")
        shutil.rmtree(external)

    def test_whole_home_uses_fresh_workspace_defaults_without_changing_system(self):
        account = create()
        home = Path(account["home"])
        (home / "old").write_text("retained for undo")
        os.mkfifo(home / "old-pipe")
        marker = Path("/etc") / ("cantrip-reset-proof-" + uuid.uuid4().hex)
        marker.write_text("shared system customization")
        inventory = run("dpkg-query", "-W").stdout
        try:
            completed = reset(account, ["."])
            self.assertEqual(completed["state"], "reset")
            self.assertEqual(sorted(path.name for path in home.iterdir()), ["Documents", "Downloads"])
            self.assertEqual(home.stat().st_uid, account["uid"])
            self.assertEqual(stat.S_IMODE(home.stat().st_mode), 0o700)
            original = Path(completed["receipt"]["retained_original_home"])
            self.assertEqual((original / "old").read_text(), "retained for undo")
            self.assertTrue(stat.S_ISFIFO((original / "old-pipe").stat().st_mode))
            self.assertEqual(marker.read_text(), "shared system customization")
            self.assertEqual(run("dpkg-query", "-W").stdout, inventory)
            self.assertFalse(completed["receipt"]["shared_system_state_changed"])
        finally:
            marker.unlink()

    def test_invalid_intent_and_stale_account_do_not_admit_reset(self):
        account = create()
        for paths in ([], [".."], ["a/../b"], ["/etc"], ["a", "a/b"], [".", "a"], ["a", "a"], ["./a"], ["a//b"], ["a\0b"], "a"):
            with self.subTest(paths=paths):
                operation = identifier()
                result = cli("reset", operation, account["id"], "--request", json.dumps({"paths": paths}), check=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(Store().directory(operation).exists())
        operation = identifier()
        expected = {key: account[key] for key in ("uid", "gid", "home")}
        expected["uid"] += 1
        result = cli("--expect-workspace", json.dumps(expected), "reset", operation, account["id"], "--request", '{"paths":["."]}', check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(Store().directory(operation).exists())

    def test_symlink_traversal_and_unselected_special_entries_preserve_original(self):
        account = create()
        home = Path(account["home"])
        external = Path(tempfile.mkdtemp(prefix="cantrip-reset-link-"))
        (external / "keep").write_text("outside")
        os.symlink(external, home / "link")
        try:
            result = cli("reset", identifier(), account["id"], "--request", '{"paths":["link/keep"]}', check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((external / "keep").read_text(), "outside")
            os.mkfifo(home / "preserved-pipe")
            (home / "selected").write_text("original")
            operation = identifier()
            result = cli("reset", operation, account["id"], "--request", '{"paths":["selected"]}', check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((home / "selected").read_text(), "original")
            self.assertTrue(stat.S_ISFIFO((home / "preserved-pipe").stat().st_mode))
            self.assertEqual(cli("inspect", operation)["state"], "failed")
            completed = reset(account, ["preserved-pipe"])
            self.assertTrue(completed["receipt"]["changes"][0]["previously_present"])
            self.assertFalse((home / "preserved-pipe").exists())
            self.assertEqual((home / "selected").read_text(), "original")
        finally:
            shutil.rmtree(external)

    def test_actual_mount_is_not_displaced_or_copied(self):
        account = create()
        home = Path(account["home"])
        external = Path(tempfile.mkdtemp(prefix="cantrip-reset-mount-"))
        (external / "keep").write_text("external source")
        target = home / "mounted"
        target.mkdir()
        result = run("mount", "--bind", str(external), str(target), check=False)
        if result.returncode:
            shutil.rmtree(external)
            self.skipTest("Actual bind mount failed on this target: " + result.stderr.decode().strip())
        try:
            result = cli("reset", identifier(), account["id"], "--request", '{"paths":["."]}', check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((external / "keep").read_text(), "external source")
            run("mountpoint", "-q", str(target))
        finally:
            run("umount", str(target))
            shutil.rmtree(external)

    def test_killed_exchange_is_observed_not_repeated(self):
        for after in (False, True):
            with self.subTest(after=after):
                account = create()
                home = Path(account["home"])
                (home / "original").write_text("before reset")
                operation = identifier()
                script = '''import os, signal, sys
sys.path.insert(0,"/usr/lib/cantrip-os-recovery")
import reset
from state import Store
actual=reset.restore.exchange
def interrupted(first,second):
    if sys.argv[3]=="True":actual(first,second)
    os.kill(os.getpid(),signal.SIGKILL)
reset.restore.exchange=interrupted
os.umask(0o077)
store=Store()
with store.lock():reset.reset(store,sys.argv[1],sys.argv[2],{"paths":["."]})
'''
                result = run("python3", "-c", script, operation, account["id"], str(after), check=False)
                self.assertEqual(result.returncode, -9, result.stderr.decode())
                self.assertEqual(cli("inspect", operation)["state"], "unknown")
                observed = cli("recover", operation)
                self.assertEqual(observed["state"], "reset" if after else "failed")
                self.assertTrue(observed["maintenance"]["released"])
                self.assertEqual((home / "original").exists(), not after)
                self.assertEqual(stat.S_IMODE(home.stat().st_mode), 0o700)
                (home / "since-recovery").write_text("must not be reset again")
                inode = home.stat().st_ino
                reset(account, ["."], operation)
                self.assertEqual(home.stat().st_ino, inode)
                self.assertTrue((home / "since-recovery").exists())

    def test_older_helper_rejects_new_reset_records_without_modifying_them(self):
        account = create()
        result = reset(account, ["."])
        operation = result["operation_id"]
        path = Store().directory(operation) / "record.json"
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        try:
            run("dpkg", "-i", "/tmp/recovery-old.deb")
            rejected = run("cantrip-recovery", "inspect", operation, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
        finally:
            run("dpkg", "-i", "/tmp/recovery.deb")
        self.assertEqual(cli("inspect", operation)["state"], "reset")

    def test_killed_staging_releases_maintenance_without_restarting_reset(self):
        account = create()
        home = Path(account["home"])
        (home / "original").write_text("original data")
        operation = identifier()
        script = '''import os, signal, sys
sys.path.insert(0,"/usr/lib/cantrip-os-recovery")
import reset
from state import Store
reset.archive.capture=lambda *args:os.kill(os.getpid(),signal.SIGKILL)
os.umask(0o077)
store=Store()
with store.lock():reset.reset(store,sys.argv[1],sys.argv[2],{"paths":["original"]})
'''
        self.assertEqual(run("python3", "-c", script, operation, account["id"], check=False).returncode, -9)
        self.assertEqual(stat.S_IMODE(home.stat().st_mode), 0)
        self.assertEqual(cli("inspect", operation)["state"], "unknown")
        observed = cli("recover", operation)
        self.assertEqual(observed["state"], "failed")
        self.assertTrue(observed["maintenance"]["released"])
        self.assertEqual((home / "original").read_text(), "original data")
        reset(account, ["original"], operation)
        self.assertEqual((home / "original").read_text(), "original data")

    def test_undo_rejects_retained_symlink_even_when_it_names_the_original_inode(self):
        account = create()
        home = Path(account["home"])
        (home / "original").write_text("retained original")
        completed = reset(account, ["."])
        retained = Path(completed["receipt"]["retained_original_home"])
        actual = retained.with_name("original-directory")
        retained.rename(actual)
        retained.symlink_to(actual.name)
        operation = identifier()
        result = cli("rollback", operation, completed["operation_id"], check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(home.is_symlink())
        self.assertFalse((home / "original").exists())
        self.assertEqual((actual / "original").read_text(), "retained original")
        self.assertEqual(cli("recover", operation)["state"], "failed")
        retained.unlink()
        actual.rename(retained)
        self.assertEqual(cli("rollback", identifier(), completed["operation_id"])["state"], "rolled-back")
        self.assertEqual((home / "original").read_text(), "retained original")

    def test_removal_releases_interrupted_reset_and_retains_ordinary_desktop(self):
        account = create()
        home = Path(account["home"])
        (home / "original").write_text("original remains usable without the package")
        operation = identifier()
        script = '''import os, signal, sys
sys.path.insert(0,"/usr/lib/cantrip-os-recovery")
import reset
from state import Store
reset.restore.exchange=lambda *args:os.kill(os.getpid(),signal.SIGKILL)
os.umask(0o077)
store=Store()
with store.lock():reset.reset(store,sys.argv[1],sys.argv[2],{"paths":["."]})
'''
        self.assertEqual(run("python3", "-c", script, operation, account["id"], check=False).returncode, -9)
        self.assertEqual(stat.S_IMODE(home.stat().st_mode), 0)
        try:
            run("dpkg", "-r", "cantrip-os-recovery")
            self.assertEqual(stat.S_IMODE(home.stat().st_mode), 0o700)
            self.assertEqual((home / "original").read_text(), "original remains usable without the package")
            run("runuser", "-u", "cantrip", "--", "xdpyinfo", "-display", ":0")
            for program in ("cantrip-workspaces", "cantrip-executor", "cantrip-remote"):
                self.assertEqual(json.loads(run(program, "status").stdout)["service"], "running")
        finally:
            run("dpkg", "-i", "/tmp/recovery.deb")
        observed = cli("inspect", operation)
        self.assertEqual(observed["state"], "failed")
        self.assertTrue(observed["maintenance"]["released"])
        self.assertEqual((home / "original").read_text(), "original remains usable without the package")


if __name__ == "__main__":
    unittest.main(verbosity=2)
