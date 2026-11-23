// Reviewed commit mutations against actual Node handlers and matching Git repos.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as p from "../../packages/protocol/dist/index.js";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const original = { ...process.env };
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  LC_ALL: "C",
  GIT_AUTHOR_DATE: "2026-11-17T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-11-17T00:00:00+00:00",
});
const { handleGitCommand } =
  await import("../../tests/reference-node-worker/src/commands/git.ts");
const { readGitStatus } =
  await import("../../tests/reference-node-worker/src/git.ts");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-commits-"));
const template = path.join(root, "template"),
  nodeRoot = path.join(root, "node"),
  rustRoot = path.join(root, "rust");
for (const dir of [template, nodeRoot, rustRoot]) await mkdir(dir);
const trees = [
  path.join(nodeRoot, "checkout"),
  path.join(rustRoot, "checkout"),
];
const bin = path.join(root, "bin"),
  cancel = path.join(root, "cancel"),
  ready = path.join(root, "ready");
await mkdir(bin);
const realGit = execFileSync("/usr/bin/which", ["git"], {
  encoding: "utf8",
}).trim();
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
await writeFile(
  path.join(bin, "git"),
  `#!/bin/sh\nif [ -f ${quote(cancel)} ] && [ "$3" = cherry-pick ] && [ "$4" = --no-commit ]; then\n printf '%s' "$2" > ${quote(ready)}\n exec /bin/sleep 30\nfi\nexec ${quote(realGit)} "$@"\n`,
  { mode: 0o700 },
);
const child = spawn(path.resolve(values.binary), [], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
});
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let sequence = 0,
  comparisons = 0;
const types = new Set();
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function write(cwd, name, text) {
  await writeFile(path.join(cwd, name), text);
}
function commit(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}
async function reset(ref = "main") {
  for (const cwd of trees) {
    await rm(cwd, { recursive: true, force: true });
    await cp(template, cwd, { recursive: true });
    git(cwd, "reset", "--hard", ref);
  }
}
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
async function native(command, extra = {}) {
  child.stdin.write(
    JSON.stringify({ op: "git", command, ...extra, requestId: ++sequence }) +
      "\n",
  );
  const line = await lines.next();
  assert.equal(line.done, false);
  const { id, result } = JSON.parse(line.value);
  assert.equal(id, sequence);
  const { code, ...value } = result;
  return value;
}
async function observe(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
async function query(type, input, success = true) {
  const command = p.workerCommandSchema.parse({
    type,
    cwd: trees[0],
    ...input,
  });
  const expected = await observe(() => handleGitCommand(command));
  assert.equal(expected.ok, success, JSON.stringify(expected));
  const actual = await native({ ...command, cwd: trees[1] });
  assert.deepEqual(
    normalize(actual),
    normalize(expected),
    `${type}: ${JSON.stringify(input)}`,
  );
  assert.deepEqual(
    await readGitStatus(trees[1]),
    await readGitStatus(trees[0]),
  );
  for (const args of [
    ["rev-parse", "HEAD"],
    ["ls-files", "--stage", "-z"],
    ["show-ref"],
  ])
    assert.equal(
      git(trees[1], ...args),
      git(trees[0], ...args),
      `actual Git ${args[0]}`,
    );
  for (const cwd of trees)
    assert.equal(
      git(cwd, "worktree", "list", "--porcelain").split("worktree ").length - 1,
      1,
      "preview worktree removed",
    );
  comparisons++;
  return actual.value;
}
async function preview(action, success = true) {
  types.add(action.type);
  return query("git.commit.action.preview", { action }, success);
}
async function apply(plan, success = true, token = plan.token) {
  return query(
    "git.commit.action.apply",
    { action: plan.action, token },
    success,
  );
}
const cherry = (...revisions) => ({
  type: "cherryPick",
  selection: { type: "commits", revisions },
});
const range = (fromRevision, toRevision) => ({
  type: "cherryPick",
  selection: { type: "range", fromRevision, toRevision },
});
try {
  git(template, "-c", "init.defaultBranch=main", "init", "--quiet");
  for (const [k, v] of Object.entries({
    "user.name": "Fixture",
    "user.email": "fixture@example.invalid",
    "commit.gpgsign": "false",
    "core.hooksPath": "/dev/null",
    "color.ui": "false",
  }))
    git(template, "config", k, v);
  await write(template, "shared.txt", "base\n");
  const base = commit(template, "Base");
  git(template, "checkout", "--quiet", "-b", "feature");
  await write(template, "feature.txt", "feature one 🧙\n");
  const first = commit(template, "Feature one");
  await write(template, "binary.bin", Buffer.from([0, 1, 2, 3]));
  const second = commit(template, "Feature two");
  git(template, "checkout", "--quiet", "main");
  await write(template, "main.txt", "main\n");
  const main = commit(template, "Main");
  git(template, "checkout", "--quiet", "-b", "conflict", base);
  await write(template, "shared.txt", "incoming\n");
  const conflict = commit(template, "Conflicting feature");
  git(template, "checkout", "--quiet", "main");
  for (const action of [
    cherry(first, second),
    cherry(first, first, second),
    range(first, second),
    range(first, first),
  ]) {
    await reset();
    const plan = await preview(action);
    assert.equal(plan.wouldConflict, false);
    await apply(plan, false, "0".repeat(64));
    const result = await apply(plan);
    assert.equal(result.operation.state, "completed");
  }
  await reset();
  await preview(range(first, main), false);
  await preview(cherry("0".repeat(40)), false);
  // A real merge commit exercises cherry-pick rejection and mainline revert.
  git(template, "merge", "--no-edit", "feature");
  const merge = git(template, "rev-parse", "HEAD");
  await reset();
  await preview(cherry(merge), false);
  await preview(
    { type: "revert", revision: merge, mainlineParent: null },
    false,
  );
  await preview({ type: "revert", revision: merge, mainlineParent: 3 }, false);
  await apply(
    await preview({ type: "revert", revision: merge, mainlineParent: 1 }),
  );
  await reset();
  await preview({ type: "revert", revision: first, mainlineParent: 1 }, false);
  await apply(
    await preview({ type: "revert", revision: second, mainlineParent: null }),
  );
  // Revert can itself stop at a conflict and remain resumable.
  await reset();
  for (const cwd of trees) {
    await write(cwd, "feature.txt", "changed after feature\n");
    commit(cwd, "Later edit");
  }
  let plan = await preview({
    type: "revert",
    revision: first,
    mainlineParent: null,
  });
  assert.equal(plan.wouldConflict, true);
  assert.equal((await apply(plan)).operation.state, "conflicted");
  await preview({ type: "amend", message: "blocked" }, false);
  // A cherry-pick stopped at its second item must report the real step.
  await reset(main);
  for (const cwd of trees) {
    await write(cwd, "shared.txt", "ours\n");
    commit(cwd, "Our conflict");
  }
  plan = await preview(cherry(first, conflict));
  assert.equal(plan.wouldConflict, true);
  const stopped = await apply(plan);
  assert.equal(stopped.operation.currentStep, 2);
  assert.equal(stopped.operation.state, "conflicted");
  await preview(cherry(second), false);
  // Dirty/staged state, exact patch-bound tokens and recovery references.
  await reset();
  await preview({ type: "amend", message: null }, false);
  await preview({ type: "fixup", revision: first }, false);
  for (const cwd of trees) await write(cwd, "shared.txt", "unstaged\n");
  await preview(cherry(conflict), false);
  await preview({ type: "amend", message: "blocked" }, false);
  await reset();
  plan = await preview({ type: "amend", message: "Reword 🧙\ud800\n\nBody" });
  const amended = await apply(plan);
  assert.equal(
    git(trees[1], "rev-parse", amended.checkpointRef),
    amended.headBefore,
  );
  assert.match(
    git(trees[1], "show", "-s", "--format=%B", "HEAD"),
    /Reword 🧙�/u,
  );
  await reset();
  for (const cwd of trees) {
    await write(cwd, "staged.txt", "staged\n");
    git(cwd, "add", "staged.txt");
  }
  plan = await preview({ type: "amend", message: null });
  await apply(plan);
  await reset();
  for (const cwd of trees) {
    await write(cwd, "fixup.txt", "fixup\n");
    git(cwd, "add", "fixup.txt");
  }
  plan = await preview({ type: "fixup", revision: first });
  await apply(plan);
  assert.equal(
    git(trees[1], "show", "-s", "--format=%s", "HEAD"),
    "fixup! Feature one",
  );
  await reset();
  for (const cwd of trees) {
    await write(cwd, "stage.txt", "old\n");
    git(cwd, "add", "stage.txt");
  }
  plan = await preview({ type: "amend", message: "old staged patch" });
  for (const cwd of trees) {
    await write(cwd, "stage.txt", "new\n");
    git(cwd, "add", "stage.txt");
  }
  await apply(plan, false);
  await reset();
  for (const cwd of trees) {
    await write(cwd, "large.txt", "🧙".repeat(1_000_001));
    git(cwd, "add", "large.txt");
  }
  const bounded = await preview({ type: "fixup", revision: first });
  assert.equal(bounded.patchTruncated, true);
  assert.equal(
    bounded.patch.length,
    2_000_000,
    "patch bound counts UTF-16 units",
  );
  // Preserve actual hook rejection and the pre-created amend checkpoint.
  await reset();
  const hooks = path.join(root, "hooks");
  await mkdir(hooks);
  await writeFile(
    path.join(hooks, "pre-commit"),
    "#!/bin/sh\nprintf 'owned hook refused\\n' >&2\nexit 1\n",
    { mode: 0o700 },
  );
  for (const cwd of trees) git(cwd, "config", "core.hooksPath", hooks);
  plan = await preview({ type: "amend", message: "Rejected" });
  await apply(plan, false);
  assert.equal(git(trees[1], "rev-parse", plan.checkpointRef), merge);
  await reset(main);
  const beforeCancel = git(trees[1], "worktree", "list", "--porcelain");
  await writeFile(cancel, "stop owned preview");
  const stoppedPreview = await native(
    p.workerCommandSchema.parse({
      type: "git.commit.action.preview",
      cwd: trees[1],
      action: cherry(first),
    }),
    { op: "git-preview-stop", ready },
  );
  assert.deepEqual(stoppedPreview, {
    ok: false,
    error: "Worker workspace operation stopped.",
  });
  const temporary = await readFile(ready, "utf8");
  await assert.rejects(readFile(path.join(temporary, ".git")), {
    code: "ENOENT",
  });
  assert.equal(git(trees[1], "worktree", "list", "--porcelain"), beforeCancel);
  console.log(
    JSON.stringify({
      comparisons,
      types: [...types],
      actualGit: true,
      exactTokens: true,
      resumableCherryPickAndRevert: true,
      recoveryCheckpoint: true,
      stoppedPreviewCleanup: true,
      platform: process.platform,
    }),
  );
} finally {
  child.stdin.end();
  try {
    assert.equal(await completion, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
}
