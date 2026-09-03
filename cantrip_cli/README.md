# Cantrip CLI

`cantrip` is the small, worker-authenticated command-line surface for
Cantrip-specific operations. Ordinary repository work still uses ordinary
commands such as `git`, `rg`, `sed`, `ls`, and the project build tools.

Run `cantrip -h` for the short command index, then ask a command group for its
own help:

```console
cantrip worktree -h
cantrip worktree create -h
cantrip policy -h
cantrip explorer -h
cantrip -v
```

The version shorthand is deliberately lowercase `-v`. Uppercase `-V` is not a
supported alias.

## Command groups

- `cantrip status` reports the connected worker and inferred project context.
- `cantrip policy` lists or reads the server-owned instructions effective for
  the current project.
- `cantrip worktree` lists, creates, switches, releases, inspects, and safely
  removes Cantrip worktrees.
- `cantrip target` lists authorized project/worktree/surface targets and
  inspects one target.
- `cantrip explorer` lists or reads a remote Explorer surface and can replace a
  text file with optimistic concurrency protection.
- `cantrip terminal` reads scrollback, sends input, or restarts a configured
  terminal service.
- `cantrip browser` discovers worker browser services or opens a URL in a
  Browser tab, creating and focusing one when the project has none.
- `cantrip run` detects, creates, updates, and deletes project-shared stable-ID
  Run configurations; it also starts, restarts, stops, inspects, and tails
  their runtime generations and writes referenced secrets from standard input.

Commands choose useful defaults. A command run inside a linked terminal uses
that terminal; a command run by Codex uses its chat; otherwise the current
working directory selects the most specific registered worktree. Global
`--context auto|cwd|lane` can force the context source when the bound lane and
current directory differ. Add `--target <name-or-id>` only when more than one
matching surface is available. Every command also supports `--json` for stable
machine-readable output.

## Connection and security

The worker places the CLI on `PATH` for Codex and worker-managed terminals. The
CLI never stores or receives the server's worker credential. Instead, it reads
a mode-`0600` connection document named by `CANTRIP_CLI_CONNECTION` and calls
an authenticated loopback-only broker. The broker adds the worker identity and
forwards the command to the server.

The server resolves owner/project context and delegates to the same operation
executor used by the managed MCP tools. Target authorization, placement,
cross-worker routing, safe worktree removal, browser URL validation, and
optimistic Explorer writes therefore have one enforcement path.
