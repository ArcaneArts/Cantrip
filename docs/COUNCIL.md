# Cantrip Council

Product and implementation plan revised from the Council design discussion. The
Grok Bot research was reviewed on November 24, 2026.

[Grok Bot research](#grok-bot-research) ·
[Execution and steering](#execution-and-steering) ·
[History and recall](#history-recall-memory-and-compaction) ·
[Implementation milestones](#implementation-milestones)

## Product

Council is a third Cantrip mode beside Chat and IDE. Each Council agent is an
account-owned, long-lived Codex chat with a role, editable memory, local working
files, and access to the account's Cantrip projects, chats, agents, settings,
models, policies, and tools. It can run a briefing, coordinate changes across
projects, and write scripts that use existing MCP services. These are examples
of jobs a user can give an agent. The same features support other jobs.

The first agent is primary automatically. The user can mark multiple agents as
primary or clear all primary designations. Cantrip adds a short system
instruction asking each primary to coordinate with peers and follow up when
useful. Primary is a role prompt and roster designation. All Council agents can
talk to peers and use the same Council operations under the account's settings.
A user can ask any agent to create another agent with a role and instructions.
The new agent starts a fresh conversation using Council defaults and can be
addressed by the user or its creator.

Council launches with personal agents and fresh conversations. Existing Chat and
IDE conversations remain distinct. If Council later replaces standalone Chat,
that is a separate product decision.

### Example workflow

Ask a Council agent to create an operations agent and set it up to check a
project every weekday. The new agent can contact an existing project chat or
create one, ask it to inspect the project, and use a configured MCP server to
collect supporting information. The project chat's completion wakes the
operations agent or steers its current turn. The operations agent can send the
result to a primary agent in their shared pair thread. The primary agent can
prepare a briefing, cite earlier decisions when relevant, and notify the user
when it has something to report. Each project action still runs in its own
project chat or Task with that target's existing permissions.

## Grok Bot research

The reference here is the Grok Bot product, with its own marketplace and product
documentation. The evidence combines first-party documentation, first-party
changelog and marketplace records, and the five supplied product screenshots.
The research is a documentation and screenshot review.

| Capability                    | Published behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Council implication                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Persistent roster             | A Bot has a name, a job, its own conversation, and durable working context. The primary Bot checks in and coordinates other Bots. Existing Bots can suggest or create another Bot. Profiles can be pinned, organized into sections, hidden without pausing, or copied. Bot templates can be published and imported as independent copies.                                                                                                                                                                          | Council makes the first agent primary, supports several primaries, and lets an agent create another agent from a role described in chat. [Bot management](https://docs.x.ai/grok-bot/bots)                                                                                                                                                                                                 |
| Memory and long history       | Bots can save preferences, durable rules, important facts, and a dated work log. Personal Bots have separate memories with a small shared profile. The user can ask what a Bot remembers, and a conversation reset can preserve the Bot's memory and other state. The chat palette searches across chats and offers an older-message search. The enterprise inference-hook guide confirms that older context can be replaced by a summary and mentions internal transcript tools.                                  | Treat saved memory, model context, and retained transcript as distinct stores with different controls. Support both a user search view and agent recall. [Bot memory](https://docs.x.ai/grok-bot/bots#what-a-bot-remembers) · [Find prior work](https://docs.x.ai/grok-bot/chat-and-collaboration#find-prior-work) · [Inference hooks](https://docs.x.ai/grok-bot/inference-hooks)         |
| Handoffs and shared chats     | Bots can send work to other Bots, and direct handoffs appear in their own chats. Users can also open a group of two to six Bots with visible collaboration. Some private requests, including approvals and credential requests, stay with the relevant Bot. Replies can be threaded, and voice calls can be reopened as transcripts.                                                                                                                                                                               | Council uses bidirectional threads between pairs of agents, linked from their main conversations. [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration)                                                                                                                                                                                                             |
| Skills and routines           | Skills encode repeatable procedures. Users create and edit routines in chat and can inspect, pause, test, or delete them. Triggers include schedules, tagged Bot email, Slack and other service events, and webhooks. The Bot gets a webhook's optional JSON body with its instructions. The documented bearer-key response acknowledges admission, while completion appears in chat and run history. The docs list a five-minute minimum schedule interval, up to 50 routines per Bot, and 20 recent run records. | Council reuses Cantrip automations to prompt an agent. Its run details retain trigger inputs and its main chat shows the resulting activity and response. [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)                                                                                                                                                |
| Proactive and background work | Cloud turns and routines keep running with the client closed. The primary Bot can proactively suggest work or report a disconnected app. Its notification setting controls alerts separately from the underlying check-ins. Release notes describe delegating coding to Cursor Cloud Agents and describe a Project as an agent that plans work and runs its own agents.                                                                                                                                            | Council runs on an enrolled Cantrip worker. It routes coding work to existing project chats and Tasks. [Grok Bot FAQ](https://docs.x.ai/grok-bot/faq) · [Initiative](https://docs.x.ai/grok-bot/initiative) · [Grok Bot changelog](https://x.ai/changelog/bot)                                                                                                                             |
| Computer and files            | First-party enterprise docs describe Cursor-hosted per-user Firecracker VMs. Personal Bots for that user share a persistent filesystem, browser sessions, and logins, with separate screens. The history is stored separately from the computer. Local-device access is separately controlled. File results can be attached and handed back in chat.                                                                                                                                                               | A Council agent works on its own Cantrip worker. The server routes interactions with project resources on other workers. [Enterprise architecture](https://docs.x.ai/grok-bot/teams-and-enterprises) · [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) · [Files and results](https://docs.x.ai/grok-bot/files-and-results)                                               |
| Plugins and connectors        | The app exposes an installation and sign-in workflow, account-wide connected apps, plugin-provided skills, and custom connectors. A custom connector can be a remote HTTPS MCP endpoint or a command on the Bot computer. Documented app OAuth tokens stay with Cursor's connector backend. An installed plugin can still require authentication.                                                                                                                                                                  | Council starts with the worker's existing Cantrip MCP configuration and authentication. [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)                                                                                                                                                                                                                                  |
| Agent-authored integrations   | The documented tinkabot example turns an API into an MCP server and skills, tests the integration, and requests permission for publication. The marketplace accepts a reviewed MCP URL or public source repository. The public Bot gallery is a separate distribution path for Bot templates.                                                                                                                                                                                                                      | Council agents can set up MCP servers and write short-lived scripts that call them. A separate plugin catalog can follow later. [How Grok Bot works](https://docs.x.ai/grok-bot/how-grok-bot-works) · [tinkabot listing](https://x.ai/bot/marketplace/bots/tinkabot) · [Plugin submission](https://x.ai/bot/marketplace/submit-a-plugin) · [Bot marketplace](https://x.ai/bot/marketplace) |
| Credentials and review        | Vault and secure forms handle logins and other sensitive inputs. App OAuth and API secret entry have dedicated paths. Auto Review can apply custom user or team rules and ask before consequential operations. The team product exposes administrative policies and audit controls.                                                                                                                                                                                                                                | Council uses existing worker authentication and passes project approval requests to the user through Agent Interactions. [Vault](https://docs.x.ai/grok-bot/vault) · [Approvals and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)                                                                                                                                    |
| Team and channel access       | Team Bots have owners, managers, and collaborators, private teammate conversations, and reviewed shared learning. They can serve shared channels through Slack and Microsoft Teams. The launch material and product docs also cover calls and mobile access.                                                                                                                                                                                                                                                       | Council agents belong to one Cantrip account. This plan covers personal agents and in-app collaboration between them. [Team Bots](https://docs.x.ai/grok-bot/team-bots) · [Grok Bot 1.0](https://x.ai/news/grok-bot-1-0)                                                                                                                                                                   |

The supplied screenshots illustrate five useful product flows. Screenshot 1
shows proactive briefings landing in a persistent one-to-one conversation with a
pinned primary Bot. Screenshot 2 shows a human answer superseding the scheduling
suggestion from another Bot and a visible routine-creation receipt. Screenshot 3
shows a separately inspectable Bot-to-Bot thread, a delegated read-only check,
and a result whose freshness depends on the two routines' schedules. Screenshot
4 distinguishes installed plugins, connector and skill counts, sign-in state,
local-device apps, and private skills. Screenshot 5 shows a searchable catalog
with categories, recommendations, and a separate entry for Bot templates. These
describe the interaction model. The source screenshots include private
operational and personal details and are omitted from the repository.

The vendor sources establish that summaries and transcript tools exist. They
leave the indexing method, ranking, chunking, context thresholds, retrieval
coverage, and retention implementation unspecified. Council's search and
compaction designs below are proposed independently. The November 2026 launch
also describes collaborative Pages, richer document and presentation work, and
organization-level sharing and usage controls. Compatibility of individual
connectors depends on plan, account, and platform.
[Grok Bot 1.0](https://x.ai/news/grok-bot-1-0) ·
[Enterprise controls](https://docs.x.ai/grok-bot/teams-and-enterprises)

## Cantrip foundations and ownership

| Area                          | Existing Cantrip foundation                                                                                          | Council change                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Navigation and conversation   | Chat and IDE modes, normalized transcript and tool events, and App Live.                                             | Add Council navigation and a roster. Reuse the IDE Agent transcript and composer for Council. [App settings schema](../packages/protocol/src/settings.ts) · [Live transport](LIVE_TRANSPORT.md)                                                                                                                                |
| Codex execution               | Managed native turns, root admission, steering, compaction, and history recovery.                                    | Add a Council conversation kind and feed human and internal inputs through its durable prompt queue. [Root admission](../cantrip_server/src/chats/roots/admission.rs) · [Native steering](../cantrip_worker/src/codex/turn/control/steer.rs) · [Runtime compatibility](CODEX_RUNTIME_COMPATIBILITY.md)                         |
| Project operations            | Managed CLI and MCP, project target resolution, encrypted chat delivery, Tasks, and durable interactions.            | Expose the owner-wide inventory to Council. Extend delivery and controls to accept Council provenance while reusing the recipient's project path. [CLI](CLI.md) · [Managed MCP](MCP.md) · [Tasks](TASKS.md) · [Agent Interactions](AGENT_INTERACTIONS.md)                                                                      |
| Background work and providers | Scheduled project automations, claim and recovery primitives, protected provider credentials, and account switching. | Target Council agents with automations. Reuse provider routing and extend active-turn account recovery for Council. [Automation dispatch](../cantrip_server/src/project_automations/dispatch.rs) · [Account failover](../cantrip_server/src/chats/account_failover.rs) · [Provider authentication](PROVIDER_AUTHENTICATION.md) |
| Tools and protected content   | Account policies, managed MCP and Skills, worker-bound configuration, and endpoint-encrypted chat and settings.      | Reuse these paths for Council prompts, tools, and history. Add endpoint-only memory and recall. [Policies](POLICIES.md) · [Codex customization](CODEX_NATIVE_CUSTOMIZATION.md) · [Encryption](ENCRYPTION.md)                                                                                                                   |

The app owns roster navigation, transcript presentation, approvals, and
notifications. The server owns account-scoped identities, canonical encrypted
records, queue admission, target routing, and automation timing. The worker runs
Codex, executes local tools, opens protected content, and searches history. HTTP
owns authoritative reads and writes. App Live publishes changes after commit.
Use existing WorkerLink grants for live data where applicable.

Start with one assigned Council worker per account. The agent's Codex process,
scratch space, memory tooling, and local MCP scripts run there. The server can
route project actions to any enrolled worker that hosts the selected target.
Council receives authorized results through Cantrip operations. Its shell runs
on the assigned worker, and project paths resolve on their own workers. If the
Council worker is offline, keep accepted work queued and show the reason. The
initial release keeps the original placement on recovery.

### Durable records

- **Agent.** Owner, agent ID, canonical conversation ID, primary flag, worker
  placement, lifecycle, and configuration revision. Encrypt the name, role
  instructions, and other semantic settings. Assign the first primary in the
  same transaction as first creation so concurrent creates produce one initial
  primary. Later designations allow multiple primaries or none.
- **Conversation.** One fresh Council conversation per agent. Use existing
  encrypted chat messages and native history with an explicit Council kind.
  Agent identity and the retained conversation survive native thread changes,
  compaction, and runtime restarts. Keep native thread and turn identifiers as
  execution detail alongside the logical Council run.
- **Prompt delivery.** Source kind, operation ID, target, order, correlation,
  delivery disposition, and encrypted input. Source kinds distinguish human
  messages, automations, Council peers, project results, and runtime
  continuation.
- **Pair thread.** Owner and the two Council agent IDs ordered canonically, with
  one chronological sequence. Each item stores direction, protected text, and
  references to related turns or artifacts.
- **Delegated work.** Source Council agent, exact project chat or Task,
  initiating operation, expected turn or Task receipt, and linked outcomes.
  Persist this relation for attribution and callbacks. The project continues to
  own the work.
- **Routine and notification.** Reuse existing automation schedule, claim, and
  run concepts with a Council recipient. An agent output records its
  notification intent separately from its visible content and source.

Keep owner checks on reads and operations and seal semantic content using
Cantrip's row-bound envelopes. Cross-worker delivery uses the existing
authorized endpoint and worker routing model. Council adds no per-agent project
grant or permission profile.

Hiding an agent affects the roster. Pausing holds execution. Stopping a Council
agent interrupts its own current turn and leaves delegated project work running.
Archive holds automations and retains history. User-directed deletion removes
the agent and queues any necessary worker cleanup.

## Execution and steering

Run one mutable native Codex turn at a time per Council agent. Different agents
can run concurrently within the worker's existing capacity. Keep one durable
prompt queue for inputs to each agent.

1. **Accept.** Persist the attributed input and its delivery receipt before
   claiming it. Duplicate callbacks or retries with the same operation ID
   resolve to the same input. A changed payload under an existing ID conflicts.
2. **Deliver.** When the agent is idle, admit the next eligible input as a
   normal turn. When a turn is running, a human message steers it. Automation
   prompts, addressed peer messages, and delegated results use the same
   send-or-steer path. Use the current native turn identity for steering. If
   that turn finishes before Codex accepts the steer, reconcile the receipt and
   deliver the still-pending input to the next turn once.
3. **Publish.** Reuse the IDE Agent view of tool calls, command activity, plan
   updates, intermediate messages, and final responses. Internal prompt inputs
   appear in their source records, such as a routine run or pair thread. The
   main conversation shows the agent's resulting activity, response, and a link
   to its source. Human messages keep their normal chat presentation.
4. **Recover.** Reconcile a possibly accepted turn or steer against its real
   native receipt before retrying. Resume queued inputs after restart. Persist
   delivery and outcome before sending follow-ups or notifications.

A project reply can wake an idle Council agent or steer its active turn. The
Council agent can finish what it is doing after sending a request. It can also
inspect status or wait for information using the existing controls. Waiting for
a reply need not keep the model running or hold a Codex turn. An interaction can
resume from its later question, answer, or completion callback.

### Provider account switching

Add a **Council default model** beside the existing Chat and IDE defaults.
Select provider accounts through Cantrip's configured model and credential
routing. When quota runs low and a compatible configured account is available,
pause or checkpoint the current run, switch the provider account or configured
model route, restart the affected Codex CLI session, and try to resume the exact
turn through existing native recovery facilities.

Show a small switching status and identify the old and new accounts in the
completed switch notice. Later inputs still target the same Council conversation
and pending work. Keep the Council run and its original trigger identity stable
through the switch.

If exact resume is unavailable, reconcile the old turn first. Start one internal
continuation prompt with the last request, a bounded history and progress
snapshot, pending decisions, and relevant tool or work receipts. Tell Codex that
the provider changed and to continue the work. The fallback must preserve known
completed work and avoid replaying an unresolved external effect. If no
configured account can run the model, show the quota block and hold the work for
a valid route.

## History, recall, memory, and compaction

### Separate memory from history

An agent owns its fast memory. It can read, write, update, and delete it without
a confirmation step. The user can inspect or correct it and can tell the agent
what to remember or where to keep detailed notes. Give the agent clear
instructions to record lasting preferences, decisions, working practices, and
references as it learns them. A saved entry can say that further notes live in a
Drive document, Obsidian, Notion, or any other store already reachable through
its tools. The short pointer stays in fast memory so the agent can find the
external material on a later turn.

Inject a small current memory section beside the role prompt, Cantrip and Codex
base context, policies, and skill and tool information. Treat memory as standing
working context. Current human instructions and configured policy still govern
the run, and permissions come from Cantrip's actual runtime settings. An older
message is historical evidence. The agent can search and cite it without
promoting it into memory.

Reuse encrypted canonical conversation history for the retained transcript. Give
agents read and search operations for history and separate read, write, and
delete operations for memory. A user can delete a history message through the
applicable chat control. Invalidate old search entries and summaries that
contain it. Memory edits and native compaction leave history intact.

### Retrieve in layers

Start each turn with bounded fast memory and recent context. Let Codex decide
when to call a search tool for old work. Teach the agent to search proactively
when the request refers to a prior discussion, result, or decision. Keep memory
injection and tool results under explicit context limits.

1. Search for text or identifiers and return a small set of snippets with
   author, time, source type, stable message ID, and coverage. Include enough
   information in one reply to select the next item.
2. Open the matched message and a bounded nearby range with one history read.
   Return stable links that can jump to the original evidence.
3. Follow available references to an attachment, tool result, peer thread, or
   delegated project chat or Task under its existing access rules. Search
   available related content when useful, and batch reads where that avoids one
   call per item. If a reference is gone or unreachable, report that separately
   from “no matching history.”

The app's history search and Codex recall should use the same query semantics
and message IDs. The retained view includes ordinary conversation and normalized
IDE-style activity. Index their useful text and the names or summaries of
related artifacts. Provide bounded content reads for deeper evidence. Keep raw
secrets and hidden runtime data outside the search corpus.

### Start with text search

Prototype worker-local full-text search over normalized, authorized records,
with exact matching for paths, errors, issue IDs, and other literal strings.
Compare SQLite FTS5 plus exact matching with a scoped, read-only transcript
projection that can be searched using ordinary text tools. Benchmark cold
availability, warm latency, incremental rebuilds, and retrieval quality. Choose
the smallest approach that meets the acceptance cases. Expose stable history
search and read tools regardless of the underlying implementation. Any file
projection must share the transcript's deletion rules and must not expose the
raw Codex session store or an unrelated agent's data.
[SQLite FTS5 reference](https://www.sqlite.org/fts5.html)

For paraphrases in the first release, let Codex reformulate searches using
synonyms, names, date ranges, or nearby terms, then open candidate messages to
check their meaning. Include exact matches and paraphrased questions in launch
fixtures. Add vector or hybrid search after Cantrip has a central embedding
model configuration and background indexing system. Council's first release uses
the text-based path.

Index or project committed message revisions on the authorized worker so search
can recover from gaps. Show coverage during rebuilds. Keep protected text and
queries endpoint-only. If the worker is offline, the unlocked client can still
browse retained history using the existing encrypted history path. Index
snapshots, if persisted, follow the same encryption, redaction, and revision
rules as their source records.

### Compact the native context

Reuse the pinned Codex runtime's compaction and history recovery. Compact at its
safe turn boundary using real context usage and native state. Keep the source
transcript and a bounded continuation snapshot with recent decisions, unfinished
work, and message references. During a native restart, recover the current
memory and role and use compacted context or a continuation prompt to resume
work. Verify that old messages still resolve by ID after repeated compaction and
a cold worker restart.
[Worker compaction](../cantrip_worker/src/codex/turn/compact.rs) ·
[Durable turn suspension](DURABLE_TURN_SUSPENSION.md)

## Project chats, Tasks, and peer conversations

### Project work runs in the project

Give Council an account-wide, owner-scoped inventory of projects, project chats,
Tasks, and Council agents. The agent can list and inspect resources, ask
questions, send or steer prompts, create project chats, and create and manage
Tasks through Cantrip. Use the Cantrip CLI and managed MCP with the same server
authorization and typed operations. Extend existing chat and Task tools where
their current caller scope assumes one project. Add a Council profile to the
authenticated in-chat MCP path for these mutations. The standalone external MCP
catalog provides discovery. The existing project permissions still apply.
[In-chat MCP](MCP.md#in-chat-mcp)

When the user asks for project work, the agent can address an existing project
chat or create a new one when no chat was specified. It can also start a Task
when that workflow fits. The target's normal setup selects the worker, project
execution context, model, and permission mode. The target runs the work under
its own settings, including YOLO if the user selected it there. Council can tell
the user where to change a target's permission mode. A Council message cannot
change that mode or act as a human approval.

Record the exact prompt and resulting project turn or Task when Council
delegates. The server sends the correlated completion back to the source agent's
prompt queue. Include the result or a bounded summary, its exact source link,
and a status the agent can act on. A later, unrelated human turn in the same
project chat has its own identity. Retry a completion callback with the same
identity so it cannot wake the Council agent twice.

A Council agent can explicitly ask Cantrip to stop, interrupt, steer, or query a
project chat and stop or manage a Task through the target's normal controls.
Stopping Council itself leaves project work running. Keep the relationship
visible through a compact linked-work indicator or details view so a busy
agent's conversation can remain readable. When a project chat or Task shows an
input sent by Council or an automation, label it **Sent via** with the agent or
automation name and a link. Human inputs keep their existing attribution.

### Forward approvals and errors

Forward a target's permission request, question, or execution error to the
Council agent with a link to the original source. Show pending requests in the
Council UI with an action that opens or renders the existing Agent Interaction.
The user answers the exact original request with its existing permissions and
identifiers.

Council agents can explain requests and surface them to the user. Approval and
denial stay human actions by default, including when Council itself runs in
YOLO. If Cantrip later adds an explicit automatic-approval setting, design it
separately from the default Council permission level. The initial release uses
the existing target approval path. [Agent Interactions](AGENT_INTERACTIONS.md)

### Give each pair one conversation

Store one bidirectional pair thread for agents A and B. Messages from A to B and
B to A share that history and display the sender. Sending a message queues an
attributed prompt for the recipient. Follow-up messages are addressed
explicitly. A recipient's ordinary response in its own conversation does not
broadcast to its peers.

Display a compact handoff indicator in the agent's main chat. Opening it shows
both directions in the pair thread, with linked turns and related work. An agent
can continue its own work while waiting for a peer. When a reply arrives, it
uses the recipient's normal send-or-steer queue. Preserve causation and retry
identity so deliveries remain traceable and retrying a send creates one item.
Apply bounded run-chain limits to repeated automated handoffs. A primary can
coordinate with other primaries through the same thread and queue.

## Automations and notifications

Use the existing Cantrip automation model to schedule prompts to Council agents.
The prompt belongs to the run record. When it becomes due, the scheduler admits
it to the recipient's prompt queue. Reuse schedule, timezone, claim, test, and
pause controls where applicable. Each scheduled occurrence has a durable
identity. If the agent is offline, accepted inputs wait for the assigned worker.
The routine prompt can tell the agent how to handle a missing or stale source.
Council does not require a dedicated workflow or report dependency engine for
that.

An agent can create or change an automation under the account's **Council
default permission level**, following the usual Cantrip controls for that mode.
Use the same default for interactive and scheduled Council runs. The user can
instruct an agent to create a schedule in the conversation. A run produces
visible agent activity and output with a source link. Its internal prompt stays
in run details. Runs for project chats or Council agents carry **Sent via**
attribution where automation messages are displayed.

The agent chooses whether each user-facing message should notify. Give it a
message action with explicit notification intent. It can post quiet progress
while working and mark a daily report or final response for notification.
Persist the intent alongside the message and associate dispatch with the message
ID so a retry does not generate another alert. Reuse Cantrip's alert and
notification paths where available and honor the user's client preferences. Keep
the message and its notification state available when clients reconnect. Display
provider switches as application activity, separately from agent-chosen
messages.

The first release covers prompts from Cantrip's existing automation support.
Generic webhook ingress and service-specific triggers are follow-up work where
Cantrip needs a new integration. When added, they should authenticate and
durably admit events into the same prompt queue with the same source
attribution.

## Defaults, policies, and integration tools

Add account settings for **Council default model** and **Council default
permission level**. Council agents and automations use the shared permission
default. Project chats and Tasks keep their own modes. Use the existing model,
provider, and authentication configuration for Council. Keep Chat and IDE
settings compatible as Council adds its own defaults.

Council's base context includes existing global system instructions and
policies, applicable skills and tool information, the agent's role, its fast
memory, and the primary instruction when designated. Make the account's
policies, MCP inventory, configured models, relevant settings, projects, and
chats discoverable through the Cantrip CLI and managed MCP. Load details on
demand. Use the existing effective MCP and policy resolution on the selected
worker, including existing installation, login, worker binding, and project
context rules. Inventory can report that a tool is unavailable or needs
authentication. Credential values remain in the existing credential paths.

Use the MCP servers Cantrip already supports, including configured remote
endpoints and worker commands. An agent can configure or set up an MCP server
through the existing worker flow when permitted by the Council default. It can
write and run a script that connects to an MCP server, retrieves information,
and exits. Reuse the configured server's transport, credentials, and Cantrip
process controls. A script that acts as a client can be temporary even when the
configured MCP server is persistent. Existing protected credential handling and
worker boundaries apply. This supports custom user workflows through the current
MCP system. A managed catalog, first-party connectors, and a plugin packaging or
publishing workflow can follow separately. [Managed MCP](MCP.md) ·
[Codex customization](CODEX_NATIVE_CUSTOMIZATION.md) · [Cantrip CLI](CLI.md)

## App experience

- Add Council to the top-level desktop, browser, and mobile mode switch. Reuse
  the app's mode navigation and restore the last Council agent when the user
  returns. Show primary designations, current activity, and pending requests in
  the roster.
- Reuse IDE Agent transcript rendering, composer actions, model and usage
  status, attachments, and visible tool activity. Add source links and handoff
  indicators without inserting internal prompt text as human messages.
- Show compact access to memory, history search, automations, and linked chats
  or Tasks. Open exact messages, pair threads, and target activity from their
  references. Show errors and approval questions beside the work that produced
  them.
- Show when the assigned worker is unavailable and why a prompt is queued. Keep
  prior conversation history available through the existing encrypted transcript
  interface.

## Implementation milestones

Each milestone extends the existing production paths and can be tested
independently. Council navigation follows the server capability, which is
enabled by default. Set `CANTRIP_COUNCIL_ENABLED=false` on the server to disable
Council. Chat and IDE remain available.

| Milestone                                               | Implementation                                                                                                                                                                                             | Exit evidence                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Council identity and Codex                           | Add account defaults, agent and conversation records, one Council worker placement, primary designation, creation through app and agent, and IDE-style transcript rendering. Extend native send and steer. | Create a first primary, mark a second, create an agent by prompt, and restart the worker. An unrelated human prompt steers a busy turn, with one visible human input and continuing tool activity.                                                         |
| 2. Memory, history, and compaction                      | Add editable fast memory, protected injection, text search, bounded reads, and compacted native recovery. Compare indexed search with the transcript projection.                                           | Find an early decision and an exact error after compaction. Follow related attachments and artifacts with bounded reads. Save, change, and delete a memory without editing the transcript.                                                                 |
| 3. Project and peer coordination                        | Extend existing CLI and MCP inventory, project chat creation and controls, Task controls, pair threads, attribution, callbacks, and forwarded interactions.                                                | A Council agent starts or finds a project chat, sends a prompt, receives the exact result while idle or active, and shows its source. A human can answer the project's original approval from Council. Two agents share one thread in both directions.     |
| 4. Scheduled work, notifications, and provider recovery | Reuse Cantrip automations, retain internal input in run details, add notification intent, and extend live provider account switching and continuation.                                                     | A scheduled run executes with the app closed. Quiet progress stays in chat, a final message notifies, and the trigger prompt stays in run details. A provider switch either resumes the same turn or admits one continuation with earlier progress intact. |
| 5. Existing MCP and launch qualification                | Wire Council into existing worker MCP configurations and setup, run the short-lived script workflow, and verify the full product across worker placements and application clients.                         | The same agent runs a briefing, coordinates work in more than one project, configures or uses a supported MCP server, and retrieves information with a script that exits. Council remains usable across model account switches and worker restarts.        |

### Verification and launch criteria

1. **Personal agents.** Create two agents concurrently and verify that the first
   creates the initial primary designation exactly once. Mark both as primary,
   change a role, and create a third agent from chat. Check the resulting Codex
   context for role, primary instruction, memory, and existing global policy.
   Confirm that another account cannot list or access these agents.
2. **Active-turn delivery.** Exercise a human message, a scheduled prompt, a
   peer message, and a duplicate project completion. Run them with the recipient
   idle and busy, including a turn that completes during steering. Assert
   exactly one delivery per accepted input and check which records appear in the
   main transcript, run details, and pair thread.
3. **Recall.** Seed a long transcript with exact errors, identifiers,
   conflicting older decisions, paraphrased questions, and linked evidence.
   Check UI and agent search against source IDs before and after compaction and
   restart. Verify that a missing artifact has its own status, that a deleted
   message leaves derived indexes and summaries, and that memory edits leave
   history intact. Measure search and rebuild cost with at least 50,000 messages
   per agent.
4. **Project authority.** Use a project on a different worker. Create a new
   chat, message an existing chat, and create a Task. Verify the original
   target's mode, **Sent via** attribution, forwarded permission requests, and
   the user's ability to answer the original request. Stop Council and observe
   that the Task continues. Then explicitly stop or steer work through the
   target's controls.
5. **Scheduled work and provider recovery.** Test scheduled execution with the
   app closed, the original worker offline, and after restart. Verify
   notification opt-in per message and retry deduplication. Switch between
   configured provider accounts during a run. Test native resume and fresh
   continuation, including the case where a prior tool action may already have
   taken effect.
6. **MCP reuse.** Give a Council agent the account's real tool inventory with a
   fixture MCP server. Set up a supported existing configuration under the
   Council default, run a short-lived client script, verify its result, and
   confirm that the script exits. Confirm that the issuer's existing credentials
   and permissions still control access.
7. **Integrated launch.** From the app, create a Council agent by prompt and
   schedule a briefing. Recover a decision after compaction and a cold Worker
   restart, approve a remote project chat command, collect its result and a
   local Task result, run the authenticated MCP script, send a peer handoff,
   and receive the briefing notification. Exercise the browser flow at desktop
   and touch widths and verify Council opens and runs a turn in the macOS app.

Use focused protocol, server, worker, and app tests as each milestone lands.
Include real Codex App Server tests for steering, compaction, and provider
resume, and use the packaged worker to test existing MCP setup. Keep the initial
work on current Cantrip infrastructure. Central embeddings, webhook ingress
beyond existing automation capabilities, and a dedicated plugin ecosystem have
separate follow-up milestones.
