# Cantrip

Cantrip is a self-hostable, multi-device coding-agent client powered by the open-source Codex CLI.

## Workspace

- `cantrip_app` — Vite, React, Tailwind, and shadcn/ui; Tauri and Capacitor stubs are included.
- `cantrip_server` — Node.js API and durable state using PGlite locally or PostgreSQL through `DATABASE_URL`.
- `cantrip_worker` — Node.js machine agent that will supervise Codex and own files and terminals.
- `packages/protocol` — runtime-validated contracts shared by all three apps.

See [docs/PLAN.md](docs/PLAN.md) for the architecture and phased roadmap.

## Develop

Requirements: Node.js 22 or newer and pnpm.

```shell
pnpm install
pnpm dev
```

The app is available at <http://127.0.0.1:5173> and the server at <http://127.0.0.1:4310>. Embedded PGlite data is stored under `.cantrip/dev/`. Press Ctrl+C once to stop every process started by the root command.

The current server announces local deployment, anonymous/no-auth identity, server-only worker routing, and split storage through `GET /api/bootstrap`. Worker presence, projects, chats, and conversation messages are persisted in PGlite. Apps only receive a server URL; they never connect to a worker directly, and source files remain exclusively on the worker.

Foundation API routes:

- `GET /api/bootstrap`, `/api/health`, `/api/workers`, and `/api/projects`
- `POST /api/projects`
- `GET|POST /api/projects/:projectId/chats`
- `GET|POST /api/chats/:chatId/messages`

Account, password, link-code, remote enrollment, and multi-worker switching modes are intentionally disabled until their security and transport layers are implemented.

To use disposable PostgreSQL through Docker instead:

```shell
pnpm dev:postgres
```

Useful checks:

```shell
pnpm build
pnpm check
pnpm format:check
```

## Native shells

The checked-in Tauri 2 stub uses the bundle identifier `art.cantrip` and starts the complete local stack before opening its desktop window:

```shell
pnpm --filter @cantrip/app tauri:dev
```

Capacitor 8 is configured with the same app identifier. Native iOS and Android projects are intentionally deferred; generate them when mobile work begins:

```shell
pnpm --filter @cantrip/app cap:add:ios
pnpm --filter @cantrip/app cap:add:android
pnpm --filter @cantrip/app cap:sync
```

Packaged clients can set `VITE_CANTRIP_SERVER_URL` to the Cantrip Server origin. Browser development uses Vite's `/api` proxy automatically.
