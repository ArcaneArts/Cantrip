# Full-worker model operation qualification

The existing browser SDK, production servers and complete worker now have a
shared product scenario for protected embedding and decision operations. The
scenario exercises actual HTTP/WebSocket transport, grants, encryption, worker
inference admission, provider adapters, cancellation and persisted usage.
Only the provider's public HTTP responses are controlled.

This milestone does not change the Rust server or rewrite the worker. It fixes
a Node PostgreSQL date-binding defect uncovered while qualifying aggregate
usage. Node remains the default server and full replacement remains incomplete.

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
