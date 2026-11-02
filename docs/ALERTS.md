# Project Alerts

Alerts are a durable projection of currently actionable source conditions.
The Alert Inbox and its badge counts do not own execution state. Opening an
alert never approves a request, starts implementation, or resumes a goal.

## Source lifecycle contract

| Source       | Identity / episode                                          | Opens or updates                                                 | Resolves                                                              |
| ------------ | ----------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| Interaction  | Exact request id and immutable request episode              | Pending permission, approval, input, or elicitation              | Response, expiration, interruption, source retirement                 |
| Task review  | Task chat id, planning round and attention occurrence       | Questions, plan review, implementation decision                  | Next planning round, accepted finalization/implementation, retirement |
| Task blocker | Task chat id and execution/blocker episode                  | Explicit actionable blocker/failure                              | Blocker resolved, execution resumes, completion/retirement            |
| Goal         | Chat id and goal execution episode                          | Explicit blocked, budget-limited, or actionable failed execution | Execution resumes, completion/retirement                              |
| Agent        | Authenticated originating chat, logical key, and occurrence | Scoped agent attention tool                                      | Originating agent resolves it or source advances/retires              |

Reading, ordinary idling, missing observations, and deliberate pauses do not
create or resolve attention. Independent pending requests remain independent.
Producers must suppress duplicate representations of the same causal wait.

## Projection foundation

The shared SQL projection uses a stable hash of owner, project, source, source
id, and episode id. Producers supply a monotonically increasing source revision.
Equal or older revisions are replayed without a write. A resolved episode is a
terminal tombstone, including when resolution arrives before opening. A new
attention episode gets a new identity. Creation time is preserved on updates.

The database transaction owns projection writes and commit-time notifications.
Both server runtimes execute the same SQL functions. Each runtime forwards
notifications as owner-scoped `project-alert` App Live invalidations; they carry
only owner/project routing metadata. A reconnect reads authoritative state.

`GET /api/projects/:projectId/alerts` returns open alerts with a bounded limit
(default 50, maximum 100) and an optional `after` alert-id cursor. Ordering is
priority ascending, then occurrence time descending, then stable id. Resolved
rows remain usable as pagination anchors. Unknown or foreign projects/cursors
return 404. Unknown query keys and malformed limits/cursors return 400.

`GET /api/project-alerts/counts` aggregates nonzero counts across the current
owner's accessible projects. It does not read transcripts, decrypt task plans,
or contact workers. Archived chat sources are excluded from reads and cannot
create fresh open projections. Source producers must also retire their rows.

System alert details stay in their original protected source records. Agent
alert details use stored `alert-content` endpoint ciphertext bound to their
originating chat. The projection contains validated routing and classification,
not plaintext questions, permission details, titles, or blocker explanations.

## Delivery milestones

1. Shared foundation: projection, contracts, list/count APIs, live invalidation.
2. Authoritative interaction producers and lifecycle reconciliation.
3. Task/goal producers and scoped agent tools.
4. Owned Alert Inbox tab, navigation, and quick actions.
5. Conditional sidebar tile and live project-switcher counts.
6. Full-flow browser/compatibility qualification and final documentation.

Interaction requests now project permissions and user-input alerts transactionally
from their authoritative source rows, including native computer-use approvals.
The migration reconciles pending requests once. Existing resolution,
interruption, expiration, and deletion operations close the exact request alert.
The expiry sweep runs once per server; inbox/count reads also expire due requests.

Stop and archive create terminal alert tombstones. Restoring a Chat does not
restore retired alerts. A deliberate automation pause leaves pending attention
intact. Native terminal turn records retire only requests with the matching
owner, worker, Chat, thread, and turn; late deliveries for those turns remain
closed. Released execution lanes also retire their requests. Existing legacy
turn cleanup continues to terminalize its own exact requests. Classification
never depends on an idle status or a missing runtime observation.

Task state now projects review readiness and explicit actionable failures in the
same transaction. An accepted dispatch hides review readiness immediately;
canceling that dispatch exposes a fresh review occurrence. Explicit blockers
remain actionable on paused execution leases. Scheduled automatic retries and
intentional pauses do not create attention. Completion retires agent Alerts too.

Normal Agent Goals use actual native Goal observations. The worker encrypts
objectives with existing Chat protection and persists an atomic private outbox.
Delivery preserves resume boundaries, retries independently per source, and uses
the authenticated worker process UUID plus a durable sequence. The server checks
the current Chat/root/thread binding. Old processes and delayed revisions cannot
revive retired attention. Reconnect refreshes known noncomplete Goals using the
bound runtime; badge reads never open runtimes or choose another model/account.
Task Goals use the Task source, avoiding a second representation of the same wait.

Agents can call `alert_raise` with a UUID key, increasing revision, reason and
next step; `alert_resolve` closes only that Chat's exact key. Retired keys remain
closed. These tools are available with read-only file permissions, but still
require the current authenticated execution lane. They cannot forge a system
permission request or clear another Chat's Alert. Details use `alert-content`
protection; a missing optional grant causes the actual tool call to fail, without
blocking ordinary Chat execution. Agents should not duplicate existing structured
permission, Task review or Goal blocker Alerts.

## Alert Inbox

`project.alerts` is an owned project singleton surface. It can close, reopen,
move between supported panes, and detach/return through the normal workspace
ownership path. Opening another Alert Inbox focuses its existing view/window.
An open empty inbox stays open. Lists use bounded 25-row cursor pages.

Expand an alert to see its original request or protected source context. The
same interaction cards submit exact scoped responses, and Task review reuses
the current planning round's answers, autosave/version protections, and explicit
implementation controls. Failed actions remain visible with an error; retries
reuse their idempotency key. Reading or navigating never executes a decision.

Agent Alerts show the originating Chat's name and protected explanation/next
step. Normal Goal snapshots are readable from authorized durable storage even
when their worker is offline. Goal execution controls remain in the current
Chat so a stale inbox row cannot change a replacement Goal.

Open Chat/Task uses workspace ownership to focus existing destinations. A
short-lived, account/server-scoped routing hint reveals the exact interaction,
Goal, turn, or Task review section in the destination window. It carries only
routing metadata, expires after navigation, and never sends a response.

Conditional discovery and cross-project live counts follow in the next cycle.
Each milestone is delivered through its own worktree and merged PR.
