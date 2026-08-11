# Distribution and server connections

Cantrip produces three independent artifacts: Server, Worker, and Desktop. The
Server and Worker are Node.js deployment trees. Desktop is a native Tauri
bundle containing the frontend plus those same service trees and the Node.js
runtime used to build it.

## Build matrix

Run packaging on the target operating system because the Worker contains
native PTY, screen capture, and image modules.

| Command                 | Output                                                            | Host requirement                       |
| ----------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `pnpm package:server`   | `artifacts/cantrip-server-<os>-<arch>`                            | No external runtime                    |
| `pnpm package:worker`   | `artifacts/cantrip-worker-<os>-<arch>`                            | Native build host, Git at runtime      |
| `pnpm package:services` | Both service trees                                                | Same as above                          |
| `pnpm package:app`      | Tauri bundles under `cantrip_app/src-tauri/target/release/bundle` | Tauri build prerequisites              |
| `pnpm bundle`           | All three native artifacts under `artifacts/bundles/<os>-<arch>`  | Current native build host              |
| `pnpm release`          | Fast-forwards `release` to synchronized `main`                    | Clean `main` checkout with push access |

`pnpm bundle` performs the complete native build for the current host. It builds
the protocol once, packages Server and Worker concurrently, then builds the
Desktop client from those exact service trees. Final archives and native
installers are collected under `artifacts/bundles/<os>-<arch>/`; it does not
create a GitHub release.

The release workflow is intentionally limited to macOS ARM64 (`macos-14`) and
Windows x64 (`windows-2025`). Its Server and Worker jobs run in parallel. The
Client job downloads those native service archives, embeds them alongside the
runner's Node.js runtime, builds the Tauri client, and publishes the resulting
client bundle. A final job creates a GitHub release tagged
`release-<full-commit-sha>` and uploads every service/client artifact.

From a clean, synchronized `main` checkout, start that workflow with:

```shell
pnpm release
```

The command first runs `git pull --ff-only origin main`, requires local `main`
to equal `origin/main`, verifies that `origin/release` can fast-forward, and
then pushes `main` to `release`. It refuses dirty trees, non-`main` branches,
unpushed main commits, and divergent release history. It does not build or
publish anything locally; the `release` branch push is the workflow trigger.

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
- `DATABASE_URL`: optional PostgreSQL connection replacing PGlite.
- `CANTRIP_WORKER_TOKEN`: shared secret for worker connections.
- `CANTRIP_APP_ORIGINS`: comma-separated browser/Tauri origins allowed by CORS.
- `CANTRIP_DEPLOYMENT_MODE` and `CANTRIP_BOOTSTRAP_MODE`: values announced by
  `/api/bootstrap`.

Account authentication is not implemented. A hosted mode or non-loopback bind
therefore requires `CANTRIP_ALLOW_INSECURE_REMOTE=true`, which only disables a
safety check. It does not authenticate requests. Keep the server on a trusted
network or put an authenticating TLS reverse proxy in front of it.
The Code surface exposes only a health endpoint and capability-scoped bearer
attachments; it does not expose application APIs or accept Cantrip cookies.

## Standalone worker

The worker makes an outbound connection to `CANTRIP_SERVER_URL`. Configure the
same `CANTRIP_WORKER_TOKEN` as the server, a stable `CANTRIP_WORKER_ID`, a
display name, and a durable `CANTRIP_WORKER_DATA_DIR`. The artifact contains the
exact Codex CLI compiled from `cantrip_codex/` for its operating system and
architecture. GitHub CLI, repository files, credentials, terminals, browsers,
and worktrees remain on the worker machine.

`CANTRIP_CODE_IDLE_TIMEOUT_MS` controls how long an unattached Code session
keeps its editor process warm (30 minutes by default). Active tunnel streams,
agent/editor coordination, and explicit Code operations refresh activity. A
restarted worker restores compatible session identities from its data directory
without launching them until the server authorizes a new attachment. A packaged
worker also guards every editor process group, so an abruptly terminated worker
cannot leave editor, extension-host, watcher, or terminal processes behind.

## Packaged desktop lifecycle

Release builds reserve a free loopback port, start the bundled Server, wait for
it to accept connections, then start the bundled Worker. Both inherit the
user's environment so worker-local Git, Ollama, and browser discovery continue
to work. Codex comes from the bundled Worker rather than the user's `PATH`.
Logs and data are written below Tauri's application data directory. Both child
processes are terminated when the desktop app exits.
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
known before server-owned settings can load. They currently store only names
and origins. Per-server account credentials and multi-account behavior are a
separate follow-up milestone.
