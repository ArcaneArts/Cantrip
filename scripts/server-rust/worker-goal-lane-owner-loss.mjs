// Hold a native observation response after a real Goal commit. The peer-loss
// case drops it on disconnect. Dependency cases release it while the service is down.
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const file = process.env.CANTRIP_TEST_GOAL_LANE_OWNER_LOSS;
if (
  file &&
  process.argv[1] === process.env.CANTRIP_TEST_GOAL_LANE_WORKER_ENTRY
) {
  const { WebSocket } = createRequire(process.argv[1])("ws");
  const emit = WebSocket.prototype.emit;
  const send = WebSocket.prototype.send;
  const fetch = globalThis.fetch;
  const requests = new Map();
  const held = [];
  const dependency = process.env.CANTRIP_TEST_GOAL_LANE_DEPENDENCY;
  let receipt, oldSocket, interrupted, resumeTimer;
  function report() {
    const temporary = file + ".tmp";
    writeFileSync(temporary, JSON.stringify(receipt) + "\n");
    renameSync(temporary, file);
  }
  function releaseDuringOutage() {
    if (!existsSync(file + ".resume")) return;
    clearInterval(resumeTimer);
    interrupted = true;
    receipt.releasedObservations = held.map(({ socket, data, args }) => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      send.call(socket, data, ...args);
      return true;
    });
    report();
  }
  WebSocket.prototype.emit = function (event, ...args) {
    if (
      receipt &&
      !interrupted &&
      event === "message" &&
      String(args[0]).startsWith("{")
    ) {
      const frame = JSON.parse(String(args[0]));
      if (
        frame.kind === "request" &&
        frame.command?.type === "chat.goal.get" &&
        frame.command.chatId === receipt.chatId
      ) {
        requests.set(frame.requestId, frame.command.observeExecution === true);
        oldSocket ??= this;
      }
    }
    if (this === oldSocket && event === "close") interrupted = true;
    return emit.call(this, event, ...args);
  };
  WebSocket.prototype.send = function (data, ...args) {
    if (
      this === oldSocket &&
      !interrupted &&
      typeof data === "string" &&
      data.startsWith("{")
    ) {
      const frame = JSON.parse(data);
      if (frame.kind === "response" && requests.has(frame.requestId)) {
        receipt.heldObservations.push({
          requestId: frame.requestId,
          observeExecution: requests.get(frame.requestId),
        });
        report();
        if (dependency) {
          held.push({ socket: this, data, args });
          resumeTimer ??= setInterval(releaseDuringOutage, 25).unref();
        }
        return;
      }
    }
    return send.call(this, data, ...args);
  };
  globalThis.fetch = async (input, options) => {
    const url = input instanceof URL ? input.href : input;
    if (
      !receipt &&
      typeof url === "string" &&
      url.endsWith("/api/internal/native-commands/task-goal-outcome")
    ) {
      const body = JSON.parse(options.body);
      if (body.inputKind === "goal-cycle") {
        receipt = {
          chatId: body.notification.chatId,
          turnId: body.goalCycleSource.turnId,
          deliveryId: body.deliveryId,
          heldObservations: [],
        };
        const response = await fetch(input, options);
        receipt.status = response.status;
        receipt.committed = (await response.clone().json()).committed === true;
        report();
        return response;
      }
    }
    return fetch(input, options);
  };
}
