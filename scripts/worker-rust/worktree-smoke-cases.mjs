// Real desktop/server APIs drive the production native worktree manager.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
import { WorkerRoutingRegistry } from "../../tests/reference-node-worker/src/routing-registry.ts";
import { WorktreeManager } from "../../tests/reference-node-worker/src/worktrees.ts";
import { RepositoryManagedOperationStore } from "../../tests/reference-node-worker/src/repository-managed-operation-store.ts";
export async function verifyNativeWorktrees({
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
  const prefix = "/api/projects/" + projectId + "/worktrees";
  const reference = new WorktreeManager(workerDirectory);
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const originalStatus = git("status", "--porcelain=v1"),
    originalHead = git("rev-parse", "HEAD");
  const initial = await call("GET", prefix);
  assert.equal(initial.status, 200, JSON.stringify(initial));
  const primary = initial.body.find(
    (worktree) => worktree.workerId === workerId && worktree.isPrimary,
  );
  assert.ok(primary);
  const store = new RepositoryManagedOperationStore(workerDirectory);
  const scope = {
    serverId,
    ownerId,
    workerId,
    projectId,
    worktreeId: primary.id,
  };
  const saved = await store.get(scope);
  async function safe(method, route, body) {
    const result = await call(method, route, body);
    const serialized = JSON.stringify(result.body);
    assert.equal(
      serialized.includes(checkout),
      false,
      "public results keep source paths private",
    );
    assert.equal(
      serialized.includes(workerDirectory),
      false,
      "public results keep managed paths private",
    );
    return result;
  }
  async function resolved(wire) {
    const registry = new WorkerRoutingRegistry(workerDirectory);
    const values = {
      path: wire.path,
      branch: wire.branch,
      lockReason: wire.lockReason,
    };
    return { ...wire, ...(await registry.resolveMetadata(values)) };
  }
  async function status(id) {
    const context = {
      serverId,
      projectId,
      worktreeId: id,
      operationId: crypto.randomUUID(),
      direction: "request",
    };
    const plain = new TextEncoder().encode(
      JSON.stringify(
        p.repositoryOperationRequestContentSchema.parse({
          type: "worktree.status",
          arguments: {
            sourcePath: "/untrusted-source",
            worktreePath: "/untrusted-target",
          },
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
    const response = await safe(
      "POST",
      prefix + "/" + id + "/repository-operation",
      {
        operationId: context.operationId,
        protectedRequest,
        access: "read",
        agent: false,
      },
    );
    assert.equal(response.status, 200, JSON.stringify(response));
    const opened = await c.decryptRepositoryOperationPayload({
      ownerId,
      context: { ...context, direction: "response" },
      keyRevision: 1,
      componentKey,
      opaque: response.body.protectedResponse,
    });
    let result;
    try {
      result = p.repositoryOperationOutcomeContentSchema.parse(
        JSON.parse(new TextDecoder().decode(opened)),
      );
    } finally {
      opened.fill(0);
    }
    assert.equal(result.ok, true, JSON.stringify(result));
    const expected = await reference.status(
      checkout,
      result.result.worktree.path,
    );
    assert.deepEqual(
      result.result,
      expected,
      "encrypted worktree status matches actual Node manager",
    );
    return result.result;
  }
  async function create(name, mode) {
    const fields = {
      name,
      ...(mode.type === "detached"
        ? { revision: mode.revision }
        : { branch: mode.branch }),
    };
    const values = await registerMetadata(projectId, fields);
    const protectedMode =
      mode.type === "detached"
        ? { type: "detached", revision: values.revision }
        : mode.type === "existingBranch"
          ? { type: "existingBranch", branch: values.branch }
          : { type: "newBranch", branch: values.branch, startPoint: null };
    const result = await safe("POST", prefix, {
      name: values.name,
      mode: protectedMode,
      sourceWorktreeId: primary.id,
    });
    assert.equal(result.status, 201, JSON.stringify(result));
    assert.notEqual(result.body.id, primary.id);
    const privateState = await status(result.body.id);
    const wire = await resolved(result.body);
    assert.equal(wire.path, privateState.worktree.path);
    assert.equal(privateState.worktree.managed, true);
    return { ...result.body, privateState };
  }
  try {
    await status(primary.id);
    await store.put(scope, {
      ...saved,
      state: "awaiting-user-action",
      completedAt: null,
      error: null,
    });
    const active = await store.get(scope);
    await status(primary.id);
    assert.deepEqual(
      await store.get(scope),
      active,
      "read-only status preserves active managed operations",
    );
    await store.put(scope, saved);
    const branch = "native-worktree-private";
    const created = await create("Native Worktree 🧙", {
      type: "newBranch",
      branch,
    });
    const target = created.privateState.worktree.path;
    const reason = "Private native worktree reason";
    const protectedReason = await registerMetadata(projectId, {
      lockReason: reason,
    });
    const locked = await safe("POST", prefix + "/" + created.id + "/lock", {
      reason: protectedReason.lockReason,
    });
    assert.equal(locked.status, 200, JSON.stringify(locked));
    assert.equal((await status(created.id)).worktree.lockReason, reason);
    const blocked = await safe("DELETE", prefix + "/" + created.id, {
      force: true,
      allowExternal: false,
    });
    assert.ok(
      blocked.status >= 400 && blocked.status < 500,
      JSON.stringify(blocked),
    );
    assert.equal(
      (await readFile(path.join(target, ".git"), "utf8")).startsWith("gitdir:"),
      true,
    );
    await restartWorker();
    assert.equal((await status(created.id)).worktree.locked, true);
    const unlocked = await safe(
      "POST",
      prefix + "/" + created.id + "/unlock",
      {},
    );
    assert.equal(unlocked.status, 200, JSON.stringify(unlocked));
    await writeFile(
      path.join(target, "private-dirty.txt"),
      "private owned worktree state\n",
    );
    assert.ok(
      (await status(created.id)).status.files.some(
        (file) => file.path === "private-dirty.txt",
      ),
    );
    const dirty = await safe("DELETE", prefix + "/" + created.id, {
      force: false,
      allowExternal: false,
    });
    assert.ok(dirty.status >= 400 && dirty.status < 500, JSON.stringify(dirty));
    assert.equal(
      await readFile(path.join(target, "private-dirty.txt"), "utf8"),
      "private owned worktree state\n",
    );
    const removed = await safe("DELETE", prefix + "/" + created.id, {
      force: true,
      allowExternal: false,
    });
    assert.equal(removed.status, 200, JSON.stringify(removed));
    await assert.rejects(readFile(path.join(target, ".git")), {
      code: "ENOENT",
    });
    assert.ok(git("show-ref", "--verify", "refs/heads/" + branch));
    const existing = await create("Existing native branch", {
      type: "existingBranch",
      branch,
    });
    assert.equal(
      (
        await safe("DELETE", prefix + "/" + existing.id, {
          force: false,
          allowExternal: false,
        })
      ).status,
      200,
    );
    const detached = await create("Detached native branch", {
      type: "detached",
      revision: "HEAD",
    });
    assert.equal(detached.privateState.worktree.detached, true);
    // Only this test-owned physical worktree is removed to leave stale Git metadata.
    await rm(detached.privateState.worktree.path, {
      recursive: true,
      force: true,
    });
    const reconciled = await safe("POST", prefix + "/reconcile", {});
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled));
    const pruned = await safe("POST", prefix + "/prune", {
      allowExternal: false,
    });
    assert.equal(pruned.status, 200, JSON.stringify(pruned));
    assert.ok(
      !(await reference.list(checkout)).worktrees.some(
        (worktree) => worktree.path === detached.privateState.worktree.path,
      ),
    );
    assert.equal(git("rev-parse", "HEAD"), originalHead);
    assert.equal(git("status", "--porcelain=v1"), originalStatus);
    assert.deepEqual(
      await store.get(scope),
      saved,
      "worktree lifecycle preserves the primary operation journal",
    );
  } finally {
    reference.close();
    if (saved) await store.put(scope, saved);
  }
}
