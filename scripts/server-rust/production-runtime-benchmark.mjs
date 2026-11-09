import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify, parseArgs } from "node:util";
import { fixtureEnvironment } from "./process.mjs";
import { LiveProbe } from "./live-sockets.mjs";

// Production entry points only. This first workload measures a small local
// profile: readiness, process-tree RSS, durable settings, ordinary reads and
// App Live latency/catch-up. It does not qualify bulk relay throughput.
const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    root: { type: "string" },
    artifact: { type: "string" },
  },
});
assert.ok(["node", "rust"].includes(values.runtime));
const root = path.resolve(values.root);
const profile = path.join(root, values.runtime, "profile");
const reports = path.join(root, values.runtime, "runs");
await mkdir(reports, { recursive: true });
const artifact = path.resolve(values.artifact);
const execute = promisify(execFile);
const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    median:
      sorted.length % 2
        ? sorted[Math.floor(sorted.length / 2)]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
  };
};
const listener = net.createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve, reject) =>
  listener.close((e) => (e ? reject(e) : resolve())),
);
const origin = `http://127.0.0.1:${port}`;
const environment = {
  ...fixtureEnvironment(profile),
  NODE_ENV: "production",
  CANTRIP_BOOTSTRAP_MODE: "standalone",
  CANTRIP_SERVER_PORT: String(port),
  CANTRIP_APP_ORIGINS: "http://127.0.0.1:5173",
  CANTRIP_LICENSE_WHITELIST_ENABLED: "false",
  CANTRIP_API_RATE_LIMIT_PER_MINUTE: "100000",
  CANTRIP_PAIRING_RATE_LIMIT_PER_MINUTE: "1000",
};
delete environment.CANTRIP_WORKER_TOKEN;
const command =
  values.runtime === "node"
    ? process.execPath
    : path.join(artifact, "bin/cantrip-server");
const args =
  values.runtime === "node"
    ? [path.resolve("cantrip_server/dist/index.js")]
    : ["--database", "pglite", "--port", String(port)];
if (values.runtime === "rust")
  environment.PGLITE_RUNTIME_DIR = path.join(artifact, "pglite");
const startedAt = performance.now();
const child = spawn(command, args, {
  cwd: path.resolve("cantrip_server"),
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
});
let diagnostics = "",
  spawnError;
child.once("error", (e) => {
  spawnError = e;
});
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (b) => {
    diagnostics = (diagnostics + b.toString()).slice(-4 * 1024 * 1024);
  });
const completion = new Promise((resolve) =>
  child.once("close", (code, signal) => resolve({ code, signal })),
);
const result = {
  runtime: values.runtime,
  pid: child.pid,
  platform: process.platform,
  architecture: process.arch,
  osRelease: os.release(),
  nodeVersion: process.version,
  dataset: {
    users: 1,
    projects: 0,
    chats: 0,
    settingsWrites: 20,
    temporaryWorkerEnrollments: 40,
  },
  scope:
    "Small-profile local PGlite production server; RSS sums resident pages of the process tree, including shared mappings. Paused-consumer catch-up is not a bulk relay/backpressure qualification.",
  loadAverage: os.loadavg(),
  status: "running",
};
const cookies = new Map();
let csrf, probe;
async function request(
  route,
  body,
  method = body ? "PATCH" : "GET",
  status = 200,
) {
  const response = await fetch(origin + route, {
    method,
    headers: {
      origin: "http://127.0.0.1:5173",
      cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      ...(csrf ? { "x-cantrip-csrf": csrf } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0],
      at = pair.indexOf("=");
    cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const data = response.status === 204 ? null : await response.json();
  assert.equal(response.status, status, `${route}: status ${response.status}`);
  if (response.status === 204) return null;
  if (data.csrfToken) csrf = data.csrfToken;
  return data;
}
async function rss() {
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,rss="]);
  const rows = stdout
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));
  const owned = new Set([child.pid]);
  for (;;) {
    const before = owned.size;
    for (const [pid, ppid] of rows) if (owned.has(ppid)) owned.add(pid);
    if (owned.size === before) break;
  }
  const selected = rows.filter(([pid]) => owned.has(pid));
  return {
    totalKiB: selected.reduce((sum, row) => sum + row[2], 0),
    processes: selected.map(([pid, ppid, rssKiB]) => ({ pid, ppid, rssKiB })),
  };
}
try {
  for (;;) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Server exited during readiness: " + diagnostics);
    try {
      await request("/readyz");
      break;
    } catch (error) {
      if (performance.now() - startedAt > 60000) throw error;
    }
    await delay(10);
  }
  result.readyMs = performance.now() - startedAt;
  await request("/api/auth/session");
  result.identity = (await request("/api/bootstrap")).server.id;
  let previous;
  try {
    previous = JSON.parse(
      await readFile(path.join(root, values.runtime, "previous.json"), "utf8"),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (previous) {
    assert.equal(result.identity, previous.identity);
    assert.equal((await request("/api/settings")).preferences.theme, "dark");
    result.previousWritesRetained = true;
  }
  await delay(250);
  const idle = [];
  for (let i = 0; i < 5; i++) {
    const sample = await rss();
    idle.push(sample.totalKiB);
    result.idleProcessTree = sample.processes;
    await delay(50);
  }
  result.idleRssKiB = stats(idle);
  const routes = ["/api/bootstrap", "/api/settings", "/api/projects"];
  for (let i = 0; i < 30; i++) await request(routes[i % routes.length]);
  const times = Object.fromEntries(routes.map((r) => [r, []]));
  for (let i = 0; i < 180; i++) {
    const route = routes[i % routes.length],
      t = performance.now();
    await request(route);
    times[route].push(performance.now() - t);
  }
  result.httpLatencyMs = Object.fromEntries(
    Object.entries(times).map(([k, v]) => [k, stats(v)]),
  );
  const concurrentAt = performance.now();
  await Promise.all(
    Array.from({ length: 8 }, async (_, client) => {
      for (let i = 0; i < 30; i++)
        await request(routes[(i + client) % routes.length]);
    }),
  );
  result.concurrentReads = {
    requests: 240,
    clients: 8,
    durationMs: performance.now() - concurrentAt,
  };
  result.concurrentReads.requestsPerSecond =
    240000 / result.concurrentReads.durationMs;
  probe = new LiveProbe({ server: { origin }, client: () => ({ cookies }) });
  await probe.open();
  await probe.initialized();
  await probe.subscribed();
  for (let i = 0; i < 10; i++) await probe.ping("warmup-" + i);
  const pings = [];
  for (let i = 0; i < 100; i++) {
    const t = performance.now();
    await probe.ping("measure-" + i);
    pings.push(performance.now() - t);
  }
  result.livePingMs = stats(pings);
  const writes = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    await request("/api/settings", { theme: i % 2 ? "dark" : "light" });
    writes.push(performance.now() - t);
  }
  result.settingsWriteMs = stats(writes);
  const workers = [];
  async function enroll(index) {
    const workerId = `benchmark-${child.pid}-${index}`;
    const code = await request(
      "/api/workers/enrollment-codes",
      {},
      "POST",
      201,
    );
    await request(
      "/api/internal/workers/enroll",
      {
        code: code.code,
        heartbeat: {
          workerId,
          name: "Benchmark worker",
          platform: process.platform,
          architecture: process.arch,
          codexVersion: null,
          startedAt: "2026-11-09T00:00:00.000Z",
        },
      },
      "POST",
      201,
    );
    workers.push(workerId);
    return workerId;
  }
  const events = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now(),
      id = await enroll(i);
    await probe.message(
      (f) => f.type === "event" && f.resource === "worker" && f.entityId === id,
    );
    events.push(performance.now() - t);
  }
  result.workerEnrollmentToLiveMs = stats(events);
  probe.socket.pause();
  const pausedAt = performance.now();
  for (let i = 20; i < 40; i++) await enroll(i);
  result.pausedConsumerWriteMs = performance.now() - pausedAt;
  result.pausedConsumerRss = await rss();
  const resumedAt = performance.now();
  probe.socket.resume();
  for (const id of workers.slice(20))
    await probe.message(
      (f) => f.type === "event" && f.resource === "worker" && f.entityId === id,
    );
  await probe.ping("drained");
  result.pausedConsumerCatchupMs = performance.now() - resumedAt;
  assert.equal((await request("/api/settings")).preferences.theme, "dark");
  await probe.close();
  probe = undefined;
  for (const id of workers)
    await request("/api/workers/" + id, undefined, "DELETE", 204);
  assert.deepEqual(await request("/api/workers"), []);
  await writeFile(
    path.join(root, values.runtime, "previous.json"),
    JSON.stringify({ identity: result.identity }) + "\n",
  );
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  probe?.socket.terminate();
  const stoppedAt = performance.now();
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  result.exit = await completion;
  clearTimeout(timer);
  result.shutdownMs = performance.now() - stoppedAt;
  if (result.exit.code !== 0) {
    result.status = "failed";
    process.exitCode = 1;
  }
  const prefix = path.join(reports, `${Date.now()}-${child.pid}`);
  await writeFile(prefix + ".json", JSON.stringify(result, null, 2) + "\n");
  await writeFile(prefix + ".log", diagnostics);
}
if (result.status !== "passed")
  throw new Error(JSON.stringify(result.failure ?? result.exit));
console.log("benchmark complete");
