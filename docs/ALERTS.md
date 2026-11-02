# Project Alerts

Alerts are a durable projection of currently actionable source conditions.
The Alert Inbox and its badge counts do not own execution state. Opening an
alert never approves a request, starts implementation, or resumes a goal.

## Source lifecycle contract

| Source       | Identity / episode                                          | Opens or updates                                                 | Resolves                                                              |
| ------------ | ----------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| Interaction  | Exact request id and immutable request episode              | Pending permission, approval, input, or elicitation              | Response, expiration, interruption, source retirement                 |
| Task review  | Task chat id and planning round                             | Questions, plan review, implementation decision                  | Next planning round, accepted finalization/implementation, retirement |
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

The Alert Inbox and discovery UI follow in later milestones. Each milestone is
delivered through its own worktree and merged PR.
