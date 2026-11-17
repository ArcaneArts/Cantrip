// Real Node/native worktree inventory, mutations, containment and common-dir queues.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import * as p from "../../packages/protocol/dist/index.js";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const original = { ...process.env };
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  GIT_AUTHOR_DATE: "2026-11-17T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-11-17T00:00:00+00:00",
});
const { WorktreeManager } =
  await import("../../cantrip_worker/src/worktrees.ts");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-worktree-")),
);
const lanes = [path.join(root, "node"), path.join(root, "rust")];
const trees = lanes.map((root) => path.join(root, "checkout")),
  data = lanes.map((root) => path.join(root, "data"));
const child = spawn(path.resolve(values.binary), [], {
  stdio: ["pipe", "pipe", "inherit"],
});
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const manager = new WorktreeManager(data[0]),
  fingerprints = [];
let sequence = 0,
  comparisons = 0;
const commands = new Set();
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const hash = (text) => createHash("sha256").update(text).digest("hex");
async function both(visit) {
  for (let i = 0; i < 2; i++) await visit(i);
}
async function observe(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
async function native(input) {
  child.stdin.write(JSON.stringify({ ...input, requestId: ++sequence }) + "\n");
  const line = await lines.next();
  assert.equal(line.done, false);
  const { id, result } = JSON.parse(line.value);
  assert.equal(id, sequence);
  const { code, ...outcome } = result;
  return outcome;
}
function normalize(value) {
  if (typeof value === "string") {
    for (let i = 0; i < 2; i++) {
      if (fingerprints[i])
        value = value
          .replaceAll(fingerprints[i], "<fingerprint>")
          .replaceAll(fingerprints[i].slice(0, 20), "<repo>");
      value = value.replaceAll(lanes[i], "<lane>");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v)]),
    );
  return value;
}
function fingerprintsAreReal(value) {
  if (!value || typeof value !== "object") return;
  if (value.repositoryFingerprint)
    assert.equal(
      value.repositoryFingerprint,
      hash(value.gitCommonDir),
      "actual SHA-256 of canonical Git common directory",
    );
  for (const item of Object.values(value)) fingerprintsAreReal(item);
}
function compare(actual, expected, label) {
  fingerprintsAreReal(actual);
  fingerprintsAreReal(expected);
  assert.deepEqual(normalize(actual), normalize(expected), label);
  comparisons++;
}
function command(type, input = {}, i = 0) {
  const replace = (value) => {
    if (typeof value === "string")
      return value
        .replaceAll(lanes[0], lanes[i])
        .replaceAll(
          fingerprints[0] ?? "<unused>",
          fingerprints[i] ?? "<unused>",
        )
        .replaceAll(
          fingerprints[0]?.slice(0, 20) ?? "<unused>",
          fingerprints[i]?.slice(0, 20) ?? "<unused>",
        );
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, replace(v)]),
      );
    return value;
  };
  return p.workerCommandSchema.parse({
    type,
    sourcePath: trees[i],
    ...replace(input),
  });
}
function run(c, hook) {
  switch (c.type) {
    case "worktree.list":
      return manager.list(c.sourcePath);
    case "worktree.reconcile":
      return manager.reconcile(c.sourcePath);
    case "worktree.status":
      return manager.status(c.sourcePath, c.worktreePath);
    case "worktree.create":
      return manager.create(c.sourcePath, c.worktreeId, c.name, c.mode);
    case "worktree.lock":
      return manager.lock(c.sourcePath, c.worktreePath, c.reason);
    case "worktree.unlock":
      return manager.unlock(c.sourcePath, c.worktreePath);
    case "worktree.prune":
      return manager.prune(c.sourcePath, c.allowExternal);
    case "worktree.remove":
      return manager.remove(c.sourcePath, c.worktreePath, {
        allowExternal: c.allowExternal,
        force: c.force,
        beforeRemove: hook,
      });
    default:
      throw new Error("Unknown fixture command");
  }
}
async function query(type, input = {}, success = true, hook) {
  commands.add(type);
  const expected = await observe(() =>
    run(
      command(type, input),
      hook
        ? async (target) => {
            await writeFile(path.join(lanes[0], "hook"), target);
            if (hook.fail) throw new Error("Owned removal hook failed.");
          }
        : undefined,
    ),
  );
  assert.equal(expected.ok, success, JSON.stringify(expected));
  const actual = await native({
    op: hook ? "worktree-remove-hook" : "worktree",
    command: command(type, input, 1),
    ...(hook ? { marker: path.join(lanes[1], "hook"), fail: hook.fail } : {}),
  });
  compare(actual, expected, type + JSON.stringify(input));
  if (hook) {
    const left = await observe(() =>
      readFile(path.join(lanes[0], "hook"), "utf8"),
    );
    const right = await observe(() =>
      readFile(path.join(lanes[1], "hook"), "utf8"),
    );
    compare(right, left, "owned removal hook admission");
  }
  return expected.value;
}
const create = (id, name, mode, success = true) =>
  query("worktree.create", { worktreeId: id, name, mode }, success);
const newBranch = (branch) => ({ type: "newBranch", branch, startPoint: null });
const remove = (worktreePath, extra = {}, success = true, hook) =>
  query("worktree.remove", { worktreePath, ...extra }, success, hook);
async function authorize(paths, success = true) {
  const expected = await observe(() =>
    manager.authorizeTargets(trees[0], paths),
  );
  assert.equal(expected.ok, success, JSON.stringify(expected));
  const actual = await native({
    op: "worktree-authorize",
    sourcePath: trees[1],
    paths: paths.map(
      (path) =>
        command("worktree.status", { worktreePath: path }, 1).worktreePath,
    ),
  });
  compare(actual, expected, "authorize physical worktrees");
}
try {
  await both(async (i) => {
    await mkdir(trees[i], { recursive: true });
    await mkdir(data[i]);
    git(trees[i], "init", "--quiet", "-b", "main");
    for (const [key, value] of Object.entries({
      "user.name": "Fixture",
      "user.email": "fixture@example.invalid",
      "commit.gpgsign": "false",
      "core.hooksPath": "/dev/null",
      "color.ui": "false",
    }))
      git(trees[i], "config", key, value);
    fingerprints[i] = hash(await realpath(path.join(trees[i], ".git")));
  });
  assert.equal(
    (await native({ op: "worktree-open", directory: data[1] })).ok,
    true,
  );
  await query("worktree.list");
  await query("worktree.status", { worktreePath: trees[0] });
  await both(async (i) => {
    await writeFile(path.join(trees[i], "base.txt"), "base\n");
    git(trees[i], "add", ".");
    git(trees[i], "commit", "--quiet", "-m", "Base");
    git(trees[i], "branch", "existing");
  });
  await query("worktree.reconcile");
  await authorize([trees[0], trees[0]]);
  const primary = trees[0];
  await query("worktree.lock", { worktreePath: primary }, false);
  await query("worktree.unlock", { worktreePath: primary }, false);
  await remove(primary, { allowExternal: true, force: true }, false);
  let created = await create(
    "one",
    " Ｆéature 🧙 Straße ",
    newBranch("agent/one"),
  );
  const first = created.worktree.path;
  assert.ok(path.basename(first).startsWith("fe-ature-stra-e-"));
  await create("one", " Ｆéature 🧙 Straße ", newBranch("agent/one"));
  await create(
    "one",
    " Ｆéature 🧙 Straße ",
    newBranch("agent/different"),
    false,
  );
  const existing = (
    await create("two", "Existing", {
      type: "existingBranch",
      branch: "existing",
    })
  ).worktree.path;
  const detached = (
    await create("three", "🧙", { type: "detached", revision: "HEAD" })
  ).worktree.path;
  assert.ok(path.basename(detached).startsWith("worktree-"));
  await query("worktree.list", { sourcePath: first });
  await authorize([first, existing, detached]);
  await query("worktree.lock", {
    worktreePath: first,
    reason: "Review 🧙\nwith spaces",
  });
  await query("worktree.lock", {
    worktreePath: first,
    reason: "Keep original reason",
  });
  await remove(first, { force: true }, false, { fail: false });
  await query("worktree.unlock", { worktreePath: first });
  await query("worktree.unlock", { worktreePath: first }, false);
  await both((i) =>
    writeFile(
      command("worktree.status", { worktreePath: first }, i).worktreePath +
        "/dirty.txt",
      "dirty\n",
    ),
  );
  await query("worktree.status", { worktreePath: first });
  await remove(first, {}, false, { fail: false });
  await remove(first, { force: true }, false, { fail: true });
  await query("worktree.status", { worktreePath: first });
  await remove(first, { force: true }, true, { fail: false });
  await remove(existing);
  await remove(detached);
  // Colliding requests share a common-dir queue; which identical request wins is unspecified.
  const plans = [
    command("worktree.create", {
      worktreeId: "parallel",
      name: "Parallel",
      mode: newBranch("agent/parallel"),
    }),
    command("worktree.create", {
      worktreeId: "parallel",
      name: "Parallel",
      mode: newBranch("agent/parallel"),
    }),
  ];
  const expected = await Promise.all(
    plans.map((plan) => observe(() => run(plan))),
  );
  const actual = (
    await native({
      op: "worktree-batch",
      commands: plans.map((plan) => command(plan.type, plan, 1)),
    })
  ).value;
  const order = (items) =>
    [...items].sort(
      (a, b) => Number(b.value?.created) - Number(a.value?.created),
    );
  compare(order(actual), order(expected), "serialized colliding creates");
  assert.equal(expected.filter((result) => result.value?.created).length, 1);
  await query("worktree.list");
  await create(
    "occupied-branch",
    "Occupied",
    { type: "existingBranch", branch: "agent/parallel" },
    false,
  );
  await create(
    "missing-branch",
    "Missing",
    { type: "existingBranch", branch: "not-present" },
    false,
  );
  await create(
    "bad-ref",
    "Bad",
    { type: "newBranch", branch: "bad branch", startPoint: null },
    false,
  );
  await create(
    "bad-revision",
    "Bad",
    { type: "detached", revision: "not-present" },
    false,
  );
  await create(
    "unpaired-\ud800",
    "Long " + "a".repeat(70),
    newBranch("agent/unpaired"),
  );
  // A pre-existing destination is never adopted or removed.
  await both(async (i) => {
    const target = path.join(
      data[i],
      "worktrees",
      fingerprints[i].slice(0, 20),
      "occupied-" + hash("occupied").slice(0, 12),
    );
    await writeFile(target, "private sentinel");
  });
  await create("occupied", "Occupied", newBranch("agent/occupied"), false);
  await both(async (i) => {
    const target = path.join(
      data[i],
      "worktrees",
      fingerprints[i].slice(0, 20),
      "occupied-" + hash("occupied").slice(0, 12),
    );
    assert.equal(await readFile(target, "utf8"), "private sentinel");
    await rm(target);
  });
  await query(
    "worktree.status",
    { worktreePath: path.join(lanes[0], "arbitrary") },
    false,
  );
  await authorize([path.join(lanes[0], "arbitrary")], false);
  // External worktrees require explicit removal/prune authority.
  await both((i) =>
    git(
      trees[i],
      "worktree",
      "add",
      "--quiet",
      "-b",
      "external",
      path.join(lanes[i], "external"),
    ),
  );
  const external = path.join(lanes[0], "external");
  await remove(external, {}, false);
  await query("worktree.lock", { worktreePath: external });
  await query("worktree.unlock", { worktreePath: external });
  await remove(external, { allowExternal: true });
  await both((i) =>
    git(
      trees[i],
      "worktree",
      "add",
      "--quiet",
      "--detach",
      path.join(data[i], "worktrees", "..external"),
    ),
  );
  const dotExternal = path.join(data[0], "worktrees", "..external");
  const dotInventory = await query("worktree.list");
  assert.equal(
    dotInventory.worktrees.find((worktree) => worktree.path === dotExternal)
      .managed,
    false,
  );
  await remove(dotExternal, {}, false);
  await remove(dotExternal, { allowExternal: true });
  await both((i) =>
    git(
      trees[i],
      "worktree",
      "add",
      "--quiet",
      "--detach",
      path.join(lanes[i], "missing"),
    ),
  );
  await both((i) =>
    rm(path.join(lanes[i], "missing"), { recursive: true, force: true }),
  );
  await query("worktree.list");
  await query(
    "worktree.status",
    { worktreePath: path.join(lanes[0], "missing") },
    false,
  );
  await query(
    "worktree.lock",
    { worktreePath: path.join(lanes[0], "missing") },
    false,
  );
  await authorize([path.join(lanes[0], "missing")], false);
  await query("worktree.prune", {}, false);
  await query("worktree.prune", { allowExternal: true });
  // Status checks actual common-dir identity even if a registered path is replaced.
  const changed = (
    await create("changed", "Changed", { type: "detached", revision: "HEAD" })
  ).worktree.path;
  const saved = [];
  await both(async (i) => {
    const target = command(
      "worktree.status",
      { worktreePath: changed },
      i,
    ).worktreePath;
    const other = path.join(lanes[i], "other");
    git(trees[i], "clone", "--quiet", trees[i], other);
    saved[i] = await readFile(path.join(target, ".git"));
    await writeFile(
      path.join(target, ".git"),
      "gitdir: " + path.join(other, ".git") + "\n",
    );
  });
  await query("worktree.status", { worktreePath: changed }, false);
  await both((i) =>
    writeFile(
      path.join(
        command("worktree.status", { worktreePath: changed }, i).worktreePath,
        ".git",
      ),
      saved[i],
    ),
  );
  await remove(changed);
  // Symlinked repository buckets cannot escape the canonical managed root.
  await both(async (i) => {
    const outside = path.join(lanes[i], "outside");
    await mkdir(outside);
    await symlink(outside, path.join(data[i], "worktrees", "escape"));
    // Existing managed lanes stay intact; use a second repo for an unused bucket.
    const alternate = path.join(lanes[i], "alternate");
    git(trees[i], "clone", "--quiet", trees[i], alternate);
    const alternateHash = hash(await realpath(path.join(alternate, ".git")));
    await symlink(
      outside,
      path.join(data[i], "worktrees", alternateHash.slice(0, 20)),
    );
  });
  await query(
    "worktree.create",
    {
      sourcePath: path.join(lanes[0], "alternate"),
      worktreeId: "escape",
      name: "Escape",
      mode: newBranch("agent/escape"),
    },
    false,
  );
  await query("worktree.list");
  console.log(
    JSON.stringify({
      comparisons,
      commands: [...commands],
      actualGit: true,
      managedIdentityAndUnicode: true,
      serializedCreates: true,
      removalHookAdmission: true,
      externalAndPruneAuthority: true,
      commonDirectoryIdentity: true,
      platform: process.platform,
    }),
  );
} finally {
  manager.close();
  child.stdin.end();
  try {
    assert.equal(await completion, 0);
  } finally {
    process.env = original;
    await rm(root, { recursive: true, force: true });
  }
}
