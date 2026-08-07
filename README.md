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

The working vertical slice imports projects from GitHub. Authenticate GitHub on the worker with `gh auth login` or a worker-local `GH_TOKEN`; the app can then list every accessible repository, reject repositories already represented by a project, and clone the selection under `.cantrip/dev/worker/repositories/`. Agent messages render GitHub-flavored Markdown, while command executions and workspace file changes stream from Codex through the worker channel and persist with the conversation.

The Settings page stores appearance, model providers, models, and the default model under the server-owned anonymous account. The browser stores none of these preferences. System appearance is the default and follows the operating system; light and dark overrides are also available. Development starts with an Ollama provider at `http://127.0.0.1:11434/v1` and a `gemma4:26b` model. A provider can instead target a Responses-compatible OpenAI API endpoint and keep its optional API key on the server. Each chat may select a model until its first message; sending that message permanently locks the chat to the resolved selection, using the account default only when the chat has no explicit selection.

Foundation API routes:

- `GET /api/bootstrap`, `/api/health`, `/api/workers`, and `/api/projects`
- `GET /api/github/status` and `/api/github/repositories`
- `POST /api/projects/from-github`
- `GET|POST /api/projects/:projectId/chats`
- `PATCH /api/projects/order` and `/api/projects/:projectId/chats/order`
- `PATCH|DELETE /api/chats/:chatId` and `POST /api/chats/:chatId/fork`
- `GET|POST /api/chats/:chatId/messages`
- `GET|PATCH /api/settings`
- `POST|PATCH|DELETE /api/settings/providers` and `/api/settings/models`
- `PATCH /api/chats/:chatId/model`
- `POST /api/chats/:chatId/turns`

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
