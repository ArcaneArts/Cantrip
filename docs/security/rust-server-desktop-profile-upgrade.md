# Automatic desktop profile upgrade qualification

Local qualification on 2026-11-07 used macOS ARM64, Node 24.22.1 for the unchanged
worker and bounded converter, the actual legacy Node distribution with PGlite
PostgreSQL 18.3, native PGlite 17.5, and bundled PostgreSQL 18.6. The ordinary
release desktop shell used a dedicated QA identifier and the same Developer ID
identity as its initialized Node fixture. Production Winterhold was not contacted.

The delivered preparation command takes a stopped existing profile, recovers any
pending activation, and actually opens/migrates a private copy. Only a native
engine-open failure starts bounded legacy conversion. The prepared replacement
is published under the same exclusive profile lease; the original directory is
retained. A fresh installation proceeds to ordinary native initialization.

## Executed evidence

- Eight cases passed against the optimized executable: actual missing-converter
  spawn failure preserves the original; production desktop conversion and restart
  after deleting the converter; reverse conversion with later Rust writes observed
  by the real Node distribution; fresh/unmarked native operation without Node;
  explicit native selection despite irrelevant malformed saved metadata; an
  actual committed migration-journal fault never invokes the legacy converter;
  a missing completed profile never becomes an empty installation; and SIGKILL
  of preparation reaps its witnessed native owner and Node converter.
- The production launcher exercised all three database modes with the real
  unchanged worker, settings writes/restarts, graceful exit, supervisor loss,
  child reaping, and recovery. The external PostgreSQL process was disposable
  and used the packaged PostgreSQL tools.
- A real Node desktop installation saved its recovery file, confirmed the
  recovery screen, reloaded, and authenticated. The ordinary Rust release shell
  opened that installation, kept its identity and recovery file, completed a real
  worker version command, accepted writes, and restarted. Latest data was then
  logically converted back to the old Node package, which observed the Rust
  write before accepting another write. The final Rust package converted that
  Node profile again successfully.
- Across the actual desktop cycle, the opaque encryption-profile response and
  recovery-file bytes matched exactly. Client `session.refresh.completed` with
  `authenticated` was checked after encryption preparation: the application
  emits that state only when `prepareClientEncryption` returns `ready`.
- The initial original profile's 1,774 files and the final pre-upgrade Node
  profile's 1,777 files were independently byte-verified in retained backups.
- SIGTERM during a witnessed app → native preparation → native owner → Node
  converter tree exited the app with code 0, reaped all witnessed children,
  and retained all 1,777 active legacy-profile files unchanged.
- Nineteen focused Rust tests, strict all-target Clippy, frozen offline workspace
  installation, frontend build, packaging tests, formatting, and workflow-removal
  validation passed. `pnpm check` stopped on unchanged Node decomposition limits:
  `build-app.ts` at 1532/1500 and `chat-turn-runtime.ts` at 2336/1999. Later stages
  of that aggregate command were not run by that invocation.

A window-specific screenshot attempt failed with `could not create image from
window`. The failed capture is retained separately; it is not visual acceptance.
Functional client encryption readiness was checked through the existing client
telemetry and its source contract.

## Reproduction entry points

Use `desktop-profile-upgrade-compatibility.mjs` with `--native-server`,
`--failure-fixture` (the test-only `profile_upgrade_fixture` example), `--probe`
(the `desktop_runtime_probe` example), `--native-assets`, `--converter`,
`--legacy-server`, `--legacy-profile`, and `--report`. Inputs must be disposable
copies and stopped profiles. Use `desktop-runtime-acceptance.mjs` with the packaged
runtime, production launcher probe, and an isolated external PostgreSQL URL for
the three-mode service matrix.

The dedicated desktop QA session retains its actual recovery-flow harness,
process logs, source-file hashes, cancellation witness, logical export/import
receipts, and client encryption-readiness records. The delivery receipt in the
active goal's external evidence directory locates the byte-verified archive.
Do not print recovery-file or Keychain material when inspecting those artifacts.

This milestone preserves the current default runtime while adding opt-in Rust
app packaging and automatic existing-profile upgrade. It does not establish
Linux/Windows, full product/performance coverage, representative Winterhold
readiness, production Node removal, or completion of the full replacement goal.
