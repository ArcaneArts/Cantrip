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

# Manage shared stable-ID Run configurations.
cantrip run list
cantrip run show 11111111-1111-4111-8111-111111111111
cantrip run detect
cantrip run create --file ./run-configuration.json
cantrip run update 11111111-1111-4111-8111-111111111111 --file ./run-configuration.json --revision <revision>
cantrip run delete 11111111-1111-4111-8111-111111111111 --revision <revision>
cantrip run start 11111111-1111-4111-8111-111111111111
cantrip run restart 11111111-1111-4111-8111-111111111111
cantrip run stop 11111111-1111-4111-8111-111111111111
cantrip run status
cantrip run logs 11111111-1111-4111-8111-111111111111 --tail 20000
printf '%s' "$TOKEN" | cantrip run secret set API_TOKEN
```

Worktree creation defaults to a new `cantrip/<name>` branch based on the
current revision. Use `--base-revision`, `--existing`, or `--detach` only when
that default is not appropriate. `--from` remains a compatibility alias for
`--base-revision`; the canonical name matches the MCP `baseRevision` field.
Removal deliberately reuses Cantrip's existing
safety policy: Primary, dirty, externally created, leased, or actively bound
worktrees cannot be removed through this command.

## Run configurations

Run definitions are project-shared JSON documents under
`.cantrip/run-configurations/<configuration-id>.json`. The document ID is the
stable identity used by the app, CLI, and MCP; names are presentation only.
Writes are revision-checked, and definitions are always read from Primary even
when a command is issued from a secondary worktree.

`run detect` proposes definitions for supported project types. `run create`,
`run update`, and `run delete` mutate exact documents. Lifecycle commands take
the stable configuration ID and run on Primary unless `--worktree <id>` is
provided. Starting an already-active configuration is idempotent; restart
stops its process tree and launches the next generation in the same managed
terminal. `run logs` reads bounded protected output, while Run terminals remain
read-only in the app.

Definitions may reference encrypted project secrets. `run secret set` reads
the value from standard input, encrypts it on the worker, and never returns the
plaintext. By default each launch also materializes the current Codex local
environment from `.codex/environments/environment.toml`; that file supplies
environment variables only and does not define actions, setup jobs, or Runs.

See [Run Configurations](RUN_CONFIGURATIONS.md) for the full schema, provider
capabilities, target model, lifecycle, limits, and threat model.

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
native MCP server named `cantrip`. Its permission-filtered read,
worker-mutation, and ephemeral client-control catalog appears in Codex's
runtime inventory as **Managed by Cantrip**. The developer instruction directs Codex to prefer MCP, start with
`context_get`, read required Policies, use `run_configuration_detect` for
guided targets, and obtain stable IDs and revisions through
`run_configuration_list` or `run_configuration_get`. Agents create and update
structured JSON definitions through the revision-checked replacement tools,
then use the explicit lifecycle, status, output, and write-only secret tools
for an exact configuration/worktree identity. Read-only profiles receive only
the read catalog. The CLI and `cantrip -h` remain the fallback.

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
