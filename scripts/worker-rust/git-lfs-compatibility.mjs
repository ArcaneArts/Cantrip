// Actual Node/native LFS CLI behavior, local transfers and lock protocol boundaries.
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
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import * as p from "../../packages/protocol/dist/index.js";
import { startLfsFixture } from "./lfs-test-server.mjs";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const original = { ...process.env };
Object.assign(process.env, {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_AUTHOR_DATE: "2026-11-17T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-11-17T00:00:00+00:00",
});
const { handleGitCommand } =
  await import("../../tests/reference-node-worker/src/commands/git.ts");
const { readGitStatus } =
  await import("../../tests/reference-node-worker/src/git.ts");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-lfs-")),
  template = path.join(root, "template"),
  empty = path.join(root, "empty"),
  remote = path.join(root, "origin.git"),
  roots = [path.join(root, "node"), path.join(root, "rust")],
  trees = roots.map((root) => path.join(root, "checkout"));
for (const dir of [template, empty, ...roots]) await mkdir(dir);
const bytes = Buffer.from("Owned LFS object 🧙\n".repeat(16)),
  oid = createHash("sha256").update(bytes).digest("hex"),
  fixture = await startLfsFixture(new Map([[oid, bytes]]));
let child,
  completion,
  lines,
  sequence = 0,
  comparisons = 0;
const actions = new Set();
function start() {
  child = spawn(path.resolve(values.binary), [], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
}
async function stop() {
  if (child) {
    child.stdin.end();
    assert.equal(await completion, 0);
    child = undefined;
  }
}
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}
async function initialize(cwd) {
  git(cwd, "init", "--quiet", "-b", "main");
  for (const [key, value] of Object.entries({
    "user.name": "Fixture",
    "user.email": "fixture@example.invalid",
    "commit.gpgsign": "false",
    "core.hooksPath": ".git/hooks",
    "color.ui": "false",
  }))
    git(cwd, "config", key, value);
  await writeFile(path.join(cwd, "base.txt"), "base\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", "Base");
}
async function reset(source = template) {
  for (let i = 0; i < trees.length; i++) {
    await rm(trees[i], { recursive: true, force: true });
    await cp(source, trees[i], { recursive: true });
    fixture.reset(i === 0 ? "node" : "rust");
    git(trees[i], "remote", "add", "origin", remote);
    git(
      trees[i],
      "config",
      "lfs.url",
      `${fixture.origin}/${i === 0 ? "node" : "rust"}`,
    );
  }
}
function normalize(value, key) {
  if (key === "generatedAt") {
    assert.ok(Number.isFinite(Date.parse(value)));
    return "<timestamp>";
  }
  if (typeof value === "string")
    return value
      .replaceAll(roots[0], "<owned>")
      .replaceAll(roots[1], "<owned>")
      .replaceAll(`${fixture.origin}/node`, `${fixture.origin}/<lane>`)
      .replaceAll(`${fixture.origin}/rust`, `${fixture.origin}/<lane>`);
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, normalize(v, key)]),
    );
  return value;
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
  const { code, ...value } = result;
  return value;
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
  for (const args of [
    ["status", "--porcelain=v1"],
    ["config", "--local", "--list"],
  ])
    assert.deepEqual(
      normalize(git(trees[1], ...args))
        .split("\n")
        .sort((a, b) =>
          args[0] === "config"
            ? a.split("=", 1)[0].localeCompare(b.split("=", 1)[0])
            : 0,
        ),
      normalize(git(trees[0], ...args))
        .split("\n")
        .sort((a, b) =>
          args[0] === "config"
            ? a.split("=", 1)[0].localeCompare(b.split("=", 1)[0])
            : 0,
        ),
      `actual Git ${args[0]}`,
    );
  comparisons++;
  return actual.value;
}
async function preview(action, success = true) {
  actions.add(action.type);
  return query("git.lfs.action.preview", { action }, success);
}
async function apply(plan, success = true, token = plan.token) {
  return query("git.lfs.action.apply", { action: plan.action, token }, success);
}
async function missing() {
  for (const cwd of trees) {
    await writeFile(
      path.join(cwd, "asset.bin"),
      git(cwd, "show", "HEAD:asset.bin") + "\n",
    );
    await rm(
      path.join(
        cwd,
        ".git",
        "lfs",
        "objects",
        oid.slice(0, 2),
        oid.slice(2, 4),
        oid,
      ),
      { force: true },
    );
  }
}
try {
  await initialize(empty);
  await cp(empty, template, { recursive: true });
  git(template, "lfs", "install", "--local");
  git(template, "lfs", "track", "*.bin");
  await writeFile(path.join(template, "asset.bin"), bytes);
  git(template, "add", "-A");
  git(template, "commit", "--quiet", "-m", "LFS object");
  git(template, "clone", "--quiet", "--bare", template, remote);
  start();
  await reset(empty);
  let status = await query("git.lfs.status", { refreshLocks: false });
  assert.equal(status.available, true);
  for (const action of [
    { type: "install" },
    { type: "track", pattern: "*.bin" },
    { type: "track", pattern: "*.🧙" },
    { type: "untrack", pattern: "*.🧙" },
  ]) {
    const plan = await preview(action);
    await apply(plan, false, "0".repeat(64));
    await apply(plan);
  }
  await reset();
  status = await query("git.lfs.status", { refreshLocks: false });
  assert.equal(status.files[0].oid, oid);
  assert.equal(status.files[0].downloaded, true);
  for (const cwd of trees)
    await writeFile(path.join(cwd, "asset.bin"), "changed\n");
  status = await query("git.lfs.status", { refreshLocks: false });
  assert.equal(status.files[0].status, "M");
  await reset();
  let plan = await preview({ type: "untrack", pattern: "*.bin" });
  for (const cwd of trees)
    await writeFile(path.join(cwd, "dirty.txt"), "dirty\n");
  await apply(plan, false);
  await reset();
  await missing();
  status = await query("git.lfs.status", { refreshLocks: false });
  assert.equal(status.missingObjects, 1);
  assert.equal(status.files[0].checkedOut, false);
  await apply(await preview({ type: "fetch", remote: "origin", all: true }));
  for (const cwd of trees)
    assert.deepEqual(
      await readFile(
        path.join(
          cwd,
          ".git",
          "lfs",
          "objects",
          oid.slice(0, 2),
          oid.slice(2, 4),
          oid,
        ),
      ),
      bytes,
    );
  await missing();
  await apply(await preview({ type: "fetch", remote: null, all: false }));
  await missing();
  await apply(await preview({ type: "pull", remote: "origin" }));
  for (const cwd of trees)
    assert.deepEqual(await readFile(path.join(cwd, "asset.bin")), bytes);
  await apply(await preview({ type: "pull", remote: null }));
  for (const verifyRemote of [false, true])
    await apply(await preview({ type: "prune", verifyRemote }));
  await apply(await preview({ type: "lock", path: "asset.bin" }));
  status = await query("git.lfs.status", { refreshLocks: false });
  assert.equal(status.locksCached, true);
  const refreshed = await apply(await preview({ type: "refreshLocks" }));
  assert.equal(
    refreshed.lfs.locks.length,
    1,
    "actual remote lock returned after refresh",
  );
  status = await query("git.lfs.status", { refreshLocks: true });
  assert.equal(status.locksCached, false);
  await apply(
    await preview({ type: "unlock", path: "asset.bin", force: false }),
  );
  for (const name of ["node", "rust"]) fixture.foreign(name, "asset.bin");
  await apply(await preview({ type: "refreshLocks" }));
  plan = await preview({ type: "unlock", path: "asset.bin", force: true });
  assert.equal(plan.warnings.length, 1);
  await apply(plan);
  await reset();
  for (const cwd of trees)
    git(cwd, "config", "lfs.url", `${fixture.origin}/unavailable`);
  status = await query("git.lfs.status", { refreshLocks: true });
  assert.equal(status.available, true);
  assert.ok(
    fixture.requests.some((request) => request.lane === "unavailable"),
    "real unavailable-endpoint request observed",
  );
  // Missing-tool behavior uses the real Git executable with no external helpers.
  await reset(empty);
  await stop();
  const isolated = path.join(root, "without-lfs");
  await mkdir(isolated);
  const gitBinary = execFileSync("/usr/bin/which", ["git"], {
    encoding: "utf8",
  }).trim();
  await symlink(gitBinary, path.join(isolated, "git"));
  process.env.PATH = isolated;
  process.env.GIT_EXEC_PATH = isolated;
  start();
  status = await query("git.lfs.status", { refreshLocks: true });
  assert.equal(status.available, false);
  assert.equal(status.locksCached, true);
  await preview({ type: "install" }, false);
  console.log(
    JSON.stringify({
      comparisons,
      actions: [...actions],
      actualGitLfs: true,
      realObjectDownloads: true,
      actualLockRequests: true,
      exactTokens: true,
      missingTool: true,
      localRequests: fixture.requests.length,
      platform: process.platform,
    }),
  );
} finally {
  try {
    await stop();
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
}
