# Workspace ownership implementation record

Status: **active and incomplete**. Cycles 1–5 and the boundary-inventory follow-up
[#2214](https://github.com/ArcaneArts/Cantrip/pull/2214) are merged. The target contract is not
a claim that all surfaces and recovery paths already satisfy it.

## Target contract

Ownership is device workspace → window → pane → tab → resource. Each tab has
one pane owner; each pane has one window owner. Moving preserves identity.
Workspace scope includes installation, account, server, and project—not viewport
size. Mobile and desktop share resource availability, not placement changes.

View close, native window close, and resource deletion are separate operations.
Active-tab close selects right, otherwise left; inactive close preserves
selection. An emptied pane selects the window's most recently focused survivor.
Popout close returns only surviving views, without placeholders or resurrecting
closed tabs. Application quit must not trigger normal return/reopen loops.

Transfers must preserve dirty inactive documents without mandatory saves or
plaintext persistence. Destination restoration, not native creation, establishes
readiness. Attachment generations fence stale renderers. A timeout alone never
proves an owner died. All production layout writers must use the same command
model; file preview/pin are ordinary tab state, not competing identities.

## Merged cycles

| Cycle | Foundation                                                                 | Merge                                                                 |
| ----- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1     | Versioned identities, validation, legacy seed conversion                   | [#2209](https://github.com/ArcaneArts/Cantrip/pull/2209), `54bf48971` |
| 2     | Revisioned commands, adjacent close selection, local focus, open-existing  | [#2210](https://github.com/ArcaneArts/Cantrip/pull/2210), `5bd2edad7` |
| 3     | Authorized persistence, transactional revisions, durable receipts          | [#2211](https://github.com/ArcaneArts/Cantrip/pull/2211), `deb9f73cd` |
| 4     | Session-bound client queue, pending reconciliation, stale-response fencing | [#2212](https://github.com/ArcaneArts/Cantrip/pull/2212), `1f2abe76e` |
| 5     | Production shell integration, editor/terminal transfers, mobile file tabs  | [#2213](https://github.com/ArcaneArts/Cantrip/pull/2213), `18b67a29e` |

Cycle 5 merged before its CI finished. App API CI found 16 stale source-line
references in the boundary inventory after formatting; regenerating the inventory
changes no authorization classifications. The regenerated inventory check and
network tranche-two verification pass locally. Server contracts also report the
timeout-policy count mismatch (expected 10, observed 6); Windows worker commands
report the broken-symlink creation assertion. These are not waived or claimed green.

The final native QA fixture exited with code 0 and no surviving owned worker or
server processes or sockets. Its harness and evidence were preserved at
`/tmp/cantrip-workspace-qa-85gyIh/cycle-5-qa.tar.gz` before recoverable worktree
archival was requested. Primary was fast-forwarded to the verified merge tree.

Merged-tree checks were performed and worktrees submitted for recoverable
archival. Primary was synchronized after these cycles. These foundations alone
did not enable the new shell.

Cycle 1 passed 569 protocol tests. Cycle 2 passed 608, with 72 focused checks
repeated after merge. Cycle 3 passed 16 database/title/tenant tests and 848
protocol tests; its 13 persistence cases were repeated after merge. Cycle 4
passed 19 new client tests again after merge, 40 focused client tests, 848
protocol tests, and 13 server workspace tests. Its App API CI passed on all
three platforms. Relevant build/typecheck and boundary checks also ran.

Broader CI was not uniformly green: earlier runs exposed the server
timeout-policy count, Windows symlink creation, and a worker Git index-lock
collision. Cycle 3's attributable boundary inventory omission was corrected in
Cycle 4. Historical failures are not waived or counted as passing.

## Cycle 5: current integrated implementation

- The shell mounts ownership and projects only the current window. Opening,
  selection, view close, layout commands, and creation use the controller.
  Initializing ownership cannot fall back to legacy mutations. Missing resource
  query data retains loading/error tabs.
- Bootstrap derives durable device scope, reads existing state before seeding,
  and imports observed native owners. Errors do not manufacture empty layouts.
  Coalesced reads cannot overwrite newer receipts. Focus/reconnect and five-second
  refresh synchronize windows without treating observer failure as owner death.
- Resource removal cleans affected views transactionally across device
  workspaces. Client deletion avoids legacy whole-layout rollback. Explicit
  archive/delete remains separate from view close.
- File links and sidebar preview/pin use the owned-file opener. Creation
  coalesces through acknowledgment, explicit path-specific resources are reused,
  existing modes are preserved, and new editable files start in Edit mode.
  Pinning preserves identity; dirty reports pin previews.
- Mobile navigation keeps distinct file identities and layout order, with
  scroll/picker overflow instead of worktree deduplication.
- Separate tab and whole-pane actions use generation-bound reservations and
  protected state envelopes. Destination components acknowledge restoration
  before ownership commits. Normal native close returns surviving panes before
  destruction. Failed preparation retains source state.
- Transfer adapters currently cover Explorer, Code, and terminal. Chat, browser,
  remote-desktop, and other relevant surfaces remain unfinished.
- Browser/remote-desktop transport now exposes nested, idempotently released
  input suspension and a drain barrier covering asynchronous encryption, queued
  chunks, backpressure, and worker transport acknowledgment. Replaced or closed
  attachments reject the barrier instead of approving retirement. The React
  transport hook exposes these operations for the remaining lifecycle adapters;
  neither browser-action completion nor destination restoration is implied.
- Close/delete preparation awaits confirmation without prematurely discarding
  buffers. Guards include inactive document revisions and resource/session
  identity. Reload/back reject stale answers. Terminal handoff drains accepted
  input before retirement.
- After native creation, transfers observe the exact destination window label.
  Actual destruction or confirmed absence before readiness/restoration rejects
  the handshake and cancels the reservation before resuming source input.
  Observer installation errors preserve their actual error instead of claiming
  a crash. Observers are released after success/failure; a late close after
  commit cannot resurrect source ownership. This covers interrupted handoff,
  not recovery of already-committed ownership after a window crash.
- Editor confirmations use the supported JS dialog API. The installed Rust
  shim calls `plugin:dialog|confirm`, but registers only open/save/message;
  the supported JS API invokes `plugin:dialog|message`. Editor windows receive
  narrowly scoped message-dialog permission.

### Verification

Latest completed broad app run: **516 files, 3,545 tests passed, three skipped**.
Protocol: **89 files, 881 tests passed**. Later confirmation/close changes passed
54 editor tests, 43 dialog/related tests, and 22 close/CRUD tests in their
respective focused runs. Server ownership/account-storage tests passed 19 cases.
App typecheck, native compilation/check, and diff checks passed at recorded
integration points. Earlier broad results do not prove the exact final tree.
The app and protocol totals above were rerun immediately before packaging this
cycle, after the destination-close and remote-input-drain changes.

The CI workflow now explicitly runs asynchronous close/delete confirmation and
terminal/mixed-pane transfer coverage. A fresh run of those 13 suites passed
all 131 tests after the workflow update; diff whitespace validation also passed.

The latest full worker run finished with **259 files passing, six failing,
31 skipped; 2,489 tests passing, 10 failing, 133 skipped**. Failures include
external-history reader version rejection, missing pinned gateway method
classifications, Chromium initial capture, outbox timeout, filesystem-notification
timing, and Sharp boundary timeout. There are no worker source edits in this
branch, but attribution still needs verification; that fact alone does not prove
baseline failures. The full server run also finished: **253 files passed,
11 failed, eight skipped; 1,493 tests passed, 13 failed, 57 skipped**. Failures
include five-second database tests, the unresolved app alias, missing test
fixture methods, the timeout-policy count, and a test expecting a retired
plaintext repository route to return 200 instead of its actual 410 response.

A serial rerun of workspace ownership, account storage, task-inline migration,
and workspace-binding immutability passed all 22 tests in four suites with the
original timeouts unchanged. The two migration timeouts did not reproduce in
that run; this does not classify the other broad-suite failures as resolved.

Destination-closure recovery passed 51 tests across native-window utilities and
the transfer coordinator, including pre-ready close, pre-restoration close,
observer failure, exact-label isolation, and post-commit cleanup. App typecheck
and diff checks passed. Native crash interaction still requires real-window QA.

Remote-surface transport passed 15 tests including browser/desktop drain,
blocked credit, acknowledgment delay, nested suspension, and interrupted drain
on reconnect. App typecheck passed. Production transfer adapters still need to
consume these primitives and receive real native acceptance coverage.

An earlier `pnpm check` passed audits, Rust formatting/Clippy, scripts, CLI/CUA,
selected app, protocol, logging, and crypto before failing server tests.
Baseline source inspection found a task-operation fixture missing
`taskRetries` and a server test importing an app module with an unresolved app
alias. This is source attribution, not a clean baseline execution establishing
every failure as unrelated. Neither broad server nor worker validation is green.

### Native and UI evidence

QA uses disposable services and unique bundles under
`.qa/20261024-010046-validate-identity-based-workspac/`. Fixture-only loopback
configuration does not alter production transport policy.

- `logs/native-workspace-tab-permissions.log`: moving dirty `second.txt`
  left dirty `qa.txt` in main; existing-file open focused its native owner;
  native close returned the surviving tab with unsaved text.
- `logs/native-workspace-pane-close.log`: whole-pane movement preserved both
  dirty files, including the inactive draft; main had no placeholder. Closing
  one tab selected the other; native close returned only the survivor. This
  exposed missing dirty-close confirmation, not a confirmation pass.
- `logs/native-workspace-async-confirm.log`: dirty-tab transfer worked, but
  Refresh reported confirmation failure and retained the draft. This led to
  the supported dialog API correction.
- `logs/native-workspace-message-confirm.log`: rebuilt fixture for that
  correction compiled successfully. Automation observed its landing page but
  could not activate web controls; coordinate calls reported
  `noWindowsAvailable`, while native menus worked. Confirmation replay is
  **not passed**.

Terminated fixtures reported no surviving owned worker/server processes.
Re-observe a live session before deciding it stopped; observation failure is
not a reason to restart. The existing browser harness aggregate (23 passing
checks) does not prove all native, mobile, or recovery requirements.

## Remaining implementation and acceptance

### Browser lifecycle increment

The next isolated cycle replaces selected-only browser rendering with a
tab-keyed persistent layer. Inactive tabs retain their address drafts and live
renderer, temporary resource-query gaps retain resolved metadata, and actual
ownership removal releases the view. Account/session and project changes reset
the retained layer. The stable portal is shared across docked and inline/mobile
presentations; hidden views do not resize the worker viewport to hidden bounds.
Address drafts survive blur and background page updates; navigation commits them
and Escape cancels them. Shell callbacks retain the owning browser/project/pane.

This persistent-browser increment merged in PR #2215 (`b2218469c`). Browser
cross-window transfer is the next isolated increment described below.
Regression tests cover draft retention, query gaps, ownership removal, responsive
portal continuity, resource replacement, and shell callback routing. Final-tree
app validation passed 518 files / 3,549 tests with 3 intentional skips; app
typecheck, focused tests, formatting, boundary inventory, transport verification,
and diff checks also passed.

### Browser cross-window transfer increment

Browser tabs now join mixed-pane encrypted handoffs with exact tab/resource/
project/worker scope validation. Source input is suspended, accepted asynchronous
navigation/clipboard work and transport writes drain, and the destination restores
the private address draft and captured viewport before acknowledging an actual
rendered frame. The passive destination cannot navigate or repeat clipboard and
metadata writes. Source retirement releases only its renderer attachment; the
worker-owned Chromium session survives. Cancellation can reattach a retired source.

Native fixture `editor-31072094-30ab-4528-a670-56753637d65b` verified an unsent
address draft surviving pop-out and native-window close/return with the loaded
page rendered in both destinations. Worker logs retained one browser runtime,
temporarily two attachments during passive staging, and one after retirement.
An earlier run exposed a missing initial-frame request after stream lanes opened;
the rebuilt run passed that round trip after the correction. Repeated detach also
displayed the preserved draft. A subsequent native automation interaction reported
`noWindowsAvailable`; close-tab and concurrent-window acceptance are not claimed.
The final passive clipboard/metadata guard still needs a final rebuilt QA replay.

State-parser regression tests cover private draft preservation, malformed values,
empty identities, and mismatched browser/project/worker reservations. The focused
parser/operation-boundary/mixed-batch run passed 19 tests; app typecheck passed.
Final-tree app validation passed 521 files / 3,569 tests with 3 intentional skips;
app typecheck and diff checks passed. This increment merged in PR #2216
(`c3465a4e8`). The native QA evidence is archived at
`/tmp/cantrip-browser-handoff-qa-TW922F/browser-handoff-qa.tar.gz`.

### Window-scoped tab recency increment (in progress)

Window ownership now records observed tab activation separately from tab order.
Legacy layouts start without tab history rather than deriving fictional recency
from their persisted order. Commands prune closed and transferred tabs from the
source window's history; destination activation records only the activated tab.
Closing an inactive tab does not manufacture an activation. Active-tab close
continues to choose the right neighbor, otherwise the left, independently of MRU.

The mobile picker presents up to five available, deduplicated recent views from
its current window, while retaining the complete Open views list. Selection uses
the same existing tab identity and command path. Schema checks reject duplicate,
missing, and foreign-window history IDs. Protocol validation passed 89 files /
889 tests; focused mobile-picker and client reconciliation tests passed 29 tests.
Full app validation passed 521 files / 3,570 tests with 3 intentional skips;
app typecheck and 15 server workspace-layout tests passed. Formatting and diff
checks passed. A real-component phone-width (390 × 844) browser harness passed
touch selection, dialog close/reopen, deduplication, five-item recency ordering,
and access to the twelfth open tab in Chromium and WebKit with no page errors.
This isolated component harness does not establish simultaneous-device isolation
or full-shell persistence. Evidence is in QA session
`20261024-033256-validate-mobile-recent-tab-picke`; merged as PR #2217
(`621e4a069`). QA evidence was preserved at
`/tmp/cantrip-recency-qa-3PgZ8l/mobile-recency-qa.tar.gz`.
Post-merge CI exposed the Windows dangling-symlink create failure, also present
in earlier run `40074994363`. Server-contract failures in run `40078679437`
are the timeout-policy inventory assertion (expected ten call sites, found six)
on all three platforms. Final CI: 15 passing checks and these four failures;
this is not an all-green CI claim.

### Atomic preview replacement increment (merged #2218)

Merged as `ead4ba1ba`; the merged tree was compared with tested commit
`91fa15b57` and matched exactly. Primary was clean and fast-forwarded. CI was
still running at handoff; do not interpret merge as an all-green CI result.

The new isolated cycle introduces one atomic open/replace operation scoped to
an existing file preview in the same pane. A pin that wins a revision race keeps
the old view and appends the new file instead. A moved replacement target rejects
the operation rather than closing a view in another pane. The protocol suite
passes 65 files / 652 tests in the fresh worktree, including these three cases.
The sidebar file-open path now requests a renderer-side clean-state reservation.
Dirty, saving, transferring, or uninitialized text documents cannot be replaced;
loaded clean previews stay inert until the command settles. Replacement is not
optimistically projected, so rejection retains the original renderer rather than
unmounting and recreating it. Unknown transport outcomes retain the reservation
through explicit retry. Controller success/rejection/uncertain-outcome tests and
focused file-opening/editor tests passed (48 tests); app typecheck passed.
A regression reproduced a reservation leak when synchronous command construction
throws; the controller now releases that reservation without sending a command.
The app suite passed 521 files / 3,575 tests, with 3 skipped. An additional renderer
test then passed in the 13-test editor-mode suite: reservation makes the clean
editor read-only, rejects a second reservation, and idempotent release restores
the same textarea and contents. This is component evidence, not native handoff QA.
The editor-mode suite now passes 14 tests, including refusal while dirty or
saving and successful reservation after save completion. Additional protocol
coverage verifies concurrent existing-file focus and invalid replacement inputs.
A pending-detach regression initially failed: replacement could remove a tab
reserved by a transfer. The mutation now explicitly rejects that replacement;
the full protocol suite passes 89 files / 897 tests. App typecheck and diff checks
passed. Browser interaction QA passed in Chromium and WebKit using real
ExplorerView/document-session/controller/protocol code with fixture file APIs
and in-memory transport: clean replacement, typed dirty-buffer preservation,
and rejected replacement retaining the original editable textarea. Evidence is
in `.qa/20261024-035232-validate-preview-replacement-wit` (two collected pass
events and screenshots). The runner waits for command completion before arming
rejection. This does not establish full-shell/native transfer or production
styling correctness; the fixture editor layout is intentionally minimal.
Final rebuilt-package verification: app typecheck; 521 app test files with
3,577 tests passed / 3 skipped; 15 server workspace-layout tests passed.
QA evidence archive: `/tmp/cantrip-preview-qa-Fbxu6Q/preview-qa.tar.gz`.
Do not substitute an unguarded close-then-open pair for this integration.

### File-document separation increment (in progress)

Source inspection after #2218 confirms that `openOwnedFile` still searches
`getExplorers` and allocates a mutable Explorer record per path. Workspace file
resources still resolve through `resolveEntitySurface` to the Explorer table;
`removeResourceWorkspaceViews` also treats Explorer deletion as file-resource
deletion. File reads/writes use the Explorer operation relay, which validates
owner/project/worktree/worker bindings before forwarding encrypted operations.
That validation and protected document-session behavior must survive separation.

The next increment must introduce dedicated file-document resource records with
immutable checkout binding and protected path identity. View mode and selection
belong to the tab, not that resource record. Do not use a plaintext path or an
unkeyed path hash as a durable layout identifier: current Explorer paths are
encrypted private state. Reuse protected envelope machinery with explicit file
classification and authority checks rather than renaming Explorer IDs.

Implementation touchpoints: protocol document/crypto classifications; repository
schema, migration and resource validation; file-operation authorization/relay;
client protected catalog and file opening; surface index/rendering; view-state
persistence and transfer; migration of existing file views; resource-deletion
semantics. Existing Explorer tree navigation remains separate. This work is not
complete until all file entry points use the new records and the competing
Explorer-backed identity/provisioning paths are removed or migrated.

Initial implementation adds dedicated opaque file-document create/catalog
schemas and an authenticated file-document-state classification bound to its
own resource table/field. Protected content carries checkout binding and path;
wire creation rejects plaintext paths and view-only fields. Protocol and crypto
builds pass; focused contract/codec checks pass 16 tests; full protocol suite
passes 90 files / 904 tests. Full crypto run has 95 passing / 1 failing test:
the existing repository-operation ciphertext-tampering assertion resolved
instead of rejecting. Investigate its encoded-byte mutation before attributing
the failure or claiming the crypto suite passes. Storage, routes, app consumers,
and migration are not yet implemented; this cycle is not ready for a PR.

Follow-up: the repository-operation test replaced the final base64 character
with a fixed `A`, which can leave ciphertext unchanged. It now flips a decoded
byte and asserts the bytes differ; the full crypto suite passes 20 files / 96
tests without changing production decryption. Added the file_documents table
and migration 0233 with protected state and project/worker/worktree foreign keys,
but no path or view preference columns. PGlite migration/reopen succeeded in the
15-test workspace-layout suite. File repository authorization, routes, migration
of existing file views and app integration still remain; table creation alone
does not establish those behaviors.

Repository follow-up: added owner-scoped document list/get and transactional
creation, deriving the worker from the authorized ready checkout. Creation locks
the project/source/worktree/worker authority rows, rejects removed sources and
unlinked workers, preserves immutable protected location, and accepts exact
request retries without inserting duplicates. Dedicated PGlite tests exercise
creation, replay, conflicting ciphertext, and foreign owner/project/missing
worktree denial. An initial test used noncanonical base64url and correctly failed
schema validation; corrected the fixture to encode actual bytes. The document
and workspace-layout suites now pass together (17 tests), and server typecheck
and diff checks pass. Routes, execution routing, app consumption, deduplication
of concurrent opens, and legacy-view migration remain unfinished.

Catalog API follow-up: registered owner-scoped list/get/create routes in the
interactive workspace registry, with schema validation and typed immutable-ID
conflicts returning HTTP 409. The migrated-database repository/API suite passes
4 tests, including foreign-owner denial and plaintext-field rejection. Added
client catalog helpers and protected document encoding/decoding; decoding checks
project, worker, and worktree against authenticated ciphertext as well as the
document-ID associated data. Requests capture the client session and discard
results across account changes. Focused adapter/API tests pass 8 tests, including
logout during encryption (no write sent) and account switch during catalog
decryption (no stale result returned). Server and app typechecks pass. These
helpers are not yet connected to file-opening UI, and worker file operations,
cross-window open deduplication, and legacy document migration remain next.

Document operation follow-up: added the `file-document.operation` worker command
and a distinct authenticated stream kind. The server resolves owner/project/
source/worktree/worker authority from storage, rejects client root injection,
and forwards the stored protected location. The worker authenticates that
location and permits only read/write/media operations on its exact path, using
the existing confined filesystem and version-checked save implementations.
Added a session-bound client executor with response operation/sequence/path
checks. The protocol suite passes 90 files / 904 tests after explicitly adding
the command to the compatibility inventory while preserving the old baseline
fingerprint. Worker tests pass 9 cases with real encrypted payloads and mocked
filesystem calls (successful read/write, protected failure, replay rejection,
wrong path/operation, and checkout binding). Server PGlite/API tests pass 5 cases,
including stored-root routing and foreign-owner denial. App, worker, and server
typechecks pass. Actual file-editor integration, media playback, cleanup policy
for documents whose worktree is removed, and native/UI operation QA are not yet
established by these tests; this cycle remains unmerged.

Viewer integration preparation: extracted an explicit `FileAccess` contract and
document-backed adapter for text read, versioned save, and chunked media. The
viewer now accepts this I/O independently of Explorer APIs, including reloads
and media rendering, with a document-specific query-cache identity. The existing
protected media assembly/metadata checks are shared rather than duplicated.
The native document-session component test verifies document-backed load/edit/
save without calling Explorer read/save APIs and confirms dirty state clears
after save. Focused native-session, markdown, and mode suites passed 51 tests;
after cache-identity changes the native-session/adapter suites passed 34 tests.
Adapter checks cover wrong-path refusal and document media routing. App typecheck
and diff checks pass. This is not yet a full document-tab UI: the viewer's
resource/view-state shape, shell catalogs, open actions, transfer payloads, and
legacy migration still need conversion before the cycle can be delivered.

Document view-state follow-up: the shared editor now accepts a discriminated
document-view model rather than requiring a complete Explorer entity. Added
`FileDocumentView` with separate tab/document identities and explicit per-view
mode/link callbacks. Document mode changes do not call Explorer persistence;
document views cannot fall back to a file tree or expose an Explorer back action.
Transfer capture carries document identity, and validation binds its selected
path and all transferred drafts to the document's exact worker/worktree/path.
The component test renders a document view without Explorer entity metadata,
checks mode isolation and identity capture, and the transfer tests reject wrong
document IDs, paths, legacy scopes, and foreign inactive drafts. Native-session,
transfer, markdown, and mode suites pass 67 tests; app typecheck and diff check
pass. These remain component/validation checks, not full native QA. Shell
catalog/open/render wiring and migration are still required.

The #2218 CI watcher reached terminal failure. Server contract logs on all three
platforms identify the timeout-policy inventory assertion (expected 10 streaming
uses, found 6); the Windows worker failure concerns dangling-symlink file
creation. These failures remain unresolved, not waived or counted as passing.

Document catalog integration follow-up: the shell now queries protected file
documents separately from Explorers and includes them in surface resolution.
An owned `project.file` can hydrate as a distinct file surface without any
Explorer row. Missing catalog data retains the same unresolved tab identity;
documents from another project are not hydrated. File surfaces are excluded
from the generic panel-creation menu, and overview sorting uses placement
timestamps rather than assuming document metadata is mutable. Compatibility
close bookkeeping retains the member kind; owned close operations continue to
dispatch `close-tab`, not resource deletion. Five focused surface, selection,
close, presentation, and create-menu suites pass 42 tests; app typecheck and
diff check pass. Catalog refresh currently polls because document resource-stream
invalidation is not yet implemented. File opening, persistent rendering,
cross-window deduplication, migration, and native verification remain unfinished;
this cycle is not ready for its PR.

Document create retries now resolve an actual HTTP conflict by reading and
decrypting the existing immutable document, accepting it only when document ID,
project, worker, worktree, and path all match the requested location. This
handles fresh encryption nonces without weakening server ciphertext binding or
overwriting an existing document. Successful creates receive the same binding
validation. Account changes stop recovery; non-conflict and lookup failures
propagate without a second create. API, file-access, and encryption suites pass
22 tests; app typecheck and diff check pass. This does not yet solve concurrent
cross-window creation with different document IDs; catalog deduplication and
the opening/rendering migration remain required.

The workspace-owned opening entry point now resolves the file-document catalog
and creates immutable documents rather than file-specific Explorer rows. It
obtains the worker binding from the selected project worktree for encryption;
the server remains responsible for actual creation authorization. Existing
documents are reusable even without an open tab. Cache updates go to the
document catalog, and placement/pinning still use workspace commands. Existing
coalescing, delayed-acknowledgment, retry, and disposed-controller tests were
ported to document records; additional tests cover unopened catalog documents,
missing worktree bindings, and catalog failures. Four focused suites pass 59
tests; app typecheck and diff check pass. The persistent rendering layer still
needs a document-view lane, and default/explicit view mode must be wired there.
Legacy tab migration and cross-window document deduplication remain outstanding;
the intermediate opening change is not ready to ship on its own.

Persistent document rendering now mounts a distinct view per tab, uses stable
pane portals, and retains the last committed document across catalog loading
gaps. It drops retained state when ownership disappears or the resource binding
changes. Per-view mode starts from the existing file-language default and
survives inactive selection; links route back through the unified file opener.
Document close confirmation/cancellation uses the tab-key lifecycle registry,
and dirty pinning resolves that view key to its owned document resource. The
frame leaves document content to this persistent layer instead of rendering a
competing surface. Three focused retention/link tests plus the existing native
session component suite pass 35 tests. This is component verification, not a
native-window test. Transfer staging/restoration, persisted view-mode recovery,
remaining header/selection adapters, and actual native QA are still required.

Document transfer wiring now uses the tab-key lifecycle at the source and binds
captured state to the document ID plus worker/worktree/path. The destination
loads document records, validates that scope, and stages first-class documents
separately from legacy Explorers. Incoming document views mount passively before
ownership commit, receive the snapshot and restoration callbacks, and initialize
their mode from transferred state. The existing acknowledgment barrier remains
in place; mounting alone does not acknowledge restoration. Added source,
destination, and passive-renderer regressions. Five transfer/retention suites
pass 38 tests; app typecheck and diff check pass. Real native transfer of dirty
documents is still unverified, and persisted mode recovery, catalog race
deduplication, cleanup policy, and legacy migration remain outstanding.

Document cleanup semantics: a real migrated PGlite regression reproduced a
checkout rollback blocked by the new restrictive document/worktree foreign key.
The unmerged document schema now retains worker/worktree IDs as immutable
historical location bindings, without retaining those catalog rows. Creation
still validates and locks actual ownership records, and execution still requires
the current authorized ready checkout. The regression verifies successful
rollback, unchanged owner-visible document metadata, unavailable execution,
foreign-owner denial, and denial of new documents against the removed checkout.
Document, worktree-migration, and project-placement suites pass 37 tests; server
typecheck and diff check pass. The broader worktree-api suite has 27 passing
tests and one failure at its legacy status-route assertion (line 4159: expected
200, received 410 for the retired plaintext route). That suite is not counted as
passing and its failure remains to be resolved. Native recovery after checkout
removal remains unverified.

Document tab action audit found generic rename/delete falling through to
project-tool resource mutations. Document surfaces now explicitly bypass those
mutations and hide those resource actions in the tab menu; closing still routes
only to view closure. Actual filesystem rename/delete remain separate Explorer
operations, not implicit document-tab actions. The shared file predicate accepts
document surfaces, and the tab strip uses their document path for language icons.
Added command-boundary and rendered-tab regressions. Three focused suites pass
42 tests; app typecheck and diff check pass. This does not complete the remaining
header/selection, migration, deduplication, or native verification work.

Broad app validation exposed missing document-renderer mocks in the persistent
surface tests and an unchecked surface-definition lookup. Updated the mocks
without removing their browser/terminal assertions, guarded the lookup, and added
a document-view routing regression covering tab identity, pane placement,
incoming transfer forwarding, and exclusion of transferred views. The initial
run also could not resolve the unbuilt local `@cantrip/glitch` package; its normal
build succeeded. The subsequent complete app suite passed all 524 test files:
3,611 tests passed and three skipped. App typecheck and diff check also passed.
This is automated app coverage, not native handoff or simultaneous-device QA.

The file-selection audit found the shell still derived context only from legacy
Explorer tabs. First-class document selection now supplies its immutable worker
and worktree binding for observation, script-command context, and window header
path/title. It is not exposed as a mutable Explorer binding target. Pane render
bindings separately select the document and do not substitute the focused pane's
worker when that document's worker is unavailable. Added header and pane-binding
regressions; the three focused selection/header suites pass 25 tests and app
typecheck passes. Mode persistence, catalog migration/deduplication, and native
transfer validation remain incomplete.

Added optional per-tab `fileMode` metadata and a `file-mode` workspace command
as the durable foundation for restoring explicit modes. Only `project.file`
views may carry it; mutations use the existing window ownership, generation,
revision, and command reconciliation checks. No path, buffer, cursor, or other
private content is added to layout metadata. Tests cover all three modes,
unmodified sibling views/input state, preservation on pane moves, invalid modes,
non-file rejection, and cross-window rejection. All 909 protocol tests pass;
protocol build and server/app typechecks pass. The UI still needs to dispatch
this command and restore the tab field, so mode persistence is not yet delivered.

The mode command is now wired from document editor controls through the shell's
workspace controller. Surface projection carries each tab's saved mode even
while its document catalog entry is loading, and retained document views restore
that preference on remount. Document mode writes now share the editor's async
view-state queue, pending state, and visible error handling; transfer capture
waits for the queue. Failure is not returned as successful persistence. Added
coverage for callback identity, remount restoration, authoritative mode updates,
projection during loading, and failed writes in the real editor wrapper. All
524 app test files pass (3,615 passed, three skipped); app typecheck and diff
check pass. Actual reload/native transfer QA and protected cursor/scroll recovery
remain unverified; this does not complete the document or overall cycle.

Server validation now includes real migrated-database file-mode persistence:
reloading layout state preserves mode, stale command replay cannot replace a
newer mode, the second device workspace remains unchanged, protected document
state remains byte-for-byte equivalent, and another owner cannot mutate it.
Document/workspace suites pass 22 tests; worker document-operation tests pass
all nine. Production app build succeeds (with chunk-size and static/dynamic
import warnings). The worktree API suite was rerun: 27 pass and one still fails
because its plaintext status request expects 200 but the request policy returns
410 with the protected-operation migration message. The status route's source
explicitly documents that tombstone. No endpoint was re-enabled and no test
expectation was weakened; migration of that test's routing coverage remains open.

New document IDs now derive from an account-keyed, domain-separated lookup of
server/account/project/worker/worktree/path, encoded as an application-defined
UUID. This makes independent windows converge on the same new document ID;
existing catalog IDs still win. Ciphertext revision changes do not alter the
identity derivation version. Actual master-key replacement changes newly derived
IDs, so existing catalog reuse remains required (catalog decryption errors are
not treated as an empty catalog). Paths are not hashed without a key or added
to plaintext metadata. The existing conflict read/decrypt/binding check handles
different encryption nonces without overwriting an immutable record. Tests cover
scope/key isolation, locked/mismatched accounts, independent controllers,
protocol UUID acceptance, and database concurrent creation preserving exactly
one envelope. Full app suite: 524 files, 3,617 passed, three skipped; focused
server document suite: eight passed; app typecheck and diff check pass. Native
multi-window opening is still unverified; legacy document migration remains open.

Native document QA setup (2026-10-24): the isolated current-source desktop build
completed and rendered against its disposable server. Initial worker startup
failed on the actual missing CLI; `pnpm cli:build` succeeded and restarting only
that fixture worker restored its heartbeat/command channel and online UI state.
Native UI automation can inspect the window but input returns
`noWindowsAvailable` despite a live native process. No document transfer or mode
restoration pass is claimed from this run; optional manual observations were
requested. The QA fixture also reports an incompatible PATH Codex, so it does
not establish agent-execution compatibility. Scenarios and observations remain
under `.qa/20261024-045922-validate-first-class-file-docume`.

Document catalog live integration (2026-10-24): successful document creation now
uses the existing authenticated mutation hook to emit a project-scoped
`file-document` invalidation. Clients refresh only the document catalog, including
project reconnect resync; no placement invalidation or shared view selection is
introduced. Protected read/write operations leave the immutable catalog alone.
Polling remains the fallback when project live updates are unavailable. Focused
client live-query suite: 30 passed; server invalidation routing suite: six passed;
protocol build passed. Native cross-window delivery remains to be observed.

Broad-cycle validation (2026-10-24): the initial `pnpm check` stopped at the
server-boundary reviewed-contract inventory. Reviewed the four new document
routes, encrypted durable table, worker operation, and content-free live resource;
added explicit classifications plus opaque route/worker protocol assertions.
The updated route-set digest matches exactly the prior inventory plus these four
routes; worker/live digests likewise add only their named document contracts.
Regenerated the inventory, including source-line changes, and the audit passed.
The subsequent broad check passed decomposition, workflow removal, network
audits, Codex source verification, CLI/interaction/CUA formatting and strict
Clippy. Remaining typechecks/tests were still running at this checkpoint; this
is not a claim that the complete check or native document QA passed.

Protected file-operation client coverage (2026-10-24): extended the existing
mocked API suite with eight cases covering exact request/response document,
operation, direction and sequence binding; content-free wire requests; stale
operation/sequence rejection before decrypting; wrong-file results; worker error
propagation; and account changes during encryption, transport, and decryption.
All 22 API tests passed. These are client validation tests, not evidence of a
native transfer. The same broad check continued through all workspace typechecks,
221 root script tests, 15 CLI tests, interaction/CUA native suites and CUA worker
tranches (246 passed/three skipped, then 319 passed), and entered workspace tests;
its final outcome was not yet available at this checkpoint.

Broad-check follow-up: protocol 909, crypto 96, logging 37, and glitch 16 tests
passed. Server tests reported local-foundation and worktree-api failures while
the suite continued. A separate local-foundation rerun reproduced its failure at
line 1771: the provider-create response lacks the required provider summary
fields. This is not yet attributed to a cause or proven pre-existing by a clean
baseline run. No assertions were weakened. The full check remains non-green.

Local-foundation diagnosis: the initial provider POST omitted required
`initialAccount: null` for a non-account provider. Supplying it and asserting 201
before parsing advances the test. Its preferences assertion now compares against
the initial preferences plus explicit updates, preserving exact equality while
checking that unrelated preferences survive. The next reproducible failure is
the ChatGPT provider fixture: it omits the protected initial account and expects
plaintext account labels although the route returns wire summaries. This test
needs further encrypted-fixture migration; it has not passed and production
validation has not been loosened. The ongoing broad run predates these fixture
edits and must not be represented as validating them.

Validation checkpoint (2026-10-24): the broad check has now terminated with
seven failing server test files (nine failed tests, 1,497 passed, 57 skipped).
Observed failures include the removed plaintext worktree status route, the
streaming timeout inventory count, and an incomplete continuation-runtime mock.
These failures have not been proven pre-existing by a clean baseline run.
The partial local-foundation fixture edits described above were removed from
this cycle: they did not complete that fixture migration and are unrelated to
document ownership. No production contract or test assertion was relaxed.
Fresh focused reruns passed all 42 client tests across document API, retained
views, file access, and owned-file opening, plus 14 server tests across document
persistence and live invalidation. `git diff --check` passed. Full-suite success,
native dirty-buffer transfer, and completion of this cycle are still unproven.

Native follow-up (2026-10-24): accessibility input recovered on the same live
isolated fixture. Created a folder project through the normal UI; qa.txt and
second.txt opened as separate editable tabs, each with an unsaved draft. A
single-tab popout restored second.txt's exact draft. Closing the native window
returned that tab and draft after visible delayed reconciliation; the inactive
qa.txt draft also remained intact when focused again. Revision conflicts appeared
in the transfer logs. This verifies this single-tab round trip, not immediate
return rendering, multi-tab pane transfer, explicit tab closure, crash recovery,
or mobile behavior. Detailed observations remain in the QA session record.

Multi-tab native follow-up: Move Pane to New Window restored both dirty file
tabs, including the inactive draft. Explicitly closing second.txt prompted for
unsaved-change confirmation and left qa.txt intact. Closing that window returned
only qa.txt with its draft; second.txt was not resurrected. Return still showed
a temporary empty main workspace. Also identified the global content fallback
rendering EmptyWorkspace below first-class file editors: added file-kind handling
beside existing retained editor cases. App typecheck and diff check pass; the
static QA build predates this fix, so its visual correction remains unverified.

Rebuilt native QA follow-up: rebuilt the isolated preview assets from current
source with old hashed assets retained for the live source window. A newly
opened native file popout restored the unsaved first draft and no longer rendered
the EmptyWorkspace graphic beneath the editor. The production Vite build passed
with existing chunk-size, dynamic-import, and browser-crypto warnings. This
closes the visual verification gap for that fallback fix, not the outstanding
return-reconciliation delay or remaining full-goal lifecycle requirements.

1. Complete first-class document/view separation beyond path-specific Explorer
   backing, safe preview replacement, and legacy preview/provisioning/rebind
   removal, including synchronous confirmations.
2. Implement chat, browser, remote-desktop, and other lifecycle adapters with
   actual restoration acknowledgment and correct live-session ownership.
3. Complete crash/reload/reconnect/quit/restart and interrupted-transfer recovery;
   prevent shutdown return loops, duplicate renderers, and stranded ownership.
4. Finish legacy file-window/link migration; remove remaining placement side
   effects and competing writers. Verify older-client isolation, idempotent
   migration, and actual detached-window import.
5. Verify interaction-based mobile recency, simultaneous device isolation,
   overflow, keyboard focus, and every file-opening entry point.
6. Replay native confirmation/failed-return cases and expand real native QA to
   concurrent popouts, inactive drafts, all adapters, and lifecycle recovery.
7. Continue investigating CI failures without weakening assertions. The Cycle 5
   inventory repair merged in #2214 and passed the audit on the merged tree.
8. Update `docs/TABS.md` to the final enabled contract and audit every objective
   requirement before completion.

A schema, focused passing tests, successful editor popout, or opened PR does not
complete the goal. All required behavior must be enabled, verified, documented,
and merged.
