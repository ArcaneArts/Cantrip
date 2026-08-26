#!/usr/bin/env python3
"""Create deterministic Python license inventory and a CycloneDX SBOM."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import pathlib
import shutil
import sys


def normalized_name(value: str) -> str:
    return value.lower().replace("_", "-")


def main() -> None:
    runtime = pathlib.Path(sys.argv[1]).resolve()
    licenses = runtime / "licenses" / "python"
    licenses.mkdir(parents=True, exist_ok=True)
    components = []
    inventory = []

    distributions = sorted(
        importlib.metadata.distributions(),
        key=lambda item: normalized_name(item.metadata.get("Name", "")),
    )
    for dist in distributions:
        name = dist.metadata.get("Name")
        version = dist.version
        if not name or not version:
            continue
        package_dir = licenses / f"{normalized_name(name)}-{version}"
        copied = []
        for relative in dist.files or []:
            base = pathlib.PurePosixPath(str(relative)).name.lower()
            if not (base.startswith(("license", "copying", "notice"))):
                continue
            source = pathlib.Path(dist.locate_file(relative))
            if not source.is_file() or source.stat().st_size > 2_000_000:
                continue
            package_dir.mkdir(parents=True, exist_ok=True)
            destination = package_dir / pathlib.PurePosixPath(str(relative)).name
            shutil.copyfile(source, destination)
            copied.append(str(destination.relative_to(runtime)))

        metadata_license = dist.metadata.get("License-Expression") or dist.metadata.get("License") or "NOASSERTION"
        purl = f"pkg:pypi/{normalized_name(name)}@{version}"
        inventory.append(
            {
                "name": name,
                "version": version,
                "license": metadata_license.strip()[:512],
                "licenseFiles": sorted(set(copied)),
            }
        )
        components.append(
            {
                "type": "library",
                "name": name,
                "version": version,
                "purl": purl,
                "licenses": [{"license": {"name": metadata_license.strip()[:512]}}],
            }
        )

    inventory_path = runtime / "licenses" / "manifest.json"
    inventory_path.write_text(json.dumps({"schemaVersion": 1, "packages": inventory}, indent=2) + "\n")
    serial_seed = json.dumps(components, sort_keys=True).encode()
    serial = hashlib.sha256(serial_seed).hexdigest()
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": f"urn:uuid:{serial[:8]}-{serial[8:12]}-{serial[12:16]}-{serial[16:20]}-{serial[20:32]}",
        "version": 1,
        "components": components,
    }
    (runtime / "sbom.cdx.json").write_text(json.dumps(sbom, indent=2) + "\n")


if __name__ == "__main__":
    main()
