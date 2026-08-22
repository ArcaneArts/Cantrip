# Agent Trajectory

## Status

This document is the implementation plan and product contract for adding a
turn-scoped Trajectory view to Cantrip's existing agent Inspect surfaces.

Trajectory is a time-lane visualization of one agent turn. It is not a causal
node graph and it is not a whole-conversation analytics view.

## Decisions

- The Inspect surface has two tabs in this order: **Trajectory**, then
  **State**.
- Trajectory is the first and default tab everywhere the Inspect content is
  presented.
- State preserves the existing live inspector: latest thought, recently
  changed files, running commands, recent command completion, and its existing
  inactive presentation.
- The normal chat Inspect sidebar shows only the current live turn or, when no
  turn is live, the most recently completed turn.
- Starting a new turn replaces the default trajectory target with that new
  live turn. Old turns do not accumulate in the graph.
- A completed transcript turn's **Worked for _duration_** header receives a
  separate Trajectory action. Activating it opens Inspect on Trajectory and
  targets that historical turn.
- Task planning/finalization and Task implementation activity surfaces use the
  same Trajectory/State tabs. They default to Trajectory and scope it to the
  Task's current turn.
- The graph has Input, Model, and Tools lanes. It includes all persisted event
  families, with filters for reducing what is shown.
- Clicking the timeline positions a visible playhead and scrolls the event
  history to the corresponding point. Clicking a concrete event also selects
  it and exposes its details.
- Event details provide Summary, Preview, and Raw tabs. Raw diagnostic payloads
  are deliberately behind event selection and the Raw tab; they are not
  expanded throughout the event list.
- Future turns capture more bounded raw request/response information and an
  effective system/developer instruction snapshot for diagnosis.
- Trajectory never loads the entire conversation. It operates on the one
  targeted turn, which must already be represented by the loaded transcript or
  the current live message overlay.

## Goals

1. Make the execution shape of the current or selected agent turn immediately
   understandable.
2. Relate user input, model work, and tool activity on one shared time axis.
3. Let a user seek through a turn with a playhead and land at the matching
   event without hunting through a long list.
4. Preserve enough protected raw diagnostic context to investigate failures
   that a compact activity label cannot explain.
5. Reuse one projection and presentation across ordinary chats and Tasks.
6. Keep live updates stable: a lifecycle update changes an existing event
   rather than adding a duplicate, jumping the list, or dropping selection.
7. Preserve Cantrip's encrypted app/server/worker boundaries.

## Non-goals

- A causal, dependency, or node-and-edge graph.
- A single graph covering the complete conversation.
- Automatically fetching every historical message when Inspect opens.
- Token-by-token model output visualization.
- Displaying raw payloads inline for every event.
- Replacing the chat transcript or its existing activity presentation.
- Changing State's short-lived operational behavior.
- Sending raw prompts, tool arguments, results, command output, or system
  instructions to plaintext server logs.

## Existing Foundation

The implementation should extend the current path rather than create a second
observation stack.

- `cantrip_app/src/components/chat/agent-inspect-panel.tsx` owns the resizable
  desktop panel and full-screen mobile overlay.
- `cantrip_app/src/components/chat/agent-inspect-content.tsx` renders the
  existing State presentation.
- `cantrip_app/src/components/chat/inspect-model.ts` intentionally projects
  only the active turn and expires recent file/command state.
- `cantrip_app/src/components/chat/timeline.ts` already identifies transcript
  work groups and calculates the **Worked for** duration.
- `cantrip_app/src/components/chat/activity.tsx` already provides normalized
  labels and compact details for every `AgentActivity` family.
- `cantrip_app/src/lib/use-chat-message-history.ts` supplies decrypted,
  paginated history merged with the cursor-deduplicated live overlay.
- `cantrip_app/src/lib/app-live-query.ts` applies live chat-message upserts and
  recovery invalidation.
- `packages/protocol/src/index.ts` defines stable activity IDs, statuses,
  lifecycle timestamps, and Codex thread/turn/item correlation.
- `cantrip_worker/src/codex/app-server.ts` normalizes Codex lifecycle events at
  the worker boundary.
- `cantrip_app/src/components/tasks/task-surface.tsx` embeds the current
  inspector during Task planning and finalization.
- `cantrip_app/src/components/tasks/task-implementation-dashboard.tsx` embeds
  the current inspector in the implementation activity section.

## Inspect Surface Contract

### Tabs

The panel header remains **Inspect**. Directly beneath it, render an accessible
tab list:

1. **Trajectory**
2. **State**

Trajectory is selected whenever a new Inspect presentation mounts. The
selection may be remembered per chat for the current application session after
the user explicitly changes it, but there is no server preference and a fresh
application session begins on Trajectory.

The existing panel currently replaces all child content with an inactive
placeholder when the chat stops. Move that gate into State. The shell and tabs
must remain present while idle so the last completed turn stays inspectable in
Trajectory.

### Normal chat target selection

The Inspect controller owns a `TrajectoryTarget` with these modes:

- `follow-current`: select the current live turn, falling back to the newest
  completed turn when idle;
- `historical`: select the explicit stable turn key supplied by a transcript
  action.

Opening Inspect from the normal header uses `follow-current`. When a new live
turn starts, `follow-current` moves to it and the previous graph is replaced.

Opening a completed turn through its transcript action uses `historical`. This
explicit selection remains pinned while the user examines it, even if live
events arrive elsewhere. The Trajectory header identifies the historical turn
and offers **Back to current**. Closing Inspect or using that action returns to
`follow-current`.

This pinning exception prevents a deliberate historical diagnosis from being
interrupted while retaining the requested current/last-turn default.

### Completed-turn transcript action

Refactor the completed `ActivityGroup` header so it contains two sibling
controls rather than nested buttons:

- the existing **Worked for _duration_** disclosure control;
- an icon/ghost action named **View turn trajectory**.

The Trajectory action:

1. supplies the group's stable turn key;
2. opens the chat's Inspect sidebar;
3. activates Trajectory;
4. targets the selected historical turn; and
5. initially places the playhead at the turn start without selecting an event.

The action is shown only when the group contains enough data to build a turn
projection. It must have a tooltip, screen-reader label, and visible keyboard
focus treatment.

### Task surfaces

Task planning/finalization and implementation activity reuse the same tabbed
content component rather than implementing a Task-specific graph.

- Trajectory is first and selected by default.
- State remains available as the second tab.
- Trajectory follows only the Task's current turn.
- When the Task advances to another planning, finalization, or implementation
  turn, the graph replaces the previous turn with the new one.
- The existing conditions that determine whether Task activity is visible are
  preserved; this project does not add a whole Task history browser.
- The Task embedding supplies its own available width, but otherwise uses the
  same timeline, filters, list, details, empty states, and accessibility
  behavior as the chat sidebar.

The reusable boundary should be an `AgentInspectContent`-level controller (or a
renamed `AgentObservationContent`), with presentation mode props for sidebar
versus embedded Task layout. Do not fork State or Trajectory logic into the two
Task components.

## Turn Identity and Projection

### Stable turn keys

Add a stable turn key to the chat timeline model and activity groups.

Resolve it in this order:

1. `activity.correlation.turnId` or text-content correlation for the turn;
2. the correlated final response's turn ID;
3. a deterministic legacy key based on the opening user message ID and the
   terminal assistant/system boundary.

The key must survive activity lifecycle replacement, live resynchronization,
and history-page merges. It must not depend on the event array index.

### Trajectory projection

Create a pure trajectory model separate from the State projection. Suggested
modules:

- `cantrip_app/src/components/chat/trajectory-model.ts`
- `cantrip_app/src/components/chat/trajectory-model.test.ts`
- `cantrip_app/src/components/chat/agent-trajectory.tsx`
- `cantrip_app/src/components/chat/agent-trajectory.test.tsx`
- `cantrip_app/src/components/chat/trajectory-details.tsx`

The projection accepts the loaded messages, target turn key, and current time.
It returns a `TrajectoryTurn` containing:

- stable turn key and runtime turn ID;
- ordinal/title information for display;
- turn start, current/end time, elapsed duration, and completion status;
- projected events in deterministic chronological order;
- summary counts by lane, type, and status;
- timeline bounds;
- a flag describing whether exact runtime timing is complete; and
- the next transition time needed by a running event.

Each `TrajectoryEvent` contains at minimum:

- stable trajectory ID;
- original message ID and sequence;
- content index;
- activity, thread, turn, item, and diagnostic IDs when available;
- lane and event kind;
- lifecycle status;
- start, last-update, and completion time;
- timing quality: `exact`, `derived`, or `instant`;
- concise label and searchable text;
- normalized summary/preview data; and
- a reference to its protected raw envelope when present.

### Lifecycle merging

One runtime item may be persisted several times as it moves from running to
completed. Merge records by correlated item ID, falling back to
`activity.type:activity.id`.

- Retain the earliest valid item start.
- Retain the latest valid update and terminal completion.
- Prefer terminal status and the richest bounded payload.
- Accumulate command output only through the existing bounded output-tail
  contract; never concatenate multiple full snapshots.
- Merge file-change paths by path and retain the latest state/preview.
- Never emit both a running and completed row for the same lifecycle item.
- Resolve equal timestamps by message sequence, content index, then stable ID.
- If a selected event receives a live replacement, update its details in place
  and preserve the selection and scroll position.

### Timing quality and fallback

The projection must not imply precision that was not captured.

Resolve timing in this order:

1. explicit activity start and completion timestamps;
2. explicit completion plus `durationMs`;
3. earliest and latest lifecycle message timestamps for the same stable item;
4. the enclosing turn summary bounds; or
5. the message creation timestamp as an instantaneous marker.

Render exact spans normally, derived spans with a subtle patterned/dashed
treatment, and instantaneous records as ticks. Explain the timing quality in
Summary details.

Older conversations and imported chats continue to work through these
fallbacks. No history migration or backfill is required.

## Timeline Visualization

### Scope and scale

The horizontal scale always covers exactly one targeted turn. Long pauses
between separate user turns therefore cannot collapse useful execution detail.
There is no whole-chat Turns scale in this feature.

The turn begins at the best available turn/user-input start and ends at:

- the terminal turn completion for a completed turn; or
- the shared inspector clock for a live turn.

Show compact turn statistics above the graph: elapsed duration, event count,
tool-call count, and status. These are summaries, not alternate conversation
scopes.

### Lanes

Use three stable lanes:

| Lane | Events |
| --- | --- |
| Input | Effective system/developer context, user prompt, attachments, persisted system/context messages |
| Model | Overall model-turn span, reasoning, plans, commentary, final response, compaction, usage, rate-limit and notice markers |
| Tools | Commands, file changes, worktree operations, MCP/dynamic tools, collaboration, subagents, web search, image view and review-mode activity |

Usage, rate-limit, warning, and error records are markers unless they have a
meaningful captured duration. Concurrent records may occupy compact sub-rows
inside a lane so one bar does not hide another.

Use semantic colors consistently between overview bars, history badges, and
details. Status must also be communicated by icon/pattern/label rather than
color alone.

### Playhead and seeking

Render a vertical playhead across all three lanes.

Pointer behavior:

1. Clicking any horizontal position converts its x-coordinate to a turn time.
2. The playhead moves immediately to that time.
3. Prefer an event whose interval contains the time. If several overlap,
   prefer the smallest/most-specific interval and then the topmost visible
   filtered event.
4. If the click falls in a gap, choose the first visible event at or after the
   time; if none exists, choose the last visible event before it.
5. Scroll the history viewport so that event is centered when practical.
6. Clicking directly on a bar also selects that event and opens its details.

The event list and graph remain synchronized:

- selecting or focusing a history row moves the playhead to that event's start;
- changing filters seeks to the nearest still-visible event if the selected
  event becomes hidden;
- live duration growth does not move a user-positioned playhead unless the
  user selects **Follow live**; and
- reduced-motion mode scrolls immediately rather than smoothly.

Keyboard behavior:

- the timeline is focusable and announces its current elapsed/total time;
- Left/Right moves the playhead by a small time step;
- Shift+Left/Right moves by a larger step;
- Home/End seeks to the turn boundaries; and
- Enter selects the event resolved at the playhead.

Use SVG for the first implementation. A one-turn event set is bounded enough
to retain accessible event targets and straightforward hit testing. If a
single turn contains more drawable intervals than available pixels, aggregate
sub-pixel spans for the overview while keeping every event in the list.

## Filters and Search

Trajectory includes a compact filter/search row that applies to both the
graph and event history.

Default: every supported event is visible.

Filters include:

- lane: Input, Model, Tools;
- event family/type;
- status: running, completed, failed, declined;
- timing quality: exact, derived, instant; and
- text search over loaded labels, commands, paths, tool names, user-visible
  prompt/response text, and bounded raw text after it has been captured.

Provide **All** and **None** actions for event-family filters. Keep system
context and errors discoverable even when filters hide them by showing an
active-filter count and a clear reset action.

Search is client-side over the already decrypted targeted turn. It does not
send prompt or raw payload text to the server and it does not request older
history.

## Event History and Details

### History list

The history under the graph is the complete ordered event list for the
targeted turn after filters are applied.

Each collapsed row shows:

- event type badge/icon;
- concise label;
- status;
- elapsed start relative to the turn; and
- duration or instantaneous marker.

Rows use stable keys and predictable collapsed heights so the list can be
windowed if necessary. Running updates must not replay entry animations, reset
scroll, or steal selection.

### Selection layout

Details always remain inside the existing Inspect/Task surface.

- At a sufficiently wide resized panel, history and details may use an
  internal split.
- At narrow widths and on mobile, selecting an event replaces the list with a
  detail page and a **Back to events** action.
- The graph and active filters remain available when space permits; otherwise
  the Back action returns to the same playhead, selection, filters, and list
  position.

### Summary

Summary presents the normalized human-readable diagnosis:

- event label and type;
- status and failure/decline state;
- turn and item identity;
- exact/derived timing and duration;
- model/provider metadata when relevant;
- command exit state, file paths, tool name, plan state, reasoning summary,
  usage, notice, or other type-specific fields; and
- runtime `sourceMethod`, thread, turn, item, and diagnostic correlation.

Reuse or extract the label/detail rules from
`cantrip_app/src/components/chat/activity.tsx` so transcript and Trajectory do
not disagree.

### Preview

Preview renders the safest useful type-specific representation:

- Markdown for user, system, commentary, final, reasoning, plan, and textual
  tool results;
- syntax-aware bounded output for commands;
- changed-file summaries and available latest-line/diff previews;
- structured tables/trees for JSON-like tool results;
- attachment metadata/preview where already supported; and
- clear **Preview unavailable** or **Not captured** states.

Preview must never silently pretend a truncated output is complete.

### Raw

Raw is available only after selecting an event and choosing the Raw tab. It
shows the normalized event plus the protected raw capture envelope when one
exists, with truncation metadata and copy actions.

Raw is diagnostic, not a second always-expanded transcript. The list never
renders raw argument/result bodies.

## Protected Raw Capture

### Requirements

Current compact activity models discard useful diagnosis data for several
tool families. Add an optional, versioned raw envelope to applicable
trajectory activities for future turns.

The initial contract should carry independently bounded request and response
documents:

```text
schemaVersion
request:  mediaType, text, originalBytes, truncated
response: mediaType, text, originalBytes, truncated
metadata: bounded normalized key/value diagnostics
```

Recommended initial budgets are 64 KiB encoded request text and 256 KiB
encoded response text per event, enforced in protocol validation and before
worker publication. Binary bodies are never embedded; record their type,
size, digest when available, and omission reason.

Capture candidates include:

- MCP arguments, structured content, text content, and error response;
- dynamic-tool arguments and returned result;
- collaboration prompt, targets, model, and bounded agent responses;
- subagent interaction prompt/result summaries;
- web search action/result metadata;
- command invocation metadata and the existing bounded output tail;
- file-change patch/diff preview within a separate conservative bound;
- review and compaction metadata; and
- provider/runtime request identifiers useful for correlation.

Known credential-bearing keys and values—Authorization, cookies, access/refresh
tokens, API keys, and protected-secret material—must be redacted before the
envelope is sealed. Raw payloads must never be added to service logs,
analytics, toast text, or unencrypted live-event metadata.

### Encryption and ownership

Workers own runtime capture. They serialize, bound, redact known credentials,
and publish the raw envelope as part of the normal activity content. The
existing chat/task content encryption seals it before server persistence. The
server stores and routes the opaque chat message but does not inspect or index
raw text. The app decrypts it through the existing message-history path.

This keeps the app/server/worker boundary intact and avoids a second diagnostic
storage system.

### Compatibility

The envelope is optional and versioned. Older clients ignore it, and older
messages display **Raw capture unavailable for this event**. No database
migration is required if it remains inside the existing encrypted message
content, but protocol schemas, compatibility tests, and encrypted-message
round-trip tests are required.

## Effective Instruction Capture

Each new turn should have one trajectory-only Input event representing the
effective instruction context used to start that turn.

The event should include, where available:

- runtime-provided system instructions;
- developer instructions;
- user-configured Cantrip global/project/chat policies and customizations;
- applicable `AGENTS.md`/instruction context exposed by the runtime;
- collaboration mode, sandbox/approval profile, model, provider, and reasoning
  configuration; and
- runtime/Codex version and capture provenance.

The normal chat transcript does not render this trajectory-only context event.
It appears in Trajectory's Input lane and history, where Summary describes its
sources, Preview renders the effective instruction text, and Raw exposes the
bounded protected snapshot.

Exactness must be explicit:

- `exact`: the runtime exposes the actual effective instruction block;
- `assembled`: Cantrip records the instruction sources it supplied but the
  runtime has additional internal instructions it does not expose; or
- `unavailable`: neither an exact nor meaningful assembled snapshot can be
  obtained.

Do not label an assembled snapshot as the verbatim model system prompt. Runtime
integration discovery should first determine which Codex/provider paths expose
the effective prompt. When unavailable, preserve the Cantrip-supplied sources
and clearly identify the limitation.

Instruction snapshots receive the same client/worker encryption and raw-size
bounds as other chat content. They must not enter plaintext logs or server-side
search.

## Live Update and Cache Contract

Trajectory consumes the same `messages.data` array as the transcript and
State. Do not introduce another polling or whole-history query.

- React Query live-overlay upserts update the projection by stable message and
  activity IDs.
- Existing cursor deduplication remains authoritative.
- Live resynchronization rebuilds the targeted turn from the recovered cache.
- A decrypt/open failure continues to invalidate the existing head-page key.
- The historical target is retained only while its stable turn key remains in
  loaded history. If it disappears after cache recovery, show a concise
  unavailable state with **Back to current**.
- Do not automatically call `fetchOlder` for Trajectory.
- Cache normalized events per message identity and reprocess only changed live
  messages. Coalesce streaming updates to the paint cadence so large command
  output updates cannot repeatedly rebuild the whole turn.
- Use the shared inspector clock only while a visible targeted turn contains
  running intervals.

## Worker Timing Normalization

The protocol already permits `startedAtMs`, `updatedAtMs`, and
`completedAtMs` on every activity. Normalize future worker events so every
item-based family spreads the supplied lifecycle timestamps, including MCP,
dynamic tool, collaboration, subagent, web-search, image-view, review-mode,
and compaction activities.

Retain the item-specific start observed on `item/started` and use it on
`item/completed`; do not replace it with the overall turn start. Projection
merging still keeps the earliest valid lifecycle start as a defensive measure.

Add worker normalization tests for started, updated, completed, failed, and
declined variants. Existing sparse records remain supported by timing-quality
fallbacks.

## Accessibility and Responsive Behavior

- Use `role="tablist"`, `role="tab"`, `aria-selected`, and associated
  tabpanels for Trajectory and State.
- Give the playhead a textual elapsed/total value and full keyboard controls.
- Make event bars focusable when they are individually drawable.
- Mirror all graph information in the event list; the graph cannot be the only
  way to discover an event.
- Maintain visible focus, adequate contrast, high-contrast support, and status
  shapes/icons in addition to color.
- Respect reduced motion for panel transitions, seeking, list scrolling, and
  live bar changes.
- Keep touch targets usable in the full-screen mobile Inspect overlay.
- Preserve the current resizable desktop panel. Do not open another app-level
  sidebar for details.

## Implementation Sequence

### Phase 1: Turn identity and timestamp correctness

1. Extend `ChatTimelineEntry` activity groups with stable turn identity and
   expose it to `ActivityGroup`.
2. Add projection tests for correlation-first and legacy fallback grouping.
3. Preserve item lifecycle timestamps across every worker-normalized activity.
4. Add worker/protocol regression coverage.

### Phase 2: Shared Inspect tabs

1. Extract the current inspector presentation as the State tab without
   changing its behavior.
2. Add Trajectory-first tab state beneath the Inspect header.
3. Move inactive gating into State so Trajectory can show the last turn.
4. Use the shared tabbed component in both Task activity embeddings.
5. Add accessible tab and default-selection tests.

### Phase 3: Turn projection and history

1. Build the pure `TrajectoryTurn`/`TrajectoryEvent` projection.
2. Merge lifecycle updates and implement timing-quality fallbacks.
3. Add lane/type/status filters and client-side search.
4. Render the stable, optionally windowed event list.
5. Add empty, unavailable, partial legacy, live, completed, failed, and
   historical-target tests.

### Phase 4: Timeline and playhead

1. Render the one-turn SVG time lanes and running bounds.
2. Implement deterministic time-to-event seeking.
3. Synchronize playhead, list scroll, event focus, and selection.
4. Add density aggregation, keyboard controls, and reduced-motion behavior.
5. Verify minimum/maximum sidebar widths and Task/mobile layouts.

### Phase 5: Details and raw capture

1. Extract shared activity summaries and previews.
2. Implement Summary, Preview, and Raw detail tabs.
3. Add the bounded, versioned protected raw envelope to the protocol and
   encrypted message round trips.
4. Capture supported raw runtime inputs/results at the worker boundary with
   credential redaction and truncation metadata.
5. Capture the effective instruction snapshot with exact/assembled provenance.
6. Add security tests proving raw text is absent from plaintext logs and live
   routing metadata.

### Phase 6: Transcript targeting and hardening

1. Add the sibling **View turn trajectory** action to completed **Worked for**
   headers.
2. Implement `follow-current`, pinned historical targeting, and **Back to
   current**.
3. Preserve selection and scroll through live upserts/resynchronization.
4. Benchmark dense turns and streaming command output.
5. Update `docs/FULL_DESCRIPTION.md` and relevant encryption/worker protocol
   documentation after implementation.

## Validation Plan

### Projection unit tests

- exact turn-ID grouping and fallback grouping;
- a new live turn replacing the previous follow-current target;
- a pinned historical target remaining stable during unrelated live updates;
- lifecycle running/completed deduplication;
- concurrent/overlapping calls;
- deterministic equal-timestamp ordering;
- exact, derived, and instant timing;
- imported/legacy history with missing correlation and timestamps;
- every activity type mapped to the expected lane;
- filter/search combinations and reset behavior;
- selected event replacement without selection loss; and
- disappearance of a pinned turn after cache recovery.

### Worker/protocol tests

- timestamps retained for every item activity family;
- item start is not replaced by overall turn start;
- raw request/response bounds and truncation metadata;
- binary omission behavior;
- known credential-key redaction;
- encrypted chat and Task message round trips with raw envelopes;
- exact/assembled/unavailable instruction provenance; and
- no raw payload leakage into structured logs or public live-event metadata.

### Component tests

- Trajectory is first and default; State is second;
- State remains behaviorally equivalent to the current inspector;
- idle Inspect still exposes the last completed trajectory;
- timeline clicks position the playhead and scroll to the deterministic event;
- event-bar clicks open details;
- Summary/Preview/Raw render type-appropriate content;
- filtered-out selection resolves to the nearest visible event;
- **View turn trajectory** opens the correct historical turn;
- **Back to current** restores follow mode;
- Task planning/finalization and implementation embeddings share the same tabs;
- keyboard, screen-reader labels, reduced motion, narrow sidebar, wide sidebar,
  and mobile overlay behavior.

### Manual QA scenarios

1. A turn with only a quick text response.
2. Long reasoning followed by commentary and final output.
3. Several sequential and parallel commands with streaming/truncated output.
4. File changes interleaved with commands.
5. MCP, dynamic, collaboration, subagent, web-search, image-view, and review
   events.
6. Failed, declined, interrupted, rate-limited, and approval-waiting turns.
7. A new turn beginning while Inspect follows the previous last turn.
8. A historical **Worked for** trajectory inspected while another turn runs.
9. A Task moving through planning, finalization, and implementation turns.
10. A legacy/imported chat with incomplete timing.
11. A dense turn containing hundreds or thousands of updates.
12. App live-stream loss and recovery while an event is selected.

Run focused app, protocol, and worker tests plus the normal repository check
appropriate to the final implementation. Documentation-only milestones still
require `git diff --check`.

## Acceptance Criteria

- Inspect and Task activity surfaces show Trajectory first and State second,
  with Trajectory selected by default.
- State preserves the existing operational inspector behavior.
- Normal Inspect automatically targets only the current live or last completed
  turn.
- Starting a new turn replaces the default followed trajectory.
- Every completed **Worked for** group with trajectory data can open Inspect on
  that exact historical turn.
- The graph is a one-turn Input/Model/Tools time-lane visualization, not a
  causal graph.
- Clicking the graph places a visible playhead and scrolls to the deterministic
  corresponding history event.
- Clicking any event exposes Summary, Preview, and Raw details inside the same
  Inspect/Task surface.
- All event families are included by default and can be filtered/searched.
- Live lifecycle updates modify existing events without duplication, scroll
  jumps, animation replay, or selection loss.
- Exact, derived, instant, truncated, redacted, and unavailable data are
  labeled honestly.
- New turns retain bounded protected raw diagnostic payloads and effective
  instruction context when the runtime makes it available.
- Raw and instruction content remains encrypted through server persistence and
  absent from plaintext logs and routing metadata.
- Trajectory does not automatically fetch whole-conversation history.
- Desktop resizing, Task embedding, mobile overlay, keyboard navigation,
  reduced motion, and high-contrast themes remain usable.

## Principal Risks

- Runtime providers differ in whether they expose an exact effective system
  prompt. Provenance labeling is required to avoid presenting reconstructed
  context as verbatim.
- Raw tool payloads may contain credentials or large/binary content. Bounding,
  credential redaction, encryption, and omission metadata are mandatory.
- Historical and imported messages cannot be retroactively given precise
  timing. Estimated visualization must remain visibly distinct.
- The completed `ActivityGroup` header is currently one disclosure button; it
  must be structurally refactored to add a second action without nesting
  interactive controls.
- Streaming output can trigger frequent message replacements. Incremental
  projection and stable selection are necessary to avoid the replay/flicker
  class of bugs seen elsewhere in frequently updating chat UI.
- The default Inspect width is narrow for graph, list, and details together.
  Responsive drill-in is required even though the surrounding panel is
  resizable.
- Task and chat embeddings can drift if they do not share the same projection
  and tab controller.
