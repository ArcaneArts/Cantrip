# AppLive polling audit

Audited on 2026-08-21 after the CodeGraph, redundant-query, chat sync, log
streaming, Git state, and provider-auth AppLive phases.

> Historical audit note: the durable workflow app/API, server
> scheduler/executor, and worker handlers were removed after this audit. Current
> source has no workflow publisher or subscriber, and the server rejects the
> protocol's residual `workflow-run` scope. Workflow references below describe
> the then-existing surface.

## Result

Every repeating app query that reads durable server or worker state is now
disabled while its AppLive scopes are healthy. HTTP remains the source of the
initial snapshot and the bounded fallback when AppLive is degraded. The final
cleanup added precise live invalidations for:

- account-session connection presence;
- project automation creation, edits, deletion, claims, and dispatch results;
- coalesced project token-usage changes; and
- worker enrollment completion, using the existing worker-presence event.

The token-usage invalidation is coalesced to at most one publication per
project every ten seconds during an active attempt and is flushed immediately
when the attempt reaches a terminal state. Live events carry no usage detail or
automation content; clients fetch the authorized server-owned summary.

## Remaining polling classifications

### Initial snapshot, degraded fallback, or reconciliation

- Project, worktree, surface, chat, task, CodeGraph, Git operation,
  Git conflict, provider-auth, project automation, token-usage, account-session,
  and worker-management queries poll only when AppLive is not healthy.
- The remote log viewer reads one backlog, streams by cursor while connected,
  and uses bounded HTTP catch-up/backoff only after a stream gap or failure.
- Code workbench readiness checks every 500 ms for at most 30 seconds after a
  new attachment. This is a bounded startup reconciliation, not steady-state
  polling.
- Worker enrollment status retains its one/1.5-second HTTP fallback only while
  AppLive is degraded and the enrollment remains pending.

### Local desktop/native behavior

- Desktop worker discovery and local service-log discovery run every five
  seconds only in Tauri.
- Desktop tunnel forwarding inventory runs every five seconds against the
  local Tauri runtime.
- Direct Code attachment health checks validate a local direct route and fall
  back to the relay after repeated failures.
- Worktree, CodeGraph, process-supervisor, and desktop capture timers observe
  worker-local processes or files and publish changes; they do not poll an app
  HTTP read endpoint.

### Large, paginated, or on-demand reads

- Git history, conflicts and file stages, repository statistics, GitHub
  listings, customization inventories/resources, attachment content, and
  browser/desktop frames remain explicit or paginated reads.
- UI clocks, clipboard notices, reconnect delays, heartbeats, stream feedback,
  lease renewal, expiry sweeps, and executor recovery timers are not state
  polling.

### Deferred protocol upgrades

- `observeCustomizationStatus` in the server still reads pending MCP OAuth and
  external-import status from the worker at one second, with a bounded
  15-minute lifetime and exponential error backoff. Removing it safely needs a
  correlated worker notification with chat/provider ownership validation,
  bounded observation retention, reconnect replay, and terminal expiry. It is
  not suitable for a low-risk polling cleanup because a bare notification
  would allow one runtime's status to be attributed to the wrong chat.
- The worker automation scheduler fetches its authorized schedule every ten
  seconds. This is execution discovery and crash/offline recovery rather than
  a client read or a server-to-worker command. Replacing it requires a durable
  server-to-worker scheduling protocol with missed-run recovery and fencing;
  the existing database lease remains authoritative meanwhile.

These deferred paths should be separate protocol milestones. Neither is a
reason to restore aggressive client polling or relax request rate limits.
