// A real external PostgreSQL cluster owned by one acceptance driver.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { deadline } from "./native-broker-client.mjs";
import { eventually } from "./full-worker.mjs";

const execute = promisify(execFile);
const postgres = createRequire(
  new URL("../../tests/reference-node-server/package.json", import.meta.url),
)("postgres");

export async function restartablePostgres(root, bin) {
  await mkdir(root, { recursive: true });
  const directory = path.join(root, "data");
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const url = new URL(`postgres://cantrip_fixture@127.0.0.1:${port}/postgres`);
  url.password = randomUUID();
  const passwordFile = path.join(root, "init-password");
  await writeFile(passwordFile, url.password + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  try {
    await execute(path.join(bin, "initdb"), [
      "-D",
      directory,
      "-U",
      url.username,
      "--encoding=UTF8",
      "--no-locale",
      "--auth=scram-sha-256",
      "--pwfile",
      passwordFile,
    ]);
  } finally {
    await unlink(passwordFile);
  }
  let running;
  let generation = 0;
  async function stop({ immediate = false } = {}) {
    if (!running) return;
    const { child, exit } = running;
    const signal = immediate ? "SIGQUIT" : "SIGINT";
    if (child.exitCode === null && child.signalCode === null)
      assert.equal(child.kill(signal), true);
    const result = await deadline(exit, "owned PostgreSQL did not exit", 15000);
    running = undefined;
    assert.equal(result.code, 0, JSON.stringify(result));
    return { pid: child.pid, port, requestedSignal: signal, ...result };
  }
  async function start() {
    assert.equal(running, undefined);
    const log = await open(
      path.join(root, `postgres-${++generation}.log`),
      "wx",
    );
    const child = spawn(
      path.join(bin, "postgres"),
      [
        "-D",
        directory,
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-c",
        "unix_socket_directories=",
      ],
      { stdio: ["ignore", log.fd, log.fd] },
    );
    running = {
      child,
      exit: new Promise((resolve) => {
        child.once("error", (error) => resolve({ error: error.message }));
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
    };
    await log.close();
    try {
      await eventually(
        async () => {
          const sql = postgres(url.href, { max: 1, connect_timeout: 1 });
          try {
            return (await sql`SELECT 1 AS ready`)[0].ready;
          } catch (error) {
            if (child.exitCode !== null || !child.pid) throw error;
            return error.code;
          } finally {
            await sql.end({ timeout: 1 });
          }
        },
        (result) =>
          assert.equal(result, 1, "PostgreSQL must accept actual SQL"),
        15_000,
      );
      return { pid: child.pid, port };
    } catch (error) {
      await stop().catch(() => {});
      throw error;
    }
  }
  await start();
  return { url: url.href, start, stop };
}
