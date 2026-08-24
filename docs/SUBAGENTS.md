# Native Subagents

Status: implemented

Scope: native Codex subagents, model configuration, encrypted event transport, chat presentation, and trajectory visualization

## Issue

Cantrip already runs a Codex version with native collaboration support and recognizes a small subset of its subagent activity, but it does not expose subagents as complete, durable participants in an agent turn. Child-thread notifications are not owned by the root execution, child conversations are not reconstructed, collaboration activity is flattened into generic tool rows, and the trajectory assumes one agent with three fixed lanes.

The model controls are also split across a model dropdown and a separate reasoning button. Cantrip has no durable root/subagent model configuration, no account-level default for that complete configuration, and no route validation for a custom subagent model.

The feature must preserve Cantrip's encrypted-content boundary. Subagent prompts, handoffs, messages, reasoning, commands, and results are private chat content. They must not become plaintext server records merely to make the new UI possible.

## Added Context

- Native subagent tools should be enabled by default, matching Codex. Enabling the tools does not authorize proactive delegation and must not add prompting that asks the model to spawn agents.
- The root agent is always the first trajectory track.
- A subagent view covers that agent's entire participation in the selected root turn, including task assignment, follow-ups, root-to-child and child-to-root communication, tool work, and final return.
- Nested descendants are presented in one flattened list with path-based indentation rather than nested panels.
- The composer model selector and reasoning control become one model-configuration dialog. The separate brain button is removed.
- A subagent inherits the root model and reasoning effort unless `Custom Subagent Model` is enabled.
- Settings replaces `Default for new agents` with `Default model configuration`, using the same dialog. The saved configuration initializes new chats.
- In the first implementation, a custom subagent model must have a usable route on the same provider identity as the selected root route. Native Codex currently copies the parent's provider into spawned threads and does not expose a provider override on `spawn_agent`.
- Every implementation cycle described below must use its own worktree, PR, and squash automerge. A cycle starts from the newly merged `main`; there is no umbrella PR.

## Current Behavior

### Codex runtime

Cantrip pins Codex 0.149.0. Upstream exposes native collaboration through `multi_agent`, has `[agents].enabled` enabled by default, and accepts:

- `agents.enabled`
- `agents.default_subagent_model`
- `agents.default_subagent_reasoning_effort`

When no subagent override is supplied, a spawned child inherits the current model and reasoning behavior. When an override is supplied, upstream applies it to the child but retains the root thread's model provider. Cantrip currently does not set the subagent defaults per chat and its generated model catalog contains only the root model.

The worker normalizes `collabAgentToolCall` and `subAgentActivity` as ordinary root activities. `thread/started` and `thread/status/changed` are recognized notifications but ignored. Notification lookup only resolves the root thread's active turn, so child messages, tools, approvals, and completion cannot safely share the existing `ActiveTurn`: a child completion could otherwise settle the root turn, and child interaction requests currently have no active Cantrip channel.

### Model configuration

`model-reasoning-picker.tsx` presents a model trigger and a separate brain trigger. `App.tsx` sends separate model and reasoning mutations. The protocol, database, and API store `modelId` and `reasoningEffort` independently and have no subagent configuration.

Settings stores only `defaultModelId`. Chat reasoning changes also update a model profile's remembered reasoning default, which conflates a chat choice, an account default, and a per-model preference.

### Chat and trajectory UI

Collaboration events render through the generic activity renderer. There is no stable subagent lifecycle card and no child transcript view. The existing right-side inspect panel can provide the shell for a mutually exclusive read-only subagent panel.

The trajectory projection has three global lanes (`input`, `model`, and `tools`) at fixed vertical positions. It has no agent identity, per-agent filtering, dynamic height, or track ordering.

### Encryption

Cantrip already seals message and activity content in the worker before it reaches server persistence. The server owns public routing and operational metadata but should not understand chat text, filesystem paths, prompts, reasoning, command bodies, or model output. Trajectory raw capture follows the same boundary.

Subagent support must extend this mechanism. It must not introduce a plaintext child-transcript table, server-side parsing of handoffs, or private content in public live-event metadata, logs, analytics, error messages, or toasts.

## Target Experience

### Availability

- Native subagent tools are available in every compatible Codex session by default.
- Cantrip does not add a proactive-delegation prompt, silently spawn agents, or change approval policy.
- Existing prompt and policy controls continue to determine whether the model actually uses a subagent.
- Older/incompatible workers report the capability as unavailable instead of accepting configuration they cannot honor.

### Model configuration dialog

Clicking the model control in the composer opens one dialog containing:

1. Root model.
2. Root reasoning effort.
3. `Custom Subagent Model` checkbox.
4. Subagent model and subagent reasoning effort when the checkbox is enabled.

When the checkbox is disabled, the subagent controls are hidden and the effective subagent configuration follows the root configuration live. Previously chosen custom values remain stored but inactive so toggling the option back on restores them. The summary in the composer should communicate either `Subagents inherit root` or the selected custom model without adding a second permanent toolbar control.

Saving is atomic. Canceling makes no change. While a turn is running or awaiting interaction, the dialog may be inspected but cannot save a runtime-changing configuration.

Settings presents a `Default model configuration` row that opens the same component in default-editing mode. This account configuration is copied into newly created chats; editing it does not mutate existing chats.

### Main chat

The main transcript shows one durable subagent lifecycle card for each `(rootTurnId, agentThreadId)` pair. Repeated status and communication events update that card instead of producing a stream of duplicate activity rows. The card shows the agent nickname/path, role, task summary, current state, and latest activity using decrypted client-side data.

Communication milestones remain visible in the root transcript in a compact form: spawn, follow-up/send, wait/status, interruption, and returned result. Clicking a card or communication event opens the subagent panel.

### Read-only subagent panel

The existing right sidebar becomes a mutually exclusive panel host. Opening a subagent replaces any currently open inspect or subagent panel.

The panel shows the selected agent's entire participation in the selected root turn:

- incoming task/spawn prompt;
- child commentary and messages;
- reasoning summaries already allowed by the normal chat presentation;
- tool calls, commands, and their details;
- root-to-child follow-ups and child-to-root messages;
- wait, interruption, failure, and completion events;
- final returned result.

It reuses the main chat's message, markdown, activity, and detail renderers but has no composer, stop button, steer action, or direct approval controls. Command/activity rows remain inspectable. The header contains the agent path, status, model/reasoning summary, parent breadcrumb, and close action. The selected transcript does not carry a permanent agent-tab list. Selecting `Root` in the breadcrumb opens a dedicated turn overview with the flattened, indented agent list; selecting an agent there returns to that transcript. Mobile uses the existing overlay form of the right panel. Finished transcript views retain their rendered state across no-op durable-history polling and update only when their projected agent snapshot actually changes.

### Trajectory

The trajectory has one horizontal track per agent rather than three global bars. Each track is a single multicolored bar whose segments retain the existing semantic colors for input, model work, and tools. Additional activity categories may add colors later without changing the track model.

Ordering is deterministic:

1. Root agent, pinned first.
2. Descendants in first-appearance order for the selected root turn.

Activity and status updates do not move existing rows. This deliberately
trades active-first grouping for a stable graph that remains readable during
parallel work.

Nested descendants are flattened and indented by depth. The graph grows through five tracks, then scrolls vertically inside its own viewport. Horizontal zoom, pan, and playhead state remain synchronized across all tracks.

Trajectory filters add one dynamic filter for every agent that participated in the selected root turn. Existing lane/type/status/timing filters remain. Event rows include the agent identity, and selecting an event can open and focus the matching activity in the subagent panel.

## Architecture

### Model configuration contract

Introduce one shared protocol object and use it for account defaults, chat state, composer state, and queued-turn snapshots:

```ts
type ModelConfiguration = {
  modelId: string;
  reasoningEffort: ReasoningEffort | null;
  customSubagentModel: boolean;
  subagentModelId: string | null;
  subagentReasoningEffort: ReasoningEffort | null;
};
```

`null` retains the existing provider/model-default semantics where supported. With `customSubagentModel: false`, the two stored subagent values are inactive and the effective child values derive from the root fields. With it enabled, both effective child values must validate for the selected child model.

Persist the same logical shape in:

- user settings as the default for new chats;
- chats as the durable configuration for future turns;
- queued prompt/turn commands as a snapshot, so later UI edits cannot change an already queued turn.

Add a single atomic chat mutation such as `PATCH /api/chats/:chatId/model-configuration`. Do not orchestrate four independent client mutations. Server validation owns model access, supported reasoning effort, provider compatibility, and worker availability. Existing model/reasoning endpoints may temporarily adapt into the new repository operation for compatibility, then be deprecated.

Existing users and chats migrate to `customSubagentModel: false`. Their root model/reasoning values remain unchanged. New chat configuration is copied from the account default at creation. A chat update must stop implicitly changing `model_profiles.defaultReasoningEffort`; account defaults and model-profile preferences are separate concepts.

### Provider and route resolution

Resolve a custom configuration as a route pair, not as two unrelated catalog entries:

1. Resolve the root model using the existing priority, account, worker, and availability rules.
2. For each viable root route, find an enabled child route for the custom model on the same provider identity/account and compatible worker runtime.
3. Select the first valid pair according to existing route priority semantics.
4. If no pair exists, reject before starting the turn with an actionable configuration error.

The UI may disable obviously incompatible child models based on current catalog metadata, but turn start must revalidate because routes and workers are dynamic. Never silently fall back to another provider or to root inheritance when the user explicitly selected a custom model.

Pass the provider-native child model slug and reasoning effort to the worker only after route resolution. Add both root and child model entries to the worker-managed Codex model catalog. If inheritance is selected, omit the two `agents.default_subagent_*` overrides and allow native Codex inheritance.

Cross-provider custom subagents are deferred. Supporting them requires an upstream Codex provider override per child or a Cantrip routing broker capable of creating the child on a different runtime; the current native spawn path cannot implement that promise safely.

### Runtime enablement

Make availability explicit in generated Codex runtime configuration:

- `agents.enabled=true`
- stable native `multi_agent` support enabled
- no proactive/automatic-delegation mode

Extend the worker turn command/options with the resolved subagent runtime defaults and capability version. Keep these values scoped to a chat turn rather than mutating a user's global Codex configuration.

### Agent execution ownership

Replace root-only notification ownership with a root execution group:

```text
RootExecution
  rootThreadId
  rootTurnId
  interactionChannel
  agentThreads: Map<threadId, AgentRuntimeState>

AgentRuntimeState
  threadId / parentThreadId / agentPath / depth
  currentTurnId / status / model
  item and activity correlation maps
```

Maintain a worker-level `threadId -> RootExecution` index. Associate a child when the parent emits spawn/subagent activity and confirm/enrich it through `thread/started` metadata (`parentThreadId`, source, nickname, role, and agent path). Namespace item and turn correlation by agent thread so repeated IDs or child completion cannot collide with the root.

All child notifications flow through their own `AgentRuntimeState`. Child `turn/completed` updates only that child. Root completion follows native root semantics and deterministically settles or marks remaining child states during root interruption, failure, disconnect, or shutdown.

Child approvals and user-input requests route through the root execution's existing interaction channel, labeled with encrypted child identity for the UI. Existing approval policy remains authoritative. No request should fail merely because its immediate thread ID is not the root thread.

A reused native child belongs to a new presentation segment when work continues in a later root turn. The durable UI key therefore includes both `rootTurnId` and `agentThreadId`.

### Encrypted agent scope and communication

Extend protected message/activity content with a sealed agent scope. A representative private shape is:

```ts
type AgentScope = {
  agentThreadId: string;
  rootThreadId: string;
  parentThreadId: string | null;
  rootTurnId: string;
  agentPath: string[];
  nickname: string | null;
  role: string | null;
  depth: number;
  isRoot: boolean;
};
```

The full scope is sealed by `EncryptedChatEventSealer` with the message or activity. Public envelopes contain only the minimum opaque identifiers, correlation, status, timestamps, and activity classification required for routing, ordering, idempotency, retention, and coarse operational metrics. Nicknames, roles, path labels, task summaries, prompts, reasoning, command bodies, filesystem paths, tool results, handoff text, and final responses remain encrypted.

Add a protected `agentCommunication` activity (or equivalent enriched collaboration activity) for spawn assignment, send/follow-up, wait/status, interrupt, and return. Preserve bounded/redacted communication text inside encrypted content rather than discarding it during normalization. The server stores and broadcasts the opaque protected payload using the existing chat-message/event path and does not index or parse it.

Encryption and projection rules:

- derive cards, labels, agent filters, and private timeline details only after client decryption;
- never copy decrypted child content into public telemetry, server logs, toast text, search indexes, or analytics;
- keep correlation IDs and actual child `turnId` distinct from the presentation `rootTurnId`;
- ensure idempotency keys include agent thread/turn scope;
- exclude child-only transcript entries from root continuation/history reconstruction so a fresh root thread does not replay child chatter as root assistant messages;
- include encrypted child records in normal retention, deletion, export, and replica flows without creating a second plaintext lifecycle;
- preserve the same access checks and chat encryption keys as the owning root chat.

### Recovery

Live notification capture is the fast path. On worker reconnect, missed association, or restart, use Codex `thread/read(includeTurns=true)` and parent/ancestor thread listing to recover child metadata and bounded turn history. Recovery output passes through the same normalization, redaction, encryption, idempotency, and root-turn segmentation as live events.

If exact communication text is not recoverable from Codex, present an explicit structural milestone rather than inventing text. Recovery must not require the server to decrypt prior content.

### Client projection and cache invalidation

Build a message-derived `AgentTurnProjection` keyed by root turn and agent thread. It contains decrypted presentation metadata, lifecycle state, ordered communication, child stream items, and trajectory segments. Recompute it when relevant messages/activities change; update elapsed-time fields separately on timer ticks.

Invalidate or re-key the projection when:

- encrypted messages are decrypted or replaced;
- a live child event arrives;
- an event is reconciled with recovered history;
- the selected root turn changes;
- a child path/parent association is enriched;
- retention or deletion removes source messages.

The main transcript, subagent panel, and trajectory consume this shared projection so ordering and status cannot disagree among three independent implementations.

## Relevant Touchpoints

- `cantrip_codex/upstream/codex-rs/config/src/config_toml.rs`: native agent enablement and default subagent model/reasoning keys.
- `cantrip_codex/upstream/codex-rs/core/src/tools/handlers/multi_agents_common.rs`: inheritance behavior and the same-provider constraint for spawned children.
- `cantrip_codex/upstream/codex-rs/app-server-protocol/schema/typescript/v2/Thread.ts`: parent/source/path/nickname/role metadata available for child discovery.
- `cantrip_worker/src/codex/provider-config.ts`: generated runtime feature and agent configuration.
- `cantrip_worker/src/codex/app-server.ts`: launch arguments, active-turn ownership, notification routing, child recovery, interaction routing, and activity normalization.
- `cantrip_worker/src/codex/customization.ts`: advertised native-subagent capability.
- `cantrip_worker/src/chat-message-encryption.ts`: protected child messages, activities, and idempotency.
- `packages/protocol/src/index.ts`: model configuration, chat/default state, worker commands, public event envelopes, and activity schemas.
- `packages/protocol/src/communication-content.ts`: protected content and agent-scope classification.
- `cantrip_server/src/db/schema.ts`: chat and user-settings migration; existing encrypted chat-message storage.
- `cantrip_server/src/db/repository.ts`: new-chat default copying, atomic configuration updates, queued-turn snapshots, and removal of chat-to-profile reasoning side effects.
- `cantrip_server/src/app.ts`: atomic API, route-pair validation, worker command construction, capability checks, and continuation filtering.
- `cantrip_app/src/lib/api.ts`: atomic model-configuration client mutation.
- `cantrip_app/src/components/chat/model-reasoning-picker.tsx`: shared root/subagent configuration dialog.
- `cantrip_app/src/components/settings/settings-page.tsx`: account default entry point.
- `cantrip_app/src/App.tsx`: composer state, queued prompts, panel host, and mutually exclusive sidebar state.
- `cantrip_app/src/components/chat/activity.tsx`: subagent lifecycle and communication cards.
- `cantrip_app/src/components/chat/agent-inspect-panel.tsx`: shell to generalize into an inspect/subagent panel host.
- `cantrip_app/src/components/chat/trajectory-model.ts`: agent-scoped projection, segments, ordering, and filters.
- `cantrip_app/src/components/chat/trajectory-timeline.tsx`: dynamic tracks, labels, height, and internal scroll.
- `cantrip_app/src/components/chat/agent-trajectory.tsx`: agent filters and event-to-panel navigation.
- `docs/ENCRYPTION.md`, `docs/TRAJECTORY.md`, and `docs/CODEX_RUNTIME_COMPATIBILITY.md`: security, capture, and pinned-runtime contracts that must stay synchronized.

## Fix Approach

Implement sequentially. Every cycle uses a fresh branch/worktree from current `origin/main`, one focused PR, squash automerge, primary checkout fast-forward, and worktree cleanup before the next cycle.

### Cycle 1 — Contracts and durable model configuration

- Add `ModelConfiguration`, effective-inheritance helpers, and optional agent-scope/activity protocol fields.
- Migrate user settings and chats with backward-compatible defaults.
- Copy the full default configuration when creating a chat.
- Snapshot it into queued prompt/turn state.
- Add repository helpers for atomic read/update and remove the chat-reasoning mutation's account/profile side effect.

Light checks: protocol schema tests, migration/default fixture, and repository tests for new/existing chat initialization.

### Cycle 2 — Atomic API and paired route resolution

- Add the atomic chat model-configuration API and settings validation.
- Resolve root/custom-child routes as a compatible pair on the same provider identity.
- Return structured, actionable failures for unsupported reasoning, unavailable workers, and incompatible provider routes.
- Carry the resolved provider-native child defaults in the worker turn command.
- Keep legacy model/reasoning endpoints compatible during transition.

Light checks: focused API tests for inheritance, valid pair, invalid pair, and stale worker availability.

### Cycle 3 — Shared model configuration UI

- Convert `ModelReasoningPicker` into the shared dialog with root and conditional custom-child controls.
- Remove the composer brain button.
- Save the chat configuration atomically and make it read-only while runtime changes are unsafe.
- Replace Settings' default model select with `Default model configuration` using the same dialog.
- Ensure new-chat UI state reflects the server-created defaults rather than maintaining a divergent client default.

Light checks: component/state tests for custom off/on, retained inactive values, cancel/save, and settings reuse; one manual desktop/mobile layout pass.

### Cycle 4 — Native runtime enablement

- Explicitly enable native agents without proactive delegation.
- Apply custom child defaults only when configured; otherwise preserve native inheritance.
- Generate a Codex model catalog containing both resolved root and child models.
- Advertise a versioned worker capability so server and UI can gate the feature.

Light checks: worker launch-argument/config tests and one native inherited/custom spawn smoke fixture.

### Cycle 5 — Child execution ownership and interactions

- Introduce `RootExecution` and per-thread `AgentRuntimeState` indexes.
- Consume child thread/status/turn/item notifications and distinguish root from child completion.
- Correlate nested paths and reused agents to the correct root-turn segment.
- Route child approvals and input requests through the owning root interaction channel.
- Bound cleanup on completion, interruption, disconnect, and worker shutdown.

Light checks: synthetic root + child + nested fixtures, child-completion isolation, interaction routing, and cleanup.

### Cycle 6 — Encrypted persistence and recovery

- Seal agent scope, communications, child message/activity content, and raw detail through the existing encrypted path.
- Add scoped idempotency and preserve only minimal public operational metadata.
- Recover missed child turns through Codex thread reads/listing and reconcile them idempotently.
- Exclude child-only records from root continuation prompt reconstruction.
- Extend retention/deletion/export paths to cover the opaque records automatically.

Light checks: encryption round trip, recovery replay, duplicate delivery, root continuation filtering, and an explicit assertion that private child text is absent from plaintext DB rows/log fixtures/live metadata.

### Cycle 7 — Chat cards and read-only panel

- Add the shared `AgentTurnProjection`.
- Render one updating lifecycle/communication card per root-turn agent.
- Generalize the right sidebar state to `inspect | subagent | subagent-root` and implement the read-only child stream and root overview.
- Add parent/child navigation, event focus, status, and mobile overlay behavior.

Light checks: projection ordering/deduplication, panel replacement, absence of controls, and nested navigation.

### Cycle 8 — Multi-agent trajectory

- Scope trajectory intervals/events to an agent.
- Render one multicolor track per agent with root pinning and stable descendant ordering.
- Add flattened indentation, dynamic height, five-row internal scrolling, and agent filters.
- Connect event selection to the child sidebar while retaining existing zoom/playhead behavior.

Light checks: projection and ordering tests plus manual views for one, five, many, and nested agents.

### Cycle 9 — Compatibility and focused hardening

- Exercise a complete inherited-model turn, custom same-provider turn, nested delegation, handoff/follow-up, child interaction, reconnect recovery, and failure/interruption.
- Verify older worker capability fallback and mixed-version protocol behavior.
- Update encryption, trajectory, and runtime compatibility documentation.
- Remove compatibility adapters only if all supported clients/workers have moved to the atomic contract.

Light checks: package-focused checks/builds and `git diff --check`; use the repository-wide check only where the final integration risk justifies it.

## Acceptance Criteria

- Native subagent tools are enabled for compatible chats by default without making delegation proactive.
- A new chat receives the complete account default model configuration.
- The composer has one model control and no separate reasoning brain button.
- The same dialog edits a chat and the account default, with correct inherited/custom behavior and atomic saving.
- Custom child configuration is rejected before a turn when no same-provider route pair is available; it never silently falls back.
- Root and child runtime model slugs are both available in the generated Codex catalog.
- Child, nested-child, and reused-child notifications attach to the correct root execution and root-turn segment.
- Child completion cannot complete the root turn, and child interaction requests reach the existing approval/input UI.
- The main chat shows deduplicated lifecycle/communication cards rather than dumping the child transcript inline.
- Clicking a child card or trajectory event opens a read-only full-turn sidebar and replaces the prior right panel.
- The sidebar exposes no chat, stop, steer, or direct-control surface.
- The trajectory renders one multicolored track per agent, pins root first, preserves descendant first-appearance order, indents nested agents, scrolls after five rows, and offers per-agent filters.
- Private child prompts, handoffs, reasoning, commands, paths, results, nicknames, and role labels remain encrypted in storage and transport outside the authorized worker/client boundary.
- Server logs, public event metadata, search indexes, analytics, and root continuation prompts do not leak or misclassify child content.
- Disconnect/restart recovery reconstructs the best available child view without duplicate activities or server decryption.
- Existing non-subagent chats, inspect UI, trajectory behavior, approvals, and encrypted-message flows continue to work.

## Validation Plan

Keep validation focused on the new boundaries rather than building a large new harness:

- protocol and migration fixtures for backward compatibility;
- server route-pair and atomic-update cases;
- worker notification fixtures for root, child, nested child, approval, completion, and recovery;
- encryption round-trip and plaintext-leak assertions;
- app projection/component checks for dialog inheritance, lifecycle deduplication, panel restrictions, track ordering, filtering, and scrolling;
- one manual end-to-end pass with inherited configuration and one with a same-provider custom child model.

Each PR runs the smallest relevant package checks plus `git diff --check`. The final hardening cycle runs the broader repository checks that are practical for the touched packages.

## Risks / Gotchas

- Native children inherit the parent provider. Treating catalog-level model compatibility as sufficient would allow configurations the runtime cannot start.
- Provider route availability can change after the dialog saves. Static UI filtering improves guidance but cannot replace turn-start validation.
- Mapping child events into the root `ActiveTurn` without per-thread state can settle the wrong promise or corrupt activity correlation.
- A native child may be reused across communications or root turns. Presentation keys must include `rootTurnId`, while runtime ownership still follows the stable child thread ID.
- `thread/started` may arrive before or after the parent's collaboration item. Association must tolerate either order and reconcile later metadata.
- Recovery may not contain every transient handoff. The UI should show honest structural gaps rather than fabricated content.
- Adding plaintext agent labels or task summaries to make server filtering easier would violate the encryption boundary. Agent filtering must be derived client-side after decryption.
- Public operational IDs can still be sensitive when combined. Keep the envelope minimal, apply existing authorization, retention, and audit rules, and avoid logging them unnecessarily.
- Independent model/reasoning mutations create invalid transient states. The UI and server must use one atomic configuration mutation.
- Hiding custom controls must not erase the user's prior custom choices, while runtime resolution must ignore those inactive values.
- Older workers must be capability-gated. Sending unknown agent defaults and assuming partial behavior would create silent divergence.
- A vertically scrolling trajectory must preserve horizontal alignment and avoid intercepting page scroll unexpectedly on touch devices.

## Open Questions

None block the initial implementation. Cross-provider custom subagents are deliberately deferred until native Codex supports a child provider override or Cantrip introduces a secure cross-runtime child routing design.

## Out of Scope

- Automatically or proactively deciding to spawn subagents.
- A writable child composer, direct stop/steer controls, or child-specific approval policy.
- Cross-provider or cross-account child routing in the initial release.
- User-authored agent roles/personas beyond metadata already supplied by native Codex.
- A plaintext server-side child transcript, server-side semantic indexing of child content, or decrypted analytics.
- Live migration of an active native child between workers.
- Replacing the existing encryption key hierarchy or chat retention model.
