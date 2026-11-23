import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  managedQueueImportAckSchema,
  managedQueueImportSchema,
  managedQueueLookupSchema,
  managedQueueMutateSchema,
  managedQueueReadSchema,
  managedQueueStartReceiptSchema,
} from "../../packages/protocol/dist/index.js";
import { AttachmentStore } from "../../tests/reference-node-worker/src/attachment-store.ts";
import { createManagedQueueInputCodec } from "../../tests/reference-node-worker/src/managed-queue-input.ts";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../../tests/reference-node-worker/src/native-command-content.ts";

export function seedNativeQueue(home, threadId) {
  const database = path.join(home, "queue_1.sqlite");
  const source = {
    id: randomUUID(),
    input: [
      {
        type: "text",
        text: "/goal clear — retain this literally 🌳",
        text_elements: [],
      },
    ],
    clientUserMessageId: randomUUID(),
  };
  const foreign = { threadId: randomUUID(), id: randomUUID() };
  const db = new DatabaseSync(database, { timeout: 3000 });
  try {
    const insert = db.prepare(
      "INSERT INTO queued_items (id,thread_id,payload_json,queue_order,created_at_ms,updated_at_ms) VALUES (?,?,?,0,?,?)",
    );
    const payload = JSON.stringify({
      UserInput: {
        content: source.input,
        client_id: source.clientUserMessageId,
      },
    });
    const timestamp = Date.now();
    insert.run(source.id, threadId, payload, timestamp, timestamp);
    insert.run(foreign.id, foreign.threadId, payload, timestamp, timestamp);
  } finally {
    db.close();
  }
  return { source, database, foreign };
}

export function queuePeer({ identity, service, root, stamp, legacy }) {
  const { serverId, ownerId, workerId, chatId, threadId, worktreeId } =
    identity;
  const codec = createManagedQueueInputCodec({
    encryption: service,
    chatId,
    attachmentStore: new AttachmentStore(path.join(root, "queue-reference")),
    defaults: () => ({
      modelId: "gpt-5",
      reasoningEffort: null,
      mode: "default",
      worktreeId,
    }),
  });
  const saved = new Map();
  let items = [],
    revision = 0,
    claim,
    awaitingLostReply = true;
  const turn = {
    id: randomUUID(),
    items: [],
    status: "inProgress",
    error: null,
  };
  const actions = [];
  const firstRead = Promise.withResolvers();
  const imported = Promise.withResolvers();
  let retained,
    ackAttempts = 0,
    stagedSources = 0;
  function check(session, worker) {
    assert.equal(worker, workerId);
    assert.equal(session.chatId, chatId);
    assert.equal(session.threadId, threadId);
    assert.equal(session.placementId, worktreeId);
  }
  function snapshot() {
    return {
      revision,
      paused: false,
      items,
      claims: claim ? [claim] : [],
      pendingImports:
        retained?.record.status === "pending"
          ? [
              {
                importId: retained.record.importId,
                nativeItemId: retained.record.nativeItemId,
                status: "pending",
                prompt: retained.item,
              },
            ]
          : [],
    };
  }
  const receipt = (admission, options = {}) => ({
    operationId: admission.operationId,
    operationGeneration: randomUUID(),
    activationGeneration: null,
    chatId,
    threadId,
    startsExecution: false,
    executionLaneId: null,
    status: "applied",
    method: admission.method,
    payloadDigest: admission.payloadDigest,
    rejectionCode: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...options,
  });
  async function apply(action, raw, send, drop) {
    if (action === "import") {
      const input = managedQueueImportSchema.parse(raw);
      const { session, items: sources, runnerGeneration } = input;
      check(session, input.workerId);
      assert.equal(
        session.connectionId,
        `queue-owner:${session.runtimeGeneration}`,
      );
      for (const candidate of sources) {
        assert.ok(legacy, "Expected the fixture's native source only.");
        stagedSources++;
        const source = legacy.source;
        assert.equal(candidate.nativeItemId, source.id);
        const idBytes = createHash("sha256")
          .update(
            JSON.stringify([serverId, ownerId, chatId, threadId, source.id]),
          )
          .digest()
          .subarray(0, 16);
        idBytes[6] = (idBytes[6] & 15) | 64;
        idBytes[8] = (idBytes[8] & 63) | 128;
        const prompt = candidate.prompt;
        assert.equal(prompt.id.replaceAll("-", ""), idBytes.toString("hex"));
        const operationId = `queue-import:${prompt.id}`;
        const context = { chatId, operationId, direction: "request" };
        assert.deepEqual(
          await openNativeCommandContent({
            service,
            context,
            envelope: candidate.protectedSource,
          }),
          source,
        );
        const reference = await protectNativeCommandContent({
          service,
          context,
          content: source,
        });
        assert.equal(reference.digest, candidate.sourceDigest);
        const prepared = await codec.preparePrompt({
          id: prompt.id,
          request: {
            params: {
              input: source.input,
              clientUserMessageId: source.clientUserMessageId,
              managed: { operationId, action: "literal" },
            },
          },
        });
        const open = (value) =>
          codec.openNativeInput({
            promptId: value.id,
            payload: value.protectedNativeInput,
          });
        assert.deepEqual(await open(prompt), await open(prepared.prompt));
        assert.equal(prompt.executionMethod, "turn/start");
        assert.ok(!JSON.stringify(raw).includes(source.input[0].text));
        const importId = createHash("sha256")
          .update(candidate.sourceDigest)
          .digest("hex");
        retained = {
          record: {
            importId,
            nativeItemId: source.id,
            sourceDigest: candidate.sourceDigest,
            protectedSource: candidate.protectedSource,
            nativeDeleteOperationId: `queue-delete:${importId}`,
            promptId: prompt.id,
            status: "pending",
          },
          item: {
            ...prompt,
            chatId,
            attachments: candidate.attachments,
            state: "importing",
            revision: 0,
            position: 0,
            createdAt: stamp,
            updatedAt: stamp,
          },
        };
        revision++;
      }
      if (retained?.record.status === "pending")
        retained.runner = runnerGeneration;
      send({
        ...snapshot(),
        imports: retained?.record.status === "pending" ? [retained.record] : [],
      });
      return;
    }
    if (action === "import-ack") {
      const input = managedQueueImportAckSchema.parse(raw);
      check(input.session, input.workerId);
      assert.equal(input.runnerGeneration, retained.runner);
      assert.equal(input.importId, retained.record.importId);
      assert.equal(input.sourceDigest, retained.record.sourceDigest);
      assert.deepEqual(input.receipt, { deleted: true, conflict: false });
      const db = new DatabaseSync(legacy.database, {
        readOnly: true,
        timeout: 3000,
      });
      try {
        assert.equal(
          db
            .prepare("SELECT id FROM queued_items WHERE id=?")
            .get(legacy.source.id),
          undefined,
        );
        assert.equal(
          db
            .prepare("SELECT id FROM queued_items WHERE id=?")
            .get(legacy.foreign.id).id,
          legacy.foreign.id,
        );
        assert.equal(
          db
            .prepare(
              "SELECT outcome FROM managed_queue_delete_receipts WHERE operation_id=?",
            )
            .get(retained.record.nativeDeleteOperationId).outcome,
          "deleted",
        );
      } finally {
        db.close();
      }
      ackAttempts++;
      if (ackAttempts === 1) {
        drop();
        return;
      }
      assert.equal(retained.record.status, "pending");
      retained.record.status = "imported";
      items.push({ ...retained.item, state: "pending" });
      revision++;
      send(snapshot());
      imported.resolve();
      return;
    }
    if (action === "read") {
      const input = managedQueueReadSchema.parse(raw);
      check(input.session, input.workerId);
      firstRead.resolve();
      send(snapshot());
      return;
    }
    if (action === "start-receipt") {
      const input = managedQueueStartReceiptSchema.parse(raw);
      check(input.session, input.workerId);
      assert.equal(input.claimId, claim.id);
      const nativeReceipt = receipt(
        {
          operationId: claim.operationId,
          method: "turn/start",
          payloadDigest: "b".repeat(64),
        },
        {
          operationGeneration: claim.operationGeneration,
          startsExecution: true,
          activationGeneration: randomUUID(),
          executionLaneId: randomUUID(),
        },
      );
      const protectedResult = await protectNativeCommandContent({
        service,
        context: {
          chatId,
          operationId: claim.operationId,
          direction: "result",
        },
        content: { result: { turn } },
      });
      send({
        claim,
        receipt: nativeReceipt,
        protectedResult: protectedResult.envelope,
        resultDigest: protectedResult.digest,
      });
      return;
    }
    const { admission, expectedRevision, mutation } =
      action === "lookup"
        ? managedQueueLookupSchema.parse(raw)
        : managedQueueMutateSchema.parse(raw);
    const { session, operationId } = admission;
    check(session, admission.workerId);
    const previous = saved.get(operationId);
    if (previous)
      assert.equal(admission.payloadDigest, previous.receipt.payloadDigest);
    if (action === "lookup") {
      send(
        previous
          ? { ...snapshot(), ...previous, found: true }
          : { found: false },
      );
      return;
    }
    assert.equal(action, "mutate");
    assert.equal(expectedRevision, revision);
    assert.ok(
      !previous,
      "A committed queue mutation must use lookup on retry.",
    );
    const request = await openNativeCommandContent({
      service,
      context: { chatId, operationId, direction: "request" },
      envelope: admission.protectedPayload,
    });
    assert.equal(request.method, `thread/queue/${mutation.kind}`);
    assert.equal(request.params.threadId, threadId);
    assert.equal(
      admission.intent.resumeAutonomy ?? false,
      ["add", "start"].includes(mutation.kind),
    );
    assert.ok(!JSON.stringify(raw).includes("Private queue fixture"));
    const confirmation = { receipt: receipt(admission) };
    actions.push(mutation.kind);
    switch (mutation.kind) {
      case "add":
      case "update": {
        const existing = items.find((item) => item.id === mutation.id);
        if (mutation.kind === "add") {
          const bytes = createHash("sha256")
            .update(JSON.stringify([serverId, ownerId, chatId, operationId]))
            .digest()
            .subarray(0, 16);
          bytes[6] = (bytes[6] & 15) | 64;
          bytes[8] = (bytes[8] & 63) | 128;
          assert.equal(
            mutation.prompt.id.replaceAll("-", ""),
            bytes.toString("hex"),
          );
        } else {
          assert.equal(mutation.expectedItemRevision, existing.revision);
        }
        const prepared = await codec.preparePrompt({
          id: mutation.prompt.id,
          existing,
          request,
        });
        assert.deepEqual(
          mutation.prompt.classification,
          prepared.prompt.classification,
        );
        assert.equal(
          mutation.prompt.pendingMessage.id,
          prepared.prompt.pendingMessage.id,
        );
        assert.deepEqual(
          mutation.attachments.map(({ id }) => id),
          prepared.attachments.map(({ id }) => id),
        );
        const open = (prompt) =>
          codec.openNativeInput({
            promptId: prompt.id,
            payload: prompt.protectedNativeInput,
          });
        assert.deepEqual(
          await open(mutation.prompt),
          await open(prepared.prompt),
        );
        const updated = {
          ...mutation.prompt,
          attachments: mutation.attachments,
          chatId,
          state: "pending",
          revision: existing ? existing.revision + 1 : 0,
          position: existing?.position ?? items.length,
          createdAt: stamp,
          updatedAt: stamp,
        };
        if (existing)
          items = items.map((item) =>
            item.id === existing.id ? updated : item,
          );
        else items.push(updated);
        confirmation.acceptedItem = updated;
        break;
      }
      case "delete":
        assert.equal(
          mutation.expectedItemRevision,
          items.find((item) => item.id === mutation.id).revision,
        );
        items = items.filter((item) => item.id !== mutation.id);
        break;
      case "reorder":
        items = mutation.ids.map((id, position) => {
          const item = items.find((item) => item.id === id);
          return { ...item, revision: item.revision + 1, position };
        });
        break;
      case "start": {
        const item = items.find((item) => item.id === mutation.id);
        assert.ok(item);
        claim = {
          id: randomUUID(),
          chatId,
          promptId: item.id,
          promptRevision: item.revision,
          requestOperationId: operationId,
          status: "consumed",
          operationId: randomUUID(),
          operationGeneration: randomUUID(),
          nativeTurnId: turn.id,
          createdAt: stamp,
        };
        items = items.filter((queued) => queued.id !== item.id);
        confirmation.claim = claim;
        break;
      }
    }
    revision++;
    saved.set(operationId, confirmation);
    if (awaitingLostReply && mutation.kind === "add") {
      awaitingLostReply = false;
      drop();
    } else send({ ...snapshot(), ...confirmation });
  }
  return {
    apply,
    turn,
    actions,
    firstRead: firstRead.promise,
    imported: legacy ? imported.promise : null,
    proveImport() {
      assert.equal(stagedSources, 1);
      assert.equal(ackAttempts, 2);
      return {
        id: retained.record.promptId,
        input: legacy.source.input,
        clientUserMessageId: legacy.source.clientUserMessageId,
      };
    },
    externalRevision() {
      return ++revision;
    },
  };
}

export async function verifyConsoleQueue({
  WebSocket,
  socketFile,
  threadId,
  chatId,
  peer,
  available,
  expectSuccess,
  verifySettings,
}) {
  await available(peer.imported ?? peer.firstRead);
  const socket = new WebSocket((await readFile(socketFile, "utf8")).trim());
  const pending = new Map(),
    notices = [];
  let id = 0,
    onNotice;
  socket.on("message", (bytes) => {
    const frame = JSON.parse(bytes);
    if (frame.method === "thread/queue/changed") {
      notices.push(frame.params);
      onNotice?.(frame.params);
    } else pending.get(frame.id)?.(frame);
  });
  const call = async (method, params) => {
    const requestId = ++id;
    const result = new Promise((resolve) => pending.set(requestId, resolve));
    socket.send(JSON.stringify({ id: requestId, method, params }));
    try {
      return await available(result);
    } finally {
      pending.delete(requestId);
    }
  };
  const queue = (name, params = {}) =>
    call(`thread/queue/${name}`, { threadId, ...params });
  const result = async (...request) => {
    const frame = await queue(...request);
    assert.ok(!frame.error, JSON.stringify(frame.error));
    return frame.result;
  };
  const managed = (action) => ({ operationId: randomUUID(), action });
  const text = (text) => ({ type: "text", text, text_elements: [] });
  const image = { type: "image", url: "data:image/png;base64,AA==" };
  try {
    await available(once(socket, "open"));
    const initialized = await call("initialize", {
      clientInfo: { name: "cantrip-console-queue-test", version: "1" },
      capabilities: { experimentalApi: true },
    });
    assert.deepEqual(initialized.result.cantripManagedGateway.queue, {
      version: 1,
    });
    socket.send(JSON.stringify({ method: "initialized" }));
    if (verifySettings) await verifySettings(call);
    assert.ok((await queue("list", { threadId: "unrelated-thread" })).error);
    if (peer.imported) {
      const list = await result("list");
      assert.deepEqual(list.managedQueue.pendingImports, []);
      assert.equal(list.data.length, 1);
      const [item] = list.data;
      assert.deepEqual(
        {
          id: item.id,
          input: item.input,
          clientUserMessageId: item.clientUserMessageId,
        },
        peer.proveImport(),
      );
      assert.equal(item.managed.action, "literal");
      await result("delete", {
        managed: managed(),
        queuedSubmissionId: item.id,
      });
      console.log(
        "The console listed the same canonical prompt imported before it opened.",
      );
    }
    const add = {
      managed: managed("literal"),
      clientUserMessageId: randomUUID(),
      input: [text("Private queue fixture"), image],
    };
    assert.equal(
      (await queue("add", add)).error.data.code,
      "queue-operation-uncertain",
    );
    const first = (await result("add", add)).queuedSubmission;
    const second = (
      await result("add", {
        managed: managed("literal"),
        clientUserMessageId: randomUUID(),
        input: [text("Private queue fixture two")],
      })
    ).queuedSubmission;
    const page = await result("list", { limit: 1 });
    assert.deepEqual(
      page.data.map(({ id }) => id),
      [first.id],
    );
    assert.deepEqual(
      (await result("list", { cursor: page.nextCursor })).data.map(
        ({ id }) => id,
      ),
      [second.id],
    );
    const updated = (
      await result("update", {
        queuedSubmissionId: first.id,
        managed: managed("parseSlash"),
        input: [text("/plan Private queue fixture edited"), image],
      })
    ).queuedSubmission;
    assert.equal(updated.id, first.id);
    assert.equal(updated.clientUserMessageId, first.clientUserMessageId);
    assert.equal(updated.managed.mode, "plan");
    assert.match(
      (await queue("list", { cursor: page.nextCursor })).error.message,
      /canonical queue changed/u,
    );
    await result("reorder", {
      managed: managed(),
      queuedSubmissionIds: [second.id, first.id],
    });
    assert.deepEqual(
      (await result("list")).data.map(({ id }) => id),
      [second.id, first.id],
    );
    assert.deepEqual(
      await result("delete", {
        managed: managed(),
        queuedSubmissionId: second.id,
      }),
      { deleted: true },
    );
    assert.deepEqual(
      await result("start", {
        managed: managed(),
        queuedSubmissionId: first.id,
      }),
      { turn: peer.turn },
    );
    assert.deepEqual(peer.actions.slice(peer.imported ? 1 : 0), [
      "add",
      "add",
      "update",
      "reorder",
      "delete",
      "start",
    ]);
    const revision = peer.externalRevision();
    const changed = new Promise((resolve) => {
      onNotice = (notice) => {
        if (notice.managedQueue.revision === String(revision)) resolve(notice);
      };
    });
    await expectSuccess({ type: "chat.queue.changed", chatId, revision });
    assert.deepEqual(await available(changed), {
      threadId,
      managedQueue: { revision: String(revision) },
    });
    await expectSuccess({
      type: "chat.queue.changed",
      chatId,
      revision: revision - 1,
    });
    assert.deepEqual(notices.at(-1), {
      threadId,
      managedQueue: { revision: String(revision) },
    });
  } finally {
    socket.terminate();
  }
}
