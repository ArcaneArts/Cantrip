import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  taskGoalOutcomeDeliverySchema,
  taskInferenceInputDispatchSchema,
} from "../../packages/protocol/dist/index.js";
import { openTaskOperationRelayResult } from "../../packages/crypto/dist/index.js";

export async function verifyDirectTask({
  source,
  outputText,
  ownerId,
  serverId,
  workerId,
  key,
  directory,
  baseUrl,
  invoke,
  start,
  stop,
  waitForFrame,
  untilProvider,
  available,
  generation,
  attach,
  diagnostics,
}) {
  const { operation, marker } = source;
  const { command, receipt, fence } = taskTurn({
    operation,
    workerId,
    baseUrl,
    providerId: "direct-task-fixture",
  });
  const { clientMessageId } = command;
  const phases = [];
  const deliveries = Promise.withResolvers();
  const replay = Promise.withResolvers();
  const native = Promise.withResolvers();
  const states = [];
  let restart = false;
  attach(
    (body, send, response) => {
      const request = taskInferenceInputDispatchSchema.parse(body);
      assert.deepEqual(request.receipt, receipt);
      assert.equal(request.workerId, workerId);
      assert.equal(request.serverId, serverId);
      assert.equal(request.workerGeneration, generation());
      if (request.phase === "claim" && phases.length) {
        response.writeHead(409).end("{}");
        return;
      }
      assert.equal(
        request.phase,
        ["claim", "dispatch", "native"][phases.length],
      );
      const acknowledgment = { receipt };
      phases.push(request.phase);
      if (request.phase === "native") {
        states.push(request.nativeExecution);
        acknowledgment.nativeExecution = request.nativeExecution;
        acknowledgment.nativeRuntimeGeneration =
          request.nativeRuntimeGeneration;
        native.resolve(() => send(acknowledgment));
        return;
      }
      send(acknowledgment);
    },
    (body, send) => {
      const record = taskGoalOutcomeDeliverySchema.parse(body);
      assert.equal(record.inputKind, "round");
      assert.equal(record.ownerId, ownerId);
      assert.equal(record.serverId, serverId);
      assert.equal(record.workerId, workerId);
      assert.deepEqual(record.notification.taskDispatchFence, fence);
      assert.equal(
        record.notification.taskInferenceInputOperationId,
        receipt.operationId,
      );
      send({
        deliveryId: restart ? record.deliveryId : randomUUID(),
        taskInferenceInputOperationId: receipt.operationId,
        committed: true,
      });
      (restart ? replay : deliveries).resolve(record);
    },
  );

  await start();
  const altered = await invoke({
    ...command,
    resultMode: {
      kind: "task-encrypted",
      operation: {
        ...operation,
        fingerprint: Buffer.alloc(32, 7).toString("base64url"),
      },
    },
  });
  assert.equal(altered.ok, false);
  assert.deepEqual(phases, []);

  const providerRequest = untilProvider();
  const note = waitForFrame(
    (frame) => frame.notification?.clientMessageId === clientMessageId,
  );
  const events = [];
  const running = invoke(command, (event) => events.push(event));
  const failed = running.then((reply) => {
    throw new Error(JSON.stringify(reply) + "\n" + diagnostics());
  });
  const acknowledge = await available(
    Promise.race([
      native.promise,
      providerRequest.then(() => {
        throw new Error(
          "The provider was reached before the Task native binding.",
        );
      }),
      failed,
    ]),
  );
  acknowledge();
  const model = await Promise.race([providerRequest, failed]);
  assert.deepEqual(phases, ["claim", "dispatch", "native"]);
  assert.equal(states.length, 1);
  assert.match(states[0].scopeId, /.+/);
  assert.ok(JSON.stringify(model.body.input).includes(marker));
  model.finish();
  const reply = await running;
  assert.equal(reply.ok, true, JSON.stringify(reply) + "\n" + diagnostics());
  assert.equal(reply.result.threadId, states[0].threadId);
  assert.equal(reply.result.turnId, states[0].turnId);
  assert.equal(reply.result.text, "");
  const result = reply.result.structuredResult;
  const opened = await openTaskOperationRelayResult({
    ownerId,
    keyRevision: 2,
    componentKey: key,
    request: operation,
    result,
  });
  assert.equal(opened.task.classification.state, "complete");
  assert.equal(opened.round.classification.status, "completed");
  assert.equal(opened.task.briefMarkdown, marker);
  assert.equal(opened.assistantMessage.content[0].text, outputText);
  assert.ok(
    events.some(
      (event) =>
        event.type === "agent.protected-task-message" &&
        event.telemetry.streaming,
    ),
  );
  const terminal = events.find(
    (event) =>
      event.message?.id === result.assistantMessage.id &&
      !event.telemetry.streaming,
  );
  assert.deepEqual(terminal.message, result.assistantMessage);
  assert.ok(!JSON.stringify({ reply, events }).includes(marker));
  assert.ok(!JSON.stringify({ reply, events }).includes(outputText));

  const saved = await available(deliveries.promise);
  const pushed = await available(note);
  assert.deepEqual(pushed.notification, saved.notification);
  assert.deepEqual(saved.notification.outcome, {
    ok: true,
    result: reply.result,
  });
  const namespace = createHash("sha256")
    .update(JSON.stringify([serverId, ownerId, workerId]))
    .digest("hex");
  const filename = path.join(
    directory,
    "task-goal-outcomes",
    namespace,
    saved.deliveryId + ".json",
  );
  const pending = await readFile(filename, "utf8");
  assert.deepEqual(JSON.parse(pending), saved);
  const duplicate = await invoke(command);
  assert.equal(duplicate.ok, false);
  assert.deepEqual(phases, ["claim", "dispatch", "native"]);
  await stop();
  assert.equal(await readFile(filename, "utf8"), pending);

  restart = true;
  await start();
  assert.deepEqual(await available(replay.promise), saved);
  await available(
    (async () => {
      for (let attempt = 0; attempt < 250; attempt++) {
        try {
          await readFile(filename);
        } catch (error) {
          if (error.code === "ENOENT") return;
          throw error;
        }
        await delay(20);
      }
      assert.fail("The acknowledged Task outcome file was not removed.");
    })(),
  );
  await stop();
  attach(undefined, undefined);
}

export function taskTurn({
  operation,
  workerId,
  baseUrl,
  providerId,
  projectId = randomUUID(),
  worktreeId = randomUUID(),
}) {
  const chatId = operation.chatId;
  const lane = randomUUID();
  const fence = {
    cycleId: randomUUID(),
    operationId: operation.operationId,
    leaseOwner: "rust-task-fixture",
    fencingToken: 1,
  };
  const provider = {
    id: providerId,
    kind: "openai-compatible",
    name: "Task fixture",
    baseUrl,
  };
  const clientMessageId = operation.userMessage.id;
  const receipt = {
    operationId: randomUUID(),
    chatId,
    clientMessageId,
    workerId,
    worktreeId,
    executionLaneId: lane,
    executionLaneActivatedAt: new Date().toISOString(),
    providerId: provider.id,
    modelRouteId: "fixture-route",
    providerAccountId: null,
    dispatch: fence,
  };
  const command = {
    type: "chat.turn",
    executionProfile: "ide",
    contextKind: "project",
    chatId,
    clientMessageId,
    executionLaneId: lane,
    worktreeId,
    scratchRootId: null,
    rootKind: "folder-root",
    isPrimary: true,
    worktreeMode: "agent-managed",
    worktreePolicy: "direct",
    policyProjectId: projectId,
    prompt: "Encrypted Task input",
    provider,
    resultMode: { kind: "task-encrypted", operation },
    taskInferenceInput: receipt,
    taskDispatchLease: {
      ...fence,
      leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  };
  return { command, receipt, fence };
}
