# Signed macOS desktop update rehearsal

The rehearsal builds two release-mode Tauri apps using the current client
source. The baseline app bundles the retained server and worker runtime from
the encrypted desktop qualification. The candidate bundles the current Rust
server and the existing packaged worker. Both use the dedicated
`art.cantrip.rust-qa-recovery` installation and its existing device keys.
Each case copies a stopped QA profile before launching.

The fixture builds and signs the standard Tauri updater archive. It supplies
a disposable signing key, a loopback HTTPS manifest and a trusted local
certificate authority in the copied app source. An authenticated loopback
controller invokes the existing updater commands from the release WebView.
The updater performs its normal download, signature verification, renderer
checkpoint, service shutdown, app installation and restart.

## Observed local results

The standalone macOS ARM64 distribution `1.1.2817` passes all three stores,
including local and hosted reopening, migrations, SQL export, retained
identity, shutdown and embedded runtime fallback. All 1,762 files were
verified. The server ran with Node absent from its PATH and with access to
Homebrew and writes to the installed distribution denied.

The actual signed update from `1.1.2786` to `1.1.2817` on PGlite rejected the
altered app archive with `update_signature_invalid`. The old app and its children
remained running. The valid archive passed HTTPS and signature verification,
stopped the owned server and worker, replaced the app and launched the
candidate. An independent reopen verified the installed hashes, original
server and worker identities, and the preference written before the update.
The public client catalog retained the installation, device and account records.

The updated ad-hoc app received a separate macOS Keychain prompt, and access
was denied. Its renderer reported `key-store-unavailable`. The PGlite encrypted
restart and signed updates for bundled and external PostgreSQL remain pending.
The harness retains the encrypted-session assertion. The earlier full desktop
upgrade and restart across all three stores has separate evidence.

The [acceptance record](security/rust-server-darwin-arm64-acceptance.json)
identifies the current distribution, signed package, source and reports.
Twenty-five local updater, packaging and installation tests passed.

## Reproduce locally

Build the application dependencies and current server. Assemble the desktop
runtime with the existing verified worker artifact.

```sh
pnpm --filter '@cantrip/app^...' -r build
pnpm package:server
pnpm package:desktop-runtime --from-artifacts
node scripts/server-rust/native-desktop-updater-acceptance.mjs \
  --previous-bundle '/absolute/path/to/Cantrip Server Shipping QA.app' \
  --current-runtime cantrip_app/src-tauri/resources/runtime \
  --profiles /absolute/path/to/stopped-qa-profile-copies \
  --external-profile /absolute/path/to/stopped-external-postgres-data \
  --previous-report /absolute/path/to/previous-desktop-restart.json \
  --data-root /absolute/path/to/new-evidence-directory \
  --report /absolute/path/to/new-evidence-directory/report.json
```

Use the profiles, worker artifact and installation catalog identified by the
[existing-client encrypted desktop qualification](RUST_SERVER_DESKTOP_ENCRYPTED_ACCEPTANCE.md).
The driver compares the recovered client catalog with its initial copy,
retains app and server hashes, and captures the actual worker command, log
records and process shutdowns. Keep the evidence locally with the QA profile
copies and archive signatures.
