// Actual Node/native graph analysis over owned repositories and Git objects.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
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
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_DATE: "2026-11-17T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-11-17T00:00:00+00:00",
});
const { handleGitCommand } =
  await import("../../tests/reference-node-worker/src/commands/git.ts");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-git-graph-"));
const trees = [
  path.join(root, "node", "checkout"),
  path.join(root, "rust", "checkout"),
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
  comparisons = 0,
  maximumQueryMs = 0;
const commands = new Set();
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 128 * 1024 * 1024,
  }).trim();
async function both(visit) {
  for (const cwd of trees) await visit(cwd);
}
async function file(cwd, name, bytes) {
  await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
  await writeFile(path.join(cwd, name), bytes);
}
async function commit(message) {
  for (const cwd of trees) {
    git(cwd, "add", "-A");
    git(cwd, "commit", "--quiet", "-m", message);
  }
  const hashes = trees.map((cwd) => git(cwd, "rev-parse", "HEAD"));
  assert.equal(hashes[0], hashes[1]);
  return hashes[0];
}
async function observe(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
function normalize(value, key) {
  if (key === "analyzedAt") {
    assert.ok(Number.isFinite(Date.parse(value)));
    return "<timestamp>";
  }
  if (key === "averageBlameAgeDays" && value !== null) {
    assert.ok(Number.isFinite(value) && value >= 0);
    return "<age>";
  }
  if (typeof value === "string") {
    for (const cwd of trees) value = value.replaceAll(cwd, "<checkout>");
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, normalize(v, key)]),
    );
  return value;
}
function compareAges(actual, expected) {
  if (
    !actual ||
    typeof actual !== "object" ||
    !expected ||
    typeof expected !== "object"
  )
    return;
  for (const key of Object.keys(expected)) {
    if (
      key === "averageBlameAgeDays" &&
      expected[key] !== null &&
      actual[key] !== null
    ) {
      assert.ok(
        Math.abs(actual[key] - expected[key]) <=
          (maximumQueryMs + 50) / 86_400_000,
        "blame age differs only by measured execution time",
      );
    } else compareAges(actual[key], expected[key]);
  }
}
async function query(type, input = {}, success = true) {
  const command = p.workerCommandSchema.parse({
    type,
    cwd: trees[0],
    ...input,
  });
  commands.add(type);
  const begin = Date.now();
  const expected = await observe(() => handleGitCommand(command));
  assert.equal(expected.ok, success, JSON.stringify(expected));
  child.stdin.write(
    JSON.stringify({
      op: "git",
      command: { ...command, cwd: trees[1] },
      requestId: ++sequence,
    }) + "\n",
  );
  const line = await lines.next();
  assert.equal(line.done, false);
  const { id, result } = JSON.parse(line.value);
  assert.equal(id, sequence);
  const { code, ...actual } = result;
  maximumQueryMs = Math.max(maximumQueryMs, Date.now() - begin);
  assert.deepEqual(
    normalize(actual),
    normalize(expected),
    type + JSON.stringify(input),
  );
  compareAges(actual, expected);
  comparisons++;
  return { actual: actual.value, expected: expected.value };
}
const snapshot = (input = {}, success = true) =>
  query("git.graph.snapshot", input, success);
const metrics = (input = {}, success = true) =>
  query("git.graph.metrics", input, success);
const overlay = (revision, rootPath = null) =>
  query("git.graph.commit-overlay", { revision, rootPath });
try {
  await both(async (cwd) => {
    await mkdir(cwd, { recursive: true });
    git(cwd, "init", "--quiet", "-b", "main");
    for (const [key, value] of Object.entries({
      "user.name": "First Author",
      "user.email": "first@example.invalid",
      "commit.gpgsign": "false",
      "core.hooksPath": "/dev/null",
      "color.ui": "false",
    }))
      git(cwd, "config", key, value);
  });
  await snapshot();
  await metrics();
  await metrics({ includeBlame: true });
  await snapshot({ rootPath: "missing" });
  await snapshot({ revision: "missing" }, false);
  await both(async (cwd) => {
    for (const [name, bytes] of [
      ["README.md", "one\n\ntwo\n"],
      ["src/index.ts", "export {};\n"],
      ["src/empty", ""],
      ["src/binary.dat", Buffer.from([0, 1, 2, 3])],
      ["src/tab\tline\n.txt", "tab\nline\n"],
      ["Dockerfile", "FROM scratch\n"],
      ["src/.hidden", "hidden\n"],
      ["src/upper.STRASSE", "upper\n"],
      ["src/notes.unknown", "unknown\n"],
      ["src/ß.ß", "case\n"],
    ])
      await file(cwd, name, bytes);
    await symlink("src/index.ts", path.join(cwd, "link"));
  });
  const initial = await commit("Initial graph");
  await both(async (cwd) => {
    await mkdir(path.join(cwd, "vendor"));
    git(
      cwd,
      "clone",
      "--quiet",
      "--no-checkout",
      cwd,
      path.join(cwd, "vendor/child"),
    );
    git(
      cwd,
      "update-index",
      "--add",
      "--cacheinfo",
      "160000",
      initial,
      "vendor/child",
    );
  });
  const linked = await commit("Graph gitlink");
  await both(async (cwd) => {
    await file(
      cwd,
      "src/index.ts",
      "export const value=1;\nexport default value;\n",
    );
    git(cwd, "config", "user.name", "Second Author");
    git(cwd, "config", "user.email", "second@example.invalid");
  });
  const expanded = await commit("Expand graph");
  const first = await snapshot();
  const cached = await snapshot();
  assert.equal(cached.actual.analyzedAt, first.actual.analyzedAt);
  assert.equal(cached.expected.analyzedAt, first.expected.analyzedAt);
  await snapshot({ rootPath: "src" });
  await snapshot({ rootPath: "src/" });
  await snapshot({ rootPath: "./src" });
  await snapshot({ rootPath: "." }, false);
  await snapshot({ rootPath: "README.md" }, false);
  await snapshot({ rootPath: "not-present" }, false);
  await snapshot({ maxNodes: 1 });
  await snapshot({ maxNodes: 5 });
  await metrics();
  await metrics({ includeBlame: true });
  await metrics({ rootPath: "src", includeBlame: true });
  await metrics({ maxNodes: 5, includeBlame: true });
  await metrics({ revision: initial, includeBlame: true });
  await snapshot({ revision: linked });
  await overlay(initial);
  await overlay(expanded, "src");
  await both((cwd) => file(cwd, "src/index.ts", "uncommitted contents\n"));
  const dirty = await snapshot();
  assert.deepEqual(dirty.actual, first.actual);
  assert.deepEqual(dirty.expected, first.expected);
  await both((cwd) =>
    file(cwd, "src/index.ts", "export const incremental=true;\n"),
  );
  const increment = await commit("Incremental graph");
  await metrics();
  await metrics({ includeBlame: true });
  await both((cwd) => git(cwd, "branch", "-m", "renamed"));
  const renamed = await snapshot();
  assert.equal(renamed.actual.branch, "renamed");
  await metrics();
  await both(async (cwd) => {
    git(cwd, "mv", "src/index.ts", "outside.ts");
    await rm(path.join(cwd, "src/empty"));
    await file(cwd, "src/binary.dat", Buffer.from([0, 9, 8, 7]));
  });
  const moved = await commit("Rename delete binary");
  await snapshot();
  await metrics({ includeBlame: true });
  await overlay(moved, "src");
  await overlay(moved);
  await both((cwd) => git(cwd, "checkout", "--quiet", "--detach", increment));
  const detached = await snapshot();
  assert.equal(detached.actual.branch, null);
  await metrics({ includeBlame: true });
  await both((cwd) => git(cwd, "checkout", "--quiet", "renamed"));
  // Real blame file-budget truncation, with a larger first file skipped.
  await both(async (cwd) => {
    await file(cwd, "budget/00-too-large.txt", "x\n".repeat(75_001));
    for (let i = 0; i < 82; i++)
      await file(
        cwd,
        "budget/" + String(i + 1).padStart(3, "0") + ".txt",
        "small\n",
      );
  });
  await commit("Bounded blame");
  await snapshot({ rootPath: "budget", maxNodes: 25 });
  const bounded = await metrics({ rootPath: "budget", includeBlame: true });
  assert.deepEqual(bounded.actual.blameCoverage, {
    analyzedFiles: 80,
    totalFiles: 83,
    truncated: true,
  });
  await metrics({ rootPath: "budget", maxNodes: 1, includeBlame: true });
  // Failed results must not become successful cached entries.
  await both((cwd) => file(cwd, "constructor", "prototype lookup"));
  await commit("Source inherited language key");
  await snapshot({}, false);
  await both(async (cwd) => {
    await rm(path.join(cwd, "constructor"));
    await file(cwd, "__proto__", "prototype lookup");
  });
  await commit("Source prototype language object");
  await snapshot({}, false);
  await both((cwd) => rm(path.join(cwd, "__proto__")));
  await commit("Recover graph");
  await snapshot();
  await metrics();
  console.log(
    JSON.stringify({
      comparisons,
      commands: [...commands],
      actualGit: true,
      treeAndMetrics: true,
      blame: true,
      cacheAndIncremental: true,
      scopedRenameDeleteOverlays: true,
      platform: process.platform,
    }),
  );
} finally {
  child.stdin.end();
  try {
    assert.equal(await completion, 0);
  } finally {
    process.env = original;
    await rm(root, { recursive: true, force: true });
  }
}
