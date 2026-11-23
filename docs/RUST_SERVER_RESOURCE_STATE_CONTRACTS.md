# Resource state and repository reconciliation

Rust preserves an owned model's explicitly null reasoning default separately
from a missing model. This milestone reconciles the remaining 24 repository
identities and refreshes the historical partial Chat execution-context entry.
The ledger now accounts for all 370 identities, including five explicit obsolete
private-helper dispositions. Complete server replacement acceptance remains open.
The base is `f5a5282c07e92e48f6e356a82b3182372654d5c9`.

## Model defaults and current helpers

The retained failing comparison reproduces the null/missing difference on all
three stores. The reference returns null for an owned model with no default and
undefined when no owned model exists. The native getter now returns nested
Options to preserve those two states. Its two HTTP callers explicitly flatten
them, matching the reference callers' existing null coalescing.

Actual column rename exercises model-default query failure without deleting
rows. Repository reads fail and preserve exact durable state. The public settings
reasoning route returns the same redacted HTTP 500 and request ID contract, then
recovers after the column is restored. No speculative query or startup gate is
added.

`getChatModelConfiguration`, `setChatReasoningEffort` and
`setChatReasoningEffortAndRememberDefault` have no current named production
callers. Occurrences in active source are their facade declarations/forwarding
and child definitions. Current public model/reasoning routes use execution
context and the atomic full-configuration setter. These three dispositions do
not retire those routes or claim separate native implementations of unused
private helpers. In particular, the old RememberDefault helper does not update
the model default despite its name.

## Executed repository comparisons

| Paired cases                           | PGlite | Private PostgreSQL | External PostgreSQL | Total |
| -------------------------------------- | -----: | -----------------: | ------------------: | ----: |
| Current resource state and context     |    113 |                113 |                 113 |   339 |
| Terminal repository and layout         |     87 |                 87 |                  87 |   261 |
| Remote-surface state and bootstrap     |     52 |                 52 |                  52 |   156 |
| Managed preparation and linked console |     59 |                 59 |                  59 |   177 |

The new resource suite retains before/after SQL across sixteen domains and eight
actual close/reopen comparisons per store. It exercises Task creation defaults,
independent Chat/Task model configuration, runtime/lane bindings, duplicate
identity, pause revisions, queue notifications, completion/unread transitions,
project ordering and all six project-tab position sources. Negative maxima,
empty tables and archived Chat exclusion retain their actual source meanings.

Real constraints fail Task insertion after the Chat/runtime/lane writes, queue
updates after the Chat pause write, and project ordering after an earlier row
update. Both peers roll back the entire respective transaction and retain exact
rows and clocks. Remote-surface cases retain opaque state and CAS revisions,
reject stale writes, roll back failed desktop/pane creation, and preserve the
canonical view and pane when only its remote surface is deleted.

The existing complete context adapter now has explicit project, Task and
standalone DTO comparisons, active runtime/lane bindings, ownership, archive
exclusion and retained restart. This supersedes the old Live-authorization-only
partial mapping. It uses the production Chat repository rather than reproducing
its projection in the fixture.

Generated runtime, lane and pane identities are verified before relating them
across isolated databases. Write clocks must belong to the actual run. Rejected
operations and reopen comparisons require exact retained values. Raw results,
including earlier fixture setup failures, remain in the evidence.

## Public callers and artifact

All nine storage/authentication cells pass each of these current comparisons:

- Terminal management, worktree movement/deletion, linked consoles, Live and
  WorkerLink: 1,862 paired HTTP observations.
- Chat customization, model/reasoning, permissions and Plan: 1,695 paired HTTP
  observations, including actual model query failure/recovery.
- Remote surfaces, desktops, competing CAS writes, caller loss and transport:
  624 paired HTTP observations.
- Managed preparation: 48 paired product assertion groups, with controlled
  worker replies and durable console identity checks.

The optimized executable separately passes 308 paired configuration HTTP
observations across all three authentication modes using external PostgreSQL.
Direct SQL clients supply fixture controls; both production entries reject the
SQL test HTTP route with 404. All six server exits are zero.

The relocated macOS arm64 `1.1.2796` distribution passes all three stores,
retained writes, restart, export/migration launchers and shutdown with Node
absent from the server PATH, Homebrew reads denied and artifact writes denied.
All 1,762 manifest files and the supplied distribution notices are retained.
The executable is 94,223,680 bytes with SHA-256
`d85e4dd9a461097161081e0c42d82f64e971d2dc9cb180e1219379c9ee7d4bcb`.

## Validation and remaining acceptance

Strict all-target Clippy, Rustfmt and all 86 Rust library tests pass. The focused
script selection passes 74 tests with one existing Windows-only skip.
Regenerating current contract assets changes none of the 38 tracked contract
files. The full `pnpm check` fails in two worker capacity/backoff tests; both
failures reproduce on clean Primary at this base. The aggregate is not green.

[The evidence summary](security/rust-server-resource-state-acceptance.json)
records report hashes, successful method case indices, obsolete-helper source
occurrences, artifact identity and the actual validation scope. The delivery
directory is `rust-server-resource-state-delivery-20261110-v1`; owned cleanup
requires independent archive verification.

All repository identities are accounted for within these recorded scopes.
Operation mappings still cover 110/135 tables, 523/584 routes, 117/323 worker
commands and 29/47 Live resources. Their unmapped and historical partial entries,
final supported-platform artifacts, integrated upgrades/post-write rollback and
the original goal audit remain open. These counts are evidence mappings, not
engineering completion percentages. No new Windows/Linux, full worker/UI or
production Winterhold deployment result is claimed. Worker rewriting and shared
crate extraction remain future work. Development validation uses local compute.
