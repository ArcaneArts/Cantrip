// Actual Node/native PR commands over owned Git and gh process boundaries.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  cp,
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
import { githubOperationsFixture } from "./github-operations-fixture.mjs";
import {
  workflowFixture,
  runFixture,
  jobFixture,
  runnerFixture,
  artifactFixture,
  releaseFixture,
  inboxPullFixture,
  noticeFixture,
} from "./github-operations-fixture.mjs";
import {
  graphqlIssueFixture,
  searchFixture,
} from "./github-issues-fixture.mjs";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-gh-operations-")),
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
const fixture = await githubOperationsFixture(root, bin);
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
execFileSync(git, ["-C", cwd, "tag", "v1.0"]);
execFileSync(git, [
  "-C",
  cwd,
  "remote",
  "add",
  "origin",
  "https://github.com/ArcaneArts/Cantrip.git",
]);
execFileSync(git, ["-C", cwd, "config", "fetch.unpackLimit", "9999"]);
const bare = path.join(root, "owned-run-source.git");
execFileSync(git, ["init", "--bare", "--quiet", bare]);
execFileSync(git, [
  "-C",
  cwd,
  "push",
  "--quiet",
  bare,
  sha + ":refs/heads/main",
]);
const tree = execFileSync(git, ["-C", cwd, "rev-parse", "HEAD^{tree}"], {
  encoding: "utf8",
}).trim();
const fetchedSha = execFileSync(
  git,
  [
    "-C",
    bare,
    "-c",
    "user.name=Owned",
    "-c",
    "user.email=owned@example.invalid",
    "commit-tree",
    tree,
    "-p",
    sha,
    "-m",
    "Owned workflow commit",
  ],
  { encoding: "utf8" },
).trim();
execFileSync(git, ["-C", bare, "update-ref", "refs/pull/43/head", fetchedSha]);
execFileSync(git, ["-C", bare, "update-ref", "refs/heads/feature", fetchedSha]);
await writeFile(path.join(cwd, "dirty.txt"), "Keep this dirty file\n");
const snapshot = path.join(root, "owned-git-baseline");
await cp(path.join(cwd, ".git"), snapshot, { recursive: true });
async function resetGit() {
  await rm(path.join(cwd, ".git"), { recursive: true, force: true });
  await cp(snapshot, path.join(cwd, ".git"), { recursive: true });
}
const fallback = path.join(root, "force-ref-fallback"),
  deny = path.join(root, "deny-fetch");
await writeFile(
  path.join(bin, "git"),
  `#!/bin/sh
printf '%s\\0' "$@" > ${quote(gitCalls)}/$$
if test "$3:$4" = fetch:--no-tags; then
  if test -e ${quote(deny)}; then printf 'Owned fetch denied\\n' >&2; exit 3; fi
  if test -e ${quote(fallback)} && test "$7" = ${quote(fetchedSha)}; then printf 'Owned exact SHA unavailable\\n' >&2; exit 2; fi
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
  { configure = async () => {}, ok = true, trace, held = null } = {},
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
    if (command.type === "github.actions.run.checkout.prepare")
      await resetGit();
    await rm(fallback, { force: true });
    await rm(deny, { force: true });
    await configure();
    if (held) await fixture.hold(held);
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
  if (held) await fixture.release(held);
  await Promise.allSettled(pending);
  const expectedCalls = await fixture.calls(),
    expectedGit = await readGitCalls(),
    expectedTrace = await fixture.mutations();
  await prepare();
  const actual = await native({ op: "github", command });
  if (held) await fixture.unhold(held);
  assert.deepEqual(await native({ op: "github-drain" }), {
    ok: true,
    value: null,
  });
  const label = `${command.type}:${command.action?.type ?? ""} #${comparisons}`;
  for (const key of ["acceptedAt", "updatedAt"]) {
    if (
      actual.ok &&
      [
        "github.actions.run.logs",
        "github.actions.workflow.dispatch",
        "github.actions.run.action",
      ].includes(command.type) &&
      key in actual.value
    ) {
      for (const value of [actual.value[key], expected.value[key]]) {
        assert.match(value, /^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/);
        assert.ok(Math.abs(Date.now() - Date.parse(value)) < 30_000);
      }
      actual.value[key] = expected.value[key];
    }
  }
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
const overview = { type: "github.actions.overview" };
const run = { type: "github.actions.run.get", runId: 7 };
const fail =
  (op, stderr = "Owned endpoint failed\n") =>
  () =>
    fixture.response(op, "", { raw: true, status: 2, stderr });
const inbox = (view = "all", kind = "pull-request") => ({
  type: "github.inbox.list",
  view,
  kind,
  state: "open",
  cursor: null,
  limit: 50,
});
try {
  await compare(overview);
  await compare(
    { ...overview, page: 2, limit: 1 },
    {
      configure: () =>
        fixture.response("runs", {
          total_count: 3,
          workflow_runs: [runFixture, runFixture],
        }),
    },
  );
  await compare(overview, { configure: fail("runners") });
  await compare(overview, {
    configure: () => fixture.response("runners", null),
  });
  await compare(overview, {
    configure: async () => {
      await fixture.response("workflows", {
        total_count: 101,
        workflows: Array(101).fill(workflowFixture),
      });
      await fixture.response("runs", {
        total_count: 101,
        workflow_runs: Array(101).fill(runFixture),
      });
      await fixture.response("runners", {
        total_count: 101,
        runners: Array(101).fill(runnerFixture),
      });
    },
  });
  for (const [op, value] of [
    ["workflows", null],
    ["workflows", { workflows: [null] }],
    ["runs", { workflow_runs: [{}] }],
    ["runners", { runners: [{}] }],
  ])
    await compare(overview, {
      configure: () => fixture.response(op, value),
      ok: false,
    });
  await compare(overview, {
    configure: fail("workflows"),
    held: "runs",
    ok: false,
  });
  await compare(run);
  for (const op of ["jobs", "artifacts"])
    await compare(run, { configure: fail(op) });
  await compare(run, {
    configure: async () => {
      await fail("jobs")();
      await fail("artifacts")();
    },
  });
  for (const [op, value] of [
    ["run", {}],
    ["jobs", null],
    ["jobs", { jobs: [null] }],
    ["artifacts", { artifacts: [{}] }],
  ])
    await compare(run, {
      configure: () => fixture.response(op, value),
      ok: false,
    });
  await compare(run, {
    configure: async () => {
      await fixture.response("jobs", {
        total_count: 102,
        jobs: [{ ...jobFixture, steps: Array(101).fill(jobFixture.steps[0]) }],
      });
      await fixture.response("artifacts", {
        total_count: 101,
        artifacts: Array(101).fill(artifactFixture),
      });
    },
  });
  await compare(run, {
    configure: () =>
      fixture.response("artifacts", {
        artifacts: [
          { ...artifactFixture, name: "REPORT", size_in_bytes: "20" },
          { ...artifactFixture, id: 28, name: "contest" },
        ],
      }),
  });
  const logs = { type: "github.actions.run.logs", runId: 7 };
  await compare(logs);
  await compare(
    { ...logs, jobId: 17 },
    {
      configure: () =>
        fixture.response(
          "logs",
          "\u001b[31mred\u001b[0m\u001b]0;Title\u0007next\u009b32mgreen\u001b[0m",
          { raw: true },
        ),
    },
  );
  await compare(logs, {
    configure: () =>
      fixture.response("logs", "stdout 😀\n", {
        raw: true,
        status: 2,
        stderr: "stderr\n",
      }),
  });
  await compare(logs, {
    configure: () => fixture.response("logs", "", { raw: true, status: 2 }),
  });
  await compare(logs, {
    configure: () =>
      fixture.response("logs", "x".repeat(1_000_001) + "😀", { raw: true }),
  });
  const dispatch = {
    type: "github.actions.workflow.dispatch",
    request: {
      workflowId: 9,
      ref: " main ",
      inputs: {
        z: "last",
        a_key: "😀\ud800",
        A: "upper",
        a: "lower",
        _start: "first",
      },
    },
  };
  await compare(dispatch, { trace: ["dispatch"] });
  await compare(dispatch, {
    configure: fail("dispatch"),
    ok: false,
    trace: ["dispatch"],
  });
  for (const action of ["cancel", "rerun", "rerun-failed"])
    await compare(
      { type: "github.actions.run.action", request: { runId: 7, action } },
      { trace: [action === "rerun-failed" ? "rerunFailed" : action] },
    );
  const checkout = { type: "github.actions.run.checkout.prepare", runId: 7 };
  await compare(checkout, {
    configure: () => fixture.response("run", { ...runFixture, head_sha: sha }),
  });
  for (const forceFallback of [false, true]) {
    const value = (
      await compare(checkout, {
        configure: async () => {
          await fixture.response("run", {
            ...runFixture,
            head_sha: fetchedSha,
          });
          if (forceFallback) await writeFile(fallback, "owned fallback");
        },
      })
    ).value;
    assert.equal(value.headSha, fetchedSha);
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
  }
  await compare(checkout, {
    configure: async () => {
      await fixture.response("run", { ...runFixture, head_sha: fetchedSha });
      await writeFile(deny, "owned denial");
    },
    ok: false,
  });
  await compare(checkout, {
    configure: () => {
      execFileSync(git, [
        "-C",
        cwd,
        "remote",
        "set-url",
        "origin",
        "https://github.com/elsewhere/repository.git",
      ]);
    },
    ok: false,
  });
  const list = { type: "github.releases.list" },
    get = { type: "github.release.get", releaseId: 37 };
  await compare(list);
  await compare(get);
  await compare(list, {
    configure: () =>
      fixture.response("releases", Array(100).fill(releaseFixture)),
  });
  for (const value of [null, {}, [{}]])
    await compare(list, {
      configure: () => fixture.response("releases", value),
      ok: false,
    });
  await compare(get, {
    configure: () =>
      fixture.response("release", {
        ...releaseFixture,
        name: "  ",
        body: 42,
        author: null,
      }),
  });
  const create = {
    type: "github.release.create",
    request: {
      tagName: "v1.0",
      name: "Private release",
      body: "Private body\ud800",
      draft: true,
      prerelease: true,
    },
  };
  await compare(create, { trace: ["createRelease"] });
  await compare(
    { ...create, request: { ...create.request, tagName: "v-new" } },
    { trace: ["createRelease"] },
  );
  await compare(create, {
    configure: fail("createRelease"),
    ok: false,
    trace: ["createRelease"],
  });
  for (const view of [
    "all",
    "needs-review",
    "failed-checks",
    "merge-conflicts",
    "approved-ready",
    "stale",
    "assigned-to-me",
    "activity",
  ])
    await compare(inbox(view));
  await compare(inbox("all", "issue"));
  await compare({
    ...inbox(),
    cursor: "opaque 😀\ud800",
    limit: 2,
    state: "closed",
  });
  await compare(inbox("activity"), { configure: fail("notifications") });
  await compare(inbox(), { configure: fail("auth"), ok: false });
  await compare(inbox(), {
    configure: () => fixture.response("notifications", [noticeFixture, null]),
  });
  await compare(inbox("activity"), {
    configure: () => fixture.response("notifications", []),
  });
  await compare(inbox(), {
    configure: () => fixture.response("inbox", null),
    ok: false,
  });
  await compare(inbox("activity"), {
    configure: () => fixture.response("activity", {}),
    ok: false,
  });
  const states = [
    {
      ...inboxPullFixture,
      number: 43,
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      commits: { nodes: [] },
    },
    {
      ...inboxPullFixture,
      number: 44,
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "CONFLICTING",
      commits: {
        nodes: [{ commit: { statusCheckRollup: { state: "ERROR" } } }],
      },
    },
    {
      ...inboxPullFixture,
      number: 45,
      isDraft: true,
      commits: {
        nodes: [{ commit: { statusCheckRollup: { state: "EXPECTED" } } }],
      },
    },
    {
      ...inboxPullFixture,
      number: 46,
      updatedAt: "2000-01-01T00:00:00Z",
      assignees: { nodes: [{ login: "ghost" }, { login: "fixture-user" }] },
      commits: {
        nodes: [{ commit: { statusCheckRollup: { state: "OTHER" } } }],
      },
    },
  ];
  for (const view of ["all", "merge-conflicts", "approved-ready"])
    await compare(inbox(view), {
      configure: () =>
        fixture.response(
          "inbox",
          searchFixture(states, { total: 99, cursor: "next", next: true }),
        ),
    });
  await compare(inbox(), {
    configure: () =>
      fixture.response(
        "inbox",
        searchFixture([{ ...inboxPullFixture, number: "wrong" }]),
      ),
    ok: false,
  });
  await compare(inbox(), {
    configure: () =>
      fixture.response(
        "inbox",
        searchFixture([
          {
            ...inboxPullFixture,
            comments: { totalCount: "bad" },
            labels: { nodes: [{ name: "bad", color: "invalid" }] },
          },
        ]),
      ),
    ok: false,
  });
  await compare(inbox("activity"), {
    configure: async () => {
      await fixture.response("notifications", [
        { ...noticeFixture, reason: "assign" },
        { ...noticeFixture, reason: "team_mention", unread: false },
        {
          ...noticeFixture,
          subject: {
            type: "PullRequest",
            url: "https://api.invalid/issues/x/pulls/44",
          },
          reason: "review_requested",
        },
      ]);
      await fixture.response("activity", {
        data: { repository: { item0: states[0], item1: states[1] } },
      });
    },
  });
  console.log(
    JSON.stringify({
      suite: "native-github-operations",
      comparisons,
      commandKinds: [...kinds],
      exactGhAndGitArguments: true,
      notificationsAndMentionFallback: true,
      boundedActionsAndCapturedLogs: true,
      localeSortedDispatchInputs: true,
      releaseTagAndHeadTargets: true,
      exactCommitFetchFallbacks: true,
      ownedConcurrentRead: true,
      nodeAbsentFromNativePath: true,
    }),
  );
} finally {
  await fixture.unhold("runs");
  child.stdin.end();
  assert.equal(await completion, 0);
  for (const key of Object.keys(process.env))
    if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  await rm(root, { recursive: true, force: true });
}
