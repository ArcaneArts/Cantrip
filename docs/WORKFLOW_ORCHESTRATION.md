# Workflow orchestration contract

Cantrip workflows are a server-owned, durable control plane above Codex App
Server. Codex remains responsible for each agent loop; Cantrip validates the
workflow graph, schedules durable node boundaries, routes worker commands, and
persists intermediate results. Workflow definitions never contain executable
JavaScript or another general-purpose expression language.

## Definition boundary

Every immutable workflow revision uses graph version `1`. A graph is a bounded
directed acyclic graph with unique node keys and dependency edges. Every node
has one of the following types and a type-specific, strictly validated
configuration:

| Node          | Configuration contract                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`       | One Codex prompt with optional developer instructions, structured-input inclusion, and an automatic-retry ceiling.                   |
| `map`         | One Codex prompt applied to a collection selected by JSON pointer, with an explicit concurrency limit and collection failure policy. |
| `pipeline`    | A bounded ordered list of uniquely keyed Codex steps applied to a collection with explicit concurrency and failure policy.           |
| `reduce`      | One Codex synthesis prompt over a selected collection, with explicit empty-collection behavior.                                      |
| `verify`      | One independent Codex verification prompt, a deterministic pass predicate, and a failure policy.                                     |
| `condition`   | A read-only branch boundary whose outgoing edges contain ordered deterministic predicates and at most one final fallback.            |
| `repeatUntil` | One Codex prompt with explicit success predicate, progress pointer, unchanged-progress limit, iteration limit, and duration limit.   |
| `gate`        | A read-only approval boundary with a prompt, optional expiry, and denial policy.                                                     |

Collection concurrency is always explicit and bounded. Repeat nodes cannot be
saved without success, no-progress, iteration, and elapsed-time limits.
Pipeline step keys must be unique. Unknown configuration fields are rejected so
misspellings cannot silently alter runtime safety.

## Deterministic predicates

Predicates select a value with an RFC 6901 JSON pointer and apply one bounded
operator:

- `exists` or `not-exists` without a comparison value;
- `equals` or `not-equals`;
- numeric or otherwise type-compatible ordering through `greater-than`,
  `greater-than-or-equals`, `less-than`, and `less-than-or-equals`; or
- `contains`.

Comparison operators require an explicit JSON value, including when that value
is `null`. Predicate evaluation will fail closed on incompatible operand types;
it does not coerce strings, evaluate source code, or access data outside the
node's structured input or result.

Only `condition` nodes may own conditional outgoing edges. A condition has at
least two outgoing branches, at least one predicate, and at most one fallback.
The fallback has no predicate and must be the last outgoing edge so branch
selection remains deterministic across restarts.

## Runtime rollout

The runtime executes read-only `agent`, `map`, `reduce`, `verify`, `condition`,
and `gate` nodes. It claims independent Codex-backed roots up to the run's
maximum parallelism, persists each attempt independently, aggregates usage,
and only releases a downstream node after every incoming dependency is durably
satisfied. Deterministic condition and gate transitions do not consume an
agent concurrency slot. A single dependency passes its selected result
directly. Fan-in without explicit target names builds an object keyed by source
node; explicit target names build the same object under those names. Duplicate
target names are rejected when the revision is saved.

A map node expands the array or object selected by `collectionPath` into
durable collection-item rows before dispatching any Codex turn. Array order is
preserved. Object keys are processed in lexical order, and the final object
retains the original keys. Each item owns its attempt counter, lease, worker
and worktree attribution, Codex thread and turn attribution, structured result,
usage, errors, and timestamps. `maxConcurrency` limits active items within the
map while the run's `maxParallelism` remains the global ceiling. Expansion also
counts against `maxNodes`, so a collection that would exceed the immutable run
budget fails before its first item is dispatched. An empty collection completes
at the expansion boundary without a worker turn.

With `failurePolicy: fail-fast`, an exhausted item fails the map, skips items
that have not started, and best-effort interrupts in-flight sibling turns with
persisted Codex thread attribution. With `continue`, all items run and the aggregate
contains explicit outcome envelopes: completed entries have
`{ status: "completed", result }`, and failed entries have
`{ status: "failed", error: { code, message } }`. Automatic retries are
calculated per item and cannot exceed the run's per-node attempt ceiling.
Operator retry resumes only retryable or previously skipped items; completed
items are retained. Cancellation terminalizes active and pending items, while
startup recovery marks interrupted items as recovering without re-expanding
the collection. Downstream nodes are released only after the parent map reaches
a durable terminal boundary.

A pipeline uses the same durable collection expansion and concurrency rules,
then advances each item through its immutable ordered `steps`. The first step
receives the object formed with `itemInputKey`; each later step receives the
previous step's structured result directly. Every step starts or resumes its
own Codex thread, applies its own prompt, developer instructions, output schema,
and automatic-retry ceiling, and commits its result before the next step can be
scheduled. The item execution state records the current step position and
attempt count plus a bounded ledger of completed step results, usage, Codex
thread and turn attribution, and completion times. This is the restart boundary;
completed steps are never replayed merely because a later step was orphaned or
retried.

Pipeline concurrency counts active items, while `maxParallelism` remains the
run-wide ceiling. Each logical item-step invocation counts against `maxNodes`
before expansion. A pipeline's collection failure policy applies when a step
exhausts its attempts: `fail-fast` skips remaining ready items and best-effort
interrupts attributed siblings, while `continue` preserves the
failed step and emits the same explicit collection outcome envelope as `map`.
Operator retry resumes the failed step and previously skipped items without
discarding completed step ledgers. Empty collections complete without a Codex
turn.

A reduce node applies `collectionPath` to its durable node input before the
selected array or object is rendered into the Codex prompt. A missing path or
non-collection value fails explicitly. An empty collection is rejected when
`emptyCollection` is `fail`; `complete` permits the reducer to execute with the
empty collection as its structured input.

Verification nodes evaluate their pass predicate after Codex returns a
structured result. `fail-run` participates in the ordinary bounded retry
policy; `continue` preserves the result and releases downstream dependencies.
The optional `automaticRetries` setting narrows automatic attempts without
increasing the immutable run budget, leaving remaining attempts available for
an explicit operator retry.

Condition nodes evaluate outgoing predicates in immutable edge order, choose
the first match, and use the final fallback only when no predicate matches.
Unselected dependencies and downstream paths are durably skipped. When no edge
matches, `requireMatch: true` fails the run with `condition-no-match`;
`requireMatch: false` completes the condition and skips every branch. A
condition decision and its event are committed atomically, so a restart cannot
choose a different path. Deterministic condition and gate decisions are final
and cannot be retried in place.

A `repeatUntil` node initializes a durable loop cursor before its first Codex
turn. The first iteration receives the node's structured input; each later
iteration receives the previous committed structured result and resumes the
same node-owned Codex thread. Successful turns append a bounded iteration
ledger containing the result, selected progress value, usage, thread and turn
attribution, and completion time. Execution failures retry within the current
iteration, so they do not consume an iteration or duplicate a completed ledger
entry. Startup recovery and operator retry likewise resume the current
iteration from this persisted boundary.

After each turn, the server resolves `progressPath` and evaluates
`successCondition` against the structured result. A missing progress value
fails explicitly. Otherwise success completes the node and releases its
downstream dependencies. An unsatisfied result schedules another iteration
only when all four ceilings still allow it: `maxUnchangedIterations`,
`maxIterations`, `maxDurationMs` measured from loop initialization, and the
run-wide `maxNodes` budget. Each initialized iteration counts as one logical
node, and the remaining loop duration also caps the active worker turn. Hard
loop ceilings fail the run with an auditable reason and cannot be bypassed by
node retry; a changed limit requires a new run.

Gate nodes create a durable pending approval record and move the node to
`waiting-for-approval`. The run remains waiting until an idempotent operator
decision, cancellation, or optional expiry is persisted. Approval passes the
gate input downstream. Denial and expiry either fail the run or skip the gated
path according to the revision's denial policy. Startup recovery preserves
pending gates, expires overdue records before dispatch, and resumes approved
work without creating a duplicate gate. Cancellation terminalizes pending
gates, and decisions against cancelled or otherwise incompatible terminal
states fail with a conflict.

## Run-wide budgets

Every run snapshots immutable limits for expanded node count, attempts per
execution unit, parallelism, node duration, total tokens, elapsed run time, and
optional estimated cost. The scheduler checks the run-wide limits before every
durable transition and after a worker boundary. A live token-usage update that
reaches `maxTokens` terminalizes the run immediately and best-effort interrupts
all attributed active turns. Worker turn timeouts are capped by both the node
limit and the remaining `maxDurationMs` measured from the run's first start, so
a later node cannot receive a fresh full-run time allowance.

When a nonterminal run reaches a token, elapsed-time, or available-cost limit,
no additional work is claimed. A final result may equal its configured maximum
but cannot exceed it. Budget terminalization atomically fails the run, cancels
pending nodes, items, and gates, interrupts active attempts, and appends one
`run.budget.exceeded` event containing the limit, observed value, error code,
and measured usage. This boundary is durable across restart and cannot be
bypassed by pause, resume, or node retry.

`maxEstimatedCostUsd` is a hard opt-in guard. Cost is aggregated only from
turns that have actually reported usage; untouched zero-usage nodes do not make
an otherwise measured total unavailable. Once a completed attempt has real
usage, the run fails closed with `workflow-cost-budget-unavailable` if its cost
signal is absent. Runs without an estimated-cost limit continue to expose
`costAvailable: false` without failing.

## Durable pause and resume

`POST /api/workflow-runs/:runId/pause` is a graceful durable pause. The server
atomically records the operator reason and idempotency key, changes an active
run to `paused`, and stops claiming new Codex turns or deterministic control
nodes. It does not interrupt turns that were already dispatched. Those turns
may finish at their normal durable boundary; their completed result, failed
attempt, or scheduled retry is retained while the run remains paused. If that
boundary terminalizes the entire run, the terminal result wins over the pause.
Pausing therefore does not spend an attempt merely to stop scheduling.

An approval or denial may still be persisted for a pending gate while its run
is manually paused. A nonterminal decision can ready downstream work, but the
work is not dispatched until resume. Cancellation is also valid while paused
and remains terminal. Recovery or an unrecoverable boundary failure supersedes
the manual pause and clears its reason.

`POST /api/workflow-runs/:runId/resume` atomically clears the manual pause,
recomputes the run from persisted nodes and collection items, appends a resume
event, and queues only the work that is still ready. Neither control mutates
attempt counters. Both controls require an idempotency key; replay with the
same payload returns the current run, while reusing the key with different
input is a conflict. Paused runs are not startup-dispatchable, so they remain
paused across server restarts until an explicit resume or cancellation.

Subsequent scheduler changes must preserve these contracts, persist every
intermediate boundary, and apply the run budget as an additional ceiling over
node-local concurrency and loop limits.

Write-capable `agent`, `map`, `pipeline`, `reduce`, `verify`, and `repeatUntil`
nodes use the same declared filesystem permission invariant as other workflow
nodes. `condition` and `gate` nodes are always read-only. Every write-capable
execution unit is dispatched into its attributed non-Primary workflow lane;
the repository rejects a write attempt that does not hold the exact active
run/node/item lease for that worker and worktree.

The durable allocation boundary is represented by a workflow worktree lease.
Each lease belongs to exactly one node or collection item, reserves a
worker-selected worktree identity before filesystem creation, and progresses
through allocating, active, checkpointed, recovery, and terminal states. It
records the source and worker attribution, branch and base revision, starting
and ending revisions, dirty state, and a structured produced-change summary.
An unreleased workflow lease is an explicit worktree-removal blocker. Terminal
unit completion records the worker-observed Git HEAD, dirty state, and file
summary in the same database transaction as the durable node boundary.

`POST /api/workflow-runs/:runId/worktree-leases/:leaseId/outcome` requires the
checkpoint's expected ending revision and an idempotency key. Its explicit
outcomes are:

- `keep`: retain the checkpointed lease and its cleanup blocker for inspection;
- `deliver`: accept the checkpoint and hand the managed checkout back for
  ordinary Cantrip use without merging or copying anything into Primary;
- `release`: relinquish workflow ownership while preserving the checkout, with
  a neutral audit outcome; and
- `discard`: force-remove only the isolated Cantrip-managed checkout, without
  deleting its branch or resetting Primary.

Before a terminal outcome, the owning worker must be online and its current
Git branch, HEAD, upstream/ahead/behind values, and file summary must exactly
match the checkpoint. Drift before resolution starts leaves the lease
checkpointed so the user can keep and inspect it. After validation, `deliver`,
`release`, and `discard` persist the exact pending request and move the lease to
`recovering` before any terminal filesystem side effect. The unreleased lease
continues blocking cleanup throughout that boundary.

An exact retry resumes the persisted intent. In particular, a retried discard
first reconciles the worker inventory: an already-absent isolated checkout is
treated as a completed removal and the durable `discarded` outcome is finalized
without issuing a second remove. A different terminal request conflicts while
an intent is recovering. `keep` is the safe escape hatch: it cancels the
pending terminal intent, preserves the checkout and cleanup blocker, and
returns the lease to its checkpointed `kept` state. Replaying a finalized
outcome with the same key and payload is safe; reusing the key with different
input is a conflict.
