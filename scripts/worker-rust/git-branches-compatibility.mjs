// Branch inventories, reviewed actions and real pushes/fetches to owned bare remotes.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, cp, rm, symlink } from "node:fs/promises";
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
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-branches-")),
  template = path.join(root, "template"),
  nodeRoot = path.join(root, "node"),
  rustRoot = path.join(root, "rust");
for (const dir of [template, nodeRoot, rustRoot]) await mkdir(dir);
const roots = [nodeRoot, rustRoot],
  trees = roots.map((r) => path.join(r, "checkout")),
  remotes = roots.map((r) => path.join(r, "origin.git"));
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
const actions = new Set();
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}
const write = (cwd, name, text) => writeFile(path.join(cwd, name), text);
function commit(cwd, message) {
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}
async function reset() {
  for (let i = 0; i < trees.length; i++) {
    for (const name of ["checkout", "origin.git", "side", "alias"])
      await rm(path.join(roots[i], name), { recursive: true, force: true });
    await cp(template, trees[i], { recursive: true });
    git(trees[i], "clone", "--quiet", "--bare", template, remotes[i]);
    git(trees[i], "remote", "add", "origin", remotes[i]);
    git(trees[i], "fetch", "--quiet", "origin");
  }
}
function normalize(v, key) {
  if (key === "generatedAt") {
    assert.ok(Number.isFinite(Date.parse(v)));
    assert.ok(Math.abs(Date.now() - Date.parse(v)) < 60_000);
    return "<timestamp>";
  }
  if (typeof v === "string")
    return v.replaceAll(nodeRoot, "<owned>").replaceAll(rustRoot, "<owned>");
  if (Array.isArray(v)) return v.map((item) => normalize(item));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, v]) => [k, normalize(v, k)]),
    );
  return v;
}
async function observe(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
async function native(command) {
  child.stdin.write(
    JSON.stringify({ op: "git", command, requestId: ++sequence }) + "\n",
  );
  const line = await lines.next();
  assert.equal(line.done, false);
  const { id, result } = JSON.parse(line.value);
  assert.equal(id, sequence);
  const { code, ...v } = result;
  return v;
}
async function query(type, input = {}, success = true, aliases = false) {
  const command = p.workerCommandSchema.parse({
    type,
    cwd: aliases ? path.join(nodeRoot, "alias") : trees[0],
    ...input,
  });
  const expected = await observe(() => handleGitCommand(command));
  assert.equal(expected.ok, success, JSON.stringify(expected));
  const actual = await native({
    ...command,
    cwd: aliases ? path.join(rustRoot, "alias") : trees[1],
  });
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
    ["rev-parse", "--verify", "HEAD"],
    ["show-ref"],
    ["config", "--local", "--list"],
    ["diff", "--binary", "HEAD"],
  ])
    assert.deepEqual(
      normalize(await observe(() => git(trees[1], ...args))),
      normalize(await observe(() => git(trees[0], ...args))),
      `actual Git ${args[0]}`,
    );
  assert.equal(
    git(remotes[1], "show-ref"),
    git(remotes[0], "show-ref"),
    "actual bare remote refs",
  );
  comparisons++;
  return actual.value;
}
async function preview(action, success = true) {
  actions.add(action.type);
  return query("git.branch.action.preview", { action }, success);
}
async function apply(plan, success = true, token = plan.token) {
  return query(
    "git.branch.action.apply",
    { action: plan.action, token },
    success,
  );
}
const create = (name, checkout = false, startPoint = null) => ({
  type: "create",
  name,
  startPoint,
  checkout,
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
  await write(template, "shared.txt", "feature\n");
  const feature = commit(template, "Feature 🧙");
  git(template, "checkout", "--quiet", "main");
  await reset();
  const inventory = await query("git.branch.list");
  assert.equal(inventory.branches[0].name, "main");
  assert.equal(inventory.branches[0].worktree.current, true);
  assert.equal(inventory.defaultRemote, "origin");
  for (const action of [
    create("topic"),
    create("topic", true, "feature"),
    create("native-🧙\ud800"),
    { type: "switch", name: "feature", kind: "local" },
    { type: "rename", name: "feature", newName: "renamed" },
    { type: "rename", name: "main", newName: "renamed-main" },
    { type: "deleteLocal", name: "feature", force: true },
    { type: "publish", name: "feature", remote: "origin" },
    { type: "deleteRemote", name: "feature", remote: "origin" },
    { type: "fetch", remote: null, prune: true },
    { type: "fetch", remote: "origin", prune: false },
    { type: "setUpstream", name: "main", upstream: "origin/main" },
  ]) {
    await reset();
    const plan = await preview(action);
    await apply(plan, false, "0".repeat(64));
    await apply(plan);
  }
  await reset();
  let plan = await preview({
    type: "deleteLocal",
    name: "feature",
    force: false,
  });
  assert.deepEqual(plan.warnings, []);
  await apply(plan, false);
  await reset();
  for (const cwd of trees) git(cwd, "branch", "merged", base);
  await apply(
    await preview({ type: "deleteLocal", name: "merged", force: false }),
  );
  await reset();
  for (const cwd of trees) git(cwd, "branch", "-D", "feature");
  await apply(
    await preview({ type: "switch", name: "origin/feature", kind: "remote" }),
  );
  await reset();
  await apply(
    await preview({
      type: "setUpstream",
      name: "main",
      upstream: "origin/main",
    }),
  );
  plan = await preview({ type: "rename", name: "main", newName: "renamed" });
  assert.equal(plan.warnings.length, 1);
  await apply(plan);
  await apply(
    await preview({ type: "setUpstream", name: "renamed", upstream: null }),
  );
  for (const action of [
    create("main"),
    create("bad name"),
    create("bad-point", false, "does-not-exist"),
    { type: "switch", name: "missing", kind: "local" },
    { type: "publish", name: "main", remote: "missing" },
    { type: "rename", name: "main", newName: "feature" },
    { type: "deleteLocal", name: "main", force: true },
    { type: "deleteRemote", name: "missing", remote: "origin" },
    { type: "setUpstream", name: "feature", upstream: null },
    { type: "setUpstream", name: "main", upstream: "origin/missing" },
    { type: "fetch", remote: "missing", prune: false },
  ]) {
    await reset();
    await preview(action, false);
  }
  // Publishing transfers a new commit/ref; a divergent remote is never forced.
  await reset();
  for (const cwd of trees) {
    git(cwd, "checkout", "--quiet", "-b", "new-publish");
    await write(cwd, "new-publish.txt", "new remote object\n");
    commit(cwd, "New publish commit");
  }
  await apply(
    await preview({ type: "publish", name: "new-publish", remote: "origin" }),
  );
  assert.equal(
    git(remotes[1], "rev-parse", "refs/heads/new-publish"),
    git(trees[1], "rev-parse", "HEAD"),
  );
  await reset();
  for (const cwd of trees) {
    git(cwd, "checkout", "--quiet", "feature");
    await write(cwd, "remote-ahead.txt", "remote advanced\n");
    commit(cwd, "Remote advanced");
    git(cwd, "push", "origin", "feature");
    git(cwd, "reset", "--hard", feature);
  }
  await apply(
    await preview({ type: "publish", name: "feature", remote: "origin" }),
    false,
  );
  // Dirty changes are warnings; real Git decides whether a switch can succeed.
  await reset();
  for (const cwd of trees) await write(cwd, "unrelated.txt", "keep\n");
  plan = await preview(create("dirty", true));
  assert.equal(plan.warnings.length, 1);
  await apply(plan);
  await reset();
  for (const cwd of trees)
    await write(cwd, "shared.txt", "incompatible local\n");
  plan = await preview({ type: "switch", name: "feature", kind: "local" });
  assert.equal(plan.warnings.length, 1);
  await apply(plan, false);
  // Both workspace and reference/ownership changes bind the original token.
  await reset();
  plan = await preview(create("stale"));
  for (const cwd of trees) await write(cwd, "new.txt", "changed\n");
  await apply(plan, false);
  await reset();
  plan = await preview(create("stale"));
  for (const cwd of trees) git(cwd, "branch", "new-ref", feature);
  await apply(plan, false);
  await reset();
  for (let i = 0; i < trees.length; i++)
    git(
      trees[i],
      "worktree",
      "add",
      "--quiet",
      path.join(roots[i], "side"),
      "feature",
    );
  const owned = await query("git.branch.list");
  assert.equal(
    owned.branches.find((b) => b.name === "feature").worktree.label,
    "side",
  );
  for (const action of [
    { type: "switch", name: "feature", kind: "local" },
    { type: "rename", name: "feature", newName: "blocked" },
    { type: "deleteLocal", name: "feature", force: true },
  ])
    await preview(action, false);
  for (let i = 0; i < trees.length; i++)
    await symlink(trees[i], path.join(roots[i], "alias"));
  await query("git.branch.list", {}, true, true);
  for (let i = 0; i < trees.length; i++)
    await rm(path.join(roots[i], "side"), { recursive: true, force: true });
  await query("git.branch.list");
  // Gone upstreams, fetch/prune and a remote-only branch use the real bare repos.
  await reset();
  await apply(
    await preview({
      type: "setUpstream",
      name: "main",
      upstream: "origin/main",
    }),
  );
  for (let i = 0; i < trees.length; i++)
    git(remotes[i], "update-ref", "-d", "refs/heads/main");
  await apply(await preview({ type: "fetch", remote: "origin", prune: true }));
  const gone = await query("git.branch.list");
  assert.equal(gone.branches.find((b) => b.name === "main").upstreamGone, true);
  await reset();
  for (let i = 0; i < trees.length; i++)
    git(remotes[i], "update-ref", "refs/heads/new-remote", feature);
  await apply(await preview({ type: "fetch", remote: "origin", prune: false }));
  await apply(
    await preview({
      type: "switch",
      name: "origin/new-remote",
      kind: "remote",
    }),
  );
  await reset();
  for (const cwd of trees) {
    git(cwd, "checkout", "--quiet", "--detach", base);
    for (const name of ["ä", "A", "𐐀", "\ue000"])
      git(cwd, "branch", name, base);
    git(cwd, "config", "branch.main.remote", ".");
    git(cwd, "remote", "set-head", "origin", "--auto");
  }
  const detached = await query("git.branch.list");
  assert.equal(detached.detached, true);
  assert.equal(
    detached.branches.some((b) => b.fullRef.endsWith("/HEAD")),
    false,
  );
  await reset();
  for (let i = 0; i < trees.length; i++) {
    for (const name of ["𐐀", "\ue000", "alpha"])
      git(trees[i], "remote", "add", name, remotes[i]);
    git(trees[i], "remote", "remove", "origin");
    git(trees[i], "config", "branch.main.remote", ".");
  }
  const defaults = await query("git.branch.list");
  assert.equal(defaults.defaultRemote, "alpha");
  // An unborn checkout retains Source's missing-HEAD preview failure behavior.
  await reset();
  for (const cwd of trees) {
    git(cwd, "checkout", "--orphan", "unborn");
    git(cwd, "rm", "--quiet", "-rf", ".");
  }
  const unborn = await query("git.branch.list");
  assert.equal(unborn.head, null);
  assert.equal(unborn.currentBranch, "unborn");
  await preview(create("blocked"), false);
  // Source's workspace fingerprint still requires HEAD, even with a start point.
  await preview(create("from-existing", true, base), false);
  console.log(
    JSON.stringify({
      comparisons,
      actions: [...actions],
      actualGit: true,
      ownedBareRemotes: true,
      exactTokens: true,
      worktreeOwnership: true,
      trackingAndPrune: true,
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
