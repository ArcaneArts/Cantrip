# Cantrip stability pass

Started 2026-10-13 from `692f05dcd`. Each milestone uses an isolated
`codex/` branch and worktree, a squash auto-merge PR, observed merge, and cleanup.
Tests run independently of metadata audits. A skipped check is never a pass.

| Milestone                                 | Status      | Branch / PR                                                                                 | Evidence                                                                                            |
| ----------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1. Lease renewal and reconnect scheduling | Merged      | `codex/stability-lease-recovery` / [#2092](https://github.com/ArcaneArts/Cantrip/pull/2092) | Three regressions fixed; 135 app + 25 worker tests pass; Windows/macOS/Linux CI passed.             |
| 2. Shared editor lifecycle and readiness  | Not started | —                                                                                           | Late readiness, retained frames, startup stages, and cancellation.                                  |
| 3. Browser recovery harness               | Not started | —                                                                                           | Actual bundled editor, isolated services, automated failure injection and usable-editor assertions. |
| 4. Measured editor loading                | Not started | —                                                                                           | Comparable cold/warm/recovery measurements; implement only demonstrated improvements.               |
| 5. Worker command dispatch                | Not started | —                                                                                           | Typed feature handlers with explicit ownership and dependencies.                                    |
| 6. App API modularization                 | Not started | —                                                                                           | Domain clients with compatible public exports and shared security infrastructure.                   |
| 7. Codex runtime decomposition            | Not started | —                                                                                           | Separate transport, turn lifecycle, subagents, normalization, and interactions incrementally.       |

## Milestone 1

The existing terminal, remote-surface, and shared WorkerLink clients closed
healthy channels after one transient renewal failure. All three failures were
reproduced with fake-clock regression tests before integrating the fix.

A shared renewal controller now retains the original authorization deadline,
retries transient failures, bounds each request, aborts on owner retirement,
ignores late responses, and closes on explicit rejection or expiry. Renewed
leases cannot extend the original absolute expiry. Shared sessions retain
healthy sibling streams while renewal is retried.

LOCAL capability activity retries are separately bounded because the legacy
telemetry acknowledgement does not return a new lease. The worker broker
continues to enforce its installed capability deadline; the client invents no
new authorization. Browser/native retries and worker reconnect backoff use
bounded jitter. The original worker disconnect-grace deadline remains intact.

Automated verification covers transient failure/success, repeated failures,
hung requests, hard expiry, HTTP authority denials, cancellation and late
responses, client identity retirement, shared sibling channels, LOCAL renewal,
and reconnect jitter. A dedicated Windows/macOS/Linux CI workflow runs the
behavioral recovery suites directly.

Validation:

- Focused app recovery: 135 passed across seven files.
- Worker reconnect/authentication and project-share transport: 25 passed.
- App and worker typechecks passed.
- Full app suite: 2,995 passed, three skipped, one existing settings-search failure.
  The same settings test fails against unmodified main (22 passed, one failed).
  Tracked in [#2091](https://github.com/ArcaneArts/Cantrip/issues/2091) for milestone 3 baseline repair.
- Workflow-removal audit and diff/format checks passed.
- `pnpm check` stops at the existing decomposition budget described below.

Browser acceptance is scheduled for milestone 3; no browser result is claimed
for this milestone.

## Baseline and blocked work

`pnpm check` is attempted for each milestone. The starting baseline stops at
`cantrip_server/src/app/runtime/task-routes.ts`: 2,000 lines against the 1,999-line
decomposition budget. This does not suppress focused behavioral tests.

No milestone is currently blocked or skipped. Concrete blockers receive bounded
resolution attempts, an evidence-backed tracker issue when independently
actionable, and an explicit ledger entry before unaffected work continues.

## Milestone 2

Working from merged milestone 1 (`6bf1c7b7d`). CodeView readiness and hidden-frame regressions are being reproduced before extracting common frame lifecycle behavior. Existing serialized attachment retirement and generation fencing remain shared.
