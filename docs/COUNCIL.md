# Cantrip Council

Proposed product and implementation plan. Grok Bot research and Cantrip source
review dated November 24, 2026. The Cantrip baseline is commit `774391faf`.

[Grok Bot research](#grok-bot-research) ·
[Cantrip architecture](#cantrip-foundations-and-proposed-ownership) ·
[History and recall](#history-recall-memory-and-compaction) ·
[Implementation milestones](#implementation-milestones)

## Product

Council is a third Cantrip mode beside Chat and IDE. A Council agent is an
account-owned teammate with a stable identity, a role, a long-lived
conversation, distinct memory and files, its own tool and credential grants, and
a durable inbox. Opening the agent shows its whole retained conversation,
including work initiated by a human, another agent, a schedule, or a webhook.
Give agents narrow jobs and optionally choose one as the primary contact that
coordinates the others.

An agent runs through the existing worker-hosted Codex CLI and App Server stack.
It uses normal Codex tools within its execution policy, plus the MCP tools
effective for that agent and turn. Council contributes persistent identities,
selective recall, managed handoffs, routines, and scoped access to Cantrip
projects. A Council agent can request work in several projects over its
lifetime. Each project operation resolves an explicit project, source, and
execution target and runs through that project's authority and placement rules.

The reference workflow is a morning briefing. The primary agent asks an
operations agent to inspect a permitted project and prepare a daily health
report. The user answers a scheduling question in the operations agent's own
conversation and activates the proposed routine. The operations agent records
and sends each result with a source link and an “as of” time. The briefing agent
can carry the latest available report and identify it as yesterday's if the
briefing runs before today's check. An abnormal result can prompt a human
decision or generate a scoped project Task for investigation. Each decision and
handoff can be reopened from the conversation that received it.

## Grok Bot research

The reference here is the Grok Bot product, with its own marketplace and product
documentation. The evidence combines first-party documentation, first-party
changelog and marketplace records, and the five supplied product screenshots.
The research is a documentation and screenshot review.

| Capability                    | Published behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Council implication                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Persistent roster             | A Bot has a name, a job, its own conversation, and durable working context. The primary Bot checks in and coordinates other Bots. Existing Bots can suggest or create another Bot. Profiles can be pinned, organized into sections, hidden without pausing, or copied. Bot templates can be published and imported as independent copies.                                                                                                                                                                          | Keep identity, conversation, profile, and execution state separate. Give users a primary agent, roster organization, draft creation, and explicitly inactive imported definitions. [Bot management](https://docs.x.ai/grok-bot/bots)                                                                                                                                                                                                             |
| Memory and long history       | Bots can save preferences, durable rules, important facts, and a dated work log. Personal Bots have separate memories with a small shared profile. The user can ask what a Bot remembers, and a conversation reset can preserve the Bot's memory and other state. The chat palette searches across chats and offers an older-message search. The enterprise inference-hook guide confirms that older context can be replaced by a summary and mentions internal transcript tools.                                  | Treat saved memory, model context, and retained transcript as distinct stores with different controls. Support both a user search view and agent recall. [Bot memory](https://docs.x.ai/grok-bot/bots#what-a-bot-remembers) · [Find prior work](https://docs.x.ai/grok-bot/chat-and-collaboration#find-prior-work) · [Inference hooks](https://docs.x.ai/grok-bot/inference-hooks)                                                               |
| Handoffs and shared chats     | Bots can send work to other Bots, and direct handoffs appear in their own chats. Users can also open a group of two to six Bots with visible collaboration. Some private requests, including approvals and credential requests, stay with the relevant Bot. Replies can be threaded, and voice calls can be reopened as transcripts.                                                                                                                                                                               | Direct delivery and explicit reply attribution are core. A shared discussion should have a distinct membership and visibility model, and private controls should stay in the agent's own conversation. [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration)                                                                                                                                                              |
| Skills and routines           | Skills encode repeatable procedures. Users create and edit routines in chat and can inspect, pause, test, or delete them. Triggers include schedules, tagged Bot email, Slack and other service events, and webhooks. The Bot gets a webhook's optional JSON body with its instructions. The documented bearer-key response acknowledges admission, while completion appears in chat and run history. The docs list a five-minute minimum schedule interval, up to 50 routines per Bot, and 20 recent run records. | Separate the repeatable method, trigger, execution receipt, and message that reports the result. Expose connector authorization and event-subscription authorization separately. These published limits describe Grok Bot. Council's limits should be measured independently. [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)                                                                                  |
| Proactive and background work | Cloud turns and routines keep running with the client closed. The primary Bot can proactively suggest work or report a disconnected app. Its notification setting controls alerts separately from the underlying check-ins. Release notes describe delegating coding to Cursor Cloud Agents and describe a Project as an agent that plans work and runs its own agents.                                                                                                                                            | Use an enrolled worker and explicit durable wake sources. Reuse Cantrip's Task and project execution lifecycle for delegated work. Surface unavailable workers and missed reports. [Grok Bot FAQ](https://docs.x.ai/grok-bot/faq) · [Initiative](https://docs.x.ai/grok-bot/initiative) · [Grok Bot changelog](https://x.ai/changelog/bot)                                                                                                       |
| Computer and files            | First-party enterprise docs describe Cursor-hosted per-user Firecracker VMs. Personal Bots for that user share a persistent filesystem, browser sessions, and logins, with separate screens. The history is stored separately from the computer. Local-device access is separately controlled. File results can be attached and handed back in chat.                                                                                                                                                               | Give personal agent state a private worker root and share particular artifacts through grants. Treat the enrolled worker as part of the trust boundary and keep placement explicit. [Enterprise architecture](https://docs.x.ai/grok-bot/teams-and-enterprises) · [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) · [Files and results](https://docs.x.ai/grok-bot/files-and-results)                                          |
| Plugins and connectors        | The app exposes an installation and sign-in workflow, account-wide connected apps, plugin-provided skills, and custom connectors. A custom connector can be a remote HTTPS MCP endpoint or a command on the Bot computer. Documented app OAuth tokens stay with Cursor's connector backend. An installed plugin can still require authentication.                                                                                                                                                                  | Separate catalog, installation, connector account, agent grant, and runtime availability. Support remote and command MCPs with the existing Cantrip configuration model and a dedicated execution policy. [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)                                                                                                                                                                      |
| Agent-authored integrations   | The documented tinkabot example turns an API into an MCP server and skills, tests the integration, and requests permission for publication. The marketplace accepts a reviewed MCP URL or public source repository. The public Bot gallery is a separate distribution path for Bot templates.                                                                                                                                                                                                                      | An agent can author an integration in a development workspace, propose a pinned version, and test it with fixtures. Private installation and public publication are distinct actions. [How Grok Bot works](https://docs.x.ai/grok-bot/how-grok-bot-works) · [tinkabot listing](https://x.ai/bot/marketplace/bots/tinkabot) · [Plugin submission](https://x.ai/bot/marketplace/submit-a-plugin) · [Bot marketplace](https://x.ai/bot/marketplace) |
| Credentials and review        | Vault and secure forms handle logins and other sensitive inputs. App OAuth and API secret entry have dedicated paths. Auto Review can apply custom user or team rules and ask before consequential operations. The team product exposes administrative policies and audit controls.                                                                                                                                                                                                                                | Provision credentials through a trusted UI and broker. Review exact actions with Cantrip's durable interaction mechanism. Keep credential data outside memory, transcripts, plugin configuration previews, and routine results. [Vault](https://docs.x.ai/grok-bot/vault) · [Approvals and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)                                                                                   |
| Team and channel access       | Team Bots have owners, managers, and collaborators, private teammate conversations, and reviewed shared learning. They can serve shared channels through Slack and Microsoft Teams. The launch material and product docs also cover calls and mobile access.                                                                                                                                                                                                                                                       | Start with owner-scoped agents. Team sharing and external-channel identity need a separate permissions model. An imported template should carry configuration only. [Team Bots](https://docs.x.ai/grok-bot/team-bots) · [Grok Bot 1.0](https://x.ai/news/grok-bot-1-0)                                                                                                                                                                           |

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
organization-level sharing and usage controls. Adoption in Council can build on
its artifact and run interfaces. Compatibility of individual connectors depends
on plan, account, and platform. [Grok Bot 1.0](https://x.ai/news/grok-bot-1-0) ·
[Enterprise controls](https://docs.x.ai/grok-bot/teams-and-enterprises)

## Cantrip foundations and proposed ownership

| Area                   | Existing Cantrip foundation                                                                                                                                                                                                                      | Council change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App mode               | `packages/protocol/src/settings.ts` defines IDE and Chat navigation state. The app shell and mobile mode switch own presentation. Standalone Chat shares the conversation machinery and has a worker-owned scratch directory.                    | Add capability-gated Council navigation and last destination. Reuse the transcript and composer with a Council-specific route, roster, run feed, and details. [Chat contract](CHAT.md) · [App settings schema](../packages/protocol/src/settings.ts)                                                                                                                                                                                                                                           |
| Durable chat and Codex | Server chat repositories, root admission, and canonical native history own execution and encrypted transcript state. The worker can start, resume, compact, observe, and recover Codex threads.                                                  | Attach an explicit Council conversation kind to a durable agent. Extend existing root admission and runtime resolution with Council scope. Add bounded recall and durability tests around compaction. [Runtime compatibility](CODEX_RUNTIME_COMPATIBILITY.md) · [Root admission](../cantrip_server/src/chats/roots/admission.rs) · [Worker compaction](../cantrip_worker/src/codex/turn/compact.rs) · [Canonical history patch](../cantrip_codex/patches/0017-managed-canonical-history.patch) |
| Queue and operations   | Project Agent chats already support encrypted, idempotent cross-chat messages within a project. Tasks have durable dispatch, target resolution, leases, and recovery. Agent Interactions persist user questions, approvals, and MCP elicitation. | Reuse the queue, protected envelopes, idempotency, and interaction primitives. Add explicit Council delivery and project delegation entry points with their own authorization. [Managed MCP](MCP.md#messages-between-agent-chats) · [Tasks](TASKS.md) · [Agent Interactions](AGENT_INTERACTIONS.md)                                                                                                                                                                                            |
| Automation             | Rust project automations already find due work, fence claims, and have workers decrypt conditions and inputs. The shared scheduling crate owns cron and time-zone behavior.                                                                      | Generalize reusable scheduling and claim mechanics. Add Council's independent trigger definitions, run records, inbox admission, and webhook endpoint. [Automation encryption](ENCRYPTION.md#project-automations) · [Automation dispatch](../cantrip_server/src/project_automations/dispatch.rs) · [Scheduling crate](../crates/cantrip-scheduling/README.md)                                                                                                                                  |
| Tools and inheritance  | Global and project MCP settings support worker binding, disabled overrides, stdio, Streamable HTTP, and native OAuth. Policies and skills have explicit audiences. Managed MCP catalogs already vary by runtime profile.                         | Add an effective Council tool and resource resolver. Retain global inheritance, support agent overrides and revocations, and compose narrowly scoped project tools at delegation. [Codex customization](CODEX_NATIVE_CUSTOMIZATION.md) · [Policies](POLICIES.md) · [Audience schema](../packages/protocol/src/audiences.ts)                                                                                                                                                                    |
| Security and placement | Endpoints decrypt protected chat, Task, workflow, and MCP data. The server tracks opaque content, authority, and placement. WorkerLink and App Live carry independently authorized data.                                                         | Give Council content and tool grants explicit agent scope, reusing the key and envelope conventions. Search and plugin execution run on authorized endpoints. [Encryption](ENCRYPTION.md) · [Multi-worker architecture](MULTI_WORKER_ARCHITECTURE.md) · [Live transport](LIVE_TRANSPORT.md)                                                                                                                                                                                                    |

The repository baseline contains no dedicated Council plan. These contracts
supply the starting boundaries. The retired Node reference applications remain
useful for historical compatibility evidence. The implementation targets the
production Rust server and worker.

### Service boundaries

- **App.** Owns roster navigation and human configuration. It encrypts settings
  and messages before submission, opens protected results, renders capability
  and run state, and handles exact approval responses. Council deep links
  identify opaque agent, conversation, message, run, or handoff IDs under the
  selected server. Switches between IDE, Chat, and Council preserve each mode's
  last destination.
- **Server.** Owns agent identities, relationships, revisions, grants, inbox
  ordering, run and trigger lifecycle, leases, canonical encrypted chat records,
  and authorization. HTTP remains authoritative and App Live emits bounded
  post-commit invalidations. WorkerLink is available for scoped live
  observations, while result history and search recovery use resumable requests.
- **Worker.** Owns the agent's restricted runtime and scratch root, invokes the
  existing Codex App Server and provider path, applies tools and credentials
  through scoped bindings, performs recall, executes authorized project work,
  and returns sealed outputs. A personal Council agent may have an always-on
  worker assignment. A desktop-bound local worker stops accepting execution when
  the machine or worker stops. The app shows the dependency.

### Identity and storage

A Council agent belongs to one Cantrip owner on one server. The initial product
supports multiple agents for that owner and one optional primary agent. Each
agent has one canonical Council conversation with zero or one currently active
Codex thread generation. The user-facing agent ID and conversation ID stay fixed
across model changes, supported worker moves, compaction, and runtime repair.
Native IDs and per-generation sequence mappings are internal. A new native
generation is admitted only after the prior generation is fenced or known
quiescent, using the supported restore or hydration path. When exact
continuation is unavailable, the UI explains the boundary and offers an explicit
restart of model context with the original timeline still visible. A Codex
console, when exposed, attaches through the managed console path to the same
root, using the same grants and single-root admission.

Use the existing encrypted chat repository and message sequence with an explicit
Council variant and an enforced one-agent-to-one-conversation relation.
Project-backed chats and standalone chats keep their existing contracts and list
filters. Council is account-scoped and has no synthetic project. Its personal
scratch root is distinct from project roots and is managed by the worker. Files
shared with another agent or project are explicit references or uploads to an
authorized artifact scope. Human project grants control what can be shared and
where.

The schema milestone will define the following records.

| Record                                    | Durable public routing state                                                                                                            | Protected endpoint content                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Agent and placement                       | Owner, agent ID, chat ID, status, primary marker, worker affinity, placement generation, configuration revision, timestamps             | Name, avatar settings, role instructions, preferences, runtime settings requiring protection        |
| Grants and effective resource assignments | Tenant, grant and scope IDs, explicit operations, endpoint or resource IDs, version, expiry, revocation status                          | Connector settings, secret reference labels, policy or skill definitions, project presentation data |
| Inbox and handoff                         | Input and source IDs, accepted order, source and target, correlation and causation IDs, revision, state, attempt and outcome references | Prompt, human and agent messages, result text, selected artifact descriptors                        |
| Routine, trigger, and run                 | Trigger ID and kind, due time, time zone, enabled state, version, run key, claim, fence, attempt, and outcome code                      | Name, prompt, filters, accepted event data, result, and semantic errors                             |
| Memory and recall                         | Memory IDs and scopes, revisions, tombstones, source message IDs, index protocol watermark when needed                                  | Facts and summaries, query and result snippets, encrypted index/checkpoint data                     |
| Integration and install                   | Version, digest, provenance reference, install state, granted capability IDs, connector binding, and owning worker                      | Private manifest content and fixtures, encrypted configuration, opaque secret references            |

Bind ciphertext to the account, scoped resource, record, field, and key revision
using existing envelope conventions. Review exact-agent derived keys and grant
limits with the encryption maintainers before adding scopes. Keep a separate
authority check for each run, search, interaction, credential broker call, and
project operation. A valid encrypted blob carries content integrity. Authority
to act comes from the current binding and permissions.

Support draft, active, paused, archived, and deleting states. Hiding or
unpinning changes navigation only. Pausing holds new execution and reports
queued or blocked work. Stop targets the current run and leaves a hold so queued
triggers cannot silently restart it. Archive disables triggers and new delivery,
keeps the timeline browsable, and requires explicit reactivation of routines on
restore. Deletion revokes admission, invalidates grants, cancels or fences
active work, removes derived recall and memory, and tracks offline worker
cleanup. Provide an export of retained data available to the owner before
permanent purge. A template or duplicate starts as a draft without source
transcript, learned memory, credential bindings, private artifacts, or active
triggers.

### Turn flow and recovery

1. A human message, authorized peer delivery, due routine, or accepted webhook
   creates a stable, attributed input. Persist the input, any source receipt,
   and the run reference in one transaction. Retrying an identical operation
   returns its receipt. A repeated operation ID with different content returns a
   conflict.
2. The dispatcher claims an eligible inbox item under a database-backed agent
   lease. Only one mutable Codex root turn may run for an agent at a time.
   Different agents can run concurrently within worker and account budgets. Take
   a versioned execution snapshot with the model route, provider account, exact
   worker, policy revision, and resource grants. Treat offline placement,
   missing provider or key access, and pending interaction as visible blocked
   states. Preserve FIFO within a source and give human inputs bounded priority
   without starving background work.
3. The worker verifies the execution binding, opens input at the endpoint,
   resolves current resources, and attaches to the managed Codex thread. Its
   initial context contains the role, effective policy, bounded memory and
   applicable run input. Stream provisional observations through existing
   transport and seal normalized messages, interaction records, results, and
   final canonical history as usual.
4. The worker reports the canonical start and terminal outcome against the
   active fence. A replacement claimant reconciles a possibly started turn
   before any replay. Stale workers cannot complete a newer claim or invoke
   brokered actions after revocation. Routine and peer inputs can wait with all
   clients closed, and approval requests use the existing interaction deadlines
   and interruption semantics.
5. Persist terminal outcomes before publishing notifications or follow-up
   inputs. A job whose external effect is uncertain is held for reconciliation.
   Reuse a stable action key at connectors that support idempotency and keep
   operation receipts. For external APIs without such support, only retry after
   determining the observed outcome or obtaining a fresh decision. Automatic
   retries cover known-safe failures, use bounded backoff, and remain attributed
   to the same run.

Use the existing provider selection, quota telemetry, and automatic fallback
rules. Put Council-specific limits around inbox growth, routine work, causal
fan-out, connector use, per-agent concurrency, and account spend. Expose what is
holding work and record the source of each run. Initial proposed defaults for
acceptance fixtures are four concurrent background turns per owner and one root
turn per agent, with production values tuned before rollout. Native Codex
subagents may be enabled within a run where the existing model and runtime
support them. Council peers remain persistent independent identities with
separately checked authority.

## History, recall, memory, and compaction

### Keep one durable transcript

Use the server's encrypted normalized message sequence for pagination, stable
links, user export, and retrieval. Preserve edited or replaced message handling
and the existing deletion semantics. Canonical Codex history retains the
material needed to resume its native thread. Its checkpoint and context
summaries have different purposes from the user-visible transcript. Project Task
transcripts and native child traces keep their current ownership. A Council
routine posts attributed input and output to the same Council conversation even
if the agent's model or native generation changed.

The design has three independently testable layers.

1. **Retained history.** Every retained user-visible message can be opened by
   stable ID, paged by position, and found for supported query terms when its
   index is current. The transcript UI can open a message even while its search
   index is rebuilding. Default indexing covers finalized user, assistant,
   routine, and peer messages plus explicit artifact descriptions. Attachment
   contents, tool output, and activity are opt-in by content class after scope
   and redaction review. Hidden reasoning, interaction secrets, provider
   credentials, and raw tool payloads stay outside the recall corpus.
2. **Memory.** Store small typed records such as a user preference, durable
   instruction, project fact, or decision. Each includes scope, source IDs,
   provenance, confidence where useful, optional expiry, and revision. Global
   profile facts are owner-editable and inherited by agents as a bounded set.
   Agent memory is private by default; sharing an item requires a separate
   authorized operation or explicit scope grant. The agent can propose,
   remember, revise, and forget facts within its grant. Promote shared or
   policy-like memory only through owner review. Show memory and source in the
   UI; supersede stale or conflicting records, and propagate deletion or
   redaction to summaries and search projections. Treat retrieved facts as dated
   evidence. Only configured policy and authority can grant permissions.
3. **Model context.** Keep role and effective policy, the current input, a
   bounded working-memory section, recent messages, and selective retrieval.
   Load heavier artifacts through tools. Derive budgets from the actual provider
   context window and reserve output and tool capacity. As starting values,
   allocate at most 4,000 tokens to durable memory plus automatic retrieval, at
   most five short automatic excerpts when an inbound request refers to earlier
   work, and keep at least 25% of the window available for generation, tool
   traffic, and compaction headroom. Measure against supported model routes
   before turning on automatic recall. Council works with manual recall tools
   even when the automatic query has no useful terms.

### Worker-local lexical search first

Prototype SQLite FTS5 on trusted workers. Use BM25 with bounded lexical query
construction and normalize natural language with a Unicode tokenizer. Add an
exact identifier and literal path lookup for issue numbers, case-sensitive
identifiers, URLs, and terms whose punctuation is meaningful. Each result
contains message ID, sequence, author/source, time, and a short snippet. Use a
deterministic score tie-breaker and stable continuation within an index
revision. Support date, agent, origin, and author filters. Return a
partial-coverage indicator and indexed-through watermark during backfill.
[SQLite FTS5 reference](https://www.sqlite.org/fts5.html)

Drive backfill and incremental updates from committed message sequence and
revisions, with durable invalidations and periodic gap repair. Persist the
covered range alongside each encrypted snapshot. Use a bounded snapshot upper
watermark for each backfill and apply updates and tombstones since that
watermark before claiming complete coverage. Derived storage is disposable.
Benchmark a memory-backed SQLite index with bounded, agent-scoped encrypted
snapshot chunks for fast restoration. If that path cannot meet durability,
memory, and latency goals, implement local encrypted database storage before
broad rollout. Verify temporary pages, journals, backups, exports, process
crashes, and deletion behavior. Never store plaintext index files or searchable
terms, snippets, queries, or vectors on the hosted server. Scope search to one
agent by default. An owner searching across agents fans out to the authorized
indexes, merges the authorized results, and shows which agents or workers were
unavailable. An offline worker never triggers a plaintext server fallback.
Normal encrypted history browsing remains available to an unlocked client.

Two bounded managed tools form the stable interface.

- `council_history_search` accepts free text, optional filters, and a cursor.
  Default to eight results and cap at 20, with snippets and index coverage. The
  caller's agent identity determines the corpus.
- `council_history_read` accepts exact message references or one reference with
  a short surrounding window. It rechecks current authorization, redaction, and
  existence and caps bytes and message count. User deep links navigate to that
  same message position. A peer can grant access to a selected result or send a
  sourced excerpt; its whole index remains private.

Separate indexing authority from the Codex shell. The worker search service
retrieves bounded canonical pages with its exact agent grant and returns
encrypted UI results or bounded text to the authorized agent runtime. Treat text
from old prompts, imported content, connectors, and messages from peers as data
with provenance. Do not re-inject it as policy, a current human message, or
approval.

For semantic recall, compare lexical search to a local-embedding prototype after
collecting a labeled corpus of real query shapes and synthetic long histories.
Put embeddings under the same agent scope, retention, and deletion contract.
Version the model and index and use hybrid ranking only if it improves recall on
paraphrases without degrading exact identifiers or violating the latency budget.
Cross-agent semantic search still needs explicit authority. Any external
embedding provider would require a separate opt-in that identifies the data
sent, which account is charged, and what retention applies. No semantic
dependency is required for the first launch.

### Compaction and cold recovery

Use the pinned runtime's supported native compaction. Preserve its
acknowledgement, event, checkpoint, and durability boundaries. Measure effective
context with real route telemetry. Start with a suggested 70–75% soft threshold
for a pending compaction when safe, preserve runtime automatic compaction, and
defer an explicit compaction across a live tool call, pending approval, active
native tree, or unsettled checkpoint. Compaction uses the same root lock and
must not construct a concurrent turn. Journal request and result identity so
that a disconnect after acknowledgement first reconciles actual App Server
state. A failed compaction leaves the previous durable history usable and
reports when the model context is constrained.
[Runtime compaction command](../cantrip_worker/src/codex/turn/compact.rs) ·
[Durable turn suspension](DURABLE_TURN_SUSPENSION.md)

Before dropping model context, verify that finalized messages for the affected
range are in canonical storage. Keep a bounded worker-side, encrypted handover
summary with covered sequence range, unresolved work, explicit decisions and
timestamps, and source links. Use native context plus targeted recall on normal
resume. On supported relocation or cold restart, hydrate with the existing
managed history facilities, then recover the essential working set from the same
transcript and memory. Tie checkpoint, index and summary revisions to the source
generation and redaction watermark. Rebuild derived state after purge or key
rotation, and invalidate any generation holding deleted context before further
inference. Keep transcript retention as an explicit product policy. A compacted
turn does not shorten the retained timeline.

## Handoffs, project work, and shared discussions

### Agent-to-agent work

Extend the existing encrypted delivery pattern with a Council inbox command.
Authenticate the sender from the active server-issued execution binding. Check
an owner-managed recipient grant at send time and again at dispatch time.
Same-owner roster discovery is bounded and returns only authorized recipients.
Delivery carries a stable operation ID, sender and recipient, purpose,
correlation and parent IDs, optional deadline, and authorized references.
Persist the delivery, encrypted sent and received timeline events, and optional
runnable input atomically. A visible handoff detail links those records and the
attributed reply. Received peer content stays attributed even when promoted to a
turn input, and a peer message cannot impersonate the owner or answer an
approval.

Offer two delivery intents, an informational note and a work request. A note
appears in the inbox and can be recalled without spending a model turn. A
request runs under the recipient's grants and may result in a structured
receipt, an answer, an attachment, a question for the user, or a refusal from
the recipient's policy. An acknowledgement or result does not start another turn
by default. The sender may opt in to one result-triggered continuation, which
consumes the original chain's limits. Busy or paused agents retain accepted work
without interrupting the current turn. A caller that needs asynchronous
completion can use status or subscribe by receipt. It should finish or release
its current turn rather than hold the agent lease while waiting on a peer that
may need it.

Set an explicit deadline, hop count, and budget for each causal chain. Use an
initial cap of four automated hops and 12 runnable deliveries per originating
event, plus per-owner and per-recipient rate limits. Reject repeats that would
create an executing cycle while allowing a reply to close a request. Creation
and changes to recurring or privileged work are privileged operations even when
requested by a peer. Approval requests go only to eligible human users through
Agent Interactions.

A later shared discussion can expose one attributed timeline with an explicit
member roster and mention-based dispatch. Messages from the thread become
bounded, provenance-labeled inputs to the selected members' own Codex
conversations. Joining a discussion grants access to its shared messages and
artifacts within membership rules. It does not expose a member's full private
history or inherit that member's connections. Test concurrent membership edits,
revocation, and approval visibility before enabling it.

### Project authority and delegation

Use owner-and-agent-specific project grants. Give each grant enumerated actions
such as discover project, read status and artifacts, propose or create a Task,
send a message to a selected project Agent chat, and read its authorized result.
The user chooses each project and allowed actions. Existing project constraints,
project policies, current permissions, and hosted restrictions remain in force.
Revoking the relationship stops new operations immediately and fences pending
callbacks and credential issuance. The project runtime's own history and
worktree rights follow its current owner and project rules.

Read-only operations use Cantrip's existing project target resolver and
authorized worker command path. A Council agent begins in its own scratch root.
Its project tools reference opaque project, replica, worktree, chat, or task
IDs. The server resolves the actual execution endpoint and verifies the
operation against current placement, ownership, and grants. Project read results
are opened on authorized endpoints and persist in Council only if the action
permits that data flow. Council has no implicit host filesystem, project
checkout, or repository credential access.

For implementation, use a project Task as the first delegated unit, then support
an explicit send to a selected existing project agent. Extend the typed server
admission operations with Council provenance. Share only the brief, approved
artifact references, requested target and effect, and result destination. Let
the existing Task scheduler, current target or worktree lease, project policy,
model availability, and approval path own execution. Offer Direct Tasks first
and route Plan + Goal through its existing review lifecycle in a follow-up.
Carry a stable Council handoff ID without changing project Task retry semantics.
Return progress and terminal results by ID, and optionally post a bounded
project result to the Council agent. If a grant is revoked mid-task, sever
future Council delivery and display a revoked link. Let the project's owner and
existing controls govern any already admitted task.

Later, a user may explicitly grant interactive project-backed console or
operation sessions from Council. Those sessions require their own project
execution binding, evaluated policy, and isolation from the agent's private home
and credentials. They cannot make the agent's long-lived personal root
accumulate mounts from several projects. Worktree-managed changes continue
through the current worktree and repository workflow. A Council orchestration
run can prepare work for review and track its outcome. Merge, deploy, publish,
and other consequential operations follow the applicable project policy and
exact action approval.

## Routines, automations, and webhooks

A routine belongs to one agent and has a versioned method, an input schema, one
or more triggers, an execution policy, and a result destination. It can reuse an
enabled skill. Support manual tests, calendar or interval schedules, generic
webhooks, and later provider-specific event adapters. Preserve the complete run
and attempt timeline according to explicit retention settings. The app shows
next due time, time zone, current status, skipped or missed work, last result,
originating event, and next dependency. A test records its own run without
consuming the next scheduled slot. Making a live test that can cause an external
effect follows the same approvals as a normal run.

An agent can propose or edit a routine in conversation. A proposal shows the
actual schedule in the owner's time zone, the input scope, target, capabilities,
delivery destination, and relevant connector accounts. The owner can answer
questions using existing interactions and approve the exact revision. A proposal
from another agent is input to that decision. A later human answer can supersede
the earlier agreement without altering an already admitted run. Permit a human
to grant a tightly scoped routine-management capability after this workflow is
established. A prompt or historical memory never enables a trigger on its own.

### Schedule and worker semantics

- Reuse Cantrip's cron and IANA time-zone rules, and build elapsed intervals on
  the scheduler's existing clock and claim primitives. Define schedule revision,
  nominal due time, next occurrence, and DST behavior. Preview actual upcoming
  occurrences, including skipped or repeated local wall times. Use a unique run
  identity comprising trigger revision and nominal UTC occurrence.
- Use durable due discovery, database leases, compare-and-set admission, and a
  transactional outbox to enqueue once logically. Duplicate wakeups, retries, or
  processes can deliver the same event, so deduplicate at both the run and chat
  admission boundaries.
- Default to at most one pending scheduled occurrence per routine while another
  is active. Record missed occurrences and coalesce at most the most recent
  eligible occurrence within the configured lateness window. After that, record
  them as skipped. Pause blocks new admissions. If the user wants to stop
  already accepted work, act on its run explicitly. Changes to configuration
  affect future admissions and cannot expand a running snapshot's permissions.
- Track queue and execution deadlines, blocked lease expiry, safe retries,
  manual replay, and explicit cancel. Freeze the input and correlation IDs for
  admitted work. Resume after restart by reconciling the persisted native start
  receipt and external effects. A replay is visibly linked to the original and
  never silently broadens the event scope.
- Support a routine feeding another routine or periodic report through explicit
  result selectors. Store event time, completed time, original window, source
  links, and expiry. Consumers can wait up to a declared freshness deadline or
  report stale and missing dependencies. Use the same causal limits as peer
  handoffs.

### Authenticated event entry

Expose a small HTTPS webhook surface with an opaque exact trigger ID, a
per-trigger signing secret, and bounded request size and rate. Publish a
documented HMAC signing format that binds the method, trigger ID, timestamp, and
raw body with test vectors. Verify before parsing semantic content, require a
bounded replay window and caller-supplied event ID, and support rotation with
revocation of the old secret. Bind deduplication to trigger and event ID, with a
payload digest to detect conflicting reuse. Return a stable admission or
duplicate receipt after durability, normally `202 Accepted`. Provide status
through an authenticated Council route or scoped receipt facility. Rate-limit by
source and trigger, and record only coarse delivery outcomes in logs.

Council workers should receive external event data through encrypted envelopes.
Use an enrolled worker ingress public key to encrypt semantic payloads for their
authorized endpoint if the chosen sender can seal the payload. A generic SaaS
webhook commonly sends plaintext. Make that trust boundary explicit: a
separately enabled worker-owned ingress adapter or user-controlled bridge may
receive, verify and seal plaintext before Cantrip server storage. A server
ingress option for pre-sealed payloads supports offline queueing without access
to semantic plaintext. Hosted ingress accepts ciphertext and can authenticate
the submission without decrypting semantic content. Keep the trigger signing
credential in server-managed transport credential custody, separate from the
execution worker's payload key. Bind each sealed envelope to the trigger, event
ID, recipient and key version. A registered bridge authenticates upstream
deliveries, seals the payload, and signs its submission with a separately
rotatable ingress credential. On user-controlled or local installations, use a
reachable ingress on an always-on enrolled host if delivery must continue with
the personal device closed. Document key rotation and queued-event
compatibility, endpoint public reachability, upstream retry behavior, and how
worker moves change routing and admission. Preserve a delivery ID across the
app, adapter, server, and worker so operators can trace genuine retries without
logging bodies.

Treat every payload and any retrieved attachment as untrusted data. Validate its
schema at the endpoint, cap strings and fields supplied to the model, and supply
source metadata distinctly from agent and routine instructions.
Provider-specific GitHub, monitoring, email, or messaging adapters can map their
documented signatures and immutable event IDs to the same admission model. Use
fixture services for initial development. Report connector login and trigger
subscription as independent states.

## Inherited settings, credentials, and tools

### Effective configuration

Council uses existing account settings for provider profiles, global Policies
and Skills, installed integrations, and any applicable global MCP
configurations. Add Council explicitly to the policy and skill audience model.
Preserve existing `ide`, `chat`, and `both` semantics during migration so an
upgrade does not repurpose prior user instructions. A versioned audience set can
express Council and an explicit all-modes choice, with current defaults retained
for existing entries. New Council agents inherit account resources marked
available to Council. Expose versioned mode and audience fields to capable
clients. Preserve the legacy IDE and Chat wire projection for older clients and
use partial updates so an old client cannot erase a Council destination or
assignment.

Resolve mandatory policy and account constraints before agent role and resource
settings. Built-in Council tool names are reserved. Optional MCP or skill
definitions resolve by stable identity, using global defaults and deliberate
agent overrides; an explicit disabled override suppresses the inherited entry.
Worker binding must match the selected execution endpoint. Project-specific
overrides apply within the separately bound project execution; no independent
project configuration is flattened into the personal root. Show the effective
set, provenance, capability approvals, and missing tools in agent details. A
configuration change takes effect on the next safe native attach. Runtime calls
still recheck current revocable capabilities. Tool appearance in Codex never
grants authority.

Use native Codex for ordinary approved shell, file, reasoning, skill, and MCP
work. Add a managed Council MCP profile for the typed Council operations. Start
with `council_agent_list`, `council_send`, `council_handoff_status`, the two
history tools, memory proposal and read tools, routine proposal and status, and
project delegation and status. Use the existing tool catalog and broker
mechanics, with dedicated Council bindings and limits inherited by subagents.
Optional browser and computer-use tools can target an explicitly granted
worker-owned session through existing supervised paths. For background runs,
grant narrow capabilities up front, stop at existing human interaction
boundaries, and keep unrestricted execution profiles outside the automated
Council path.

### Secrets and connector accounts

Store account-level or agent-level grants referencing opaque credential
identities and connector accounts. Use the existing encryption custody, scoped
worker grants, and protected provider-account leases as design foundations.
Humans add API keys or complete OAuth through trusted UI. Workers resolve grants
against exact owner, agent, connector instance or version, operation, and worker
placement. OAuth refresh material stays in the trusted endpoint's credential
store or supported connector backend, and short-lived access material is scoped
to connectors that actually need it. Prefer requests mediated by the broker, so
the model and Codex shell do not receive credential strings. Keep inference
provider credentials separate from integration credentials.

An agent may inherit the ability to use a globally allowed integration. Resolve
a specific connector account and scope before actual work. Per-agent deny,
disconnect, rotation, deletion, or reassignment takes effect on the next
authorized operation and invalidates applicable leases. “Connected” reports
account authentication, while “available” reports the effective grant and worker
compatibility. Credential prompts for background runs appear only as scoped
interactions in the owning agent's view. Don't expose raw secret content in
environment snapshots, generic terminal commands, transcripts, search,
summaries, diagnostics, exports, or child runtimes. If a third-party executable
requires a raw credential in its environment, treat it as a trusted recipient
authorized for that particular secret, pin the executable, and confine what it
can reach. Do not claim the model or its tools are isolated from a secret that
is available in the same unrestricted process boundary.

Use actual tool, target, requested effect, and latest policy for consequential
approvals. Show the proposed action and relevant source so the human can decide.
An approval is bound to the operation, execution and policy revision. Reject
stale or altered requests. For an integration whose operation effect cannot be
classified reliably, require an explicit decision or keep it in the unprivileged
development path. Webhook payloads, agent messages, recall, and connector
responses cannot answer or create grants.

## Plugins and agent-authored integrations

Ship a Cantrip catalog and private plugin installation in stages. Treat a
catalog listing as discoverable metadata, a plugin version as immutable content
with a digest, an installation as an account or worker resource, and an agent
binding as explicit use authority. The manifest specifies publisher, name and
version, compatible Cantrip and transport versions, declared tool operations,
requested permissions, runtime and placement, external origins, authentication,
included skills, and test fixtures. Include bounded resource budgets and effect
classifications where they can be enforced. Channel adapters and Bot templates
have their own install flows. A template can reference an integration but
requires the recipient's own explicit connection and grant.

Plugins can use either supported transport.

- **Remote MCP.** Reuse worker-side Streamable HTTP, HTTPS by default, and
  app-mediated OAuth where supported. Preserve the caller's specific account and
  tool scope. Evaluate the actual endpoint and redirects under the worker's
  egress policy. Treat private-network or local service access as a distinct
  user-granted worker placement. Bound handshake, tool schemas, sessions,
  requests, and response bytes. Server metadata or instructions supplied by a
  remote endpoint do not authorize anything.
- **Worker command MCP.** Support approved pinned command and argument arrays
  over stdio through the existing worker mechanism. Run private or third-party
  packages under a dedicated identity or isolated runtime with a bounded
  filesystem, explicit network capabilities, clean environment, and process
  limits. Read-only fixtures and mock credentials are the default during
  validation. For platforms without the required isolation, keep agent-authored
  packages in explicit remote or development use and explain why managed install
  is unavailable.
  [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
  ·
  [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

The agent-authored flow starts from an API description and desired actions. The
agent proposes schemas and requested capabilities, writes a small MCP server and
optional skill in a scoped workspace, and runs contract tests against mocked or
explicitly approved test endpoints. It produces a versioned artifact with
dependency lock and source provenance, asks for private installation of the
exact version and scopes, and receives a fresh restricted runtime binding after
installation. It can then suggest a routine using the integration. No production
secret is needed to develop the fixture, and the dev runtime receives no
production grants by default.

Updates introduce a new immutable revision. Review changed capabilities,
preserve the previous signed or hash-verified version for rollback, and require
approval for new grants. Disable or uninstallation revokes bindings, stops
supervised processes, and makes affected routines visibly blocked. Retain
provenance in past runs. A first-party catalog should focus on maintained
integrations with clear read-only workflows, such as source control, monitoring,
and documents, and show setup and test status on the user's selected worker.
Expand into a substantial library through curated listings and a review process
with artifact integrity, permission declarations, compatibility tests, and a
removal and notification path. Agent-generated integrations remain private by
default. Public submission and publication require explicit review and
authorization.

## App experience and operations

- Add Council to the top-level mode switch on desktop, browser, and mobile
  behind a server capability. Retain current project navigation and settings
  behavior. Show a roster with primary agent, per-agent status, unread handoffs,
  and approval indicators. Let users rename, pin, hide, pause, archive, restore,
  or duplicate a draft. Avoid conflating sidebar visibility with a running or
  paused state.
- Reuse the chat transcript, composer, model selection, context meter,
  attachment previews, and existing interaction cards. Add searchable retained
  history with jump-to-message, clearly attributed trigger and peer rows,
  receipt links, and a view of why work is blocked. Show context consumption
  separately from index coverage and retained history. Earliest stored message,
  last indexed sequence, and latest compaction can be inspected independently.
- Give each agent a details view for role, worker, model, memory, tools, skills,
  credential references, permitted projects, permitted peers, and routines.
  Display effective versus configured resources with origin and health.
  Signed-in device integrations, if added, show which device must be online and
  where approval goes.
- Show triggers, run history, messages, and artifacts on one causal run detail
  view backed by stable IDs. Include queued, blocked, running, waiting for
  input, succeeded, failed, skipped, canceled, and requires-reconciliation
  statuses, with targeted controls. Set a notification policy for approvals,
  final failures, and meaningful results. Notify with IDs and a generic summary
  while locked, and use unlocked client context for protected text.
- Emit structured metrics for queue delay, trigger lag, duplicate admissions,
  lease recovery, waiting interactions, context utilization, quota, search
  coverage, and result freshness. Redact user data and credential material from
  logs and traces, including body digests unless explicitly required in
  protected durable state. Use scoped IDs for operator correlation.

## Implementation milestones

Each milestone is independently deliverable through a separate change and has
local verification. Keep new surfaces capability-gated until their production
paths meet the corresponding acceptance checks. Roll back by disabling new entry
points and claims while preserving existing encrypted state and allowing
explicit recovery or export. Do not rewrite IDE or Chat rows into Council or
repurpose their active queues.

| Milestone                                      | Implementation                                                                                                                                                                                                                                                                                                             | Exit evidence                                                                                                                                                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Agent identity and native turn              | Add versioned protocol, Council agent and conversation records, scoped worker placement and grants, routes and App Live events, and minimal app roster and composer. Integrate chat root admission, model routing, and managed App Server.                                                                                 | Create two agents, send messages on both, switch modes, reconnect and restart. Each agent resumes the correct Codex conversation and the other's files, tools, and transcript stay outside its grants. Existing Chat and IDE paths remain compatible with upgraded and older clients.     |
| 2. Retained history, memory, and compaction    | Implement authorized canonical replay, FTS and exact lookup, index rebuild and purge, memory CRUD and provenance, context budgeting, and native compaction recovery. Ship user search and the read and search tools.                                                                                                       | Locate an early source through both UI and MCP after repeated compactions and a cold runtime restart. Verify exact links, partial coverage, redaction, rotation, offline behavior, and encrypted server and disk boundaries. Run the long-history benchmark below.                        |
| 3. Council coordination and project delegation | Add peer grants, delivery chain, holds and reconciliation, primary agent, run detail, project grants and target binding, Direct Task delegation, and result receipts. Add later targeted project-chat delegation and Plan + Goal reuse behind their own capabilities.                                                      | Two agents hand off a scoped project investigation, and the recipient works through the proper worker and worktree. Busy, paused, revoked, retry, result-callback, and cycle cases preserve attribution and avoid duplicate turns.                                                        |
| 4. Routines and external events                | Reuse scheduling primitives, implement durable routine definitions and claims, approval and test actions, encrypted generic webhook and trusted bridge, then provider adapters. Add run history, dependencies, and notifications.                                                                                          | With the app closed, one scheduled and one webhook wake run on a real unattended worker. Retry duplicate webhooks and restart across claim and start boundaries. Verify stale results, DST, pause, rotation, missed occurrences and outbound approvals.                                   |
| 5. Integration catalog and authored MCP        | Add versioned catalog and installs, allowed global inheritance and per-agent overrides, remote MCP, OAuth and credential broker, isolated command sandbox, generation, fixtures, and exact installation approvals. Start with curated integrations supporting a complete read-only workflow.                               | An owner installs a known connector, uses it from a granted agent, and an agent authors and privately installs a new fixture-backed MCP integration. Verify showable grant provenance, revoke while live, update and rollback, and process and credential isolation.                      |
| 6. Extend and qualify                          | Evaluate semantic recall, add shared discussions and template portability, broaden event and catalog coverage, and qualify native platforms and hosted operation. Team agents, external channels, device app access, and direct project sessions can ship in follow-ups with their own authorization and placement models. | Compare lexical and hybrid recall with the same fixtures and decide on measurable value. Run the reference briefing workflow across real worker placements and verify usage and recovery on supported deployments. Shared discussion and template tests exercise private data boundaries. |

### Verification and launch criteria

1. **History and context.** Seed at least 50,000 retained messages per agent,
   with early decisions, rare identifiers, URLs, overwritten memories, duplicate
   terms, multiple languages, and newer contradicting messages. Use known
   fixture answers and source IDs. Test exact lookup, text ranking, filtered and
   older pagination, newest and deleted revisions, same-message links from app
   and MCP, repeated compaction, and cold restart. Set a proposed warm indexed
   search budget of p95 under 250 ms on a reference worker, excluding network.
   Report cold rebuild cost and partial coverage at each checkpoint. Compare
   lexical versus hybrid recall at 10 on a labeled paraphrase set, alongside
   exact-target recall and end-to-end answer grounding. Test automatic retrieval
   against the planned prompt budget using actual usage observations.
2. **Durable runs.** Exercise PGlite and PostgreSQL, a restart between receipt,
   claim, delivery, start and settle, and a two-replica scheduler where
   coordination is supported. Reissue identical and changed input under the same
   idempotency key. Lose acknowledgements, revoke a worker or grant, pause while
   work is queued, cancel at the interaction boundary, and reconnect with a
   stale claim. Assert logical admission and recorded outcome from authoritative
   state. Use a fake API with stable operation keys and a non-idempotent fixture
   that produces an uncertain result.
3. **Project and peer isolation.** Exercise distinct accounts, different
   workers, no project grants, a read-only grant, an approved Task grant, target
   relocation, stale callbacks, and a revoked read. Check that peer references
   resolve only under explicit owner and artifact access. Attempt to use prompt
   text from a webhook, connector, historical transcript, Task result, or peer
   message as a human authorization and verify it does not acquire privileges.
   Verify a chain can report success, ask for help, or fail without generating a
   reply storm or holding a deadlocked agent lease.
4. **Routines and security.** Inspect live behavior with app closed, worker
   offline, after recovery, around DST shifts, during backlog and rate-limit
   pressure, and while changing a schedule. Run signed payload fixtures,
   including duplicate, replayed, expired, rotated, malformed, and oversized
   cases. Inspect server persistence, logs, bundles, worker temporary files,
   network traces, and exports with canary values for unauthorized plaintext.
   Ensure grants, worker bridge credentials and OAuth scopes can be revoked
   without breaking unrelated agents.
5. **Product acceptance.** Run the briefing scenario from the Product section on
   desktop and browser and verify the corresponding mobile navigation and
   approvals. Track user answer precedence in the routine revision, source
   freshness in the briefing, and navigation to the original project run.
   Exercise installing, authoring, testing, approving, updating, disconnecting,
   and disabling an integration through normal product entry points. Verify
   hiding an agent leaves intended work active, archiving holds it, restoring
   does not re-enable triggers, and deletion invalidates searching including on
   an offline worker's next authorized reconnect.

Use `pnpm --filter @cantrip/protocol test`, `pnpm server:test`,
`pnpm worker:rust:test`, `pnpm --filter @cantrip/app test`, and runtime
compatibility and packaged acceptance fixtures appropriate to each milestone.
Include an actual pinned Codex integration test for compaction and recovery, and
a managed worker integration test against an MCP fixture for tools and authored
plugins. Run the repository verification for code milestones and document
platform-specific results.

### Decisions to validate during implementation

- Determine the worker footprint and crypto storage for the derived index with a
  restart, rebuild, and key revocation prototype. Pick the production approach
  before storing searchable material on disk.
- Qualify history hydration and native compaction on every supported Council
  model and worker target. Record whether context survives each failure boundary
  and where a user-visible fresh model generation is required.
- Select enforceable command-MCP isolation by platform. Make the
  operator-managed worker or isolated remote path usable where local isolation
  is insufficient for third-party packages.
- Specify webhook bridge hosting and source profiles for self-hosted deployments
  before offering public endpoints. Confirm the conversion from standard webhook
  delivery to encrypted durable admission, especially when the execution worker
  is offline.
- Set supported retention, worker scheduling, and budget defaults using the
  acceptance measurements. Decide on semantic retrieval and shared discussions
  after the lexical and direct-handoff flows meet their documented goals.

The first complete Council workflow has a stable Codex-backed roster, retained
and searchable history, scoped inheritance and credentials, direct handoffs,
project delegation, schedule and webhook execution, and catalog and privately
authored MCP integration. Its acceptance scenario follows one result from a
retained source message through a peer handoff, project work, a recurring
report, and a user-visible briefing with traceable provenance.
