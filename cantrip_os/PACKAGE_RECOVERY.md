# Optional package upgrade and repair

Recovery 0.4.0 supplies `cantrip-package`, a bounded root CLI with no daemon,
listener, credentials or scheduler. The owning Worker can execute the same
versioned source over its Docker/strict-SSH carrier without invoking an installed
Cantrip helper. Debian Python and dpkg must still work. This is the administration
foundation; Server-owned package admissions and product controls are a subsequent
Phase 5 checkpoint.

## Admission and installation

An admission contains exactly these fields:

```json
{
  "version": 1,
  "operationId": "<new canonical UUID>",
  "scopeKey": "<64 lowercase hexadecimal characters identifying the attachment>",
  "action": "upgrade",
  "configuration": "preserve",
  "packages": [
    {
      "name": "cantrip-os-recovery",
      "version": "0.4.0",
      "architecture": "all",
      "sha256": "<actual lowercase SHA-256 of the Debian artifact>",
      "bytes": 0
    }
  ]
}
```

Replace placeholders and `bytes` with actual artifact metadata. Supported package
names are `cantrip-os-workspaces`, `cantrip-os-executor`, `cantrip-os-remote` and
`cantrip-os-recovery`. No dependency download is performed: normal Debian
dependency/architecture errors are retained as real installation outcomes.

The scope key is immutable request metadata, not an enrollment credential.
Administrative authority comes from Docker management or strict SSH/sudo access.
Use an exact Docker container ID for manual recovery. Product admission must add
its canonical ownership/attachment fencing; this CLI does not replace that layer.

With a working installed CLI:

```sh
sudo cantrip-package admit "$(cat request.json)"
sudo cantrip-package receive "$OPERATION_ID" "$PACKAGE_SHA256" < package.deb
sudo cantrip-package start "$OPERATION_ID"
sudo cantrip-package inspect "$OPERATION_ID"
```

`receive` verifies byte length, SHA-256 and actual Debian Package/Version/
Architecture before accepting the upload. It can receive the same admitted
artifact again while staging remains open. Reusing an operation ID with changed
intent is rejected. Finish all uploads before starting installation.

`start` durably reserves its only launch before forking a detached installer.
The response may still show a pending/running operation. Inspect until the
original operation has a committed outcome. There is no automatic install retry.

## Recovery without installed helpers

From the repository root, write a private transport JSON file containing either
`{"kind":"docker","container":"<exact container ID>"}` or an SSH transport with
`kind`, `host`, `port`, `user`, `identityFile` and `knownHostsFile`. SSH requires
batch authentication, strict host-key checking and noninteractive sudo. The key
remains on the Worker; agent forwarding is disabled.

```sh
node cantrip_os/scripts/manage-packages.mjs --transport transport.json admit request.json
node cantrip_os/scripts/manage-packages.mjs --transport transport.json receive "$OPERATION_ID" "$PACKAGE_SHA256" package.deb
node cantrip_os/scripts/manage-packages.mjs --transport transport.json start "$OPERATION_ID"
node cantrip_os/scripts/manage-packages.mjs --transport transport.json inspect "$OPERATION_ID"
```

This sends the repository's trusted rescue source to `/usr/bin/python3` rather
than calling `cantrip-package` or `cantrip-recovery`. The source is also included
in the packaged `@cantrip/os-host` assets. It does not install a Worker or expose
a new network service.

An ordinary `upgrade` runs `dpkg --force-confold --install` once. An explicit
`repair` first restores trusted package payload and maintainer scripts, retaining
original bytes and metadata before each replacement, then runs the real Debian
installer. This can repair helper/script breakage that prevents normal package
installation. Extraction alone is never reported as installation.

Repair uses dpkg's actual frontend/database POSIX locks and the recovery
maintenance mutex before replacing payload. An existing installer or coordinated
recovery command can therefore refuse the operation through its real lock.
The package's `prerm failed-upgrade` fallback also performs maintenance release;
it cannot silently bypass an active recovery command after the old `prerm` fails.
The fallback invocation follows [Debian's maintainer-script procedure](https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html).

## Configuration, outcomes and retained data

`configuration: "preserve"` is the default required policy for upgrades. Repair
also preserves conffiles unless its admission explicitly selects
`"configuration":"package-defaults"`. That separate choice retains originals
before replacing the selected packages' conffiles with their shipped defaults.
It does not reset workspace homes or unrelated system configuration.

Keeping an invalid configuration can keep a helper broken. Receipts record
actual dpkg status and subsequent helper `status` exit codes; a successful dpkg
exit alone does not become a ready repair when the helper check fails. Disabled
services are not required to start. Diagnostics do not retain helper-status
stdout, which can contain workspace access information.

Root-private records, staged artifacts, logs and retained originals default to
`/var/lib/cantrip-os-executor/package-operations`, within the retained executor
volume. They are guest-side plaintext readable by root. Removal/reinstallation
of recovery retains them. This state is separate from workspace backup manifests
and does not copy machine identities or restore live runtime handles.

Inspection compares Linux boot/PID/start identities. A lost carrier does not
cancel the detached installer. A dead coordinator with no committed outcome stays
unknown, even if its installer finishes or the requested version is present.
Repeated `start` observes the original claim and never launches another install.
After an unknown operation, preserve its journal and inspect its recorded
installer; deliberately request a new repair only after that installer ends.

Repair is not a transaction across arbitrary privileged writers. Quiesce
independent root edits. If root changed a custom recovery-state path and then
destroyed the configuration pointing to it, an administrator must also coordinate
any operation still using that old path. A broken Python/dpkg installation,
unbootable disk or lost Docker/SSH control needs the deployment's separate rescue
path. This mechanism does not preserve/export the entire customized system layer
or merge arbitrary system modifications into a newer base image.

## Actual acceptance

Run only against disposable instances with the normal 0.4.0 artifact:

```sh
CANTRIP_OS_TEST_PACKAGE_TRANSPORT=/private/path/transport.json \
CANTRIP_OS_TEST_PACKAGE_DEB=/private/path/cantrip-os-recovery_0.4.0_all.deb \
node --test cantrip_os/tests/package-repair.integration.test.mjs
```

The suite makes real accounts, dirty/ignored/Unicode Git files, a SQLite browser
profile and a root-owned `/etc` marker. It builds actual faulty Debian packages,
breaks both installed helper entrypoints and a maintainer script, attempts normal
reinstallation, performs explicit external repair, verifies original configuration
bytes, and exercises real maintenance/dpkg locks. It kills the actual start
carrier and the detached coordinator separately. The guest CLI observes the same
saved outcomes after repair. Fixture data and operation records remain for
inspection; the original recovery conffile is restored at test completion.
