"""Small private product fixtures. No host files or real browser credentials."""
import json
import os
from pathlib import Path
import pwd
import sqlite3
import subprocess
import sys

action, workspace = sys.argv[1:]
account = pwd.getpwnam("ctw-" + workspace)
home = Path(account.pw_dir)
repo = home / "source" / "project"

def git(*args):
    return subprocess.check_output(["git", "-c", "safe.directory=*", "-C", str(repo), *args], stderr=subprocess.DEVNULL).decode().strip()

if action == "seed":
    repo.mkdir(parents=True)
    (repo / "tracked.txt").write_text("committed\n")
    (repo / ".gitignore").write_text(".env\nnode_modules/\n")
    git("init")
    git("add", ".")
    git("-c", "user.name=Cantrip QA", "-c", "user.email=qa@example.test", "commit", "-m", "private fixture")
    (repo / "tracked.txt").write_text("dirty captured\n")
    (repo / ".env").write_text("private ignored fixture\n")
    (repo / "untracked 日本語 🖤.txt").write_text("Unicode µ retained\n")
    (repo / "node_modules").mkdir()
    (repo / "node_modules" / "fixture.bin").write_bytes(bytes(range(256)))
    (repo / "mode.sh").write_text("#!/bin/sh\necho retained\n")
    (repo / "mode.sh").chmod(0o751)
    (home / ".cache").mkdir(exist_ok=True)
    (home / ".cache" / "excluded").write_text("explicit exclusion\n")
    (home / ".config").mkdir(exist_ok=True)
    (home / ".config" / "workspace.json").write_text('{"oled":true}\n')
    # A closed browser-profile SQLite fixture proves byte preservation without
    # claiming portable browser authentication or model/browser acceptance.
    profile = home / ".config" / "chromium" / "Default"
    profile.mkdir(parents=True)
    with sqlite3.connect(profile / "History") as db:
        db.execute("CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT)")
        db.execute("INSERT INTO urls VALUES(1, ?, ?)", ("https://fixture.invalid/日本語", "Private profile fixture"))
    for path in [home, *home.rglob("*")]:
        os.chown(path, account.pw_uid, account.pw_gid)
    print(json.dumps({"seeded": True}))
elif action == "sentinel":
    (home / "usable-original").write_text("keep original\n")
    os.chown(home / "usable-original", account.pw_uid, account.pw_gid)
elif action == "check-sentinel":
    assert (home / "usable-original").read_text() == "keep original\n"
    print(json.dumps({"sentinel": True}))
elif action == "edit":
    (repo / "tracked.txt").write_text("source edited after capture\n")
elif action == "check-edit":
    assert (repo / "tracked.txt").read_text() == "source edited after capture\n"
    print(json.dumps({"edited": True}))
elif action == "verify":
    with sqlite3.connect(home / ".config" / "chromium" / "Default" / "History") as db:
        browser = db.execute("SELECT url,title FROM urls").fetchall() == [("https://fixture.invalid/日本語", "Private profile fixture")]
    result = {
        "dirty": (repo / "tracked.txt").read_text() == "dirty captured\n",
        "ignored": (repo / ".env").read_text() == "private ignored fixture\n" and (repo / "node_modules" / "fixture.bin").read_bytes() == bytes(range(256)),
        "unicode": (repo / "untracked 日本語 🖤.txt").read_text() == "Unicode µ retained\n",
        "mode": (repo / "mode.sh").stat().st_mode & 0o777 == 0o751,
        "ownership": all(p.stat().st_uid == account.pw_uid and p.stat().st_gid == account.pw_gid for p in repo.rglob("*")),
        "browser": browser,
        "config": json.loads((home / ".config" / "workspace.json").read_text()) == {"oled": True},
        "git": git("log", "-1", "--format=%s") == "private fixture" and any(line.endswith(" tracked.txt") and "M" in line[:2] for line in git("status", "--porcelain").splitlines()),
        "cacheExcluded": not (home / ".cache" / "excluded").exists(),
    }
    print(json.dumps(result))
else:
    raise ValueError(action)
