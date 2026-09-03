# Standalone Chat mode

- Status: Implemented product contract
- Last updated: 2026-08-25
- Related contracts: [Codex-native customization](CODEX_NATIVE_CUSTOMIZATION.md),
  [encryption](ENCRYPTION.md), [multi-worker placement](MULTI_WORKER_ARCHITECTURE.md),
  [project network shares](PROJECT_NETWORK_SHARES.md), and
  [agent interactions](AGENT_INTERACTIONS.md)

## Purpose

Cantrip has two top-level product modes:

- **IDE** is the existing project and workspace experience. It contains
  project Agent chats, Tasks, terminals, Explorer, Code, Git, Browser, Remote
  Desktop, and the other project surfaces.
- **Chat** is a standalone conversation experience similar to a conventional
  AI chat application. It uses the same account, models, worker-hosted Codex
  harness, encrypted history, attachments, context meter, streaming, and
  permission system without placing the conversation inside an IDE project.

Chat is not another workspace, project type, project tab, or filtered view of
project Agent chats. A Chat conversation is always standalone. Existing and
future project Agent chats never appear in the Chat sidebar, and standalone
Chat conversations never appear in an IDE project's surface list.

Each standalone conversation receives private scratch space on one worker.
Codex can use its built-in shell and file tools there to compile programs,
download data, transform files, and perform other ordinary agent work. The user
can inspect and manage those files from a lightweight Chat file surface without
opening Cantrip Code.

This contract deliberately keeps standalone and project chats close at the
message, runtime, and encryption layers. A later feature may move or link a
standalone conversation to a project, but no conversion, linking, project
visibility, or project creation flow is part of this implementation.

## Final product decisions

- The user-facing product label is **Chat**.
- Chat mode lists standalone conversations only.
- Chat conversations continue to execute through the selected worker's Codex
  harness.
- A worker must be online to create a Chat conversation or send a message.
  Server-owned history remains readable while its worker is offline.
- Every Chat conversation has its own persistent worker-owned scratch folder.
- Chat receives the managed Cantrip MCP standalone web profile, containing
  exactly `tool_help`, `web_search`, and `web_read`. Managed CodeGraph remains
  absent.
- Codex's built-in shell, file, and other non-collaboration tools remain
  available subject to the selected permission profile and approvals. Hosted
  native web search is disabled in favor of managed Cantrip search.
- Native subagents are disabled at the runtime and protocol layers, not merely
  hidden in the app.
- Chat has no Plan mode, Goal mode, linked Codex console, Inspect, Trajectory,
  State panel, subagent view, GitHub references, project
  commands, or per-chat customization inventory.
- Prompt queueing, steering, pause/resume, stop, edit-and-retry, forking,
  archiving, and attachments remain available.
- Model and reasoning selection, provider availability, permission selection,
  approvals, and the context ring remain available.
- MCP servers, Policies, and Skills receive an `IDE`, `Chat`, or `Both`
  audience. Existing, imported, and newly proposed entries default to `IDE`.
- Chat has separate account defaults for model/reasoning and permission
  profile. Until explicitly overridden, its model/reasoning defaults inherit
  the account's existing general defaults. Its initial permission default is
  `Workspace`, rooted only at the Chat scratch folder.
- Top-level mode and last destination are synchronized in account settings.
- With no prior navigation state, Cantrip opens IDE when at least one project
  exists and opens Chat when no projects exist.
- Archived Chat conversations follow the existing 90-day recovery window.
  Their scratch folders remain intact until permanent purge is confirmed.

## Goals

1. Let Cantrip serve as both a complete IDE and a general AI chat application
   without weakening the existing app/server/worker boundary.
2. Reuse the proven encrypted chat, provider, attachment, streaming, queue,
   and approval paths instead of building a second conversation stack.
3. Give standalone Codex sessions useful, isolated filesystem space while
   keeping raw worker paths and file bytes out of durable server storage.
4. Make the Chat experience visibly and operationally simpler than an Agent
   chat inside a project.
5. Reduce default Chat prompt/tool overhead by excluding IDE-only MCP servers,
   Policies, Skills, CodeGraph, project-only Cantrip tools, and native
   collaboration tools.
6. Preserve a clean future path from a standalone conversation to an explicit
   project context without implementing that transition now.

## Non-goals

- Aggregating project Agent chats into the Chat sidebar.
- Showing standalone conversations inside IDE workspaces or projects.
- Giving a Chat access to an existing project, repository, worktree, GitHub
  issue, pull request, GitHub Actions run, Run configuration, terminal, Explorer, Code,
  Browser, Remote Desktop, or project network share.
- Converting, linking, copying, or promoting a Chat into a project.
- Creating a project from a Chat.
- Plan or Goal mode.
- Tasks, automations, or autonomous Goal continuations in Chat mode.
- Native subagents or any Cantrip-specific replacement for subagents.
- A linked Codex console or raw CLI switch-view.
- Inspect, Trajectory, State, or protected raw diagnostics UI.
- A per-Chat customization inventory, MCP OAuth panel, MCP resource browser,
  Skill picker or slash-command palette.
- Filtering Codex's remaining built-in shell/file tool set beyond existing
  permission behavior.
- A full embedded Code workspace for scratch files.
- Moving an existing Chat to another worker in the first implementation.

## Terminology and domain model

The existing `experience` field continues to distinguish ordinary Agent chats
from Task-backed chats. A separate context discriminator identifies where an
Agent chat executes:

```text
experience:  "agent" | "task"
contextKind: "project" | "standalone"
```

Valid combinations are:

| Experience | Context      | Product surface |
| ---------- | ------------ | --------------- |
| `agent`    | `project`    | IDE Agent chat  |
| `task`     | `project`    | IDE Task        |
| `agent`    | `standalone` | Chat            |

`task + standalone` is invalid. “Chat” in product language means the last row;
“project chat” or “Agent chat” means the first row when a distinction is
needed.

Shared code should consume a discriminated `ChatSummary` and
`ChatExecutionContext`, not a collection of independently nullable project and
scratch fields. Project-only code must narrow to `contextKind === "project"`
before accessing project, worktree, policy-assignment, Git, Code, or relocation
state.

## Application shell and navigation

### Top-level mode switch

The main, non-pop-out app window owns an explicit top-level mode:

```text
AppMode = "ide" | "chat"
```

In IDE mode, a **Chat** button appears above the workspace selector. Selecting
it replaces the project sidebar and project content region with the Chat
sidebar and conversation surface.

In Chat mode, an **IDE** button occupies the equivalent stable position.
Selecting it restores the last valid IDE project and surface. Switching modes
does not stop running turns, clear drafts, discard selection, or move a
conversation.

Desktop pop-outs and explicit project deep links always resolve to IDE mode.
The Chat mode switch is available in the primary window, browser app, and
Capacitor app. It is not a project tab and does not participate in tab groups
or desktop group pop-outs.

### Account-synchronized destination

Account settings persist:

```text
lastAppMode: "ide" | "chat" | null
lastIdeProjectId: string | null
lastIdeWorkspaceId: string | null
lastStandaloneChatId: string | null
```

Explicit mode, workspace, project, and Chat selections update these settings.
The values intentionally synchronize across desktop, browser, and mobile
clients for the same account and server. The most recently committed selection
wins. A client applies ordinary live-settings reconciliation without changing
the currently visible destination in the middle of an active interaction; the
synchronized destination is authoritative on its next bootstrap or explicit
root navigation.

Startup resolution is deterministic:

1. An explicit deep link or desktop pop-out target wins and opens IDE.
2. A valid saved `lastAppMode` and destination are restored.
3. If the saved Chat was archived or deleted, Chat mode opens its empty/home
   state rather than selecting an unrelated conversation.
4. If the saved IDE project was removed, Cantrip chooses the first visible
   project in the saved/default workspace.
5. With no saved state, IDE opens when any project exists.
6. With no projects, Chat opens, including on a first-time mobile or web
   client.

Deleting the last project does not create a project automatically; the main
window falls back to Chat. Creating the first project does not forcibly switch
an actively used Chat session into IDE.

### Chat sidebar

The Chat sidebar contains:

- a New Chat action;
- active standalone conversations ordered by their durable Chat position;
- running, waiting, offline, failed, and unread-completion states;
- rename, fork, archive, and delete actions consistent with existing chat
  semantics;
- an archived-conversation entry point with the existing recovery countdown;
- account/server/settings controls already appropriate at the root shell; and
- the IDE mode switch.

It does not show workspaces, projects, Tasks, project tab groups, worktrees,
terminals, Explorer trees, Git state, Code, Browser, or project creation
controls.

Chat selection is a single content destination. Standalone conversations do
not receive project tab-layout or tab-group rows.

## Conversation feature contract

### Included features

The Chat conversation reuses:

- end-to-end encrypted user, assistant, commentary, activity, and system
  messages;
- incremental streaming and reconnect recovery;
- Markdown, syntax highlighting, image display, and copy actions;
- drag, paste, and picker attachments, including large-paste handling;
- model and reasoning selection;
- provider route fallback and account usage display;
- the context ring and compaction state;
- permission profile selection and protected interaction approvals;
- prompt queue ordering, editing, freezing, removal, and steering;
- pause, resume, and stop;
- editing/retrying the latest eligible user turn;
- conversation fork, rename, archive, restore, and permanent deletion;
- persistent composer drafts; and
- offline-readable server-owned history.

Forking a Chat creates another standalone Chat with its own new scratch folder
on the selected/default worker. Conversation history is copied through the
existing protected fork semantics; scratch files are not copied in the first
implementation.

### Excluded features

The Chat surface does not render or offer:

- Default/Plan/Goal mode selection; every Chat prompt uses normal default
  conversation mode;
- custom root/subagent model controls;
- Skills or slash-command pickers in the composer;
- saved project commands;
- `#issue` or pull-request reference completion;
- worktree controls or relocation;
- open-in-Terminal, open-in-Explorer, open-in-History, or project file actions;
- linked console controls;
- Inspect, Trajectory, State, or subagent panels;
- per-turn “View trajectory” actions;
- per-Chat customization inventory or OAuth/resource controls; or
- Code editor synchronization and dirty-editor turn preparation.

Audience-enabled Skills may still be supplied to Codex as runtime
customization. “No Skills” in the Chat UI means there is no discovery picker,
explicit `$skill` composer experience, or per-Chat management surface. The
settings-level audience controls remain the authority for whether a Skill is
available to the runtime.

### Shared composition boundary

`ChatTranscript` is split into controller and view components and accepts one
cohesive capability profile:

```text
ChatSurfaceCapabilities
  context: project | standalone
  modes: default-only | agent-modes
  inspect: boolean
  linkedConsole: boolean
  subagents: boolean
  projectReferences: boolean
  projectCommands: boolean
  customizationInventory: boolean
  scratchFiles: boolean
```

`cantrip_app/src/components/app/global-content-host.tsx` composes the same
transcript, composer, queue, attachments, interactions, and context meter for
standalone, project, and Task contexts with different capability profiles.
Capabilities are presentation aids only; server and worker contracts
independently reject forbidden standalone
operations.

## Chat files surface

### Files button and panel

Every standalone conversation shows a **Files** button in the top-right
conversation header. It opens a right-side panel containing a lazy file tree
rooted exclusively at that Chat's scratch folder.

Selecting a file leaves the tree in the Files panel and opens the content in a
deterministically named Tauri file window on desktop or a full-screen overlay
on browser and Capacitor. Text/source editing, structured visualization, media
preview, size limits, and conflict-safe saves are handled in that file surface.

This is not Cantrip Code and does not start or embed an OpenVSCode server. The
panel reuses Explorer read/write/preview primitives where safe, but all API and
worker authorization is rooted in the standalone Chat identity rather than a
project Explorer surface.

### File actions

Context menus provide:

- delete file or folder, with confirmation for recursive folder deletion;
- reveal in Finder or File Explorer;
- download file;
- download folder as ZIP; and
- download all Chat files from the panel header.

Reveal follows the existing desktop locality and network-share contract:

- Shift requests the physical path only when the desktop proves it owns the
  same local worker and exact root;
- otherwise desktop reveal uses an authorized network share; and
- browser/mobile clients do not receive a native reveal action.

Download actions appear only when the client is remote from the worker. “Local”
requires the existing cryptographic/locality proof used by desktop direct
surfaces; browser location, loopback addresses, names, and user claims do not
establish locality. A client without that proof is remote and may download.

Downloads stream from the worker through the authorized data plane. The server
does not persist file bytes. File, folder-ZIP, and all-files downloads require
bounded size, entry-count, path-depth, compression, rate, and concurrency
limits. ZIP creation rejects symlinks and path traversal and should stream from
temporary worker-owned staging that is removed after completion or failure.

Chat Markdown file links that resolve inside the scratch root use the same
desktop file-window or browser/Capacitor overlay behavior. They never resolve
arbitrary absolute worker paths.

## Persistence model

### Chats

Add direct owner identity and context discrimination to `chats`:

```text
ownerId: string
contextKind: "project" | "standalone"
projectId: string | null
activeWorktreeId: string | null
activeScratchRootId: string | null
```

Database checks enforce:

- project chats have a project and worktree and no scratch root;
- standalone chats have a scratch root and no project or worktree;
- Tasks are project-only;
- owner identity matches the project owner for project chats; and
- standalone chats use ordinary Agent experience only.

Backfill every existing chat from its project owner and mark it `project`.
Existing project routes and response shapes retain compatible defaults during
rolling deployment. New protocol shapes use a discriminated union so clients
cannot accidentally treat a standalone Chat as a partially loaded project.

### Standalone Chat scratch roots

Add a durable owner-scoped record, named here `standalone_chat_roots`, with at
least:

```text
id
chatId
ownerId
workerId
protectedPathHandle
status: provisioning | ready | offline | failed | deleting
provisioningRevision
deletionJobId
createdAt
updatedAt
```

The server stores an opaque worker routing handle, never a dereferenceable raw
path. A root belongs to exactly one Chat and worker. Existing Chats do not move
when the account Default worker changes.

Provisioning and deletion use durable, idempotent jobs so a server crash or
offline worker cannot produce an acknowledged Chat with ambiguous scratch
ownership. A failed provision may be retried with the same Chat/root identity.

### Runtime sessions and execution lanes

`chat_runtime_sessions` and `chat_execution_lanes` gain the same root union:

```text
worktreeId XOR scratchRootId
```

The one-active-lane-per-chat invariant remains. Standalone roots are never
shared, so they do not participate in project worktree branch leases or
worktree transitions. Runtime identity still records the physical worker,
model route, provider account, Codex thread, status, and timestamps.

Attribution exposed to shared message code becomes a discriminated execution
root rather than pretending a scratch root is a worktree.

### Related project assumptions

Every owner check, interaction request, token/behavior telemetry record,
attachment placement, live event, archive query, runtime recovery path, and
log projection that currently requires `projectId` must accept the tagged
context. Standalone records use `projectId = null` where analytics schemas
already support it. Authorization derives from `chats.ownerId`, never from an
optional project join.

Project-only tables such as tab groups, worktree transitions, relocations,
Tasks, and linked terminals reject standalone Chat IDs.

## Account defaults

Extend account settings with:

```text
defaultChatModelId: string | null
defaultChatReasoningEffort: ReasoningEffort | null
defaultChatPermissionProfileId: PermissionProfileId
```

An unset Chat model/reasoning value inherits the current general default at
Chat creation time. This keeps existing accounts working without duplicating a
selection while allowing Chat and IDE defaults to diverge later. Each Chat
persists its selected model and reasoning exactly like an Agent chat, and the
composer can change either when the runtime is idle.

`defaultChatPermissionProfileId` is independent from the IDE default. Its
initial value is `:workspace`, interpreted against only the scratch root. A
user may deliberately choose Full access or YOLO for either context without
changing the other. Existing warning gates remain mandatory for YOLO.

New Chat placement uses Cantrip's existing account Default worker and
deterministic compatible online fallback. The first version does not add a
second “Default Chat worker” setting. With no compatible online worker, New
Chat is disabled with an actionable offline state.

## MCP, Policy, and Skill audiences

### Shared audience contract

Every user-managed MCP server, Policy, and Skill receives:

```text
audience: "ide" | "chat" | "both"
```

The UI labels these values **IDE**, **Chat**, and **Both**. Create, edit,
import, discovery-add, and template-instantiation dialogs expose the choice and
initially select IDE. Existing records migrate to IDE. Audience is explicit
server-visible control metadata because the server must filter content before
runtime dispatch; secret commands, URLs, environment values, Skill content,
and other currently protected fields retain their existing protection.

Audience filtering happens before effective-set name precedence, assignment,
decryption, runtime startup, tool discovery, or prompt construction. A record
that is ineligible for the current audience cannot shadow or otherwise affect
an eligible record.

### MCP servers

IDE turns receive MCP servers marked IDE or Both after ordinary global,
project, worker, enabled, and name-precedence rules. Standalone Chat turns
receive servers marked Chat or Both after ordinary global and worker rules.
Because a standalone Chat has no project, project-scoped MCP definitions are
not eligible even if their stored audience includes Chat. Keeping the audience
field on those rows preserves a future project-linking path without granting
project access now.

Managed `codegraph` is a hard-coded IDE-only system server. Managed `cantrip`
does not appear in editable audience controls: the worker injects its full
profile for IDE turns and its strict `tool_help`/`web_search`/`web_read` profile
for standalone Chat. User-managed servers continue to follow the audience and
scope rules above.

An audience change updates affected idle Codex threads through the existing
MCP rematerialization lifecycle. A running turn is not interrupted; its next
turn receives the new effective set.

Codex already supports per-MCP `enabled_tools` and `disabled_tools`, but custom
tool selection is not part of this implementation. Measure the effective
initial request after audience filtering, removal of managed MCP, and subagent
disablement before adding another configuration surface.

### Policies

IDE policy effectiveness retains the existing mandatory, workspace-assigned,
and project-assigned rules, then filters for IDE or Both.

An enabled Policy marked Chat or Both is effective for standalone Chats owned
by that account. Project/workspace assignment does not apply because a Chat has
no project. This makes the audience selection the explicit opt-in to applying
that Policy across standalone Chat conversations.

The standalone managed Cantrip profile does not expose `policy_read`.
Therefore its effective Policy bodies are supplied directly as bounded runtime
instruction context rather than summaries that point to an unavailable tool.
IDE policy behavior remains unchanged. Policy edits affect future turns and do
not interrupt an active turn.

### Skills

Settings-level Skill records and imported Skill metadata receive the same
audience. Standalone Chat runtimes receive only enabled global Skills marked
Chat or Both. Project-local Skills and project extra roots are ineligible
because the scratch context is not a project.

Chat exposes no Skill picker, `$skill` suggestion menu, Skill settings panel,
or per-Chat customization inventory. Audience-eligible Skills may still be
discovered and used by Codex according to native Skill behavior. Updates apply
to future turns through the existing runtime reload/discovery lifecycle.

## Worker scratch lifecycle

### Safe path derivation

The worker owns a dedicated manager analogous to `ManagedFolderManager`. It
derives a location such as:

```text
<worker-data>/chat-scratch/<lowercase-chat-uuid>
```

The manager:

- accepts canonical UUID identities only;
- creates its root and children with private permissions where supported;
- rejects symbolic links, non-directory targets, and paths outside the
  canonical scratch root;
- uses idempotent materialize, resolve, list, read, write, delete, archive,
  download, and package operations;
- protects returned path metadata through the worker routing registry; and
- never accepts a client-supplied deletion path.

Scratch space is persistent working data, not temporary attachment staging.
Attachments continue to use the existing worker-owned attachment store and are
not silently copied into the scratch root.

### Archive and permanent deletion

Archiving uses the current 90-day Chat recovery period. While archived:

- server history remains recoverable;
- the scratch folder remains intact;
- the worker records the archived state and projected expiry locally; and
- ordinary heartbeat or reconciliation does not repeatedly ask whether the
  Chat has been purged.

Restore clears the worker's cached archive deadline. Permanent deletion,
whether explicit or after retention expiry, creates a durable cleanup tombstone
before the server removes the Chat rows. That tombstone survives long enough
for an offline worker to reconnect, safely delete the exact scratch root, and
acknowledge completion. The worker may perform one due-time confirmation when
necessary, but must not poll the server continuously.

A root deletion failure is visible as a cleanup job requiring retry; it does
not restore the deleted conversation. Account usage reconciliation continues
to count retained scratch files until worker-confirmed deletion.

## Runtime and permission enforcement

### Standalone Codex profile

The server sends an explicit standalone capability profile with every Chat
runtime operation. The worker must not infer it merely because CodeGraph cannot
recognize the directory.

For standalone Chat, the worker:

- skips Cantrip Code preparation and agent-state notification;
- skips CodeGraph observation/preparation;
- injects managed Cantrip with exactly `tool_help`, `web_search`, and
  `web_read`, and omits managed CodeGraph MCP;
- opens only audience-eligible user MCP servers;
- loads only audience-eligible global Policies and Skills;
- sets `features.multi_agent=false` and `agents.enabled=false`;
- omits subagent defaults and `subagentProtocolVersion`;
- rejects child-agent lifecycle events as an incompatible runtime result;
- uses the scratch folder as `cwd` and the only normal workspace root; and
- retains Codex's built-in shell/file tools subject to permissions and disables
  hosted native web search in favor of managed Cantrip search.

The capability profile participates in `codexRuntimeId` or an equivalent
runtime cache key. An app-server process configured for an IDE Agent chat must
never be reused as a supposedly subagent-disabled Chat runtime.

The server also rejects standalone requests for Goal, Plan, Task, console,
worktree, relocation, customization inventory, project automation, and managed
Cantrip operations. UI gating is not an authorization boundary.

### Permissions

The existing permission-profile inventory and protected interaction pipeline
remain authoritative. `Workspace` means reads and writes inside the one Chat
scratch root. Full access and YOLO retain their existing broader semantics and
warnings. Read-only remains available.

Network and command approvals continue through protected interaction requests.
Standalone interaction records use Chat ownership and nullable project
provenance. An offline or disconnected client does not convert an approval into
implicit consent.

## API and protocol surface

The implemented route boundary is:

```text
GET    /api/chats?context=standalone
POST   /api/chats
GET    /api/chats/archived?context=standalone
POST   /api/chats/:chatId/restore
DELETE /api/chats/:chatId/permanent
DELETE /api/chats/:chatId

POST   /api/chats/:chatId/files/operation
```

The protected file-operation route accepts `list`, `read`, `write`, `remove`,
`download`, and `archive` intents. `DELETE /api/chats/:chatId` performs the
normal archive operation; permanent deletion remains a separate route.

Shared message, attachment, queue, steering, pause, interrupt, retry, fork,
model, reasoning, permission, draft, and archive operations continue under the
existing Chat identity after resolving its context.

The shared protocol adds:

- discriminated project/standalone Chat summaries;
- discriminated execution roots and attribution;
- standalone root provision/status/delete worker commands;
- bounded scratch file and download contracts;
- worker capability advertisement for standalone scratch and file operations;
- Chat account defaults and synchronized destination settings;
- MCP, Policy, and Skill audience enums; and
- standalone-aware live invalidation payloads.

Older workers advertise standalone Chat as unavailable. Older clients ignore
the new bootstrap capability and continue using IDE project chats. The server
does not dispatch standalone commands until the selected worker advertises the
complete required capability set.

## Live state and cache invalidation

Add an owner-scoped standalone Chat list subscription/invalidation family.
Creating, renaming, forking, status changes, unread completion, archive,
restore, purge, scratch provisioning, and cleanup status update the relevant
list without subscribing the client to every project.

Suggested client query keys are separate from project caches:

```text
["standalone-chats"]
["archived-standalone-chats"]
["standalone-chat-files", chatId, directory]
["standalone-chat-root", chatId]
```

Message, draft, queue, interaction, model, permission, and context usage keys
remain Chat-ID scoped and reusable. Audience mutations invalidate settings and
the affected effective runtime inventories. Account destination changes update
the settings cache without unexpectedly navigating an already interactive
window.

## Security and privacy

- The app still talks only to the server; it never opens an unauthenticated
  direct connection to a worker.
- Conversation text, attachments, drafts, queue entries, interactions, and
  private labels retain their current endpoint-encryption boundary.
- Raw scratch paths remain on the worker. The server stores only opaque routing
  handles and operational placement/status metadata.
- Scratch file bytes and generated ZIPs are streamed and never stored in the
  server database.
- Every file operation is rooted from the server-authorized Chat identity;
  clients cannot supply an arbitrary worker root.
- Symlinks, traversal, recursive deletion, archive bombs, unbounded previews,
  oversized downloads, and stale optimistic writes require explicit defensive
  handling.
- Audience is control-plane metadata. It reveals only where a configured
  object may apply, not its protected name, content, command, URL, or secrets.
- The standalone Cantrip profile means a Chat cannot reach project, worktree,
  client-focus, terminal, Browser, Run, Explorer, or interactive web-session
  operations through that tool boundary.
- Disabling subagents is enforced in Codex configuration and server protocol;
  hiding UI controls alone is insufficient.

## Future project transition seam

No transition UI or mutation ships in this implementation. The data model must
nevertheless avoid making it destructive later.

A future transition can:

1. create or select a project execution placement;
2. preserve the existing Chat ID, title, encrypted messages, attachments,
   model history, and fork relationships;
3. create a project runtime session and execution lane;
4. hydrate a new Codex thread from canonical server-owned conversation history
   using the existing relocation/import machinery;
5. explicitly decide whether scratch files are copied, attached, or retained;
6. change the context discriminator only after successful hydration; and
7. expose the resulting conversation solely in the IDE project.

The initial implementation must not create hidden projects, synthetic project
worktrees, fake project IDs, or implicit project access to simplify this future
work.

## Implementation milestones

Each milestone is independently reviewable and follows the manual-change
worktree, pull-request, and auto-merge protocol.

### Milestone 1: contracts and migration

- add context-discriminated Chat and execution-root schemas;
- add direct Chat ownership and standalone-root persistence;
- backfill existing chats as project context;
- generalize runtime sessions, lanes, interactions, and nullable telemetry;
- add account Chat defaults and destination settings; and
- advertise the server capability without enabling creation.

### Milestone 2: worker scratch lifecycle

- implement safe scratch materialization/resolution/deletion;
- add durable provision and cleanup jobs;
- add worker capability negotiation and opaque routing handles;
- add archive deadline/tombstone reconciliation; and
- validate path, symlink, restart, offline, and deletion behavior.

### Milestone 3: standalone execution

- resolve tagged Chat execution contexts;
- add standalone create/list/archive operations;
- run turns against scratch roots;
- skip Code, CodeGraph, worktree, relocation, and project policy paths;
- enforce default-only mode and disabled subagents;
- separate runtime cache identity; and
- preserve shared encrypted messages, attachments, queue, steering,
  interactions, retry, fork, and model routing.

### Milestone 4: audiences and defaults

- add IDE/Chat/Both to MCP, Policy, and Skill persistence and APIs;
- migrate every existing record to IDE;
- update create/import/discovery/template dialogs;
- filter before effective resolution and runtime dispatch;
- inject full bounded Chat Policy bodies without relying on Cantrip
  `policy_read`;
- load eligible global Skills without exposing a Chat Skill picker; and
- add separate Chat model/reasoning and permission settings.

### Milestone 5: application shell and shared Chat UI

- extract the reusable conversation component from `App.tsx`;
- introduce explicit IDE and Chat capability profiles;
- add the top-level mode switch and dedicated Chat sidebar;
- add account-synchronized destination restoration;
- implement desktop, browser, and mobile startup/fallback behavior; and
- remove every excluded IDE-only control from the standalone composition.

### Milestone 6: Chat files

- add the Files header action and right-side tree;
- reuse minimal Monaco, media, and visual previews;
- implement conflict-safe writes and guarded deletes;
- implement local reveal and remote-only download visibility;
- stream bounded file/folder/all downloads and safe ZIPs; and
- resolve in-chat scratch file links into the files panel.

### Milestone 7: lifecycle, compatibility, and measured audit

- complete 90-day archive/restore/purge and offline cleanup recovery;
- cover live invalidation, unread state, server restart, and worker reconnect;
- verify older client/worker capability gating;
- run desktop, web, iOS, and Android navigation/file QA;
- regress every existing project Chat and Task behavior; and
- measure initial request/tool-schema size before considering built-in or
  per-MCP tool filtering.

## Validation matrix

### Protocol and database

- existing project chats backfill without changing IDs, ordering, history, or
  runtime bindings;
- invalid context/root combinations fail schema and database checks;
- standalone ownership never depends on a project join;
- project-only mutations reject standalone Chat IDs;
- audience defaults and rolling-schema fallbacks are IDE-only; and
- account destination/default updates are owner-scoped and revision-safe.

### Server and worker

- create fails clearly without a compatible online worker;
- materialization is idempotent across retries and restarts;
- scratch roots cannot escape, traverse, or follow symlinks;
- a Chat can run shell and file work inside its scratch root;
- Workspace permission cannot write outside that root;
- Full/YOLO behavior and warnings remain unchanged;
- Chat turns receive only the three-tool managed Cantrip web profile and no
  CodeGraph MCP, project Policy assignment, project Skill root, or subagent
  tool;
- eligible Chat/Both MCP, Policies, and global Skills do reach the runtime;
- archive retains scratch content and restore cancels cleanup;
- retention purge eventually cleans an offline worker after reconnect; and
- server restart does not lose provision, archive, or cleanup state.

### App

- IDE and Chat switch without losing the last valid destination;
- account-synchronized startup behaves identically on desktop, web, and
  mobile;
- no-project first use opens Chat and existing-project first use opens IDE;
- Chat sidebar never includes project Agent chats or Tasks;
- standalone Chat never appears in a project sidebar or tab group;
- included composer/history/queue/archive features remain usable;
- excluded IDE controls are absent and forbidden APIs cannot be invoked;
- offline history is readable and send/new controls explain worker state;
- Files preview, edit, delete, reveal, remote download, folder ZIP, and
  download-all obey locality and limits; and
- screen-reader names, focus order, keyboard navigation, narrow layouts, and
  software-keyboard behavior remain accessible.

### Regression

- project Agent chats retain the full Cantrip MCP catalog, CodeGraph, Policies,
  Skills, worktrees, relocation, linked console, Inspect, Trajectory, and
  subagents;
- Tasks retain planning, finalization, Goal, scheduling, and activity surfaces;
- MCP project/global/worker precedence remains unchanged within the IDE
  audience;
- project Explorer, Code, network share, attachment, and file-link behavior is
  unchanged; and
- provider routing, encryption, usage telemetry, rate limits, and failover work
  for both contexts.

## Acceptance criteria

The feature is complete when:

1. Cantrip exposes stable top-level IDE and Chat modes on desktop, web, iOS,
   and Android.
2. Chat mode contains standalone conversations only and restores the
   account-synchronized last Chat destination.
3. A compatible online worker can create one isolated persistent scratch root
   per Chat and Codex can work inside it under the selected permission profile.
4. The shared transcript retains attachments, streaming, model/reasoning,
   context ring, queue/steer, pause/resume/stop, retry, fork, archive, and
   encrypted history.
5. Plan, Goal, Tasks, linked console, Inspect/Trajectory, project-only Cantrip
   tools, CodeGraph MCP, and subagents are unavailable in standalone Chat at
   both UI and runtime boundaries; its managed Cantrip catalog is exactly
   `tool_help`, `web_search`, and `web_read`.
6. MCP servers, Policies, and Skills honor IDE/Chat/Both, with every preexisting
   or imported item safely defaulted to IDE.
7. Chat and IDE have independent default permission settings, and Chat can
   override the inherited default model/reasoning configuration.
8. The Files panel provides bounded scratch browsing and file actions, while a
   desktop file window or browser/Capacitor overlay provides preview/edit,
   without starting Code.
9. Archive preserves scratch files throughout the 90-day recovery period, and
   permanent purge safely cleans online or later-reconnected workers without
   continuous polling.
10. Existing project Agent chats and Tasks pass focused and full regression
    validation without product or security-boundary changes.
11. The implementation contains no hidden project or fake-worktree shortcut
    and leaves the documented future transition seam intact.
