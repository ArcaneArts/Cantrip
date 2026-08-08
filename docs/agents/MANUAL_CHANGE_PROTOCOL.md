# Cantrip Manual Change Protocol

Use this protocol when a user directly asks an agent to change Cantrip code,
configuration, scripts, documentation, assets, or migrations without assigning
a GitHub issue.

It applies when the agent will author repository changes. It does not require a
new worktree for read-only investigation, QA, issue creation, or an explicit
request to inspect or package pre-existing user-owned changes.

## Non-negotiable delivery model

Every manually requested change must be authored in its own isolated Git
worktree and branch, then delivered through a pull request with squash
auto-merge enabled.

Do not:

- edit the Primary `main` checkout to implement the change;
- commit or push directly to `main`;
- combine unrelated dirty work with the requested change;
- clean, stash, reset, move, or adopt changes from the Primary checkout;
- invent or claim a GitHub issue merely to justify a worker workflow;
- bypass repository rules or a failing check with an administrative merge; or
- remove another user or agent's worktree or branch.

## 1. Inspect before creating the lane

From the Primary repository checkout:

1. Run `git status --short --branch` and preserve any existing user or agent
   work.
2. Run `git fetch origin --prune`.
3. Inspect `git worktree list`, current branches, and relevant open pull
   requests.
4. Confirm `origin/main` contains the baseline required by the requested
   change.
5. If another active change substantially overlaps the request, report the
   collision instead of mixing work.

A dirty Primary checkout does not authorize changing it. Create the
manual-change worktree from `origin/main` and leave Primary untouched.

## 2. Create an isolated worktree before editing

Use a unique descriptive branch and a temporary path outside the Primary
checkout. For example:

```bash
git worktree add \
  -b agent/manual/<change-slug> \
  /tmp/cantrip-<change-slug> \
  origin/main
```

If the branch or path already exists, choose a unique suffix. Confirm the lane:

```bash
git -C /tmp/cantrip-<change-slug> status --short --branch
```

All implementation, validation, staging, committing, and pushing for the
request happens inside that worktree.

For a large goal, use sequential, independently mergeable milestones. Each
milestone receives its own worktree, branch, pull request, merge observation,
and cleanup cycle. Do not create a pull request for every automatic
continuation or trivial edit.

## 3. Implement and validate

- Keep the diff scoped to the direct request or named milestone.
- Preserve Cantrip's app/server/worker boundaries: the app talks only to the
  server, the server owns durable state and routing, and workers own files,
  Git, PTYs, and Codex runtimes.
- Do not copy unrelated files or uncommitted changes from another checkout.
- Use the worker command protocol for worker-owned filesystem behavior rather
  than adding app-to-worker access.
- Add migrations and protocol validation when persisted or transported state
  changes.
- Run validation proportional to the change. `git diff --check` is the minimum.

The standard repository check is:

```bash
pnpm check
```

Use relevant focused checks as needed:

```bash
pnpm --filter @cantrip/protocol test
pnpm --filter @cantrip/server test
pnpm --filter @cantrip/worker test
pnpm --filter @cantrip/app test
pnpm --filter @cantrip/app build
cargo fmt --manifest-path cantrip_app/src-tauri/Cargo.toml -- --check
cargo check --manifest-path cantrip_app/src-tauri/Cargo.toml
git diff --check
```

Do not claim validation that did not run. Inspect the final diff and branch
status before committing.

## 4. Commit, push, and open the pull request

Create one coherent commit unless the milestone genuinely benefits from
multiple commits. Push only the manual-change branch and open a ready pull
request against `main`:

```bash
git push -u origin HEAD
gh pr create --base main --head "$(git branch --show-current)" \
  --title "<concise change title>" \
  --body "<summary and validation>"
```

The pull request body must state what changed and which validation ran. A
GitHub issue reference is optional and must refer to a real related issue.

## 5. Enable and observe auto-merge

Request squash auto-merge after opening the pull request:

```bash
gh pr merge <pr-number> --auto --squash
```

An intentionally disabled optional workflow, an empty check list, or the
absence of an optional gate is not a blocker. Request auto-merge anyway and let
GitHub merge immediately when remaining repository rules are satisfied.

If a check actually runs and fails, or the branch conflicts with a newer
`main`, fix only the manual-change branch and let GitHub evaluate it again. Do
not use `--admin` and do not manually merge a pull request with a failing check.

Observe the pull request until GitHub reports it merged before starting a
dependent milestone.

## 6. Sync and clean up

After the pull request merges:

1. Fetch `origin` again.
2. If the Primary `main` checkout is clean, fast-forward it with
   `git pull --ff-only`.
3. If Primary is dirty, do not alter it; report that `origin/main` advanced and
   leave synchronization to the owner.
4. Confirm the temporary worktree is clean.
5. Remove only the temporary worktree created for this change.
6. Never remove another agent's worktree or branch.

The completion report must name the branch, pull request, merge result,
validation performed, Primary synchronization state, and any worktree left
behind intentionally.
