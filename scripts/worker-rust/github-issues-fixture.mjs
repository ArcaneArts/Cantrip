// Network-free gh REST/GraphQL boundary. No repository or account is mutated.
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { githubCatalogFixture } from "./github-catalog-fixture.mjs";
export const issueFixture = {
  number: 42,
  title: "Owned issue 😀",
  state: "open",
  html_url: "https://github.com/ArcaneArts/Cantrip/issues/42",
  user: { login: "author" },
  comments: 1,
  labels: [{ name: "feature", color: "22d3ee" }],
  assignees: [{ login: "maintainer" }],
  milestone: { title: "Native worker" },
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-17T00:00:00Z",
  closed_at: null,
  body: "Private issue body\ud800",
};
export const commentFixture = {
  id: 99,
  user: { login: "reviewer" },
  body: "An owned comment 😀",
  html_url: "https://github.com/ArcaneArts/Cantrip/issues/42#issuecomment-99",
  created_at: "2026-11-17T00:00:00Z",
  updated_at: "2026-11-17T00:00:00Z",
};
export const graphqlIssueFixture = {
  __typename: "Issue",
  number: 42,
  title: issueFixture.title,
  state: "OPEN",
  url: issueFixture.html_url,
  author: issueFixture.user,
  comments: { totalCount: 1 },
  labels: { nodes: issueFixture.labels },
  assignees: { nodes: issueFixture.assignees },
  milestone: issueFixture.milestone,
  createdAt: issueFixture.created_at,
  updatedAt: issueFixture.updated_at,
  closedAt: null,
};
export const graphqlPullFixture = {
  ...graphqlIssueFixture,
  __typename: "PullRequest",
  number: 43,
  url: "https://github.com/ArcaneArts/Cantrip/pull/43",
  body: "Private PR body\ud800",
  isDraft: false,
  merged: false,
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  headRefName: "feature",
  headRefOid: "a".repeat(40),
  baseRefName: "main",
  baseRefOid: "b".repeat(40),
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
};
export function searchFixture(
  nodes,
  { total = nodes.length, cursor = null, next = false } = {},
) {
  return {
    data: {
      search: {
        issueCount: total,
        nodes,
        pageInfo: { endCursor: cursor, hasNextPage: next },
      },
    },
  };
}
export async function githubIssuesFixture(root, bin) {
  const fixture = await githubCatalogFixture(root, bin);
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    path.join(bin, "gh"),
    `#!/bin/sh
fixture=${quote(fixture.directory)}
printf '%s\\0' "$@" > "$fixture/calls/$$"
case "$1:$2" in
  api:graphql)
    operation=search
    for argument in "$@"; do
      case "$argument" in
        after=fixture-page-[1-9]) operation=search\${argument##*-} ;;
      esac
    done ;;
  api:repos/ArcaneArts/Cantrip/issues|api:repos/arcanearts/cantrip/issues) operation=createIssue ;;
  api:repos/ArcaneArts/Cantrip/issues/42|api:repos/arcanearts/cantrip/issues/42)
    operation=issue
    if test "$4" = PATCH; then operation=closeIssue; fi ;;
  api:repos/ArcaneArts/Cantrip/issues/42/comments|api:repos/arcanearts/cantrip/issues/42/comments)
    operation=comments
    if test "$4" = POST; then operation=commentIssue; fi ;;
  *) printf 'Unexpected owned gh invocation' >&2; exit 91 ;;
esac
if test "$operation" = comments && test -e "$fixture/issue.hold"; then
  while ! test -e "$fixture/issue.started"; do /bin/sleep 0.01; done
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
  await fixture.response("issue", issueFixture);
  await fixture.response("comments", [[commentFixture]]);
  await fixture.response("createIssue", issueFixture);
  await fixture.response("commentIssue", commentFixture);
  await fixture.response("closeIssue", { ...issueFixture, state: "closed" });
  for (const name of [
    "search",
    ...Array.from({ length: 9 }, (_, index) => "search" + (index + 1)),
  ])
    await fixture.response(
      name,
      searchFixture([graphqlIssueFixture, graphqlPullFixture]),
    );
  fixture.hold = async (operation) => {
    await rm(path.join(fixture.directory, operation + ".release"), {
      force: true,
    });
    await rm(path.join(fixture.directory, operation + ".started"), {
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
  return fixture;
}
