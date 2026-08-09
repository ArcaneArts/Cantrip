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

Gate nodes create a durable pending approval record and move the node to
`waiting-for-approval`. The run remains waiting until an idempotent operator
decision, cancellation, or optional expiry is persisted. Approval passes the
gate input downstream. Denial and expiry either fail the run or skip the gated
path according to the revision's denial policy. Startup recovery preserves
pending gates, expires overdue records before dispatch, and resumes approved
work without creating a duplicate gate. Cancellation terminalizes pending
gates, and decisions against cancelled or otherwise incompatible terminal
states fail with a conflict.

Unsupported dynamic nodes (`pipeline` and `repeatUntil`) still fail explicitly
rather than falling back to an agent chat or an unvalidated interpretation.
Subsequent scheduler changes must preserve this contract, persist every
intermediate boundary, and apply the run budget as an additional ceiling over
node-local concurrency and loop limits.

Write-capable `agent`, `map`, `pipeline`, `reduce`, `verify`, and `repeatUntil`
nodes use the same declared filesystem permission invariant as other workflow
nodes. `condition` and `gate` nodes are always read-only. Until workflow
worktree allocation lands, the runtime rejects every write-capable executable
node, including `map`. This contract does not authorize writes to Primary.
