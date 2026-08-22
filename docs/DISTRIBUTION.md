# Distribution and server connections

Production container, Compose, reverse-proxy, PostgreSQL migration,
backup/restore, TURN, and rolling-upgrade operations are documented in
[Hosted deployment and recovery](HOSTED_DEPLOYMENT.md).

Cantrip produces Server, Worker, Desktop, Android, and iOS release outputs. The
Server and Worker are Node.js deployment trees. Desktop is a native Tauri
bundle containing the frontend plus those same service trees and the Node.js
runtime used to build it. Android produces a signed Capacitor App Bundle for
Google Play and a signed APK for direct testing; both are attached to the
GitHub release. The signed Capacitor iOS archive is uploaded directly to App
Store Connect for TestFlight processing rather than attached publicly.

The two browser-only surfaces are deployed separately through DigitalOcean App
Platform using `.do/app.yaml`. Both static components watch `release` with
automatic deploys enabled, and `pnpm release` also reapplies the committed spec,
waits for the App Platform deployment, and verifies that both components
activated the exact release commit. Host-based ingress serves the marketing
site at `cantrip.art`, the browser application at `app.cantrip.art`, and
redirects the DigitalOcean starter hostname to the marketing site. The
components build from the repository root so pnpm can resolve the shared
workspace packages.
Each component has an explicit browser-only build command; App Platform must
not invoke the root native distribution build, which requires Rust and other
desktop toolchains that are intentionally absent from its Node.js build image.
The `cantrip.art` DigitalOcean DNS zone manages routing explicitly: the apex
uses App Platform's static ingress addresses and `app` is a CNAME to the app's
DigitalOcean starter hostname.

Once the `release` branch exists, update the existing App Platform
configuration with:

```shell
doctl apps spec validate .do/app.yaml
doctl apps update 81fa8bbd-668f-4c1f-848c-7b49442af6b2 \
  --spec .do/app.yaml --update-sources --wait
```

DigitalOcean validates the configured source branch when the specification is
submitted, so the update is rejected until the first `pnpm release` creates
`release`. Updating the spec then builds both components, and subsequent pushes
to `release` trigger them automatically. Custom-domain certificates become
active only after the DNS records requested by App Platform have propagated.

## Build matrix

Run packaging on the target operating system because the Worker contains
native PTY, screen capture, and image modules.

| Command                 | Output                                                            | Host requirement                                      |
| ----------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| `pnpm package:server`   | `artifacts/cantrip-server-<os>-<arch>`                            | No external runtime                                   |
| `pnpm package:worker`   | `artifacts/cantrip-worker-<os>-<arch>`                            | Native build host, Git at runtime                     |
| `pnpm package:services` | Both service trees                                                | Same as above                                         |
| `pnpm package:app`      | Tauri bundles under `cantrip_app/src-tauri/target/release/bundle` | Tauri build prerequisites                             |
| `pnpm bundle`           | All three native artifacts under `artifacts/bundles/<os>-<arch>`  | Current native build host                             |
| `pnpm deploy:server`    | Builds and deploys the current production server                  | Clean synchronized `main`, Docker, Infisical, and SSH |
| `pnpm release`          | Promotes `release`, deploys App Platform, and deploys the Server  | Same as `deploy:server`, plus `doctl` and push access |

Every Worker package must contain the regular entry file
`dist/mcp/stdio.js` and its production MCP SDK dependencies. Standalone Worker
trees also contain `runtime/node` on macOS/Linux or `runtime/node.exe` on
Windows. `package-distributions.mjs` verifies the entry and invokes it with the
bundled runtime, expecting the bounded missing-`--connection` startup error;
this proves that the packaged module graph loads without requiring a live
worker credential or server. Native release CI repeats the check on both
`darwin-arm64` and `win32-x64` before creating the Worker archives. Operators
can repeat it with:

```console
node scripts/verify-packaged-worker-mcp.mjs artifacts/cantrip-worker-<target>
```

`pnpm bundle` performs the complete native build for the current host. It builds
the protocol once, packages Server and Worker concurrently, then builds the
Desktop client from those exact service trees. Final archives and native
installers are collected under `artifacts/bundles/<os>-<arch>/`; it does not
create a GitHub release.

The only GitHub Actions release trigger is a push to `release`; pull requests,
ordinary `main` pushes, and manual dispatches do not run native packaging. The
workflow uses Blacksmith's Apple Silicon macOS 15 and Windows Server 2025 x64
runners for the service and desktop lanes. Server, Worker, Android, and iOS
jobs start in parallel. Desktop jobs then download the exact native service
archives, embed them alongside the runner's Node.js runtime, and build a signed
and notarized macOS DMG or a Windows NSIS installer. Android builds a signed
App Bundle and APK while iOS archives and uploads to TestFlight. A final job
waits for every lane, creates a GitHub release tagged
`v<major>.<minor>.<commit-count>`, and uploads the DMG, NSIS executable, Android
App Bundle and APK, signed Tauri updater artifacts, and both standalone Server
and Worker archives for both platforms.

Release caches are content-addressed and platform-specific. They retain the
verified final Codex runtime bundle and exact-fingerprint Cantrip Code
distribution rather than their very large intermediate build trees. Separate
caches retain pnpm downloads, Cargo dependencies and safe incremental output,
the OpenVSCode npm download cache, its checksum-pinned Node toolchain, and
Codex's checksum-verified rusty_v8 downloads. A source or patch change produces
a new key and the build scripts still validate every restored runtime before
reusing it. Blacksmith transparently serves standard `actions/cache`,
`setup-node`, and Rust cache action traffic from its colocated cache.

Before advancing `release`, install the Blacksmith GitHub App for this
repository so jobs with `blacksmith-*` runner labels can be provisioned. The
first run for each platform is expected to be cold; later releases reuse cache
entries whenever the pinned Codex and Cantrip Code inputs remain unchanged.

### Mobile release lanes

The Android lane uses Java 21 and the checked-in Gradle wrapper after running a
Capacitor sync. CI restores the upload keystore only for the Android build,
fails closed when any signing value is missing, and removes the temporary
keystore even when the job fails. Gradle emits a signed Android App Bundle for
Google Play and a signed APK for direct testing. They are published as
`Cantrip_<version>_android.aab` and `Cantrip_<version>_android.apk` under the
`cantrip-android-release` workflow artifact name.

The Android lane requires these Actions secrets:

- `ANDROID_UPLOAD_KEYSTORE_BASE64`: the base64-encoded upload keystore;
- `ANDROID_UPLOAD_KEYSTORE_PASSWORD`: the keystore password;
- `ANDROID_UPLOAD_KEY_ALIAS`: the upload-key alias; and
- `ANDROID_UPLOAD_KEY_PASSWORD`: the private-key password.

The same recovery values are stored in the production Infisical environment.
The upload key is not the Play-managed app-signing key: Google Play retains the
app-signing key while this key authenticates future bundle uploads. Never add a
keystore, signing password, or decoded secret to the repository.

For the first internal test, create the Play Console app with package ID
`art.cantrip`, enable Play App Signing, and upload the versioned `.aab` from the
GitHub release. Add an internal tester email list or Google Group, publish the
internal release, and share Play Console's opt-in link. Automated Play uploads
are intentionally deferred until the Play app exists and a Google Play service
account has been granted release access; that credential is separate from the
Android upload key configured here. See Google's documentation for
[app signing](https://developer.android.com/studio/publish/app-signing) and
[internal testing](https://support.google.com/googleplay/android-developer/answer/9845334).

The iOS lane synchronizes the Capacitor project, archives the `App` scheme for
the generic iOS destination, and exports with the `upload` destination. The
repository's commit-count build number keeps App Store Connect build numbers
monotonic when releases advance normally. The upload enters Apple's normal
TestFlight processing pipeline; tester-group assignment and external beta
review remain App Store Connect operations.

The iOS job reuses the App Store Connect API key already required for desktop
notarization and additionally requires these Actions secrets:

- `IOS_DEVELOPMENT_CERTIFICATE`: a base64-encoded `.p12` containing an
  **Apple Development** certificate and its private key;
- `IOS_DEVELOPMENT_CERTIFICATE_PASSWORD`: the password used to export that
  development `.p12`;
- `IOS_DISTRIBUTION_CERTIFICATE`: a base64-encoded `.p12` containing an
  **Apple Distribution** certificate and its private key;
- `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`: the password used to export that
  `.p12`;
- `KEYCHAIN_PASSWORD`: the existing arbitrary password for the temporary CI
  keychain;
- `APPSTORE_CONNECT_ISSUER_ID`: the App Store Connect API issuer UUID;
- `APPSTORE_CONNECT_KEY_ID`: the App Store Connect API key ID; and
- `APPSTORE_CONNECT_KEY`: the raw or base64-encoded `.p8` private key.

The Apple Development and Apple Distribution identities must belong to the
same team. Reusing the development identity lets automatic provisioning create
or refresh the app-specific profile without creating a new development
certificate on every ephemeral runner and exhausting Apple's certificate
quota. The Apple Distribution identity is separate from the Developer ID
Application identity used by the macOS desktop lane. CI derives the team ID
from the iOS certificates, uses automatic provisioning authenticated by the
API key, and deletes the temporary keychain and private key even if archiving
or upload fails. The final GitHub release waits for the successful TestFlight
upload and Android artifact, so a published release cannot silently omit either
mobile track.

### macOS distribution

The macOS client job fails closed unless the repository has these Actions
secrets:

- `APPLE_CERTIFICATE`: a base64-encoded `.p12` containing a **Developer ID
  Application** certificate and its private key;
- `APPLE_CERTIFICATE_PASSWORD`: the password used to export that `.p12`;
- `KEYCHAIN_PASSWORD`: an arbitrary strong password used only for the
  job-scoped temporary keychain;
- `APPSTORE_CONNECT_ISSUER_ID`: the App Store Connect API issuer UUID;
- `APPSTORE_CONNECT_KEY_ID`: the App Store Connect API key ID; and
- `APPSTORE_CONNECT_KEY`: the raw or base64-encoded `.p8` private key.

The workflow imports the identity into an ephemeral keychain, signs every
embedded native runtime and the app bundle, submits the app to Apple, staples
its ticket, creates and signs the DMG, then submits and staples the final DMG.
Packaging rejects an ad-hoc or non-Developer-ID identity, unsigned embedded
native code, a missing notarization ticket, or a failed Gatekeeper assessment.
The temporary certificate keychain and notarization key are removed even when
the job fails.

For a signed and notarized local package, install the Developer ID certificate
in the login keychain, find its exact identity, and provide the downloaded API
key directly:

```shell
security find-identity -v -p codesigning
APPLE_SIGNING_IDENTITY='Developer ID Application: Example (TEAMID)' \
  CANTRIP_REQUIRE_MACOS_SIGNING=1 \
  CANTRIP_REQUIRE_MACOS_NOTARIZATION=1 \
  APPLE_API_ISSUER='issuer-uuid' \
  APPLE_API_KEY='EXAMPLE123' \
  APPLE_API_KEY_PATH="$PWD/AuthKey_EXAMPLE123.p8" \
  pnpm package:app --target darwin-arm64
```

Signing does not enable App Sandbox, and the normal installation flow remains
dragging Cantrip from the read-only DMG into `/Applications`.

### Desktop updater signing and recovery

Tauri update signatures are independent from Apple Developer ID and Windows
installer signatures. The public key embedded in `tauri.conf.json` verifies
every downloaded application bundle. Release jobs read the encrypted private
key from `TAURI_SIGNING_PRIVATE_KEY` and its password from
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; packaging fails before building the
desktop bundle when either secret is absent.

The current private-key recovery copy is stored outside the repository at
`~/Library/Application Support/Cantrip/release-signing/cantrip-updater.key`
with mode `0600`. Its password is stored in macOS Keychain under service
`art.cantrip.updater-signing` and account
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Back up the encrypted key and its
password to separate organization-controlled secure stores. Never commit,
attach, log, or paste the private key or password into a pull request.

To restore the repository secrets from the recovery copy without writing the
password to a shell-history argument:

```shell
gh secret set TAURI_SIGNING_PRIVATE_KEY \
  < "$HOME/Library/Application Support/Cantrip/release-signing/cantrip-updater.key"
security find-generic-password \
  -a TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
  -s art.cantrip.updater-signing -w \
  | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Losing this private key prevents every already-installed updater-enabled build
from accepting future updates. Replacing the embedded public key therefore
requires distributing another manual installer; it is not a routine rotation
mechanism.

With updater artifacts enabled, Tauri emits `Cantrip.app.tar.gz` plus its
signature on macOS and reuses the NSIS `*-setup.exe` plus its signature on
Windows. The release job validates that exactly one complete pair exists for
each platform, generates the GitHub release Markdown once, and embeds those
same notes in `latest.json`. It uploads all referenced artifacts before
uploading `latest.json`, and a new release remains a draft until that final
manifest is present. The stable endpoint is:

```text
https://github.com/ArcaneArts/Cantrip/releases/latest/download/latest.json
```

Builds installed before updater support do not contain the public key or native
updater code. Those users must perform one final manual DMG or NSIS installation
of an updater-enabled release before the in-app update flow can be used.

From a clean, synchronized `main` checkout, start that workflow with:

```shell
pnpm release
```

The command first runs `git pull --ff-only origin main`, requires local `main`
to equal `origin/main`, verifies that `origin/release` can fast-forward, and
then pushes `main` to `release`. It refuses dirty trees, non-`main` branches,
unpushed main commits, and divergent release history. The branch push triggers
the native client release workflow. The release command then validates and
applies `.do/app.yaml` with authenticated `doctl`, waits for App Platform, and
requires both the `app` and `site` components to activate the exact promoted
commit. Finally, it cross-builds the Linux x64 Server with Docker Buildx, loads
the production environment from Infisical on the release machine, and deploys
that same commit to the configured production host. Use `pnpm deploy:server`
to retry only the server deployment without advancing `release`.

Neither command gives the production host access to Infisical. The release
machine writes an allowlisted service environment over SSH, excluding the SSH
deployment key and any other non-server secret, and removes its temporary key
and bundle after the attempt. See [Hosted deployment and recovery](HOSTED_DEPLOYMENT.md#production-droplet-release)
for prerequisites, host paths, and service operations.

All lower-level packaging commands accept the native target explicitly, for example
`pnpm package:worker --target darwin-arm64` or
`pnpm package:app --target darwin-arm64`. Cross-compilation is rejected because
both the Worker and Cantrip Code contain native modules. `macos-*` and
`windows-*` are accepted aliases for the runtime target names `darwin-*` and
`win32-*`.

The Server and Worker archives each include the platform-matched Node runtime
used to build their native dependencies. Their startup scripts invoke only that
packaged executable, so a separate host Node installation is not required.
Desktop removes those duplicate per-service runtimes while staging and uses its
single shared bundled Node executable instead.

Worker packages contain `resources/cantrip-code/`, including the compiled
browser-native editor, its bundled Node runtime, legal notices, and a
content-hashed compatibility manifest. The manifest also pins the bundled
`cantrip-workbench` extension version, and worker startup verifies that exact
extension package before launching the editor. Packaging invokes `pnpm code:build`
when the exact target/input fingerprint is not cached. It never downloads or
updates the editor after the artifact is assembled. Desktop embeds the same
worker tree, so the standalone Worker and local-only desktop use an identical
editor compatibility unit.

Local editor builds bootstrap and checksum the Node release recorded in
`cantrip_code/upstream/.nvmrc`; it is a build-only toolchain independent from
the Node process running Cantrip. Builds still require the platform's native VS
Code prerequisites, npm, Git, and network access for the pinned dependency
graph and Node toolchain. Generated source, dependencies, toolchains, caches,
and distributions remain ignored.

Cantrip Code artifacts are cached in the repository's shared
`.cantrip-code/cache` directory across Git worktrees. Set
`CANTRIP_CODE_CACHE_DIR` when a build host should use another cache volume.

## Standalone server

Copy the packaged `.env.example` to `.env`. The startup scripts use Node's
`--env-file-if-exists` support. Important variables are:

- `CANTRIP_SERVER_HOST` and `CANTRIP_SERVER_PORT`: listening address.
- `CANTRIP_CODE_SURFACE_HOST` and `CANTRIP_CODE_SURFACE_PORT`: the isolated
  editor-surface listener. It must not share the application API origin.
- `CANTRIP_CODE_SURFACE_ORIGIN`: the public HTTP(S) origin browsers use for
  short-lived Code attachments. Hosted reverse proxies should route this
  separate origin to the Code surface listener without exposing worker ports.
- `CANTRIP_DATA_DIR`: PGlite data and durable server state.
- `DATABASE_URL`: PostgreSQL connection replacing PGlite; required in hosted
  mode.
- `CANTRIP_PUBLIC_ORIGIN`: canonical HTTPS application API origin; required in
  hosted mode.
- `CANTRIP_APP_ORIGINS`: comma-separated browser/Tauri origins allowed by CORS.
- `CANTRIP_TRUSTED_PROXIES`: bounded IP/CIDR or named private-range list whose
  peers may supply validated `X-Forwarded-*` headers. Hosted mode requires it.
- `CANTRIP_DEPLOYMENT_MODE` and `CANTRIP_BOOTSTRAP_MODE`: values announced by
  `/api/bootstrap`.
- `CANTRIP_AUTH_MODE`: `none` for loopback, `password` for one protected owner,
  or `accounts` for account sessions.
- `CANTRIP_PASSWORD_HASH`: required Argon2id encoded hash for `password` mode.
- `CANTRIP_ADMIN_EMAIL`: the licensed administrator identity. The first account
  created with this email becomes the server owner; later matching registration
  becomes an administrator.
- `CANTRIP_LICENSE_WHITELIST_ENABLED`: gates account registration to the
  administrator email and durable server whitelist. It defaults to `true`;
  setting it to `false` permits open account registration.
- `CANTRIP_SESSION_TTL_SECONDS` and `CANTRIP_AUTH_RATE_LIMIT`:
  account/session policy. `CANTRIP_ADMIN_BOOTSTRAP_TOKEN` and
  `CANTRIP_PUBLIC_REGISTRATION` remain compatible with older programmatic
  configurations that do not set the whitelist policy.
- `CANTRIP_COOKIE_SECURE` and `CANTRIP_COOKIE_SAME_SITE`: hosted cookie policy;
  hosted mode defaults to `Secure` plus `SameSite=None` so approved web,
  Tauri, and Capacitor origins can share the server-owned session. Same-origin
  deployments may explicitly choose `lax` or `strict`.
- `CANTRIP_API_BODY_LIMIT_BYTES`, `CANTRIP_UPLOAD_LIMIT_BYTES`, and
  `CANTRIP_WEBSOCKET_MAX_PAYLOAD_BYTES`: independent public transport ceilings.
- `CANTRIP_API_RATE_LIMIT_PER_MINUTE`,
  `CANTRIP_PAIRING_RATE_LIMIT_PER_MINUTE`,
  `CANTRIP_UPLOAD_RATE_LIMIT_PER_MINUTE`, and
  `CANTRIP_WEBSOCKET_HANDSHAKE_RATE_PER_MINUTE`: independent in-process request
  buckets. In a multi-instance deployment, each replica receives a conservative
  partition of the configured global budget.
- `CANTRIP_ACCOUNT_UPLOAD_CONCURRENCY`,
  `CANTRIP_ACCOUNT_WEBSOCKET_LIMIT`,
  `CANTRIP_ACCOUNT_REMOTE_SURFACE_LIMIT`,
  `CANTRIP_WORKER_REMOTE_SURFACE_LIMIT`,
  `CANTRIP_ACCOUNT_COMMAND_CONCURRENCY`, and
  `CANTRIP_WORKER_COMMAND_CONCURRENCY`: active relay ceilings. Account and
  worker command rate variables provide a second backpressure boundary without
  adding a short timeout to long-running agent work.
- `CANTRIP_ACCOUNT_UPLOAD_BYTES_PER_MINUTE`,
  `CANTRIP_WORKER_UPLOAD_BYTES_PER_MINUTE`,
  `CANTRIP_ACCOUNT_RELAY_BYTES_PER_MINUTE`, and
  `CANTRIP_WORKER_RELAY_BYTES_PER_MINUTE`: process-local byte budgets for
  attachments and worker relay traffic. The configured global budgets are
  divided by the hard replica ceiling when Redis coordination is enabled.
- `CANTRIP_METRICS_TOKEN`: optional 32+ character operator bearer token for
  aggregate Prometheus metrics. Owner/admin sessions can also read metrics.
- `REDIS_URL`: optional shared coordination endpoint. When present, server
  replicas exchange worker presence, commands, binary relay frames,
  notifications, disconnects, and live invalidations through Redis.
- `CANTRIP_SERVER_INSTANCE_ID`, `CANTRIP_COORDINATION_PRESENCE_TTL_MS`, and
  `CANTRIP_COORDINATION_MAX_INSTANCES`: instance identity, lease duration, and
  hard replica ceiling. Global traffic limits are divided by the ceiling and
  readiness rejects excess replicas.

Hosted mode never permits anonymous authentication, including when
`CANTRIP_ALLOW_INSECURE_REMOTE=true`. It also refuses missing encryption keys,
PGlite, implicit or wildcard client origins, insecure public/Code origins, and
an absent or invalid trusted-proxy list. Password and account modes use
revocable server-side sessions, tenant authorization, and per-worker
enrollment. Account/worker quotas, audit visibility, operational probes,
Prometheus metrics, and production deployment assets are implemented. Public
horizontal hosting uses the Redis coordination layer. Scheduled workflow and
project automation occurrences use durable database claims with instance-bound
lease tokens and monotonically increasing fencing tokens. Expired claims can be
recovered by another replica without allowing the stale holder to finalize the
occurrence. `CANTRIP_SCHEDULER_LEASE_TTL_MS` controls the recovery interval.
The encryption keyring protects provider API keys plus MCP environment and
static-header values. MCP configuration responses contain fixed masks rather
than plaintext; preserve old keyring entries until startup has rewrapped every
stored envelope with the selected active key.
The Code surface exposes only a health endpoint and capability-scoped bearer
attachments; it does not expose application APIs or accept Cantrip cookies.

## Standalone worker

When the Worker will run on the same desktop as the Cantrip app, select the
hosted server in that app and use Settings → Workers → **Add this machine**.
The signed-in app creates and consumes the one-time enrollment internally,
persists only the resulting worker credential in the worker's protected data
directory, and can enable launch-at-login. The app starts hidden in the system
tray after login; closing the main window does not stop its linked workers.

For headless hosts or machines without the desktop app, the manual flow remains
available:

The worker makes an outbound connection to `CANTRIP_SERVER_URL`. Generate a
short-lived link code from Settings → Workers as a signed-in user, copy the
generated POSIX or PowerShell pairing command, and set the code once as
`CANTRIP_WORKER_ENROLLMENT_CODE`, and configure a display name plus durable
`CANTRIP_WORKER_DATA_DIR`. The worker creates a stable local identity, exchanges
the single-use code, and stores its unique credential in
`worker-credential.json` with owner-only filesystem permissions. Remove the
link code from the environment after the first successful start. Immutable
deployments may inject `CANTRIP_WORKER_CREDENTIAL` with its bound
`CANTRIP_WORKER_ID` from a secret manager instead.

The artifact contains the exact Codex CLI compiled from `cantrip_codex/` for
its operating system and architecture. GitHub CLI, repository files,
credentials, terminals, browsers, and worktrees remain on the worker machine.
The legacy shared worker token is accepted only by anonymous loopback
`pnpm-dev` and embedded Tauri bootstraps.

Remote workers are managed from the same settings page. Renaming is stored as
a server-side display alias, credential rotation updates an online packaged
worker before reconnecting, and an offline rotation shows the replacement only
once for manual installation. Unlinking revokes all active credentials while
retaining server-owned project and conversation metadata. Pairing the same
worker identity again restores those associations. Internal desktop/dev
workers are labeled and cannot be renamed or unlinked.

`CANTRIP_CODE_IDLE_TIMEOUT_MS` controls how long an unattached Code session
keeps its editor process warm (30 minutes by default). Active tunnel streams,
agent/editor coordination, and explicit Code operations refresh activity. A
restarted worker restores compatible session identities from its data directory
without launching them until the server authorizes a new attachment. A packaged
worker also guards every editor process group, so an abruptly terminated worker
cannot leave editor, extension-host, watcher, or terminal processes behind.
Codex app-server, authentication, discovery, and import subprocesses use the
same owner-death guard, preventing abandoned Codex servers when a worker or the
desktop shell terminates unexpectedly.

## Packaged desktop lifecycle

Release builds reserve a free loopback port, start the bundled Server, wait for
it to accept connections, then start the bundled Worker. Both preserve the GUI
launch environment. On macOS, Cantrip also augments `PATH` with standard system,
Homebrew, MacPorts, and common per-user tool directories because Finder does
not run interactive shell startup files. This keeps worker-local Git, `gh`,
Ollama, package managers, and browser discovery available without executing
`.zshrc` as application startup code. Codex comes from the bundled Worker
rather than the user's `PATH`.
Logs and data are written below Tauri's application data directory. The app
keeps its services alive when the main window is hidden and terminates them
only when Cantrip actually quits. A single-instance guard reopens the existing
background process instead of starting a duplicate stack.
`CANTRIP_DESKTOP_DATA_DIR` can override that root for portable installations or
packaging smoke tests.

`pnpm devtop` deliberately does not start a second embedded stack. The Rust
shell points its Local profile at the externally orchestrated development
server so TypeScript watchers and Vite hot reload remain fast.

Both `pnpm dev` and `pnpm devtop` ensure the fingerprinted Cantrip Code build is
available. A matching cache is reused immediately; after cloning or whenever
the pinned editor, patchset, product configuration, extension source, or native
target changes, development startup builds the new distribution automatically.
`pnpm code:ready` remains available as a strict verification-only command.

## Switching servers

Click the account area beside the Settings gear to list server profiles. The
built-in Local profile cannot be removed. **Add server** accepts a name and an
HTTP(S) origin, can test its bootstrap response, and saves it before switching.
Switching reloads the frontend so queries, terminal sockets, Browser/Remote
Desktop streams, and subsequent mutations all use the same server.

Profiles are stored locally by the client because the active server must be
known before server-owned settings can load. The browser keeps redundant
local-storage and IndexedDB copies, requests persistent site storage after an
explicit profile change, and reconciles newer changes made by another tab.
Profiles contain only names and origins. Per-server account credentials and
multi-account behavior are a separate follow-up milestone.
