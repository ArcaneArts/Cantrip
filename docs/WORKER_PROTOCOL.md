# CareMap Issue Worker Protocol

This protocol is for persistent Codex worker tasks running in separate managed
Git worktrees. The task prompt supplies `AGENT_NAME` and `AGENT_SLUG`; this file
supplies the shared workflow.

## Objective

Perform exactly one healthy issue cycle at a time:

1. Resume the agent's own unfinished branch or pull request, if one exists.
2. Otherwise claim one useful, unclaimed GitHub issue.
3. Implement and validate only that issue.
4. Push an agent-owned branch and open a ready pull request.
5. Arm squash auto-merge and leave GitHub's repository rules plus any checks
   that actually run to decide when the change can enter `main`.

Never push directly to `main`, bypass repository rules, use `--admin`, or work
on more than one issue in a cycle.

## Required Identity

The task prompt must set both values explicitly:

- `AGENT_NAME`, such as `Bob`
- `AGENT_SLUG`, such as `bob`

If either value is missing or still looks like a placeholder, stop without
claiming work.

All branches owned by the agent use this prefix:

```text
agent/<AGENT_SLUG>/
```

The GitHub account is shared by the workers. GitHub author identity therefore
does not establish ownership; branch prefixes and named claim comments do.

## Repository And Architecture

Do not assume a fixed filesystem path. Managed worktrees live under Codex's
worktree directory. Start by verifying:

```bash
git rev-parse --show-toplevel
git remote get-url origin
git status --short --branch
```

The expected remote is `ArcaneArts/CareMap`.

Authoritative architecture:

- React/Vite client and Capacitor shell in `caremap_app/`
- Fastify/Node API in `caremap_server/`
- React/Vite marketing site in `caremap_site/`
- PostgreSQL behind the Node API; migrations are the schema source of truth
- DigitalOcean Spaces for active object storage
- DigitalOcean App Platform deployment through `.do/app.yaml`
- Guide > Sequence > Page > Block authoring
- Dedicated editor and player routes
- Server-owned permissions, copy, media, session, answer, report, and schedule
  operations

MyGuide, Firebase, SurrealDB, CockroachDB, GCP, and TiKV references are
historical unless an issue explicitly concerns legacy import behavior.

Read `README.md`, the relevant parts of `docs/BASELINE_PLAN.md`, and source/tests
related to the issue. Read `docs/old/11.md` and `docs/old/12.md` only when legacy
product behavior is relevant.

## Start Or Resume Safely

Run:

```bash
git status --short --branch
git fetch origin --prune
gh auth status
gh pr list --state open --limit 100 \
  --json number,title,headRefName,baseRefName,url,isDraft,mergeStateStatus,statusCheckRollup
```

Then determine ownership before selecting new work.

Resume instead of claiming a new issue when any of these apply:

- the worktree has uncommitted changes from this agent's current issue;
- the checked-out branch begins with `agent/<AGENT_SLUG>/` and is not finished;
- an open pull request has a head branch beginning with that prefix;
- an open issue has this agent's active named claim and no later release or
  completion marker.

If the worktree is dirty and ownership is unclear, do not discard, stash,
overwrite, or commit the files. Report the collision and stop.

When there is no unfinished work and the tree is clean, update the lane before
claiming:

```bash
git switch --detach origin/main
```

Do not delete an old local agent branch unless its pull request is merged and
no work depends on it.

## Pull Request Continuation

An existing pull request owned by this agent has priority over new work.

- If checks fail, inspect the check logs and fix the issue when it remains in
  scope.
- If review comments are actionable, address them before doing anything else.
- If the branch conflicts with current `main`, rebase only the agent's own clean
  branch onto `origin/main`, validate, and push with `--force-with-lease`.
- If checks are pending and auto-merge is armed, do not claim another issue.
- The optional PR Gate workflow may be intentionally disabled. A
  `disabled_manually` workflow, an empty check list, or the absence of a PR Gate
  run is not a blocker: arm auto-merge anyway, and allow GitHub to merge the PR
  immediately when the remaining repository rules are satisfied.
- If the pull request merged, confirm the linked issue closed, return to a clean
  detached `origin/main`, and only then consider a new issue on a later cycle.

Never force-push another agent's branch.

## TestFlight Feedback Intake

TestFlight feedback can be synchronized into a shared local inbox with
`pnpm testflight:feedback:pull`. See `docs/agents/TESTFLIGHT_FEEDBACK.md` for
the storage layout and privacy rules.

Downloaded feedback is not a GitHub issue and is not automatically claimable
work. Inspect it only when the user asks for feedback triage. Agents may record
findings and draft an issue proposal locally, but must not create an issue or
upload any feedback artifact without the user's explicit approval.

## Claim Protocol

Use `gh` from the worktree. List open issues, then inspect the full body,
comments, reactions, labels, and related pull requests for candidates. Never
assume that an open issue is claimable from its title alone.

An active claim contains:

```text
<!-- caremap-agent-claim -->
Agent: <AGENT_NAME>
Agent-Slug: <AGENT_SLUG>
Status: started
```

`started`, `resumed`, `pull-request-open`, and `blocked` reserve the issue.
`released` and `completed` do not reserve it. A later status from the same
agent supersedes that agent's earlier status. If claims race, the earliest
active named claim wins.

Eyes reactions alone are legacy/unknown ownership evidence. Avoid those issues
unless comments clearly establish release or completion.

Before claiming, also inspect open pull requests from other workers. Avoid a
candidate whose likely files or subsystem substantially overlap another active
worker branch, even when it is a different issue.

Choose exactly one issue that is:

- independently implementable in one worker cycle;
- grounded in current code and product direction;
- useful to the CareMap MVP or current reliability;
- clear enough to validate;
- not already fixed, claimed, blocked, or represented by an open pull request.

Do not create filler issues or claim a broad epic merely to stay busy. If no
safe issue exists, stop cleanly.

Immediately before claiming, re-fetch the issue. Then post:

```text
<!-- caremap-agent-claim -->
Agent: <AGENT_NAME>
Agent-Slug: <AGENT_SLUG>
Status: started

I am starting work on this issue.

Plan:
- <brief implementation and validation direction>

I will publish an agent-owned pull request and request squash auto-merge after
the pull request is open.
```

Add an eyes reaction when practical, re-fetch the issue, and verify that this
agent won any claim race. If another active claim is earlier, post `released`
and select another issue or stop.

After winning the claim, create a unique branch from the current detached
`origin/main`:

```bash
git switch -c agent/<AGENT_SLUG>/<ISSUE_NUMBER>-<short-description>
```

## Implementation Rules

- Keep changes tightly scoped to the selected issue.
- Prospect before editing: inspect the implementation, nearby components,
  relevant migrations, existing patterns, and focused smoke tests.
- Preserve Guide > Sequence > Page > Block and use “block,” not “plugin.”
- Keep blocks inside guide authoring rather than creating top-level Blocks
  navigation.
- Prefer existing component and design-system patterns over one-off CSS.
- Keep browser/mobile database access behind the Node API.
- Keep sensitive, privileged, external, deep-copy, media, report, and complex
  validation operations server-owned.
- Treat sessions, answers, events, and reports as distinct records.
- Preserve responsive, touch-first, safe-area, and offline considerations.
- Never add credentials, signing material, production secrets, or keystores.
- Never modify another agent's branch or agent-specific notes.

To reduce merge conflicts, do not edit `docs/MEMORY.md`,
`docs/BASELINE_PLAN.md`, `docs/old/*`, or another agent's memory file unless the
selected issue explicitly requires that documentation change. GitHub claims,
branches, pull requests, checks, and issue comments are the operational source
of truth for worker coordination.

Do not stop or reset shared Docker, PostgreSQL, API, or browser sessions owned
by another task. Prefer focused checks that do not require persistent services.
If a temporary process is necessary, use an available lane-specific port and
stop only the process started by this agent.

## Validation

Run checks proportional to the change and include focused smoke coverage where
the repository already provides it. At minimum run:

```bash
git diff --check
```

Use relevant combinations of:

```bash
pnpm -r typecheck
pnpm -r lint
pnpm -r build
pnpm <focused-smoke-script>
```

For UI work, perform focused browser or Playwright QA when a safe isolated or
existing server is available. For backend changes, run the relevant server and
migration checks. Do not claim validation that did not run. When enabled, the
optional GitHub PR Gate independently runs dependency installation, the
committed-secret scan, workspace typecheck, and changed-file whitespace checks.
Its absence does not replace or invalidate the worker's own proportional
validation. Focused lint, build, smoke, and browser checks remain the worker's
responsibility when the issue warrants them.

## Commit, Push, And Pull Request

Before committing:

1. Re-read the issue acceptance criteria.
2. Inspect `git status`, the full diff, and staged scope.
3. Remove generated or unrelated changes caused by validation.
4. Confirm no secret or signing material is included.
5. Run `git diff --check`.

Commit the issue as a coherent change. Include `Fixes #<ISSUE_NUMBER>` in the
commit subject or body. Then push only the agent branch:

```bash
git push -u origin HEAD
```

Open a ready, non-draft pull request targeting `main`. Its body must contain:

- a concise summary;
- the implementation and user impact;
- validation actually performed;
- `Fixes #<ISSUE_NUMBER>` on its own line.

Immediately after creating the pull request, request repository-controlled
auto-merge:

```bash
gh pr merge <PR_NUMBER> --auto --squash
```

Never use `--admin`. Never manually merge while a check that actually ran is
failing. A disabled or absent optional PR Gate is not a failed check and must
not delay the auto-merge request. Never push the feature commit directly to
`main`.

Post this issue status after the PR exists:

```text
<!-- caremap-agent-claim -->
Agent: <AGENT_NAME>
Agent-Slug: <AGENT_SLUG>
Status: pull-request-open

Implementation is published in PR #<PR_NUMBER>.

Validation:
- <checks actually run>

Commit:
- <short hash>

Auto-merge has been requested. GitHub may merge immediately when no required
checks are configured; otherwise it remains subject to the checks that run.
```

If GitHub reports that auto-merge is unavailable, do not merge manually. Leave
the PR open and report the exact state.

## Blocked Or Released

Use `blocked` when the issue must remain reserved but cannot proceed without a
requirement, external state, or PM decision. Include the blocker and the PR or
branch state.

Use `released` only when no unsafe partial work remains and another worker can
safely take the issue. Do not release an issue while an auto-merging PR still
targets it.

Never hide a failed check, conflict, incomplete acceptance criterion, or
validation gap merely to keep the queue moving.

## Final Response For Each Cycle

Keep the result concise and state:

- agent name and slug;
- resumed or newly claimed issue;
- branch and PR;
- implementation completed;
- validation results;
- auto-merge/check state;
- any blocker or collision;
- whether the worktree is clean.

Do not leave development servers or command sessions running unless they were
already intentionally running before the cycle.
