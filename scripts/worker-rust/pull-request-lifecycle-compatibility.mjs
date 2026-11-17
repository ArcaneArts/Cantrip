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
import { GithubClient } from "../../cantrip_worker/src/github.ts";
import { handleGithubCommand } from "../../cantrip_worker/src/commands/github.ts";
import { pullRequestLifecycleFixture } from "./pull-request-lifecycle-fixture.mjs";
import {
  pullFixture,
  checkFixture,
  statusFixture,
  reviewFixture,
} from "./pull-request-fixture.mjs";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-pr-lifecycle-")),
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
const fixture = await pullRequestLifecycleFixture(root, bin);
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
const bare = path.join(root, "owned pull source.git");
execFileSync(git, ["init", "--bare", "--quiet", bare]);
execFileSync(git, ["-C", cwd, "config", "user.name", "Owned"]);
execFileSync(git, ["-C", cwd, "config", "user.email", "owned@example.invalid"]);
const tree = execFileSync(git, ["-C", cwd, "rev-parse", "HEAD^{tree}"], {
  encoding: "utf8",
}).trim();
const fetchedSha = execFileSync(
  git,
  ["-C", cwd, "commit-tree", tree, "-p", sha, "-m", "Owned pull source"],
  { encoding: "utf8" },
).trim();
execFileSync(git, [
  "-C",
  cwd,
  "push",
  "--quiet",
  bare,
  fetchedSha + ":refs/pull/43/head",
]);
execFileSync(git, [
  "-C",
  cwd,
  "remote",
  "add",
  "origin",
  "https://github.com/ArcaneArts/Cantrip.git",
]);
await writeFile(path.join(cwd, "dirty.txt"), "Keep this dirty file\n");
await writeFile(
  path.join(bin, "git"),
  `#!/bin/sh
printf '%s\\0' "$@" > ${quote(gitCalls)}/$$
if test "$3:$4" = fetch:--no-tags; then
  exec ${quote(git)} -c ${quote("url." + bare + ".insteadOf=https://github.com/ArcaneArts/Cantrip.git")} "$@"
fi
exec ${quote(git)} "$@"
`,
  { mode: 0o700 },
);
process.env.GIT_ALLOW_PROTOCOL = "file";
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
const preview = (action) => ({
  type: "github.pull-request.lifecycle.preview",
  action,
});
const fail =
  (op, message = "owned endpoint failed\n") =>
  () =>
    fixture.response(op, "", { raw: true, status: 2, stderr: message });
const closed = () =>
  fixture.response("pull", { ...pullFixture, state: "closed" });
const draft = () => fixture.response("pull", { ...pullFixture, draft: true });
const mergeAction = {
  type: "merge",
  method: "squash",
  commitTitle: " Owned title ",
  commitMessage: " Body 😀\ud800 ",
};
const lifecycle = [
  [{ type: "close" }, "patchPull"],
  [{ type: "reopen" }, "patchPull", closed],
  [{ type: "mark-ready" }, "ready", draft],
  [{ type: "convert-draft" }, "convertDraft"],
  [{ type: "update-branch" }, "updateBranch"],
  [mergeAction, "merge"],
  [{ ...mergeAction, type: "enable-auto-merge" }, "enableAuto"],
  [{ type: "disable-auto-merge" }, "disableAuto"],
  [{ type: "enqueue-merge-queue" }, "enqueue"],
  [{ type: "dequeue-merge-queue" }, "dequeue"],
];
try {
  for (const [action, effect, configure] of lifecycle) {
    const options = { configure, trace: [] };
    const reviewed = (await compare(preview(action), options)).value;
    await compare(
      {
        type: "github.pull-request.lifecycle.apply",
        request: {
          action,
          token: reviewed.token,
          confirmation: reviewed.confirmationPhrase ?? "",
        },
      },
      { configure, trace: [effect] },
    );
  }
  for (const state of [
    { state: "closed" },
    { merged: true },
    { draft: true },
    { mergeable: null },
    { mergeable: false, mergeable_state: "blocked\ud800" },
  ])
    await compare(preview(mergeAction), {
      configure: () => fixture.response("pull", { ...pullFixture, ...state }),
      ok: false,
      trace: [],
    });
  await compare(preview({ type: "reopen" }), { ok: false, trace: [] });
  await compare(preview({ type: "mark-ready" }), { ok: false, trace: [] });
  await compare(preview({ type: "close" }), {
    configure: closed,
    ok: false,
    trace: [],
  });
  const failedReview = async () => {
    await fixture.response("checks", {
      total_count: 1,
      check_runs: [{ ...checkFixture, conclusion: "failure" }],
    });
    await fixture.response("reviews", [
      { ...reviewFixture, state: "CHANGES_REQUESTED" },
    ]);
    await fixture.response("pull", {
      ...pullFixture,
      head: { ...pullFixture.head, ref: "feature\ud800" },
      base: { ...pullFixture.base, ref: "base\udfff" },
    });
  };
  const warned = (
    await compare(preview(mergeAction), { configure: failedReview, trace: [] })
  ).value;
  assert.equal(warned.warnings.length, 3);
  await compare(preview(mergeAction), {
    configure: () => fixture.response("reviews", []),
    trace: [],
  });
  const basic = (await compare(preview(mergeAction), { trace: [] })).value;
  await compare(
    {
      type: "github.pull-request.lifecycle.apply",
      request: {
        action: mergeAction,
        token: "0".repeat(64),
        confirmation: basic.confirmationPhrase,
      },
    },
    { ok: false, trace: [] },
  );
  await compare(
    {
      type: "github.pull-request.lifecycle.apply",
      request: {
        action: mergeAction,
        token: basic.token,
        confirmation: "wrong",
      },
    },
    { ok: false, trace: [] },
  );
  for (const changed of [
    { head: { ...pullFixture.head, sha: "c".repeat(40) } },
    { base: { ...pullFixture.base, sha: "d".repeat(40) } },
  ])
    await compare(
      {
        type: "github.pull-request.lifecycle.apply",
        request: {
          action: mergeAction,
          token: basic.token,
          confirmation: basic.confirmationPhrase,
        },
      },
      {
        configure: () =>
          fixture.response("pull", { ...pullFixture, ...changed }),
        ok: false,
        trace: [],
      },
    );
  for (const response of [
    { merged: false, message: "Declined\ud800" },
    { merged: false },
    null,
  ])
    await compare(
      {
        type: "github.pull-request.lifecycle.apply",
        request: {
          action: mergeAction,
          token: basic.token,
          confirmation: basic.confirmationPhrase,
        },
      },
      {
        configure: () => fixture.response("merge", response),
        ok: false,
        trace: ["merge"],
      },
    );
  await compare(
    {
      type: "github.pull-request.lifecycle.apply",
      request: {
        action: mergeAction,
        token: basic.token,
        confirmation: basic.confirmationPhrase,
      },
    },
    { configure: fail("merge"), ok: false, trace: ["merge"] },
  );
  const refreshed = {
    ...pullFixture,
    state: "closed",
    closed_at: "2026-11-17T00:00:00Z",
  };
  const closePreview = (
    await compare(preview({ type: "close" }), { trace: [] })
  ).value;
  const after = await compare(
    {
      type: "github.pull-request.lifecycle.apply",
      request: {
        action: { type: "close" },
        token: closePreview.token,
        confirmation: closePreview.confirmationPhrase,
      },
    },
    {
      configure: () => fixture.after("patchPull", "pull", refreshed),
      trace: ["patchPull"],
    },
  );
  assert.equal(after.value.state, "closed");
  const checkout = { type: "github.pull-request.checkout.prepare" };
  const sourcePull = {
    ...pullFixture,
    head: { ref: "FÉATURE/_--É..😀", sha: fetchedSha },
    title: "A".repeat(193) + "😀\ud800",
  };
  const fetched = (
    await compare(checkout, {
      configure: () => fixture.response("pull", sourcePull),
      trace: [],
    })
  ).value;
  assert.equal(fetched.headSha, fetchedSha);
  assert.equal(
    execFileSync(git, ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    sha,
  );
  assert.equal(
    execFileSync(git, ["-C", cwd, "symbolic-ref", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    base,
  );
  assert.equal(
    await readFile(path.join(cwd, "dirty.txt"), "utf8"),
    "Keep this dirty file\n",
  );
  await compare(checkout, { ok: false, trace: [] });
  execFileSync(git, ["-C", cwd, "remote", "rename", "origin", "upstream"]);
  assert.equal(
    (
      await compare(checkout, {
        configure: () => fixture.response("pull", sourcePull),
        trace: [],
      })
    ).value.remote,
    "upstream",
  );
  execFileSync(git, [
    "-C",
    cwd,
    "remote",
    "add",
    "origin",
    "https://github.com/other/repository.git",
  ]);
  await compare(checkout, {
    configure: () => fixture.response("pull", sourcePull),
    trace: [],
  });
  execFileSync(git, [
    "-C",
    cwd,
    "remote",
    "set-url",
    "upstream",
    "https://github.com/other/repository.git",
  ]);
  await compare(checkout, {
    configure: () => fixture.response("pull", sourcePull),
    ok: false,
    trace: [],
  });
  execFileSync(git, [
    "-C",
    cwd,
    "remote",
    "set-url",
    "origin",
    "https://github.com/ArcaneArts/Cantrip.git",
  ]);
  const context = (intent) => ({
    type: "github.pull-request.agent-context",
    request: { intent },
  });
  await compare(context("address-review"), { trace: [] });
  await compare(context("fix-checks"), { trace: [] });
  const failures = Array.from({ length: 9 }, (_, i) => ({
    ...checkFixture,
    id: i + 1,
    name: "Failed " + i,
    conclusion: "failure",
    details_url:
      i === 8
        ? "https://example.invalid/actions/runs/7"
        : `https://github.com/ArcaneArts/Cantrip/actions/runs/${7 + Math.min(i, 5)}`,
  }));
  const withFailures = async () => {
    await fixture.response("checks", {
      total_count: failures.length,
      check_runs: failures,
    });
    await fixture.response("statuses", {
      statuses: [{ ...statusFixture, state: "error" }],
    });
  };
  const evidence = (
    await compare(context("fix-checks"), { configure: withFailures, trace: [] })
  ).value;
  assert.equal(evidence.failedChecks.length, 10);
  assert.equal(
    evidence.failedChecks[6].logUnavailableReason,
    "This run was outside the bounded log-fetch window.",
  );
  await compare(context("fix-checks"), {
    configure: async () => {
      await withFailures();
      await fail("log-8")();
      await fixture.response("log-9", "", { raw: true });
      await fixture.response("log-10", "😀".repeat(50001), { raw: true });
    },
    trace: [],
  });
  await compare(context("address-review"), {
    configure: withFailures,
    trace: [],
  });
  await compare(context("fix-checks"), {
    configure: async () => {
      await withFailures();
      await fail("log-7", "error 😀".repeat(500))();
    },
    trace: [],
  });
  await compare(context("fix-checks"), {
    configure: async () => {
      await withFailures();
      await fixture.response("checks", {
        total_count: 25,
        check_runs: Array.from({ length: 25 }, (_, i) => ({
          ...failures[0],
          id: i + 1,
        })),
      });
    },
    trace: [],
  });
  console.log(
    JSON.stringify({
      suite: "native-pull-request-lifecycle",
      comparisons,
      commandKinds: [...kinds],
      allTenLifecycleActions: true,
      exactTokensAndArguments: true,
      staleAndConfirmationGuards: true,
      realLocalFetchWithoutCheckoutChange: true,
      boundedAgentEvidence: true,
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
