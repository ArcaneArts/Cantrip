import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as crypto from "../../packages/crypto/dist/index.js";
import { workerHeartbeatSchema } from "../../packages/protocol/dist/index.js";

export async function verifyProjectExport({
  call,
  origin,
  projectId,
  workerId,
  workerDirectory,
  userHome,
  codexHome,
  master,
  ownerId,
  restartWorker,
  checkout,
}) {
  const list = await call("GET", `/api/projects/${projectId}/worktrees`);
  assert.equal(list.status, 200, JSON.stringify(list));
  const worktree = list.body.find(
    (tree) => tree.isPrimary && tree.workerId === workerId,
  );
  assert.ok(worktree, JSON.stringify(list));
  const identity = JSON.parse(
    await readFile(
      path.join(workerDirectory, "worker-encryption-key.json"),
      "utf8",
    ),
  );
  const { credential } = JSON.parse(
    await readFile(
      path.join(workerDirectory, "worker-credential.json"),
      "utf8",
    ),
  );
  async function enableFixtureExport() {
    const workers = await call("GET", "/api/workers");
    assert.equal(workers.status, 200, JSON.stringify(workers));
    const worker = workers.body.find((record) => record.workerId === workerId);
    assert.ok(worker, "The enrolled Rust worker is online");
    // This fixture exercises the real Core relay before the companion import
    // port can advertise the shared capability in the production heartbeat.
    const response = await fetch(origin() + "/api/internal/workers/heartbeat", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        workerHeartbeatSchema.parse({ ...worker, externalCodexHistory: true }),
      ),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 202);
  }
  async function grant(component) {
    const componentKey = crypto.deriveComponentKey({
      accountMasterKey: master,
      ownerId,
      component,
      keyRevision: 1,
    });
    const wrappedKey = await crypto.wrapComponentKeyForWorker({
      ownerId,
      workerId,
      component,
      keyRevision: 1,
      componentKey,
      workerPublicKey: identity.publicKey,
    });
    const granted = await call(
      "POST",
      `/api/encryption/principals/${identity.principalId}/grants`,
      {
        component,
        keyRevision: 1,
        wrappedKey,
      },
    );
    assert.equal(granted.status, 201, JSON.stringify(granted));
    const refreshed = await call(
      "POST",
      `/api/workers/${workerId}/encryption/refresh`,
      {
        component,
        keyRevision: 1,
      },
    );
    assert.equal(
      refreshed.body.status.state,
      "ready",
      JSON.stringify(refreshed),
    );
    return componentKey;
  }
  const labelKey = await grant("private-surface-metadata");
  const chatKey = await grant("chat-content");
  try {
    const chatId = randomUUID();
    const title = "Private exported fixture";
    const endpoint = `/api/projects/${projectId}`;
    const created = await call("POST", endpoint + "/chats", {
      id: chatId,
      autoTitle: false,
      titleProtection: await crypto.encryptPrivateDisplayLabel({
        ownerId,
        keyRevision: 1,
        recordKind: "chat",
        rowId: chatId,
        componentKey: labelKey,
        label: title,
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    const messages = `/api/chats/${chatId}/messages`;
    async function append(role, text) {
      const messageId = randomUUID();
      const classification = { role, mode: "default", attachmentIds: [] };
      const response = await call("POST", messages, {
        id: messageId,
        idempotencyKey: randomUUID(),
        classification,
        reasoningEffort: null,
        protectedContent: await crypto.encryptChatMessageProtectedContent({
          ownerId,
          messageId,
          keyRevision: 1,
          componentKey: chatKey,
          content: {
            version: 1,
            classification,
            content: [{ type: "text", text }],
          },
        }),
      });
      assert.equal(response.status, 201, JSON.stringify(response));
    }
    const input = "Private export fixture question 🌲";
    const output = "Private export fixture answer";
    await append("user", input);
    // The encrypted message exceeds one 256 KiB worker command chunk.
    const largeAnswer = `${output}\n${"bounded export evidence\n".repeat(9_000)}end of fixture answer`;
    await append("assistant", largeAnswer);
    const before = await call("GET", messages);
    assert.equal(before.status, 200);
    const target = { kind: "codex-local" };
    const worktreeId = worktree.id;
    await enableFixtureExport();
    const preview = await call("POST", endpoint + "/exports/preview", {
      target,
      worktreeId,
    });
    assert.equal(preview.status, 200, JSON.stringify(preview));
    assert.equal(preview.body.available, true, JSON.stringify(preview));
    assert.equal(preview.body.destinationLabel, "$CODEX_HOME");
    const operationId = randomUUID();
    const request = { operationId, target, worktreeId, chatIds: [chatId] };
    async function exportChat() {
      await enableFixtureExport();
      const response = await call("POST", endpoint + "/exports", request);
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.equal(response.body.outcomes.length, 1);
      assert.equal(JSON.stringify(response.body).includes(checkout), false);
      assert.equal(JSON.stringify(response.body).includes(input), false);
      return response.body.outcomes[0];
    }
    const first = await exportChat();
    assert.equal(first.status, "exported", JSON.stringify(first));
    assert.equal(first.reused, false);
    assert.equal(first.messageCount, 2);
    const leaf = createHash("sha256").update(chatId).digest("hex");
    const journal = path.join(
      workerDirectory,
      "project-exports",
      operationId,
      leaf,
    );
    const receiptText = await readFile(
      path.join(journal, "state.json"),
      "utf8",
    );
    assert.equal(JSON.parse(receiptText).threadId, first.threadId);
    assert.equal(JSON.parse(receiptText).status, "exported");
    assert.ok(!receiptText.includes(title) && !receiptText.includes(input));
    await assert.rejects(lstat(path.join(journal, "transcript.uploading")), {
      code: "ENOENT",
    });
    await assert.rejects(
      lstat(path.join(userHome, ".cursor", "projects", ".cantrip-exports")),
      { code: "ENOENT" },
    );
    const sessions = path.join(codexHome, "sessions");
    const artifacts = (await readdir(sessions, { recursive: true })).filter(
      (name) => name.endsWith(".jsonl"),
    );
    assert.equal(artifacts.length, 1);
    const transcript = await readFile(
      path.join(sessions, artifacts[0]),
      "utf8",
    );
    assert.ok(
      transcript.includes(input) &&
        transcript.includes(output) &&
        transcript.includes("end of fixture answer"),
    );
    assert.deepEqual(await call("GET", messages), before);
    await restartWorker();
    const replay = await exportChat();
    assert.deepEqual(replay, { ...first, reused: true });
    await append("user", "A later message changes the export identity");
    const conflict = await exportChat();
    assert.equal(conflict.status, "failed", JSON.stringify(conflict));
    assert.match(conflict.message, /associated with different source data/u);
    assert.deepEqual(
      (await readdir(sessions, { recursive: true })).filter((name) =>
        name.endsWith(".jsonl"),
      ),
      artifacts,
    );
  } finally {
    labelKey.fill(0);
    chatKey.fill(0);
  }
}
