# ADR 0004: Codex-native workflow control plane

- Status: superseded
- Date: 2026-08-09

> Supersession: the public durable-workflow UI and APIs were removed in commit
> `66ab97645`. The remaining scheduler, executor, workflow repositories, worker
> commands/events, and focused runtime tests were removed in commit
> `87adc1841`. Former durable-workflow paths remain unregistered and receive
> ordinary not-found responses. Migration `0191` in `b6bc0df2a` then removed
> workflow persistence and related interaction, tunnel, branch-lease, and
> accounting residue. Commit `ecf7131a9` then removed the dedicated shared
> protocol/encryption residue. Only historical migrations and implementation
> records remain. The decision below is historical; see
> `docs/WORKFLOW_ORCHESTRATION.md` for the current boundary.

## Context

Cantrip needs reusable commands, guarded unattended automation, structured
multi-stage workflows, and recovery semantics that are useful in Claude Code
without making Claude Code a second runtime. Codex App Server already owns the
agent loop, conversation context, model execution, sandboxing, approvals,
threads, turns, items, skills, hooks, MCP connections, goals, plans, and native
subagents. It does not provide Cantrip's product-specific durable workflow graph,
worktree-lane, schedule, or trigger-delivery model.

Running both CLIs would split authentication, permissions, histories, event
schemas, recovery rules, and UI behavior. Reimplementing the Codex agent loop in
Cantrip would create the same split at a different layer.

## Decision

Cantrip remains Codex-only and adds a durable, data-only workflow control plane
above Codex App Server.

- The app is only a Cantrip Server client.
- The server owns immutable workflow definitions and revisions, run graphs,
  scheduling, dependency state, budgets, approvals, trigger delivery,
  provenance, recovery, and audit history.
- Workers own project files, Git worktrees, terminals, and Codex runtime
  processes. Every worker filesystem or worktree operation uses the worker
  protocol.
- Codex App Server executes each agent or verification turn and remains the
  authority for runtime sandboxing, permissions, context, tools, and streamed
  events.
- Workflow nodes store structured inputs and outputs. They are not hidden user
  chats, and intermediate state does not inflate an unrelated parent chat.
- Write-capable nodes receive exclusive, server-leased worktree lanes. Parallel
  writes never share a checkout.

Workflow definitions contain only schema-validated JSON. JavaScript and
TypeScript workflow imports are inert source material and are never executed.
Repository imports and Codex-generated previews enter as untrusted; running or
automating them requires explicit review and trust changes.

Unattended triggers require a trusted definition and revision plus a
preauthorized revision, every node, and the trigger manifest. Those invariants
are rechecked at delivery and run creation. Schedules, API calls, webhooks,
normalized Git events, and saved commands all use durable idempotency keys,
bounded rate limits, sanitized provenance, and the same run machinery.

## Native capability boundary

Cantrip delegates native customization to the installed App Server whenever the
negotiated method is supported: instructions, memories, skills, hooks, MCP,
permission profiles, plan/collaboration modes, goals, subagents, event progress,
and external-agent configuration import. Cantrip does not create parallel file
formats or mutation APIs for those capabilities. Plugin mutation remains hidden
while the pinned App Server documents it as under development.

Cantrip owns only the product layer that Codex does not: saved workflow graphs,
workflow-run state, worker/worktree routing, trigger schedules, and the operator
control surface.

## Consequences

- There is one agent runtime, authentication model, permission engine, and event
  vocabulary to support.
- App Server schema changes remain isolated behind the negotiated worker runtime
  adapter.
- Workflow recovery occurs at durable node, item, iteration, and worktree
  boundaries. A crashed in-flight Codex turn is never guessed complete; it is
  orphaned or failed and requires a policy-driven or explicit retry.
- General Claude/Cursor imports use Codex's reviewed external-agent import APIs.
  Recognized `.claude/workflows` shapes may be translated into untrusted Cantrip
  data, but Claude CLI is never installed, spawned, or used as fallback.
- The current product is still local single-user software. Normal operator API
  routes inherit that deployment boundary; only scoped webhook routes have
  independent credentials. Insecure remote mode is not a public deployment
  mode.

## Rejected alternatives

- **Add Claude Code CLI as a second backend:** rejected because it duplicates
  runtime, permission, history, and recovery semantics.
- **Translate every Claude feature into Cantrip-owned behavior:** rejected where
  Codex already exposes a native negotiated API.
- **Execute imported workflow scripts:** rejected because arbitrary executable
  imports cannot satisfy the constrained trust and permission model.
- **Encode orchestration in one long Codex prompt:** rejected because it loses
  durable boundaries, independent attribution, bounded parallelism, recovery,
  and worktree isolation.
