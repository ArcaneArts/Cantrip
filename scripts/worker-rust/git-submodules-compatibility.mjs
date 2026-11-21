// Actual Node/native submodules with isolated local repositories and nested paths.
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
  GIT_ALLOW_PROTOCOL: "file",
  LC_ALL: "C",
  GIT_AUTHOR_DATE: "2026-11-17T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-11-17T00:00:00+00:00",
});
const { handleGitCommand } =
  await import("../../tests/reference-node-worker/src/commands/git.ts");
const { readGitStatus } =
  await import("../../tests/reference-node-worker/src/git.ts");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-submodules-")),
  template = path.join(root, "template"),
  library = path.join(root, "library"),
  leaf = path.join(root, "leaf"),
  roots = [path.join(root, "node"), path.join(root, "rust")],
  trees = roots.map((root) => path.join(root, "checkout"));
for (const dir of [template, library, leaf, ...roots]) await mkdir(dir);
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
async function initialize(cwd, file) {
  git(cwd, "init", "--quiet", "-b", "main");
  for (const [key, value] of Object.entries({
    "user.name": "Fixture",
    "user.email": "fixture@example.invalid",
    "commit.gpgsign": "false",
    "core.hooksPath": "/dev/null",
    "color.ui": "false",
    "protocol.file.allow": "always",
  }))
    git(cwd, "config", key, value);
  await writeFile(path.join(cwd, file), "base\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", "Base");
}
async function reset() {
  for (const cwd of trees) {
    await rm(cwd, { recursive: true, force: true });
    await cp(template, cwd, { recursive: true });
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
      .replaceAll(roots[1], "<owned>");
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
  assert.deepEqual(
    await readGitStatus(trees[1]),
    await readGitStatus(trees[0]),
  );
  for (const relative of [
    "",
    "modules/library",
    "modules/library/nested/leaf",
  ]) {
    for (const args of [
      ["status", "--porcelain=v1"],
      ["config", "--local", "--list"],
    ]) {
      const left = await observe(() =>
        git(path.join(trees[0], relative), ...args),
      );
      const right = await observe(() =>
        git(path.join(trees[1], relative), ...args),
      );
      assert.deepEqual(
        normalize(right),
        normalize(left),
        `actual submodule ${relative} ${args[0]}`,
      );
    }
  }
  comparisons++;
  return actual.value;
}
async function preview(action, success = true) {
  actions.add(action.type);
  return query("git.submodule.action.preview", { action }, success);
}
async function apply(plan, success = true, token = plan.token) {
  return query(
    "git.submodule.action.apply",
    { action: plan.action, token },
    success,
  );
}
const modulePath = "modules/library",
  nestedPath = `${modulePath}/nested/leaf`;
const init = (path, recursive) => ({ type: "initialize", path, recursive });
const update = (path, recursive, remote = false) => ({
  type: "update",
  path,
  recursive,
  remote,
});
const sync = (path, recursive) => ({ type: "sync", path, recursive });
const deinit = (path, force = false) => ({ type: "deinitialize", path, force });
try {
  await initialize(leaf, "leaf.txt");
  await initialize(library, "library.txt");
  git(
    library,
    "submodule",
    "add",
    "--quiet",
    "--name",
    "leaf",
    "-b",
    "main",
    leaf,
    "nested/leaf",
  );
  git(library, "commit", "--quiet", "-am", "Nested module");
  await initialize(template, "base.txt");
  git(
    template,
    "submodule",
    "add",
    "--quiet",
    "--name",
    "library",
    "-b",
    "main",
    library,
    modulePath,
  );
  git(template, "submodule", "update", "--init", "--recursive");
  git(template, "commit", "--quiet", "-am", "Module");
  await reset();
  let inventory = await query("git.submodule.list");
  assert.equal(inventory.submodules.length, 2);
  assert.ok(
    inventory.submodules.every(
      (module) => module.initialized && module.state === "clean",
    ),
  );
  assert.equal(inventory.submodules[1].nested, true);
  let plan = await preview(init(null, false));
  assert.equal(plan.targets.length, 1);
  await apply(plan, false, "0".repeat(64));
  await apply(plan);
  plan = await preview(sync(null, true));
  assert.equal(plan.targets.length, 2);
  await apply(plan);
  await apply(await preview(deinit(nestedPath)));
  inventory = await query("git.submodule.list");
  assert.equal(inventory.submodules[1].state, "uninitialized");
  for (const cwd of trees)
    assert.throws(() =>
      git(path.join(cwd, modulePath), "config", "--get", "submodule.leaf.url"),
    );
  await apply(await preview(init(nestedPath, true)));
  for (const cwd of trees)
    await writeFile(path.join(cwd, nestedPath, "leaf.txt"), "dirty\n");
  inventory = await query("git.submodule.list");
  assert.ok(inventory.submodules.every((module) => module.dirty));
  await preview(deinit(nestedPath), false);
  plan = await preview(deinit(nestedPath, true));
  assert.equal(plan.warnings.length, 2);
  await apply(plan);
  await apply(await preview(init(nestedPath, true)));
  await writeFile(path.join(leaf, "leaf.txt"), "remote advance\n");
  git(leaf, "commit", "--quiet", "-am", "Advance");
  const next = git(leaf, "rev-parse", "HEAD");
  await apply(await preview(update(nestedPath, true, true)));
  inventory = await query("git.submodule.list");
  assert.equal(inventory.submodules[1].currentHash, next);
  assert.notEqual(inventory.submodules[1].expectedHash, next);
  await apply(await preview(update(nestedPath, false, false)));
  plan = await preview(sync(modulePath, true));
  for (const cwd of trees)
    await writeFile(path.join(cwd, "dirty.txt"), "dirty root\n");
  await apply(plan, false);
  await reset();
  plan = await preview(deinit(modulePath));
  for (const cwd of trees)
    await writeFile(
      path.join(cwd, modulePath, "library.txt"),
      "changed module\n",
    );
  await apply(plan, false);
  await reset();
  const url = "https://name:password@host.invalid/repo?token=hidden";
  for (const cwd of trees)
    git(cwd, "config", "-f", ".gitmodules", "submodule.library.url", url);
  inventory = await query("git.submodule.list");
  assert.ok(!inventory.submodules[0].url.includes("password"));
  assert.ok(!inventory.submodules[0].url.includes("hidden"));
  await apply(await preview(sync(modulePath, true)));
  for (const cwd of trees)
    assert.equal(git(cwd, "config", "--get", "submodule.library.url"), url);
  await reset();
  await apply(await preview(deinit(modulePath)));
  inventory = await query("git.submodule.list");
  assert.equal(inventory.submodules.length, 1);
  assert.equal(inventory.submodules[0].state, "uninitialized");
  await apply(await preview(init(modulePath, false)));
  plan = await preview(init(null, true));
  assert.equal(plan.targets.length, 2);
  await apply(plan);
  for (const action of [
    init("missing", true),
    update("missing", false),
    sync("missing", true),
    deinit("missing"),
    deinit("missing-\ud800"),
  ])
    await preview(action, false);
  // Missing gitlink/configuration records and rejected lexical escapes.
  await reset();
  for (const cwd of trees) {
    for (const [name, location] of [
      ["missing", "modules/missing"],
      ["outside", "../escape"],
      ["absolute", path.join(root, "outside")],
      ["dot", "."],
    ]) {
      git(
        cwd,
        "config",
        "-f",
        ".gitmodules",
        `submodule.${name}.path`,
        location,
      );
      git(cwd, "config", "-f", ".gitmodules", `submodule.${name}.url`, leaf);
    }
  }
  inventory = await query("git.submodule.list");
  assert.equal(inventory.submodules.length, 3);
  assert.equal(
    inventory.submodules.find((module) => module.path === "modules/missing")
      .state,
    "missing",
  );
  await apply(await preview(init("modules/missing", false)), false);
  // A symlinked .gitmodules is ignored rather than treated as a regular file.
  await reset();
  const external = path.join(root, "external-gitmodules");
  await writeFile(external, '[submodule "outside"]\npath=outside\nurl=owned\n');
  for (const cwd of trees) {
    await rm(path.join(cwd, ".gitmodules"));
    await symlink(external, path.join(cwd, ".gitmodules"));
  }
  inventory = await query("git.submodule.list");
  assert.equal(inventory.submodules.length, 0);
  await preview(init(null, true), false);
  // Real unmerged gitlink index stages produce the existing conflicted state.
  await reset();
  const base = git(library, "rev-parse", "HEAD");
  for (const cwd of trees)
    execFileSync("git", ["-C", cwd, "update-index", "--index-info"], {
      input: `0 ${"0".repeat(40)}\t${modulePath}\n160000 ${base} 1\t${modulePath}\n160000 ${base} 2\t${modulePath}\n160000 ${next} 3\t${modulePath}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    });
  inventory = await query("git.submodule.list");
  assert.equal(inventory.submodules[0].state, "conflicted");
  console.log(
    JSON.stringify({
      comparisons,
      actions: [...actions],
      actualGit: true,
      nestedParentRouting: true,
      exactTokens: true,
      dirtyAndForcedDeinitialization: true,
      localRemoteUpdate: true,
      urlRedactionAndPathFiltering: true,
      unmergedGitlink: true,
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
