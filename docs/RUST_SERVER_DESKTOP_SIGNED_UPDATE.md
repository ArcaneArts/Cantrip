# Signed macOS desktop update rehearsal

The local Developer ID rehearsal updates release-mode Tauri apps from
`1.1.2786` to `1.1.2831` on macOS ARM64. Both apps use the current client
source. The baseline bundles the retained runtime from the encrypted desktop
qualification. The candidate bundles the current Rust server and the existing
worker, with the portable Node `24.22.1` executable used by the baseline.

Both apps and all 198 embedded Mach-O files in each app are signed with the
same Developer ID using the production runtime signer. The fixture uses a
disposable Tauri updater key, a loopback HTTPS manifest and a test certificate
authority. The release WebView invokes the existing updater commands through
the authenticated local test controller.

## Developer ID update results

All three database modes passed. For each mode, the previous app created a
disposable profile and completed the normal anonymous recovery screen. The
driver saved the generated recovery file under the case directory and verified
an authenticated encrypted session after reloading the WebView. It accepted a
preference write and ran a version command through the real worker before
installing the update.

The PGlite case rejected an altered archive with `update_signature_invalid`
while the old app and its services remained running. Each valid archive
passed HTTPS and signature verification, shut down the old server and worker,
and restarted the installed app. The updated WebView authenticated with the
same device key. The server retained its identity and accepted preference,
the worker reconnected and executed its version command, and the app accepted
another write. The public catalog retained the installation, device key,
account bindings and migration records in each case.

The driver verified PGlite 17 and private PostgreSQL 18 through readiness and
the actual profile database files before and after the update. A direct
`pg_stat_activity` query witnessed a live Cantrip connection to the external
cluster before and after that update. All three installed apps matched the
candidate executable hashes and retained the same macOS designated signing
requirement. All test services exited cleanly.

The [acceptance record](security/rust-server-darwin-arm64-acceptance.json)
records the exact signed archive, executables, source and reports. Thirty-four
local updater, packaging and catalog tests and 41 first-run encryption tests
passed. This rehearsal used local Developer ID signing. Release notarization
and Windows installer acceptance remain separate.

## Earlier results

The `1.1.2817` standalone distribution passed all three stores, migrations,
SQL export, retained restart and graceful shutdown. All 1,762 packaged files
were verified with Homebrew reads and distribution writes denied. The
[database lifecycle qualification](RUST_SERVER_DATABASE_LIFECYCLE.md#embedded-pglite-cache-recovery)
also passed the newer `1.1.2831` standalone package.

An earlier ad-hoc PGlite update installed successfully, then macOS denied the
new binary access to its retained Keychain item. The same-Developer-ID test
above reopened the encrypted session in all three modes. The
[existing-client upgrade and restart qualification](RUST_SERVER_DESKTOP_ENCRYPTED_ACCEPTANCE.md)
retains the independent results for older populated profiles.

## Reproduce locally

Build the application dependencies and current server. Assemble the desktop
runtime with the existing verified worker artifact and a portable macOS
Node executable. The packager copies the Node executable that runs it. A
local Homebrew build tried to load an unbundled `libnode.137.dylib` when the
updated app launched its worker.

```sh
pnpm --filter '@cantrip/app^...' -r build
pnpm package:server
/absolute/path/to/portable-node scripts/package-distributions.mjs desktop-runtime --from-artifacts
node scripts/server-rust/native-desktop-updater-acceptance.mjs \
  --previous-bundle '/absolute/path/to/Cantrip Server Shipping QA.app' \
  --current-runtime cantrip_app/src-tauri/resources/runtime \
  --signing-identity 'Developer ID Application: Your signing identity' \
  --data-root /absolute/path/to/new-evidence-directory \
  --report /absolute/path/to/new-evidence-directory/report.json
```

By default the driver creates an isolated app installation and fresh baseline
profiles. The optional `--profiles`, `--external-profile` and
`--previous-report` arguments together select the historical fixtures from
the [existing-client encrypted desktop qualification](RUST_SERVER_DESKTOP_ENCRYPTED_ACCEPTANCE.md).
