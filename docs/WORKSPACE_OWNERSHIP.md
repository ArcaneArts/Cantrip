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
`20261024-033256-validate-mobile-recent-tab-picke`; PR delivery remains pending.

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
