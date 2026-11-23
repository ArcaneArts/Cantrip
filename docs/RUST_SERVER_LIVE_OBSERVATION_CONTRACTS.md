# Filesystem, inference progress and server Live contracts

Current local comparisons qualify filesystem invalidations and inference progress
through production HTTP, worker connections and App Live sockets on all three
stores and authentication modes. Separate core Hub comparisons qualify the
`server` resource's transport behavior. No production Rust change was needed.
Complete server replacement and final shipping acceptance remain open.

## Executed behavior

The filesystem comparison retains the existing project/Git/Run assertions and
now records complete original `explorer-filesystem` frames. Each peer receives
one worker filesystem notification before reconnect and one after reconnect.
Both produce the original project scope and worktree identity. Existing Run
receipts, rollback, secret/definition handling and durable reopen checks remain.

The opt-in inference comparison uses an actual protected Task continuation
through the unchanged worker transport. Its controlled worker sends four
protocol-validated progress packets while holding the final model reply: one
unrelated request, two updates for the admitted request and its clear packet.
The client receives exactly the latter three. Before releasing the reply, the
fixture asserts the original Chat/request identity, sequence, complete payload
and updated/updated/deleted actions. Original encryption, Goal admission,
idempotency, negative requests and restart assertions remain. This exercises
server transport and routing; the controlled worker does not run model inference.

Tests run on macOS arm64 from `48180077c2b879f79232dd48aac75d1cb01903a8`, using
fresh frozen executables. Each HTTP suite passes PGlite, private PostgreSQL and
external PostgreSQL with anonymous, password and accounts authentication.

| Observation                                       | Count |
| ------------------------------------------------- | ----: |
| Paired production HTTP database/auth cells        |    18 |
| Paired HTTP case observations                     | 1,821 |
| Original filesystem Live frames across peers      |    36 |
| Original inference-progress frames across peers   |    54 |
| Controlled worker progress packets across peers   |    72 |
| Core Hub comparison cases                         |    46 |
| Core Hub comparison steps                         |   704 |
| Dedicated server-resource cases within that total |     2 |

Counts of paired HTTP observations exclude additional setup and polling
requests; retained request traces count those separately. Hub snapshots are not
HTTP/database authentication cells and are not added to the production totals.

## Server-resource scope

The protocol retains `server`, and the app maps it to its bootstrap query. Two
explicit cases drive the actual reference `AppLiveHub` and Rust `Hub` with
controlled socket IO, active-session callbacks and clocks. They compare complete
snapshots and independently assert owner isolation, unsubscribe, prior-event
replay and subsequent delivery, including the original invalidation fields.
These cases establish generic resource transport, not an HTTP mutation publisher,
real database authorization or Redis integration.

A retained syntax audit parsed 535 current reference TypeScript source files.
It records 88 `publishLiveInvalidation` calls: 86 literal resources, with no
literal `server`, and two dynamic delegations. It also records 70 generic
publish/receive calls and the 17 broad mutation-hook resource literals. This is
syntax evidence, without type resolution; it does not establish that generic
`server` publication is impossible or that the resource is retired. Dedicated
publisher/consumer disposition remains part of the broader reconciliation.

## Reproduction and remaining acceptance

After building the reference workspace and native executable, supply the frozen
binary/database asset overrides and run:

```sh
node --import tsx scripts/server-rust/task-dashboard-goals-http.mjs \
  --database pglite --inference-progress --keep-fixture \
  --report /absolute/path/progress.json
node --import tsx scripts/server-rust/project-git-http-compatibility.mjs \
  --database pglite --keep-fixture --report /absolute/path/filesystem.json
node --import tsx scripts/server-rust/live-hub-oracle.mjs \
  --capture-snapshots --report /absolute/path/hub.json
```

Repeat the HTTP suites with `bundled-postgres` and `postgres`; all three auth
profiles run by default. `CANTRIP_RUST_LIVE_HUB_BINARY` optionally selects the
frozen Hub example. The [acceptance record](security/rust-server-live-observation-acceptance.json)
binds the raw frames/snapshots to source, report, trace and executable hashes.
Complete retained evidence is in the external
`rust-server-live-observations-delivery-20261110-v1` archive.

Rust formatting, strict all-target Clippy, all 86 library tests and all seventeen
generated graph/map comparisons pass. Required `pnpm check` retains 744 passing
worker tests, two capacity/backoff failures and two unhandled errors. Those two
failures reproduce on clean Primary at the same base with identical worker/test
bytes. Full formatting reports twelve files identical to Primary. Neither
aggregate check is claimed to pass; changed-file checks pass separately.

All 47 Live identities now have scoped mappings, including partial Hub-only
evidence for `server`. Worker commands remain 269/323; this milestone adds none.
Historical partial scopes, remaining command identities, actual product/model
and mixed-instance interruption cases, current supported-platform artifacts and
complete final shipping acceptance remain required. The worker remains Node.
Validation runs locally; no GitHub Actions development run or production
Winterhold deployment occurs.
