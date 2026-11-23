# Packaged desktop Rust services

The desktop supervisor starts `cantrip-server` and `cantrip-worker` from the
bundled runtime. The worker package includes Codex, the Cantrip CLI, and the
computer-use helper. The services and first-party helpers run without Node.js.

## Build and stage the runtime

Build on a host matching the desktop target. For example, stage the runtime on
macOS ARM64 with the desired PostgreSQL installation.

```sh
CARGO_TARGET_DIR=/path/to/shared-target CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 \
  pnpm package:desktop-runtime --target darwin-arm64 \
  --postgres-bin /path/to/postgresql18/bin
```

The runtime is staged under `cantrip_app/src-tauri/resources/runtime`. For the
complete Tauri bundle, run `pnpm package:app --target darwin-arm64`.
The server and the pinned Codex toolchain can use their respective shared build
caches.

To use existing native service packages on the same platform, stage them with
the `--from-artifacts` option.

```sh
pnpm package:desktop-runtime --target darwin-arm64 --from-artifacts
```

The package directories are `artifacts/cantrip-server-<target>` and
`artifacts/cantrip-worker-<target>`, produced by `pnpm package:server` and
`pnpm package:worker` or extracted from their release archives. Pass
`--from-artifacts` to `pnpm package:app` to use those same service trees in
the desktop bundle.

`runtime/server/desktop-server.json` records the server's bundled PostgreSQL and
legacy compatibility paths. The launcher passes the bundled asset paths to the
server. Explicit environment and saved database selection retain their normal
precedence for PGlite, bundled PostgreSQL, and external PostgreSQL.

## Existing profiles

Close the previous installation before opening a profile with the new desktop
bundle. The supervisor invokes native profile preparation before starting the
server. Legacy PGlite conversion uses the packaged PostgreSQL compatibility
tools and keeps the existing profile identity and directory. The worker reuses
its identity, credentials, keys, and local state. See the
[server guide](../deploy/server.README.md#existing-desktop-profiles) for stopped
profile upgrades and rollback.

## Lifecycle and logs

The native server inherits the existing loopback address, ephemeral port, Tauri
bootstrap/authentication settings, worker token and profile directory. The
worker uses the same server URL, bootstrap identity and retained worker data.
The server's owned stdin pipe closes when its desktop supervisor disappears.
Normal shutdown stops the worker first and requests native shutdown through
that pipe, with bounded signal/termination fallback.

Native stdout and stderr records are captured into the bounded, rotating,
redacted server archive. The server log view and log dump use that archive.
The desktop registers exit and shutdown state before starting either service.

## Local acceptance

Build the service probe with the same shared server target:

```sh
node scripts/server-rust/cargo.mjs build --example desktop_runtime_probe
node scripts/server-rust/desktop-runtime-acceptance.mjs \
  --runtime cantrip_app/src-tauri/resources/runtime \
  --probe /path/to/shared-target/<triple>/debug/examples/desktop_runtime_probe \
  --external-url postgresql://fixture@127.0.0.1:<port>/fixture \
  --report .qa/desktop-native.json
```

The probe imports the production desktop command, environment, readiness and
shutdown helpers. The driver uses the actual packaged worker and genuine client
crypto wrappers, initializes the anonymous owner's encryption profile through
HTTP, and requires a real worker command response. It checks all selected
stores, settings writes, retained server and worker IDs, graceful reaping,
abrupt supervisor loss, and reopening the same data. Omit `--external-url` to
run only PGlite and bundled PostgreSQL; provide a disposable fixture rather than
an inherited database URL. Private client keys and plaintext master keys remain
in the test client.

The macOS release-shell driver executes an actual `.app` built with a dedicated
QA bundle identifier. It observes the server archive, real HTTP operations,
packaged worker responses and the WebView's anonymous-session log. It sends
SIGTERM to the owned app and checks its child processes exit:

```sh
node scripts/server-rust/desktop-bundle-acceptance.mjs \
  --bundle '/path/to/Cantrip Rust QA.app' --report .qa/desktop-bundle.json
node scripts/server-rust/desktop-bundle-acceptance.mjs \
  --bundle '/path/to/Cantrip Rust QA.app' --stop-on-startup \
  --report .qa/desktop-startup-signal.json
```

The release-shell driver also accepts a disposable `--external-url`. Use
`--data-root` to reopen the same initialized fixtures and `--previous-report` to
verify retained server identities and preferences before making another write.
It retains its fixture roots and the QA installation/log directory for evidence capture.
The startup-signal case sends SIGTERM upon the native server's listening event,
before waiting for renderer or worker readiness.

### Earlier server-port qualification

The server-port qualification exercised all three storage modes through the production
launcher probe and the actual release `.app`, using an optimized Rust server,
the then-current Node worker and its matching Codex source build. The real
WebView saved the recovery file, confirmed it and authenticated after reload in
each mode. Temporary UI instrumentation was removed; the normally built app
then reopened those fixtures, verified their original identities and preferences
before writing, executed worker commands, captured server logs and exited
cleanly. The early-startup SIGTERM regression also passes in the normal release
shell. Desktop Rust tests pass 146 cases; the final log-only change passes its
10 focused tests, and the packaging helpers pass 21 Node tests.

An existing Node PGlite directory needs logical conversion: the native server
refused to open a disposable physical copy with a `postgresql.conf` error.
The [profile activation component](RUST_SERVER_PROFILE_ACTIVATION.md) now passes
offline logical conversion, interrupted in-place activation and reversal after
accepted native writes across all three stores. It preserves the original
directory and the active pathname. PR #2752 subsequently bundled automatic
conversion and qualified local existing-client recovery-file continuity,
encrypted identity, actual worker commands and post-write rollback/re-upgrade.
The [worker port ledger](RUST_WORKER_PORT.md#current-runtime) records the native
desktop runtime, later profile round trips, and platform validation limits.
