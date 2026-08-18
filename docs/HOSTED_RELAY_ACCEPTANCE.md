# Hosted relay acceptance ledger

This ledger maps Cantrip's hosted-relay guarantees to repeatable evidence. It
is a release-candidate checklist, not a substitute for an operator's threat
model, capacity test, or backup rehearsal.

## Automated gate

Run from a clean checkout with the repository-pinned pnpm version:

```bash
pnpm check
pnpm audit:server-boundaries
export CANTRIP_VERSION_PATCH="$(git rev-list --count HEAD)"
docker compose --env-file deploy/hosted.env \
  -f deploy/compose.hosted.yml config --quiet
```

`pnpm check` verifies pinned Codex and Cantrip Code sources, type-checks every
workspace, runs the server, worker, protocol, app, extension, and release-script
test suites, checks formatting, and rejects stale generated boundary evidence.
The checked-in route inventory must report zero `legacyLocalOwnerRoutes`.

## Guarantee matrix

| Guarantee                                                                                  | Primary automated evidence                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anonymous loopback remains zero-auth                                                       | `local-foundation.test.ts`, `config.test.ts`                                                                                                     |
| Password and account sessions, CSRF, expiry, and revocation                                | `auth-service.test.ts`, `auth-api.test.ts`, `live-api.test.ts`                                                                                   |
| Cross-account HTTP and live-resource isolation                                             | `tenant-authorization.test.ts`, `live-hub.test.ts`                                                                                               |
| Independent worker enrollment, rotation, revocation, and ID binding                        | `worker-enrollment-api.test.ts`, `worker-bridge-surface.test.ts`                                                                                 |
| Provider and MCP secrets are encrypted and redacted                                        | `provider-secret-encryption.test.ts`, `mcp-secret-encryption.test.ts`, `secret-vault.test.ts`                                                    |
| Hosted origin, proxy, cookie, size, and startup rules fail closed                          | `http-hardening.test.ts`, `config.test.ts`, `abuse-limits.test.ts`                                                                               |
| Project replicas use explicit placement, guarded synchronization, and expiry-fenced replay | `project-placement-api.test.ts`, `project-replica-jobs.test.ts`, `project-replica-executor.test.ts`                                              |
| Managed folders remain owner-bound, non-Git, durable offline, and explicitly convertible   | `project-folder-api.test.ts`, `managed-folders.test.ts`, `task-domain.test.ts`, `workflow-execution.test.ts`, app managed-folder component tests |
| Chat relocation hydrates safely, commits atomically, and recovers only expired claims      | `chat-relocation-jobs.test.ts`, `chat-relocation-api.test.ts`, `chat-relocation-executor.test.ts`, `chat-relocation-dialog.test.tsx`             |
| Code, project-share, browser, desktop, terminal, and generic tunnels remain server-routed  | `code-tunnel.test.ts`, `project-share-tunnel.test.ts`, `remote-surface-relay.test.ts`, `tunnel-control-plane.test.ts`, `tunnel-runtime.test.ts`  |
| Two server replicas route worker commands and live invalidations through Redis             | `shared-relay-coordination.test.ts`                                                                                                              |
| A rolling server startup preserves transient state owned by an existing peer               | `coordinated-startup-recovery.test.ts`                                                                                                           |
| Account/worker quotas reject excess work visibly                                           | `abuse-limits.test.ts`, `managed-relay-telemetry.test.ts`                                                                                        |
| Security activity, probes, and metrics omit product content                                | `audit-events.test.ts`, `http-hardening.test.ts`, `managed-relay-telemetry.test.ts`                                                              |
| Scheduled workflow and project-automation occurrences are leased and fenced                | `workflow-trigger-api.test.ts`, `project-automation-api.test.ts`                                                                                 |
| In-flight workflow attempts renew, expire, recover, and dispatch with account attribution  | `workflow-execution.test.ts`, `workflow-executor-coordination.test.ts`                                                                           |
| Migration and packaged-runtime contracts remain usable                                     | migration tests under `cantrip_server/test`, `bundled-runtime.test.ts`, and release-script tests under `scripts/test`                            |

The route inventory is review evidence rather than a proof by itself. Routes
classified as `application-principal` must derive ownership from the request
principal; `worker-control` routes must authenticate an independently revocable
worker credential (except the one-time enrollment exchange); and capability
surfaces must bind their bearer token to the account, worker, and resource.

## Practical release-candidate smoke

Before a public deployment, exercise these flows against the exact artifacts
and proxy configuration being released:

1. Start `pnpm dev`; create a local project and use chat plus a terminal without
   signing in.
2. Start `pnpm devtop`; repeat chat, terminal, Code, browser, and remote-desktop
   attachment flows inside the desktop shell.
3. Start the hosted Compose stack with PostgreSQL and Redis, create two accounts,
   and verify each account sees only its own workers, projects, chats, providers,
   audit events, and live updates.
4. Enroll two workers for one account. Rotate and revoke one credential, attempt
   a reconnect with the old secret and another worker's ID, and verify rejection.
5. Prepare one repository replica on each worker. Route new terminals, Explorer,
   Code, browser/desktop surfaces, and automations to each placement; then take a
   worker offline and verify server-owned history remains readable while its
   live surfaces become unavailable.
6. Create two managed folders with the same display name on one enrolled
   worker, one from a remote browser/mobile-sized client and one from Tauri.
   Verify both have distinct UUID paths; Agent, Task, Terminal, Explorer, Code,
   Browser, Remote Desktop, tunnel/share, script automation, and a direct
   parallel write workflow use only that worker; and no Git, Issues, PR,
   release, worktree, replica, relocation, or open-issue control appears. Take
   the worker offline and verify history remains readable while filesystem
   actions fail explicitly, then reconnect and verify live recovery. Unlink one
   folder and confirm its files remain. On the other, select file deletion and
   verify the checkbox is followed by a second warning before the exact folder
   is removed. Finally convert a third folder through the explicit new/empty
   GitHub repository flow and verify a local `git init` alone never converts it.
7. Run two server replicas, connect the app and worker through different
   replicas, and verify commands, cancellation, binary tunnels, and live
   invalidations cross the shared relay. Kill one replica during both a replica
   job and a chat relocation. Verify the surviving process does not steal a
   fresh claim, then recovers it after expiry with a higher attempt; verify the
   former holder cannot publish a late completion.
8. While one replica owns an active chat, workflow attempt, Remote Desktop, and
   tunnel attachment, start another replica. Verify none of those records is
   reset or orphaned and the active operations continue through the peer.
9. Trigger one scheduled occurrence during a rolling server restart and verify
   exactly one durable run is accepted.
10. Kill a server during a silent and an approval-waiting workflow attempt. Verify
    a live peer leaves each fresh heartbeat alone, recovers it only after the
    stale window, publishes the owning account's invalidation, and rejects the
    former holder's late completion.
11. Back up PostgreSQL, the encryption keyring, and a quiesced worker data
    volume containing a managed folder. Restore into an isolated deployment,
    migrate, and verify account login, worker metadata, chat history, one
    secret-backed provider, and the managed folder's contents.

Record the release version, commit, platform artifacts, proxy/TURN configuration,
and pass/fail result outside the repository. Do not record credentials, prompts,
terminal output, source content, or raw capability URLs.

## Current capability boundary

Bootstrap flags are conservative. Multi-worker enrollment, placement, replica
provisioning, and exact-revision synchronization are advertised only when their
complete server configuration is available. Durable chat relocation is
advertised now that the server and worker implement context handoff, target
hydration, atomic placement commit, replay, fencing, and recovery, and the app
provides explicit target selection, safety reasons, progress, retry, and
cancellation controls. Cantrip never treats equal project IDs as equal files or
silently moves dirty worktrees, active turns, PTYs, or uncommitted state.

Managed folders advertise their own additive worker capability. They are
available to remote web, Tauri, iOS, and Android clients through the same server
API, but source access always routes back to the owning worker. They never
advertise replica, relocation, worktree, Git, or GitHub capability before an
explicit completed GitHub conversion.

Operational configuration, migration, backup, recovery, quotas, Redis failure
semantics, and incident response are documented in
[HOSTED_DEPLOYMENT.md](HOSTED_DEPLOYMENT.md). Trust boundaries and the generated
inventory are documented in
[HOSTED_SECURITY_ARCHITECTURE.md](HOSTED_SECURITY_ARCHITECTURE.md).
