# Workspace ownership implementation record

Status: active, incomplete. This record tracks the identity-based tab/pane/window
goal. It does not redefine completion around the foundation below.

## Target contract

The ownership chain is device workspace → window → pane → tab → resource.
Each tab has one pane owner; each pane has one window owner. Moving preserves
identity. Window ownership is actual placement, not a disabled main-window
placeholder. Workspace IDs are scoped to the authenticated account/server and
project; viewport changes never choose a different device workspace.

Tab close removes that view; popout window close returns its surviving views.
Resource deletion/archive is a separate action. Active-tab close selects the
right neighbor, then the left. Closing an inactive tab leaves selection alone.
Closing the final tab removes its pane and focuses the most recently focused
surviving pane in the same window, or home. Recent tab switching is separate.

Normal window close waits for a recoverable return transfer. Application quit
persists a coherent session without reopening windows during shutdown. A native
creation event is not an application-ready acknowledgement. No timeout alone
proves that an owner died. Transfers prepare every affected surface and fence
stale renderers using attachment generations. Dirty documents must transfer
without mandatory saves or plaintext persistence.

Mobile and desktop share resources, not automatic layout edits. File tabs must
be first-class views rather than mutable Explorer selections. Preview and pin
are flags on ordinary tabs. Resource loading must not remove tab identities.

## Cycle 1: ownership contract and seed conversion

Branch: `codex/workspace-ownership-contract`. [PR #2209](https://github.com/ArcaneArts/Cantrip/pull/2209)
merged as `54bf48971`; Primary synchronized.

- Added a versioned protocol snapshot with window-owned pane trees and independent
  tab identities, window-local selection/history, and attachment generations.
- Validates unique ownership, exact center-tree membership, and local focus.
- Added deterministic, one-time conversion from validated legacy wire layouts.
  Preserves resource references, opaque protected labels, order, split fractions,
  dock preferences, and supplied selection. Existing workspace state wins over
  subsequent legacy snapshots; mismatched scope is rejected.
- Conversion preserves pane IDs within a workspace. Persistence must use
  workspace-scoped keys rather than treating imported pane IDs as globally unique.
- No server table, endpoint, live UI, or migration runner uses this yet. Existing
  legacy APIs remain unchanged. This is a contract foundation, not the rollout.
- Explorer-backed file references intentionally remain legacy references during
  seeding. A later file migration must resolve them through authorized protected
  resource state, not copy paths into plaintext layout records.
- Native detached-window discovery/import must happen before committing the
  seeded layout in the integration cycle; the pure seed creates only the main
  window and does not claim existing native windows have moved.

Verification: all 569 protocol tests passed (28 new ownership/conversion cases),
protocol typecheck/build passed, and scoped formatting, large-file checks, and
`git diff --check` passed. The original export compatibility fingerprint remains
unchanged; its additive list now also records the three traffic constants from
#2204 that reproduced a baseline failure on unchanged Primary. Native/UI
verification is not applicable to this unconnected contract cycle and remains
required before completion.

Broader CI exposed a Windows worker broken-symlink creation failure also present
in the preceding run `40046965685`, plus a worker Git index-lock collision.
Cycle 1 changed no worker source/tests. Final broader CI: 15 jobs passed, four
failed. The other three failures were the unchanged server timeout-policy count
(expects ten unbounded commands, observes six), also reproduced in preceding
run `40047835332`. These are not claimed as passing; native and full-system
acceptance remain open. The clean cycle worktree was submitted for recoverable
archival after merge verification.

## Cycle 2: deterministic workspace command controller

Branch: `codex/workspace-command-controller`. PR/merge: pending.

- Added strict commands with operation, workspace, project, window, attachment
  generation, and expected-revision identity. Pure execution rejects stale
  renderers/revisions and cannot modify a tab in another window by accident.
- Implements select/home, close tab/pane, pin, exact reorder, move, split,
  resize, and open/focus-existing. Close selection is adjacent within a pane;
  empty-pane cleanup collapses its tree leaf and uses local focus history.
- Opening an already-open resource selects its original view, returning an
  explicit focus-window effect when necessary, not a duplicate placement.
- Empty-popout effects describe only a window emptied by the current command;
  unrelated empty windows preparing transfers are left untouched.
- Execution validates a cloned result and advances one revision atomically;
  failures never mutate the input. No native destruction, resource deletion,
  authorization, or save is performed by this pure transition layer.
- Durable receipts/idempotency, server persistence, pending-operation rebasing,
  lifecycle confirmations, and actual UI routing remain integration work. This
  cycle does not enable a competing write path or claim live cutover.

Verification: all 608 protocol tests passed, including 39 new transition tests;
protocol typecheck and build passed. Scoped formatting, large-file checks, and
`git diff --check` passed. Reviewed inputs remain unchanged after both successful
and rejected operations. Native/UI integration is still outstanding.

## Remaining implementation and acceptance ledger

- [ ] Server persistence and owner-authorized workspace endpoints; atomic,
      idempotent operations and workspace-scoped revisions.
- [ ] One-time durable migration, existing detached-window import, legacy
      labels/links translation, and isolation from older-client writes.
- [ ] Unified controller for every layout/selection entry point, authoritative
      base plus pending operations, conflict rebasing, and stale-response handling.
- [ ] Adjacent-tab close policy and window-local focus history in the live app.
- [ ] Stable loading/error tabs when resource queries lag layout queries.
- [ ] First-class documents/file tabs, unified opens, ordinary preview/pin state,
      protected dirty-buffer continuity, and explicit mode preservation.
- [ ] Independent mobile workspace placement; stable file identities, real recent
      history, overflow navigation, and simultaneous desktop/mobile verification.
- [ ] Actual single-tab and whole-pane popout moves, no main placeholders, and
      return of surviving tabs to the original or deterministic fallback placement.
- [ ] Native application-ready transfer acknowledgement; all-surface adapters;
      dirty inactive tabs; generation fencing; failed-open and failed-return recovery.
- [ ] Crash/reload/reconnect/quit/restart recovery without duplicate renderers,
      lost edits, resurrected closed tabs, or shutdown return loops.
- [ ] Dedicated file windows, menus, drag/drop, keyboard actions, sidebar, mobile,
      and links migrated to the same command/ownership semantics.
- [ ] Account/logout/revocation boundaries, worker authorization, protected state,
      resource deletion, and live terminal/browser/Code/remote-desktop/chat behavior.
- [ ] Real native two-window tests and representative mobile interaction tests;
      rapid operations, delayed responses, conflicts, and resource-loading races.
- [ ] Completed behavior enabled; obsolete competing write paths removed;
      documentation updated; every cycle merged and verified.

The open draft PR #2140 touches Explorer editor-buffer recovery. Cycle 1 does not
touch its files. Reinspect its current state before implementing editor transfer;
do not adopt or overwrite its unmerged work.
