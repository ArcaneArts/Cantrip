// Real unmerged stages, bounded previews and staged resolutions in owned repos.
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
  symlink,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
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
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-conflicts-"));
const template = path.join(root, "template"),
  nodeRoot = path.join(root, "node"),
  rustRoot = path.join(root, "rust");
for (const directory of [template, nodeRoot, rustRoot]) await mkdir(directory);
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
const strategies = new Set();
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
async function write(cwd, file, content) {
  await writeFile(path.join(cwd, file), content);
}
async function reset() {
  for (const cwd of trees) {
    await rm(cwd, { recursive: true, force: true });
    await cp(template, cwd, { recursive: true, verbatimSymlinks: true });
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
    "actual checkout/index state",
  );
  assert.equal(
    git(trees[1], "ls-files", "--stage", "-z"),
    git(trees[0], "ls-files", "--stage", "-z"),
    "actual index modes, stages and object identities",
  );
  comparisons++;
  return actual.value;
}
async function preview(file, strategy, content = null, success = true) {
  strategies.add(strategy);
  return query(
    "git.conflicts.preview",
    { request: { path: file, strategy, content } },
    success,
  );
}
async function apply(plan, success = true, token = plan.token) {
  const result = await query(
    "git.conflicts.apply",
    { request: plan.request, token },
    success,
  );
  for (const cwd of trees) {
    const relative = plan.request.path;
    let bytes;
    try {
      bytes = await readFile(path.join(cwd, relative));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (cwd === trees[0]) apply.expected = bytes;
    else
      assert.deepEqual(
        bytes,
        apply.expected,
        "actual worktree bytes after resolution",
      );
  }
  return result;
}
try {
  git(template, "-c", "init.defaultBranch=main", "init", "--quiet");
  for (const [key, value] of Object.entries({
    "user.name": "Fixture",
    "user.email": "fixture@example.invalid",
    "commit.gpgsign": "false",
    "core.hooksPath": "/dev/null",
    "core.filemode": "true",
    "color.ui": "false",
  }))
    git(template, "config", key, value);
  const files = [
    "shared.txt",
    "delete-ours.txt",
    "delete-theirs.txt",
    "join.txt",
    "mode.sh",
    "binary.bin",
    "large.txt",
    "line\n🧙.txt",
  ];
  for (const file of files)
    await write(
      template,
      file,
      file === "binary.bin" ? Buffer.from([0, 1, 2]) : "base\n",
    );
  await chmod(path.join(template, "mode.sh"), 0o755);
  commit(template, "Base");
  git(template, "checkout", "--quiet", "-b", "feature");
  for (const file of files.filter((file) => file !== "delete-theirs.txt"))
    await write(
      template,
      file,
      file === "binary.bin"
        ? Buffer.from([0, 3, 4])
        : file === "large.txt"
          ? "a".repeat(2_000_001)
          : file === "join.txt"
            ? "theirs without newline"
            : "theirs\n",
    );
  await rm(path.join(template, "delete-theirs.txt"));
  await write(template, "added.txt", "theirs added\n");
  commit(template, "Feature");
  git(template, "checkout", "--quiet", "main");
  for (const file of files.filter((file) => file !== "delete-ours.txt"))
    await write(
      template,
      file,
      file === "binary.bin"
        ? Buffer.from([0, 5, 6])
        : file === "large.txt"
          ? "b".repeat(2_000_001)
          : file === "join.txt"
            ? "ours without newline"
            : "ours\n",
    );
  await rm(path.join(template, "delete-ours.txt"));
  await write(template, "added.txt", "ours added\n");
  commit(template, "Main");
  assert.throws(() => git(template, "merge", "--no-edit", "feature"));
  await reset();
  const listed = await query("git.conflicts.list");
  assert.equal(listed.files.length, 9);
  for (const file of [...files, "added.txt"])
    await query("git.conflicts.get", { path: file });
  const large = await query("git.conflicts.get", { path: "large.txt" });
  assert.equal(large.ours.truncated, true);
  assert.equal(large.result.truncated, true);
  for (const strategy of [
    "ours",
    "theirs",
    "both",
    "result",
    "manual",
    "delete",
  ]) {
    await reset();
    const plan = await preview(
      "shared.txt",
      strategy,
      strategy === "manual" ? "resolved 🧙\ud800\n" : null,
    );
    await apply(plan, false, "0".repeat(64));
    const done = await apply(plan);
    assert.equal(done.resolved, true);
    assert.equal(done.remainingPaths.includes("shared.txt"), false);
    await query("git.conflicts.get", { path: "shared.txt" }, false);
  }
  for (const file of ["delete-ours.txt", "delete-theirs.txt", "added.txt"]) {
    for (const strategy of ["ours", "theirs"]) {
      await reset();
      const plan = await preview(file, strategy);
      await apply(plan);
    }
  }
  await reset();
  await preview("delete-ours.txt", "both", null, false);
  await reset();
  await apply(await preview("join.txt", "both"));
  assert.equal(
    await readFile(path.join(trees[1], "join.txt"), "utf8"),
    "ours without newline\ntheirs without newline",
  );
  await reset();
  await apply(await preview("mode.sh", "manual", "#!/bin/sh\nresolved\n"));
  assert.equal(
    (await lstat(path.join(trees[1], "mode.sh"))).mode & 0o777,
    0o755,
  );
  await reset();
  await preview("binary.bin", "both", null, false);
  await apply(await preview("binary.bin", "theirs"));
  await reset();
  await preview("large.txt", "both", null, false);
  await apply(await preview("large.txt", "ours"));
  // Existing index and current-result identities both bind the review token.
  await reset();
  let stale = await preview("shared.txt", "manual", "resolved\n");
  for (const cwd of trees)
    await write(cwd, "shared.txt", "changed after preview\n");
  await apply(stale, false);
  await reset();
  stale = await preview("shared.txt", "ours");
  for (const cwd of trees) {
    const oid = git(cwd, "rev-parse", "feature:added.txt");
    execFileSync("git", ["-C", cwd, "update-index", "--index-info"], {
      input: `100644 ${oid} 3\tshared.txt\n`,
    });
  }
  await apply(stale, false);
  await reset();
  for (const cwd of trees) await rm(path.join(cwd, "shared.txt"));
  await preview("shared.txt", "result", null, false);
  await apply(await preview("shared.txt", "ours"));
  await reset();
  for (const cwd of trees)
    await write(cwd, "shared.txt", Buffer.from([0xff, 0xfe, 65]));
  await query("git.conflicts.get", { path: "shared.txt" });
  await apply(await preview("shared.txt", "result"));
  // Real symlink and parent-containment failures must leave the outside file intact.
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "value.txt"), "outside stays\n");
  await reset();
  for (const cwd of trees) {
    await rm(path.join(cwd, "shared.txt"));
    await symlink(
      path.join(outside, "value.txt"),
      path.join(cwd, "shared.txt"),
    );
  }
  await query("git.conflicts.get", { path: "shared.txt" });
  await apply(await preview("shared.txt", "manual", "must not write\n"), false);
  assert.equal(
    await readFile(path.join(outside, "value.txt"), "utf8"),
    "outside stays\n",
  );
  await reset();
  for (const cwd of trees) {
    await symlink(outside, path.join(cwd, "escape"));
    const oid = git(cwd, "rev-parse", "HEAD:shared.txt");
    execFileSync("git", ["-C", cwd, "update-index", "--index-info"], {
      input: `100644 ${oid} 1\tescape/value.txt\n100644 ${oid} 2\tescape/value.txt\n100644 ${oid} 3\tescape/value.txt\n`,
    });
  }
  await apply(
    await preview("escape/value.txt", "manual", "must not escape\n"),
    false,
  );
  assert.equal(
    await readFile(path.join(outside, "value.txt"), "utf8"),
    "outside stays\n",
  );
  await reset();
  for (const cwd of trees) {
    const base = git(cwd, "rev-parse", "HEAD^"),
      ours = git(cwd, "rev-parse", "HEAD"),
      theirs = git(cwd, "rev-parse", "feature");
    execFileSync("git", ["-C", cwd, "update-index", "--index-info"], {
      input: `160000 ${base} 1\tmodule\n160000 ${ours} 2\tmodule\n160000 ${theirs} 3\tmodule\n`,
    });
  }
  const module = await query("git.conflicts.get", { path: "module" });
  assert.equal(module.ours.mode, "160000");
  assert.equal(module.ours.binary, true);
  assert.equal(module.ours.content, null);
  console.log(
    JSON.stringify({
      comparisons,
      strategies: [...strategies],
      actualGit: true,
      exactReviewTokens: true,
      boundedBinaryAndText: true,
      symlinkAndParentGuards: true,
      gitlinkStages: true,
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
