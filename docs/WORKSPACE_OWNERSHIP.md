# Workspace ownership implementation record

Status: **active and incomplete**. Integrated work includes the Code file-opening
cutover in [#2243](https://github.com/ArcaneArts/Cantrip/pull/2243). See
[the current tab contract](TABS.md) for ownership and return semantics. Entries
below are chronological evidence, not a claim that earlier limitations remain
current or that all surfaces and recovery paths satisfy the target contract.

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

### Local-window refresh cycle (in progress)

The first-class file-document cycle merged as PR #2219, squash commit
`71afc1aa54dddfff37514526dd1f13d715efa9c0`. Subsequent CI is not fully green:
the Windows worker commands job failed the existing-file assertion for a dangling
symlink in `test/explorer.test.ts`; the Ubuntu server contracts job failed
`worker-command-timeout-policy.test.ts` (ten expected streaming call sites,
six found). These are
unresolved validation failures, not evidence of full-goal completion.

The next isolated lane adds revision-only BroadcastChannel notifications scoped
to server, account, project, and device workspace. Receiving windows request an
authorized server refresh; no layout, document content, or ownership authority
is accepted from a broadcast. Existing polling remains the fallback. Bursts
coalesce, failed reads do not spin, and disposal cancels queued refresh work.
Account changes dispose the channel with the workspace connection.

Validation: all 50 focused refresh-channel, workspace API, and command-client
tests passed; the app and dependency production build passed; diff whitespace
checks passed. The unit-test additions cover in-flight disposal and late events
after controller disposal. Native two-window timing remains unverified for this
change. This notification mechanism is not a substitute for the required
destination-restored acknowledgment before native window destruction.

The API regression test now uses actual BroadcastChannel delivery between two
connections, with mocked authorized HTTP responses: a committed revision reaches
the second controller through a server read without a polling tick. It passed;
this is not native WebView validation. The isolated native fixture is still live,
but the computer-use tool reported that the Mac is locked and could not unlock
it. Native interaction must resume after manual unlock; no native timing result
is claimed and production app data has not been touched.

Refresh cycle merged as PR #2220 (`bcc2a6175115f79a73923400a569c58aaa45aae1`);
Primary was fast-forwarded and the refresh worktree archived. All three domain
CI jobs (macOS, Linux, Windows) subsequently passed.

### Chat view lifecycle cycle (in progress)

Source inspection confirms the transfer path already waits for ready and
restored-state acknowledgments before committing. However, its surface adapter
rejects chats, remote desktop, and several tool surfaces. Project chats still
render directly from `selectedChat`, keyed by resource identity, unlike retained
browser/file views. Their composer has protected draft persistence, but that
does not by itself preserve all local view state or flush in-flight edits on a
window transfer.

The isolated chat-view lane introduces a tab-keyed retained renderer and two
passing regression tests for draft retention across selection, query-gap metadata,
resource replacement, and independent closure. This component is not wired into
the shell at that checkpoint. Remaining work in this cycle includes shell integration, hidden
view focus behavior, encrypted transfer capture/restoration (including draft and
scroll state), and integration/native verification. No chat-transfer behavior is
claimed from these component tests alone.

Shell integration checkpoint: project chat rendering now goes through the
tab-keyed persistent surface layer, with the old selected-resource renderer
removed from GlobalContentHost. Existing chat actions are retained in
WorkspaceChatPanel; only the selected visible tab subscribes to native
window-activation focus. Nine focused owner/layer/linked-console tests and the
app/dependency production build pass. The full app suite passed: 526 files,
3,638 tests passed and three skipped. Encrypted
chat transfer capture/restoration, inactive view side-effect review, and native
interaction verification remain unfinished; this cycle is not ready to merge.

Transfer-contract checkpoint: the common encrypted batch now validates reserved
chat/project identities and private composer/transcript state. The chat lifecycle
registry fences replaced renderers and account generations. Eleven focused tests
pass, including stale cancellation, pending capture during account rotation,
unauthenticated registration, and batch capture/staging. App TypeScript build
checking and diff whitespace checks pass. The app now directly declares the
existing locked Zod version; lockfile changes are limited to that dependency.
These contracts are not yet connected to live chat capture/restore or destination
staging, so chat window transfer remains unfinished and this is not native QA.

The source transfer adapter now includes registered chat views in mixed-pane
batches, using the reserved tab/chat/project identity. Its six tests pass.
The scroll hook has explicit capture/restoration methods and prevents its queued
mount-time jump from overwriting a restored reading position. Eighteen focused
scroll, registry, state, and batch tests pass. Destination callers must load the
required transcript rows before restoring; live chat registration, historical-row
restoration and destination staging are still required before the cycle can merge.

Destination staging now loads the authorized project chat catalog, matches each
reserved tab to its chat, validates the private snapshot, and waits for the chat
renderer acknowledgment. Cancellation drops staged state; committed views retain
it until that tab closes. The retained chat component accepts staged incoming
views, keeps them inert before commit, and preserves component identity on
activation. Twenty-one destination/retained-view/surface-layer tests and app
TypeScript checking pass. Live transcript capture/restore and shell propagation
of the incoming state are not connected yet; no end-to-end transfer is claimed.

The chat-view lifecycle hook now coordinates source suspension, draft flush before
capture/retirement, cancellation release, and abortable destination restoration.
Three hook tests pass for ordering, release idempotency, and suppression of late
acknowledgments after disposal. This hook does not stop server execution. It still
needs the transcript controller's concrete capture/restore callbacks; inspection
confirmed paginated history must be restored before applying scroll coordinates,
and pending attachment uploads must not be silently filtered out of capture.

Live integration checkpoint: shell incoming-chat propagation and transcript
lifecycle registration are connected. Capture includes draft, attachments,
selection, editing state, inspector state, GitHub references and loaded-history
boundary. Destination restoration reads authoritative history pages, trims extra
prefix rows, restores local state, and acknowledges completion. Pending attachment
operations report an explicit transfer failure. Staged views suppress draft writes,
console synchronization and incidental older-history prefetch; source suspension
makes the transcript inert without stopping agent execution. Hidden viewport scroll
restoration is retained until the viewport becomes measurable. The full app suite
passed (530 files; 3,656 tests and three skips) before the final prefetch guard and
hidden-viewport regression additions. Native two-window validation, live integration
race review, and PR delivery remain outstanding; this is not completion of the goal.

Review checkpoint: the app/dependency production build passes with the existing
crypto externalization, chunk-size and ineffective dynamic-import warnings.
Native QA was attempted again; the computer-use tool reports the Mac is locked
and automatic unlock failed. Manual unlock is needed for native interaction.
Source suspension now disables background draft scheduling, console synchronization
and native focus handling, and capture rejects an actual in-flight message update.
A regression covers cancelling a transfer while its draft flush is pending; late
flush completion cannot capture the cancelled source. Native results remain
unverified and the implementation remains in its isolated unmerged cycle.

PR packaging checkpoint: final automated validation passes on the integrated
chat-view implementation (530 app test files; 3,657 tests passed, three skipped;
app/dependency production build and whitespace checks). The cycle is ready for
automated PR review with native QA explicitly outstanding, not represented as
passed. The broader goal still requires native/mobile verification, remaining
surface adapters, migration/legacy-path retirement and final TABS documentation.

### Remote desktop lifecycle cycle (in progress)

The preceding chat-view cycle merged as PR #2221, squash
`905ac2e37f3902bd84bf7e4670802dc6eed3888b`. Its source and merged trees match;
Primary is clean and synchronized. App-domain CI passed on Linux, macOS and
Windows. The Windows command lane failed the existing dangling-symlink creation
case in `test/explorer.test.ts:136`. Linux and macOS server-contract lanes failed
`test/worker-command-timeout-policy.test.ts:65` (six streaming contexts versus ten
expected). Neither the worker/server source nor those tests changed in #2221.
Windows server contracts subsequently finished with the same timeout-policy
assertion. All CI is now terminal. These failures remain unresolved; this is not
a claim that all CI passed. Recoverable archival of the clean chat-view worktree
was requested after verifying that its tree matches the merged result.

Remote desktop inspection found its renderer still mounted through selected
global content, and its worker link enabled by encryption readiness without a
workspace transfer suspension boundary. The next cycle must retain tab-keyed
views, stage incoming state, and coordinate source input cancellation and renderer
retirement with the existing ownership handshake. Worker session/target identity
must remain intact; attachment input epochs must not be copied to a new renderer.

The isolated remote-desktop cycle now has a strict private view-state parser
covering desktop/project/worker reservation identity, viewport and local fleet
search state. Ten focused tests pass after building the protocol package. They
cover successful capture data, empty search, mismatched ownership, invalid fields
and rejection of attachment input epochs. Live capture/restore, retained views,
source/destination integration and native validation remain to be implemented;
the parser alone does not establish remote-desktop transfer support.

The remote-desktop registry now fences callbacks by tab/desktop/project/worker
identity and the authenticated client generation. Stale renderer cleanup cannot
remove a replacement, and a capture finishing after account rotation is rejected.
Unregistering does not retire the worker session. The mixed-pane private envelope
now captures, validates, stages and retires registered remote-desktop entries,
rejecting missing reservations and duplicate tab identities. Twenty-two focused
parser, registry and mixed-batch tests pass, as does app TypeScript checking.
These adapters still require live source registration and destination mounting;
the UI continues to reject remote-desktop transfers until those are connected.

Renderer integration checkpoint: `ManagedRemoteDesktopView` accepts transfer
identity, private state and staging callbacks. Its lifecycle hook cancels input
before suspension, drains accepted transport work before capture and retirement,
and detaches only the renderer attachment. Cancellation during drain prevents
capture; rollback after retirement permits a new attachment. Staged destinations
restore local state but do not connect or accept input before ownership commits.
Capture rejects an actual pending target mutation instead of guessing readiness.
Four hook tests and nine existing desktop/clipboard tests pass after building
workspace dependencies; app TypeScript and whitespace checks pass. The source
adapter, retained tab-keyed mounting and destination shell integration are still
pending, so native remote-desktop transfer is not yet enabled or verified.

Shell integration checkpoint: source preparation resolves the authorized desktop
and its registered renderer; destination preparation loads the project desktop
catalog, validates the reserved identities, and waits for renderer restoration.
Incoming desktop state now reaches the shell's retained, tab-keyed desktop owner.
The selected-content renderer was removed, avoiding a second interactive desktop
view. Hidden retained views preserve their last usable viewport rather than
sending a one-pixel resize. Destination regression coverage now includes both
successful acknowledgment/commit/close and reservation cancellation, plus a
mismatched-worker rejection (14 destination tests pass). The existing source and
surface-layer suites also passed before the new destination cases. App TypeScript
and whitespace checks pass. Dedicated retained-view and live source regressions,
review of pending asynchronous desktop actions, full app checks, native QA and
PR delivery remain outstanding; shell wiring is not end-to-end verification.

Regression/review checkpoint: retained-desktop tests verify inactive state,
close-only disposal, staging-to-commit identity and stale incoming-resource
rejection. A mixed editor/desktop source test covers authorized capture and
rejects a desktop from another project. Review found an in-flight clipboard read
could otherwise finish after suspension and lose its paste; transfer preparation
now rejects while an actual clipboard or target-update operation is pending,
before cancelling input. The clipboard regression confirms the accepted paste
still dispatches. The full app suite passed (534 files, 3,682 tests, three skips),
and the final retained-view/source run passed all ten tests. App TypeScript,
app/dependency production build and whitespace checks pass. Build warnings remain
for crypto externalization, chunk sizes and ineffective dynamic imports. Native
two-window desktop validation and final review/PR delivery are still outstanding.

Final integration review checkpoint: remote desktop inline visibility now follows
the same project-screen conditions as retained chat/browser views, keeping the
renderer mounted but hidden while Settings, overview, or another non-project
screen is displayed. Removed unused imports/bindings from its former global
content host and grouped transfer imports. Re-ran app TypeScript and the
surface-layer, retained-desktop, and transfer-hook suites (13 tests passed);
whitespace checks passed. These checks do not substitute for native multi-window
validation; PR delivery and the wider goal remain unfinished.

Remote-desktop delivery: #2222 merged as `307c174b0`; the merged tree matched
source commit `1f9dfef28`, and clean Primary fast-forwarded to that result.
GitHub reported no checks/runs for this PR or merge, so this is not a CI-pass
claim. The cycle worktree was recoverably archived. Native interaction was
attempted again, but the Mac lock screen prevented access; no new native pass
is claimed.

Next cycle: dedicated file-window routing. Current-source inspection confirms
`useExplorerLifecycleRegistration.openExplorerFileWindow` still calls
`openDesktopExplorerFile`, and `PersistentSurfaceLayer` passes that callback to
the retained Explorer on desktop. That route creates the independent
`DesktopExplorerFileWindow` document store and discard-on-close guard rather
than a workspace-owned file tab and return-to-main handoff. Existing
`openOwnedFile` already resolves the protected document and opens/focuses its
workspace tab, but does not return the resulting resource/placement to a caller
that needs to detach it. This cycle must bridge that actual open result to the
ordinary transfer lifecycle, wait for renderer registration rather than assume
query arrival means readiness, preserve existing-window focus/deduplication,
and retain safe handling for legacy links. No routing replacement is implemented
at this checkpoint.

File-window routing implementation checkpoint: `openOwnedFile` now returns its
resolved protected document and authoritative open receipt, allowing the next
step to identify the exact opened/focused view rather than use Explorer
selection as a proxy. It revalidates context after asynchronous native focus
before exposing that result. Existing coalesced-open coverage now asserts both
callers receive the same tab identity, and a focused regression rejects a result
when the controller is disposed during focus. All 12 file-opening tests and
dependency builds pass. The UI routing and actual renderer-ready handoff remain
to implement; this result contract alone does not change native file opening.

Routing checkpoint: the shell now supplies a workspace-owned file-window action
instead of the standalone launcher. It opens/pins the ordinary file tab, focuses
an existing owner in another window, and otherwise waits for the source surface
and its lifecycle registration before invoking the same detach handshake as tab
popouts. Repeated clicks share the pending action; context changes, closed tabs,
and failed destinations do not silently create a second document/window. The
registration wait is bounded and leaves the ordinary tab intact on failure.
Focused coverage passes (27 tests across routing, Explorer lifecycle, and file
opening). Native QA, additional cancellation review, legacy-link handling, full
app verification, and PR delivery remain outstanding.

Cancellation review found that rejecting the UI promise on workspace change did
not cancel an already-started handoff. Requests now carry an abort signal through
the source adapter into the existing coordinator, preserving its rollback and
uncertain-outcome handling. Removed the unused standalone launcher callback from
Explorer lifecycle registration. The old project-file compatibility fallback
and native legacy-link receiver remain to retire or translate. The full app run
passed 535 files / 3,689 tests (three skipped); subsequent focused runs cover the
new unmount and adapter cancellation cases. App TypeScript and production build
passed after routing/registration cleanup, with existing bundle/crypto warnings.
Native testing and PR delivery are not yet complete.

Legacy opening cleanup: the project/chat-file helper now requires the owned-file
opener. Removed its fallback that chose an arbitrary Explorer, created a legacy
Explorer resource, changed its selected path, or launched a standalone native
file window. Production calls to `openDesktopExplorerFile` are now absent outside
that legacy launcher's own implementation. Checkout-resolution tests retain their
original meaning but assert the owned opener, with explicit failure propagation
coverage and no alternative mutation path. App TypeScript and 28 focused tests
pass after this removal. Existing legacy URL receivers/launch support are still
present for compatibility and need a separate safe migration/retirement review;
their removal is not claimed here.

File-window routing final local verification: all 535 app test files passed
(3,691 tests, three skipped), followed by a successful app/dependency production
build and whitespace check. The build retains known crypto externalization,
large-chunk and ineffective-dynamic-import warnings. This cycle is ready for PR
delivery; actual native interaction remains blocked by the host lock screen.

File-window routing delivery: #2223 merged as `a7c0e9d3e`; its merged tree
matched the source commit, clean Primary fast-forwarded, and the worktree was
confirmed recoverably archived. GitHub reported no checks for that PR; this
does not establish a CI pass.

Committed-window restart recovery cycle: bootstrap previously reconnected to
persisted ownership without reopening its missing native hosts. Main now performs
an authoritative refresh on connection and focus, then reopens committed,
nonempty detached owners under their original window identities. The native
lookup leaves surviving windows untouched; creation does not focus each restored
window or replay an old transfer payload. Ownership and protected document
storage are not rewritten. Context is checked again immediately before native
creation, and errors preserve the owner while other independent windows continue.

Windows involved in pending transfers are deliberately not reopened as committed
views. Reconciliation of interrupted reservations, startup-ready acknowledgement,
full session restoration across projects, legacy standalone-file receiver
migration, and genuine native restart/dirty-buffer QA remain outstanding. This
cycle does not claim those requirements are complete. Initial focused validation
passed 51 tests, and app/dependency build plus TypeScript checks passed; final
full-suite results and delivery are recorded below when available.

Final local validation: 537 app test files passed (3,701 tests, three skipped),
including native-launch mocks, context cancellation, focused-host behavior,
empty/transferring-owner exclusion, and per-window failure isolation. Production
app/dependency build, TypeScript, and whitespace checks passed. Existing bundle
size, crypto externalization and dynamic-import warnings remain. These automated
results do not establish native restart or protected-draft recovery correctness.

Committed-window recovery delivery: #2224 merged as `f1d7156be`; the merged tree
matched source `44a80ac2a`, Primary synchronized cleanly, and recoverable archival
was confirmed. No GitHub checks/runs were reported for the PR or merge.

Interrupted-transfer investigation (next cycle): the native editor's
`EditorSessionStore` is an in-memory Map owned by `ExplorerView`'s React ref.
`EditorDocumentSession.captureTransfer` captures inactive drafts after actual
writes settle, but neither that store nor the transfer channel durably journals
them. The channel encrypts the snapshot for BroadcastChannel transport and
clears its retained envelope on disposal. The protected file-document catalog
is a resource locator, not a durable draft store. Consequently, reopening a
committed native window is not evidence that unsaved text survives a process
crash, and automatic cancellation of stranded reservations alone would be an
incomplete recovery implementation.

The next implementation must establish encrypted endpoint recovery before
reconciling interrupted transfers: durable snapshots bound to account/server,
device workspace, resource/view and generation; actual write completion before
source retirement; validated restoration without overwriting a newer dirty
document; and explicit save/discard/retirement cleanup. It must cover ordinary
document edits as well as the handoff checkpoint, since transfer-only persistence
does not protect edits made after commit. Plaintext document bytes and paths
must not enter layout metadata or a plaintext local-storage fallback. Failed
storage or decryption must retain a visible recoverable error, not be interpreted
as an empty draft. Native restart fault tests remain necessary.

Open PR #2140 touches embedded Code authority recovery and documents a failed
dirty-buffer acceptance test. Its changes are not adopted by this lane; the
native editor's in-memory store is a distinct path. Coordinate before changing
that PR's embedded-editor lifecycle files. No recovery implementation or passing
crash test is claimed by this investigation checkpoint.

Protected-recovery implementation checkpoint: added a versioned IndexedDB
ciphertext-record store with opaque digest keys, strict transaction completion,
atomic compare-and-swap revisions, and revision-bearing discard tombstones.
Corrupt/unsupported data and unavailable storage reject instead of returning an
empty draft. Delayed writers cannot overwrite a newer revision or resurrect a
discarded record. Four focused validation/conflict tests and the app/dependency
production build passed (existing bundle warnings remain). This store is not
yet connected to editor sessions: scope-bound encryption, live edit persistence,
validated restore/cleanup, actual IndexedDB concurrency tests and native fault
validation remain required before this cycle can be delivered. No production
draft-recovery behavior is claimed at this checkpoint.

Encryption checkpoint: recovery envelopes now have a dedicated field-key domain
and authenticate account/server, device workspace, project, worker, checkout,
opaque document/view identity and record revision. The storage identifier is a
digest of those opaque identities (never a path); moving a view between windows
does not change it. Plaintext is copied before asynchronous encryption and
temporary key/plaintext buffers are cleared. Account changes during crypto and
stale key revisions reject explicitly. Seventeen focused crypto/storage tests
pass, covering each binding field, revision substitution, mutable input, locked
encryption, account changes and stale revisions. App TypeScript and whitespace
checks passed. Live session integration and real storage/crash tests remain;
this is still an unfinished cycle, not a delivered draft-recovery feature.

Session integration foundation: `DocumentRecoverySession` now combines encrypted
records with serialized checkpoint/clear operations. Loading must decrypt and
validate successfully before the session accepts the storage revision; invalid
content remains retained. Cross-renderer conflicts are not automatically rebased.
Disposal/account changes fence queued work, and `flush` propagates prior write
failures until a later checkpoint actually succeeds. Review caught and fixed an
initial queue implementation that would have swallowed that failure at flush.
The 22 focused crypto/storage/session tests and app TypeScript pass. Editor
callbacks, restore/error UI, save/discard handling, transfer flush integration,
actual IndexedDB transaction testing and native crash QA are still unwired or
unverified. No production behavior change or PR readiness is claimed yet.

Storage adapter checkpoint: the existing IndexedDB emulator now exercises the
production adapter across reopened instances, retained corrupt records, and four
writers attempting the same revision. Exactly one writer commits; rejected
writers leave the winning record intact. All 25 focused recovery tests pass.
These are emulator checks, not proof of native crash durability. Close-path
inspection also confirmed that `beforeClose` runs before the authoritative
close command, while `onSuccess` currently has no editor cleanup callback.
Recovery deletion must be attached to confirmed close completion and retain the
prepared editor handle across unmount; it must not run in `prepareClose`.
Editor integration and native fault validation remain unfinished in this lane.

Confirmed-close integration: the surface-close mutation now retains the prepared
renderer finalizer across authoritative removal/unmount and invokes it only after
the close succeeds. A cleanup rejection is reported separately and cannot call
the close rollback or cancellation hooks after ownership already committed.
The shell captures the exact editor lifecycle object rather than looking it up
again after its registry entry may have disappeared. Three regression cases
cover successful close, rejected close, and failed post-commit cleanup; the
16-test surface-close suite passes. The optional editor finalizer is the hook
for durable recovery deletion; it is not yet connected to the recovery session.

File-view wiring checkpoint (unmerged): first-class file views now load and
validate their encrypted recovery snapshot before ordinary editor initialization.
Load/write errors are visible and retryable, rather than treated as empty drafts.
Staged destinations do not acquire a recovery writer revision until staging ends;
source transfer capture awaits the real encrypted checkpoint before retirement.
Ordinary edit/save-state changes checkpoint without waiting for an in-flight file
save, retaining newer text with its last acknowledged version. Confirmed close
writes a tombstone through the retained editor callback and rejects later stale
checkpoint calls. Unmount itself never clears recovery. The account wrapper does
not remount merely because connection generation changes.

Hook regressions cover StrictMode, staged-to-owned transition, restore failure
and retry, and confirmed cleanup after unmount; document-session coverage checks
recovery capture during a pending save. This integration still requires broader
review and native validation, including save/discard cleanup, scroll/selection
checkpointing, encryption unlock transitions, and interrupted-transfer recovery.
It is not yet a completed or PR-ready recovery cycle.

Viewport/clean-file review: native selection and scroll events now notify the
recovery owner even when document text is unchanged, suppressing duplicate
unchanged events. After an actual post-mount file fetch, clean recovered sessions
can reconcile a changed disk version; dirty or saving sessions remain protected.
Reconciliation clamps a restored selection when the fresh file is shorter.
Integration coverage verifies edit/viewport checkpoints and that a failed
recovery write rejects transfer capture while retaining the source draft.
The full app suite passed: 541 files, 3,735 tests passed and 3 skipped; app
TypeScript also passed. Native fault validation, encryption-transition handling,
and the remaining recovery lifecycle review are still outstanding.

Encryption retry review: a changed encryption snapshot previously left an already
loaded recovery session permanently fenced, even after unlocking the same key.
Explicit retry now authenticates the retained record with the current account
key while requiring the exact previously accepted storage revision. It does not
replay saved contents over the live editor or adopt another writer's revision.
Regression tests cover same-key renewal, stale writers, wrong accounts/keys,
and retry ordering. Native UI inspection on this continuation reported the Mac
locked with automatic unlock unsuccessful; manual unlock was requested. A QA
session was initialized at `.qa/20261024-071030-validate-encrypted-file-tab-reco`.
No native acceptance pass is claimed; source-level work remains available.

Write-queue review: ordinary not-yet-started recovery checkpoints now coalesce
to the latest captured bytes, clearing the superseded buffer. In-flight writes
still settle normally, and explicit clears and encryption renewal remain ordering
barriers. Callers of a coalesced checkpoint wait for the actual replacement write;
they are not acknowledged early. Tests hold an actual mocked storage operation
pending, verify that the latest edit wins with two writes rather than three,
and verify that an intervening clear is not skipped. Confirmed-close cleanup also
renews the authenticated encryption context before its tombstone, without
adopting a newer writer's revision. Explicit reload/discard ordering remains to
be reviewed before delivery.

Reload review: the editor previously discarded/reset its session before the
replacement read succeeded. It now retains the live session until that read
completes and rejects discard approval if the document revision changed while
reading. Two regressions cover a failed worker read and edits made during the
read; the 35-test native-session suite and app TypeScript pass. A disposable
Chromium acceptance run was attempted; its worker exited because this worktree's
Cantrip CLI binary had not been built. The CLI build was started to resolve that
actual startup failure. This attempt is not an editor acceptance pass.

The CLI build completed, the failed fixture reached a terminal result and closed
its processes, and a fresh desktop Chromium acceptance run passed. Evidence is
`.qa/editor-c529707d-efa1-4291-977f-990b9832276d/native-editor-results.json`.
It covers ordinary open/save, BOM/CRLF, legacy file-window routes, tab continuity,
server/worker restarts, alternate-worktree and chat files, conflicts, Code tabs,
and account revocation. These existing scenarios do not prove browser-reload
draft recovery or native two-window ownership; those remain required.

Close review additionally found that approved input remained editable during the
authoritative close request. Close preparation now holds input inert, retaining
all buffers; cancellation releases only that close reservation, not an unrelated
transfer. A regression exercises attempted late input and resumed editing after
cancellation. This final close change postdates the Chromium run above and is
covered by the focused native-session regression, not that browser run.

Renderer-reload acceptance now waits for the actual recovery checkpoint to
settle before reloading the browser, then verifies the unsaved text returns
without appearing on disk. The expanded desktop Chromium run passed with no
page errors (`.qa/editor-5f0790e6-ca9f-4c9a-ac2d-582817137602`). The phone-sized
WebKit run also passed this draft-reload assertion and each functional scenario,
but its overall result failed the page-error assertion with two worker-link peer
network access-control errors
(`.qa/editor-6b442ee0-0a42-4ba3-8a48-6292e96ebdc7`). This is not a mobile suite
pass; the error assertion remains intact. Selection and undo-history reload
assertions were subsequently added and require their own run evidence. Neither
headless run establishes native two-window transfer acceptance.

The stronger phone WebKit reload case exposed a real selection-checkpoint bug:
the native `select` listener updated the session before React's callback compared
the selection, suppressing the recovery notification. Both paths now share a
change-detecting notifier, with a current callback reference for the persistent
DOM listener. The focused editor regression verifies a changed native selection
notifies exactly once and repeated unchanged events do not notify. The complete
app suite before this final selection fix passed 541 files / 3,746 tests with
3 skipped; that full-suite result is not coverage of the subsequent fix.

After the selection fix, phone WebKit fixture
`.qa/editor-23ee5aa1-98af-4fdd-a811-2c992a514e28` passed reload restoration of
text, backward selection, and undo/redo history, plus all subsequent functional
scenarios. Its final page-error assertion still failed on the same two peer
network access-control errors; no error filtering was added. Focused editor
regression, TypeScript, and diff whitespace checks pass. The recovery cycle
remains unmerged pending the remaining review and acceptance work.

WebKit error investigation: fixture
`.qa/editor-2db8d273-c8de-4e2b-8b7f-33b5816a4c5d` captured no window `error` or
`unhandledrejection` events while Playwright reported peer access-control page
errors. A standalone HTTP page reproduced the same Playwright error with a
caught DELETE fetch started in `pagehide`; no Cantrip code was involved. The
reproducer is retained in the recovery QA session as
`harness_app/webkit-pagehide.cjs`. The integration harness now records these
separately only during its deliberate renderer reload, only on WebKit, and only
for exact same-origin peer endpoint access-control errors. Runtime errors and
all other page errors remain fatal; classified messages remain in the results
artifact. This addresses teardown diagnostic classification, not a claim that
arbitrary WorkerLink failures are harmless. Native UI availability was checked
again and the Mac remains locked.

With that evidenced classification, phone-sized WebKit fixture
`.qa/editor-9e49bcb5-78b9-4246-9243-69186c461a14` completed with exit zero:
all functional assertions passed, runtime and unexpected page errors were empty,
and teardown messages were retained separately. The post-selection-fix full app
suite also passed 541 files / 3,746 tests with 3 skipped. Native multi-window
acceptance remains outstanding and is not implied by this representative mobile
pass.

Duplicate-close review found a reservation ownership hazard: a second close
could reject preparation and invoke cancellation while the first close still
awaited its authoritative mutation. The close hook now tracks in-flight tab
identities, rejects duplicates without preparation/cancellation/rollback, and
releases only the original operation's entry on settlement. Deterministic tests
hold the mutation pending and cover both success and failure followed by retry;
the focused close suite passes 18 tests. Actual app type checking was rerun with
`pnpm --filter @cantrip/app typecheck` (`tsc -b --pretty false`) and passed.
The earlier standalone `tsc --noEmit` invocation only checked the empty root
project configuration and must not be treated as referenced-project coverage.

Delivery checkpoint: the encrypted file-view reload/confirmed-close increment is
ready for its own PR. Final full app verification passed 541 test files with
3,748 tests passed and 3 skipped; referenced-project typecheck, production build,
changed-file formatting, large-file safety, app decomposition, and diff whitespace
checks passed. Desktop Chromium and representative phone WebKit evidence is
recorded above. This increment enables durable recovery for first-class file
views; it does not complete interrupted ownership-transfer reconciliation or
native crash/two-window acceptance. Those remain required follow-up work for the
unbounded workspace goal. The local QA fixture artifacts remain intentionally
untracked and must be preserved until native acceptance is finished.

### Attachment recovery follow-up (in progress)

Previous cycle: PR #2225 merged as `a5b7fb5c3`. Integrated focused tests
passed (54), editor lifecycle run `40094568230` passed, and native contracts
run `40094568225` passed Linux/macOS/Windows on attempt 2. The first Windows
attempt failed in unchanged process-guard fixture cleanup with EBUSY.

This cycle joins authoritative attachment generations to actual renderer
lifetimes and interrupted-transfer reconciliation:

- An origin-wide exclusive Web Lock remains held until JavaScript context
  destruction. Pagehide aborts consumers; BFCache restoration reloads rather
  than reusing disposed controllers. Neither timeout nor observer failure
  establishes replacement ownership.
- Overlapping connections share an attachment identity. Final disconnect
  retires that binding; same-page project return claims a fresh generation
  because the original in-memory transfer lease no longer exists.
- Atomic `replace-attachment` cancels affected uncommitted reservations while
  preserving source tabs, protected drafts, and unrelated transfers. First
  attachment of a staged destination preserves its handshake generation;
  replacing that staged renderer retires the reservation instead.
- Attachment claims rebase only after explicit revision rejection. Lost
  replies remain uncertain; authoritative matching renderer identity proves
  a prior claim without incrementing again.
- Transfer sources observe cancellation and resume only while their original
  generation still owns every transferred tab. Replaced sources cannot resume.
- Startup restores source windows of interrupted transfers but not staged
  destinations. Only an authoritative retired-window result closes the
  matching current native popout, never main or another window.
- Logout, renderer abort, and explicit disposal share idempotent cleanup of
  subscriptions, refresh channels, controllers, and connection references.

Automated evidence on this branch:

- Full app: 544 files, 3,770 passing tests, 3 skipped.
- Protocol: 917 passing tests, including 94 command tests.
- Server workspace: 15 passing tests.
- Focused API/bootstrap/lifetime/attachment/source tests: 49 passing.
- App typecheck, production build, large-file/decomposition checks, diff check.
- Real Chromium/WebKit lock harness: six acquisition/reload/close checkpoints.
- Desktop Chromium editor fixture `editor-fd79363d-3c5a-4d7e-8cac-edd191c5799a`
  passed before the final connection-cleanup fix.
- Post-cleanup phone WebKit fixture
  `editor-6ffad67f-fb6d-4d88-a934-f5e2902490b4` passed, including fixture
  shutdown with all owned processes and sockets closed.

The failed WebKit run `editor-92121c20-77fe-4636-be76-e0bbc36ba251` remains
preserved, not counted as a pass. A separate localhost page without Cantrip
code reproduced grant/telemetry/session cleanup access-control page errors
during all eight reloads despite handled fetch rejections and no runtime
errors. The harness classifies only these exact same-origin cleanup endpoints
during explicit WebKit reload. Two classifier tests retain failures for other
origins, ports, paths, messages, browsers, and times; runtime-error assertions
are unchanged. Evidence:
`.qa/20261024-081122-locate-webkit-worker-link-access`.

Native validation used the current branch's isolated QA app and fixture
`editor-f346d348-bd87-41b9-9b9e-7e7d997f1e6c`:

- Dirty single-tab detach and native-close return preserved the draft.
- Whole-pane transfer preserved two dirty files, including the inactive tab.
- Main showed no duplicate tab, disabled placeholder, or occupied pane slot.
- Explorer focused the already-open detached resource.
- Detached WebView reload restored both unsaved drafts.
- Closing one dirty tab with explicit confirmation and then its window
  returned only the surviving tab; the closed tab did not resurrect.
- Actual graceful application exit through the registered SIGINT handler,
  followed by restart using the same isolated data directories, restored the
  detached window and its unsaved draft; main remained empty. This checks
  process shutdown/restart, not the tray confirmation dialog.
- Both source files remained unchanged on disk. All owned native fixture
  processes were stopped after validation; no production app was stopped.

Detailed observations are retained in
`.qa/20261024-141112-validate-current-native-attachme/OBSERVATIONS.md`.
A transient “Add your first project” view during reload remains recorded for
the final loading-UI audit.

Interruption fixture `editor-0e17e5e6-4d53-4120-bf30-8601d1cfffec` passed
two further native scenarios. A fixture-only HTTP 503 prevented the destination
application from starting. Source WebView reload during pending transfer
recovered the same tab and unsaved draft; clearing the fault allowed a successful
detach. Abrupt SIGKILL of that isolated native app, followed by relaunch with
the same fixture data, restored the detached owner and exact draft while main
remained empty. The disk file remained the original baseline. Logs:
`native-interruption.log` and `native-crash-restart.log` in the native QA session.
These validate source reload during interrupted readiness and abrupt process
restart, not every possible timing permutation. Final cycle delivery remains
outstanding. The full workspace goal is incomplete.

### Legacy document migration follow-up (in progress)

Attachment recovery merged in PR #2226 as `ad7b48376`. Primary was synchronized;
57 integrated recovery tests passed after rebuilding its stale generated protocol
output. Native QA artifacts were preserved outside the archived cycle worktree at
`/Users/cyberpwn/.codex/qa-artifacts/workspace-attachment-recovery-pr2226`.
The full repository check stops at the unchanged server tab-layout line budget
(2,006 lines versus 2,000); this is also present in the baseline, not a passing
repository-wide check. Native-contract CI run `40125409972` passed on Linux,
macOS, and Windows.

Worker-command run `40125409927` failed its Windows lane at
`test/explorer.test.ts:136`: creating `broken.txt` over an existing broken symlink
resolved instead of rejecting. The lane passed 144 tests with nine skipped and
one failure. This matches the historical Windows symlink failure recorded above;
no worker source or test changed in #2226. It remains an unresolved failure, not
a green run or an assertion to weaken. Server-contract/CUA jobs were still live
at this checkpoint.

Current-source audit confirms a migration gap: `seedWorkspaceOwnership` maps
legacy Explorer members to `project.explorer`, while `openOwnedFile` creates
immutable `project.file` documents. Bootstrap performs no document conversion.
Thus legacy file tabs retain mutable Explorer location authority even though
new file tabs use independent document/view identities. Server seed cannot
derive a document path from the encrypted Explorer state.

The next increment must convert only actual file-bound legacy views, preserving
their tab IDs, pane order, selection, mode, protected metadata, and drafts:

1. Resolve and validate the decrypted Explorer location in the authenticated
   client, then idempotently create the existing immutable document identity.
2. Add a revision/generation-checked conversion operation for the current
   owning window. Validate both source Explorer and target document project,
   worker, and worktree authority on the server. Reject stale source bindings
   rather than relocating a tab to an outdated path.
3. Prepare/capture any mounted legacy editor before changing its backing, and
   restore/checkpoint its state into the document view. Never discard dirty
   state or force a save merely for migration; failed migration retains the
   legacy view for recovery.
4. Exclude active transfer reservations and other-window owners. Conversion
   must be idempotent across reconnect/restart and coexist with old-client
   resource writes without restoring project-global placement authority.
5. Retain genuine Explorer tree resources (no selected file) and compatibility
   readers until their last consumers are verified. Audit legacy native links
   separately from ordinary document opening.

This is an implementation plan grounded in current source, not completed
migration. Protocol, server authority, client lifecycle, and native validation
must land together before this cycle is delivered. `docs/TABS.md` still contains
superseded placeholders and rollback descriptions and needs final reconciliation.

Resumed implementation: `legacy-document-migration.ts` now partitions a validated
Explorer capture into independently scoped document candidates, keeping the
selected file first and preserving its mode. Source inspection found that the
legacy session store also retains buffers from earlier paths/worktrees. Those
buffers must receive separate document views in the same atomic migration;
converting only `selectedPath` would discard inactive drafts. Tree-only Explorers
remain tree views, including when retained buffers need separate recovery views.
The helper preserves all captured document data and rejects foreign scope or
incorrect target bindings. It does not yet mutate ownership or run at startup.

Verification at this checkpoint: eight new migration unit tests and fifteen
existing transfer-state tests passed (23 total), app typecheck passed, and
`git diff --check` passed. Dependency packages were built in this worktree.
Server authorization, atomic multi-document placement, protected checkpoints,
runtime wiring, and native validation remain required before opening this PR.

Final #2226 CI observations: CUA run `40125409966` passed. Server contract run
`40125409895` failed on all three platforms with the same unchanged timeout-policy
test: `worker-command-timeout-policy.test.ts:65` expects ten streaming-command
contexts but finds six (147 passing tests, one failure per platform). #2226
changed no server source/tests. This failure is recorded without weakening its
assertion or claiming the server suite passed; the Windows worker broken-symlink
failure above also remains unresolved.

Atomic migration implementation checkpoint: `migrate-explorer-file` replaces
the original tab's resource without changing its identity, selected position,
preview flag, protected label, or pane split. It inserts retained document views
adjacent to that tab without stealing focus. It rejects colliding view/document
IDs, stale source resources, foreign-window tabs, and pending transfers. The
server holds source/target authority rows through commit, compares the exact
encrypted source binding, checks every target document's live project/source,
worker, and worktree authority, and records the normal idempotent receipt. The
client deliberately does not project this replacement optimistically: a rejected
operation must leave the suspended legacy editor mounted with its draft store.

Verification: all 925 protocol tests passed; 29 existing/focused file-document
and workspace database tests passed, including six new migration cases; 39
client queue/migration tests passed. Server and app typechecks and diff checks
passed. The first protocol test attempt rejected a noncanonical base64url test
fixture; the fixture was corrected, with validation unchanged. Runtime
checkpoint orchestration, automatic invocation, and native migration checks are
not implemented yet. No PR has been opened for this unfinished cycle.

Runtime migration is now wired into the owning window's shell. Mounted
file-bound legacy views are suspended, captured, and checkpointed through the
existing encrypted document-recovery store before the atomic conversion runs.
A separate encrypted legacy journal bridges process exit before layout commit.
On retry/restart, recovered dirty buffers replace clean disk-loaded buffers;
conflicting dirty versions are retained and reported rather than overwritten.
Actual failure retains the journal and legacy view. Migration does not run in
another window, during a transfer, or for a tree-only Explorer. It exposes a
dedicated retry action without reconnecting or replaying unrelated commands.

Runtime verification checkpoint: production app build and app typecheck passed;
the full app run passed 3,787 tests with three skipped across 546 files. A further
four owner-window/retry hook tests, added after that full run started, passed
separately. Six coordinator tests cover checkpoint ordering, rejected commands,
restart recovery, checkpoint failure, conflicting live/recovered drafts, and
attachment retirement. The recovery-banner test confirms explicit migration
retry routing. These use isolated mocked recovery I/O for orchestration; they
do not establish native/IndexedDB behavior. Native migration QA has been
initialized at `.qa/20261024-144650-validate-automatic-legacy-explor` but has not
run yet. `pnpm check` still fails at the unchanged 2,006-line server tab-layout
budget. The cycle remains uncommitted and no PR has been opened.

Resumed QA checkpoint: the full app suite now passes 3,791 tests with three
skipped across 547 files. A compiled production-app Chromium run seeded a legacy
Explorer file via the authenticated APIs, reloaded, and observed automatic
conversion to `project.file` with the original tab identity. An unsaved edit in
the migrated view survived another reload, while the repository file remained
unchanged. Evidence is under `.qa/editor-8a1fd3fa-e7d0-485d-88f9-b2db245cd57a`
(including `migration.png`); the runnable harness is in the migration QA session
above. Both owned fixture processes exited normally with no surviving children.
The first run could not start its worker because the new worktree lacked the
Cantrip CLI; `pnpm cli:build` succeeded and resolved that setup failure. A second
run exposed a harness-only attempt to inspect workspace identity before session
rehydration; the fixture now returns no snapshot until identity exists. The
successful third run establishes browser migration and actual protected draft
reload, not inactive-draft migration or native two-window acceptance. Those
checks remain pending; no PR or merge is claimed for this cycle.

Inactive-draft browser QA also passed using real file reads, the production
editor-session store, and an encrypted pre-commit migration journal. Selected
and inactive drafts became adjacent distinct tabs, retained the source tab ID,
survived selection/reload, and left both disk files unchanged. Evidence:
`.qa/editor-2a9e26fa-d222-4409-90d8-4db51afd357d`.

The first actual native migration rendered both recovered tabs and the selected
draft, but exposed an authenticated-label mismatch: the migration retained the
old Explorer resource's encrypted title after changing the resource identity.
Migration now clears that obsolete resource label, matching ordinary file opens
whose displayed name derives from the encrypted document path; pane title and
view identity remain intact. The protocol fixture now includes a non-null old
Explorer label and asserts it is not carried into the document view. All 925
protocol tests passed after the correction. Native transfer acceptance and a
fresh browser label-error assertion are being rerun; this is not yet merged.

Corrected acceptance passed: a fresh compiled Chromium fixture passed the
label-error assertion, selected/inactive encrypted journal migration, and draft
reload checks. Actual macOS native fixture
`.qa/editor-a2b703a6-65e5-44e6-9301-235f8efe2bea` migrated both drafts without a
label error, moved their entire pane to a new native window, displayed each
draft there, and returned both tabs with their contents when the native window
closed. Selecting each returned tab confirmed both original drafts; repository
`git diff --exit-code -- qa.txt second.txt` confirmed no disk writes. Detailed
observations are in the migration QA session's `OBSERVATIONS.md`. App typecheck
and diff checks also passed. The cycle is ready for final source review and PR
packaging, not yet merged; the broader goal's remaining adapters, entrypoint
cleanup, simultaneous-device verification, and final documentation audit remain.

### Sidebar ownership cutover (in progress)

Legacy document migration merged in PR #2227 as `1535bdd62`. Primary was
fast-forwarded; 102 integrated workspace-command tests passed. Its clean worktree
was archived after preserving QA data at
`/Users/cyberpwn/.codex/qa-artifacts/workspace-legacy-document-migration-pr2227`.
The prior full server test process was discovered still running after worktree
cleanup and was stopped; that run is not counted as passing. The separately
completed focused server rerun passed all 29 tests.

Native-contract CI `40128254658` passed on all three platforms. Worker-command
CI `40128254703` passed on Linux/macOS but failed on Windows with two failures:
the existing broken-symlink assertion in `explorer.test.ts:136`, and a Git
`index.lock` collision in the filesystem-notification test in `worktrees.test.ts`.
Neither file changed in #2227. These remain unresolved, not waived or green.
Server-contract run `40128254649` also failed on all platforms at the unchanged
timeout-policy assertion (six streaming contexts found, ten expected). CUA,
App API domains, and Worker Codex runtime passed on all their platforms.

Current-source audit found that the shell always supplies `openOwnedFile`, but
sidebar commands still carried an optional fallback that repurposed Explorer
resources, waited for a warm successor, force-saved a dirty preview, and wrote
legacy placement. This cycle removes that fallback and makes owned opening
mandatory. It also removes the legacy pin mutation and its project-layout query
write; the shell's pin progress now tracks the actual document/workspace operation.
Compatibility readers and legacy preview teardown remain until their consumers
are removed; they are not a new-file placement authority. The broader goal still
requires the remaining compatibility cleanup, file mutation/entrypoint audit,
concurrent mobile/desktop acceptance, and final `TABS.md` reconciliation.

Verification for this cutover: all 547 app test files passed (3,792 tests,
three skipped), including owned preview/pin identity, errors without legacy
fallback, non-file boundaries, and center placement while a dock is focused.
The final direct command and owned-file reruns passed 12 and 13 tests respectively.
Production app build (including TypeScript) passed after fixing a missing type
import and removing a stale destructuring reference exposed by the first check.
Changed-file formatting and `git diff --check` passed. `pnpm check` again stopped
at the unchanged 2,006-line server tab-layout budget. No new native QA is claimed
for this removal of the unused fallback; the preceding migration cycle's actual
native two-window evidence is recorded above. PR delivery is the remaining step
for this cycle, not for the full goal.

### Simultaneous mobile/desktop acceptance

Sidebar ownership cutover merged as PR #2228 (`036b9724a`); Primary was
fast-forwarded and 40 integrated focused tests passed. This cycle adds the
repeatable `scripts/qa/workspace-mobile-desktop.mjs` acceptance harness and
[execution instructions](qa/WORKSPACE_MOBILE_DESKTOP.md). It changes no production
layout behavior. Two independent Chromium installations connect to the same
disposable account/project through the actual recovery-file import, app, server,
worker, and protected workspace transport.

The expanded run `.qa/editor-6c24fdb0-aff4-46db-996c-58ffeb548b7f` exited zero
with six passing checkpoints: different device workspace IDs, mobile file opens
without desktop placement changes, dirty buffer and tab identities surviving
viewport resize/reload, inactive close preserving selection, Rust default Edit
mode plus interaction-based recency and adjacent close selection, and desktop
opens/pins without mobile placement changes. Both owned fixture processes exited
cleanly with no surviving owned processes. The mobile screenshot shows the
unsaved draft and single remaining file tab. An initial exploratory run waited
for an obsolete Switch to IDE step even though recovered account preferences had
already restored IDE; the harness was corrected and fresh runs passed.

`pnpm check` still fails the unchanged server `tab-layouts.ts` line budget
(2,006 versus 2,000). This is not waived. The test uses representative mobile
Chromium, not physical iOS/Android, and does not establish large-tab overflow or
all native surface adapters. Those, the remaining compatibility cleanup, final
`TABS.md` rewrite, and goal-wide acceptance audit remain required. PR delivery
for this verification cycle is pending.

### Legacy surface policy decomposition

Concurrent mobile/desktop acceptance merged in #2229 (`8bb0b2304`). Its six
checkpoints passed again on integrated Primary after rebuilding the documented
dependencies. The first integrated attempt failed opening the initial desktop
file and logged a worker encryption-identity conflict while using older built
packages; it is not counted as passing. Native contract CI `40130094719` passed
on Linux, macOS, and Windows. QA artifacts were preserved outside the archived
worktree at `/Users/cyberpwn/.codex/qa-artifacts/workspace-mobile-acceptance-pr2229`.

This cycle extracts legacy surface kind/definition/region validation into
`tab-layout-surface-policy.ts`, retaining the old public export and behavior.
The repository drops from 2,006 to 1,949 lines without increasing its budget.
The generated security inventory changes only the corresponding source line
numbers; classifications and reviewed contract digests are unchanged. New
table-driven tests cover every legacy kind, explicit file-definition overrides,
built-in validation, unavailable definitions, and every registered surface's
allowed/rejected regions. All 50 focused policy, ownership, pane-migration, and
overview-retirement tests passed; server TypeScript checking passed.

The repository-wide check now passes decomposition, workflow removal, route
inventory, and network-contract audits; later stages are still being evaluated.
This structural extraction does not remove the remaining compatibility readers
or establish the outstanding native lifecycle/entrypoint acceptance. The full
goal remains incomplete, including the final `TABS.md` rewrite and requirements
audit.

Expanded verification passed all workspace typechecks, source/patch checks,
CLI and interaction/CUA checks, and the protocol/crypto/logging/glitch suites.
The ongoing full server run exposed existing failures. A separate identical
two-file rerun on both this branch and unchanged Primary reproduced exactly
two failures with 27 passing tests: `local-foundation.test.ts:1771` parses a
provider response missing the expected fields, and `worktree-api.test.ts:4159`
expects HTTP 200 from a retired plaintext route that returns 410. Neither is
caused by the policy extraction; both remain unresolved and are not waived.
The full suite has not yet completed, so it is not recorded as passing.

### File-document storage accounting

Compatibility policy extraction merged in #2230 (`9c291a7c4`), with 50 focused
tests passing again on integrated Primary. Its full repository check subsequently
finished with 1,535 server tests passing, 57 skipped, nine failed tests and one
suite-loading failure (seven failed files). The remaining recursive package
checks were not completed by that failed run.

That run exposed a goal-related omission: `file_documents` was absent from the
exhaustive storage-accounting manifest. File documents now use project-owned
accounting, resolving their account through `project_id`, matching their schema
rather than assuming an `owner_id` column. The existing exhaustive table test is
retained and additionally asserts this specific ownership classification.

Other full-run failures remain unresolved: native-history app alias resolution,
the local-foundation provider fixture, task-operation queue fixtures, streaming
timeout policy expectations, the retired plaintext worktree route expectation,
and worktree-continuation live-message setup. This accounting correction does
not waive those failures or complete the broader ownership goal.

Validation: all 19 account-resource-usage and workspace-layout tests passed,
including execution of the complete accounting query against PGlite; server
TypeScript checking and `git diff --check` passed.

### Retire the legacy sidebar pin handoff

File-document accounting merged in #2231 (`ede667bd8`); all 19 focused tests
passed again on integrated Primary. Server behavior CI was still running when
this cleanup began.

Source audit confirmed that sidebar pinning has no producer for the old
`SidebarFilePinHandoffState`: preview and pin requests both enter the owned
file-tab controller. This cycle removes that dead state, its timeout and
completion effects, successor activation, source/destination Explorer overrides,
and inline-editor readiness callback. Sidebar progress now reflects only the
real owned-file mutation. The unused preview-ownership gate and obsolete prewarm
arguments are removed as well. Protected document transfer/recovery and legacy
Explorer migration are unchanged.

Tests specific to the retired handoff are removed; owned-file success/failure
coverage remains. Renderer-owner regression cases verify the requested owner
set, deduplication with current active metadata, and an empty layout without an
invented owner. Remaining transient-preview readers and Explorer prewarm pooling
still require cleanup; this cycle does not claim the complete identity goal or
native acceptance audit is finished.

Validation: the full app run passed 547 files / 3,790 tests with three skips;
the final focused run passed all 66 tests including the new owner-set cases.
App TypeScript checking, production build, application decomposition, large-file
audit, and `git diff --check` passed. No native UI claim is based on this
dead-code removal; native lifecycle acceptance remains a separate requirement.

### Retire shell transient-preview ownership

The pin-handoff cleanup merged in #2232 (`0f716ffb0`), with all 66 focused
tests passing again on integrated Primary. This cycle removes the remaining
shell-level transient sidebar preview identity, its lifecycle/header state,
navigation setters, special tab-strip injection, and pane-body suppression.
Sidebar file opening and pinning continue through owned file tabs; ordinary
preview flags, protected buffers, and legacy Explorer migration remain intact.

Regression tests now exercise owned file and Code placements independently
with either pane focused, rather than constructing an obsolete transient
preview. Sidebar tree ownership still excludes tabbed Explorers. Target-pane
coverage includes missing, empty, and dock-only layouts.

Validation: the full app suite passed 547 files / 3,784 tests with three skips
before the final two target-pane boundary cases were added. The final focused
run passed all 109 tests, including those boundary cases. The production
build (including TypeScript), decomposition audit, large-file audit, and diff
checks passed. Component-level transient APIs and sidebar prewarm pooling remain
follow-up cleanup; native lifecycle acceptance, the TABS.md rewrite, and the
final requirements audit are still outstanding.

Prior server CI run 40131223407 has now finished: each platform failed the
existing worker-command-timeout-policy expectation (10 unbounded commands
expected, six actual); its encrypted identity/ownership batch otherwise passed
147 tests. This remains unresolved, not waived by the app cleanup.

### Retire unused preview component contracts

Shell transient ownership removal merged in #2233 (`a2d1b9318`), and all
109 focused tests passed again on integrated Primary. The component cleanup
removes the tab strip's separate `previewFile` contract and its special
renderer, plus transient-file/lifecycle forwarding in PersistentExplorerViews.
Ordinary file surfaces remain the tab strip's sole file presentation, including
their preview flag and view identity. Dirty legacy Explorer retention and
incoming editor transfers are unchanged.

Tests now select and middle-click-close both preview and pinned ordinary file
surfaces by view identity. Legacy Explorer tests check keyed metadata updates,
inactive open-view retention beyond the clean cache bound, and dirty retention.
The lower-level ExplorerView transient-path API remains intentionally supported:
Code views and the legacy popout reader still call it. Sidebar prewarm pooling
also remains for the next cleanup cycle.

The audit additionally found that ordinary file tabs currently lack the old
preview renderer's double-click/Keep Open action. Sidebar pinning works through
the owned controller, but the tab-strip action must be wired to that same
controller in a subsequent behavior change. This is remaining work, not a
completed preview/pin acceptance claim.

Validation: full app suite 547 files / 3,786 passed / three skipped; final
focused suite 95 passed, including the retained ExplorerView transient/mode
and native-session cases. Production build (including TypeScript), application
decomposition, large-file audit, changed-file formatting, and diff checks passed.
This dead-API removal makes no new native-window acceptance claim.

### Ordinary preview Keep Open controls

Component cleanup merged in #2234 (`53a1ced1c`), with 95 focused tests passing
again on Primary. Ordinary file tabs now expose Keep Open in both menus and
on double-click. The mobile picker exposes a separate pin action. All three
dispatch the existing owned-workspace `pin` command with the view identity;
no Explorer promotion, replacement document, selection change, or successor
handoff is introduced. Already-pinned files and non-file resources are ignored.
Rejected requests preserve the preview and remain retryable.

Validation: full app suite 548 files / 3,797 passed / three skipped; focused
suite 81 passed; TypeScript, decomposition, large-file and diff checks passed.
The disposable desktop/mobile browser harness passed ten checkpoints, including
double-click pinning, menu pinning, mobile pinning, an injected HTTP rejection
followed by successful retry, unchanged tab fields except preview, dirty-buffer
reload, close selection, and device isolation. Final fixture:
`editor-b13fd1c5-3e4f-4404-9a5a-492969ceaf2e`. An earlier failure-injection run
missed a response because its listener was installed after the click; the
harness now installs that listener first. Initial builds/QA also hit actual
disk-full failures before space became available; those runs are not passes.

This is not completion of the overall goal. Sidebar prewarm cleanup, remaining
native surface/recovery acceptance, TABS.md replacement, known server-suite
failures and the final requirement audit remain outstanding.

### Sidebar tree ownership without hidden preview editors

Ordinary Keep Open controls merged in #2235 (`67537e4dc`); its native/runtime
contract CI passed on Linux, macOS, and Windows. The sidebar now provisions
one tree resource for the desired worktree instead of a two-Explorer preview
pool. It no longer mounts hidden prewarm or successor editors. Existing open
and retained dirty legacy editors keep their normal ownership and transfer
behavior; no existing resources are deleted. Selecting an ordinary file tab
now supplies that file's worktree to the sidebar tree selector.

Validation: full app suite 548 files / 3,797 passed / three skipped;
TypeScript, decomposition, large-file audit, formatting and diff checks passed.
The desktop/mobile browser harness passed all ten checkpoints, including
dirty-buffer reload, independent device placement, preview pinning and retry.
Fixture: `editor-ced0222a-8567-46d2-84da-21cbceef0463`.
Remaining work includes native surface/recovery acceptance, the TABS.md rewrite,
known server-suite failures and the final requirement audit. This cleanup does
not establish additional native multiwindow acceptance.

### Restore timeout and retry verification contracts

Sidebar tree ownership merged in #2236 (`7584e9d7f`); all 41 focused tests
passed on integrated Primary, and editor lifecycle CI passed on all three
platforms. Its worktree was archived after preserving browser QA artifacts.

The server timeout inventory still expected duplicated pause routes removed
by #2181. It now asserts the exact six streaming call-site owners (three
terminal attachments, one turn, and two shared pause-runtime calls), retaining
the runtime deadline and streaming-completion tests. Task submission fixtures
now include the retry store and explicitly assert user submissions reset the
latch, automatic submissions preserve it, and rejected submissions never reset
it. No production timeout or retry policy changes are made.

The four focused timeout, queue, pause and interruption suites pass 23 tests.
The history suite's app-alias import failure and task continuation encryption
fixture failure were separately reproduced and are not fixed by these changes.
Native lifecycle acceptance, remaining suite failures, TABS.md and the final
requirements audit remain outstanding.

### Restore history and continuation verification

Timeout/retry verification merged in #2237 (`85de5cd5a`), with all 23 focused
tests passing again on Primary. The server test runner now resolves the app
source alias used by the real client history projection; test discovery remains
unchanged. The previously unloaded history suite now executes its database-backed
ingestion and projection cases.

Continuation encryption assertions now follow the #2190 contract: ordinary
Task and Agent continuations pass an encrypted chat envelope to beginTurn, while
active Task Goals use their dedicated continuation runtime. Tests decrypt both
ordinary envelopes, check system/default classification and protected worktree
text, reject another owner's decryption, and ensure a handled Goal does not
start a duplicate turn or issue another protection request.

Validation: all 66 tests across native-history-items, worktree-continuation-
encryption and task-goal-observation passed; server type-check, formatting and
diff checks passed. This cycle does not change runtime behavior. The full server
run started in the previous verification worktree remains separate evidence;
other known failures, native acceptance, documentation replacement and the final
requirements audit are not declared complete.

### Repeatable native surface acceptance harness

History/continuation verification merged in #2238 (`721c5dc0d`); its CI and
#2237's CI both completed successfully. A checked-in macOS launcher now builds
the current native source into a uniquely identified disposable app bundle,
with isolated server, worker, repository and desktop data. The local browser
fixture provides a random document-instance ID, volatile input and counter so
native transfer tests distinguish session retention from a page reload.

Actual native checks on the #2238 baseline:

- A terminal retained output and a live shell variable through tab detach and
  native-window return. A whole-pane two-terminal move left main empty, with no
  disabled placeholder; closing one view and then its window returned only the
  surviving terminal, without resurrecting the closed sibling.
- A browser retained the same document UUID, unsaved input and in-memory count
  through detach, destination interaction and return. Main was directly inspected
  while detached and contained only the sibling terminal.
- A verified full unsent chat draft survived detach and return. An initial
  rapid typing/detach attempt arrived partially typed; the source was not checked
  before that move, so its cause remains unproven rather than called a pass.
- A mixed pane of terminal, browser, chat and two native Code tabs moved and
  returned. Both dirty Code drafts, including the inactive editor, were verified
  at the destination and after return. Both fixture files retained their original
  bytes on disk and the fixture Git worktree remained clean.

The terminal whole-pane run included a transport error after 22.45 seconds and
an automatic successful reconnect without shell-state loss. Its cause remains
to investigate. Remote Desktop opened a worker session but had not delivered a
frame at inspection (1x1, 0 FPS); live capture/input transfer is not established.
The harness checklist does not imply remaining concurrent-window, remote-desktop,
loading-layout, full-suite, documentation or final-audit requirements have passed.

### Native helper setup and Remote Desktop continuation

The native acceptance harness merged in #2239 (`2d83f5714`); its Linux, macOS
and Windows CI jobs passed. The isolated worker initially had no bundled
`cantrip-cua` executable. Running the missing executable failed with ENOENT;
building the current helper restored capture. The launcher now builds that
helper before starting its services and supplies Cargo's actual executable path
only to the fixture worker. It neither installs a production helper nor relies
on a stale binary in the checkout. Build errors propagate before services start.

After refreshing targets and selecting the disposable QA main window, native
capture became ready at 1280x800 with no input warning. Detaching Remote Desktop
preserved that target and capture; the captured main window showed only its five
sibling tabs, without a disabled Remote Desktop placeholder. Closing the native
popout returned the tab and restored capture in main. A click on a sibling tab
inside the remote image did not visibly select it: remote input remains
unverified, and clearing a warning is not evidence of input delivery.

Validation for the launcher correction: the current helper compiled successfully
using a shared Cargo target directory; all four helper build/bundle regression
tests passed, including actual-output selection and rejection of failed/stale
build results. Both changed JavaScript files passed syntax checks. Full native
acceptance, remaining transport findings and the final scope audit remain open.

### Protected server contract verification

The native helper correction merged in #2240 (`37bc405a9`). This verification
cycle updates the foundation and worktree integration fixtures to exercise the
current protected contracts instead of retired plaintext routes. It preserves
checks for scope, ordering, revision conflicts, restart recovery, native queue
receipts, approvals, and resource lifecycles. Private results are decrypted in
the test client, not made visible to the server to satisfy old assertions.

Repository operations now exercise the production worker dispatch function,
extracted without changing its behavior from the worker entry point. The
fixture uses the real protected request/response codecs and worker-managed Git
operation store; leaf Git execution remains simulated. Managed-operation
restart checks reopen that store and read through the protected operation
endpoint. An offline worker returns a transport error rather than server-cached
private Git state. Separate dispatcher tests cover trusted path precedence,
empty operation state, invalid operation control, and peer-worktree rejection.

The full server suite passed 1,600 tests across 263 files (57 existing skipped
tests across eight files). After the final fixture corrections, sequential
focused verification again passed all 55 server tests across foundation,
worktree API, and attachment coordination. Six worker dispatcher/store tests
and server/worker source typechecks passed. The extra test-file type audit found fixture
issues not covered by the source-only server typecheck; new-line findings were
corrected, while existing test-file errors remain outside that check. The
boundary audit now checks the extracted dispatcher and its production wiring,
retaining the trusted-path and worker-local operation-store requirements.
These contract checks do
not establish the remaining native acceptance, documentation replacement, or
full-goal completion requirements.

### File-creation collision verification follow-up

The protected server contract cycle merged in #2241 (`5078aa0a8`). Its native
editor/runtime, app API, and computer-use foundation CI lanes passed. The worker
command matrix exposed a Windows-only failure in the existing Explorer collision
test: exclusive open accepted a dangling symbolic link as a new file.

File creation now inspects the destination entry with `lstat`, rejecting existing
links without following their targets. Errors other than a missing entry remain
errors; exclusive open is retained to reject competing regular-file creation.
The regression also verifies that the dangling link survives unchanged and its
target is not created. This is not a claim of atomic protection against a hostile
symlink swap between inspection and open on Windows.

Local verification passed all 14 Explorer tests and the worker source typecheck.
Windows CI must verify the platform-specific correction. Remaining native
acceptance, legacy-path cleanup, and the replacement of the historical tab
documentation remain outstanding; this correction does not complete the goal.

### Code browser file-opening cutover

The file-creation collision correction merged in #2242 (`a8c7c793e`) after all
six worker command/runtime CI jobs passed, including Windows repeated terminal
replay. Primary was synchronized and its tree matched the reviewed commit.
Recoverable worktree archival remains unavailable because registration hits the
app's attachment limit; the clean checkout was retained rather than removed
without its recovery snapshot.

The Code browser was still opening new files through a local transient path.
It now requires the shared project-file opener, forwarded through the persistent
surface layer. New requests therefore use ordinary document/tab ownership,
including existing-tab focus, rather than creating a second inline file view.
Restored legacy Code buffers retain their existing transfer, dirty-state, save,
and close protections; their presence is compatibility recovery, not permission
to create new transient file views.

Regression coverage checks that browser clicks request the bound project and
checkout without reading an inline file, that shell wiring reaches the shared
opener, and that restored legacy drafts retain editing and lifecycle behavior.
The final focused run passed 40 tests; app typechecking also passes after adding
the required opener callback to existing transfer fixtures.

The full check from the preceding contract cycle terminated with 10 worker-test
failures across six files (2,503 passed). A serial rerun of those six files passed
104 tests, with six failures remaining in external-history reader-version checks
and the pinned native-gateway method inventory. MCP restart, history-outbox
restart, worktree notifications, and Sharp boundary checks passed unchanged in
that serial run; this does not prove their broad-run timing failures resolved.
Full-goal native/mobile acceptance and historical tab-documentation replacement
remain incomplete.

### Current tab contract and compatibility audit

The Code browser cutover merged in #2243 (`8aab6e624`); all nine native
editor/runtime, editor-lifecycle, and stability-recovery CI jobs passed across
the three platforms. Primary matched the reviewed tree after synchronization.

`docs/TABS.md` now replaces the old project-wide placement and disabled-popout
placeholder design with the integrated ownership contract. The source audit
covered the schema, command transitions and queue, bootstrap, seed conversion,
mobile navigation, transfer protection, and return-before-native-close behavior.
The documented return fallback preserves intervening split changes instead of
claiming unconditional restoration of the original tree. All 21 local Markdown
link targets resolve and `git diff --check` passes for this documentation cycle.

The compatibility audit still identifies the legacy standalone Explorer-file
receiver and restored Code inline-buffer path. New Code opens no longer use the
latter, but safe retirement of these recovery readers is not established. Native
validation of the new Code opening route, representative simultaneous mobile and
desktop interaction, remaining recovery/concurrency cases, and the outstanding
broad-check failures remain work, not waived acceptance criteria. No runtime
behavior changes in this documentation cycle.

### Retire the unused Explorer file-window producer

The current tab contract merged in #2244 (`1c93fc6c9`). The next compatibility
audit found no production callers of the old `openDesktopExplorerFile` or its
prewarm API: new project file windows already use `useOwnedFileWindow` and the
workspace transfer coordinator. The unused producer, warm-slot state, parallel
window/broker maps, and identity-subscription cleanup are removed from
`desktop-popout.ts` rather than retained as a competing way to open file views.

Legacy target parsing/labels and both receiver paths remain unchanged so this
cleanup does not discard existing drafts or break restored links. The removed
tests exclusively exercised the retired producer (including same-window path
replacement, which conflicts with first-class file tabs). Route compatibility,
receiver authority/revocation, and the owned opening/transfer tests remain. A
small API regression test prevents reintroducing the retired exports.

All 89 tests in eight focused desktop/receiver/owned-file/transfer suites pass;
the app source typecheck passes. This is unused-path cleanup, not acceptance of
the still-retained receivers or proof of the remaining native/mobile matrix.

### Bound destination acknowledgements after reproduced HTTP startup failure

Fresh native QA on #2245 moved a Code browser and two unsaved file tabs to a
popout and back. Both active and inactive drafts survived; main had no duplicate
placement and disk contents remained unchanged. The representative mobile run
also passed its ten device-isolation, preview, pin, reload, and selection checks.

Injecting HTTP 503 into the actual destination startup request exposed a hang:
the destination stayed hidden while source inputs stayed suspended indefinitely.
The transfer coordinator now waits at most 30 seconds for each application-ready
and restored-state acknowledgement. Expiry uses the existing authoritative
cancel path before resuming the retained source lease. Unknown server mutation
outcomes are not raced or inferred from this observation deadline. A cancelled,
unowned new destination is destroyed; return-to-main never destroys main or the
returning source. Main receives the native destroy capability needed for this
cleanup, and the helper rejects non-workspace labels.

Regression coverage includes missing readiness/restoration, cancellation failure,
failed return readiness, native cleanup, and a delayed commit beyond the deadline.
The five focused suites pass 70 tests and the app source typecheck passes.
Native reproduction of the fix remains required; the prior failing fixture and
both drafts are retained in workspace-retire-file-producer/.qa. This does not
close the remaining compatibility, full-suite, or native acceptance requirements.

### Import legacy native file windows

The destination-deadline fix merged in #2246 (`77dfb000e`). Fresh native QA
confirmed that an actual HTTP 503 destination times out, resumes both source
drafts, and permits a successful retry and return with unchanged disk contents.
The Windows installation fixture and both Windows/macOS transport jobs passed.

Legacy Explorer-file links now use authenticated startup, including links with
obsolete broker launch IDs. They no longer select the standalone broker renderer
in production startup. The compatibility receiver defers workspace attachment
until its actual native label has been imported, so absence before migration is
not mistaken for a retired owner. It captures and encrypts all retained buffers,
creates/reuses authorized immutable file documents, checkpoints each target view,
and commits the import under the workspace revision lock. Replay tombstones
survive normal view/window closure. Explorer IDs cannot masquerade as document
IDs at the import endpoint, and project ownership is checked server-side.

Successful import replaces the route within the same JavaScript context and
mounts the ordinary owned pane. Close requests are deferred while import is
actually running. Real failures retain the source and encrypted journal for
retry; a live source may advance only checkpoints it wrote itself. A new renderer
with divergent dirty data, or a document that already has another owned view,
requires reconciliation rather than silently replacing either draft.

Native QA imported two encrypted dirty files, selected the inactive file, edited
it without saving, and returned both tabs to main by closing the native window.
Both draft contents survived; disk baselines were unchanged. An obsolete launch
link in the same workspace entered authenticated import and reported the expected
existing-view conflict while preserving its source. The standalone broker
component remains only for the older file-polish QA fixture, not production
startup. Conflict-resolution UX and the restored Code inline-buffer audit remain
follow-up work, as does the broader goal acceptance matrix.

An independent native fixture also passed obsolete launch-link import and return:
both dirty tabs returned to main and both disk baselines remained unchanged.
The final full app suite passed 550 files / 3,816 tests (three skips), app and
server typechecks passed, and installation compatibility passed all seven
contract/recovery simulations plus the workflow-removal contract. Focused
protocol ownership tests passed 146 tests and the server file/ownership suites
passed 30. The final close-in-flight refinement is unit-tested; the native build
used for this run predates that refinement. Source review is complete; PR
delivery and the wider goal acceptance matrix remain outstanding at this
checkpoint. This record does not claim goal completion.

### Legacy import contract verification follow-up

Legacy native file import merged in #2247 (`a5e9e82a1`). Primary was fast-forwarded
and matched the reviewed tree. Its cross-platform CI exposed two omitted contract
updates: the root protocol export baseline did not enumerate the four additive
legacy-import exports, and the reviewed server-route inventory omitted the new
import endpoint. The original baseline fingerprint remains unchanged; the new
exports are explicitly named and asserted. The endpoint was reviewed against its
strict identity-only request, owner/project authorization, immutable document
lookup, and opaque-label response before updating the inventory digest. The
generated inventory adds exactly that route, with associated counts and source
line updates; it does not reclassify unrelated routes.

The follow-up passes all 694 protocol tests, the actual server-boundary audit,
and 19 route-parser/content-classification tests. The preceding cycle's native
editor/runtime jobs passed on Linux, macOS and Windows. Remaining CI is still
being observed. Restored Code buffers still use the inline compatibility reader;
converting them into first-class file tabs, conflict reconciliation, and the
broader native/recovery acceptance matrix remain required, not waived.

### Preserve existing target drafts during legacy conversion

The contract follow-up merged in #2248 (`2b5a23b0a`); all 19 remote checks
passed. The Windows native-runtime lane passed on its unchanged rerun after
an initial temporary-directory cleanup `EBUSY` failure.

Before extending conversion to restored Code buffers, source review found that
the owned Explorer conversion loaded a target document's recovery record but
then discarded its contents before checkpointing. An interrupted migration could
therefore replace an unsaved target with a clean disk read. It now reconciles
that actual recovery payload with the source using the same validated merge as
legacy native-window import. Recovered dirty content, history, selection, and
scroll survive clean source reads; divergent dirty drafts reject conversion
before source retirement or ownership mutation. Both records remain available
and the source resumes. Source-journal reconciliation also compares baseline
versions rather than treating identical text from different versions as equal.

Six additional regression cases cover selected/inactive target preservation,
selected/inactive conflicts, identical-target replay after server rejection,
and mismatched journal versions. Five failed against the preceding implementation;
all 36 focused migration tests now pass, as does the app typecheck. This change
does not implement a conflict-resolution UI or finish the restored Code buffer
conversion; those and the remaining native/recovery acceptance matrix are still
required.

The complete app suite also passed 550 files / 3,822 tests (three skips), with
formatting and diff checks clean. No new native visual run was performed for
this reconciliation-only change; it does not establish completion of native
handoff acceptance.

### Restored Code buffer conversion

Draft-preservation reconciliation merged in #2249 (`ae6badf05`). The next
isolated cycle implements `migrate-code-files`: an owner-window command adds
adjacent, non-preview file tabs while retaining the Code browser identity.
Identity-only conversion receipts prevent replay from resurrecting closed file
tabs. Source Code binding and all target documents are validated under the server
transaction; documents already owned elsewhere reject conversion rather than
creating a competing renderer. Client migration checkpoints all buffers through
protected recovery, including inactive files, and waits for authoritative commit
before replacing the inline Code editor with its browser. A recovered Code
journal also restores the selected file and mode on a browser-only restart.

Current verification: 939 protocol tests, 20 server file-document tests, and the
full app suite (550 files / 3,825 passes, three skips) passed. A subsequent
selected-file recovery regression passes in the 14-test migration suite. App
and server typechecks, the server-boundary audit, and seven installation
compatibility simulations passed. Full-suite rendering failures found during
development were fixed and the suite rerun successfully; they were not waived.

Native QA passed after the disk-space interruption was resolved. The rebuilt
macOS fixture restored two protected Code drafts into distinct file tabs and
selected second.txt. That dirty file moved into a native popout, disappeared
from main, and returned intact when its native window closed. Explicitly closing
second.txt and reloading did not resurrect it; qa.txt retained its unsaved text.
Both worker files still contained their original baseline bytes (no implicit
save). The fixture is retained with the surviving synthetic draft.

This real run exposed a lifecycle-subscription render loop: callback replacement
was notifying parent subscribers on every render. Registration notifications now
track mount/unmount only, while the registry still exposes the latest callbacks.
A focused regression covers replacement, removal, and duplicate removal; the
17-test Code lifecycle/view/migration-hook group passes. Before that final fix,
the complete app suite passed 3,826 tests (three skips), all 939 protocol tests
passed, and app typechecking passed. Broader goal acceptance remains incomplete.

The cycle merged in #2250 (`b066fb16b`); Primary was synchronized and its tracked
tree matched the reviewed branch. All 25 remote CI checks passed. The final app
suite passed 3,827 tests (three skips). A concurrent full server run passed 1,577
tests but failed ten tests and a suite setup across repository-discovery,
task-dispatch, and tunnel-control tests; timeout failures occurred under combined
native/app build load. All three files subsequently passed unchanged, serially:
42 tests. This isolated rerun does not claim the full server suite passed.

### Explicit recovered-draft reconciliation

The next cycle adds a client-only comparison dialog for divergent protected
migration snapshots. Owned Explorer/Code conversion and legacy native-window
import can ask which draft to keep or cancel. Choices are scoped to the exact
validated snapshots, rechecked against ownership/account after awaiting input,
and never save worker files. Cancel retains both versions; account/context
changes clear previews and reject stale callbacks. A selected recovered draft
is carried into the migration checkpoint instead of being silently replaced by
a recapture of the suspended live editor. No private text enters layout metadata.

Final verification passes all 551 app test files / 3,842 tests (three skips),
including comparison rendering, cancellation, stale account/context actions,
per-file choices, and source-ownership changes. App typechecking and diff checks
pass. Legacy-window importer tests also cover explicit choice,
cancellation, and account changes while awaiting a choice.

After the host was unlocked, native validation passed: the dialog displayed both
divergent second.txt drafts, Cancel retained both and offered Retry migration,
and retry displayed the same snapshots. Choosing the recovered draft created
distinct second.txt and qa.txt tabs. A native WebView reload retained the chosen
second.txt text and the inactive dirty qa.txt text. Both worker files retained
their original baseline bytes (no implicit save). The comparison dialog bounds
its height and wraps baseline identifiers to remain usable in smaller windows.
This is not goal completion and does not replace the broader recovery and
compatibility audit.

This cycle merged in #2251 (`d27da765b`); Primary was synchronized and all three
native contract CI platforms passed.

### Checkpoint-protected normal desktop quit

Merged in PR #2252 (`7651506ee`). All six remote checks passed, including
Linux/macOS/Windows contracts, both native transport jobs, and the Windows
installation fixture.

Normal confirmed Quit now freezes editor input in every registered native
renderer and waits for actual protected recovery writes, including inactive
documents. A failed checkpoint, renderer replacement, or missing acknowledgement
cancels quit and restores interaction; it never saves or discards a worker file.
Acknowledgements are bound to the native window, renderer token, and quit round.
Normal window-return handling and new popouts are suppressed while preparing.
The native coordinator logs checkpoint outcomes without document text or tokens.

Native validation uncovered a separate identity mismatch: the Code migration
receipt identifies a workspace view, while its rendering consumer compared a
resource ID. This stranded the retired source on “Moving editor…” and prevented
quit. The consumer now matches the view ID before mapping to the Code resource;
a regression uses deliberately distinct identities.

In the isolated macOS fixture, two recovered unsaved files were split between
main and a native popout. An injected checkpoint failure kept both windows and
drafts. Retrying with a five-second checkpoint completed both acknowledgements,
exited, and restarted the same fixture. Main restored only qa.txt and the Code
browser; the separate window restored only second.txt. Both unsaved contents
survived, while the repository stayed clean with its original file bytes.

This increment covers normal confirmed Quit. Updater restart, synthetic-build
replacement, forced termination, mobile acceptance, and the remaining broad
workspace acceptance audit are not established by this run.

Verification: all 553 app test files passed (3,853 tests, three skips) with four
workers; all 130 native Rust library tests passed. App typechecking, formatting,
large-file and decomposition checks passed. Initial simultaneous native/app/QA
runs timed out in Graph status and native loopback tests; unchanged reruns after
stopping the extra QA fixtures passed, including both full suites. Fixture data
and synthetic protected drafts were retained; the final fixture exited normally.

### Installation uses the same protected checkpoint

The release updater and cached synthetic-build installer now await the actual
per-renderer checkpoint before stopping services or beginning installation.
The shared checkpoint runs off the native main thread. Its owned guard releases
the renderer freeze and registration fence if preparation or staging fails;
successful installation retains the fence through exit/restart. A stale guard
cannot cancel a newer round. Synthetic handoff helpers already wait for process
exit, so they now launch before services stop: a helper launch error leaves the
running application usable instead of stranding it with stopped services.

Verification: 131 native Rust tests passed, including stale-round cancellation;
10 renderer checkpoint tests passed. The release-profile Rust check passed,
covering the packaged updater branch. Formatting, diff, large-file and app
decomposition checks passed. Initial transport/QA attempts in the fresh worktree
failed on missing built JavaScript dependencies; building those dependencies
allowed unchanged reruns to pass.

Native macOS QA used two unsaved file tabs in separate windows. An injected
failure cancelled the checkpoint. A five-second successful checkpoint was then
deliberately dropped without installing anything, releasing both renderers.
Typing a new line in main succeeded; another checkpoint succeeded. Normal quit
and fixture restart restored that new line and the other window's unsaved draft,
with exclusive tab placement and unchanged repository file bytes. The debug-only
isolated QA menu exposes this checkpoint-and-abort scenario; it never invokes an
installer. This establishes checkpoint/abort/restart behavior, not a live signed
update or Windows installer run. Forced termination, mobile acceptance and the
remaining broad workspace audit are still outstanding.

Merged in PR #2253 (`c0e688859`). The macOS and Windows native transport jobs
and Windows installation fixture passed after merge observation.

### Mobile overflow and explicit view-mode acceptance

The concurrent mobile/desktop harness now opens and pins six additional Rust
files, creating seven distinct mobile file tabs. It verifies real horizontal
overflow, complete picker membership, five-entry interaction recency, keyboard
picker activation, and adjacent selection after closing a middle active tab.
Explicit View mode survives another-file selection, Explorer reopening, and
reload without changing tab identity or order. The original unsaved draft and
desktop's authoritative layout remain unchanged. The existing rejected-pin and
successful retry scenarios still run afterward.

Verification: `node scripts/qa/workspace-mobile-desktop.mjs` passed all 13
scenario assertions in touch-enabled Chromium at 390 × 844 with a separate
desktop context. The final mobile screenshot shows the unsaved buffer and
overflowing bottom navigation. Owned server/worker processes exited cleanly,
with zero surviving children or sockets. This is representative mobile browser
acceptance, not a physical iOS/Android or native crash test. Forced termination,
multi-window concurrency, remaining surface runtime checks, and the complete
file-entry-point audit remain open; the full goal is not complete.
