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
import { GithubClient } from "../../tests/reference-node-worker/src/github.ts";
import { handleGithubCommand } from "../../tests/reference-node-worker/src/commands/github.ts";
import { pullRequestActionsFixture } from "./pull-request-actions-fixture.mjs";
import { pullFixture, reviewContextFixture } from "./pull-request-fixture.mjs";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-pr-actions-")),
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
const fixture = await pullRequestActionsFixture(root, bin);
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
execFileSync(git, [
  "-C",
  cwd,
  "-c",
  "user.name=Owned",
  "-c",
  "user.email=owned@example.invalid",
  "commit",
  "--quiet",
  "--allow-empty",
  "-m",
  "Owned",
]);
execFileSync(git, ["-C", cwd, "branch", "feature/é!😀"]);
const sha = execFileSync(git, ["-C", cwd, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const base = execFileSync(git, ["-C", cwd, "symbolic-ref", "--short", "HEAD"], {
  encoding: "utf8",
}).trim();
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
  comparisons = 0;
const kinds = new Set(),
  actions = new Set();
async function native(input) {
  child.stdin.write(
    JSON.stringify({ ...input, directory, requestId: ++sequence }) + "\n",
  );
  const line = await lines.next();
  assert.equal(line.done, false);
  const { id, result } = JSON.parse(line.value);
  assert.equal(id, sequence);
  const { code, ...value } = result;
  return value;
}
async function readGitCalls() {
  const result = [];
  for (const name of await readdir(gitCalls)) {
    const file = path.join(gitCalls, name);
    result.push((await readFile(file, "utf8")).split("\0").slice(0, -1));
    await rm(file);
  }
  return result.sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}
async function compare(
  input,
  { configure = async () => {}, ok = true, trace } = {},
) {
  const command = workerCommandSchema.parse({
    repository: "ArcaneArts/Cantrip",
    cwd,
    number: 43,
    ...input,
  });
  await fixture.calls();
  await readGitCalls();
  async function prepare() {
    await fixture.reset();
    await fixture.response("remoteRef", { object: { sha } });
    await configure();
  }
  await prepare();
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
      value: await handleGithubCommand(command, { github }),
    };
  } catch (error) {
    expected = { ok: false, error: error.message };
  }
  await Promise.allSettled(pending);
  const expectedCalls = await fixture.calls(),
    expectedGit = await readGitCalls(),
    expectedTrace = await fixture.mutations();
  await prepare();
  const actual = await native({ op: "github", command });
  assert.deepEqual(await native({ op: "github-drain" }), {
    ok: true,
    value: null,
  });
  const label = `${command.type}:${command.action?.type ?? ""} #${comparisons}`;
  assert.deepEqual(actual, expected, label);
  assert.deepEqual(
    await fixture.calls(),
    expectedCalls,
    "exact gh argv " + label,
  );
  assert.deepEqual(
    await readGitCalls(),
    expectedGit,
    "exact git argv " + label,
  );
  assert.deepEqual(
    await fixture.mutations(),
    expectedTrace,
    "mutation sequencing " + label,
  );
  if (trace) assert.deepEqual(expectedTrace, trace, label);
  assert.equal(actual.ok, ok, label);
  comparisons++;
  kinds.add(command.type);
  if (command.action) actions.add(command.action.type);
  return actual;
}
const create = {
  type: "github.pull-request.create",
  request: { base, head: "feature/é!😀", title: "  Owned create 😀  " },
};
const mutate = (action) => ({
  type: "github.pull-request.review.mutate",
  action,
});
const noPending = structuredClone(reviewContextFixture);
noPending.data.repository.pullRequest.reviews.nodes = [];
const fail =
  (op, stderr = "owned mutation failed\n") =>
  () =>
    fixture.response(op, "", { raw: true, status: 2, stderr });
try {
  await compare(create, { trace: ["createPull"] });
  await compare(
    {
      ...create,
      request: {
        ...create.request,
        body: "  Body\ud800  ",
        draft: true,
        linkedIssueNumbers: [9, 9, 3],
        labels: ["bug", "bug", "Bug"],
        reviewers: ["reviewer", "reviewer", "other"],
      },
    },
    { trace: ["createPull", "labels", "reviewers"] },
  );
  await compare(
    {
      ...create,
      request: { ...create.request, labels: ["bug"], reviewers: ["reviewer"] },
    },
    {
      configure: async () => {
        await fail("labels")();
        await fail("reviewers")();
      },
      trace: ["createPull", "labels", "reviewers"],
    },
  );
  for (const remote of [
    { object: { sha: "f".repeat(40) } },
    { object: { sha: sha.toUpperCase() } },
    { object: null },
    { object: { sha: 42 } },
    null,
  ])
    await compare(create, {
      configure: () => fixture.response("remoteRef", remote),
      ok: false,
      trace: [],
    });
  await compare(create, { configure: fail("remoteRef"), ok: false, trace: [] });
  await compare(create, {
    configure: fail("createPull"),
    ok: false,
    trace: ["createPull"],
  });
  await compare(
    { ...create, request: { ...create.request, head: "missing" } },
    { ok: false, trace: [] },
  );
  await compare(
    { ...create, request: { ...create.request, head: "invalid..branch" } },
    { ok: false, trace: [] },
  );
  await compare({ ...create, cwd: root }, { ok: false, trace: [] });
  await compare(create, {
    configure: () => fixture.response("createPull", {}),
    ok: false,
    trace: ["createPull"],
  });
  await compare(
    {
      ...create,
      request: { ...create.request, labels: ["bug"], reviewers: ["reviewer"] },
    },
    {
      configure: fail("labels", "x".repeat(1100)),
      ok: false,
      trace: ["createPull", "labels", "reviewers"],
    },
  );
  const comment = { body: "  Private comment 😀\ud800  " };
  await compare(
    { type: "github.pull-request.comment", ...comment },
    { trace: ["comment"] },
  );
  await compare(
    { type: "github.pull-request.review.reply", commentId: 101, ...comment },
    { trace: ["reply"] },
  );
  await compare(
    { type: "github.pull-request.review.submit", review: { event: "approve" } },
    { trace: ["submitReview"] },
  );
  const inline = {
    body: " Owned line ",
    path: "src/file.rs",
    line: 5,
    side: "RIGHT",
  };
  await compare(
    { type: "github.pull-request.review.comment", comment: inline },
    { trace: ["addThread"] },
  );
  for (const event of ["comment", "approve", "request-changes"])
    await compare(
      mutate({
        type: "submit-review",
        review: { event, body: "review 😀\ud800" },
      }),
      { trace: ["submitReview"] },
    );
  await compare(mutate({ type: "comment", ...comment }), {
    trace: ["comment"],
  });
  await compare(mutate({ type: "reply", commentId: 101, ...comment }), {
    trace: ["reply"],
  });
  for (const pending of [true, false]) {
    const configure = () =>
      fixture.response("context", pending ? reviewContextFixture : noPending);
    await compare(
      mutate({
        type: "inline-comment",
        comment: { ...inline, startLine: 3, startSide: "LEFT" },
      }),
      {
        configure,
        trace: pending ? ["addThread"] : ["createReview", "addThread"],
      },
    );
    await compare(
      mutate({ type: "submit-review", review: { event: "comment" } }),
      { configure, trace: [pending ? "submitReview" : "submitRest"] },
    );
    await compare(mutate({ type: "discard-review" }), {
      configure,
      ok: pending,
      trace: pending ? ["deleteReview"] : [],
    });
  }
  await compare(mutate({ type: "inline-comment", comment: inline }), {
    configure: async () => {
      await fixture.response("context", noPending);
      await fixture.response("createReview", {
        data: { addPullRequestReview: { pullRequestReview: { id: 7 } } },
      });
    },
    ok: false,
    trace: ["createReview"],
  });
  await compare(mutate({ type: "inline-comment", comment: inline }), {
    configure: async () => {
      await fixture.response("context", noPending);
      await fail("addThread")();
    },
    ok: false,
    trace: ["createReview", "addThread"],
  });
  for (const resolved of [true, false])
    await compare(
      mutate({
        type: "set-thread-resolved",
        threadId: "thread-owned",
        resolved,
      }),
      { trace: [resolved ? "resolveThread" : "unresolveThread"] },
    );
  await compare(
    mutate({
      type: "set-thread-resolved",
      threadId: "foreign-thread",
      resolved: true,
    }),
    { ok: false, trace: [] },
  );
  for (const viewed of [true, false])
    await compare(
      mutate({ type: "set-file-viewed", path: "src/file.rs", viewed }),
      { trace: [viewed ? "markViewed" : "unmarkViewed"] },
    );
  const details = {
    title: " New title 😀 ",
    body: "Body\ud800",
    labels: ["new", "new"],
    reviewers: ["next", "next"],
  };
  const labelPull = {
    ...pullFixture,
    labels: [
      { name: "old /é!😀", color: "ffffff" },
      { name: "old /é!😀", color: "ffffff" },
    ],
  };
  await compare(mutate({ type: "update-details", details }), {
    configure: () => fixture.response("pull", labelPull),
    trace: [
      "patchPull",
      "labels",
      "deleteLabel",
      "reviewers",
      "deleteReviewers",
    ],
  });
  await compare(
    mutate({
      type: "update-details",
      details: { ...details, labels: [], reviewers: ["reviewer"] },
    }),
    {
      configure: () => fixture.response("pull", { ...pullFixture, labels: [] }),
      trace: ["patchPull"],
    },
  );
  for (const stop of [
    "patchPull",
    "labels",
    "deleteLabel",
    "reviewers",
    "deleteReviewers",
  ]) {
    const order = [
      "patchPull",
      "labels",
      "deleteLabel",
      "reviewers",
      "deleteReviewers",
    ];
    await compare(mutate({ type: "update-details", details }), {
      configure: async () => {
        await fixture.response("pull", labelPull);
        await fail(stop)();
      },
      ok: false,
      trace: order.slice(0, order.indexOf(stop) + 1),
    });
  }
  await compare(mutate({ type: "update-details", details }), {
    configure: () =>
      fixture.response("pull", {
        ...pullFixture,
        labels: [{ name: "old\ud800", color: "ffffff" }],
      }),
    ok: false,
    trace: ["patchPull", "labels"],
  });
  const changed = {
    ...pullFixture,
    title: "Actually refreshed after mutation",
  };
  assert.equal(
    (
      await compare(mutate({ type: "comment", ...comment }), {
        configure: () => fixture.after("comment", "pull", changed),
        trace: ["comment"],
      })
    ).value.title,
    changed.title,
  );
  await compare(mutate({ type: "comment", ...comment }), {
    configure: () => fixture.after("comment", "pull", {}),
    ok: false,
    trace: ["comment"],
  });
  await compare(mutate({ type: "discard-review" }), {
    configure: fail("context"),
    ok: false,
    trace: [],
  });
  await compare(mutate({ type: "comment", body: "NUL\0body" }), {
    ok: false,
    trace: [],
  });
  await compare(
    { type: "github.pull-request.comment", cwd: root, ...comment },
    { ok: false, trace: [] },
  );
  console.log(
    JSON.stringify({
      suite: "native-pull-request-actions",
      comparisons,
      commandKinds: [...kinds],
      reviewActions: [...actions],
      exactGhAndGitArguments: true,
      exactMutationOrderAndFailures: true,
      publishedBranchGuard: true,
      refreshAfterMutation: true,
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
