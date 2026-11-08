import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureEnvironment } from "./process.mjs";
import { repositoryRoot } from "./build.mjs";

export async function waitAccounting(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    assert.ok(Date.now() < deadline, label);
    await delay(25);
  }
}
export async function accountingProductionPeer(
  kind,
  data,
  url,
  flushInterval,
  result,
) {
  await mkdir(data, { recursive: true });
  const listener = createServer();
  await new Promise((yes, no) => {
    listener.once("error", no);
    listener.listen(0, "127.0.0.1", yes);
  });
  const port = listener.address().port;
  await new Promise((yes) => listener.close(yes));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    kind === "node" ? process.execPath : process.env.CANTRIP_RUST_SERVER_BINARY,
    kind === "node"
      ? ["--import", "tsx", "cantrip_server/src/index.ts"]
      : ["--database", "postgres", "--port", String(port)],
    {
      cwd: repositoryRoot,
      env: {
        ...fixtureEnvironment(data),
        DATABASE_URL: url,
        CANTRIP_SERVER_PORT: String(port),
        CANTRIP_LOG_LEVEL: "debug",
        CANTRIP_LICENSE_WHITELIST_ENABLED: "false",
        CANTRIP_STORAGE_RECONCILIATION_INTERVAL_MS: "60000",
        CANTRIP_ACCOUNT_USAGE_MAINTENANCE_INTERVAL_MS: "60000",
        CANTRIP_BANDWIDTH_USAGE_FLUSH_INTERVAL_MS: String(flushInterval),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  Object.assign(result, { pid: child.pid, origin, stdout: "", stderr: "" });
  child.stdout.on("data", (bytes) => {
    result.stdout += bytes;
  });
  child.stderr.on("data", (bytes) => {
    result.stderr += bytes;
  });
  const completion = new Promise((yes, no) => {
    child.once("error", no);
    child.once("close", (code, signal) => {
      result.exit = { code, signal };
      yes(result.exit);
    });
  });
  completion.catch(() => {});
  const text = () =>
    (result.stdout + result.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  const count = (fragment) => text().split(fragment).length - 1;
  async function request(route, options = {}) {
    const response = await fetch(origin + route, {
      ...options,
      headers: { origin: "http://127.0.0.1:5173", ...options.headers },
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body);
  }
  let stopping = false;
  const peer = {
    child,
    request,
    count,
    async waitMessage(fragment, previous = 0, timeout) {
      return waitAccounting(
        () => {
          assert.equal(child.exitCode, null, result.stderr);
          return count(fragment) > previous;
        },
        "Actual production console record: " + fragment,
        timeout,
      );
    },
    stop() {
      if (stopping) return;
      stopping = true;
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    },
    async close() {
      peer.stop();
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      try {
        assert.deepEqual(await completion, { code: 0, signal: null });
      } finally {
        clearTimeout(timer);
      }
    },
    async records() {
      const directory = path.join(data, "logs"),
        records = [];
      for (const name of (await readdir(directory))
        .filter((name) => name.endsWith(".jsonl"))
        .sort())
        records.push(
          ...(await readFile(path.join(directory, name), "utf8"))
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
      return records;
    },
  };
  try {
    await waitAccounting(
      async () => {
        assert.equal(child.exitCode, null, result.stderr);
        try {
          return (await request("/readyz")).database.status === "ready";
        } catch {
          return false;
        }
      },
      "Actual production readiness",
      60000,
    );
    await peer.waitMessage("Account usage history maintenance completed");
    return peer;
  } catch (error) {
    await peer.close();
    throw error;
  }
}
