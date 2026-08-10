# Git client

Cantrip's Git client is deliberately worktree-aware. The app selects an
explicit project worktree and talks only to the Cantrip server. The server
authorizes that worktree, routes bounded commands to its worker, and owns
durable coordination state. The worker owns the checkout, Git process, GitHub
CLI authentication, files, and credentials.

Git commands use argument arrays rather than shell interpolation. Revision,
ref, path, remote, and user-supplied values are validated at the protocol and
worker boundaries. Potentially large histories, file lists, messages, and
patches are bounded or paginated.

## Commit inspection

Click any commit row in a History tab to open its inspector. It includes the
full bounded message, author and committer identities and timestamps,
signature state, refs, parent and child navigation, aggregate change stats,
and the files changed relative to the selected parent. Merge commits allow a
different parent to be selected; root commits compare against the empty tree.
File patches are fetched lazily through the reusable revision-diff endpoint,
and use the same side-by-side viewer as working-copy changes. Renames, deleted
files, binary files, and truncated messages, file lists, or patches are marked
explicitly.

Manual QA:

1. Open a History tab and click a normal, root, and merge commit.
2. For a merge, select each parent and confirm file counts and patches change.
3. Follow parent and child revision buttons and confirm the inspector updates.
4. Open added, deleted, renamed, and binary files and confirm intentional
   empty/binary states and rename labels.
5. Repeat with the worker offline and confirm an error appears without falling
   back to another worktree.

## Arbitrary comparisons

Open a History tab and choose **Compare**. Endpoint A and endpoint B can be
selected from a searchable list of local branches, remote branches, tags,
HEAD, and every known project worktree HEAD. While the comparison is open, the
compact A/B controls on commit rows can assign either endpoint directly from
the graph.

Direct mode shows the patch needed to transform A into B. Merge-base mode
shows changes introduced on B since the common ancestor of A and B. The panel
always states that direction, reports commits unique to either side and
ahead/behind counts, and exposes bounded changed-file stats and lazy per-file
patches through the shared diff viewer.

Manual QA:

1. Compare two divergent local branches in direct mode and confirm files from
   both sides appear as additions/deletions as appropriate.
2. Switch to merge-base mode and confirm only B-side changes since the common
   ancestor are shown.
3. Select a tag, remote branch, and named worktree HEAD through search.
4. Assign A and B from graph rows and confirm the direction and result update.
5. Open a comparison file patch, then reverse A and B and confirm the patch
   direction changes.
6. Compare unrelated histories directly, then confirm merge-base mode reports
   the missing common ancestor intentionally.

## Hunk and selected-line staging

Open **Working changes** and select a staged or unstaged text file. Changed
lines have selection controls, while each hunk header selects or clears the
whole hunk. Unstaged selections can be staged or discarded; staged selections
can be unstaged. Whole-file buttons remain available in the file list.

Every partial mutation is a two-step operation. The worker constructs and
validates the exact patch, the app shows that patch in the shared diff viewer,
and the server applies it only with the matching review token. The worker
rebuilds the patch immediately before applying it, so stale selections are
rejected instead of targeting newly changed content. Git's own `apply --check`
is also required before a preview is returned.

New and deleted files can be partially staged safely, including files without
a trailing newline. Partial rename and file-mode metadata changes are disabled
and direct the user to the existing file-level action. Binary and truncated
patches are likewise intentionally non-selectable. A file that has both staged
and unstaged content retains the other scope when only one scope is changed.

Manual QA:

1. Edit two separated lines in a tracked file, select one replacement, review
   the exact patch, stage it, and confirm the other edit remains unstaged.
2. Select and unstage one staged hunk, then discard one unstaged hunk after
   reviewing the destructive confirmation.
3. Partially stage a new file and a deleted file and confirm both staged and
   unstaged entries remain.
4. Change a file after opening its patch preview and confirm apply rejects the
   stale review.
5. Inspect binary, rename-only, mode-only, and truncated changes and confirm
   the UI keeps their file-level actions but disables partial selection.
6. Stop the selected worktree's worker and confirm preview/apply reports the
   offline worker without falling back to another worktree.

## Stashes and shelves

Open a History tab and choose **Stashes**. The compact inspector lists the
selected worktree repository's bounded stash stack with names, timestamps,
file counts, aggregate stats, changed files, and lazy per-file patches in the
shared diff viewer. New stashes can include staged changes, unstaged changes,
and untracked files. A staged-only stash uses native Git behavior. When staged
changes are excluded, the worker builds an isolated shelf with a temporary Git
index so the real index remains untouched and the saved patch does not silently
include staged content.

Apply keeps the stash. Pop removes it only after a successful apply. A stash
can also create a branch from its base commit. Drop and clear are destructive;
all actions first show an authoritative worker preview, and apply requires its
matching token. Moving stash positions or changing the working copy invalidates
that token. If apply, pop, or branch produces conflicts, Cantrip reports the
conflicted paths in the common Working changes surface and keeps the stash
recoverable.

Manual QA:

1. Create full, staged-only, unstaged-only, and unstaged-plus-untracked stashes
   and confirm excluded scopes remain in the selected worktree.
2. Inspect tracked, untracked, binary, and large stash files and confirm lazy
   patches and intentional binary/truncation states.
3. Apply a stash and confirm it remains; pop a clean stash and confirm it is
   removed only after its changes appear.
4. Create a branch from a stash and confirm the branch starts at the recorded
   base, receives the stash, and becomes the selected worktree branch.
5. Create a conflicting change, pop the stash, and confirm its paths appear as
   conflicts while the stash remains in the list.
6. Preview a drop or clear, mutate the stash stack elsewhere, and confirm the
   stale action is rejected before deletion.
7. Disconnect the selected worktree's worker and confirm the list and actions
   fail without targeting another worktree.

## Branch management

Open a History tab and choose **Branches**. The compact, searchable inspector
separates local and remote refs while keeping the selected worktree explicit.
Each row shows its latest commit, merged state, upstream availability,
ahead/behind counts, and any worktree that currently owns the local branch.
The header explains that Cantrip pulls are fast-forward-only; fetch and explicit
fetch-plus-prune remain separate reviewed actions.

Branch actions are worker-owned and use bounded Git argument arrays. Cantrip can
create or switch branches, track a remote branch, publish, rename, set/change/
unset upstreams, and delete local or remote refs. Every mutation receives a
fresh authoritative preview token. Git refs, HEAD, index, or working-copy
changes invalidate stale confirmations. Local deletion is merged-only unless
the user explicitly chooses force deletion, while remote deletion and pruning
always receive destructive confirmation. A branch checked out in another
worktree cannot be switched to, renamed, or deleted from the selected lane.

Manual QA:

1. Create a branch from HEAD and from another local or remote ref, both with
   and without switching the selected worktree.
2. Publish a local branch, change and unset its upstream, then confirm the row
   updates ahead/behind and remote availability without a full page reload.
3. Rename a current and an inactive local branch. Confirm an upstream is not
   silently renamed and the review warns about that distinction.
4. Attempt to switch, rename, or delete a branch checked out in another
   worktree and confirm Cantrip identifies its owning lane and refuses.
5. Delete a merged local branch, then review an unmerged branch and confirm
   force deletion requires a separate explicit choice.
6. Delete a remote branch and run fetch-plus-prune, confirming each review
   names the exact remote/ref scope before it runs.
7. Change a ref after opening a preview and confirm apply rejects the stale
   token. Disconnect the worker and confirm no operation falls back to Primary.

## Remotes, tags, and GitHub releases

Open a History tab and choose **Repository**. Remotes, tags, and releases stay
scoped to the selected worktree and its assigned worker. Remote rows expose
separate fetch and push URLs, explicit default fetch/push selection, and
individual fetch or fetch-plus-prune. Cantrip strips URL credentials before a
remote ever crosses the worker boundary, including credentials in URL query
parameters. Add, edit, remove, default, and prune operations use authoritative
preview tokens; destructive or credential-changing operations are called out
before apply.

The searchable tag list distinguishes lightweight and annotated tags, shows
the peeled target and remote publication state, and lazily loads full annotation
messages. Signature status, signer, key, and fingerprint are retained when Git
can verify them. Creating, pushing, deleting locally, and deleting from a named
remote are reviewed operations. Remote discovery is bounded and a failed remote
is reported without hiding local tags.

GitHub-backed projects also list releases and can create one from an existing
local tag. The form supports a title, Markdown notes, draft state, and
prerelease state; existing releases link to GitHub for the complete hosted
view. Release calls run on the selected worktree's worker so its GitHub identity
and local tag inventory stay authoritative.

Manual QA:

1. Add a remote with different fetch and push URLs, edit both, select default
   fetch/push remotes, and confirm the compact list updates after each review.
2. Configure a credential-bearing HTTPS URL and confirm credentials never
   appear in the app, server response, warnings, or logs.
3. Fetch one remote, then fetch-plus-prune it; verify prune is marked
   destructive and a changed remote invalidates an open preview.
4. Create lightweight and annotated tags at HEAD and another revision. Confirm
   messages appear only on annotated tags and signature state is explicit.
5. Push a tag, delete it from the remote, and then delete it locally. Confirm
   each operation names the exact tag and remote before it runs.
6. Inspect a signed and unsigned tag and verify signer/key/fingerprint metadata
   is shown only when Git provides it.
7. Create draft, prerelease, and published GitHub releases from local tags, then
   open each hosted release in GitHub.
8. Disconnect the selected worker and confirm remotes, remote tag checks, and
   releases fail explicitly without falling back to another worktree.

## Commit and history actions

Right-click a commit row, or open its inspector and choose the actions menu, to
cherry-pick, revert, create a fixup commit, or amend current HEAD. All actions
run against the selected worktree through its assigned worker. Cherry-pick can
target one commit or an inclusive, ancestry-validated range of full commit
hashes; the worker resolves the range oldest-first and rejects merge commits
that would need an ambiguous mainline. Merge reverts require an explicit
mainline parent and show which parent Git keeps.

Before apply, Cantrip creates a detached temporary worktree at current HEAD and
runs cherry-pick or revert without committing. The resulting aggregate patch,
affected files, and predicted conflicts are shown in the shared diff viewer.
The real worktree must remain clean, and apply recomputes the preview so changed
refs, index state, or working files invalidate the review token. Amend and
fixup use only staged changes and block when unstaged or conflicted files are
present. An amend creates a `refs/cantrip/checkpoints/...` recovery reference to
the original HEAD before rewriting it.

If cherry-pick or revert conflicts, Cantrip does not claim success or clean up
the Git sequencer. The result records the operation type, original/current HEAD,
source sequence, current step, and conflicted paths, then directs the user to
Working changes. This shared operation envelope is the basis for the resumable
continue/skip/abort controls in the next Git milestone.

Manual QA:

1. Right-click a normal commit and cherry-pick it into another clean worktree;
   confirm the exact preview patch matches the resulting commit.
2. Cherry-pick an inclusive two-or-more commit ancestry range and confirm the
   commits apply oldest-first. Try unrelated endpoints and confirm preview is
   rejected.
3. Preview a conflicting cherry-pick and confirm the warning appears before
   apply. Apply it, verify the sequencer remains active, and open its conflicted
   files through Working changes.
4. Revert a normal commit, then revert a merge while selecting each possible
   mainline parent. Confirm a merge revert cannot proceed without that choice.
5. Stage a change and create a fixup commit. Verify its subject targets the
   selected commit and unstaged changes block the action.
6. Stage a change, amend HEAD, and confirm the original commit remains
   reachable at the displayed Cantrip recovery ref.
7. Open a preview, change HEAD or the working copy elsewhere, and confirm apply
   rejects the stale review. Disconnect the worker and confirm no action falls
   back to another worktree.

## Resumable merge and rebase operations

Open **Operations** from a History tab, or choose **Merge into current** or
**Rebase current onto** from a branch row. Both workflows remain bound to the
History tab's explicit worktree. The worker resolves the selected source and
current local branch, requires a clean worktree, and runs a detached temporary
worktree preview before the real mutation. Cantrip shows the affected commits,
files, exact bounded patch, predicted conflicts, and stale-review token. Rebase
also creates a `refs/cantrip/checkpoints/rebase-...` recovery reference before
rewriting commit identities.

The server records an operation before asking the worker to mutate Git. Its
durable row includes worker/worktree ownership, source and target refs and
revisions, original and current HEAD, current/total steps, pending commits,
conflicted paths, bounded command output, checkpoint, and timestamps. Active
states are unique per worktree and survive app or server reconnection. The
server refreshes them against Git's merge, rebase, cherry-pick, or revert
sequencer state when the assigned worker is available; while it is offline the
last authoritative state remains visible instead of falling back to another
worker.

**Continue** is enabled once Git's index has no unresolved entries. Rebase,
cherry-pick, and revert can **Skip** where Git permits it, while every active
operation can **Abort**. Completion, failure, and abort are terminal durable
states. Status, history, branch, and operation queries are invalidated only
after authoritative worker results, and project worktree observation refreshes
all affected lanes.

Manual QA:

1. Merge a clean, divergent branch and confirm preview files and patch match
   the resulting merge. Repeat with a fast-forward merge.
2. Preview a conflicting merge, start it, reload the app, and confirm source,
   target, original HEAD, step, output, and conflicted paths remain visible.
3. Resolve and stage all merge paths in Working changes, return to Operations,
   continue, and confirm history and every worktree marker refresh.
4. Rebase a multi-commit branch onto a divergent ref, verify the recovery ref,
   then continue through one conflict and skip a later commit.
5. Start another rebase, restart the server or disconnect/reconnect the worker,
   and confirm the same durable operation resumes without targeting Primary.
6. Abort merge, rebase, cherry-pick, and revert conflicts and confirm each
   selected worktree returns to its recorded original HEAD.
7. Change HEAD or the worktree after preview and confirm start rejects the stale
   token. Try starting a second mutation while one is active and confirm it is
   blocked with the active operation named.

## Conflict resolution

When a durable merge, rebase, cherry-pick, or revert reports unmerged index
entries, the Operations panel opens a compact conflict resolver. Its path list
comes from `git ls-files -u`, not from conflict markers. Each row identifies the
Git conflict kind and exposes the available base, ours, and theirs stages. Text
stages and the worktree result are bounded to 2 MB; binary and oversized content
remain resolvable without pretending that they can be rendered.

The result editor supports whole-file ours, theirs, both, current-result,
manual, and delete choices. Standard and diff3 conflict blocks can also be
resolved one block at a time before reviewing the combined manual result. Every
choice receives an exact preview and a token bound to all three index-stage
object IDs plus the current worktree result. A changed conflict invalidates the
review. After apply, the worker stages the path and re-reads the unmerged index;
Cantrip reports success only when that path has no stage 1/2/3 entries.

Conflict reads and writes always target the selected project worktree through
its assigned worker. The server serializes mutations, persists the owning
operation's updated conflict state, publishes live invalidations, and keeps
continue disabled until every unmerged path is verified resolved. Stash
apply, pop, and branch conflicts enter the same durable resolver. Before a
stash mutation, the worker records a Cantrip checkpoint that includes existing
staged, unstaged, and untracked work. **Finish** keeps an applied stash or drops
the source only for pop/branch semantics; **Abort** resets the attempted result
and restores the exact checkpoint. A conflicted pop never removes its source
stash early.

Manual QA:

1. Create a text merge conflict and verify base, ours, theirs, result, conflict
   kind, and path all match `git ls-files -u` and the worktree.
2. Resolve separate blocks with ours, theirs, and both; edit the final result,
   review it, apply it, and confirm the file is staged with no unmerged entries.
3. Resolve modify/delete, add/add, both-deleted, mode, rename-related, binary,
   and no-newline conflicts using applicable whole-file actions.
4. Open a resolution preview, change the result or index elsewhere, and confirm
   apply rejects the stale token.
5. Resolve every path, reload or reconnect another client, and confirm the
   durable operation becomes awaiting-user-action and Continue is enabled.
6. Disconnect the assigned worker and confirm conflict detail and mutations
   fail explicitly without falling back to Primary or another worktree.
7. Apply and pop a conflicting stash over a worktree with staged, unstaged,
   and untracked changes. Resolve and finish one run, abort another, and verify
   the source stash and checkpoint semantics in both cases.

## Interactive history rewriting

Choose **Rewrite** in the History tab's Operations panel, then select an
ancestor of the current branch. The worker resolves every commit after that
upstream and returns a complete pick-only plan. Each commit must remain in the
todo exactly once, but the plan can reorder it or change its action to pick,
reword, edit, squash, fixup, or drop. Reword requires its replacement message;
squash and fixup require an earlier retained commit; dropping every commit is
rejected. The exact validated Git todo is shown before Start becomes available.

Preview runs the complete plan in a detached temporary worktree. Edit steps are
continued without changes for preview purposes, while conflicts remain visible
as a bounded patch. Apply recomputes the plan and selected-worktree fingerprint,
so changed commits, refs, files, or plan contents invalidate the token. Before
the real rewrite, Cantrip preserves original HEAD under a
`refs/cantrip/checkpoints/rewrite-...` recovery ref.

Sequence and reword editor state lives under the repository's private Git
directory rather than the source tree, allowing reword, squash, and conflict
continuation after worker or server reconnects. An explicit edit step pauses as
awaiting user action. Stage changes through Working changes and use **Amend and
continue** with an optional replacement message, or continue without amending.
The normal conflict resolver, skip, continue, and abort controls remain durable
through the server-owned operation record.

Manual QA:

1. Load a five-commit plan, reorder it, reword one commit, squash and fixup two,
   drop one, validate, and compare the displayed todo with the resulting log.
2. Change a plan after validation and confirm Start remains disabled until the
   exact todo and patch are recomputed.
3. Pause at an edit step, change and stage a file, amend the commit message,
   reconnect the app, and continue the remaining plan.
4. Cause a conflict after a reword step, restart the worker, resolve it, and
   verify later queued reword messages still apply to their intended commits.
5. Abort an edit or conflict and verify HEAD returns to the recovery ref's
   commit while the recovery ref itself remains inspectable.
6. Attempt a missing, duplicated, all-drop, or leading squash/fixup todo and
   confirm the worker rejects it without mutating the selected worktree.

### Published-history protection

Interactive rewrite previews compare the selected range with every local
remote-tracking ref. If a remote ref already reaches the range, the review
shows a prominent published-history warning and names those refs. Completing a
rewrite never pushes automatically.

When the current branch has both outgoing and remote-only commits, **Push**
opens a separate destructive review. The worker fetches the configured
upstream, records its authoritative commit as an exact lease, and returns
bounded lists of the local commits to publish and remote commits that will stop
being reachable from that branch. The user must type the exact
`remote/branch` before apply is enabled. Apply recomputes the preview and then
uses `--force-with-lease=refs/heads/<branch>:<expected-oid>`; any local or
remote movement invalidates the token or lease rather than overwriting newer
work. Fast-forward pushes continue to use the normal Push action.

Manual QA:

1. Rewrite a commit already present on the upstream branch and verify the plan
   names the published remote-tracking ref before Start.
2. Complete the rewrite, choose Push, and verify the dialog lists both the
   commits removed from the remote branch and the replacement local commits.
3. Confirm the destructive button stays disabled until the exact remote/branch
   text is entered, then push and verify ahead/behind returns to zero.
4. Preview a force push, advance the remote from another clone, and verify
   apply refuses to overwrite the new remote commit.
5. Verify an ordinary ahead-only branch pushes without the destructive dialog.

## GitHub pull request creation

Open a project's Issues tab in **Pull requests** mode and choose **Pull
request**. Creation remains bound to the History tab's explicitly selected
worktree. The head selector contains only local branches; the worker refuses
to create the pull request until that exact local tip is already published to
the same-named GitHub branch. Cantrip never silently pushes, changes branches,
or substitutes the Primary worktree.

The form supports a base branch, title, Markdown body, draft state, labels,
reviewers, and linked issue numbers. Linked issues are appended to the body as
GitHub closing references. Pull request creation happens first; labels and
reviewers are best-effort enrichment. If either enrichment fails, Cantrip
returns the created pull request and a warning instead of encouraging a retry
that could create a duplicate.

Manual QA:

1. Publish a local feature branch, select its owning worktree, and create both
   ready and draft pull requests targeting `main`.
2. Add Markdown, labels, reviewers, and duplicate linked issue numbers. Confirm
   labels/reviewers are deduplicated and each `Closes #N` line appears once.
3. Advance the local branch without pushing and confirm creation is rejected
   with an exact local-versus-GitHub tip mismatch.
4. Make label or reviewer assignment fail after creation and confirm the
   hosted pull request is returned with a warning rather than retried.
5. Disconnect the selected worker and confirm creation fails without falling
   back to another worktree or moving credentials through the app/server.

### Pull request review surface

Click a pull request row to open its worktree-scoped review dialog. Overview
shows draft/open/merged state, head and base, mergeability, aggregate changes,
requested reviewers, review decisions, and the bounded general conversation.
Commits and changed files are capped at 100 entries, reviews at 100, and checks
plus commit statuses at 200; the UI identifies an incomplete result and links
to GitHub rather than silently presenting it as complete. Changed-file patches
use Cantrip's shared side-by-side diff viewer. Binary, unavailable, and absent
GitHub patches intentionally render as having no textual line changes.

The Checks view combines GitHub check runs and legacy commit statuses for the
exact PR head. It displays running/conclusion state, a bounded summary, and the
hosted details link, which provides logs for failed checks without transporting
unbounded log output through Cantrip. All reads route app → server → the
selected worktree's worker, where GitHub CLI authentication remains.

Manual QA:

1. Open a clean, conflicted, draft, and merged pull request; confirm head/base,
   mergeability, review state, requested reviewers, and aggregate stats match
   GitHub.
2. Inspect normal, renamed, deleted, binary, and large changed files and verify
   patches use the shared diff viewer with intentional unavailable/truncated
   states.
3. Open a PR with more than 100 commits or files and confirm the bounded notice
   appears without freezing the app.
4. Inspect successful, failed, cancelled, and running checks plus a legacy
   commit status. Follow the hosted link for a failed check's full log.
5. Disconnect the selected worktree's worker and confirm the dialog reports it
   offline instead of reading through another worker.

### Conversations and reviews

The PR overview supports general comments, approvals with an optional note,
and change requests with a required explanation. Inline review comments start
by selecting an old or new line number in the shared Files diff; GitHub
validates that the path, side, line, and exact PR-head commit still belong to
the current diff. Existing inline comments are grouped into threads and can be
replied to from Cantrip. GitHub's REST review-comments API does not expose a
thread's resolved flag, so Cantrip keeps that state explicitly unknown rather
than making an unreliable claim.

Every review mutation is validated by the shared protocol, serialized by the
server for the project, executed with the selected worktree and worker-owned
GitHub CLI identity, and followed by a complete authoritative PR refresh. The
app updates only from that worker response and also refreshes the PR list's
comment counts.

Manual QA:

1. Add a general Markdown comment and verify the new conversation entry and PR
   list count appear only after GitHub accepts it.
2. Approve with and without a note, then request changes with an explanation;
   verify an empty change request is rejected before reaching the worker.
3. Select an added, deleted, and context line in Files, submit comments on the
   correct right/left side, and confirm each appears in its GitHub thread.
4. Reply to an existing inline thread and confirm the authoritative refresh
   preserves comment order and review state.
5. Change the PR head after opening its diff and confirm GitHub rejects a stale
   inline target rather than commenting on a different revision.
6. Disconnect the selected worker during a submission and confirm the draft
   remains visible with an error and no fallback worker is used.

### Pull request lifecycle and merge

Open PRs can be closed, closed unmerged PRs can be reopened, and drafts can be
marked ready for review. An open ready PR can be merged with GitHub's merge,
squash, or rebase method, including optional commit title and message where
GitHub supports them. Cantrip does not bypass branch protection: GitHub remains
authoritative for required checks, reviews, allowed merge methods, and other
repository rules.

Every lifecycle operation has a worker-authored preview bound to the PR number,
exact head/base commits, open/draft/merged state, mergeability, checks, review
decision, and requested action. Close and merge require typing the displayed
phrase. Apply re-fetches and recomputes the preview; any changed state rejects
the token. Merge also sends the reviewed head SHA to GitHub's merge endpoint,
closing the remaining race between validation and mutation. The app updates
only from the complete post-action PR response.

Manual QA:

1. Preview and close an open PR, type an incorrect phrase, then the exact
   `close #N` phrase; reopen it and verify the hosted state after each action.
2. Mark a draft ready and confirm GitHub notifies reviewers and the draft badge
   disappears only after the authoritative refresh.
3. Preview merge, squash, and rebase with optional commit title/message; verify
   the dialog names exact head/base SHAs, checks, reviews, and mergeability.
4. Advance the PR head after preview and confirm apply rejects the stale token;
   advance it between apply validation and merge and confirm GitHub's exact SHA
   guard rejects the mutation.
5. Try blocked mergeability, pending/failed checks, requested changes, and a
   repository that disallows one merge method. Confirm warnings are precise
   and GitHub protection is never bypassed.
6. Disconnect the selected worker and confirm preview/apply fail without using
   another worktree or exposing GitHub credentials.

### Pull request worktrees

Checkout in the PR inspector fetches GitHub's exact `refs/pull/N/head` through
the matching repository remote and creates a new Cantrip-managed worktree and
local `cantrip/pr/...` branch at that immutable commit. The selected worktree
is used only as the explicit worker/repository context: its branch, index, and
files are never switched or modified. Repeating checkout for the same PR head
reuses the already cataloged worktree, while a newer PR head receives a new
SHA-qualified branch so existing review work remains recoverable.

Manual QA:

1. Open a PR from the Primary worktree, click Checkout, and confirm Cantrip
   selects a new user-managed worktree while Primary remains on its branch.
2. Repeat checkout for the same head and confirm the existing worktree is
   selected instead of creating a duplicate.
3. Push another commit to the PR and checkout again; confirm a new worktree is
   created at the new exact SHA and the previous checkout remains unchanged.
4. Test a PR from a fork, a closed PR, and a private repository authenticated
   through the worker's GitHub CLI.
5. Remove or rename the matching GitHub remote and confirm checkout explains
   the missing remote without switching the selected worktree.
6. Disconnect the selected worker and confirm no fallback worker is used and
   no partial server worktree record is created.

## File history, blame, and revision comparison

The History tab's File inspector accepts a safe repository-relative path and
starting revision. History follows renames through Git and loads at most 100
commits per request. Blame resolves the requested revision first, requests at
most 201 lines at a time, groups adjacent lines with the same commit, and lets
the user jump directly to the shared commit inspector. The Compare view reuses
the existing bounded revision-diff transport and shared patch viewer for any
two commit-ish inputs without switching the worktree.

Manual QA:

1. Inspect a file that was renamed several times and confirm older commits
   continue loading in order through the rename boundary.
2. Load blame for a file longer than 500 lines, paginate, and confirm line
   numbers, author metadata, and commit jumps remain correct at page edges.
3. Compare the file between branches, tags, and commit hashes in both
   directions; verify additions/deletions reverse and the selected worktree
   remains unchanged.
4. Test deleted, binary, empty, root-commit, and pre-rename paths and confirm
   unavailable textual patches are intentional rather than fabricated.
5. Try an escaping path, invalid revision, unborn repository, and offline
   worker; confirm validation/error states are bounded and explicit.

### Repository commit search

The Search inspector combines literal message text, author name/email, an
abbreviated or full commit hash, inclusive date bounds, a repository-relative
path, and either one local/remote branch or one tag. The worker verifies exact
branch/tag/hash scopes before invoking Git, limits every response to 100
commits, and continues through cursor pagination. Results retain graph refs and
open in the shared commit inspector; no search changes refs or checkout state.

Manual QA:

1. Combine message, author, date, and path filters and confirm only commits
   satisfying every supplied filter appear.
2. Search a local branch, `remote/name` branch, and annotated tag, then enter
   an invalid or missing ref and verify the worker reports it explicitly.
3. Search by abbreviated and full hashes and confirm ambiguous prefixes fail
   rather than selecting an arbitrary commit.
4. Load more than 100 matching commits and verify ordering and pagination have
   no duplicate or skipped rows.
5. Search an offline selected worktree and confirm Cantrip does not fall back
   to another checkout or worker.

## Recovery tools

The History tab's Recovery inspector pages through reference movements with a
plain-language explanation of checkout, commit, reset, merge, pull, and rebase
events. A separate lost-commit view asks the selected worker to find commits
that are unreachable even when reflogs are ignored. A selected revision can be
preserved on a new recovery branch, used to restore an existing unowned branch,
or used for a soft, mixed, or hard reset of the explicit worktree.

Every action has a worker-authored preview bound to the current HEAD, target,
branch state, index, and working tree. The preview shows commits and files that
would lose reachability, requires an exact generated confirmation, and is
recomputed immediately before apply. Branches checked out by any worktree are
never moved indirectly. Destructive branch restoration and reset create a
permanent `refs/cantrip/recovery/...` checkpoint before changing the ref.

Manual QA:

1. Create commits, switch branches, reset, merge, and rebase; confirm Recovery
   explains each resulting movement and paginates without duplicate rows.
2. Delete an unmerged branch and confirm its commit appears under Lost commits;
   preserve it with a new recovery branch before repository maintenance.
3. Preview soft, mixed, and hard resets with staged, unstaged, and untracked
   files. Confirm the warning and file/commit summary match Git's exact scope.
4. Change HEAD or a file after preview and confirm apply rejects the stale token.
5. Restore an unowned branch, then try a branch checked out by this or another
   worktree and confirm the worker blocks it with a precise explanation.
6. Apply a destructive action and verify its recovery ref points to the exact
   previous revision and remains usable after reconnecting the app.

### Durable bisect

Choose **Bisect** in the History tab's Operations panel and identify one known
good revision plus one known bad revision. Cantrip verifies that good is an
ancestor of bad, bounds the searchable range, and previews the candidate
commits before changing HEAD. Starting creates a recovery checkpoint and lets
Git select the next candidate in the explicitly selected worktree.

Classify each candidate with **Good**, **Bad**, or **Skip**. The server persists
the operation, current candidate, remaining range, and Git output after every
step, so reconnecting the app, server, or worker resumes the same bisect rather
than starting over. When Git identifies the first bad commit, its output stays
visible until **Reset bisect** restores the original branch and HEAD. Abort also
restores the original checkout while recording the operation as aborted.

Bisect is serialized with every other Git mutation and requires a clean
worktree. Its controls never fall back to another checkout or worker, and a
second managed operation cannot begin while the bisect is active.

Manual QA:

1. Create a linear history with a known regression, preview a known-good and
   known-bad pair, then classify candidates until Git identifies the first bad
   commit.
2. Reload the app and restart the worker between classifications. Confirm the
   same candidate, range, output, and controls return from the durable record.
3. Skip a candidate and confirm Git selects another candidate without losing
   the operation. Reset after the result and verify the original branch and
   HEAD are restored.
4. Abort midway and confirm the original checkout is restored and the aborted
   record remains inspectable.
5. Try unrelated or reversed good/bad revisions, a dirty worktree, a second
   managed operation, and an offline worker; confirm each fails without
   mutating or falling back to another worktree.

## Submodule management

Open **Repository → Submodules** from a History tab to inspect the submodules
configured by the selected worktree. Each row identifies its path, redacted
URL, configured branch, recorded commit, checked-out commit, nested status, and
whether the checkout is uninitialized, changed, conflicted, missing, or dirty.
Inventory is bounded and nested modules are discovered recursively once their
parent checkout is initialized.

Cantrip can initialize modules at the commits recorded by the superproject,
update one or all modules to those recorded commits, deliberately follow each
module's configured remote branch, synchronize changed URLs, and deinitialize
one checkout. Every mutation receives a worker-authored preview token bound to
the selected worktree, `.gitmodules` inventory, Git links, and local module
state. Remote updates warn that they may differ from the recorded Git link.
Deinitialization is destructive and refuses local submodule changes unless the
review explicitly uses force.

Manual QA:

1. Open a repository with initialized and uninitialized modules. Confirm paths,
   URLs, branches, expected/current commits, and status match Git.
2. Initialize one module and all modules recursively, then reload and confirm
   nested modules appear without changing another worktree.
3. Advance a module remote, compare recorded update with remote update, and
   verify the changed-commit state is explicit.
4. Change `.gitmodules`, synchronize URLs, and confirm credentials are redacted
   before the inventory reaches the app.
5. Modify a submodule checkout and confirm ordinary deinitialize is refused.
   Force it only after the destructive warning, then reinitialize it.
6. Change module state after preview and verify apply rejects the stale token.
   Disconnect the assigned worker and confirm no action falls back elsewhere.

## Git LFS

Open **Repository → LFS** to inspect Git LFS on the selected worktree's worker.
The surface reports whether `git-lfs` is installed, its version, tracked
patterns and their attribute files, reachable pointer files, materialized and
missing objects, working-tree pointer status, and cached lock ownership.
Inventories are bounded; missing tooling and unavailable lock remotes remain
explicit states instead of hiding the rest of the repository.

Cantrip can install repository-local hooks, track and untrack patterns, fetch
required or all reachable objects, pull and materialize objects, prune unused
local objects with remote verification, refresh locks, and lock or unlock a
path. Network work stays on the assigned worker. Every action has an exact
preview token bound to LFS inventory plus worktree state; changes after preview
require another review. Untracking, pruning, and force-unlocking are marked
destructive, with force unlock warning that another user's lock may be removed.

Manual QA:

1. Open repositories with no `git-lfs`, with LFS installed but unused, and with
   tracked files. Confirm each availability and empty state is intentional.
2. Track a new pattern, stage a matching file, and verify the pattern source,
   pointer OID, object size, materialization, and working-tree status.
3. Remove a local object and confirm it appears missing; fetch and pull it and
   verify the object and checkout become available again.
4. Refresh locks against a supporting remote, lock and unlock your path, then
   inspect a lock owned by another user and confirm force unlock is explicit.
5. Prune with remote verification and confirm the destructive preview explains
   that old local objects may require another download.
6. Change `.gitattributes`, an LFS pointer, or lock state after preview and
   confirm apply rejects it. Disconnect the worker or LFS remote and confirm
   the UI degrades without moving credentials or falling back to another lane.

## Commit and tag signatures

Commit inspectors and annotated-tag details show the signature format, signer,
key or fingerprint, and Git's bounded verification output. GPG, SSH, and X.509
signatures are identified separately. A cryptographically invalid signature is
not conflated with an otherwise-valid signature that the worker cannot verify:
the UI calls out a missing public key, missing SSH allowed-signers
configuration, missing verification tooling, or another Git verification
error.

Verification always runs on the worker that owns the selected checkout. Its
GPG keyring, SSH allowed-signers file, and verification programs never move to
the server or app. Unsigned commits and lightweight tags remain an intentional
state, while older Git versions that cannot grade a present signature surface
it as unverifiable instead of silently calling it unsigned.

Manual QA:

1. Inspect GPG- and SSH-signed commits and annotated tags. Confirm the format,
   signer, fingerprint, and valid state match command-line Git on the worker.
2. Remove the verification public key and confirm Cantrip reports a missing
   key without claiming the signature is invalid.
3. For SSH signing, unset `gpg.ssh.allowedSignersFile` and confirm the missing
   configuration is explained. Restore it and verify the same object again.
4. Stop or hide the configured verification executable and confirm missing
   tooling is distinct from a bad signature.
5. Inspect an unsigned commit, lightweight tag, expired/revoked key, and
   deliberately corrupted signature. Confirm every state remains distinct.
6. Disconnect the assigned worker and confirm signature inspection does not
   fall back to another worker or expose worker-local trust configuration.

## Agent-assisted working changes

The Working Changes panel offers optional **Summarize** and **Draft message**
actions. The assigned worker collects a bounded staged/unstaged status and
patch snapshot, then runs the account's default model in a read-only,
network-disabled generation turn. Repository content is treated as untrusted
evidence rather than instructions.

Every result opens in an editable review dialog. Summaries can be copied.
Commit-message drafts enter the ordinary commit-message field only after
**Use reviewed draft**; they never stage files, create a commit, push, or
publish by themselves. The normal Git controls remain available when no model
is configured or the worker's Codex runtime is unavailable.

Manual QA:

1. Create staged and unstaged changes, generate a summary, and confirm both
   scopes are described without changing status or HEAD.
2. Generate a commit-message draft, edit it in the review dialog, and use it.
   Confirm the edited text enters the commit field but no commit occurs.
3. Cancel and regenerate drafts. Confirm each remains preview-only and shows
   the selected model route's provider and model.
4. Remove the default model, disconnect the assigned worker, and exhaust one
   provider route. Confirm clear errors and normal manual Git controls remain
   usable; configured fallback routes are attempted in priority order.
5. Put instruction-like text in a changed file and confirm the model treats it
   as repository evidence rather than an instruction to mutate or publish.

## Evolution checklist

- [x] Commit inspector and reusable revision-diff transport
- [x] Arbitrary revision comparison
- [x] Hunk and selected-line staging
- [x] Stash/shelf management
- [x] Complete branch management
- [x] Remotes, tags, and GitHub releases
- [x] Commit and history actions
- [x] Resumable merge and rebase operations
- [x] Conflict resolution
- [x] Advanced history rewriting
- [x] Full GitHub pull-request workflow
- [x] File history, blame, and repository search
- [x] Recovery tools and bisect
- [x] Repository-system support
- [ ] Agent-assisted Git workflows

Each checklist item is delivered through its own isolated worktree and pull
request based on the latest merged `origin/main`.
