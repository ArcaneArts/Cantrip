// Production encrypted graph commands, native cache/restart and journal guards.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import * as p from "../../packages/protocol/dist/index.js";
import { handleGitCommand } from "../../tests/reference-node-worker/src/commands/git.ts";
function normalize(value, key) {
  if (key === "analyzedAt") {
    assert.ok(Number.isFinite(Date.parse(value)));
    return "<timestamp>";
  }
  if (key === "averageBlameAgeDays" && value !== null) {
    assert.ok(value >= 0);
    return "<age>";
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, normalize(v, key)]),
    );
  return value;
}
function ages(actual, expected, maximum) {
  if (!expected || typeof expected !== "object") return;
  for (const key of Object.keys(expected)) {
    if (key === "averageBlameAgeDays" && expected[key] !== null) {
      assert.ok(Math.abs(actual[key] - expected[key]) < maximum / 86_400_000);
    } else ages(actual?.[key], expected[key], maximum);
  }
}
export async function verifyGraph({
  operation,
  checkout,
  restartWorker,
  store,
  scope,
  journal,
}) {
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        checkout,
        "-c",
        "user.name=Graph Fixture",
        "-c",
        "user.email=graph@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const oldHead = git("rev-parse", "HEAD"),
    oldStatus = git("status", "--porcelain=v1");
  const saved = await store.get(scope),
    before = await readFile(journal, "utf8");
  const started = Date.now(),
    rootPath = "native-graph",
    directory = path.join(checkout, rootPath);
  let held = false;
  async function query(type, input = {}) {
    const command = p.workerCommandSchema.parse({
      type,
      cwd: checkout,
      ...input,
    });
    const expected = await handleGitCommand(command);
    const { type: kind, cwd, ...args } = command;
    const result = await operation({ type: kind, arguments: args });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(normalize(result.result), normalize(expected));
    ages(result.result, expected, Date.now() - started + 100);
    return result.result;
  }
  try {
    git(
      "stash",
      "push",
      "--include-untracked",
      "-m",
      "owned graph fixture sentinel",
    );
    held = true;
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(path.join(directory, "src", "main.rs"), "fn main() {}\n");
    await writeFile(
      path.join(directory, "binary.dat"),
      Buffer.from([0, 1, 2, 3]),
    );
    await symlink("src/main.rs", path.join(directory, "link"));
    git("add", "--", rootPath);
    git("commit", "--quiet", "-m", "Owned graph tree");
    const initial = await query("git.graph.snapshot", { rootPath });
    assert.equal(
      initial.nodes.find((node) => node.path === rootPath + "/link").kind,
      "symlink",
    );
    await query("git.graph.metrics", { rootPath });
    await query("git.graph.metrics", { rootPath, includeBlame: true });
    await restartWorker();
    await query("git.graph.snapshot", { rootPath });
    await query("git.graph.metrics", { rootPath, includeBlame: true });
    await writeFile(
      path.join(directory, "src", "main.rs"),
      'fn main() {\n println!("native");\n}\n',
    );
    await rm(path.join(directory, "binary.dat"));
    git("add", "--", rootPath);
    git("commit", "--quiet", "-m", "Owned graph change");
    const revision = git("rev-parse", "HEAD");
    await query("git.graph.metrics", { rootPath, includeBlame: true });
    const overlay = await query("git.graph.commit-overlay", {
      revision,
      rootPath,
    });
    assert.ok(
      overlay.nodes.some(
        (node) => node.path.endsWith("binary.dat") && node.ghost,
      ),
    );
    const bounded = await query("git.graph.snapshot", {
      rootPath,
      maxNodes: 1,
    });
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.nodes.length, 1);
    assert.equal(
      await readFile(journal, "utf8"),
      before,
      "graph reads preserve managed journals",
    );
    await store.put(scope, {
      ...saved,
      state: "awaiting-user-action",
      completedAt: null,
      error: null,
    });
    const active = await readFile(journal, "utf8");
    await query("git.graph.snapshot", { rootPath });
    await query("git.graph.metrics", { rootPath });
    await query("git.graph.commit-overlay", { revision, rootPath });
    assert.equal(
      await readFile(journal, "utf8"),
      active,
      "graph reads stay available during active operations",
    );
  } finally {
    await store.put(scope, saved);
    // workspace-smoke owns this mkdtemp checkout and its complete Git history.
    git("reset", "--hard", oldHead);
    if (held) git("stash", "pop");
    assert.equal(
      git("status", "--porcelain=v1"),
      oldStatus,
      "owned fixture state restored",
    );
  }
}
