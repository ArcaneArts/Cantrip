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
| `pnpm package:server`   | `artifacts/cantrip-server-<os>-<arch>`                            | Node.js 22+ at runtime                 |
| `pnpm package:worker`   | `artifacts/cantrip-worker-<os>-<arch>`                            | Node.js 22+, Codex CLI, Git at runtime |
| `pnpm package:services` | Both service trees                                                | Same as above                          |
| `pnpm package:app`      | Tauri bundles under `cantrip_app/src-tauri/target/release/bundle` | Tauri build prerequisites              |

The manual/tag-triggered GitHub Actions workflow runs both packaging jobs on
macOS, Linux, and Windows and uploads Server, Worker, and Desktop separately.

## Standalone server

Copy the packaged `.env.example` to `.env`. The startup scripts use Node's
`--env-file-if-exists` support. Important variables are:

- `CANTRIP_SERVER_HOST` and `CANTRIP_SERVER_PORT`: listening address.
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

## Standalone worker

The worker makes an outbound connection to `CANTRIP_SERVER_URL`. Configure the
same `CANTRIP_WORKER_TOKEN` as the server, a stable `CANTRIP_WORKER_ID`, a
display name, and a durable `CANTRIP_WORKER_DATA_DIR`. GitHub CLI, Codex CLI,
repository files, credentials, terminals, browsers, and worktrees remain on
the worker machine.

## Packaged desktop lifecycle

Release builds reserve a free loopback port, start the bundled Server, wait for
it to accept connections, then start the bundled Worker. Both inherit the
user's environment so worker-local Git, Codex, Ollama, and browser discovery
continue to work. Logs and data are written below Tauri's application data
directory. Both child processes are terminated when the desktop app exits.
`CANTRIP_DESKTOP_DATA_DIR` can override that root for portable installations or
packaging smoke tests.

`pnpm devtop` deliberately does not start a second embedded stack. The Rust
shell points its Local profile at the externally orchestrated development
server so TypeScript watchers and Vite hot reload remain fast.

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
