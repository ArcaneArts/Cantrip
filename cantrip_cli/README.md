# Cantrip CLI

`cantrip` is the small, worker-authenticated command-line surface for
Cantrip-specific operations. Ordinary repository work still uses ordinary
commands such as `git`, `rg`, `sed`, `ls`, and the project build tools.

Run `cantrip -h` for the short command index, then ask a command group for its
own help:

```console
cantrip worktree -h
cantrip worktree create -h
cantrip explorer -h
cantrip -v
```

The version shorthand is deliberately lowercase `-v`. Uppercase `-V` is not a
supported alias.

## Command groups

- `cantrip status` reports the connected worker and inferred project context.
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

Commands choose useful defaults. A command run inside a linked terminal uses
that terminal; a command run by Codex uses its chat; otherwise the current
working directory selects the most specific registered worktree. Add
`--target <name-or-id>` only when more than one matching surface is available.
Every command also supports `--json` for stable machine-readable output.

## Connection and security

The worker places the CLI on `PATH` for Codex and worker-managed terminals. The
CLI never stores or receives the server's worker credential. Instead, it reads
a mode-`0600` connection document named by `CANTRIP_CLI_CONNECTION` and calls
an authenticated loopback-only broker. The broker adds the worker identity and
forwards the command to the server.

The server resolves owner/project context and delegates to the same operation
executor used by the temporary Codex tools. Target authorization, placement,
cross-worker routing, safe worktree removal, browser URL validation, and
optimistic Explorer writes therefore have one enforcement path. The legacy
tools remain registered during the parity transition so existing chats do not
lose capabilities.
