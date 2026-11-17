// Actual Node/native mutations in separate matching owned repositories. All
// remotes are local bare repositories; nothing contacts a hosted Git service.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  cp,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { gitActionSchema } from "../../packages/protocol/dist/index.js";
import { runGitAction, readGitStatus } from "../../cantrip_worker/src/git.ts";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const original = { ...process.env };
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_DATE: "2026-11-16T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-11-16T00:00:00+00:00",
  LC_ALL: "C",
});
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-actions-"));
const nodeRoot = path.join(root, "node"),
  rustRoot = path.join(root, "rust"),
  template = path.join(root, "template");
await mkdir(template);
await mkdir(nodeRoot);
await mkdir(rustRoot);
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function configure(cwd) {
  for (const [name, value] of Object.entries({
    "user.name": "Fixture",
    "user.email": "fixture@example.invalid",
    "commit.gpgsign": "false",
    "core.hooksPath": "/dev/null",
    "color.ui": "false",
  }))
    git(cwd, "config", name, value);
}
git(template, "-c", "init.defaultBranch=main", "init", "--quiet");
configure(template);
const trees = [
  path.join(nodeRoot, "checkout"),
  path.join(rustRoot, "checkout"),
];
await cp(template, trees[0], { recursive: true });
await cp(template, trees[1], { recursive: true });
const child = spawn(path.resolve(values.binary), [], {
  stdio: ["pipe", "pipe", "inherit"],
});
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let sequence = 0,
  comparisons = 0;
const exercised = new Set();
function normalize(value) {
  if (typeof value === "string")
    return value
      .replaceAll(nodeRoot, "<owned>")
      .replaceAll(rustRoot, "<owned>");
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v)]),
    );
  return value;
}
async function native(input) {
  child.stdin.write(JSON.stringify({ ...input, requestId: ++sequence }) + "\n");
  const line = await lines.next();
  assert.equal(line.done, false);
  const { id, result } = JSON.parse(line.value);
  assert.equal(id, sequence);
  const { code, ...value } = result;
  return value;
}
async function observe(read) {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
async function action(input) {
  const action = gitActionSchema.parse(input);
  exercised.add(action.type);
  const expected = await observe(() => runGitAction(trees[0], action));
  const actual = await native({
    op: "git",
    command: { type: "git.action", cwd: trees[1], action },
  });
  assert.deepEqual(
    normalize(actual),
    normalize(expected),
    JSON.stringify(action),
  );
  assert.deepEqual(
    await readGitStatus(trees[1]),
    await readGitStatus(trees[0]),
    "actual resulting index/HEAD/branch state",
  );
  comparisons++;
  return actual;
}
async function write(file, content) {
  for (const cwd of trees) await writeFile(path.join(cwd, file), content);
}
function both(...args) {
  return trees.map((cwd) => git(cwd, ...args));
}
function commit(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
}
try {
  await write("tracked.txt", "initial\n");
  await write("second.txt", "second\n");
  await action({ type: "stage", paths: ["tracked.txt"] });
  await action({ type: "unstage", paths: ["tracked.txt"] });
  await action({ type: "stageAll" });
  await action({ type: "unstageAll" });
  await action({ type: "commit", message: " initial ", all: true });
  await action({ type: "commit", message: "nothing" });
  await write("tracked.txt", "staged\n");
  await action({ type: "stage", paths: ["tracked.txt"] });
  await write("tracked.txt", "working\n");
  await action({ type: "unstage", paths: ["tracked.txt"] });
  await action({ type: "stageAll" });
  await action({ type: "unstageAll" });
  await action({ type: "stage", paths: ["tracked.txt"] });
  await write("tracked.txt", "discard this\n");
  await action({ type: "discard", paths: ["tracked.txt"] });
  assert.equal(
    await readFile(path.join(trees[1], "tracked.txt"), "utf8"),
    "working\n",
  );
  await action({ type: "discard", paths: ["missing", "missing\ud800"] });
  await write("literal[ab].txt", "literal\n");
  await write("literala.txt", "keep\n");
  await action({ type: "discard", paths: ["literal[ab].txt"] });
  assert.equal(
    await readFile(path.join(trees[1], "literala.txt"), "utf8"),
    "keep\n",
  );
  await action({ type: "discardAll" });
  assert.equal(
    (await readGitStatus(trees[1])).files.find(
      (file) => file.path === "tracked.txt",
    ).staged,
    true,
  );
  await action({ type: "commit", message: "literal `shell` $(ignored)" });
  await action({ type: "createBranch", name: "feature/new" });
  await action({ type: "checkout", branch: "main" });
  await action({ type: "checkout", branch: "no-such-branch" });
  await action({ type: "createBranch", name: "-invalid" });
  await action({ type: "push" });
  both("checkout", "--detach", "--quiet");
  await action({ type: "push" });
  both("checkout", "--quiet", "main");
  await write("tracked.txt", "hook changes\n");
  for (const cwd of trees) {
    git(cwd, "config", "core.hooksPath", ".git/hooks");
    const hook = path.join(cwd, ".git/hooks/pre-commit");
    await writeFile(
      hook,
      "#!/bin/sh\nprintf 'from-stdout\\n'\nprintf 'from-stderr\\n' >&2\nexit 23\n",
    );
    await chmod(hook, 0o700);
  }
  const rejected = await action({
    type: "commit",
    message: "hook rejects",
    all: true,
  });
  assert.deepEqual(rejected, { ok: false, error: "from-stdout\nfrom-stderr" });
  for (const cwd of trees)
    await writeFile(
      path.join(cwd, ".git/hooks/pre-commit"),
      "#!/bin/sh\nprintf 'only-stdout\\n'\nexit 23\n",
    );
  assert.deepEqual(
    await action({ type: "commit", message: "stdout rejection" }),
    { ok: false, error: "only-stdout" },
  );
  both("config", "core.hooksPath", "/dev/null");
  await action({ type: "commit", message: "commit retained index" });
  const remotes = [
    path.join(nodeRoot, "origin.git"),
    path.join(rustRoot, "origin.git"),
  ];
  for (let i = 0; i < 2; i++) {
    git(
      root,
      "-c",
      "init.defaultBranch=main",
      "init",
      "--bare",
      "--quiet",
      remotes[i],
    );
    git(trees[i], "remote", "add", "origin", remotes[i]);
  }
  assert.equal(
    (await action({ type: "push" })).value.status.upstream,
    "origin/main",
  );
  await action({ type: "push" });
  for (let i = 0; i < 2; i++) {
    const head = git(trees[i], "rev-parse", "HEAD");
    git(
      root,
      "--git-dir",
      remotes[i],
      "update-ref",
      "refs/heads/remote-only",
      head,
    );
    git(trees[i], "fetch", "--quiet", "origin");
  }
  await action({ type: "checkout", branch: "origin/remote-only" });
  await action({ type: "checkout", branch: "main" });
  await action({ type: "checkout", branch: "origin/remote-only" });
  await action({ type: "checkout", branch: "main" });
  for (let i = 0; i < 2; i++) git(trees[i], "remote", "add", "aaa", remotes[i]);
  await action({ type: "createBranch", name: "prefer-origin" });
  assert.equal(
    (await action({ type: "push" })).value.status.upstream,
    "origin/prefer-origin",
  );
  await action({ type: "checkout", branch: "main" });
  both("remote", "remove", "origin");
  await action({ type: "createBranch", name: "first-remote" });
  assert.equal(
    (await action({ type: "push" })).value.status.upstream,
    "aaa/first-remote",
  );
  await action({ type: "checkout", branch: "main" });
  both("remote", "rename", "aaa", "origin");
  both("config", "branch.main.remote", "origin");
  both("config", "branch.main.merge", "refs/heads/main");
  const publishers = [
    path.join(nodeRoot, "publisher"),
    path.join(rustRoot, "publisher"),
  ];
  for (let i = 0; i < 2; i++) {
    git(root, "clone", "--quiet", remotes[i], publishers[i]);
    configure(publishers[i]);
    await writeFile(
      path.join(publishers[i], "remote.txt"),
      "remote addition\n",
    );
    commit(publishers[i], "remote addition");
    git(publishers[i], "push", "--quiet", "origin", "main");
  }
  const pulled = await action({ type: "pull" });
  assert.equal(pulled.ok, true, JSON.stringify(pulled));
  assert.equal(pulled.value.status.behind, 0);
  await write("tracked.txt", "local divergence\n");
  await action({ type: "commit", message: "local divergence", all: true });
  for (let i = 0; i < 2; i++) {
    await writeFile(
      path.join(publishers[i], "diverged.txt"),
      "remote divergence\n",
    );
    commit(publishers[i], "remote divergence");
    git(publishers[i], "push", "--quiet", "origin", "main");
  }
  assert.equal((await action({ type: "pull" })).ok, false);
  assert.equal((await readGitStatus(trees[1])).behind, 1);
  assert.equal((await action({ type: "push" })).ok, false);
  both("checkout", "--quiet", "-b", "conflict");
  await write("tracked.txt", "side conflict\n");
  for (const cwd of trees) commit(cwd, "side conflict");
  both("checkout", "--quiet", "main");
  await write("tracked.txt", "main conflict\n");
  for (const cwd of trees) commit(cwd, "main conflict");
  for (const cwd of trees) {
    let failed = false;
    try {
      git(cwd, "merge", "--no-edit", "conflict");
    } catch {
      failed = true;
    }
    assert.equal(failed, true);
  }
  await write("preserved.txt", "preserve on rejected discardAll\n");
  assert.equal((await action({ type: "discardAll" })).ok, false);
  assert.equal(
    await readFile(path.join(trees[1], "preserved.txt"), "utf8"),
    "preserve on rejected discardAll\n",
  );
  await action({ type: "discard", paths: ["preserved.txt"] });
  console.log(
    JSON.stringify({
      suite: "native-git-actions",
      comparisons,
      variants: exercised.size,
      variantNames: [...exercised].sort(),
      actualGit: true,
      localBareRemotes: true,
      ownedRepositories: true,
      normalization: "only corresponding owned fixture root paths",
    }),
  );
} finally {
  child.stdin.end();
  await completion;
  await rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env))
    if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
}
