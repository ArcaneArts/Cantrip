// Native, owned gh boundary. These fixtures never contact GitHub or run jobs.
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { githubCatalogFixture } from "./github-catalog-fixture.mjs";
import {
  graphqlIssueFixture,
  graphqlPullFixture,
  searchFixture,
} from "./github-issues-fixture.mjs";
export const workflowFixture = {
  id: 9,
  name: "Owned workflow 😀",
  path: ".github/workflows/owned.yml",
  state: "active",
  html_url: "https://github.com/ArcaneArts/Cantrip/actions/workflows/9",
  badge_url: null,
};
export const runFixture = {
  id: 7,
  workflow_id: 9,
  name: "Owned run",
  display_title: "Private workflow run 😀",
  event: "pull_request",
  status: "completed",
  conclusion: "failure",
  head_branch: "feature",
  head_sha: "a".repeat(40),
  pull_requests: [{ number: 43 }],
  run_number: 12,
  run_attempt: 1,
  actor: { login: "author" },
  created_at: "2026-11-17T00:00:00Z",
  updated_at: "2026-11-17T00:01:00Z",
  html_url: "https://github.com/ArcaneArts/Cantrip/actions/runs/7",
};
export const jobFixture = {
  id: 17,
  name: "Owned job",
  status: "completed",
  conclusion: "failure",
  html_url: "https://github.com/ArcaneArts/Cantrip/actions/runs/7/jobs/17",
  started_at: runFixture.created_at,
  completed_at: runFixture.updated_at,
  runner_name: "Owned runner",
  runner_group_name: null,
  steps: [
    {
      number: 1,
      name: "Check 😀\ud800",
      status: "completed",
      conclusion: "failure",
      started_at: null,
      completed_at: null,
    },
  ],
};
export const runnerFixture = {
  id: 19,
  name: "Owned runner",
  os: "macOS",
  status: "online",
  busy: true,
  labels: [{ name: "self-hosted" }, { name: "ARM64" }],
};
export const artifactFixture = {
  id: 27,
  name: "owned-junit-report",
  size_in_bytes: 20,
  expired: false,
  created_at: runFixture.created_at,
  expires_at: "2026-12-17T00:00:00Z",
};
export const releaseFixture = {
  id: 37,
  tag_name: "v1.0",
  name: "Owned release 😀",
  body: "Private release body\ud800",
  html_url: "https://github.com/ArcaneArts/Cantrip/releases/tag/v1.0",
  author: { login: "author" },
  draft: true,
  prerelease: false,
  created_at: runFixture.created_at,
  published_at: null,
};
export const inboxPullFixture = {
  ...graphqlPullFixture,
  reviewRequests: { nodes: [{ requestedReviewer: { login: "fixture-user" } }] },
  assignees: { nodes: [{ login: "fixture-user" }] },
};
export const noticeFixture = {
  subject: {
    type: "PullRequest",
    url: "https://api.github.com/repos/ArcaneArts/Cantrip/pulls/43",
  },
  reason: "mention",
  unread: true,
};
export async function githubOperationsFixture(root, bin) {
  const fixture = await githubCatalogFixture(root, bin);
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    path.join(bin, "gh"),
    `#!/bin/sh
fixture=${quote(fixture.directory)}
printf '%s\\0' "$@" > "$fixture/calls/$$"
method=GET
previous=
for argument in "$@"; do
  if test "$previous" = --method; then method=$argument; fi
  previous=$argument
done
case "$1:$2:$method" in
  api:user:*) operation=auth ;;
  api:graphql:*)
    operation=unknown
    for argument in "$@"; do
      case "$argument" in
        query=*CantripInboxActivity*) operation=activity ;;
        query=*CantripInbox*) operation=inbox ;;
      esac
    done ;;
  api:repos/*/notifications:*) operation=notifications ;;
  api:repos/*/actions/workflows:GET) operation=workflows ;;
  api:repos/*/actions/runs:GET) operation=runs ;;
  api:repos/*/actions/runners:GET) operation=runners ;;
  api:repos/*/actions/runs/7:GET) operation=run ;;
  api:repos/*/actions/runs/7/jobs:GET) operation=jobs ;;
  api:repos/*/actions/runs/7/artifacts:GET) operation=artifacts ;;
  api:repos/*/actions/workflows/9/dispatches:POST) operation=dispatch ;;
  api:repos/*/actions/runs/7/cancel:POST) operation=cancel ;;
  api:repos/*/actions/runs/7/rerun:POST) operation=rerun ;;
  api:repos/*/actions/runs/7/rerun-failed-jobs:POST) operation=rerunFailed ;;
  api:repos/*/releases:GET) operation=releases ;;
  api:repos/*/releases/37:GET) operation=release ;;
  api:repos/*/releases:POST) operation=createRelease ;;
  run:view:*) operation=logs ;;
  *) printf 'Unexpected owned gh invocation' >&2; exit 91 ;;
esac
case "$operation" in dispatch|cancel|rerun|rerunFailed|createRelease) printf '%s\\n' "$operation" >> "$fixture/mutations" ;; esac
if test "$operation" = workflows && test -e "$fixture/runs.hold"; then
  while ! test -e "$fixture/runs.started"; do /bin/sleep 0.01; done
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
  fixture.reset = async () => {
    await writeFile(path.join(fixture.directory, "mutations"), "");
    for (const [name, value] of Object.entries({
      workflows: { total_count: 1, workflows: [workflowFixture] },
      runs: { total_count: 1, workflow_runs: [runFixture] },
      runners: { total_count: 1, runners: [runnerFixture] },
      run: runFixture,
      jobs: { total_count: 1, jobs: [jobFixture] },
      artifacts: { total_count: 1, artifacts: [artifactFixture] },
      releases: [releaseFixture],
      release: releaseFixture,
      createRelease: releaseFixture,
      notifications: [noticeFixture],
      inbox: searchFixture([inboxPullFixture, graphqlIssueFixture]),
      activity: { data: { repository: { item0: inboxPullFixture } } },
    }))
      await fixture.response(name, value);
    for (const op of ["dispatch", "cancel", "rerun", "rerunFailed"])
      await fixture.response(op, "Owned accepted without JSON", { raw: true });
    await fixture.response("auth", "fixture-user\n", { raw: true });
    await fixture.response(
      "logs",
      "\u001b[31mPrivate failed output 😀\ud800\u001b[0m\n",
      { raw: true },
    );
  };
  fixture.hold = async (op) => {
    for (const suffix of ["release", "started"])
      await rm(path.join(fixture.directory, op + "." + suffix), {
        force: true,
      });
    await writeFile(path.join(fixture.directory, op + ".hold"), "owned hold");
  };
  fixture.release = (op) =>
    writeFile(path.join(fixture.directory, op + ".release"), "owned release");
  fixture.unhold = async (op) => {
    await fixture.release(op);
    await rm(path.join(fixture.directory, op + ".hold"), { force: true });
  };
  fixture.mutations = async () =>
    (await readFile(path.join(fixture.directory, "mutations"), "utf8"))
      .split("\n")
      .filter(Boolean);
  await fixture.reset();
  return fixture;
}
