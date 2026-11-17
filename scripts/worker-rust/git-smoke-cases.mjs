// Production encrypted repository operations against the owned smoke checkout.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
export async function verifyGit({
  call,
  ownerId,
  serverId,
  componentKey,
  projectId,
  workerId,
  workerDirectory,
  checkout,
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
      access: "read",
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
  };
}
