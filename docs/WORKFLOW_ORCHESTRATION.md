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
| `agent`       | One Codex prompt with optional developer instructions and structured-input inclusion.                                                |
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

The type-specific contract is intentionally landed before the multi-node
scheduler. Until the corresponding orchestration slice is present, unsupported
node types fail explicitly rather than falling back to an agent chat or an
unvalidated interpretation. Subsequent scheduler changes must preserve this
contract, persist every intermediate boundary, and apply the run budget as an
additional ceiling over node-local concurrency and loop limits.

Write-capable `agent`, `map`, `pipeline`, `reduce`, `verify`, and `repeatUntil`
nodes use the same declared filesystem permission invariant as other workflow
nodes. `condition` and `gate` nodes are always read-only. Worktree allocation
and write-lane leasing are defined separately by the workflow worktree
milestone; this contract does not authorize writes to Primary.
