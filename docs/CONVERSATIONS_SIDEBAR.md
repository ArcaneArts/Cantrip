# Conversations sidebar implementation plan

Status: **implementation in progress; the complete feature is not yet delivered**.

Prepared on 2026-10-30 against `64bbf0148` on `main`. In the current workspace
ownership model, rail middle-click already closes a view without archiving its
Agent resource. Preserve that
behavior and complete the resource catalog and tab-free conversation experience
described here.

Related contracts: [tabs and workspace ownership](TABS.md),
[workspace implementation record](WORKSPACE_OWNERSHIP.md),
[standalone Chat](CHAT.md), [Tasks](TASKS.md), and [encryption](ENCRYPTION.md).
Implementation milestones follow the [manual change protocol](agents/MANUAL_CHANGE_PROTOCOL.md).

## Implementation record

### Catalog cycle (merged)

The `codex/conversations-catalog` worktree adds bounded Agent catalog pages,
server-issued usage tracking with retry receipts and per-client sequencing,
explicit empty-chat archival, and resource-only creation/restoration. Creation
retries retain the original encrypted request identity. Existing legacy deletion
behavior remains available for its existing callers.

Validation: all 37 focused server tests across archive, migration, composer
drafts, workspace layouts, standalone lifecycle, and storage accounting passed.
All 961 protocol tests passed. Server typechecking, changed-file formatting,
the content-boundary audit, Rust workspace query-manifest validation and
workspace contract/model tests, and `git diff --check` passed. Concurrent
creation requests produce one Agent catalog entry.

The broader `pnpm check` found the new tables' missing accounting classifications
(now fixed) and two pre-existing failures: provider account selection in
`local-foundation.test.ts:7218` and a missing `getModelRuntimeByRoute` fixture in
`terminal-managed-session.test.ts:140`. Both failures reproduced unchanged in
a separate checkout of base commit `dc995f51a`; the full check is not recorded
as passing. Initial Windows CI also encountered an `EBUSY` temporary-directory
cleanup failure; the subsequent native-contract run passed on Windows without
changing its assertions. PR [#2326](https://github.com/ArcaneArts/Cantrip/pull/2326) squash-merged as
`ae2a214b5`. Clean Primary was fast-forwarded and the catalog worktree removed.
The next cycle, `codex/conversation-views`, implements owned conversation slots
and their lifecycle integration.

### Owned conversation views cycle (merged)

The isolated `codex/conversation-views` branch adds version 2 ownership with a
retained center conversation slot and explicit content selection, separate from
rail tabs. The current changes cover TypeScript commands, projection, draft
checkpoint integration, direct-view recovery, and server version negotiation.
Native commands, validation, resource removal, detach/return, and version
negotiation now have matching implementations and compatibility fixtures.
PR [#2332](https://github.com/ArcaneArts/Cantrip/pull/2332) squash-merged as
`b04530e3c`. Clean Primary was fast-forwarded and the cycle worktree removed.
Optional GitHub workflows were still running at merge time; they are not
recorded here as passing. Sidebar entry points remain milestone 3 work.

All 977 protocol tests pass, including 16 focused conversation-view tests.
Coverage includes same-pane rail conversion without losing another tab,
tab-free rail conversion, splitting while retaining the other view, occupied
return slots, content added while detached, and legacy editor import after a
version upgrade. The Rust workspace contract suite and both workspace model
suites pass, including direct-view transfer and import comparisons. HTTP parity
passes on PGlite and private PostgreSQL across unauthenticated, password, and account profiles (61,
64, and 66 observations respectively), including old-client read/write/import
rejection, canonical encrypted titles, receipt replay, and Task/standalone/
archived/foreign-chat denial. All 19 app workspace API tests pass, including
version headers on every route. App and server typechecking and the production
app build pass. All 16 focused workspace API tests pass. Native repository
compatibility passes all 66 cases and 11 retained-state snapshots on both
PGlite and private PostgreSQL.

The broad repository check initially found a stale generated route inventory;
it was regenerated from the changed routes. The restarted check reached CUA
tests, where `compact_score_supports_full_frame_budget_and_default_holds`
exceeded its JavaScript execution time limit during concurrent native builds.
The exact test passed when rerun without that concurrent build; the full check
is not recorded as passing. Native server clippy passes with warnings denied.
The full app suite passes (3,917 tests, three skipped across 556 files), and
the generated workspace query manifest matches the actual repository queries.
These are interim results, not evidence that the cycle or feature is complete.

Sidebar rendering, client usage signals, inline archive interaction, full rail
placement interaction, Rust workspace parity, and real-interaction and scale
acceptance remain outstanding. No feature acceptance item below is claimed
complete by these partial changes.

### Sidebar shell cycle (ready for PR)

The isolated `codex/conversations-sidebar` branch adds the app catalog client,
Files/Conversations switcher, persisted page preference, visibility-aware file
tree, active conversation list, resource-only creation, and direct selection.
Creation retains encrypted request identity across uncertain retries and follows
the existing Agent naming preference. Pending actions are fenced against changed
sessions, projects, workspace controllers, and unmounted sidebars.

Explicit owned Agent open/select commands and composer send/retry/steer actions
record usage without blocking navigation or execution. The tracker coalesces
same-activation focus signals, retains receipt identities for bounded retries,
and discards obsolete pending activity. Passive reads, restoration, and close
fallback do not emit usage events. Catalog queries reuse chat Live invalidation
and poll only while visible without Live coverage.

File tabs in the sidebar-bearing window offer Reveal in Files. This explicitly
selects Files and expands the requested worktree/path; ordinary file selection
does not switch sidebar pages. File scroll restoration survives asynchronous
reauthorization/directory loading. Detached windows retain their existing return
to main-window workflow rather than offering a nonfunctional sidebar command.

The final app suite passed 3,936 tests with 3 skipped across 562 files. Coverage
includes the reveal/sidebar/rail subset and delayed scroll restoration. App
typechecking, production build, five source-corpus tests, decomposition budgets,
changed-file formatting, and diff whitespace checks passed.

The repository `pnpm check` stopped at two CUA tests with "JavaScript execution
limit exceeded": `compact_score_supports_full_frame_budget_and_default_holds`
and `live_help_and_large_generated_score_match_runtime_limits`. Both pass when
run individually unchanged; the broad check remains recorded as failed, not
converted to a pass by those isolated retries. No CUA source or limits changed.

Inline archive, resource drag placement, list virtualization/scroll anchoring,
and the complete real-interaction acceptance matrix remain subsequent milestones.
No full-feature acceptance checkbox is marked complete by this cycle alone.

## Product outcome

Replace the collapsible **Files** heading below the project selector with a
**Files | Conversations** switcher. Files retains the project file tree.
Conversations provides a complete catalog of the selected project's Agent
chats, ordered by last usage, followed by an **Archived** section.

A conversation exists independently of an open tab. Users can work entirely
from this sidebar, leaving the top, right, and bottom rails for files, Issues,
Git, and other tools. Users who prefer one Agent tab can keep that tab open and
leave Files selected. Both workflows use the same chats and transcript UI.

Closing an Agent view and archiving its conversation are separate actions:
**rail middle-click hides the view; sidebar middle-click archives the
conversation**.

### Scope and defaults

- “All agent chats” means every eligible Agent chat in the **selected project**,
  including chats on other project worktrees and chats with no open views.
  Project selection remains the scope selector; this is not an account-wide
  cross-project inbox.
- Include only project-context chats with `experience === "agent"`. Exclude
  Task conversations, Task planning/execution/follow-up chats, standalone Chat
  mode conversations, and nested runtime subagent records. A chat's mode,
  worker availability, or absence from a rail does not decide eligibility.
- Active chats stay in Conversations even while open in any rail or another
  local window. Render one catalog row per chat ID, not one row per view.
- Files is the default for existing installations. Remember the chosen sidebar
  page per installation/account/server/project; changing projects restores that
  project's preference. Viewport resizing does not create a new preference.
- Preserve the existing 90-day archive recovery policy. Show the expiration
  information in the Archived section; moving its UI does not silently make
  archived chats permanent storage. Explicit **Permanently Delete** remains
  available before expiration.
- Deliver this document first. Runtime changes are subsequent, independently
  reviewable implementation milestones; their completion must be recorded with
  actual validation evidence.

## Interaction contract

| User action                                                   | Required result                                                                | Resource or layout effect                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Select Files or Conversations                                 | Show that sidebar page; the heading never collapses its contents               | Sidebar preference only                                                          |
| Press Conversations `+`                                       | Create an Agent, put it first in Conversations, and open its composer directly | Create a chat and a conversation view, with no rail tab or legacy tab attachment |
| Click an active conversation with no open view                | Show it directly in the workspace content area                                 | Open an owned conversation view without a rail tab                               |
| Click an active conversation already open                     | Focus its existing view, revealing its dock or owner window when needed        | Select/focus; do not duplicate or relocate it                                    |
| Drag an active conversation to the top, right, or bottom rail | Open or move its view at the indicated destination and select it               | Place a tab; keep the sidebar row                                                |
| Middle-click an Agent rail tab                                | Close that tab and use normal neighboring-tab/pane focus fallback              | Do not archive, delete, interrupt, or pause the chat                             |
| Middle-click an active sidebar conversation                   | Move the chat into Archived, including an empty chat                           | Archive the resource and remove its open views                                   |
| Choose Archive from an active row's menu                      | Same result as sidebar middle-click                                            | Accessible equivalent of archive                                                 |
| Open an archived row's `...` menu                             | Offer **Restore** and **Permanently Delete**                                   | Opening the menu has no mutation                                                 |
| Choose Restore                                                | Return the chat to the active list at the top                                  | Restore the same chat ID; create no tab and do not steal content focus           |
| Choose Permanently Delete and confirm                         | Remove that archived chat and its conversation history                         | Irreversible resource deletion through the existing lifecycle                    |
| Middle-click an archived row                                  | No deletion or restoration                                                     | No mutation                                                                      |

### Sidebar presentation

Use the existing sidebar spacing, fonts, selection treatment, and icons. Keep
the switcher fixed above the scrolling content. Its two choices are actual
accessible tabs, not a button that toggles the entire tree. Folder expansion
inside Files remains unchanged, as does the application's whole-sidebar
collapse control.

Conversations has a compact `+` action with the accessible name **New agent
conversation**. Rows show the decrypted chat title and existing Agent activity,
approval, unread-completion, and unavailable-worker indicators. An open-view
indicator may identify Top, Right, Bottom, or another window without splitting
the list into separate open/closed groups. Selection and open placement are
different states: several rows can have open views, but focus has one owner.

Below the active list, always expose an **Archived** heading and its count,
including a useful empty state. Do not hide this section behind Settings or a
second navigation page. Use bounded scrolling for a large active list so the
Archived heading remains reachable without loading every active page first;
its rows can scroll within their own section. Preserve scroll position by chat
ID when recent usage changes ordering.

Each archived row exposes a trailing `...` button on hover and keyboard focus.
Keep it visible on touch devices. Its menu contains the exact actions
**Restore** and **Permanently Delete**, with the latter styled as destructive.
Reuse the existing permanent-delete confirmation, including the affected chat
name, pending state, failure message, and cancellation behavior. Opening or
using the menu must not also select, drag, or middle-click the underlying row.

Active-row menus expose Archive and keyboard/touch equivalents of placing the
chat in the top, right, or bottom rail. Preserve existing Rename and Fork
capabilities through shared chat actions. A fork started here becomes another
sidebar conversation by default, rather than forcing an Agent rail tab.

### Direct viewing without rail tabs

Clicking an unplaced conversation opens the ordinary Agent transcript and
composer in the most recently focused center pane, otherwise the first center
pane, or creates a center conversation pane if none exists. Existing file/tool
tabs and their order remain intact. The pane
can show its selected conversation without adding an Agent entry to its tab
strip. Clicking one of its existing tabs returns to that tab's content.

Keep the Agent's local toolbar above the transcript, including its existing
customization, console, Inspect, and applicable relocation controls. Linked
console mode must also work for a directly viewed conversation. Reuse the
Agent renderer, message queries, encrypted drafts, queueing, attachments,
approvals, and runtime subscriptions; do not build a reduced second chat UI.

Selecting another unplaced conversation replaces that pane's conversation
selection after its draft is checkpointed. Switching to Files changes only
the sidebar and leaves the displayed conversation visible. Switching to a
file/tool tab preserves the conversation selection and draft for returning
through the sidebar. Limit each pane to one retained direct conversation view;
the catalog itself does not mount a transcript for every chat.

If the requested chat already has a view in this device workspace, focus that
view instead. Do not simultaneously mount a second interactive composer in a
direct conversation host. Another device's placement does not prevent this
device from opening its own view under the existing cross-device rules.

### Last usage

Define last usage as an explicit user activation or interaction, not generic
database modification time. Record usage when the user creates, selects,
restores, or submits/steers a message to an Agent conversation. Selecting its
rail tab or its already-open window through navigation counts too. Passive
mounting, startup restoration, polling, background streamed tokens, automatic
title changes, hover, opening a row menu, and reordering tabs do not count.

Persist an owner-scoped `lastUsedAt` for each project Agent and synchronize it
across the owner's devices. Order active rows by `lastUsedAt DESC`, then
`createdAt DESC`, then chat ID as a stable tie-breaker. Placement order and
workspace recent-tab history remain separate. Archived rows use
`archivedAt DESC`, then chat ID; Restore records a new usage event.

Use server-issued timestamps and idempotent usage events. Coalesce repeated
focus signals for the same activation, retain an operation ID across retries,
and reject obsolete per-client activation sequences so delayed requests cannot
reorder newer activity from the same client. A failed usage update must not
block opening, reading, or sending to the conversation. Keep the local recent
selection visible while reconciling; do not replay a backlog of old offline
focus events as new activity after reconnect.

For existing chats, backfill from `updatedAt`, falling back to `createdAt`.
This is a one-time approximation, not a claim to recover historical user
activity. After migration, only the defined usage events change recency.

## Existing implementation and required changes

The following are current source observations, not proposed new behavior.

| Area                 | Current implementation                                                                                                                                                                                                                    | Required change                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Project sidebar      | [ProjectChatList](../cantrip_app/src/components/sidebar/project-chat-list.tsx) currently hosts the selected project's file tree despite its name                                                                                          | Introduce a clear project sidebar body with Files and Conversations pages                             |
| Files heading        | [ProjectSidebarFileTree](../cantrip_app/src/components/sidebar/project-sidebar-file-tree.tsx) owns `filesCollapsed`; that flag also controls directory/encryption work                                                                    | Move the page header to the switcher and drive expensive tree work from actual Files visibility       |
| Sidebar wiring       | [ShellSidebar](../cantrip_app/src/components/app/shell-sidebar.tsx) and [sidebar explorer controller](../cantrip_app/src/components/app/sidebar-explorer-controller.ts) supply file operations                                            | Bind conversation resources and actions without tying their availability to Explorer or a live worker |
| Chat inventory       | [Project workspace resources](../cantrip_app/src/components/app/project-workspace-resources.ts) fetches `['chats', projectId]`; [chat catalog](../cantrip_server/src/db/repository/chat-catalog.ts) lists active chats by stored position | Add a complete Agent-only recent catalog independent of placement and Task queries                    |
| Chat creation        | [Creation operations](../cantrip_app/src/components/app/surface-creation-operations.ts) has `open: false`, but server `createChatExperience` still attaches non-Task chats to the legacy layout                                           | Add an explicit resource-only creation path; an app-only `open: false` is insufficient                |
| Close versus archive | [TABS.md](TABS.md) specifies view-only rail close; [removeAgentChat](../cantrip_app/src/lib/remove-agent-chat.ts) invokes interruption/removal for resource deletion                                                                      | Keep close on workspace commands and archive on a distinct lifecycle action                           |
| Archive semantics    | [ChatArchiveLifecycleRepository](../cantrip_server/src/db/repository/chat-archive-lifecycle.ts) archives chats with messages but deletes empty chats; restore attaches a legacy tab                                                       | Explicit Agent archive must retain empty chats, and resource-only restore must not attach tabs        |
| Archive UI           | [ProjectArchiveSettings](../cantrip_app/src/components/projects/project-archive-settings.tsx) mixes archived Agents and Tasks with restore/delete controls                                                                                | Move Agent recovery into the sidebar; retain Task archive access in Settings                          |
| Drag/drop            | [Workspace drag model](../cantrip_app/src/lib/workspace-dnd-model.ts) assumes a surface drag already has a pane and tab key                                                                                                               | Support catalog-resource drags with no source placement                                               |
| View ownership       | [Workspace schema](../packages/protocol/src/workspace-ownership.ts) requires nonempty `pane.tabs` and an `activeTabId`; [command client](../cantrip_app/src/lib/workspace-command-client.ts) opens resources as tabs                      | Model directly viewed conversations explicitly, preserving exclusive ownership and recovery           |

Use project identity plus `experience === "agent"` for both active and archived
catalogs. The legacy project schemas allow an omitted `contextKind`; normalize
that documented project form at the API adapter rather than accidentally
excluding old project chats. Never use `experience !== "task"` on unknown
unvalidated data or equate “currently has an Agent tab” with eligibility.

The Node server remains the normal runtime at this baseline. The
[Rust replacement](RUST_SERVER_REPLACEMENT.md) already implements workspace
contracts and has compatibility fixtures. Keep changed workspace schemas,
transitions, persistence, and fixtures aligned there; explicitly record any
chat-domain parity work still pending. This feature does not perform a server
cutover or change the worker's execution ownership.

## Workspace model for direct conversation views

A new JSX branch or hidden rail tab is not enough: the existing layout schema,
focus history, native transfer, resource removal, and restoration all enumerate
pane tabs. Extend the authoritative ownership model before exposing tab-free
conversation viewing.

### Proposed representation

Factor the existing tab's view identity/resource binding into a shared owned
view shape, then add an optional `conversationView` to a center pane. It is a
view of a `project.agent` resource with its own stable view ID, owned by that
pane/window/workspace, but absent from `pane.tabs` and all rail counts. Keep
`pane.tabs` as the ordered list of actual rail tabs.

Introduce an explicit active-content discriminator:

```text
pane.selection = { kind: "tab", tabId }
               | { kind: "conversation", viewId }

pane.tabs = ordered rail tabs
pane.conversationView = null | owned Agent view
```

These are proposed field names, not existing API fields. Version and migrate
the schema as one contract, including receipt and selection adapters. A pane
is valid when it contains at least one tab or a conversation view; its
selection must reference content it owns. A completely empty pane is removed
using the existing topology/focus rules. Right and bottom regions continue to
use ordinary tabs; direct conversation hosts live in center panes.

Closing an inactive tab preserves the selected content. Closing an active tab
selects its right neighbor, then its left, then the retained conversation slot
if present. Closing the selected conversation slot selects the last active
surviving tab, otherwise the first tab. Only an empty pane is removed; focus
then follows surviving pane history. Resource removal applies the same rules.

Within one device workspace, ordinary opening of a chat resolves its existing
view across **both** tabs and conversation slots. Conversion between a direct
view and a rail tab preserves view identity and draft state. Closing a view
may discard its view identity after protected state is retained; reopening
creates a new view of the same chat resource. No catalog entry itself claims
ownership of a renderer.

### Commands and rendering

Extend the existing revisioned workspace command path with operations for:

1. Opening/selecting an existing Agent in a conversation slot, or focusing its
   existing tab/slot elsewhere in the workspace.
2. Placing a catalog Agent into an explicit pane/region/index, converting a
   direct view in place or moving an existing tab when necessary.
3. Selecting pane content and closing a direct view, with deterministic focus
   fallback and draft preparation.

Use stable operation IDs, immutable sent command bytes, revisions, and
attachment generations through
[WorkspaceCommandClient](../cantrip_app/src/lib/workspace-command-client.ts)
and the [pure transitions](../packages/protocol/src/workspace-command-apply.ts).
Extend resource lookup, presentation, focus history, command search, native
window focusing, and lifecycle registration to enumerate both kinds of view.
Do not write a parallel local-storage layout or mutate the retired project
layout to implement these actions.

The pane renderer selects either its rail tab content or its conversation
content. Its tab strip still shows existing file/tool tabs when a conversation
is active, but none is falsely marked as the selected content. The direct
conversation title and controls live in the panel toolbar. When there are no
rail tabs, omit the empty Agent tab strip while retaining a usable way to open
other project surfaces.

Treat replacement, hiding, and transfer as lifecycle operations. Preserve
encrypted composer text, attachments, queued inputs, transcript position,
console selection, and Inspect state using existing protected state adapters.
Do not destroy the old renderer based solely on an optimistic request that
may fail. A failed checkpoint or transfer keeps the source recoverable with
an actionable error; a missing acknowledgment does not prove it is safe to
mount a duplicate.

Extend whole-pane detach/return and application quit/reload recovery to include
conversation slots, even when inactive behind a file tab. Detaching a direct
conversation alone uses the same prepared ownership transfer and presents a
conversation view in the destination. Return restores its conversation slot
when possible; if that slot now holds a different conversation, create a
center conversation pane rather than overwrite intervening work. Other device
workspaces keep their placements. Resource archival, unlike view closure,
removes all views of that resource across the owner's workspaces.

## Drag and drop

Add a catalog-resource drag variant carrying account/session scope, project
ID, and chat resource ID. It may include an observed view ID for presentation,
but the committed operation resolves current ownership rather than trusting a
stale source pane. Never manufacture a fake `paneId` for an unplaced chat.

Reuse the existing drag provider, insertion previews, region hit testing,
keyboard equivalents, and move/transfer commands:

- **Top rail:** insert into the indicated center pane at the displayed index;
  an empty center target creates a pane.
- **Right rail:** insert into its target pane or create a right pane, then
  reveal the dock without overwriting its remembered split size.
- **Bottom rail:** the same behavior for the bottom region.
- **Already placed:** move the existing view to the explicit drop destination,
  preserving identity. This differs from a simple sidebar click, which focuses
  the existing placement. A drop at the same location is a no-op.
- **Directly viewed:** convert/move that owned view into a tab, clearing its
  conversation slot only when the placement commits.
- **No view:** create one owned tab for the existing resource. Do not create,
  fork, restore, or duplicate the chat itself.
- **Archived row:** not draggable. The user restores it first.

An explicit cross-window move uses the existing protected handoff before
changing ownership. A cross-project/account drop is rejected by the real
command authorization. Canceling a drag has no side effect. If a chat is
archived/deleted or its source/destination changes during a drag, reconcile the
actual command result and retain the current valid state. A stale UI snapshot
must not prevent attempting an otherwise valid operation.

Do not enable manual sorting within Conversations: its order is last usage.
Dragging from its row is a placement action, not a list reorder. Suppress the
following click after a completed drag so it does not reopen another host.

## Server, persistence, and lifecycle work

### Catalog and recency

Add a paginated, owner-authorized project Agent catalog, backed by the existing
chat records and encrypted summary mappers. A proposed additive API is
`GET /api/projects/:projectId/conversations?state=active|archived&cursor=...`.
Return typed summaries and `nextCursor`; provide section totals independently
of the loaded page. Keep existing `getChats` consumers and Task APIs compatible.

Add last-usage storage and an index matching project, Agent experience, archive
state, and the relevant ordering. A proposed
`POST /api/chats/:chatId/usage` accepts a stable operation ID and client sequence
and returns authoritative recency. Authorize the actual chat/project on every
request. Use server time; timestamps and opaque IDs are operational metadata,
while chat titles and content retain their current encryption boundary.

Use bounded cursor pages with deterministic tie-breakers. Live changes restart
the affected ordered query and merge by chat ID; preserve the visible anchor
and never append duplicate rows. Handle a chat moving across a page boundary
while pages are in flight. Offer load-more/retry access to every item, not a
fixed recent-N cap. Virtualize long lists without mounting transcripts or
fetching message histories for each row.

### Creation and restoration without placement

Add an explicit placement option to the validated create/restore contracts,
such as `attachToTabLayout: false`, rather than inferring intent from a missing
pane ID. Preserve legacy behavior when the option is absent until all callers
are migrated. New owned-workspace callers create/restore the resource without
legacy placement and issue the desired owned-view command separately.

The sidebar `+` flow must create an Agent resource with normal model, permission,
worktree/worker selection, naming, encryption, and draft behavior. It then opens
the direct conversation host. If creation succeeds but opening fails, retain
the new catalog row and offer opening it again; retrying must not create a
second chat. Use the existing client-generated chat ID as the stable creation
identity, with server retry handling for an uncertain response.

Restore clears archive state and records last usage but performs no placement
operation. It preserves the chat ID, messages, attachments, title, model,
worktree binding, and existing automation-pause policy; restoring does not
silently restart a turn or automation. If its old execution location is
unavailable, keep history accessible and report that actual limitation when
execution is requested. Do not make history recovery depend on a worker being
online.

### Archive and permanent deletion

Introduce an explicitly named Agent archive operation in the app and server
domain. Its contract always archives an idle eligible Agent, including one
with no messages or only an unsent draft. Do not call the current generic
`deleteChat` path unchanged, because it can permanently remove empty chats.
An additive `POST /api/chats/:chatId/archive` can preserve old clients and Task
deletion semantics while making the new intent unambiguous.

Perform archive validation and mutation transactionally against current
execution state. Retain the archive timestamp on an idempotent retry; a retry
must not extend retention. Pause automation/queued execution according to the
existing Agent archive policy and remove owned tabs and conversation slots in
the same durable resource transition. Extend
[workspace resource removal](../cantrip_server/src/db/workspace-resource-removal.ts)
to cover conversation views, focus history, and in-flight transfers.

For a running or approval-waiting chat, sidebar middle-click presents the
existing stop-and-archive flow with an explicit **Stop and Archive** action;
it does not silently stop execution. After accepted interruption, retry the
actual archive operation while the terminal event is still in flight, using
the existing bounded removal pattern. A raced start or failed interruption
leaves the row active and shows the actual error. Rail close always remains
available without stopping the Agent.

Before archiving the locally displayed chat, checkpoint its unsent draft.
Preserve recoverable drafts in other attached windows through the existing
protected draft/recovery lifecycle when resource removal invalidates them.
Neither archival nor switching sidebar pages may discard a draft just because
the transcript is no longer rendered.

Permanent deletion uses the archived-resource endpoint and existing cleanup
semantics. Validate archive state and ownership at mutation time so a stale
delete dialog cannot delete a concurrently restored active chat. Remove cached
drafts, selections, resource summaries, and view references after confirmed
deletion. Do not delete the project's repository/worktree files merely because
its Agent conversation was deleted. Preserve existing retention cleanup and
exclude expired resources from recovery once the actual purge has committed.

### Invalidation and failure behavior

Publish or reuse App Live invalidations for create, usage, rename, status,
archive, restore, and delete. Update active/archived catalogs, existing
`['chats', projectId]` and `['archived-chats', projectId]` caches, and affected
workspace revisions. Resource status updates change badges without changing
last usage. Follow existing fallback polling only when Live coverage is absent.

Track pending state per chat/action rather than disabling every conversation
while one mutation runs. Reconcile optimistic patches by resource ID and
operation outcome; do not restore a whole stale list after one failure. A
request with an unknown outcome is resolved through authoritative state and
idempotent retry, not by guessing success or creating another resource.

Fence requests and retained callbacks by account, server, project, workspace,
and renderer generation. Loading failures show loading/error/retry content;
they do not imply that a chat has been deleted. Server-owned history remains
readable when its worker is offline. Use actual API/worker outcomes for creation
and execution failures, not speculative readiness checks that prevent valid
operations from running.

## Sidebar state, compatibility, and accessibility

Extract the file heading from the tree. Replace `filesCollapsed` query gating
with an explicit visibility signal so hidden Files does not continually fetch
directories or negotiate file access. Keep folder expansion, selected paths,
pending edits, scroll, and file-change indicators intact across page switches.
An explicit Reveal in Files command selects Files and expands the path; merely
receiving a new file selection must not steal the Conversations page.

Use shared hooks for catalog mutations and archive rows instead of copying
`ProjectArchiveSettings` into a second inconsistent implementation. Move Agent
archive browsing out of Settings, keeping archived Tasks available there. Old
Agent-archive links should navigate to this project's Conversations/Archived
section. Existing archived Agents appear automatically from the same records;
do not move, duplicate, unarchive, or reset their retention dates in migration.

For ownership migration, translate existing `activeTabId` into tab selection,
preserve every tab/pane/window ID and split, and initialize empty conversation
slots. Do not auto-convert existing Agent tabs, reopen closed chats, or seed
tabs from the catalog. Readers must understand the new version before writers
emit it. An older client must not round-trip a new layout through an old strict
schema and erase conversation views; use an explicit supported-version
response, with upgrade guidance, instead of lossy conversion. Preserve data
on rollback, including protected drafts and views the old client cannot show.

Use tablist/tab/tabpanel semantics and arrow-key navigation for Files and
Conversations. Keep focus visible; Enter/Space selects a conversation and
Shift+F10 or `...` opens its menu. After archive, focus moves to the next row,
then the previous row, then `+`; after restore, focus can move to the restored
row without opening its content. After permanent deletion, focus returns to a
surviving archive row or its heading. Announce action results and errors without
stealing focus from a composer.

Touch and mobile use the same sidebar pages and menu actions. Placement menus
provide alternatives to drag and middle-click, mapped to supported responsive
presentation without rearranging another device's workspace. A tab-free
conversation must remain reachable through the sidebar after closing the
drawer; it must not manufacture a mobile rail tab just to stay selected.

## Implementation sequence

Each milestone receives its own isolated worktree, ready PR, squash automerge,
merge observation, and cleanup. Keep dependent UI unavailable until its real
contracts exist; do not ship controls that pretend to work. Rebase the plan's
touchpoints against current source before each milestone.

### 1. Catalog, recency, and resource lifecycle contracts

Add protocol schemas, migration/indexes, Agent-only catalog paging, usage
tracking, explicit archive, and resource-only create/restore. Preserve legacy
Task/standalone semantics and encrypted labels. Add API/repository tests for
ownership, ordering, empty-chat archival, retention, idempotency, and races.
Exit: the API supports the complete catalog lifecycle without creating tabs.

### 2. Owned conversation views

Implement versioned pane conversation slots and active-content selection in
protocol, transitions, persistence, resource cleanup, and the command client.
Extend focus/open deduplication, presentation, transfer, quit/reload, and
protected draft adapters. Update the Rust workspace contract implementation and
comparison fixtures. Exit: a conversation can be viewed, switched, closed,
detached, and recovered without any rail entry or duplicate interactive owner.

### 3. Files/Conversations shell and direct use

Add the switcher, preference persistence, visible-state file query behavior,
active list, and `+`. Wire direct viewing through milestone 2 and reuse Agent
local controls. Keep list ordering independent of rail order and background
activity. Exit: several newly created chats can be used while the top rail
contains only files/tools, and switching back to Files preserves its state.

### 4. Inline archive and Settings transition

Add the Archived section, row menus, Stop and Archive, restore, permanent
delete, focus recovery, errors, and Live reconciliation. Remove duplicate Agent
archive browsing from Settings while preserving Task archives and old links.
Exit: sidebar archive is recoverable for empty and populated Agents, restore
does not create tabs, and Tasks/standalone chats never appear in either list.

### 5. Rail placement and close semantics

Add resource drags, all three rail targets, keyboard/touch placement menus,
direct-view conversion, existing-view movement, and canceled/stale drag
handling. Audit every top/right/bottom rail close handler and context label.
Exit: repeated drag/close cycles preserve one chat and its history, never
archive on rail close, and never create duplicate views in one workspace.

### 6. Acceptance, scale, and documentation

Run the focused matrix below, then the applicable broader checks. Exercise
real browser and native interaction, including multiwindow transfer and mobile
presentation; record unsupported physical-device coverage honestly. Verify
large-list navigation and paging, finish compatibility removal that is safe,
and update `TABS.md`, sidebar guidance, archive copy, and this document's status.
Exit: all acceptance criteria have recorded evidence, with failures and any
remaining limitations explicitly stated.

## Validation matrix

| Layer                | Required coverage                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol/model       | Eligible Agent filtering; cursor and usage validation; no empty invalid panes; valid active content; view-ID uniqueness across tabs/slots; deterministic close fallback; tab-to-slot conversion; stale revisions and renderer generations                                                                                          |
| Database/API         | Owned-project filtering; no Task or standalone leakage; deterministic MRU and equal timestamps; pagination during updates; create/restore without legacy placement; empty/draft-only archive; 90-day retention; running/archive race; concurrent restore/delete; idempotent retries and transaction rollback                       |
| Workspace lifecycle  | One interactive view per ordinary chat open in a device workspace; other-window focus; hidden/closed views keep execution running; checkpoint failure; direct conversation detach/return; whole-pane transfer with an inactive conversation; crash/reload/quit recovery; resource archive removes slots and tabs across workspaces |
| App components       | Switcher replaces heading collapse; file expansion and edits survive switching; stable list keys/scroll; correct row counts; active/archived menus and pending/error states; creation retry; restore creates no tab; no background-token reordering                                                                                |
| Drag/rails           | Catalog-only chat to empty/populated center/right/bottom; exact insertion; existing tab move; direct-view conversion; canceled drag; stale target; source archived mid-drag; cross-project denial; rail middle-click view-only on all rails                                                                                        |
| Live/offline         | Archive/restore/create/delete from another window/device; disconnected Live fallback; delayed or duplicated events; project/account switch while mutation is pending; offline history; command/refresh failures retain recoverable state                                                                                           |
| Accessibility/mobile | Keyboard switcher and list navigation; menu focus; touch equivalents; no hover-only required actions; screen-reader labels and announcements; narrow drawer navigation; independent desktop/mobile placement                                                                                                                       |
| Privacy/regression   | Encrypted titles/drafts/attachments; no plaintext transcript in layout, drag transport, logs, or recency storage; unchanged Task and standalone Chat lifecycle; file/tool tabs and dirty buffers preserved                                                                                                                         |

Extend existing suites where they own the behavior, especially:

- [sidebar tree tests](../cantrip_app/src/components/sidebar/project-sidebar-file-tree.test.tsx)
  and [sidebar composition tests](../cantrip_app/src/components/sidebar/project-chat-list.test.tsx);
- [surface creation ownership tests](../cantrip_app/src/components/app/surface-creation-ownership.test.ts),
  [tab strip tests](../cantrip_app/src/components/workspace/project-tab-bar.test.tsx),
  and [dock rail tests](../cantrip_app/src/components/app/project-workspace-frame-dock-rail.test.tsx);
- [drag model tests](../cantrip_app/src/lib/workspace-dnd-model.test.ts),
  [command client tests](../cantrip_app/src/lib/workspace-command-client.test.ts),
  and [Live query tests](../cantrip_app/src/lib/app-live-query.test.ts);
- [workspace protocol tests](../packages/protocol/test/workspace-ownership.test.ts)
  and [archive API tests](../cantrip_server/test/chat-archive-api.test.ts).

Add dedicated conversation catalog, recency, direct-view, and sidebar tests
where these introduce new behavior. Do not substitute text/snapshot assertions
for actual mutation outcomes or real drag/focus interactions.

Measure a fixture with at least 1,000 active and 1,000 archived chats: bounded
request sizes, bounded mounted row count, no per-row transcript queries,
reachable oldest items, no duplicate/missing rows after Live updates, and
stable focus/scroll during ordering changes. Compare interaction and network
cost to a small-list baseline and record the observations.

For implementation, run applicable protocol/server/app tests, the app build,
changed-file formatting, `git diff --check`, Rust workspace parity checks when
those contracts change, and the repository's required checks. Retain failures
as failures rather than claiming an isolated retry proves a broad pass.
Documentation-only delivery of this plan requires link inspection, formatting,
and `git diff --check`, not a claim that the feature has passed runtime tests.

## Acceptance checklist

- [ ] Files is a page of the Files/Conversations switcher; the old heading
      collapse behavior is gone and normal directory collapse still works.
- [ ] Every active Agent in the selected project is reachable in most-recent-use
      order, with no Task or standalone Chat entries.
- [ ] `+` creates a usable sidebar conversation without creating a rail tab or
      legacy placement, including after reload and uncertain creation replies.
- [ ] Multiple conversations can be used directly while file/tool tabs remain
      in the top rail; all Agent controls and protected drafts still work.
- [ ] A chat remains listed while open in top, right, bottom, or another local
      window, and clicking it focuses the existing view.
- [ ] Dragging an active row to any rail places or moves exactly one view,
      preserving the chat, history, draft, and indicated destination.
- [ ] Middle-clicking any Agent rail tab only hides its view; it neither archives
      nor interrupts the chat, including a running or approval-waiting chat.
- [ ] Middle-clicking an active sidebar row archives it into the section below;
      empty chats are recoverable and running chats use Stop and Archive.
- [ ] Archived `...` menus expose Restore and Permanently Delete on mouse,
      keyboard, and touch; restore never creates a tab and deletion confirms.
- [ ] Old archived Agents are visible in the sidebar with their original
      retention deadlines; archived Tasks remain accessible in Settings.
- [ ] Direct views survive reload, project/page switches, native transfer, and
      concurrent mutations without duplicated ownership or lost drafts.
- [ ] Paging, Live updates, offline errors, accessibility, and desktop/mobile
      workspace independence have recorded acceptance evidence.
