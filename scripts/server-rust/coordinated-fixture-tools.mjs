import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { repositoryRoot } from "./cargo.mjs";
const { createClient } = createRequire(
  path.join(repositoryRoot, "cantrip_server/package.json"),
)("redis");
export async function redisFixture(binary, root) {
  const socket = createServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const url = `redis://127.0.0.1:${port}`;
  let child,
    client,
    sequence = 0;
  const api = {
    url,
    port,
    get client() {
      return client;
    },
    async start() {
      let log = "",
        error;
      child = spawn(
        binary,
        [
          "--bind",
          "127.0.0.1",
          "--port",
          String(port),
          "--save",
          "",
          "--appendonly",
          "no",
          "--dir",
          root,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.on("data", (b) => {
        log += b;
      });
      child.stderr.on("data", (b) => {
        log += b;
      });
      child.on("error", (e) => {
        error = e;
      });
      child.once("close", () =>
        writeFile(path.join(root, `redis-${++sequence}.log`), log),
      );
      const until = Date.now() + 15000;
      while (true) {
        if (error) throw error;
        if (child.exitCode !== null)
          throw new Error(`Private Redis exited ${child.exitCode}: ${log}`);
        const candidate = createClient({
          url,
          socket: { reconnectStrategy: false },
        });
        candidate.on("error", () => {});
        try {
          await candidate.connect();
          if ((await candidate.ping()) !== "PONG")
            throw new Error("Private Redis PING");
          client = candidate;
          break;
        } catch (e) {
          if (candidate.isOpen) candidate.destroy();
          if (Date.now() > until) throw e;
          await delay(20);
        }
      }
    },
    async stop() {
      if (client?.isOpen) client.destroy();
      client = null;
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise((r) => child.once("close", r));
        child.kill("SIGKILL");
        await closed;
      }
    },
  };
  await api.start();
  return api;
}
export function bridgePeer(
  kind,
  executable,
  root,
  name,
  nodeScript = "scripts/server-rust/coordinated-bridge-node.mjs",
) {
  const child = spawn(
    kind === "node" ? process.execPath : executable,
    kind === "node" ? ["--import", "tsx", nodeScript] : [],
    { cwd: repositoryRoot, env: process.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let next = 0,
    stdout = "",
    stderr = "";
  const pending = new Map();
  const terminal = () => child.exitCode !== null || child.signalCode !== null;
  const fail = (error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.once("exit", (code, signal) =>
    fail(new Error(`${name} exited ${code}/${signal}: ${stderr}`)),
  );
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    stdout += line + "\n";
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    const p = pending.get(r.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(r.id);
    p.resolve(r);
  });
  const peer = {
    kind,
    name,
    events: [],
    async call(op, fields = {}) {
      const id = ++next;
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${name} ${op} RPC timed out: ${stderr}`));
        }, 20000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, op, ...fields }) + "\n");
      });
      if (Object.hasOwn(response, "error")) throw new Error(response.error);
      return response.result;
    },
    async drain() {
      this.events.push(...(await this.call("events")));
      return this.events;
    },
    stop() {
      this.stopping ??= (async () => {
        try {
          if (!terminal()) {
            await this.call("close");
            child.stdin.end();
          }
          const closed = new Promise((r) =>
            terminal() ? r() : child.once("close", r),
          );
          await Promise.race([
            closed,
            delay(5000, undefined, { ref: false }).then(() => {
              if (!terminal()) throw new Error(`${name} fixture did not stop`);
            }),
          ]);
        } finally {
          if (!terminal()) child.kill("SIGKILL");
          await writeFile(path.join(root, name + ".stdout.jsonl"), stdout);
          await writeFile(path.join(root, name + ".stderr.log"), stderr);
        }
      })();
      return this.stopping;
    },
  };
  return peer;
}
export async function eventually(read, accept, name) {
  const until = Date.now() + 15000;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > until)
      throw new Error(
        `Timed out ${name}: ${JSON.stringify(value).slice(-3000)}`,
      );
    await delay(15);
  }
}
