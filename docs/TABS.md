# Tabs, panes, and workspace layout

Status: implemented through Milestone 7.

Cantrip is moving from a kind-dependent tab-group presentation to a unified
workspace model. Every open surface should behave like a tab, every tab should
have exactly one placement, and the pane containing that tab should determine
where and how it is rendered.

This document replaces the previous tab-group design. It preserves the
important durability, revision, and ownership guarantees of the existing
implementation while defining the target model for mixed tabs, docked panes,
split views, singleton project tools, and detached windows.

## Why the model is changing

The current model persists ordered groups and members, but the client decides
their visual lane from surface kind:

- Explorer file surfaces appear in the top file bar.
- Agents, Terminals, Browsers, Git views, and other project surfaces appear in
  the project sidebar.
- Dragging is constrained to the inferred lane.
- Overview, Tasks, History, Issues, PRs, Actions, and Graph also exist as a
  separate fixed navigation system.

This produces several problems:

- Selecting a non-file surface can hide or replace the user's open-file tabs.
- A project with many agents consumes most of the sidebar.
- A surface cannot be moved naturally between the center, right, and bottom.
- The fixed project tools do not participate in the same tab lifecycle.
- The presentation model cannot grow cleanly into resizable docks or split
  panes.
- History and Issues can appear both as fixed project sections and as created
  project-view records.

The replacement design makes placement explicit and treats surface kind as a
default-placement hint rather than a permanent visual restriction.

## Design goals

1. Keep file tabs visible and stable when another surface is selected.
2. Give every actual tab exactly one pane placement.
3. Allow tabs to move between center, right, bottom, split, and detached panes.
4. Keep surface resources separate from their open tab placements.
5. Make built-in project tools behave like tabs without creating disposable
   database entities or permanently cluttering the interface.
6. Preserve server-authoritative ordering and revision conflict handling.
7. Remember dock size and full-view intent without persisting unusable pixel
   geometry.
8. Support future center-pane splitting without redesigning the right and
   bottom docks.
9. Let agent-first, IDE-first, and hybrid workflows share one model.
10. Preserve compact and mobile navigation without forcing desktop chrome onto
    narrow screens.

## Non-goals

- Recreating VS Code's complete editor-group system in the first milestone.
- Allowing one tab view to be mounted in two panes simultaneously.
- Treating a launcher icon as a second placement of its surface.
- Making every surface type open in every region before its rendering and
  lifecycle behavior is ready.
- Synchronizing literal window coordinates or pixel dimensions between
  devices.

## Vocabulary

### Surface definition

A surface definition describes something Cantrip knows how to display. It
declares:

- a stable definition ID;
- project, worktree, account, or global scope;
- singleton or multi-instance cardinality;
- capability requirements;
- a suggested first-open placement;
- whether the underlying resource can be deleted;
- supported presentation constraints; and
- its icon, label, category, and launcher behavior.

Definitions do not imply that a tab is currently open.

### Surface resource

A resource is the durable object being viewed, such as an Agent chat,
Terminal, Browser, file, Remote Desktop session, or project-scoped built-in.
Closing a view does not necessarily delete its resource.

### Surface view

A surface view is the navigable tab identity for a resource. Initially,
Cantrip will enforce one view per resource. Keeping resource identity separate
from view identity leaves room for an explicit future "Duplicate View" action
without weakening the initial one-location guarantee.

### Tab placement

A placement assigns one surface view to one pane at one ordered position. A
surface view has at most one placement. Moving a tab atomically removes its old
placement and inserts its new placement.

### Pane

A pane owns:

- an ordered list of tab placements;
- one locally active tab;
- center tab-strip or dock-rail presentation;
- mounting and parking behavior for inactive surfaces; and
- an owning workspace region or split node.

Center panes present their placements in a tab strip at the top of the pane.
Right and bottom dock panes do not render a second tab strip: their rail is the
placement selector, creation control, and drag target.

### Launcher

A launcher is a shortcut in the project navigator, right rail, bottom rail,
surface catalog, or command palette. It may focus an existing tab or open a new
one. A launcher is not a tab placement and can appear in more than one
navigation surface without violating the one-placement invariant.

## Core invariants

- A surface view has zero or one tab placement.
- A tab placement belongs to exactly one pane.
- A pane belongs to one workspace region, split node, or detached window.
- Moving a placement is revision-checked and atomic.
- Opening an already-open singleton focuses its existing placement.
- Startup and project-navigator surface launches join the focused center pane,
  falling back to the first center pane. Opening Overview or Tasks must not
  synthesize a new center split.
- Closing a view removes its placement but does not delete its resource.
- Deleting a resource is a distinct, explicitly destructive action.
- Built-in singleton surfaces cannot be deleted.
- Launcher visibility and tab placement are independent.
- No tab automatically moves after the user has explicitly placed it.

## Workspace topology

The desktop workspace has a stable outer frame:

```text
Workspace frame
├── project navigator / launcher sidebar
└── content frame
    ├── upper workspace
    │   ├── center root
    │   └── right dock
    ├── bottom dock, spanning the full content width
    ├── right launcher rail
    └── bottom launcher rail
```

The initial center root is one pane. Later it may be a recursive horizontal or
vertical split tree:

```text
Center root = Pane | Split(direction, first, second, fraction)
```

The right and bottom docks remain stable outer regions around that center root.
This gives predictable behavior even after arbitrary center splits are added.

### Center only

With both docks closed, the center root fills the content frame.

### Right dock open

Opening a right-rail tab horizontally splits the upper workspace. The center
root remains on the left and the right-dock pane appears on the right.

### Bottom dock open

Opening a bottom-rail tab vertically splits the content frame. The center root
remains above and the bottom-dock pane spans the full content width below it.

### Right and bottom docks open

When both are open:

- the center root occupies the upper-left region;
- the right dock occupies the upper-right region; and
- the bottom dock spans the complete lower region beneath both.

The bottom dock does not stop at the center/right divider. The right-dock
fraction is calculated within the upper workspace, while the bottom fraction
is calculated against the complete content-frame height.

### Left-side behavior

The project navigator is an inventory and launcher surface, not the owner of
open tab placements. A future left dock may mirror the right-dock mechanics,
but it should remain distinct from the persistent project/resource inventory.

## Pane and dock behavior

Each dock contains one pane in the first implementation. Multiple tabs may
share that pane, but only one is active at a time.

- The dock rail is the pane's tab selector; the pane body has no tab strip.
- The rail owns the add-surface control and is the drop target for tabs moved
  from center panes.
- Open rail tabs follow the pane's persisted member order. Dragging one along
  the rail smoothly displaces its neighbors and commits the reordered member
  list when dropped.
- An open rail tab has the same close and destructive resource actions as a
  center tab. Its context menu closes the view or, when the surface definition
  permits it, confirms deletion or archival of the underlying resource.
- Static rail launchers do not participate in sorting or deletion. Once a
  launcher opens a placement in that dock, the placement becomes the sortable,
  actionable rail tab and the duplicate launcher is hidden there.
- Clicking a closed rail launcher opens or focuses its tab in that dock.
- Clicking an already-open launcher focuses the tab and reveals its dock.
- An optional repeated click may collapse the dock without closing the tab,
  provided the collapsed/open distinction remains clear.
- Closing the tab removes its placement. The resource remains available from
  the navigator or surface catalog.
- Dragging a tab into a dock joins that dock pane.
- Dragging a tab onto a center-pane tab strip joins that center pane.
- Dragging onto a center-pane edge creates a future split pane.
- Dragging an entire pane moves the pane only after pane-level movement is
  implemented explicitly.

Surface kinds should not be permanently locked to regions. Suggested defaults
are:

- files and Agents: center;
- Terminals and Problems: bottom;
- Browser, History, Graph, and inspection tools: center or right;
- project Overview and Tasks: center; and
- Explorer/outline utilities: left when a left dock exists, otherwise center.

These defaults apply only when a user has no remembered choice.

## Placement resolution

Opening or focusing a surface resolves its destination in this order:

1. If the surface view is already open, focus its existing pane and tab.
2. If the user supplied an explicit drop, split, dock, or "Open to Side"
   target, use that target.
3. If the action was invoked inside a pane, open beside the invoking tab when
   supported.
4. Use the view's remembered placement or region preference.
5. Use the surface definition's suggested first-open placement.
6. Fall back to the primary center pane.

Capability or size constraints may affect effective presentation, but they
must not silently rewrite the persisted user choice. If a target cannot render
temporarily, show an unavailable placeholder or a local responsive fallback
rather than deleting or moving the placement.

## Resizing, snapping, and full view

Right and bottom dock presentation is modeled with explicit states:

```text
Dock presentation = closed | split | full
```

For each relevant tab placement, remember:

```text
preferredMode: closed | split | full
splitFraction: normalized fraction used in split mode
restoreFraction: last useful non-edge fraction
```

"Full" must not be represented as a near-100% split. It is a distinct state
that renders only the active workspace pane. This prevents unusable slivers of
the hidden panes.

### Split fractions

- Right width is stored as a fraction of the upper workspace width.
- Bottom height is stored as a fraction of the full content-frame height.
- Fractions are clamped against local minimum useful pixel sizes.
- A responsive clamp changes only effective local geometry; it does not
  overwrite the saved preference.
- Literal pixel dimensions are not synchronized between devices.

### Snap behavior

- Dragging the right divider almost completely left expands the right dock.
- Dragging the bottom divider almost completely up expands the bottom dock.
- Crossing the configured high threshold, initially around 94%, enters full
  mode.
- Dragging a dock almost completely closed collapses it to its launcher rail
  while retaining the last useful split fraction.
- Snap thresholds should use hysteresis so the layout does not oscillate near
  an edge.

### Restoring from full view

Full view renders no residual center, right, or bottom pane sliver. A resize
hit target may remain as an overlay on the workspace edge; it is an input
affordance, not a partially rendered pane.

Dragging that handle away from the edge returns to split mode and begins from
the remembered restore fraction. An explicit "Restore Split" command and
double-click divider action should provide keyboard and pointer alternatives.

Closing a full-view dock remembers that tab's full-view preference. Reopening
or focusing it returns to full view until the user resizes it back to split.

### Multiple tabs in one dock

Dock geometry is live pane state, while each tab placement remembers its last
preferred mode and fraction for that dock. Switching tabs applies the newly
active tab's preference. Resizing updates only the active tab's remembered
preference.

This allows a Git History tab to prefer a 34% right split while a Browser tab
in the same dock prefers full view. The transition should be immediate or use
a short reduced-motion-aware layout animation.

### Interaction between full-view tabs

When another rail tab is selected while one dock is full:

- if the selected tab also prefers full view, it replaces the current full
  view;
- if the selected tab prefers split view, the current full view restores to
  its remembered split fraction and the requested split becomes visible; and
- inactive tabs retain their saved preferences.

Full view applies to workspace panes. Persistent application chrome and
launcher rails remain visible unless a separate Zen/Focus mode is active.

## Built-in singleton surfaces

The following project tools become project-scoped singleton surface
definitions:

- `project.overview`
- `project.tasks`
- `git.history`
- `git.graph`
- `github.issues`
- `github.pull-requests`
- `github.actions`

These surfaces are always conceptually available when project capabilities
allow them. They do not need a newly created domain record each time they are
opened.

- Opening one creates or focuses a deterministic layout reference.
- Closing it removes the placement only.
- It has no Delete action.
- It may be pinned or unpinned as a launcher.
- Worktree selection, filters, and other view state are stored against its
  deterministic identity.
- Capability loss preserves the placement and shows an unavailable state
  instead of silently deleting it.

History, Issues, PRs, Actions, and Graph may be grouped under a collapsible
"Project tools" launcher category. Availability does not require all seven to
occupy permanent sidebar rows or open tabs.

History and Issues should stop being independently creatable `ProjectView`
records after migration. Remote Desktop remains a multi-instance project view.

## Agent and resource inventory

An Agent chat's existence and its open tab are separate states.

The project navigator may list resources under compact sections such as:

- Pinned
- Running
- Needs attention
- Recent
- Archived

Opening a resource creates or focuses its one tab placement. Closing that tab
does not delete or archive the conversation. This prevents the sidebar from
becoming an unbounded list of every open view while keeping durable resources
discoverable.

The same separation applies to Terminals, Browsers, and other deletable or
archivable resources. Context menus must clearly distinguish:

- Close View
- Move to Region
- Pin/Unpin Launcher
- Rename Resource
- Archive Resource
- Delete Resource

Built-in singleton surfaces expose only the applicable non-destructive subset.

## Conceptual persisted model

The exact schema may evolve during implementation, but the model should be
equivalent to:

```text
SurfaceDefinition {
  id
  scope
  cardinality
  suggestedPlacement
  capabilityRequirements
  deletable
}

SurfaceView {
  id
  surfaceRef
  projectId
}

TabPlacement {
  viewId
  paneId
  position
  preferredMode
  splitFraction
  restoreFraction
}

Pane {
  id
  region
  orderedViewIds
}

WorkspaceLayout {
  projectId
  revision
  centerRoot
  rightDockPaneId
  bottomDockPaneId
}

LocalDesktopOwnership {
  paneId
  phase: detaching | detached
  explorerId?
}

LayoutNode = PaneNode | SplitNode(direction, fraction, first, second)
```

The existing tab group can evolve into a Pane without discarding stable IDs or
member ordering. A generalized surface reference must support both
entity-backed resources and deterministic built-ins.

## Persistence boundaries

### Server-authoritative project state

The server continues to own:

- surface view identity;
- pane identity;
- tab placement and order;
- pane region and split-tree structure;
- layout revision; and
- atomic move, split, merge, and reorder mutations.

Mutations claim the layout revision in the same transaction. A stale client
receives `409`, restores its optimistic snapshot, and reloads the authoritative
layout.

### Client and window state

Each app window locally remembers:

- the active tab in each pane;
- focus history;
- temporary responsive clamps;
- hover/reveal state for collapsed rails;
- effective pixel geometry derived from normalized fractions;
- pane-to-pop-out ownership claims and discovery state; and
- native pop-out window position, size, and focus.

Normalized user preferences may sync with tab placement, while platform- or
device-specific geometry remains local. The synced `workspaceLayoutProfile`
setting is a prospective first-open policy, not a saved layout: changing it
never moves a placed tab, changes a pane revision, or rewrites dock or split
geometry.

The available profiles are:

- **Agent:** new surfaces prefer the center so the workspace stays focused on
  one agent-first canvas.
- **Hybrid:** new surfaces use the registry defaults (Agents and files in the
  center, Terminals at the bottom, and inspection tools on the right).
- **IDE:** registry defaults remain in force except new Agents prefer the
  right dock beside the editor.

An explicit pane or region always wins. Existing singleton and resource views
always focus their current placement, regardless of the active profile.

## Detached windows and ownership

A pop-out owns a pane, not a duplicate set of surfaces. The pane keeps its
server layout identity and region while a device-local window claims its live
rendering ownership.

- One local desktop window owns a pane at a time.
- The main window keeps a launcher/placeholder for a detached pane.
- Selecting that placeholder focuses the owning window.
- Closing a pop-out releases local ownership without deleting its tabs.
- The main window claims before opening and rolls back only that pane if native
  window creation fails.
- Startup discovery checks every loaded pane and understands both the
  canonical `cantrip-pane-*` label and the compatibility `cantrip-group-*`
  label before allowing a live surface to mount.
- Multiple detached panes are observed and released independently.
- Dragging between windows remains unsupported until there is an explicit,
  atomic cross-window handoff protocol.
- Terminals, Browsers, Code, Remote Desktop, and similar live surfaces must
  never mount concurrently in two windows for the same view.

Compatibility readers remain for the legacy group query parameter and window
label, but all maintained ownership and rendering decisions are pane-based.
The migration converts any legacy durable `detached` region into a center pane,
rebuilds that project's center tree, and preserves every view. New pop-outs are
opened only through the pane pop-out action; `detached` is no longer advertised
or accepted as a generic placement region.

## Compact and mobile behavior

Compact clients consume the same surface definitions, placements, and order
but may not render desktop docks or split handles.

- Mobile navigation exposes at most five active and recent surfaces after
  collapsing Explorer file views to one destination per worktree.
- Selecting a right- or bottom-placed tab may present it full-screen locally.
- That responsive presentation must not rewrite its desktop region or saved
  split fraction.
- Built-in singleton surfaces remain available through the same catalog.
- Destructive resource actions remain distinct from closing a local view.

## Migration from tab groups

Migration should be incremental and preserve current layouts:

1. Treat every existing tab group as a Pane in the client model while retaining
   its current server ID and ordered members.
2. Introduce generalized surface references that can address entity-backed and
   built-in surfaces.
3. Add deterministic singleton references for Overview, Tasks, History, Graph,
   Issues, PRs, and Actions.
4. Dedupe existing History and Issues project-view records into their
   singleton references without deleting unrelated Remote Desktop records.
5. Add explicit pane region and dock placement to the persisted layout.
6. Map current file-tab groups to the center and current non-file groups to the
   navigator/center defaults without changing their order.
7. Replace `file-tabs` versus `sidebar` drag legality with pane and pane-edge
   targets.
8. Add right and bottom dock panes behind a feature flag or schema capability.
9. Add split-tree nodes after the stable dock frame is shipped.
10. Remove legacy entity-position navigation authority only after all clients
    consume the pane layout.

Migration code must be idempotent, revision-aware, and covered by protocol and
server tests. No migration may silently delete a user's resource merely
because its view placement is deduplicated.

## Implementation milestones

### Milestone 1: surface registry and lifecycle language

- Introduce surface definitions and deterministic built-in identities.
- Split Close View from Delete/Archive Resource in commands and menus.
- Preserve current rendering while establishing open-or-focus behavior.
- Add tests for singleton and multi-instance cardinality.

### Milestone 2: built-in project tools

- Move Overview, Tasks, History, Graph, Issues, PRs, and Actions into the
  registry.
- Replace the fixed secondary navigation with launchers that open or focus
  singleton tabs.
- Stop creating duplicate History and Issues project-view resources.
- Add capability-aware unavailable states and launcher pinning.

### Milestone 3: panes and unified center tab strips

- Evolve tab groups into explicit panes.
- Render one mixed surface tab strip per center pane.
- Keep file tabs visible when Agents, Terminals, Browsers, or built-ins are
  active in the same pane.
- Persist region and allow cross-kind moves.
- Replace lane-locked drag/drop legality.

### Milestone 4: right and bottom docks

- Add the stable content-frame topology.
- Use each dock rail as its pane selector, add-surface control, and tab drop
  target without rendering an internal dock tab strip.
- Open right-rail tabs into the upper-right split.
- Open bottom-rail tabs across the full lower width.
- Support both docks simultaneously.
- Add accessible resize controls and pointer dividers.

### Milestone 5: size memory and full view

- Persist normalized split and restore fractions.
- Add explicit closed, split, and full modes.
- Implement collapse and full-view snap thresholds with hysteresis.
- Preserve each active tab's dock preference.
- Add overlay restore handles and keyboard restore commands.

### Milestone 6: center split tree

- Add horizontal and vertical center split nodes.
- Support pane-edge drops and resize fractions.
- Preserve active-tab state independently per pane and window.
- Define close/merge behavior for the final tab in a split pane.

### Milestone 7: detached panes and layout profiles

- Migrated pop-out routing, labels, discovery, observation, and ownership from
  one selected group to a pane-keyed local claim map.
- Kept cross-window drag/handoff unavailable until an atomic protocol exists;
  direct `detached` API placement is rejected rather than becoming invisible.
- Added synced Agent, Hybrid, and IDE first-open profiles with Hybrid as the
  compatibility default.
- Kept responsive clamps, native window geometry, active pane state, and
  effective pixel sizes device- and window-local.

Each milestone should be independently mergeable, migrate existing state
safely, and include a compatibility period when protocol or server schema
changes are involved.

## Validation and manual QA

At minimum, validate the following desktop matrix:

1. Open only the center, only the right dock, only the bottom dock, and both
   docks. Verify the bottom dock spans the complete content width.
2. Resize right and bottom independently, reload, and confirm normalized sizes
   restore within local minimum constraints.
3. Drag a dock past the high threshold and confirm full mode renders no sliver
   of another workspace pane.
4. Close and reopen a full-view tab and confirm it returns to full view.
5. Restore from full view with pointer, keyboard command, and divider
   double-click.
6. Switch between two tabs in one dock with different remembered fractions and
   modes.
7. Open center, right, and bottom tabs on a narrower viewport. Confirm local
   fallback does not overwrite the saved desktop layout.
8. Move a tab center -> right -> bottom -> center and verify it has one
   placement after each revisioned mutation.
9. Attempt a stale concurrent move and confirm the optimistic snapshot rolls
   back on `409`.
10. Close an Agent view and confirm the chat resource remains available.
11. Delete an eligible resource and confirm the destructive action is distinct
    and explicit.
12. Open every built-in singleton twice and confirm the second action focuses
    the existing placement rather than creating a duplicate.
13. Remove GitHub capability temporarily and confirm existing Issues/PRs/
    Actions placements show unavailable state without being deleted.
14. Pop out a pane and verify the main window focuses the one local owner
    instead of mounting duplicate live surfaces.
15. Exercise compact/mobile navigation and confirm it does not rewrite desktop
    dock or split placement.

Repository validation should remain proportional to each milestone. Protocol,
server, and app tests are required when persisted layout or transported surface
state changes. `git diff --check` is the minimum for documentation-only changes.
