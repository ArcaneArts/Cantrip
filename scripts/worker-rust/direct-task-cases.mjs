import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  taskGoalOutcomeDeliverySchema,
  taskInferenceInputDispatchSchema,
  taskPauseRuntimeStateSchema,
} from "../../packages/protocol/dist/index.js";
import { NativeSuspensionStore } from "../../cantrip_worker/src/native-suspension-store.ts";
import { openTaskOperationRelayResult } from "../../packages/crypto/dist/index.js";

function boundaryTool(body, callId) {
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
    call_id: callId,
    arguments: JSON.stringify({
      cmd: "printf task-checkpoint-boundary",
      yield_time_ms: 1000,
    }),
  };
}

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
  const restored = Promise.withResolvers();
  const states = [];
  let restart = false;
  let current = receipt;
  let currentCommand = command;
  const namespace = createHash("sha256")
    .update(JSON.stringify([serverId, ownerId, workerId]))
    .digest("hex");
  let runtimeGeneration;
  attach(
    (body, send, response) => {
      const request = taskInferenceInputDispatchSchema.parse(body);
      assert.deepEqual(request.receipt, current);
      assert.equal(request.workerId, workerId);
      assert.equal(request.serverId, serverId);
      assert.equal(request.workerGeneration, generation());
      if (
        (request.phase === "claim" && phases.length % 3 !== 0) ||
        phases.length === (checkpoint?.cold ? 6 : 3)
      ) {
        response.writeHead(409).end("{}");
        return;
      }
      assert.equal(
        request.phase,
        ["claim", "dispatch", "native"][phases.length % 3],
      );
      const acknowledgment = { receipt: current };
      phases.push(request.phase);
      if (request.phase === "native") {
        states.push(request.nativeExecution);
        runtimeGeneration = request.nativeRuntimeGeneration;
        acknowledgment.nativeExecution = request.nativeExecution;
        acknowledgment.nativeRuntimeGeneration =
          request.nativeRuntimeGeneration;
        (current === receipt ? native : restored).resolve(() =>
          send(acknowledgment),
        );
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
      assert.equal(
        record.notification.outcome.ok,
        true,
        JSON.stringify(record.notification.outcome),
      );
      assert.deepEqual(record.notification.taskDispatchFence, current.dispatch);
      assert.equal(
        record.notification.taskInferenceInputOperationId,
        current.operationId,
      );
      send({
        deliveryId: restart ? record.deliveryId : randomUUID(),
        taskInferenceInputOperationId: current.operationId,
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

  if (checkpoint)
    checkpoint.respond((body) => boundaryTool(body, "direct-task-boundary"));
  const providerRequest = untilProvider();
  const note = waitForFrame(
    (frame) => frame.notification?.clientMessageId === clientMessageId,
  );
  const events = [];
  let running = invoke(
    command,
    (event) => events.push(event),
    undefined,
    checkpoint?.cold,
  );
  const failed = running.then((reply) => {
    if (!reply.disconnected)
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
    const scope = { serverId, ownerId, workerId };
    const protection = {
      ...checkpoint.oracle,
      registration: () => ({ principalId }),
    };
    const store = new NativeSuspensionStore(directory, () => scope, protection);
    const savedSource = {
      chatId: command.chatId,
      threadId,
      contextKind: "project",
      projectId: command.policyProjectId,
      placementId: receipt.worktreeId,
      modelRouteId: receipt.modelRouteId,
      providerAccountId: null,
      taskInput: receipt,
    };
    const saved = await store.open(
      state.execution.checkpoint.storageId,
      savedSource,
    );
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
    if (checkpoint.cold) {
      const oldGeneration = generation();
      const priorRuntime = runtimeGeneration;
      await stop();
      assert.deepEqual(await running, { ok: false, disconnected: true });
      const outcomes = await readdir(
        path.join(directory, "task-goal-outcomes", namespace),
      ).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      assert.ok(
        !outcomes.some((name) => name.endsWith(".json")),
        "Stopping a held Task must leave its checkpoint instead of publishing a failed outcome.",
      );
      // Re-seal the captured continuation through the independent Node
      // reference. The actual Codex checkpoint and source identity stay intact.
      const nodeDirectory = path.join(
        directory,
        "node-task-checkpoint-fixture",
      );
      const nodeStore = new NativeSuspensionStore(
        nodeDirectory,
        () => scope,
        protection,
      );
      const reference = await nodeStore.commit({
        ...saved,
        suspension: saved.evidence.suspension,
        runtimeVersion: saved.evidence.runtimeVersion,
        runtimeFingerprint: saved.evidence.runtimeFingerprint,
      });
      assert.deepEqual(reference, saved.evidence);
      const digest = (value) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const record = path.join(
        "native-turn-suspensions",
        digest(scope),
        digest(command.chatId),
        reference.storageId + ".json",
      );
      await copyFile(
        path.join(nodeDirectory, record),
        path.join(directory, record),
      );
      current = {
        ...receipt,
        operationId: randomUUID(),
        dispatch: { ...fence, fencingToken: fence.fencingToken + 1 },
      };
      await start();
      assert.notEqual(generation(), oldGeneration);
      assert.deepEqual(
        check(
          await invoke({
            ...control,
            paused: false,
            task: { ...control.task, revision: 2 },
          }),
        ),
        { paused: false, active: null },
      );
      const commandAfterRestart = {
        ...command,
        threadId,
        taskInferenceInput: current,
        taskDispatchLease: {
          ...command.taskDispatchLease,
          ...current.dispatch,
        },
        taskResumption: {
          controlId: randomUUID(),
          checkpoint: saved.evidence,
          source: receipt,
        },
      };
      currentCommand = commandAfterRestart;
      const unknown = await invoke({
        ...commandAfterRestart,
        taskResumption: {
          ...commandAfterRestart.taskResumption,
          checkpoint: { ...saved.evidence, storageId: randomUUID() },
        },
      });
      assert.equal(unknown.ok, false);
      assert.match(unknown.error.message, /^Task restoration failed at attach/);
      assert.equal(phases.length, 3);

      checkpoint.respond((body) =>
        boundaryTool(body, "restored-task-boundary"),
      );
      const continued = untilProvider();
      const bound = Promise.withResolvers();
      running = invoke(commandAfterRestart, (event) => {
        events.push(event);
        if (event.type === "agent.task-resumed") bound.resolve(event);
      });
      const rejected = running.then((reply) => {
        throw new Error(JSON.stringify(reply) + "\n" + diagnostics());
      });
      const ack = await available(
        Promise.race([
          restored.promise,
          rejected,
          continued.then(() =>
            assert.fail(
              "Task recovery reached the provider before Core bound the original turn.",
            ),
          ),
        ]),
      );
      assert.equal(checkpoint.calls(), model.number);
      assert.deepEqual(states[1], { ...states[1], threadId, turnId });
      assert.notEqual(runtimeGeneration, priorRuntime);
      assert.ok(!events.some((event) => event.type === "agent.task-resumed"));
      ack();
      const event = await available(Promise.race([bound.promise, rejected]));
      assert.deepEqual(event, {
        type: "agent.task-resumed",
        controlId: commandAfterRestart.taskResumption.controlId,
        inputOperationId: current.operationId,
        threadId,
        turnId,
      });
      const resumed = await Promise.race([continued, rejected]);
      assert.equal(resumed.number, model.number + 1);
      assert.equal(JSON.stringify(resumed.body.input).split(marker).length, 2);
      assert.equal(
        JSON.stringify(resumed.body.input).split("direct-task-boundary").length,
        3,
      );
      const pauseAgain = { ...control, task: { ...control.task, revision: 3 } };
      assert.deepEqual(
        check(await invoke({ ...pauseAgain, waitForBoundary: false })),
        {
          paused: true,
          active: null,
        },
      );
      const recapturing = invoke(pauseAgain).then(check);
      checkpoint.respond(undefined);
      resumed.finish();
      const recaptured = await recapturing;
      assert.deepEqual(recaptured.active, { threadId, turnId });
      assert.deepEqual(recaptured.execution.actor, {
        workerGeneration: generation(),
        runtimeGeneration,
        operationId: current.operationId,
        operationGeneration: current.operationId,
      });
      const held = await store.open(
        recaptured.execution.checkpoint.storageId,
        savedSource,
      );
      assert.ok(
        held.taskContinuation.events.ids.some(
          ([, id]) => id === published.message.id,
        ),
      );
      const next = untilProvider();
      const live = invoke({
        ...pauseAgain,
        paused: false,
        task: { ...pauseAgain.task, revision: 4 },
      }).then(check);
      const afterLive = await Promise.race([next, live.then(() => next)]);
      assert.equal(afterLive.number, resumed.number + 1);
      assert.deepEqual(await live, {
        paused: false,
        active: { threadId, turnId },
        execution: { actor: recaptured.execution.actor, checkpoint: null },
      });
      afterLive.finish();

      console.log(
        "Restarted the worker and Codex and restored the original Task under a fresh Core receipt.",
      );
    } else {
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
    }
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
  const filename = path.join(
    directory,
    "task-goal-outcomes",
    namespace,
    saved.deliveryId + ".json",
  );
  const pending = await readFile(filename, "utf8");
  assert.deepEqual(JSON.parse(pending), saved);
  const duplicate = await invoke(currentCommand);
  assert.equal(duplicate.ok, false);
  assert.deepEqual(
    phases,
    checkpoint?.cold
      ? ["claim", "dispatch", "native", "claim", "dispatch", "native"]
      : ["claim", "dispatch", "native"],
  );
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
