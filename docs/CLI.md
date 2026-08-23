# Cantrip CLI

The Cantrip CLI gives humans, scripts, diagnostics, and fallback agent runtimes
a conventional command-line interface for operations that belong to Cantrip
rather than to the local operating system. Attached Codex chats should prefer
the worker-owned [`cantrip` MCP server](MCP.md). The CLI intentionally exposes
the same bounded operation contract when MCP is unavailable. Use normal shell
and Git commands for ordinary files and repository work.

## Discovering commands

Help is layered so the root page remains readable:

```console
cantrip -h
cantrip policy -h
cantrip worktree -h
cantrip worktree create -h
cantrip target -h
cantrip explorer -h
cantrip terminal -h
cantrip browser -h
cantrip run -h
```

`cantrip -v` prints the CLI version. `cantrip --json <command>` returns the
same command result as JSON and uses nonzero exit codes for invalid input,
missing/ambiguous context, conflicts, or unavailable workers.

## Common examples

```console
# Inspect where this shell or Codex turn is running.
cantrip status

# Read server-owned instructions effective for the current project.
cantrip policy list
cantrip policy read manual-change-protocol
cantrip --json policy list

# Worktrees use the current project automatically.
cantrip worktree list
cantrip worktree create fix-cache-race
cantrip worktree create docs-refresh --branch docs/refresh --switch
cantrip worktree create investigate --existing release/2.x
cantrip worktree status
cantrip worktree switch fix-cache-race
cantrip worktree release
cantrip worktree remove fix-cache-race

# Find Cantrip-managed resources.
cantrip target list
cantrip target list --kind terminal
cantrip target show
cantrip target show "Build terminal"

# Operate a surface; --target is needed only when selection is ambiguous.
cantrip explorer list src
cantrip explorer read README.md
printf '%s\n' '# Updated' | cantrip explorer write README.md
cantrip terminal read --target "Build terminal"
cantrip terminal send --target "Build terminal" pnpm test
cantrip terminal restart --target "Dev server"
cantrip browser services --target Preview
cantrip browser open --target Preview http://127.0.0.1:5173

# Inspect Codex-compatible project Run configurations.
cantrip run list
cantrip run show "Run Spectral Lab"
cantrip run validate
cantrip run config path
cantrip run config schema --json
cantrip run config example
cantrip run config init --name "Spectral Lab"
cantrip run config action add "Run app" --command "pnpm run dev" --icon run
cantrip run config action add "Run Windows app" --command "pnpm run dev" --platform win32
cantrip run start "Run Spectral Lab" --no-focus
cantrip run status
cantrip run logs 11111111-1111-4111-8111-111111111111 --tail 20000
cantrip run open 11111111-1111-4111-8111-111111111111
cantrip run stop 11111111-1111-4111-8111-111111111111
cantrip run setup status
cantrip run setup retry
```

Worktree creation defaults to a new `cantrip/<name>` branch based on the
current revision. Use `--base-revision`, `--existing`, or `--detach` only when
that default is not appropriate. `--from` remains a compatibility alias for
`--base-revision`; the canonical name matches the MCP `baseRevision` field.
Removal deliberately reuses Cantrip's existing
safety policy: Primary, dirty, externally created, leased, or actively bound
worktrees cannot be removed through this command.

## Run configurations

Cantrip discovers declarative Codex local environments from
`.codex/environments/*.toml` beneath the registered project source root. It
uses the target worker platform when selecting actions, so repeated macOS,
Windows, and Linux variants with the same display name resolve correctly. An
ignored local environment remains local to that worker and still applies when
the active chat uses a secondary worktree; a tracked file follows normal Git
replication.

This intentionally follows OpenAI's
[local environments](https://learn.chatgpt.com/docs/environments/local-environment)
contract: setup prepares newly created worktrees, while actions are ordinary
integrated-terminal commands. Cantrip adds distributed routing and supervision
without inventing a second project configuration format.

`cantrip run list` returns actions compatible with the current worker.
`cantrip run show` accepts an exact action name or the opaque ID returned by
the list. Duplicate compatible names are rejected as ambiguous instead of
being selected arbitrarily. `cantrip run validate` reports bounded parsing,
schema, path-safety, and ambiguity diagnostics and exits nonzero when errors
are present. `cantrip run config path` reports the canonical
`.codex/environments/environment.toml` location and whether it is tracked,
ignored, untracked, or absent.

`cantrip run config init [--name <name>]` creates a minimal canonical v1 file
only when it is absent. `--overwrite` is required to replace an existing file,
and the worker still rejects a stale revision. The command never edits
`.gitignore` or stages, commits, or pushes the result. Project settings →
Environment provides the same revision-checked authoring path for setup and
action platform variants.

`cantrip run config schema --json` returns the exact authoring JSON Schema,
complete document example, and equivalent TOML. `cantrip run config example`
prints the TOML example directly. For the common case, `cantrip run config
action add <name> --command <shell-command>` creates the canonical file when
absent or appends one complete revision-checked action. `--icon` defaults to
`run`; omit `--platform` for every host or select `win32`, `darwin`, or
`linux`. `--environment-name` sets the displayed environment name. All
three commands honor the global `--context auto|cwd|lane` selection.

`cantrip run start <action>` resolves an unambiguous action name or opaque ID,
then sends its exact ID and configuration revision to the owning worker. The
worker rereads the source-root configuration, rechecks its platform and
revision, and starts the command once in a worker-owned PTY. The action CWD is
the active worktree. Its environment preserves the worker environment and
sets `CODEX_WORKTREE_PATH`, `CANTRIP_WORKTREE_PATH`, `CANTRIP_PROJECT_ROOT`,
`CANTRIP_RUN_ID`, and `CANTRIP_ACTION_ID`. A desktop client is not required;
the Run succeeds headlessly when no compatible client is connected. When a
client is available, Cantrip asks it to encrypt and idempotently materialize a
terminal whose UUID is the Run UUID. `cantrip run open <run-id>` retries that
best-effort materialization after a client reconnects and focuses it when
applied. The terminal attaches to the existing worker-owned Run PTY; it never
starts a second shell or gives the action terminal-service restart semantics.

`cantrip run status [run-id]` refreshes one Run or, when no ID is supplied, the
most recently created Run in the current worktree. `cantrip run logs <run-id>`
reads a bounded character tail from volatile worker memory; `--tail` accepts 1
through 100000 characters. Scrollback is not persisted by the server and is
unavailable when its worker is offline or has restarted. `cantrip run stop
<run-id>` terminates the PTY's complete process tree. Exited actions are never
automatically restarted, and retries reuse the same Run identity instead of
starting the action twice. Cantrip also stops affected Runs before removing a
worktree, managed project folder, or worker-owned repository copy.

Run instances persist only routing and lifecycle metadata: project, worktree,
worker, action ID, configuration revision, state, timestamps, exit result, and
an optional terminal association. Commands, environment values, and terminal
output are never stored in the server database. The action-add command is the
preferred simple authoring path; ordinary repository tools remain available
for complete TOML editing. Setup is separate and does not execute when a Run
starts.

`cantrip run setup status` reports the durable setup job plus bounded output
when its worker is available. `cantrip run setup retry` is an explicit
secondary-worktree mutation; it is unavailable for Primary. A changed
configuration makes completed setup stale until retry, and removing the
worktree deletes its worker-private setup state.

See [Codex-compatible Run environments](RUN_CONFIGURATIONS.md) for the full
schema, platform shell matrix, lifecycle, limits, and threat model.

## Policies

`cantrip policy list` returns the current project's effective policies in
configured order with key, name, summary, Mandatory flag, and effective source
labels. It intentionally omits full bodies.

`cantrip policy read <policy-key>` returns the current key, name, summary,
and full Markdown body. The key must be effective for the resolved project;
foreign, disabled, unassigned, and unknown keys all fail without revealing
another policy. Policy operations are read-only in the CLI. Creation, editing,
ordering, and assignment remain authenticated Settings operations owned by
Cantrip Server.

Agents receive the same effective summaries as bounded application context.
The global Cantrip developer instruction directs them to read a full policy
when its summary requires that. Policy bodies remain server-owned and are
fetched only through the authenticated broker/server path.

## Context resolution

Each invocation reports three hints to the server, in priority order:

1. `CODEX_THREAD_ID`, for a command run by a Cantrip chat's Codex process. The
   worker broker binds this to the active server-issued chat execution lane,
   including before a newly created Codex thread has been persisted by the
   server.
2. `CANTRIP_TERMINAL_ID`, injected into each Cantrip Terminal process.
3. The current working directory, matched to the most specific worktree path
   registered on the connected worker.

The server scopes every lookup to the account owning the authenticated worker.
A stale, missing, spoofed, or ambiguous hint fails clearly instead of guessing
across projects. Chat transitions such as `worktree switch` additionally
require the exact active chat execution lane; read-only and direct surface
commands can run from a normal project terminal.

## Codex integration

For applicable new and resumed chat threads, the worker injects a required
native MCP server named `cantrip`. Its 35 read, worker-mutation, and ephemeral
client-control tools appear in Codex's runtime inventory as **Managed by
Cantrip**. The developer instruction directs Codex to prefer MCP, start with
`context_get`, read required Policies, prefer `run_config_action_add` for
simple authoring, consult `run_config_schema` before direct TOML editing, and
use exact action IDs plus configuration revisions with managed Run tools.
Read-only profiles receive only the read catalog. The CLI and `cantrip -h`
remain the fallback.

Both thread paths still send `dynamicTools: []`. The pinned runtime's resume
compatibility patch distinguishes that explicit empty override from an omitted
field and removes obsolete dynamic-tool declarations saved by older chats.
Native MCP tools are configured separately and are not disabled by this field.

## Transport

The data path is:

```text
cantrip CLI
  -> authenticated loopback worker broker
  -> authenticated server /api/internal/cli endpoint
  -> shared execution operation and placement resolver
  -> owning worker (which may be a different worker)
```

The protected connection file contains only a short-lived broker session token
and public connection metadata. Worker server credentials remain in the worker
process. Broker requests and responses are bounded, server calls are schema
validated, mutations are audited, and long-running commands do not fail merely
because cloning or remote work takes longer than a small client timeout.
