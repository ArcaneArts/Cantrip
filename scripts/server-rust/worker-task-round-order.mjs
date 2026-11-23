// Keep one final Task stream event off the wire until its durable HTTP result
// is observed. Replay the earlier stream event after a successful receipt.
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const report = process.env.CANTRIP_TEST_TASK_ROUND_ORDER_FILE;
if (
  report &&
  process.argv[1] === process.env.CANTRIP_TEST_TASK_ROUND_ORDER_WORKER_ENTRY &&
  !existsSync(report)
) {
  const kind = process.env.CANTRIP_TEST_TASK_OUTCOME_ORDER_KIND ?? "round";
  const mode = kind === "round" ? "default" : "goal";
  const field = kind === "round" ? "assistantMessage" : "message";
  const { WebSocket } = createRequire(process.argv[1])("ws");
  const send = WebSocket.prototype.send;
  const fetch = globalThis.fetch;
  let first, final, finished;
  const pending = [];
  WebSocket.prototype.send = function (data, ...args) {
    if (!finished && typeof data === "string" && data.startsWith("{")) {
      const frame = JSON.parse(data);
      const event = frame.event;
      if (
        frame.kind === "event" &&
        event?.type === "agent.protected-task-message" &&
        event.message.classification.mode === mode &&
        event.telemetry?.kind === "message"
      ) {
        if (!first && event.telemetry.streaming === true) {
          first = { frame, data, socket: this };
        } else if (
          first &&
          frame.requestId === first.frame.requestId &&
          event.message.id === first.frame.event.message.id &&
          event.telemetry.streaming !== true
        ) {
          final = { frame, data };
          return;
        }
      }
      if (
        first &&
        ((frame.kind === "response" &&
          frame.requestId === first.frame.requestId) ||
          (frame.kind === "notification" &&
            frame.notification?.type === "chat.turn.outcome" &&
            frame.notification.outcome?.result?.structuredResult?.[field]
              ?.id === first.frame.event.message.id))
      ) {
        pending.push(data);
        return;
      }
    }
    return send.call(this, data, ...args);
  };
  globalThis.fetch = async (input, options) => {
    const url = input instanceof URL ? input.href : input;
    if (
      !finished &&
      first &&
      typeof url === "string" &&
      url.endsWith("/api/internal/native-commands/task-goal-outcome")
    ) {
      const body = JSON.parse(options.body);
      const assistant =
        body.notification.outcome.result?.structuredResult?.[field];
      if (
        body.inputKind === kind &&
        assistant?.id === first.frame.event.message.id
      ) {
        const response = await fetch(input, options);
        const receipt = await response.clone().json();
        const matched =
          JSON.stringify(assistant.protectedContent) ===
          JSON.stringify(final?.frame.event.message.protectedContent);
        const replacedProvisional =
          JSON.stringify(assistant.protectedContent) !==
          JSON.stringify(first.frame.event.message.protectedContent);
        let exactReplay, changedReplayStatus;
        if (response.ok) {
          const replay = await fetch(input, options);
          const replayReceipt = await replay.json();
          exactReplay =
            replay.status === response.status &&
            JSON.stringify(replayReceipt) === JSON.stringify(receipt);
          const changed = structuredClone(body);
          changed.notification.outcome.result.structuredResult[
            field
          ].protectedContent = first.frame.event.message.protectedContent;
          const conflict = await fetch(input, {
            ...options,
            body: JSON.stringify(changed),
          });
          changedReplayStatus = conflict.status;
          await conflict.text();
        }
        finished = true;
        if (response.ok) send.call(first.socket, first.data);
        else if (final) send.call(first.socket, final.data);
        for (const frame of pending) send.call(first.socket, frame);
        const temporary = report + ".tmp";
        writeFileSync(
          temporary,
          JSON.stringify(
            {
              messageId: assistant.id,
              status: response.status,
              committed: receipt.committed === true,
              finalEventHeld: Boolean(final),
              receiptMatchesFinalEvent: matched,
              differsFromProvisionalEvent: replacedProvisional,
              replayedProvisionalEvent: response.ok,
              exactReplay,
              changedReplayStatus,
            },
            null,
            2,
          ) + "\n",
        );
        renameSync(temporary, report);
        return response;
      }
    }
    return fetch(input, options);
  };
}
