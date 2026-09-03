# Workflow implementation audit

> Historical implementation evidence captured before the endpoint-encrypted
> workflow cutover. The entire public durable-workflow product was later
> removed: the current app has no workflow UI/client, and the server registers
> no public workflow routes. The scheduler, executor, repositories, worker
> handlers, and focused runtime tests were removed afterward. Only legacy
> database/protocol/encryption shapes remain. Everything below is historical.
> Use the [retired workflow boundary](WORKFLOW_ORCHESTRATION.md) and
> [legacy-data operations](WORKFLOW_OPERATIONS.md) for the current
> boundary.

- Audit date: 2026-08-09
- Runtime: bundled Codex CLI/App Server `0.146.1`
- Product boundary: local single-user Cantrip
- Result at the audit date: the Codex-native customization and workflow roadmap was implemented;
  the limitations below remain explicit product boundaries rather than hidden
  fallbacks.

## Architecture result

Cantrip uses one agent runtime: Codex App Server. No Claude CLI dependency,
process launcher, runtime adapter, fallback, or dual-backend selector was added.
Claude references in shipped source are limited to reviewed import discovery,
recognized data translation, inert assisted-conversion text, UI labels, tests,
and documentation.

Codex owns threads, turns, items, context, tools, sandbox execution, approvals,
skills, hooks, MCP, plans, goals, native subagents, and external-agent import.
Cantrip owns durable workflow definitions, revisions, run graphs, orchestration,
worker/worktree routing, triggers, audit state, recovery, and UI. See
[ADR 0004](adr/0004-codex-native-workflow-control-plane.md).

## Recovery and security evidence

This matrix points to then-existing focused tests instead of duplicating them in
the final documentation pass. Several workflow UI/API suites named here were
removed with the public feature.

| Requirement                      | Evidence                                                                                                                                                                                         | Result                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Server restart recovery          | `workflow-execution.test.ts`: pipeline, repeat, map, pause, gate, and orphan recovery; `workflow-run-api.test.ts`: materialized graph reload; `workflow-trigger-api.test.ts`: schedule restart   | Durable boundaries reload; in-flight work is orphaned, never guessed complete      |
| Worker restart/disconnect        | `workflow-execution.test.ts`: replayed lane outcomes and worker reconnect; `worktree-api.test.ts`: pending transition reconnect and offline metadata                                             | Work remains queued/recovering and resumes through worker-owned commands           |
| App reconnect                    | Workflow center queries server-owned definitions/runs/triggers and pages durable events; `workflow-run-api.test.ts` proves reload/list/event cursors                                             | A new app instance rehydrates state; closing the app does not own cancellation     |
| Codex runtime crash              | `CodexAppServerRuntime.handleExit` rejects live RPCs/turns and clears volatile state; `ensureStarted` lazily starts a replacement; `workflow-execution.test.ts` covers orphan and explicit retry | No silent completion or implicit replay of a crashed turn                          |
| Duplicate delivery/replay        | Trigger API concurrent same-key delivery, schedule restart, run key drift, worktree allocation/outcome replay tests                                                                              | One logical delivery/run and deterministic conflicts on payload drift              |
| Capability/version compatibility | `discovery.test.ts` covers compatible, incompatible, missing, core/optional partial support; `app-server.test.ts` covers schema drift and unavailable runtime entry points                       | Core incompatibility fails closed; optional methods degrade independently          |
| Authorization/ownership          | Workflow definition/run owner-boundary tests; worker bearer checks; lane-bound worktree tool tests                                                                                               | Current local identity cannot cross stored ownership or worker/lane bindings       |
| Forged events                    | Trigger API rejects mismatched Git event/branch; worktree API rejects stale/spoofed lanes; remote surfaces reject binding escape                                                                 | Forged scope or identity does not dispatch work                                    |
| Path traversal/symlink escape    | Worker Explorer, attachments, worktrees, workflow repository, customization roots, and managed repository deletion tests                                                                         | Worker resolves and confines paths; symlink and Git common-dir escapes fail closed |
| Approval spoofing                | Agent interaction tests reject unavailable decisions, changed idempotency keys, overbroad permission responses, expired/interrupted requests; workflow gate cancellation/late-decision tests     | Only the exact pending request and allowed response can resolve authority          |
| Secret leakage                   | Secret user-input redaction, trigger secret-field rejection, webhook hash redaction, URL/remote-surface/code-tunnel secret tests                                                                 | Secret values are omitted or redacted at persisted and returned boundaries         |
| Runaway workflows                | Token, elapsed-time, node, attempt, cost, repeat/no-progress, and duration ceiling tests                                                                                                         | Budgets interrupt active work and stop future dispatch with durable reasons        |
| Worktree collision/isolation     | Parallel write-lane test, coordinator serialization, worker common-dir and branch-collision tests                                                                                                | Concurrent writes use distinct checkouts; collisions and drift reject mutation     |
| Bounded parallel load            | Static parallel roots, map collections, ordered pipelines, sibling cancellation, and parallel budget tests assert observed peak concurrency                                                      | Scheduler never exceeds run and node concurrency limits under queued fan-out       |
| Read-only end to end             | `workflow-execution.test.ts` persists a complete agent result, usage, event stream, and Codex attribution                                                                                        | Audit-style workflow completes through server → worker → Codex result boundary     |
| Mutating end to end              | `workflow-execution.test.ts` creates an isolated write lane, checkpoints Git state, and exercises keep/deliver/discard/release recovery                                                          | No write node mutates Primary or an unleased checkout                              |

## Explicit limitations

- Authentication and secure worker enrollment for a public multi-user server are
  future phases. The current operator and normalized Git APIs are safe only on
  the documented local/trusted boundary. The scoped webhook has its own
  credential but is not a replacement for server authentication.
- The Git-event endpoint consumes a normalized trusted-adapter envelope. It is
  not a raw GitHub webhook endpoint and does not validate
  `X-Hub-Signature-256`.
- A Codex crash does not transparently replay an in-flight mutation. The attempt
  is failed/orphaned and normal retry policy or an explicit operator retry
  decides what runs next.
- Cross-worker handoff still requires a compatible checkout and occurs only at
  an idle/durable boundary. Opaque live Codex state and uncommitted files are not
  migrated.
- Plugin list/read metadata is capability-gated, but install/uninstall controls
  remain disabled while the pinned App Server documents plugin mutation as
  under development.
- PGlite is the supported local database. Public/multi-instance deployment and
  PostgreSQL disaster-recovery exercises remain part of the future hosted
  control-plane phase.
- Workflow migrations are forward-only. Schema downgrade requires restoring a
  matching pre-upgrade database backup; see
  [Workflow operations](WORKFLOW_OPERATIONS.md#upgrade-and-data-handling).

## Final validation

`SHELL=/bin/sh pnpm check` passes on the final lane, including pinned Cantrip
Code/Codex source verification, all workspace type checks, 47 protocol tests,
71 app tests, 102 worker tests, 133 server tests, extension tests, and the
repository-wide Prettier check. The pass also closes two pre-existing format
findings and updates the worktree API fixture for the current saved-editor
boundary commands.

## Pull request ledger

Every implementation lane used a fresh worktree, ready pull request, squash
auto-merge, merge observation, Primary fast-forward, and lane cleanup.

### Milestone 1 — Codex runtime contract

- [#18](https://github.com/ArcaneArts/Cantrip/pull/18) — `agent/manual/codex-runtime-contract-019fe256` — negotiate Codex runtime compatibility.

### Milestone 2 — durable approvals and structured interaction

- [#21](https://github.com/ArcaneArts/Cantrip/pull/21) — `agent/manual/durable-approvals-019fe256` — persist durable interaction requests.
- [#24](https://github.com/ArcaneArts/Cantrip/pull/24) — `agent/manual/approval-bridge-019fe256` — bridge Codex approval and interaction requests.
- [#25](https://github.com/ArcaneArts/Cantrip/pull/25) — `agent/manual/approval-ui-permissions-019fe256` — add approval UI and permission profiles.

### Milestone 3 — rich Codex events

- [#26](https://github.com/ArcaneArts/Cantrip/pull/26) — `agent/manual/rich-codex-events-019fe256` — normalize rich Codex events.

### Milestone 4 — native customization

- [#27](https://github.com/ArcaneArts/Cantrip/pull/27) — `agent/manual/customization-capability-gates-019fe256` — negotiate customization capabilities.
- [#31](https://github.com/ArcaneArts/Cantrip/pull/31) — `agent/manual/native-customization-inventory-019fe256` — expose customization inventory.
- [#32](https://github.com/ArcaneArts/Cantrip/pull/32) — `agent/manual/native-customization-ui-019fe256` — inspect customization in the app.
- [#35](https://github.com/ArcaneArts/Cantrip/pull/35) — `agent/manual/native-customization-mutations-019fe256` — guard native mutations.
- [#38](https://github.com/ArcaneArts/Cantrip/pull/38) — `agent/manual/native-customization-controls-019fe256` — add guarded controls.

### Milestone 5 — workflow domain and APIs

- [#41](https://github.com/ArcaneArts/Cantrip/pull/41) — `agent/manual/workflow-domain-schema-019fe256` — add durable workflow schema.
- [#43](https://github.com/ArcaneArts/Cantrip/pull/43) — `agent/manual/workflow-protocol-019fe256` — define workflow protocol.
- [#44](https://github.com/ArcaneArts/Cantrip/pull/44) — `agent/manual/workflow-definitions-api-019fe256` — add definition APIs.
- [#46](https://github.com/ArcaneArts/Cantrip/pull/46) — `agent/manual/workflow-runs-api-019fe256` — materialize workflow runs.

### Milestone 6 — single-agent execution

- [#50](https://github.com/ArcaneArts/Cantrip/pull/50) — `agent/manual/workflow-node-runtime-019fe256` — add the Codex node entry point.
- [#53](https://github.com/ArcaneArts/Cantrip/pull/53) — `agent/manual/workflow-dispatch-recovery-019fe256` — dispatch and recover durable nodes.
- [#55](https://github.com/ArcaneArts/Cantrip/pull/55) — `agent/manual/workflow-controls-019fe256` — add durable run controls.

### Milestone 7 — orchestration primitives and budgets

- [#56](https://github.com/ArcaneArts/Cantrip/pull/56) — `agent/manual/workflow-orchestration-contracts-019fe256` — constrain orchestration data.
- [#58](https://github.com/ArcaneArts/Cantrip/pull/58) — `agent/manual/workflow-static-dag-runtime-019fe256` — execute static DAGs.
- [#60](https://github.com/ArcaneArts/Cantrip/pull/60) — `agent/manual/workflow-control-gates-019fe256` — execute conditions and gates.
- [#62](https://github.com/ArcaneArts/Cantrip/pull/62) — `agent/manual/workflow-map-pipeline-019fe256` — execute map collections.
- [#63](https://github.com/ArcaneArts/Cantrip/pull/63) — `agent/manual/workflow-pipeline-019fe256` — execute durable pipelines.
- [#65](https://github.com/ArcaneArts/Cantrip/pull/65) — `agent/manual/workflow-repeat-until-019fe256` — execute durable repeat loops.
- [#66](https://github.com/ArcaneArts/Cantrip/pull/66) — `agent/manual/workflow-pause-resume-019fe256` — add pause and resume.
- [#67](https://github.com/ArcaneArts/Cantrip/pull/67) — `agent/manual/workflow-run-budgets-019fe256` — enforce run-wide budgets.

### Milestone 8 — worktree isolation and recovery

- [#68](https://github.com/ArcaneArts/Cantrip/pull/68) — `agent/manual/workflow-worktree-lease-domain-019fe256` — add durable lease state.
- [#69](https://github.com/ArcaneArts/Cantrip/pull/69) — `agent/manual/shared-worktree-coordinator-019fe256` — share the mutation coordinator.
- [#70](https://github.com/ArcaneArts/Cantrip/pull/70) — `agent/manual/workflow-worktree-allocation-019fe256` — add allocation transitions.
- [#71](https://github.com/ArcaneArts/Cantrip/pull/71) — `agent/manual/workflow-worktree-dispatch-019fe256` — make allocation replay-safe.
- [#72](https://github.com/ArcaneArts/Cantrip/pull/72) — `agent/manual/workflow-write-checkpoints-019fe256` — execute writes in isolated lanes.
- [#73](https://github.com/ArcaneArts/Cantrip/pull/73) — `agent/manual/workflow-outcomes-019fe256` — add lane outcome controls.
- [#74](https://github.com/ArcaneArts/Cantrip/pull/74) — `agent/manual/workflow-outcome-recovery-019fe256` — make outcomes crash-replayable.
- [#75](https://github.com/ArcaneArts/Cantrip/pull/75) — `agent/manual/workflow-lease-recovery-019fe256` — recover on startup and reconnect.

### Milestone 9 — workflow operator UI

- [#76](https://github.com/ArcaneArts/Cantrip/pull/76) — `agent/manual/workflow-center-019fe256` — add the operator center.
- [#77](https://github.com/ArcaneArts/Cantrip/pull/77) — `agent/manual/unified-commands-019fe256` — unify commands, skills, and workflows.

### Milestone 10 — authoring, generation, and portability

- [#78](https://github.com/ArcaneArts/Cantrip/pull/78) — `agent/manual/workflow-authoring-019fe256` — add constrained authoring.
- [#79](https://github.com/ArcaneArts/Cantrip/pull/79) — `agent/manual/workflow-save-run-019fe256` — save completed runs as revisions.
- [#80](https://github.com/ArcaneArts/Cantrip/pull/80) — `agent/manual/workflow-generation-019fe256` — add Codex-assisted generation.
- [#81](https://github.com/ArcaneArts/Cantrip/pull/81) — `agent/manual/workflow-repository-portability-019fe256` — add repository portability and safe Claude-shape translation.

### Milestone 11 — automation and triggers

- [#82](https://github.com/ArcaneArts/Cantrip/pull/82) — `agent/manual/workflow-trigger-control-plane-019fe256` — add durable schedule/API/webhook control plane.
- [#83](https://github.com/ArcaneArts/Cantrip/pull/83) — `agent/manual/workflow-trigger-adapters-019fe256` — add Git/saved-command adapters and operator controls.

### Milestone 12 — final audit and documentation

- [#84](https://github.com/ArcaneArts/Cantrip/pull/84) —
  `agent/manual/workflow-final-audit-019fe256` — add final evidence, operations,
  migration, rollback, README, PLAN, ADR, and repository-format closure.
