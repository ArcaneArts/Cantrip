// Actual Node/native PR commands over owned Git and gh process boundaries.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { workerCommandSchema } from "../../packages/protocol/dist/index.js";
import {
  GithubClient,
  parsePullRequestReviewContext,
  groupPullRequestReviewThreads,
} from "../../tests/reference-node-worker/src/github.ts";
import { handleGithubCommand } from "../../tests/reference-node-worker/src/commands/github.ts";
import {
  pullRequestFixture,
  pullFixture,
  fileFixture,
  commitFixture,
  checkFixture,
  statusFixture,
  reviewFixture,
  reviewCommentFixture,
  contextCommentFixture,
  reviewContextFixture,
  viewedFixture,
} from "./pull-request-fixture.mjs";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-pr-inspection-")),
);
const bin = path.join(root, "bin"),
  cwd = path.join(root, "checkout 😀 with spaces"),
  directory = path.join(root, "worker"),
  gitCalls = path.join(root, "git-calls");
const original = { ...process.env },
  binary = path.resolve(values.binary);
const git = execFileSync("/usr/bin/which", ["git"], {
  encoding: "utf8",
}).trim();
const fixture = await pullRequestFixture(root, bin);
await mkdir(gitCalls);
await mkdir(cwd);
for (const key of Object.keys(process.env))
  if (key.startsWith("GIT_")) delete process.env[key];
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
});
execFileSync(git, ["init", "--quiet", cwd], { cwd: root });
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
await writeFile(
  path.join(bin, "git"),
  `#!/bin/sh
printf '%s\\0' "$@" > ${quote(gitCalls)}/$$
exec ${quote(git)} "$@"
`,
  { mode: 0o700 },
);
process.env.PATH = bin;
const child = spawn(binary, [], {
  cwd: root,
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdout.setEncoding("utf8");
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let sequence = 0,
  comparisons = 0,
  reviewComparisons = 0;
const sections = new Set();
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned PR fixture response timed out")),
          30000,
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
async function readGitCalls() {
  const entries = await readdir(gitCalls);
  const result = await Promise.all(
    entries.map(async (name) => {
      const file = path.join(gitCalls, name);
      const args = (await readFile(file, "utf8")).split("\0").slice(0, -1);
      await rm(file);
      return args;
    }),
  );
  return result.sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}
async function query(
  section,
  { ok = true, override = {}, heldRead = null } = {},
) {
  const command = workerCommandSchema.parse({
    type: "github.pull-request.get",
    repository: "ArcaneArts/Cantrip",
    cwd,
    number: 43,
    ...(section ? { section } : {}),
    ...override,
  });
  await fixture.calls();
  await readGitCalls();
  if (heldRead) await fixture.hold(heldRead);
  const github = new GithubClient(directory),
    pending = [],
    api = github.api.bind(github);
  github.api = (...args) => {
    const result = api(...args);
    pending.push(result);
    return result;
  };
  let expected;
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
  const expectedCalls = await fixture.calls(),
    expectedGit = await readGitCalls();
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
  assert.deepEqual(actual, expected, `${command.section} #${comparisons}`);
  assert.deepEqual(
    await fixture.calls(),
    expectedCalls,
    "exact gh argv " + command.section,
  );
  assert.deepEqual(
    await readGitCalls(),
    expectedGit,
    "actual Git verification " + command.section,
  );
  assert.equal(actual.ok, ok, `${command.section} outcome`);
  comparisons++;
  sections.add(command.section);
  return { value: actual.value, calls: expectedCalls, gitCalls: expectedGit };
}
async function review(value, group = false) {
  let expected;
  try {
    expected = {
      ok: true,
      value: group
        ? groupPullRequestReviewThreads(value)
        : parsePullRequestReviewContext(value),
    };
  } catch (error) {
    expected = { ok: false, error: error.message };
  }
  const actual = await native(
    group
      ? { op: "github-review-group", comments: value }
      : { op: "github-review-context", value },
  );
  assert.deepEqual(actual, expected, `review helper #${reviewComparisons}`);
  reviewComparisons++;
  return actual;
}
try {
  const overview = await query("overview");
  assert.equal(
    overview.value.reviewThreads[0].comments[0].body,
    "GraphQL thread\ud800",
  );
  assert.equal(overview.value.pendingReview.commentCount, 0);
  assert.equal(overview.value.mergeQueueEntry.position, 2);
  assert.equal(overview.value.reviewDecision, "approved");
  assert.equal(overview.calls.length, 5);
  const files = await query("files");
  assert.equal(files.value.files[0].viewed, true);
  assert.equal(files.calls.length, 2);
  await query("commits");
  await query("checks");
  const all = await query();
  assert.equal(all.calls.length, 11);
  assert.equal(all.gitCalls.length, 4);
  assert.equal(all.value.checksState, "success");
  const empty = path.join(root, "not a checkout");
  await mkdir(empty);
  const noCheckout = await query("overview", {
    ok: false,
    override: { cwd: empty },
  });
  assert.equal(noCheckout.calls.length, 0);
  await fixture.response("files", [
    { ...fileFixture, patch: "x".repeat(999999) + "😀" },
  ]);
  const truncated = await query("files");
  assert.equal(truncated.value.files[0].patch.length, 1000000);
  assert.equal(truncated.value.files[0].patch.at(-1), "\ud83d");
  assert.equal(truncated.value.files[0].patchTruncated, true);
  await fixture.response("viewed", {
    data: {
      repository: {
        pullRequest: {
          files: {
            nodes: [
              { path: "src/file.rs", viewerViewedState: "VIEWED" },
              { path: "src/file.rs", viewerViewedState: "DISMISSED" },
            ],
          },
        },
      },
    },
  });
  await fixture.response("files", [fileFixture]);
  assert.equal((await query("files")).value.files[0].viewed, false);
  await fixture.response("viewed", {}, {});
  const unviewed = await query("files");
  assert.equal(unviewed.value.files[0].viewed, null);
  assert.equal(unviewed.value.warnings.length, 1);
  await fixture.response("files", "", {
    raw: true,
    status: 2,
    stderr: "owned files denied\n",
  });
  await fixture.response("viewed", viewedFixture);
  await query("files", { ok: false, heldRead: "viewed" });
  await fixture.reset();
  await fixture.response("context", "", {
    raw: true,
    status: 3,
    stderr: "owned GraphQL unavailable\n",
  });
  await fixture.response("reviewComments", [
    reviewCommentFixture,
    { ...reviewCommentFixture, id: 102, in_reply_to_id: 101, body: "reply" },
  ]);
  const fallback = await query("overview");
  assert.equal(fallback.value.reviewThreads[0].comments.length, 2);
  assert.equal(fallback.value.viewerLogin, null);
  assert.equal(fallback.value.reviewThreads[0].resolved, null);
  for (const operation of ["conversation", "reviews", "reviewComments"])
    await fixture.response(operation, "", {
      raw: true,
      status: 4,
      stderr: "owned unavailable\n",
    });
  const unavailable = await query("overview");
  assert.equal(unavailable.value.warnings.length, 4);
  assert.equal(unavailable.value.reviewDecision, "unknown");
  await fixture.reset();
  for (const operation of ["conversation", "reviews", "reviewComments"])
    await fixture.response(operation, null);
  assert.equal((await query("overview")).value.warnings.length, 0);
  await fixture.reset();
  await fixture.response("reviews", [
    reviewFixture,
    { ...reviewFixture, state: "DISMISSED" },
    { ...reviewFixture, user: { login: "other" }, state: "CHANGES_REQUESTED" },
  ]);
  assert.equal(
    (await query("overview")).value.reviewDecision,
    "changes-requested",
  );
  await fixture.response("reviews", [
    {
      ...reviewFixture,
      commit_id: "A".repeat(40),
      user: null,
      state: "unknown",
      body: 17,
    },
  ]);
  await query("overview");
  await fixture.response("reviews", [null]);
  await query("overview", { ok: false });
  await fixture.reset();
  await fixture.response(
    "files",
    Array.from({ length: 101 }, (_, index) => ({
      ...fileFixture,
      filename: "file-" + index,
    })),
  );
  const manyFiles = await query("files");
  assert.equal(manyFiles.value.files.length, 100);
  assert.equal(manyFiles.value.filesTruncated, true);
  await fixture.response(
    "commits",
    Array.from({ length: 100 }, () => commitFixture),
  );
  assert.equal((await query("commits")).value.commitsTruncated, true);
  for (const operation of ["files", "commits"]) {
    for (const data of [{}, [null]]) {
      await fixture.response(operation, data);
      await query(operation, { ok: false });
    }
  }
  await fixture.reset();
  await fixture.response("commits", [
    {
      ...commitFixture,
      commit: { message: null, author: { name: "", date: null } },
      author: null,
    },
  ]);
  await query("commits");
  await fixture.response("files", [
    {
      ...fileFixture,
      additions: "5",
      deletions: null,
      changes: "7",
      raw_url: "ftp://example.invalid/x",
      patch: null,
    },
  ]);
  await query("files");
  await fixture.reset();
  for (const [status, conclusion, expected] of [
    ["queued", null, "pending"],
    ["in_progress", "success", "pending"],
    ["completed", "action_required", "failure"],
    ["completed", "neutral", "neutral"],
    ["completed", "success", "success"],
  ]) {
    await fixture.response("checks", {
      total_count: 1,
      check_runs: [{ ...checkFixture, status, conclusion }],
    });
    await fixture.response("statuses", { statuses: [] });
    assert.equal((await query("checks")).value.checksState, expected);
  }
  await fixture.response("checks", {
    total_count: 2,
    check_runs: [checkFixture],
  });
  await fixture.response("statuses", {
    statuses: [
      {
        ...statusFixture,
        state: "pending",
        description: "x".repeat(99999) + "😀",
      },
    ],
  });
  const checkTruncated = await query("checks");
  assert.equal(checkTruncated.value.checksTruncated, true);
  assert.equal(checkTruncated.value.checks[1].id, "status-8");
  assert.equal(checkTruncated.value.checks[1].summary.at(-1), "\ud83d");
  await fixture.response("checks", "", {
    raw: true,
    status: 4,
    stderr: "owned checks unavailable\n",
  });
  await query("checks");
  await fixture.response("statuses", "", {
    raw: true,
    status: 5,
    stderr: "owned statuses unavailable\n",
  });
  await query("checks", { ok: false });
  await fixture.reset();
  await fixture.response("checks", null);
  await query("checks", { ok: false });
  await fixture.reset();
  for (const operation of ["files", "commits", "checks", "statuses"])
    await fixture.response(operation, "", {
      raw: true,
      status: 6,
      stderr: "owned section unavailable\n",
    });
  const partial = await query("all");
  assert.equal(partial.value.files.length, 0);
  assert.equal(partial.value.filesTruncated, true);
  assert.equal(partial.value.checksState, "unknown");
  assert.deepEqual(
    partial.value.warnings.map((value) => value.section),
    ["files", "commits", "checks"],
  );
  await fixture.reset();
  for (const value of [
    null,
    { ...pullFixture, head: null },
    { ...pullFixture, title: "" },
  ]) {
    await fixture.response("pull", value);
    const invalid = await query("all", { ok: false });
    assert.equal(invalid.calls.length, 1);
  }
  await fixture.reset();
  await review(reviewContextFixture);
  for (const value of [
    null,
    {},
    {
      data: {
        viewer: { login: "" },
        repository: reviewContextFixture.data.repository,
      },
    },
  ])
    await review(value);
  const noPending = structuredClone(reviewContextFixture);
  noPending.data.repository.pullRequest.reviews.nodes[1].author.login = "other";
  await review(noPending);
  for (const position of [null, "invalid", -1, 0, 2.5]) {
    const value = structuredClone(reviewContextFixture);
    value.data.repository.pullRequest.mergeQueueEntry.position = position;
    await review(value);
  }
  for (const count of ["3.5", "unknown", null]) {
    const value = structuredClone(reviewContextFixture);
    value.data.repository.pullRequest.reviews.nodes[1].comments.totalCount =
      count;
    await review(value);
  }
  for (const kind of [
    "null-review",
    "null-thread",
    "null-comment",
    "missing-comment-id",
    "invalid-comment-date",
  ]) {
    const value = structuredClone(reviewContextFixture),
      pull = value.data.repository.pullRequest;
    if (kind === "null-review") pull.reviews.nodes = [null];
    if (kind === "null-thread") pull.reviewThreads.nodes = [null];
    if (kind === "null-comment")
      pull.reviewThreads.nodes[0].comments.nodes = [null];
    if (kind === "missing-comment-id")
      pull.reviewThreads.nodes[0].comments.nodes[0].databaseId = 0;
    if (kind === "invalid-comment-date")
      pull.reviewThreads.nodes[0].comments.nodes[0].createdAt = "not a date";
    await review(value);
  }
  const thread = {
    id: 1,
    reviewId: null,
    author: "reviewer",
    body: "body",
    url: reviewCommentFixture.html_url,
    path: "src/file.rs",
    line: 5,
    side: "RIGHT",
    startLine: null,
    startSide: null,
    diffHunk: "",
    inReplyToId: null,
    createdAt: reviewCommentFixture.created_at,
    updatedAt: reviewCommentFixture.updated_at,
    pending: false,
  };
  for (const comments of [
    [],
    [
      thread,
      { ...thread, id: 2, inReplyToId: 1 },
      { ...thread, id: 3, inReplyToId: 2 },
    ],
    [
      { ...thread, id: 3, inReplyToId: 2 },
      thread,
      { ...thread, id: 2, inReplyToId: 1 },
    ],
    [thread, { ...thread, id: 1, body: "replacement" }],
  ])
    await review(comments, true);
  console.log(
    JSON.stringify({
      suite: "native-pull-request-inspection",
      comparisons,
      reviewComparisons,
      sections: [...sections],
      exactGhAndGitArguments: true,
      partialDataWarnings: true,
      utf16Truncation: true,
      fileFailureRepliesWithOptionalReadHeld: true,
      nodeAbsentFromNativePath: true,
    }),
  );
} finally {
  await fixture.unhold("viewed");
  child.stdin.end();
  assert.equal(await completion, 0);
  for (const key of Object.keys(process.env))
    if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  await rm(root, { recursive: true, force: true });
}
