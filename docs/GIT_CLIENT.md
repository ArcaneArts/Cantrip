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

## Evolution checklist

- [x] Commit inspector and reusable revision-diff transport
- [x] Arbitrary revision comparison
- [x] Hunk and selected-line staging
- [ ] Stash/shelf management
- [ ] Complete branch management
- [ ] Remotes, tags, and GitHub releases
- [ ] Commit and history actions
- [ ] Resumable merge and rebase operations
- [ ] Conflict resolution
- [ ] Advanced history rewriting
- [ ] Full GitHub pull-request workflow
- [ ] File history, blame, and repository search
- [ ] Recovery tools and bisect
- [ ] Repository-system support
- [ ] Agent-assisted Git workflows

Each checklist item is delivered through its own isolated worktree and pull
request based on the latest merged `origin/main`.
