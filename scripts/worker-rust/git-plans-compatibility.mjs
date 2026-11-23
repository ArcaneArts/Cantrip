// Actual Git rehearsals, review tokens and mutations in matching owned repos.
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
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-plans-"));
const template = path.join(root, "template"),
  nodeRoot = path.join(root, "node"),
  rustRoot = path.join(root, "rust");
for (const directory of [template, nodeRoot, rustRoot]) await mkdir(directory);
const trees = [
  path.join(nodeRoot, "checkout"),
  path.join(rustRoot, "checkout"),
];
const realGit = execFileSync("/usr/bin/which", ["git"], {
  encoding: "utf8",
}).trim();
const bin = path.join(root, "bin"),
  cancel = path.join(root, "cancel"),
  ready = path.join(root, "ready");
await mkdir(bin);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
await writeFile(
  path.join(bin, "git"),
  `#!/bin/sh\nif [ -f ${quote(cancel)} ] && [ "$3" = -c ] && [ "$7" = merge ]; then\n printf '%s' "$2" > ${quote(ready)}\n exec /bin/sleep 30\nfi\nexec ${quote(realGit)} "$@"\n`,
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
  await write(template, "base.txt", "base\n");
  return commit(template, "Base");
}
async function reset() {
  for (const cwd of trees) {
    await rm(cwd, { recursive: true, force: true });
    await cp(template, cwd, { recursive: true });
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
async function native(command, op = "git", extra = {}) {
  child.stdin.write(
    JSON.stringify({ op, command, ...extra, requestId: ++sequence }) + "\n",
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
  assert.equal(expected.ok, success, JSON.stringify(command));
  const actual = await native({ ...command, cwd: trees[1] });
  assert.deepEqual(
    normalize(actual),
    normalize(expected),
    JSON.stringify(command),
  );
  assert.deepEqual(
    await readGitStatus(trees[1]),
    await readGitStatus(trees[0]),
    "resulting checkout/index/branch state",
  );
  comparisons++;
  return actual;
}
async function preview(action, success = true) {
  kinds.add(action.type);
  const before = trees.map((cwd) => ({
    head: git(cwd, "rev-parse", "HEAD"),
    worktrees: git(cwd, "worktree", "list", "--porcelain"),
    status: git(cwd, "status", "--porcelain=v1"),
  }));
  const result = await query("git.operation.preview", { action }, success);
  for (const [i, cwd] of trees.entries())
    assert.deepEqual(
      {
        head: git(cwd, "rev-parse", "HEAD"),
        worktrees: git(cwd, "worktree", "list", "--porcelain"),
        status: git(cwd, "status", "--porcelain=v1"),
      },
      before[i],
      "preview preserves checkout and removes its worktree registration",
    );
  return result.value;
}
async function start(plan, success = true, token = plan.token) {
  const result = await query(
    "git.operation.start",
    { action: plan.action, token },
    success,
  );
  assert.equal(
    git(trees[1], "show-ref"),
    git(trees[0], "show-ref"),
    "actual branch and recovery refs",
  );
  return result.value;
}
async function branch(conflict = false) {
  const base = await init();
  git(template, "checkout", "--quiet", "-b", "feature");
  await write(template, conflict ? "base.txt" : "feature.txt", "feature\n");
  const feature = commit(template, "Feature");
  git(template, "checkout", "--quiet", "main");
  await write(template, conflict ? "base.txt" : "main.txt", "main\n");
  const main = commit(template, "Main");
  return { base, feature, main };
}
try {
  for (const kind of ["merge", "rebase"]) {
    for (const conflict of [false, true]) {
      await branch(conflict);
      await reset();
      const plan = await preview({ type: kind, sourceRef: "feature" });
      assert.equal(plan.wouldConflict, conflict);
      await start(plan, false, "0".repeat(64));
      const state = await start(plan);
      assert.equal(state.state, conflict ? "conflicted" : "completed");
      if (conflict) {
        await preview({ type: "merge", sourceRef: "feature" }, false);
        await query("git.operation.control", {
          context: plan.context,
          action: "abort",
        });
      }
    }
  }
  // Fast-forward/no-op histories and stale ref/HEAD/workspace review inputs.
  await init();
  git(template, "checkout", "--quiet", "-b", "feature");
  await write(template, "feature.txt", "feature\n");
  commit(template, "Feature");
  git(template, "checkout", "--quiet", "main");
  await reset();
  const ff = await preview({ type: "merge", sourceRef: "feature" });
  await start(ff);
  await reset();
  const stale = await preview({ type: "merge", sourceRef: "feature" });
  for (const cwd of trees) {
    git(cwd, "checkout", "--quiet", "feature");
    await write(cwd, "later.txt", "later\n");
    commit(cwd, "Later");
    git(cwd, "checkout", "--quiet", "main");
  }
  await start(stale, false);
  await reset();
  const dirty = await preview({ type: "merge", sourceRef: "feature" });
  for (const cwd of trees) await write(cwd, "dirty.txt", "dirty\n");
  await start(dirty, false);
  await reset();
  await preview({ type: "merge", sourceRef: "HEAD" }, false);
  await preview({ type: "merge", sourceRef: "missing-\ud800" }, false);
  for (const cwd of trees) git(cwd, "branch", "feature�", "feature");
  await preview({ type: "merge", sourceRef: "feature\ud800" });
  for (const cwd of trees) git(cwd, "checkout", "--quiet", "--detach", "HEAD");
  await preview({ type: "merge", sourceRef: "feature" }, false);
  // Every supported interactive todo action, ordering, metadata and warnings.
  const upstream = await init(),
    revisions = [];
  for (const name of ["A", "B", "C", "D", "E"]) {
    await write(template, `${name}.txt`, `${name}\n`);
    revisions.push(commit(template, name));
  }
  const head = revisions.at(-1);
  for (const name of ["origin/Ä", "origin/a", "origin/Z"])
    git(template, "update-ref", `refs/remotes/${name}`, head);
  git(template, "update-ref", "refs/remotes/origin/base", upstream);
  git(
    template,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/Z",
  );
  await reset();
  const automatic = await preview({
    type: "interactiveRebase",
    upstreamRef: upstream,
    todo: [],
  });
  assert.equal(automatic.todo.length, 5);
  assert.equal(automatic.publishedRefs.length, 3);
  const todo = [
    { action: "pick", revision: revisions[1], message: null },
    { action: "squash", revision: revisions[2], message: null },
    { action: "fixup", revision: revisions[3], message: null },
    { action: "drop", revision: revisions[4], message: null },
    { action: "reword", revision: revisions[0], message: "Reworded 🧙" },
  ];
  const rewrite = await preview({
    type: "interactiveRebase",
    upstreamRef: upstream,
    todo,
  });
  await start(rewrite);
  assert.equal(git(trees[1], "log", "-1", "--format=%s"), "Reworded 🧙");
  const actions = [
    todo.slice(1),
    [todo[0], todo[0], ...todo.slice(2)],
    todo.map((item) => ({ ...item, action: "drop", message: null })),
    [{ ...todo[0], action: "squash" }, ...todo.slice(1)],
    [
      { ...todo[0], action: "drop" },
      { ...todo[1], action: "fixup" },
      ...todo.slice(2),
    ],
  ];
  for (const invalid of actions) {
    await reset();
    await preview(
      { type: "interactiveRebase", upstreamRef: upstream, todo: invalid },
      false,
    );
  }
  await reset();
  const editTodo = revisions.map((revision, i) => ({
    action: i === 0 ? "edit" : i === 1 ? "reword" : "pick",
    revision,
    message: i === 1 ? "Queued reword 🧙" : null,
  }));
  const edit = await preview({
    type: "interactiveRebase",
    upstreamRef: upstream,
    todo: editTodo,
  });
  const paused = await start(edit);
  assert.equal(paused.pausedAction, "edit");
  const key = edit.context.checkpointRef.split("/").at(-1);
  for (const file of ["todo", "reword-messages.json"])
    assert.equal(
      await readFile(
        path.join(trees[1], ".git", "cantrip", "rebases", key, file),
        "utf8",
      ),
      await readFile(
        path.join(trees[0], ".git", "cantrip", "rebases", key, file),
        "utf8",
      ),
    );
  await assert.rejects(
    readFile(
      path.join(
        trees[1],
        ".git",
        "cantrip",
        "rebases",
        key,
        "message-editor.cjs",
      ),
    ),
    { code: "ENOENT" },
  );
  await query("git.operation.amend", {
    context: edit.context,
    message: "Edited 🧙",
  });
  // Bisect bounds, candidates, durable checkpoint and controls.
  const good = await init(),
    candidates = [];
  for (let i = 0; i < 4; i++) {
    await write(template, `step-${i}.txt`, `${i}\n`);
    candidates.push(commit(template, `Step ${i}`));
  }
  await reset();
  const bisect = await preview({
    type: "bisect",
    goodRef: good,
    badRef: candidates.at(-1),
  });
  const started = await start(bisect);
  assert.ok(started.pendingCommits.length > 0);
  await preview({ type: "merge", sourceRef: good }, false);
  await query("git.operation.control", {
    context: bisect.context,
    action: "reset",
  });
  await reset();
  await preview({ type: "bisect", goodRef: good, badRef: good }, false);
  await preview(
    { type: "bisect", goodRef: candidates.at(-1), badRef: good },
    false,
  );
  // A real hook failure still occurs at start; preview disables hooks locally.
  await branch();
  git(template, "config", "core.hooksPath", ".git/hooks");
  await write(
    template,
    ".git/hooks/pre-merge-commit",
    "#!/bin/sh\necho owned-hook-rejection >&2\nexit 1\n",
  );
  const { chmod } = await import("node:fs/promises");
  await chmod(path.join(template, ".git/hooks/pre-merge-commit"), 0o700);
  await reset();
  const hooked = await preview({ type: "merge", sourceRef: "feature" });
  const pending = await start(hooked);
  assert.equal(pending.state, "awaiting-user-action");
  await query("git.operation.control", {
    context: hooked.context,
    action: "abort",
  });
  await branch();
  await reset();
  const beforeCancel = git(trees[1], "worktree", "list", "--porcelain");
  await writeFile(cancel, "cancel owned preview");
  const stopped = await native(
    p.workerCommandSchema.parse({
      type: "git.operation.preview",
      cwd: trees[1],
      action: { type: "merge", sourceRef: "feature" },
    }),
    "git-preview-stop",
    { ready },
  );
  assert.deepEqual(stopped, {
    ok: false,
    error: "Worker workspace operation stopped.",
  });
  const temporary = await readFile(ready, "utf8");
  await assert.rejects(readFile(path.join(temporary, ".git")), {
    code: "ENOENT",
  });
  assert.equal(
    git(trees[1], "worktree", "list", "--porcelain"),
    beforeCancel,
    "stopped preview removes its owned registration",
  );
  console.log(
    JSON.stringify({
      comparisons,
      actions: [...kinds],
      actualGit: true,
      exactReviewTokens: true,
      nativeRebaseEditors: true,
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
