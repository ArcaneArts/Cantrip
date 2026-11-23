import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function holdSystemWorker({
  directory,
  command,
  hold,
  holdId,
  key,
  managerModule,
}) {
  const trace = join(directory, `child-${hold}.jsonl`),
    marker = join(directory, `held-${hold}.json`);
  const config = join(directory, `child-${hold}.json`);
  await writeFile(
    config,
    JSON.stringify({
      directory,
      command,
      hold,
      holdId,
      key: key.toString("base64"),
      managerModule,
      trace,
      marker,
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./system-worker-child.mjs", import.meta.url)),
      config,
    ],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      void appendFile(join(directory, `child-${hold}.log`), bytes);
    });
  try {
    const value = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error("System Worker did not reach its actual held reply"),
          ),
        240_000,
      );
      child.once("message", (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`System Worker ended before held reply: ${code}`));
      });
    });
    assert.equal(value.held, hold, JSON.stringify(value));
    const closed = once(child, "close");
    child.kill("SIGKILL");
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    return (await readFile(trace, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
  }
}
