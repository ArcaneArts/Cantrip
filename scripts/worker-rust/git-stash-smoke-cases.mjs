import { nodeGit } from "./git-node-reference.mjs";
// Real encrypted stash operations, persisted checkpoints and restart recovery.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  readGitStashes,
  readGitStashFileDiff,
} from "../../cantrip_worker/src/git.ts";
export async function verifyStashes({
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
  const request = (
    includeStaged = true,
    includeUnstaged = true,
    includeUntracked = true,
  ) => ({
    message: "Native encrypted stash 🧙",
    includeStaged,
    includeUnstaged,
    includeUntracked,
  });
  async function create(selection = request()) {
    const result = await operation({
      type: "git.stash.create",
      arguments: { request: selection },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.result;
  }
  async function preview(stash, type) {
    const action = { type, ref: stash.ref, hash: stash.hash };
    const source = await nodeGit(checkout, "git.stash.action.preview", {
      action,
    });
    const result = await operation({
      type: "git.stash.action.preview",
      arguments: { action },
    });
    assert.deepEqual(
      result,
      { ok: true, result: source },
      "exact Node/native stash preview and token",
    );
    return source;
  }
  async function apply(plan) {
    const result = await operation({
      type: "git.stash.action.apply",
      arguments: { action: plan.action, token: plan.token },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.result;
  }
  async function list() {
    const result = await operation({ type: "git.stash.list", arguments: {} });
    assert.deepEqual(result, {
      ok: true,
      result: await readGitStashes(checkout),
    });
    return result.result;
  }
  git(
    "stash",
    "push",
    "--include-untracked",
    "-m",
    "native stash smoke dirty sentinel",
  );
  try {
    const old = await readFile(journal, "utf8");
    const staged = "native-stash-staged.txt",
      file = "native-stash-conflict.txt",
      loose = "native-stash-untracked.txt";
    await write(staged, "base staged\n");
    await write(file, "base\n");
    git("add", staged, file);
    git("commit", "--quiet", "-m", "Native stash base");
    await write(staged, "retained staged\n");
    git("add", staged);
    await write(file, "shelved text\n");
    await write(loose, "shelved untracked\n");
    const shelf = await create(request(false, true, true));
    assert.equal(shelf.operation, null);
    assert.equal(await readFile(path.join(checkout, file), "utf8"), "base\n");
    assert.equal(git("show", `:${staged}`), "retained staged");
    await assert.rejects(readFile(path.join(checkout, loose)), {
      code: "ENOENT",
    });
    assert.equal(await readFile(journal, "utf8"), old);
    await restartWorker();
    assert.ok((await list()).stashes.some((s) => s.hash === shelf.stash.hash));
    const diff = await operation({
      type: "git.stash.diff",
      arguments: { hash: shelf.stash.hash, path: file, contextLines: 0 },
    });
    assert.deepEqual(diff, {
      ok: true,
      result: await readGitStashFileDiff(checkout, shelf.stash.hash, file, 0),
    });
    const popped = await apply(await preview(shelf.stash, "pop"));
    assert.equal(popped.operation, null);
    assert.equal(
      await readFile(path.join(checkout, loose), "utf8"),
      "shelved untracked\n",
    );
    assert.equal(await readFile(journal, "utf8"), old);
    // Commit restored fixture changes, then create an incoming conflicting stash.
    git("add", "-A");
    git("commit", "--quiet", "-m", "Restored shelf fixture");
    await write(file, "incoming stash\n");
    const incoming = (await create()).stash;
    await write(file, "upstream\n");
    git("add", file);
    git("commit", "--quiet", "-m", "Stash upstream");
    const privateFile = "native-stash-private.txt",
      localFile = "native-stash-local.txt";
    await write(privateFile, "private untracked stays\n");
    await write(localFile, "local staged stays\n");
    git("add", localFile);
    let plan = await preview(incoming, "apply");
    assert.equal(plan.warnings.length, 1);
    const rejected = await operation({
      type: "git.stash.action.apply",
      arguments: { action: plan.action, token: "0".repeat(64) },
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /no longer match this preview/u);
    assert.equal(await readFile(journal, "utf8"), old);
    const conflicted = await apply(plan);
    assert.deepEqual(conflicted.conflictedPaths, [file]);
    assert.equal(conflicted.operation.state, "conflicted");
    const record = await store.get(scope);
    assert.equal(record.type, "stash");
    assert.equal(record.sourceRevision, incoming.hash);
    assert.notEqual(record.id, JSON.parse(old).id);
    assert.match(record.checkpointRef, /-dirty$/u);
    const held = await readFile(journal, "utf8");
    assert.deepEqual(
      await operation({
        type: "git.stash.create",
        arguments: { request: request() },
      }),
      { ok: false, error: "Finish or abort the active Git operation first." },
    );
    assert.equal(await readFile(journal, "utf8"), held);
    await restartWorker();
    const aborted = await operation({
      type: "git.operation.control",
      arguments: { operationId: record.id, action: "abort" },
    });
    assert.equal(aborted.ok, true, JSON.stringify(aborted));
    assert.equal(aborted.result.operation.state, "aborted");
    assert.equal(
      await readFile(path.join(checkout, file), "utf8"),
      "upstream\n",
    );
    assert.equal(
      await readFile(path.join(checkout, privateFile), "utf8"),
      "private untracked stays\n",
    );
    assert.equal(git("show", `:${localFile}`), "local staged stays");
    assert.ok((await list()).stashes.some((s) => s.hash === incoming.hash));
    plan = await preview(incoming, "pop");
    const again = await apply(plan);
    assert.deepEqual(again.conflictedPaths, [file]);
    const current = await store.get(scope);
    assert.notEqual(current.id, record.id);
    await restartWorker();
    const resolution = {
      path: file,
      strategy: "manual",
      content: "resolved native stash\n",
    };
    const review = await operation({
      type: "git.conflicts.preview",
      arguments: { request: resolution },
    });
    assert.equal(review.ok, true, JSON.stringify(review));
    const resolved = await operation({
      type: "git.conflicts.apply",
      arguments: { request: resolution, token: review.result.token },
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    await restartWorker();
    const continued = await operation({
      type: "git.operation.control",
      arguments: { operationId: current.id, action: "continue" },
    });
    assert.equal(continued.ok, true, JSON.stringify(continued));
    assert.equal(continued.result.operation.state, "completed");
    assert.equal(continued.result.operation.id, current.id);
    assert.equal(
      (await list()).stashes.some((s) => s.hash === incoming.hash),
      false,
    );
    assert.equal(git("show", `:${file}`), "resolved native stash");
    assert.equal(
      await readFile(path.join(checkout, privateFile), "utf8"),
      "private untracked stays\n",
    );
    await restartWorker();
    assert.deepEqual(
      await operation({ type: "git.operation.current", arguments: {} }),
      { ok: true, result: { operation: await store.get(scope) } },
    );
  } finally {
    git("stash", "pop");
  }
}
