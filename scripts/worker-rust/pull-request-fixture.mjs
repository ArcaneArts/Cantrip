// Native, network-free gh boundary for PR inspection. No GitHub account used.
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { githubCatalogFixture } from "./github-catalog-fixture.mjs";
import { issueFixture, commentFixture } from "./github-issues-fixture.mjs";
export const pullFixture = {
  ...issueFixture,
  number: 43,
  title: "Private pull request 😀",
  body: "Private PR body\ud800",
  html_url: "https://github.com/ArcaneArts/Cantrip/pull/43",
  node_id: "PR_owned",
  head: { ref: "feature", sha: "a".repeat(40) },
  base: { ref: "main", sha: "b".repeat(40) },
  draft: false,
  merged: false,
  merged_at: null,
  mergeable: true,
  mergeable_state: "clean",
  additions: 5,
  deletions: 2,
  changed_files: 1,
  commits: 1,
  requested_reviewers: [{ login: "reviewer" }, { login: "reviewer" }],
};
export const fileFixture = {
  sha: "c".repeat(40),
  filename: "src/file.rs",
  status: "modified",
  additions: 5,
  deletions: 2,
  changes: 7,
  blob_url: "https://github.com/ArcaneArts/Cantrip/blob/main/src/file.rs",
  raw_url: "https://example.invalid/raw/file.rs",
  patch: "@@ -1 +1 @@\n-old\n+new 😀\ud800",
};
export const commitFixture = {
  sha: "a".repeat(40),
  html_url: "https://github.com/ArcaneArts/Cantrip/commit/" + "a".repeat(40),
  commit: {
    message: "Owned commit 😀\n\nBody\ud800",
    author: { name: "Author", date: "2026-11-17T00:00:00Z" },
  },
  author: { login: "author" },
};
export const checkFixture = {
  id: 7,
  name: "Owned build",
  status: "completed",
  conclusion: "success",
  details_url: "https://github.com/ArcaneArts/Cantrip/actions/runs/7",
  started_at: "2026-11-17T00:00:00Z",
  completed_at: "2026-11-17T00:01:00Z",
  output: { title: "Build", summary: "Passed 😀", text: "Owned details\ud800" },
};
export const statusFixture = {
  id: 8,
  context: "Owned external check",
  state: "success",
  target_url: "https://example.invalid/status",
  description: "Passed",
  created_at: "2026-11-17T00:00:00Z",
  updated_at: "2026-11-17T00:01:00Z",
};
export const reviewFixture = {
  id: 11,
  user: { login: "reviewer" },
  state: "APPROVED",
  body: "Review\ud800",
  commit_id: "a".repeat(40),
  submitted_at: "2026-11-17T00:00:00Z",
  html_url: "https://github.com/ArcaneArts/Cantrip/pull/43#review-11",
};
export const reviewCommentFixture = {
  id: 101,
  pull_request_review_id: 11,
  user: { login: "reviewer" },
  body: "REST thread\ud800",
  html_url: "https://github.com/ArcaneArts/Cantrip/pull/43#discussion_r101",
  path: "src/file.rs",
  line: 5,
  side: "RIGHT",
  start_line: 4,
  start_side: "RIGHT",
  diff_hunk: "@@ -1 +1 @@",
  in_reply_to_id: null,
  created_at: "2026-11-17T00:00:00Z",
  updated_at: "2026-11-17T00:00:00Z",
};
export const contextCommentFixture = {
  databaseId: 101,
  author: { login: "reviewer" },
  body: "GraphQL thread\ud800",
  url: reviewCommentFixture.html_url,
  line: 0,
  startLine: 0,
  diffHunk: "@@ -1 +1 @@",
  createdAt: reviewCommentFixture.created_at,
  updatedAt: reviewCommentFixture.updated_at,
  pullRequestReview: { databaseId: 11, state: "PENDING" },
};
export const reviewContextFixture = {
  data: {
    viewer: { login: "reviewer" },
    repository: {
      pullRequest: {
        id: "PR_owned",
        isMergeQueueEnabled: true,
        autoMergeRequest: {
          enabledAt: "2026-11-17T00:00:00Z",
          mergeMethod: "SQUASH",
        },
        mergeQueueEntry: { id: "queue-owned", position: "2", state: "WAITING" },
        reviews: {
          nodes: [
            {
              id: "review-other",
              author: { login: "other" },
              state: "PENDING",
            },
            {
              id: "review-owned",
              author: { login: "reviewer" },
              state: "pending",
              comments: { totalCount: -2 },
            },
          ],
        },
        reviewThreads: {
          totalCount: 2,
          nodes: [
            {
              id: "thread-owned",
              path: "src/file.rs",
              line: 5,
              diffSide: "RIGHT",
              startLine: 4,
              startDiffSide: "RIGHT",
              isResolved: false,
              isOutdated: false,
              viewerCanResolve: true,
              viewerCanUnresolve: false,
              comments: { totalCount: 1, nodes: [contextCommentFixture] },
            },
            {
              id: "thread-empty",
              path: "empty.rs",
              comments: { totalCount: 1, nodes: [] },
            },
          ],
        },
      },
    },
  },
};
export const viewedFixture = {
  data: {
    repository: {
      pullRequest: {
        files: {
          nodes: [{ path: "src/file.rs", viewerViewedState: "VIEWED" }],
        },
      },
    },
  },
};
export async function pullRequestFixture(root, bin) {
  const fixture = await githubCatalogFixture(root, bin);
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    path.join(bin, "gh"),
    `#!/bin/sh
fixture=${quote(fixture.directory)}
printf '%s\\0' "$@" > "$fixture/calls/$$"
case "$1:$2" in
  api:graphql)
    operation=unknown
    for argument in "$@"; do
      case "$argument" in
        query=*CantripPullRequestReviewContext*) operation=context ;;
        query=*CantripPullRequestFileStates*) operation=viewed ;;
      esac
    done ;;
  api:repos/*/pulls/43) operation=pull ;;
  api:repos/*/pulls/43/files) operation=files ;;
  api:repos/*/pulls/43/commits) operation=commits ;;
  api:repos/*/pulls/43/reviews) operation=reviews ;;
  api:repos/*/pulls/43/comments) operation=reviewComments ;;
  api:repos/*/issues/43/comments) operation=conversation ;;
  api:repos/*/commits/*/check-runs) operation=checks ;;
  api:repos/*/commits/*/status) operation=statuses ;;
  *) printf 'Unexpected owned gh invocation' >&2; exit 91 ;;
esac
if test "$operation" = files && test -e "$fixture/viewed.hold"; then
  while ! test -e "$fixture/viewed.started"; do /bin/sleep 0.01; done
fi
if test -e "$fixture/$operation.hold"; then
  : > "$fixture/$operation.started"
  while ! test -e "$fixture/$operation.release"; do /bin/sleep 0.01; done
fi
/bin/cat "$fixture/$operation.stdout"
/bin/cat "$fixture/$operation.stderr" >&2
exit "$(/bin/cat "$fixture/$operation.status")"
`,
    { mode: 0o700 },
  );
  const defaults = {
    pull: pullFixture,
    files: [fileFixture],
    commits: [commitFixture],
    checks: { total_count: 1, check_runs: [checkFixture] },
    statuses: { statuses: [statusFixture] },
    reviews: [reviewFixture],
    reviewComments: [reviewCommentFixture],
    conversation: [
      {
        ...commentFixture,
        html_url:
          "https://github.com/ArcaneArts/Cantrip/pull/43#issuecomment-99",
      },
    ],
    context: reviewContextFixture,
    viewed: viewedFixture,
  };
  fixture.reset = async () => {
    for (const [name, value] of Object.entries(defaults))
      await fixture.response(name, value);
  };
  fixture.hold = async (operation) => {
    for (const suffix of ["release", "started"])
      await rm(path.join(fixture.directory, operation + "." + suffix), {
        force: true,
      });
    await writeFile(
      path.join(fixture.directory, operation + ".hold"),
      "owned hold",
    );
  };
  fixture.release = async (operation) =>
    writeFile(
      path.join(fixture.directory, operation + ".release"),
      "owned release",
    );
  fixture.unhold = async (operation) => {
    await fixture.release(operation);
    await rm(path.join(fixture.directory, operation + ".hold"), {
      force: true,
    });
  };
  await fixture.reset();
  return fixture;
}
