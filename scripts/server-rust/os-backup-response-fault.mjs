// Test-only Worker preload. Drop one completed backup response selected by
// operation ID. The production worker still executes and journals the command.
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const directory = process.env.CANTRIP_TEST_BACKUP_RESPONSE_DIRECTORY;
if (directory) {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  const WebSocket = require("ws");
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data, ...options) {
    if (typeof data === "string" && data.includes('"protectedResult"')) {
      const envelope = JSON.parse(data);
      const result = envelope.result;
      if (
        envelope.kind === "response" &&
        envelope.ok === true &&
        result?.state === "ready" &&
        ["restore", "rollback"].includes(result.action) &&
        /^[a-f0-9-]{36}$/.test(result.operationId)
      ) {
        const base = path.join(directory, result.operationId);
        if (existsSync(base + ".armed")) {
          unlinkSync(base + ".armed");
          writeFileSync(
            base + ".tmp",
            JSON.stringify({ pid: process.pid, envelope }),
          );
          renameSync(base + ".tmp", base + ".json");
          return;
        }
      }
    }
    return send.call(this, data, ...options);
  };
}
