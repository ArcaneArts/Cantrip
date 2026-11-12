# Signed macOS desktop update rehearsal

## Rebuilt server and desktop shell on macOS ARM64

The release-mode desktop shell from `deefa4204` embeds the `1.1.2881`
server rebuilt from `ff6a4b060` and the existing packaged worker. The
local signed update from `1.1.2869` passed on PGlite, bundled PostgreSQL,
and external PostgreSQL. Each installed app retained its encrypted client
bindings, server and worker identities, database selection and accepted
setting. Each accepted another write and shut down its services cleanly.
The PGlite case rejected a tampered archive before installing the valid
one over loopback HTTPS.

Every installed app passed strict Developer ID verification and matched
all 13,571 files in the rebuilt candidate archive. This rehearsal used a
disposable Tauri updater key. Production notarization remains release
validation.
[Rebuilt macOS signed-update record](security/rust-server-2881-macos-acceptance.json#rebuiltSignedDesktopUpdate)

## Installed app and signed update `1.1.2881`

The native macOS ARM64 server and worker were packaged from
`ccafd3cd4baea444ab43c1b84471ab3225f718e3`. Both service archives were extracted
before the desktop runtime was assembled. The embedded server matched the
standalone executable before signing. All eight worker dependency links
resolved inside the relocated runtime after the original artifact paths were
removed. The standalone package verified all 1,762 file hashes and passed
PGlite, bundled PostgreSQL and external PostgreSQL with Node absent from the
server PATH and Homebrew reads and distribution writes denied.

The release-mode fixture built both clients from the current app source and
updated from the retained `1.1.2869` runtime to `1.1.2881`. It used the
same Developer ID, a disposable Tauri updater key and verified loopback HTTPS.
All three updates retained the selected database, encrypted WebView device
and account bindings, server and worker identities, and an accepted setting.
The updated app accepted another write and the existing worker answered a
command before supervised shutdown. The PGlite case rejected a tampered
archive. Each installed bundle passed strict signature verification and
matched all 13,572 files in the signed candidate archive.

The [macOS acceptance record](security/rust-server-2881-macos-acceptance.json)
lists the archive, executable and report checksums. The signed rehearsal used
fresh isolated profiles and local Developer ID signing. The
[historical round trip](RUST_SERVER_HISTORICAL_PRODUCT_ROLLBACK.md#current-packaged-round-trip)
separately verifies upgrades and post-write rollback from the original Node
profile. Production notarization remains release validation.

## Developer ID update rehearsal `1.1.2831`

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

## Installed app and signed update `1.1.2869`

The normal macOS ARM64 service packager produced both the Rust server and
the Node worker at `1.1.2869` from
`0ae86163efb8503387a2b3d627f9e962d099e1cd`. The desktop packager assembled
those same artifacts with portable Node `24.22.1` and the legacy profile
converter. The standalone server separately verified all 1,762 package files
and passed all three stores with Node absent from its runtime PATH and
Homebrew reads and distribution writes denied.

The release-mode desktop fixture updated the previous `1.1.2845` runtime to
`1.1.2869` with matching Developer ID requirements, a disposable updater key,
and loopback HTTPS. All three installed apps kept the database selection,
server and worker identities, accepted setting, and encrypted WebView device
and account bindings. The worker answered a real command after reconnecting.
The PGlite case rejected an altered archive before installing the valid
candidate. The updated app accepted a new write, and its supervised services
exited cleanly. An independent comparison matched all 13,569 files in each
installation to the signed archive, including the versioned worker entry.

The exact packaged worker and standalone server also passed the forced
Task/Goal input-order scenario in a browser on all three stores. The fixture
controls model responses and makes autonomy attempt an early turn. It
observed the early denial, the original Task receipt binding to the first
explicit input, and a later autonomous turn. The runtime startup logs
reported worker version `1.1.2869` in every case.

The [acceptance record](security/rust-server-2869-production-packages.json)
includes artifact and report checksums. The desktop rehearsal used fresh
baseline profiles and an isolated application identifier. The older
[encrypted profile rehearsal](RUST_SERVER_DESKTOP_ENCRYPTED_ACCEPTANCE.md)
covers original Node installations.

## Current installed app and signed update

The local release-mode macOS ARM64 app updates from `1.1.2831` to
`1.1.2845` on PGlite, bundled PostgreSQL and external PostgreSQL. Both apps
use client source `241e94256fa22a5ab753f900808d15060a1c653f`. The candidate
embeds the verified `1.1.2845` server from
`2e60d2042203f64c8105d5c52d12ae1db92d2d83`, a fresh worker JavaScript build
and portable Node `24.22.1` for the worker. The nine retained worker helper
files match the earlier verified app, and their source has no changes in
this interval.

The production signer applied the same Developer ID to both app versions
and signed 198 embedded Mach-O files per app. The installed app matched the
candidate application and server hashes in all three cases. A separate
archive comparison verified all 13,567 files in each installation. The loopback
HTTPS updater with a disposable signing key rejected a tampered archive,
then installed and relaunched the signed candidate. Each updated WebView
authenticated using its retained device key. The server retained its
identity, database selection and accepted setting. The packaged worker
reconnected with the same identity and answered a real version command.
Each updated app accepted another setting change and shut down its owned
services cleanly.

The `1.1.2831` baseline initialized the profiles during the rehearsal.
The earlier encrypted-profile qualification covers original Node profiles.
[Historical encrypted-profile qualification](RUST_SERVER_DESKTOP_ENCRYPTED_ACCEPTANCE.md)

The current local run used a separate application identifier and test trust
root. The reports and signed archives are retained. The production frontend
build, 40 focused desktop script tests and 13 renderer auth tests passed locally.
[macOS acceptance record](security/rust-server-darwin-arm64-acceptance.json)

## Current standalone package

The optimized macOS ARM64 server `1.1.2845` from
`2e60d2042203f64c8105d5c52d12ae1db92d2d83` passes the relocated distribution
suite on PGlite, bundled PostgreSQL and external PostgreSQL. Each backend
passes migrations, SQL export, retained settings and identity after restart,
hosted reopening and SIGTERM shutdown. The driver verifies all 1,762 files
and the embedded PGlite fallback with Node absent from the server PATH and
Homebrew reads and artifact writes denied. The
[acceptance record](security/rust-server-darwin-arm64-acceptance.json) contains
the new artifact and report checksums.

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
