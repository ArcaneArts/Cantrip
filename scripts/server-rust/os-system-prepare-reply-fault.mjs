// Lose one real Worker prepare reply after its encrypted journal is durable.
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const directory = process.env.CANTRIP_TEST_SYSTEM_PREPARE_REPLY_DIRECTORY;
if (directory) {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  const WebSocket = require("ws");
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data, ...options) {
    if (typeof data === "string" && data.includes('"prepared"')) {
      const envelope = JSON.parse(data);
      const result = envelope.result;
      if (
        envelope.kind === "response" &&
        envelope.ok === true &&
        result?.action === "capture" &&
        result.state === "running" &&
        result.phase === "prepared" &&
        result.protectedResult &&
        /^[a-f0-9-]{36}$/.test(result.operationId)
      ) {
        const base = path.join(directory, result.operationId);
        if (existsSync(base + ".armed")) {
          unlinkSync(base + ".armed");
          writeFileSync(
            base + ".tmp",
            JSON.stringify({
              operationId: result.operationId,
              phase: result.phase,
            }),
          );
          renameSync(base + ".tmp", base + ".json");
          return;
        }
      }
    }
    return send.call(this, data, ...options);
  };
}
