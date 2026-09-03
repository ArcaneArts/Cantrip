# Project tab groups

Cantrip stores project navigation as ordered tab groups rather than a single
flat list. The durable model is shared by browser, Capacitor, and Tauri clients.
Interactive grouping and top-tab drag/drop are desktop/wide-layout controls;
compact layouts consume the same order through direct bottom-navigation
selection.

## Ownership model

- The server owns group identity, group order, membership, member order, and
  the stable anchor used for the sidebar title.
- Every project surface belongs to exactly one group. Linked Codex consoles are
  a presentation mode of their parent chat and are not independent members.
- Every layout carries a monotonically increasing revision. Reorder, split,
  and merge endpoints claim that revision inside the same database transaction.
  A stale client receives `409`, restores its optimistic snapshot, and refreshes
  the authoritative layout.
- Each app window locally remembers the active member of each group. Switching
  one window does not change another window's active member.
- Remote Desktop and other selected-only surfaces attach only while selected.
  Interactive and chat-console Terminal views are the exception: the client
  parks their Xterm/addon/WorkerLink ownership while inactive, subject to the
  12-view retention cap. Run terminals have their own lifecycle.

Migration `0037_freezing_captain_stacy.sql` backfills existing surfaces as ordered
singleton groups from their legacy positions. Linked consoles are excluded.
The legacy entity position columns remain readable for migration compatibility,
but they are no longer a navigation or mutation authority.

## Same-window dragging

On non-compact layouts, one workspace drag context covers projects, sidebar
groups, and top tabs.

- Sort top tabs inside their current group.
- Drag a singleton sidebar group into the visible top bar.
- Drag a top tab into the sidebar to create a new singleton group.
- Sort whole groups and projects in the sidebar.
- Reject cross-project membership, self-grouping, and attempts to merge a
  grouped sidebar row wholesale.

The client applies the same pure legality reducer before optimistic updates.
The server remains authoritative and atomically rejects stale revisions.

## Tauri pop-outs

Pop-out URLs identify a persistent group and initial active member:

```text
?cantrip-popout-group=<groupId>&project=<projectId>&active=<tabKey>
```

The deterministic `cantrip-group-<groupId>` Tauri label enforces one local
desktop owner per group. The main sidebar still lists detached groups and
focuses their owner instead of mounting a second terminal, browser, Code, or
Remote Desktop attachment. Closing a window does not mutate the server layout.

The explicit pop-out action opens the whole group in its deterministic window.
Tab dragging remains scoped to the current webview on every platform. Dropping
a tab outside its current window is cancelled: it does not create a pop-out,
move an existing pop-out, or dock into another Cantrip window. This keeps Tauri
behavior aligned with the wide browser layout while preserving ordinary group
pop-outs and same-window grouping operations. Capacitor and other compact
layouts do not render the top tab bar, so they select surfaces through the
mobile bottom navigation rather than exposing these drag gestures.

## Manual QA

Before a desktop release, exercise this matrix with `pnpm devtop`:

1. Group a Terminal and Explorer, rename both, reorder them, refresh, and
   verify membership and order survive.
2. Pop the group out, switch active members, and verify its main-sidebar row
   focuses the existing window.
3. Drag a top tab beyond the main or pop-out window edge. Confirm the drag is
   cancelled and no window is created, moved, or docked.
4. Attempt a cross-project drop and confirm it is rejected without moving or
   closing the source.
5. Close a pop-out normally, select its sidebar row, and confirm the same group
   reopens locally with no data loss.
6. Leave a Remote Desktop member inactive in a group and confirm it does not
   connect until selected.

For non-desktop regression coverage, run `pnpm --filter @cantrip/app build` and
the Capacitor sync/build path appropriate to the target. Wide browser layouts
must preserve same-window grouping without a Tauri runtime; compact layouts
must preserve durable membership/order while selecting surfaces directly.
