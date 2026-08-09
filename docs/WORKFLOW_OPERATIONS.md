# Workflow operations

This guide covers the shipped local single-user workflow control plane. The
workflow engine is a Cantrip Server feature above Codex App Server; it is not a
second agent runtime. Read [Workflow orchestration](WORKFLOW_ORCHESTRATION.md)
for the domain and execution contract and
[ADR 0004](adr/0004-codex-native-workflow-control-plane.md) for the ownership
decision.

## Safe operating boundary

Cantrip's current supported deployment is the loopback local stack. Standalone
server mode may be used only on a trusted private network or behind an
authenticating reverse proxy. `CANTRIP_ALLOW_INSECURE_REMOTE=true` is an explicit
acknowledgement, not an authentication mechanism. Do not expose operator API,
Git-event, worker, or workflow routes directly to the public internet.

The scoped webhook route is the one trigger surface with its own credential.
The workflow center hashes that credential in the client; the server stores only
the SHA-256 hash and compares deliveries in constant time. The normalized Git
route is intended for a trusted Cantrip/provider adapter, not as a raw GitHub
webhook receiver and not as GitHub HMAC-signature validation.

## Create and review a workflow

1. Open a project's settings and select **Workflows**.
2. Create a project or personal workflow. Definitions and revisions are
   immutable, constrained JSON graphs; editing appends a revision.
3. Review its graph, declared schemas, defaults, permission requirements, source,
   and provenance.
4. Leave generated, repository-imported, and Claude-translated revisions
   untrusted until the representation is understood.
5. Run manually and review the input, budget, and permissions before launch.

Codex-assisted generation uses a separate read-only workflow-owned thread and
returns an unpersisted preview. Saving the preview is a distinct operator action.
Unsupported JavaScript or TypeScript import material may be supplied to that
conversion flow as inert text, but Cantrip never imports or executes it.

## Run supervision and recovery

The workflow center lists durable runs and node state, structured attempts,
usage, Codex thread/turn attribution, worker and worktree attribution, approval
gates, and recovery errors. Available actions depend on durable state:

- Pause stops dispatch at a durable boundary; active turns finish or interrupt
  according to the operation already in progress.
- Resume requeues available work without replaying completed nodes or item
  ledgers.
- Cancel interrupts active turns and terminalizes undispatched work.
- Retry is explicit for eligible failed or orphaned work and has its own
  idempotency key and attempt budget.
- Gate decisions are idempotent. A cancelled, expired, or already resolved gate
  rejects a conflicting response.

A server restart preserves definitions, run graphs, gates, schedule clocks,
item/pipeline/repeat ledgers, and worktree outcome intents. In-flight attempts
are never assumed successful; they become recoverable/orphaned state. A worker
reconnect resumes durable worktree transitions and available queued work. A
Codex process failure rejects its live request, clears volatile runtime state,
and the worker lazily starts a new App Server process on the next operation;
durable workflow retry policy still decides whether an interrupted node may run
again.

The app keeps no authoritative workflow state. Reopening or reconnecting it
reloads definitions, runs, gates, triggers, and event pages from the server and
then follows active runs through the application live channel. If that channel
is unavailable, bounded 1.5–2 second active-run snapshots preserve convergence.
Closing the app does not cancel server-owned work.

## Write-capable workflows

Write nodes never mutate an arbitrary app-selected path. The server reserves a
worker-owned workflow worktree identity, the worker creates and verifies it
against the project Git common directory, and the server activates an exclusive
lease before dispatch.

Successful write work checkpoints its starting and ending revision, dirty
state, and produced-change summary. The operator then chooses an explicit lane
outcome:

- **Keep** retains the checkpointed lane for inspection.
- **Deliver** records delivery and releases Cantrip's lease without deleting the
  Git branch.
- **Discard** removes only an unchanged, verified managed lane.
- **Release** releases an unchanged lane without removing it.

Outcome intents are persisted before worker mutation and replay after a server
restart or worker reconnect. Revision drift, dirty state, mismatched identity,
active tabs/terminals/chats, Primary, and unapproved external worktrees fail
closed.

## Configure automation

Only a `trusted` definition and revision whose revision and every node use
`preauthorized` approval mode can create or enable an unattended trigger. The
workflow center creates every trigger disabled and snapshots the selected
revision's defaults, budget, and permission manifest. Review the trigger, then
use its explicit **Enable** action.

### Schedules

Schedule intervals are at least 60 seconds and persist their next due time.
Choose one recovery behavior for each dimension:

- Missed intervals: run once after recovery or skip an overdue interval.
- Worker offline: pause delivery and retry later or create one durable queued
  run.

The scheduler uses compare-and-set clock updates and the due timestamp as its
idempotency key, so a restart between run creation and clock advancement does
not launch twice.

### Cantrip API

Deliver an API trigger through the local operator API:

```http
POST /api/workflow-triggers/<trigger-id>/deliver
Content-Type: application/json

{
  "idempotencyKey": "caller-stable-delivery-id",
  "structuredInput": { "ref": "main" }
}
```

Reuse the same idempotency key only for the same logical delivery and payload.
A new delivery inside the trigger's minimum interval returns `429` with
`Retry-After`. The current operator API inherits local deployment security; it
is not a public bearer-token API.

### Scoped webhook

Send a configured credential in `X-Cantrip-Webhook-Token`:

```http
POST /api/workflow-hooks/<trigger-id>
X-Cantrip-Webhook-Token: <credential>
Content-Type: application/json

{
  "idempotencyKey": "provider-delivery-id",
  "structuredInput": { "ref": "main" }
}
```

Bad credentials receive the same not-found response as an unknown trigger. The
credential, hash, and delivery payload are not copied into run provenance.

### Normalized Git or GitHub event

A trusted adapter may deliver a normalized event to a specific Git trigger:

```http
POST /api/workflow-triggers/<trigger-id>/git-event
Content-Type: application/json

{
  "event": "push",
  "branch": "refs/heads/main",
  "deliveryId": "provider-delivery-id",
  "structuredInput": {}
}
```

The configured event and bounded `*` branch pattern must match before the
delivery is claimed. The provider delivery id, normalized event, and branch are
audited. This route is a local/trusted adapter surface; direct public GitHub
webhooks require a future authenticated provider integration with native HMAC
verification.

### Saved command

An enabled saved-command trigger appears in chat autocomplete as
`/command/<key>`. Selecting it calls the trigger-specific invocation endpoint
with a fresh idempotency key and opens the workflow center for the launched run.
Disabling the trigger removes it from autocomplete after cache refresh.

## Abuse and secret controls

- Every trigger has a durable minimum delivery interval.
- Trigger delivery is idempotent per trigger and delivery key.
- External structured input is bounded by the canonical workflow JSON schema.
- Fields named like secrets, tokens, passwords, credentials, authorization, or
  API keys are rejected recursively before persistence.
- Webhook credentials are never returned by trigger APIs.
- Unattended trust and preauthorization are rechecked at create, enable,
  delivery, and run creation boundaries.
- Any unexpected runtime permission request follows the existing durable
  interaction policy and cannot silently acquire unattended authority.

Do not store secret values in workflow definitions, defaults, trigger inputs,
prompts, or event metadata. Use a native authenticated MCP/app/provider boundary
for secret-bearing operations.

## Migration, backup, and rollback

Workflow persistence arrived through forward-only migrations:

- `0028_wandering_wilson_fisk`: definitions, revisions, run graphs, attempts,
  events, and gates.
- `0030_unique_thunderbird` and `0031_jittery_cerebro`: durable map and pipeline
  item state.
- `0032_absent_stellaris` through `0034_bent_cassandra_nova`: exclusive
  worktree leases and crash-replayable outcomes.
- `0035_yielding_xavin`: automation triggers and delivery history.

Before upgrading a database that matters, stop the server and take a consistent
backup. For PGlite, copy the complete configured server data directory while no
process has it open. For PostgreSQL, use the deployment's normal consistent
backup or `pg_dump` procedure and verify restore separately.

There are no destructive down migrations. Application rollback is safe only to
a version that understands every already-applied schema. To roll back before a
workflow migration, first disable all triggers and stop server/workers, then
restore the pre-upgrade database backup together with the matching application
version. Never drop workflow tables from a live database as a substitute for a
backup restore: they contain run, approval, worktree, and idempotency evidence.

Repository workflow exports under `.cantrip/workflows` are normal project files
and are not removed by a database restore. Review them independently when
rolling application state backward.

## Validation and troubleshooting

The evidence matrix and shipped PR ledger are in
[Workflow implementation audit](WORKFLOW_IMPLEMENTATION_AUDIT.md). Useful
focused checks are:

```shell
pnpm --filter @cantrip/protocol test
pnpm --filter @cantrip/server exec vitest run test/workflow-execution.test.ts
pnpm --filter @cantrip/server exec vitest run test/workflow-trigger-api.test.ts
SHELL=/bin/sh pnpm --filter @cantrip/worker test
pnpm --filter @cantrip/app build
```

Common operator responses:

- **Trigger will not enable:** review definition/revision trust and every
  approval mode; append a corrected revision rather than editing history.
- **Worker offline:** reconnect the owning worker. Paused schedules retry;
  queued schedules remain server-owned.
- **Run recovering:** inspect its failed/orphaned attempt and worktree lease,
  then use Retry or a lane outcome only when the UI offers it.
- **Worktree outcome rejected:** do not force it. Inspect revision drift, dirty
  files, active resource blockers, and the exact lane selected in History.
- **Codex capability unavailable:** inspect the worker compatibility report.
  Optional native features degrade independently; a missing core turn method
  makes the runtime incompatible.
