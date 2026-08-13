# Cantrip CLI

The Cantrip CLI gives humans and agents a conventional command-line interface
for operations that belong to Cantrip rather than to the local operating
system. It is intentionally narrow: use normal shell and Git commands for
ordinary files and repository work, and use `cantrip` when an operation needs
Cantrip's server-owned context or worker routing.

## Discovering commands

Help is layered so the root page remains readable:

```console
cantrip -h
cantrip worktree -h
cantrip worktree create -h
cantrip target -h
cantrip explorer -h
cantrip terminal -h
cantrip browser -h
```

`cantrip -v` prints the CLI version. `cantrip --json <command>` returns the
same command result as JSON and uses nonzero exit codes for invalid input,
missing/ambiguous context, conflicts, or unavailable workers.

## Common examples

```console
# Inspect where this shell or Codex turn is running.
cantrip status

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
```

Worktree creation defaults to a new `cantrip/<name>` branch based on the
current revision. Use `--from`, `--existing`, or `--detach` only when that
default is not appropriate. Removal deliberately reuses Cantrip's existing
safety policy: Primary, dirty, externally created, leased, or actively bound
worktrees cannot be removed through this command.

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

Cantrip does not register product-specific functions in Codex's tool list. New
threads and resumed threads both send `dynamicTools: []`; the pinned runtime's
resume compatibility patch distinguishes that explicit empty override from an
omitted field and removes any tool declarations saved by pre-cutover chats.
Both paths install a small developer instruction directing Codex to
`cantrip -h` and standard command-line tools.

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
