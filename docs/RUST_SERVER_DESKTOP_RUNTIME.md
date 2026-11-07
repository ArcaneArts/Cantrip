# Packaged desktop Rust server

The desktop supervisor can launch the native server distribution directly while
continuing to run the existing Node worker. Runtime selection is explicit build
configuration. The default remains Node during existing-installation migration
and full replacement qualification.

## Package a native candidate

Build on the target platform, using an isolated QA installation/profile:

```sh
CARGO_TARGET_DIR=/path/to/shared-target CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 \
  pnpm package:desktop-runtime --server-runtime rust \
  --postgres-bin /path/to/postgresql18/bin
```

This builds the existing worker and its native helpers, packages the Rust server
with matching database assets, and retains Node for the worker. The Codex build
honors an explicit `CARGO_TARGET_DIR` so worktrees can reuse its existing cache.
The server target and the separately pinned Codex toolchain can reuse their
respective shared caches without producing per-worktree target directories.

To assemble previously built artifacts on that platform:

```sh
pnpm package:desktop-runtime --target darwin-arm64 \
  --server-runtime rust --from-artifacts
```

The inputs are `artifacts/cantrip-server-rust-<target>` and the existing
`artifacts/cantrip-worker-<target>`. Native server launchers, PGlite assets,
PostgreSQL layout and shared libraries remain intact. The worker retains its
existing workspace-import and actual native CUA/image smoke checks. Desktop
native resource copies retain executable/read bits and gain owner-write
permission, allowing Tauri to copy resources over its previous staging tree
when rebuilding. Runtime read-only mounts and sandboxes still apply.

`runtime/server/desktop-server.json` selects the native executable and records
the distribution's PostgreSQL binary location. The shell passes bundled asset
fallbacks to the executable; explicit environment and saved database selection
retain their native-server precedence. No executable-presence probe selects a
different server after a configured native launch fails.

Existing distributions without that configuration retain their Node launcher.
Native selection does not activate a legacy database conversion. Use a fresh
QA profile or an explicitly migrated copy until the existing-installation
upgrade/rollback milestone is qualified; do not use this build option to claim
production cutover readiness.

## Lifecycle and logs

The native server inherits the existing loopback address, ephemeral port, Tauri
bootstrap/authentication settings, worker token and profile directory. The
worker uses the same server URL, bootstrap identity and retained worker data.
The server's owned stdin pipe closes when its desktop supervisor disappears.
Normal shutdown stops the worker first and requests native shutdown through
that pipe, with bounded signal/termination fallback.

Native stdout/stderr records are captured into the existing bounded, rotating,
redacted server archive. The server log view and log dump use that archive;
the existing Node server continues to own its own archive. The desktop's exit
and shutdown state is registered before setup starts, so SIGTERM during service
startup does not access unregistered state.

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

Local macOS arm64 evidence includes all three storage modes through the production
launcher probe and the actual release `.app`, using an optimized Rust server,
the existing Node worker and its matching current Codex source build. The real
WebView saved the recovery file, confirmed it and authenticated after reload in
each mode. Temporary UI instrumentation was removed; the normally built app
then reopened those fixtures, verified their original identities and preferences
before writing, executed worker commands, captured server logs and exited
cleanly. The early-startup SIGTERM regression also passes in the normal release
shell. Desktop Rust tests pass 146 cases; the final log-only change passes its
10 focused tests, and the packaging helpers pass 21 Node tests.

An actual Node-created PGlite profile is not yet an accepted native upgrade.
The native server refused to open its disposable physical copy with a
`postgresql.conf` error. The original remained byte-preserved, and Node reopened
the attempted copy with the same identity and preferences. This verifies failure
safety, not successful conversion or rollback after native writes. Keep the
existing default until a data-preserving conversion and reverse path pass.

Windows, other supported platforms, installer/update behavior, existing-user
migration and post-write rollback, full product/coordination/performance
acceptance and default cutover remain required. The broad repository check
still stops at unchanged Node source line limits; it is not green. All development
checks run locally; no production deployment is performed by these drivers.
