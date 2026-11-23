// Withhold the full worker's successful Resume response on its old socket.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const file = process.env.CANTRIP_TEST_QUEUE_RESUME_ACK;
if (
  file &&
  process.argv[1] === process.env.CANTRIP_TEST_QUEUE_RESUME_ACK_WORKER_ENTRY
) {
  const { WebSocket } = createRequire(process.argv[1])("ws");
  const emit = WebSocket.prototype.emit;
  const send = WebSocket.prototype.send;
  let target;
  WebSocket.prototype.emit = function (event, ...args) {
    if (
      !target &&
      event === "message" &&
      existsSync(file + ".armed") &&
      String(args[0]).startsWith("{")
    ) {
      const frame = JSON.parse(String(args[0]));
      if (
        frame.kind === "request" &&
        frame.command?.type === "chat.automation.resume" &&
        frame.command.chatId === readFileSync(file + ".armed", "utf8")
      ) {
        target = { requestId: frame.requestId, socket: this };
      }
    }
    return emit.call(this, event, ...args);
  };
  WebSocket.prototype.send = function (data, ...args) {
    if (
      target?.socket === this &&
      typeof data === "string" &&
      data.startsWith("{")
    ) {
      const frame = JSON.parse(data);
      if (
        frame.kind === "response" &&
        frame.requestId === target.requestId &&
        frame.ok === true &&
        frame.result?.resumed === true
      ) {
        writeFileSync(
          file + ".tmp",
          JSON.stringify({
            requestId: frame.requestId,
            resumed: frame.result.resumed,
          }),
        );
        renameSync(file + ".tmp", file + ".held");
        return;
      }
    }
    return send.call(this, data, ...args);
  };
}
