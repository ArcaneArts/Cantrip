# Cantrip: Full Project Description

This document is a compact, standalone description of Cantrip for an agent or
person who does not have the repository available. It combines the product
concepts from the README with the broader implemented feature set, architecture,
runtime rules, and repository conventions. Cantrip changes quickly; when this
document and source code disagree, source code and the narrower design documents
are authoritative.

## Executive summary

Cantrip is a local-first, self-hostable workspace for software development with
coding agents. It turns the open-source Codex CLI runtime into a persistent,
multi-surface application rather than treating an agent as a disposable terminal
process. A project can have agent chats, real terminals, a lazy file explorer
and editor, an embedded VS Code-derived workbench, browser and remote-desktop
sessions, tunnels, automations, and durable graph workflows. GitHub-backed
projects additionally provide Git/GitHub tooling, worktrees, replicas, and
relocation. The same project state is available from the Tauri desktop app,
browser, and mobile clients.

The product is split into three main runtime roles:

- **App:** React UI packaged for web, Tauri desktop, and Capacitor mobile. It
  never owns repository or agent execution and normally talks only to Cantrip
  Server.
- **Server:** authoritative control plane. It owns users, workspaces, projects,
  tabs, chat transcripts, model/provider configuration, encrypted credentials,
  scheduling, workflow state, worker enrollment, routing, and audit/telemetry.
- **Worker:** execution/data plane running near project files. It owns managed
  folders, repository checkouts, worktrees, Git processes, PTYs, Codex
  processes, Cantrip Code, browser automation, desktop capture/input, and local
  tool access.

In local desktop development these roles can run together on one machine, but
the architecture does not assume that. A hosted server can coordinate many
outbound-connected workers, and a logical GitHub project can have replicas on
multiple workers. A managed folder remains bound to one. Server state remains
inspectable while a worker is offline; runtime surfaces and source operations
clearly report that their worker is unavailable.

Cantrip's main design goals are:

- keep projects and execution under the user's control;
- make agent work durable, observable, steerable, and resumable;
- preserve normal Git repositories, worktrees, terminals, and files rather than
  replacing them with proprietary abstractions;
- support one-machine use without preventing hosted, multi-user, multi-worker,
  or multi-server deployments;
- centralize authority and policy on the server while keeping source and
  heavyweight execution on workers;
- require explicit review for destructive, privileged, or unattended behavior.

## Product mental model

### Core object hierarchy

The main user-visible and runtime objects are:

1. **Server profile** — a local bundled stack or a named remote Cantrip Server.
2. **Account/user** — the authenticated tenant principal on that server.
3. **Workspace** — a visual project filter/tag. Every account begins with a
   default workspace. A project may appear in multiple workspaces; this does not
   duplicate the repository.
4. **Project** — a logical GitHub repository or worker-managed folder plus its
   server-owned configuration and runtime surfaces.
5. **Project source** — one worker-local installation of a project. A managed
   folder has exactly one bound source; a GitHub project may have replicas on
   multiple workers.
6. **Execution root** — the concrete source directory. For GitHub projects this
   is a Git worktree inside a replica; for a managed folder it is the one
   UUID-derived folder root.
7. **Surface/tab** — Agent, Task, Terminal, Explorer, Code, Git, Browser, or
   Remote Desktop. A surface is bound to a project and, when required, its
   worker and execution root. Git is available only for GitHub projects.
8. **Agent chat/thread** — durable server transcript plus a Codex runtime lane
   on a worker. A thread may survive process restarts and, for GitHub projects
   at safe boundaries, relocate between compatible workers.
9. **Execution attempt** — one concrete provider route/account/worker/model
   attempt for a turn. Logical turns may fail over before side effects begin.

The server stores identity, configuration, and history. The worker stores
repository state and live runtime state. A placement record connects the two.

### Project creation and import

The project picker offers two explicit origins. Users can:

- create a new empty Cantrip-managed folder on a selected capable worker,
  without GitHub authentication;

- import an existing repository;
- create a new GitHub repository from Cantrip;
- choose a personal owner or organization;
- choose public or private visibility;
- set repository name and description;
- import an empty repository;
- assign the project to the current and additional workspaces.

For a managed folder, Cantrip creates
`<worker-data>/folders/<project-UUID>` and binds every filesystem-backed surface
to that worker. Names may repeat because they never determine the path. The
project has no Git, GitHub, worktree, replica, or relocation capabilities;
running `git init` does not change that. Project Settings can explicitly convert
it to a new or empty GitHub repository after a worker preflight and confirmed
initial commit when required.

For a GitHub origin, Cantrip provisions the repository on a suitable worker.
Both paths switch to the project, create an Agent tab, and open it when ready.
Projects can later be archived/restored without treating archival as source
deletion. Removing a managed folder defaults to unlinking; deleting its files
requires a checkbox and a second destructive confirmation.

### Workspaces

Workspaces are intentionally lightweight:

- they group/filter the projects shown in the sidebar;
- membership is many-to-many;
- the same project and runtime state are shared in every workspace where it is
  visible;
- users can create, rename, switch, reorder, and delete workspaces;
- users can choose which workspace is the account default;
- project creation defaults to the active workspace and can add more;
- a dedicated settings page edits membership across all projects/workspaces.

No model, Git, worker, or repository settings are duplicated per workspace.

### Tabs and windows

Project surfaces appear as sidebar rows and as top tabs. Tabs support:

- create, rename, delete, reorder, and drag/drop;
- middle-click close for actual tabs, but never for project rows;
- tab groups with a sidebar group row and a top member bar;
- split/group/reorder operations;
- one remembered active group member per window;
- popout into a separate Tauri window;
- single ownership/focus behavior so the same group is not ambiguously active in
  two windows;
- durable state for important surfaces, not merely React component state.

The project sidebar is collapsible/resizable. Desktop chrome integrates project
and surface controls into the Tauri titlebar to avoid wasting vertical space.
Mobile uses a dedicated compact navigation model rather than shrinking every
desktop control.

## Runtime architecture

### App

The main app is React 19 with Vite, Tailwind/shadcn-style components, Radix
primitives, TanStack Query, and TanStack Router. Platform shells are Tauri 2 for
macOS/Windows and Capacitor 8 for Android/iOS. The same feature-oriented React
code drives browser and packaged clients, with platform adapters for native
windowing, updates, local transports, credentials, and filesystem integration.

The app:

- renders server-owned state;
- subscribes to live invalidations and streaming activity;
- sends authoritative mutations through server APIs;
- attaches to worker-owned streams only through server-authorized transports;
- does not directly read repositories or launch Codex/Git/PTY processes;
- keeps optimistic UI bounded by server versions, placement, and conflict
  tokens.

### Server

Cantrip Server is a Fastify/TypeScript service using Drizzle and either embedded
PGlite for local operation or PostgreSQL for hosted operation. It owns:

- authentication and tenant boundaries;
- projects, workspaces, tabs, tab groups, and view state;
- workers, enrollment, capabilities, heartbeats, and placement;
- project origin/source/root kinds, setup and conversion jobs, replicas,
  worktree metadata, branch leases, and relocation state;
- chat transcripts, normalized Codex events, pending interactions, queues,
  goals, plans, and lifecycle state;
- providers, logical models, route/account priority, encrypted OAuth credentials,
  and access leases;
- quota, token, behavior, audit, and operations telemetry;
- schedules, automations, workflow definitions/runs, claims, budgets, and gates;
- GitHub-facing metadata and user-authorized control-plane actions;
- update metadata and the packaged local-stack update flow.

In a multi-server deployment, PostgreSQL remains authoritative and Redis carries
ephemeral routing, live invalidations, worker command/response correlation, and
binary/live-plane coordination. Redis is not the durable job queue or backup.
Server instances use leases/fencing for schedulers and workflow claims; WebSocket
stickiness can help efficiency but is not required for correctness.

### Worker

Cantrip Worker is a Node/TypeScript process. Workers enroll with the server and
connect outbound, so users do not need to expose worker control ports to the
internet. A worker advertises health/capabilities and executes authorized,
project-scoped commands including:

- materialize and exactly remove UUID-derived managed folders;
- clone/provision/synchronize/remove project replicas;
- discover/create/switch/release/remove Git worktrees;
- list/read/write files and calculate directory commit metadata;
- run bounded Git/GitHub operations;
- create and retain PTYs;
- launch/supervise Codex;
- host the browser-native Cantrip Code workbench;
- run Chromium browser profiles and stream frames/input;
- enumerate/capture/control desktop targets;
- provide project network shares and managed tunnels;
- run worker-local providers such as Ollama;
- relay logs and runtime activity to the server.

Workers do not communicate with one another directly. Cross-worker operations
are authorized and coordinated by the server. Workers keep source, terminal
output, browser state, and desktop capture local unless a feature explicitly
streams bounded data to an attached client.

### Protocol and live transport

The shared protocol package contains Zod-validated request, response, event, and
worker command contracts. HTTP endpoints provide authoritative snapshots and
mutations. A server-profile WebSocket carries invalidations, activity, worker
events, and live attachment coordination.

Live surfaces use a server-authorized transport abstraction:

- WebSocket relay is the universal fallback;
- the desktop app can use a short-lived, resource-bound local/direct capability
  when the selected worker is on the same machine;
- browser and Remote Desktop can negotiate server-signaled media/data paths
  where supported, with relay fallback;
- web/mobile clients never silently bypass server authorization;
- capabilities are scoped, short-lived, and bound to the exact surface/resource.

The system applies explicit limits to sessions, attachments, frame sizes, output
queues, and fanout so a live surface cannot consume unbounded server or worker
memory.

## User-facing feature catalog

The following surfaces make up the normal project workspace.

### Agent chats

An Agent tab is a durable coding-agent conversation backed by the bundled
open-source Codex runtime. Cantrip normalizes raw Codex events into a coherent
timeline instead of rendering terminal escape output as the product model.

#### Composer and turn controls

The composer supports:

- text prompts, file/image attachments, and large-paste handling;
- logical model selection and reasoning-effort selection;
- one-message **Mode** attachment: Default, Plan, or Goal;
- slash commands and configured skills;
- per-chat permission/sandbox profiles;
- explicit warning-gated unrestricted/YOLO behavior;
- sending a new prompt, steering the active turn, or queueing later prompts;
- queue inspection, reordering, removal, and sequential advancement;
- pause-when-possible, resume, stop, and interrupt;
- context compaction;
- follow-up prompts without losing the durable transcript.

Pause is cooperative: it prevents queued prompts, goals, or other automatic work
from advancing after the current safe boundary. Resume continues the same
conversation/context rather than creating a blank thread. The pause control only
appears while an agent is active and sits beside the send/stop control.

#### Plan and Goal modes

Plan and Goal are selected for the next outgoing message rather than opened as
unrelated dialogs:

- **Plan mode** asks the agent to investigate and produce/maintain a structured
  plan. Questions are represented as durable pending interactions and do not
  disappear because the client temporarily disconnects.
- **Goal mode** creates a persistent objective that can advance through multiple
  turns/cycles, report budget/progress, and stop only when complete, blocked
  under the defined rules, paused, or cancelled.
- The mode selection travels with the message and is visible consistently in the
  Cantrip UI and linked Codex console/runtime.

#### Timeline rendering

The transcript can show:

- user and assistant messages;
- plain latest reasoning/thought text without requiring a “Reasoned” expansion;
- shell commands, tool calls, patches, file changes, approvals, and subagent
  activity;
- structured plans and plan updates;
- rate-limit/provider events and failover/reconnect status;
- compact “tokens · duration” metadata after message actions rather than noisy
  standalone completion rows;
- failures with the underlying normalized runtime error;
- per-event provenance/source details when expanded.

Cantrip preserves the distinction between commentary, reasoning summaries,
tool/runtime activity, and final answers while presenting them as one turn.
Copying and forking are available at useful message boundaries.

#### Durable interactions and approvals

Runtime questions are stored as explicit server records:

- command/file approvals;
- temporary or persistent permission grants;
- structured request-user-input questions;
- MCP elicitation requests;
- approval expiry, interruption, denial, and resolution provenance.

The app resolves these records through the server; it does not write an answer
straight into a Codex process. Resolution is idempotent and bound to a runtime
attempt. Sensitive answers are redacted/bounded. On recovery the system fails
closed rather than guessing that a previously pending privileged action was
approved.

#### Agent Inspector

Each chat has an optional resizable right-side **Inspect** panel. New chats start
collapsed and the open/width state is remembered per chat for the application
session. When inactive it says that activity will appear while the agent works.
While active it shows a live operational view:

- the most recent agent thought/commentary, retained while commands/files change;
- files changed in roughly the last ten seconds;
- a best-effort latest changed line based on Codex patch/filesystem events;
- add/modify/delete state and animated line progression;
- running command cards after they have lasted at least one second;
- command, elapsed stopwatch, streaming output, and exit state;
- a rolling latest 256 KiB per command with an explicit truncation marker while
  continuing to retain new output;
- up to three commands sharing available height; four or more become a
  longest-running-first scrollable stack;
- recently completed micro-commands near the file activity for about three
  seconds before fading away.

This is observation of events Codex/worker already emits, not invasive
token-by-token filesystem interception.

#### Lifecycle, forks, and consoles

Chats can be renamed, duplicated, and forked from a message. GitHub-backed
chats can also bind to a different worktree according to safety rules; managed
folder chats stay on their fixed execution root. The structured chat view can
switch to its linked live Codex terminal/console. If the user opens the console
before sending the first message, Cantrip initializes the CLI with the model
currently selected in the composer. Switching views does not create a different
conversation.

On macOS and Windows, Cantrip can discover local Codex/ChatGPT CLI histories and
import them as resumable forks. Import preserves source attribution without
claiming ownership of the original history.

### Tasks

A Task is a specialized durable Chat experience for planning and completing a
large job without inventing a second agent runtime. It uses the same project,
execution-root/worker placement, Codex thread, transcript, attachments,
Inspector, console, permission profile, tab grouping, pop-out, and archive
lifecycle as an Agent Chat. Relocation is inherited only when the project
supports it. Only Task-backed Chats show the compact Task/Chat view toggle; the
Chat side exposes the underlying transcript.

The Task side moves through durable draft, planning, review, finalizing,
implementing, paused, blocked, complete, and recoverable failure states:

- The draft is a full-content Markdown editor with rename, attachment
  drag/drop/paste, model/reasoning controls, Implementation access selection,
  autosave, and optimistic conflict handling.
- Planning and finalization always use a server-selected read-only execution
  profile, regardless of Implementation access. Codex can inspect project
  files, available Git state, attachments, and effective Policies, but cannot
  mutate files, Git, GitHub, or side-effecting external tools.
- A structured planner result replaces one server-owned Markdown plan and up to
  twelve bounded questions with options, recommendations, required/freeform
  behavior, saved answers, and optional overall direction.
- Review supports repeated Continue Planning rounds and a revision-safe Monaco
  Edit Plan flow. The durable planning-round history retains correlated inputs,
  outputs, messages, execution lane, turn, and bounded failure state.
- Begin Implementation performs one structured finalization, freezes an
  immutable final plan and Goal prompt, and idempotently starts one Goal on the
  same Chat. Effective Policy summaries and CLI policy-read instructions shape
  the objective without copying Policy bodies into Task state.
- The implementation dashboard shows Goal status, elapsed time and token use,
  cooperative pause/resume/stop controls, active execution-root/worker state,
  available Git branch/dirty state, live Inspector activity, immutable plan,
  generated objective, available Task-associated GitHub pull requests, and
  advisory workflow warnings.

Task state is server-authoritative and tenant-scoped. Row versions prevent
cross-window draft/plan overwrites; operation and Goal-start keys prevent
duplicate planning rounds or Goals after retries/restarts. Draft attachments are
included in cross-worker relocation snapshots when relocation is supported,
even before a transcript message references them. A worker outage leaves every
artifact readable and retryable.
Archiving preserves the Task and restores the Task view; permanent deletion
cascades Task-only rows. Forking its transcript creates a normal Agent Chat.
See [TASKS.md](TASKS.md) for the complete contract and acceptance criteria.

#### Codex customization

Project/global customization surfaces expose capabilities supported by the
installed Codex App Server, including:

- skills and extra skill roots;
- MCP servers/resources/OAuth;
- hooks;
- collaboration modes;
- thread goals;
- supported native agents/custom agents where the runtime contract allows them.

Capabilities are negotiated rather than inferred from a CLI version. Unsupported
or development-only APIs are shown as unavailable instead of being invoked
optimistically.

### Policies

Policies are reusable, owner-scoped Agent instructions stored by Cantrip Server
rather than copied into repository files. Each policy has a stable CLI key,
name, compact Agent-visible summary, full Markdown body, Enabled and Mandatory
flags, global sort position, optional packaged-template provenance, and
optimistic row version.

Root **Settings → Policies** is the only policy-authoring surface. It supports:

- search and a flat, divider-based ordered list;
- pointer and keyboard sorting;
- blank creation or copying the packaged Manual Change Protocol template;
- Markdown edit/preview with bounded name, key, summary, and body fields;
- enable/disable and user-controlled Mandatory scope;
- assignment counts, template/custom provenance, reset confirmation, and
  assignment-aware deletion confirmation;
- optimistic conflict handling so another Settings window cannot silently
  overwrite a newer edit or order.

The packaged template catalog is immutable server distribution data. On the
first Policy bootstrap for an owner, Cantrip copies the Manual Change Protocol
template into one independent editable policy, enables it, and marks it
Mandatory. A durable bootstrap marker makes this exactly-once: deleting the
copy does not recreate it, and the packaged template remains available.

Nonmandatory policies can be assigned to workspaces and projects. Effectiveness
is:

```text
enabled AND (mandatory OR directly assigned OR inherited from any workspace)
```

A project in several workspaces receives the union. One policy row shows all
effective sources—Mandatory, named workspaces, and direct project assignment—
without duplication. Disabled policies retain assignments but stop applying.
Workspace and Project Settings expose assignment controls and inherited-source
labels; creation and content editing link back to root Settings.

Every centralized Agent turn construction path resolves the current effective
set before dispatch. Ordinary, Plan, Goal, queued, automation-delivered, and
automatic-continuation turns receive one application-owned context value
containing ordered keys, names, and summaries. Bodies, IDs, revisions,
timestamps, and assignment internals are excluded. The context is limited to
64 effective policies and 32 KiB of UTF-8 data; overflow rejects the whole turn
with an actionable error rather than truncating an arbitrary tail.

The Rust CLI exposes `cantrip policy list` and
`cantrip policy read <policy-key>`, including global `--json` output. It
uses the normal thread, terminal, or working-directory context resolver and
authenticated worker broker, but the server performs the owner/project lookup.
List output is body-free; read returns the current full Markdown only when the
key is effective in that project. There are no policy mutation commands for
Agents.

Policy mutations publish owner-scoped live invalidations for root lists,
details, workspace/project assignments, and effective queries, so independent
Settings windows naturally refetch. Summaries and bodies are explicitly
redacted from routine HTTP request logging. See [POLICIES.md](POLICIES.md) for
the complete product, security, and failure contract.

### Terminal

Terminal tabs are real worker PTYs, not command-output text areas. They support:

- interactive input/output and terminal resize;
- reconnecting to an already-running PTY;
- persistent tab identity across app navigation;
- worker/placement/offline status;
- stop/restart/delete lifecycle controls;
- the Cantrip CLI context for operating on the current project/worktree/surface.

A terminal can optionally be a durable **service terminal**:

- configure one command and enable service mode;
- start it whenever the owning worker is available;
- keep the PTY/process running even when no client is attached;
- restart an unexpectedly exited command after a five-second cooldown;
- reconnect later and see the still-running process;
- manually restart from the service sidebar;
- disabling service mode or deleting the terminal intentionally kills the
  process and prevents automatic restart.

Service configuration is server-owned; process supervision is worker-owned.

### Explorer and persistent file editor

Explorer is a Finder-style, worktree-aware file browser rather than a single
flat file list.

#### Browser

- lazy expandable directory tree in list mode;
- one TanStack query per expanded directory;
- collapsing removes children from the rendered tree but keeps query cache;
- directories sort before files with stable natural ordering;
- file sizes and responsive metadata columns;
- local Git status decorations derived from the already-fetched worktree status;
- asynchronous “last commit touching this entry” metadata;
- directories inherit the newest commit that touched a descendant;
- one streamed newest-first Git log walk resolves immediate visible entries,
  avoiding an N-files/N-Git-process pattern;
- graceful empty/unavailable commit metadata for non-Git folders and unborn
  branches;
- untracked/local-only entries remain visible;
- a 1,000-entry safety limit per directory with a clear truncation notice;
- refresh invalidates root, expanded children, history metadata, and Git status
  without eagerly loading the entire repository.

Commit enrichment handles spaces and rename history. Files appear immediately;
Git history hydrates independently so slow history cannot block filesystem
navigation.

#### File modes and editor

Selecting a file replaces the Explorer browser surface with a persistent
full-content file surface:

- files open in Preview by default;
- a compact eye/pencil-style mode menu switches Preview, Edit, or a supported
  structured/visual view;
- close-file control appears beside the Explorer/worktree title;
- Markdown supports rendered preview;
- source/text files use Monaco when editable;
- supported tabular/structured formats can provide visual editors;
- raw preview remains available when a visual parser cannot represent a valid
  real-world document;
- TOML parsing accepts actual TOML syntax, including quoted keys and dependency
  keys containing periods, rather than applying an overly restrictive
  identifier-only schema.

The editor remains mounted while switching tabs. Its draft, cursor, scroll
position, undo stack, selected path, and mode survive ordinary tab navigation.
The selected path/mode are part of durable Explorer view state and clear when
rebinding to a different worktree.

Saves:

- are explicit;
- use optimistic SHA-256 protection so a stale editor cannot silently overwrite
  an externally changed file;
- immediately invalidate worktree status so modified decorations update;
- retain dirty state across normal tab switching;
- prompt before destructive close/reload/rebind/delete operations;
- allow Save and continue or Cancel before a dirty desktop popout;
- cause the retained main window to refetch after the popped-out editor closes.

### Cantrip Code

The Code surface embeds **Cantrip Code**, a pinned VS Code-derived browser
workbench built and distributed with Cantrip. It is a full workbench for users
who prefer VS Code navigation/editing/extensions over the lightweight Explorer
editor.

Cantrip-specific behavior includes:

- worker prewarming so opening Code does not pay the full server startup cost;
- one project/worktree-aware workspace per surface;
- projects trusted by default; Workspace Trust prompts are disabled;
- the Cantrip-selected theme is forced at initial load and on theme changes;
- system/light/dark/high-contrast and desktop Pro appearance integration;
- opaque editor/terminal surfaces where partial transparency would cause
  flickering or unreadable background blending;
- “Command Palette” instead of an internal workspace UUID in the command center;
- AI Agent Chat and unnecessary onboarding UI hidden by default;
- noisy language-project configuration popups suppressed where safe;
- live reconnect and worker readiness state.

Cantrip Code is built from a pinned upstream source revision plus explicit
Cantrip patches/resources. Development validates that the built bundle matches
the pinned source so stale Code artifacts cannot silently ship.

### Git and GitHub workbench

The unified **Git** tab has top-level History, Issues, and PRs views. Issues and
PRs add compact Open/Closed switching and hydrate in 100-item pages as the user
continues through the list; repository histories are likewise bounded/paginated
rather than downloading every issue or commit.

#### Everyday Git

- worktree-aware status, branch, upstream, ahead/behind, fetch/pull/push;
- commit graph/history with refs, worktrees, author, time, subject, and hash;
- full commit inspector: message, author/committer, signature, refs, parents,
  children, stats, file list, and lazy patches;
- arbitrary A/B and merge-base comparison using commits, branches, tags, or
  worktree HEADs;
- create/switch/track/publish/rename/delete branches;
- upstream management and stale remote-branch pruning;
- fast-forward-safe pull behavior;
- remote inspection/editing with credential redaction;
- lightweight/annotated tags, signed tags, push/delete;
- GitHub releases: draft, prerelease, published.

#### Precise change control

- stage/unstage/discard whole files;
- stage/unstage/discard selected hunks or lines;
- preview tokens make a stale patch selection fail instead of hitting different
  content;
- commit, amend, fixup, cherry-pick ranges, and revert;
- merge-commit mainline selection where required;
- recoverable checkpoints around dangerous history operations.

#### Stash/shelf and operation state

- shelves for staged, unstaged, and untracked changes;
- apply, pop, branch from, drop, and clear;
- durable merge/rebase/cherry-pick/revert state;
- continue/skip/abort controls survive client refresh;
- conflicts remain recoverable rather than collapsing into a generic failure.

#### Conflict and history tools

- conflict resolver with base/ours/theirs/manual/delete choices;
- block-level diff3 where text is suitable;
- whole-file treatment for binary/oversized files;
- stale-preview protection;
- interactive history rewrite: reorder, reword, squash, fixup, drop;
- published-history protection and recovery refs;
- file history following renames;
- paginated blame;
- repository commit search;
- reflog/lost-commit inspection;
- recovery branches;
- soft/mixed/hard reset with checkpoint protections;
- durable bisect flows;
- submodule and Git LFS support;
- GPG, SSH, and X.509 signature visibility/operations where Git supports them.

#### GitHub collaboration

- Issues and PR lists with open/closed filters;
- issue/PR detail and bounded lazy hydration;
- create PRs from branches;
- PR commits/files/diff/checks;
- review state, comments, and inline review threads;
- close/reopen, mark ready, and merge/rebase/squash using GitHub permissions;
- PR-specific worktree checkout;
- no UI path that intentionally bypasses required GitHub protections.

Agent-assisted Git actions can draft summaries, commit messages, PR bodies,
reviews, conflict explanations, and check-failure explanations. Drafts remain
read-only until the user reviews and invokes a concrete Git/GitHub action.

### Browser

Browser tabs run worker-managed Chromium profiles. They support:

- saved project browser surfaces and named tabs;
- normal navigation, history, refresh, URL entry, and page interaction;
- worker-side Chrome DevTools Protocol screencast;
- server-authorized frame/input streaming;
- explicit clipboard transfer rather than implicit clipboard access;
- reconnect/crash recovery;
- worker placement and fleet service discovery;
- no debug “WebSocket stream” chip in the page viewport.

Browser profiles and processes can remain near the repository/tooling worker
while a desktop, browser, or mobile client views them remotely.

### Remote Desktop

Remote Desktop surfaces let a Cantrip client view and control monitors or
application windows exposed by an enrolled worker:

- enumerate targets across eligible workers;
- choose monitor/window and concrete worker placement;
- stream video/frames and send pointer/keyboard input;
- 15/30/60 FPS choices;
- adaptive, data-saver, balanced, and sharp quality modes;
- macOS/Windows permission/readiness diagnostics;
- reconnect and explicit offline/error state;
- bounded concurrent surfaces and attachments.

Capture and input remain worker-side. The server authorizes sessions and routes
metadata/signaling; it does not become an unlimited recording store.

### Tunnels and project network shares

#### Managed tunnels

Project tunnels expose an explicitly configured service from a worker through a
server/desktop-controlled endpoint. Saved tunnel definitions, target placement,
start/stop state, local listener information, and readiness are visible in
project/global settings. The control plane is authenticated; the binary data
plane is bounded and tied to the specific tunnel. Tunnels do not grant a client
arbitrary worker network access.

#### Network shares

Desktop clients can reveal/mount a remote worker project as a normal writable
network location:

- worker hosts a scoped WebDAV share on loopback with random credentials;
- server authorizes and coordinates the lease/transport;
- same-machine Tauri can use a direct local path; remote use relays safely;
- macOS mounts through its WebDAV facility;
- Windows mounts through its network-drive APIs;
- common OS metadata noise is filtered;
- credentials are kept in memory/redacted from logs;
- leases are bounded and cleaned up on lifecycle changes.

This complements Explorer/Code: users can use native Finder/Explorer and local
tools without making the server the repository owner.

## Worktrees, replicas, and multi-worker placement

This section applies to GitHub-backed projects. Managed-folder projects expose
one direct execution root on their owning worker and deliberately disable
worktrees, replicas, placement changes, and chat relocation until explicit
GitHub conversion.

### Worktree model

Every project replica has a Primary worktree. Additional worktrees may be:

- **managed:** created/released/removed by Cantrip;
- **external:** discovered from the repository and treated conservatively.

Chats have lane semantics:

- **Agent managed:** Cantrip may create/select a worktree for the agent;
- **Pinned:** the chat stays on an explicitly selected worktree.

A single server transcript may span multiple runtime lanes, but messages and
side effects retain worktree/worker attribution. Removing a worktree never
deletes its branch. Removal is blocked when the worktree is active, dirty,
locked, or otherwise unsafe.

### Replicas

A logical project can be installed on several workers. The server records replica
identity, readiness, repository revision, worktrees, capabilities, and health.
Users can:

- choose a default/preferred worker;
- add/provision a replica;
- verify/synchronize a replica;
- remove a safe replica;
- see offline and capability-incompatible placements;
- use account policies for automatic provisioning and synchronization.

Sync policies include off, verify-only, and clean-Primary fast-forward behavior.
Cantrip does not reset/rebase dirty worktrees to force replicas into agreement.
Removal is blocked when active or dirty state would be orphaned.

### Placement

Placement is explicit, durable state rather than a transient load-balancer guess.
Selectors can represent:

- Automatic;
- account/project preferred worker;
- replica Primary/default;
- exact worker/replica/worktree;
- machine-level placement for Browser/Remote Desktop.

The UI explains why a choice is unavailable: worker offline, replica missing,
capability absent, revision incompatible, busy/leased, and so on. Offline
resources remain visible rather than silently moving.

### Concurrency and relocation

- logical branch leases prevent two replicas from concurrently mutating the same
  branch;
- durable jobs use claims, expiry, fencing tokens, and idempotent outcomes;
- chat relocation happens only at an idle/safe boundary;
- server state is hydrated to the target and committed with compare-and-swap;
- attachments can transfer through a bounded server relay;
- active processes and uncommitted repository state are never implicitly moved;
- failed relocation recovers to a clear previous/pending/error state rather than
  producing two active writers.

Managed-folder Agents write directly when their permission profile allows it.
Write-capable workflow nodes also share the folder directly and honor the
workflow's configured parallelism; they do not acquire Git leases or advertise
checkpoints. This is an explicit no-Git operating mode, not an emulated
worktree.

## Models, providers, authentication, and routing

### Provider types

Cantrip separates a user-facing logical model from the concrete provider route.
Supported provider families include:

- **Ollama:** worker-local discovery/execution;
- **OpenAI-compatible APIs:** for services such as OpenRouter or xAI API access;
- **ChatGPT subscription OAuth:** portable server-owned sign-ins used through
  compatible Codex workers;
- **SuperGrok/Grok OAuth:** one or more subscription accounts exposed through a
  worker-local compatibility proxy.

Multiple ChatGPT or SuperGrok accounts can belong to one provider. Users can
rename accounts, sign in/out, inspect quota/reset information, and drag/reorder
account chips to set fallback priority.

### Logical models and route failover

A logical model profile contains an ordered route list. Each route can select:

- provider;
- account or worker-local provider instance;
- provider-specific model identifier;
- reasoning-effort override;
- enabled/disabled state and priority.

The selected logical model is recorded on the chat, but every attempt also
records the resolved concrete route/account/model/worker. Failover is allowed
only before observable command or filesystem side effects; Cantrip does not
blindly retry a turn on another account after it may have changed the project.

### Credential handling

- OAuth/API secrets are server-owned and envelope-encrypted with AES-GCM;
- credentials are tenant/account scoped;
- workers receive short-lived access leases, not durable plaintext vault copies;
- refresh is serialized and revisioned to avoid two writers corrupting a token;
- normal operation avoids provider auth files on worker disk;
- legacy worker credentials use an explicit capture/acknowledge/purge migration;
- global sign-out revokes/clears affected leases and runtimes;
- credentials, auth headers, prompts, and response bodies are excluded from
  service logs.

The Grok adapter translates only the compatible request/response surface and
must preserve provider-owned compaction and model-input payloads exactly where
the upstream API requires them. Provider-specific payloads are not assumed to be
interchangeable merely because both endpoints resemble the Responses API.

### Quota and token telemetry

Cantrip stores immutable quota observations separately from execution attempts.
Provider-reported usage tracks dimensions such as:

- input and output;
- cached input/cache write;
- reasoning output and visible output;
- provider total when available;
- rate-window remaining/reset observations.

Subset counters are not double-summed into totals. Each execution attempt records
route/account/worker/turn/reasoning/runtime timestamps and terminal status
(success, failure, cancellation, interruption, failover).

Quota correlation partitions observations by account/window/reset and can
estimate tokens-per-percent and projected full-window consumption. Rebaselines,
delayed samples, mixed models/efforts/projects, and failed attempts reduce
confidence instead of being hidden.

Behavior telemetry records operational facts such as time to first activity,
time to visible response, duration, status, tool/compaction counts, approvals,
files changed, recognized test outcomes, context usage, failover position, and
interrupts. It intentionally does not store prompts, responses, command output,
or source contents as analytics. Historical model catalogs are sanitized,
content-addressed, and deduplicated.

Usage UI labels bars as **remaining**, so a provider reporting 95% used displays
5% remaining rather than a misleading 95%-full availability bar.

## Automations and workflows

Cantrip provides two levels of unattended orchestration.

### Simple project automations

A project automation submits a saved prompt to a selected Agent chat on a
schedule. Configuration is divided into details, schedule, and condition:

- name, target chat, prompt, and enabled state;
- interval schedules by minute/hour/day/week/month/year with an anchor;
- weekday/time-of-day/time-zone scheduling;
- cron/time-zone scheduling;
- at most one precondition:
  - none;
  - worker script where exit code 0 means allow and any other code skips;
  - minimum number of open GitHub issues, default 1.

The assigned worker evaluates worker-local conditions. Disabled or false
conditions do not enqueue the agent turn. Automation state is server-owned so it
survives client and worker restarts.

### Durable graph workflows

The workflow control plane orchestrates Codex turns using immutable validated
graph revisions. It is deliberately not arbitrary executable JavaScript.
Supported node kinds include:

- agent;
- map;
- pipeline;
- reduce;
- verify;
- condition;
- repeat-until;
- approval gate.

Definitions support:

- strict DAG/graph validation and typed inputs/outputs;
- JSON-pointer predicates such as exists, equality, comparison, and contains;
- bounded map/pipeline concurrency and failure policies;
- durable item/step attempt ledgers;
- bounded repeat loops with iteration, unchanged-output, duration, progress, and
  node-count guards;
- durable gates with expiry and deny policy;
- run budgets: nodes, attempts, parallelism, node duration, tokens, total time,
  and optional cost;
- pause/resume/cancel/retry;
- pause that stops new scheduling but allows active turns to reach a safe finish;
- isolated worktree execution and reviewed outcomes/checkpoints on GitHub
  projects, or direct execution with configured concurrency on managed folders;
- per-run history, diagnostics, input/output inspection, and gate resolution.

Triggers include schedules, API calls, webhooks, saved commands, and—when the
project has Git capability—Git/GitHub events. Unattended triggers are disabled
until an immutable workflow revision and its permission manifest are explicitly
reviewed/trusted. Trust never implicitly transfers to a changed revision.

## Settings and operations

### Global settings

Global settings are flat list/table-oriented pages rather than card-heavy
dashboards. Major sections are:

- **General:** system/light/dark appearance, high contrast, macOS Pro
  translucency/opacity, default permissions, Remote Desktop quality, desktop
  update status;
- **Models:** providers, accounts, catalogs, logical models, ordered routes, and
  default model;
- **Workers:** local/remote worker status, enrollment, default worker,
  provisioning/sync policy;
- **Logs:** client, embedded-server, and worker logs;
- **Tunnels:** global tunnel status/control;
- **Workspaces:** names, default workspace, project memberships;
- **Policies:** reusable instruction documents, template copies, ordering,
  Enabled/Mandatory scope, and assignment counts;
- **Skills:** global/project skill discovery and file management;
- **MCP:** global/project MCP server configuration.

### Project settings

Project settings include:

- General;
- Archive;
- Automations;
- Workflows;
- Replicas;
- Worktrees;
- Tunnels;
- Policies, including direct assignments and inherited/Mandatory sources;
- Skills;
- MCP.

Project overview can show runtime/replica health and aggregate token usage.

### Service logs

The Logs UI combines normalized, redacted records from the client, packaged
server, and linked workers. It supports source/level/time filters, search,
follow/pause, clear, copy, and JSONL export. Rendering and storage are bounded
(virtualized recent records, per-record cap, batch cap, rotating packaged logs).
The server does not recursively fetch/log its own HTTP log stream.

Service logs exclude chat prompts/transcripts, terminal output, command output,
source/file contents, secrets, and auth headers. Development Tauri runs forward
browser/client logs into the shared terminal so protocol, server, worker,
desktop, and client failures can be correlated.

### Explicit desktop updates

Packaged notarized macOS and signed Windows Tauri clients can check GitHub
releases for a newer signed build. There is no silent background installation:

1. Settings shows an available update.
2. Clicking it opens a dialog rendering the release Markdown/changelog.
3. The user explicitly starts download/install.
4. The signed HTTPS artifact is verified.
5. Progress/cancel state is shown.
6. Cantrip checks active local work and prompts/blocks unsafe replacement.
7. The bundled local client/server/worker stack updates and the app relaunches.

Remote hosted servers/workers are not silently upgraded by a desktop client.

## Hosted and multi-node operation

Cantrip can be deployed as more than one monolithic instance.

### Authentication and tenancy

Server modes support:

- no-auth local/trusted operation;
- shared-password operation;
- account-based hosted operation.

Hosted records are tenant-owned and authorization is checked at the server.
Workers are explicitly enrolled, carry scoped identities, and connect outbound.
Secrets are encrypted. Quotas, metrics, and audit events are server-owned.

### Multiple server instances

A production cluster can run several stateless-ish Fastify server instances
behind a load balancer when all instances share:

- PostgreSQL for authoritative state;
- Redis for worker/live routing and invalidation;
- common credential encryption configuration;
- compatible protocol/schema versions.

Requests and app WebSockets may land on different instances. Redis routes worker
commands/responses/notifications to the instance holding the relevant live
connection. Scheduler/workflow/replica claims use database leases and fencing so
only one instance commits an action. Readiness fails when routing dependencies
are unavailable rather than pretending the node is safe. Redis loss may disrupt
live routing but does not replace/corrupt PostgreSQL durable state.

### Local-first behavior

The packaged desktop app includes a production server, worker, Node runtime, and
database migrations. It binds a dynamic loopback origin and presents it as the
Local server profile. Users can also save remote server profiles. Browser/mobile
clients require an already-running server and worker; they do not bootstrap
machine services.

Mobile pairing uses a short-lived, one-use QR grant containing server identity,
origin, and a pairing code—not the user's password or a reusable session.

## Persistence and ownership rules

### Server-owned durable state

- accounts/authentication and encrypted provider credentials;
- workspaces, projects, settings, tabs/groups, and selected durable view state;
- chat transcripts, normalized events, queues, goals/plans, interactions;
- providers/models/routes/account priorities;
- worker enrollment, project source/root kinds, replica/worktree metadata,
  placement, leases;
- automations, workflow definitions/runs/triggers/gates;
- policies, bootstrap state, and workspace/project policy assignments;
- telemetry, audit, and update metadata.

### Worker-owned state

- managed project folders, repository clones, and all Git object/worktree
  content;
- uncommitted and non-Git project files;
- live Codex processes and worker-local runtime caches;
- PTYs and service processes;
- Cantrip Code runtime/profile data;
- Chromium profiles;
- desktop capture/input resources;
- local Ollama models;
- ephemeral network-share/tunnel endpoints.

### Client/session state

- transient focus/hover/animation state;
- some per-window active group/member selection;
- per-chat inspector open/width memory;
- local platform integration state.

Important durable editor selection/drafts do not rely solely on client memory.
The app can display server-owned history/config while a worker is offline, but it
does not fabricate filesystem or live-process state.

## Safety and correctness invariants

- The app does not directly execute project filesystem or repository commands.
- Workers execute only server-authorized, scoped operations.
- Secrets must never enter normal logs, transcripts, or analytics.
- Git commands use argument arrays and bounded output; user text is not spliced
  into shell strings unless an explicitly user-authored shell feature requires
  it.
- Listing/history APIs are paginated or bounded.
- Explorer commit metadata is batched, never one Git process per file.
- File writes use content hashes/version checks.
- Git patch mutations use preview/staleness tokens.
- Dirty worktrees are not reset, rebased, removed, or relocated implicitly.
- Removing a worktree does not delete its branch.
- The same logical branch cannot be mutated concurrently on two replicas.
- Provider failover stops once side effects may have occurred.
- Pending approvals recover fail-closed.
- Unattended workflows require explicit revision/permission trust.
- Offline workers/resources remain visible and explain why they cannot run.
- Managed folders never relocate or replicate, and Git-only operations remain
  capability-guarded even if the user runs `git init` inside one.
- Managed-folder deletion derives only the UUID path below the worker's folder
  root and requires a separate destructive confirmation in the app.
- Long-running live output, frames, logs, fanout, and attachments are bounded.
- User-authored project data remains ordinary Git/filesystem data.

## Repository and implementation map

The pnpm workspace is organized approximately as follows:

- **cantrip_app/** — React/Vite UI, Tauri desktop shell, Capacitor mobile shell.
- **cantrip_server/** — Fastify control plane, database schema/migrations,
  authentication, provider vault/routing, projects/chats/workflows.
- **cantrip_worker/** — repository/Git/PTY/Codex/Code/Browser/Desktop execution.
- **cantrip_cli/** — Rust command-line client for project-context operations.
- **cantrip_site/** — React/Vite marketing/splash site.
- **cantrip_protocol/** — shared Zod contracts and protocol types.
- **cantrip_logging/** — shared structured logging/redaction helpers.
- **cantrip_version/** — shared release/version helpers.
- **cantrip_codex/** — pinned open-source Codex source/build with Cantrip patches.
- **cantrip_code/** — pinned VS Code-derived Cantrip Code source/build,
  extensions, resources, and patch metadata.
- **scripts/** — development preparation, source verification, builds, packaging,
  release helpers, wait/ready scripts.
- **docs/** — architecture, operations, security, protocol, and feature design.
- **ops/** — hosted/deployment operational material.
- **tests/** and package-local test directories — unit/integration/browser
  coverage.

The root package manager is pnpm 11 and the minimum Node version is 22. Rust is
required for Cantrip CLI and the pinned Codex build. Git and GitHub CLI are
required for normal repository/GitHub development. Chromium is used by Browser;
Ollama is optional.

## Development, build, test, and package commands

Common root commands:

    pnpm dev
    pnpm devtop
    pnpm site
    pnpm dev:server
    pnpm dev:postgres

- **dev** starts the ordinary browser-oriented development stack.
- **devtop** prepares protocol/Codex/Cantrip Code and runs protocol, server,
  worker, and Tauri desktop together with prefixed logs.
- **site** runs pnpm --filter @cantrip/site dev.
- Browser app defaults to port 5173, server to 4310, and the Tauri Vite frontend
  to 1420.

Validation:

    pnpm build
    pnpm typecheck
    pnpm test
    pnpm check
    pnpm format
    pnpm format:check

Runtime source/build helpers:

    pnpm codex:verify
    pnpm codex:build
    pnpm codex:clean
    pnpm code:source:verify
    pnpm code:build
    pnpm code:ready
    pnpm code:verify
    pnpm code:extension:test
    pnpm code:dev
    pnpm code:clean

Development preparation verifies that pinned Codex and Cantrip Code artifacts
match their source stamps. A missing/stale Code bundle is a deliberate hard
failure with guidance to run pnpm code:build; preparation/build scripts should
rebuild automatically when the project command promises a ready dev stack.

Packaging/release scripts cover:

- standalone server;
- standalone worker;
- service bundles;
- embedded desktop runtime;
- Tauri application;
- complete bundle/release assembly.

Release targets include macOS ARM64, Windows x64, Android APK, and iOS/TestFlight
lanes as configured. macOS output is signed, notarized, and stapled; updater
artifacts are signed. The checked-in Capacitor native projects are part of the
mobile build.

## Cantrip CLI

The Rust CLI is intended for agents and users operating inside Cantrip context.
It resolves context primarily from injected thread/terminal identifiers and then
from the current working directory. Representative operations include:

- status/context inspection;
- effective Policy list/read;
- worktree list/create/status/switch/release/remove for GitHub projects;
- execution target list/show;
- Explorer list/read/write;
- Terminal read/send/restart;
- Browser service discovery/open.

The CLI speaks to an authenticated loopback worker broker, which routes through
the server to the owning worker when necessary. It is the preferred API for
Cantrip-specific lifecycle operations. Ordinary file reads/writes and normal Git
inspection can still use standard shell tools.

## Terminology quick reference

- **Agent:** user-facing name for a Codex-backed chat surface.
- **Chat/thread:** the same durable Agent conversation concept; Codex commonly
  calls it a thread while Cantrip APIs use Chat.
- **Task:** a specialized Chat experience with durable planning artifacts and
  an automatic same-thread Goal handoff.
- **Lane:** a concrete worker/execution-root runtime segment of a chat.
- **Primary:** mandatory default Git worktree inside each GitHub replica.
- **Replica:** one worker-local Git installation of a logical GitHub project.
- **Managed folder:** the single worker-bound, UUID-derived non-Git execution
  root of a folder project.
- **Placement:** durable resolution of a surface/job to its worker and execution
  root, optionally through a Git replica/worktree.
- **Provider:** credentialed backend/account family.
- **Logical model:** user-facing model profile with ordered concrete routes.
- **Attempt:** one concrete provider route execution for a turn.
- **Interaction:** durable question/approval awaiting user resolution.
- **Surface:** Agent/Task, Terminal, Explorer, Code, Git, Browser, Remote
  Desktop.
- **Cantrip Code:** bundled browser-native VS Code-derived workbench.
- **Workflow:** durable graph orchestration above individual Codex turns.
- **Automation:** simpler scheduled prompt with an optional single condition.
- **Policy:** a server-owned reusable Agent instruction that is Mandatory or
  assigned to selected workspaces/projects.

## Narrower design documents

For repository users, these documents contain the deeper contracts behind this
summary:

- [AGENT_INTERACTIONS.md](AGENT_INTERACTIONS.md)
- [CLI.md](CLI.md)
- [CODE.md](CODE.md)
- [CODEX_CHAT_IMPORT.md](CODEX_CHAT_IMPORT.md)
- [CODEX_EVENT_NORMALIZATION.md](CODEX_EVENT_NORMALIZATION.md)
- [CODEX_NATIVE_CUSTOMIZATION.md](CODEX_NATIVE_CUSTOMIZATION.md)
- [CODEX_RUNTIME_COMPATIBILITY.md](CODEX_RUNTIME_COMPATIBILITY.md)
- [DISTRIBUTION.md](DISTRIBUTION.md)
- [GIT_CLIENT.md](GIT_CLIENT.md)
- [HOSTED_DEPLOYMENT.md](HOSTED_DEPLOYMENT.md)
- [HOSTED_SECURITY_ARCHITECTURE.md](HOSTED_SECURITY_ARCHITECTURE.md)
- [LIVE_TRANSPORT.md](LIVE_TRANSPORT.md)
- [MULTI_WORKER_ARCHITECTURE.md](MULTI_WORKER_ARCHITECTURE.md)
- [POLICIES.md](POLICIES.md)
- [TASKS.md](TASKS.md)
- [PROJECT_NETWORK_SHARES.md](PROJECT_NETWORK_SHARES.md)
- [PROVIDER_AUTHENTICATION.md](PROVIDER_AUTHENTICATION.md)
- [SERVICE_LOGS.md](SERVICE_LOGS.md)
- [TAB_GROUPS.md](TAB_GROUPS.md)
- [TOKEN_TELEMETRY.md](TOKEN_TELEMETRY.md)
- [TUNNELS.md](TUNNELS.md)
- [WORKER_PROTOCOL.md](WORKER_PROTOCOL.md)
- [WORKFLOW_OPERATIONS.md](WORKFLOW_OPERATIONS.md)
- [WORKFLOW_ORCHESTRATION.md](WORKFLOW_ORCHESTRATION.md)
- [WORKTREES.md](WORKTREES.md)
