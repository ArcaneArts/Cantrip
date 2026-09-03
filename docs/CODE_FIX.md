# Cantrip Code editor latency diagnosis and fix design

- Status: implemented and regression-verified
- Analyzed baseline: `0e154d670fae8f005564d1356e5a81a732e833cb`
- Confidence: 98% for the primary latency cause and bounded-prewarm fix; 99% for the file-tree replay cause

## Implementation outcome

The diagnosed lifecycle error is fixed by the merged sequence in
[`CODE_FIX_IMPLEMENTATION_PROGRESS.md`](./CODE_FIX_IMPLEMENTATION_PROGRESS.md):

- PR #1642 restored real prewarming only for the existing bounded two-owner
  sidebar preview pool while leaving ordinary inactive editors dormant.
- PR #1643 kept populated file-tree rows mounted during pinning.
- PR #1644 started the authenticated extension bridge before nonessential
  presentation setup.
- PR #1649 passed only the worker-authorized canonical initial file through
  OpenVSCode's supported startup navigation.
- PR #1652 added an authenticated, exact, one-shot acknowledgement so the
  redundant fallback open is suppressed only after the workbench proves the
  requested file is the sole active tab.

Deterministic lifecycle coverage proves that a completed prewarm leaves no
route, transport, attachment, iframe, or workbench creation on first-selection
or post-pin selection paths. Missing, stale, mismatched, or unsupported startup
state still uses the existing validated bridge command. No retry, polling,
delay, timeout increase, or broader hidden-editor activation was added.

The present-tense diagnosis below describes the analyzed baseline, not current
behavior. It is retained as the evidence and design record for the fix.

## Executive verdict

The 5–8 second wait is not caused by an offline worker, slow routing, tunnel setup,
encryption, retries, or a new OpenVSCode server process. It happens because every
new sidebar preview Explorer currently creates a fresh embedded OpenVSCode browser
workbench only after the user clicks a file.

Cantrip still creates a bounded pool of two sidebar preview Explorer surfaces, but
those surfaces no longer prewarm Cantrip Code. They prewarm only the outer Explorer
React surface. Current ownership, retention, null-path, and inactive-state guards
prevent the editor attachment, iframe, workbench, and extension bridge from starting
in the background.

This behavior was introduced intentionally by commit
`376a02a88f892d6825de73d81e610d6b10127f01` (`refactor(code): make retained
editors dormant`, PR #1517). That change correctly aimed to stop arbitrary inactive
tabs from consuming workbench resources, but it also disabled the explicit,
bounded sidebar preview prewarm introduced by PRs #1476 and #1481. Those are two
different ownership cases and must not share the same dormancy rule.

The correct fix is to restore real Code prewarming only for the existing bounded
sidebar preview pool. Ordinary inactive or pinned tabs must remain dormant. The
prewarmed editor must keep the same keyed Explorer, attachment, iframe, session, and
workbench when the first path is selected or the preview is pinned.

## What the four traces prove

| Interaction                                 | Route and transport | Workbench boot | File open |    Total |
| ------------------------------------------- | ------------------: | -------------: | --------: | -------: |
| First file in a new preview Explorer        |              155 ms |       3,360 ms |  1,966 ms | 5,599 ms |
| Different file in the same unpinned preview |       already ready |         reused |     76 ms |    81 ms |
| Pin the live preview                        |              reused |         reused | no reopen |    73 ms |
| First file in the successor Explorer        |               88 ms |       3,296 ms |  1,724 ms | 5,201 ms |

The two slow launches use the same OpenVSCode process instance and the same shared
local-direct transport. The health request succeeds on the first attempt. The
first iframe takes about 3.2 seconds to load and the workbench becomes ready at
about 3.4 seconds. Only then does Cantrip start the bridge-mediated file-open,
which adds another 1.7–2.0 seconds on a fresh workbench.

The 81 ms path change uses the same Explorer ID, editor instance, attachment,
iframe, session, and ready workbench. This is the direct A/B control: repository
I/O and file navigation are fast once the workbench exists.

The pin handoff is also healthy. It promotes the exact live preview Explorer and
finishes in about 73 ms without starting another editor. After the pin, however,
the replacement preview Explorer is only an empty outer surface. Its first file
therefore repeats the full 5.2 second workbench path.

No trace contains a retry, failure, timeout, encryption lock, worker-offline event,
or fallback path that explains the delay. React StrictMode replays the initial
effect in development, but the first attempt is cancelled in 1–2 ms before it does
meaningful work; it is diagnostic noise, not the delay.

## Source-level causal chain

### 1. Sidebar preview identity is already reused correctly

`cantrip_app/src/components/app/sidebar-explorer-commands.ts` replaces the
transient file path while retaining the same sidebar preview Explorer ID.
`cantrip_app/src/components/app/persistent-surface-layer.tsx` activates that
Explorer, and `cantrip_app/src/components/explorer/persistent-explorer-views.tsx`
keys the retained view by Explorer ID. This is why changing paths in one unpinned
preview is instant.

Pinning also preserves the source Explorer ID. The controller persists that same
surface into the layout, clears the transient preview, and selects a successor.
The pin path does not recreate the workbench.

### 2. The advertised prewarm pool does not own a Code workbench

`cantrip_app/src/lib/sidebar-file-tabs.ts` defines a sidebar pool size of two, and
the sidebar controller identifies both the current preview owner and a successor.
Those Explorer surfaces are mounted ahead of use.

The prewarm stops at the outer surface:

- `persistent-explorer-views.tsx` excludes the prewarm Explorer IDs from inline
  Code ownership and does not pass a Code-prewarm role through the component tree.
- `cantrip_app/src/components/explorer/use-retained-inline-workbench.ts` acquires
  retention from active visibility; ownership only prevents an already-retained
  instance from expiring.
- `cantrip_app/src/components/explorer/retained-explorer-code-editor.tsx` returns
  `null` when there is no selected path, which prevents a pathless workbench from
  starting.
- `cantrip_app/src/components/explorer/explorer-code-editor.tsx` refuses connection
  and recovery work while inactive.

Consequently, a surface labeled `prewarm` has no attachment, iframe, workbench, or
extension bridge. A user click is the first event that can start them.

### 3. The regression is visible in history and tests

PR #1517 removed the `prewarmInlineCode` plumbing, removed the prewarm input from
the retained editor, changed the retained-editor render condition to require a
path, initialized retention from active state only, and added inactive connection
guards.

The current ownership test in
`cantrip_app/src/components/explorer/__tests__/persistent-explorer-code-ownership.test.tsx`
asserts that a prewarm Explorer creates no Code owner. It therefore codifies the
regression instead of protecting the intended click latency.

The lifecycle test in
`cantrip_app/src/components/explorer/__tests__/explorer-code-editor-lifecycle.test.tsx`
named for pathless prewarming mounts the editor with its default active state. It
proves that a pathless editor can warm and later reuse one attachment and frame,
but it does not exercise a hidden sidebar prewarm owner.

Project documentation is currently contradictory. Pass 4 of
`docs/CODE_EDITOR_SIMPLIFICATION_PROGRESS.md` records the removal of hidden
prewarming, while `docs/CODE.md` still describes an actual sidebar workbench being
prewarmed without a selected file.

### 4. The cold file-open tail is real but secondary

The server authorizes `initialFile`, and the worker retains it on the attachment,
but the worker currently starts OpenVSCode with only the workspace URI. Cantrip
waits for the generic patched workbench-ready signal and then sends a separate
open-file command through the extension bridge.

On a fresh workbench, the bridge connects only after shell readiness and awaited
presentation setup. The worker bridge waits for that authoritative extension
socket before sending the file command. The trace ordering proves bridge readiness
is on the 1.7–2.0 second cold critical path. The logs do not timestamp the internal
extension operations finely enough to assign that entire interval among bridge
connection, `openTextDocument`, `showTextDocument`, and cleanup; claiming a more
specific split would be guesswork.

This tail is not the primary reason the second file is fast: the warm 76 ms result
shows that the bridge and document path are healthy once the client workbench is
ready. Real prewarming removes both cold phases from the normal click interaction.

## Exact implementation boundary

### Required fix: restore bounded sidebar Code prewarming

1. Pass an explicit `prewarmInlineCode` (or equivalently named) role from
   `PersistentExplorerViews` through `ExplorerView` and
   `RetainedExplorerCodeEditor` into `ExplorerCodeEditor`.
2. Grant this role only to the two explicit sidebar pool owners already selected by
   the sidebar controller. Do not infer it from generic inactivity, retention, an
   open tab, or a hidden surface.
3. Allow an explicit prewarm owner to retain and mount `ExplorerCodeEditor` with a
   `null` path.
4. Separate visibility from startup eligibility. Attachment, frame, workbench, and
   bridge startup may run when `active || prewarmInlineCode`; file navigation,
   focus, presentation changes, user-facing recovery, and path-specific effects
   remain gated to an active surface and a non-null path.
5. Preserve the keyed Explorer/editor instance when the prewarm owner becomes the
   active preview or is pinned. Activation must update the path on the existing
   instance instead of allocating another attachment or iframe.
6. After pinning, replenish and warm the new bounded successor in the background.
7. Tear down or rebind prewarm ownership when the project, server, worker,
   worktree, account/security binding, or Explorer owner changes. Never reuse an
   attachment across a mismatched authorization boundary.

The existing pool size of two is the resource budget. This restores fast first and
post-pin file opens without returning to unbounded hidden workbenches for every
inactive tab.

### Required UI fix: keep the file tree mounted while pinning

`cantrip_app/src/components/app/shell-sidebar.tsx` currently includes
`pinSidebarFileMutation.isPending` in the whole-tree `fileTreeLoading` value.
`cantrip_app/src/components/app/project-sidebar-file-tree.tsx` replaces all rows
with a spinner whenever that value is true. This is the visible tree replay during
the otherwise-fast pin.

Remove pin pending from the whole-tree loading condition while valid tree data is
present. Keep the existing path-level `fileTreePinningPath` progress indicator and
keep prior directory data mounted while the replacement preview owner is created.
The directory hook already has placeholder-data continuity intended for this owner
handoff; replacing the whole tree defeats it.

### Recommended cold-start tail improvement

Move the extension bridge connection before awaited presentation/layout commands.
This is a narrow ordering change: establish the authoritative socket as soon as the
extension activates, then perform presentation setup. It reduces the unavoidable
cold path and does not weaken validation or readiness acknowledgements.

A separate follow-up may pass the already-authorized initial file through
OpenVSCode's supported initial-navigation payload so file loading overlaps workbench
boot. The renderer must not be allowed to inject an unvalidated payload, and the
existing post-ready command must not be removed until the initial navigation has an
authoritative acknowledgement. This optimization is useful but is not required to
fix normal sidebar latency once bounded prewarming is restored.

## Tests that must accompany the source fix

1. Mount the full sidebar prewarm composition with `active=false` and `path=null`.
   Assert that exactly the bounded owners create one attachment, iframe, and ready
   workbench each.
2. Activate a prewarmed owner with its first path. Assert that the Explorer,
   editor, session, attachment, and iframe identities do not change and exactly one
   file-open is sent.
3. Change the path in the same unpinned preview. Assert no attachment or frame is
   recreated.
4. Pin the preview, replenish the successor, and assert that the successor is ready
   before its first path selection.
5. Assert that ordinary inactive pinned/open Explorers that were never activated do
   not prewarm or connect.
6. Assert that the number of background workbenches never exceeds the sidebar pool
   budget and that ownership changes release obsolete instances.
7. Assert that project, worker, worktree, server, and account/security changes never
   reuse an incompatible prewarmed attachment.
8. Assert that pin/replenishment pending state does not unmount or replace existing
   file-tree rows and that the path-level pin indicator remains visible.
9. Retain coverage for popout handoff, editor recovery, terminal and Explorer
   ownership, and Tauri/browser transport behavior.
10. Add trace-level acceptance coverage: after background prewarm completes, the
    first and post-pin launches must begin with attachment and workbench readiness
    already true and must not perform session-route, transport, or frame creation
    during the click.

For a deterministic harness, a warmed first click should meet the existing warm
baseline rather than a multi-second cold threshold. A product-level target of less
than 250 ms after prewarm is reasonable; unit tests should assert lifecycle reuse
and event counts instead of flaky wall-clock timing.

## Explicitly ruled-out fixes

Do not add another retry loop, readiness poll, timeout increase, worker-online
guard, encryption check, confirmation screen, blank fallback, or automatic tab
recreation. The traces show those are not the cause and they would add latency or
hide the lifecycle error.

Do not make every retained or inactive editor operational. That would undo the
resource-control goal of PR #1517. Only the bounded sidebar preview pool needs a
background workbench.

Do not remove the authoritative file-open acknowledgement merely to make the UI
appear fast. Prewarm the real dependency, and only replace the post-ready RPC after
an initial-navigation path has equivalent validation and acknowledgement.

## Expected result

Once the bounded prewarm is ready, both the first sidebar file and the first file
after pinning should follow the already-measured warm path: update the existing
preview's path and open it in roughly 76–100 ms, with no new route, transport,
attachment, iframe, or workbench on the interaction path. Pinning remains under a
second and no longer causes the file tree to disappear and replay.

If a user clicks before initial background prewarming finishes, that click can only
wait for the remaining portion of the real workbench startup. Eliminating even that
first-install race would require starting the bounded pool earlier or a larger
shared-workbench architecture; it should not be disguised with more guards or
timeouts.
