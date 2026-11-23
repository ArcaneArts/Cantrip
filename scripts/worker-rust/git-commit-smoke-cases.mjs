import { nodeGit } from "./git-node-reference.mjs";
// Encrypted commit mutations and durable conflict recovery in the real worker.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function verifyCommitActions({
  operation,
  checkout,
  restartWorker,
  store,
  scope,
  journal,
}) {
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (file, value) => writeFile(path.join(checkout, file), value);
  async function preview(action) {
    const source = await nodeGit(checkout, "git.commit.action.preview", {
      action,
    });
    const native = await operation({
      type: "git.commit.action.preview",
      arguments: { action },
    });
    assert.deepEqual(
      native,
      { ok: true, result: source },
      "exact Node/native commit preview and token",
    );
    return source;
  }
  async function apply(plan) {
    const result = await operation({
      type: "git.commit.action.apply",
      arguments: { action: plan.action, token: plan.token },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.result;
  }
  git(
    "stash",
    "push",
    "--include-untracked",
    "-m",
    "native commit smoke dirty sentinel",
  );
  try {
    const oldRecord = await readFile(journal, "utf8");
    let plan = await preview({
      type: "amend",
      message: "Native reviewed amend 🧙",
    });
    const head = git("rev-parse", "HEAD");
    const rejected = await operation({
      type: "git.commit.action.apply",
      arguments: { action: plan.action, token: "0".repeat(64) },
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /changed after this preview/u);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(await readFile(journal, "utf8"), oldRecord);
    await restartWorker();
    const amended = await apply(plan);
    assert.equal(amended.operation, null);
    assert.equal(git("rev-parse", amended.checkpointRef), head);
    assert.equal(
      git("show", "-s", "--format=%s", "HEAD"),
      "Native reviewed amend 🧙",
    );
    assert.equal(
      await readFile(journal, "utf8"),
      oldRecord,
      "amend creates no managed operation",
    );
    const target = git("rev-parse", "HEAD");
    await write("native-fixup.txt", "native staged fixup\n");
    git("add", "native-fixup.txt");
    const fixed = await apply(
      await preview({ type: "fixup", revision: target }),
    );
    assert.equal(fixed.operation, null);
    assert.equal(
      git("show", "-s", "--format=%s", "HEAD"),
      "fixup! Native reviewed amend 🧙",
    );
    const base = git("rev-parse", "HEAD"),
      branch = git("branch", "--show-current"),
      file = "native-commit-conflict.txt";
    await write(file, "base\n");
    git("add", file);
    git("commit", "--quiet", "-m", "Conflict base");
    git("checkout", "--quiet", "-b", "native-reviewed-cherry");
    await write(file, "incoming\n");
    git("commit", "--quiet", "-am", "Incoming cherry");
    const incoming = git("rev-parse", "HEAD");
    git("checkout", "--quiet", branch);
    await write(file, "ours\n");
    git("commit", "--quiet", "-am", "Our cherry conflict");
    plan = await preview({
      type: "cherryPick",
      selection: { type: "commits", revisions: [incoming] },
    });
    assert.equal(plan.wouldConflict, true);
    const cherry = await apply(plan);
    assert.equal(cherry.operation.state, "conflicted");
    let record = await store.get(scope);
    assert.equal(record.type, "cherry-pick");
    assert.equal(record.state, "conflicted");
    assert.notEqual(record.id, JSON.parse(oldRecord).id);
    assert.deepEqual(record.pendingCommits, [incoming]);
    assert.deepEqual(record.conflictedPaths, [file]);
    const held = await readFile(journal, "utf8");
    assert.deepEqual(
      await operation({
        type: "git.commit.action.preview",
        arguments: { action: { type: "amend", message: "blocked" } },
      }),
      { ok: false, error: "Finish or abort the active Git operation first." },
    );
    assert.equal(await readFile(journal, "utf8"), held);
    await restartWorker();
    const request = {
      path: file,
      strategy: "manual",
      content: "resolved native cherry\n",
    };
    const resolution = await operation({
      type: "git.conflicts.preview",
      arguments: { request },
    });
    assert.equal(resolution.ok, true, JSON.stringify(resolution));
    const resolved = await operation({
      type: "git.conflicts.apply",
      arguments: { request, token: resolution.result.token },
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    await restartWorker();
    const completed = await operation({
      type: "git.operation.control",
      arguments: { operationId: record.id, action: "continue" },
    });
    assert.equal(completed.ok, true, JSON.stringify(completed));
    assert.equal(completed.result.operation.state, "completed");
    assert.equal(completed.result.operation.id, record.id);
    assert.equal(git("show", `HEAD:${file}`), "resolved native cherry");
    // A completed revert creates its own new durable identity and survives reopen.
    await write("native-revert.txt", "revert me\n");
    git("add", "native-revert.txt");
    git("commit", "--quiet", "-m", "Revert fixture");
    const revision = git("rev-parse", "HEAD");
    const reverted = await apply(
      await preview({ type: "revert", revision, mainlineParent: null }),
    );
    assert.equal(reverted.operation.state, "completed");
    const revertRecord = await store.get(scope);
    assert.equal(revertRecord.type, "revert");
    assert.equal(revertRecord.state, "completed");
    assert.notEqual(revertRecord.id, record.id);
    assert.deepEqual(revertRecord.pendingCommits, []);
    await restartWorker();
    const current = await operation({
      type: "git.operation.current",
      arguments: {},
    });
    assert.deepEqual(current, {
      ok: true,
      result: { operation: revertRecord },
    });
    assert.notEqual(git("rev-parse", "HEAD"), base);
  } finally {
    git("stash", "pop");
  }
}
