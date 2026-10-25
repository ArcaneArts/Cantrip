# Tabs, panes, windows, and device workspaces

The identity-based workspace path is integrated into the application. This
document replaces the retired project-wide placement/local-popout-claim design.
Final verification and cleanup are still **incomplete**: the chronological
[implementation record](WORKSPACE_OWNERSHIP.md) records merged cycles, actual
verification, failures, and outstanding work.

## Identities and authority

```text
Device workspace (installation + account + server + project)
└── Window (attachment generation fences its live renderer)
    └── Pane (region, ordered tabs, active tab)
        └── Tab (independent view identity)
            └── Resource or document reference
```

Resources exist independently of their open views. Every placed tab belongs to
exactly one pane, and every pane to exactly one window in one workspace. A move
preserves tab identity; a whole-pane move also preserves pane identity. A
launcher or resource catalog entry is not another placement.

The nested layout is authoritative. Each window owns its center split tree,
focused pane, pane history, and tab history. Regions belong within windows, not
instead of windows. The protocol rejects invalid ownership and stale attachment
generations. Knowing an ID never substitutes for server authorization.

Different installations share resource availability, not placement or selection.
Resizing into mobile presentation does not change workspace identity. Account,
server, project, and renderer changes fence retained handlers and requests.

Source: [schema](../packages/protocol/src/workspace-ownership.ts),
[device identity](../cantrip_app/src/lib/workspace-device-identity.ts),
[bootstrap](../cantrip_app/src/lib/workspace-bootstrap.ts).

## Commands, reconciliation, and loading

The workspace controller routes open, close, select, reorder, pin, layout, and
transfer operations through revisioned commands. Stable operation IDs and server
receipts make retries idempotent. Scope validation and mutations are transactional.
Native creation and document preparation happen in lifecycle adapters, not the
pure layout transition.

The client projects pending commands over authoritative state. It must not
restore a whole old cache snapshot on conflict. Already-sent operation bytes
remain stable until a receipt or explicit rejection resolves their outcome.
A refresh failure is distinct from command failure and does not prove owner death.

Resource loading is not tab closure. Presentation retains owned identities while
labels or resources load, showing loading, unavailable, or error content without
deleting placements. Presentation retries must not create another view.

Source: [client queue](../cantrip_app/src/lib/workspace-command-client.ts),
[transitions](../packages/protocol/src/workspace-command-apply.ts),
[server persistence](../cantrip_server/src/db/workspace-layouts.ts),
[presentation](../cantrip_app/src/lib/workspace-presentation-store.ts).

## Opening, selecting, and closing

- Opening an existing resource normally focuses its existing tab in this
  workspace, including focusing another local owner window. Explicit duplicate
  views are not required.
- Explicit pane/region targets apply to new placement. Surface definitions and
  first-open profiles supply defaults, not authority to move existing tabs.
- Closing an inactive tab preserves its pane's active tab.
- Closing the active tab selects its right neighbor, otherwise its left.
- Closing the last tab removes that pane and its split-tree leaf. Focus uses
  surviving pane history in the same window, then a center pane, then another
  surviving pane. An empty window has no selected tab.
- Recent-tab navigation records activation separately from order and pane
  history. Reordering does not manufacture recent activity.
- Close View and middle-click close only the view. They do not archive an Agent
  chat or stop its execution. Archive/Delete Resource are separate actions;
  surface-specific close preparation still protects dirty documents.

Overview is a project page, not a surface tab. Back to Project returns to the
workspace. Tasks remains a built-in surface. Resource catalogs and launchers
must not render a second placement of an owned tab.

## Panes and presentation

Center panes have mixed-surface tab strips and a recursive horizontal/vertical
split tree. Right and bottom rails select their pane's tabs without a second
strip inside the pane. The bottom dock spans the content width below center and
right regions.

Dock presentation distinguishes closed, split, and full modes. Normalized split
and restore fractions represent saved intent; local minimum-size clamps and
responsive full-screen presentation must not overwrite that intent. Collapsing
a dock does not close its tabs. Display preferences, colors, hover states, and
native pixel geometry are presentation, not alternative ownership records.

## First-class files

Explorer navigation and file views are separate. A file tab references an explicit
document identity with account/server/worker/project/worktree/path boundaries.
Different files in one worktree remain different tabs.

The shared owned-file opener resolves the document and opens/focuses its tab.
Explorer actions, file links, and Code's file browser must use this route rather
than repurpose an arbitrary Explorer entity or retain a new inline view. Native
file-window requests use the owned tab and the same transfer lifecycle.

Preview is tab state. Pinning preserves identity without entity promotion or
successor handoff. Dirty previews cannot be silently replaced. Explicit view/edit
mode is view state; editable code defaults to Edit on mobile too. Protected
document sessions own buffers, save state, and recovery. Moving must not require
saving first.

Code still accepts an old transferred inline selected path for legacy restoration.
Legacy native Explorer-file links, with or without a broker launch token, now
enter authenticated startup and import into the actual native host's workspace.
The importer checkpoints selected and inactive drafts through encrypted recovery
before atomically creating document tabs. It translates the route in place, then
uses ordinary renderer attachment and return-to-main behavior. A retained import
record prevents an old link from resurrecting a window that has already closed.
Conflicting owned views or divergent recovered drafts are retained and reported,
not overwritten. An import failure offers explicit retry. New file opens must
still use the shared owned-file opener; compatibility is not an alternative
authoritative placement path.

Source: [opener](../cantrip_app/src/lib/open-owned-file.ts),
[owned native file window](../cantrip_app/src/components/app/use-owned-file-window.ts),
[legacy import](../cantrip_app/src/lib/import-legacy-file-window.ts).

## Detach, return, and recovery

Move Tab to New Window moves only the addressed tab into a destination pane.
Move Pane to New Window moves every tab, including inactive views. The committed
source has neither disabled duplicates nor the vacated pane's divider or slot.
The source remains recoverable during preparation.

1. Record source placement and allocate transfer/destination identities.
2. Prepare every affected adapter, including inactive dirty editors.
3. Create the destination and receive actual application readiness.
4. Transfer protected state and receive its restoration acknowledgement.
5. Retire prepared source renderers and commit ownership once.
6. Activate the destination. Failed preparation preserves source state; uncertain
   outcomes require reconciliation, not an invented new owner.

Transfer protection binds server, owner, project, workspace, transfer, both
windows and generations, and message purpose. Editor, terminal, browser, chat,
and remote-desktop state have adapters. A handoff must not create concurrent
interactive renderers of the transferred view.

Closing a popout tab closes only that tab. Closing its last tab closes the empty
native window. Closing the native window instead returns its surviving panes
before destruction. Failed return keeps the window/state recoverable. Closed
tabs never return.

### Deterministic return placement

For a single-tab detach, return inserts survivors at the saved tab index, clamped
to current length, when the original pane exists. Otherwise it inserts the
returning pane at the saved pane index, using the original region when applicable,
or center when no matching original placement exists.

For a whole center pane, its saved split tree is restored only when removing that
pane from the saved tree exactly matches the current destination tree. Otherwise
the current center tree becomes the first child of a horizontal 50/50 split and
the returned pane the second; an empty center becomes that pane directly. This
does not undo intervening layout edits. Surviving order and active selection are
preserved; return focuses the returned view.

Application quit is distinct from normal window return and must not start
return/reopen loops. Reloads/reconnects use generations and recorded transfer
state. A heartbeat timeout, HTTP failure, or observer error alone does not prove
a renderer died. Native validation has exercised normal quit, failed quit
checkpoint, abrupt process termination, WebKit renderer death, and interrupted
destination startup. This does not claim exhaustive concurrent interleavings.

Source: [source coordinator](../cantrip_app/src/lib/workspace-transfer-source.ts),
[destination](../cantrip_app/src/lib/workspace-transfer-destination.ts),
[state batch](../cantrip_app/src/components/app/workspace-view-transfer-batch.ts),
[encryption](../cantrip_app/src/lib/workspace-transfer-encryption.ts),
[return-before-close](../cantrip_app/src/components/app/use-workspace-window-return.ts).

## Mobile

Mobile uses its own device workspace and the same command semantics. Opening a
view must not rearrange another installation's desktop docks. A narrow viewport
in an existing installation changes presentation only.

Navigation retains every window-owned view, including different files in one
worktree. The bottom bar scrolls and the Project tabs picker exposes all Open
views. Recent uses recorded activation history, up to five available recent
views, not the tail of layout order. Selection does not change membership.
Close, preview, pin, and explicit mode selection have desktop semantics.

Source: [navigation](../cantrip_app/src/components/app/mobile-project-navigation.ts).

## Migration and compatibility

Bootstrap obtains installation-scoped identity and connects to the authoritative
workspace. Legacy project layout is a one-time seed, not an ongoing competing
placement writer. Existing workspace state wins over repeated seeding.

The seed preserves compatible pane IDs, member order, protected metadata,
selection observations, and center topology. Legacy references receive
deterministic scoped tab identities. Observed detached panes are imported into
their actual native windows and removed from the main center tree. A missing
response must not be interpreted as evidence of new ownership.

Explorer-file migration is a separate explicit document rebind; restored dirty
state must remain protected until transition completes. Compatibility readers
for old links, labels, and file-window launches must not become alternate layout
writers. Removing remaining readers requires safe persisted-session restoration.

Source: [seed](../packages/protocol/src/workspace-ownership-seed.ts),
[bootstrap](../cantrip_app/src/lib/workspace-bootstrap.ts),
[API](../cantrip_server/src/app/routes/workspace-layouts.ts).

## Verification and remaining acceptance

The [implementation record](WORKSPACE_OWNERSHIP.md) records evidence per cycle
and a consolidated acceptance audit. Native two-window tests have exercised
active and inactive dirty editors, terminal shell state, browser document state,
chat drafts, and remote input. Representative simultaneous mobile/desktop tests
cover isolated placement, overflow, preview/pin, explicit modes, and file entry
through Explorer, chat, related files, command search, History, and graph.
Physical iOS/Android execution is not claimed. Compatibility readers remain for
persisted routes; the obsolete local-claim pane/tab popout producers are removed.

Final work includes reconciling broad-check failures, completing the remaining
requirement audit, and preserving evidence before cleaning retained QA lanes.

Keep regression coverage for single-tab versus whole-pane detach; tab close
versus window return; removed/rearranged original panes; inactive dirty files;
startup/restore/return failures; reload/crash/quit/restart; simultaneous device
workspaces; revision conflicts and delayed replies; late resource catalogs;
every file-opening route; preview/pin/mode preservation; authorization; and
deterministic keyboard/focus behavior. Mocked transitions alone cannot establish
native WebView or mobile acceptance.

The latest broad `pnpm check` did **not** pass. Worker filesystem-notification
and image-adaptation tests failed under the full run; both files passed unchanged
in isolation. Full-suite reruns are recorded separately from passing focused
tests and CI. Formatting also reports existing source/document files and generated
Rust build artifacts. Do not replace those results with a blanket green claim
or weaken checks.
Documentation-only edits require link inspection and `git diff --check`;
protocol, server, app, and native changes require relevant tests and actual
interaction validation.
