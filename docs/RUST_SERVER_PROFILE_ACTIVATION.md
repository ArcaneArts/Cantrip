# Native server profile activation

Logical profile conversion can now be followed by an in-place directory switch.
The active pathname stays the same, and the previous directory is retained at a
unique backup pathname reported by the CLI. The worker remains Node.

These are offline operations. Stop the source server and its worker before
exporting, converting or activating a profile. Use copies for qualification.
The native server's ordinary serving and background work do not run the bounded
JavaScript converter.

## Upgrade a stopped Node PGlite profile

```sh
node scripts/database-transfer/legacy-profile.mjs \
  /installation/server /backup/legacy-logical /absolute/path/to/cantrip-server

/absolute/path/to/cantrip-server --database pglite \
  --data-dir /installation/server-prepared --migrate-only \
  --restore-profile /backup/legacy-logical

/absolute/path/to/cantrip-server --data-dir /installation/server \
  --migrate-only --activate-profile /installation/server-prepared
```

Restore can instead explicitly select bundled PostgreSQL or external PostgreSQL
using the existing configuration options. The published profile retains that
backend selection. Distribution asset paths can be supplied with
`--bundled-pglite-runtime-dir` and `--bundled-postgres-bin-dir`.

The activation receipt reports `activationId`, `dataDirectory` and
`backupDirectory`. Existing physical database files, keys and opaque files in
the previous profile are retained by renaming its whole directory. No database
version or capability metadata determines whether a backend may open.

## Roll back after Rust has accepted writes

Start reverse conversion with a fresh export of the current Rust profile, so
the resulting Node profile includes the writes accepted since the upgrade:

```sh
/absolute/path/to/cantrip-server --data-dir /installation/server \
  --migrate-only --export-profile /backup/current-rust \
  --pg-dump-path /absolute/path/to/pg_dump

node scripts/database-transfer/legacy-profile.mjs --restore \
  /backup/current-rust /installation/server-node /absolute/path/to/cantrip-server

/absolute/path/to/cantrip-server --data-dir /installation/server \
  --migrate-only --activate-profile /installation/server-node
```

The Node launcher can then use its original data pathname. This switch retains
the most recent Rust directory as another backup. Keep both receipts and backups
until the replacement has been validated. The original pre-upgrade backup is
historical recovery data; the fresh reverse-converted profile carries subsequent
writes.

## Interrupted activation

A private journal beside the active directory records the actual switch.
The candidate receives a unique owner-only operation marker. Activation moves
the prepared directory to its private incoming pathname, retains the old
directory, then exclusively publishes the incoming directory. The containing
directories and journal are synced on Unix; directory publication uses the
existing exclusive platform rename operation.

Normal Rust startup finishes a pending switch before reading the remembered
backend or opening a database. It recognizes publication that completed before
its acknowledgement was written. An explicit recovery command is also available:

```sh
/absolute/path/to/cantrip-server --data-dir /installation/server \
  --migrate-only --recover-profile-activation
```

Repeating activation with its consumed preparation pathname returns the prior
receipt and preserves subsequent writes. Preparing another profile at that
pathname starts a new explicit switch. No backup is removed automatically.

If an uncommitted candidate disappears while the original directory remains
active, recovery abandons that failed incoming move and reopens the current
data. Loss of both directories fails startup. A completed journal also requires
the activated directory to remain available; its completion record cannot
silently turn lost data into a fresh installation. An explicit restore of a
current logical export remains available to repair the missing destination.

OS locks serialize switches and exclude them while cooperating native servers
hold serving leases. Multiple native instances can hold shared leases for an
external PostgreSQL profile. A writable data mount may have an immutable or
root-owned parent: an actual permission/read-only failure to create the parent
lock does not prevent ordinary serving when no switch needs recovery. A pending
switch still requires its real recovery operation to finish.

Directory activation needs a writable parent on the same filesystem. A mounted
volume's root cannot be renamed; use a profile subdirectory when preparing an
explicit deployment-path migration. Cross-filesystem and permission failures
come from the actual filesystem operation and preserve the active directory.

## Local acceptance

The activation driver takes an actual stopped Node PGlite profile, an actual
packaged Node server, the native server and its interruption example:

```sh
CARGO_TARGET_DIR=/path/to/shared-target CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 \
  node scripts/server-rust/cargo.mjs build --bin cantrip-server \
  --example profile_activation_probe

node scripts/server-rust/profile-activation-compatibility.mjs \
  --native-server /path/to/cantrip-server \
  --probe /path/to/examples/profile_activation_probe \
  --native-assets /path/to/native-server-distribution \
  --legacy-server /path/to/node-server-distribution \
  --legacy-profile /path/to/disposable-stopped-profile \
  --external-url postgresql://fixture@127.0.0.1:PORT/fixture \
  --immutable-parent --report .qa/profile-activation.json
```

Each selected backend is interrupted with a real process kill after every
rename and after completion. The driver exercises normal startup recovery,
saved backend selection, original byte retention, real HTTP writes, a blocked
activation retry, restart, reverse conversion and actual packaged Node writes.
The optional immutable-parent case requires a Unix account without filesystem
permission bypass. Omit the external URL to select only the two local engines.
Always provide an owned disposable PostgreSQL fixture; no inherited connection
is used.

The driver also checks two native processes sharing an external-database profile,
lost uncommitted candidates, missing active data after acknowledged activation,
explicit recovery from a latest-state export, and a no-op recovery command under
the non-writable parent. These cases distinguish actual data recovery from
relying on a journal's previous completion status.

Local macOS arm64 acceptance passes all twelve interruption/reversal cases:
four real process-kill boundaries for each of native PGlite 17.5, bundled
PostgreSQL 18.6 and external PostgreSQL 18.6. The source is an actual Node-created
desktop PGlite 18.3 profile. Its original bytes remain unchanged; server UUID,
preferences and opaque key files survive conversion and activation. Every case
accepts a Rust HTTP write, retains it across retry/restart, reverse-converts the
current state, and observes that write through the actual packaged Node server
before Node accepts another write.

All five supplemental recovery/lease/layout scenarios pass. Seven native
activation tests and six existing profile-file tests also pass. The standard
repository check still stops at unchanged Node line budgets, so it is not green.
These results establish this offline component on the tested host; they do not
establish complete client, historical-runtime or other-platform acceptance.

This component does not yet package or automatically invoke the legacy
converter during a desktop update. Existing-client recovery/Keychain continuity,
packaged upgrade supervision, historical runtime versions and supported-platform
qualification remain required before default cutover. All development validation
runs locally; GitHub Actions remains reserved for releases and deployments.
