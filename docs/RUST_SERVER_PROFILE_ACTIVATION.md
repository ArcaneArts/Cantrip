# Native server profile activation

Logical profile conversion can now be followed by an in-place directory switch.
The active pathname stays the same, and the previous directory is retained at a
unique backup pathname reported by the CLI. The worker remains Node.

These are offline operations. Stop the source server and its worker before
exporting, converting or activating a profile. Use copies for qualification.
The native server's ordinary serving and background work do not run the bounded
JavaScript converter.

## Upgrade a stopped legacy PGlite profile

The offline CLI accepts an explicit PostgreSQL 18 compatibility runtime.
Its build matches the datum and stored-expression formats of legacy PGlite 18.
Build it on macOS or Linux with the PostgreSQL source build tools and zlib
development headers. Node is used by the build script.

```sh
node scripts/database-transfer/build-legacy-postgres.mjs /build/legacy-postgres

/absolute/path/to/cantrip-server --data-dir /installation/server \
  --migrate-only --upgrade-profile \
  --legacy-postgres-bin-dir /build/legacy-postgres/bin
```

The upgrade tries the native serving engine on a private copy. If it cannot
open the database, the compatibility runtime opens a fresh copy and dumps it.
The server restores the logical profile into native PGlite and publishes it
through the activation journal.

Desktop packaging on a matching macOS or Linux host builds the private tools
into `runtime/server/legacy-postgres`. The package records their `bin` directory
in `desktop-server.json`, and desktop startup tries the upgrade before serving.
For manual operations, point `--legacy-postgres-bin-dir` at that same directory.
Building the package requires a C toolchain, Make, Bison, Flex and zlib headers.
The packaged conversion uses the binaries directly. Windows and cross-target
desktop assembly still use the JavaScript converter. The native runtime takes
precedence when both are supplied.

Use explicit export and restore if you need to keep an archive, prepare at a
separate path, or select another database backend.

```sh
/absolute/path/to/cantrip-server --data-dir /installation/server \
  --migrate-only --export-legacy-profile /backup/legacy-logical \
  --legacy-postgres-bin-dir /build/legacy-postgres/bin

/absolute/path/to/cantrip-server --database pglite \
  --data-dir /installation/server-prepared --migrate-only \
  --restore-profile /backup/legacy-logical

/absolute/path/to/cantrip-server --data-dir /installation/server \
  --migrate-only --activate-profile /installation/server-prepared
```

Restore can explicitly select bundled PostgreSQL or external PostgreSQL
through the existing configuration options. The published profile retains
that backend selection. Supply distribution asset paths with
`--bundled-pglite-runtime-dir` and `--bundled-postgres-bin-dir`.

The activation receipt reports `activationId`, `dataDirectory`, and
`backupDirectory`. Renaming the original directory retains its physical
database, keys, and opaque files.

## Roll back after Rust has accepted writes

Export the current Rust profile so the restored legacy database includes
writes accepted since the upgrade.

```sh
/absolute/path/to/cantrip-server --data-dir /installation/server \
  --migrate-only --export-profile /backup/current-rust \
  --pg-dump-path /build/legacy-postgres/bin/pg_dump

/absolute/path/to/cantrip-server --data-dir /installation/server-legacy \
  --migrate-only --restore-legacy-profile /backup/current-rust \
  --legacy-postgres-bin-dir /build/legacy-postgres/bin

/absolute/path/to/cantrip-server --data-dir /installation/server \
  --migrate-only --activate-profile /installation/server-legacy
```

The restored legacy profile uses the pinned JavaScript engine's physical
format. The CLI verifies the bundle, loads it in one transaction, checks the
resulting cluster and expression format, and stops PostgreSQL before
publishing the candidate. The later activate command retains the latest
Rust directory as a backup. The Node launcher can then use the original
profile path. The export, restore and activation CLI commands run without Node.

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
