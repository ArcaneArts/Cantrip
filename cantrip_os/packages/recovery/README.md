# Optional workspace recovery package

`cantrip-os-recovery` 0.5.0 supplies root administration commands for consistent
workspace capture, staged restore, explicit home-state reset and rollback. It has no daemon, network
listener, Worker, model credentials or scheduler. Docker and ISO launch scripts
include it with the executor edition; `CANTRIP_OS_RECOVERY=0` omits it. The ordinary
OS remains selectable with `CANTRIP_OS_WORKSPACES=0`.

Encrypted Worker storage and durable Worker backup jobs build on this guest
package. Both Servers supply durable admissions and a catalogue API, used by
Cantrip's project backup controls. Local guest staging is plaintext readable by root;
the Worker encrypts archives outside the OS. See [backup behavior](../../BACKUPS.md).

## Build and install

From the repository root:

```sh
node cantrip_os/scripts/recovery-package.mjs
```

The architecture-independent output is
`cantrip_os/artifacts/packages/cantrip-os-recovery_0.5.0_all.deb`. Install it with
`sudo apt install ./cantrip-os-recovery_0.5.0_all.deb`. Dependencies are the existing
workspace and executor packages plus Python. No extra desktop environment or
full Worker is installed. Package configuration is a Debian conffile at
`/etc/cantrip-os/recovery.json`.

Default root-private records and staging live in
`/var/lib/cantrip-os-executor/recovery`, inside the existing retained Docker
executor volume. Restore staging and retained original homes live beside the
workspace home, inside the retained workspace volume. Ordinary Docker stop/start
and linked-source recreation retain these paths; they are not a backup of the
container's entire writable system layer.

## Capture and transfer

Use a new canonical UUID for each intended operation. Retain it when a response
is lost. Example, with an existing workspace named `example`:

```sh
sudo cantrip-recovery capture "$CAPTURE_ID" example --request '{"exclusions":["repo/node_modules"]}'
sudo cantrip-recovery inspect "$CAPTURE_ID"
sudo cantrip-recovery export "$CAPTURE_ID" > workspace.tar
```

The capture receipt includes the archive's byte length and SHA-256. `export`
also supports `--offset` and `--length`; it verifies the retained archive before
emitting bytes. Repeating a capture with the same ID/request observes its saved
outcome. Reusing the ID for different intent fails. It never silently captures a
newer state under an older operation ID.

Worker admissions pass global `--expect` with the persistent guest, owner and
Worker identities, plus the admitted runtime generation for mutations.
`--expect-workspace` pins the exact numeric UID/GID and home. Mutation checks run
under the actual maintenance lock, before admission or filesystem effects.
Receive retains the expected account for later activation and rollback. Local
administrators may omit these flags; an old helper rejects unsupported flags
before performing the operation. Observation retains persistent identity pins
without requiring the pre-maintenance runtime to survive a service restart.

Capture stops the actual remote, executor and workspace services, then remaining
processes running as registered workspace accounts. This interrupts **all**
Cantrip workspaces on the instance, including managed root descendants. The
personal console desktop is independent. Services previously running are
restarted in reverse order; enable/disable preferences are preserved. Stopped
desktop windows and processes are not resurrected. The receipt records the
affected workspace IDs and remaining workspace writer PIDs.

Included root permissions are temporarily closed to ordinary workspace users.
Linux filesystem watches reject changes during copying, including unavailable
watch coverage. Arbitrary trusted root processes can bypass account permissions;
this coordinates managed writers, not hostile root users or independent external
writers. A stopped service may create a fresh runtime generation on restart;
existing captured handles require the normal explicit product recovery path.

The home includes dirty/untracked/ignored files, Chromium profile bytes,
configuration, modes, numeric ownership, hard links, symlinks and Linux extended
attributes. Gitignore is never consulted. Exclusions are explicit home-relative
paths recorded in the manifest; Git metadata cannot be excluded this way.
Sockets/devices and nested mount contents are omitted with recorded reasons.
Symlinks are stored without following their contents. File content is streamed;
member/inventory indexes still use memory proportional to the number of entries.

Additional sources are explicit private request metadata:

```json
{
  "sources": [
    { "mode": "linked", "guestPath": "/projects/host-source" },
    {
      "mode": "linux-owned",
      "guestPath": "/projects/linux-source",
      "gitMetadataPaths": ["/projects/primary/.git"]
    }
  ]
}
```

Linked sources are references, including when their path is inside the home.
Their bytes are not copied. Linux-owned paths are included. Administrative Git
pointers include common metadata only within the home or explicitly declared
Linux roots/`gitMetadataPaths`; they do not grant access to arbitrary external
trees. Missing external Git metadata is recorded as a reference. Verify the
manifest's roots, exclusions, references and skipped entries for intended scope.

## Receive, restore and roll back

Create a destination workspace with `cantrip-workspaces create destination`.
Supply the authenticated receipt values received with the archive:

```sh
sudo cantrip-recovery receive "$RESTORE_ID" destination \
  --request '{"archive_bytes":20480,"archive_sha256":"<actual lowercase SHA-256>"}' < workspace.tar
sudo cantrip-recovery restore "$RESTORE_ID"
```

`receive` streams and checks the exact bytes before accepting the archive. Restore
validates version, member graph, inventory and file digests in root-private
staging. Data and directory changes are synced before an atomic Linux directory
exchange activates the restored home. The original home is retained privately.
The destination must be newly created and empty by default; to deliberately
replace existing data, include `"replace":true` in the original receive request.

Source workspace UID/GID values, including named POSIX ACL entries, map to the
destination account. Root-owned and other numeric owners remain numeric; no
unrelated system accounts are created. Additional Linux source roots move into
`.cantrip-restored-sources-<restore-ID>/extra-N` beneath the new home. Git
administrative pointers to included paths are relocated. Unresolved external
Git targets become intentionally absent paths listed in the private receipt,
so Git does not continue operating on the old workspace. Exotic quoted Git
configuration and generic external symlinks may need manual repair. The receipt
reports source roots and references for deliberate source rebinding.

This restores workspace data, not machine/enrollment identities, SSH host keys,
Server source bindings, live processes or runtime handles. Browser files can be
restored, but authenticated browser sessions may depend on machine/account keys
and are not promised portable.

To restore the retained original after an explicit replacement:

```sh
sudo cantrip-recovery rollback "$ROLLBACK_ID" "$RESTORE_ID"
```

Rollback has its own durable admission and retains the replaced home rather than
deleting either copy. It requires the actual directory identities from that
restore; it cannot exchange an unrelated subsequently replaced home.

## Reset selected home state

Reset keeps the same Linux account, UID/GID and absolute home. Shared installed
packages, `/etc` configuration, machine/enrollment identities and SSH host keys
are outside this operation. Use a fresh UUID and explicitly select canonical
home-relative paths:

```sh
sudo cantrip-recovery reset "$RESET_ID" example \
  --request '{"paths":[".config/chromium","Documents"]}'
```

The selected entries are removed from a verified staged copy of the home.
`Documents` and `Downloads` are recreated as empty account-owned directories,
matching a newly created workspace. Other absent entries are recreated by their
applications when needed. To reset the entire home to those fresh workspace
defaults, explicitly use `{"paths":["."]}`. Empty, absolute, overlapping, parent
traversal and noncanonical selections are rejected. A selected symlink itself
can be removed; selecting through a symlink ancestor is rejected. Its external
target is never copied or reset.

Selected reset stages the full home using the existing archive consistency and
verification path, preserving unselected ordinary files, dirty/ignored Git data,
internal hard links, modes, numeric ownership and extended attributes. Existing
Git pointers remain verbatim because the account and absolute home do not move.
The staged copy has new inode identities; open processes and handles are not
retained. A real mounted filesystem at or inside the home must be detached
explicitly before either reset mode: exchanging the home must not silently move
that attachment. Partial reset rejects an unselected special entry it cannot
preserve, rather than dropping it. The complete original home remains active
when staging fails.

As with capture/restore, maintenance interrupts **all managed Cantrip workspace
processes and desktops on this instance**. Other workspace files and the ordinary
personal desktop are retained. A service restart establishes fresh runtime
handles; use explicit product recovery and source verification afterwards.

The final directory exchange retains the complete original home privately beside
the active home. The receipt records selected paths, the actual account and the
retained path. `inspect` and repeating the same reset ID only observe; they never
reset a newer home again. Undo is explicit:

```sh
sudo cantrip-recovery rollback "$UNDO_ID" "$RESET_ID"
```

Undo exchanges the retained original back into place and retains the replaced
home too, including files written since reset. It does not merge later work.
Both paths must still be the actual recorded directories; substituting a symlink
is rejected. `forget` can discard partial-reset transfer staging after release,
but preserves the reset outcome and retained home required for undo.

Reset journals use record version 2. Existing capture/restore/rollback journals
remain version 1. An older 0.2.0 helper rejects reset records without modifying
them; reinstall 0.3.0 or newer to inspect/recover them. An interrupted staging or
exchange is recovered from actual process/directory identities without replay.
Package removal releases interrupted reset maintenance before removing the helper
and retains both workspace data and operation records.

Worker/Server reset admissions and the
[product reset controls](../../PRODUCT_WORKFLOW.md#reset-workspace-state) build on
this guest administration boundary. In Project Settings → CantripOS, choose
**Private backups and recovery → Reset workspace state**, review explicit paths
or the entire home, and confirm. Capture/restore retain their version-1 records.

## Package upgrade and external repair

Version 0.5.0 supplies `cantrip-package`, a separate bounded package-operation CLI.
The owning Worker can send its identical source over Docker or strict SSH to
repair broken installed Cantrip helpers. Upgrade preserves administrator
conffiles; explicitly choosing package defaults retains the original bytes.
One-shot jobs have durable launch claims, actual dpkg/helper outcomes and
observation without replay. Version 0.5.0 adds actual identity/boot probing,
owner-pinned version 2 requests and durable pre-start abandonment. External
Worker jobs supply verified artifact snapshots and private encrypted outcomes
without requiring a live executor. Both Servers now retain authorized package
admissions, history and protected results. Project Settings → CantripOS →
**Cantrip integration packages** supplies build selection, update/repair review,
saved-request recovery and private receipts.
See [package recovery](../../PACKAGE_RECOVERY.md).

## Interruption and removal

`inspect` is read-only. A dead command with an unfinished admission reports
`unknown`, not success. Process identity includes the Linux boot ID and process
start ticks, so a reboot cannot make an old PID appear alive. An uncertain
capture is never recaptured automatically.
After the root command has actually exited, run:

```sh
sudo cantrip-recovery recover "$OPERATION_ID"
```

Recovery observes recorded directory identities to determine whether the atomic
exchange happened, then restores permissions and the previously running
services. It does not repeat the exchange. A failure before activation preserves
the active original; an observed completed exchange is reported as restored.
Unknown directory identities leave both paths untouched for administration.
An interrupted capture/receive with no committed completion becomes failed after
its process is confirmed dead; recovery releases maintenance without replaying it.

`forget ID` deletes transfer spool files only after maintenance is released. It
does not delete retained original homes. Protect/export backups before forgetting
their guest archive. Cleanup preserves the committed outcome and rollback
evidence. Rollback also accepts an older 0.1.0 `forgotten` restore when its retained
receipt and actual directory identities still prove the completed exchange.
Retained originals need deliberate administrator cleanup.

Removing or upgrading the package executes maintenance release under the real
operation lock. An active command must finish first. Interrupted maintenance is
recovered before the helper disappears. Removal retains records, files and
conffiles; reinstall can inspect the old operation. This command-only package has
no service to disable. Omit/remove it to disable backup commands while keeping
ordinary desktops and files.

## Disposable integration test

Copy `test/integration.py` and the built package to a disposable running OS as
`/tmp/recovery-integration.py` and `/tmp/recovery.deb`, then run as root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 /tmp/recovery-integration.py
```

The fixture requires the remote package too, creates real accounts and data,
stops services/writers, injects abrupt process exits around the actual exchange,
and removes/reinstalls recovery. It is destructive test administration; do not
run it against a user's working OS. See `cantrip_os/ACCEPTANCE.md` for recorded
Docker/installed results and remaining Phase 5 product work.

Reset acceptance is a separate actual-guest suite. Copy
`test/reset_integration.py`, the normal 0.5.0 package and the prior normal 0.2.0
package to the disposable guest as `/tmp/reset-integration.py`,
`/tmp/recovery.deb` and `/tmp/recovery-old.deb`, then run as root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 /tmp/reset-integration.py
```

This exercises selected/full-home reset, undo, metadata and ignored-file
preservation, real process kills around staging/exchange, unsupported old-helper
records and removal/reinstallation. The bind-mount case attempts the actual
mount; ordinary Docker without the required kernel permission skips that case.
Installed-system acceptance exercises it with a real mount. Retained originals
and test accounts are intentionally kept for inspection.
