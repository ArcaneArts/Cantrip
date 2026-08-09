# Project tab groups

Cantrip stores project navigation as ordered tab groups rather than a single
flat list. The model is shared by the browser, Capacitor, and Tauri clients;
only cross-window coordination is desktop-specific.

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
- Worker-backed runtimes remain attached only while their surface is selected.
  An inactive Remote Desktop tab, for example, does not connect merely because
  another member of its group is visible.

Migration `0037_project_tab_groups.sql` backfills existing surfaces as ordered
singleton groups from their legacy positions. Linked consoles are excluded.
The legacy entity position columns remain readable for migration compatibility,
but they are no longer a navigation or mutation authority.

## Same-window dragging

One workspace drag context covers projects, sidebar groups, and top tabs.

- Sort top tabs inside their current group.
- Drag a singleton sidebar group into the visible top bar.
- Drag a top tab into the sidebar to create a new singleton group.
- Sort whole groups and projects in the sidebar.
- Reject cross-project membership, self-grouping, and attempts to merge a
  grouped sidebar row wholesale.

The client applies the same pure legality reducer before optimistic updates.
The server remains authoritative and atomically rejects stale revisions.

## Tauri pop-outs and cross-window dragging

Pop-out URLs identify a persistent group and initial active member:

```text
?cantrip-popout-group=<groupId>&project=<projectId>&active=<tabKey>
```

The deterministic `cantrip-group-<groupId>` Tauri label enforces one local
desktop owner per group. The main sidebar still lists detached groups and
focuses their owner instead of mounting a second terminal, browser, Code, or
Remote Desktop attachment. Closing a window does not mutate the server layout.

Tauri's `WindowCoordinator` registers each visible top bar in physical screen
coordinates. It converts DOM logical pixels using the current window scale
factor and refreshes registrations on window movement, resizing, scale changes,
horizontal scrolling, and tab DOM changes. This supports negative monitor
coordinates and mixed-DPI layouts without an operating-system-specific hook.

For a grouped tab, a small non-focusable native preview follows the pointer.
Releasing it above another registered top bar performs the existing atomic
membership move. Releasing elsewhere first splits the member on the server and
then opens its authoritative new group at the release point. A singleton
pop-out uses Tauri's native `startDragging` path to move the existing window.
Docking that singleton closes its source only after the server move succeeds.
Mutation failure leaves the source group and window intact.

Web and Capacitor bundles never invoke the coordinator. Their top bars use the
same React components and server layout API, but a drag cannot cross an OS
window boundary.

## Manual QA

Before a desktop release, exercise this matrix with `pnpm devtop`:

1. Group a Terminal and Explorer, rename both, reorder them, refresh, and
   verify membership and order survive.
2. Pop the group out, switch active members, and verify its main-sidebar row
   focuses the existing window.
3. Detach one member from the multi-tab pop-out. Confirm both windows remain
   and the detached window appears near the pointer.
4. Drag a singleton pop-out by its tab. Confirm the existing window moves
   without creating another group.
5. Dock that singleton into another pop-out and into the main window. Confirm
   the source closes only after the destination updates.
6. Attempt a cross-project drop and confirm it is rejected without moving or
   closing the source.
7. Repeat a detach/dock across monitors with different scale factors and with a
   monitor positioned left of the primary display.
8. Close a pop-out normally, select its sidebar row, and confirm the same group
   reopens locally with no data loss.
9. Leave a Remote Desktop member inactive in a group and confirm it does not
   connect until selected.

For non-desktop regression coverage, run `pnpm --filter @cantrip/app build` and
the Capacitor sync/build path appropriate to the target. Same-window grouping
must work without a Tauri runtime, and native coordinator functions must remain
behind the desktop runtime gate.
