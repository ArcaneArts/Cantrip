// Test-only preload: observe the production launch without changing its command,
// streams, timing policy or result. CI keeps the actual startup failure evidence.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const directory = process.env.CANTRIP_TEST_CHROMIUM_TRACE;
if (directory) {
  mkdirSync(directory, { recursive: true });
  const destination = path.join(
    directory,
    `chromium-startup-${process.pid}.jsonl`,
  );
  const original = childProcess.spawn;
  childProcess.spawn = function (executable, args, options) {
    const child = Reflect.apply(original, this, arguments);
    if (executable === process.env.CANTRIP_CHROMIUM_EXECUTABLE) {
      const write = (event) =>
        appendFileSync(
          destination,
          JSON.stringify({ at: Date.now(), pid: child.pid, ...event }) + "\n",
        );
      write({ event: "spawn", executable, args });
      let bytes = 0;
      child.stderr?.on("data", (chunk) => {
        if (bytes < 16384) {
          const stderr = chunk.subarray(0, 16384 - bytes).toString();
          bytes += Buffer.byteLength(stderr);
          write({ event: "stderr", stderr });
        }
      });
      child.once("error", (error) =>
        write({ event: "error", message: error.message, code: error.code }),
      );
      child.once("exit", (code, signal) =>
        write({ event: "exit", code, signal }),
      );
    }
    return child;
  };
  syncBuiltinESMExports();
}
