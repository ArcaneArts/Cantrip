// Forward the bundled app-server protocol and inject one controlled native frame.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const { WebSocket, WebSocketServer } = createRequire(
  new URL("../../cantrip_worker/package.json", import.meta.url),
)("ws");
const [binary, marker, prompt, scenario, ...args] = process.argv.slice(2);
if (!args.some((argument) => argument.startsWith("ws://"))) {
  const child = spawn(binary, args, { stdio: "inherit" });
  child.once("close", (code) => process.exit(code ?? 1));
} else {
  const child = spawn(binary, args, { stdio: ["inherit", "pipe", "pipe"] });
  let relay;
  function subprocessLine(line) {
    const endpoint = /listening on:\s+(ws:\/\/\S+)/u.exec(line)?.[1];
    if (!endpoint || relay) return;
    relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    relay.on("listening", () => {
      console.log(`listening on: ws://127.0.0.1:${relay.address().port}`);
    });
    relay.on("connection", (worker) => {
      const native = new WebSocket(endpoint);
      const targets = new Map();
      const approvalId = "cantrip-fixture-approval";
      worker.pause();
      native.once("open", () => worker.resume());
      worker.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (
          scenario === "approval" &&
          frame.id === approvalId &&
          !frame.method
        ) {
          writeFileSync(marker, `${JSON.stringify(frame)}\n`, {
            flag: "a",
            mode: 0o600,
          });
          return;
        }
        if (
          frame.method === "turn/start" &&
          frame.params?.input?.some((item) => item.text === prompt)
        ) {
          if (scenario === "approval") {
            targets.set(frame.id, frame.params.threadId);
            native.send(raw, { binary: false });
            return;
          }
          let fresh = false;
          try {
            writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
            fresh = true;
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
          if (fresh) {
            worker.send(
              JSON.stringify({
                id: frame.id,
                error: {
                  code: -32001,
                  message: "Fixture: prior permission change is pending.",
                  data: { reason: "pendingSettings", inputConsumed: false },
                },
              }),
            );
            return;
          }
        }
        native.send(raw, { binary: false });
      });
      native.on("message", (raw) => {
        worker.send(raw, { binary: false });
        if (!targets.size) return;
        const frame = JSON.parse(String(raw));
        const threadId = targets.get(frame.id);
        if (!threadId || !frame.result?.turn?.id) return;
        targets.delete(frame.id);
        worker.send(
          JSON.stringify({
            id: approvalId,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId,
              turnId: frame.result.turn.id,
              itemId: "fixture-item",
              startedAtMs: Date.now(),
              command: "echo private fixture approval",
              availableDecisions: ["accept", "decline", "cancel"],
            },
          }),
        );
      });
      worker.once("close", () => native.close());
      native.once("close", () => worker.close());
      native.on("error", () => worker.terminate());
      worker.on("error", () => native.terminate());
    });
  }
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", subprocessLine);
  }
  child.once("close", (code) => process.exit(code ?? 1));
}
