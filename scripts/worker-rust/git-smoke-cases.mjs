// Production encrypted repository operations against the owned smoke checkout.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createHash } from "node:crypto";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
import {
  managedOperationRecord,
  RepositoryManagedOperationStore,
} from "../../cantrip_worker/src/repository-managed-operation-store.ts";
export async function verifyGit({
  call,
  ownerId,
  serverId,
  componentKey,
  projectId,
  workerId,
  workerDirectory,
  checkout,
  restartWorker,
}) {
  const worktrees = await call("GET", `/api/projects/${projectId}/worktrees`);
  assert.equal(worktrees.status, 200, JSON.stringify(worktrees));
  const worktree = worktrees.body.find(
    (tree) => tree.workerId === workerId && tree.isPrimary,
  );
  assert.ok(worktree, JSON.stringify(worktrees));
  const worktreeId = worktree.id;
  async function operation(content, override = {}, expectedStatus = 200) {
    const context = {
      serverId,
      projectId,
      worktreeId,
      operationId: crypto.randomUUID(),
      direction: "request",
    };
    const plaintext = new TextEncoder().encode(
      JSON.stringify(p.repositoryOperationRequestContentSchema.parse(content)),
    );
    let protectedRequest;
    try {
      protectedRequest = await c.encryptRepositoryOperationPayload({
        ownerId,
        context,
        keyRevision: 1,
        componentKey,
        plaintext,
      });
    } finally {
      plaintext.fill(0);
    }
    const body = {
      operationId: context.operationId,
      protectedRequest,
      access: p.repositoryOperationAccess(content.type),
      agent: false,
      ...override,
    };
    const response = await call(
      "POST",
      `/api/projects/${projectId}/worktrees/${worktreeId}/repository-operation`,
      body,
    );
    assert.equal(response.status, expectedStatus, JSON.stringify(response));
    if (expectedStatus !== 200) return response.body;
    assert.equal(JSON.stringify(response.body).includes(checkout), false);
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
  const status = await operation({
    type: "git.status",
    arguments: { cwd: "/untrusted-overridden" },
  });
  assert.equal(status.ok, true, JSON.stringify(status));
  const checked = p.gitStatusSchema.parse(status.result);
  assert.equal(checked.branch, "main");
  assert.ok(checked.files.some((file) => file.path === "untouched.txt"));
  const diff = await operation({
    type: "git.diff",
    arguments: { path: "untouched.txt", scope: "unstaged", contextLines: 0 },
  });
  assert.equal(diff.ok, true, JSON.stringify(diff));
  assert.ok(
    p.gitFileDiffSchema
      .parse(diff.result)
      .patch.includes("+private dirty content"),
  );
  const wrong = await operation(
    { type: "git.status", arguments: {} },
    { access: "write" },
    502,
  );
  // Public access metadata and authenticated inner operation must agree.
  assert.equal(wrong.error, "Repository operation access metadata is invalid.");
  const mutable = "native-action.txt",
    literal = "native-literal[ab].txt",
    sibling = "native-literala.txt";
  for (const [name, value] of Object.entries({
    "user.name": "Fixture",
    "user.email": "fixture@example.invalid",
    "commit.gpgsign": "false",
    "core.hooksPath": "/dev/null",
  }))
    execFileSync("git", ["-C", checkout, "config", name, value]);
  await writeFile(path.join(checkout, mutable), "first\n");
  async function action(action) {
    return operation({ type: "git.action", arguments: { action } });
  }
  const scope = { ownerId, serverId, workerId, projectId, worktreeId };
  const store = new RepositoryManagedOperationStore(workerDirectory);
  const workerStatus = async () => {
    const outcome = await operation({ type: "git.status", arguments: {} });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    return p.gitStatusSchema.parse(outcome.result);
  };
  const active = managedOperationRecord({
    scope,
    state: {
      type: "merge",
      state: "conflicted",
      originalHead: checked.head,
      currentHead: checked.head,
      sourceRef: "private/fixture",
      sourceRevision: checked.head,
      targetRef: "refs/heads/main",
      targetRevision: checked.head,
      pendingCommits: [checked.head],
      currentStep: 1,
      totalSteps: 1,
      conflictedPaths: [mutable],
      output: "private existing operation",
      checkpointRef: null,
      status: await workerStatus(),
    },
  });
  await store.put(scope, active);
  assert.deepEqual(await action({ type: "stage", paths: [mutable] }), {
    ok: false,
    error: "Finish or abort the active Git operation first.",
  });
  assert.equal(
    (await workerStatus()).files.find((file) => file.path === mutable).staged,
    false,
  );
  await store.put(
    scope,
    managedOperationRecord({
      existing: active,
      scope,
      state: { ...active, state: "completed" },
    }),
  );
  const staged = await action({ type: "stage", paths: [mutable] });
  assert.equal(staged.ok, true, JSON.stringify(staged));
  assert.equal(
    p.gitActionResultSchema
      .parse(staged.result)
      .status.files.find((file) => file.path === mutable).staged,
    true,
  );
  const unstaged = await action({ type: "unstage", paths: [mutable] });
  assert.equal(unstaged.ok, true, JSON.stringify(unstaged));
  assert.equal(
    unstaged.result.status.files.find((file) => file.path === mutable).staged,
    false,
  );
  assert.equal((await action({ type: "stage", paths: [mutable] })).ok, true);
  const committed = await action({
    type: "commit",
    message: "Native encrypted action",
    all: false,
  });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.notEqual(committed.result.status.head, checked.head);
  assert.equal(
    committed.result.status.files.find((file) => file.path === "untouched.txt")
      .staged,
    false,
  );
  await writeFile(path.join(checkout, mutable), "discard this\n");
  await writeFile(path.join(checkout, literal), "remove literal\n");
  await writeFile(path.join(checkout, sibling), "keep sibling\n");
  const discarded = await action({
    type: "discard",
    paths: [mutable, literal],
  });
  assert.equal(discarded.ok, true, JSON.stringify(discarded));
  assert.equal(await readFile(path.join(checkout, mutable), "utf8"), "first\n");
  assert.equal(
    await readFile(path.join(checkout, sibling), "utf8"),
    "keep sibling\n",
  );
  await assert.rejects(readFile(path.join(checkout, literal)), {
    code: "ENOENT",
  });
  await rm(path.join(checkout, sibling));
  const branch = await action({
    type: "createBranch",
    name: "native-encrypted",
  });
  assert.equal(branch.ok, true, JSON.stringify(branch));
  assert.equal(branch.result.status.branch, "native-encrypted");
  const switched = await action({ type: "checkout", branch: "main" });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  assert.equal(switched.result.status.branch, "main");
  assert.deepEqual(await action({ type: "push" }), {
    ok: false,
    error: "This repository has no Git remote.",
  });
  const directory = path.join(workerDirectory, "repository-operations");
  await mkdir(directory, { recursive: true });
  const key = createHash("sha256")
    .update(
      JSON.stringify([serverId, ownerId, workerId, projectId, worktreeId]),
    )
    .digest("hex");
  const journal = path.join(directory, key + ".json");
  await writeFile(journal, "{malformed-owned-fixture");
  const invalid = await operation({ type: "git.status", arguments: {} });
  assert.deepEqual(invalid, {
    ok: false,
    error: "Stored repository operation is invalid.",
  });
  assert.equal(await readFile(journal, "utf8"), "{malformed-owned-fixture");
  return async () => {
    const reopened = await operation({ type: "git.status", arguments: {} });
    assert.deepEqual(
      reopened,
      invalid,
      "restart preserves an invalid journal rather than resetting it",
    );
    await store.put(scope, active);
    const before = await readFile(journal, "utf8");
    await restartWorker();
    assert.equal(
      await readFile(journal, "utf8"),
      before,
      "legacy active record survives native restart byte-for-byte",
    );
    assert.deepEqual(await action({ type: "stageAll" }), {
      ok: false,
      error: "Finish or abort the active Git operation first.",
    });
    assert.equal(
      (await workerStatus()).files.find((file) => file.path === "untouched.txt")
        .staged,
      false,
    );
  };
}
