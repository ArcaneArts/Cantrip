# Current OS, repository and Run execution contracts

The server replacement remains incomplete. This milestone qualifies current
CantripOS source/backup HTTP operations and protected repository routing, plus
additional worktree/Run worker commands, durable Run state and Live resources.
The worker remains Node. All development validation runs locally.

The comparison uses current reference-server source and a frozen Rust executable
from base `7ca2cdca4` plus the recorded production fixes. Both peers use the
unchanged worker connection protocol with controlled OS/Git/Run responses. Each
suite runs anonymous, password and account authentication against PGlite,
private PostgreSQL and external PostgreSQL: nine cells per suite.

The OS comparison exercises 399 paired HTTP observations. Provisioning and
backup each complete on the controlled worker, lose their acknowledgement, and
recover after an actual server shutdown and worker reconnect. Retrying observes
the original operation; each mutation is dispatched once. Reopening canonical
storage retains one provision admission, one backup operation and the exact
original encrypted requests. Endpoint code decrypts the retained backup result.
The comparisons perform 72 endpoint cryptographic proofs across both peers.
Private source/backup content is absent from public responses and diagnostics.

Both void and observed attachment acknowledgements reach a fresh authoritative
inspection. Reattachment rotates its generation while retaining instance and
workspace identity. Wrong guest/owner observations cannot dispatch attachment
mutations. Stale Run selections, wrong project, wrong operation ID/type, failed
worker replies and mismatched source receipts preserve the reference errors.
An uncertain attachment clears the observed runtime generation; provisioning
cannot dispatch until an authoritative refresh restores it, without repeating
the original provisioning mutation.

These tests found and repaired actual Rust differences:

- Attachment incorrectly required an observed-instance reply before refreshing;
  the reference accepts a void acknowledgement and then inspects actual state.
- Run definitions parsed an action-specific reply before checking routing. The
  reference validates the full response union and explicitly rejects a different
  project, operation identity or operation type.
- Known placement/source errors lost their public text behind a generic error.
  Typed placement errors now retain the reference messages. Unexpected worker,
  validation and database errors retain their bounded public fallback.

The project/Git comparison adds 1,089 paired HTTP observations. It exercises
protected repository operations, usage attribution, worktree changes, Run
start/restart/stop, concurrent admission/replay, worker reconnect, output
identity checks, Run definitions and protected secret revisions. Canonical
storage reopen compares current runtimes, original operation receipts, secret
values and secret-operation digests. Replaying revision 1 preserves the current
secret at revision 2 with exactly two receipts. Retirement removes 260 persisted
runtimes/terminals across the page boundary while retaining its stop receipt.
Persisted runtime exit clocks are independently bounded before semantic
comparison, and raw clock values remain in the evidence.

Actual Live publications qualify Run invalidations, Run configuration
invalidations, repository token usage and CodeGraph status. The latter rejects
foreign/missing worktrees, suppresses duplicate fingerprints and advances its
revision on changed observations. The acceptance record links exact report
pointers and actual successful HTTP trace identities for every mapped cell.

[The acceptance record](security/rust-server-os-execution-acceptance.json) adds
nine routes, fifteen server-produced worker commands, four durable tables and
four Live resources. The ledger maps 581/584 routes, 156/323 commands, 118/135
tables and 36/47 Live resources; all 370 repository identities were previously
accounted for. These are evidence counts, not a completion percentage.
Three internal HTTP identities remain unmapped: suspension execution, Task Goal
cycle dispatch and Task Goal outcome. Remaining command/table/Live identities,
historical partial scopes and final integrated shipping acceptance remain open.

The controlled workers do not execute actual guest archives, Git filesystem
mutations or native runtime processes. The two OS restarts exercise durable
server recovery while retaining the controlled worker's completed operation
journals in the test process. This is not a new full worker/UI, Linux/Windows,
shared deployment, final package or production Winterhold qualification.

All 86 Rust library tests, strict all-target Clippy and Rustfmt pass. The full
`pnpm check` still fails in two worker capacity/backoff tests: 744 pass, two fail
and two unhandled errors are reported. Both failures reproduce on clean Primary
at the exact milestone base. Repository formatting reports the same twelve
pre-existing files; none is changed by this milestone. The aggregate is not
green. Earlier failed fixtures, incomplete PostgreSQL asset restoration and
actual pre-fix Rust mismatches are retained separately.

Run either comparison with `node --import tsx
scripts/server-rust/cantrip-os-http-compatibility.mjs` or
`scripts/server-rust/project-git-http-compatibility.mjs`, selecting `--database`
and `--report`. Both support frozen server/repository fixture overrides and
`--keep-fixture`. Trace capture uses the existing opt-in HTTP diagnostic import.
The retained evidence directory is
`rust-server-os-execution-delivery-20261110-v1`.
