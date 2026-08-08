# Cantrip worktrees

Cantrip treats a project as one logical Git repository, a project source as one
worker-owned installation, and a worktree as one physical checkout belonging to
that source. The server owns durable identity, policy, leases, and transcript
attribution. The worker owns files, canonical paths, Git state, PTYs, and Codex
runtimes.

## User model

Every source has a **Primary** worktree using the original repository checkout.
It cannot be removed separately from the project. Additional worktrees may be:

- Cantrip or agent managed beneath the worker data directory;
- created by a user through a worktree control or History; or
- external checkouts discovered by `git worktree list` reconciliation.

The project sidebar stays flat. Secondary-worktree Chats, Terminals, Explorers,
and History tabs show a compact icon whose tooltip and popover describe branch
or detached revision, worker, dirty/conflict state, display path, and lease
owner. Primary and project-level Browser or Issues tabs show no icon.

### Agent managed and Pinned chats

**Agent managed** is the default. The agent can begin on Primary for inspection
and call Cantrip's native worktree tools when isolated writes are appropriate or
required by project policy. A switch requested during a turn is scheduled: the
agent finishes that turn, Cantrip activates the destination lane, and a
continuation turn starts with the destination CWD and workspace root. The
transcript records the transition.

**Pinned** binds a chat to the selected worktree and prevents autonomous
switching. Use the worktree control in the chat header or the chat's Worktree
context submenu to pin, return to Agent managed, select Primary or another
checkout, create a checkout, or open a Terminal, Explorer, or History there.

Queued prompts without an explicit worktree use the chat's active lane when
they dispatch. A deliberately pinned queued prompt retains its selected lane.
Linked Codex consoles always follow the parent chat and its worktree-specific
runtime.

### History and filesystem tabs

History shows a compact marker at every known worktree HEAD. Shared commits may
have several markers, detached worktree commits are included even when they are
unreachable from `git log --all`, and dirty worktrees receive a WIP row joined
to their HEAD lane. Selecting a marker changes which checkout supplies status,
staging, commit, pull, push, branch creation/switching, and the changes panel.

Marker menus can open or create an owning Chat, Terminal, Explorer, or another
History tab. History also exposes create, reconcile/refresh, lock/unlock,
prune, and safe removal. Terminal and Explorer tabs never silently move when a
chat changes lanes; create a new tab on the desired checkout instead.

## Policies and safety

Projects store one of three policies:

- `direct`: agents may write in Primary;
- `agent-managed`: agents decide when to acquire an isolated worktree; or
- `required-for-writes`: Primary is inspection-only for agents.

Cantrip enforces `required-for-writes` at the Codex turn boundary: Primary uses
a read-only sandbox, while secondary worktree turns use a workspace-write
sandbox rooted at that checkout. Every turn also receives the current project
policy and chat mode as application context.

The default is `agent-managed`. The API endpoint
`PATCH /api/projects/:projectId/worktree-policy` accepts a validated policy.
The project action menu opens Project Settings, where the policy is saved on
the server alongside the project's source and worktree inventory.

Project Settings lists every Primary, managed, user-created, and discovered
external worktree with its branch or detached HEAD, lifecycle and dirty state,
worker, path, and bound tabs. From there a user can reconcile or prune the
inventory, create a worktree, lock or unlock a secondary worktree, safely
remove a secondary checkout, or open a Chat, Terminal, Explorer, or History tab
on a selected checkout.

Repositories may optionally declare their import-time default in
`.cantrip/project.json`:

```json
{
  "worktreePolicy": "required-for-writes"
}
```

Cantrip reads this bounded, regular JSON file when cloning or re-linking the
repository. Missing or invalid files never block project setup; invalid files
produce a setup warning, and users may still change the server-owned policy
from the project action menu.

Cantrip enforces these boundaries:

- clients and agents provide intent, branch, name, and base revision, never a
  target path;
- the worker canonicalizes paths and verifies Git common-directory identity;
- mutating worktree operations serialize per project source;
- Primary cannot be individually removed or locked;
- branches are retained when a worktree is removed;
- locked, dirty, active, leased, or terminal-backed worktrees block unsafe
  removal;
- one chat exclusively leases a secondary managed checkout by default;
- external and user-owned checkout removal requires explicit user authority;
- missing workers leave server metadata and chat history intact; and
- cross-worker file replication is not implied or implemented.

## Agent integration

Codex app-server receives these dynamic tools from the worker:

- `cantrip_worktrees_list`
- `cantrip_worktree_create`
- `cantrip_worktree_acquire`
- `cantrip_worktree_switch`
- `cantrip_worktree_status`
- `cantrip_worktree_release`
- `cantrip_worktree_remove`

The server validates the current chat lane, actor, policy, ownership, and
removal authority before routing an operation. Runtime identity includes chat,
worker, and worktree. See
[ADR 0001](adr/0001-agent-managed-worktree-execution.md) for the Codex CWD spike
and safe continuation decision.

## Development validation

Run the focused automated suites from a clean milestone worktree:

```shell
pnpm --filter @cantrip/protocol test
pnpm --filter @cantrip/worker test -- worktrees.test.ts app-server.test.ts
pnpm --filter @cantrip/server test -- worktree-migration.test.ts worktree-api.test.ts
pnpm --filter @cantrip/app test -- worktree-control.test.ts git-history.test.ts project-settings-page.test.tsx desktop-popout.test.ts
pnpm check
pnpm --filter @cantrip/app build
```

The migration suite applies the real SQL migration chain to PGlite and verifies
Primary/tab/transcript backfills. To exercise the same Drizzle migration folder
against disposable PostgreSQL, start the repository's tmpfs-backed database
and the server with `DATABASE_URL`:

```shell
docker compose -f compose.dev.yml up -d --wait postgres
DATABASE_URL=postgresql://cantrip:cantrip@127.0.0.1:54329/cantrip \
  CANTRIP_DATA_DIR=/tmp/cantrip-postgres-worktree-check \
  pnpm --filter @cantrip/server dev
```

Wait for `Cantrip Server is ready`, request
`http://127.0.0.1:4310/api/bootstrap`, and verify it reports
`"worktrees":true`. Stop the server, then run
`docker compose -f compose.dev.yml down`. The compose database uses tmpfs and
is intentionally disposable.

For interactive UI verification, run `pnpm dev`, add a small public repository,
and add a History tab. Create a new branch worktree from History, verify Primary
and secondary markers share the expected HEAD, bind a chat to it, and create a
file through the chat or its Terminal. Confirm a WIP row appears, the sidebar
indicator becomes dirty, History actions target only that checkout, and a
desktop History popout retains the same selected worktree. Finally verify lock,
dirty-removal confirmation, branch retention, return to Primary, worker-offline
rendering, and prune behavior.
