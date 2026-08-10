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

## Evolution checklist

- [x] Commit inspector and reusable revision-diff transport
- [x] Arbitrary revision comparison
- [x] Hunk and selected-line staging
- [x] Stash/shelf management
- [x] Complete branch management
- [x] Remotes, tags, and GitHub releases
- [x] Commit and history actions
- [x] Resumable merge and rebase operations
- [ ] Conflict resolution
- [ ] Advanced history rewriting
- [ ] Full GitHub pull-request workflow
- [ ] File history, blame, and repository search
- [ ] Recovery tools and bisect
- [ ] Repository-system support
- [ ] Agent-assisted Git workflows

Each checklist item is delivered through its own isolated worktree and pull
request based on the latest merged `origin/main`.
