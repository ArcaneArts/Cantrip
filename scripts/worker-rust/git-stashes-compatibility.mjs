// Native stash selection, object diffs, review tokens and actual Git recovery.
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
  await import("../../cantrip_worker/src/commands/git.ts");
const { readGitStatus } = await import("../../cantrip_worker/src/git.ts");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-stashes-"));
const template = path.join(root, "template"),
  nodeRoot = path.join(root, "node"),
  rustRoot = path.join(root, "rust");
for (const dir of [template, nodeRoot, rustRoot]) await mkdir(dir);
const trees = [
  path.join(nodeRoot, "checkout"),
  path.join(rustRoot, "checkout"),
];
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
const actions = new Set(),
  scopes = new Set();
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
const write = (cwd, name, text) => writeFile(path.join(cwd, name), text);
function commit(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}
async function reset() {
  for (const cwd of trees) {
    await rm(cwd, { recursive: true, force: true });
    await cp(template, cwd, { recursive: true });
  }
}
async function dirty() {
  for (const cwd of trees) {
    await write(cwd, "staged.txt", "staged\n");
    git(cwd, "add", "staged.txt");
    await write(cwd, "unstaged.txt", "unstaged\n");
    await write(cwd, "binary.bin", Buffer.from([0, 3, 4]));
    await write(cwd, "line\n🧙.txt", "untracked\n");
  }
}
function normalize(v) {
  if (typeof v === "string")
    return v.replaceAll(nodeRoot, "<owned>").replaceAll(rustRoot, "<owned>");
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, v]) => [k, normalize(v)]),
    );
  return v;
}
async function native(command) {
  child.stdin.write(
    JSON.stringify({ op: "git", command, requestId: ++sequence }) + "\n",
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
async function query(type, input = {}, success = true) {
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
    type + JSON.stringify(input),
  );
  assert.deepEqual(
    await readGitStatus(trees[1]),
    await readGitStatus(trees[0]),
  );
  for (const args of [
    ["rev-parse", "HEAD"],
    ["ls-files", "--stage", "-z"],
    ["show-ref"],
    ["diff", "--binary", "HEAD"],
  ])
    assert.equal(
      git(trees[1], ...args),
      git(trees[0], ...args),
      `actual Git ${args[0]}`,
    );
  comparisons++;
  return actual.value;
}
async function create(
  includeStaged = true,
  includeUnstaged = true,
  includeUntracked = true,
  success = true,
) {
  const request = {
    message: "Scoped native 🧙",
    includeStaged,
    includeUnstaged,
    includeUntracked,
  };
  scopes.add([includeStaged, includeUnstaged, includeUntracked].join(","));
  return query("git.stash.create", { request }, success);
}
async function preview(stash, type, extra = {}, success = true) {
  actions.add(type);
  return query(
    "git.stash.action.preview",
    {
      action:
        type === "clear"
          ? { type }
          : { type, ref: stash.ref, hash: stash.hash, ...extra },
    },
    success,
  );
}
async function apply(plan, success = true, token = plan.token) {
  return query(
    "git.stash.action.apply",
    { action: plan.action, token },
    success,
  );
}
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
  for (const name of ["staged.txt", "unstaged.txt"])
    await write(template, name, "base\n");
  await write(template, "binary.bin", Buffer.from([0, 1, 2]));
  commit(template, "Base");
  for (const selection of [
    [true, true, false],
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, true, true],
    [false, false, true],
  ]) {
    await reset();
    await dirty();
    const created = await create(...selection);
    assert.equal(created.operation, null);
    await query("git.stash.list");
    for (const file of created.stash.files)
      await query("git.stash.diff", {
        hash: created.stash.hash,
        path: file.path,
        contextLines: 0,
      });
  }
  await reset();
  await create(false, true, false, false);
  await create(true, true, false, false);
  await preview(null, "clear", {}, false);
  await reset();
  await dirty();
  let stash = (await create()).stash;
  await query(
    "git.stash.diff",
    { hash: stash.hash, path: "missing.txt" },
    false,
  );
  for (const type of ["apply", "pop", "drop", "clear", "branch"]) {
    await reset();
    await dirty();
    stash = (await create()).stash;
    const plan = await preview(
      stash,
      type,
      type === "branch" ? { branch: "from-stash" } : {},
    );
    await apply(plan, false, "0".repeat(64));
    await apply(plan);
    const list = await query("git.stash.list");
    assert.equal(list.stashes.length, type === "apply" ? 1 : 0);
  }
  // Stale working changes and a moved reflog position both invalidate reviews.
  await reset();
  await dirty();
  stash = (await create()).stash;
  await apply(await preview(stash, "branch", { branch: "native-🧙\ud800" }));
  await reset();
  await dirty();
  stash = (await create()).stash;
  let plan = await preview(stash, "pop");
  for (const cwd of trees)
    await write(cwd, "unstaged.txt", "changed after preview\n");
  await apply(plan, false);
  await reset();
  await dirty();
  stash = (await create()).stash;
  plan = await preview(stash, "clear");
  for (const cwd of trees) await write(cwd, "unstaged.txt", "new stash\n");
  await create();
  await apply(plan, false);
  await preview(stash, "pop", {}, false);
  // Independent unstaged shelving rejects overlapping staged content.
  await reset();
  for (const cwd of trees) {
    await write(cwd, "unstaged.txt", "staged overlap\n");
    git(cwd, "add", "unstaged.txt");
    await write(cwd, "unstaged.txt", "unstaged overlap\n");
  }
  await create(false, true, false, false);
  // Conflicted apply/pop checkpoints preserve dirty staged and untracked work.
  for (const type of ["apply", "pop"]) {
    await reset();
    await dirty();
    stash = (await create()).stash;
    for (const cwd of trees) {
      await write(cwd, "unstaged.txt", "upstream\n");
      commit(cwd, "Upstream");
      await write(cwd, "local.txt", "local staged\n");
      git(cwd, "add", "local.txt");
      await write(cwd, "private.txt", "private untracked\n");
    }
    plan = await preview(stash, type);
    assert.equal(plan.warnings.length, 1);
    const result = await apply(plan);
    assert.equal(result.operation.state, "conflicted");
    if (type === "apply") {
      await query("git.operation.control", {
        context: result.operation,
        action: "abort",
      });
      for (const cwd of trees) {
        assert.equal(
          await readFile(path.join(cwd, "private.txt"), "utf8"),
          "private untracked\n",
        );
        assert.equal(git(cwd, "show", ":local.txt"), "local staged");
      }
    } else {
      for (const file of result.conflictedPaths) {
        const request = {
          path: file,
          strategy: "manual",
          content: "resolved stash\n",
        };
        const resolution = await query("git.conflicts.preview", { request });
        await query("git.conflicts.apply", {
          request,
          token: resolution.token,
        });
      }
      const completed = await query("git.operation.control", {
        context: result.operation,
        action: "continue",
      });
      assert.equal(completed.state, "completed");
      assert.equal((await query("git.stash.list")).stashes.length, 0);
    }
  }
  // Failure with no conflicts restores the dirty checkpoint before reporting Git.
  await reset();
  await dirty();
  stash = (await create()).stash;
  for (const cwd of trees)
    await write(cwd, "unstaged.txt", "blocked local edit\n");
  await apply(await preview(stash, "apply"), false);
  console.log(
    JSON.stringify({
      comparisons,
      actions: [...actions],
      scopes: [...scopes],
      actualGit: true,
      exactTokens: true,
      dirtyCheckpointRecovery: true,
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
