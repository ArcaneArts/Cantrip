// Encrypted client APIs -> actual Rust worker/server, including peer authority
// and a retained transfer conflict journal reopened after worker restart.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
import { WorkerRoutingRegistry } from "../../cantrip_worker/src/routing-registry.ts";
import { RepositoryManagedOperationStore } from "../../cantrip_worker/src/repository-managed-operation-store.ts";
import { nodeGit } from "./git-node-reference.mjs";
export async function verifyWorktreeRecovery({
  call,
  ownerId,
  serverId,
  componentKey,
  projectId,
  workerId,
  workerDirectory,
  checkout,
  restartWorker,
  registerMetadata,
}) {
  const prefix = `/api/projects/${projectId}/worktrees`;
  const inventory = await call("GET", prefix);
  assert.equal(inventory.status, 200, JSON.stringify(inventory));
  const primary = inventory.body.find(
    (tree) => tree.isPrimary && tree.workerId === workerId,
  );
  assert.ok(primary);
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  const source = (...args) => git(checkout, ...args);
  const originalHead = source("rev-parse", "HEAD"),
    originalStatus = source("status", "--porcelain=v1");
  const initial = await nodeGit(checkout, "git.stash.list", {});
  source(
    "stash",
    "push",
    "--include-untracked",
    "-m",
    "native worktree recovery fixture sentinel",
  );
  const saved = (await nodeGit(checkout, "git.stash.list", {})).stashes.find(
    (stash) => !initial.stashes.some((old) => old.hash === stash.hash),
  );
  assert.ok(saved);
  const file = "native-move-conflict.txt",
    untracked = "native-move-untracked.txt";
  let target;
  async function operation(id, type, arguments_, peerWorktreeId) {
    const operationId = crypto.randomUUID();
    const context = {
      serverId,
      projectId,
      worktreeId: id,
      operationId,
      direction: "request",
    };
    const plain = new TextEncoder().encode(
      JSON.stringify(
        p.repositoryOperationRequestContentSchema.parse({
          type,
          arguments: arguments_,
        }),
      ),
    );
    let protectedRequest;
    try {
      protectedRequest = await c.encryptRepositoryOperationPayload({
        ownerId,
        context,
        keyRevision: 1,
        componentKey,
        plaintext: plain,
      });
    } finally {
      plain.fill(0);
    }
    const response = await call(
      "POST",
      `${prefix}/${id}/repository-operation`,
      {
        operationId,
        protectedRequest,
        access: p.repositoryOperationAccess(type),
        agent: false,
        ...(peerWorktreeId ? { peerWorktreeId } : {}),
      },
    );
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(JSON.stringify(response).includes(checkout), false);
    const opened = await c.decryptRepositoryOperationPayload({
      ownerId,
      context: { ...context, direction: "response" },
      keyRevision: 1,
      componentKey,
      opaque: response.body.protectedResponse,
    });
    try {
      return p.repositoryOperationOutcomeContentSchema.parse(
        JSON.parse(new TextDecoder().decode(opened)),
      );
    } finally {
      opened.fill(0);
    }
  }
  try {
    await writeFile(path.join(checkout, file), "base\n");
    source("add", file);
    source("commit", "--quiet", "-m", "Move base");
    const metadata = await registerMetadata(projectId, {
      name: "Native transfer target",
      branch: "native-transfer-target",
    });
    const created = await call("POST", prefix, {
      sourceWorktreeId: primary.id,
      name: metadata.name,
      mode: { type: "newBranch", branch: metadata.branch, startPoint: null },
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    const resolved = await new WorkerRoutingRegistry(
      workerDirectory,
    ).resolveMetadata({ path: created.body.path });
    target = { id: created.body.id, path: resolved.path };
    const store = new RepositoryManagedOperationStore(workerDirectory);
    const scope = {
      serverId,
      ownerId,
      workerId,
      projectId,
      worktreeId: target.id,
    };
    const request = { sourceWorktreeId: primary.id };
    async function preview() {
      source("status", "--porcelain=v1");
      source("diff", "--binary", "--no-ext-diff", "HEAD");
      const expected = await nodeGit(
        target.path,
        "git.worktree.changes.preview",
        { sourceCwd: checkout, request },
      );
      const actual = await operation(
        target.id,
        "git.worktree.changes.preview",
        { request, sourceCwd: "/untrusted-ciphertext-source" },
        primary.id,
      );
      assert.deepEqual(
        actual,
        { ok: true, result: expected },
        "exact Source/native encrypted preview and token",
      );
      return expected;
    }
    await writeFile(path.join(checkout, file), "staged transfer\n");
    source("add", file);
    await writeFile(path.join(checkout, untracked), "untracked transfer\n");
    let plan = await preview();
    assert.equal(plan.wouldConflict, false);
    const mismatched = await operation(
      target.id,
      "git.worktree.changes.preview",
      { request: { sourceWorktreeId: "wrong-source" } },
      primary.id,
    );
    assert.deepEqual(mismatched, {
      ok: false,
      error:
        "The protected source worktree does not match the routed peer worktree.",
    });
    const unrelated = await operation(
      target.id,
      "git.recovery.list",
      { kind: "reflog", limit: 1, cursor: 0 },
      primary.id,
    );
    assert.deepEqual(unrelated, {
      ok: false,
      error: "A peer worktree is only valid for a worktree changes move.",
    });
    const rejected = await operation(
      target.id,
      "git.worktree.changes.apply",
      { request, token: "0".repeat(64) },
      primary.id,
    );
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /changed after this preview/);
    const moved = await operation(
      target.id,
      "git.worktree.changes.apply",
      { request, token: plan.token, sourceCwd: "/untrusted-ciphertext-source" },
      primary.id,
    );
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(moved.result.operation, null);
    assert.equal(source("status", "--porcelain"), "");
    assert.equal(
      await readFile(path.join(target.path, file), "utf8"),
      "staged transfer\n",
    );
    assert.equal(
      await readFile(path.join(target.path, untracked), "utf8"),
      "untracked transfer\n",
    );
    assert.equal(await store.get(scope), null);
    async function recovery(action) {
      const expected = await nodeGit(target.path, "git.recovery.preview", {
        action,
      });
      const native = await operation(target.id, "git.recovery.preview", {
        action,
      });
      assert.deepEqual(native, { ok: true, result: expected });
      const result = await operation(target.id, "git.recovery.apply", {
        request: {
          action: expected.action,
          token: expected.token,
          confirmation: expected.confirmation,
        },
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.result;
    }
    const targetHead = git(target.path, "rev-parse", "HEAD");
    await recovery({
      type: "createBranch",
      branch: "native-recovered-ref",
      target: targetHead,
    });
    const reset = await recovery({
      type: "reset",
      mode: "hard",
      target: targetHead,
    });
    assert.equal(
      git(target.path, "rev-parse", reset.checkpointRef),
      targetHead,
    );
    await rm(path.join(target.path, untracked));
    await writeFile(path.join(target.path, file), "target branch content\n");
    git(target.path, "commit", "--quiet", "-am", "Target conflict");
    await writeFile(path.join(checkout, file), "source conflict content\n");
    plan = await preview();
    assert.equal(plan.wouldConflict, true);
    const conflicted = await operation(
      target.id,
      "git.worktree.changes.apply",
      { request, token: plan.token },
      primary.id,
    );
    assert.equal(conflicted.ok, true, JSON.stringify(conflicted));
    assert.equal(conflicted.result.operation.state, "conflicted");
    const record = await store.get(scope);
    assert.equal(record.state, "conflicted");
    assert.equal(record.sourceRef, `apply:move-${primary.id}`);
    assert.equal(record.sourceRevision, conflicted.result.stash.hash);
    assert.equal(
      git(target.path, "rev-parse", record.checkpointRef),
      plan.targetHead,
    );
    await restartWorker();
    const reopened = await operation(target.id, "git.operation.current", {});
    assert.equal(reopened.ok, true, JSON.stringify(reopened));
    assert.equal(reopened.result.operation.id, record.id);
    assert.equal(reopened.result.operation.state, "conflicted");
    const blocked = await operation(target.id, "git.recovery.apply", {
      request: {
        action: { type: "reset", mode: "hard", target: targetHead },
        token: "0".repeat(64),
        confirmation: "wrong",
      },
    });
    assert.deepEqual(blocked, {
      ok: false,
      error: "Finish or abort the active Git operation first.",
    });
    const aborted = await operation(target.id, "git.operation.control", {
      operationId: record.id,
      action: "abort",
      context: { untrusted: true },
    });
    assert.equal(aborted.ok, true, JSON.stringify(aborted));
    assert.equal(aborted.result.operation.state, "aborted");
    assert.equal(
      await readFile(path.join(target.path, file), "utf8"),
      "target branch content\n",
    );
    const candidates = await operation(target.id, "git.recovery.list", {
      kind: "reflog",
      limit: 2,
      cursor: 0,
    });
    assert.equal(candidates.ok, true, JSON.stringify(candidates));
    assert.ok(candidates.result.entries.length > 0);
    return {
      trustedPeerAndCiphertextPathOverride: true,
      encryptedReviewedTransfer: true,
      indexAndUntrackedPreserved: true,
      checkpointedRecovery: true,
      conflictJournalRestartAndAbort: true,
      activeOperationGuard: true,
    };
  } finally {
    if (target) {
      const removed = await call("DELETE", prefix + "/" + target.id, {
        allowExternal: false,
        force: true,
      });
      assert.equal(removed.status, 200, JSON.stringify(removed));
    }
    source("reset", "--hard", originalHead);
    await rm(path.join(checkout, untracked), { force: true });
    source("stash", "apply", "--index", saved.hash);
    const stash = (await nodeGit(checkout, "git.stash.list", {})).stashes.find(
      (stash) => stash.hash === saved.hash,
    );
    assert.ok(stash);
    source("stash", "drop", stash.ref);
    assert.equal(source("status", "--porcelain=v1"), originalStatus);
  }
}
