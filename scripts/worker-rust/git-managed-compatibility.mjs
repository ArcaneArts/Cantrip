// Native recovery versus the production Node algorithms over matching owned
// repositories, including old interactive-rebase data and durable stash state.
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
  stat,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
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
// The source's managed editor environment is captured at module initialization.
const source = await import("../../cantrip_worker/src/git.ts");
const { handleGitCommand } =
  await import("../../cantrip_worker/src/commands/git.ts");
const { managedOperationRecord, RepositoryManagedOperationStore } =
  await import("../../cantrip_worker/src/repository-managed-operation-store.ts");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-managed-"));
const template = path.join(root, "template"),
  nodeRoot = path.join(root, "node"),
  rustRoot = path.join(root, "rust");
await mkdir(template);
await mkdir(nodeRoot);
await mkdir(rustRoot);
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
const kinds = new Set();
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function commit(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}
async function write(cwd, name, text) {
  await writeFile(path.join(cwd, name), text);
}
async function init() {
  await rm(template, { recursive: true, force: true });
  await mkdir(template);
  git(template, "-c", "init.defaultBranch=main", "init", "--quiet");
  for (const [key, value] of Object.entries({
    "user.name": "Fixture",
    "user.email": "fixture@example.invalid",
    "commit.gpgsign": "false",
    "core.hooksPath": "/dev/null",
    "color.ui": "false",
  }))
    git(template, "config", key, value);
  await write(template, "file.txt", "base\n");
  return commit(template, "Base");
}
async function reset() {
  for (const tree of trees) {
    await rm(tree, { recursive: true, force: true });
    await cp(template, tree, { recursive: true });
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
async function native(input) {
  child.stdin.write(JSON.stringify({ ...input, requestId: ++sequence }) + "\n");
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
async function query(type, context, extra = {}, success = true) {
  kinds.add(context?.type ?? "stash-list");
  const command = p.workerCommandSchema.parse({
    type,
    cwd: trees[0],
    context,
    ...extra,
  });
  const expected = await observe(() => handleGitCommand(command));
  assert.equal(expected.ok, success, JSON.stringify(command));
  const actual = await native({
    op: "git",
    command: { ...command, cwd: trees[1] },
  });
  assert.deepEqual(
    normalize(actual),
    normalize(expected),
    JSON.stringify(command),
  );
  assert.deepEqual(
    await source.readGitStatus(trees[1]),
    await source.readGitStatus(trees[0]),
    "resulting index/HEAD/branch state",
  );
  comparisons++;
  return actual;
}
function context(kind, original, sourceRevision) {
  return p.gitManagedOperationContextSchema.parse({
    type: kind,
    originalHead: original,
    sourceRef: "feature",
    sourceRevision,
    targetRef: "refs/heads/main",
    targetRevision: original,
    pendingCommits: [sourceRevision],
    totalSteps: 1,
    checkpointRef: null,
  });
}
try {
  // Real merge/rebase/cherry-pick conflicts, then continue/skip/abort and errors.
  for (const kind of ["merge", "rebase", "cherry-pick"]) {
    const base = await init();
    git(template, "checkout", "--quiet", "-b", "feature");
    await write(template, "file.txt", "feature\n");
    const feature = commit(template, "Feature");
    git(template, "checkout", "--quiet", "main");
    await write(template, "file.txt", "main\n");
    const main = commit(template, "Main");
    assert.throws(() =>
      git(
        template,
        kind,
        ...(kind === "merge" ? ["--no-ff", "feature"] : ["feature"]),
      ),
    );
    const ctx = context(kind, main, kind === "rebase" ? main : feature);
    await reset();
    const state = await query("git.operation.inspect", ctx);
    assert.equal(state.value.state, "conflicted");
    await query("git.operation.control", ctx, { action: "continue" }, false);
    await query("git.operation.control", ctx, { action: "good" }, false);
    await query("git.operation.amend", ctx, { message: null }, false);
    await query(
      "git.operation.control",
      ctx,
      { action: "skip" },
      kind !== "merge",
    );
    await reset();
    await query("git.operation.control", ctx, { action: "abort" });
    assert.equal(git(trees[1], "rev-parse", "HEAD"), main);
    await reset();
    for (const cwd of trees) {
      await write(cwd, "file.txt", "resolved\n");
      git(cwd, "add", "file.txt");
    }
    await query("git.operation.control", ctx, { action: "continue" });
    await query("git.operation.inspect", ctx);
  }
  // Revert uses its own marker and can be aborted or completed after staging.
  await init();
  await write(template, "file.txt", "first\n");
  const reverted = commit(template, "First");
  await write(template, "file.txt", "second\n");
  const current = commit(template, "Second");
  assert.throws(() => git(template, "revert", "--no-edit", reverted));
  const revert = context("revert", current, reverted);
  await reset();
  await query("git.operation.inspect", revert);
  await query("git.operation.control", revert, { action: "abort" });
  await reset();
  for (const cwd of trees) {
    await write(cwd, "file.txt", "resolved\n");
    git(cwd, "add", "file.txt");
  }
  await query("git.operation.control", revert, { action: "continue" });
  // Bisect keeps its own progress and reset/abort terminal hints.
  const good = await init();
  const history = [];
  for (let i = 0; i < 4; i++) {
    await write(template, `step-${i}.txt`, `${i}\n`);
    history.push(commit(template, `Step ${i}`));
  }
  const bad = history.at(-1);
  git(template, "bisect", "start", bad, good);
  const bisect = {
    ...context("bisect", bad, good),
    pendingCommits: [...history].reverse(),
    totalSteps: history.length,
  };
  for (const action of ["continue", "good", "bad", "skip", "reset", "abort"]) {
    await reset();
    await query("git.operation.inspect", bisect);
    await query(
      "git.operation.control",
      bisect,
      { action },
      action !== "continue",
    );
  }
  // Source-generated dirty stash checkpoint restores staged and untracked data.
  await init();
  await write(template, "keep.txt", "base\n");
  commit(template, "Keep");
  await write(template, "file.txt", "stash\n");
  const stash = (
    await source.createGitStash(template, {
      message: "Owned stash",
      includeStaged: true,
      includeUnstaged: true,
      includeUntracked: false,
    })
  ).stash;
  await write(template, "file.txt", "branch\n");
  commit(template, "Diverge");
  await write(template, "keep.txt", "preexisting\n");
  git(template, "add", "keep.txt");
  await write(template, "untracked.txt", "preserve\n");
  const stashAction = { type: "apply", ref: stash.ref, hash: stash.hash };
  const preview = await source.previewGitStashAction(template, stashAction);
  const applied = await source.applyGitStashAction(
    template,
    stashAction,
    preview.token,
  );
  const stashContext = p.gitManagedOperationContextSchema.parse(
    applied.operation,
  );
  await reset();
  await query("git.stash.list");
  await query("git.operation.inspect", stashContext);
  await query("git.operation.control", stashContext, { action: "skip" }, false);
  await query("git.operation.control", stashContext, { action: "abort" });
  assert.equal(
    await readFile(path.join(trees[1], "keep.txt"), "utf8"),
    "preexisting\n",
  );
  assert.equal(
    await readFile(path.join(trees[1], "untracked.txt"), "utf8"),
    "preserve\n",
  );
  await reset();
  for (const cwd of trees) {
    await write(cwd, "file.txt", "resolved\n");
    git(cwd, "add", "file.txt");
  }
  await query(
    "git.operation.control",
    { ...stashContext, sourceRef: "pop:stash@{0}" },
    { action: "continue" },
  );
  await query("git.stash.list");
  await reset();
  await query(
    "git.operation.control",
    { ...stashContext, checkpointRef: null },
    { action: "abort" },
    false,
  );
  // Node-created interactive edit followed by a queued reword uses native editors.
  const upstream = await init();
  const revisions = [];
  for (const name of ["A", "B"]) {
    await write(template, `${name}.txt`, `${name}\n`);
    revisions.push(commit(template, name));
  }
  const action = {
    type: "interactiveRebase",
    upstreamRef: upstream,
    todo: [
      { action: "edit", revision: revisions[0], message: null },
      { action: "reword", revision: revisions[1], message: "Reworded 🧙" },
    ],
  };
  const planned = await source.previewGitManagedOperation(template, action);
  const started = await source.startGitManagedOperation(
    template,
    action,
    planned.token,
  );
  assert.equal(started.pausedAction, "edit");
  const interactive = p.gitManagedOperationContextSchema.parse(started);
  await reset();
  await query("git.operation.inspect", interactive);
  await query(
    "git.operation.control",
    {
      ...interactive,
      checkpointRef: "refs/cantrip/checkpoints/rewrite-\ud800",
    },
    { action: "abort" },
    false,
  );
  await query("git.operation.amend", interactive, { message: null }, false);
  await query("git.operation.amend", interactive, { message: "Edited 🧙" });
  assert.equal(git(trees[1], "log", "-1", "--format=%s"), "Reworded 🧙");
  await reset();
  await query("git.operation.control", interactive, { action: "continue" });
  await reset();
  await query("git.operation.control", interactive, { action: "abort" });
  // Fixed-time record construction and byte-identical publication in both directions.
  const operationState = await source.inspectGitManagedOperation(
    trees[0],
    interactive,
  );
  const scope = {
    ownerId: "owner",
    serverId: "https://fixture.invalid",
    workerId: "worker",
    projectId: "11111111-1111-4111-8111-111111111111",
    worktreeId: "22222222-2222-4222-8222-222222222222",
  };
  const command = {
    serverId: scope.serverId,
    projectId: scope.projectId,
    worktreeId: scope.worktreeId,
  };
  const now = "2026-11-17T00:00:00.000Z",
    id = "33333333-3333-4333-8333-333333333333";
  const expected = managedOperationRecord({
    state: operationState,
    scope,
    now,
    id,
  });
  const record = await native({
    op: "git-record",
    command,
    workerId: scope.workerId,
    state: operationState,
    now,
    id,
  });
  assert.deepEqual(record, { ok: true, value: expected });
  comparisons++;
  const directory = path.join(root, "profile"),
    store = new RepositoryManagedOperationStore(directory);
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        scope.serverId,
        scope.ownerId,
        scope.workerId,
        scope.projectId,
        scope.worktreeId,
      ]),
    )
    .digest("hex");
  const file = path.join(directory, "repository-operations", key + ".json");
  await store.put(scope, expected);
  const originalBytes = await readFile(file, "utf8");
  assert.deepEqual(
    await native({
      op: "git-put",
      directory,
      command,
      ownerId: scope.ownerId,
      workerId: scope.workerId,
      record: expected,
    }),
    { ok: true, value: null },
  );
  assert.equal(await readFile(file, "utf8"), originalBytes);
  assert.deepEqual(await store.get(scope), expected);
  comparisons++;
  if (process.platform !== "win32")
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  const later = "2026-11-17T00:01:00.000Z";
  const refreshed = managedOperationRecord({
    state: { ...operationState, state: "completed" },
    scope,
    now: later,
    existing: expected,
  });
  assert.deepEqual(
    await native({
      op: "git-record",
      command,
      workerId: scope.workerId,
      state: { ...operationState, state: "completed" },
      now: later,
      existing: expected,
    }),
    { ok: true, value: refreshed },
  );
  comparisons++;
  const invalid = await native({
    op: "git-put",
    directory,
    command,
    ownerId: scope.ownerId,
    workerId: "wrong-worker",
    record: expected,
  });
  assert.deepEqual(invalid, {
    ok: false,
    error: "Repository operation escaped its worker scope.",
  });
  assert.equal(await readFile(file, "utf8"), originalBytes);
  comparisons++;
  console.log(
    JSON.stringify({
      comparisons,
      kinds: [...kinds],
      realNodeGeneratedRecovery: true,
      nativeInteractiveEditors: true,
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
