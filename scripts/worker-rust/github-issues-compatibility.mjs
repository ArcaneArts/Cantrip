// Actual worker handler versus native GH operations on an owned gh executable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { workerCommandSchema } from "../../packages/protocol/dist/index.js";
import {
  GithubClient,
  githubListSearchQuery,
} from "../../cantrip_worker/src/github.ts";
import { handleGithubCommand } from "../../cantrip_worker/src/commands/github.ts";
import {
  githubIssuesFixture,
  issueFixture,
  commentFixture,
  graphqlIssueFixture,
  graphqlPullFixture,
  searchFixture,
} from "./github-issues-fixture.mjs";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-github-issues-"));
const bin = path.join(root, "bin"),
  directory = path.join(root, "worker 😀");
const fixture = await githubIssuesFixture(root, bin);
const original = { ...process.env },
  binary = path.resolve(values.binary);
process.env.PATH = bin;
process.env.GH_TOKEN = process.env.GITHUB_TOKEN = "";
const child = spawn(binary, [], {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdout.setEncoding("utf8");
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const commands = new Set();
let sequence = 0,
  comparisons = 0,
  searchQueries = 0;
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned GitHub fixture response timed out")),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function native(input) {
  child.stdin.write(
    JSON.stringify({ ...input, directory, requestId: ++sequence }) + "\n",
  );
  const line = await bounded(lines.next());
  assert.equal(line.done, false);
  const { id, result } = JSON.parse(line.value);
  assert.equal(id, sequence);
  const { code, ...value } = result;
  return value;
}
async function query(type, arguments_ = {}, ok = true, heldRead = null) {
  const command = workerCommandSchema.parse({
    type,
    repository: "ArcaneArts/Cantrip",
    ...arguments_,
  });
  await fixture.calls();
  if (heldRead) await fixture.hold(heldRead);
  let expected;
  const github = new GithubClient(directory),
    pending = [],
    api = github.api.bind(github);
  // Observe the real Source promises so a rejected Promise.all cannot leave
  // its sibling gh child running into the next fixture response configuration.
  github.api = (...args) => {
    const result = api(...args);
    pending.push(result);
    return result;
  };
  try {
    expected = {
      ok: true,
      value: await bounded(handleGithubCommand(command, { github })),
    };
  } catch (error) {
    expected = { ok: false, error: error.message };
  }
  if (heldRead) await fixture.release(heldRead);
  await Promise.allSettled(pending);
  const expectedCalls = await fixture.calls();
  if (heldRead) await fixture.hold(heldRead);
  let actual;
  try {
    actual = await native({ op: "github", command });
  } finally {
    if (heldRead) await fixture.unhold(heldRead);
  }
  assert.deepEqual(await native({ op: "github-drain" }), {
    ok: true,
    value: null,
  });
  assert.deepEqual(actual, expected, `${type} #${comparisons}`);
  assert.deepEqual(
    await fixture.calls(),
    expectedCalls,
    "exact subprocess args: " + type,
  );
  if (ok !== null) assert.equal(actual.ok, ok, JSON.stringify(actual));
  comparisons++;
  commands.add(type);
  return { result: actual.value, calls: expectedCalls };
}
async function search(
  kind,
  filters = {},
  { repository = "ArcaneArts/Cantrip", ok = true } = {},
) {
  const input = {
    op: "github-search",
    repository,
    kind,
    state: "open",
    filters,
    now: Date.parse("2026-11-17T12:00:00Z"),
  };
  let expected;
  try {
    expected = {
      ok: true,
      value: githubListSearchQuery(
        repository,
        kind,
        input.state,
        filters,
        new Date(input.now),
      ),
    };
  } catch (error) {
    expected = { ok: false, error: error.message };
  }
  assert.deepEqual(await native(input), expected, JSON.stringify(input));
  assert.equal(expected.ok, ok);
  searchQueries++;
}
try {
  await query("github.issues.list", { state: "open" });
  await query("github.pull-requests.list", {
    state: "closed",
    cursor: "opaque /+=😀",
    filters: {
      search: 'escaped "value" \\ path\ud800',
      labels: ["feature", ' label "two" '],
      author: "@me",
      assignee: "maintainer",
      milestone: "Native worker",
      view: "review-requested",
      draft: false,
      reviewDecision: "changes-requested",
      checksState: "failure",
    },
  });
  const detail = await query("github.issue.get", { number: 42 });
  assert.equal(detail.result.body, issueFixture.body);
  assert.equal(detail.result.comments[0].id, "99");
  const created = await query("github.issue.create", {
    request: { title: "  New issue 😀  " },
  });
  assert.equal(created.result.comments.length, 0);
  assert.deepEqual(created.calls, [
    [
      "api",
      "repos/ArcaneArts/Cantrip/issues",
      "--method",
      "POST",
      "-f",
      "title=New issue 😀",
      "-f",
      "body=",
    ],
  ]);
  await query("github.issue.create", {
    request: { title: "Unicode title\ud800", body: "New body\ud800\n😀" },
  });
  await query(
    "github.issue.create",
    { request: { title: "Nul", body: "bad\0body" } },
    false,
  );
  for (const body of [
    "a".repeat(140) + "\0",
    "a".repeat(80) + "\nsecond\0",
    "a" + "😀".repeat(70) + "\0",
    "a".repeat(10001) + "'\"\0",
  ]) {
    await query(
      "github.issue.create",
      { request: { title: "Bounded invalid argument", body } },
      false,
    );
  }
  await query(
    "github.issue.create",
    { request: { title: "Owned large argv", body: "x".repeat(512 * 1024) } },
    null,
  );
  await query("github.issue.comment", {
    number: 42,
    body: "  New comment 😀  ",
  });
  const close = await query("github.issue.close", {
    number: 42,
    comment: "  Closing 😀  ",
  });
  assert.equal(close.calls.length, 4);
  const noComment = await query("github.issue.close", {
    number: 42,
    comment: null,
  });
  assert.equal(noComment.calls.length, 3);
  await fixture.response("commentIssue", "", {
    raw: true,
    status: 9,
    stderr: "owned comment failure\n",
  });
  const failedComment = await query(
    "github.issue.close",
    { number: 42, comment: "must stop here" },
    false,
  );
  assert.equal(
    failedComment.calls.length,
    1,
    "failed comment must prevent close and follow-up reads",
  );
  await fixture.response("commentIssue", commentFixture);
  await fixture.response("closeIssue", "", {
    raw: true,
    status: 10,
    stderr: "owned close failure\n",
  });
  const failedClose = await query(
    "github.issue.close",
    { number: 42, comment: null },
    false,
  );
  assert.equal(
    failedClose.calls.length,
    1,
    "failed close must prevent follow-up reads",
  );
  await fixture.response("closeIssue", issueFixture);
  await fixture.response("comments", "", {
    raw: true,
    status: 11,
    stderr: "owned read failure\n",
  });
  await query("github.issue.get", { number: 42 }, false);
  await fixture.response("comments", [
    [{ ...commentFixture, id: null, user: null, body: 17 }],
    [{ ...commentFixture, id: "second", body: "\ud800\u2028tail" }],
  ]);
  await fixture.response("issue", {
    ...issueFixture,
    number: "42",
    comments: "2",
    user: null,
    labels: [null, "skip", {}, { name: "ok", color: "aAbB00" }],
    assignees: [null, {}, { login: "assigned" }],
    milestone: 4,
    body: null,
  });
  await query("github.issue.get", { number: 42 });
  await fixture.response("issue", null);
  await query("github.issue.get", { number: 42 }, false);
  await fixture.response("issue", {
    ...issueFixture,
    title: "",
    comments: -1,
    html_url: "invalid",
    updated_at: "today",
  });
  await query("github.issue.get", { number: 42 }, false);
  await fixture.response("issue", issueFixture);
  for (const comments of [null, {}, [null]]) {
    await fixture.response("comments", comments);
    await query("github.issue.get", { number: 42 }, false);
  }
  await fixture.response("issue", "", {
    raw: true,
    status: 12,
    stderr: "owned slow issue failure\n",
  });
  await fixture.response("comments", "", {
    raw: true,
    status: 13,
    stderr: "owned first comments failure\n",
  });
  await query("github.issue.get", { number: 42 }, false, "issue");
  await fixture.response("issue", issueFixture);
  await fixture.response("comments", [[commentFixture]]);
  // Filtering scans preserve opaque cursor progression and reduce each request
  // by the number of matches already collected, without advertising a total.
  await fixture.response(
    "search",
    searchFixture([{ ...graphqlPullFixture, mergeable: "CONFLICTING" }], {
      total: 30,
      cursor: "fixture-page-1",
      next: true,
    }),
  );
  await fixture.response(
    "search1",
    searchFixture([graphqlPullFixture], {
      total: 30,
      cursor: "fixture-page-2",
      next: true,
    }),
  );
  await fixture.response(
    "search2",
    searchFixture([{ ...graphqlPullFixture, number: 44 }], { total: 30 }),
  );
  const scanned = await query("github.pull-requests.list", {
    state: "open",
    limit: 2,
    filters: { mergeability: "mergeable" },
  });
  assert.equal(scanned.calls.length, 3);
  assert.equal(scanned.result.total, null);
  assert.deepEqual(
    scanned.result.pullRequests.map((value) => value.number),
    [43, 44],
  );
  assert.ok(
    scanned.calls.some(
      (args) =>
        args.includes("first=1") && args.includes("after=fixture-page-2"),
    ),
  );
  for (let index = 0; index < 10; index++)
    await fixture.response(
      index ? "search" + index : "search",
      searchFixture([{ ...graphqlPullFixture, mergeable: "CONFLICTING" }], {
        cursor: "fixture-page-" + (index + 1),
        next: true,
      }),
    );
  const bounded = await query("github.pull-requests.list", {
    state: "open",
    limit: 2,
    filters: { mergeability: "mergeable" },
  });
  assert.equal(bounded.calls.length, 10);
  assert.equal(bounded.result.nextCursor, "fixture-page-10");
  assert.equal(bounded.result.pullRequests.length, 0);
  await fixture.response(
    "search",
    searchFixture([
      {
        ...graphqlPullFixture,
        mergeable: "UNKNOWN",
        reviewDecision: "FUTURE",
        commits: {
          nodes: [{ commit: { statusCheckRollup: { state: "UNRECOGNIZED" } } }],
        },
      },
    ]),
  );
  await query("github.pull-requests.list", {
    state: "open",
    filters: { mergeability: "unknown" },
  });
  for (const state of [
    "SUCCESS",
    "ERROR",
    "FAILURE",
    "EXPECTED",
    "PENDING",
    null,
  ]) {
    await fixture.response(
      "search",
      searchFixture([
        {
          ...graphqlPullFixture,
          commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] },
        },
      ]),
    );
    await query("github.pull-requests.list", { state: "open" });
  }
  await fixture.response(
    "search",
    searchFixture(
      [
        {
          ...graphqlIssueFixture,
          number: "42",
          author: null,
          comments: {},
          labels: { nodes: [] },
          assignees: { nodes: [null, {}, { login: "ok" }] },
          milestone: null,
          closedAt: "2026-11-17T00:00:00Z",
          state: "CLOSED",
        },
        { __typename: "Other" },
      ],
      { total: "7" },
    ),
  );
  await query("github.issues.list", { state: "closed" });
  for (const total of ["not-a-count", null, 0]) {
    await fixture.response("search", searchFixture([], { total }));
    await query("github.issues.list", { state: "open" });
  }
  for (const value of [
    null,
    {},
    { data: { search: { nodes: [], pageInfo: null } } },
    searchFixture([], { cursor: null, next: true }),
    searchFixture([null]),
    searchFixture([{ ...graphqlIssueFixture, labels: { nodes: [null] } }]),
    searchFixture([{ ...graphqlIssueFixture, title: "", number: -1 }]),
  ]) {
    await fixture.response("search", value);
    await query("github.issues.list", { state: "open" }, false);
  }
  await fixture.response("search", "not JSON", { raw: true });
  await query("github.issues.list", { state: "open" }, false);
  for (const view of ["all", "assigned-to-me", "recently-updated"])
    await search("issue", { view });
  await search("pull-request", {
    view: "review-requested",
    draft: true,
    reviewDecision: "review-required",
    checksState: "pending",
    search: 'quote "slash\\\ud800',
    labels: ['label "one"'],
    author: "@me",
    assignee: "reviewer",
    milestone: " milestone ",
  });
  for (const filters of [
    { view: "review-requested" },
    { draft: false },
    { reviewDecision: "none" },
    { mergeability: "unknown" },
    { checksState: "failure" },
  ])
    await search("issue", filters, { ok: false });
  await search("issue", {}, { repository: "owner/../escape", ok: false });
  await search("issue", {}, { repository: "./repo", ok: false });
  console.log(
    JSON.stringify({
      suite: "native-github-issues-compatibility",
      comparisons,
      searchQueries,
      commands: [...commands],
      exactGhArguments: true,
      boundedMergeabilityScan: true,
      mutationFailureStopsFollowup: true,
      failedReadRepliesWithSiblingHeld: true,
      nodeAbsentFromNativePath: true,
    }),
  );
} finally {
  child.stdin.end();
  assert.equal(await completion, 0);
  for (const key of Object.keys(process.env))
    if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  await rm(root, { recursive: true, force: true });
}
