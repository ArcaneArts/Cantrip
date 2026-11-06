# Instance lifecycle

Retained-instance power operations are distinct from desktop lifecycle, workspace
reset, system/image replacement and optional-package upgrades. Stopping a Docker
container retains its writable layer and attached volumes. Recreating it from an
image has different preservation semantics.

## Retained Docker carrier checkpoint

The shared `@cantrip/os-host` library exposes `changeRetainedContainer` and
`observeRetainedContainer`. The owning Worker must supply an already authorized
immutable Docker container ID; a transport name alone is not sufficient admission.
This library does not authorize an owner, attach a guest or imply SSH power-on.
Server and Worker now own lifecycle admissions and observation; client controls
remain a subsequent step.

An input contains `operationId`, `action` (`start`, `stop` or `restart`),
`container`, `expectedContainerId` and a private Worker-owned `journalPath`.
The shared instance lock serializes it with existing Docker recreation. A complete
private journal is exclusively reserved and synced before dispatch. Docker's
actual named target must still have the admitted ID; the mutation then addresses
that ID directly. No container is created, removed or substituted, and no image
or volume is replaced.

Repeating an admission only observes it. A changed target/action cannot reuse the
same journal. After a lost reply, observation can reconcile the actual desired
carrier state; restart additionally requires a different container start time.
The receipt distinguishes acknowledged-and-observed completion from completion
inferred by observing the requested state. It does not claim causation for
out-of-band owner actions or that the guest integration is ready.

When dispatch never began, the saved operation reports that fact without sending
a new request. An unverified transition remains unknown. A damaged journal cannot
authorize a replacement operation or manufacture a completion. Saved failures are
not retried automatically. A historical completion remains historical when the
container is subsequently stopped or removed; current observation/error is
returned separately. Helper readiness and fresh runtime authority still require
an actual guest observation through the existing management path.

## Current checks

Run the foundation tests:

```sh
node --test cantrip_os/tests/*.test.mjs
```

The actual retained-container test uses a disposable, already running instance:

```sh
CANTRIP_OS_TEST_RETAINED_CONTAINER=cantrip-os-lifecycle-test \
  node --test cantrip_os/tests/retained-lifecycle.integration.test.mjs
```

This test interrupts all managed work in that instance. It writes unique root
configuration and persistent-volume sentinels, stops/starts the same container,
compares their bytes/modes and the actual package inventory, then performs a real
restart whose receipt is deliberately dropped. Observation and repeated admission
must not issue another restart. The container ID, image and mounts must match.
Finally the test ensures the retained instance is running; its proof files and
private operation journals remain available for inspection.

The recorded local Docker test is a carrier-level checkpoint. Full Worker failure,
client lifecycle controls, independent desktop stop/restart, reset,
image preservation and failed-upgrade recovery remain required for Phase 5.

## Server-owned power admissions

Both Server implementations expose the same owner-scoped endpoints:

| Method | Route                                                               | Behavior                                                 |
| ------ | ------------------------------------------------------------------- | -------------------------------------------------------- |
| GET    | `/api/cantrip-os/:instanceId/power`                                 | Current supported carrier and observation                |
| POST   | `/api/cantrip-os/:instanceId/power-operations`                      | Admit once or observe the identical saved request        |
| GET    | `/api/cantrip-os/:instanceId/power-operations`                      | Paginated operation history                              |
| GET    | `/api/cantrip-os/:instanceId/power-operations/:operationId`         | Saved historical result                                  |
| POST   | `/api/cantrip-os/:instanceId/power-operations/:operationId/observe` | Reconcile the original admission without mutation replay |

The create body contains `operationId`, `action`, `attachmentGeneration` and
`targetGeneration`. Clients do not provide a Docker ID, private transport, guest
success receipt or execution scope. Retain this exact request if its outcome is
uncertain. A reused ID with changed content is rejected. Missing Worker records
remain unknown; reconciliation does not recreate the operation.

An actual owned guest refresh discovers the local Engine's immutable container
ID. The Worker pins guest observation to that ID and verifies the ID/start time
again before returning it. The Server stores this pin privately. The same retained
container keeps its power target across runtime changes; replacement or reattachment
requires a new target generation. SSH attachments do not advertise power control.
A valid Docker CLI transport without a local Engine can still observe its guest.

New power admission fences instance execution before Worker dispatch. Refresh and
recovery checks cannot remove that fence while an operation is active or uncertain.
A private monotonic power epoch also rejects delayed guest observations that began
before a subsequently completed power operation. A fresh owned guest observation
is required to establish readiness afterward. Power success itself never grants
fresh runtime, source, chat, desktop or input authority.

The Worker keeps private operation and carrier journals outside the guest helper.
Start and observation therefore remain available while the container/helper is
stopped, subject to the recorded carrier and owning Worker being available.
Completed and definitely failed history survives current Engine unavailability;
current state is observed separately. Public projections omit physical Docker IDs.
A history cursor uses the stored database timestamp and operation ID, preserving
ordering even when two records fall within one JavaScript millisecond.

Run the actual Worker Manager acceptance against a disposable attached instance:

```sh
CANTRIP_OS_TEST_CONTAINER=cantrip-os-lifecycle-test \
  pnpm --filter @cantrip/worker exec vitest run test/os-power.integration.test.ts
```

This interrupts that instance. It exercises actual stop/start, a completed restart
with a dropped response, a fresh Manager reading saved jobs, unchanged root bytes
and mode, fresh guest runtime observation, and no second restart POST. It does not
establish full Worker-process failure or client acceptance. Client lifecycle
controls, service/viewer/input cleanup and the broader Phase 5 matrix remain next.
