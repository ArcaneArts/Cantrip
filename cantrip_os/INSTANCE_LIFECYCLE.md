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
Server-owned lifecycle admissions and product controls remain a subsequent step.

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
Server/product lifecycle controls, independent desktop stop/restart, reset,
image preservation and failed-upgrade recovery remain required for Phase 5.
