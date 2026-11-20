// Forward the bundled app-server protocol, injecting one definite
// no-consumption response before Codex sees the selected turn/start.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const { WebSocket, WebSocketServer } = createRequire(
  new URL("../../cantrip_worker/package.json", import.meta.url),
)("ws");
const [binary, marker, prompt, ...args] = process.argv.slice(2);
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
      worker.pause();
      native.once("open", () => worker.resume());
      worker.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (
          frame.method === "turn/start" &&
          frame.params?.input?.some((item) => item.text === prompt)
        ) {
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
      native.on("message", (raw) => worker.send(raw, { binary: false }));
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
