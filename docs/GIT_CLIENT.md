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

## Evolution checklist

- [x] Commit inspector and reusable revision-diff transport
- [ ] Arbitrary revision comparison
- [ ] Hunk and selected-line staging
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
