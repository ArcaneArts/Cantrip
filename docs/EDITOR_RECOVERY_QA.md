# Automated editor recovery QA

`pnpm qa:editor-recovery` starts the production server and worker with disposable
state, builds an immutable app for this run, and drives the actual bundled
Cantrip Code editor in an isolated sandboxed Chromium context. Each run has its
own `*.localhost` origin, ports, Vite cache, database, worker directory, and
browser storage. It does not adopt a desktop development profile.

Prepare the shared packages and actual runtimes, then run the browser suite:

```sh
pnpm install --frozen-lockfile
pnpm --filter @cantrip/version --filter @cantrip/logging --filter @cantrip/protocol --filter @cantrip/crypto --filter @cantrip/glitch -r build
pnpm cli:build
pnpm code:build
pnpm exec playwright-core install chromium
pnpm qa:editor-recovery
```

Select individual scenarios in a fresh fixture:

```sh
pnpm qa:editor-recovery --case transient-renewal
pnpm qa:editor-recovery --case hard-expiry,explicit-revocation
```

Cases cover cold/warm use, delayed readiness, worker/service-worker/server
restarts, carrier loss, Pong loss, renewal, expiry/revocation, forced relay route
replacement, congestion, preview/pin, and worktree navigation. Blocked setup and
failed behavior are distinguished. Exit codes are zero for pass, one for failed
behavior, and two when only blocked/unknown cases remain. Worktree and logical
congestion setup currently have explicit automated follow-ups in the ledger.

An existing CLI or Code installation can be selected through the worker's
normal `CANTRIP_CLI_BIN` / `CANTRIP_CODE_ROOT` overrides. The worker performs its
normal runtime discovery and authorization. On this macOS host, native builds
use `DEVELOPER_DIR=/Library/Developer/CommandLineTools`.

For interactive agent QA, `pnpm qa:editor-fixture` leaves the owned services
running and prints their browser origin. Open it with the browser tool and use
the normal application onboarding and project/file controls. Stop the fixture
with SIGINT or SIGTERM. Its private control origin and bearer token are written
to `.qa/editor-<run-id>/fixture.json`; control operations can interrupt carriers,
restart an owned service, drop Pong responses, fail renewals, and deny replacement session creation. The
fixture uses real 45-second session leases through the production server factory;
production startup retains its normal defaults and authority checks.

The browser runner verifies rendered text, real typing, saves reaching the
worker-owned file, retained frames, and unsaved content. It disables autosave
only in the fixture's generated Code workspace so dirty-buffer assertions have
a defined meaning. Save attempts during reconnect are retried within a bounded
deadline; seeing text locally never proves transport recovery.

Results, accessibility snapshots, screenshots, console/request errors, and
correlated server/worker logs remain in the ignored `.qa/` directory. Recovery
files and control credentials belong to the disposable account and stay local.
The runner reports failed cases and continues independent cases; failures are
not converted to passes. Cleanup terminates only processes and connections
created by this fixture.

`pnpm network:acceptance` runs the protocol, app, worker, server, and native
behavioral groups before metadata audits, collects independent failures, and
returns a nonzero exit code if any stage fails. `network:acceptance:check` is a
metadata audit; it does not claim runtime or browser coverage.

See [the stability ledger](STABILITY_PASS.md) for observed results, tracker
follow-ups, and portions still awaiting execution.

Loading measurements are available through:

```sh
node scripts/qa/editor-loading-benchmark.mjs --label current --warmups 1 --iterations 3 --output /tmp/editor-loading-current.json
node --expose-gc scripts/qa/editor-http-buffer-benchmark.mjs
```

The browser benchmark repeats cold typing/save, warm retained reopening, and
transient-renewal recovery in fresh owned fixtures. It captures verified
workbench stages, actual network/handshake timing, worker endpoint and extension
bridge readiness, presentation/file completion, file-open rendering, and renderer
heap metrics. Onboarding remains part of the
cold-case total; individual phases overlap and must not be summed. Unknown service-worker byte sizes are explicitly reported; bridge timing begins
at session registration and can overlap browser document/workbench startup. The parser benchmark executes production parser functions,
checks output/ownership, and reports local allocations and timing; it is not an
end-to-end startup benchmark.
