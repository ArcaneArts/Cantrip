// Exact reviewed selections and resulting Git index/worktree bytes in owned repos.
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
  rename,
} from "node:fs/promises";
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
const { readGitStatus, readGitFileDiff } =
  await import("../../cantrip_worker/src/git.ts");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-patches-")),
  template = path.join(root, "template"),
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
const operations = new Set();
function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}
const write = (cwd, name, bytes) => writeFile(path.join(cwd, name), bytes);
async function reset() {
  for (const cwd of trees) {
    await rm(cwd, { recursive: true, force: true });
    await cp(template, cwd, { recursive: true });
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
    type + JSON.stringify(input),
  );
  assert.deepEqual(
    await readGitStatus(trees[1]),
    await readGitStatus(trees[0]),
  );
  for (const args of [
    ["rev-parse", "HEAD"],
    ["ls-files", "--stage", "-z"],
    ["diff", "--binary", "HEAD"],
  ])
    assert.equal(
      git(trees[1], ...args),
      git(trees[0], ...args),
      `actual Git ${args[0]}`,
    );
  const file = input.request.path;
  const bytes = await Promise.all(
    trees.map(async (cwd) => {
      try {
        return await readFile(path.join(cwd, file));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return null;
      }
    }),
  );
  assert.deepEqual(bytes[1], bytes[0], "actual selected worktree bytes");
  comparisons++;
  return actual.value;
}
async function preview(request, success = true) {
  operations.add(request.operation);
  return query("git.patch.preview", { request }, success);
}
async function apply(request, plan, success = true, token = plan.token) {
  return query("git.patch.apply", { request, token }, success);
}
function hunks(patch) {
  const result = [];
  for (const line of patch.trimEnd().split("\n")) {
    if (line.startsWith("@@ ")) result.push([]);
    else if (result.length) result.at(-1).push(line);
  }
  return result;
}
async function selection(operation, file, kind = "pair") {
  const diff = await readGitFileDiff(
    trees[0],
    file,
    operation === "unstage" ? "staged" : "unstaged",
  );
  const body = hunks(diff.patch)[0];
  assert.ok(body);
  const indexes = body.flatMap((line, index) =>
    (kind === "pair" && /^[+-]/u.test(line)) ||
    (kind === "add" && line.startsWith("+")) ||
    (kind === "delete" && line.startsWith("-"))
      ? [index]
      : [],
  );
  return {
    operation,
    path: file,
    hunks: [{ hunkIndex: 0, lineIndexes: kind === "hunk" ? null : indexes }],
  };
}
const base =
  Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const edited = base
  .replace("line 2\n", "changed 2 🧙\n")
  .replace("line 24\n", "changed 24\n");
async function edit(operation, file = "lines.txt") {
  for (const cwd of trees) {
    await write(cwd, file, edited);
    if (operation === "unstage") git(cwd, "add", "--", file);
  }
}
try {
  git(template, "-c", "init.defaultBranch=main", "init", "--quiet");
  for (const [k, v] of Object.entries({
    "user.name": "Fixture",
    "user.email": "fixture@example.invalid",
    "commit.gpgsign": "false",
    "core.hooksPath": "/dev/null",
    "core.filemode": "true",
    "color.ui": "false",
  }))
    git(template, "config", k, v);
  for (const file of [
    "lines.txt",
    "literal[ab].txt",
    "literala.txt",
    "line\n🧙.txt",
    "rename.txt",
    "mode.sh",
  ])
    await write(template, file, base);
  await write(template, "deleted.txt", "first\nsecond\nthird\n");
  await write(template, "no-newline.txt", "one\ntwo");
  await write(template, "binary.bin", Buffer.from([0, 1, 2]));
  git(template, "add", "-A");
  git(template, "commit", "--quiet", "-m", "Base");
  for (const operation of ["stage", "unstage", "discard"]) {
    for (const kind of ["hunk", "pair", "add", "delete"]) {
      await reset();
      await edit(operation);
      const request = await selection(operation, "lines.txt", kind);
      const plan = await preview(request);
      await apply(request, plan, false, "0".repeat(64));
      await apply(request, plan);
    }
  }
  await reset();
  await edit("stage");
  let request = {
    operation: "stage",
    path: "lines.txt",
    hunks: [
      { hunkIndex: 1, lineIndexes: null },
      { hunkIndex: 0, lineIndexes: null },
    ],
  };
  let plan = await preview(request);
  await apply(request, plan);
  await reset();
  await edit("stage");
  for (const hunks of [
    [
      { hunkIndex: 0, lineIndexes: null },
      { hunkIndex: 0, lineIndexes: null },
    ],
    [{ hunkIndex: 999, lineIndexes: null }],
    [{ hunkIndex: 0, lineIndexes: [] }],
    [{ hunkIndex: 0, lineIndexes: [0] }],
    [{ hunkIndex: 0, lineIndexes: [999] }],
    [
      { hunkIndex: 1, lineIndexes: [999] },
      { hunkIndex: 0, lineIndexes: [] },
    ],
  ])
    await preview({ operation: "stage", path: "lines.txt", hunks }, false);
  request = await selection("stage", "lines.txt");
  request.hunks[0].lineIndexes.push(request.hunks[0].lineIndexes[0]);
  plan = await preview(request);
  assert.equal(plan.selectedLines, 2);
  await apply(request, plan);
  // Selected content binds the token; unrelated files do not become extra gates.
  await reset();
  await edit("stage");
  request = await selection("stage", "lines.txt");
  plan = await preview(request);
  for (const cwd of trees)
    await write(
      cwd,
      "lines.txt",
      edited.replace("changed 2 🧙", "changed again"),
    );
  await apply(request, plan, false);
  await reset();
  await edit("stage");
  request = await selection("stage", "lines.txt");
  plan = await preview(request);
  for (const cwd of trees) await write(cwd, "unrelated.txt", "unrelated\n");
  await apply(request, plan);
  for (const file of ["literal[ab].txt", "line\n🧙.txt"]) {
    await reset();
    await edit("stage", file);
    request = await selection("stage", file);
    await apply(request, await preview(request));
    assert.equal(git(trees[1], "show", ":literala.txt"), base.trim());
  }
  // Partial new/deleted files need the same header and range normalization.
  for (const operation of ["stage", "unstage", "discard"]) {
    await reset();
    for (const cwd of trees) {
      await write(cwd, "new.txt", "first\nsecond\nthird\n");
      if (operation === "unstage") git(cwd, "add", "new.txt");
    }
    request = await selection(operation, "new.txt", "add");
    request.hunks[0].lineIndexes = request.hunks[0].lineIndexes.slice(1, 2);
    await apply(request, await preview(request));
    await reset();
    for (const cwd of trees) {
      await rm(path.join(cwd, "deleted.txt"));
      if (operation === "unstage") git(cwd, "add", "deleted.txt");
    }
    request = await selection(operation, "deleted.txt", "delete");
    request.hunks[0].lineIndexes = request.hunks[0].lineIndexes.slice(1, 2);
    await apply(request, await preview(request));
  }
  for (const operation of ["stage", "unstage", "discard"]) {
    await reset();
    for (const cwd of trees) {
      await write(cwd, "no-newline.txt", "one\nTWO");
      if (operation === "unstage") git(cwd, "add", "no-newline.txt");
    }
    request = await selection(operation, "no-newline.txt");
    await apply(request, await preview(request));
  }
  // Binary and file metadata retain the source's file-level-only restrictions.
  await reset();
  for (const cwd of trees)
    await write(cwd, "binary.bin", Buffer.from([0, 3, 4]));
  await preview(
    {
      operation: "stage",
      path: "binary.bin",
      hunks: [{ hunkIndex: 0, lineIndexes: null }],
    },
    false,
  );
  for (const changeText of [false, true]) {
    await reset();
    for (const cwd of trees) {
      await chmod(path.join(cwd, "mode.sh"), 0o755);
      if (changeText) await write(cwd, "mode.sh", edited);
    }
    await preview(
      {
        operation: "stage",
        path: "mode.sh",
        hunks: [{ hunkIndex: 0, lineIndexes: null }],
      },
      false,
    );
  }
  for (const changeText of [false, true]) {
    await reset();
    for (const cwd of trees) {
      await rename(path.join(cwd, "rename.txt"), path.join(cwd, "renamed.txt"));
      if (changeText) await write(cwd, "renamed.txt", edited);
      git(cwd, "add", "-A");
    }
    await preview(
      {
        operation: "unstage",
        path: "renamed.txt",
        hunks: [{ hunkIndex: 0, lineIndexes: null }],
      },
      false,
    );
  }
  await reset();
  for (const cwd of trees)
    await write(cwd, "lines.txt", "🧙".repeat(1_000_001));
  await preview(
    {
      operation: "stage",
      path: "lines.txt",
      hunks: [{ hunkIndex: 0, lineIndexes: null }],
    },
    false,
  );
  console.log(
    JSON.stringify({
      comparisons,
      operations: [...operations],
      actualGit: true,
      exactTokens: true,
      newDeletedAndNoNewline: true,
      metadataGuards: true,
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
