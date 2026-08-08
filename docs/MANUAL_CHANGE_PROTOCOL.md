# Manual Change Protocol

Use this protocol when a user directly asks an agent to change CareMap code, configuration, scripts, documentation, assets, or migrations without assigning a GitHub issue. Persistent GitHub issue workers use `docs/agents/WORKER_PROTOCOL.md` instead.

This protocol applies when the agent will author repository changes. It does not require a new worktree for read-only investigation, QA, issue creation, or an explicit request to inspect or package pre-existing user-owned changes.

## Non-negotiable delivery model

Every manually requested change must be authored in its own isolated Git worktree and branch, then delivered through a pull request with squash auto-merge enabled.

Do not:

- edit the primary `main` checkout to implement the change,
- commit directly on `main`,
- push directly to `main`,
- combine unrelated dirty work with the requested change,
- invent or claim a GitHub issue merely to use the issue-worker workflow,
- bypass a failing repository check with an administrative merge.

## 1. Inspect before creating the lane

From the primary repository checkout:

1. Run `git status --short --branch` and preserve any existing user or agent work.
2. Run `git fetch origin --prune`.
3. Inspect `git worktree list`, current branches, and relevant open pull requests for overlapping work.
4. If another active change overlaps the request, report the collision instead of mixing work.

A dirty primary checkout does not authorize modifying or cleaning it. Create the manual-change worktree from `origin/main`, leaving the primary checkout untouched.

## 2. Create an isolated worktree before editing

Use a unique descriptive branch and a temporary path outside the primary checkout. For example:

```bash
git worktree add \
  -b agent/manual/<change-slug> \
  /tmp/caremap-<change-slug> \
  origin/main
```

If that branch or path already exists, choose a unique suffix. Confirm the new lane with:

```bash
git -C /tmp/caremap-<change-slug> status --short --branch
```

All implementation, validation, staging, and committing for the request must happen inside this worktree.

## 3. Implement and validate

- Keep the diff scoped to the direct request.
- Preserve the current CareMap architecture and repository conventions.
- Do not copy unrelated files or uncommitted changes from another checkout.
- Run validation proportional to the change. `git diff --check` is the minimum; code changes should also run the relevant typecheck, lint, build, tests, or focused smoke checks.
- Inspect the final diff and branch status before committing.

## 4. Commit, push, and open the pull request

Create one coherent commit unless the requested change genuinely benefits from multiple commits. Then push only the manual-change branch and open a ready pull request against `main`:

```bash
git push -u origin HEAD
gh pr create --base main --head "$(git branch --show-current)" \
  --title "<concise change title>" \
  --body "<summary and validation>"
```

The pull request body must state what changed and which validations ran. A GitHub issue reference is optional and should only be included when a real related issue already exists.

## 5. Enable and observe auto-merge

Request squash auto-merge after the pull request is open:

```bash
gh pr merge <pr-number> --auto --squash
```

The optional PR Gate workflow may be intentionally disabled. A
`disabled_manually` workflow, an empty check list, or the absence of a PR Gate
run is not a blocker: request auto-merge anyway, and allow GitHub to merge the
pull request immediately when the remaining repository rules are satisfied.

If a check actually runs and fails, or the branch conflicts with newer `main`,
fix the manual-change branch and let GitHub evaluate it again. Do not use
`--admin` to bypass checks and do not manually merge a pull request with a
failing check.

## 6. Sync and clean up

After GitHub reports the pull request merged:

1. Fetch `origin` again.
2. If the primary `main` checkout is clean, fast-forward it with `git pull --ff-only`.
3. If the primary checkout is dirty, do not alter it; report that `origin/main` advanced and leave synchronization to the owner.
4. Remove only the temporary worktree you created, after confirming it is clean.
5. Never remove another agent's worktree or branch.

The final response should name the branch, pull request, merge result, validation performed, main synchronization state, and any worktree left behind intentionally.
