import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  managedQueueLookupSchema,
  managedQueueMutateSchema,
  managedQueueReadSchema,
  managedQueueStartReceiptSchema,
} from "../../packages/protocol/dist/index.js";
import { AttachmentStore } from "../../cantrip_worker/src/attachment-store.ts";
import { createManagedQueueInputCodec } from "../../cantrip_worker/src/managed-queue-input.ts";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../../cantrip_worker/src/native-command-content.ts";

export function queuePeer({ identity, service, root, stamp }) {
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
  function check(session, worker) {
    assert.equal(worker, workerId);
    assert.equal(session.chatId, chatId);
    assert.equal(session.threadId, threadId);
    assert.equal(session.placementId, worktreeId);
  }
  function snapshot() {
    return { revision, paused: false, items, claims: claim ? [claim] : [] };
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
    if (awaitingLostReply) {
      awaitingLostReply = false;
      drop();
    } else send({ ...snapshot(), ...confirmation });
  }
  return {
    apply,
    turn,
    actions,
    firstRead: firstRead.promise,
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
}) {
  await available(peer.firstRead);
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
    assert.ok((await queue("list", { threadId: "unrelated-thread" })).error);
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
    assert.deepEqual(peer.actions, [
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
