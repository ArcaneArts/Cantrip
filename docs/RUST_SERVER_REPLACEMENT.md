# Rust server replacement

Native worker management now includes the owned catalog, display-name updates,
restart acknowledgment and atomic unlink/revocation. Local comparison passes all
three storage modes with development, password, account and standalone profiles,
including ordered Live events, rollback, concurrent unlinking and retained state
after restart/re-enrollment. See the [worker management qualification](RUST_SERVER_WORKER_MANAGEMENT.md)
for exact scope and remaining full-worker/platform acceptance. Node remains the
default server.

Native project Chat export previews and opaque transcript relays are now
implemented. See the [project export qualification](RUST_SERVER_PROJECT_EXPORTS.md)
for Source comparisons, actual database/transport failures, all nine local
storage/authentication combinations and remaining product/platform acceptance.
The default server remains Node.

Native external Chat imports and history discovery now include their SQL
repository, durable executor, HTTP routes, opaque attachment relay, hydration,
ordered Live publication and crash recovery. Local comparison passes all three
storage modes and authentication modes; real interruption tests also corrected
atomic publication and private PostgreSQL ownership handoff. See the
[Chat import qualification](RUST_SERVER_CHAT_IMPORTS.md) for exact evidence and
remaining product/platform acceptance. The full replacement remains in progress.

The native durable Chat relocation server now has repository, hydration, HTTP,
job, Live, recovery and shutdown implementations. Local storage/authentication
comparisons and real PostgreSQL interruption tests also reproduce and correct
two shared Node/Rust target-cleanup safety bugs. See the
[Chat relocation qualification](RUST_SERVER_CHAT_RELOCATIONS.md) for exact scope,
reproduction commands and remaining full-worker/platform/product acceptance.
The default server and overall replacement status remain unchanged.

Validation policy, updated November 4, 2026: run development and milestone checks
locally. GitHub Actions is reserved for releases and deployments. Historical CI
results below retain their original scope; they are not instructions to dispatch
new validation jobs or wait for retired hosted checks. Record actual local
results and platform limitations without treating unrun checks as passing.

The Git/worktree/Run milestone broad `pnpm check` exited 1 with 1,633 server
tests passing, two failing and 57 skipped. Both failures were freshly reproduced
on clean Primary `b04530e3c`: the pooled-provider assertion in
`local-foundation.test.ts:7218` and the missing `getModelRuntimeByRoute` mock in
`terminal-managed-session.test.ts`. This does not make the broad check green.
Reports: `.qa/rust-server/git-milestone-check-v1-exit.json` and
`git-milestone-baseline-server-v1.log`. PR #2332's conversation-view changes were
integrated by regenerating the combined contracts rather than replacing either
feature set.

Status: **implementation in progress; not a deployable replacement**.

The MCP capability registry now matches all 55 current Source operations and
their order. Forty-six use the ported server domains; help and eight web
operations retain the existing worker implementation. The worker uses advertised
web operations when selecting its allowed tools, including standalone web Chat.
The server preserves Source mutation/read-only authority and direct
HTTP errors rather than executing worker-private browser or research content.
The unchanged production MCP broker, HTTP SDK and WorkerWebService are exercised
with controlled search/fetch/browser boundaries. This establishes negotiation
and routing compatibility; full worker/native/browser product acceptance and
legacy CLI transport remain required.

Integrated with Main `3dd936255`, the macOS arm64 comparison passes all three stores and all
three authentication modes: 657 paired direct cases, 1,314 responses/audit rows,
54 actual MCP tool catalogs and 540 MCP calls. The full ordered registry,
mutation classification and 8,360 authority/readiness cases match Source.
Fifty-one Rust library tests, two contract tests, 34 worker tests, 23 server
tests, strict all-target Clippy and all three application typechecks pass locally.
The broad `pnpm check`
still stops at Main-identical Node decomposition limits: 1,524/1,500 lines in
`build-app.ts` and 2,249/1,999 in `chat-turn-runtime.ts`. A clean Main source
snapshot reproduces both failures; the broad check is not green.

The Task/Goal integration repair restores server, worker and app typechecks and
builds against base `1579245e9`. Retirement now reads the failure-evidence discriminator while retaining
the existing receipt, worker and dispatch guards. Historical output resolves its
physical worktree through the owning project source. Goal observations use the
actual worktree path and project relationship. Thirty database regressions cover
these paths, including original-root attribution, owner isolation, changed
observation fences and failure classification. The old implementation reproduces
four authority/observation failures and two wrong-root historical writes.

The initial qualification against base `d9e8ddf11` supplies thirteen previously
missing protocol fixture roots. Its broad native wire suite passes 619,692 comparisons across 625 roots, both
generated-manifest equality checks and 69,648 ECMAScript JSON round trips. The
outgoing worker envelope separately passes 298 complete requests, 86 boundary
cases and 241,091 mutations, executing all 100 registered refinement callbacks.
Its refreshed fixtures preserve all 295 previous command inputs and 1,134
alternative cases. All 625 other roots retain identical fixture inputs.
Focused Task input
and Run input oracles pass 1,692 and 2,617 comparisons. The local broad
TypeScript suites still fail: server 60 failed / 1,699 passed / 58 skipped;
worker six failed / 2,745 passed / 225 skipped. Every failing test heading was
reproduced on a separate clean `d9e8ddf11` checkout. These counts describe that
frozen baseline, rather than later additions to Main. The broad repository check
also stops on unchanged Node source line limits. These failures remain required
acceptance work. Native worker tests requiring a current built runtime remain
separate; passing typechecks and builds do not establish native product readiness.

Integration with `1579245e9` adds the four Task provider-transfer fixture roots
and the settled/revoke worker messages. All 630 roots have valid Source fixture
samples. The updated corpus preserves all 298 prior command inputs and 1,154
alternative cases. Rust integration fixes retain JavaScript-string dispatch keys,
use an explicitly typed empty provider array and convert settlement validation
through the existing response error adapter.
The complete base suite passes 631,962 comparisons across 629 roots, both
manifest checks and 69,648 JSON round trips. Its separate outgoing-worker suite
passes 299 complete commands, 86 boundary cases and 241,601 mutations, executing
all 100 authoritative refinement callbacks.

The subsequent integration with `9a384ee0a` supplies native Goal attempt samples
through admission, managed queues and queued handoff state/configuration. All
631 roots have valid Source samples. A fresh native parser passes 59,894
comparisons over the seven changed roots and one new root. Exact reachable-graph
comparison and fixture digests retain the other 623 roots, including the
outgoing-worker envelope; the wire interpreter source is byte-identical across
this integration. This preserves the earlier full-corpus evidence without
claiming another full run for the newer source. Typechecks, builds, protocol
tests and all 31 database regressions pass after integration.
The first-cycle Goal-claim addition in `50edd969c` is covered by another 47,713
comparisons across its three changed handoff schemas. Samples retain pending
claims with and without a native attempt, both withdrawal values and their
canonical operation identities. Exact graph and fixture checks preserve the
other 628 roots. All 631 roots have valid Source samples (2,114 samples).

The full-worker folder harness accepts `--task-diagnostics` to select its
development SQL fixture executable. On a Task failure it captures eight scoped
operational tables from the server's open database before worker teardown,
using one read-only, repeatable-read transaction. It preserves the original
failure if evidence collection also fails. The production executable does not
include this SQL endpoint. A thirty-first database regression exercises the
actual queries and rejects other owner/project scopes. This evidence-capture
test does not establish successful native Task or Goal execution.

The worktree MCP port implements six advertised operations: list, status, create,
switch, release and remove. The surface milestone advertised 46 of Source's
55 MCP operations; the worker-local capability follow-up completes the registry.
`worktree.acquire` belongs to the shared legacy CLI executor and is rejected by
the MCP allowlist, including when a binding explicitly grants it. Legacy CLI
transport and its acquisition behavior remain separate required work.

The surface milestone adds twelve native MCP operations: Explorer list/read/write,
terminal read/send/restart, browser services/open, and client notify/focus-project/
focus-surface/show-interaction. It reuses the native resource and Live services,
keeps endpoint content opaque, and permits exact targets on another owned worker
as Source does. Four independent generated input contracts remain valid after
unrelated growth of the base schema graph. Interaction reads retain Source SQL
diagnostics and original UTF16 parameters after an actual query failure.

Qualification integrated with Main `18a925160` passes 232 paired response/header/worker-command/
Live-event/audit/durable-state scenarios across all three stores and authentication
modes: 2,088 pairs, 4,176 HTTP responses, 18 disconnected callers, 4,194 audit rows
and 18 server restarts. Tests include actual ten-second control expiry, protected
notification endpoint decryption, ownership/provenance isolation, folder roots,
Run-terminal restrictions, committed browser writes after worker failure and
second-worker dispatch. Concurrent browser-placement SQL reads retain either
Source first failure; every diagnostic and original parameter is verified before
normalizing that scheduling choice. The Unicode regressions fix a native
Live control JSON panic and verify unpaired UTF16 in actual client-control frames.
All 44 Live core scenarios also pass. These are controlled endpoint peers, not full native
worker or supported-platform product acceptance. The worker-local follow-up
preserves the remaining nine MCP operations in the unchanged worker. Legacy CLI,
migration/rollback, packaging and the full replacement goal remain.

The worktree handlers retain Source argument order, history visibility, pagination
caps, status truncation, UTF16 summaries, capability/permission guards and durable
lane scheduling. Agent removal uses serialized Run retirement, worker removal
and inventory reconciliation. The MCP result retains the worker's full removal
inventory; its retained database row becomes missing, matching Source's MCP
behavior. The public removal route separately records a removed state.
Actual failed transition writes retain captured Source ORM diagnostics and the
original JavaScript parameters. No configuration is rejected before attempting
the real SQL operation. A NUL-purpose regression verifies the entire transaction
rolls back its earlier pending-lane suspension. Generated error clocks are
bounded and all SQL/parameter text is checked before comparison normalization.

Local integrated qualification passes 102 MCP cases per peer across all three
stores and all three authentication modes: 918 pairs, 1,836 responses, 18 actual
socket disconnects, 1,854 matching audit rows and 18 server restarts. Each dropped
socket closes after worker admission and its removal completes once. All peers
fence the old execution after restart. NUL-purpose coverage retains unpaired
UTF16, literal replacement characters and comma-containing parameters through
real SQL failure and rollback. The controlled worker uses production
WorkerConnection but supplies Git replies; full-worker/native product and
supported-platform acceptance remain required. Node remains the default server
and the worker remains Node.

The frozen `20001aa43` integration supplies OS recovery result fixtures for all
five result kinds. All 633 base roots have valid Source samples (2,121 samples),
and all 643 existing fixture arrays retain identical serialized JSON. Fresh base
and independent Run manifests equal Source. Fifty Rust library tests and five
focused OS/MCP contract/binding tests pass. The two published OS recovery schemas
are explicitly included in the export review while preserving all existing
fingerprints. The reviewed inventory adds only the owner-scoped OS recovery
route: 543 routes, 299 worker commands, 116 declared tables and 367 repository
methods. All previous route classifications and other reviewed contract digests
remain unchanged.

The live Task evidence helper now returns the `result` SQL column required by the
Node fixture gateway. Both peers exercise all eight capture queries through
actual HTTP before the worktree cases. The database regression retains its owner
and project scope assertions. This repairs evidence collection without claiming
successful native Task/Goal execution.

Integration with `50e2760be` repeats all nine worktree MCP profiles successfully:
918 paired cases, 1,836 responses, 1,854 audit rows, 18 dropped sockets and 18
restarts. The live Task snapshot now includes `chats` and `managed_queue_states`
alongside its original eight tables. Both implementations retain an unknown
suspension record and the canonical Goal-recovery marker through the real HTTP
SQL gateway, before explicit disposable-fixture cleanup. Owner and project
isolation remain covered by the database regression.

All 648 current base roots have valid Source samples (2,208 samples). New samples
include Goal-recovery source/admission/fencing/withdrawal, queue marker defaults,
negative-dispatch ownership challenges and queued handoff state. The four worker
continuity kinds accompany all five OS recovery outcomes. The refreshed outgoing
corpus retains all 299 prior command inputs and all 1,156 alternative input cases,
adding `chat.goal.recover` and one enclosing alternative. Exact reachable graphs
retain 609 earlier roots; 15 roots are new and 24 changed. Another 627 existing
fixture arrays retain identical serialized JSON. Base and independent Run
manifests equal the authoritative current Source definitions.
A native streaming parser passes 142,724 complete Source value, issue and exact
error-message comparisons over all 38 changed or added non-worker roots. The
outgoing-worker envelope separately passes all 300 command fixtures, 86
boundary cases and 242,426 mutations, executing all 100 authoritative
refinement callbacks. Strict all-target Clippy passes
with warnings treated as errors. All 50 rebuilt Rust library tests and five
focused OS/MCP contract and binding tests pass.
A focused PGlite/anonymous Run-MCP regression retains 113 paired HTTP cases
through the shared MCP error adapter.

The current integration repairs actual Rust compile failures in nested native
JSON construction and preserves weak session references by iterating the existing
Codex runtime registry. Worker admissions retain integrated Main's options shape; autonomous Goal
admission still requests its explicit continuation option, asserted by the
existing test. All 1,114 protocol tests, 46 focused
worker tests and 46 Task-authority/suspension database tests pass. Server, worker
and app typechecks pass. These checks do not establish successful full native
Task/Goal execution.

Integration with worker-only Pause changes in `4af03a674` preserves the qualified
server/protocol/transport inputs. All 62 focused worker session, handoff, client
and suspension tests pass after retaining Main's admission options and assertions.
This does not establish actual native Pause or Task/Goal product acceptance.

The frozen broad Node server run exits with 122 failed, 1,571 passed and 133
skipped tests; many failures are migration/setup timeouts. The frozen worker run
has 13 failed, 2,741 passed and 235 skipped tests. A focused timing rerun passes
five of seven cases, retaining GitHub lifecycle and encrypted-history timeout
failures. These broad failures have not all been reproduced on a clean matching
baseline and are not treated as passing. The current root `pnpm check` stops at
unchanged Source line budgets (`build-app.ts` 1,519/1,500 and
`chat-turn-runtime.ts` 2,230/1,999). Their source and checker bytes match integrated
Main. Full product, supported-platform and replacement acceptance remain active.

The Run configuration MCP milestone adds twelve operations to the Rust registry,
bringing the supported set to twenty-eight. It reuses native definition, secret,
lifecycle and encrypted-output services. Reads validate the exact worker used
for dispatch; mutations retain Primary-worker prevalidation and eager project
coordination. Public Run response and error contracts remain covered separately.
Local coverage includes a real secondary worker, Primary movement during an
in-flight read, read-only/standalone rejection, actual server restarts with fresh
execution authority, retained receipts and endpoint-decrypted output. SQL error
context attaches only after the native worktree query fails and preserves the
original JavaScript text parameters. The existing nine captured target queries
are unchanged. The 113-case suite passes all three stores and all three authentication modes
(1,017 pairs, 2,034 HTTP calls/audit rows, 18 restarts, 36 output proofs), including
UTF16/NUL lookup cases.
The public Git/Run HTTP regression passes all nine storage/authentication profiles:
1,089 paired observations and 2,178 calls. Each peer has 116, 120 or 127
observations according to authentication mode.
Run input schemas live in a self-contained generated graph. Rust relocates its
references when composing it with the base graph, so unrelated base graph growth
cannot silently change Run schema references during a clean Git merge. The base
manifest retains all 626 roots and 10,545 nodes byte for byte from `9a6be65e9`.
Local regression coverage compares Source outcomes after three base graph sizes.
The refreshed reviewed inventory has 540 routes, 298 worker commands, 116 declared
tables and 367 repository methods. Its additions cover the existing inference
resource authorization, Task outcome delivery, inference revocation, captured OS
tunnel preparation and owner/revision-only provider catalog fencing. Existing
route content classifications are unchanged.
These controlled-worker results do not establish full native product or platform
acceptance; the worker remains Node and the default server has not changed.

Native PGlite runtime reuse now attempts initialization with existing asset
directories, including packaged assets without the optional extraction marker.
A missing marker no longer blocks startup. New runtime extraction retains actual
filesystem errors, and incomplete assets report the actual executable error.
Local subprocess coverage reproduces the old rejection, then verifies fresh
initialization, retained database writes, transaction rollback and unchanged
runtime asset bytes/links without the marker. Current Task round terminal writes
also use PostgreSQL JSON parameter bindings; their previous direct wire-value
bindings did not compile. Full product, migration and platform acceptance remains
separate from these storage checks.

The execution-target MCP milestone integrates `2d68134ec`. Rust advertises
sixteen operations, including `target.list` and `target.inspect`. These reuse
the native owned catalog and placement services, retaining Source filtering,
JavaScript trimming, pagination defaults and limits, unavailable resources,
browser state revisions, read-only grants and safe read-binding transitions.
Stored Chat validation runs before filters; the other opaque projections retain
Source's pass-through behavior. Actual database failures retain Source SQL,
original UTF-16 parameters and MCP classification. Public query execution and
the stored-Chat error's existing display text remain unchanged.

Local real HTTP and authenticated WorkerConnection comparisons pass 117 cases
per peer/profile on all three stores and all three authentication modes:
1,053 pairs, 2,106 calls/audit records and eighteen actual server restarts.
The fixtures exercise actual invalid database text parameters, corrupted owned
and foreign records, a 2,000-target catalog, encrypted labels and retained
browser revisions. Concurrent browser/desktop lookups may expose either failing
Source statement; both raw outcomes are retained and checked against captured
Source SQL and every original parameter before comparison. Independent account
IDs are normalized only after verifying the actual owner in each diagnostic.
These target suites use controlled worker transport and do not establish full
worker product acceptance.

Two named contract exports reuse existing nodes. All 617 integrated Source root
references and all 10,411 ordered nodes remain unchanged, with 619 roots total.
The incoming inference evidence export is explicitly reviewed in the existing
public-surface test; its prior fingerprint and positive assertions remain.
Strict all-target Clippy passes after retaining the Goal predicates' exact
short-circuit order, boxing the optional inference error payload without
changing its contents or cloning semantics, and keeping the legacy observation
fixture's unguarded behavior explicit.

All three package typechecks, 1,100 protocol tests and 37 focused Source
executor/binding/Goal tests pass. Incoming Goal callback annotations now retain
the actual user message, and the existing Task guard's narrowed routing type is
preserved without changing runtime values. Goal fixtures assert the current
launch guard, physical input receipt and lane activation fence, including no
pause for an unrecognized turn. Public repository comparisons pass 431 cases on
each store, plus 62 descriptor-builder cases. Their placement-change fixture now
moves worker and source together while retaining the active-runtime binding
rejection assertion. The integrated Goal preparation guard now constructs its
nested native JSON explicitly, round-outcome routing retains the Task type
established by its guard, and retry argument references satisfy strict Clippy.
The reviewed inventory adds only `surface.desktop.os-prepare`: server-derived
Linux execution identities return a desktop generation, while private target
state and pixels remain endpoint protected. The inventory now has 296 worker
commands and 256 migrations; prior classifications remain unchanged.

Separately, the pinned native runtime for baseline `067906537` has 62 verified
patch files through `0061`, digest
`69a8c39407fe460dee6cc92bd0229e2bdbf5ff6456547ccc0bffd214ced7e412`.
The unchanged browser/full-worker/native Task scenario passes against both
servers on PGlite: eleven steps per peer, seven actual MCP calls and four worker
exits with code zero per peer. The browser decrypts the actual native child
answer; server/worker restart retains the exact transcript without duplicate
model inference. The original shutdown assertions and deadlines remain. This is
that pinned baseline's evidence; newer Task/Goal input patches, other databases,
supported platforms and full replacement still require qualification.

Run target verification locally:

```sh
node --import tsx scripts/server-rust/agent-target-http-compatibility.mjs --database pglite --report /tmp/mcp-target.json
node --import tsx scripts/server-rust/mcp-target-query-manifest.mjs
node scripts/server-rust/cargo.mjs test --test mcp_target_contracts --test mcp_operation_contracts --test worker_bridge --test worker_command_budgets
```

Repeat the HTTP suite with `postgres` and `bundled-postgres`. Retained startup
failures hit Node's existing 60-second deadline before any MCP calls; subsequent
full comparisons passed without changing deadlines. The repository decomposition
check still fails on the unchanged Node `native-commands.ts`: 2,049 lines against
its 2,000-line budget. The same check was executed on an extracted `dd0ba7161`
baseline and reproduced the failure with identical source bytes. This milestone
does not claim a green broad `pnpm check`.

The context and policy MCP milestone integrates `b5ea4ba84`. Rust now
advertises fourteen operations, adding `context.compact`, `policy.list` and
`policy.read`. Compaction retains Source's current-turn authorization result;
the worker remains responsible for executing it. Policy reads retain project
scope, mandatory/workspace/direct assignment order, JavaScript string trimming,
read-only permissions and opaque content. Standalone chats retain the IDE
unsupported-capability response. Stored-record validation and actual database
failures preserve Source's MCP error classification, exact ORM SQL/parameters
and 2,000 UTF-16-unit limit. Public policy readers keep their existing error
messages and database operations.

Local real HTTP and authenticated WorkerConnection comparisons pass all three
stores and all three auth modes: 47 calls per peer/profile, 423 pairs and 846
audit rows. Eighteen actual server restarts preserve encrypted policy content
and assignments; endpoint crypto verifies 54 policy reads. Nine real query
failures per peer/profile cover all eight distinct Source policy statements,
including argument/query precedence. Private summary/body text never appears
in observed HTTP, worker command or server log data. Independently encrypted
peer results are compared only after verifying each actual stored envelope and
blind index; the report retains the raw ciphertext and query failures.

Both added policy result roots pass 1,026 actual Source normalization, issue
and error-message comparisons; the existing compatible-binding target passes
another 2,432. All 614 prior root references and all 10,365 prior ordered nodes
remain unchanged. The combined manifest has 616 roots and 10,367 nodes.
An incoming computer-use validation condition is expressed as a let-chain for
strict Clippy; its predicates and short-circuit order are retained.

The integrated Task input contract also checks canonical round, input, provider,
placement and dispatch-fence bindings in the Rust worker validator, preserving
Source issue ordering. Task dispatch and inference recovery return their distinct
invalid-request codes. The new local oracle and HTTP suite compare validation
and rejection boundaries; successful canonical Task dispatch and native restart
acceptance remain required. The reviewed inventory now includes 538 routes;
only the Task input dispatch route was added, with prior classifications retained.

The integrated logical-input helper rejects an absent session identity before
checking its thread. The admission regression follows Source #2534's supported
standalone Agent input: it checks durable scratch-lane ownership and retains a
rejected standalone case for the selected runtime's GUI-origin restriction.
Standalone GUI queue coverage asserts accepted scratch ownership, encrypted
input retention, queue revision, immutable replay and foreign-owner rejection.
The inventory regression follows Source #2507: configured endpoint routes remain
eligible for an authorized attempt despite past availability observations.
Account providers retain authoritative worker/account filtering, including exact
UTF-16 identity isolation. The local PGlite regression passes 1,580 paired cases
and 1,359 execution-state snapshots; public policy HTTP passes 80 cases per
runtime with actual encryption, publication and query-error assertions.

Run this milestone locally:

```sh
node --import tsx scripts/server-rust/agent-policy-http-compatibility.mjs --database pglite --report /tmp/mcp-policy.json
node --import tsx scripts/server-rust/mcp-policy-query-manifest.mjs
node scripts/server-rust/cargo.mjs test --test mcp_policy_contracts --test mcp_operation_contracts -- --nocapture
```

Repeat the HTTP suite with `bundled-postgres` and `postgres`. These checks use
controlled worker transport and actual endpoint crypto; they do not establish
full native-worker compaction/lifecycle or supported-platform packaging
acceptance. Execution-target, Run, surface and other MCP domains, coordination,
upgrades, post-write rollback, artifacts and default cutover remain unfinished.

The atomic MCP chat-delivery milestone starts from `dd9a1303f`. Rust now
implements `chat.send` and advertises eleven MCP operations. The worker continues
to prepare and open encrypted messages. The server checks Source's delivery
identities and classifications, resolves the receiver's current model settings,
preserves its autonomy pause and commits its queue entry and both history copies
in one transaction. Project-first and sorted chat locks serialize opposite
directions. Committed replays retain their original records despite fresh worker
encryption, changed receiver configuration or a later missing default model.

Local HTTP, audit and worker-encryption comparisons pass all three stores and
authentication modes: 41 calls per peer/profile, 369 paired cases and 738 audit
records. Eighteen actual server restarts retain the protected messages, queue
entries and delivery receipts. Eighteen real failures of the third INSERT roll
back the queue and receiving copy; a subsequent retry commits once. Initial
simultaneous duplicates retain exactly one of the actual submitted ciphertext
pairs. An additional PGlite scenario routes to another worker and placement,
checking the receiving receipt and history attribution while retaining the
caller's placement for its sent copy. Both persisted history events appear after
successful delivery or replay;
failed transactions publish neither. The unchanged worker code decrypts both
transcripts before and after restart. Each cursor and sequence order is checked
against the actual database. Independent reverse-direction requests can commit
in either order; only that concurrent suffix is canonicalized across peers.

The GUI queue helper now honors Source's explicit `resumeAutonomy: false`.
Its normal path and the new transaction-bound path share envelope construction.
Actual Source message INSERT SQL and driver parameter encodings are captured
from the repository. MCP-only diagnostics attach them after an INSERT fails,
retaining Source's 2,000 UTF-16-unit response limit. Each fault check verifies the
whole statement and actual request-bound encrypted parameters before comparing
independently encrypted peers. Public message writers retain their existing
failure classification.

All 610 previous ordered schema graphs and the native validation engine remain
unchanged. One new root passes 4,339 Source normalization, issue and error-message
comparisons; the combined manifest has 611 roots and 10,340 nodes. Local checks
also pass 1,054 protocol tests, 34 focused Source tests, three typechecks and
strict Clippy. Managed-queue regressions pass 129, 129 and 133 cases on PGlite,
private PostgreSQL and external PostgreSQL; public message writes pass 62 cases
per store. The earlier Task and read matrices have separate regression reports.

Run delivery validation locally:

```sh
node --import tsx scripts/server-rust/agent-chat-send-http-compatibility.mjs --database pglite --report /tmp/mcp-chat-send.json
node --import tsx scripts/server-rust/mcp-delivery-query-manifest.mjs
node scripts/server-rust/cargo.mjs test --test mcp_chat_send_contracts -- --nocapture
```

Repeat the HTTP suite with `bundled-postgres` and `postgres`. These scenarios use
controlled WorkerConnection peers and the actual worker MCP/encryption functions.
They do not establish full native-worker lifecycle or supported-platform artifact
acceptance. Other MCP domains, remaining operation failures and coordination,
upgrades and post-write rollback, packaging and final cutover remain unfinished.
Normal app/server entrypoints still use Node; the worker remains Node.

The MCP chat-read milestone integrates `d075cd30a`, including native
deferral/recovery and independent helper admission identities. The original local
candidate used `233f548ab`. Rust now implements
`chat.list`, `chat.read` and the server-side `chat.wait` read contract. It retains
project Agent scope, opaque labels/messages, model inheritance, complete user-turn
pages and the cursor over the latest 20-message window. `maxChars` remains a
worker concern. The six MiB relay cap retains the maximal suffix of whole wire
messages and updates paging metadata. Context probes preserve the public nine
fields, ignore operation arguments as Source does, use the worker-labelled
summary and readiness suffix, and correctly recognize permitted Task mutations.
Standalone context probes retain Source's unsupported-capability response.

The original local candidate passes paired HTTP/audit checks on all three stores
and all three auth modes: 42 cases per peer/profile, 378 pairs and 756 calls/audit rows. Eighteen real
server restarts preserve the receiving transcript and cursor; recovery rejects
an old inactive caller before a fresh controlled turn resumes reads. The relay
case stores 100 opaque 70,000-character ciphertexts and returns exactly the last
89 messages (6,288,919 bytes, starting at sequence 12). The preceding message
cannot fit. Ciphertext and autonomy-pause changes alter the exact cursor;
pagination, empty older pages and `maxChars` leave the latest-window cursor
unchanged.

Six actual catalog/header/opaque-row failures per peer/profile preserve exact
Source ORM SQL, parameters and UTF-16 error limits. Two tests retain validation
of hidden Task descriptors before filtering/target lookup. The Source ORM query
manifest is generated by executing the actual repositories through Drizzle's
proxy. Native wrappers attach it only after a real query fails; healthy public
reads retain their existing SQL and mapping. MCP response-validation failures
use Source's generic validation message.

The three new schema roots pass 3,046 Source/native comparisons; the earlier
compatible-binding suite passes another 2,432. All 607 ordered graphs from the
integrated base and the validation engine are unchanged. The combined manifest has 610 roots and 10,337 nodes. The original
candidate separately proved its 605 prior graphs unchanged at 608 roots/10,289
nodes. Integration validation is recorded separately against the combined
candidate. Original local checks also pass 21 paired standalone/Task-caller scope
cases, all 216 prior Task HTTP pairs across the storage/auth matrix, 1,054
protocol tests, 34 Source tests, three typechecks, strict Clippy and Rustfmt.

Integration fixes five incoming native recovery compilation errors using the
existing typed response validator and JSON constructors. The seven new recovery
and timing exports are reviewed explicitly while retaining the old public-surface
fingerprint. The reviewed inference-recovery route carries worker-authenticated,
process-generation-bound journal metadata; encrypted input stays in the existing
queue. All 536 previous route classifications remain unchanged, giving 537 routes,
295 worker commands and 47 Live resources. The combined protocol suite passes all
1,054 tests and the regenerated boundary audit passes locally.

Run these checks locally:

```sh
node --import tsx scripts/server-rust/agent-chat-read-http-compatibility.mjs --database pglite --report /tmp/mcp-chat-reads.json
node --import tsx scripts/server-rust/agent-context-scope-http-compatibility.mjs --report /tmp/mcp-context-scope.json
node --import tsx scripts/server-rust/mcp-read-query-manifest.mjs
node scripts/server-rust/cargo.mjs test --test mcp_chat_read_contracts --test mcp_operation_contracts -- --nocapture
```

Repeat the read suite with `bundled-postgres` and `postgres`. That milestone
advertised ten native MCP operations; the later atomic delivery milestone above
adds `chat.send`. Remaining MCP domains and current native/platform/product
acceptance remain unfinished. The earlier
full-worker shutdown failure remains an open lifecycle result; these controlled
WorkerConnection checks do not replace that acceptance.

The MCP Task admission milestone is based on `64b2e4961`. Native Task tools
now use dispatch enqueue directly, retain retry history, preserve request order
and deduplication, return the Source validation/error contracts and append the
authenticated worker owner's audit before publishing HTTP. Audit failures remain
best effort after a committed mutation. The public Task start path retains its
retry reset. Read-only project bindings follow Source's safe lane-transition
rules; mutation bindings still require the exact lane and permission context.

The HTTP relay now uses the actual Source compatibility schema. It accepts
legacy bindings, discards unknown claims and filters future grants before strict
authorization. The manifest contains 605 roots and 10,266 nodes. All 603 previous
ordered schema graphs are unchanged; the new transform is unreachable from every
old graph, and the previous parser dispatch/refinements retain their bytes.
The two new roots pass 2,432 Source/native value, issue and exact-error comparisons.

All three stores and all three auth modes pass 24 paired Task HTTP cases per
peer: 216 pairs and 432 calls, including actual query/audit failures and 21
matching audit rows per peer/profile. The retry-history suite covers MCP and
public starts on the same matrix, preserving opaque payloads, model selection,
revision and operation identity through 36 real server restarts. MCP retains the
latched retry history; public start resets it. Local checks also pass 1,054
protocol tests, 44 Source tests, three typechecks, strict all-target Clippy,
Rustfmt and the existing Alert-source HTTP scenario.

Local PostgreSQL tests prove that all 18 successful, invalid and forbidden calls
across the three auth modes withhold HTTP headers until the real audit INSERT
finishes. Six more cases abort the caller while that INSERT is blocked and
verify its audit still commits after release. Another 12 create/replay calls
observe one committed Task/cycle and both App Live invalidations while a real audit INSERT is blocked; after the
trigger raises, both servers still return 200 without an audit row. Eighteen
additional create/replay calls observe no extra retry-reset transaction. Before
the fix, terminating that extra transaction's real PostgreSQL backend produced
500 after the Rust dispatch commit in each auth mode; the retained before and
after reports distinguish the actual interruption from its corrected absence.

Run these development checks locally:

```sh
node scripts/server-rust/cargo.mjs test --test mcp_operation_contracts -- --nocapture
node --import tsx scripts/server-rust/task-read-query-manifest.mjs
node --import tsx scripts/server-rust/agent-task-http-compatibility.mjs --database pglite --report /tmp/task-mcp-http.json
node --import tsx scripts/server-rust/agent-task-retry-history-compatibility.mjs --database pglite --report /tmp/task-mcp-history.json
node --import tsx scripts/server-rust/agent-task-postcommit-compatibility.mjs --report /tmp/task-mcp-postcommit.json
node --import tsx scripts/server-rust/agent-task-audit-publication-compatibility.mjs --report /tmp/task-mcp-audit.json
node --import tsx scripts/server-rust/agent-task-audit-failure-compatibility.mjs --report /tmp/task-mcp-audit-failure.json
CANTRIP_CODEX_BIN=/absolute/path/to/bundle/codex node --import tsx scripts/server-rust/actual-folder-client.mjs --project-chats --agent-tasks --database pglite --report /tmp/actual-native-agent-tasks.json
```

Repeat the two database-parameterized suites with `bundled-postgres` and
`postgres`. Each runs anonymous, password and account modes. The native scenario
uses the existing encrypted browser APIs, unchanged full worker and actual
native MCP tools to create/replay an encrypted child, execute it through the
scheduler, wait for completion and recover its transcript after server/worker
restart. Artifact provenance remains part of each acceptance result. The
older reference bundle fails current patch verification and actually rejects the
worker ownership command (`--scope`). A separately built local candidate uses
the current 51 patches plus unmerged native patch 0052 (artifact patch digest
`ce401e59e302422924639b2bb8b5ee2310b364fc7448ba1644d904e355270a6a`). With
that candidate, both Source and Rust complete seven actual native Task tool
calls: list, create, replay, list, status, paused wait and completed wait. The
unchanged worker executes the child and the browser decrypts its actual native
answer, with inherited model and Goal mode off. Captured browser/server requests
do not contain the private child text.

Both runs then fail the unchanged worker shutdown assertion at
`full-worker.mjs:172`; the final worker-stopped log is absent. Native restart
acceptance is not reached. The paired process and isolated Rust investigator
remain failed results, and the candidate is not exact-current-patch packaging
acceptance. Reports and a separately asserted execution subset retain those
limits. Other MCP domains, supported-platform packaging, shared coordination,
migrations/rollback and the default server cutover remain open.

The latest integration includes main `2031c9884` and worker-owned inference
snapshots over HTTP and owner-scoped Live. It corrects two native compile errors
in the incoming status implementation and retains connection identity through
the Source metering wrapper; the real Source HTTP test failed 409 before that
missing delegation was restored. Both implementations now accept valid private,
non-cached snapshots and reject foreign/retired identity fields and malformed
worker replies. An ordered Live barrier proves that only revisions 1000 and
1005 publish after duplicate and foreign notifications are rejected.

Current local paired HTTP checks pass all three stores and all three auth modes:
167, 171 and 174 observations per peer, or 512 per store. The four changed
schema graphs pass 54,709 additional complete Source/native comparisons; the
other 599 graphs and native validation engine are unchanged from the validated
endpoint candidate. The manifest remains at 603 roots with 10,242 nodes.
All 294 earlier primary command objects and 1,131 case objects retain their
property/relative order; `inference.status` brings totals to 295 commands,
1,132 cases and 1,168 coverage descriptors (61 unions/530 alternatives and
164 enums/638 alternatives). Every earlier incoming worker fixture is retained.
The boundary review preserves all 535 previous route classifications, all 294
command classifications and all 46 Live classifications while explicitly
classifying the added snapshot route, status command and Live resource.

All 1,054 protocol tests, 14 focused Source metering/deadline/notification tests,
three typechecks, strict all-target Clippy and Rustfmt pass. Current native
checks pass 295 primary requests, 86 boundaries, six bridge tests, two request
admission tests and three budget tests (13 Source timelines/135 complete
snapshots). Formatting, reviewed boundary inventory and diff checks pass.
These results remain local macOS evidence; the full replacement is unfinished.

The settings integration validated at `aee580909` is based on main
`aae5906d4`. It preserves
worker-owned endpoint discovery for LM Studio, llama.cpp, vLLM, Unsloth and
LiteLLM, including separate catalogs for separate provider instances. Connection
tests accept the same endpoint kinds as Source, retain account sign-in
diagnostics and return provider-labelled failures without exposing worker error
details. The native diagnostic regexes preserve JavaScript's UTF-16 unit
semantics, including context-error matching at surrogate-pair boundaries.

The combined manifest has 603 roots and 10,234 nodes. Its nine changed graphs
and one added endpoint inventory root pass 81,622 Source/native comparisons;
the other 593 graphs and native validation engine are unchanged. All 293 prior
primary command objects and 1,107 alternative cases retain their property order
and relative order. The current corpus contains 294 commands, 1,131 cases and
1,167 coverage descriptors, covering 61 unions/529 alternatives and 164
enums/638 alternatives. The reviewed addition is `model.endpoint.catalog`,
classified as endpoint-protected. All previous command classifications and
all 535 route keys retain their reviewed contracts. The migration chain remains
at 252 entries.

Local checks pass 1,054 protocol tests, 29 focused server tests, 33 worker tests
including actual native endpoint execution, 45 client tests and all three
typechecks. Provider diagnostics pass 1,118 actual Source comparisons and 513
response-contract cases. Paired settings-operation HTTP checks pass all three
database modes and all three authentication modes: 159, 163 and 165 observations
per peer, or 487 per store. Catalog checks pass on all three stores with 84
account-mode and 77 local-mode observations per peer, including endpoint
instance isolation, loaded states, stale recovery, abandoned callers and
restart. The 999/1,000/1,001-model inventory boundaries, strict all-target
Clippy, Rustfmt, reviewed boundary inventory and changed-file formatting pass.
These results retain their local macOS scope and do not establish final
platform, packaging or deployment acceptance.

Native PGlite boot now restores the host's Unix SIGINT/SIGTERM handlers before
reporting readiness. PostgreSQL's backend handlers were otherwise chained into
host shutdown and aborted database work that still needed to drain. An owned
process regression installs host listeners before and after native boot, sends
real SIGTERM/SIGINT, commits a post-signal write and closes the database. At
`fc4c084b2`, the optimized macOS arm64 executable also exits cleanly on both
signals in standalone and desktop bootstrap modes with checkout reads and
JavaScript execution denied. It recovers the interrupted profile's identity and
accepted setting before a new write. Full packaging and supported-platform
acceptance remain unfinished.

The optimized `918aead5c` executable repeats all four clean signal shutdowns and
recovers the older interrupted profile before new writes. A staged macOS runtime
also carries PostgreSQL 17.9, native `pg_dump`, relocated libraries and database
templates. Native PGlite profile export/restore and all three storage modes'
standalone/desktop-bootstrap operations pass with Homebrew, checkout reads and
JavaScript execution denied. The external database remains available after each
server exits. PostgreSQL's compiled relative directory layout
must be preserved for template discovery. This is a local artifact assembly
proof; product packaging, distribution notices and release signing remain
unfinished.

Current Source worktree projections include location kind and guest path. The
native query captures now retain both fields, and terminal-service reconciliation
uses Source's worker-local filter. A stored guest terminal previously made Rust
reject the entire service list because its host path is null; Source retained the
unrelated local service. The regression fails before the filter and passes across
all three stores afterward, including restart and SQL-error diagnostics: 69 paired
repository comparisons and nine paired state snapshots. These checks do not
establish complete CantripOS execution support.

Concurrent source registration exposed a shared PostgreSQL trigger lock upgrade:
canonical registration acquired a worker key-share lock before active-path
validation acquired the same worker's update lock. Migration 0251 renames the
registration trigger so path validation takes the worker lock first. The original
capacity, reconnect and fault scenarios then pass on both implementations across
all three stores: 60 provisioning jobs finish exactly once without retries.
Existing migration bytes remain unchanged. Complete profile transfer, interrupted
imports and reversal to Node after accepted Rust writes also pass with this
migration.

Current protocol coverage adds accepted and rejected inputs for 23 previously
uncovered alert, Goal, context and Task schemas. Worker command cases
cover alert content and sent/received communication; all 944 older inputs remain
unchanged, with shifted enum coverage references reconciled against Source.
Fixtures now use coherent source/worker pairs under the current identity
constraints. Settings assert the current Source 404 and exact error body for a
project unavailable on the selected worker.

The 23 new roots pass 18,158 native/Source comparisons, including exact error
strings. Alert projection errors preserve Source's `code`, `path`, `message`
order inside `Error.message`. Rejected inputs remain explicit boundary cases;
accepted inputs seed structural mutations. The legacy Task Worker model codec
keeps its public native validation, while outgoing-command coverage counts the
98 callbacks actually reachable from current commands. Moving that registration
leaves the generated native manifest unchanged.

The branch integrates upstream `d0a63ad6d`, including captured Linux runtime
environments, immutable OS chat/file/terminal placement, Linux-owned Git worktree
admission and source-specific Run definitions. The combined manifest has 596 roots
and 10,106 nodes, outgoing commands total 286, and the migration chain has 249 entries. The trigger-order migration follows
upstream's terminal-placement migration without changing either migration's SQL
bytes or any existing journal entry.
All 1,026 earlier outgoing fixture inputs remain exactly in order, including
the terminal/service and repository-fingerprint additions. Another 48 accepted
Run-definition examples cover all eight operations across Linux-owned/linked,
folder and SSH execution variants, bringing the corpus to 1,074. All 285 earlier
primary command inputs remain intact and the new command is appended. Current
Source traversal checks 60 union schemas/518 alternatives and 163 enum schemas/628 alternatives. Before the
terminal-placement integration, the rebuilt
protocol passes 1,040 tests. At `43a0df179`, all 217 native tests pass with no
failures or ignored tests, and the full worker suite passes with two test
workers (2,634 passed, 141 existing skips). Its frozen 27-stage matrix passes
26 stages, including all-store historical 244-to-248 upgrades and post-write
profile transfer/reversal. The remaining bundled project-chat stage fails on
an unhandled worker TCP reset during shutdown; that run is not green.

The corrected worker closes rejected native upgrades after flushing the same
401 response and handles peer reset errors. A real TCP reproducer fails before
the fix and passes afterward; all 29 original gateway tests remain intact and
the expanded 30-test suite passes on macOS and Windows. All 15 corrective stages
then pass against unchanged source, including all-store workspace and Task
controls, actual Node/Rust Task flows, and the previously failing bundled
project-chat flow with 19 steps and 11 clean worker stops for each server.
Formatting, worker typechecking and strict all-target Clippy also pass.

Task restart checks compare the complete accepted inference log before and
after restart, requiring all earlier inference to have completed. This detects
replays while allowing the native Goal runtime to omit its automatic idle turn
when explicit Task work wins admission. All other completion, encryption,
recovery assertions and deadlines remain intact. Windows process ownership
checks also compare creation times, excluding stale parent IDs from previous
process lifetimes while retaining actual descendant termination checks.
Current cross-platform CI and the unchanged Windows foundation test's original
15-second deadline remain required; the focused Windows run still times out
there. No deadline is increased or required behavior skipped.
The terminal-placement integration retains the current upstream stale-turn
fence, refreshes actual Source SQL captures and preserves both worker-local and
captured-OS maintenance restrictions. Its frozen `852cb574d` matrix completes
24 of 27 stages with source unchanged, including all-store historical 244-to-249
upgrades, post-write profile transfer/reversal, and actual Node/Rust chat/terminal
and Task flows. Those 12 runtime runs complete 222 product steps and 102 clean
worker stops. The three terminal HTTP stages fail against the current Node
reference because upstream now publishes exit status even after readiness.
That fourth invalidation is now required in both WorkerLink and direct bootstrap
cases; every other original assertion and deadline remains unchanged.

Native WorkerLink completion now records that exit independently of readiness,
preserving successful grants after readiness and typed command failures. A pinned
previous native executable fails the stricter event check after Node passes.
The five-stage correction matrix then passes with source unchanged: three native
contract tests, terminal HTTP/Live on all three stores and both authentication
profiles (1,255 matching observations per server), and the real-worker PGlite
chat/terminal flow (23 steps and 12 clean worker stops for each server). Strict
all-target Clippy and formatting pass. Full current platform CI remains required.
The worktree integration passes the full native/Source root-schema comparison,
worker-command fixture/boundary/mutation targets, HTTP and PGlite/PostgreSQL
repository tests. After the Run integration, an ordered graph comparison proves
591 existing roots and the native validation engine unchanged; the four added
roots and changed outgoing envelope receive focused native comparisons. Native
Run routing/repository and worker command-budget targets pass. The expanded
outgoing corpus passes all three native comparison targets. The current protocol
passes 1,040 tests, and worker/app typechecking and strict all-target Clippy pass.

The new Run-definition route resolves the owner's selected source/workspace Primary
and current runtime before worker-owned guest access. Its route and command are
reviewed as bounded Git-shared definition control with secret references only.
The Source coordinator's actual dispatch uses 180 seconds; native Run dispatch now
matches that budget while other CantripOS operations retain 600 seconds. The current
PGlite real-worker chat/terminal regression also passes on Node and Rust: 23 product
steps and 12 clean worker stops per server. The reviewed
boundary inventory classifies the added route and command while retaining endpoint
protection for private provisioning intent. At
`918aead5c`, all 215 Rust tests and the complete all-store historical-upgrade,
profile-transfer, replica, maintenance and actual-worker chat/Task matrix pass.
The upstream observation method's status/runtime/error arguments are now grouped
without changing its expected-runtime comparison or SQL parameters; all three
focused OS test targets and strict all-target Clippy pass afterward.

Storage accounting now classifies all 122 durable tables, including seven canonical
source and OS tables absent from the previous manifest. Guest worktrees resolve
their project owner through canonical source identities; the previous legacy
source join omitted them. A two-account regression checks seven added rows per
account plus two captured-conversation rows, exact independently measured row
bytes, and isolated metadata growth.
It fails against the previous implementation with zero rather than seven rows.
The new chat-placement classification also fails its previous-manifest control
with one rather than two conversation rows; the corrected Source test passes.
The native SQL capture uses the same corrected Source query. The all-store
repository comparison includes these guest rows and retains existing rollback,
lease, receipt and restart assertions.

Before this latest integration, two broad checks pass 1,709 Source server, 4,391
app and 1,038 protocol tests, but remain red: one unchanged worker
history-projection test exceeds its 15-second deadline, including a run with no
concurrent native compilation. Its entire file passes in isolation. Ten format
failures are byte-identical to the then-current base. Current Linux CI also exposed a native publication race:
the separate PostgreSQL notification thread could split the handler's
interaction/summary pair, which Source emits synchronously. Native committed
event publication now submits that pair under one hub-state lock. The existing
exact trace assertions remain unchanged; concurrent producers receive an added
regression test. All nine storage/authentication HTTP/Live combinations and six
controlled PostgreSQL delivery schedules pass after that repair. Full supported-platform validation remains in progress.

Schedule comparisons pin the reference runtime to Node 24.22.1, whose 2026e
time-zone data matches the bundled native database. The floating CI selection
used Node 24.22.0 with 2026c data. The unchanged Source oracle under those two
runtimes produces two different results across 17,252 identical inputs, for
Inuvik and Winnipeg. All 17,252 comparisons pass with the canonical runtime;
no case or assertion is removed. Oracle diagnostics report Node, ICU and
time-zone versions. Mixed-version rollout must align the time-zone basis before
scheduling parity can be claimed.

Before the terminal-placement integration, the full existing-worker chat/settings
scenario passes on both servers across all three stores, retaining 19 product
steps and 11 clean worker stops per run.
Completed-turn identities come from already observed, decrypted responses before
waiting for canonical history; all final history, synchronization and restart
assertions remain intact. Windows acceptance teardown now terminates the owned
worker process tree and records cleanup failures before writing its report.
Windows CI demonstrated taskkill returning 128 after terminating the root while
reporting descendant termination errors. Teardown now records the owned tree's
process identities, attempts termination, then checks actual descendant liveness
and the original worker exit assertions. Verification of this correction on
Windows remains pending. The Windows Source foundation test's original
15-second deadline and a Source Task shutdown failure also remain unresolved.

The Windows startup diagnostic at `a31d02d60` checks six fresh processes and
persistent directories across 244 migrations and 1,911 statements. Original
median readiness is 4,115 ms; experimental batching is 4,016 ms, with overlapping
run ranges. All complete migration receipts match the Source file hashes and
journal order. Batching is not adopted into product migrations; this measured
difference does not resolve the original reference test's 15-second timeout.

The public desktop-update active-work and provider connection-test routes now
have native implementations. Updater counts execute the nine captured Source
queries independently, retaining ownership and lifecycle predicates, archived
queue behavior, standalone exclusion, terminal service semantics and integer
bounds. Provider tests retain the existing Z.ai guard, model/worker selection,
body parsing, repeated-query behavior, native reply validation, failure-stage
precedence and production two-minute deadline. The worker stays in Node.

Local comparisons pass 513 actual Source response-contract/error cases and 992
failure-stage/UTF-16 detail cases. All nine storage/authentication combinations
pass 1,281 paired HTTP observations and 369 provider commands, including fourteen
real missing-table failures and restoration, default/offline worker selection,
malformed replies, caller disconnect, worker reconnect, actual server restart
and command backpressure while desktop counts remain available. Both peers pass
the unchanged 120-second deadline and recover from a late reply. Strict
all-target Clippy and focused Source/Rust tests pass. Across modified existing
harnesses and tests, the assertion audit retains 3,047 original calls verbatim,
strengthens two authority expectations with the required default-off field and
proves four calls equivalent in two exact-byte Buffer assertions. It checks full
matcher arguments and preserves the original deadlines. Integration with
main `88d1c0b` preserves all 564 existing contract roots and 9,779 nodes before
appending these three response schemas (567 roots / 9,796 nodes).
The upstream worker build required four default-off test-fixture fields and an
SDK callback type annotation; actual esbuild output of that callback is byte
identical. Its new Task tools also receive explicit endpoint-protected boundary
classifications and an updated reviewed inventory. One upstream nested Task
configuration lookup is collapsed without changing its short-circuit behavior
to satisfy strict Clippy. Task admission now supplies the existing agent-managed
worktree default explicitly to both Node and Rust repositories, fixing the new
server type error and the native missing-field failure. Positive CUA fixtures
explicitly opt into the new Cantrip-app permission; older protocol authorities
are verified to default to protected access. The seven new Task exports are
checked separately while preserving the original public-export fingerprint.
Appending Task creation to the mutation catalogs preserves their original
ordering and operation/tool alignment. All 1,032 protocol tests pass, and the
generated contract manifest still matches the embedded manifest exactly.
Fresh combined-state macOS runs pass all nine HTTP profiles and all three
nineteen-step browser/full-worker/native flows. The app suite passes 4,391 tests
with three existing skips. The initial full Source suite passes 1,699 tests with 57
skips and three failures; all three failures reproduce on clean upstream
`9ce9356`. The initial broad check stops at six computer-use worker failures,
also reproduced on that upstream checkout with the actual compiled helper.
Positive native fixtures now explicitly grant access to their protected fake
targets, while default-off authorities remain explicit. Inventory access
metadata is checked separately from the unchanged native target facts. Repeated
CUA guidance is compacted from 6,305 to 5,968 characters without changing method
names, the initial call example, input semantics or default protection rules.
The full native computer-use command now passes 1,461 tests across protocol,
crypto, worker, Source and app, with three existing skips. The ten global
formatting failures are byte-identical to upstream. The fresh broad check passes
all 1,702 Source tests and 4,391 app tests. Its worker phase has 2,621 passes,
133 skips and three failures: one outdated Task-create idempotency expectation
and two unchanged 15-second timeouts in native history batching and PNG
adaptation. The Task annotation fixture now matches the existing deterministic
operation identity; all three entire affected files pass 72 tests with their
original deadlines. The broad run remains red. Fresh composed flows after the
guidance change pass all three stores at `a4afebf51`, retaining nineteen steps,
eleven clean worker stops and the original seven plus nine TLS model POSTs per
peer.
The Windows native computer-use check also exceeded the PNG boundary test's
fifteen-second deadline. Its deep Buffer matcher took 2,246 ms in an isolated
local measurement versus 0.234 ms for native byte equality. That one assertion
now uses `Buffer.equals`, retaining exact length and byte comparison, the actual
Sharp decoder, size limits and the original deadline. Full-file AST comparison
proves no other test logic changed; distinct equal buffers pass, while last-byte
and length mismatches fail. All 28 image tests pass locally. Replacement native
computer-use checks pass at `43727e798` on Windows, Linux and macOS, with 1,461
tests per platform and six additional cold model-configuration tests on Windows.
At that head, the Linux browser/full-worker/native Codex job also passes all
three composed flows and all three Task flows. All six downloaded reports,
their ZIP CRCs and the artifact API digest are independently verified.
The separate Linux native-command job fails while the Node reference first
starts, before any controlled approval request. Its unchanged command passes
locally with all three authentication profiles and both delivery schedules.
The test launcher now retains bounded stdout alongside stderr on startup
failure and waits for output streams to close before reporting an early exit.
The two real-process regression tests verify retained failure output and actual
HTTP readiness/graceful shutdown; the first fails before the diagnostic fix.
AST comparison retains the listening-event selection, environment, process
launch, sixty-second startup deadline, failure cleanup and normal shutdown.
The original five publication-oracle tests and all six local paired approval
comparisons pass. The same Linux failure recurs at `eccce0878`; retained
startup stdout reaches migrations before the sixty-second deadline. An isolated
Linux arm64 reproduction uses the actual Node reference, Node 24.22.1 and
PostgreSQL 16.15: direct startup completes in 5.85 seconds, the unchanged proxy
exceeds sixty seconds, and enabling TCP_NODELAY on both proxy sockets completes
two fresh starts in 4.25 and 5.00 seconds with clean shutdown. Only those two
socket calls change; every original proxy byte outside them, frame parser,
delivery gate, assertion and deadline remains unchanged. The original six
paired approval schedules still pass locally in 62.14 seconds. Linux x64 CI at
`dbe58c0b3` also passes the full native suite; the six paired approval schedules,
actual held PostgreSQL frames and exact HTTP/Live traces are independently
verified in its checksum-verified 100-report artifact. The Linux full-worker job at
`dbe58c0b3` independently passes its three composed and three Task reports;
artifact commit/digest, every ZIP CRC and all six paired reports are verified.
The two Source reference account/handoff files also exceed the original
fifteen-second monolithic-test deadline in Linux and Windows CI. Their exact
22-test command passes locally. The one 256 KiB media comparison now uses
native Buffer equality: 205 ms versus 0.108 ms in a local assertion-only
measurement. Full-file AST equivalence, mismatch rejection and the unchanged
fifteen-second default are verified; the same 22 tests pass after the change.
Linux CI at `eccce0878` still exceeds that original deadline. The unchanged
command passes on isolated Linux arm64 with two CPUs in 13.01 seconds for the
monolithic test; CPU profiling passes at 14.13 seconds and records substantial
PGlite and garbage-collection work. Increasing the test-worker young heap does
not fix the deadline in alternating trials and is not adopted. Linux CI at
`dbe58c0b3` passes the unchanged monolithic scenario in 9.879 seconds, while the
Windows reference still exceeds its original deadline. Its first CPU artifact
contains only the coordinator: Windows fork termination loses exit-time worker
profiles, matching [Vitest issue 9907](https://github.com/vitest-dev/vitest/issues/9907).
The opt-in diagnostic config now saves CPU profiles inside each actual worker
using awaited teardown, without changing the fork pool or test deadlines. The
unchanged 22-test scenario passes in two local runs with these hooks; a later run
reproduces the original fifteen-second timeout and still saves the actual worker
profile. A separate deliberate timeout also remains failed with its profile
retained. The original required command
and outcome remain unchanged. Profiling runs only after its failure or through an
explicit Windows-only diagnostic dispatch; a passing diagnostic cannot replace
the original failure. The Windows performance bottleneck remains unproven.
A separate Windows contract failure at `eccce0878` occurs in the Node reference
before Rust runs: the 8 MiB streamed upload reports ECONNABORTED before response
headers. The disposable HTTP client now attaches only bounded transport counters
to the original error, and the file-document report retains them. Removing those
counters restores every original helper byte, including request framing,
16 KiB writes, both poll yields, complete-response requirements, no-retry and
abort behavior. All seven original test bodies are byte-identical; the new
real-reset regression fails without diagnostics and passes with them while still
requiring the reset to fail. All eight upload tests pass locally. The Windows
upload cause and updated CI acceptance remain unproven.
Windows archive cleanup separately fails its original timestamp upper bound in
the Rust account profile. Failure-only capture now retains raw events, parent
Date/performance clocks and a real database clock query, then rethrows the
original error. The assertion loop and every other original statement are
AST-identical. All three PGlite authentication profiles pass locally; a
controlled parent-parser fault still fails the original assertion and retains
both raw events and clock samples. Windows clock causation and updated CI
acceptance remain required.
The historical native-editor fixture now supplies the additive default-off CUA
column required by its current repository setup, retaining the old editor tables
until their removal migration runs. Its nine original assertions and deadline
are unchanged, and the exact five-file CI command passes all eight tests.
The final integrated production-deadline comparison also passes, including both
120-second deadlines and late-reply recovery. Linux CI at `49ad2961c` passes all
three composed flows and all three Task flows. Its downloaded artifact's commit,
API digest, ZIP members and six paired reports are independently verified.
Remaining server/platform CI and complete packaging acceptance are outstanding.

A real native Codex path probe also explains the previous Linux skill fixture
failure: macOS's lexical `/var` worker home differed from the native canonical
`/private/var` inventory. An owned directory alias now exercises the original
inventory rejection on every platform, while an additional canonical-path
account configuration round trip proves the successful behavior. Original
negative assertions remain. The composed PGlite browser/full-worker/native test
passes eighteen steps and its original seven model requests per peer.

The composed browser/full-worker/native Codex flow now passes nineteen steps
on all three storage modes for both servers. Its original seven model requests
remain separate from nine provider HTTPS requests: three successes and the
actual six native authentication retries on a controlled401 response, followed
by successful recovery. Provider identity and credential availability survive
server/worker restart. A disposable trusted CA and strict local CONNECT proxy
route only the owned model listener; certificate verification stays enabled.
MCP discovery of the proxy URL is validated and answered404, preserving the
original discovery assertions. These local results do not establish platform,
packaging or complete replacement readiness.

One retained Source-only native-history failure occurs before the provider
probe: a previously displayed assistant answer becomes a no-text notice, while
the native SQLite item and rollout retain the full text. The original assertion
fails, and the disposable runtime is archived in
`.qa/rust-server/source-native-history-before-provider-v4.tar.gz` with its hash
proof. Offline decryption and replay verify all 34 retained source records and
preserve the full answer. At the failure, the canonical row still contains the
started empty item at revision 1, exactly matching the third staged publication;
the projection has committed only through source record 8. A live follow-up is
still required to establish catch-up behavior and the correct test observation
boundary. No production fix or resolution is claimed from the offline replay.

Fenced Task failure recovery now commits dispatch settlement and precise retry
accounting in one owner-serialized transaction. The Linux failure trace showed
saved-outcome recovery settling a failed dispatch before its live RPC callback;
the later callback rejected the stale fence and never recorded the worker's
public `usage-limit` category. Legacy recovery then adopted the generic stored
failure as a retryable runtime error. The unchanged worker already supplies the
bounded public category without exposing encrypted content.

Both saved-outcome recovery and live failure cleanup now use the same atomic
operation in Source and Rust. It checks the owned Task and dispatch, retains
existing lease fencing, and uses the original dispatch failure key and retry
policy. Successful completion keeps its existing path. Encrypted content,
Task revisions, and the external protocol are unchanged. Mixed deployments
require this fix on Node peers as well as the preceding stale-adoption fix.

The original deterministic outcome-service regression fails before the fix and
passes afterward. Local checks pass 160 outcome observations and 272 retry
repository observations per store, including all nine public categories and
both callback orderings. A real SQL trigger first verifies that the
dispatch has become terminal, then raises `P7101` during the ledger update;
both writes roll back on all three stores. Sixteen additional PostgreSQL races
observe competing owner-lock waiters across same and mixed Node/Rust replicas
in both acquisition orders. The prior 32 retry/adoption races also pass, as do
55 focused Source tests, 47 Rust library tests and 13 Task/category/lifetime
tests. Strict all-target Clippy passes. Both real callbacks also recover after
an actual retry-write failure; a nontransactional SQL sequence witnesses that
the trigger saw the terminal dispatch before rollback, then saved-outcome replay
commits the precise manual failure after the fault is removed. Existing dispatch,
claimed execution, automatic actor and background comparisons pass on all three
stores. All 235 original assertions and polling calls in the four touched or
reused execution harnesses retain their arguments and deadlines.

The existing browser SDK, full unchanged worker and actual bundled Codex pass
all fourteen Task-flow steps on every store for both servers, with exactly nine
public model POSTs per peer: direct and Plan + Goal completion, opaque quota
failure, explicit retry, queued admission through server/worker restart and
retained encrypted results. Only public model HTTP responses are controlled.
The app, worker, protocol and crypto sources/tests remain unchanged; the three
Source implementation fixes are the only changed files among 3,015 checked
existing source/test files. Fresh Linux, broader repository, packaging and full
replacement acceptance remain required; Node remains the default server.

The global/project MCP settings milestone implements all ten CRUD, list and
worker-discovery endpoints. Configuration stays encrypted. Owned workers may be
bound while offline; updates preserve an omitted audience and reset an omitted
worker binding, matching Source. Mutation and lookup SQL comes from thirteen captured actual
reference query builders. Database failures retain exact diagnostics only after
the operation fails. Response-validation failures preserve Source's already
committed row, including subsequent repair. Lists preserve SQL microsecond
ordering before millisecond wire serialization and reject 201 rows rather than
truncating them. Real missing-table faults reproduce and verify project/worker
lookup diagnostics, including original UTF-16 parameters despite UTF-8 SQL
encoding. Query context is attached only after actual query failure; ordinary
worker lookup and row mapping retain their existing behavior.

Local comparisons pass 3,334 exact Source contract/boundary cases, 1,416 paired
HTTP observations and 324 persisted-runtime selections across all nine
storage/authentication profiles. They cover all four scope/binding uniqueness
constraints, tenant/CSRF isolation, opaque-byte retention, real SQL failure and
zero-row inserts, post-write output errors, real filesystem discovery and
endpoint cryptography, malformed worker replies, Source's accepted response
worker identity, the production twenty-second deadline, command backpressure,
HTTP disconnect ownership, offline behavior and exact restart retention.

The existing browser SDK, full production worker and actual Codex pass the
composed eighteen-step flow on all three stores for both servers: Agent/Goal,
automations, approvals, customizations, permissions, skills and MCP. MCP adds
both transports' CRUD, real Codex/Claude discovery import, fresh-identity
cross-project copy, a real stdio peer and native MCP resource read with the
project override, exact ciphertext retention through server/worker restart and
deletion. The existing explicit Goal control resumes resource IO after restart;
these MCP operations start no inference. Each composed peer makes the same seven
scripted model requests. An acceptance-only process preload supplies the full
worker's disposable home; production worker sources remain unchanged. The
model fixture optionally validates real MCP discovery probes and returns 404,
retaining all existing Responses assertions. All 120 existing assertion/poll
calls and arguments in the four extended harness files remain unchanged.
Supported-platform, packaged and complete replacement acceptance remain
unfinished; Node remains the default server and worker.

The milestone's broad `pnpm check` completes in 625.181 seconds with all 1,702
server and 4,391 app tests passing. It remains red on two unchanged worker
fifteen-second timeouts: native-history batching and the exact PNG size boundary.
Both complete files subsequently pass all 56 tests with their original deadlines
in 60.106 seconds. All 3,015 existing source/test files under the checked app,
worker, Node-server, protocol and crypto roots remain byte-identical to the
baseline. Global formatting reports eleven independently verified unchanged
files; changed-file formatting and Rust formatting pass. This does not make the
broad check green or establish complete replacement readiness.

The fixed-head Linux Task diagnostic `41631825880` is not acceptance. Its first
trial passes all fourteen steps and nine model POSTs for each server, but the
second and third Rust trials end in `implementing` instead of the expected
`complete`/`failed`, with 33/31 model POSTs. Node passes all three trials. The
artifact was independently checked against the run head, API size/digest and
all ZIP CRCs; public Task transitions and complete reports are retained. This
remaining execution failure still requires a source-level fix. The independently
reproduced stale-adoption fix below does not prove Linux product recovery.

The Task retry adoption fix addresses a race reproduced in both reference and
Rust actors with real PostgreSQL owner-lock waiters, including a Node writer
and Rust actor. A stale read of a legacy failure could replace a newly recorded
manual `usage-limit` failure with a scheduled `runtime` retry. Both repositories
now adopt only while the locked Task still has no retry record, is failed and
retains the observed error code and timestamp. Precise worker failure accounting
and the existing retry timing remain unchanged. This requires no schema or wire
change and does not rewrite encrypted Task state or revisions.
Mixed rollout tests use the patched reference server. Apply the same adoption
fix to Node peers before relying on this guarantee while both server types run.

All three stores pass 167 paired retry repository observations each, with eight
SQL snapshots each, plus 27 paired automatic actor observations each. Eight
additional PostgreSQL races cover both lock orders and every same/mixed
Node/Rust writer/actor combination. They retain the precise manual failure,
encrypted content, error identity, revisions and timestamp, without worker IO.
Independent before/after reproductions also exercise the actual actors and a
precise Source writer. Source typechecking, 28 focused tests, all-target Rust
compilation and strict Clippy pass.

The existing browser SDK, full unchanged worker and Codex pass all fourteen
Task flow steps on each store for both servers: direct execution, planning and
native Goal completion, quota failure with explicit retry, paused admission
across server/worker restart and retained encrypted results. Each peer performs
exactly nine scripted model requests. The acceptance harness retains public
Task state transitions when an assertion fails; its original 32 assertion and
poll calls and all deadlines remain unchanged. These are local macOS results.
The dedicated Linux diagnostic repeats the original flow with these public
observations; supported-platform confirmation remains pending. The earlier
Linux failure must not be treated as resolved without that evidence.

The repository-wide check completed in 610.710 seconds with 1,702 server and
4,391 app tests passing. Three unchanged worker tests failed under the broad
run: history and image-boundary timeouts and a Goal-delivery assertion. All
three complete files subsequently pass 60 tests with their original deadlines.
All worker/app/protocol source and tests remain byte-identical to the baseline;
the two reference-server implementation files and one updated test double are
the only changes among those existing source/test trees. Changed-file and Rust
formatting pass; global formatting reports eleven independently verified,
unchanged baseline files. The broad check is recorded as failed.

The global Skill settings milestone adds all seven inventory, encrypted file
read/write/delete/configuration and audience endpoints. Worker-owned contents
remain opaque to the server. Audience metadata validates an independently
owned active worker/provider pair and retains Source's sorting, defaults,
upsert identity and invalidation scopes. Disabled configured model routes are
retained for settings; file operations also work without a model route. Relay
limits preserve the existing 502 list / 409 mutation behavior.

All nine storage/authentication profiles pass 1,014 paired HTTP observations:
107 anonymous, 112 password and 119 account observations per store. Each
peer/profile verifies 42 actual WorkerConnection commands, 49 downstream calls,
65 crypto proofs, nineteen ordered customization events (fifteen current-user
and four project), five durable snapshots and six recovery cases. Coverage
includes exact 5,000/5,001 audience boundaries, owner/CSRF checks, unavailable
and unlinked workers, protected request authentication, mutation replay,
retained context during worker IO, SQL rollback/retry, relay limits,
client-disconnect completion and offline restart retention. All 2,179 named
Source values/issues/exact errors and strict all-target Clippy pass. The
553-root/9,696-node manifest preserves the previous 540 mappings and complete
9,641-node prefix.

The existing browser SDK, unchanged full worker/SkillManager and real Codex
pass on all three stores: real project/account discovery, encrypted reads and
atomic edits, project native disable/enable, audience selection, scope
isolation, invalid-write byte retention, server/worker restart and deletion to
verified recovery folders. Settings operations start no inference. Account
configuration preserves Source's authenticated native-inventory rejection;
file editing and audience selection remain available there. These are local
macOS results. Supported-platform, packaged and complete replacement
acceptance remain unfinished; Node remains the default server and worker.

The repository-wide check completed in 592.672 seconds with all 1,702 server
and 4,391 app tests passing. It remains red on an unchanged worker history
batch timeout and Codex RPC `EPIPE`; both complete files subsequently pass all
31 tests with their original deadlines. All 3,436 existing app, worker,
Node-server and protocol source/test files are byte-identical to the baseline.
Changed-file formatting and Rust formatting pass; global formatting reports
eleven independently verified, unchanged baseline files. These results do not
establish complete replacement readiness. The separately observed Linux Rust
Task quota-recovery failure still requires a fix.

The Chat customization milestone adds all twelve protected skills, inventory,
MCP and external-import routes, plus the five remaining model, reasoning and
permission routes. Content remains encrypted between the browser and worker.
The existing standalone restriction runs before operation/schema validation;
standalone model, reasoning and permission controls remain available. Unbound
permission writes recheck the native source inside the locked transaction;
bound writes retain source identity, policy revisions and durable rejection
receipts. Model/reasoning changes during a pending native handoff preserve
Source's 409 status and complete Fastify error body. Only successful skill/roots/reload operations publish invalidations.

Local comparisons pass all nine storage/authentication profiles: 161 anonymous,
166 password and 172 account observations per store (1,497 paired observations),
69 actual worker commands, 52 customization crypto proofs, three protected native
settings snapshots, eight ordered Live events, eight durable snapshots and
seven recovery cases per peer/profile. Coverage includes malformed/Buffer
bodies, ownership/CSRF, standalone validation order, captured scope during a
routing change, authenticated ciphertext rejection, mutation replay, relay
limits, native-source replacement during capability reads, SQL rollback/retry,
client-disconnect completion, offline behavior and retained server restart.
All 4,736 named Source contract values/issues/exact errors pass; the generated
540-root/9,641-node manifest preserves the previous 530 mappings and entire
9,597-node prefix. Strict all-target Clippy passes locally.

The existing browser SDK, unchanged full worker and actual Codex also pass on
all three stores: real skill discovery, disable/enable and extra-root changes,
MCP reload, encrypted native MCP/import failures, confirmed bound read-only
and default permission transitions, and retained configuration after server
and worker restart. These operations start no inference. Cold inventory reads
preserve Source's authenticated thread-not-found error; explicit existing Goal
control resumes the native thread with its preserved configuration before the
retained skill check. Only disposable skill files and public model HTTP output
are fixtures. Supported-platform, packaging and complete server-replacement
acceptance remain unfinished; Node remains the default server and worker.

The milestone broad `pnpm check` exits 1 after 663.998 seconds: 1,702 server and
4,391 app tests pass; the worker has 2,623 passing tests and one existing
15-second history-batching timeout. Its complete 28-test file passes separately
in 58.774 seconds with the original deadlines. All 3,436 server, worker, app
and protocol source/test files are byte-identical to the baseline. This does
not establish the broad timeout's cause or make the broad check green. Global
formatting reports eleven baseline files, each verified unchanged; formatting
of every changed supported file and Rustfmt pass.

The Task dashboard and Chat Goal milestone mounts the existing implementation
dashboard and public Goal GET/POST/PATCH/DELETE controls through the same native
runtime, routing, encrypted Task synchronization and lease services. Dashboard
PR associations, warning order, folder placement, observed dirty files and
worker-unavailable reasons follow Source. Both concurrent PR requests retain
ownership after an early failure; Task Goal errors remain opaque.

Local comparisons pass all nine database/authentication profiles: 79 anonymous,
80 password and 85 account observations per store (732 paired HTTP observations
total), plus 69 complete worker-command comparisons per peer/profile. Actual
worker cryptography independently verifies Task and Goal ciphertext; the suite
also checks completion synchronization, unrelated-message rejection, resume
admission before controlled model completion, owner isolation, missing threads,
offline behavior, sixteen ordered Task Live events per peer/profile, redacted
server diagnostics and reopened durable state. All 34,379 Task protocol outcomes
and exact errors and 224 dashboard association/warning cases pass. The manifest
has 494 roots and 9,311 nodes, preserving every baseline root mapping and the
complete 9,237-node prefix. Strict all-target Clippy passes locally. These are
controlled-worker results; complete unchanged-client/worker execution and
packaged acceptance remain required.

Fresh PR #2439 Linux and Windows native suites fail at the existing native-event
comparison: project-alert commit notifications interleave differently with
application invalidations. The Windows message-write suite also times out at
Rust/PGlite startup. Actual logs and the Ubuntu artifact were retained. The
PGlite notification path now publishes its callback inline, preserving Source
commit-before-application ordering; the original native-event assertions pass
all three local authentication profiles. External PostgreSQL retains its
separate LISTEN path and its original comparison also passes locally. Fresh
supported-platform verification and the Windows startup investigation remain;
no assertions or deadlines were changed.

The Task catalog milestone implements public creation, deletion, attachment
listing and Chat model configuration. Creation commits the encrypted Task,
Chat, runtime session and suspended execution lane together, inherits account
defaults, and publishes through the existing title/Live execution graph after
commit. Deletion attempts worker interruption and continues after a failed or
malformed response. Model changes retain the existing route-resolution errors
and runtime write fence; the Chat and Task keep separate model configurations.

Fresh local comparisons pass all nine storage/authentication profiles: 150
paired HTTP observations per store (450 total), five independently decrypted
Task results per peer/profile, project-scoped creation publication and reopened
database checks for atomic rollback, lane identity, absent pane membership and
deletion cascades. These are controlled-worker tests, not complete model or
packaged-product acceptance. The populated attachment case exposed an existing
Source bug: repository records include `workerId`, which the strict public
schema rejects. Both implementations now apply the existing public attachment
projection before validating that response. No routing field is made public.

All 29,036 Task protocol outcomes/exact errors, 46 Rust library tests, recursive
type checks, 43 focused Source Task/Goal tests and strict all-target server
Clippy pass locally. After integrating the project-alert foundation and current
UI changes, the 487-root/9,237-node manifest preserves the complete
482-root/9,219-node baseline prefix and mappings. The previous Linux and Windows
CI runs stopped at a persistence fixture still using retired Task Worker input;
the current per-Task model fixture passes all 158 cases and six snapshots on
every store.
Fresh platform reruns and the remaining Task dashboard/Goal controls are still
required. The combined broad check passes 1,684 Source server tests with 57
skipped and four failures. Three integration failures are repaired: the Task
model migration fixture now selects migration 0236 by its journal identity,
and project alerts have owner-scoped storage accounting in both servers.
All twelve focused Source migration/accounting/alert tests, both native usage
contract tests and all 46 usage repository comparisons per store pass. The
comparisons include populated alerts for two owners and accounting after their
project deletion. The previously reproduced account-pooling fixture failure
remains; its investigated setup changes were not retained. The broad check has
not passed, and its recursive bail does not establish complete worker/app test
acceptance.

The Task admission work in
[PR #2425](https://github.com/ArcaneArts/Cantrip/pull/2425) mounts six public start, planning, continuation,
finalization, retry and retained-session recovery endpoints through the actual
native queue/recovery graph. The current per-Task model changes are integrated;
retired Task Worker inputs retain their new strict rejection behavior. Fresh
local comparisons pass all nine storage/authentication profiles: 263 paired
HTTP observations per store (789 total), 17 decrypted Task results and twelve
admission Live events per peer/profile. These verify authorization, invalid
inputs, durable admission identity, replay before revision checks, FIFO/fencing
identity and post-commit fanout. The scheduler's asynchronous eligibility
observation is retained separately; the entire settled Task response must match
and report the actual paused-project decision. These are controlled-worker
transport tests, not complete client/model execution or packaged acceptance.

Canonical Goal continuation carries the existing resume control marker so the
worker can preserve an implementation failure without changing finalized
planning metadata. Initial launch and continuation errors cover all nine
operational categories. Re-reading a failed Goal preserves its encrypted
diagnostic and timestamp; an explicit resume clears the failure. The server
never decrypts or rewrites that content, and the planning guard is unchanged.
Source/native coordinator comparisons pass 162 cases and six snapshots on each
store, including exact two-minute lease renewal, retained fencing/ownership and
durable failed continuations. All 35 focused worker crypto tests, 78 focused
Source Task/Goal tests, recursive type checks, 46 Rust library tests and strict
all-target server Clippy pass. The regenerated 475-root/9,150-node manifest
preserves every root mapping and the complete node prefix of the integrated
473-root/9,145-node baseline.

Platform followup exposed stale fixtures after the per-Task model cutover.
The background scheduler, claimed execution and retained-session recovery now
pass 180 cases/18 snapshots, 116 cases/eight snapshots and 92 cases/eight
snapshots respectively on every store. Model selection and custom subagent
selection live on Tasks; retired presets no longer impose concurrency or
recovery eligibility. The fixtures retain physical-worktree exclusion, exact
retry counts, runtime failures, original deadlines and all restart checks.
All 25,024 Task protocol outcomes and exact errors pass, including the two new
admission/recovery request roots.

The actual Windows artifact `13149687017` showed independent tenants acquiring
global message sequences in different orders. The generic snapshot comparison
now uses the existing per-chat observer, retaining the exact allocation set,
unique sequence ownership, stored/wire identity, per-chat order and every row
field. Six additional observer tests pass. The downloaded ZIP's SHA-256 is
`4f33d2acd00b413be0196cb428d36657b720465a7fed8a5aba6f88a199922334`;
its exact allocation and identity witnesses agree under replay. This is not a
fresh Windows acceptance result.

The earlier worker desktop failure reproduces on clean Primary `459955f43`:
the test expected a promise rejection after participant input became
asynchronous. It now verifies rejection logging and exactly zero extra native
sends for duplicate or stale-epoch packets, followed by a valid fresh-epoch
input. All forty focused desktop/Goal crypto tests pass. The earlier CUA Clippy
errors also reproduce on that clean revision; a semantics-preserving match
removes the checked unwraps. Queue saturation tests now fill the actual 37-slot
limit with one additional request, retaining their cancellation deadlines and
every response assertion. All 222 CUA tests and strict all-target CUA Clippy
pass locally; supported-platform reruns remain necessary.

The refreshed full worker run passes 2,616 tests with 133 skipped and one
15-second timeout in the unchanged large encrypted history batch case. The
entire 28-test history file passes separately with its original limits, and the
exact timed-out case passes on clean Primary `fa8441f8e` with the original limit.
The
earlier broad `pnpm check` stopped at the now-repaired CUA lint errors; these
observations do not establish a green broad check. Current milestone evidence uses
`.qa/rust-server/task-lifecycle-integrated-*`, with separate
`task-lifecycle-main-*-baseline-v1` reports. Public Task creation, deletion,
attachments/dashboard, Chat Goal controls, full client/worker execution,
packaging and the remaining replacement requirements are still unfinished.

The execution milestone merged through squash auto-merge in
[PR #2409](https://github.com/ArcaneArts/Cantrip/pull/2409), at
`64857ee68469379c8b935440b017c6c5bce4d84d`; clean Primary was fast-forwarded and
the completed worktree was removed after all 2,990 archived evidence files were
hash-verified. The final local combined browser/full-worker flow passes 35 steps
per peer on all three stores, and the refreshed worker suite passes 2,605 tests
with 133 skipped. The original 1,024-attachment early-failure cleanup case passes
locally with its original deadline. Host-global service-discovery tests must run
sequentially on one host: a retained concurrent run captured another suite's
actual HTTP/TLS probes in its TCP fixture; exact HTTP bytes were identified and
the serialized rerun passes unchanged assertions. Fresh
[platform run 41441145506](https://github.com/ArcaneArts/Cantrip/actions/runs/41441145506)
remains in progress; merge does not establish full platform acceptance.

The public Task editing milestone adds reads and encrypted draft/plan edits
using the native repositories and actual
post-commit chat/project Live fanout. Local comparisons pass all nine
storage/authentication profiles: 86 paired HTTP observations per store, six
independently decrypted Task results and four Live events per peer/profile.
These cover owner isolation, HEAD, exact input/state/revision/worker-selection
errors, rejected-write preservation and ciphertext integrity. Their CI steps are
configured; no supported-platform pass or full Task lifecycle is claimed. Public
Task creation, deletion, attachments, dashboards and Chat Goal controls remain
to finish; the admission and protected-continuation work is described above.

The fresh Windows run passes the repaired 92-case Task recovery suite, then
exposes the same path-spelling issue in the Source quota timer adapter. Source
missed the two reset timers while Rust produced the required four captures. The
quota adapter now normalizes actual frames, and an additional forced-Windows
scenario retains exact capture times, trigger identities and timer cleanup.
The complete local GUI matrices pass 698 cases/173 snapshots each on PGlite and
private PostgreSQL, and 710 cases/179 snapshots on external PostgreSQL. This
fixture repair still requires a Windows rerun; production Source behavior and
all reset deadlines remain unchanged.

The execution implementation was verified at
revision `cee3dc0c1f2cc02371ab4da068d4c2cbb2eb47e0`. It mounts twelve public
encrypted Chat/queue and Chat/Project Task pause routes through concrete native
admission, receipts, recovery, Goal/Task scheduling, worker commands and Live
services. Owned timers and admitted work drain before database shutdown.

Current local macOS comparisons pass all nine database/authentication profiles:
268 paired HTTP observations per database (804 across native PGlite, private
PostgreSQL and external PostgreSQL), including encrypted transcripts, immutable
queue-input/claim/hash/generation bindings, automatic continuation, caller
abort and worker disconnect. All 45 Rust library tests and strict all-target
Clippy pass. The integrated 473-root/9,141-node manifest passes 421,047 full
protocol cases, 69,648 ECMAScript JSON round trips, 9,636 public Chat outcomes
and exact errors, 22,078 workspace validation/error cases, 862 seed/import/strict
identity cases and 147 resource-deletion ownership cases. The app build passes.
Model execution, rollback and pause acknowledgments in the public fixture are
controlled boundaries; actual CLI preparation/resume/exit/retry has separate
retained evidence. These are not full worker/client or packaged-product results.

The fresh integrated `pnpm check` remains failing: 1,662 server tests passed,
57 were skipped, four cases timed out at their original five-second limits,
and the account-pooling assertion at `local-foundation.test.ts:7218` failed.
All four timeout cases pass in the focused three-file run with their original
limits. Clean Primary `dab13cde2` reproduces the same pooling assertion unchanged.
The fixture creates a chat already prepared with its default native model, then
expects the turn body's model ID to replace that binding. Actual routing and
the completed encrypted transcript retain the prepared model, as Source's
explicit native-session rule requires. No assertion or native binding guard is
weakened to hide this baseline. The older release-workflow assertion failures
were separately reproduced on clean Primary and fixed to require the recursive
app-dependency build in all three release jobs; its six-package closure actually
builds and all twelve focused workflow tests pass. Reports use
`.qa/rust-server/gui-milestone-*` and `gui-integrated-*`.

The [preceding platform run](https://github.com/ArcaneArts/Cantrip/actions/runs/41336630442)
finished with seventeen passing and four failing main jobs across Linux, macOS
and Windows. The Windows recovery fixture now normalizes actual stack paths,
with an additional Windows-spelling regression passing all three stores locally.
The browser fixture uses Vite's real HTML transformation for the React preamble;
the file/workspace flow passes locally with native PGlite and the full worker.
The Run exit probe now observes both SIGTERM and SIGHUP, retaining process-death
and directory-before-deletion assertions; the full PGlite worktree flow passes
locally. These repairs still require platform revalidation. The Windows browser
cleanup failure remains under investigation: Source did not finish all 1,023
successful siblings within the original deadline. A middle-failure variant passes
locally but is retained only as a diagnostic; the original early-failure scenario,
workload and deadline remain unchanged. Public Task/Goal lifecycle controls,
complete unchanged-worker/client
acceptance, the documented protected Goal-continuation failure, distributed
coordination, complete old-data upgrade/post-write rollback, supported artifacts,
desktop packaging, Winterhold rehearsal, performance, default cutover and Node
server removal remain. Normal builds still launch Node. Detailed milestone
records below retain their original tested scopes and historical results.

The canonical-history milestone's fresh `pnpm check` exited 1 with 1,662
server tests passing, one failing and 57 skipped. The provider-pooling assertion
at `local-foundation.test.ts:7218` also fails in a fresh focused run on clean
Primary `6e0fe9bc4`. Root formatting fails on 12 unchanged tracked files; a
fresh Primary run reports those same 12 plus 196 generated CUA target artifacts.
The initial worker command expanded into the full suite and timed out one
large-history encryption test; that exact case subsequently passed on this
branch and clean Primary with its original timeout and assertions. Focused
worker/server/app checks and the app build pass. These observations do not make
the broad check green. Evidence uses `.qa/rust-server/canonical-history-*`.

The production logical-completion milestone's `pnpm check` exited 1 with 1,662
server tests passing, one failing and 57 skipped. The same provider-pooling
assertion at `local-foundation.test.ts:7218` fails in a fresh focused run on clean
Primary `75e4b68f7`. All 41 Rust library tests, strict all-target Clippy and a
release-mode library check pass. Reports use
`.qa/rust-server/execution-completion-*`; the broad check is not green.

The queue runtime milestone's fresh `pnpm check` exited 1 with 1,662 server
tests passing, one failing and 57 skipped. The provider-pooling assertion at
`local-foundation.test.ts:7218` also fails in a fresh focused run on clean
Primary `038a7226f`. All 40 Rust library tests and strict all-target Clippy pass.
Reports use `.qa/rust-server/native-runtime-*`; the Primary reproduction is
`native-runtime-root-baseline-v1.log`. The broad check is not green.

The native command milestone's current-main `pnpm check` exited 1: 1,645 server
tests passed, 18 failed and 57 were skipped. One failure is the pooled-provider
assertion at `local-foundation.test.ts:7218`; the other 17 are unchanged 5-second
test timeouts. A fresh run of the eight failing files on clean Primary
`a1b125544` reproduced 15 failures, including the provider assertion; the other
three timeout cases passed there. The full app suite passed 4,112 tests with one
timeout, and the full worker suite passed 2,558 with four timeouts. Those exact
five cases subsequently passed on both the milestone branch and clean Primary
with one test worker and their original timeouts. The app production build,
current native/worker wire comparisons, Rust formatting and strict all-target
Clippy passed. Root Prettier checking still fails on 12 unchanged files; the
same 12 failures were reproduced on clean Primary. These results do not make
the broad checks green. Logs and exit records use the
`.qa/rust-server/native-kernel-*` prefix and are preserved with milestone evidence.

## Canonical native history

The Rust history domain owns worker-authenticated binding open, item resolution,
ingestion, and the three pinned archive endpoints. Historical bindings preserve
the original worker and placement without acquiring execution authority.
Canonical reservations retain proven command, queue, Goal, observed-input and
output aliases, original protected GUI input, attachment references and child
thread ancestry.

Ingestion commits the actual protected messages, attachment replicas, turn
headers, usage projection, immutable receipt, stream checkpoint and publication
record in one transaction. Canonical revision conflicts retain an immutable
rejection after rolling back the attempted writer savepoint. Retrying an
accepted record returns its original receipt. Archive pages retain complete
endpoint-encrypted item evidence, every bound writer's turn candidates, accepted
source batches and legacy missing-source markers; pagination pins their shared
committed stream heads.

Confirmed chat-message invalidations use the durable publication outbox.
Scheduling starts with the server, retries independently of worker input and
stops before live transport teardown. Shutdown drains owned publication work
before closing the database. Acknowledgment and defer recheck the binding,
worker, chat and owner instead of consuming unrelated work.

Local real HTTP comparisons pass for native PGlite, private PostgreSQL and
external PostgreSQL in anonymous, password and account modes. They use the
unchanged worker client and encryption/recovery helpers, decrypt complete
archived evidence, compare immutable responses, exercise a real SQL failure on
publication acknowledgment and verify durable retry and restart recovery.
External PostgreSQL also preserves accepted history and pending publication
through Node-to-Rust and Rust-to-Node handoffs. Reports use
`.qa/rust-server/canonical-history-http-*`.

The complete repository corpus also passes all three storage modes, including
publication identity fences, due ordering, limits, attempts, mismatched legacy
owners, acknowledgment/replay and restart. All 42 Rust library tests pass,
including 62 publication lifecycle scenarios from the unchanged Node service.
Twenty additional PostgreSQL ingestion races cover all four same/mixed runtime
pairings. Actual SQL lock witnesses force overlapping writes before release;
accepted replay, receipt mismatch, canonical CAS, immutable rejection replay
and competing streams preserve exactly one canonical message and receipt.
Strict all-target Clippy and a release-mode library check pass. The focused
worker/server/app worktree suites and app build pass.

This domain still requires current-head supported-platform acceptance. Full
GUI/native dispatch, receipt HTTP consumers, Tasks/Goals/scheduling and the
remaining replacement requirements continue separately. Normal app and server
builds still launch Node; the worker remains Node by design.

## Public chat execution (in progress)

The Rust public turn and queue routes now use the production execution graph:
encrypted submission and replay, retry rollback, canonical queue mutations and
operation receipts, active steering, and automatic queued continuation. The
one-second durable queue delivery service starts and drains with the server.
Standalone chats retain their legacy queue shapes and default-mode restriction.

The expanded local macOS Node/Rust comparison passes 268 paired HTTP
observations per database across anonymous, password and account modes on
native PGlite, private PostgreSQL and external PostgreSQL. Each profile verifies
actual encrypted transcripts, two consumed claims, immutable queued input and
claim-derived operation hashes, matching receipt generations, zero remaining
active lanes or pending prompts, and idle completed chats. Existing worker
transport, endpoint crypto, native command client and managed session adapter
run unchanged; model execution and rollback are controlled fixture boundaries.
This is not full worker-process, client or packaged-product acceptance.

Seven additional public wire schema roots preserve all prior 466 root mappings
and the entire 9,105-node prefix. The initial manifest had 473 roots and 9,138 nodes; integration with current
main preserves all 473 roots and brings it to 9,141 nodes.
The Source/native comparison passes 9,636 additional public contract outcomes
and errors, 421,047 full protocol cases and 69,648 ECMAScript JSON round trips.
Actual public-route testing exposed a URL-suffix dispatch error for an invalid
prompt lookup named `steer`; canonical Axum matched routes now choose the
handler. Its regression and newly mounted Chat/Project Task pause controls
pass all nine local database/authentication profiles. Pause comparisons verify
validation and ownership, opposite/failing worker acknowledgments, retained
project state after partial Task failure, stale revisions, four project-wide
finally invalidations per peer/profile, and shutdown persistence. A caller
actually disconnected after worker dispatch cannot cancel its admitted pause.
An actually disconnected worker leaves threaded chats safely paused, while an
empty threadless Task can resume without a worker action. Task ciphertext is
actually decrypted after shutdown and matches its original protected content.
Pause acknowledgments remain a controlled worker boundary; actual native pause,
full worker/client and supported-platform acceptance remain.

Public Task/Goal controls, complete unchanged-worker/client execution, failure
and restart acceptance, supported platforms, merged delivery and the original
replacement shipping requirements remain. Normal builds continue to use Node.

## Managed chat preparation (in progress)

The Rust preparation service now owns the existing GET/POST preparation routes,
durable phase and generation receipts, linked-console identity, worker reconnect
registration, authenticated detached-exit observations and owned shutdown work.
The native-thread readiness promise completes before CLI console startup, as in
Source. A console failure remains separate from native conversation readiness.
Stale generations cannot overwrite a replacement or turn an exited console back
into a ready console. Console creation retains the unique linked-chat identity.
Worker notification handling verifies the actual worker-link identity, owner,
server, worker process and preparation generation before committing an exit.
Preparation never synthesizes terminal input.

Local Node/Rust repository and runtime comparisons pass 57 cases, 15 complete
state snapshots and a real reopen on native PGlite, private PostgreSQL and
external PostgreSQL. An additional archive-during-thread-preparation scenario
passes on PGlite; its expanded PostgreSQL corpus still needs to run. The unchanged
Source preparation suite passes all 14 tests. Actual HTTP, the unchanged
WorkerConnection transport, worker endpoint encryption/decryption and App Live
comparisons pass all three database modes in anonymous, password and account
authentication modes. Each runtime/profile verifies the exact ten preparation
invalidations, retained opaque console fields, authenticated exit, stale-process
and stale-preparation refusal, retry identity and a separately failed console.

The in-progress GUI turn composition now includes native admission, protected
input forwarding, inherited model configuration and post-commit receipt effects.
The expanded local comparison passes 478 cases and 79 execution-state snapshots
on native PGlite and private PostgreSQL. External PostgreSQL passes 490 cases
and 85 snapshots, including six real concurrent placement scenarios for each
repository, twelve telemetry races across same/mixed Node/Rust pairings, and
eight Task lease races. Each store also reopens its real database three times.
Task follow-up recovery requests the worker's real
inventory before returning an actually removed, agent-managed checkout to its
own source's Primary; pinned, active, offline and unready placements retain
Source behavior. Existing conversation identity and target runtime survive the
move, and the linked console moves in the same transaction. The unchanged
Source Task placement suite passes all 13 tests.

Placement race evidence holds the chat row with `FOR NO KEY UPDATE`, confirms
the real final placement `UPDATE` is waiting on that lock, changes the captured
worktree, revision, mode, automation pause or status, then releases it. Both
repositories return the exact placement conflict and roll back the suspended
lane and console move. A missing-target-runtime case also proves the new runtime
insert rolls back. The content-free model behavior tracker retains actual
native capture gaps and conflicts, streamed-update deduplication, first-observed
timing and JavaScript test-command whitespace behavior. Equal locale collation
keys preserve original capture insertion order. Returned snapshots cannot
mutate retained native evidence; command text and output stay out of them. All
15 unchanged Source tracker/attribution tests pass.

General live token usage now has the complete native-turn identity writer:
project-before-chat locking, exact source aliases, zero-count bootstrap adoption,
refusal to discard independently measured usage, native response deduplication,
immutable capture fences and delayed-finalizer retention. Canonical history uses
that same writer inside its existing transaction and a real nested savepoint;
the older specialized history writer has been removed. Model behavior uses the
Source advisory lock and retains finalized counters while late captures enrich
attribution. Both writers roll back actual injected SQL failures, then accept
retries without duplicate rows or aliases.

The live wrappers use these actual writers and the unchanged reference runtime
for comparison. They preserve child-turn source identities, account/route resume
identity, project usage publication, current server/runtime versions and warning
behavior when analytics storage fails. Their behavior snapshots contain counts
and model evidence without retaining command text or output.

The chat quota service now uses the existing native account/observation writers
and limited worker command bus. It retains live credit mutation and settings
invalidation, the real two-minute quota-read command, immediate and 5/15/45-second
completion samples, and deduplicated samples five seconds before and two seconds
after known resets. Reset identities are released before sampling again. Delays
outside the reference bounds are skipped. Closing cancels timers and drains
admitted requests through their actual SQL commits, including a controlled
worker response held in flight while closing starts.

Twenty-eight quota scenarios per store compare the unchanged Source routing
service and real writers, with seventeen additional durable-state observations.
They cover provider/account eligibility, repeated snapshots, shared credit state,
nullable correlation, missing versus null live limit identity, exact reset
timing and deduplication, canceled timers,
worker/schema errors and actual SQL faults. Credit writes that Source commits
before a failed quota reading remain committed; runtime mutation and settings
publication retain their separate Source success/failure boundaries. Grok
observations preserve the reference's ChatGPT-only credit update policy. These
components still require the full turn service's production composition.

The production Live mutation service now uses the real message and interaction
writers, worker protection, model attribution, plan state and Task workload
routing. Native-event HTTP publication uses this same service after the fenced
transaction commits. Its actual HTTP comparisons pass all three stores in all
three authentication modes. Task launch, heartbeat, pause and settlement use the
persisted lease's exact fence. Real row-lock races across Node, Rust and mixed
pairs prove that launch and unstarted pause cannot both win. A Source PostgreSQL
Date-parameter defect was reproduced and fixed; its thirteen Task dispatch tests
and the actual PostgreSQL comparisons pass.

The new turn bootstrap composes placement recovery, model/account binding,
worker protection, attachments, policies, MCP, Task launch fencing, native or
legacy lane admission, retry rollback, plan mode and durable input attribution.
Comparison runs the real Source turn through worker-attribution loading and
then deliberately stops before its worker stream. It covers bound disabled
routes, Task reprotection, stale/missing leases, standalone ownership, missing
attachments and real INSERT failure after admission. A surrogate-bearing route
must remain a lookup filter; the regression fails before its native fix and
passes afterward. Retry acknowledgments use the actual Source rollback schema.
All 5,499 turn-contract outcomes and exact errors match, including the actual
turn/relay results, automatic-label response, computer-use approval and worktree
status roots. The latest extension preserves all 436 previous root mappings and
all 8,892 schema nodes, adding one root for an already represented status schema.

Bootstrap stage deadlines retain the actual late operation and shutdown drain;
caller disconnect does not cancel its work or completion logging. Separate
tests exercise those lifetimes. The initial 1 MiB bootstrap stack overflow was
fixed by boxing async composition boundaries; the same constrained fixture now
passes without increasing its stack.

The native turn engine now composes automatic message-title claims, the real
worker payload, ordered event handling, protected final-message deduplication,
approvals, opaque plans, actual telemetry/quota writers, outcome validation,
provider failover and failure settlement. Ordinary calls return while their
owned stream continues; scheduled Tasks wait for dispatch and retain their
fenced heartbeat. Message naming rereads the setting after the worker reply,
releases its actual claim on failure, and retains the private logging boundary.
Task title reconciliation still requires the Task domain implementation.

The expanded controlled-worker corpus passes 553 comparisons and 116 complete
state snapshots on native PGlite and private PostgreSQL. External PostgreSQL
passes 565 comparisons and 122 snapshots, including the real placement,
telemetry and Task lease races. Each store reopens its database three times.
These tests execute the actual Source and Rust engines and durable writers. They cover
protected approvals, plaintext-plan rejection, completed Task output, Task Goal
worker interruption without replay, callback failure boundaries, worktree
continuation and pre-activity provider failover. The comparison exposed and
fixed a native fanout-admission ordering defect and a non-Unicode JavaScript
retry-expression mismatch. Both regressions fail before their respective fixes.

The recovery coordinator now implements real queue claims, unadmitted-claim
release, dispatch coalescing, native Goal actions, full model configuration,
worktree moves and protected system continuations. Account preparation precedes
claim acquisition. A failed native action retains the already committed input
projection while releasing the unadmitted claim. Unmanaged dispatch deletes its
queue input only after bootstrap succeeds. Pending releases request actual
worker status and cancel when new uncommitted changes appear. Task recovery runs
before an old pending handoff can move placement. These comparisons exercise the
real Node and Rust coordinators and repositories with explicitly controlled
turn, account-transfer and Task collaborators.

The shared outcome scheduler now cancels delayed recovery after ordinary turn
settlement, renews its sixty-second suppression window and retains admitted
recovery work through shutdown draining. Its virtual-clock regression exposed a
late-started timer under executor backlog; deadlines now start at admission.
All five native scheduler/lifetime tests and five unchanged Source tests pass.

The engine and coordinator still need production composition with actual account
preparation and Task collaborators. Controlled runtime collaborators are not
production composition. Full
durable outcome projection and public turn/receipt HTTP composition remain
unported, so these components do not yet provide complete GUI execution.

Native runtime handoffs now have their actual Rust repository, configured runtime
resolution, worker dispatch coordinator and all seven HTTP route/method pairs.
Reservations, preparation/replacement CAS, canonical commit, cancellation,
acknowledgement, cold source/destination recovery, retirement and bounded failure
diagnostics share the actual chat lock and native settings writers. A late SQL
trigger failure rolls back the runtime, root model, settings and handoff together.
Configuration uses owned configured identity without cached readiness or quota
gates. Worker acknowledgements alone cannot authorize input: account transfer
waits for the durable completed phase. The expanded GUI/handoff repository corpus
passes 628 comparisons and 131 snapshots on PGlite/private PostgreSQL, and 640
comparisons and 137 snapshots on external PostgreSQL, including its real races.
Each store reopens four times. Seven added schema roots preserve every old root
mapping and schema-node prefix; 15,432 turn protocol outcomes and exact errors
match Source.

Actual handoff HTTP comparisons pass all three stores in anonymous, password and
account modes using the existing WorkerConnection and NativeRuntimeHandoffClient.
They compare bodies, status codes, security headers, endpoint-encrypted snapshots,
worker intents, publication counts, coalesced retry, cancellation, restart and
shutdown with a command that has no deadline. A queued preparation retains its
generation while real handoff recovery is held, then claims and opens the
destination console only after recovery settles. Authenticated worker reconnect
now supplies these actual per-chat recovery futures to Rust preparation. Owned
HTTP/worker work drains after bridge closure and before database closure. The
ordinary preparation HTTP matrix also passes again across all stores/auth modes.

This combined test exposed two Source lifecycle defects, retained as failing
before-fix evidence: pending handoff failure persistence raced database closure
and hung shutdown, and account-mode reconnect published outside its owner
context, rejecting an otherwise completed recovery and stranding preparation.
Source now tracks every outstanding handoff through shutdown (including replaced
requests), and binds reconnect recovery to the authenticated account. The same
HTTP assertions pass after these fixes. All 52 existing Source handoff/account
tests pass with the bundled real Codex binary, including both formerly skipped
CLI transfer tests. Those CLI results exercise Source; Rust's new HTTP worker is
explicitly controlled and does not establish real native file/account transfer
or attached CLI acceptance. Strict all-target Clippy, the turn protocol/lifetime/
scheduler suites and Source typechecking pass. The supported-platform workflow
now includes these GUI, preparation and handoff suites; configured CI is not
passing platform evidence. This work remains unmerged, and full GUI execution,
packaging, migration/rollback, final cutover and merged delivery remain required.

Automatic account preparation now uses the real Rust handoff service before
admission. It rereads the owned context, checks its captured input revision and
canonical binding, and preserves the route and native conversation. A depleted
ChatGPT account can select an eligible credit or legacy account using the shared
account-routing rules. Current credits, unknown or incomplete weekly usage,
missing alternatives, Task conversations and active lanes retain Source behavior.
There is no new readiness gate. The queued-account adapter uses the same service
and captured revision; the application constructs that service with its actual
handoff coordinator and drains account work before handoffs and the database.

Concurrent callers join one owned preparation, including a caller with an older
revision arriving while the transfer is held. Dropping the first or every waiter
does not cancel the admitted transfer. Shared failures retain their original
typed error, message, status and cause through caller context; an early worker
reply still cannot authorize account replacement. A failed transfer retains its
reservation, and a later automatic attempt respects that durable pending handoff.
The complete GUI corpus now passes 696 comparisons and 173 state snapshots on
PGlite/private PostgreSQL, and 708 comparisons and 179 snapshots on external
PostgreSQL. Four real database reopens per store remain verified. The new cases
use actual selectors, settings, handoff coordination and durable writers with
an explicitly controlled worker. They also resolve both configured account homes,
including a legacy fallback, and exercise actual model-catalog availability.
All 21 existing Source account-failover/recovery tests and strict all-target
Clippy pass. These are component checks; full turn/receipt routing, real Rust
native account/file transfer, Task/outcome integration and merged delivery remain
unfinished. Normal builds continue to use Node.

The native Task repository now persists opaque draft/plan edits, encrypted
operation starts and idempotent results, execution/message references,
finalization acknowledgements, failures, interrupted-operation reconciliation,
Goal state synchronization and owned deletion. It preserves the Source version
conflicts, exact updated columns, queued-cycle fencing, lookup precedence and
the boundary between an encrypted finalization result and acknowledged Goal
startup. JSON-text comparisons retain raw JSONB key order: an otherwise
identical Goal update can advance the revision just as Source does. The server
does not decrypt Task content.

The actual Source/native Task repository suite passes 158 paired observations
on each of native PGlite, private PostgreSQL and external PostgreSQL, with three
process reopens per store. A forced conflict after round insertion rolls back
both the attempted round and the Task mutation. Oversized wire-valid draft/plan
revisions preserve PostgreSQL integer-range failures and leave stored state
unchanged; guards compare the actual typed column rather than its JSONB form.
Twenty-four external PostgreSQL
races verify distinct/duplicate starts and duplicate completion under actual
row-lock contention, including mixed Node/Rust peers and reversed callers.
These prove the Task repository operations, not a complete mixed rolling
deployment. State, retry-window/latching and encrypted-relay policy comparisons
match 1,756 Source outcomes; seven added schema roots match 20,022 protocol
outcomes and exact error strings. The manifest retains all 444 previous root
mappings and its entire 8,974-node prefix (now 451 roots and 9,013 nodes).

This repository and its relay/retry helpers are dependencies for recovery
integration. The Goal and retry services described below provide the next
dependencies; execution recovery, scheduling collaborators, durable turn-outcome
projection and public turn/receipt HTTP composition remain unfinished. Component comparisons do not establish actual Rust CLI acceptance,
desktop packaging or Winterhold readiness. This GUI/Task milestone remains in
its isolated worktree until it forms a coherent, verified delivery.

Task dispatch now has its native owner-serialized enqueue, claim, pause/resume,
capacity deferral, expired-lease reconciliation and retained Goal recovery
repository. Worker order, FIFO age, assignment/continuity, project pause,
worktree/branch ownership and capacity checks preserve Source behavior. The
eligibility resolver is required; production routing must prepare its results
outside the transaction, as Source does, so PGlite does not nest queries on its
exclusive connection. An unused invalid clock does not add an eager rejection.

Actual Source/native dispatch comparisons pass 282 observations on native
PGlite/private PostgreSQL and 326 on external PostgreSQL, including 24 witnessed
owner-lock races. Those races cover claims competing with claims, retained
paused resumes and settled Goal capacity reacquisition, with same/mixed
Node/Rust peers and both operation orders. A post-claim Task write failure rolls
back the cycle, fence and metadata together. Goal recovery retains live owners
and fences and re-fences expired ownership without replaying its operation.
The timestamp comparison caught and corrected a real fidelity defect: Source
writes FIFO age through JavaScript Date, so Rust now truncates stored
submillisecond Task timestamps to the same millisecond precision.

Two added schema roots retain all previous 451 mappings and the full 9,013-node
prefix (now 453 roots and 9,027 nodes). The expanded Task protocol suite matches
21,038 outcomes and exact error strings. All 18 existing Source dispatch,
scheduling and scheduling-migration tests pass, as do strict all-target Clippy
and the 158-case native PGlite Task repository regression. These are component
results; the actual Goal runtime, model eligibility preparation, automatic retry
scheduler, Task HTTP routes and complete turn/receipt execution still require
production integration. The workflow includes these checks, but no new passing
supported-platform run is claimed. Normal builds still select Node.

The native Goal service now implements ordinary and encrypted Goal startup,
prepared finalization, passive/active observations, controlled-message
correlation, resume, saved-objective worktree continuation, retained dispatch
leases and scheduled completion/failure hooks. Its real routing, console,
protection, live and SQL dependencies preserve opaque Task content. Turn,
worktree-recovery and queue callbacks are required dependencies; production has
no placeholder collaborators. The composition into public turn execution is
still pending.

Actual Source/native Goal comparisons pass 86 observations on each of native
PGlite, private PostgreSQL and external PostgreSQL, with three process reopens
per store. They cover metadata/validation failures, passive stale-revision
recovery, active control conflicts, missing Goal observations, native and opaque
resume, unpause guards, console/input protection, finalization before turn
admission, existing start-message replay prevention, startup failure retention,
ordinary Goal UTF16/numeric interpolation and initial retained-lease
reconciliation. A failing-before regression caught null launch options bypassing
Source defaults in the first Rust implementation; the native service now applies
the same nullish model, message, purpose and worker-prompt fallbacks. Worker and turn boundaries are explicitly controlled in these
component fixtures. Periodic lease timing, in-flight shutdown, scheduled-hook
failure paths and complete worktree continuation still require direct
integration coverage.

The separate durable retry ledger passes 141 Source/native observations per
store and four process reopens per store. Operational retry writes leave Task
row/scheduler revisions, encrypted content and Task timestamps unchanged.
Checks include ownership, pause/approval gates, exact fractional due times,
claim expiry, deferred-attempt refunds, latching/reset and window boundaries.
Twenty-four external PostgreSQL owner-lock races cover duplicate claims,
duplicate failure notes and duplicate finishes with same/mixed Node/Rust peers
and both caller orders. These are repository coordination proofs, not full
mixed-version rolling-deployment acceptance.

The two new protocol roots preserve all previous 453 root mappings and the
complete 9,027-node prefix (now 455 roots and 9,056 nodes). Task protocol checks
match 22,944 outcomes and exact error strings; 660 actual Source failure-category
vectors include Unicode and explicit-code precedence. All 42 existing Source
Goal/retry tests pass. The 158-case Task and 696-case GUI native PGlite
regressions and strict all-target Clippy pass. The supported-platform workflow
now includes the new suites; its configuration does not prove platform
acceptance. Task execution recovery, eligibility/worker management, automatic
scheduling, complete turn/receipt composition and every original release,
migration/rollback, coordination and packaging requirement remain. Normal
builds continue to select Node; this owned milestone has no PR yet.

Task execution recovery now uses the real native Goal service, Task/dispatch
repositories, worktree placement and execution lanes. It restores retained
session affinity, preserves manual pause and provider/user budgets, coalesces
concurrent observations, escalates a joined explicit Resume, and throttles
completed background observations for 30 seconds. Owner-scoped unpause and
status writes preserve queue revisions and unread-completion behavior. The
service implements the required Task collaborator for chat recovery; its
publication, unpause and failure-report callbacks remain required production
dependencies, without fallback implementations.

Actual Source/native recovery comparisons pass 91 observations on each of
native PGlite, private PostgreSQL and external PostgreSQL, with four process
reopens per store. They include unavailable/different retained worktrees,
concurrent user changes, running native-session reattachment, real capacity
reacquisition, exact observation backoff, coalesced intent/failures, detached
caller drain, restoration of original placement, and cancellation of obsolete
handoffs. Canonical-repair cases persist a real encrypted finalization through
the Task repositories before protecting a system continuation; they assert that
the saved approved objective is reused and that concurrent protected completion
wins before turn admission. The worker and final turn/publication callbacks are
explicitly controlled component boundaries, not actual CLI/product acceptance.

An existing Source/worker failure boundary remains visible: the worker's
`protectTaskGoalLaunchFailure` creates a finalization-phase failure with
`stableStateBeforeFailure: review`; implementation synchronization rejects that
metadata during an already-started Goal continuation. Both servers preserve the
same rejection, original Task revision and live bounded dispatch. A separate
valid implementation-failure payload verifies opaque failure persistence and
lease settlement. The failing expectation and the corrected distinct cases are
retained; actual-worker continuation-failure acceptance still needs resolution
before claiming that product flow is ready. No planning metadata is rewritten
or validation bypassed to conceal the issue.

All 39 existing Source recovery/Goal tests and 20 worker Task-operation tests
pass. The preceding 86-case Goal and 696-case GUI native PGlite regressions and
strict all-target Clippy pass. The workflow includes recovery across the three
platform/backend jobs, but no new passing supported-platform run is claimed.
Prepared eligibility, automatic scheduling, outcome projection and full public
turn/receipt composition remain next, together with
all original coordination, migration/rollback, release and packaging work.
Normal builds still use Node and this owned GUI/Task lane has no PR yet.

Task Worker settings now run through native production list/create/update/delete/
order HTTP routes and real owner-scoped persistence. They preserve SQL defaults
for omitted internal properties, optimistic revision fences, shared-provider
checks for custom subagents, trusted catalog continuity-family normalization,
explicit null overrides, active dispatch counts, two-phase ordering and soft
deletion with retained Task/cycle references. Project scheduling pause persistence
uses the same owner lock, revision and timestamp behavior as Source; its public
pause/resume runtime is not yet composed.

Actual Source/native comparisons pass 102 repository scenarios per backend,
with ten snapshots and five process reopens on native PGlite, private PostgreSQL
and external PostgreSQL. Forty external PostgreSQL races witness the actual
competing SQL lock waits for create, update, delete/update and project pause
with same/mixed Node/Rust peers and both arrival orders. Checks retain SQL integer
overflow/rollback, lone-surrogate text encoding, committed invalid projections
and a 257th worker that inserts successfully before list validation rejects it.
No eager list-limit or model-catalog startup gate substitutes for the operation.

Actual production HTTP/Live comparisons pass all three backends in anonymous,
password and account modes: 37/41/45 observations per runtime on PGlite/private
PostgreSQL and 38/42/46 on external PostgreSQL. They verify required DELETE bodies,
static-order versus dynamic-ID routing, owner isolation, exact error responses,
SQL rollback, post-commit settings invalidations, committed response-projection
failure and restart persistence. External PostgreSQL additionally holds a real
row lock, aborts an admitted caller, releases the lock and verifies the committed
update and Live event in each authentication mode.

The eight scheduling roots preserve all prior 455 mappings and the complete
9,056-node prefix (now 463 roots and 9,093 nodes). Task protocol comparisons pass
24,423 outcomes and exact errors; all 18 existing Source scheduling/migration/
dispatch tests, the 282-case dispatch and 86-case Goal PGlite regressions, and
strict all-target Clippy pass. CI now includes the repository
and HTTP suites on each backend; no new supported-platform run is claimed.
Prepared eligibility, the automatic/background scheduler, complete GUI/public
turn/receipt composition and every original shipping requirement remain. These
resource proofs do not establish a complete mixed-version rolling deployment.
Normal builds still use Node; the owned GUI/Task lane remains unmerged.

Prepared Task dispatch and resume eligibility now use the actual native routing,
Task Worker configuration, physical worker status and chat context repositories.
Provider/catalog reads finish before owner-serialized claim/resume transactions;
the resolver passed into those transactions reads only its prepared snapshot.
Changed project, physical worker, worktree or Task Worker revision fences reject
the cached dispatch result. Claimed runtime projection checks the selected route
and provider account exactly; retained threads survive only an exact match.

Actual Source/native comparisons pass 64 observations on each backend, with six
Task SQL snapshots and three process reopens. Explicit pre/post-reopen equality
checks preserve the complete Task, Worker and dispatch/retained-lease rows. They include real prepared claims and
resumes, worker disconnects during resolution, Task component grants, subagent
capability/topology, catalog reconciliation, account budgets/credits/cooldowns,
changed Worker revisions, cached-placement rejection and retained lease identity.
The Source credit-funded account cooldown exception is asserted separately from
ordinary account cooldown rejection. No extra grant or enabled-state gate is
added to paused resident-session resumption, preserving Source behavior.

Real delayed catalog work exercises both dispatch and resume timeouts. The
native service retains admitted work and drains it after the waiter times out;
its warning event, duration, error class and message match Source. A delayed
catalog SQL write is observed after the timeout. The Source functions were
extracted into a reusable production helper without body changes apart from a
timeout dependency whose production default remains 30 seconds; the original
body and an exact canonical-body comparison are preserved as evidence.

Source typechecking, all 26 focused scheduling/dispatch/launch/project-pause
tests, the boundary inventory audit, strict all-target Clippy, the 282-case
PGlite dispatch regression and actual PGlite HTTP/Live in all three auth modes
pass. CI now includes eligibility comparisons on all backends, but no new
supported-platform run is claimed. Catalog transport and connection-state peers
are explicitly controlled fixture boundaries; this does not prove complete
worker/product execution. Full background scheduling, actual project Task
pause/resume, durable outcome
and full public turn/receipt composition remain, together with every original
migration/rollback, coordination, packaging, platform/performance, Winterhold
rehearsal and merged default-cutover requirement. Normal builds remain on Node.

Task automatic naming now uses the native title service with the existing
worker label command and opaque Task brief. Task-specific preferences remain
independent of message/random-agent naming. Atomic claims, privacy-preserving
failure logs and protected-label publication retain Source behavior. An empty
creation result reconciles exactly once when a newer Task revision has a saved
dispatch; an autosaved draft alone never triggers reconciliation. Ordinary
message naming continues through its existing route-pair selection; Task naming
uses the Source Task runtime's available-route selection.

The native Task operation queue composes actual dispatch admission, retry-ledger
reset, Task Live invalidation, Task lookup, best-effort naming and scheduler
wakeup in Source order. Explicit operations reset the retry ledger; automatic
admission preserves its complete stored record. A naming error cannot fail an
already admitted operation. The retry helper reuses the real approved
finalization/Goal receipt instead of creating a second operation; ordinary
failed attempts use their requested or freshly generated operation ID.
Implementation and Goal-continuation retries remain on their Goal controls.

Actual Source/native comparisons pass 58 observations on each backend, with
11 shared state snapshots, ten Task-specific SQL snapshots and three process
reopens. Explicit pre/post-reopen comparisons retain protected labels and full
Task/dispatch rows. The corpus includes the existing message-title assertions,
Task preference/claim/reconciliation/error cases, manual/automatic admission,
real encrypted finalization receipts and fresh-attempt retries. An actual SQL
constraint forces retry-ledger reset to fail after dispatch admission commits;
both servers retain the committed queued cycle and the original ledger.
Catalog/worker replies and the scheduler wakeup are explicitly controlled
fixture boundaries; this is not complete scheduler or real-worker acceptance.

All 19 existing Source naming/retry tests, the 696-case PGlite GUI regression and
strict all-target Clippy pass. CI includes the naming/queue corpus on all three
backends; no new supported-platform run is claimed. The background claimed/resumed
execution scheduler, actual project Task pause/resume,
durable outcome and full public turn/receipt graph still require production
composition, together with every original migration/rollback, coordination,
platform/product/performance, packaging, Winterhold rehearsal and merged/default
cutover requirement. Normal builds continue to use Node.

The native automatic retry actor now composes the actual Task/retry repositories,
Goal observation and execution recovery, operation queue, naming and Live services.
It reserves at most four chats per batch before starting jobs, deduplicates
concurrent ticks and lets other candidates proceed while a worker observation is
held. Stop prevents new admission; drain waits for admitted jobs. Legacy failures
are adopted once, claim IDs become new attempt receipts, running prior turns defer
without spending attempts, and implementation recovery preserves user-paused Goals.

All three local macOS storage modes pass 27 Source/native comparisons, including
28 Task-specific SQL snapshots, eight shared snapshots and four process reopens.
The fixture holds actual Goal commands to exercise the concurrency bound and
nonstalling recovery, and uses actual database triggers to change a revision or
invalidate the Task projection immediately after claim. Both implementations
finish these claims through the same failure/revision branches; the revision
mismatch preserves Source's early return without a final publication. Complete
Task/dispatch rows are explicitly compared before and after restart. Different
owners retain their own queued operations and Live events. Every event, command
and log field is compared, preserving per-chat order while allowing independent
chats to interleave.

All 67 focused Source tests, the 86-case Goal and 91-case Task recovery regressions,
the 696-case GUI regression, strict all-target Clippy, Rust formatting and diff
checks pass. CI includes the retry corpus for every storage mode. Worker replies,
catalog transport, the turn boundary and scheduler wakeup are named controlled
fixture peers. Full background execution/public turn composition, actual worker
and client acceptance, supported-platform and packaged readiness remain unproven.
Every original coordination, existing-data upgrade/post-write rollback, performance,
packaging, Winterhold rehearsal, merged/default cutover and Node-server removal
requirement remains. Normal builds continue to use Node.

The native claimed Task launcher now uses the actual turn runtime, Goal service,
routing, worker command bus, Live writers and repositories. It validates the
claim's current placement and selected runtime, prepares and persists the opaque
operation, and supplies real structured completion/failure hooks. Completion
persists the authenticated result, appends the protected assistant message,
attaches its durable identity and settles the fenced dispatch. A saved committed
result settles without replaying its worker operation. Preparation failures record
operational retry state without inventing protected Task failure content.

All three local storage modes pass 43 Source/native observations, twelve
Task/round/cycle/message SQL snapshots, six shared snapshots and three process
reopens. Direct and initial-plan operations run through the complete turn engine;
full rows are explicitly compared across restart. An actual running Task forces
capacity deferral, then a new real claim reuses the saved request without preparing
a second operation. Worker transport failure, malformed stored metadata and
structured result identity failure exercise real cleanup. A delayed worker reply
commits an actual SQL effect after the launch timeout; both fixtures drain that
admitted work. Launch-stage start is observed before bootstrap events.

Configuration changes after claim preserve Source's distinction between a
retryable unavailable subagent route and a nonretryable missing worker capability.
The comparison exposed generic native error names; response validation and model
configuration errors now retain their named classes and failure data across owned
turn boundaries. Diagnostic text is preserved. The Source launcher was extracted
as a reusable production helper: its 402-line body is unchanged after canonical
formatting, and its launch timeout keeps the existing 30-second production default.
All 54 focused Source tests, typechecking and the boundary inventory audit pass.
The initial concurrent Source test batch timed out during database setup; the
same assertions pass serially with their original deadlines.

Strict all-target Clippy, the 696-case GUI and 158-case Task repository regressions,
Rust formatting and diff checks pass. Worker replies, catalog transport,
claim-eligibility answers, worktree/queue continuation and scheduler wakeup remain
explicit controlled fixture boundaries. This is not actual-worker,
full background scheduling or packaged acceptance. Pause/resume and resumed
dispatch are described below. Complete scheduling/project controls, actual-worker
finalization/Goal and lease/shutdown acceptance, the public turn/receipt graph and
every original shipping requirement remain. Normal server defaults use Node.

Chat/Task automation pause now uses the actual native control context, durable
state, Goal service and Live publishers. Managed unpause commits before worker
admission; active native controls persist intent at dispatch. A late worker
acknowledgement rereads the newest durable state instead of overwriting it with
an older request. Legacy Tasks still require an exact worker acknowledgement.
Failure paths retain Source's pause rollback, compensation and error ordering.

The local comparison passes 60 observations, thirteen shared snapshots and three
process reopens on each storage backend. It uses real native admission, dispatch
and settlement for overlapping controls in both directions. Invalid receipts,
UTF16 errors, offline/missing/foreign sources, source deletion after the worker
boundary, dropped callers, failed Goal resume and native failure after dispatch
are covered. Initial and missing-source compensation commands retain the
unbounded streaming deadline; failed next-action compensation retains the normal
worker deadline. Worker replies remain a controlled fixture boundary. Public
routing, full scheduler/project controls and actual product/platform acceptance
remain unfinished.

Resumed Task execution now composes the actual acknowledged pause service, Goal
service, claimed launcher, turn engine and durable dispatch/Live repositories.
It checks current placement and retained thread/turn affinity before continuing.
An inactive Task uses the real claimed launcher; an implementing finalizer resumes
its retained Goal. Failed resumes re-pause the worker and fenced dispatch. Typed
stale-fence conflicts preserve the original error, while a genuine cleanup
projection error takes precedence. Admitted work survives a dropped caller.

The expanded claimed/resumed corpus passes 116 observations per local backend,
25 Task/round/cycle/message SQL snapshots, eight shared snapshots and four process
reopens. It covers real pause/resume claims, active-turn affinity, changed placement,
offline workers, actual direct-turn restart, preparation failure accounting and
retained finalization heartbeats. An actual SQL trigger commits an invalid dispatch
projection to exercise cleanup precedence. The implementing finalizer runs a real
encrypted Goal continuation through the turn engine and stores both protected
messages. Complete rows are explicitly equal after restart.

The 2,731-byte Source resumed function retains its exact body after canonical
formatting and is called by the existing production routes. All 116 selected
Source tests and 24,752 Task protocol outcomes/messages pass; all existing contract
root mappings and nodes remain unchanged before the three appended pause roots.
Strict all-target Clippy, typechecking, formatting and the boundary audit pass.
Worker replies, catalog transport, continuation/queue boundaries and scheduler
wakeup remain controlled development peers. This is component evidence: the full
scheduler and project-control production mounting, public turn/receipt composition,
actual client/worker/CLI, platform/product and all original shipping acceptance remain.

The coalesced Task scheduler now uses concrete automatic retry, recovery,
prepared eligibility, claimed/resumed execution and Live services. Weak wakeups
connect their real completion hooks to the same scheduler without a reference
cycle. A tick captures its own completion, drops duplicate active wakeups, and
launches owned execution without waiting for slow worker turns. Startup retains
an immediate tick and the one-second poll. Timer/retry stop and captured-tick,
retry and admitted-launch drains keep durable writes owned through shutdown.

All three local storage modes pass 31 Source/native observations, fourteen
Task/cycle/round/message SQL snapshots, six in-run snapshots, eight shared
snapshots and four process reopens. The graph executes encrypted direct Tasks,
capacity-limited queues, independent checkouts, periodic project unpause,
expired unstarted reclaim, worker-acknowledged resume and delayed affinity
failure. Retained Goal recovery renews its lease before expiry reconciliation.
Started-work expiry applies saved protected failure; real malformed projections
exercise both per-cycle error reporting and failed-tick recovery. Automatic
retry records its actual attempt while a disabled worker leaves the request
queued, then completes when enabled. Stop/drain preserves admitted completion
and queued work across restart. Concurrent tenants use their own worker, model
and event ownership. Full durable rows are explicitly equal after restart.

Independent chats can acquire PostgreSQL's global message sequences in either
order. Raw results retain that interleaving. The comparison preserves the exact
allocated sequence set and every message field, while checking positive unique
sequences, per-chat first-publication order, message identity/role, event
scope/revision and database/wire agreement. Negative checks reject changed
revision, scope, stored sequence and reversed message publication; opaque
payload changes remain observable. This makes independent-chat scheduling
comparable without discarding durable ordering checks.

The original 5,589-byte Source loop is preserved after canonical formatting and
continues to run in the existing Node server. Source typechecking, 116 selected
server tests, the boundary audit and strict all-target Clippy pass. Shared
regressions also pass 696 GUI, 116 claimed/resumed execution and 27 automatic-retry
observations. The reviewed contract set is unchanged. The worker, catalog and worktree/queued-turn
continuation boundaries remain controlled development peers. Production mounting,
public project controls, the full public turn/receipt graph and actual client/worker/CLI
acceptance are still required, along with all original distributed coordination,
full upgrade/post-write rollback, platform/product/performance, packaging,
Winterhold rehearsal and merged/default-cutover requirements. Defaults remain Node.

Project Task pause/resume orchestration now shares the concrete acknowledged
Chat pause, Goal lease, dispatch and Live services. It attempts all eligible
Tasks concurrently and aggregates failures in the original list order, preserving
UTF-16 messages. Complete/failed, archived and non-Task Chats are excluded.
Unstarted claims commit pause without a worker command and advance their fence;
active claims use acknowledged affinity and release retained Goal leases. Only
typed stale-dispatch conflicts are suppressed. List resume leaves paused dispatches
to the scheduler so capacity and lease acquisition remain authoritative. Admitted
controls remain owned when their caller disconnects.

The integrated local corpus now passes 70 paired Source/native observations per
backend: the 31 scheduler observations plus 39 project-control observations.
Each storage mode has 33 SQL snapshots, 27 in-run observations, 12 shared snapshots
and six process reopens. The added cases cover mixed states, saved/acknowledged
affinity, genuine scheduler resume, independent concurrent acknowledgements,
partial pause/resume failures, offline resume, tenant ownership and unchanged
protected envelopes. Actual PostgreSQL triggers prove failure after acknowledgement
and rollback of the Chat pause when the queue revision write fails; healthy
sibling Tasks still finish. The full ORM query-error contract now matches Source
for Chat, queue and both dispatch pause writes. A generated query manifest checks
the current Source builders. Comparison keeps exact SQL and scalar parameters,
validates live Date parameters before normalization, and rejects changed SQL,
state, failure counts and out-of-window clocks in negative probes. The original
Source project-control implementation is unchanged. This remains component
evidence: authenticated project pause routes, complete public execution/outcome
composition and every original product and shipping requirement remain.

Durable turn-outcome recovery now uses the real lane, Task, dispatch, protected
message, Live and logical-completion services. It checks lane ownership, the
latest user message and the claimed Task fence before accepting saved worker
results. It preserves partial commits on actual SQL failure, suspends finished
lanes, repairs a successful outcome after a concurrent failed/released lane,
and routes finalization through the actual Goal launch and turn engine. Lost
logical acknowledgements retain the durable outbox; older outcomes cannot
finish a newer GUI operation. Protected writes remain owned after their caller
disconnects. Concrete Task recovery/Goal adapters and weak runtime/coordinator
construction connect the actual queue/worktree coordinator without a reference
cycle.

The integrated local matrix passes 180 paired Source/native observations per
backend: 31 scheduler, 39 project-control and 110 saved-outcome observations.
Each backend has 84 SQL snapshots, 67 in-run observations, 18 shared snapshots
and nine actual process reopens. Coverage includes protected Agent/Task and
standalone results, malformed worker payloads, stale messages/leases, typed
settlement conflicts, real heartbeat/settlement SQL faults, finalization launch
and failure, logical acknowledgement loss and a retained queued follow-up
through the real turn engine. The controlled worker does not exercise its real
CLI receipt path; full queue consumption and actual-worker acceptance remain.
Independent queue claims are compared only after verifying the exact operation
hash against the owner, claim and immutable protected input. Negative probes
reject changed operation hashes, claims, owners and opaque input, alongside
changed SQL, state, failure counts and out-of-window Date parameters. Raw SQL
evidence also retains the exact default lease duration.

The original 12,622-byte Node outcome body is unchanged after canonical
formatting and is reused by production through an extracted helper. Source
typechecking, 92 existing server tests, the 696-case GUI regression, native
lifetime tests, strict all-target Clippy, the Source query manifest and the
boundary audit pass. The reviewed contract set and inventory counts are
unchanged. Worker/catalog I/O, account preparation and scheduler wakeup remain
explicit development boundaries for that component corpus. The production
execution graph is now composed in `chats/execution_services`, with actual
account preparation, worker commands, scheduler wakeups, receipt settlement and
authenticated worker outcome subscriptions. Public turn/project/Task controls
and all original actual-client, platform, upgrade, rollback, performance,
packaging, Winterhold and merged/default-cutover acceptance remain. Defaults
stay Node.

Canonical-history comparisons pass 233 cases and 88 state snapshots on native
PGlite/private PostgreSQL, and 255 cases and 99 snapshots on external PostgreSQL,
including 22 history races. A real GUI bootstrap precedes protected ingestion;
receipt SQL failure rolls the entire projection back, and a later GUI finalizer
cannot replace canonical response totals. Actual history HTTP passes all three
stores in anonymous, password and account modes using the unchanged worker
transport and endpoint encryption, complete opaque evidence, publication retry
and restart. The Rust library tests and strict all-target Clippy pass.

This is component evidence; production service composition alone does not
establish complete public GUI execution or packaged acceptance.

The stronger native acceptance fixture starts Cantrip's actual bundled Codex
runtime, managed gateway and PTY. It now passes against Node and Rust on all
three database modes: actual native resume, detached CLI exit and retry retain
the terminal/thread, with no inference, synthetic terminal input or native
history turns. Both peers complete two gateway resumes with no captured native
failures. The previously missing POST `/api/internal/native-commands/receipt`
now settles through production receipt notifications, Live boundaries and the
actual queue/recovery graph. These are macOS native preparation proofs using
real worker components, not complete unchanged-worker/app, supported-platform
or packaged GUI acceptance. The milestone remains in its owned worktree and
has not been submitted or merged.

The production HTTP/worker-notification comparison also passes anonymous,
password and account modes on each backend: 86 paired HTTP observations and
18 paired receipt Live-effect groups per backend. The actual worker transport
delivers a saved outcome; the real protection command encrypts its message,
duplicate notification preserves one result, and post-shutdown database reads
prove idle state, five settled receipts and no active lanes. Strict all-target
Clippy, three usage-timer tests and nine turn/recovery lifetime tests pass.
Full public execution/queue/Goal/Task routes, complete queue consumption and
adversarial production execution/shutdown coverage remain required.

Strict all-target Clippy passes after the runtime and fixture additions. The
corrected complete wire suite passes 370,337 actual protocol outcomes and exact
error messages. The new native behavior attribution root separately passes 890
outcomes and messages, and the generated manifest matches Source. All previous
root mappings and the entire schema-node graph remain identical when adding
that root. Invalid preparation examples remain in the explicit invalid-vector
stream, while oracle baseline examples are strictly parsed by Source. The full
`pnpm check` run reaches 1,662 passing
server tests, 57 skips and the same provider-account pooling failure at
`local-foundation.test.ts:7218` previously reproduced on clean Primary. Normal
desktop, development and standalone builds continue to use the Node server.

## Platform compatibility observations

Worktree state comparisons observe wall and monotonic clocks inside each
repository process. Returned update/scan timestamps must fall within those
strict producer boundaries and equal the actual persisted row. Parent-process
clock windows remain diagnostic; the Windows reference process has produced a
valid timestamp one millisecond before that independent window.

The streaming HTTP fixture waits for each chunk's write callback and an incoming
I/O opportunity before scheduling more output. A real Fastify parser reproduces
the earlier `EPIPE` while closing an oversized chunked upload. The regression
requires twenty complete 413 responses, twenty connections, limit-crossing
bytes and rejection before the full upload; reset, incomplete-response and abort
checks remain enforced. File-document HTTP comparisons pass all three stores.

Terminal deletion comparisons require cancellation of the affected tab's pending
transfer, exact retention of an unrelated transfer and removal of deleted views
from every window. All three store suites preserve complete relational/layout
snapshots. Evidence uses `.qa/rust-server/platform-contracts-*`.

Run 41249132393 completed with failure and has not established full platform
acceptance. Its Windows
contracts job fails on the Source Node Explorer oversized upload with
`read ECONNRESET`. Its Windows native-command job also fails on Source Node's
first oversized native-history request with `fetch failed` / `read ECONNRESET`,
after six parse-before-authentication assertions and before any native-history
proofs. Native-history HTTP on PGlite passes all authentication profiles in the
same Windows job. These actual failures are retained in the platform job logs
and downloaded report artifacts; no platform repair is claimed here.

The Linux contracts job also fails the actual Run-retirement flow on Source
Node: the real child starts and decrypts its protected Run secret, but its own
termination witness never appears before the bounded observation fails at
`actual-run-retirement.mjs:152`. Rust is not reached in that product flow. The
macOS contracts job is canceled. Native-command jobs pass on Linux/macOS, and
the migration, conversion, replica, discovery and chat-message jobs pass on all
three platforms; these successes do not establish the remaining contracts or
packaged product acceptance.

The fresh broad check still fails the provider-pooling assertion at
`local-foundation.test.ts:7218` (1,662 server tests pass, one fails and 57 skip).
The same focused case fails on clean Primary `10484f06e`. Root formatting still
reports 12 unchanged files. Focused protocol/worker/server/app suites, app build,
strict all-target Clippy, clock/HTTP regression tests and changed-file formatting
pass; the broad check remains unsuccessful.

A later focused worker run failed during an actual `git add` with an existing
`.git/index.lock`. Git Trace2 confirmed that background status reads write the
index, and a deterministic real-repository regression failed before the fix:
reading status changed the index bytes after only the tracked file's timestamp
changed. The status reader now disables Git's optional locks. The same test
passes while still reporting actual content edits, and subsequent add/commit
operations succeed. All 138 Git, worktree and app-server tests pass together,
including the previously failing filesystem observation case. The earlier
source-byte witness describes the pre-fix state; the Git reader is now
intentionally changed. This does not resolve the separate Node provider-pooling
failure in the broad check.

## Native command kernel and protected internal APIs

The additive native kernel implements command admission, immutable receipts,
preparation/dispatch, observed turns, logical continuations and completion
records, execution lanes/leases, encrypted prompts and managed queue authority.
Visible/protected interaction storage, accepted worker replies, expiry,
permission state/evidence and transaction-bound Agent/Task message and plan
writes retain the Node repository's transaction and idempotency behavior.

Native HTTP now handles admission, bind-preparation, dispatch, protected events,
permission transitions, pending requests, continuations and settings evidence.
Settings refresh/update/observation, account defaults and native model inventory
also execute natively. Real HTTP/Live comparisons cover native PGlite, private
PostgreSQL and external PostgreSQL in anonymous, password and account modes,
using the unchanged worker transport and production endpoint encryption helpers.
Stored command requests and native settings evidence decrypt using their
original associated data and retain the keyed worker digest. PostgreSQL fault
injection additionally verifies event rollback, actual row-lock waits and
historical Task chat/project notification ordering.

The coordination HTTP comparisons also reject missing, mismatched,
insufficient-scope, revoked and expired worker credentials for each new route.
In account mode, a second account enrolls a real worker and cannot access the
first account's command or Chat state. Rejected calls publish no Live events.

The next runtime layer includes a native receipt notification/wait primitive.
It retains notices received during a database read, polls durable receipts every
750 milliseconds when a notice is lost, preserves original UTF-16 Chat keys,
and removes subscriptions on completion or cancellation. Fifteen controlled
read/timer scenarios compare the unchanged Node waiter directly with Rust,
including concurrent abort/read outcomes and multiple listeners. The public
native method reads the actual managed queue repository. Receipt and queue HTTP
routes still require their real GUI dispatch and recovery consumers.

Native GUI queue preparation, mutation and lookup now use those same durable
repositories. Twenty GUI scenarios on each database compare original JSON
digests, explicit optimistic revisions, immutable replay and rejected receipts,
retained input after deletion, administrative input fences and tenant/placement
rejection with the unchanged Source helper. Their surrounding managed queue
corpus also retains restart checks and 20 same/mixed-runtime PostgreSQL races.
These helpers do not complete GUI turn dispatch or its HTTP consumers.

Native queue delivery now uses the durable notification repository and admitted
worker command bus. Its recovery group runs independently of notification
sweeps; each group has eight workers, retries retain their durable cursor, and
stop prevents late acknowledgment or defer. Twenty-four controlled scenarios
execute the unchanged Node service, including coalesced callers, errors at each
boundary, independently running recovery, early rejection with other workers
still active, and interval/stop behavior. Real repository/worker-wire comparisons
on all three storage modes also verify successful acknowledgment, no duplicate
delivery and a five-second defer after an actual worker rejection. Product
registration still requires the real GUI dispatcher; no production no-op
dispatch is supplied.

Logical completion delivery is now registered in the production Rust server.
It starts with the server, reads up to 64 due closures, uses eight independent
workers, and retries at the Source exponential delay capped at 30 seconds. The
next timer starts after the current sweep finishes. Shutdown stops admission
before closing the worker bridge and drains owned delivery before the database.
Exact owner, worker, Chat, root and generation identities fence acknowledgment
and retry writes; private worker/SQL errors remain outside the warning payload.

Thirty-one scenarios execute the unchanged Node completion service and compare
coalescing, concurrency, retry clocks, timer behavior and shutdown races. Real
production entrypoints and the unchanged worker transport pass all nine
database/authentication combinations: worker rejection retries without user or
reconnect input, successful acknowledgment deletes the durable row, shutdown
retains an unresolved root, and restart independently redelivers it. Shared
PostgreSQL additionally passes Node-to-Rust and Rust-to-Node restart handoff in
every authentication mode, preserving the generation and server identity.
Worker acknowledgment outcomes are controlled; complete native GUI/worker
execution remains required.

The native `finishManagedGui` equivalent commits logical closure before sending
the exact worker release and preserves the outbox if that acknowledgment fails.
Nineteen added repository cases per backend include a worker-side read proving
the closure committed before release, actual acknowledgment/closure SQL faults,
replay, and generation rejection. The surrounding PGlite corpus retains all
previous cases and passes 1,569 comparisons. Opt-in persistence observations
follow the real SQL result; native observations are absent from release builds.
Full GUI turn dispatch, receipt HTTP and canonical history composition remain
unfinished.

PR #2384's Windows native command job failed its first fresh GUI admission on
the original 1 MiB fixture thread with stack overflow (`3221225725`). The
`native_stack_diagnostic` workflow input runs that same repository suite under
MinGW GDB and retains native thread stacks/registers. It changes neither the
requested stack nor the suite's assertions and is separate from platform
acceptance. The optional `CANTRIP_FIXTURE_GDB` launcher affects only disposable
Rust repository fixtures; ordinary launches retain their existing command line.
The first debugger capture places the failure on the Rust caller during branch
lease acquisition while the PGlite engine thread is idle. The follow-up capture
measured 214,064 bytes retained by the native fixture dispatcher and 242,720 by
its outer dispatcher. The native selector now returns an individual boxed future
for each operation before it is polled. The original 1 MiB PGlite workload passes
locally with all 1,523 original cases plus 20 GUI cases. Windows run
`41226706489` now passes that same 1 MiB workload, including 1,337 snapshots and
10 reopen checks. The earlier full platform run separately failed an execution
target repository fixture with stack overflow. Run `41228493161` captured
373,760 bytes retained by the repository operation dispatcher and 235,232 by
its outer dispatcher while resolving a project target. Both selectors now
construct the selected future before polling it. All 431 original target cases
pass locally, with no cases removed or assertions changed. Windows run
`41229647423` now passes the same 1 MiB admission workload (1,550 cases, 1,345
snapshots and 10 reopens) and all 431 target cases under GDB. Full Windows
platform acceptance remains pending beyond those two suites.

The production completion milestone's Windows diagnostic `41235358597` also
passes the original 1 MiB fixture thread: 1,569 admission cases, 1,354 snapshots,
10 reopens and all 431 target cases. The retained GDB logs report normal exits.
This focused diagnostic does not run the complete platform matrix.

Restart recovery deliberately suspends existing execution lanes. The HTTP
fixtures therefore admit and dispatch through real routes after server startup;
they do not disable recovery or weaken event fencing. Current managed command
admission preserves Node's Agent-project eligibility. Task and standalone
managed admissions retain `managed-session-ineligible`; their complete product
execution paths remain separate work in the replacement goal.

The dedicated `native-commands` workflow job runs protocol/policy comparisons,
the repository suites with a 1 MiB fixture stack, and settings/model/event/
coordination HTTP suites across all three databases on Linux, macOS and Windows.
Registration of that job is not platform acceptance. Receipt HTTP with actual
queue notifications and dispatch/recovery, GUI orchestration, canonical history
ingestion, complete Task/Goal execution, Redis coordination, supported-platform
packaging, data-preserving upgrades/rollback and Winterhold rehearsal remain
required. Normal development, desktop and standalone entrypoints still use Node.

## Controlled conversion caller connection ownership

Linux conversion run `41160107203` reset the first status request after the
fixture restarted its server on the same port. An optional diagnostic workflow
repeats the original scenarios on isolated external PostgreSQL databases and
stops at the first failed iteration. It retains actual TCP connection and send
times without collecting credentials, query parameters or request bodies.

Diagnostic run `41165810079` failed at iteration four. Socket 53 connected at
`1793418880326`, while process 9018 was shutting down. That process exited at
`1793418880366`. The socket remained unused until the first status GET to the
restarted process 9033 at `1793418880741`, then reset one millisecond later.
The connection belonged to the previous server process: aborting the controlled
global-fetch caller had opened an unused replacement connection.

The controlled admission caller now uses the existing single-socket streaming
HTTP helper. Its abort closes that socket without opening a replacement. The
original database locks, admitted-write, shutdown, restart, recovery, revision
and worker-command assertions remain in place. The repeat harness additionally
checks actual TCP connection times for post-restart status reads. Resets and
incomplete HTTP responses still fail without retrying. All eight focused
streaming-client and trace tests pass, including the new actual abort/connection
ownership test. Two corrected local repeats pass all three auth modes for both
implementations on Node 24.22.1, including the actual post-restart connection
checks. Linux diagnostic run `41167479583` at code head `9412d6565` passes all
20 repetitions. Its verified artifact contains 120 completed restart scenarios
(three auth modes and both implementations per repetition), with each actual
post-restart GET using a connection established after the prior process exited.
The artifact ZIP SHA256 is
`579fb182432dc55adbafb30a38ebbf089b4c7dce046f393927fb9c312e625086`.
This is focused Linux lifetime evidence; diagnostic dispatch does not replace
the full platform matrix or packaged acceptance.

## Platform recovery observations and PostgreSQL 16 transfer

PR #2361 platform run `41129609392` exposed two observation races. The macOS
external-PostgreSQL discovery check read an imported candidate with parent
revision 11 and returned before asserting the required revision 12. Both
production implementations read the job and candidates through separate queries,
so a completion can commit between those reads. The recovery poll now waits for
all expected fields together and retains each raw snapshot. Exact final revisions
and ordered recovery events still have their original assertions.

The Windows external-PostgreSQL terminal report shows the startup reconciliation
command arriving after service creation and enabling, producing an extra terminal
invalidation during the later restart check. The fixture now observes the actual
empty startup reconciliation before creating the service. It keeps exact event
counts, order, scope and payload checks, and retains raw Live traces and failed
fixture roots for diagnosis.

PR #2362 Linux migration run `41138651367` reached the native storage contracts,
then PostgreSQL 16 rejected pg_dump 18's generated `transaction_timeout` setting.
An isolated PostgreSQL 16.15 container reproduced that error. The bounded exporter
now adapts only the generated leading prelude: it attempts the real setting in a
DO block and tolerates only an absent setting. Permission errors and other SQL
failures still propagate. Function bodies and exported multiline values are never
searched or rewritten. PostgreSQL's [cross-version dump notes](https://www.postgresql.org/docs/18/app-pgdump.html#APP-PGDUMP-NOTES)
explain why older destinations can require SQL adaptation.

Local current and genuine 233-migration transfers pass into PostgreSQL 16.15,
native PGlite 17.5 and private PostgreSQL 17.9 with identical 115-table snapshots
and four sequence states. The fixture includes a multiline row containing the
same setting text to verify that data remains unchanged. The optional test-only
`--postgres-url` creates isolated random databases on a supplied PostgreSQL test
server and removes only those databases afterward. These backend results do not
prove the Rust executable's Linux or Windows acceptance.

The local discovery lifecycle suite passes on all three stores and all three auth
modes; terminal HTTP/Live passes on all three stores and both auth modes. A retained
PostgreSQL recovery trace actually includes `(revision 11, imported)` followed by
`(revision 12, imported)`. Current and historical transfer interruption checks also
pass on all stores. The original Windows migration job passes with SQL-written
SIGKILL witnesses and successful retries; the follow-up head still needs CI results.

The broad repository check ran and failed with 21 source-server test failures,
1,628 passing and 71 skipped under concurrent validation. Sequential reruns of all
16 failing files on both clean baseline and this branch each pass 49 tests and
reproduce only the existing provider-routing assertion in
`local-foundation.test.ts:7218`. No deadlines or assertions were changed, and this
does not make the broad check green. The local startup stalls were separately
sampled in tsx disk-cache eviction before application entry; the reruns disable
that shared cache without deleting it.

## Removed plaintext GitHub catalog

The root Node request policy disables every `/api/github/` route, including the
five catalog handlers still present in TypeScript source. Rust now preserves
that HTTP 410 contract after authentication and CSRF and before payload parsing,
request limits or worker dispatch. This does not reactivate plaintext repository
access or implement the separate protected GitHub provisioning domain.

The real-socket `github-catalog-http-compatibility.mjs` suite compares status,
body, cookies and security/CORS headers for local, password and account modes.
It includes unknown paths, unsupported methods, duplicate query parameters,
malformed JSON, unsupported payload types, rejected origins and preflight.
Local macOS comparisons pass in all three storage modes: 34 local-mode, 38
password-mode and 38 account-mode observations per implementation per backend.
Strict all-target Clippy and Rust formatting pass. Evidence is retained in
`github-catalog-http-{pglite,postgres,bundled}-v1.json`.

Supported-platform CI runs this suite on all three database modes; configuring
those jobs is not evidence that Windows/Linux have passed.

## Execution-target catalog stack usage (verification in progress)

Windows CI run `41065255700` overflowed the 1 MiB repository probe during the
execution-target suite. The catalog joined eleven inline database-read futures;
its future measured 62,088 bytes on local macOS. Boxing those component futures
reduces the same measured catalog future to 600 bytes while retaining concurrent
reads, mapper errors and result semantics. The unchanged local baseline passed
at 1 MiB, so that measurement is not a Windows reproduction or readiness claim.

The target repository harness now retains the last submitted operation for each
runtime, preserves the original failure when shutdown also fails, and saves the
report and disposable database root on failure. Previously a cleanup exception
prevented the Windows failure report from being written. The 1 MiB probe remains
unchanged; supported-platform verification is still required.

All 431 repository cases pass locally on each of native PGlite, private
PostgreSQL and external PostgreSQL at 1 MiB (`target-stack-repository-*-v1.json`).
Strict all-target Clippy and Rust formatting pass. An injected SIGKILL during a
real catalog request verifies that the original process error, last operation,
shutdown error, 31 prior cases and database root remain available in the saved
report (`target-stack-report-fault-v1.json` and
`target-stack-report-fault-verified.json`). That intentional failure verifies
report retention; it is not counted as a passing compatibility run.

## Ordered worktree observation comparison

Linux run `41068582355` exposed an unordered test boundary: inventory mutation
writes the canonical `path` routing handle and the scheduled observation reply
replaces it with the field-scoped `worktreePath` handle. The next HTTP command
could race that persisted replacement, producing different reconcile source
handles despite equivalent source-selection queries. The test now reads the
actual worktree catalog until the observation path is stored between mutations.
It retains the exact command/body/Live comparisons and asserts the observed
path; it does not substitute a delay or remove the differing field. External
PostgreSQL, private PostgreSQL and native PGlite pass all nine local
storage/authentication combinations with unchanged 116/120/127 recorded
observations per runtime. Reports: `observation-order-http-*-v1.json`. Platform
verification remains pending for this adjustment.

## Product acceptance observation boundaries

The acceptance driver now waits for the real Run child's exit witness and its
actual `ESRCH` result before asserting retirement. Linux platform traces show a
PTY shell-group PID distinct from the Node child PID. A bounded Linux reproduction
using the unchanged production process-tree controller confirmed five cases where
the shell exited before a child flushed its witness 150 ms later. This timing
reproduction does not replace whole-worker Linux acceptance. The existing child
identity, worktree-directory ordering, secret hash and durable-runtime assertions
remain intact.

The browser-discovery fixture now serves its HTTP listener in a separately
supervised process. In the macOS failure, both services hosted by the browser/Vite
driver disappeared from the fleet reply while independently served ports remained.
An actual worker-probe reproduction stalls the driver for 1.1 seconds: the inline
listener misses the unchanged 750 ms probe deadline, while the isolated listener
responds. Only candidate addresses are supplied in this bounded timing experiment;
the full product flow still uses the production OS listener inventory. Both client
APIs must still find the exact listener, title, worker and placement, and the
fixture retains the real request/response events.

Local Run product checks pass 25 steps per Node/Rust runtime on PGlite, private
PostgreSQL and external PostgreSQL. The full encrypted resource flow passes 35
steps per runtime on each store, including actual fleet discovery, terminals,
WorkerLink/direct routing, tunnels, protected shares, file documents and workspaces.
It retains exact tunnel-byte assertions. These host-wide OS discovery flows must run serially when
sharing a machine: one validation run's HTTP/TLS probes otherwise reach another
run's raw TCP peer. No traffic is filtered out to make that assertion pass.

Current-head supported-platform and packaged acceptance remain required. A separate
Windows conversion job in run `41141260086` timed out during native PGlite opening;
its logs and artifact are retained rather than counted as a pass. The serialized
standard `pnpm check` for this milestone finishes with 1,662 source-server tests
passing, 57 skipped and only the previously reproduced provider-routing assertion
at `local-foundation.test.ts:7218` failing. No assertions or deadlines were changed;
the broad check remains non-green.

## Actual Run product acceptance

The browser/worker probe now uses the existing app API to store an opaque Run
secret, discover capabilities/paths, create and update definitions, reject stale
writes, read/list/validate definitions, and launch a real child. The child writes
only a SHA-256 digest to prove it received the decrypted secret. Stale definition
deletion preserves the live process; current-revision deletion stops it, removes
the definition, and retires durable runtime state. A second child verifies
worktree retirement while preserving the Primary file.

This exposed a client grant gap: start/restart did not authorize `run-content`
before dispatch. They now install the existing endpoint encryption grant, as
output reads already do. Stop remains callable without obtaining a grant.
Focused app tests pass 37 assertions and app typecheck passes.

Local macOS runs pass 25 steps per Node/Rust runtime on all three stores
(`run-product-pglite-v5.json`, `run-product-postgres-v1.json`, and
`run-product-bundled-postgres-v3.json`). A prior PGlite run completed all Node product
assertions but timed out stopping the worker; the next full run passed. A private
PostgreSQL attempt timed out stopping the Node-connected worker before the Run
flows; both the diagnostic rerun and the next uninstrumented run passed. These
failed reports are retained; they are not passing evidence. Linux CI run
`41066792147` also failed the Node pane-lifetimes shutdown deadline after logging
fixture shutdown completion. Its job log and artifacts are retained for further
investigation; platform verification remains incomplete.
Linux/macOS CI now includes the POSIX child-retirement probe. Windows needs an
equivalent process-termination probe; none of this proves packaged acceptance.

## Run definition administration

Native project routes now cover list/get, capabilities, detection, path discovery,
validation, Flutter devices, writes and deletion. Worker files remain owned by the
worker; Primary resolution and response correlation match Node. Writes/deletes
share the existing project queue with runtime and worktree operations. Deletion
reads the actual definition and checks its revision before runtime retirement;
a still-active stop result prevents the worker delete command.

The controlled-worker HTTP suite exercises creation/update, stale writes/deletes,
missing/foreign ownership, malformed and misrouted replies, query parsing,
server-owned secret summaries, active-runtime retirement, ordered command/Live
streams and persisted audit rows. Exact protocol comparisons cover 106 definition
request/response vectors. Evidence: `.qa/rust-server/run-definitions-contract-tests-v2-exit.json`
and `run-definitions-http-{postgres,bundled-postgres}-v1.json` plus
`run-definitions-http-pglite-v3.json`. All nine local storage/authentication
combinations pass with 116/120/127 HTTP observations per runtime. This is not full-worker filesystem or packaged-platform
acceptance. Additional interruption/concurrent-definition tests remain pending.

## Run secret administration

Native GET/PUT project secret routes preserve validation-before-lookup, tenant
ownership, opaque envelope persistence, JavaScript-compatible digest receipts,
revision increments, replay of the original revision/timestamp, and 201/200/502
behavior. Successful writes and replays preserve both ordered invalidations
(route publication and response-completion publication) and the owned audit row.
All nine local database/authentication HTTP combinations pass, with audit rows
read back after server shutdown. Concurrent identical repository writes produce
one revision and one receipt on all three stores under the 1 MiB fixture stack.
Evidence: `run-admin-secret-http-*-final.json` and
`run-admin-repository-*-v5.json` in `.qa/rust-server/`.
Supported-platform/package verification remains incomplete. Native Run definition
administration is described above. The default server is still Node.

## Protected Git operations and worker observations (in progress)

Native Run lifecycle admission now includes owner-scoped receipt replay, Primary
definition reads, encrypted secret lookup across platform overrides, serialized
start/restart/stop dispatch, durable worker failure reconciliation and ordered
terminal/Run invalidations. The expanded HTTP/worker-decoder comparison passes
all nine database/authentication combinations with stored opaque secrets. Tests
exercise terminal reuse, generation changes, replay without dispatch, receipt
conflicts, inactive/active no-op outcomes, current-state receipt reads and missing
worker runtime persistence. Exact definition/secret-summary schema comparisons
pass 46 cases, alongside the existing worktree/runtime contract tests. Strict
all-target Clippy passes. Evidence: `.qa/rust-server/git-run-lifecycle-http-*-v4.json`,
`git-run-definition-contract-tests-v2-exit.json`, and `git-run-lifecycle-clippy-v3-exit.json`.
Full definition/secret administration, additional failure boundaries and real
process/platform acceptance are not established by this controlled-worker suite.

The real browser/full-worker probe exposed a reference retirement race: a worker
notification committed the stopped state before the stop reply, causing deletion
to reject an unchanged observation. PR #2331 merged the regression-backed fix as
`9aad78a702aa6aa4e99dee4ce93e203c861f51d7`; native retirement now follows the same
rule. Matching applied/unchanged observations are accepted only when the runtime
is inactive; stale generation/operation observations remain rejected.
The final differential matrix passes all nine storage/authentication combinations
with 74/76/80 HTTP observations per runtime. An unchanged `stopping` reply is
explicitly rejected before any worktree removal dispatch. Reports:
`.qa/rust-server/git-run-retirement-http-*-v2.json`; strict all-target Clippy:
`git-retirement-observation-clippy-v1-exit.json`.

Retirement across the 256-row page boundary now passes all nine storage/auth
combinations with 260 persisted runtimes and terminals per implementation.
The HTTP status response retains its 256-row cap; deletion leaves zero runtime
and terminal rows for the target worktree, without extra stop commands for idle
instances. Evidence: `.qa/rust-server/git-retirement-batch-*-v1.json`, also
preserved with logs and hashes under `~/.codex/qa-evidence/run-retirement-batch-260`.
This verifies batching, not concurrent admission or packaged platform behavior.

A held worker start reply now exposes committed admission through real HTTP
status reads while duplicate client requests overlap. The completed requests
produce one worker start, preserve the receipt ID and replay flag, and can then
stop the same generation. All nine storage/authentication combinations pass
(`.qa/rust-server/git-run-concurrent-*-v3.json`). Concurrent groups compare the
entire ordered Live stream once rather than attributing overlapping event slices
to individual responses. Seed timestamps are explicit to keep initial ordering
inputs identical. Earlier fixture failures remain preserved, including a replay
racing a stop: the receipt correctly carries the current runtime snapshot, which
can differ with request admission order. This is not yet deterministic coverage
of a queued stop/delete or HTTP disconnect during admission.

Admitted Run start also survives a real HTTP socket disconnect while its worker
reply is held. After the socket close event, retrying the original operation
returns the persisted receipt and running state with exactly one start dispatch;
a subsequent stop retains the generation. All nine storage/auth combinations
pass, including ordered Live events (80/82/86 HTTP observations per runtime).
Evidence: `.qa/rust-server/git-run-disconnect-pglite-v2.json` and
`git-run-disconnect-{postgres,bundled-postgres}-v1.json`; reports and logs are
preserved under `~/.codex/qa-evidence/run-disconnect-http`. The platform workflow
now runs the Git/worktree/Run contracts and HTTP suite on all three stores; those
new CI steps have not run yet. Queued deletion and additional worker/server
interruption boundaries remain outstanding.

Actual browser/full-worker acceptance now passes 17 steps per Node/Rust runtime
on PGlite, private PostgreSQL and external PostgreSQL locally on macOS. A real
long-lived child writes an exit marker proving its directory still exists when
termination arrives; after deletion, its PID is gone, the secondary checkout is
removed and its durable runtime is absent. The Primary user file remains intact.
Reports: `.qa/rust-server/git-actual-run-retirement-pglite-v5.json` and
`git-actual-run-retirement-{postgres,bundled-postgres}-v1.json`. Earlier failed
reports and the stopped-state database inspection remain retained.

PR #2331 validation passes 79 focused server tests, 92 worker tests plus the
source worktree test, 56 app tests, 961 protocol tests, app build and server
typecheck. The broad check failed in two unchanged CUA JavaScript execution-budget
tests (137 others passed); all 23 JavaScript tests passed separately. This does
not make the broad check green. Evidence is preserved with hashes under
`~/.codex/qa-evidence/run-retirement-observation-merged-9aad78a70`. Server CI run `41058467522` passed on macOS, Windows and Linux. Additional lifecycle failure boundaries, definition/secret
administration, packaged acceptance and full supported-platform evidence remain
required.

Run status and encrypted-output HTTP reads now execute natively. Differential
HTTP/worker-socket tests pass across all nine database/authentication combinations
(PGlite, private PostgreSQL and external PostgreSQL; anonymous, password and
accounts). Each runtime executes 61/63/67 HTTP observations respectively. The
added cases verify owned status, foreign-owner isolation, missing/offline output,
unchanged opaque envelopes, default output tail and rejection of all eleven
mismatched response identity fields. Strict all-target Clippy passes. These are
controlled-worker tests; full client acceptance extends beyond the real-process
retirement flow verified above. Evidence: `.qa/rust-server/git-run-reads-http-*-v2.json` and
`git-run-reads-clippy-v1-exit.json`.

The native project repository-operation route now uses per-project FIFO admission,
retains admitted work after client disconnect, and drains result finalization
before shutdown. It preserves protected request/response envelopes, model routing,
Git-agent usage recording and the two existing worktree invalidation points.
The worker remains unchanged.

Worker observation configuration includes owner-scoped source selection, active
operation context, debouncing and conditional path reconciliation. Real-socket
comparisons pass with PGlite, private PostgreSQL and external PostgreSQL across
anonymous, password and account modes. Those scenarios verify opaque routing
handle persistence, refreshed configuration, filesystem Live invalidation and
worker reconnects. Repository observation-context comparisons pass 165 cases
on each backend.

The account-mode comparison exposed a reference-server defect: connection-time
observation lacked an explicit owner. PR 2320 fixed that propagation and merged
as `f0b951146277b260e2af7f0f8a5a8d76f97bcf4d`; server-behavior CI passed on Linux,
macOS and Windows. The separate Rust replacement platform jobs remain pending.

Native CodeGraph status observations reserve revisions before asynchronous
ownership reads, suppress duplicate publication and retain at most 4,096 recent
bindings. State tests and HTTP comparisons across all three storage modes and
authentication modes pass, including missing-worktree and wrong-worker rejection.

Native inventory reconciliation preserves existing worktree identity, validates
the Primary path and repository fingerprint, and applies missing/prunable state
in a transaction. Repository comparisons pass 178 cases on each storage backend,
including an insertion conflict proving that earlier source and Primary updates
roll back. Worker inventory notifications now resolve owned routing paths,
publish worktree invalidation and refresh observation configuration. Real-socket
comparisons pass all nine storage/authentication combinations, including durable
Git field updates and rejected mismatched routing paths. Strict all-target Clippy
passes.

Creation rollback, lifecycle updates, observed state writes and removal-blocker
reads now have native repository implementations. The expanded 212-case target
repository suite passes on all three storage modes. It covers ready-context
admission, owner/path/origin checks, repeated rollback, missing/prunable precedence,
active and released execution lanes, run-configuration terminal exclusion and
foreign-key protection during rollback. The full worktree coordinator, HTTP
integration and managed Git recovery remain unfinished; this milestone is not
replacement acceptance.

The worktree coordinator now has a native implementation for serialized creation,
inventory reconciliation, pull-request checkout reuse and creation rollback.
Recovery
failure validation matches 42 actual protocol cases, including inconsistent
outcome/code/target combinations and UTF-16 string limits. Eight comparisons also
match the Node error constructor, including truncation inside an emoji.
The expanded 231-case repository/coordinator suite passes on all three database
modes. Controlled worker replies exercise successful creation, missing source,
ambiguous worker failure, malformed replies, conservative rollback, changed
catalog bindings, PR checkout reuse/rejection and new user-owned checkout creation.
These use real repositories with controlled command delegates; actual worker
filesystem mutations, HTTP lifecycle integration and recovery remain required.

Catalog, create, reconcile, lock, unlock and prune now have native HTTP handlers
connected to the shared coordinator. Capability checks precede request-schema
validation, and successful mutations preserve both coordinator and post-response
worktree invalidations. Socket comparisons pass all nine database/authentication
combinations, including exact Live-event ordering, command envelopes, durable
routing handles and operation timestamps. Strict Clippy passes.

Run configuration runtime reads, bounded lists, worker identities, inactive-row
deletion and fenced observations now have native repository implementations.
The target repository suite passes 337 cases on each of PGlite, external
PostgreSQL and bundled PostgreSQL. It covers all 64 state-transition pairs,
ownership and generation checks, persisted failure details, unchanged observation
replay, transaction rollback after a constraint violation, list ordering and
256-item bounds. Strict all-target Clippy passes.

Operation admission and terminal binding are now implemented. The expanded
421-case repository suite passes on all three database modes, including all
24 operation/state combinations, receipt replay and identity conflicts, generation
updates, terminal reuse and exactly-once pane attachment. A forced receipt-write
failure rolls back runtime creation, terminal creation, membership and layout
revision; retrying the same operation succeeds. Concurrent admission checks are
described below. Strict Clippy passes; these repository results alone do not
establish complete runtime or worktree DELETE parity.

Worktree DELETE and the runtime retirement loop now have native implementations
under focused HTTP comparison. Retirement stops active instances, validates the
worker result, reconciles the fenced observation, updates terminal status and
removes terminal/runtime records before dispatching worktree removal. The new
runtime-result contract matches 68 protocol cases, and strict Clippy passes.
Anonymous PGlite HTTP comparison passes 44 observations, including offline active
instances, missing/active/stale/future-generation stop replies, final retirement,
retained stop receipts and exact Live-event ordering. All nine storage/authentication
combinations pass this retirement suite. Actual worker process retirement
acceptance remains required; filesystem acceptance is described below. Missing worktrees remain observation targets in the reference
repository; deletion does not remove those catalog identities.

Native runtime notifications now use authenticated connection ownership and retain
admitted work through shutdown. Reconnect reconciliation compares durable identities,
marks missing processes lost and publishes run then terminal invalidations. The
focused anonymous PGlite socket suite passes with wrong-project/stale-generation
rejection, a failed runtime notification, missing-process reconnect and retirement
of active/failed/lost instances. Strict Clippy passes; the expanded nine-combination
notification/reconciliation matrix exposed missing account owner context in the
Node reference reconnect handler. PR #2327 fixes that handler; its two-owner
real-WebSocket regression fails before the fix and all 13 focused tests pass after
it. All nine database/authentication combinations now pass against that merged
reference (44 anonymous, 46 password and 48 account HTTP observations per
backend, including notification and reconnect Live events). Concurrent database
admission now verifies 12 duplicate starts produce one runtime, terminal, pane
membership and receipt; 12 distinct stops produce one accepted stop; and 12
identical exit observations apply once. These checks pass for both implementations
on all three storage modes, with strict Clippy passing. Additional reconciliation
failure cases and actual process acceptance remain open.

Actual browser/full-worker worktree acceptance now passes on all three database
modes for both implementations (`actual-folder-client.mjs --worktrees`). The
existing client encrypts metadata and the unchanged worker creates a real local
Git checkout, locks/unlocks it, retains its identity across server/worker restart,
reconciles, removes and prunes it while preserving the primary checkout. The
fixture seeds only the disposable local Git project's catalog classification to
exercise GitHub-backed capabilities without external GitHub access. Client
status convergence respects its existing one-second cache. Active runtime process
retirement, additional mutation failure/disconnect recovery and supported-platform
packaging remain unverified by this flow.

Dirty-removal acceptance exposed a reference-server lifecycle rollback bug:
recovery reused a ready-only execution lookup and left rejected removals stuck
at `removing`. PR #2330 fixes the Node setter with owner/project/active-source
checks inside the update; Rust now uses the same atomic authorization. The
421-case repository suite passes on all three stores, including recovery and
foreign-owner/removed-source rejection. The expanded 15-step real-browser/full-worker flow passes for both servers on
all three stores: dirty removal returns the protected error, retains the file,
restores `ready`, and permits deletion after cleanup. The reference fix passes 61 focused server, 93 worker and 56 app
tests, app build and server typecheck. Its full repository check finished with
1,633 server tests passing, 57 skipped and two failures: the pooled provider
account expectation in local-foundation and the missing getModelRuntimeByRoute
mock in terminal-managed-session. Both were independently reproduced on the
pre-fix baseline; the broad check is not green. The final log and hashes are
preserved in `~/.codex/qa-evidence/worktree-removal-recovery-merged-903542623`.

## Workspace read stack usage follow-up

Follow-up platform run `41037815947` has completed with failures in the later
actual-browser integration suite: macOS failed the Node fleet-discovery listener
assertion; Linux and Windows failed Rust browser-surface readiness with a
connection error. These failures require diagnosis and resolution before platform
acceptance. Raw failed-step logs and platform artifacts are retained in local QA
evidence; a passing workspace-specific check does not establish a passing matrix.
The Linux worker logs show `surface.attach` rejecting a browser URL outside
HTTP/HTTPS after opening its Chromium target. Open draft PR 2132 addresses the
overlapping initial blank-page navigation race and still reports unresolved
Windows validation. Its worker changes have not been adopted into this lane.

PR 2318's Windows run `41035166842` still aborts at the first owned workspace
seed on its 1 MiB test thread, after missing-project and foreign-owner checks
pass. The earlier fixture-dispatch extraction is not sufficient Windows
remediation. Artifact `12967972359` has SHA256
`682dfad190623bf073d574bce32c38b57c006014cab5fb38a9eb7da030de526f`.

The legacy layout reader now allocates each of its ten joined database futures
on the heap. It retains concurrent reads, their original executor and the
caller's transaction boundaries. In the observed ARM debug executable this
reduces the reader's polling frame from 171,808 to 33,744 bytes. That is a frame
measurement, not a claim about total process memory or Windows acceptance.
Both ARM and x86 macOS can run the original workspace suite at 1 MiB; platform
revalidation remains necessary to establish whether this fixes Windows.

After this change, workspace repository compatibility passes all three storage
modes at 1 MiB (66 cases and 11 snapshots per mode), as does legacy pane
repository compatibility. The x86 macOS workspace run, PGlite workspace HTTP
comparisons, PostgreSQL pane concurrency/read-boundary/shutdown checks, strict
all-target Clippy and Rust formatting also pass. The broad repository check
is still running; these focused results do not establish full replacement
or Windows readiness.

## Explorer, Code tabs and project views

All 18 project-surface routes now execute natively, preserving their distinct
validation, placement, ownership, encrypted state, capability errors and ordered
Live invalidations. The implementation reuses native pane placement and workspace
cleanup, retains Explorer pin idempotency, and fences Code checkout updates using
the prior worker and worktree binding. Explorer operations use the unchanged worker
command transport and preserve the separate 4 MiB request limit.

Local comparisons pass on PGlite, bundled PostgreSQL and external PostgreSQL:
133 repository operations and 68 durable snapshots per store, plus all nine
storage/authentication HTTP combinations (88/94/98 observations per runtime).
Populated main/detached workspace layouts cover all view definitions and legacy
Explorer `project.file` aliases. Another owner's layout remains unchanged.
An actual SQL trigger failure at the final resource DELETE rolls back workspace,
legacy-pane, layout-revision and remote-surface cleanup on every store.

Project-view deletion revokes two active WorkerLink grants before sending
`surface.close`; foreign deletion cannot revoke them, and deleted grants cannot
renew or be reissued. These cases pass inside the existing terminal/relay suite
on all three stores for local and account authentication. Repeated deletion does
not send another close command. Controlled workers use the unchanged decoder and
transport; this is not full remote-desktop UI acceptance.

Existing browser APIs and the full production worker pass Explorer reads/writes,
stale-save and stale-binding denial, Code/Explorer metadata, pin retries and
restart retention. A real local Git checkout is discovered through folder setup;
encrypted History/Graph creation, rename, deletion and restart retention pass on
all stores (14 steps per runtime). The source correctly rejects worktree switching
for these managed-folder projects even when Git is available. Actual GitHub-backed
Issues/PR/Actions flows and wider worktree lifecycle acceptance remain required.

The 16 schema roots pass 8,396 exact cases; the full wire regression passes
260,456 cases. PostgreSQL lock tests establish pin/CAS races and admitted work
surviving caller abort and graceful shutdown. The focused Source suite passes
37 tests, and the app build passes. Strict all-target Clippy and changed-file formatting pass. Route-template dispatch
also preserves validation for resource IDs that resemble action names. Current-head
supported-platform results and merged delivery are still pending. The native
all-target run passed before the subsequent fixture stack correction; that run
does not verify the final fixture source. Normal builds
continue to select the Node server; this milestone does not perform the cutover.

The preceding pane milestone's run `41026486096` has now reported Windows and
macOS failures. Windows exits during native workspace seeding with a confirmed
main-thread stack overflow. Its artifact `12963648256` has SHA256
`b66115ee2ab2a10d83a2f6be1f168041ed95c23a4d33817e3bc1572d7df837d9`.
macOS caught a lock-observation race: a blocker was visible while the separately
sampled wait type was null. The observer now waits for both actual signals before
releasing the transaction, retaining the bounded deadline and assertions; the
external PostgreSQL workspace repository suite passes locally after this fix.
A local 1 MiB-stack reproduction isolated excessive debug stack use in the
shared repository fixture dispatcher: its poll frame alone reserved about
660 KiB. Extracting unrelated operations into a separately boxed dispatcher
passes all 66 workspace cases and 11 snapshots on each of native PGlite,
private PostgreSQL and external PostgreSQL at 1 MiB,
with production repository code unchanged. The CI workspace repository matrix
now uses the same explicit stack size. Windows platform revalidation remains
required; a local pass does not establish that the Windows failure is fixed.

The current focused worker check reports 92 passes and one filesystem-notification
failure. An isolated repeat fails later in that same test. Clean Primary passes
the full focused group once, then times out on the isolated test; all 842 compared
worker/protocol/crypto/CLI source and test files are identical. These results
establish baseline instability, not its cause or a green worker check.
The broad current milestone check passes 1,623 Source server tests (57 skipped),
955 protocol tests and 3,899 app tests (three skipped), but fails four worker
tests: filesystem notifications, browser-profile adoption, abrupt-process outbox
replay and large-image encoding. An unchanged isolated rerun of the last three
files passes all 53 tests. The broad check remains failed.

## Legacy panes, surface launchers and normal workspace bootstrap

All 20 legacy pane, tab-group alias, surface-launcher and built-in worktree
routes now execute natively. They preserve opaque titles, ordering, center-tree
splits, dock preferences, member identity, revision conflicts, built-in resource
resolution and lazy Overview cleanup. Standalone reads retain independent query
connections; workspace seeding uses its caller-owned transaction. Mutations retain
admitted work through caller disconnect and graceful shutdown.

Local Node/Rust comparisons pass on native PGlite, private PostgreSQL and external
PostgreSQL: 107 repository operations and ten durable snapshots per store, plus
13,823 exact schema/error cases and 38 Source-generated SQL shapes. HTTP tests
cover all three authentication modes on every store, with 59/62/64 observations
per runtime. Pane mutations publish the ordered project and project-tab-layout
notifications; launcher and built-in worktree changes preserve their absence.
The reference fixture observes completion of the actual final response hook
before checking Live delivery: a response body or unrelated pong alone does not
prove completion of the earlier asynchronous audit hook.

Actual PostgreSQL locks establish three revision races, both standalone and
caller-transaction read boundaries, and cleanup committed before a later failed
claim. A caller-aborted insert remains admitted through observed server shutdown,
then commits and survives restart. Injected SQL failures verify rollback without
replacing the real repository operations.

The existing browser client now exercises normal workspace bootstrap rather than
supplying a custom seed: workspace GET 404, legacy panes GET 200, then seed POST 200. The unchanged full worker and encrypted dirty-editor handoff/restart flow
pass on all three stores, with 20 steps per runtime. These results do not establish
native desktop window hosting or complete React UI acceptance.

Workspace repository and HTTP regressions also pass on all three stores after
the shared-reader refactor. The full native all-target run passes 131 tests across
70 result groups, with no failures or ignored tests. Strict all-target Clippy,
Rust formatting, changed-file
formatting, the app build, 106 focused Source tests, 955 protocol tests and the
full app suite (3,899 passed, three skipped) pass locally. The broad repository
check is not green: a computer-use process test timed out, then passed unchanged
in isolation. A separate broad Source run encountered migration/test timeouts; all seven
affected files subsequently pass unchanged with one test worker (14 tests).
the worker run retains its filesystem-change notification failure. The same
focused worker failure reproduces on clean Primary, with identical relevant
source/test hashes and 91 other tests passing in each checkout. Those failures
are retained and must be investigated without weakening their assertions.

A second full `pnpm check` passes all 1,623 Source server tests (57 skipped),
3,899 app tests (three skipped), and the earlier computer-use process test. It
ends with four worker failures: filesystem notifications, batch replay after
process exit, browser keyboard input and browser-profile adoption (2,528 passed,
133 skipped). The focused outbox/browser rerun passes the three timeout cases but
fails a different initial-screenshot browser case (24 passed, one failed).
All 842 compared worker, protocol, crypto and CLI source/test files match Primary;
these observations do not establish the remaining browser failure's cause.
The separate root format check reports 12 unchanged files; all 12 also fail the
same formatter in clean Primary. Changed-file formatting passes. Broad repository
and platform acceptance remain incomplete.

The preceding workspace milestone's Windows CI artifact also records a browser
surface failure in the Node reference, before Rust's private-PostgreSQL run:
`surface.attach` rejects a protected URL as non-HTTP(S). Its PGlite flow completed
35 steps for each runtime. The artifact SHA256 is
`b2218c4c3b9d2d58f03a9784c8032c5a5ef0682fb5ec3d610e0a9f997cba3150`.
The macOS run fails Rust's external-PostgreSQL catalog sync-state assertion.
Neither partial result establishes full supported-platform acceptance.

The pane suites are configured in the Linux/macOS/Windows workflow. Current-head
platform results, broader regressions and merged delivery remain required. Normal
app and standalone launchers still use Node; this milestone does not switch the
default server or complete replacement.

```sh
node --import tsx scripts/server-rust/layout-query-manifest.mjs --check
node scripts/server-rust/cargo.mjs test --test pane_contracts -- --nocapture
node --import tsx scripts/server-rust/layout-repository-compatibility.mjs --database pglite --report .qa/rust-server/layout-repository-pglite.json
node --import tsx scripts/server-rust/pane-http-compatibility.mjs --database pglite --report .qa/rust-server/pane-http-pglite.json
node --import tsx scripts/server-rust/pane-http-lifetimes.mjs --report .qa/rust-server/pane-http-lifetimes.json
```

Repeat repository and HTTP comparisons with `--database bundled-postgres` and
`--database postgres`.

## Device workspace ownership and editor handoff

The four workspace-layout routes now execute natively: read, seed, commands and
legacy immutable-file import. All 24 command variants preserve attachment
generations, revisions, exact command receipts, canonical encrypted resource
labels, preview ownership, pane topology and detach/return handshakes. Receipt
replay checks the current renderer attachment first, returns the current layout
with the original applied revision, and does not repeat native window effects.
Legacy import receipts survive closed views and missing source documents.

Seeding reads the server's real legacy panes, resources, built-in state and dock
preferences. It preserves their invariant errors and lazily retires Overview
inside its nested transaction. A failing cleanup rolls back its revision and
members. Concurrent seeds converge on the first committed main-window identity.
Code/Explorer conversion locks the source editor and current document, worker,
source and checkout authority through layout/receipt commit. The existing
terminal/browser deletion helper now shares this command model instead of
maintaining another close-tab reducer.

The real legacy reads exposed native PGlite's unnamed-statement interference
between concurrent queries inside one transaction. A regression executes ten
distinct statements concurrently; it returns the last statement's identity for
the first query before the fix. PGlite transaction operations now serialize each
complete parse/describe/bind/execute exchange. The database contract passes with
PGlite process restart and real PostgreSQL. PostgreSQL pooling remains independent.

Local evidence includes 21,432 exact validation/error comparisons, 687 shared
model cases, 147 actual deletion-helper outcomes and 34 Source-generated query
statements. Real repository comparisons pass on all three stores, including
negative-zero receipt identity, eleven-document SQL bindings, legacy cleanup,
authority rejection, injected receipt rollback and retained restart state.
External PostgreSQL additionally observes six authority-change races and locks
on all six authority rows through receipt insertion. A Node/Rust/Node roundtrip
also retains workspace writes and receipts across runtime cutover and return.
Full-server data conversion and post-write rollback remain unfinished. Real concurrent HTTP tests
cover identical and competing commands, generation fencing, seed convergence,
and a caller-aborted receipt insertion that commits before shutdown completes.

The HTTP suite passes anonymous, password and account modes on all three stores,
with 45/48/50 observations per runtime. It checks exact bodies, headers, cookies,
CSRF, errors, scope, body limits and restart. Per-request Live barriers preserve
the current Source mapping: workspace-layout mutations publish no broad project
invalidations. The existing browser API/queue, renderer lifetime and unchanged
full worker also run on all three stores. An actual encrypted BroadcastChannel
transfers an unsaved editor model, undo history, selection and scroll state before
the server commits ownership. The endpoint draft and detached ownership survive
server restart; workspace HTTP contains no private path or document text.

The full native `--all-targets` run reports 130 passes across 69 result groups,
with no failures or ignored tests. Strict Clippy, the application build, 106
focused Source server tests and 138 focused application tests pass. The broad
`pnpm check` passes 1,623 server and 3,899 app tests, then fails the unchanged
worker filesystem-notification debounce test (2,531 worker tests pass). The
focused worker run also fails watcher checks; the clean Primary passes that file
alone. All 815 compared worker/test/protocol/CLI source files are byte-identical.
The cause remains unresolved; the broad repository check is not green.
The separate formatting check reports 12 unchanged files; all 12 also fail the
same formatting check in clean Primary. Changed files pass their scoped check.

```sh
node --import tsx scripts/server-rust/workspace-query-manifest.mjs --check
node scripts/server-rust/cargo.mjs test --test workspace_contracts --test workspace_models -- --nocapture
node --import tsx scripts/server-rust/workspace-repository-compatibility.mjs --database postgres --report .qa/rust-server/workspace-repository-external.json
node --import tsx scripts/server-rust/workspace-http-compatibility.mjs --database pglite --report .qa/rust-server/workspace-http-pglite.json
node --import tsx scripts/server-rust/workspace-http-lifetimes.mjs --report .qa/rust-server/workspace-http-lifetimes.json
pnpm --filter @cantrip/worker build
node --import tsx scripts/server-rust/actual-folder-client.mjs --database pglite --terminals --file-documents --workspaces --report .qa/rust-server/workspace-client-pglite.json
```

Repeat the repository, HTTP and browser commands with `--database pglite`,
`--database bundled-postgres` and `--database postgres`. CI includes these
comparisons on Linux, macOS and Windows; configured CI is not passing evidence.
Native desktop window hosting, full editor/UI recovery, shared coordination and
packaged acceptance remain required. These device-layout APIs do not complete
project-workspace CRUD or the remaining resource domains. The production Node
entrypoints remain in place; migration/rollback, packaging, Winterhold rehearsal,
performance and the remaining resource/execution domains remain in scope.

## Oversized document upload response observation

PR 2313's Windows run passes the complete PGlite document HTTP comparisons and
both anonymous private-PostgreSQL runtimes. Its account-mode Node reference then
fails with `ECONNRESET` while the test uploads a body above the 4 MiB route limit,
before recording a response or starting the corresponding Rust account run.
The uploaded seven-file ZIP and raw job log are retained; the ZIP's SHA256 is
`dc3fa4753565bc89f29c5f88e102515e740f38d9314ec67e4707cb4389ec3b63`.

The reset also reproduces locally against Node when the client advertises the
entire oversized length before uploading. The oversized-body fixture now sends
the same JSON payload with actual chunked framing, yields to socket responses,
and stops uploading when response headers arrive. Separate headers-only requests
advertise the oversized length without sending body bytes. A completed reply
still has its exact status, JSON, headers, request identity and cookies checked.
A reset without a response or a truncated body fails; there is no retry or
inferred 413. Other fixture operations keep their existing fetch transport.
Five real socket tests cover early replies and cookies, a complete chunked
upload, headers without body bytes, absent replies and incomplete replies.

PR 2314's Windows socket test then records four passes and an actual reset from
its immediate-close early-response peer. The early-reply test now responds after
receiving the first real chunk and explicitly keeps that connection open until
the client consumes the reply. It still requires the exact 413, JSON, both
cookies, chunked framing and a nonempty partial upload. The separate reset and
truncated-response cases still require failure. The client and production server
are unchanged by this test-peer correction; Windows results must be observed.

The actual headers-only comparison exposes a native parsing defect independently
of that reference-client reset: Node immediately returns 413 for JSON, text and
its registered binary parser, and 415 for unsupported or missing content types.
Rust waits for body bytes and fails the caller deadline. Rust now checks an
actually supplied oversized Content-Length before buffering, preserving that
parser-dependent error priority. The existing byte-bound read still limits
chunked uploads. The original failing reports are retained. Current-head Windows
and complete supported-platform acceptance remain required.

The repaired document comparisons pass locally on all three stores with 39
anonymous and 41 account observations and six worker commands per runtime,
retaining exact per-request Live and durable-state comparisons. The general
HTTP/WebSocket JSON comparisons also pass on all three stores. All five actual
socket tests, 19 native library tests, strict all-target Clippy and Rustfmt pass.
The earlier full-suite worker notification failure remains unresolved; this
focused parser repair does not establish a green repository check or packaging
readiness and adds no routes to the coverage count.

## Immutable file documents

The four document catalog, creation, lookup and protected operation routes now
execute in Rust. The repository uses the actual TypeScript statements and
parameter order. Creation locks the current project, source, checkout and worker
authority through insertion. Exact retries preserve the original binding and
timestamp; reusing an identity with different ciphertext, checkout, worker or
project returns the same conflict. Historical documents remain in their owner's
catalog when their checkout becomes unavailable. Operations rejoin current
ownership and availability before dispatching the opaque request to the worker.

The operation route retains its explicit 4 MiB body limit, worker failure
mapping and strict protected-response validation. File paths and contents stay
encrypted. Admitted operations and creation own their lifetimes through caller
disconnect and shutdown. Successful creation, including an exact retry, publishes
the reference's project-scoped document invalidation after HTTP response
completion. Failed requests and file operations do not mutate the catalog.

Local real-repository comparisons pass 42 operations and four state snapshots on
each storage mode, including immutable conflicts, tenant isolation, source and
worker changes, insertion rollback, process restart and removed checkouts.
External PostgreSQL additionally passes five actual lock races. Four hold the
authority query while its records become unavailable; the fifth blocks the
actual INSERT in a database trigger and proves source removal must wait for its
transaction to commit. The committed document then remains recoverable while its
operation context becomes unavailable. Query drift and 2,089 validation and
rendered-error cases match the real protocol.

A separate real-HTTP shutdown test blocks the actual document INSERT after its
authority selection, aborts the caller and starts server shutdown. Both servers
retain that same blocked query until the lock is released, commit the identical
opaque binding, finish shutdown and serve the retained document after restart.
No old snapshot or discarded write is used to make that test pass.

Actual Node/Rust HTTP comparisons pass 34 anonymous and 36 account observations
per runtime on all three stores. They compare complete worker commands, per-route
Live invalidations and retained rows, including real database failure, malformed
requests, both sides of the operation body limit, worker errors, invalid replies,
caller disconnect and worker disconnect. PostgreSQL publication can complete
after a Live ping, so the fixture waits for the actual expected committed event
before asserting its exact scope and count.

On all three stores, the unchanged browser API and full worker write 44,454 real
file bytes, reject stale saves, wrong locations and repeated operations, resolve
fresh-nonce retries through the existing client, and recover document access
after server and worker restart. The combined existing
terminal/browser/tunnel/share flow passes 32 steps per runtime with this document
flow included on all three stores. Run the combined storage flows sequentially
on one host to keep OS discovery away from another flow's strict TCP peer.

The full native regression passes 127 tests across 57 result groups, with no
failures or ignored tests. Strict all-target Clippy, Rustfmt, all 18 changed
formatter files, the 20 source file-document tests and the application production
build pass. The repository check passes 1,623 server and 3,899 app tests, then
fails the same worker filesystem-notification case: 2,531 worker tests pass and
one fails. Both the feature and clean Primary checkouts pass all ten tests in
that file when run separately. All 932 compared worker/shared/dependency files
are byte-identical. The broad check remains red; this intermittent failure is
unresolved. Current-head supported-platform and packaged acceptance remain
required. Complete workspace/editor behavior, shared
coordination, packaging, existing-data conversion, full post-write rollback and
the rest of the server replacement remain separate required work.

## Direct preparation acknowledgment and release comparison

The terminal HTTP fixture now holds the actual worker preparation acknowledgment
after its HTTP caller disconnects. Both servers acknowledge an early release
with 204 while telemetry returns 404 and no worker revoke is sent. After the
worker acknowledgment, the fixture attempts the real authenticated telemetry
operation until it observes the published, inactive capability's exact 409
response. The final release must then send exactly one worker revoke. Final
telemetry and its duplicate both return 204, matching the reference's deduplicated
accounting. The original complete command, HTTP, state and Live comparisons remain.

Receiving the worker request alone did not prove that the server had processed
its acknowledgment and published the grant. The earlier fixture could release
too soon and snapshot commands before the final revoke existed. This repair
changes the compatibility fixture; no production timing or grant behavior changes.
Publication attempts are retained separately because their count depends on
scheduling; every response must match either the exact unpublished 404 or final
inactive 409 contract.

The full terminal comparisons pass locally on all three storage modes. Each
Node/Rust runtime passes 191 anonymous and 202 account HTTP observations with
PGlite, 189 and 202 with private PostgreSQL, and 205 and 218 with external
PostgreSQL. All twelve runtime/profile combinations match the acknowledgment
boundary. CI runs these existing three comparisons after shared dependency
setup, before full browser integration, so a later browser failure cannot hide
this independent evidence. The full browser and worker checks remain enabled.
These local results do not establish supported-platform, packaged desktop or
complete replacement acceptance.

## Protected project and standalone-chat shares

The Rust server now implements the three project/standalone-chat share creation
and deletion routes and their protected WebDAV broker. Project and worktree
selection use the reference repository's exported SQL and bindings. Ownership,
worker placement, scratch capability, tunnel identity and protected revision
checks retain their ordering. Existing attachments stop before the protected
revision check, including a stale replacement request. Worker open and close
use the actual 30-second and best-effort 5-second deadlines. Failure responses
retain safe codes, stages and the actual dispatched worker request identity;
private worker errors, filesystem paths and credentials stay out of responses.

Actual Node/Rust HTTP comparisons pass 55 anonymous and 62 account observations
per runtime on each database mode, including real database-trigger rollback,
held concurrent operations, worker errors, exact Live scope/order and a real
caller disconnect. The generated share contracts match 1,490 validation and
rendered-error cases. A separate PostgreSQL test blocks the actual tunnel INSERT
after the worker's successful reply, aborts its caller, starts shutdown, witnesses
the same database waiter and verifies identical committed protected rows after
releasing the lock.

The existing client and full unchanged worker pass the share flow on all three
stores. HTTP Digest authenticates actual WebDAV PUT, GET and PROPFIND operations
with 40,026-byte file contents over encrypted WorkerLink and legacy carriers;
incorrect credentials fail. The worker's real filesystem contains the written
bytes. The server catalog and captured control requests contain no private root,
public share path or credentials. Startup deliberately removes transient share
records, matching the reference: the client creates a new share identity and
reads the retained file. An existing standalone-chat scratch fixture is
provisioned with the production scratch manager while its worker is stopped,
then opened and served by the full worker. This does not claim native chat
creation or scratch provisioning routes are complete.

The real-worker test reproduced a reference revocation defect: a share was absent
from the catalog after deletion, but its old WorkerLink grant still returned the
original 40,026 bytes with HTTP 200. Both implementations now revoke the scoped
WorkerLink authority before refresh/deletion and managed-resource removal.
Regression assertions require the old channel to close; the original failing
reproduction and source are retained.

An additional restart keeps the actual worker process alive while the server
restarts on its retained address. Both implementations retire the old share
channel, reconnect that same worker PID, create a fresh share identity and read
the retained 40,031-byte file. The test attempts the existing client operation
through reconnect, retrying only its explicit offline outcomes; other failures
propagate immediately. This flow passes on all three stores.

The final native regression passes 125 tests across 67 result groups, with no
failures or ignored tests. Strict all-target Clippy, query drift, source
typechecking and five broker tests pass. The exact CI product flow passes 28
steps per Node/Rust runtime on all three stores, including the original direct
terminal, browser and tunnel assertions. Run these product flows sequentially on
one host: another test worker's OS-wide discovery can probe the strict TCP peer.
The original exact-byte failure is retained; its assertions remain intact.

The repository check passes 1,623 server and 3,899 app tests, then fails the worker
filesystem-notification test. Both the feature checkout and clean main reproduce
the same `observed.txt` notification failure, each with nine passing tests in
that file. All 849 compared worker/shared source, test and dependency files are
byte-identical. This is a retained baseline failure; the repository check remains
red. Supported-platform and packaged acceptance remain separate work.
The whole-tree formatter also reports 12 unchanged tracked files; clean main
reports those same files, plus its ignored build outputs. The changed files pass
their focused formatting check. Neither baseline result is reported as green.
The latest merged CI run, 40969628794, failed on all three platforms: Ubuntu's
private-PostgreSQL terminal command comparison missed a final revoke observation;
macOS's Node reference fleet discovery missed the fixture listener; Windows's
Node product flow passed 25 steps before the Rust browser-surface flow failed.
Raw job logs are retained. The discovery fixture now retains both actual replies
before asserting their identity. No platform failure is waived.
The three uploaded ZIP archives were SHA256-verified before reading their actual
reports. Ubuntu's full-worker reports pass 25 steps per runtime on all three
stores, proving the per-executable sandbox policy through real browser operation.
Windows's worker diagnostic reports a rejected protected browser URL during
`surface.attach`; the existing draft PR 2132 concerns startup blank-page behavior
and remains separate from this server milestone.

## Browser service discovery in progress

Native project-fleet and existing-browser discovery now use the unchanged worker
command transport. Project ownership, folder affinity and ready local-Git replicas
filter the eligible workers before ICU locale sorting and the 64-worker bound.
Requests run concurrently with the source's 20-second deadline. Worker identities
are validated before authenticated identities replace their claims; fleet entries
retain explicit placement nulls. Per-worker parsing retains the 128-service bound,
and ordered fleet aggregation enforces the 1,024-service budget. Offline, timeout,
worker-error and partial/truncation behavior retain the source's exact contracts,
including UTF-16 name and error truncation and whitespace-only errors.

Actual Node/native HTTP comparisons pass 60 anonymous and 61 account observations
per runtime on each of PGlite, private PostgreSQL and external PostgreSQL. Each
compares 37 exact worker-selection observations, admits all ten controlled worker
requests before any completes, exercises the actual 20-second deadline and
disconnects an in-flight worker. Browser/surface rows remain byte-equivalent after
the read-only operations and restart. The combined browser protocol suite matches
9,113 validation and rendered-error cases from the actual schemas.

The existing client/full-worker flow passes 25 steps against each server on all
three stores. Both discovery APIs find a real HTTP listener through the full
worker's OS enumeration and HTTP probes, with two actual requests witnessed by
the listener. Discovery finishes before the later tunnel test opens its strict
TCP payload peer: the original ordering correctly detected the scanner's HTTP
and TLS probes as additional peer traffic. Exact tunnel payload assertions remain.
The final native regression passes 122 tests across 66 result groups, with no
failures or ignored tests. Strict Clippy, formatting, boundary and large-file
checks pass. The final diagnostic-flow reruns pass all 25 steps on all three stores.

PR 2308 is merged as `ba3a3f99320822e34c55023bb0c6d0ba258aa182`. Its Linux and
macOS jobs each pass all six browser repository/HTTP steps, then fail the Node
reference full-worker flow. The retained Linux Chromium stderr identifies an
actual namespace-sandbox abort. The next CI run installs Chromium's documented
per-executable AppArmor policy for that runner's downloaded binary; production
worker launch arguments and the Chromium sandbox remain unchanged. This policy
passes the real browser flows on all three stores in run 40969628794. That run's
later terminal comparison still fails. The older macOS failure is specifically
the legacy CTTN reply poll; its WorkerLink tunnel already passed. The legacy poll
now checks complete length before the original full-byte assertion, and the TCP
peer retains bounded connection/data/half-close/reply-write timestamps. This does
not establish the cause or resolution of the macOS failure. Both artifacts and
their SHA256 digests are retained; Windows and subsequent platform results remain
separate acceptance work. No platform failure is waived.

## Browser product management in progress

The current browser-management lane implements the five native list, create,
update, delete and managed-tunnel routes. Creation uses the existing execution
placement rules and one transaction for the opaque browser row, remote surface
and project pane. Browser and terminal resources now share the same native pane
placement and removal implementation, retaining their different profile defaults.
State updates retain the expected-revision predicate, committed state during
worker failures, explicit offline/error status and the source's Live event order.
Deletion removes workspace views and panes transactionally, revokes browser
WorkerLink grants, stops managed tunnel attachments and owns the asynchronous
worker close through shutdown. No private URL or title is decrypted by the server.

Actual Node/native repository comparisons pass 40 operations and 22 complete
state snapshots on each database mode. External PostgreSQL additionally passes
five write-lock scenarios: revision advancement, a worker change after the
context read, row deletion with and without a revision predicate, and concurrent
deletion that still commits source-style workspace/surface cleanup. These tests
observe the blocked query, blocking backend and ungranted locks before releasing
the competing transaction. Real trigger failures and integer overflow retain
their actual SQLSTATE and transaction rollback behavior.

The HTTP comparisons pass 37 anonymous-mode and 41 account-mode observations per
runtime on all three stores. They assert complete responses, exact Live event
order and scope, CSRF, tenant isolation, online/offline worker configuration,
revision conflicts, managed-tunnel attachment reset and deletion cleanup. Native
protocol validation and rendered errors match 7,641 cases from the actual schemas.
The shared-pane extraction also passes the existing terminal repository suite.

The full existing-client/full-worker flow passes 24 steps against each server on
all three stores. Browser setup uses the unchanged client API instead of seeding rows:
the client creates encrypted state, reopens/decrypts it after server restart,
receives authenticated JPEG and encrypted location messages, changes the saved
URL through the real worker, and deletes the browser with an installed grant.
That grant is revoked; retained requests contain none of the authenticated private
browser URLs. The final-source full native regression passes 122 tests with no failures
or ignored tests across 66 result groups. Strict all-target Clippy also passes.
This is not platform, package or full replacement acceptance.
Browser service discovery, remaining owning domain consumers and
the original migration/packaging/cutover requirements remain in scope.

A real external PostgreSQL trigger rejects one of 1,024 sibling attachment stops.
Node completes the other 1,023 and retains the earlier managed-tunnel write. The
initial native run is still progressing at its 15-second observation deadline;
that counter is not evidence of discarded work. Native recomputation repeatedly
decoded complete attachment rows as wire JSON. It now selects the source's four
required values directly, using SQL presence for the nullable last-seen field.
Both runtimes complete all siblings with the same 500 response and committed
state. Current local observations are about 3.6 seconds for Rust and 4.1 seconds
for Node; this establishes this workload only. Child work is admitted before the
aggregate is awaited and remains owned through shutdown. The failure, progress
timeline, source snapshots and passing comparisons are retained.

PR 2307 is merged as `17f3b20c5b0193991c13e23ab234f7ba252b45af` and clean
Primary contains it. Its five other workflows pass, but the Rust workflow
40951884864 fails on all three platforms: Linux fails the Node browser startup
flow; macOS fails the Node encrypted tunnel reply; Windows passes both PGlite
flows then fails the bundled PostgreSQL Rust tunnel reply. The two tunnel
artifacts retain data, half-close and close frames after an earlier empty-buffer
poll failed. A local empty-versus-40-KiB buffer assertion takes about 2.5 seconds
and generates 360,873 diagnostic characters; the reply poll now checks complete
length before retaining its original full-byte equality assertion. This does not
prove that assertion cost caused the CI failures. A test-only preload records
the actual unmodified Chromium launch and bounded startup stderr so the next
Linux run retains the underlying failure. No platform failure is waived.

## Managed tunnel persistence and reference identity in progress

Native managed-tunnel registration, lookup and removal now preserve the source's
ownership/placement checks, feature identity, protected revisions, counter and
creation-time retention, cascades and post-commit reads. Private display fields
and endpoint addresses are omitted from persisted routing metadata. Missing
protected content for a private endpoint retains its repository error; an
unprotected public-adapter insert still reaches the actual database constraint.
No SQL schema or external protocol changes are introduced.

The combined repository comparison passes 311 operations and 146 complete tunnel/attachment/lease state
snapshots on each of PGlite, private PostgreSQL and external PostgreSQL. Five new
external PostgreSQL scenarios observe the actual blocked writes before changing
the competing state: revision advancement, deletion, a management change,
management-sensitive removal and duplicate creation. Source/native responses and
committed state match, including the source's separate read/write boundaries and
real SQLSTATE failures. Random generated IDs are validated, aliased and sorted
only in unordered raw-state snapshots; public catalog order remains asserted.
Creation-time, position and identity retention are asserted separately in each
runtime so timestamp normalization cannot hide a changed relationship.

An additional case exposes a native reference-cardinality defect: two distinct
UTF-16 worker IDs could collapse to one replacement-character ID before SQL
binding. Source rejects that registration while the original native code creates
it. Native reference checks now retain original JS string identities through
deduplication and placement comparisons, then bind their lossy UTF-8 text.
Distinct and identical lone-surrogate cases pass on all three stores. The final-source full native run passes 120 tests across 65 result groups, with
zero failures or ignored tests. Strict final-source Clippy passes; the rebuilt
final-source client/full-worker flow passes all 22 steps on all three stores. Owning browser/project-share
routes and their runtime cleanup still need native integration; these repository
results do not advance accepted route or platform/package coverage.

Three complete worker runs with actual callback/lifecycle instrumentation retain
the existing filesystem notification failure. Real native FSWatcher/FSEvent
handles are created without reported watcher errors, but the affected stream
delivers no callbacks; one trace already sees the new file in Git status without
a matching filesystem notification. This narrows the failure boundary without
proving why native delivery is silent. No production watcher, timeout or test
parallelism changes were made. Clean-Primary baseline evidence and the earlier
startup controls remain retained.

## Browser publication and raw handshake compatibility in progress

The independently reproduced worker browser-state loss now has a bounded Node
integration fix. Refreshes retain pending broadcasts and attachment recipients,
serialize history/encryption work and take a new snapshot after an in-flight
refresh. A renderer error can yield to an already queued replacement. Four
deterministic regressions exercise the public adapter over an actual CDP
WebSocket with real worker encryption, including concurrent broadcasts,
concurrent attachments and renderer failure/recovery. The original publisher
fails both concurrency regressions. No worker rewrite or wire change is involved.
The focused browser/crypto/CDP/Grok set passes 29 tests. The complete
client/server/worker rerun passes all 22 steps on each of the three stores;
final acceptance is retained separately from the initial coalescing build.
This fixes the proven loss mechanism; the precise cause of the earlier
intermittent full-flow failure remains unproven.

A new raw TCP handshake comparison retains actual response bytes and headers
for valid upgrades, malformed keys/versions/protocols and automatic HEAD routes.
Its first run finds native differences: HEAD incorrectly upgrades, a request's
close token leaks into the successful response, and Hyper supplies a Date header
that the raw source handler omits. Native code preserves the source HEAD error
contract and uses explicit response extensions in the existing Hyper fork to
retain authored connection headers, disable HTTP reuse and suppress automatic
dates only for raw responses. Ordinary HTTP close/date behavior is a control.
All 24 cases pass in both auth profiles against both runtimes on all three stores;
all response headers are compared, with only validated dates/request IDs
normalized. Current native HTTP tests pass 13 cases; strict Clippy, Rust formatting
and the server-boundary audit pass. Configured CI is not platform acceptance.

The isolated whole-repository rerun passes the server's 1,622 tests and app's
3,899 tests but fails five worker tests. Full worker-only default runs in this
lane and clean Primary each fail the same filesystem-added-notification assertion,
with the other tests passing; a four-worker run still fails that assertion.
No parallelism or timeout configuration was changed. The Grok test now waits for
all its original final-status assertions within its original two-second timeout,
since credentials can be readable before profile enrichment/login cleanup finish.
The other broad-run timeouts remain unwaived. Whole-repository formatting also
reports 12 unchanged files; the identical formatting failures reproduce in clean
Primary and their source hashes match. Formatting of this milestone's changed
files passes; those baseline warnings remain recorded separately.

A controlled watcher-startup investigation disproves the competing-initialization
hypothesis: the existing sweep guard retains one initialization and status awaits
it. An uninstrumented held-startup run still misses the added notification;
a subsequent instrumented run records the actual added event and passes.
Neither establishes the exact broad-failure cause. No production watcher change
was made; retain both observations and trace the missing event next.

## Encrypted legacy TCP and shutdown ownership in progress

The combined browser/full-worker flow now includes a legacy CTTN socket step.
The existing browser attachment API creates credentials and opens the encrypted
tunnel configuration; production tunnel cryptography protects 40,000+ request
bytes. The full Node worker decrypts them, forwards to a real loopback
TCP listener and returns an authenticated encrypted reply. Actual payload hashes,
half-close and attachment revocation pass against Node and Rust on all three
stores, bringing this flow to 22 steps per runtime/store. The WebSocket source
endpoint is controlled test plumbing; production Tauri forwarding and packaged
desktop acceptance remain required.

Actual runtime fault comparisons cover the production initialization timeout and
permanent worker credential revocation in local/account modes on all three
stores. Revocation closes an open stream with its endpoint-disconnected broker
frame before the socket closes, and persists the matching offline incarnation.
External PostgreSQL also holds authorization beyond ten seconds: a first message
captured before the timeout still activates after release, while a message sent
after timeout cannot replace the rejected initialization promise. Tests observe
the actual blocked queries and ungranted locks.

Two further local/account PostgreSQL comparisons close the socket and server
while either authorization or activation is blocked. The process remains alive
with the admitted database operation, then exits cleanly after lock release.
Persisted attachment state and relay byte/operation totals match. The activation
case exposed a source shutdown race: Node ended its database before the late
activation's offline write. The authorization case exposed usage recording after
the meter had closed. Production source now owns complete socket initialization,
activation, retirement and expiry promises, and drains them before ending the
usage meter/database. Two focused source tests retain the late-write drain proof.
The native writer also now sends an empty close payload for local code 1005;
encoding that reserved code had produced an abnormal client close. Both original
failures and passing comparisons are retained.

The new full native regression passes 120 tests with none failed or ignored;
strict Clippy, source typechecking and 53 focused source tests pass. The preceding
attachment HTTP/socket/heartbeat/bandwidth matrix passes again on all three
stores. CI configures the new encrypted step and fault/shutdown suites; observed
supported-platform and packaged results remain required.

One extended PGlite run failed an existing browser reload assertion before the
legacy tunnel step. The worker logged a completed reload but the client retained
the prior title. The unchanged assertion subsequently passed with added control
state and actual navigation-request diagnostics. Its cause remains unresolved;
the failure is retained and must not be treated as unrelated baseline evidence.
Failed full-worker fixture directories are now retained for investigation.
An isolated reproduction now executes the actual worker publisher with controlled
CDP timing and real worker encryption: a concurrent broadcast refresh is dropped
while an earlier history read is pending, and an explicit later call publishes
the newer title. The temporary test module only resolves imports and exposes the
private class; it does not replace the publisher algorithm. This confirms a
worker publication defect independently of either server, while its causal link
to the full-flow failure remains unproven. The bounded fix and regressions are
recorded above; the original reproduction retains the unchanged source snapshot.

The whole-repository `pnpm check` passes the server's 1,622 tests, then fails four
worker tests (CodeGraph synchronization, filesystem debounce, linked-worktree
metadata and the Sharp image boundary). Focused runs of the three affected files
pass all 49 tests in both this lane and clean Primary; 919 worker/dependency source
files are byte-identical. These broad-run failures remain unexplained, rather
than established unrelated-baseline exclusions. Their original outputs and both
focused results are retained.

## Native attachment runtime and legacy sockets in progress

The unmerged WorkerLink milestone now installs the native tunnel runtime in the
server, lease sweeper and shutdown lifecycle. It owns physical subscriptions,
activation reservations, heartbeat/expiry timers and late database cleanup.
Reservations enter the per-attachment queue before task scheduling; replacement,
disconnect and expiry retain their separate incarnation fences and source order.
The broker's factory still uses its default activity policy and the production
relay quota callback.

All six attachment lifecycle/direct/socket routes now run natively. They preserve
credential rotation, existence-only lease checks, preparation fencing, direct
activation/finalization, attachment-specific WorkerLink revocation and Live
invalidation ordering. The legacy socket retains secret/header/subprotocol
authentication, public-route policy, owner capacity registration, first-message
capture and timeout before authorization completes, opaque frames and FIFO close
writes.

Actual Node/native HTTP and socket comparisons pass locally on all three stores.
Each runtime has 50 local-mode and 55 account-mode HTTP observations, with one
additional external PostgreSQL race setup observation, plus 17/15 socket cases.
The production 25-second/10-second heartbeat timers accept the matching 16-byte
token and retire a wrong token. Rotation revokes the matching WorkerLink grant
while a sibling grant still renews. Open streams receive their broker close frame
before the socket close. Persisted relay bytes and operation counts match exactly
after normal shutdown; actual opaque data and half-close frames are compared.

External PostgreSQL additionally proves three runtime races using observed
blocking PIDs and ungranted SQL locks: replacement queues behind activation with
strictly increasing generations; disconnect retains the late activation's fenced
offline write; expiry during a blocked activation UPDATE waits for that exact
generation before stopping it. The expiry fixture uses the production Date's
millisecond precision. An earlier SQL-now fixture accidentally retained
microseconds and did not match the source's exact expiry fence; its failure is
retained. The expanded protocol oracle matches 9,067 actual validation/error
cases. It exposed and corrected a native starts-with issue/message mismatch.

The full native regression passes 120 tests with no failures or ignored tests;
strict server Clippy also passes. The existing 21-step browser/full-worker
regression passes again against both servers on all three stores. That flow
exercises the preceding WorkerLink/direct transports and remains separate from
actual encrypted legacy TCP and Tauri/packaged acceptance.

These preceding tests use production worker transport with controlled opaque
responses. The encrypted TCP and fault section above extends their acceptance.
Full transport operational hooks, managed registration, remaining runtime
consumers, Redis, Tauri/packaged and supported-platform acceptance remain required.
The work does not advance the accepted route ledger.

## Legacy tunnel stream core in progress

The same unmerged WorkerLink milestone now includes a native CTTN codec and
stream broker. This protocol is separate from the WorkerLink carrier. The codec
retains validated headers and opaque payload bytes, including the source's
validation/error priority, UTF-8 replacement/BOM behavior, header limits and
maximum-depth JSON within a valid header. Actual source comparisons pass 160
byte/error cases. The expanded tunnel wire oracle matches 8,485 validation and
rendered error cases, including the preceding catalog schemas.

The broker preserves connection identity, sequence/direction checks, plaintext
flow credit for authenticated ciphertext, half-close, congestion, owner/worker
quotas, bandwidth windows, idle/lifetime expiry and statistics. Its reentrant
serialization permits source-style synchronous activity/send callbacks to revoke
the current route. Actual source execution matches 56 scenarios and 286 complete
transition/byte/callback/statistics snapshots, including nested termination and
stale close handles.

The native worker bridge now has a separate typed tunnel binary path, ordered
listeners and production WebSocket dispatch. Source comparisons cover buffer
thresholds and in-flight reservations, listener mutation/deduplication, protocol
isolation, stale peers, callback failure and replacement from inside a listener.
Binary admission, decode and callback delivery share the reentrant lifecycle
guard with connection replacement. Tunnel and WorkerLink decode failures now
use the source's shared bounded warning policy without recording frame contents.
An already locked dependency provides reentrant synchronization; actual offline
resolution adds no package versions.

The complete native regression passes 120 tests with none failed or ignored,
and strict server Clippy passes locally. These preceding core comparisons alone
do not establish legacy attachment/socket product acceptance. The native runtime
and production route integration are covered by the section above; full product,
failure and packaging acceptance remain required. The source production broker
factory configures relay quota consumption; its activity callback uses the
broker default. Production wiring must retain that activity policy and the
relay quota callback.

The existing 21-step real-browser/full-worker regression also passes again
against Node and Rust on native PGlite, private PostgreSQL and external
PostgreSQL after these bridge changes. This exercises the previously implemented
WorkerLink/direct paths and does not substitute for the remaining legacy socket
and actual Tauri/package acceptance.

## Tunnel catalog and management in progress

The same unmerged WorkerLink milestone now implements all six tunnel catalog
and user-management HTTP routes, with native list/get/create/update/delete
repositories. Ownership, owner-specific positions, project placement restrictions,
active attachment guards, protected revisions, opaque content and ordered
attachment summaries match the source. Project-scoped listing performs the
complete project listing before its existence check. Mutations retain the
source's separate writes and fresh post-write reads; they do not introduce a
new transaction or optimistic revision predicate.

Actual source/native repository comparisons pass 272 operations and 123 full
tunnel/attachment/direct-lease state snapshots per store. The matrix includes
the user/managed capability states, omitted/null fields, listener and destination
worker ownership, local Git source readiness, numeric rounding, expanded/invalid
dates, real integer overflow and write-trigger failures. Renamed unused columns
cause actual PostgreSQL errors. A missing attachment projection after update
proves that both implementations retain the committed protected revision despite
the later read failing. Database failures retain raw driver diagnostics and
compare the actual SQLSTATE and persisted state.

External PostgreSQL additionally passes five catalog races under observed real
row-lock waits: attachment insertion after the edit/delete guard, a competing
protected revision after the initial read, and management changes before the
final update/delete predicate. These supplement the four preceding attachment
transaction races. The resulting response, fresh attachments, cascade cleanup
and persisted state match the source.

Actual HTTP comparisons pass on all three stores with 77 local-mode and 83
account-mode observations per runtime. They compare response bodies/headers,
CSRF, tenant isolation, typed management conflicts, generic database errors,
restart persistence and exact response-completion Live invalidations. An invalid
owned project projection still fails before a missing project's 404. The native
wire interpreter now implements the installed protocol's strict-object
intersection behavior; 7,192 actual tunnel validation and rendered error cases
match. The HTTP and expanded repository suites are configured in CI; these local
macOS results do not establish supported-platform or packaged acceptance.

The complete native regression passes 117 tests with none failed or ignored;
strict server Clippy also passes. The existing 21-step real-browser/full-worker
flow passes again against both servers on all three databases after this change,
including encrypted terminal, remote-surface and tunnel traffic. Its direct
carrier still uses controlled forwarding; production Tauri IPC and packaged
desktop acceptance remain separate requirements.

Attachment management, managed tunnel registration/removal, direct activation,
legacy relay sockets, complete runtime consumers, Redis and desktop forwarding
remain required. This work is unmerged and does not advance the accepted route
ledger or establish a deployable replacement.

## Direct terminal data acceptance in progress

Server-issued terminal capabilities now have actual data-path acceptance through
the real worker broker. The desktop identity verifier is shared through
`direct_probe_connection.rs`; its implementation is byte-identical to the prior
verifier after removing the Tauri attribute. The desktop command remains a thin
facade with the same request and result. A development Rust executable imports
that production component using the desktop's WebSocket dependency version. A
controlled TCP forwarder uses the existing tunnel codec, route/sequence checks
and credit messages to carry the browser's inner terminal WebSocket.

The existing client crypto protects input, a real PTY executes the private
command, and the browser authenticates ordered encrypted output. Wrong terminal
operations are rejected before execution. Actual broker checks reject secret
reuse, completed revocation and mismatched identity; completed server revocation
also interrupts an active native broker connection. Broker/tunnel bytes are
checked for absence of the private command, token and path. These checks pass
against both servers on native PGlite, private PostgreSQL and external PostgreSQL,
bringing the combined real-browser/full-worker flow to 21 steps per runtime/store.

The actual Tauri library and desktop probe compile after extraction; strict
server Clippy passes including the shared verifier example. An additional strict
desktop Clippy run reports four existing warnings in `tunnel_forward.rs`.
The same four failures reproduce on clean Primary, and that file is
byte-identical in both checkouts. The extraction's successful desktop compilation
and actual native broker traffic are separate evidence from that baseline lint
failure. No assertions or lint rules were relaxed.

The Rust-server CI matrix now configures this direct-terminal flow on all three
databases and watches changes to the shared desktop verifier. These are local
macOS execution results and configured CI, with supported-platform observation
still required. The forwarder is controlled test plumbing; actual Tauri IPC,
the production native TCP forwarder, packaged artifacts, fallback across network
topologies and complete replacement acceptance remain required. This work remains
part of the same unmerged WorkerLink milestone.

## Legacy terminal WebSocket relay in progress

The unmerged WorkerLink milestone now implements `/api/terminals/:id/connect`.
It preserves upgrade-time origin rejection, account/session registration, UTF-16
operation limits, owner/read-only/offline checks, managed consoles, encrypted
input/output frames, terminal status changes and close codes. Input commands wait
for the preceding acknowledgment and recover after a rejected command; resize
commands remain independent. Early frames are metered but ignored until the
execution context is available. Socket close and late readiness retain their
separate detach behavior. Child operations enter lifecycle accounting before
they are spawned, so disconnect cleanup and its writes drain during shutdown.

Local/account comparisons pass on all three storage modes. They
compare actual socket frames, complete worker commands and persisted bandwidth
bytes/operation counts, including malformed and binary messages, encrypted output,
held input acknowledgments, independent resize, startup/exit failures, readiness
after disconnect, managed consoles and session revocation. Matching attachment
detach acknowledgments separate scenarios. The legacy logout close reason is
`Session was revoked`, matching the source. A creation response's exact two
project invalidations are observed before opening its direct stream; a Live ping
alone could overtake the asynchronous response hook. External PostgreSQL's
expanded matrix additionally exercises a genuinely blocked context read and a
pong barrier before releasing its table lock. The observation uses the actual
ungranted relation lock and blocking PID; PostgreSQL's activity view truncates
the source query before its joins, so SQL text alone cannot identify that wait.

The real-browser/full-worker flow passes 19 steps per runtime on all three
storage modes. Its new legacy socket step encrypts input with the existing client
module, executes a private command in a real PTY, authenticates ordered encrypted
output, closes the socket and deletes the terminal. This includes the preceding
18-step WorkerLink/browser/tunnel flow. The native terminal wire oracle matches
10,857 actual validation/error cases, and strict Clippy passes. The preceding
full native regression for this relay change passed 116 tests with none ignored.

Current work remains unmerged. Real direct-terminal broker/data transport,
remaining resource consumers, shared authority and supported-platform/package
acceptance are still required, along with the rest of the replacement goal.

## Legacy terminal direct bootstrap in progress

The unmerged WorkerLink milestone now implements `POST /api/terminals/:id/direct`
using the native direct-attachment coordinator. It preserves request validation,
preparation leases, owner/worker checks, managed-console startup, opaque state,
terminal readiness, bootstrap detach, status publication and twelve-hour leases.
The returned route and installed capability share the same attachment and exact
endpoint bindings, including UTF-16 client identifiers. Readiness wins over a
subsequent streaming-command result, matching the source route. Revocation during
preparation compensates the capability, closes the started terminal and releases
the lease before resource deletion proceeds. Admitted work survives caller abort.

Actual local/account HTTP comparisons pass on native PGlite, private PostgreSQL
and external PostgreSQL. They compare complete commands, opaque payloads, schema
errors and ordered committed/response Live invalidations. A second preparation
is held at the real worker acknowledgment; deletion's existing-capability
revocation proves its mutation fence is held before that acknowledgment is
released. Both rejected preparation and deletion complete with the reference
cleanup. The timeout scenario waits the real fifteen seconds. The fixture sends
an authenticated heartbeat so the controlled worker retains normal presence.
Native direct validation matches 1,584 actual protocol/error cases, including the
new request and ticket schemas. Strict Clippy passes locally.

The existing real-browser/full-worker flow also passes again on all three
storage modes after these changes, with 18 steps per runtime/store covering
encrypted PTYs, Chromium surfaces and tunnel traffic. This regression flow uses
WorkerLink; it does not establish real direct-terminal data transport.

This is controlled-worker HTTP acceptance. Real direct-terminal broker/data
traffic, legacy relay sockets, supported-platform/package acceptance and merged
delivery remain required; the route ledger is unchanged.

## Terminal deletion and workspace ownership cleanup in progress

The unmerged WorkerLink milestone now includes native terminal deletion under
the direct resource mutation fence. WorkerLink resource grants are revoked first,
including pending installations. The transaction locks the owning project and
its ordered workspace rows, removes every matching view, preserves detached
windows and conversion/transfer metadata, clears runtime bindings and detaches
the legacy pane placement before deleting the terminal. Focus/history, pane
anchors and labels, compact member positions and center-tree collapse match the
source. Active Run configuration instances still prevent deletion. A rejected
worker close does not undo the committed deletion, and admitted deletion survives
caller disconnect while waiting for a revocation acknowledgment.

Actual three-store repository comparisons pass 87 cases and 91 complete state
snapshots per store. They include multiple device/window views, untouched foreign
layouts, running interactive terminals, all four active Run states, revision
overflow, invalid ownership, project scope mismatch, missing topology and exact
transaction rollback. The source's pending-transfer behavior is retained. Native
ownership/tab/recursive-center validation matched 7,131 actual protocol cases and
their error messages. The device-workspace milestone above extends this to the
complete command model and shares that reducer with deletion.

The actual TypeScript cleanup helpers now generate 18 embedded SQL shapes and
their projected column positions. Native reads execute those exact selections;
failed writes retain the exact source SQL and parameters. Eleven real trigger
failures and four missing-column failures compare diagnostics and complete
transaction rollback. SQL write timestamps are checked against the actual run
before normalization, while raw diagnostics remain in the reports. A JSONB
`null` legacy root follows the source missing-root error, and an emptied center
tree is stored as SQL `NULL`, matching the source's physical representation.

Four external PostgreSQL races observe the deletion genuinely blocked before
releasing its writer. They verify that workspace cleanup reads the updated,
locked layout; deletion returns its pre-lock execution context; the Run guard
retains the source's pre-lock admission snapshot; and a concurrent deletion still
cleans up ownership. Complete response and persisted-state outcomes match.

Expanded local/account HTTP comparisons pass on all three stores. An actual
PostgreSQL foreign-key rejection proves deletion cleanup rolls back and preserves
the exact source DELETE diagnostic. The multi-grant test exposed Tokio task
spawning reordering commands from an ordered revocation batch. The command bus
now reserves FIFO dispatch order in the caller and performs transport work in an
owned task, releasing the reservation before awaiting acknowledgment. Independent
owner lookups remain independent. Inline transport would reenter the bridge from
an offline callback while its lifecycle lock is held; a retained thread sample
proves that hang, and the corrected queue passes the actual offline/replacement,
admission, budgets and bridge tests.

The full-worker comparisons also reproduced Node shutdown hanging beyond 105
seconds with one zero-byte TCP connection and no active HTTP work. The application
now tracks actual admitted HTTP requests and closes idle/unadmitted connections
at preClose; active requests drain and upgraded transports retain their existing
owners. Four real-socket tests cover speculative connections, partial headers,
an admitted held response and upgrade ownership. The original timeout reports
and partial-header reproduction are retained. Successful reruns do not by
themselves establish complete shutdown/platform acceptance.

Terminal direct/legacy streams and other resource lifecycle consumers remain
required, along with the rest of the replacement goal. This local work remains
unmerged and does not advance the accepted route ledger or establish platform,
packaging or migration readiness.

## Terminal worktree lifecycle in progress

The unmerged WorkerLink milestone now implements terminal worktree movement.
It preserves request parsing, owner/project capability checks and their order,
read-only/linked/running restrictions, ready and nonremoved target selection,
worker placement, opaque state and response-completion Live invalidations.
The direct-attachment resource mutation fence owns the full operation, while
WorkerLink grants are revoked before resource checks, including a rejected move.
The production service boundary now exposes resource-scoped grant revocation.

Actual repository comparisons pass 50 cases and 30 complete terminal/layout
snapshots on each of native PGlite, private PostgreSQL and external PostgreSQL.
The expanded HTTP matrices pass local and account profiles on all three stores.
They verify invalid requests retaining authority, foreign-owner isolation,
rejection after revocation, an installation losing authority before its worker
acknowledgment and exact ordered Live changes. External PostgreSQL additionally
holds the worker revocation acknowledgment, aborts the HTTP caller and observes
the subsequent placement write. An actual CHECK rejection preserves the source
SQL error response and original placement. Diagnostics are captured from the
actual source repository; only the validated wall-clock write timestamp is
normalized for comparison.

Further deletion failure/locking acceptance, terminal direct/legacy attachment
routes and the remaining resource lifecycle consumers are still required.
This progress remains unmerged and does not advance the
accepted route ledger or establish packaged/platform readiness.

## Tunnel grants and durable attachment leases in progress

The unmerged WorkerLink milestone now includes native tunnel grant issuance,
opaque attachment authorization, credential rotation, activation markers,
generation-fenced disconnect/stop, bounded direct leases, finalization, expiry
and single-instance startup recovery. Owning-tunnel row locks serialize writers.
Preparation leases survive admitted HTTP work and are released on every return;
late placement/client/deletion changes revoke the installed grant, and a changed
credential generation cannot activate it. A real activation-write failure rolls
back the database transaction and compensates the worker grant. Successful grants
publish the reference project/current-user tunnel invalidation.

Actual-source repository comparisons pass 80 cases and 17 full snapshots on each
database mode. External PostgreSQL also observes four genuinely blocked writers,
changes a credential or activation generation before releasing the lock, and
compares complete outcomes. The comparison deliberately retains the reference's
pre-lock renewal snapshot and exact millisecond Date stop fence, including the
case where legacy microsecond expiry values cannot match it.

The comparisons exposed a production Node PostgreSQL bug: four raw SQL lease
expressions supplied Date objects to an adapter that disables the date serializer.
The real-clock reference rotation failed before the fixture's deterministic clock
was installed. Those expressions now bind ISO strings, preserving the timestamp
calculation on PGlite and enabling the same rotation/lease behavior on PostgreSQL.
The reproduction is retained; the actual repository matrices exercise the fix.

The native minute sweep owns and drains admitted database writes, and direct
coordinator renewal/finalization callbacks now persist tunnel leases. The actual
60-second timer comparison on external PostgreSQL observes both lease expiry and
hard attachment expiry, their ordered Live changes, and the committed rows.
HTTP comparisons cover local/accounts, exact grants and command order, caller
disconnects, post-install mutations and real SQL activation failure on all stores.

The existing browser `openTunnelWorkerLink` and unchanged full worker carry an
authenticated encrypted 40 KB request to a real loopback TCP target, preserve
half-close and return an authenticated encrypted reply on all three stores. The
source endpoint uses the production tunnel AES implementation; this is not the
Tauri native forwarder or desktop IPC. The fixture seeds an existing encrypted
tunnel and attachment after the production client authorizes the worker's
`tunnel-content` key. The combined browser/terminal/surface/tunnel flow completes
18 steps per server/store locally.

Tunnel catalog/CRUD, attachment management/direct/legacy sockets, the complete
runtime/brokers, resource mutation revocation consumers and desktop forwarding
remain required. Redis/shared recovery, supported-platform/package acceptance
and coherent merged delivery also remain unfinished. No route-ledger acceptance
or production cutover is claimed by this progress.

## Remote-surface grants and operational logging in progress

The same unmerged WorkerLink milestone now includes native Browser and Remote
Desktop grants. Requests preserve validation/authorization order, opaque state,
desktop stream preferences, attachment acknowledgment, two-lane grant installation,
post-install state/placement checks, compensating revocation and finally cleanup.
Status writes publish the reference's three ordered current-user invalidations;
successful HTTP responses publish the additional resource/layout invalidations.
Terminal grants now also publish their reference response-completion invalidations.
An actual database failure in the catch's status write still runs attachment
cleanup. Disconnecting the HTTP caller does not abandon admitted work.

Canonical remote contexts now require both the project and worker owner, matching
the source join even for inconsistent cross-owner database rows. Browser backfill
uses the source's project/default-worker and ready-worktree selection, preserves
existing surfaces and skips missing sources. The native single-instance startup
runs that local-owner backfill and resets transient surface statuses while
preserving errors and last-connected timestamps. Shared startup recovery still
requires the future coordinator's observed instance count.

Local macOS comparisons pass 52 repository cases and 19 full state snapshots on
each of native PGlite, private PostgreSQL and external PostgreSQL. The expanded
terminal/surface HTTP matrices pass both local and account profiles on all three
stores, including complete command order and committed status/response Live
events. External PostgreSQL additionally exercises state changes and deletion
during grant installation, primitive stored-label failure and an actual rejected
error-status write. The real browser test now uses the existing
`RemoteSurfaceWorkerLinkClient`, production encryption and a full unchanged worker
rendering Chromium: authenticated private state/JPEG output, encrypted reload and
grant release pass on all three database modes (17 combined product steps per
runtime/store). It seeds an existing
encrypted browser row; browser CRUD and Remote Desktop capture acceptance remain
separate required work. A retained Chromium CDP attachment failure is recovered
by the production client's normal retry; this is not proof that the underlying
worker startup race is fixed.

Shared log emission now implements source-compatible text/context redaction,
UTF-16 truncation and keys, sampled events, bounded repeated-event suppression and
window summaries. Actual TypeScript comparisons cover 65,937 sanitizer/error
vectors and 2,136 policy actions across eight scenarios. Direct-attachment
comparisons pass 334 cases/15 scenarios with the production log policy; routing
and worker-link revocation diagnostics also match the source calls. Runtime log
buffer/archive APIs, formatting and complete production metrics remain unfinished.
All of this work remains unmerged and does not advance the accepted route ledger.
The preceding local full native regression passed 116 tests with none ignored;
strict server Clippy also passes. These are macOS results, not platform or
packaged-artifact acceptance.

## Managed consoles and terminal WorkerLink grants in progress

The unmerged WorkerLink milestone now includes native terminal grant issuance.
It validates the request before authority/resource lookup, preserves read-only
and placement failures, waits for the actual terminal readiness event, detaches
the bootstrap attachment, installs the grant and rechecks placement. Startup,
worker-result, detach and installation failures preserve the reference cleanup
and terminal status behavior. Caller disconnect does not cancel admitted work.
Real PostgreSQL mutation during grant installation proves that moved/deleted
resources receive a compensating grant revocation and a conflict response.

Linked consoles use native model/account eligibility, usage reserves, credit
balances, cooldowns, catalog hydration/reload, reasoning and exact root/subagent
pairing. Effective permissions, managed session context and opaque MCP selection
feed the real `chat.thread.ensure` command. Existing threads avoid binding writes;
new threads select the model and update the canonical runtime in the reference's
two separate transactions before `terminal.open` is sent. A failed second
transaction retains the committed model selection. Thread identifiers retain
UTF-16 on the wire and use Node-compatible UTF-8 replacement at database storage.

The same complete project/standalone chat execution-context projection now serves
Live authorization and execution targets. Actual-source comparisons pass 583
repository/service/helper cases and 31 state snapshots per store on native
PGlite, private PostgreSQL and external PostgreSQL. Three additional real
PostgreSQL lock scenarios observe the blocked backend and introduce a handoff or
route replacement before releasing the lock; both implementations reject the
writer without committing its model update. Chat summaries match 8,013 actual
protocol/error cases, and the expanded WorkerLink/result roots match 9,289 cases.
These dependencies do not constitute a completed chat/execution domain.

The controlled-worker terminal HTTP/Live matrix passes in local and account modes
on all three stores, including exact terminal command order and persisted console
bindings. It exercises invalid/open-before-ready and ready-before-result outcomes,
the actual 15-second startup timer, detach retry cleanup, rejected installation
and caller abort. External PostgreSQL additionally covers actual placement changes
and deletion during installation. The existing browser terminal transport and
encryption modules also run against each server and the full unchanged worker:
encrypted input executes in a real PTY, produces filesystem proof and returns
authenticated encrypted output over relay. This completes 16 combined product
steps per runtime on each store. Linked Codex startup still has controlled worker
results; a full real Codex-console product run remains required.

The first two new terminal abort runs finished their Node scenarios but timed out
during Node shutdown with one remaining socket. The abort fixture now owns a
single-use HTTP caller socket; complete Node/Rust runs pass on all three stores
without changing server shutdown behavior. A separate new combined native-probe
browser run still timed out during Node shutdown before Rust. These retained
failures do not establish that the earlier intermittent shutdown issue is fixed.

## WorkerLink authority, native HTTP and binary relay in progress

Native WorkerLink authority now models session identities, acknowledged session
and grant installation, lease renewal/expiry, scoped revocation fences, peer
rounds and ordered signaling mailboxes. Identity keys retain UTF-16 code units.
Capabilities return only after the worker acknowledgment; worker installations
receive SHA-256 token hashes. The controlled-worker comparison executes the
actual TypeScript coordinator and the native coordinator: 567 cases pass locally,
including installation/revocation and renewal/shutdown races, capacity limits,
failed acknowledgments, mailbox cursors and signaling byte/count bounds.

Native binary frame and remote-surface chunk codecs preserve validated bytes,
header/payload bounds, UTF-8 replacement, chunk ordering and incomplete-frame
replacement policy. All 127 actual-protocol binary/assembly/byte-bound cases and
9,289 validation/error-message comparisons pass locally.

The worker bridge now sends and receives these frames over its native binary
socket, preserves ordered subscriptions and permanent-offline callbacks, and
accounts for queued/in-flight WebSocket frame bytes through actual writer
completion or cancellation. The native relay implements per-direction channel
sequences, replay rejection, closing-channel tombstones, remote-surface permits,
payload quotas, feature traffic recording, bounded lane queues, fair draining and
stall retirement. It matches 148 actual-reference snapshots in 33 scenarios.

The server runtime binds authority to its actual command bus, configuration,
shared relay quotas and usage meter. Native HTTP handlers cover session
opening/renewal, peer creation/signals/mailboxes/release and grant renewal/release;
the authenticated binary relay socket checks Origin, client/session ownership,
duplicate query values and stale generations before HTTP upgrade, and checks
authority again afterward. Logout owns the database revocation and capability
cleanup across caller cancellation, preserving Live/capability/socket ordering.
Shutdown closes the relay and coordinator before the worker bridge and drains
owned callbacks before database closure.

Actual Node/Rust HTTP/socket comparisons pass locally on all three storage
modes with the unchanged production WorkerConnection and controlled command
acknowledgments. They include byte-exact bidirectional frames, persisted ingress
and egress feature bytes, early peer signals, replay/error close codes and aborted
HTTP installation/logout. Raw command traces are retained; only independent
account-session revocation batches are compared without ordering, matching the
reference's explicit Promise.all and asynchronous owner lookups. A full native
regression run passes 114 tests with none ignored, including authentication,
sessions, worker bridge, WorkerLink and the existing resource domains. Strict
all-target server Clippy passes. The final thread storage conversion was added
while that full run was in flight and is covered by the fresh three-store
managed-console comparisons above and the final all-target Clippy run.

Native direct-attachment authority now implements preparation leases, resource
generation/kind fences, queued resource mutation, scoped revocation, per-capability
renewal serialization, exact expiry/renewal decisions, activation, monotonic
telemetry and bounded retired-tunnel accounting. It preserves transient transport
failure versus fail-closed renewal behavior and drains lifecycle persistence.
Actual-reference comparisons pass 270 cases across 14 scenarios, including late
acknowledgments, caller-owned mutation failures, UTF-16 identity fences and delayed
renewal during revocation. Another 841 protocol/error cases and 139 operational
transport metric snapshots match the actual TypeScript implementation. Real native
timer tests verify that expiry revocation survives through acknowledgment and
shutdown waits for pending persistence; background expiry RPCs have a separate
runtime drain before database closure.

The production native runtime now composes this authority with its actual worker
command bus and permanent-offline subscriptions. Logout revokes direct authority
before WorkerLink authority; shutdown closes both before the bridge. Session
route changes, release, direct preparation/activation and telemetry now use their
native consumers. Generic direct probe, release and telemetry/renewal routes also
execute in Rust, including the reference telemetry validator's thrown-error path.
The operational transport collector retains direct/WorkerLink counters and exports
the corresponding Prometheus series; the full operational endpoint remains a
separate unported consumer.

The expanded actual HTTP/socket matrix passes locally on native PGlite, private
PostgreSQL and external PostgreSQL: 83 local-mode and 99 account-mode HTTP
observations per runtime/store, plus 15 and 19 socket observations. It verifies
direct ticket binding, activation/telemetry, route replacement, scoped release,
worker failures and cleanup after aborted direct preparation. Observation grants
now preserve body validation, owner/account-session isolation, actual worker
installation, token hashing, renewal and release. A held installation surviving
caller disconnect cannot resurrect a released session: both servers send the
session revoke and a compensating grant revoke after the late acknowledgment.
These HTTP tests use the production worker transport with controlled command
outcomes; separate product flows below use the full unchanged worker.

The existing browser WorkerObservationClient and WorkerLinkManager now exercise
real observation grants and events channels through both servers and the full
worker. Real PTY process exit generates the observation; the client validates its
continuity and process generation, receives binary data and returns credit, then
releases the grant and session. All three storage modes pass the complete flow.
The native desktop probe is also executed from its production Rust source against
the full worker's actual broker. It verifies the server-advertised signed identity
and rejects secret reuse, completed server revocation and a mismatched broker
identity. The combined folder/PTY/observation/native-probe flow passes 17 product
steps per runtime on each store locally. This proves the native probe component,
not packaged desktop supervision, WebView IPC or the LOCAL WorkerLink data carrier.

Two actual LAN/WebRTC attempts failed in the Node reference before Rust was
reached. One timed out a worker signaling request after five seconds; another
acknowledged the offer, mDNS candidate and completion but remained on relay.
The test requires LAN and rejects relay fallback. These failures remain retained
and unresolved. An earlier external PostgreSQL Node product run also timed out
during HTTP shutdown; request/repository/notification diagnostics were added to
the disposable oracle, and a subsequent complete run passed. That intermittent
shutdown failure is not considered resolved by the later pass.

The native probe example builds and both Rust projects pass formatting. Strict
desktop Clippy still fails four existing lints in `tunnel_forward.rs`; the same
four errors were reproduced on clean `main`, with byte-identical source and Cargo
files. This does not affect the separate passing server Clippy result and remains
part of desktop acceptance work.

Remaining remote/tunnel resource grants and resource mutation revocation consumers,
full linked Codex/resource execution, desktop LOCAL carrier and IPC,
congestion faults, shared/Redis authority and supported-platform/package acceptance
remain unfinished. Tunnel lifecycle persistence observers are implemented and
tested; the production tunnel repository/runtime consumer remains unported. The
native operational logger now has the shared reference noise-control policy;
buffer/archive APIs and complete metrics remain required.
These checks do not establish complete WorkerLink product acceptance or advance
the route coverage ledger yet. The current WorkerLink work remains unmerged.

```sh
node --import tsx scripts/server-rust/worker-link-coordinator-compatibility.mjs --report .qa/rust-server/worker-link-coordinator.json
node --import tsx scripts/server-rust/direct-attachment-compatibility.mjs --report .qa/rust-server/direct-attachment-coordinator.json
node --import tsx scripts/server-rust/worker-link-http-compatibility.mjs --database pglite --report .qa/rust-server/worker-link-http-pglite.json
node --import tsx scripts/server-rust/worker-link-http-compatibility.mjs --database bundled-postgres --report .qa/rust-server/worker-link-http-bundled.json
node --import tsx scripts/server-rust/worker-link-http-compatibility.mjs --database postgres --report .qa/rust-server/worker-link-http-external.json
node --import tsx scripts/server-rust/actual-folder-client.mjs --terminals --worker-links --native-probe --database pglite --report .qa/rust-server/actual-worker-link-pglite.json
```

## Terminal management and encrypted PTY services

The first Windows terminal product run failed in the reference Node flow before
Rust was exercised: the inline, quoted probe repeatedly exited without writing
its proof. The probe now runs a generated CJS program with its secret passed as
an argument, preserving proof that the worker decrypted the actual command.
Real PTY, PID replacement, previous-process termination, reconnect and disable
assertions remain intact. Windows acceptance requires the new workflow result;
the failed job is retained in
[run 40779444391](https://github.com/ArcaneArts/Cantrip/actions/runs/40779444391).

The Rust server implements terminal listing, creation, encrypted title updates,
service configuration and service restart. Creation preserves execution placement,
cross-resource tab positions, pane selection and membership, center topology and
layout revisions in one transaction. Center validation preserves duplicate-node,
set-membership, depth and node-count failures. Position overflow reaches an actual
PostgreSQL integer conversion instead of wrapping in Rust.

Managed-runtime terminals retain their read-only errors. Linked consoles cannot
become services. Service configuration persists before worker reconciliation;
a later reconciliation failure retains the configuration and records offline
status. Status and response-completion invalidations retain their separate
current-user/project scopes and ordering. Shared custom validation issues now
preserve the reference property order when rendered into error-message strings.

Local macOS actual-source comparisons pass 9,639 protocol and error-message cases,
35 repository cases and 29 complete state snapshots on each store. Failed
creation leaves exact terminal, pane, membership, topology, revision and timestamp
snapshots unchanged. Independent SQL ties retain raw order in the receipts while
comparisons enforce the declared position/creation-time ordering. Actual HTTP and
Live comparisons pass 79 observations per runtime/store across local and account
profiles, with nonempty ordered notifications and tenant isolation. A real
PostgreSQL pane-member INSERT remains owned after its caller disconnects and
shutdown begins; lock release atomically commits the terminal, membership and
layout revision, which remain after reopening.

The existing browser encryption and terminal API modules also run against each
server and the full unchanged worker. All 13 combined folder/terminal product
steps pass on all three stores. A terminal in the newly created managed folder
decrypts its title/state at the endpoints, runs a persistent real PTY process,
restarts, rejects an offline restart, resumes its persisted service on reconnect
and stops the process when disabled. Request-body checks retain opaque titles,
commands and paths. The test never changes persisted worker encryption bindings
to accommodate the fixture's later port-changing server restart.

All 100 native tests and strict all-target Clippy pass. The production native
PGlite HTTP matrix also passes with an observed 1 MiB main stack. The standard
`pnpm check` passes typechecking and the server/app/protocol suites, then fails
the existing worker filesystem-notification test. Focused current and clean
baseline runs both reproduce that failure with nine passing tests; all 2,072
compared Node server, worker, shared and dependency files are identical.

```sh
node --import tsx scripts/server-rust/terminal-repository-compatibility.mjs --report .qa/rust-server/terminal-repository-pglite.json
node --import tsx scripts/server-rust/terminal-http-compatibility.mjs --report .qa/rust-server/terminal-http-pglite.json
node --import tsx scripts/server-rust/actual-folder-client.mjs --terminals --report .qa/rust-server/actual-terminals-pglite.json
```

Repeat with `--database bundled-postgres` and `--database postgres`. Supported
platforms, packaging, movement/deletion and resource revocation, interactive
terminal output, WorkerLink/direct attachments and shared coordination remain
required by the complete replacement goal.

## Worker encryption refresh and terminal-service reconciliation

The Rust server implements worker encryption refresh with the existing request
and response contracts, 20-second command deadline, owner checks, error mapping
and successful post-response worker invalidation. Only a material fingerprint
change for surface-private-state triggers terminal-service reconciliation;
timestamps and grant ordering do not. Reconciliation reads enabled services from
their bound worker worktrees, sends the actual 30-second worker command, then
starts parallel running-status writes and current-user terminal invalidations.
No response schema is imposed on the reconciliation command.

Worker reconnect also runs reconciliation. The reference callback inherits its
HTTP application-owner context: local sockets publish terminal invalidations,
while credential-only account sockets commit status updates without an owner for
their best-effort publication. Authenticated refresh requests publish under the
requesting account. Raw Live receipts retain arrival order; independent terminal
writes can complete in either order, and successful refresh always publishes its
worker invalidation after those writes.

Local macOS comparisons pass 25,600 actual TypeScript helper cases, 22 repository
cases and three SQL state snapshots on each of the three stores, and 45 HTTP
observations per runtime/store across local and account profiles. The HTTP matrix
requires nonempty terminal events and rejects foreign-owner delivery. Actual
PostgreSQL locks prove that status writes survive caller disconnect and shutdown.
A rejected status write returns HTTP 502 before a held sibling completes; that
sibling remains owned through shutdown and commits after lock release.

The existing browser repository flow now approves and refreshes its encryption
grant through each server and the full unchanged worker. All nine folder product
steps pass on all three stores without manual grant preloading or a worker
restart to acquire the key. The following terminal milestone adds management
and actual encrypted PTY service flows. Movement/deletion, terminal transports,
shared coordination, supported-platform acceptance and packaging remain required
by the replacement goal.

```sh
node --import tsx scripts/server-rust/maintenance-repository-compatibility.mjs --report .qa/rust-server/maintenance-repository-pglite.json
node --import tsx scripts/server-rust/maintenance-http-compatibility.mjs --report .qa/rust-server/maintenance-http-pglite.json
```

Repeat with `--database bundled-postgres` and `--database postgres`. The latter
HTTP suite exercises the actual locks and shutdown faults.

All 98 native tests and strict all-target Clippy pass locally. Existing worker,
command-quota and folder HTTP regressions also pass. The production native
PGlite HTTP matrix passes with an observed 1 MiB main-stack limit.
The standard `pnpm check` passes typechecking and the server/app/protocol suites,
then fails two existing worker worktree tests. A focused current run passes all
ten tests; a clean retained baseline still reproduces the filesystem failure.
All 2,072 compared Node server, worker, shared and dependency files are identical
to that baseline; the earlier baseline receipts also retain both failing tests.
The repository-wide check is not reported as passing.

## Workspace catalog, repository discovery and imports

The native server now implements all eight workspace catalog, attached-root,
scan and import routes. Encrypted names, active key revisions, default promotion,
immutable worker/root bindings, revision conflicts, candidate classification,
checkout/GitHub conflicts and file-preserving workspace removal use native
repositories. Import completion creates the user-owned direct project, external
Primary and workspace membership in one transaction. Late constraint failures
roll back the whole completion; retrying the identical completion succeeds.

Discovery scans and imports share one executor slot, with scans taking priority.
The unchanged worker receives protected routing handles over its existing
command socket. Scan requests have no fixed command deadline; import validation
retains its 60-second deadline. Both retain the production two-minute lease,
30-second renewal/recovery and bounded retries for actual command quota errors.
Caller disconnect does not cancel an admitted mutation. Shutdown drains admitted
work while the database remains open, and startup/worker reconnect recovers
unfinished scans and imports with the existing attempt/revision fences.

Local macOS evidence covers all three stores: 241 repository observations and
73 SQL snapshots each, 6,590 exact source validation cases across 18 roots, and
all three authentication modes with 68/68/72 HTTP observations per runtime when
lifecycle cases are enabled. Real worker reconnect, missing capability, explicit
retry and shutdown recovery match the reference. Separate tests hold scans
through the real lease deadline and reject a stale attempt before actual expiry
and sweep recovery; production clocks and SQL lease timestamps are unchanged.

Admitted root attachment survives a real HTTP client abort on every store.
External PostgreSQL tests use actual blocking SQL and backend identities to
prove concurrent same-revision admission returns one 202 and one 409, and that
an admitted catalog insert survives client disconnect and shutdown. Raw
pg_stat_activity witnesses are retained separately from normalized comparisons.

The actual encrypted browser APIs and full built worker attach a disposable
root, discover/import a local Git checkout, and link its existing public GitHub
origin without pushing. Project/source/Primary identities, Git refs and dirty
bytes survive conversion and server restart. Removing the workspace while the
worker is offline removes catalog records and preserves every worker file.
This flow passes for PGlite, private PostgreSQL and external PostgreSQL without
seeding project catalog rows or substituting worker commands.

The generic source oracle now supplies baselines for all 324 registered native
roots, including 69 previously missing Run/worktree/provisioning roots. A real
empty-revision Run refinement mismatch was corrected to preserve JavaScript
truthiness; all 112 dedicated definition cases pass. The full generic suite now
passes 296,220 exact source comparisons and 69,648 ECMAScript JSON round trips
locally. Discovery CI is configured for Linux, macOS and Windows;
this milestone has not yet run there. Full managed execution/removal consumers,
shared coordination, packaging, migration and final default cutover remain open.
Normal app/server packaging still selects the Node server and Node worker.

## Managed-folder provisioning

Native folder creation now includes default workspace/storage bootstrap,
membership, queued setup jobs, transactional claims, revision and command fences,
lease renewal, recovery, retry and source/Primary-root completion. The server
dispatches up to four jobs through the existing worker protocol. Reconnecting a
worker resumes retryable blocked jobs. Shutdown stops new admissions and drains
owned callbacks and active jobs before closing storage. Post-response project
invalidations retain the existing creation and retry notifications.

The worker-scoped encrypted repository-operation route also runs natively.
Private path registration and resolution use the existing browser encryption and
full worker implementation; the server routes ciphertext and opaque handles.
Project/worktree agent operations still require their separate native consumers.

Repository comparisons inspect seven complete SQL tables and rejected-write
snapshots: 56 cases and 33 snapshots pass on all three stores, including missing
storage profiles, managed defaults and attached-default repair. Real
HTTP/worker-transport tests require nonempty ordered project Live
events and verify tenant isolation, the four-job admission windows and retained
restart. Independent jobs can reach the worker in different orders while their
asynchronous lookups run; raw arrival order is retained, with exact per-project
attempts and admission windows checked separately.

The local HTTP matrix passes 104 observations per runtime on PGlite/private
PostgreSQL and 106 on external PostgreSQL. A real membership INSERT stays locked
after its caller disconnects and shutdown begins; releasing the lock commits the
project, membership and queued job, which remain after restart. A held worker
command also observes the actual 30-second lease renewal without changing its
command, attempt or revision. Shutdown during dispatch retains a retryable job;
worker reconnect completes a new attempt. The native PGlite HTTP matrix also
passes with the production process limited to a 1 MiB main stack locally.

The actual-client harness runs the existing browser account, durable encryption,
project and repository APIs against each server and the full built Node worker.
It creates real worker directories, attaches an existing folder without changing
its file, repairs an actual missing path and retries, resumes an offline job on
reconnect, and reopens encrypted labels and completed jobs after server restart.
Names and paths are checked for absence from server request bodies. The browser
now authorizes and refreshes the repository grant through the normal existing
client flow without restarting the worker. These are focused product
flows, with full UI, project/worktree routes, shared coordination, supported
platforms and packaging still required.

All nine product steps pass locally against both servers on all three stores.
The full native suite passes 96 tests across 45 targets, including 156,132 actual
protocol cases and 203,929 outgoing-command mutations. The original full-worker
catalog flow passes again on all stores after sharing worker supervision.

```sh
node --import tsx scripts/server-rust/folder-repository-compatibility.mjs --report .qa/rust-server/folder-repository-pglite.json
node --import tsx scripts/server-rust/folder-http-compatibility.mjs --report .qa/rust-server/folder-http-pglite.json
node --import tsx scripts/server-rust/actual-folder-client.mjs --report .qa/rust-server/actual-folder-client-pglite.json
```

Repeat with `--database bundled-postgres` and `--database postgres`. The actual
client suite uses the same built worker, CLI and Chromium setup as the catalog
flow below. Configured CI is not passing platform evidence; the coverage ledger
records the accepted scope.

## GitHub conversion execution in progress

The native conversion repository, two-job executor and all four preflight,
start/status/retry routes are implemented. Protected repository and commit
handles remain opaque. Preflight binds the chosen source and worker rather than
trusting worker-supplied response identities. Admission, retry, lease renewal,
restart recovery, completion fences and the existing Live publications preserve
the source behavior. Completion updates the existing source, Primary worktree,
project origin and job in one transaction; user ownership and identities remain.

Local macOS repository comparisons pass 124 cases and 44 snapshots on all three
stores. They cover actual last-write constraint failure and rollback, stale
attempts, source ownership/path/Primary drift and repository collisions. HTTP
comparisons now pass all nine storage/auth combinations: 67 observations per
runtime in anonymous/password mode and 72 in account mode, with nine base worker
commands and eight base job Live invalidations each. Malformed worker preflight
results return matching 502 bodies.
Managed folders are created through real HTTP/worker materialization. For the
external Git branch, existing workspace-discovery ownership metadata is prepared
with the server stopped: legacy from-folder attachment currently records Cantrip
ownership in the reference and cannot stand in for a user-owned discovery import.
This fixture boundary is explicit; it is not proof of the actual external-source
discovery flow. The separate managed-folder product flow below uses the full client
and worker without catalog seeding.

The capacity and active-command shutdown extension also passes every combination.
It records five additional execution commands: three conversions admit two held
running jobs and one queued job, releasing one slot dispatches the third once,
and all complete on attempt one. Shutdown retains an interrupted conversion as
the same blocked worker-offline job at attempt one/revision three. Restart and
worker reconnect complete it once at attempt two/revision six, with one recovery
Live invalidation. Strict all-target Clippy/format checks,
large-file checks and four focused reference tests pass. Current reports are
`conversion-repository-pglite-v6.json`, `conversion-repository-{postgres,bundled}-v2.json`
and `conversion-all-auth-{pglite,postgres,bundled}-v1.json` under `.qa/rust-server/`.

Production lease tests now pass on all three stores without fake clocks or SQL
lease mutation. A held worker command remains attempt one/revision two beyond its
original two-minute lease, and is dispatched once. A stale ready result remains
running until the real sweep recovers it; attempt two succeeds at revision five.
Both jobs publish exactly their expected job Live revisions.

Actual external PostgreSQL lock tests pass anonymous, password and account modes.
Two same-project starts return 202/409; distinct projects claiming one repository
return 202/500 with the reference private error contract. Each race persists one
job. The joined `SKIP LOCKED` claim can skip the first job while the losing
admission retains its project lock in either runtime; a following admission is
the real dispatcher wake-up used by this test. The harness records this behavior
instead of asserting immediate dispatch. A disconnected caller retains the same
blocked INSERT. Shutdown waits for its commit, leaving queued attempt zero/
revision one; restart blocks offline at attempt one/revision three and reconnect
completes the same job at attempt two/revision six.

The existing encrypted browser APIs and full worker now complete a real GitHub
conversion on all three stores, with 12 product steps per runtime. A fresh managed
folder receives matching public GitHub history in its disposable worker directory.
Preflight selects `remoteAction=link`; execution preserves uncommitted file bytes,
remote refs and the project/source/Primary identities, publishes job revisions
`[1, 3]`, and retains the converted state through server and worker restart. There
are no SQL fixtures or command substitutions in this flow. It performs public
reads and linking, without repository creation or push. Actual external user-source
discovery and managed-folder push/initial-commit product flows remain required.

The macOS and Windows replica CI jobs also exposed a pending-observation shutdown
wait. An unanswered real observation command reproduces the Rust failure locally
at the original 15-second deadline. Shutdown now stops observation admission,
closes the worker bridge, then drains their owned persistence tasks before storage
closes. The same regression passes on all three stores without extending its
deadline or cancelling work. The platform matrix still must verify this fix.
The Linux contracts job separately failed because the real Run retirement probe
did not produce its termination marker under Node; its cause remains unresolved.

```sh
node --import tsx scripts/server-rust/conversion-http-compatibility.mjs --database pglite --profile none --leases --report .qa/rust-server/conversion-real-leases-pglite.json
node --import tsx scripts/server-rust/conversion-http-compatibility.mjs --database postgres --lifetimes --report .qa/rust-server/conversion-http-lifetimes.json
node --import tsx scripts/server-rust/conversion-http-compatibility.mjs --database pglite --profile none --lifecycle --observation-shutdown --report .qa/rust-server/conversion-observation-shutdown-pglite.json
node --import tsx scripts/server-rust/actual-folder-client.mjs --database pglite --github-conversion --report .qa/rust-server/actual-github-conversion-pglite.json
```

Repeat the lease, observation and product suites with `--database postgres` and
`--database bundled-postgres`. The independent conversion CI job configures the
three supported operating systems and all stores; configuration is not evidence
that those jobs passed. Further source/failure cases, supported-platform results,
packaging, migration/rollback and multi-instance acceptance remain required.

PR #2348 Windows CI stopped in a project-surface test probe when its blocker
count matched but `wait_event_type` was null. The surface and workspace probes
now poll for the complete count-plus-Lock witness before releasing their real
SQL lock, retaining every assertion and the ten-second deadline. Both complete
local concurrency/shutdown suites pass. This is not Windows acceptance; the
platform matrix must still run the updated probes.

## Project replica execution in progress

The native replica domain now includes durable admission, payload fingerprints,
revision and command fences, source/worktree completion, lease scheduling,
worker reconnect, and the catalog/job/retry/cancel/link-repair routes. Protected
GitHub import retains opaque repository handles and the existing separate
project-creation and job-admission transactions.

Local macOS comparisons pass all three stores for repository lifecycle
(52 cases/9 snapshots), admission (72/7), and completion (39/19). The HTTP
validation and offline-import suites each pass 18 observations per runtime and
authentication profile. Connected transport plus failure recovery passes 43 HTTP
observations, eight worker commands and 21 job Live events per runtime/profile.
It holds a command while checking durable progress, rejects stale progress,
provisions and synchronizes replicas, repairs a managed link, removes a second
replica, protects the final source, and recovers a worker-blocked job through a
failed retry and successful retry. Both anonymous and account profiles run.

The reconnect extension passes all three stores: 47 HTTP observations, nine
worker commands and 25 job Live events per runtime/profile, including exactly
one dispatch after an offline attempt resumes on reconnect. Real-time renewal
and stale-completion recovery also pass all three stores: 53 HTTP observations,
12 commands and 32 job Live events per runtime/profile. A held command stays on
attempt one beyond its original lease; a stale completion expires and recovers
exactly once on attempt two. Active-command shutdown/restart passes all three
stores in both auth profiles: the held first attempt survives as a retryable
worker-offline job, then reconnect completes attempt two with exact Live revisions.
A second-account extension passes all three stores with 61 account-profile HTTP
observations (50 in anonymous mode), including all ten replica/job routes denying
foreign access, unchanged owner state and no extra worker dispatch.
Repository removal comparisons also cover extra worktrees, chats, terminals,
Explorer and Code tabs, project views, and active/released execution lanes.
Converted-folder retention and deletion pass all three stores in both auth
profiles (56 anonymous/67 account HTTP observations, 12 commands). Completed
conversion records are seeded while the server is stopped; production routes
then detach without a worker command or run folder deletion through failure and
retry. Restarted database reads confirm source retirement, missing worktrees and
matching deletion timestamps, including an already absent folder. A real worker
heartbeat is sent on reconnect; command sockets alone do not refresh presence.
The capacity comparison also passes all three stores: five admitted jobs yield
four held running attempts and one queued attempt, releasing one slot dispatches
the fifth once, and all five finish on attempt one. It records 57 anonymous/68
account HTTP observations per runtime. Controlled handlers return distinct
worker paths; a copied-database reproduction retains the real source-path
ownership rejection from the initial fixture.
An actual encrypted browser/two-full-worker local Git flow now passes on all
three stores (12 product steps per runtime). It uses real direct checkout
attachment, exact admission replay, retained replica identity after server and
worker restart, refused user-checkout deletion, and detach with Git files intact.
No catalog, repository or worker handler is seeded for this flow. The existing
AppLiveClient receives the same per-job sequences from both servers, including
unchanged completion revisions published by exact admission replay. The comparison
function also passes against all six saved runtime reports.

The first PGlite run timed out during Node startup before product steps; an
isolated same-mode startup passed in 6.3 seconds, without proving the cause.
A second run completed the Node flow but killed a full worker 30 seconds after
SIGTERM in the Rust case, despite its shutdown-completed log at 853 ms. No worker
handle trace was available for that failure. A later traced run identified the
late-observation watcher defect fixed below; attribution of the earlier untraced
hang remains unproven. Test-only handle tracing and complete server shutdown-stage
retention support further investigation. The startup timeout remains unresolved.

The managed GitHub extension uses real public `octocat/Hello-World` reads and
clones through `gh`, the encrypted browser API, and both full workers. The latest
comparison passes 17 product steps per runtime on all three stores: import,
exact-revision second replica, synchronization, ignored-user-file rejection, and
retry/removal with the primary retained. Both dirty and ignored checks remain
unchanged. The initial PGlite failure is retained: its ignored CodeGraph cache
blocked removal despite clean Git status.

Worker replica deletion now invokes CodeGraph retirement only after existing
checkout path/ownership checks. Retirement fences reconfiguration, aborts and
drains the current CLI through actual process close, and executes managed
`uninit --force` before the existing Git checks. It also works before first
observation after restart. Cleanup failure does not replace the filesystem
operation's result; the actual dirty/ignored checks still run. A blocked removal
resumes observation. A successful removal forgets the retired path. No ignored
file allowlist or force-delete bypass was added.

The v4 PGlite/Rust run observes two real retirement events in the previously
failing cache case. Latest v5 also records real retirements on Node/PostgreSQL
and Rust/private PostgreSQL; all six runtime/store flows preserve the injected
ignored user file, then remove only the secondary checkout on attempt two.
Forty-six focused CodeGraph/Git safety tests and the worker build pass, including
real delayed-SIGTERM process drain, reconfiguration fencing, cleanup before first
observation, optional-tool failure, symlink preservation and denial before the
removal lifecycle. The 11 worktree tests also pass.

The extended run also captures two referenced filesystem watchers on a retiring
checkout and `.git` after the worker logged shutdown completion. WorktreeManager
accepted a late observation configuration after close. A child-process regression
first proves configuration completed and then reproduces both persistent watcher
handles; a permanent observation-close flag fixes that lifetime defect. All 11
worker worktree tests and the full worker build pass. Earlier trial regressions
that timed out before configuration completed are retained as invalid leak
proof; the measured failing/passing process regression is the evidence. Server
shutdown deadlines and the worker's 30-second shutdown assertion are unchanged.

Controlled HTTP admission and lifetime comparisons now pass on external
PostgreSQL for Node and Rust in anonymous and account modes. Five forced races
cover identical provision keys, competing keys for one worker, a reused key with
different worker payloads, and identical/distinct synchronization keys. Both
requests reach the actual blocked INSERT or source-row lock before release;
each case verifies exact conflict bodies, one durable job and exact later replay.
The PostgreSQL activity view truncates the reference's long SELECT projection,
so its actual blocker PID and lock wait establish the source-row boundary.
Synchronization's unsafe cancellation is refused; normal worker reconnect then
completes its second attempt. A disconnected admission still commits, and an
admission disconnected during shutdown retains one queued job at attempt zero,
revision one. Restart dispatches that same job once and replay returns its
canonical blocked result. Evidence: `replica-http-lifetimes-v5.json`. These
cross-session lock cases deliberately use external PostgreSQL; the other suites
continue to exercise all three storage modes.

Remaining placement/failure product flows and supported-platform acceptance
remain required before completing this domain.
Existing platform CI shutdown failures remain unresolved; local comparisons do not prove
packaged or Winterhold readiness. Fixed native shutdown-stage diagnostics now
record drain names, start/completion and elapsed time without changing ordering
or timeouts. Full-worker catalog reports retain these stages on success and
failure to locate stalled drains. The default server remains Node.

```sh
node --import tsx scripts/server-rust/replica-import-http-compatibility.mjs --connected --faults --reconnect --report .qa/rust-server/replica-connected-pglite.json
node --import tsx scripts/server-rust/replica-import-http-compatibility.mjs --connected --faults --reconnect --lease-recovery --report .qa/rust-server/replica-lease-pglite.json
node --import tsx scripts/server-rust/replica-http-lifetimes.mjs --report .qa/rust-server/replica-http-lifetimes.json
node --import tsx scripts/server-rust/actual-folder-client.mjs --replicas --report .qa/rust-server/actual-replica-product-pglite.json
```

Repeat with `--database postgres` and `--database bundled-postgres`. The lease
scenario uses the production two-minute expiry and 30-second timers without
clock substitution. The Live test client sends ordinary heartbeat pings throughout
the wait. These local results do not establish supported-platform acceptance.

## Project catalog and execution placement

The Rust server implements the four project catalog/placement routes: project
listing, placement selection, execution-target listing and explicit target
resolution. All seven surface kinds retain their existing ownership, context,
readiness and capability rules. Worker-bound folders and local Git projects
preserve their source restrictions. Protected labels and surface state stay
opaque. Stored resource projections preserve validation failures even when the
catalog does not display the invalid field.

Actual Node/Rust comparisons pass on native PGlite, private PostgreSQL and
external PostgreSQL: 165 placement cases and nine catalog cases, 86 target
repository cases plus one rejected SQL constraint, and 129 HTTP observations per
runtime across anonymous and account profiles. HTTP cases use the unchanged
Node WorkerConnection after real enrollment and credential rotation, covering
connected/offline presence, all target/surface types, owner isolation, errors,
HEAD and retained restart. Background worker commands use an explicitly
unsupported metadata-fixture handler; these cases do not execute filesystem,
chat or model operations.

Sixty-two additional comparisons execute the actual TypeScript descriptor
builder, checking serialized property order, Unicode, resource filters,
availability and the 2,000-target limit. In-memory identifiers preserve UTF-16;
SQL-bound identifiers preserve PostgreSQL's UTF-8 replacement behavior. Six new
protocol roots and four native refinements bring the actual protocol comparison
to 150,879 cases. Existing project mapping and Live authorization read suites
pass again on all three stores after the shared replica mapper extraction. A
local native PGlite process limited to a 1 MiB main stack completes schema
startup, 45 seed writes, catalog composition and all seven surface resolutions.

Supported-platform CI for this group is configured; acceptance is still pending.
Presence checks currently use the local worker bridge. Redis/multi-instance
coordination, project/resource mutations, execution, full client/UI flows and
packaged operation remain required by the replacement goal.

Mutation audits now begin after body completion rather than delaying the HTTP
response. An owned admission retains the audit through its deferred write, and
shutdown drains those admissions before closing the database. HEAD discards
complete their audit while preserving the GET body's size hint and Content-Length.
Response errors also complete audits; abandoned unfinished bodies do not. Explicit
in-handler authentication audits retain their existing timing.

A real PostgreSQL relation lock proves that Node and Rust both return the
original HTTP 400 while the audit INSERT waits, retain it during shutdown,
commit after release and reopen with one correlated row. A rejected audit INSERT
preserves the HTTP response and permits clean shutdown/reopen. The local security
matrix passes 387 comparisons per store across anonymous, password, account and
administrator profiles on native PGlite, private PostgreSQL and external
PostgreSQL, including exact HEAD Content-Length. Eight body-lifecycle tests and
all 96 native tests pass; strict all-target Clippy passes. Platform acceptance
remains required.

The security harness observes the actual Node onResponse hooks and audit
completions, then observes correlated Rust rows before the next scenario. Full
audit lists, IDs, ordering and cursors remain exact comparisons. Test-only
observation does not replace handlers, reorder responses or introduce a server
runtime JavaScript dependency.

The actual Linux worker flow exposed an embedded desktop backend signal handler
that called `process.exit(143)` before Cantrip could drain its services. The
worker now opts out of that backend's SIGINT/SIGTERM handlers through a narrow
dependency patch. The cross-process session lock and normal-exit lock cleanup
remain enabled; standalone library callers retain their original signal
behavior. Four subprocess cases exercise the real desktop client, both signals,
Cantrip's completed asynchronous close, and the standalone exit codes. The SIGTERM
case reproduces the original failure before the patch; all four cases pass
locally afterward.
On Windows the subprocess test invokes the actual registered Node listeners
over IPC, since process termination cannot deliver Unix signal handlers.
Supported-platform execution and full-worker acceptance remain required.

The existing browser account/provider API modules and AppLiveClient now run a
real Ollama catalog operation through each server and the full, unchanged built
worker entrypoint. Local macOS runs pass eight product steps per runtime on
native PGlite, private PostgreSQL and external PostgreSQL: account/session setup,
worker enrollment and command readiness, committed Live notification, provider
creation and discovery, retained catalog while stopped, persisted-credential
worker restart, stale-catalog behavior after an actual Ollama HTTP 503, and
recovery. Catalog capabilities, worker-scoped availability, sync state and model
identity are checked through the existing client. The test builds the native
Cantrip CLI required by worker startup; no worker command handler is replaced.
All twelve worker processes exit cleanly on macOS. The installed Codex runtime
is advertised as incompatible; this flow does not execute Codex or a model.
Windows process termination does not exercise Node's Unix shutdown handlers.
Supported-platform CI is configured but remains unaccepted. Full UI, execution,
packaging and deployment acceptance are still required.

```sh
pnpm --filter @cantrip/worker build
node --import tsx scripts/server-rust/actual-worker-client.mjs --report .qa/rust-server/actual-worker-client-pglite.json
node --import tsx scripts/server-rust/actual-worker-client.mjs --database bundled-postgres --report .qa/rust-server/actual-worker-client-bundled.json
node --import tsx scripts/server-rust/actual-worker-client.mjs --database postgres --report .qa/rust-server/actual-worker-client-external.json
```

Build shared workspace packages and install Chromium as for the existing
browser harness. The PostgreSQL modes use `CANTRIP_TEST_POSTGRES_BIN_DIR`.
Every worker uses a disposable data directory and its real startup, enrollment,
transport, command dispatcher and catalog implementation.

Global settings reads and provider create/update/delete now use native services.
Settings reads reconcile the bundled Z.ai catalog before returning their snapshot
and start account/Ollama discovery without delaying the response. Provider
mutations preserve opaque keys, initial-account validation, hydration ordering,
cache invalidation and the account sign-out sequence before deletion. Admitted
operations and background catalog work retain their existing shutdown drains.

Local Node/Rust socket comparisons pass 99 observations per storage mode across
account and local authentication. They include real account-insert rollback,
rejected provider updates, retained writes after a later runtime-detach failure,
model deletion restrictions, built-in discovery and restart. Generated discovery
IDs are checked for UUID format and model/route/default relationships before
normalization. SQL error context is attached only after the actual failed query.
External PostgreSQL additionally holds a real provider UPDATE behind a row lock,
disconnects its caller and requests shutdown. Both runtimes wait for release,
commit the update and reopen with its value retained (103 HTTP observations).
The local native suite passes 92 tests across 44 targets and strict all-target
Clippy passes. Supported-platform acceptance and remaining settings/provider
operations are still required.

The provider telemetry milestone implements the analytics, export and deletion
routes natively. Quota attribution, pending consumption, confidence, calendar
and locale breakdowns, period comparisons and all eight change metrics retain
the existing calculations. Reads preserve owner and query scopes, historical
accounts, prior-reading selection and per-account sampling. Exports contain
opaque dimensions and structured evidence; deleting four history tables is one
transaction and preserves current account projections.

Local comparisons pass 56 repository observations and 102 HTTP observations on
each of native PGlite, private PostgreSQL and external PostgreSQL. A further
external PostgreSQL scenario holds a real lock on an admitted DELETE, closes
the caller and shuts down the server. Both implementations wait for release,
commit all four deletes and reopen with the deletion retained (104 external
PostgreSQL HTTP observations in total). Valid structured telemetry at depths
100, 150 and 300 passes through JSONB reads, analytics and exports without
Serde's intermediate recursion limit. The fixtures give ordered rows distinct
timestamps because the source SQL defines no order within timestamp ties;
response comparisons remain exact. The native
statistics, quota and change helpers are compared directly with the current
TypeScript helpers; protocol responses use three additional generated roots.
The current local all-target Rust suite passes 92 tests across 44 targets, with
strict all-target Clippy and native formatting passing. Supported-platform
acceptance is still required.
Execution-domain telemetry writers, packaged operation and complete replacement
remain in scope.

PR 2293's Windows run passed the earlier rounding regression, then terminated
the settings repository fixture with a stack overflow. Local bounded-stack
replays reproduced nested future allocation failures. The adapter and shared
settings/provider refresh seams now keep those futures on the heap. All 768
existing settings comparisons pass with the native process limited to a 1 MiB
main stack, and a native regression performs real settings reads and rejected/
committed updates on a 1 MiB thread. No runtime stack allowance was increased.
PR 2294's Windows run completed all 768 settings comparisons on each of the
three stores at `fc5b06aac`, accepting that fixture's stack fix. It later failed
the telemetry private-PostgreSQL suite's generated-timestamp assertion in the
unmodified Node reference before starting Rust. The failed timestamp and request
bounds were not retained. The repository comparison now records the runtime,
actual timestamp, parsed milliseconds, request wall-clock bounds and monotonic
elapsed time before checking the same inclusive bounds. Both implementations and
their full state comparison now run before timing validation, so a reference
clock observation cannot prevent the actual Rust comparison from executing.
Later Windows receipts retain matching repository results from both runtimes,
while generated timestamps can exceed the parent process's after-reading by
one or two milliseconds. The repository fixtures now take independent wall-clock
and monotonic readings immediately around the actual operation inside each
producer process. The same strict inclusive predicate validates generatedAt
against those producer readings. Original parent readings and their predicate
remain in every timing report; production timestamp generation is unchanged.
Boundary controls accept exact endpoints and reject even one millisecond outside
the producer interval, including when parent bounds would accept that value.
Local comparisons pass all 56 repository observations and 27 generated-timestamp
checks per runtime on each of the three stores. Windows run 40711050999 passes
all three repository suites and the strict clock controls. Its later private
PostgreSQL HTTP suite fails the parent-clock assertion in the Node reference;
the failed timestamp and bounds were not saved, and Rust was not reached.

The HTTP comparison now retains raw generatedAt/range.to values, parent
wall/monotonic readings and their original predicates before timing assertions.
Opt-in Node request hooks and a development-only Rust example record independent
producer clocks correlated by the actual request ID. The example includes the
unchanged production main source and wraps its actual router; it preserves the
CLI, storage initialization and shutdown paths. Rust records the real router's
request/response-construction interval; Node records its onRequest/onResponse
interval. These JSON handlers generate timestamps within those intervals.
Both runtimes complete the HTTP/Live and retained-state comparisons before the
same strict inclusive predicate checks producer bounds. No production timestamp
generation or tolerance changes. The normal entrypoints emit no clock receipts;
12 real HTTP controls cover enabled/disabled observation and reject eight values
one millisecond outside actual producer intervals. Supported-platform acceptance
of the HTTP measurement change and complete replacement remain required.

The audit milestone's repository-wide check passes the Node server's 1,616 tests, the app's
3,899 tests and all type checks, but fails four worker cases: Grok login,
history-outbox replay, filesystem status observation and the PNG size boundary.
Focused runs of those four files on this revision and the retained clean baseline
each pass 67 cases and reproduce the filesystem observation failure; the other
three sweep failures do not reproduce in either focused run. Worker source and
dependencies are unchanged by this milestone. The 12 repository-wide formatting
failures are byte-identical to the baseline. Original failures and baseline
results are retained without changing assertions or limits.

The outgoing worker envelope now has native validation and normalization before
bridge admission. Its development oracle exercises the actual TypeScript
protocol for every command type and reachable union alternative; large boundary
cases and real HTTP/WS admission comparisons supplement malformed mutations.
Local admission comparisons pass on all three storage modes with unchanged
worker transport components and controlled handlers. PR 2287 merged, and its
Linux/macOS jobs and 70 uploaded JSON reports passed inspection. Windows reached
the configured 60-minute job limit during worker PGlite HTTP tests, with earlier
steps passing. That attempt does not establish full Windows acceptance. PR 2288
raised the allowance to 120 minutes and its complete descendant
[run 40492875845](https://github.com/ArcaneArts/Cantrip/actions/runs/40492875845)
passed Linux, macOS and Windows. All 141 uploaded JSON reports were inspected,
artifact SHA256 digests verified, and native coverage receipts retained. That
run accepts the command and usage scopes at its head; the earlier cancelled
Windows attempt remains part of the historical record.
This is wire-contract coverage; resource-domain and execution behavior remain
in scope below.

The full objective is a Node-free Rust server supporting desktop-packaged and
standalone operation, with PGlite, bundled private PostgreSQL, and external
PostgreSQL. The existing app, worker, CLI, browser and mobile contracts remain
the compatibility baseline. Winterhold readiness and desktop packaging are
required before completion. Production deployment is a separate action.

## Policies

The policy domain now executes in Rust: public packaged templates, encrypted
bootstrap, opaque CRUD, collection ordering, workspace/project assignments,
assignment counts, and IDE/standalone effective-policy resolution. Owner,
collection and row-version conflicts preserve their transaction boundaries.
Ordering compares original JavaScript UTF-16 identifiers; SQL binding converts
only at PostgreSQL's UTF-8 boundary. Policy content remains opaque, including
blind indexes and authenticated encryption metadata.

Successful HTTP mutations publish one owner-scoped policy invalidation after
the response body completes. Empty responses complete without a body frame;
partial or failed body streams do not publish a success event. Mutations that
return an error do not publish. Shared multi-instance coordination and resource
publishers in unported project/workspace/chat domains remain required.

Local macOS evidence includes 62 actual Node/Rust repository comparisons per
store on native PGlite, private PostgreSQL and external PostgreSQL. Nineteen
cases per store retain exact before/after snapshots proving transactional
rollback, including an injected assignment-insert fault. Cases also cover
owner isolation, limits, cascade deletion, source ordering and process reopen.
The real HTTP/Live suite passes 80 observations per runtime on each store,
including concurrent optimistic updates, CSRF, error bodies, original UTF-16
equality, invalidation counts and foreign-subscriber isolation. Existing client
crypto encrypts and decrypts both fields, rejects a wrong owner or row, and
verifies exact ciphertext after restart; component keys never reach the server.

Oversized versions exposed a real mismatch between early Rust integer
conversion and Node's PostgreSQL errors. Native operations now let the database
perform integer conversion, including next-version and position overflow.
The failure matrix preserves the existing query-error contexts for policy
count, position, order, assignment, initialization and post-delete increment
errors. It proves that a failed transaction restores deletion and that updates
and bootstrap claims committed before a response-projection failure stay
committed. Sixty-three method/path comparisons per runtime/store also preserve
Fastify's method-specific literal/parameter route selection. Sequential
Node/Rust/Node operations on one external database retain encrypted Rust writes,
assignments and version counters, and the unchanged Node repository continues
writing afterward. Full-server rollback and existing PGlite conversion remain
required. These checks do not establish supported-platform or packaged
acceptance.

Templates, their source hashes and limits are embedded from the actual public
Markdown collection, with a source-drift test. Thirteen additional schema roots
bring the current protocol manifest to 67 roots/5,409 nodes; the actual protocol
oracle passes 67,389 validation cases. Four body-completion tests and the final
full native regression suite pass locally, as do all-target Clippy and Rustfmt.
The complete repository check passes server, app, protocol and crypto tests but
exits on two unchanged worker failures: filesystem notification debouncing and
the image adapter's exact 2.5 MiB timeout. A focused rerun passes 37 tests,
including the image boundary, and reproduces only the filesystem case. Its
unchanged source hashes and earlier baseline failure evidence are retained;
assertions and timeouts were not relaxed. Supported-platform acceptance remains
required for this milestone.

Project/workspace rows in the policy harness are seeded fixtures. This does not
port their CRUD, the app settings UI, or chat/native execution consumers. Legacy
PGlite conversion, full post-write rollback, desktop packaging and Winterhold
delivery remain part of the original replacement goal. Node is still the
production entry point.

## Account resource usage (merged; accepted on three platforms)

The usage milestone implements native storage measurement from the actual
110-table ownership manifest, exact decimal bandwidth counters, idempotent
transactional flush receipts, fenced reconciliation, hourly/daily history,
rollup/retention and operational totals. It also adds bounded asynchronous
metering, live quarter-second traffic samples, response projections and the
three authenticated account usage HTTP routes. All operations execute in Rust;
JavaScript is used only by development exporters and comparison oracles.

HTTP request/response bodies, App Live frames and worker control text frames
feed the native meter. Stream completion, error and destruction count one
operation while retaining consumed bytes. Usage-observer traffic avoids another
refresh, and the live-traffic route excludes its own payloads and request count.
Storage reconciliation and history maintenance start after binding the listener;
shutdown waits for their in-flight work and drains bandwidth before closing the
database. Coalesced owner invalidations follow committed storage/bandwidth work.

Local evidence includes 42 actual Node/Rust repository comparisons on each of
the three stores, with precise counters, duplicate/overflow rollback, injected
rollup/lease faults and retained process reopen. Native state comparisons cover
209 meter scenarios, 127 live-traffic scenarios and 58 response projections.
Timer/close, background drain, coalescing capacity and stream cancellation/error
tests supplement those comparisons. Production-entrypoint HTTP suites pass 33
cases per runtime on every store, including exact post-shutdown persistence.
Production socket suites on all stores compare their observed frames with
durable counters and observe a real usage publication without a refresh loop.

The socket accounting proof is per runtime: Node still emits additional worker
commands and resource notifications whose domains remain unported. The suite
does not claim those absolute frame totals or full worker-domain behavior match.
Account-isolation/restart checks pass 14 cases per runtime on each store,
including distinct retained large counters and rejected owner injection. The
shared query parser also matches 72,298 actual Fastify cases and preserves
malformed escapes in validation errors. PR 2288 passed observed
Linux/macOS/Windows CI; all 141 reports and native
coverage receipts were inspected and archived. Whole-server metrics integration,
future binary/domain transport hooks and complete product acceptance remain
open. This milestone is not a complete server replacement or packaged/deployment
acceptance.

## Foundation

`cantrip_server_rs` currently contains native database execution, the existing
SQL migration chain and Drizzle journal, private PostgreSQL provisioning, and
the foundation HTTP routes, version/bootstrap responses, and account/session
authentication. Other domains remain unported. The existing Node service
remains the production entry point.

The compatibility harness launches the actual Node service and Rust executable
on ephemeral ports with isolated database roots. It compares JSON bodies,
status codes, content types, HEAD behavior, method handling, unknown routes and
trailing slash handling. Only timestamps and measured latency are normalized;
their types and ranges are validated. It also restarts Rust and requests actual
database readiness. Its report explicitly does not assert full replacement.

The database contracts execute all existing migrations, inspect every journal
hash and timestamp, rerun without replaying migrations, exercise JSONB and bound
parameters, constraints, commit, rollback, cancellation rollback and LISTEN /
NOTIFY, and verify retained data after reopening in a new process. PostgreSQL
tests start a real private cluster and also invoke the executable in external
connection mode. They never connect to a developer's ordinary database.

PostgreSQL request operations now lease up to five connections, matching the
reference pool, while PGlite retains its single serialized session. A separate
LISTEN connection restores established channels after an actual connection
failure. A cancelled or incomplete pooled operation keeps its pool slot during
a bounded CancelRequest attempt, then discards that session. Statements are
not automatically replayed. Shutdown closes admission, wakes queued borrowers,
stops the listener and drains operations, cancellation cleanup and drivers.

Worker authentication has a separate shutdown drain before pool closure. A
closed worker socket still completes credential usage and its owner lookup,
including work queued behind the five PostgreSQL connections. The external
worker fault suite holds the real credential row, closes 32 pending sockets,
requests server shutdown, and verifies that shutdown waits for lock release.
A trigger in the disposable database then proves all 32 usage writes committed.
The native server previously exited while that lock remained held and lost
those writes; the actual Node service waited and retained them.

`tests/postgres_pool.rs` exercises real relation locks, unrelated concurrent
reads, all five busy connections plus a listener, cancelled transactions,
backend termination, listener restoration and shutdown. The real HTTP/TLS
harness compares eleven SSL-on/off configurations against postgres-js and the
Node/Rust services, checks actual `pg_stat_ssl`, and keeps `/api/workers`
blocked while `/api/account/sessions` completes over a TLS server connection:

```sh
node scripts/server-rust/postgres-connections.mjs --report .qa/rust-server/postgres-connections.json
```

The Live lock fault checks the actual blocking backend and verifies that its
granted table lock survives transport ping and close, with no subscription
reply. It retains the authorizer backend's post-close state separately: Node
may keep it waiting, while Rust may already have cancelled and disposed it.
Requiring the abandoned query to remain blocked made the older assertion race
with successful cancellation; the actual lock and transport deadlines remain.

Supply `CANTRIP_TEST_POSTGRES_BIN_DIR` and an OpenSSL CLI for this disposable
fixture. The Windows workflow installs that test dependency explicitly. Local
macOS arm64 results passed; this milestone still requires observed platform CI.
The external URL adapter preserves omitted/disabled SSL, prefer fallback,
required encryption and strict certificate rejection for the tested settings.
An explicitly empty `sslmode=` retains Node's omitted-option behavior; the
adapter resolves and removes that key before invoking the typed driver parser.
Complete connection-option/environment parity, startup retry behavior,
interrupted-network recovery and deployment artifacts remain required. A
successful CancelRequest is not an acknowledgment of remote statement rollback
during a network partition; retained execution recovery still needs its domain
tests. This does not establish complete database or server replacement.

The TLS fixture's PostgreSQL launcher inherits a real append log and null
stdin, matching the native Windows owner instead of leaving a daemon attached
to captured launcher pipes. Cleanup attempts actual `pg_ctl stop` after every
start attempt, including a launcher observation failure. Logs indicating a
listening server do not substitute for the actual connection checks.

Windows private-cluster startup uses PostgreSQL's own `pg_ctl` restricted-token
launch path. A kill-on-close Windows Job Object owns the launcher and its
descendants, assigned during process creation so startup cannot outrun process
ownership. The Windows integration test abruptly kills the owner, observes the
actual postmaster exit, and reopens the cluster to verify committed data after
crash recovery. This test passed in the observed Windows run linked below;
future changes still require their own execution results.

On Unix a native owner mode of the same Rust executable holds PostgreSQL. The
main server keeps a private pipe open; main-process death closes that pipe and
the owner requests fast PostgreSQL shutdown and reaps its actual child. Normal
shutdown closes database sessions before releasing the pipe. External database
connections do not enter this ownership path.

The owner has its own Unix process group. A terminal's foreground-group Ctrl-C
therefore reaches the main server, which drains work before releasing the pipe,
instead of killing its owner and bypassing that shutdown order.

Unix initialization also runs under that owner. A new cluster is initialized
and synced in a private staging directory, then promoted to `data` after initdb
success. Parent death during initialization kills its owned initializer process
group and removes its staging files. An existing cluster is never reset or
deleted to recover from an opening or promotion failure.

The lifecycle harness uses the actual executable, HTTP account/worker writes,
process death, PostgreSQL status and retained login/credential checks. Its Unix
cases additionally interrupt real initdb and stop PostgreSQL with the parent's
pipe still open, checking that the owner exits independently of that reader:

```sh
node scripts/server-rust/postgres-lifecycle.mjs --report .qa/rust-server/postgres-lifecycle.json
```

Local macOS results passed. The revised lifecycle still requires observed Linux,
macOS and Windows CI, packaged assets and client/service supervision acceptance.
The earlier pool/TLS milestone passed all three platforms at `50339edbd` in
[run 40427101801](https://github.com/ArcaneArts/Cantrip/actions/runs/40427101801);
its 93 reports do not establish this later ownership change.

PGlite candidate: `pglite-rs` 0.2.7 statically embeds Electric's
`postgres-pglite` fork. It reports PostgreSQL 17.5. The current JavaScript
PGlite 0.5.4 reports PostgreSQL 18.3. **Physical directories are not compatible
by assumption. Existing-installation conversion is unfinished.** Native
PostgreSQL owns process-wide stdio and signal state; native tests use separate
processes, and the executable duplicates launcher pipes before initialization.
PL/pgSQL needs backend symbols exported from the final executable on macOS and
Linux. The native runtime and its license/artifact distribution still need
release review and packaging integration.

The Rust command reads the existing server environment configuration, including
auth/deployment/bootstrap modes, hosted startup protections, origins, proxies,
cookies, key rings, limits, WorkerLink policy, TURN and WebRTC settings. The
configuration itself is implemented; the session handlers are now implemented
and the remaining transport domains are unported. CLI host, port, data directory and database options
override their environment settings. Explicit CLI port zero supports ephemeral
process tests; environment ports retain the existing 1–65535 range.

Data paths resolve lexically before native PostgreSQL can change the process
working directory. The default remains `../.cantrip/dev` relative to the launch
directory. The canonical `server-db` root is preserved; an opening failure never
selects an empty replacement. Bundled mode still needs PostgreSQL executables
through `CANTRIP_POSTGRES_BIN_DIR` or the CLI option until packaging is integrated.

Storage selection uses `CANTRIP_DATABASE_MODE=pglite|bundled-postgres|postgres`.
When unset, a nonempty `DATABASE_URL` selects external PostgreSQL; otherwise
PGlite preserves the existing behavior. Explicit embedded/private modes also
work with hosted configuration while retaining its authentication, key-ring,
origin, proxy and cookie protections. Storage selection is independent from
deployment; this does not assert that the remaining hosted service is ported.

A differential configuration test executes the actual Node parser for 977
scenarios and compares every resulting field or validation error with Rust.
Inputs cover all bounded numeric settings, booleans, Unicode, key rings, nested
policy validation, host/origin/proxy handling, multi-instance quota division,
and error precedence. Executable tests exercise configuration rejection before
storage writes, CLI precedence, relative paths and real PGlite process reopen.
The Node oracle is development-only and is not called by the server executable.

Run from the repository root:

```sh
pnpm --filter @cantrip/version --filter @cantrip/logging --filter @cantrip/protocol -r build
node scripts/server-rust/build.mjs
CANTRIP_TEST_POSTGRES_BIN_DIR=/absolute/path/to/postgres/bin \
  node scripts/server-rust/cargo.mjs test -- --nocapture
node scripts/server-rust/compatibility.mjs --report .qa/rust-server/foundation-http.json
```

The GitHub workflow executes real tests on Linux, macOS and Windows; scheduled
or configured coverage is not evidence of a passing run. Windows currently
uses the native PGlite crate's GNU target, independently of the desktop Tauri
MSVC target. Cross-platform results must be observed before claiming support.
The build tooling points the compiler at Cargo's resolved, checksummed native
artifact package. This works around the upstream 0.2.7 build scripts checking
only for an uncompressed archive, overlooking their published `.a.zst`, and
falling back to a nonexistent Windows release download. The actual compiler
and runtime tests still execute; no declared capability substitutes for them.

Local evidence, 2026-10-25, macOS arm64: the database integration scenarios
passed with all 235 migrations and real PGlite process reopen, PostgreSQL 18
private-cluster restart, external-mode executable invocation, cancellation
rollback and notifications. Seven HTTP comparisons plus a Rust restart passed
against the Node service over actual sockets. Rust formatting and Clippy with
warnings denied passed. These are foundation results, not the complete server
or product-flow acceptance matrix.

## Legacy PGlite logical export and transactional restore

An actual round trip found that the upstream dump wrapper removed lines beginning
with `\\restrict` or `\\unrestrict` from multiline row values and SQL function
bodies. The converter now obtains SQL directly from the pinned package's generated
WASM factory, before that global cleanup. It removes only the matching generated
header and footer commands. The unmodified factory, license and provenance are
retained under `scripts/database-transfer/third-party`; the matching WASM remains
in the pinned dependency. Native serving never imports this bounded converter.

The regression fixture uses the same guard key inside actual text and a SQL
function, restores the real dump, and checks both values exactly. It also invokes
an actual invalid dump option, checks ordinary error redaction and explicitly
retained private diagnostics, and verifies the original session/search path still
works. The complete current and historical transfer fixtures now retain SQL NULL
versus JSON null, multiline guard text and the function result alongside the full
table and sequence snapshots. Their all-store interruption/retry suites pass
locally; supported-platform results remain required.

The expanded current/historical fixtures also pass against real PostgreSQL
16.15. Strict all-target Clippy and native database contracts pass. The broad
repository check exits 1 with 1,662 source-server tests passing, 57 skipped and
the previously reproduced provider-routing assertion failing at
`local-foundation.test.ts:7218`. This is not a green repository-wide check.

A bounded offline JavaScript tool now opens a private copy of the stopped legacy
PGlite database and exports ordinary PostgreSQL SQL with the pinned, matching
[PGlite/pg_dump packages](https://pglite.dev/docs/pglite-tools). It never opens the original database for execution and
creates the export exclusively with private file permissions. Native serving
and background work do not import or invoke this converter.

The Rust executable accepts trusted INSERT-format exports through `--restore-sql`
with `--migrate-only`. Restore DDL,
data and pending migrations execute in one transaction on the selected native
PGlite, private PostgreSQL or external PostgreSQL backend. The original Drizzle
journal and migration SQL hashes remain authoritative. Deferred checks are
resolved before upgrade DDL so valid circular chat/root relationships do not
leave PostgreSQL 17 trigger events pending during the conversation backfill.
An offline restore also preserves the existing local-user timestamps instead
of running the ordinary migrate-only local-user refresh.

For a stopped source and a separate destination, the SQL transfer components
can be exercised with:

```shell
node scripts/database-transfer/legacy-pglite.mjs /old/profile/server-db /backup/export.sql
/absolute/path/to/cantrip-server --database pglite --data-dir /new/profile \
  --migrate-only --restore-sql /backup/export.sql
```

Local macOS checks transfer actual PostgreSQL 18.3 WASM PGlite data into native
PostgreSQL 17.5 PGlite and both PostgreSQL deployment modes. All 115 table
snapshots and four sequence states match, including the real migration journal,
large integers, precise numerics, JSONB, bytea, arrays, generated columns,
Unicode and microsecond timestamps. Snapshot queries explicitly use UTC on
both sides to compare stored instants. Every one of the source profile's 1,665
original files retains its bytes and permissions.

A second fixture applies the actual first 233 migrations, seeds a valid
worker/chat/root cycle and then exports it. The native restore applies the
three pending migrations and matches a separate copy upgraded by the actual
Node migrator. Late import errors, a failure after earlier pending upgrades,
and replay into an existing destination leave destination state intact.
Actual invalid-value errors expose SQLSTATE without logging exported values.
A failed private PostgreSQL load closes its postmaster before returning, so an
immediate retry does not race parent-death shutdown. Two concurrent native
restores share the startup migration transaction lock: actual blocked-query
witnesses prove serialization, one succeeds and the other rejects the existing
destination while the retained snapshot stays identical.

Interruption tests kill the native command only after a SQL-written filesystem
witness proves execution. The historical case pauses inside the conversation
migration after earlier upgrades execute. Restart observes no partially
committed application state, and an identical retry succeeds on all stores.
An external PostgreSQL backend may retain the interrupted query until it
finishes and detects the lost connection; these checks include that eventual
rollback instead of inferring it from the client's exit alone.

These are SQL transfer components. The complete-profile components described
below add file/key transfer, persistent backend selection and representative
post-write reverse conversion. Packaged upgrade integration and full product
rollback remain unfinished. Normal builds continue to select the Node server
and Node worker.

## Native logical export and representative post-write rollback

The Rust executable now accepts `--migrate-only --export-sql <new file>` for
native PGlite, private PostgreSQL and external PostgreSQL. It opens the selected
database, obtains a real native pg_dump export, and exits before migrations,
local-user refresh or HTTP/background services start. Supply `--pg-dump-path`,
or use the configured PostgreSQL binary directory or PATH. Bundling those native
client/runtime assets remains packaging work.

```shell
/absolute/path/to/cantrip-server --database pglite --data-dir /native/profile \
  --migrate-only --export-sql /backup/native.sql \
  --pg-dump-path /absolute/path/to/pg_dump
```

Native PGlite exposes an exclusive wire-session guard through a small local
pglite-rs patch. It retains the existing session mutex without issuing BEGIN;
pg_dump establishes its own snapshot and transaction settings. Dropping the guard
queues rollback before another caller can proceed. A real SQL-written filesystem
witness verifies cancellation during execution. Upstream source, MIT license and
patch provenance are retained under `cantrip_server_rs/third-party/pglite-rs`.

PostgreSQL exports use a temporary loopback relay authenticated by a random
startup token. Rust opens the actual backend connection with its existing TLS
connector and forwards the PostgreSQL protocol. The client retains configured
login credentials, startup options, host choices and session-attribute selection.
The TLS matrix uses a held relation lock to identify the actual pg_dump backend
and checks `pg_stat_ssl` while that backend is blocked. Eleven SSL-on/off and
omitted/empty/disable/prefer/require/verification cases pass locally. Wider URL
option and supported-platform acceptance remain required. A real startup-role
case found that URL form encoding sent spaces as literal plus signs to the Rust
PostgreSQL driver. Retained query values now use percent-only encoding; role,
login identity and space/plus/Unicode application-name results match the actual
Node driver. Export uses the configured login identity while preserving startup role
and session-authorization options. The final eleven-case TLS regression also passes after this correction.

The SQL preparer removes only matching generated header/footer guard commands and
adapts only the generated transaction-timeout prelude for older destinations.
An actual native 17.9 dump with its guard key inside multiline TEXT and a SQL
function restores exactly, including CRLF guard variants, large numbers, bytea,
SQL NULL and JSON null. A private staging file is synced and published without
overwriting an existing path. Actual missing-executable and restricted-role SQL
failures leave no published file. Default error rendering stays redacted; an
explicit diagnostic consumer verifies that the original SQL failure is retained.

Current-schema and genuine 233-migration fixtures pass logical transfer into all
three Rust backends and back into JavaScript PGlite. Every one of 115 table
snapshots, four sequence states, the literal function result and NULL distinctions
matches. The expanded scenario signs into Rust with password authentication,
initializes protection records, creates a workspace and promotes it with a
revision fence. After native export and restore, the actual Node server accepts
the Rust-issued session and CSRF token, reports the same server ID, returns the
complete workspace and commits the next revision. This passes on all three
stores for both schema histories. A mixed-version follow-up also passes with
pg_dump 18.6, private PostgreSQL 18.6, external PostgreSQL 16.15 and native
PGlite 17.5. The 146-test native regression passes across 64 groups without
ignored tests before the final role/URI correction; the role and TLS suites
exercise the corrected connection path afterward.

An instrumented native client pauses only after the real pg_dump emits an INSERT
for the fixture table. Killing the server at that boundary publishes no partial
file; the observer and real dump client exit, private staging is identified and
removed, the original state reopens, and a normal export/reverse restore succeeds.
This is an actual export interruption scenario, alongside the existing SQL import
and pending-migration SIGKILL/retry checks.

The final strict all-target Clippy check passes. The broad `pnpm check` exits 1
with 1,661 source-server tests passing, 57 skipped and two failures: the existing
provider-routing assertion at `local-foundation.test.ts:7218`, and a five-second
account-resource-usage timeout. The latter passes unchanged in isolation on both
this branch and clean Primary, with actual test durations of 2.28 and 2.29 seconds.
No deadline or assertion was relaxed, and the broad check remains non-green.

These results establish a representative database rollback subset. The
complete-profile components below extend it to file/key transfer and persisted
backend selection. Packaged upgrades and full product rollback remain unfinished.
The normal desktop, development and standalone paths continue to use the Node
server and Node worker.

## Early upload rejection lifetime

The Windows file-document comparison in run `41141260086` failed with
`ECONNRESET` while uploading the request above the 4 MiB operation limit. The
native parser dropped its unread request body on overflow. Hyper can then close
with unread TCP bytes before the peer receives the complete error response.

The parser now bounds collection itself, sends the existing 413 response with
the Node parser's `Connection: close`, and discards remaining frames without
collecting them. An abandoned rejected upload is released after five seconds.
Neither response delivery nor advertised-length rejection waits for upload EOF.
The limit, error contract, authorization and worker dispatch behavior remain in
place. Unsupported oversized media types retain their existing 415 selection.

Native tests exercise an actual bounded-channel upload, an advertised-length
rejection without sending body bytes, cleanup with a paused clock, and a real
loopback HTTP connection that receives its complete response before finishing
the upload. The real Node/Rust file-document fixture retains its original cases
and adds an 8 MiB streamed request plus exact connection-close assertions.
The client still fails on TCP resets and incomplete responses without retrying.
Local comparisons pass 40 anonymous and 42 account observations per runtime
on each of native PGlite, private PostgreSQL and external PostgreSQL, with six
worker commands per profile. All 31 native library tests, the JSON/WS comparison,
the five upload-client tests and strict all-target Clippy pass. The three new
lifetime/loopback tests compile and fail against the original parser, then pass
with the fix. Supported-platform results remain required; local evidence alone
does not close the Windows failure.

Run `41157035912` also exposed a Windows compiler error in native SQL export:
the TCP connection future inferred its error type only from a Unix-only branch.
Its TCP result now explicitly uses `std::io::Error` on every platform. This fixes
the diagnosed inference path; actual Windows compilation and export acceptance
must be observed in the subsequent platform run.

## Native dump byte preservation on Windows

Run `41157865174` passed the native upload tests on Windows, then its migration
job caught a distinct native export defect: LF bytes became CRLF inside both
stored text and SQL function bodies during the reverse transfer. Artifact
`13025514562` was retained with its verified uploaded ZIP SHA256
`eca40b2852e6d92570e9705aa494c4959e14d64a7baa765656cc1672a49ca0ff`.
The exact table/function comparisons remain in place.

Native pg_dump now produces gzip-compressed plain SQL on stdout. PostgreSQL's
[Windows output setup](https://github.com/postgres/postgres/blob/REL_17_9/src/bin/pg_dump/pg_backup_archiver.c)
explicitly selects binary stdout for compressed plain output. Rust decodes the
gzip stream and publishes the existing plain SQL export. It does not rewrite
newlines in SQL or row values. The added Rust dependencies were already resolved
in the lockfile; no package versions change.

The dump-row interruption observer decodes the real child's gzip stream before
recognizing the actual fixture INSERT, then forwards gzip from Rust's binary
stdout. Its real-row witness, process cleanup and unpublished-destination
assertions remain. The shared transfer fixture additionally contains original
CRLF and bare CR beside LF and Unicode in its SQL function value. A dedicated
actual pg_dump test restores in a fresh process and compares exact mixed-newline
bytes in both the table value and function result. PGlite cannot reopen after
close in one process, so this test uses the same process boundary as the CLI.

Local current and historical-schema (233 of 236 migrations) all-store transfers,
password-authenticated Rust writes,
Node post-write rollback, real-row interruption/retry, eleven TLS cases and
restricted-role redaction pass with compressed transport. Current supported-platform outcomes must be observed separately. No complete profile,
packaged migration or full replacement acceptance follows from this fix.

## Logical profile transfer and durable backend selection

The native CLI can export a stopped installation's database and opaque files
as one directory bundle, then restore it into a new profile root. The bundle
contains logical SQL, a versioned manifest and copied files with SHA256/length
records. It retains unknown regular files, materializes file references and
preserves empty directories, executable bits and file modification times.
Physical `server-db` and `postgres` engine directories are excluded. Paths use
portable forward slashes; unsafe paths, duplicates, directory cycles and changed
SQL/assets fail without publishing the destination.

```shell
# Stop the source server before exporting its database and files.
node scripts/database-transfer/legacy-profile.mjs /old/profile /backup/profile-bundle /absolute/path/to/cantrip-server
/absolute/path/to/cantrip-server --data-dir /new/profile --database pglite \
  --migrate-only --restore-profile /backup/profile-bundle

# After Rust has accepted writes, export its current database and files.
/absolute/path/to/cantrip-server --data-dir /new/profile --migrate-only \
  --export-profile /backup/after-rust --pg-dump-path /absolute/path/to/pg_dump
node scripts/database-transfer/legacy-profile.mjs --restore /backup/after-rust /rollback/profile /absolute/path/to/cantrip-server
```

Use `--database bundled-postgres --postgres-bin-dir <directory>` or an explicit
`DATABASE_URL` to restore into the other backends. A bundle carries its source
mode as the default; external PostgreSQL credentials must be supplied separately.
Successful restore writes private `server-database.json` and profile-receipt
files. Normal Rust startup reads the stored backend, connection and binary path.
Explicit backend inputs retain precedence. `--migrate-only --remember-database`
records a selection only after the actual database setup succeeds; a failed
open leaves the previous selection intact. No metadata capability probe replaces
the real open. Stored external URLs contain credentials and require the same
protection as the installation's existing key/configuration files.

Restore copies verified files and creates local storage inside a private stage
in the destination's parent. Database restore and pending migrations commit
together with a manifest-specific import receipt. It closes sessions and owned
postmasters, restores the launch working directory, syncs the profile and
publishes the directory exclusively. Even an existing empty destination is
preserved. Unix staging directories are explicitly restricted to owner access
before any profile data is written, independent of the native engine's umask.
The JavaScript reverse converter is an offline bounded operation; native serving
and background work never invoke it.

Local macOS tests pass the complete Node-profile → each Rust backend → Node-profile
path. All 115 table snapshots, four sequence states, SQL functions, mixed newline
bytes, SQL NULL versus JSON null, large integers, precise numerics and opaque
file bytes match. The original session/CSRF, server UUID, encryption key and
encrypted workspace survive. Rust commits workspace revision 2; the actual Node
server reads that state and commits revision 3. Original source files and bundle
bytes remain unchanged. Restart tests verify all three remembered backend modes,
explicit external overrides and retention of the prior selection after a real
missing-executable setup failure.

Fault cases kill the importer only after an actual SQL filesystem witness. No
partial profile appears, the private postmaster exits after its owner dies, and
retry succeeds against the same destination/external database. A PostgreSQL
protocol proxy holds the actual COMMIT acknowledgement after a direct database
query confirms the durable import receipt. The killed importer publishes no
profile. A separate Rust server then accepts a real HTTP write; retrying the
original bundle preserves that newer write and publishes the profile. Late SQL
exceptions roll back the load, retain SQLSTATE/private diagnostics and expose no
fixture SQL values in ordinary native or legacy-converter diagnostics.

The local complete-profile suite passes in 94.73 seconds; eleven native profile
file/configuration tests and strict all-target Clippy also pass. Linux/macOS/
Windows migration jobs now include these profile checks, but this milestone's
new platform outcomes still require observation. Earlier Windows raw-SQL
current/historical/reverse-transfer reports from run `41160107203` were downloaded,
checked against uploaded ZIP SHA256
`4bff8c251e44489c948bacae50cea021bd482b38aa37cb7907a02f674b78ad96`
and inspected successfully; they do not validate the newer profile publisher.

The final complete-profile regression passes in 100.81 seconds after wrapping
converter setup/cleanup failures in the same private diagnostic boundary.
Stored-backend restart checks also cover an empty `DATABASE_URL` environment
template: it retains the saved external connection. All 977 actual Node/Rust
configuration cases match. The broad `pnpm check` exits 1 after 500.85 seconds
with 1,662 source-server tests passing, 57 skipped and the retained provider
selection assertion failing at `local-foundation.test.ts:7218`. Server, worker,
shared package and dependency sources are unchanged from the merged baseline;
the repository-wide check is not green.

This CLI component requires stopped sources, trusted logical bundles and new
destination directories. It does not yet activate an existing installation in
the desktop launcher. A crash after final publication may leave a completed
profile without the command's acknowledgement; a retry refuses the existing
directory and preserves it. Hard-killed imports can leave private temporary
directories that need owned-stage cleanup. Historical physical PGlite runtime
versions, packaged upgrade/rollback supervision, all product flows and full
supported-platform acceptance remain required. Normal development, standalone
and desktop builds still use the Node server and worker.

The complete Windows migration job in run `41163777652` passes at profile head
`40bdce5e58884d72928037b8c2c238d32fb009e1`. All six uploaded JSON reports were
inspected after checking ZIP SHA256
`748fac193d59fd521c6143c6b1cab5a846249dc9f35a100057f09c12d1c7f0fe`.
This includes exact 115-table/four-sequence profile transfer and reverse
comparison, original sessions/keys/files, actual Node revision 3, real process
interruption/private-postmaster cleanup and the held-COMMIT-acknowledgement case.
It validates the Windows profile publisher at that head, not packaged activation.

That run's Linux profile test failed during native PGlite export: the new
harness ignored `CANTRIP_TEST_PG_DUMP_PATH` and selected the configured PostgreSQL
16 server directory's client. It now passes the requested dump-client path to
the existing CLI option, independently of the database server directory. There
is no version probe or fallback. An actual source-built pg_dump 16.15 reproduces
the failure against native PGlite 17.5 while the requested client 18 is left
unused. Follow-up tests keep that incompatible default client present and use
the explicitly configured native client for the export. The corrected all-store
profile suite passes in 94.64 seconds with the same default client still present;
an actual wrapper witness records all three exports invoking pg_dump 18.6. All
table/sequence/function/file comparisons and interruption/rollback assertions
remain. Linux verification of this follow-up is still required.

## Remaining delivery sequence

1. Establish cross-platform foundation results and legacy PGlite logical
   export/import evidence; evaluate native runtime limitations against actual
   operations before selecting final packaged database artifacts.
2. Finish shared wire validation, version/build identity and runtime logging;
   configuration parity is implemented and requires cross-platform acceptance.
3. Port authentication, sessions, tenant authorization, encryption envelopes,
   worker enrollment and revocation.
4. Extend the actual browser-to-full-worker Ollama operation to the remaining
   resource/execution flows, ordered events, reconnect continuity and committed
   App Live notifications across supported artifacts and platforms.
5. Port durable account, provider, policy, project, workspace, source, worktree,
   file, tab, surface, chat, attachment, usage and administration domains.
6. Port native admission/receipts, history, managed queues, settings/permissions,
   handoffs, Tasks, retries, automations, leases and recovery.
7. Complete streaming, WorkerLink, tunnels, attachments, logs, Redis routing,
   multi-instance failure recovery and any claimed mixed-version rollout.
8. Prove existing-installation upgrades, interrupted conversion and post-write
   data-preserving rollback across the supported storage modes.
9. Integrate desktop supervision, native/container releases, Winterhold
   deployment tooling and the supported platform/storage product-flow matrix.
10. Switch defaults and remove the production Node server after acceptance.

Every current route, worker command and durable table in
`security/server-route-inventory.json` remains in scope. Add behavioral cases
as each domain is ported; passing foundation cases does not close other rows.
Also retain the encryption inventories, operational contracts and migration
history as requirements while the implementation changes language.

The machine-readable ledger is `security/rust-server-coverage.json`. Every
inventory row inherits its category's explicit default until overridden.
Applying a table's schema does not establish its domain behavior; local tests
and configured CI do not establish platform acceptance.

## Completion evidence

Completion requires merged milestones and an integrated commit, a complete
contract ledger, actual deployment/storage/platform results, migration and
post-write rollback evidence, native/container artifact paths and checksums,
desktop and representative Winterhold deployment results, and representative
performance/recovery measurements. No production runtime path may delegate to
Node, Bun, Deno or the old TypeScript server. Node may remain for the unchanged
worker, frontend builds, compatibility tests and bounded legacy conversion.

No complete replacement, production cutover, existing-data migration,
packaged release or Winterhold deployment is claimed by the foundation work.

## Account and session milestone

The current implementation adds the existing `/version`, `/api/bootstrap`, and
eight authentication endpoints: registration, login, session lookup,
reauthentication, mobile grant creation/exchange, logout and logout-all.
Authentication modes, origin/CORS/security headers, body parsing and limits,
account pins, session-cookie conflicts, CSRF, rate limits, configured
administrators, owner/member provisioning and security audit writes are ported.

Password hashing uses the existing Argon2id parameters and accepts retained Node
hashes; Node also verifies Rust-produced hashes. Session token and CSRF hashes,
secure/partitioned cookies, mobile code formats and single-use transactions
retain their existing contracts. Session revocations publish internal events;
the live, WorkerLink and attachment transports still need implementations that
consume those events before transport-wide revocation can be considered done.

The Rust build embeds metadata from the authoritative existing version resolver
at build time. Node is a build dependency, never a server runtime dependency.
Wire responses retain the protocol schema's existing validation and field
stripping, including its rejection of suffixed synthetic versions.

Native database error statements are suppressed at the engine boundary. Tests
execute an invalid SQL statement containing a private sentinel and inspect the
native process output and private PostgreSQL log for disclosure. Query errors
remain available to callers; this does not complete the remaining operational
logging APIs or their broader privacy acceptance.

The socket harness runs the actual Node and Rust servers against independent
fixtures. Profiles cover anonymous, password and account modes, secure dual
cookies, licensing, trusted proxies and rate limits. It compares full response
bodies and security/cookie/CORS headers, validates entropy and CSRF derivation,
and checks identities, sessions and expiration consistency across restarts.
The same scenarios can run with PGlite, private PostgreSQL or external
PostgreSQL. No scenario connects to an ordinary developer database.

An external-PostgreSQL transition scenario uses one disposable populated
database sequentially: Node creates an owner/session, Rust retains them and
creates accounts/mobile sessions, Node reads those writes and verifies Rust
password hashes, then Node observes Rust session revocation. This establishes
account/session compatibility after Rust writes, not full-server rollback.

Run the socket matrix with a PostgreSQL binary directory supplied for the two
PostgreSQL modes:

```sh
pnpm server:rust:auth:compatibility --report .qa/rust-server/auth-pglite-http.json
pnpm server:rust:auth:compatibility --database bundled-postgres --report .qa/rust-server/auth-bundled-http.json
pnpm server:rust:auth:compatibility --database postgres --report .qa/rust-server/auth-external-http.json
```

The test-only `database-fixture` example owns isolated PostgreSQL clusters for
the Node reference and external mode. It is not distributed with the server.
The native repository tests additionally cover concurrent mobile consumption,
legacy CSRF rotation, settings/workspace provisioning, configured-administrator
updates and PGlite/PostgreSQL retained state. Request-schema tests execute the
actual TypeScript protocol schemas rather than reproducing their expectations.

The session milestone merged as [PR 2277](https://github.com/ArcaneArts/Cantrip/pull/2277),
commit `d759084a30cba3e8641878bd51b69a7c936c4155`. Its
[observed workflow run](https://github.com/ArcaneArts/Cantrip/actions/runs/40254773601)
passed on Linux, macOS and Windows, including all three database socket suites,
retained-state tests, configuration contracts and database/process recovery.
This establishes that milestone's platform results, not full product readiness.

## Encryption registry and account security

The current slice adds the account encryption profile, initialization,
migration-status updates, password rewrapping, principals, approvals,
revocations, and grant APIs. It stores existing opaque envelopes and their
metadata in the original schema. Password-hash and wrapper changes commit
atomically under the existing profile revision check. Revoking a principal
cascades to its active grants; retained revoked grants still prevent duplicate
component/revision inserts. Worker-principal repository operations retain
credential/owner checks and atomic identity rotation, while the worker
enrollment/bootstrap HTTP integration remains unported.

Account session lists, owner/admin audit queries and license-whitelist APIs
are also present. Session connection indicators currently cover the current
session; additional connected sessions require the remaining live transport.
Mutation auditing for implemented routes now follows body/header completion,
including HEAD and response errors, with owned shutdown draining. Remaining
domain hooks, operational logging and packaged/platform acceptance are still
required.

`contracts/security.json` is generated from 36 actual protocol exports by
`scripts/server-rust/contracts.mjs`. The native validator preserves defaults,
stripping/strictness, issue paths/order/messages, coercion, unions and explicit
custom refinements. Unknown exporter operations fail the development export;
normal server startup never invokes the exporter or JavaScript. Differential
tests execute the actual protocol independently, compare the generated manifest
and run 27,252 mutation cases, including lone UTF-16 code units in keys and
values. The native JSON representation retains UTF-16 and JavaScript number and
property-order semantics. A further 69,647 JSON round trips compare every
UTF-16 code unit and deterministic floating-point edge cases with Node.
Global malformed/deep-JSON behavior and the remaining domains' schema semantics
still require acceptance; these counts do not close those contracts.

The security socket harness compares entire responses, security/cache/CORS
headers, cookies, errors, tenant boundaries, revision conflicts and retained
state. It uses the existing client crypto implementation to create real HPKE
and password wrappers, fetch and decrypt them, change passwords without
changing the master key, reject wrong-owner/tampered wrappers, and repeat after
restart. External PostgreSQL additionally runs Node initialization, Rust
password/wrapper writes, and Node reopening those writes with the original
client keys. This is encryption/account evidence, not full-server rollback or
legacy PGlite conversion.

```sh
node --import tsx scripts/server-rust/security-compatibility.mjs --report .qa/rust-server/security-pglite-http.json
node --import tsx scripts/server-rust/security-compatibility.mjs --database bundled-postgres --report .qa/rust-server/security-bundled-http.json
node --import tsx scripts/server-rust/security-compatibility.mjs --database postgres --report .qa/rust-server/security-external-http.json
```

Supply `CANTRIP_TEST_POSTGRES_BIN_DIR` for the PostgreSQL fixtures. These
databases and the client key material are disposable. Linux/macOS/Windows CI
executes the same tests; configured checks are not passing evidence.

Worker enrollment/control, live transports, account usage and other resource
and execution domains, usable legacy conversion/rollback, desktop packaging and
Winterhold delivery remain required work.

## Native JSON lifetime and authentication boundaries

An actual Node/Rust comparison found that a roughly 4 KiB request containing
2,048 nested arrays aborted the native process with a stack overflow over both
HTTP and App Live. Node accepted the HTTP enrollment request after stripping its
unknown field and returned the existing invalid-message error over Live, while
remaining healthy. The native parser previously reparsed each subtree through a
fresh Serde visitor, and tree clone/drop/serialization also recursed.

The native wire representation now validates syntax once with `RawValue`, then
constructs the tree iteratively. Clone, equality, serialization, destruction and
HTTP poison-key scanning also use explicit stacks. It retains UTF-16 strings,
JavaScript numbers, duplicate-key replacement and ECMAScript property ordering;
the existing transport byte limits and endpoint schemas still decide admission.
No new nesting rejection limit substitutes for parsing valid inputs.

Authentication requests now use the same exported native protocol contracts as
the other ported APIs. They retain raw UTF-16 through validation, including issue
keys/messages, and convert explicitly to UTF-8 at password hashing and database
text boundaries. This removes the recursive conversion of an entire unvalidated
request into `serde_json::Value` and the separate handwritten auth validator.

The socket suite compares 52 HTTP and 27 WebSocket cases per backend, including
20,000-level accepted unknown fields, deep wrong types, truncated JSON, poison
keys, escapes, overflowing numbers, duplicate keys and lone UTF-16 units. It
checks subsequent health and usable Live initialization/ping/close. A native
test uses a 256 KiB thread stack for 32,768 nested arrays and 12,000 alternating
object/array pairs, including clone, equality, stringify, Serde output and drop.
These tests and all three storage socket profiles passed locally on macOS arm64;
the changed implementation still requires its own supported-platform CI results.

```sh
pnpm server:rust:json:compatibility --report .qa/rust-server/json-pglite-http.json
pnpm server:rust:json:compatibility --database bundled-postgres --report .qa/rust-server/json-bundled-http.json
pnpm server:rust:json:compatibility --database postgres --report .qa/rust-server/json-external-http.json
```

Supply `CANTRIP_TEST_POSTGRES_BIN_DIR` for disposable PostgreSQL fixtures. Live
parser cases run before enrollment mutations: the latter still lack some
resource-domain publications, which a retained comparison exposed as divergent
Live cursors. Remaining schemas, coercion/refinement boundaries, authenticated
serialization, domain publishers and complete product acceptance remain required.

## JSON socket cursor observations

The JSON milestone PR 2282 passed the full native suite on Linux, macOS and
Windows, including small-stack tree lifetime tests. Its full Linux/macOS jobs
passed. Windows failed the new PGlite socket suite when a ready response had
Node cursor 1 and Rust cursor 0; later Windows suites did not run. The failure
is retained in run 40396215390. Follow-up PR 2283 subsequently passed all three
complete platform jobs in run 40405725752 on tested head
`2bbd667b17409c9b5a11ed2efdf8f1538722f4eb`, including the cursor controls and
all three JSON storage suites. All 90 uploaded reports were retained before
merge `0799dc6814e441e46ce00437c2b276896848c93c`. Those results cover the JSON
follow-up, not this newer PostgreSQL implementation or complete replacement.

A real subscribed Node client reproduced a separate `account-resource-usage`
publication advancing its cursor. Usage accounting and those native publications
remain unported. Publication timers differ between independently launched
processes, so comparing their absolute counters inside parser cases also makes
those cases depend on an unrelated domain and the speed of the host.

The JSON suite now installs a real observer with retained replay, preserves raw
ready/pong counters, and proves each counter against a contiguous publication
chain for that process. A counter cannot precede events observed before its
request. Only the exact usage invalidation shape is accounted separately;
unexpected resources, changed server epochs, missing ordinals and stale
counters fail. Raw counter/publication differences remain in the output and
coverage ledger. This is not acceptance of the unfinished usage domain.

The suite lowers the real usage flush threshold and waits for a real reference
publication before later ready messages, deliberately exercising the original
failure on every platform. A separate real-Node control suite verifies valid
accounting and rejects stale/future counters, a changed epoch and an actual
worker mutation publication. It runs with the same supported-platform workflow:

```sh
node --import tsx scripts/server-rust/live-cursor-contract.mjs --report .qa/rust-server/json-cursor-contract.json
```

The reference notification-order and authentication-shutdown fixtures give cold
WASM, full migrations and application initialization the same 60-second startup
budget as the real-server harness, and report their actual setup durations. The
connection/shutdown test bodies and behavioral polling deadlines stay unchanged.

## Standalone Chat catalogs and scratch jobs (in progress)

Rust now implements standalone creation and active/archived catalogs through
`POST /api/chats`, `GET /api/chats?context=standalone` and
`GET /api/chats/archived?context=standalone`. Creation keeps the opaque title,
locale-sorted compatible worker choice, online preferred worker, inherited model
and reasoning settings, archived positions, and the transaction containing the
Chat, scratch root, runtime session, suspended execution lane and provision job.

The scratch repository retains identity-sensitive admission, separate commits
for deletion enqueue and failure settlement, leases, fenced completions,
interrupted recovery, retryable reconnect, reconciliation targets, missing roots,
archive expiry and durable deletion tombstones. Its executor is connected to
startup, worker reconnects and shutdown draining; it dispatches at most four jobs,
renews leases every 30 seconds, uses the existing worker command bus and emits
owner-scoped Chat invalidations after durable transitions. Interruption, expiry and shutdown-fault
acceptance remains required.

Local Node/Rust comparisons pass 114 repository operations and 89 state snapshots
on native PGlite, private PostgreSQL and external PostgreSQL. Real trigger failures
check partial commits and rollback of all five creation records. Concurrent
claims retain unique job and command ownership, and reopening each backend retains
its exact state. A failing native prototype committed provision completion before
DTO validation; the retained failing report demonstrated that mismatch. Provision,
deletion and purge now validate inside their original transactions.

The HTTP/Live suite passes all nine local database/authentication combinations:
26 anonymous, 27 password and 28 account observations per implementation, with
four provision outcomes, an actual worker reconciliation and eight ordered Chat events per profile.
It retains complete creation/executor state and verifies invalid result,
worker-error and routing-handle rejection. Source ordinary duplicate creation
returns 500 because its regex sees Drizzle's top-level statement/parameter message,
rather than the PostgreSQL cause. Rust preserves that behavior and the 409 case
when those rendered parameters contain the matched words, without logging opaque
parameters. The separate PGlite message-predicate comparison also passes.
The protocol oracle passes 12,149 exact cases across nine Chat/scratch schemas.

Actual external-PostgreSQL lease probes pass both implementations in all three
auth modes: a held job renews after about 30 seconds, extends the stored lease
by another two minutes and retains its command, attempt, revision and start time.
The six-job capacity probe also passes all auth modes: four jobs run while two
remain queued, each released slot dispatches the next job, and all six complete
once with their original identities and ordered invalidations.

The broad `pnpm check` finishes with 1,662 source-server tests passing, 57 skipped
and the existing provider-selection assertion at `local-foundation.test.ts:7218`
failing. Server, worker, shared package and dependency sources are unchanged.
This does not make the broad check green.

This milestone does not finish Chat behavior. The lifecycle and metadata port
is described below; forks, messages, execution queues, history, Tasks and
Goal/automation continuity remain required. Actual client/full worker scratch
filesystem tests, lease expiry and interruption faults, supported platforms, Redis
coordination, packaged activation and default cutover are also unfinished.
Normal desktop, development and standalone builds still select the Node server.

## Chat lifecycle and metadata (pending platform acceptance)

The native Chat repository and HTTP routes now implement explicit project Agent
archive, legacy project deletion, standalone archive/restore/permanent deletion,
runtime selection, encrypted title updates, completion acknowledgments, composer
drafts, file references and opaque standalone file operations. Empty project
Chats are deleted by the legacy route; history-bearing Chats are archived, and
explicit Agent archival retains empty conversations. Standalone archival retains
the Chat and root for 90 days; permanent deletion creates the existing durable
scratch deletion tombstone before cascading Chat-owned rows.

The repository comparison executes the actual source and native implementations
on separate databases: 66 operations and 98 snapshots pass on native PGlite,
private PostgreSQL and external PostgreSQL. It checks running/approval conflicts,
tenant boundaries, task behavior, archived idempotency, all three layout profiles,
anchor/label updates, removal from multiple owned windows, cancellation of a
pending detach, opaque draft retention and exact backend reopen state. The IDE
profile restores Chat tabs into the right dock; hybrid and agent profiles use
the center. Other resource placement retains its existing behavior.

Transaction boundaries remain observable. Invalid archive/restore DTOs roll back
both Chat and scratch-root writes; invalid project restore DTOs also roll back
legacy placement/revision changes. By contrast, a title update whose response
fails validation retains its already committed write, matching the source.
Completion acknowledgments change only the unread flag, and composer drafts do
not change the Chat's general update timestamp. Seventeen Chat/scratch protocol
schemas match 13,777 source parsing, issue and rendered-error cases. The archive
result refinement also retains JavaScript's behavior when invalid dates produce
NaN rather than an additional ordering error.

`standalone-chat-http-compatibility.mjs --lifecycle` extends the catalog/executor
suite with actual project and standalone HTTP flows, unchanged worker transport,
stored-state comparisons and ordered Live observations. It checks archive and
restore after worker error or invalid output, archived access restrictions,
foreign users, stale file bindings, offline workers, encrypted drafts and
permanent deletion completion. A controlled delete command separates the durable
tombstone response from the worker's completion. A separate archive command is
held until its actual HTTP caller disconnects, then released; the archive
publication and later restore prove that admitted work survives the caller.

The source's successful-response invalidation hook is preserved in addition to
direct publications, including duplicate completion invalidations. Draft writes
do not publish metadata changes; successful write/remove operations publish two
Chat-scoped file invalidations. Each authentication profile retains 43 standalone
Chat events, 25 project lifecycle events and 16 lifecycle worker commands for
comparison. Running/approval HTTP probes establish state after startup through
the disposable external PostgreSQL connection, since source startup recovers
preexisting running rows. Repository probes cover both conflicts on all three
storage modes; no second process opens a live PGlite database.

All nine local storage/authentication combinations pass the expanded HTTP suite.
PGlite and private PostgreSQL compare 101 anonymous, 102 password and 113 account
observations per implementation; external PostgreSQL adds the four actual
post-startup running/approval conflict responses per profile. Project HTTP state
is read back after shutdown and compared alongside the earlier standalone state.
Strict all-target Clippy, generated-manifest equality, formatting, large-file and
server-boundary checks pass. The broad `pnpm check` finishes in 501 seconds with
the same existing provider-selection failure at `local-foundation.test.ts:7218`
(1,662 source-server tests pass, 57 skip, one fails). Source server, worker, shared
package and dependency files remain unchanged; the broad check is not green.

Actual existing-client/full-worker filesystem acceptance, managed-share failure
probes, additional lock/interruption boundaries, supported-platform artifacts,
Redis coordination and packaged activation remain required. Forks, messages,
execution, queues, history, Tasks and Goal/automation continuity are unfinished.
This milestone does not switch the normal Node server build or packaging paths.

## Protected Chat forks (pending platform acceptance)

The native server now serves `POST /api/chats/:chatId/fork` for project and
standalone Chats. It preserves encrypted title validation, Task relocation errors,
offline and missing-source responses, message-prefix selection, 201/202 response
differences, placement and post-response invalidations. Source messages stay
opaque to the server. The existing worker reprotects them for new message IDs in
batches of at most 100, with the existing `fork:<source-id>` idempotency keys.

Project forks read their source in a transaction, release it before worker
dispatch and compare a fresh read in the write transaction. The comparison
includes source Chat, destination worktree and selected messages. It retains
JavaScript millisecond Date equality. The current maintained Node 24.22 reference
compares invalid Dates as equal; the follow-up below corrects the earlier local
24.14 behavior. The original failing prototype rejected infinite timestamps
before invoking the callback; both paths now preserve the source's order.
Creation of the Chat, runtime session, suspended lane, optional legacy placement,
messages and behavior fork count shares the original transaction. Archived Chat
positions count toward ordering, nonprimary worktrees retain exclusive suspended
lanes and starting heads, and copied metadata retains its original attribution.

Standalone forks keep their different commit model. They call the existing
standalone creator after reprotection, then copy settings and messages separately.
Later failures delete the new Chat; its already committed provision job remains.
If cleanup itself fails, its SQL error wins and the earlier records remain,
matching the source. Both paths keep the parameterized bulk message insertion,
SQL NULL behavior and actual driver failures for oversized parameter lists.

The real repository comparison passes 48 operations and 82 snapshots per backend
on native PGlite, private PostgreSQL and external PostgreSQL. It checks ownership,
history prefixes, non-opaque refusal, source/destination changes during the worker
callback, Date precision, classifications, attribution, layout/lane state, forced
SQL failures, cleanup failures and exact reopen state. A 4,000-message copy
actually attempts the oversized bulk operation and checks rollback and continued
database usability. No capability probe substitutes for that operation. Twenty
Chat/scratch/fork schemas match 15,980 protocol, issue and rendered-error cases.

The HTTP suite passes all nine local backend/authentication combinations using
the unchanged worker transport and production `protectChatMessage` and
`reprotectChatMessages` functions with a test-owned endpoint key provider. The
key stays outside both servers. Each implementation/profile compares 25 anonymous,
26 password or 27 account HTTP observations, 14 reprotection commands, 516
decryption/binding proofs and eight ordered Chat events. It checks a 205-message
history, 100-message batching, prefix copies, ordinary duplicate inserts, worker
errors/invalid results, Task/owner/offline rejection, standalone provisioning and
an admitted fork whose HTTP caller disconnects. Every stored copied message is
decrypted under its new ID, retains its expected plaintext and rejects the old
ID binding. Raw encrypted commands/state are retained alongside compared metadata;
the server diagnostic output contains no test plaintext sentinel.

A separate actual-source HTTP oracle verifies command-budget failures: the Rust
route preserves `429`, the error body and `Retry-After`, including the source
route's earlier duplicate-message classification when both conditions apply.

The broad `pnpm check` again finishes with the existing source provider-selection
failure at `local-foundation.test.ts:7218` (1,662 pass, 57 skip, one fails;
483 seconds). Source server, worker, shared package and dependency files are
unchanged. The separate Linux workspace-disconnect suite also has an unresolved
`ECONNRESET` failure in run `41170859141`, job `124448318451`; its uploaded
artifact was downloaded and SHA-256 verified for a separate follow-up. These
results do not establish a green broad check or platform acceptance.

The same run's Windows contracts job `124448318427` also exits during the PGlite
execution-target repository suite: the Rust fixture exits with code `3221225725`
while resolving a project. Its artifact and log are retained for investigation;
this fork milestone does not claim a Windows pass.

Full client/full-worker key provisioning and filesystem integration, supported
platforms, further interruption boundaries, Redis coordination and packaging
remain required. General messages, native history ingestion, execution queues,
Tasks, Goal/automation continuity and default cutover remain unfinished. Normal
builds still use the Node server.

## Controlled workspace admission caller connections

The Linux diagnostic reproduces the earlier workspace restart reset on iteration
nine of run `41176923583`, job `124466282896`. Its SHA-256-verified artifact
`13032917940` retains all eight successful iterations and the partial failing
password/Rust iteration. Socket 25 connected to the old server 41 milliseconds
before that process closed. After a new process started on the same port, the
shared global fetch pool reused that socket for the unchanged worker's heartbeat
125 milliseconds later and received `ECONNRESET`.

The controlled test caller now uses the existing `streamingHttpRequest` helper
with its own socket. Production servers and worker heartbeat behavior are
unchanged. Actual caller aborts, SQL lock/PID witnesses, durable admissions,
revisions, worker commands and same-port restart assertions remain in place.
Partial lifecycle evidence and optional HTTP connection tracing are retained
even when a scenario fails. The repeat driver stops at the first failure and
does not retry failed requests or scenarios.

Two local PostgreSQL iterations pass all twelve authentication/runtime scenarios;
the anonymous PGlite and private PostgreSQL lifetime suites also pass. Corrected
Linux run `41178019278`, job `124469506406`, passes all twenty iterations and
120 authentication/runtime restart scenarios. Its SHA-256-verified artifact
`13033962863` also proves that all 240 post-restart heartbeat and catalog requests
use connections established after the old process closed. The tested source
head is `5713c2f66bd30ea91c2733819f005d413ca5220f`. The required broad `pnpm check`
completes in 430 seconds with the existing provider-selection failure at
`local-foundation.test.ts:7218` (1,662 pass, 57 skip, one fails). This work does
not establish a green broad check, Windows acceptance or packaged activation.

## Protected messages and persisted turn reads (pending platform acceptance)

The native server now handles message listing, turn-aware pagination, encrypted
Agent appends and persisted native-history turn reads. The archive endpoint is
read-only: it neither dispatches to a worker nor requires a live history binding,
and it emits no mutation invalidation. An owner can read an archived Chat's
persisted turns. Multiple owned bindings for the same turn remain separate
candidates in binding order; a larger revision does not hide another binding.

The repository port includes plain, Task and encrypted append/upsert operations,
idempotency lookup, route attribution, headers, latest protected user lookup and
turn trimming. Agent writes retain the project/Chat locks and atomic message,
touch and DTO boundary. Plain and Task writes preserve their separately committed
steps, including the inserted row surviving a later touch or DTO error. SQL NULL
and JSON null retain their distinct attribution behavior. Committed canonical
history mappings return the existing message and reject conflicting identities;
reservations at revision zero do not claim canonical ownership.

The Source Agent idempotency comparison uses raw stored JSON ordering, while the
Task path parses its stored envelope before comparing. Tests retain that
observable difference rather than changing the protocol during the port. Input
validation, missing/foreign/archived lookup precedence, page-query errors, Task
write refusal and typed canonical-history errors are compared against real Node
HTTP responses. Turn pages retain the source's backward user boundary and
500-header search limit.

Local macOS repository checks compare 46 query operations and nine snapshots,
then 62 write/archive operations and eight snapshots per backend. Both suites
run their Rust fixture with a 1 MiB thread stack. The expanded state snapshots
include archive bindings and turns, and the actual backend reopen also checks
the complete archive response. Twenty-eight Chat schemas match 20,341 actual
protocol/issue/rendered-error cases.

Local macOS repository and actual HTTP/Live comparisons pass on native PGlite,
private PostgreSQL and external PostgreSQL. The HTTP suite exercises anonymous,
password and account authentication, production worker endpoint encryption and
actual endpoint decryption with test-owned keys outside both servers. Returned,
published and reopened Agent messages retain their expected content and reject a
wrong message-ID binding; server diagnostics contain no plaintext sentinel.
Task envelope persistence is checked separately and does not establish Task
endpoint encryption or ingestion acceptance.

External PostgreSQL additionally holds real project/Chat locks and observes the
blocked backend PIDs before disconnecting callers, admitting competing writes
or archiving the Chat. Admitted writes commit after their callers disconnect;
competing duplicate appends retain the source's one-success/one-error result.
Late archival refuses the write. A real trigger failure after INSERT rolls back
both the Agent message and Chat touch without publishing a message event. Actual
Live ordering is compared after these races as well as ordinary responses.

The current broad `pnpm check` exits 1 after 454 seconds: 1,662 source-server
tests pass, 57 skip and the provider-selection assertion at
`local-foundation.test.ts:7218` fails. A fresh focused run on clean Primary
`584a14af9` reproduces that same failure. This is retained baseline evidence,
not a green broad check. The Source server/worker implementation and dependency
files are unchanged by this milestone. The separate full formatting check
also reports 12 unchanged baseline files; focused formatting of this milestone
is checked separately.

Run the suites from the repository root, replacing DATABASE with pglite,
bundled-postgres or postgres:

```sh
node scripts/server-rust/cargo.mjs test --test chat_contracts -- --nocapture
node --import tsx scripts/server-rust/chat-message-repository-compatibility.mjs --database DATABASE
node --import tsx scripts/server-rust/chat-message-write-repository-compatibility.mjs --database DATABASE
node --import tsx scripts/server-rust/chat-message-http-compatibility.mjs --database DATABASE
```

The dedicated CI job runs these checks on Linux, macOS and Windows. Configuration
of those jobs is not platform acceptance. Canonical history ingestion, native
command execution, streaming, queues, approvals, Tasks, Goal continuation,
complete client/full-worker integration, Redis coordination, packaged activation
and default cutover remain required. Ordinary builds still use the Node server.

## Fork snapshot Date equality on the maintained reference runtime

Linux run `41179568205`, contracts job `124474015015`, exposed a real Source/Rust
mismatch. For a Chat with `updated_at = infinity`, Source Node 24.22.1 completed
reprotection and created the fork; Rust returned a conflict. Artifact
`13035533686` was downloaded and its ZIP SHA-256 verified as
`26de0e7f6b9bb4cf4325e81b82849750c73d3476fa092d59cab6282571a800bb`.
The same unmodified repository case fails locally under the exact CI runtime.

The earlier local reference was Node 24.14.0. Its `isDeepStrictEqual` rejects two
invalid Date instances. The official Node 24.22.1 executable instead considers
them equal, as does its
[Date comparison implementation](https://github.com/nodejs/node/blob/v24.22.1/lib/internal/util/comparisons.js).
The downloaded Darwin ARM64 runtime matches its official SHA-256,
`654ba79de6155647e22321932b45f2a1ccb705976cc337c9b8e278beb085a628`.
This corrects the earlier claim about Node 24 as a whole: the reference version
matters, and older 24.14 behavior differs at this boundary.

Rust now uses a private invalid-Date marker for the fork reread snapshot. It is
distinct from SQL null and valid timestamps, stays out of responses and stored
messages, and requires no Node runtime. Finite timestamps still compare at
JavaScript millisecond precision. A new oracle executes the actual reference
utility against 407 row comparisons, including null, both PostgreSQL infinity
values, Date range boundaries, offset-equivalent instants, submillisecond
precision, property ordering and changed JSON metadata. All comparisons match
Node 24.22.1 locally. Running the same oracle on 24.14 records 27 differing
comparisons rather than disguising the reference-version difference.

The expanded repository suite explicitly requires successful complete forks
for unchanged positive/negative infinity and for a change between two invalid
Dates. Valid-to-invalid and invalid-to-valid changes still reject after exactly
one reprotection callback. Complete table/sequence snapshots prove that only the
controlled callback timestamp mutation survives those conflicts. Existing
source/destination/message changes, encryption classification checks, SQL
failures, cleanup behavior and reopen assertions remain in the suite.

The new snapshot oracle is part of the Linux/macOS/Windows contract jobs.
Local checks do not establish platform or packaged acceptance, and the full
server replacement remains unfinished.

## Complete SQL lock witnesses in controlled message races

Windows message run `41183089946`, job `124484345954`, passed all three
query/write repository pairs and both PGlite/private PostgreSQL HTTP matrices.
The external PostgreSQL Source/password late-archive probe reached its expected
blocking-PID count, then failed because a sampled wait-event field was null.
Artifact `13036340964` was downloaded and its ZIP SHA-256 verified as
`0a4c68041870a2e7bfaf1431d1c14461de1c0833f0825ed7d177f7b786d8d67e`.
The failure occurred while collecting the complete lock witness.

The test observer now continues until both the expected blocker count and every
`Lock` wait event are present in the returned sample. It retains matching-count
samples with incomplete wait fields for diagnosis. The deadline, held SQL locks,
actual blocking PIDs, both final assertions, single HTTP attempts, caller-abort,
commit, rollback, encryption and ordered Live checks remain in place. This change
is confined to the controlled test caller; production behavior is unchanged.
A fresh Windows job must establish acceptance.

The current broad `pnpm check` runs for 523 seconds and again reports the Source
provider-selection failure at `local-foundation.test.ts:7218`: 1,662 tests pass,
57 skip and one fails. A fresh Node 24.22.1 run on clean Primary `c749612c0`
reproduces that assertion. Full formatting reports 12 unchanged baseline files;
changed-file Prettier passes. The earlier intermediate formatting run also
caught the edited ledger before its final formatting; the ledger is now fixed.
These results do not establish a green broad check or a deployable replacement.

Linux's dedicated message job in that run passes all three storage modes and all
nine authentication/backend profiles. Artifact `13035975785` contains nine JSON
reports, all inspected after verifying ZIP SHA-256
`ac61057e3a2fe2a7bd10d02eb00a24fa9e283650313861e2a42503bb06df14ff`.
The corrected observer also passes the fresh local external PostgreSQL matrix,
including all five races per runtime/auth profile. This scoped evidence does not
establish a Windows pass or packaged readiness.

## Existing Task client, full worker and native Goal execution

The local macOS acceptance flow now runs the existing browser SDK against each
server, through the unchanged production worker and bundled Codex 0.166.0. All
three storage modes pass 14 steps per implementation. The only controlled
execution boundary is a local public Responses model endpoint; native RPC,
threads, Goal tools, endpoint encryption, repositories and worker handlers are
real. This is not a complete UI or packaged-client acceptance claim.

The flow executes a direct Task, then plans and reviews another Task, finalizes
its approved plan, and completes its native implementation Goal. It compares the
actual native Goal tool result with the browser-decrypted objective and dashboard,
including the compiled implementation policy and approved-plan attachment path.
Planning waits for the previous dispatch to succeed, matching the existing UI's
admission rule. Native Goal activation and the saved encrypted server control
message are separate actual turns, both covered by the model endpoint.

A real quota-failure response produces a private failure with manual retry. The
existing browser retries the same Task and decrypts its completed result. Project
pause then keeps a queued admission unexecuted through both server and full-worker
restart. Unpause executes that saved admission once. Completed Task and Goal
transcripts, native thread identity and encrypted objectives survive restarts
without duplicate completed inference. Each implementation makes exactly nine
model requests and completes five worker shutdowns. No private content appears in
browser-to-server request bodies or server diagnostics.

The actual client uncovered the missing public project Chat list. Rust now
serves both active and archived project catalogs with Source ownership joins,
ordering and summary schemas. A separate exact HTTP suite passes all nine
storage/authentication profiles: 102 paired observations, including HEAD,
foreign/missing projects, archived Task experience, message counts and the
Source-derived 90-day retention deadline. Project Chat creation and the remaining
catalog/conversation APIs are still separate work.

The dedicated `actual-task-worker` CI job builds the production Codex runtime
using the verified release cache recipe, then runs all three database modes on
Linux, macOS and Windows. On Windows it builds Codex with MSVC before configuring
the GNU native PGlite toolchain. These configured jobs still require observed
results. Run locally with an actual bundled Codex executable:

```sh
CANTRIP_CODEX_BIN=/absolute/path/to/bundle/codex node --import tsx scripts/server-rust/actual-folder-client.mjs --tasks --database pglite --report .qa/rust-server/actual-task-worker-pglite.json
node --import tsx scripts/server-rust/project-chat-catalog-http.mjs --database pglite --report .qa/rust-server/project-chat-catalog-pglite.json
```

Replace `pglite` with `bundled-postgres` or `postgres` to exercise those modes.
Strict all-target Clippy and the contextual Chat contracts pass locally (46
library tests and 20,810 Chat validation/error comparisons). Running-turn
pause/resume, scheduling races, broader faults, supported artifacts, upgrades,
post-write rollback, Redis coordination, performance and the full app/Winterhold
cutover remain required. Node remains the default server.

Fresh PR #2440 CI provides scoped Windows message acceptance: all nine artifact
reports pass, including reads, writes, all storage/authentication combinations,
encryption and ordered Live. The wider run still has actual failures: Linux
PostgreSQL project-alert notification order, Windows Task background scheduling,
and Windows discovery's private PostgreSQL owner shutdown. Their job logs and
hash-verified artifacts are retained. These results do not establish a passing
platform matrix; no assertions, workloads or timeouts have been relaxed.

## Task launch admission and Goal observation accounting

Owned Rust operations now execute through their first await when admitted,
matching the Source async launcher before its scheduler requests the next claim.
The pending continuation stays owned by the executor, so dropping an unobserved
result or timing out the caller still cannot cancel admitted work. A deterministic
regression captures no launched operations before the fix and both launches in
invocation order afterward. All 46 library tests and five lifetime tests pass,
including the existing deadline, cancellation and worker-error contracts.
The unchanged background scheduler comparison passes 180 cases on each local
storage mode. Claimed and resumed operation comparisons also pass on PGlite.
The actual browser/full-worker/native Codex Task flow passes all 14 steps per
implementation on all three stores after this change, with nine model requests
and five worker stops per peer. Strict all-target Clippy passes. These local results do not prove
the earlier Windows scheduling failure resolved; fresh platform evidence remains
required.

The full repository check also found the recently added Goal observation table
missing from Source's storage manifest. Both servers now charge those rows to
Chat-owned conversation storage through the owning project. Source's manifest
coverage test fails before the addition and its complete four-test file passes
afterward. The regenerated native accounting SQL stays derived from the same
manifest. All three storage modes pass 48 paired repository cases, including an
observation increasing only its owner's row count and byte usage; deletion
restores the earlier measurement. No database constraint or test assertion is
relaxed. Supported-platform and broader replacement acceptance remain required.

## Project Agent conversations and creation receipts

The Rust project Chat endpoint now creates the encrypted Agent, initial runtime,
suspended worktree lane and optional tab placement in one transaction. Detached
creation retains the parsed request as JSONB and replays the current Chat summary
for the same owner, project and exact request. Conflicting or archived identities
retain the Source conflict response. Managed preparation is queued through the
production preparation runtime after creation. Task creation continues through
the shared transaction with its existing Task-specific state.

The conversation catalog preserves active/archived scoping, totals and ordering,
including PostgreSQL microseconds in cursors while public dates remain in
milliseconds. Usage first authorizes and locks the Agent, then serializes the
owner/client sequence and operation receipt. Replay returns the original result;
stale operations cannot move recency backward. Missing, archived, Task and foreign
Chats do not allocate client bookkeeping. The paired HTTP suite passes all nine
local authentication/storage combinations. External PostgreSQL also exercises
concurrent identities, real SQL exceptions after lane and usage-receipt writes, caller abort and retained
creation/usage across server restart.

An actual comparison exposed a Source archived-message count bug: the ORM
rendered the nested comparison as `chat_id = id`, binding the inner message ID.
The count now qualifies the outer Chat table explicitly. The populated-archive
regression checks both archived Chat and conversation catalogs; all fourteen
Source archive tests pass. The positive count assertion and microsecond page
boundaries remain intact.

The existing Agent client now has a full-worker acceptance flow. It creates and
replays a retained conversation identity, prepares the actual bundled native CLI,
records usage, decrypts an ordinary response and runs native Goal create/complete
tools. Before restart it requires both canonical native turns to be completed
and both answers to carry their original model attribution. It then compares the
entire transcript before and after server restart and worker reconnect, replays
the creation/usage identities, reads the same encrypted Goal, and clears it
without additional inference. The worker's missing native model-inventory HTTP
route is implemented with its existing credential scope and repository reader.
The inventory HTTP suite covers browser-only access, wrong worker, insufficient
credential scope, foreign providers and credential ownership with a foreign
browser session. The Linux/macOS/Windows CI matrix runs these flows sequentially
with the existing Task scenarios; configured jobs still require observed results.

```sh
node --import tsx scripts/server-rust/project-chat-creation-http.mjs --database postgres --report .qa/rust-server/project-chat-creation-postgres.json
node --import tsx scripts/server-rust/native-model-inventory-http-compatibility.mjs --database pglite --report .qa/rust-server/native-model-inventory-pglite.json
CANTRIP_CODEX_BIN=/absolute/path/to/bundle/codex node --import tsx scripts/server-rust/actual-folder-client.mjs --project-chats --database pglite --report .qa/rust-server/actual-project-chat-worker-pglite.json
```

Use each of `pglite`, `bundled-postgres` and `postgres` for storage coverage. This
milestone passes locally on macOS arm64 for both implementations with all three
stores: twelve client steps, four model requests, four worker stops and two
completed canonical native turns per peer. The HTTP suites compare 421 paired
creation/catalog/usage observations (including the fault/restart cases) and 207
worker/public inventory observations. Strict all-target Clippy, all 46 library
tests and 23,965 contextual Chat validation/error comparisons pass. The original
505 contract roots and entire 9,458-node prefix stay unchanged; six new roots
bring the manifest to 511 roots and 9,508 nodes. This does not establish the full
platform matrix, remaining Chat lifecycle
and synchronization APIs, production multi-instance operation, existing-data
upgrades/post-write rollback, final artifacts, desktop packaging, performance or
Winterhold deployment readiness. Node remains the default server.

The broad `pnpm check` run finished in 521.9 seconds with 1,701 Source tests
passing, 57 skipped and one provider-account pool assertion failure at
`local-foundation.test.ts:7218`. The same failure is present in the independently
hash-verified pre-milestone #2447 evidence archive. Recursive bail means later
worker/app tests and whole-repository formatting did not complete; focused
formatting and the actual production-worker acceptance above pass. The failing
assertion and its deadline remain unchanged.

## Chat console synchronization and passive thread observation

The Rust server now implements `POST /api/chats/:chatId/sync` and enrolled-worker
`chat.thread.changed` reconciliation. Both paths use the actual model routing,
native admission repository, execution lanes, shared token accounting, protected
Live message writers, worktree transitions and queue dispatcher. Public requests
preserve the existing missing/archived/foreign-owner, Task, standalone,
threadless, missing-model and offline behavior. Empty history is terminal
lifecycle evidence only when the worker supplies `statusSource: native-thread`;
a running response or retained turns also provide lifecycle evidence.

Passive observations lock the project and Chat and revalidate every placement,
runtime-route, thread and execution-lane binding. An active native admission
prevents a console read from finishing or relabeling its turn. A linked console
can acquire its own real execution lane, finish that exact lane or update an
otherwise idle Chat. Failure after lane insertion rolls back the complete
transaction. Existing worker-owned encryption protects projected legacy console
messages before they are persisted; protected canonical native history stays out
of the legacy synchronization response.

The bounded production revision reconciler rejects stale revisions, merges
changes arriving during an active callback, preserves per-thread order, consumes
failed revisions once, evicts only inactive entries and fences callbacks queued
before clear. It uses lossless UTF-16 keys. Notifications require exactly one
current, owner-scoped Agent binding and revalidate it before publishing Goal,
queue and plan invalidations and reading the native thread.

The base local Source/native repository comparisons pass 92 cases and 40 snapshots
per storage mode, including thirteen canonical projections and seven controlled
production-reconciler scenarios. External PostgreSQL additionally exercises
three contention orders with homogeneous and mixed Node/Rust server processes
(twelve server-pair entries), plus an actual AFTER lane-insert SQL exception.
All 46 Rust library tests, 27,184 contextual Chat validation/error comparisons
and nineteen focused Source synchronization/reconciliation tests pass. The two
new protocol roots bring the manifest to 513 roots and 9,536 nodes while
preserving all 511 prior roots and the complete 9,508-node prefix.

The public HTTP suite passes 288 paired observations across all nine local
storage/authentication profiles, including actual endpoint decryption, encrypted
message replay/revision/restart, lifecycle transitions, negative notification
bindings and exactly-once console usage accounting. After server shutdown, each
profile retains three protected messages, zero plaintext message rows, no active
lane and one owner-scoped console usage record. Generated identities and
timestamps use the existing harness aliases; each normalized
message ciphertext is decrypted and compared against the actual worker input.

The existing browser `syncChat` SDK, full production worker and bundled
`codex-cli 0.166.0` pass on PGlite, private PostgreSQL and external PostgreSQL.
Each peer completes thirteen client steps, two real synchronizations before and
after server/full-worker restart, and exactly four model requests. Synchronizing
retains the native thread identity, authoritative idle status, empty legacy turn
list and exact decrypted canonical transcript without repeating inference.

```bash
node --import tsx scripts/server-rust/native-command-admission-compatibility.mjs --domain thread-observation --database pglite --report .qa/rust-server/chat-thread-observation-pglite.json
node --import tsx scripts/server-rust/native-command-admission-compatibility.mjs --domain thread-observation --database postgres --report .qa/rust-server/chat-thread-observation-postgres.json
node --import tsx scripts/server-rust/chat-thread-sync-http.mjs --database pglite --report .qa/rust-server/chat-thread-sync-http-pglite.json
CANTRIP_CODEX_BIN=/absolute/path/to/bundle/codex node --import tsx scripts/server-rust/actual-folder-client.mjs --project-chats --database pglite --report .qa/rust-server/actual-project-chat-worker-pglite.json
```

Use each of `pglite`, `bundled-postgres` and `postgres` for storage coverage.
The supported-platform workflow now includes the focused Source tests, passive
repository/race cases and public HTTP/worker tests; configuring CI does not prove
platform acceptance. Archive cleanup, other unfinished domains, Redis and
multi-instance behavior, complete upgrade/post-write rollback acceptance, final
artifacts, desktop packaging, performance, Winterhold rehearsal and default
cutover remain required. The actual Task/full-worker PGlite regression and final
strict all-target Clippy and focused formatting also pass. Node remains the
default server and the worker remains Node. This milestone does not establish complete replacement or deployment
readiness.

The fresh broad `pnpm check` finished in 574.3 seconds with 1,700 Source tests
passing, 57 skipped and two failures: the unchanged provider-pool assertion at
`local-foundation.test.ts:7218` and the administrator encryption-registry test's
original five-second timeout. All four tests in the unchanged registry file pass
on the focused rerun with the original deadlines. The pool assertion is also
present in the independently hash-verified pre-milestone archive. No assertions
or deadlines were relaxed. Recursive bail prevented later worker/app tests and
whole-repository formatting from running; the focused format and real-worker
checks above pass. The broad check remains failing and requires follow-up.

## Reference account selection and notification fixture lifetimes

The local foundation test now selects each model through the existing settings
API before creating its Chat, matching the browser flow and the native
preparation boundary. A turn body cannot replace an already prepared provider
binding. The original fresh-account reserve selection remains checked. An
existing managed conversation keeps its account and native thread at 98% usage;
100% usage without credits triggers the existing durable account handoff. This
matches `managed-chat-account-failover.ts` and its existing focused tests; no
production routing or wire contract changes are made.

The controlled-worker fixture supplies real endpoint-encrypted source and
destination settings and advances the actual prepare/commit/finish repositories.
It requires a completed durable acknowledgement, the selected account and
credential home, an unchanged native thread, exact existing encrypted message
rows and the same decrypted transcript prefix. The next turn adds exactly the
user, command activity, file-change activity and assistant rows in their actual
order. It does not substitute a new thread or a plaintext reconstructed prompt.
Native file transfer remains covered by its separate real-Codex acceptance work.

The #2449 Linux and Windows Chat-message jobs exposed an overlapping queue
invalidation in the synchronization fixture. Their original artifacts are retained
with verified zip SHA-256 digests. The public history/replay lifecycle cases
continue to use the original unpaused Chat. Notification ordering now has its
own paused Agent Chat, so unrelated queued work cannot enter its measured scope.
The exact Goal/queue/plan order, strictly increasing cursors, complete null event
metadata, negative binding checks and original deadlines are unchanged. This is
a fixture isolation correction; the production queue dispatcher stays asynchronous.
Platform reruns remain required.

Focused commands:

```bash
pnpm --filter @cantrip/server exec vitest run --maxWorkers=2 test/local-foundation.test.ts test/managed-chat-account-failover.test.ts test/native-runtime-handoffs.test.ts
node --import tsx scripts/server-rust/chat-thread-sync-http.mjs --database pglite --report .qa/rust-server/chat-thread-sync-http-pglite.json
```

Use all three storage modes for HTTP comparisons. The focused foundation flow,
server typecheck and 50 focused account/handoff tests pass locally; two existing
real-native tests remain skipped without their explicit native test binary.
Full replacement, supported-platform/package acceptance and default cutover are
still unfinished. Node remains the default server.

The refreshed local sync matrix passes all nine storage/authentication profiles
(288 paired HTTP observations), retaining the exact notification assertions.
The broad `pnpm check` now passes all 1,702 Source tests with 57 existing skips,
then fails on six app assertions across four unchanged app test files (4,385 app
tests pass and three skip). All six reproduce in a focused run on clean Primary
`4692c643d`; their logs and file hashes are retained. They concern Explorer
controls, Git history URL ownership, the Node-only Task tab environment and an
empty running-menu fixture. The root run ends after 598.8 seconds; worker tests
were interrupted by recursive bail and whole-repository formatting did not run.
These app failures remain follow-up work; no assertion or deadline was relaxed.

The independent complete worker suite finishes with 2,623 passing tests, 133
existing skips and one MCP broker metadata failure: `alert_raise` advertises
`idempotentHint: true` while the test expects false. The same test fails on clean
Primary with the worker files unchanged (15 other focused broker tests pass).
This additional baseline issue remains to resolve; the worker suite is not
reported as green.

## Reference client and worker test alignment

The independently reproduced app and MCP broker failures now have scoped test
corrections. File views require their current View/Edit mode control and hide
Explorer-directory refresh; returning to the directory must expose refresh,
invalidate that exact directory and avoid reloading the previously selected file.
History overlays preserve the focused pane's complete mounted URL, including
unrelated query parameters, through open and close. A distinct background project
cannot claim that route. Task tabs keep the real browser event subscription under
jsdom and retain the unsaved Overview editor across tab changes.

The default creation menu retains its exact GitHub items while omitting Running
and its separator when there are no active instances. The packaged MCP host must
advertise both keyed/revisioned Alert mutations as idempotent; actual Source Alert
replay, ownership and resolved-key tombstone tests independently prove that
contract. No production app, worker or server behavior changes in this milestone.

Focused validation passes 42 app tests, 18 worker tests and 12 Source Alert tests.
The broad `pnpm check` finishes in 627.5 seconds: all 1,702 Source and 4,391 app
tests pass (57 and three existing skips respectively). Worker results are 2,622
passing, 133 existing skips and two 15-second timeouts in the unchanged native
history batch and CUA image-boundary tests. Both complete files pass all 56 tests
on the focused rerun with their original deadlines. Their source hashes match
clean Primary; the broad run remains failing and requires timing follow-up.

A separate whole-repository format check finds eleven unchanged baseline files;
all eleven failures reproduce on clean Primary. Changed-file formatting passes.
The preceding #2450 Linux and Windows Chat-message jobs also fail because the
original full foundation scenario exceeds its 15-second deadline, before reaching
the synchronization suite. Those terminal job logs are retained with SHA-256
digests. This does not establish platform acceptance or resolve the timing and
formatting failures. Node remains the default server and the complete Rust
replacement goal remains unfinished.

## Owner-scoped archive cleanup

The Rust server implements `POST /api/chats/archives/cleanup` using the existing
project retention and standalone scratch-job repositories. Project deletion
commits before standalone cleanup, matching the reference failure boundary.
Scratch cleanup reads a fresh clock, creates durable deletion jobs, publishes
their actual changes and queues the existing worker executor only when jobs exist.
The request uses the scratch service's owned lifetime so losing the HTTP waiter
does not cancel accepted persistence work. Startup and periodic cleanup remain enabled.

A valid body is ignored, including null, scalars, arrays, text and binary input.
The registered binary parser retains its distinct
`ceil(uploadLimitBytes * 1.5) + 1 MiB` limit. Malformed/empty JSON, unsupported
methods, authentication and CSRF keep the reference responses. This ignored-input
path does not establish general JavaScript Buffer validation semantics for other
routes; the shared parser's remaining binary-body behavior still needs an audit.

The local macOS arm64 matrix passes all nine storage/authentication profiles:
219 paired HTTP observations and 36 additional concurrent requests. It checks
expired project/standalone records, five byte-identical retained chats and three
retained roots per peer, active/unarchived and missing-expiry controls, qualifying
foreign-owner archives, body-owner spoofing and owner-isolated Live delivery.
Racing requests preserve one job, receipt and worker command. A real SQL trigger
failure after project deletion leaves that earlier commit intact and rolls back
the scratch transaction; retry deletes only the remaining scratch Chat. Each peer
preserves three completed deletion jobs, all retained encrypted content and archive
deadlines through an actual server restart, with no duplicate commands.

The normal production binary then serves the same profile to exercise body,
method and authentication failures and return 404 for the development SQL control.
Only the development example/oracle opt-in exposes that control, using its existing
database connection to age and inspect rows after real startup maintenance. The
unchanged worker transport carries controlled deletion results in this suite;
full worker filesystem, supported-platform and packaged acceptance remain separate.
The original shared-fixture setup path also passes all three PGlite auth profiles
with 96 paired synchronization regression observations.

All 47 library tests, 27,257 contextual Chat protocol/error comparisons and strict
all-target Clippy pass. The new cleanup result root brings the manifest to 514
roots and 9,538 nodes; all prior 513 roots and the entire 9,536-node prefix remain
unchanged. The broad `pnpm check` exits 1 after 810.8 seconds: all 1,702 Source
and 4,391 app tests pass (57 and three existing skips). Worker results are 2,619
passing, 133 existing skips and five timeouts in unchanged files: three Chromium
startup failures and the prior native-history batch/image-boundary deadlines.
The complete browser file passes all four tests on its focused rerun; both bulk
files pass all 56 tests with their original deadlines. File hashes match clean
Primary. Recursive bail prevents whole-repository formatting from running;
changed-file Prettier and Rust formatting pass. The broad check remains failing.
The platform workflow runs the new cleanup matrix before the independent full
foundation scenario; that reference test retains its original deadline and still
fails the job when unsuccessful, including after a feature test fails.

The retained #2450 platform evidence additionally records Linux encrypted approval
notification order and Windows managed-preparation Live invalidation-count failures. Their
job logs and original artifacts have verified SHA-256 digests. These failures,
the foundation timing failure, broad worker timing and existing formatting issues
remain unresolved. Configured CI and local acceptance do not establish Linux or
Windows readiness. All remaining replacement, Redis/multi-instance, upgrade and
post-write rollback, artifact, app packaging, Winterhold rehearsal, performance
and default-cutover requirements remain active. Node remains the default server
and the worker remains Node.

```sh
node --import tsx scripts/server-rust/chat-archive-cleanup-http.mjs --database pglite --report .qa/rust-server/chat-archive-cleanup-pglite.json
node --import tsx scripts/server-rust/chat-archive-cleanup-http.mjs --database bundled-postgres --report .qa/rust-server/chat-archive-cleanup-bundled-postgres.json
node --import tsx scripts/server-rust/chat-archive-cleanup-http.mjs --database postgres --report .qa/rust-server/chat-archive-cleanup-postgres.json
```

## Native approval publication schedules

The Linux encrypted-approval failure exposed an assumption in the HTTP oracle:
PostgreSQL delivers committed project-alert notifications over a dedicated LISTEN
connection, while the request handler publishes its interaction and Chat summary
after its transaction resolves. Those two connections can complete in either order.
The reference server's two handler publications remain an ordered, adjacent group.
PGlite delivers its notification callback inline and retains its exact total trace.

A development-only transparent TCP proxy demonstrates both PostgreSQL schedules
against the actual unchanged Node server and the actual Rust executable. Holding
the interaction transaction's real commit response allows the alert to arrive first.
Holding the listener's real notification allows the handler group to arrive first.
The test observes the held boundary before releasing the original frames, checks
the complete three-event trace under each schedule, and compares every event field
between both runtimes. It preserves raw frames, increasing cursors, publication
clock checks and endpoint-encryption marker checks in the report. The proxy uses
only disposable loopback PostgreSQL connections and records boundary labels rather
than SQL, credentials or parameter values.

The ordinary event suite waits for each of the four actual alert-changing writes'
notification before advancing to its next request. A socket ping alone does not
prove that a separate database listener has delivered its notification. Replays,
rejected writes and already-terminal requests require zero additional alerts.
PostgreSQL comparisons retain each producer's complete ordered stream and allow
the independent alert only before or after the adjacent handler group. PGlite and
all other event cases continue comparing their complete total trace. The report
also retains the unmodified cross-producer deliveries and timestamps. Adversarial
oracle tests reject missing, duplicate, interleaved and reversed events, changed
scope/entity/action/revision/payload metadata, and changed operation sequences.

The local macOS arm64 run passes all nine storage/authentication profiles with
420 paired HTTP observations, 27 event operations and 26 raw event frames per
peer/profile, and five endpoint-crypto proofs per peer/profile. All six controlled
PostgreSQL schedule/profile cases pass against both executables, with 94 paired
HTTP setup/approval observations and complete three-event trace equality under
each chosen schedule. The existing PostgreSQL fault suite also passes its 20
paired observations, retaining SQL rollback with zero publication, historical
Task fanout order and a real locked transaction's post-commit publication fence.
All five adversarial oracle tests pass.

The broad `pnpm check` finishes in 695.8 seconds with all 1,702 Source and 4,391
app tests passing (57 and three existing skips). Worker results are 2,622 passing,
133 existing skips and the two unchanged 15-second native-history batch and CUA
Sharp image-boundary timeouts. Both complete files pass all 56 tests on a focused
rerun with their original deadlines. Their test/source hashes match the base and
clean Primary. The broad check remains failing; recursive bail prevents the
whole-repository format check. Changed-file formatting passes.

The platform workflow runs the oracle tests and controlled delivery scenarios
early in the native-command matrix. Platform acceptance still depends on the
actual completed jobs and all remaining checks. The Windows preparation count,
foundation timing, actual Worker/client failures and other final replacement
requirements remain active; Node remains the default server.

```sh
node --test scripts/server-rust/native-event-publication-trace.test.mjs
node --import tsx scripts/server-rust/native-event-http-compatibility.mjs --database postgres --publication-schedules-only --report .qa/rust-server/native-event-publication-schedules.json
```

## Worker native queue HTTP

The Rust server implements all six enrolled-worker queue actions: `lookup`,
`read`, `mutate`, `start-receipt`, `import` and `import-ack`. Each action uses
`worker:agent-tools` authentication and the credential owner. Validation precedes
authentication. The existing canonical repository owns revisions, immutable
receipts, imports, runner fencing, claims and retained encrypted input.

The HTTP adapter preserves the reference's two error boundaries: rejected
`lookup`, `read` and `import` promises reach the framework error envelope, while
`mutate`, `import-ack` and `start-receipt` return the route's code-only domain
errors. Generic receipt read failures and the real 90-second deadline return
`queue-receipt-pending`. Binary bodies use the registered upload limit and fail
the required object schema; this does not establish general Buffer behavior for
other domains.

Mutation and successful import acknowledgment publish their actual Chat queue
invalidations and conditionally dispatch through the existing execution graph.
Mutation replay still publishes as Source does. Pending receipts share the same
notification service and 750-millisecond fallback as native settlement. Dropping
the HTTP view aborts its waiter, while an already-started database read remains
owned until it finishes. Completed writes and dispatch work retain their owned
lifetime when their HTTP waiter disappears.

The compatibility suites use unchanged worker SDK requests and actual HTTP,
worker transport and Live sockets. Queue and future-message ciphertext comes
from the production worker encryption helper. The client decrypts every returned
copy, checks exact ciphertext retention and verifies that private input does not
appear in HTTP, Live or server diagnostics. Native import identity hashes are
independently recomputed before normalizing per-instance owner-derived IDs.
Import replay, runner replacement, uncertain deletion, conflict, changed-source
replacement and acknowledgment retain their complete Source responses.

The receipt suite exercises real settlement, replay, caller disconnect, SQL
failure, the actual 90-second deadline and a PostgreSQL read held by a real
exclusive table lock. Its account cases cover all six cross-owner denials,
unchanged foreign encrypted rows and exact worker/Live notice metadata. The
first read creates revision zero with a pending notice; the suite observes its
real acknowledgment before adding revision one, preventing scheduling from
coalescing those two independently verified notices.

The transaction case uses concurrent identical SDK mutations, SQL exceptions
after queue effects, import/acknowledgment rollback, exact-operation retry and
actual server restart with the existing worker reconnecting. Explicit frozen-item
start verifies the deterministic claim and retained decryptable input. A failed
dispatch releases the claim; replay preserves the immutable receipt and returns
the current queue state. The suite does not assume that the whole snapshot stays
unchanged after dispatch.

That restart case exposed missing production startup wiring: the existing lane
reset and Task-operation reconciliation repositories were implemented but never
called. Startup now runs both in the existing single-coordinator transient
recovery sequence, matching Source's suspended lanes and interrupted Chat
statuses before dispatch resumes. Redis/multi-instance startup recovery still
requires its own coordinator-aware implementation and acceptance.

The normal production executable serves the ordinary queue/auth/crypto/import
suite. SQL fault and lock controls exist only in the explicit development
example and Source oracle opt-in; the example includes the actual server main.
Full native runtime/product acceptance uses the separate existing browser/full
worker/bundled Codex flow. Local and configured CI checks do not establish
supported-platform, packaged or complete replacement acceptance. Node remains
the default server and the worker remains Node.

The final local macOS arm64 HTTP comparison passes all nine storage/authentication
profiles with 888 paired observations, 40 endpoint decryption proofs and five
worker SDK operations per peer/profile. All 37 receipt-matrix scenarios pass:
12 each for PGlite and bundled PostgreSQL, and 13 for external PostgreSQL. A
further focused external-PostgreSQL case holds an actual mutation inside SQL,
closes its HTTP caller, observes the original database operation still blocked,
then releases it. The mutation commits once, publishes both route and durable
notifications, and the unchanged worker SDK reconciles and replays the original
receipt without duplicate encrypted input. The existing locked-read regression
also passes with that helper.

All six existing browser/full-worker/bundled-Codex product suites pass after the
startup fix: Agent conversations and Tasks on each backend. Each Chat peer
completes two canonical turns, uses native Goal tools and preserves encrypted
history, usage, synchronization and Goal state through server/worker restart.
Each Task peer completes direct execution, planning/native Goal implementation,
manual retry after an actual controlled quota response, paused admission through
server/worker restart and retained completion without duplicate inference. Only
the public model HTTP responses are controlled.

All 47 Rust library tests, 44,824 native-command contract comparisons, strict
all-target Clippy, boundary audit and changed-file formatting pass. The broad
`pnpm check` exits 1 after 728.2 seconds: Source has 1,702 passing tests and the app
has 4,391 (57 and three existing skips). Worker results are 2,620 passing, 133
skipped and four failures: GitHub/native-history/Sharp 15-second timeouts, a
project Goal delivery assertion, plus an unhandled Codex RPC `EPIPE`. All five
complete implicated worker files pass 94 focused tests with original deadlines;
six relevant test/source files match the base and clean Primary byte for byte.
A separate full standalone worker run on clean Primary passes all 2,624 tests
with 133 skips and zero errors, leaving Primary clean. That does not reproduce
the broad run's context or prove its failure cause. The broad check remains
failing and prevents its final whole-repository formatting step.

Latest retained #2453 platform evidence also remains unresolved: the Linux
controlled-publication test times out starting its first Node server before
any Rust server or held frame; Windows archive cleanup fails its event-clock
assertion; Linux/Windows Source foundation exceeds the original 15-second
deadline; and Windows private-PostgreSQL Run transitions fail a transaction-clock
assertion. Actual job logs and two original artifacts with verified API SHA-256
digests are retained. No assertions or deadlines are weakened by this milestone.

```sh
node --import tsx scripts/server-rust/native-queue-http-compatibility.mjs --database pglite --report .qa/rust-server/native-queue-http-pglite.json
node --import tsx scripts/server-rust/native-queue-http-compatibility.mjs --database bundled-postgres --report .qa/rust-server/native-queue-http-bundled-postgres.json
node --import tsx scripts/server-rust/native-queue-http-compatibility.mjs --database postgres --report .qa/rust-server/native-queue-http-postgres.json
node --import tsx scripts/server-rust/native-queue-receipt-http.mjs --database pglite --report .qa/rust-server/native-queue-receipt-pglite.json
node --import tsx scripts/server-rust/native-queue-receipt-http.mjs --database bundled-postgres --report .qa/rust-server/native-queue-receipt-bundled-postgres.json
node --import tsx scripts/server-rust/native-queue-receipt-http.mjs --database postgres --report .qa/rust-server/native-queue-receipt-postgres.json
```

## Project automations

The Rust server implements all four public encrypted automation CRUD routes and
both worker polling/dispatch routes. Worker requests require `worker:automations`
and retain the credential owner. Missing projects still list as an empty array;
Agent-target ownership, optimistic revisions, disabled schedules and no-future
conflicts follow Source. The server retains opaque name, prompt and condition
content. The unchanged worker evaluates conditions and seals the actual turn.

Scheduling runs entirely in Rust. Its parser preserves Croner 10.0.1's five-part
syntax, one-shot date forms, diagnostic order, question-mark wildcard behavior,
weekday transforms, civil traversal and year-3000 search boundary. Calendar
intervals retain JavaScript Date.UTC normalization. Timezone roundtrips preserve
Source's fold/gap behavior. Named zones use the bundled timezone database rather
than host zoneinfo; an actual America/Inuvik comparison exposed a one-hour host
data difference. Source and bundled data currently use 2026e. Legacy SystemV
aliases use compiled TZif assets extracted from actual Source Intl behavior,
including historical exceptions and a future rule checked over a complete
400-year Gregorian cycle. MIT attribution for the Croner adaptation is retained.
No JavaScript database or scheduling helper runs in the production server.

The repository executes Source-derived SQL and parameter order, with native
bindings and JSON row projection. It preserves separate CRUD operations, revision
conflicts, millisecond timestamp comparisons, occurrence uniqueness, expired-run
recovery, lease tokens/fencing and captured reasoning settings. Claims and
completion updates keep their original transaction boundaries. Finishing a run
can succeed after an automation edit without overwriting the newer revision.
Error text is sliced by UTF-16 units before the text driver encodes it.

Dispatch claims remain outside the protected-dispatch error boundary. The worker
protection request retains its 45-second budget. Recovery reads, queued prompts,
turn starts and dispatch use the existing native services, including their owned
lifetimes after the HTTP caller disconnects. Project invalidations retain their
owner and scope. Strict binary-body errors include Source Buffer's inherited
enumerable keys; other domains' general Buffer compatibility remains separate.

Local macOS arm64 comparisons match 9,337 actual Source contract outcomes and
exact errors, plus 17,252 occurrences covering every Intl-supported timezone,
legacy aliases/history, interval/calendar boundaries, folds/gaps, the year cutoff
and UTF-16 date comments. Actual repositories match 66 scenarios on each of the
three stores. The controlled HTTP/worker/Live suite passes all nine storage/auth
profiles: 516 paired HTTP observations, 24 endpoint decryption proofs, eight
protection commands, 35 project invalidations, two unchanged scheduler HTTP
operations and six concurrency, lifetime and legacy-recovery scenarios per
peer/profile. It covers concurrent dispatch, edits during protection, lease expiry
after queue admission, durable completion after a client disconnect, legacy
visible-message/prompt recovery and the existing opaque-mapper rejection. Account
cases deny foreign-owner CRUD and retain the worker credential owner alongside a
foreign session cookie.

Existing browser automation APIs, normal server executables, the full production
worker and the actual bundled Codex also pass on all three stores. Real `exit 0`
and `exit 7` conditions produce one native turn and one skipped automation. Their
protected schedules and completed canonical history survive two additional
server/worker restarts before deletion. The original Chat/Goal/history/usage
assertions remain. Only public model HTTP responses are controlled.

All 47 Rust library tests, 44,824 native-command contract comparisons and strict
all-target Clippy pass after the timezone fixes. Focused unchanged Source tests
pass: six protocol, two server, six worker and one app test.

The broad `pnpm check` exits 1 after 627 seconds: all 1,702 Source server and
4,391 app tests pass, while the worker passes 2,623 tests and exceeds the original
15-second deadline in one encrypted-history batch test. Its complete unchanged
28-test file passes separately in 62 seconds with the original deadlines. This
does not establish the cause or a green broad check. A separate full formatting
check reports eleven files, all byte-identical to the milestone base; changed-file
formatting passes. Neither failure is suppressed or treated as whole-goal acceptance.

These local results do not establish supported-platform, packaging, multi-instance
or whole-server replacement acceptance. The prior PR #2454 platform run includes
Linux/Windows Source foundation timeouts, a Linux Source startup timeout, Windows
scheduler/transaction-clock comparisons and a Linux native logical-export failure.
The failing Linux contract job selected PostgreSQL 16 tools for the PGlite 17
dump; it now uses the existing migration job's PostgreSQL 18 dump client while
retaining PostgreSQL 16 server coverage. A fresh Linux result remains required.
Its actual Linux full-worker Task job passes; the other observations remain open,
and logs plus three independently checksum-verified failure artifacts are retained.
Node remains the default server, and the worker remains Node.

## Execution platform comparisons

The prior Windows runtime artifact records the unchanged Source server producing
`03:46:28.084Z` while the parent observer starts at `03:46:28.085Z`; Rust produces
`03:46:28.090Z` inside that parent window. Runtime observation and admission now
use the existing producer-process clock witnesses. The exact inclusive bounds,
replay timestamps and complete value comparisons remain, with the parent readings
retained diagnostically. No tolerance is added. The complete target/runtime corpus
passes 431 paired cases on each store locally; 210 cases per store include the
producer observations. Existing negative controls still reject timestamps one
millisecond outside either producer boundary.

A controlled worker-preparation gate also demonstrates that Source and Rust can
claim Tasks in FIFO order while a later preparation completes and runs first.
Both preserve a held first claim and a completed second occurrence before release,
then finish both. The shutdown test now keeps its second occurrence queued but
ineligible until polling stops, then configures its model. It retains the original
one-turn, durable queued-state, exact restart and retained-work completion checks.
The new reverse-preparation case remains part of the full scheduler corpus.
All 182 paired scheduler cases, eighteen snapshots and nine reopens pass on each
store locally. No production service implementation is changed by these fixture
corrections. Fresh supported-platform results remain required.

The Windows migration artifact `13206049545` fails during interrupted bundled
PostgreSQL import after the main process closes and the original postmaster-exit
assertion passes. Owned staging removal now uses bounded retries of the actual
filesystem operation. The original 30-second no-orphan deadline, partial-profile
checks and valid-bundle retry remain; persistent removal errors retain their phase,
postmaster IDs and main-process exit witness in the report. The complete profile
transfer corpus passes locally on all three stores, including retained sessions,
identities and files, reverse conversion after Rust writes, SQL failure rollback,
killed-import recovery and a lost-COMMIT-acknowledgement retry that preserves a
later Rust write. This does not prove the Windows cleanup correction has passed.

The milestone broad check exits 1 in 599 seconds: 1,702 Source server and 4,391 app
tests pass; the worker passes 2,621 tests with three failures in encrypted-history
batching, Flutter device inspection and the exact PNG-size boundary. Their three
complete unchanged files pass all 65 tests separately with original deadlines.
The cause remains unresolved and the broad check is not green. A separate global
formatting run reports eleven files, all byte-identical to the milestone base.

## Public agent interactions and approvals

Rust now serves all three public interaction routes: list requests, inspect a
request and submit its response. They use the existing native interaction
repository and post-resolution Live mutations. Visible and protected responses
retain their separate validation rules; pending replies use either the legacy
runtime command or the active native control command. Computer-use preview and
agent approvals project current placement, permission policy and authority from
durable state. Native turn preparation shares that authority projection.

The implementation preserves Source replay and failure behavior. A resolved
ordinary request replays before model selection or worker availability checks.
An encrypted replay checks its idempotency key without comparing ciphertext.
Computer-use replay still validates current authority but sends no further
authorization command. Normal worker quota errors retain status 429, while the
computer-use route returns its existing redacted 409. A failed persistence write
after acknowledgment leaves the request pending and retryable. Accepted native
replies retain a resolution that won concurrently.

All 7,695 actual Source contract value, issue and exact-error comparisons pass.
The real-socket matrix passes 891 paired HTTP observations across all three
stores and anonymous, password and account authentication. Each peer/profile
also verifies 23 WorkerConnection commands, 24 scoped interaction Live
invalidations, eighteen durable snapshots and four concurrency/recovery cases.
Cases include project and standalone visible/protected replies, legacy and native
control, computer-use preview/agent authority, expiry, ownership, CSRF, malformed
JSON and Buffer bodies, UTF16 errors, worker quota and offline errors, native
concurrent resolution, real SQL failure after acknowledgment, disconnected-client
completion, startup interruption and retained offline replay. SQL snapshots retain
their raw values; comparisons validate timestamp instants and recognize only
independently decrypted envelopes, including PostgreSQL JSONB property ordering.

The existing browser SDK, normal executable, full unchanged worker and actual
bundled Codex also pass on all three stores. A model response requests harmless
command execution with native approval. The browser decrypts the actual request,
encrypts its reply and observes the real command output in the next native model
request. The unchanged worker can publish its protected resolution before the HTTP
handler resolves the same request: the winning write owns the replay key. The
fixture proves that its key replays without another execution and the competing
key receives the existing 409. These runs retain the earlier Chat, Goal, history,
usage, real automation conditions and restart assertions. Only public model HTTP
output is controlled.

The local all-target check, strict Clippy, all Rust library tests and both native
command and interaction contract suites pass. Focused unchanged Source protocol,
server, worker and app interaction tests also pass. Current-head supported-platform
CI adds the interaction contract/matrix checks and actual native approval flow;
configured checks do not establish passing platform evidence.

The previous #2456 platform run now passes the actual Windows and Linux migration
jobs. Its retained, independently checksum-verified artifacts still show a Linux
publication-fixture startup timeout, a Windows Source file-document HTTP
`ECONNABORTED`, and a Windows archive-cleanup assertion plus the unchanged
15-second Source foundation timeout. Those failures remain open. The actual
`GET /api/chats/:chatId/permission-profiles` request also returns native 404;
the complete customization domain remains a separate unfinished port. The actual
approval operation succeeds without using that endpoint as a preflight gate.
These results do not establish whole-server, shared coordination, packaging,
Winterhold or performance acceptance. Node remains the default server and the
worker remains Node.

The milestone broad `pnpm check` exits 1 after 586 seconds: all 1,702 Source
server and 4,391 app tests pass; the worker passes 2,623 tests and exceeds the
original 15-second deadline in one encrypted-history batch test. Its complete
28-test file passes separately in 59 seconds with the original deadlines.
Forty-three reviewed history source/test files are byte-identical to the base.
This does not establish the cause or a green broad check. Global formatting
also exits 1 on eleven files, all byte-identical to the base; changed-file
formatting, Rustfmt and the diff check pass. Neither failure is suppressed.

### Linux Run lifecycle integration and retained performance evidence

The settings/shutdown milestone integrates main `4ad75709c`, including the
worker-owned Linux Run lifecycle. The authoritative manifest contains 599 roots
and 10,131 nodes, with 292 outgoing command types. Ordered graph comparison
against the tested `2d0278e6a` candidate preserves 595 previous roots and the wire
validation engine exactly; only the worker request envelope changes, with three
new Run roots. All 286 previous primary command inputs remain in order, and all
1,074 previous alternative cases remain an exact prefix of the 1,101-case corpus.
Every upstream primary and alternative input is also retained. Coverage is 60
union schemas/524 alternatives and 163 enum schemas/628 alternatives. The six Run
lifecycle commands now have explicit content-boundary classifications: launch
secrets and operation-bound output remain protected, and the worker validates
captured Linux authority and owns processes and journals.

The placement fixture first verifies that the current database rejects a
worktree/source worker mismatch. It then simulates legacy corrupted state in its
own disposable databases by disabling only the scope trigger while seeding,
restores that trigger before admission, and retains all 46 original placement
and catalog scenarios and every original assertion. The production constraint
is unchanged. The reference foundation scenario retains its original 15-second
watchdog and all per-wait timeouts and assertions. An initial variant polls all
42 waits at 5 ms instead of Vitest's default 50 ms. Its same-host ABBA comparison
measures median accumulated wait time of 1,300 ms versus 867 ms and median test
time of 7.11 s versus 6.65 s. Ordinary Windows execution still fails at
`e28765515`; the local timing improvement does not resolve that failure.

The current candidate retains 5 ms polling for 22 synchronous assertions and
restores the original interval for 20 asynchronous queries. A second same-host
ABBA comparison reduces median asynchronous callback attempts from 62.5 to 34.5,
while median test time changes from 6.82 s to 6.955 s. The full original test AST
is preserved after removing the adapter and normalizing those 22 call names.
This is a scheduling experiment, not a demonstrated Windows timeout fix.

Retained built-artifact measurements at `2d0278e6a` cover fresh PGlite and external
PostgreSQL profiles, accepted writes/reopen, and a separate WorkerLink relay
workload using the production Node worker transport with controlled resource
authority. Each comparison uses five warmups and twenty measured workflows per
server. External PostgreSQL median fresh readiness is 1,348 ms for Node versus
498 ms for Rust, with server RSS of 419,960 KiB versus 51,816 KiB. Database service
startup is excluded and database memory is recorded separately. All 50 workflows
preserve saved settings/identity and produce 100 actual clean server exits; all
owned databases and the private test service are cleaned up.

The relay comparison transfers 5.32 GiB across 50 successful workflows with
byte-exact payloads and frame sequences, bounded credit, a 100 ms paused reader,
responsive HTTP, observed worker-initiated channel close and 50 clean server
exits. Median steady throughput per direction is 185 MiB/s for Node versus
201 MiB/s for Rust. The paused-reader median is 189.7 ms versus 201.2 ms, a 6.1%
slowdown that remains an unresolved performance result despite the improved
paused-reader p95. The original 8 MiB stress observation also remains retained:
Node closes with code 1013 during the steady burst, while Rust completes that
run. The comparable steady measurement uses a 1 MiB in-flight window on both
servers; it does not replace or represent the failed stress run as passing.
These local empty-profile and controlled-relay results do not establish actual
resource execution, endpoint encryption acceptance, representative load,
fault-recovery, multi-instance, platform, product packaging or Winterhold
readiness. The worker and default server remain Node.

The integrated source passes 1,040 protocol tests, worker/server typechecking,
production worker compilation, 13,998 Linux Source vectors, all 292 primary
worker commands, 83 boundaries and 232,678 mutations exercising all 98 registered
custom checks. All three storage modes pass 165 placement admissions and nine
catalog cases per peer, including the exact SQLSTATE `P0001` and scope-trigger
message verified inside each database. The focused worker run has 29 passing
tests; the existing opt-in actual Linux executor integration is not run without
a configured test transport. The reference foundation/failover run passes 22
tests locally. Strict all-target Clippy, Rustfmt, the reviewed boundary audit,
formatting and diff checks pass; the final eight-stage check preserves all
source code during execution. These results do not waive platform CI, the
reported foundation timing failures or any final replacement requirement.

### Persisted Run epochs and migration-history integration

The subsequent integration includes main `cbb910584`, its persisted Linux Run
execution epochs and explicit simulated CUA-target grant. Every one of the 249
prior SQL files and journal entries is compared directly with the pinned Git
tree and remains unchanged. The milestone's lock-order SQL bytes are unchanged
and now append as migration 0249, timestamp 1793805840553, after upstream 0248;
there are 250 entries. The protocol, generated wire manifest, validation engine
and complete worker input corpus remain identical to the tested `2b26d8613`
integration. All fifteen Source query/policy captures run again and match the existing Native
queries. Three raw-output differences are formatting only; canonical formatting
restores the original exact bytes, with values and property order unchanged.

The new capture coverage reproduced a default-stack PostgreSQL integration-test
overflow. LLDB records the nested driver/capture/admission/validation polls.
Scheduling the capture phase as a separately awaited task lets the large driver
poll return before that phase runs on the same runtime. Both PGlite/PostgreSQL
repository tests pass with the default stack; all remaining test source,
arguments, assertions and deadlines are preserved. Source Run runtime tests,
server typechecking and simulated CUA smoke tests also pass. The affected
placement, workspace, legacy-layout, project-surface and usage/guest-accounting
comparisons pass on all three stores. All 21 subsequent validation stages pass
with source code unchanged during the run, including strict Clippy, Rustfmt,
reviewed boundaries and formatting.

The focused Windows profiling run at `2b26d8613` times out. The subsequent
`e28765515` run executes the ordinary suite first and reproduces the original
15-second foundation failure; the other 21 tests pass. Failure-only profiling
also exceeds that same deadline. These failures remain unwaived. The selective
polling candidate and complete platform/product acceptance still require actual
platform execution. The performance and native-runtime artifacts described above
retain their original revision and scope; they do not establish packaging
readiness for this later integration.

### Captured Linux Run API integration

The branch next integrates main `e0c038405`, which exposes captured Linux Runs
through lifecycle, status and output APIs. The manifest contains 600 roots and
10,146 nodes. Ordered graph comparison identifies three changed request roots
and the added `cantripOsRunSelectionSchema`; all 596 other existing graphs and
the native validation engine remain unchanged. The worker envelope and complete
outgoing input corpus are unchanged, preserving the earlier worker-command
comparison evidence. The native OS contract loop now explicitly exercises all
three changed request roots as well as the new selector.

Native OS contract, HTTP and both storage repository targets pass. The protocol
passes 1,042 tests, and the focused worker Run targets pass 31 tests. Server and
worker typechecking, strict all-target Clippy and Rustfmt pass. Paired HTTP
compatibility passes on PGlite, bundled PostgreSQL and external PostgreSQL after
rebuilding the actual workspace dependencies; earlier attempts with a stale
compiled version package are retained as failures rather than normalizing the
version comparison. Migration history remains at 250 entries.

Extra opt-in Source/worker Linux Run tests are attempted in an owned disposable
Docker fixture. The existing executor image lacks current Run helpers; after
installing source-built helpers, its executor reports that it is a stub without
`process/resize` support. Those failed attempts are retained. Building and
installing the complete current executor 0.6.0 arm64 package then makes both the
Source server-to-worker Run API scenario and the real worker Run execution,
transport-loss and cancellation scenario pass, without changing either test.
The ordinary reference foundation/failover suite also passes all 22 tests locally
with the original deadlines. These Source/worker guest results and the passing
controlled-worker native HTTP tests do not establish complete Rust product or
supported-platform acceptance. The default server and worker remain Node.

### Linux Run source selection and captured terminal files

The next integration includes main `4c6c915a3`, its Run source selector and
immutable captured terminal-file placement. The manifest has 601 roots and
10,159 nodes. Four existing request/response graphs change and one source-summary
root is added; all 596 other previous graphs and the native validation engine
are unchanged. The worker envelope graph is unchanged, and the complete outgoing
input corpus remains byte-identical to the validated `84587920e` candidate. The native OS contract
loop explicitly covers the changed status and operation result roots.

Upstream migration 0249 backfills captured Run terminal placement. Every one of
the 250 upstream SQL files and journal entries remains unchanged; the milestone's
identical lock-order SQL follows as 0250, timestamp 1793813543081. There are 251
entries. Native OS contracts, real HTTP and PGlite/PostgreSQL repository targets
pass with this chain.

The broader local check at `84587920e` fails with 33 tests and six suite-hook
errors. The ownership-reconciliation assertion reproduces independently: its
fixture returns a Host Run even when queried for Linux Runs, which have no
captured execution in that fixture. Correcting only the host/Linux mock selection
and empty reconciliation reply makes all original ownership assertions pass.
All 23 previously failing files then pass 84 tests in a separate serial run with
their original test and hook limits. This does not make the earlier broad
`pnpm check` green or establish the cause of its deadline failures. Development
validation remains local under the merged Actions policy.

All fifteen subsequent validation stages pass with source unchanged: 19 Source
Run tests, 31 worker Run tests, 42 affected client tests, 1,042 protocol tests,
server/worker/app typechecks, paired HTTP on all three stores, strict all-target
Clippy, Rustfmt, reviewed boundaries, formatting and diff checks. The complete
current executor package is then rebuilt and installed in an owned disposable
guest. Both the updated Source Run-source/captured-status scenario and the real
worker execution/transport-loss/cancellation scenario pass unchanged. The guest
is stopped and removed, with package provenance and logs retained. These local
Source/worker and native controlled-worker results do not prove complete Rust
product, supported-platform or shipping acceptance.

### Provider admission and stored Linux history integration

The next integration includes main `55b3491e9`: stored Linux history remains
readable after runtime changes, Host/Linux Runs share one catalog, and providers
carry concurrency limits and configuration revisions for the worker's FIFO
admission. Keep Main's `InstanceObservation.runtime` representation and history
behavior while retaining the default-stack capture test boundary and matching
Run-definition deadline. The worker remains Node.

The manifest has 601 roots and 10,166 nodes. Six existing graphs change,
including the worker envelope; the other 595 graphs and native validation engine
are unchanged. All 601 root comparisons and the actual 292-command, 83-boundary
and 232,678-mutation comparisons pass, executing all 98 custom checks. Native
settings operation, OS HTTP and both repository targets also pass.

Upstream migration 0250 adds provider limits and the atomic revision trigger.
All 251 earlier SQL files and journal entries remain unchanged; the milestone's
identical lock-order SQL follows as 0251, timestamp 1793816000001. There are 252
entries. Repository comparisons explicitly check the default limit/revision,
changing a limit, repeating it without advancing the revision, and preserving
both values when a legacy edit omits them.

Current history tests, managed-worker session tests and affected client catalog
tests pass. The protocol export test first reproduces eight unreviewed additions;
explicitly checking those eight exports preserves the complete existing baseline
section and every subsequent assertion byte for byte. Protocol tests then pass.
The provider catalog fixture receives the new default fields, and the inference
observer log receives its required subsystem. Server, worker and app typechecks
pass afterward. Earlier failures remain retained rather than reported as green.

All three stores pass 771 Source/native settings repository comparisons,
including the added limit/revision cases, with no fixture cleanup failures.
The current HTTP settings-operation comparison also passes on all three stores.
Strict all-target Clippy, Rustfmt, boundary review and changed-file formatting
pass. All fifteen Source query/policy captures retain the existing values and
property order; canonical formatting restores the three raw formatting-only
differences to their original exact bytes. This is local milestone evidence,
not complete replacement or deployment acceptance.

### Linux MCP and Run-definition retirement

The next integration includes main `531642a48`, which retires captured source
runtimes before deleting Run definitions and supplies worker-owned MCP to Linux
native sessions. The migration chain remains at 252 entries. The manifest has
601 roots and 10,168 nodes: the worker envelope and two Run-definition graphs
change, while the other 598 graphs and native validation engine remain unchanged.

The merged outgoing corpus retains all 1,101 previous case objects and their
order, plus every upstream input with its property order. One new retirement
input is appended as case 1101, giving 1,102 cases and 1,153 union/enum coverage
descriptors. Existing descriptor references remain intact and the new union
option points to the appended case. Both named and unnamed fixtures are retained.

Current local checks pass 21 server API/history/ownership tests, 10 worker MCP
and lifecycle tests, 21 affected client tests, all 1,042 protocol tests and all
three typechecks. The native OS contract, HTTP and repository targets pass.
The worker targets match all 292 primary requests, 83 boundaries and 233,547
mutations, executing all 98 custom checks and covering 60 unions with 525
alternatives plus 163 enums with 628 alternatives. Strict all-target Clippy,
Rustfmt and the reviewed boundary checks also pass. Disposable-guest verification
remains separate; prior provider results retain their tested revision.

### Provider admission and setup integration

Integration with main `852494ede` includes the shared provider setup policy,
worker-wide inference tickets, queued inference deadlines and live provider
limit delivery. The manifest has 602 roots and 10,219 nodes. Compared with the
preceding local candidate, the worker request and server envelopes and native
command-event graph change, and `workerInferenceStatusSchema` is added. The
remaining 598 graphs and the native validation engine retain their exact
behavioral graph representations.

The outgoing corpus keeps all 292 previous primary request objects and all
1,102 alternative case objects, with their property order and relative order
intact. It adds `inference.configure` and four initial-label requests, giving
293 commands, 1,107 cases and 1,154 coverage descriptors. Actual Source coverage
validation covers 60 unions with 526 alternatives and 163 enums with 628
alternatives. Five new public exports, one command and two worker events are
reviewed explicitly; every original public-surface fingerprint and worker
baseline assertion is retained.

Current local Source checks pass 1,054 protocol tests, 19 server tests, 39 worker
tests, 15 client tests and all three typechecks. The otherwise optional native
label test also passes with the actual local Codex executable. Four real HTTP
limit edits reach the existing Node worker admission pool before the response,
including an identical edit that preserves its configuration revision; the
active native runtime remains intact.

Integration corrected the label result parser's optional argument and the
Source/native provider-sync worker identity field. Rust now removes trailing
slashes before removing the endpoint suffix, matching all 240,143 original
settings comparisons after the earlier 32 URL differences. All 513 settings
response and 992 provider failure-stage/detail comparisons also pass.

Worker deadline budgets now use the same Tokio clock as their timers. All six
original bridge tests pass after that correction, including the unchanged
601-second virtual advance. Three admission-budget tests, 293 primary requests,
237,801 mutations and all 98 custom callbacks pass. The corrected boundary
locator preserves all 83 original inputs byte for byte and adds three inference
configuration limits; all 86 native boundary comparisons pass. Two request
admission tests and 23,495 complete incoming worker comparisons also pass.

The three changed/new incoming/status roots pass 27,986 comparisons, including
complete error messages. The development probe compares Source's actual JSON
transport, matching the existing oracle's encoding of undefined issue metadata.
The original raw-JavaScript comparison failure remains retained.

The frozen earlier 0.7 Linux executor package built and passed its unchanged
Source management, worker Run execution and native-agent MCP tests in the owned
guest. That guest was stopped and removed, with package provenance and logs
retained. Those results remain scoped to the frozen Source/Node worker revision.
Current strict all-target Clippy and Rustfmt pass. Paired real HTTP checks pass
on PGlite, bundled PostgreSQL and external PostgreSQL in all three authentication
modes: 143, 147 and 149 observations per peer, respectively, or 439 paired
observations per store. Each peer also verifies four live inference-limit edits,
unchanged revisions on identical limits and preservation of its native runtime.
The boundary review adds only the numeric inference-configuration command; all
292 previous command classifications and all 535 route keys retain their exact
reviewed contracts. The generated inventory and its check pass. These results
do not establish full replacement, deployment or platform acceptance.

## Queued managed Goal provider transfer: source implementation

The shared handoff boundary now includes exact, worker-observed managed native
Goal continuations that have not forwarded input and own no canonical queue
claim. Node and Rust use a separate autonomous no-start deferral, preserving
existing GUI claim checks, original Goal state and explicit cancellation.
The worker must seal the original inference source and acknowledge actual native
runner invalidation before recording withdrawal. First-cycle `awaitingGoal`
claims, Task-private Goal channels and already-started turns remain outside this
transition. See [the inference lifecycle guide](PROVIDER_INFERENCE_CONCURRENCY.md#provider-transfers-for-queued-managed-goal-continuations).

This change received source review, formatting, mechanical protocol export and
`git diff --check` only. No tests, builds, typechecks, benchmarks, native/helper
execution, patch application, hosted validation or computer-use checks ran.
The Rust boundary remains partially implemented and source-reviewed; historical
validation above does not establish correctness of this extension or platform
acceptance. The exported protocol now has 631 roots and 10,588 nodes; Run remains
at 11 roots and 453 nodes. No route or worker-command surface was added.

The subsequent first-cycle extension retains an exact `awaitingGoal` claim
across the same worker-confirmed pre-start transfer. Node and Rust preserve its
applied parent setter and original encrypted input, retire only the unused child
operation, and allow that one claim through handoff idle boundaries. Route
affinity requires its exact captured identity and the current full settings
binding on a settled completed/cancelled handoff. The worker wake preserves that
claim's ordering ahead of later prompts while obtaining normal FIFO capacity.
The protocol export now has 631 roots and 10,592 nodes; Run remains 11/453.
This extension was source-reviewed and formatted, with mechanical protocol export
and `git diff --check` only. No tests, builds, typechecks, benchmarks,
native/helper execution, patch application, hosted validation or computer-use
checks ran. Neither this extension nor its boundary review establishes runtime
or platform acceptance, and the overall replacement remains partial.

The shared recovery contract subsequently adds optional typed autonomous Goal
epoch metadata. The worker and native lifetime keeper use it to distinguish
unused managed Goal attempts from GUI/Task inputs and private/resumed execution.
The exported protocol has 631 roots and 10,595 nodes, with Run unchanged at
11/453. Canonical autonomous reconciliation and durable wake-up are still
unfinished; the server's GUI-only path currently leaves these records unresolved.
This identity foundation received source review, formatting, mechanical protocol
export and `git diff --check` only. The native patch was not applied or executed;
no tests, builds, typechecks, benchmarks, native/helper execution,
patch-application checks, hosted validation or computer-use checks ran. It adds
no route or worker-command surface and establishes no runtime/platform acceptance.

## Native legacy worker CLI relay

The native server now implements all 35 legacy CLI commands through its existing
repositories and domain services, preserving the separate CLI context, error,
selector and audit contracts. Local all-three-store/all-three-authentication
qualification includes real HTTP, unchanged worker transport/client, admitted
write disconnects and server restarts. See [the CLI qualification](RUST_SERVER_CLI.md)
for exact counts, commands and the controlled-worker/platform boundaries. This
adds no worker rewrite or default-server cutover; complete product, packaging,
migration/rollback and replacement acceptance remain required.

## Opaque Chat attachments

The native server now owns opaque attachment upload, replica-aware download and
concurrent deletion, with transactional primary-replica creation and caller-loss
continuity. Local qualification covers all three database modes and all three
authentication modes: 486 paired HTTP observations, 423 full paired attachment/
replica SQL snapshots, actual INSERT failures, caller destruction, post-write
reopen and real quotas. See [the attachment evidence and limitations](RUST_SERVER_CHAT_ATTACHMENTS.md).
Node remains the default server; full product, platform, migration, rollback,
packaging and Winterhold acceptance remain required.
