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
Server and Worker own lifecycle admissions and observation. Cantrip exposes the
same operations in Project Settings → CantripOS → Instance power.

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
acceptance is recorded below. Service/viewer/input cleanup and the broader Phase 5
matrix remain required.

## Client controls and full Worker recovery

Choose an instance in Project Settings → CantripOS. `Check recovery` performs an
owned guest observation and discovers its actual supported Docker carrier, including
existing attachments created before power control was installed. The same private
power epoch and active-operation fence protect discovery and ordinary refresh.

Instance power shows current carrier state separately from Linux readiness. Start,
stop and restart require explicit confirmation that shared workspaces are affected.
SSH-only attachments expose no fabricated power capability. An unknown current
Engine observation is shown as unverified; a known pinned carrier may still receive
an actual operation and return its actual error.

Before submission the client freezes the instance, Worker, attachment, target and
operation ID. It retains the request in session storage scoped to the authenticated
Server/account and instance. Reloading a submitted request never sends another
power mutation. `Observe saved request` reconciles its original Server admission;
missing records or journals remain uncertain. Dismissing a reminder does not cancel
an admitted operation. Paginated history supports observing older admissions.
Changing accounts cannot publish an old response into the new account or clear its
saved request.

Actual Docker product acceptance includes retained root bytes/modes and package
inventory after stop/start. A real Engine restart completed while its response was
held; the full Worker was then killed. After client reload and a new Worker process,
explicit observation recovered the original admission with exactly one restart POST.
The receipt reports observed state rather than claiming acknowledgement. Explicit
guest recovery then distinguished both OS-runtime and Worker-process changes.

Fresh source verification and desktop opening do not retarget old terminals, Runs,
documents or chats. Focusing a Linux desktop uses its captured source for the file
sidebar and new-terminal defaults; a missing/mismatched desktop query leaves that
destination unavailable instead of selecting Host. A stale capture is retained
and fails through the normal source authorization path. Actual editor acceptance
verified guest bytes and the absence of a Host copy after recovery.

Independent desktop controls, held-input and service cleanup, reset/image/upgrade
semantics, current-runtime model acceptance and real remote acceptance remain
separate Phase 5 requirements. These client checks do not claim them complete.

## Guest desktop operation checkpoint

Workspace package 0.4.0 adds generation-bound root administrative operations for
one desktop, independently of instance power. See
[durable desktop administration](packages/workspaces/README.md#durable-desktop-administration)
for `desktop-target`, `desktop-execute` and `desktop-observe`.

The caller retains the exact account/display/generation snapshot and operation
identity before dispatch. The guest atomically reserves and syncs a private journal
before invoking its existing serialized lifecycle commands. Existing admissions
only observe; changed admissions, stale targets and damaged journals cannot mutate
a replacement desktop. Historical completion is returned separately from current
desktop observation. A stopped daemon does not turn saved resume intent into a
running observation; its root CLI can inspect saved history without enabling it.

Actual disposable Docker acceptance covers another desktop and an independent
same-account shell surviving individual stop/start/restart, retained Unicode files,
a lost socket reply, SIGKILL after a real restart but before completion was saved,
and observation without another restart. Disable/removal/purge/reinstall retain
journals and files while the personal desktop remains usable.

These package-owned commands now have Server-owned admissions and Worker routing,
described below. Client controls, actual terminal/Run/CUA/service recovery,
installed-system acceptance and the rest of Phase 5 remain required. No Worker or
model credentials are installed in the guest.

## Server-owned desktop admissions

Both Server implementations expose workspace-scoped desktop observation and
operation history beneath
`/api/cantrip-os/:instanceId/workspaces/:workspaceId`:

- `GET /desktop` observes the captured runtime and records an opaque desktop target.
- `POST /desktop-operations` admits an operation with `operationId`, `action`,
  `attachmentGeneration`, `runtimeGeneration` and `targetGeneration`.
- `GET /desktop-operations` lists history with `limit` and optional `cursor`.
- `GET /desktop-operations/:operationId` reads its retained outcome.
- `POST /desktop-operations/:operationId/observe` observes that exact admission.

The Server resolves the owned workspace account, display and private snapshot.
Clients cannot choose UID, home, transport or guest desktop tokens. The stored
command retains its original scope and transport before dispatch. Repeating a
create observes its original command; changed request content cannot reuse its ID.
Active or uncertain operations fence another admission for the same target.

The Worker runs the root CLI through an authenticated native executor connection
pinned to that account and guest runtime. It journals the original admission and
native process identity before execution. After Worker loss, observation reads the
original guest journal; a missing Worker cache never authorizes execute. An exact
authenticated guest receipt can recover completion even without that cache. Missing
or unverified outcomes remain unknown. Saved completion remains historical when
current observation is unavailable.

Workspace desktop observation epochs reject observations begun before a lifecycle
admission or another successful target observation. An explicit new observation of
a changed actual snapshot rotates its opaque target. It can authorize a new
operation without rewriting or replaying an older uncertain admission; observing
the same snapshot retains its target and unresolved-operation fence. Instance power
epochs and immutable runtime identities also fence stale observations.

Desktop transitions do not change instance connectivity, runtime or source binding
authority. They do not themselves retire independent shells, Runs, other desktops
or ordinary SSH/TCP routes. Desktop-bound viewing/input/VNC cleanup and fresh GUI
authority are separately required product behavior, not implied by these APIs.

Cantrip's workspace desktop panel supplies confirmation, saved-request recovery
and paginated history. The client saves an account-bound original admission
before sending it and only observes a submitted request after uncertain delivery.
See [the product workflow](PRODUCT_WORKFLOW.md#workspace-desktop-lifecycle).
Actual Docker acceptance includes independent terminal/Run survival across
desktop stop/start, lost-reply observation after Worker death, held-input cleanup
and fresh viewing authority. Installed-system acceptance remains separate.

Run the real Worker/native desktop check against an explicitly selected disposable
container with the workspace and executor packages installed:

```sh
CANTRIP_OS_TEST_DESKTOP_CONTAINER=your-disposable-container \
  pnpm --filter @cantrip/worker exec vitest run test/os-desktop.integration.test.ts
```

The check creates its own workspace, retains private proof and test files, stops
its desktop and terminates only its own independent process. It does not remove
the container or existing workspace state.
