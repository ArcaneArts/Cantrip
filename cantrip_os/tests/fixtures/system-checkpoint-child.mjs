import { readFile } from "node:fs/promises";
import { LocalDocker, captureSystemCheckpoint } from "../../host/index.mjs";

const [socketPath, inputPath, heldAction] = process.argv.slice(2);
const input = JSON.parse(await readFile(inputPath, "utf8"));
const engine = new LocalDocker(socketPath);
const request = engine.request.bind(engine);
engine.request = async (method, path, body, options) => {
  const result = await request(method, path, body, options);
  const action = path.startsWith("/commit?")
    ? "commit"
    : path.endsWith("/start")
      ? "start"
      : null;
  if (method === "POST" && action === heldAction) {
    process.send?.({
      event: "real-effect-reply-withheld",
      action,
      receipt: result,
    });
    await new Promise(() => setInterval(() => {}, 1000));
  }
  return result;
};
const result = await captureSystemCheckpoint(engine, input);
console.log(
  JSON.stringify({
    state: result.operation.state,
    phase: result.operation.phase,
  }),
);
process.exitCode = result.operation.state === "ready" ? 0 : 1;
