// Real standalone Node distribution, observed through its actual health endpoint.
// Its human-readable console log is not the test launcher's JSON event stream.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function startPackagedNodeServer(
  directory,
  environment,
  { nodeExecutable, port = 0, platform = process.platform } = {},
) {
  if (!port) {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    port = listener.address().port;
    await new Promise((resolve, reject) =>
      listener.close((e) => (e ? reject(e) : resolve())),
    );
  }
  const child = spawn(
    nodeExecutable ??
      path.join(
        directory,
        "runtime",
        process.platform === "win32" ? "node.exe" : "node",
      ),
    [
      ...(platform === "win32"
        ? [
            "--import",
            new URL("./legacy-node-shutdown.mjs", import.meta.url).href,
          ]
        : []),
      path.join(directory, "dist/index.js"),
    ],
    {
      cwd: directory,
      env: { ...environment, CANTRIP_SERVER_PORT: String(port) },
      stdio: [platform === "win32" ? "pipe" : "ignore", "pipe", "pipe"],
    },
  );
  let diagnostics = "",
    spawnError;
  child.once("error", (e) => {
    spawnError = e;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-262144);
    });
  const completion = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const origin = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 60_000;
    let last;
    for (;;) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          "Packaged Node server exited during startup: " + diagnostics,
        );
      try {
        const response = await fetch(origin + "/readyz", {
          signal: AbortSignal.timeout(5000),
        });
        if (response.status === 200 && (await response.json()).database.engine)
          break;
      } catch (error) {
        last = error;
      }
      assert.ok(
        Date.now() < deadline,
        "Packaged Node /readyz timed out: " + String(last) + "\n" + diagnostics,
      );
      await delay(50);
    }
  } catch (error) {
    child.kill("SIGKILL");
    await completion;
    throw error;
  }
  return {
    origin,
    child,
    diagnostics: () => diagnostics,
    events: [],
    async close({ shutdownTimeoutMs = 30_000 } = {}) {
      if (child.exitCode === null && child.signalCode === null) {
        if (platform === "win32") child.stdin.end();
        else child.kill("SIGTERM");
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), shutdownTimeoutMs);
      try {
        const result = await completion;
        assert.equal(
          result.code,
          0,
          "Packaged Node shutdown: " +
            JSON.stringify(result) +
            "\n" +
            diagnostics,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
