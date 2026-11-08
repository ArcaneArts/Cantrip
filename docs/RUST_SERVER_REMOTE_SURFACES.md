# Native remote desktops and surfaces

Rust implements the twelve existing remote-desktop/surface HTTP endpoints,
including the legacy binary WebSocket connection. Node remains the default
server and the worker remains Node. Complete replacement, default cutover and
supported-platform/package acceptance remain unfinished.

## Behavior

Owned catalogs reuse canonical browser, surface and desktop projections. Generic
browser surfaces retain opaque labels/state, revision conflicts and their separate
encryption resource. Managed desktop creation retains worker placement, probe or
CantripOS preparation, captured binding/runtime/desktop generations, and the
transaction creating the project view, surface and tab placement. Configuration
updates retain the existing worker command, public error masking and durable
completion after an HTTP caller disconnects. Successful mutation responses retain
the four existing Live invalidations. Deletion revokes WorkerLink grants and
requests worker closure without deleting the canonical project view.

Fleet discovery retains project affinity, locale ordering, UTF16 text limits,
bounded parallel inventories, partial results and the 20-second worker deadline.
Worker inventories and saved surface state remain encrypted. The server does not
open images, controls, labels, URLs or inventories.

The legacy socket preserves origin/session/viewport validation, account/worker
quotas, settings, TURN credentials, 30-second attachment admission, status changes,
late-acknowledgment detach and CantripOS revalidation after acknowledgment. CTRS
frames retain binding checks, per-channel sequencing, replay handling, usage
accounting and bandwidth limits. Under physical socket pressure, image/cursor
frames may be dropped; reliable controls close the slow client. Worker loss and
session revocation close active attachments and release their counts/quotas.

## Executed local qualification

All nine local macOS arm64 Source/Rust database/authentication pairs pass:
PGlite, private PostgreSQL and external PostgreSQL, each with none/password/accounts
authentication. The final matrix retains 624 paired HTTP observations, 555 paired
command/state/socket cases and 18 clean server exits. These include actual
competing revision writes, caller destruction, session revocation, worker
disconnection, ownership, malformed opaque replies, placement and captured OS
generation fences. Worker commands use the unchanged production connection;
their reply producers are controlled in this suite.

Separate runs exercise actual 20/30-second deadlines without accelerated clocks,
quota rejection/release and persisted accounting. A paused TCP reader receives
64 one-MiB worker image frames followed by a reliable control. Both servers close
it with the existing slow-client contract and detach exactly once. Durable
ingress/egress bytes and operation counts match the frames actually accepted by
each server. Physical buffering can accept different numbers of image frames;
the comparison retains those measurements rather than requiring identical
network scheduling.

Actual failed SQL during initial socket context lookup reproduced a Node process
exit and a stranded Rust socket. Both implementations now contain this failure,
send the existing recoverable error and close with 1013. Restoring the relation
and requesting bootstrap proves the server remains usable. Context failure is
qualified on all three stores; the separate settings-read failure is qualified
on PGlite. The original failing reports are retained.

The existing browser APIs and complete unchanged worker pass six single-server
cells and all four Redis pairings: Node/Node, Node/Rust, Rust/Node and Rust/Rust.
These ten cells retain 150 product steps, 28 clean server exits and 30 clean worker
stops. A real Chromium supplies authenticated JPEG frames and encrypted reload
controls through both the legacy socket and existing WorkerLink client. The
scenario verifies modified encryption bindings are rejected, suspend/resume,
saved encrypted URL restoration, deletion, grant revocation and server/worker
restart retention. Existing first-attempt WorkerLink failures/retries occur on
both peers and remain in the reports.

Actual host-desktop discovery reports one worker, zero healthy inventories and
`partial: true` on both peers. This does not prove successful physical desktop
capture. Positive CantripOS preparation/capture fencing uses controlled worker
replies; real desktop/platform acceptance remains required. WebRTC configuration
and TURN credentials are compared, but this milestone does not establish a real
TURN/media deployment.

The actual production Rust executable is 92,972,448 bytes, SHA-256
`4405684e6f8a8aff9e2b63a01a7e7417f9463df25f003bee8c4449704c8cc31c`.
The production inventory completes 584 requests per peer with clean exits and
four remaining generic fallbacks, all computer-use endpoints. Its inspection
command still exits one while those routes remain unfinished; this probe alone
does not establish successful domain behavior.

The independent 16-root/193-node graph passes 40,299 Source comparisons across
three unrelated base graph sizes. All 71 Rust library tests, strict all-target
Clippy and five focused Source tests pass locally. The standard `pnpm check`
stops at unchanged Node line limits: `build-app.ts` 1,532/1,500 and
`chat-turn-runtime.ts` 2,336/1,999. Its downstream aggregate checks did not run.
Current builds, generated-contract comparisons, boundary/workflow audits and
formatting/syntax checks are recorded with the milestone evidence. No hosted
development Actions were used.

## Repeatable commands

Build current workspace packages, the Node reference and worker first. Supply
the existing fixture, PostgreSQL and Redis runtimes as appropriate. Keep one
shared Cargo target and disable incremental compilation.

```sh
node --import tsx scripts/server-rust/remote-surface-http-compatibility.mjs \
  --database pglite --quota worker --report /absolute/path/to/http.json

node --import tsx scripts/server-rust/remote-surface-http-compatibility.mjs \
  --database postgres --profile password --timers --stress --accounting \
  --report /absolute/path/to/pressure.json

node --import tsx scripts/server-rust/remote-surface-startup-fault.mjs \
  --database bundled-postgres --fault context --report /absolute/path/to/fault.json

node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database pglite --surfaces --remote-surfaces --keep-fixture \
  --report /absolute/path/to/product.json

node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --database postgres --server-pair all --surfaces --remote-surfaces \
  --keep-fixture --report /absolute/path/to/shared.json
```

Use `CANTRIP_RUST_SERVER_BINARY` for the HTTP SQL fixture and
`CANTRIP_TEST_SERVER_BINARY` for the production browser scenario. The latter
records the actual spawned executable's bytes/hash. Supply
`CANTRIP_TEST_CLI_BIN` and `CANTRIP_TEST_WORKER_PACKAGE` for an existing full worker
package. Repeat single-server product runs on all three stores. Preserve reports,
process diagnostics, databases and exact artifacts before cleanup.
