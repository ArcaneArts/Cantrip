#!/usr/bin/env python3
"""Create a link-free deterministic ZIP from a managed runtime tree."""

from __future__ import annotations

import os
import pathlib
import stat
import sys
import zipfile


def info(name: str, mode: int, is_directory: bool) -> zipfile.ZipInfo:
    item = zipfile.ZipInfo(name + ("/" if is_directory else ""))
    item.date_time = (2026, 8, 22, 0, 0, 0)
    item.create_system = 3
    kind = stat.S_IFDIR if is_directory else stat.S_IFREG
    item.external_attr = (kind | mode) << 16
    item.compress_type = zipfile.ZIP_DEFLATED
    return item


def main() -> None:
    source = pathlib.Path(sys.argv[1]).resolve(strict=True)
    destination = pathlib.Path(sys.argv[2]).resolve()
    with zipfile.ZipFile(
        destination,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
        strict_timestamps=True,
    ) as archive:
        for root, directories, files in os.walk(source):
            directories.sort()
            files.sort()
            root_path = pathlib.Path(root)
            for directory in directories:
                candidate = root_path / directory
                if candidate.is_symlink():
                    raise RuntimeError(f"runtime contains a symlink: {candidate}")
                relative = candidate.relative_to(source).as_posix()
                archive.writestr(info(relative, 0o700, True), b"")
            for filename in files:
                candidate = root_path / filename
                if candidate.is_symlink() or not candidate.is_file():
                    raise RuntimeError(f"runtime contains an unsafe entry: {candidate}")
                relative = candidate.relative_to(source).as_posix()
                executable = bool(candidate.stat().st_mode & 0o111)
                archive.writestr(
                    info(relative, 0o700 if executable else 0o600, False),
                    candidate.read_bytes(),
                )


if __name__ == "__main__":
    main()
