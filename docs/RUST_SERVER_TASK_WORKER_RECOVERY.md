# Task recovery after worker process loss

The existing Task recovery endpoint can now resolve an expired direct or planning
round from its original native turn. Both servers use the same authority checks
and the existing encrypted failure content. Node remains the default server;
this milestone does not complete replacement acceptance or rewrite the worker.

## Recovery authority

A forwarded input remains unresolved after worker loss and lease expiry. Expiry
revokes dispatch authority and advances the fence; it does not prove that native
execution failed, and it does not authorize replay.

An explicit `POST /api/tasks/:chatId/recover` captures the latest expired round
under the owner, dispatch, round, project, Chat and lane locks. The capture retains
the entire canonical input, its original receipt and native owner, Task revision,
placement and Stop revisions, and current suspension controls. A Task's native
binding comes from its canonical input; its general Chat runtime may have no
thread even though the dispatch has a running native turn.

The server resolves configuration and asks the existing worker to observe that
exact saved thread and turn. `chat.thread.ensure` already has an optional
`recoveryTurnId`; the worker now returns its generation-pinned native history
observation for a Task as well as a managed Agent session. It submits no input.

Only an actual `failed` or `interrupted` turn observed under a different native
runtime generation can use this failure projection. Missing, completed or live
turns remain unresolved. The server reacquires all write locks and compares the
capture again after IPC. Replaced inputs, provider-transfer metadata, native
owners, user controls, placement, lanes, versions or dispatch fences invalidate
the observation.

## Atomic settlement and retry

The successful transaction applies the round's precomputed encrypted failure
Task and round, suspends its exact execution lane, records a content-free native
terminal digest, fails the original dispatch, and interrupts pending approvals
on that lane. Original receipts, sticky dispatch evidence, native identities,
messages and encrypted content remain retained. No no-dispatch evidence is
fabricated.

The transaction also records an existing-format private idle retry marker. The
public automatic-retry summary stays empty. This marker prevents another peer's
legacy failure adopter from scheduling a new inference after recovery. A repeated
Recovery request returns the existing 409 contract without clearing the marker.
The existing explicit Retry starts a fresh operation. Finalization/Goal recovery
continues to use its existing retry-budget reset and retained Goal controls.

## Local qualification

The current debug candidate passes local qualification in the isolated
`codex/rust-worker-process-recovery` lane. Reports are retained under
`.qa/rust-worker-process-recovery`; failed investigations retain their original
reports and fixtures.

The current production debug executable is
`native-server-recovery-debug-v4`, SHA-256:

```text
2d780c9b68510740b7bab155053ebf72349be638d40ed916963d6ff8d2af41e9
```

The full production worker uses the current 92-patch native runtime. Its patch
set digest is:

```text
11ba64258abf73b678aef876152c131ac3f828163b5a11d258e7ef882ab41cbf
```

The repository corpus exercises missing/nonterminal/unrelated observations,
changed authority after the native read, exact terminal settlement, idempotency,
legacy retry adoption, protected approval isolation, and an actual SQL exception
at the final approval write. Shared PostgreSQL races use observed competing
owner-row locks across all four Node/Rust process pairings.

The browser/full-worker scenario starts a direct Task or planning round and
kills the real worker during a held model stream, observing native owner
shutdown. It retains the original credential,
operation and message through actual lease expiry, performs explicit recovery,
repeats Recovery, waits beyond the real five-second adoption timer, and requires
one inference until explicit Retry. The new operation completes once, and exact
Task/history state survives server and worker restart. Separate runs cover all
three stores and all four shared server pairings. Full-worker loss during
resumption and Goal execution remains separate qualification.

Current debug results:

| Scope                                                                           | Result                                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Full browser/worker loss and explicit Retry, both servers on all three stores   | Passed six cases                                                |
| Shared worker loss, Node/Node, Node/Rust, Rust/Node and Rust/Rust               | Passed four cases                                               |
| Canonical authority, exact settlement, legacy adoption, SQL rollback and reopen | Passed 512 paired observations across all three stores          |
| Competing settlement transactions on shared PostgreSQL                          | Passed all four process pairings, one committed settlement each |
| Current native Agent/Task product regression on PGlite                          | Passed both production peers                                    |
| Task/Goal control unit tests                                                    | Passed 33 tests                                                 |
| Worker history unit tests and enabled pinned-native worker/history tests        | Passed nine unit tests and two native tests                     |
| Broad native repository regression, all three stores                            | Passed 5,003 paired cases and 4,270 snapshots                   |
| Inference retirement, ownership, binding and admission regression               | Passed 15 tests, including two separate-process lifetime cases  |

The optimized production matrix with the final worker passes twelve
single-server cases (both round kinds, both servers and all three stores) and
eight shared cases (both round kinds across all four process pairings).

The ten debug worker-loss cases retain one model request until explicit Retry and two
requests total through completed-history restart. Their repeated Recovery call
and real 6.5-second wait exercise legacy adoption after the terminal transaction.
The two initially gated native tests were subsequently enabled with
`CANTRIP_CODEX_TEST_BINARY` and both pass; their earlier skipped run is retained.

The optimized production server is `native-server-recovery-release-v1`, SHA-256:

```text
53af4e02991ecc3e8ce7156f2f4a6bb4aa89f08be15ee4e76b0186e6e08e4835
```

Its initial external and bundled PostgreSQL runs and both mixed-peer runs pass.
The PGlite run completes recovery, Retry and history retention, then fails the
final worker shutdown assertion: the worker exits zero without finishing its
shutdown promise. A separate Node process reproduces premature exit during
unreferenced native retirement before the keeper is closed. Inference admission
shutdown now retains a process reference through actual retirement, journal
flush and ownership cleanup, releasing it in `finally`. Separate-process tests
cover successful and rejected cleanup without leaking that reference.

The rebuilt production worker, `worker-runtime-observer-v3`, passes the complete
optimized direct-Task and planning-round matrices: both servers on all three
stores and all four shared pairings. Every shutdown assertion is retained. The
twenty cases each retain one inference until explicit Retry, two total model
requests, four normal worker exits and one deliberate SIGKILL. Earlier passing runs retain
their original worker scope; the failed shutdown result is retained as evidence.

The same full-worker scenario accepts `--worker-recovery-kind initial-plan`,
enables Plan + Goal through the existing browser draft API, and requires explicit
Retry to produce the exact saved plan in the `review` state. All six storage/runtime
cases and all four shared pairings pass, including exact single canonical
Markdown plan-message and restart retention. It does not qualify worker loss
during an active implementation Goal or resumption.

The final worker also passes the delegated Agent/Task regression against both
production server entry points on PGlite: eleven product steps, four clean
worker stops and three clean server generations per peer. The existing native
product runner now forwards `--production-server` to select those entry points;
neither installs SQL fixture routes in that mode.

The standard `pnpm check` stops at the same decomposition limits reproduced on
clean Primary: `build-app.ts` 1539/1500 and `chat-turn-runtime.ts` 2338/1999.
Its downstream aggregate stages are not reported as passing. A separately run
repository decomposition check also reproduces the same untouched
`native-commands.ts` limit on both checkouts: 2300/2000. The server-boundary audit
passes after regenerating route source locations and adding the internal
observer to the source inventory. All reviewed external contract-set digests
and route, command, table, repository-method and live-resource counts remain
unchanged. The older Goal
unit fixture also reproduced 22 failures on Primary because it lacked the
current pending-input and observation ports. Updating those ports and exact
lease arguments preserves the existing assertions; all 25 original tests and
eight new explicit-control tests pass.

Initial investigations incorrectly expected lease expiry alone to fail the Task.
The retained source and actual database evidence establish the required
uncertainty behavior. A later shared Node run exposed the missing idle marker:
the recovery response had no pending retry, then a peer adopted that failure and
scheduled one. The current transaction and repeated-control qualification address
that reproduced race.

All development validation runs locally. GitHub Actions remains reserved for
releases and deployments. Supported-platform artifacts, broader historical
upgrades and product-wide post-write rollback, remaining fault/performance
acceptance, default cutover and production Node-server removal remain part of
the complete replacement goal. No Winterhold production deployment is performed.
