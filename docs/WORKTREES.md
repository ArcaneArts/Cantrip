# Cantrip worktrees

For a GitHub-backed project, Cantrip treats the project as one logical Git
repository, a project source as one worker-owned installation, and a worktree
as one physical checkout belonging to that source. The server owns durable
identity, policy, leases, and transcript attribution. The worker owns files,
canonical paths, Git state, PTYs, and Codex runtimes.

The Primary source may be a Cantrip-managed clone, a managed clone with an
external link, or a direct checkout created/attached at an exact worker path.
That choice does not change the worktree model: Cantrip always registers the
canonical Primary checkout, and all secondary worktree targets remain under
worker control. See
[PROJECT_REPOSITORY_PLACEMENT.md](PROJECT_REPOSITORY_PLACEMENT.md).

A worker-managed folder project is intentionally outside this worktree model.
It has one UUID-derived execution root on one owning worker. Agents may write
there directly according to their permission profile, while worktrees, Git
observation, replicas, and relocation stay unavailable. Legacy workflow records
may remain in the database but cannot execute. Running `git init` does not opt
the project into this guide; only explicit conversion to a GitHub repository does. See
[FOLDERS.md](FOLDERS.md).

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
History tab. History also exposes source-aware creation from branches, issues,
and pull requests; opening the worktree that already owns a branch; moving a
reviewed dirty patch between compatible worktrees; copying selected commits to
another lane; reconcile/refresh; lock/unlock; bulk cleanup; prune; and safe
removal. Terminal and Explorer tabs never silently move when a chat changes
lanes; create a new tab on the desired checkout instead.

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

Managed-folder projects persist `direct` and do not show the worktree policy
control. The selected Agent permission profile still governs writes; `direct`
means only that Cantrip does not manufacture a Git isolation lane.

Cantrip enforces these boundaries:

- after Primary provisioning, clients and agents provide worktree intent,
  branch, name, and base revision, never a secondary target path;
- the worker canonicalizes paths and verifies Git common-directory identity;
- one server coordinator serializes mutating worktree operations per project
  source for user and chat-agent operations;
- Primary cannot be individually removed or locked;
- branches are retained when a worktree is removed;
- dirty-patch transfers resolve both worktrees through server-owned IDs,
  require the same source and worker, and verify one Git common directory;
- move previews bind both HEAD/status snapshots plus working and staged-index
  content, and apply retains recovery state whenever conflict resolution is
  required;
- locked, dirty, active, leased, or terminal-backed worktrees block unsafe
  removal;
- one chat exclusively leases a secondary managed checkout by default;
- external and user-owned checkout removal requires explicit user authority;
- missing workers leave server metadata and chat history intact; and
- cross-worker file replication is not implied or implemented.

## Git status observation

The worker, rather than each app client, owns external worktree observation.
After its authenticated command socket connects, the server configures at most
128 owned source/worktree path pairs. The worker validates those paths through
the existing canonical worktree inventory and Git common-directory checks,
uses recursive filesystem observation where the platform supports it, and
debounces changes for 500 ms before reading Git status. Observation does not
weaken symlink, ownership, managed-root, or cross-repository isolation rules.

Filesystem watching is only the prompt path. A bounded worker sweep reconciles
the configured sources and statuses every 30 seconds, so index-only Git
changes, watcher loss, unsupported recursive watching, external worktree
creation, and transient filesystem errors still converge. Source scans run two
at a time and status reads four at a time. Repeating the same configuration is
idempotent and unchanged snapshots are neither persisted nor republished.

Known Cantrip Git actions persist and publish their returned status
immediately. Unsolicited worker observations travel as validated notification
envelopes on the existing worker WebSocket; they do not enter the application
control socket until the server has verified worker ownership and committed
the snapshot. Healthy apps update the exact TanStack Query cache entry from
that payload and make no periodic per-worktree requests. If the app live socket
is disconnected while the worker remains online, a 15-second HTTP fallback is
used. If the worker is offline, the status endpoint returns the latest stored
snapshot and does not poll an unavailable machine.

## Agent integration

Codex receives no legacy Cantrip-specific dynamic tools. New chats start with
an explicit empty dynamic-tool override, and resumed chats send the same
override so old persisted declarations are removed by the pinned Codex
compatibility patch. The worker separately injects the native managed `cantrip`
MCP and directs agents to prefer `worktree_create`, `worktree_switch`, and the
other typed tools. `cantrip -h` remains the fallback when MCP is unavailable.

The worker-managed `cantrip` executable provides layered `worktree`, `target`,
`explorer`, `terminal`, and `browser` commands. Worktree status can address a
canonical worktree target on another worker, and surface commands use the same
canonical target resolver as the application. The source worker never contacts
the target worker directly.

Bounded mutations retain their existing constraints: Explorer writes require
the version token from the corresponding read, terminal service restarts
require an enabled service, Browser navigation accepts HTTP(S) only, and every
mutation attempt is audited by the server.

For a managed-folder execution context, `target`, `explorer`, `terminal`, and
`browser` continue to resolve through the server to the owning worker. The
`worktree` command group is rejected with an unsupported-capability response.

The server validates the current chat lane, actor, policy, ownership, and
removal authority before routing an operation. The loopback CLI broker attaches
the active chat and execution-lane identity to commands originating inside a
Codex turn, while ordinary terminal commands resolve through terminal ID or
working directory. Runtime identity includes chat, worker, and worktree. See
[ADR 0001](adr/0001-agent-managed-worktree-execution.md) for the Codex CWD spike
and safe continuation decision.

## Development validation

Run the focused automated suites from a clean milestone worktree:

```shell
pnpm --filter @cantrip/protocol test
pnpm --filter @cantrip/worker test -- worktrees.test.ts app-server.test.ts
pnpm --filter @cantrip/server test -- worktree-migration.test.ts worktree-api.test.ts project-placement-api.test.ts
pnpm --filter @cantrip/app test -- worktree-control.test.ts git-history.test.ts project-settings-page.test.tsx desktop-popout.test.ts
pnpm check
pnpm --filter @cantrip/app build
```

Repository-placement changes additionally run the focused direct/link,
protected-path, durable-job, and shared-dialog suites listed in
[the placement release acceptance](PROJECT_REPOSITORY_PLACEMENT.md#release-acceptance).
Custom Primary placement does not relax any secondary worktree validation or
removal rule in this guide.

Managed-folder changes that touch the compatibility execution-root row or Git
capability guards also run:

```shell
pnpm --filter @cantrip/worker test
pnpm --filter @cantrip/server test
```

The folder-focused coverage includes OS-specific POSIX/Windows path derivation,
UUID and symlink containment, PGlite migration, owner-only placement, the Task
lifecycle, offline state, destructive removal, conversion, and rejection of
Git/worktree routes.

The migration suite applies the real SQL migration chain to PGlite and verifies
Primary/tab/transcript backfills plus deterministic project-wide logical branch
lease backfill. The placement suite verifies that different worker-local
worktree IDs cannot concurrently acquire the same project branch.
To exercise the same Drizzle migration folder
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
