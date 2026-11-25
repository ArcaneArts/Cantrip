// Forward the bundled app-server protocol and inject one controlled native frame.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const { WebSocket, WebSocketServer } = createRequire(
  new URL("../../tests/reference-node-worker/package.json", import.meta.url),
)("ws");
const [binary, marker, prompt, scenario, ...args] = process.argv.slice(2);
const liveYolo = scenario === "live-yolo";
const restoring =
  scenario === "resume-approval" ||
  scenario === "resume-cua" ||
  scenario === "resume-guest";
if (
  args[0] !== "app-server" ||
  !args.some((argument) => argument.startsWith("ws://"))
) {
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
      let liveTurn,
        downgrade,
        liveTurnCount = 0;
      function requestApproval(suffix, method, fields) {
        worker.send(
          JSON.stringify({
            id: approvalId + suffix,
            method: `item/${method}/requestApproval`,
            params: {
              ...liveTurn,
              itemId: `fixture-item${suffix}`,
              startedAtMs: Date.now(),
              ...fields,
            },
          }),
        );
      }
      worker.pause();
      native.once("open", () => worker.resume());
      worker.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        const approval =
          scenario === "approval" || scenario === "resume-approval" || liveYolo;
        if (
          approval &&
          (frame.id === approvalId ||
            (liveYolo &&
              typeof frame.id === "string" &&
              frame.id.startsWith(approvalId))) &&
          !frame.method
        ) {
          writeFileSync(marker, `${JSON.stringify(frame)}\n`, {
            flag: "a",
            mode: 0o600,
          });
          if (liveYolo && frame.id === approvalId)
            requestApproval("-file", "fileChange", {});
          return;
        }
        if (
          liveYolo &&
          frame.method === "thread/settings/update" &&
          frame.params.permissions === ":read-only"
        ) {
          downgrade = frame.id;
        }
        if (restoring && frame.method === "turn/suspension") {
          const { operation, threadId } = frame.params;
          native.send(raw, { binary: false });
          if (operation.type === "pause") {
            writeFileSync(
              marker + ".pause",
              JSON.stringify({ threadId, turnId: operation.turnId }),
              { mode: 0o600 },
            );
          } else if (operation.type === "resume") {
            if (approval) targets.set(frame.id, threadId);
            if (scenario === "resume-guest") {
              writeFileSync(
                marker + ".resume",
                JSON.stringify({
                  threadId,
                  turnId: operation.suspension.turnId,
                }),
                { mode: 0o600 },
              );
            }
          }
          return;
        }
        if (scenario === "resume-guest" && frame.method === "turn/interrupt") {
          const { threadId, turnId } = frame.params;
          writeFileSync(
            marker + ".stop",
            JSON.stringify({ threadId, turnId }),
            {
              mode: 0o600,
            },
          );
        }
        if (
          !restoring &&
          frame.method === "turn/start" &&
          frame.params?.input?.some((item) => item.text === prompt)
        ) {
          if (scenario === "approval" || liveYolo) {
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
        if (!targets.size && !downgrade) return;
        const frame = JSON.parse(String(raw));
        if (liveYolo && frame.id === downgrade && frame.result) {
          downgrade = null;
          requestApproval("-permissions", "permissions", {
            cwd: process.cwd(),
            permissions: { network: { enabled: true } },
          });
        }
        const threadId = targets.get(frame.id);
        if (!threadId) return;
        const turnId =
          scenario === "resume-approval"
            ? frame.result?.suspension?.turnId
            : frame.result?.turn?.id;
        if (!turnId) return;
        targets.delete(frame.id);
        if (liveYolo) {
          liveTurn = { threadId, turnId };
          liveTurnCount += 1;
        }
        worker.send(
          JSON.stringify({
            id:
              liveTurnCount > 1 ? `${approvalId}-${liveTurnCount}` : approvalId,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId,
              turnId,
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
