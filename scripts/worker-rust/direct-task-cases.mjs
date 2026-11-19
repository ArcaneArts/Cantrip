import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  taskGoalOutcomeDeliverySchema,
  taskInferenceInputDispatchSchema,
  taskPauseRuntimeStateSchema,
} from "../../packages/protocol/dist/index.js";
import { NativeSuspensionStore } from "../../cantrip_worker/src/native-suspension-store.ts";
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
  checkpoint,
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
  let runtimeGeneration;
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
        runtimeGeneration = request.nativeRuntimeGeneration;
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

  if (checkpoint) {
    checkpoint.respond((body) => {
      const exec = body.tools
        .flatMap((tool) =>
          tool.type === "namespace"
            ? tool.tools.map((entry) => ({ ...entry, namespace: tool.name }))
            : [tool],
        )
        .find((tool) => tool.name === "exec_command");
      assert.ok(exec);
      return {
        name: exec.name,
        ...(exec.namespace ? { namespace: exec.namespace } : {}),
        call_id: "direct-task-boundary",
        arguments: JSON.stringify({
          cmd: "printf task-checkpoint-boundary",
          yield_time_ms: 1000,
        }),
      };
    });
  }
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
  if (checkpoint) {
    const { threadId, turnId } = states[0];
    const { operationId } = receipt;
    const control = {
      type: "chat.pause.set",
      chatId: command.chatId,
      paused: true,
      task: {
        revision: 1,
        workerId,
        projectId: command.policyProjectId,
        worktreeId: receipt.worktreeId,
        threadId,
        modelRouteId: receipt.modelRouteId,
        providerAccountId: null,
        cycleId: fence.cycleId,
        taskRound: {
          operationId: fence.operationId,
          inputOperationId: operationId,
          cycleId: fence.cycleId,
        },
      },
    };
    const check = (reply) => {
      assert.equal(
        reply.ok,
        true,
        JSON.stringify(reply) + "\n" + diagnostics(),
      );
      return taskPauseRuntimeStateSchema.parse(reply.result);
    };
    const foreign = await invoke({
      ...control,
      task: { ...control.task, workerId: randomUUID() },
    });
    assert.equal(foreign.ok, false);
    assert.deepEqual(
      check(await invoke({ ...control, waitForBoundary: false })),
      { paused: true, active: null },
    );
    const pause = invoke(control).then(check);
    checkpoint.respond(undefined);
    const commentary = "Private Task commentary before the checkpoint.";
    model.finish([
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        id: "task-before-checkpoint",
        content: [{ type: "output_text", text: commentary }],
      },
    ]);
    const state = await pause;
    assert.deepEqual(state.active, { threadId, turnId });
    assert.deepEqual(state.execution.actor, {
      workerGeneration: generation(),
      runtimeGeneration,
      operationId,
      operationGeneration: operationId,
    });
    assert.equal(checkpoint.calls(), model.number);
    assert.deepEqual(check(await invoke(control)), state);
    const { principalId } = JSON.parse(
      await readFile(
        path.join(directory, "worker-encryption-key.json"),
        "utf8",
      ),
    );
    const store = new NativeSuspensionStore(
      directory,
      () => ({ serverId, ownerId, workerId }),
      { ...checkpoint.oracle, registration: () => ({ principalId }) },
    );
    const saved = await store.open(state.execution.checkpoint.storageId, {
      chatId: command.chatId,
      threadId,
      contextKind: "project",
      projectId: command.policyProjectId,
      placementId: receipt.worktreeId,
      modelRouteId: receipt.modelRouteId,
      providerAccountId: null,
      taskInput: receipt,
    });
    assert.deepEqual(saved.evidence, state.execution.checkpoint);
    assert.equal(saved.continuation.turnId, turnId);
    assert.equal(saved.continuation.executionKind, "chat");
    assert.deepEqual(saved.taskContinuation.request, operation);
    assert.equal(saved.taskContinuation.events.mode, "default");
    const published = events.find(
      (event) =>
        event.type === "agent.protected-task-message" &&
        event.telemetry.phase === "commentary",
    );
    assert.ok(published);
    assert.ok(
      saved.taskContinuation.events.ids.some(
        ([, id]) => id === published.message.id,
      ),
    );
    const next = untilProvider();
    const resume = invoke({
      ...control,
      paused: false,
      task: { ...control.task, revision: 2 },
    }).then(check);
    const resumed = await Promise.race([next, resume.then(() => next)]);
    assert.equal(resumed.number, model.number + 1);
    assert.deepEqual(await resume, {
      paused: false,
      active: { threadId, turnId },
      execution: { actor: state.execution.actor, checkpoint: null },
    });
    resumed.finish();
    console.log(
      "Direct Task pause saved an authenticated Node-readable checkpoint and resumed the same turn.",
    );
  } else {
    model.finish();
  }
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
