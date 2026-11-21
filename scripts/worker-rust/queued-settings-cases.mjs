import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  nativeCommandAdmissionSchema,
  nativeCommandDispatchSchema,
  nativeCommandReceiptSchema,
  nativeCommandSettlementSchema,
  nativeSettingsEvidenceSchema,
  nativeSettingsEvidenceResultSchema,
} from "../../packages/protocol/dist/index.js";
import { createManagedQueueInputCodec } from "../../tests/reference-node-worker/src/managed-queue-input.ts";
import {
  openNativeCommandContent,
  protectNativeCommandContent,
} from "../../tests/reference-node-worker/src/native-command-content.ts";
import { NativeSettingsDelivery } from "../../tests/reference-node-worker/src/native-settings-delivery.ts";

const hash = (parts) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export async function verifyQueuedSettings({
  start,
  stop,
  request,
  expectThread,
  expectSuccess,
  available,
  modelCalls,
  attach,
  workerId,
  generation,
  provider,
  directory,
  oracle,
  stamp,
}) {
  await start();
  const session = {
    contextKind: "project",
    chatId: randomUUID(),
    computerUseEnabled: false,
    projectId: randomUUID(),
    worktreeId: randomUUID(),
    rootKind: "folder-root",
    scratchRootId: null,
  };
  const permissionProfileId = ":read-only";
  const { threadId } = await expectThread({
    session,
    provider,
    permissionProfileId,
  });
  const codec = createManagedQueueInputCodec({
    chatId: session.chatId,
    encryption: oracle,
    defaults: () => ({
      modelId: "gpt-5",
      mode: "default",
      reasoningEffort: null,
    }),
  });
  const prepared = await codec.preparePrompt({
    id: randomUUID(),
    request: {
      method: "thread/queue/add",
      params: {
        threadId,
        managed: { action: "parseSlash" },
        input: [{ type: "text", text: "/plan" }],
      },
    },
  });
  const { prompt } = prepared;
  const queueClaim = { id: randomUUID(), promptRevision: 3 };
  const operationId = "queue:" + queueClaim.id;
  const command = {
    type: "chat.queue.execute",
    chatId: session.chatId,
    threadId,
    session,
    provider,
    permissionProfileId,
    subagentDefaults: null,
    queuedPromptId: prompt.id,
    queueClaim,
    nativeAction: prompt.nativeAction,
    executionMethod: prompt.executionMethod,
    protectedPrompt: prompt.pendingMessage,
    protectedNativeInput: prompt.protectedNativeInput,
  };
  assert.equal(command.executionMethod, "thread/settings/update");

  const outbox = path.join(
    directory,
    "native-settings-evidence",
    hash([oracle.serverIdentity(), oracle.ownerId(), workerId]),
  );
  const appliedCaptured = Promise.withResolvers();
  const appliedDelivered = Promise.withResolvers();
  const queuedDelivered = Promise.withResolvers();
  const legacyDelivered = Promise.withResolvers();
  const steps = [];
  let receipt, nativeSession, rpcAck, applied, legacy;
  let holdApplied = true;
  const allowDispatch = Promise.withResolvers();
  const reachedDispatch = Promise.withResolvers();
  const open = async (
    direction,
    envelope,
    digest,
    eventId,
    operation = operationId,
  ) => {
    const context = {
      chatId: session.chatId,
      operationId: operation,
      direction,
      eventId,
    };
    const content = await openNativeCommandContent({
      service: oracle,
      context,
      envelope,
    });
    const resealed = await protectNativeCommandContent({
      service: oracle,
      context,
      content,
    });
    assert.equal(resealed.digest, digest);
    return content;
  };
  attach(async (phase, body, response, send) => {
    assert.equal(body.workerId, workerId);
    if (phase === "admit") {
      const value = nativeCommandAdmissionSchema.parse(body);
      assert.equal(value.operationId, operationId);
      if (receipt) {
        assert.equal(receipt.status, "applied");
        send({
          receipt,
          replayed: true,
          execution: null,
          computerUseAuthority: null,
        });
        return;
      }
      assert.equal(value.method, "thread/settings/update");
      assert.equal(value.intent.nativeSettingsOperationId, operationId);
      assert.deepEqual(value.intent.settingKeys, ["collaborationMode"]);
      assert.deepEqual(value.queueClaim, queueClaim);
      assert.equal(value.intent.workerGeneration, generation());
      nativeSession = value.session;
      assert.equal(nativeSession.threadId, threadId);
      const opened = await open(
        "request",
        value.protectedPayload,
        value.payloadDigest,
      );
      assert.equal(opened.id, operationId);
      assert.equal(opened.method, value.method);
      assert.equal(opened.params.operationId, operationId);
      assert.equal(opened.params.threadId, threadId);
      assert.equal(opened.params.collaborationMode.mode, "plan");
      receipt = nativeCommandReceiptSchema.parse({
        operationId,
        operationGeneration: randomUUID(),
        chatId: session.chatId,
        activationGeneration: null,
        executionLaneId: null,
        startsExecution: false,
        status: "accepted",
        method: value.method,
        payloadDigest: value.payloadDigest,
        rejectionCode: null,
        threadId,
        createdAt: stamp,
        updatedAt: stamp,
      });
      steps.push("admit");
      send({ receipt, execution: null, computerUseAuthority: null });
      return;
    }
    if (phase === "dispatch") {
      const value = nativeCommandDispatchSchema.parse(body);
      assert.deepEqual(value.session, nativeSession);
      assert.equal(value.operationGeneration, receipt.operationGeneration);
      assert.equal(value.payloadDigest, receipt.payloadDigest);
      assert.equal(value.workerGeneration, generation());
      steps.push("dispatch");
      reachedDispatch.resolve();
      await allowDispatch.promise;
      receipt.status = "dispatched";
      send({ receipt, execution: null, computerUseAuthority: null });
      return;
    }
    if (phase === "receipt") {
      const value = nativeCommandSettlementSchema.parse(body);
      assert.equal(value.operationGeneration, receipt.operationGeneration);
      assert.equal(value.status, "applied");
      assert.notEqual(receipt.status, "accepted");
      ({ result: rpcAck } = await open(
        "result",
        value.protectedResult,
        value.resultDigest,
      ));
      assert.equal(rpcAck.operationId, operationId);
      assert.ok(rpcAck.submissionId);
      receipt.status = "applied";
      steps.push("receipt");
      send({ receipt });
      return;
    }
    assert.equal(phase, "settings-evidence");
    const event = nativeSettingsEvidenceSchema.parse(body);
    const content = await open(
      "settings-evidence",
      event.protectedResult,
      event.resultDigest,
      event.eventId,
      event.operationId,
    );
    assert.equal(content.kind, event.kind);
    if (event.operationId === operationId) {
      assert.notEqual(receipt.status, "accepted");
      assert.equal(event.operationGeneration, receipt.operationGeneration);
      assert.equal(event.threadId, threadId);
      assert.equal(event.runtimeGeneration, nativeSession.runtimeGeneration);
      assert.equal(event.nativeOperationId, operationId);
      if (event.kind === "queued") {
        assert.equal(content.content.result.submissionId, event.submissionId);
        queuedDelivered.resolve(event);
      } else {
        assert.equal(event.kind, "applied");
        assert.equal(
          content.content.threadSettings.collaborationMode.mode,
          "plan",
        );
        assert.equal(content.content.operationId, operationId);
        assert.equal(content.content.submissionId, event.submissionId);
        if (applied) assert.deepEqual(event, applied);
        applied = event;
        appliedCaptured.resolve();
        if (holdApplied) {
          response.destroy();
          return;
        }
        appliedDelivered.resolve(event);
      }
    } else {
      assert.deepEqual(event, legacy);
      assert.deepEqual(content.content, {
        reason: "worker-recovered-before-settings-result",
      });
      legacyDelivered.resolve(event);
    }
    send(
      nativeSettingsEvidenceResultSchema.parse({
        operationId: event.operationId,
        operationGeneration: event.operationGeneration,
        eventId: event.eventId,
        application: {
          nativeOperationId: event.nativeOperationId,
          submissionId: event.submissionId,
          status:
            event.kind === "applied"
              ? "applied"
              : event.kind === "transport-lost"
                ? "uncertain"
                : "pending",
          evidenceCount: 1,
        },
      }),
    );
  });
  try {
    const before = modelCalls();
    assert.equal(
      (await request({ ...command, queuedPromptId: randomUUID() })).ok,
      false,
    );
    assert.deepEqual(steps, []);
    const response = expectSuccess(command);
    await available(reachedDispatch.promise);
    assert.deepEqual(steps, ["admit", "dispatch"]);
    assert.deepEqual(
      await readdir(outbox).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return [];
      }),
      [],
    );
    allowDispatch.resolve();
    const result = await response;
    assert.deepEqual(result, rpcAck);
    const accepted = await available(queuedDelivered.promise);
    await available(appliedCaptured.promise);
    assert.equal(accepted.submissionId, applied.submissionId);
    assert.equal(modelCalls(), before);
    await stop();
    const evidence = await readFile(
      path.join(outbox, applied.eventId + ".event.json"),
      "utf8",
    );
    assert.equal(evidence, JSON.stringify(applied));

    const old = new NativeSettingsDelivery({
      directory,
      workerId,
      service: oracle,
      client: {
        settingsEvidence: async () =>
          assert.fail("Legacy fixture must leave its marker on disk."),
      },
      onError: (error) => {
        throw error;
      },
    });
    const oldId = "queue:" + randomUUID();
    const oldGeneration = randomUUID();
    await old.track({
      operationId: oldId,
      operationGeneration: oldGeneration,
      chatId: session.chatId,
      threadId,
      runtimeGeneration: nativeSession.runtimeGeneration,
      nativeOperationId: oldId,
    });
    legacy = JSON.parse(
      await readFile(
        path.join(outbox, hash([oldId, oldGeneration]) + ".pending.json"),
        "utf8",
      ),
    ).recovery;
    holdApplied = false;
    await start();
    await available(
      Promise.all([appliedDelivered.promise, legacyDelivered.promise]),
    );
    const signal = AbortSignal.timeout(5000);
    while ((await readdir(outbox)).length)
      await delay(20, undefined, { signal });
    const replay = await request(command);
    assert.equal(replay.ok, false);
    assert.match(replay.error.message, /already has a receipt/);
    assert.deepEqual(steps, ["admit", "dispatch", "receipt"]);
    assert.equal(modelCalls(), before);
    await stop();
  } finally {
    attach();
  }
  console.log(
    "Queued Plan Mode applied in Codex with separate encrypted evidence, exact restart replay, and legacy registration recovery.",
  );
}
