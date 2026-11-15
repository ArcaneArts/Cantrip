# Full-worker model operation qualification

The existing browser SDK, production servers and complete worker now have a
shared product scenario for protected embedding and decision operations. The
scenario exercises actual HTTP/WebSocket transport, grants, encryption, worker
inference admission, provider adapters, cancellation and persisted usage.
Only the provider's public HTTP responses are controlled.

The initial qualification fixed a Node PostgreSQL date-binding defect in
aggregate usage. Normal service entry points now select Rust. The full worker
and the development reference server continue to use Node.
[Rust default cutover](RUST_SERVER_DEFAULT_CUTOVER.md)

## Packaged 1.1.2845 qualification

The current browser SDK and signed desktop worker passed the same twelve
protected operation cases for each server on each of the three stores. Each
peer observed thirteen provider requests, one intentional worker crash and
four normal worker exits. The persisted aggregate retained all six token
totals and all four receipt coverage counts. The existing cancellation,
encrypted transport and retained restart assertions also passed.
[Current product evidence](security/rust-server-current-native-product.json)

## Packaged 1.1.2976 qualification

The packaged macOS ARM64 Rust server and Node reference passed 72 cases
across PGlite, bundled PostgreSQL and external PostgreSQL. Shared
PostgreSQL and Redis added 48 cases across Node/Node, Node/Rust, Rust/Node
and Rust/Rust. The browser and worker connected to opposite peers.
All cases retained their original cancellation outcomes and usage receipts
through the tested worker loss and orderly restart. Across both matrices,
the runs observed 130 provider requests, 10 intentional worker losses and
42 clean server exits.
[1.1.2976 model-operation evidence](security/rust-server-2976-darwin-arm64-model-operations.json)

The macOS ARM64 package also completed a protected embedding through a
45-second external PostgreSQL outage. The original provider connection stayed
open while the database was down. After PostgreSQL restarted on the same port,
the worker completed the embedding, recorded one usage receipt, and executed a
fresh decision. Replaying the original operation produced no additional
provider request. The same server and worker processes stayed alive.

Both Rust and the Node reference passed all 14 operation cases in this
scenario. Both returned HTTP 503 immediately after PostgreSQL stopped and
HTTP 200 after recovery. During the outage, Rust continued returning HTTP 503
from readiness while the Node reference exceeded the five-second readiness
probe deadline. Both returned HTTP 200 from liveness. The provider replied
after database recovery.

A separate run released the provider response during a 60-second external
PostgreSQL outage. The browser received the completed embedding while the
database was offline. Both baselines left the usage attempt running after
the database recovered. The Rust server now retries transient PostgreSQL
failures for a validated receipt using the original operation identity. The
rerun settled one receipt, rejected replay without another provider request,
and completed a fresh decision. The live server retries a validated receipt
for up to 15 minutes, allowing for PostgreSQL WAL recovery after a prolonged
outage. It uses the original operation identity on every write. An individual
write attempt is bounded by two minutes, and shutdown stops retrying after
the current attempt.

A macOS ARM64 run exercised the longer window with the browser SDK, the full
packaged worker and PostgreSQL 18. It completed all 14 operation cases. During
the eight-minute outage, readiness returned HTTP 503 and liveness returned
HTTP 200. The browser received the embedding before PostgreSQL recovered on
the same port. After recovery, readiness returned HTTP 200, one usage receipt
settled and the replay caused zero additional provider requests. A fresh
decision completed and recorded its own receipt.

The 1.1.3059 macOS ARM64 standalone archive and Linux ARM64 OCI image each
passed 14 model operations with a five-minute external PostgreSQL outage.
The browser received the embedding while PostgreSQL was down. Readiness
returned HTTP 503 through the outage and HTTP 200 after restart. The same
server and worker settled one receipt, rejected a replay without another
provider call, and completed a new decision. In the matching Node reference
case, the browser also received the embedding during the outage and its usage
row stayed `running` after PostgreSQL returned. The host-side worker in all
three runs was the bundled Node worker reporting 1.1.2976.
[1.1.3059 long PostgreSQL outage results](security/rust-server-3059-postgres-long-outage.json)

A separate macOS ARM64 run repeated the five-minute interruption with worker
version 1.1.3059. The browser received the protected embedding during the
outage, the same worker settled a single usage receipt after recovery, and
replay made no additional provider call.
[Version-aligned macOS results](security/rust-server-3059-macos-worker-version-acceptance.json)

The verified Linux x64 OCI image also passed all 14 cases with the rebuilt
1.1.3059 worker. During the 300-second external PostgreSQL outage the browser
received the embedding in 16 ms. Recovery settled one usage row and the
interrupted operation made one provider request. The x64 server ran through
Rosetta on the ARM64 Linux host.
[Linux x64 outage results](security/rust-server-3059-postgres-long-outage.json)

## Decision requests during PostgreSQL interruption

The current macOS ARM64 1.1.3059 archive and rebuilt Node reference kept an
active decision pending through a 45-second PostgreSQL outage. After
PostgreSQL restarted, the browser received the original typed answers and
each server recorded one receipt for ten tokens. The original server and
worker processes stayed alive. Replaying the operation made no additional
provider call.

A separate run released the provider response while PostgreSQL was down for
60 seconds. Both servers returned the same typed decision before the database
restarted. Rust settled one receipt after recovery and rejected a replay
without another provider call. The Node control left the attempt running with
no receipt throughout the 30-second post-recovery assertion. Its failed run
is retained. The Rust readiness checks returned HTTP 503 while PostgreSQL
was down and HTTP 200 after restart. Liveness returned HTTP 200 during the outage.

Use `--model-operation-postgres-outage-operation decision` with
`actual-folder-client.mjs --model-operations --database postgres
--model-operation-postgres-outage` to hold the decision until PostgreSQL
recovers. Add `--model-operation-postgres-offline-settlement` to release the
reply while the database is down. Omitting the operation selector still
exercises an embedding, which passed its regression run on the same archive.
[Decision outage evidence and artifact checksums](security/rust-server-3059-decision-postgres-outage.json)

### Linux container qualification

The Linux ARM64 and x64 1.1.3059 images built at `f820371ea` also held a
decision through a 45-second external PostgreSQL outage. The browser request
remained pending while PostgreSQL was down. After recovery, both architectures
returned the original typed decision, recorded one receipt and rejected exact
replay without another provider call.

Both images also returned the typed decision during a five-minute PostgreSQL
outage. After the database recovered, the original receipt settled and the
same worker reconnected. Exact replay preserved the receipt and made no
additional provider call. Each server then accepted a fresh decision. All
four Linux cases passed 56 model-operation checks and 12 container exits
were clean.

The first ARM64 five-minute run returned the decision and settled the receipt.
Its immediate replay got HTTP 502 because the worker command channel was still
offline. The repeat explicitly observes the reconnect before testing the
worker's replay response. The earlier result is retained.

The browser and the bundled 1.1.3059 Node worker ran on macOS ARM64. The x64
image ran through Rosetta. Every server generation used the expected image
and executable. ARM64 file checks ran inside its containers. The x64 check
hashed a copy of the exact image's package on the host, then matched the image,
manifest and running executable in each read-only container. The test also
checks that mounts cannot replace package files.
[Linux decision outage evidence](security/rust-server-3059-linux-decision-postgres-outage.json)

## Active Redis interruption

A real 45-second Redis process outage interrupted a protected embedding
with the browser and full worker connected to opposite server peers.
Both peers reported unready throughout the sampled outage while PostgreSQL
stayed available. The original provider request remained open. Redis
recovery restored readiness and the original worker continuity identity.

All four Node and Rust pairings passed 56 operation cases and observed
60 provider requests in total. The interrupted embedding returned HTTP 502
with one unknown usage attempt and no receipt. Replaying it was rejected
without another provider request. A fresh decision completed and recorded
its own receipt. Explicit cancellation and client disconnect still closed
their original provider requests in the same runs.
[Redis interruption evidence](security/rust-server-2976-darwin-arm64-model-operations.json#sharedRedisOutage)

The macOS ARM64 1.1.3013 standalone archive repeated the full matrix with
external PostgreSQL and the packaged Node worker. Its four runs retained
the same readiness transitions, interrupted usage outcome, and replay
behavior.
[Packaged Redis interruption report](security/rust-server-3013-darwin-arm64-redis-outage.json)

The 1.1.3059 Linux ARM64 and x64 OCI images each passed the 45-second
Redis interruption with two Rust servers and the rebuilt Node worker.
Both peers went unready while PostgreSQL stayed available. The interrupted
embedding returned HTTP 502 and retained one unknown usage row, and replay
made no additional provider request. The worker kept its connection identity
and completed a fresh decision with a 1.1.3059 receipt. The x64 image ran
through Rosetta.
[1.1.3059 Linux Redis interruption results](security/rust-server-3059-linux-redis-outage.json)

### Active decisions across shared peers

The macOS ARM64 1.1.3059 standalone archive passed the decision scenario in
all four peer pairings. The 1.1.3059 Linux ARM64 and x64 images each passed it
with two Rust peers. Chromium and the full 1.1.3059 Node worker connected to
opposite peers over real HTTP and WebSockets.

Each pairing held the provider reply through a 45-second Redis outage and
repeated the test with the provider replying 20 seconds into the outage.
Both peers reported unready at the sampled points while external PostgreSQL
remained ready. All 12 cases returned the same HTTP 502 decision error,
retained one unknown usage attempt without a receipt and rejected exact
replay without another provider request. After Redis recovered, the same
worker completed a fresh decision with the same typed answers and a receipt
for ten tokens. The stored transport status after replay was `replied` on
macOS and `unavailable` on Linux. Both retained the original usage identity
and recorded no receipt. The x64 containers ran through Rosetta.

The decision matrix passed 168 model operations and 72 clean server exits.
The default embedding case also passed its 14 operations with two macOS
Rust peers.

Use `--model-operation-redis-outage-operation decision` with
`actual-folder-client.mjs --model-operations --database postgres
--server-pair rust/rust --model-operation-redis-outage`. Add
`--model-operation-redis-offline-reply` to release the provider response
while Redis is down. Omitting the operation selector exercises an embedding.
[Decision Redis outage reports and artifact identities](security/rust-server-3059-active-decision-redis-outage.json)

### PostgreSQL and Redis down at the same time

The current packages repeated the cross-peer decision with Redis stopped and
external PostgreSQL shut down immediately. The provider completed its original
reply 20 seconds into the overlap. PostgreSQL recovered on the same port
after at least 45 seconds, and the peers stayed unready until Redis also
recovered. Both peers stayed live. Rust readiness returned HTTP 503 while
both dependencies were down. The Node readiness probes exceeded five seconds
during the overlap.

The four macOS peer pairings and the two Linux Rust/Rust pairings completed
84 model operations and 36 clean server exits. The interrupted request returned
the same HTTP 502 as in the Redis-only run. It kept one unknown usage record
and rejected replay without another provider call. The same worker completed
a fresh decision and recorded one ten-token receipt after recovery.

Add `--model-operation-redis-and-postgres-outage` to the cross-peer Redis
scenario with `--model-operation-redis-offline-reply` to exercise this recovery
order. Add `--model-operation-redis-first-recovery` to restore Redis before
PostgreSQL. The Linux x64 image ran through Rosetta.

With Redis restored first, the original request can return HTTP 502 while
PostgreSQL is still offline. The original Rust package dropped that terminal
usage write and left the attempt running after recovery. The Node reference
recorded an unknown outcome for the same failure. Rust now retries terminal
usage writes on transient PostgreSQL errors, including outcomes without a
receipt. The retry uses the original operation identity, preserves an
existing receipt and never resends inference to the provider.

The rebuilt macOS ARM64 package passed 42 operations with Redis recovering
first across Rust/Rust, Rust/Node and Node/Rust. All three cases returned
HTTP 502 before PostgreSQL recovered and then settled the original record as
unknown. Replay made no additional provider request. The relocated package
also passed export, restart and hosted startup across all three storage modes
with Node and Homebrew excluded from the server process.
[Overlapping dependency acceptance evidence](security/rust-server-3059-shared-decision-dependency-loss.json)

Linux ARM64 and x64 1.1.3059 images built from PR #3152 each passed the
Redis-first recovery test with two Rust peers, the existing app and the
packaged Node worker. The 28 cases included an interrupted decision on
each architecture. Both requests returned the established HTTP 502,
settled the original attempt as unknown after PostgreSQL recovered and
rejected replay without another provider request. A fresh decision on the
same worker recorded a ten-token receipt. All 12 server generations exited
cleanly. The x64 runtime ran under Rosetta.
[Linux usage settlement evidence](security/rust-server-3059-linux-usage-settlement.json)

## Installed Windows x64

The Windows 1.1.2976 installer with the worker grant refresh passed 12
model-operation cases per database mode using Edge and the installed
server. The run covered worker process loss, restart and usage retention.
The external PostgreSQL rerun used a QA process snapshot that skips
entries confirmed to have exited during enumeration. All three reports
matched the digests emitted by the guest.
[Windows model operations](security/rust-server-2976-win32-x64-model-operations.json)

The same signed desktop's Rust executable passed 20 product steps and 14
model operations with external PostgreSQL in a Windows 11 x64 guest. A
forced server exit interrupted an active embedding after the provider
received one request. The replacement server reopened the same origin,
retained one usage record without reported tokens or a receipt, and
reconnected the same worker. A fresh decision completed with its own
receipt. The fixture used Edge and an extended MCP startup timeout in the
worker copy for the emulated guest.
[Windows active model-operation recovery](security/rust-server-2976-win32-x64-model-server-loss.json)

## Product assertions

`actual-folder-client.mjs --model-operations` uses production server executables
and the existing account-encrypted browser APIs. It retains the existing project,
worker reconnect and restart assertions and adds twelve operation cases:

| Case                  | Required behavior                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Batched embedding     | Three items produce two HTTP batches, preserve order despite reversed provider results, and retain one two-request usage receipt.                 |
| Pinned embedding      | An explicit route and the original vector-space identity survive a subsequent request.                                                            |
| Typed decision        | Predicate, choice and score answers retain IDs, order, native values and reported token counters.                                                 |
| Missing counters      | A successful result retains unknown usage; absent provider counts do not become invented observations.                                            |
| Malformed decision    | The protected client error retains actual reported request counters and never retries inference.                                                  |
| Provider rejection    | HTTP 401 produces a protected provider error without exposing the provider's private diagnostic.                                                  |
| Explicit cancellation | The cancel endpoint closes an already-running provider request and settles one cancelled receipt.                                                 |
| SDK abort             | Existing SDK cancellation closes the upstream connection and preserves the receipt.                                                               |
| HTTP disconnect       | Closing the request without sending the SDK's cancel request still retires the original inference.                                                |
| Provider deadline     | Timeout closes the provider connection and records a failed request, distinct from user cancellation.                                             |
| Worker crash          | Actual worker SIGKILL closes the provider request; the server retains unknown usage instead of fabricating a receipt or retrying after reconnect. |
| Retained restart      | Exact usage survives a clean server/worker restart and the retained provider and route execute a new operation.                                   |

Exact redelivery of completed and cancelled operations cannot perform another
inference or overwrite the retained terminal receipt. Operation, server, worker,
model, route and provider identities are checked against the real dispatch.
Clear input is asserted at the owned provider boundary, while input, credentials
and provider diagnostics remain absent from observed server HTTP and logs.
No SQL fixture route or second embedded database opener is used.

## Aggregate accounting and the Node repair

The public provider telemetry SDK must return these exact values per peer:

- Tokens: 36 input, 9 output, 45 total, 6 cached input, 3 cache-write input and
  3 reasoning output.
- Coverage: 12 attempts, 11 reported attempts, 12 observed requests and
  7 attempts with incomplete usage.

The provider observes thirteen HTTP requests. One worker dies before supplying
a receipt, so only twelve requests are reported as observed in server telemetry.
Unknown counters and missing receipts remain explicit in the exported evidence.

The unmodified Node PostgreSQL baseline returns HTTP 500 from aggregate
analytics: a `CASE` SQL expression bypasses Drizzle's timestamp-column encoder,
leaving raw JavaScript `Date` parameters for the PostgreSQL driver. Both external
and private PostgreSQL references reproduce the error. PGlite accepts those
parameters and already passes; the Rust analytics path also passes independently.

The Node repair serializes the four date-range parameters as ISO timestamps.
It retains the existing range predicates, observation-time fallback and ownership
filters. Public aggregate accounting remains asserted through the same SDK.

## Local evidence and limits

Source baseline: `bb7af5ccc7322e5b18c1a23cd31abb198ad1608c`.
Native executable SHA-256:
`20bb778bd097862de7be6e51ee9d2c90c57dce27700c14e856b53ce36054b985`.
The native executable is unchanged from the preceding recovery milestone.

The selected matrix compares Node and Rust on PGlite, bundled PostgreSQL and
external PostgreSQL on macOS arm64, using account authentication. The bundled
PostgreSQL Node reference connects to the fixture's private external database;
Rust owns its private PostgreSQL process. PGlite uses an owned materialization
of the exact embedded runtime, leaving the damaged shared temporary cache alone.

All three final matrix processes exited zero with the same assertions:

| Storage             | Node / Rust product steps | Operation cases | Provider requests | Worker SIGKILLs |
| ------------------- | ------------------------- | --------------- | ----------------- | --------------- |
| External PostgreSQL | 19 / 19                   | 24              | 26                | 2               |
| Bundled PostgreSQL  | 19 / 19                   | 24              | 26                | 2               |
| PGlite              | 19 / 19                   | 24              | 26                | 2               |

The final runs observe 24 clean worker exits and 18 clean production-server exits,
separately from the six intentional worker interruptions. Their reports are
`{postgres,bundled-postgres,pglite}-matrix-v4.json`. Earlier complete operation
matrices and the independent Rust aggregate run are retained separately rather
than added to these totals.

The production Node build and thirteen focused quota/behavior repository tests
pass. The initial parallel selection timed out one five-second test under load;
the same assertions and default timeout pass with one test worker. Both reports
are retained. Formatting, current generated contracts and the server-boundary
and release-only workflow audits pass locally.

Reports are retained under `.qa/rust-model-operation-product`, including initial
setup failures, the incorrect new timeout-counter expectation, original Node
PostgreSQL analytics failures, and the final unchanged assertion set. The worker
collector deliberately classifies `TimeoutError` as failed rather than cancelled;
the new assertion was corrected from source and the real Node baseline. Existing
user-cancellation assertions were retained.

The standard `pnpm check` still stops at unchanged Node line budgets:
`build-app.ts` 1,532/1,500 and `chat-turn-runtime.ts` 2,336/1,999. Its downstream
checks did not run. Development validation is local; GitHub Actions is reserved
for releases and deployments.

This qualification uses configured OpenAI-compatible embedding/decision adapters
and a controlled local provider, rather than a paid external service. It does
not establish supported-platform packaging, mixed-peer operation recovery,
server interruption during these operations, long outages or every adapter's
worker-private behavior. Earlier malformed/auth/ownership boundary comparisons
remain separate evidence. Current catalog and CantripOS product qualification,
final platform/deployment/migration/performance acceptance, default Rust cutover
and production Node-server removal remain required.

## Linux 1.1.2976 package qualification

The production Linux ARM64 and x64 standalone containers passed 72
model-operation cases across PGlite, bundled PostgreSQL and external PostgreSQL.
Each of the six cells exercised the Chromium client, the packaged Node worker
on macOS, and a scripted local provider. The cases covered embedding, decision,
usage receipts, cancellation, disconnect, timeout, worker crash and a successful
operation after worker restart. The actual executable and packaged files were
verified inside every server generation. All 18 server exits were clean.

Docker Desktop ran on an ARM64 host and used Rosetta for Linux x64.
Windows package coverage, active-operation server and dependency interruption,
and long outages retain separate acceptance.
[Linux package acceptance record](security/rust-server-2976-linux-model-operations.json)

## macOS 1.1.2976 server interruption

Run `actual-folder-client.mjs --model-operations --model-operation-server-loss`
against a single server to exercise an active request across SIGKILL. The
browser observes one durable running usage record before the test kills the
server. The original request fails and its held provider response closes.
The replacement binds the same origin and retains the server identity and all
usage records. The interrupted record retains its last observed running state
with no terminal receipt or reported counters. The same worker process
reconnects and handles a new decision. Each operation makes one provider request.

All six macOS ARM64 cells passed across PGlite, bundled PostgreSQL and external
PostgreSQL, with matching Node and Rust outcomes. The six cells ran 84 operation
cases, including six active server interruptions and six post-reconnect decisions.
The results establish recovery from a single abrupt server exit. Active database
and Redis interruptions and long outages remain open.
[Server interruption evidence](security/rust-server-2976-darwin-arm64-model-operation-server-loss.json)

## Linux packaged server interruption

The product fixture can invoke a container-specific signal helper through
`CANTRIP_TEST_SERVER_SIGKILL_HELPER`. The helper receives the host launcher PID,
identifies its live container and sends SIGKILL to the observed Rust service
process inside it. The launcher must report exit 137 before the test reopens
the server on the same origin with the same data.

The Linux x64 1.1.3033 and Linux ARM64 1.1.3014 packages passed on all three
stores. Each cell exercised 14 operation cases with the Chromium client and the
packaged Node worker on macOS. Each interrupted request retained a single
unreported usage row. The same worker reconnected and completed a new request
without replaying the interrupted operation. Linux x64 ran through Rosetta.

[Linux server interruption evidence](security/rust-server-linux-model-operation-server-loss.json)
