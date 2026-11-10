# Transport and inference contract reconciliation

Rust now preserves the reference server's full unavailable-resource response
from inference authorization: HTTP 410 includes both
`code: "inference-resource-unavailable"` and
`error: "The inference resource is unavailable."`. Stale server, owner and worker
process generations retain their separate code-only 409 response. The retained
comparison reproduced the omission on all three stores before this repair.
The base is `b6c8e96f10d8f2fa9dfcbb2835eb43fe5ed2f3b8`.

Ten local suites compare the actual reference and Rust HTTP/WebSocket entries
using the unchanged `WorkerConnection`, isolated databases and controlled worker
replies. Each passes PGlite, private PostgreSQL and external PostgreSQL with
anonymous, password and account authentication. Password acceptance was added to
the older WorkerLink, tunnel catalog and attachment fixtures. Frozen native
executables keep concurrent suites independent of subsequent Cargo builds.

| Suite                                                  | Paired HTTP observations | Paired assertion groups |
| ------------------------------------------------------ | -----------------------: | ----------------------: |
| WorkerLink sessions, peers and sockets                 |                      798 |                       0 |
| Tunnel catalog, ownership and Live                     |                      714 |                       0 |
| Native runtime handoffs and restart                    |                      408 |                      54 |
| Terminals, consoles and resource grants                |                    1,883 |                       0 |
| Managed preparation and encrypted console state        |                        0 |                      48 |
| Native execution and receipts                          |                      258 |                       0 |
| Native coordination and settings evidence              |                      636 |                       0 |
| Native protected events and history                    |                      447 |                       0 |
| Tunnel attachments and binary sockets                  |                      469 |                       0 |
| Inference resource authorization and no-start recovery |                      285 |                       0 |
| Total                                                  |                    5,898 |                     102 |

The preparation suite retains product assertions rather than counting its
individual HTTP calls as paired observations. The comparisons additionally
perform 270 endpoint cryptographic proofs. Socket, command, lifecycle and SQL
assertions are not added to the HTTP observation count.

The new inference scenario admits one original endpoint-encrypted terminal input
and replays its admission. Contradictory granted history, an incorrect journal
digest and a different native message cannot return it to the queue; actual
unchanged-worker SDK reads require identical accepted input and claim state.
Correlated never-granted evidence requeues it, and replay remains idempotent.
After server close and database reopen, each peer retains exactly one original
encrypted input, one deferred claim and one completed recovery receipt, with no
native turn. The endpoint decrypts both queued and future-message content and
checks that private text is absent from HTTP, Live and diagnostics. This suite
uses controlled journal evidence; separate full-worker crash tests remain
necessary for product acceptance.

The standalone-chat admission fixture had an obsolete rejection assertion. Both
current servers admitted that Chat, and their complete normalized admission
responses matched independently on all three stores before updating the fixture.
The fixture now checks standalone placement and computer-use authority, admission
replay, preparation binding, dispatch, protected history persistence and endpoint
decryption. Task admission rejection remains asserted. Earlier failing runs are
retained, including new fixture rows rejected by actual database constraints and
the distinction between active claims in the queue DTO and deferred rows retained
in storage.

An opt-in diagnostic-channel observer records actual method, origin, pathname,
status and database/authentication peer context. It records no headers, bodies or
query values and consumes no response streams. It observes a WebSocket upgrade
only when the request already has an upgrade owner. Four real HTTP/WS tests check
response integrity, binary echo, automatic unhandled-response draining and A/B
rejection of an unsolicited upgrade. Importing it without the trace environment
variable does not subscribe an observer.

[The acceptance record](security/rust-server-transport-inference-acceptance.json)
contains report hashes, 15,303 actual network observations from the selected
passing runs, and exact witnesses for all nine cells of each mapped route and
command. The ledger gains 49 routes and 24 server-produced command identities.
The command scope is server dispatch, correlation and side effects with controlled
worker replies; observed commands rejected by the controlled worker are excluded
from the new mappings.

Four durable table entries now link to exercised terminal persistence, managed
preparation, runtime handoff restart recovery and actual relay bandwidth sums.
The bandwidth entry does not establish the complete periodic consolidation or
flush crash contract. Three Live entries link to exact committed preparation,
tunnel and remote-desktop publications. These mappings preserve their final
integration/platform limitations.

The ledger now maps 572/584 routes, 141/323 worker commands, 114/135 tables and
32/47 Live resources. All 370 repository identities were accounted for in the
preceding milestone. Twelve route identities remain unmapped: eight CantripOS
source/backup operations, three internal suspension/Task Goal paths, and the
protected repository-operation route. Remaining command/table/Live identities,
historical partial entries, final supported-platform artifacts, integrated
upgrades/post-write rollback and the original goal audit remain open. These are
evidence counts, not an engineering completion percentage.

Development validation is local. No new full worker/UI, Windows/Linux, shared
deployment, shipping artifact or production Winterhold result is claimed here.
All 86 Rust library tests, strict all-target Clippy, Rustfmt, the four trace tests
and formatting of changed files pass. The full `pnpm check` fails in two worker
capacity/backoff tests: 744 worker tests pass, two fail and two unhandled errors
are reported. Both failures reproduce on clean Primary at the exact base. The
separate repository-wide format check reports the same twelve pre-existing files
on Primary; none is changed by this milestone. The aggregate is not green.
The retained evidence directory is
`rust-server-transport-inference-delivery-20261110-v1`.

To capture a suite's actual network identities, set
`CANTRIP_RUST_HTTP_TRACE_FILE` and preload
`scripts/server-rust/http-request-trace.mjs` before `tsx`, then run the respective
compatibility script with `--database` and `--report`. The older suites accept
frozen binary overrides and `--keep-fixture` (`--keep-data` for WorkerLink).
