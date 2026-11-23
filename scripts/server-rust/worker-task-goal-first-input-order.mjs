import { randomUUID } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const file = process.env.CANTRIP_TEST_TASK_GOAL_FIRST_INPUT_FILE;
if (
  file &&
  !existsSync(file) &&
  process.argv[1] ===
    process.env.CANTRIP_TEST_TASK_GOAL_FIRST_INPUT_WORKER_ENTRY
) {
  const phase = process.env.CANTRIP_TEST_TASK_GOAL_FIRST_INPUT_PHASE;
  const { WebSocket } = createRequire(process.argv[1])("ws");
  const send = WebSocket.prototype.send;
  const emit = WebSocket.prototype.emit;
  const fetch = globalThis.fetch;
  const gates = new Map();
  const receipt = { phase };
  let activation, wakeId, firstInputId, denyId, earlyBegin, resolveBegin;

  function report() {
    const temporary = file + ".tmp";
    writeFileSync(temporary, JSON.stringify(receipt) + "\n");
    renameSync(temporary, file);
  }

  function frame(data) {
    const text = String(data);
    return text.startsWith("{") ? JSON.parse(text) : null;
  }

  WebSocket.prototype.send = function (data, ...args) {
    const message = frame(data);
    const params = message?.params;
    if (params?.threadId && params.executionGate?.inferenceOnly)
      gates.set(params.threadId, params.executionGate.runnerGeneration);
    if (message?.method === "thread/goal/set" && params.status === "active")
      activation = { socket: this, threadId: params.threadId };
    if (this === activation?.socket && earlyBegin) {
      if (
        firstInputId === undefined &&
        message?.method === "turn/start" &&
        params.threadId === activation.threadId
      ) {
        firstInputId = message.id;
        receipt.earlyTurnFinishedBeforeFirstInput =
          receipt.earlyTurnFinished === true;
      }
      if (
        message?.method === "thread/managedExecution/resolve" &&
        params.attemptId === earlyBegin.attemptId &&
        params.allow === false
      )
        denyId = message.id;
    }
    return send.call(this, data, ...args);
  };

  WebSocket.prototype.emit = function (event, ...args) {
    if (this === activation?.socket && wakeId && event === "message") {
      const message = frame(args[0]);
      const params = message?.params;
      if (message?.id === wakeId)
        receipt.wakeScheduled = message.result?.scheduled === true;
      if (
        !earlyBegin &&
        message?.method === "thread/managedExecution/requested" &&
        params.threadId === activation.threadId &&
        params.goalEpoch &&
        params.input?.phase === "begin"
      ) {
        earlyBegin = params;
        receipt.earlyGoalTurnId = params.turnId;
        resolveBegin();
      }
      if (denyId !== undefined && message?.id === denyId)
        receipt.earlyDenialAcknowledged = !message.error;
      if (
        earlyBegin &&
        message?.method === "turn/completed" &&
        params.turn?.id === earlyBegin.turnId
      )
        receipt.earlyTurnFinished = true;
      if (firstInputId !== undefined && message?.id === firstInputId)
        receipt.firstInputTurnId = message.result?.turn?.id;
    }
    return emit.call(this, event, ...args);
  };

  globalThis.fetch = async (input, options) => {
    const url = typeof input === "string" ? input : (input?.url ?? input?.href);
    const response = await fetch(input, options);
    if (!response.ok || typeof options?.body !== "string") return response;
    if (url?.endsWith("/api/internal/native-commands/task-input-dispatch")) {
      const body = JSON.parse(options.body);
      if (
        !wakeId &&
        activation &&
        body.receipt?.kind === "goal" &&
        body.phase === phase
      ) {
        // Hold delivery of the real server reply while waking Core's existing
        // idle producer. No model, native turn, or database result is replaced.
        receipt.operationId = body.receipt.operationId;
        receipt.authorityStatus = response.status;
        const beforeReply = new Promise((resolve) => {
          resolveBegin = resolve;
        });
        wakeId = `cantrip-fixture-wake:${randomUUID()}`;
        send.call(
          activation.socket,
          JSON.stringify({
            id: wakeId,
            method: "thread/managedExecution/wake",
            params: {
              threadId: activation.threadId,
              runnerGeneration: gates.get(activation.threadId),
            },
          }),
        );
        await Promise.race([beforeReply, delay(2500)]);
        receipt.earlyBeginBeforeReply = Boolean(earlyBegin);
        report();
      } else if (
        wakeId &&
        body.phase === "native" &&
        body.receipt?.operationId === receipt.operationId
      ) {
        receipt.boundFirstInputTurnId = body.nativeExecution.turnId;
        report();
      }
    }
    if (
      wakeId &&
      url?.endsWith("/api/internal/native-commands/task-goal-cycle-dispatch")
    ) {
      const body = JSON.parse(options.body);
      if (!receipt.laterGoalTurnId && body.threadId === activation.threadId) {
        receipt.laterGoalTurnId = body.turnId;
        report();
      }
    }
    return response;
  };
}
