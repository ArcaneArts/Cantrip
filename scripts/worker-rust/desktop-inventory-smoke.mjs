// Exercise the production worker command over its authenticated Core socket.
// The real cantrip-cua executable uses its explicit deterministic backend.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { on, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  decryptSurfacePrivateState,
  wrapComponentKeyForWorker,
} from "../../packages/crypto/dist/index.js";

async function withTimeout(work, milliseconds, action) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(action + " timed out.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const { values } = parseArgs({
  options: Object.fromEntries(
    ["worker", "codex", "helper"].map((name) => [name, { type: "string" }]),
  ),
});
assert.ok(values.worker && values.codex && values.helper);
const require = createRequire(
  new URL("../../cantrip_worker/package.json", import.meta.url),
);
const { WebSocketServer } = require("ws");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-desktop-inventory-"));
const serverId = randomUUID();
const ownerId = randomUUID();
const workerId = "desktop-inventory-fixture";
const token = "ctwk_" + "D".repeat(43);
const key = randomBytes(32);
const component = "surface-private-state";
const time = new Date().toISOString();
let grant = false;
let failure;
const helper = path.join(root, "capture-helper");
const pids = path.join(root, "helper-pids");
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
await writeFile(
  helper,
  `#!/bin/sh\nprintf '%s\\n' "$$" >> ${quote(pids)}\nexec ${quote(path.resolve(values.helper))} --backend fake\n`,
  { mode: 0o700 },
);

async function bootstrap(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const { principalId, publicKey } = JSON.parse(Buffer.concat(chunks));
  const grants = grant
    ? [
        {
          id: randomUUID(),
          ownerId,
          principalId,
          component,
          keyRevision: 1,
          wrappedKey: await wrapComponentKeyForWorker({
            ownerId,
            workerId,
            component,
            keyRevision: 1,
            componentKey: key,
            workerPublicKey: publicKey,
          }),
          state: "active",
          revision: 1,
          revokedAt: null,
          revokedReason: null,
          createdAt: time,
          updatedAt: time,
        },
      ]
    : [];
  return {
    serverId,
    ownerId,
    principal: {
      id: principalId,
      ownerId,
      workerId,
      kind: "worker",
      label: null,
      publicKey,
      state: "approved",
      revision: 1,
      approvedAt: time,
      revokedAt: null,
      revokedReason: null,
      createdAt: time,
      updatedAt: time,
    },
    grants,
  };
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, "Bearer " + token);
    const value =
      request.url === "/api/internal/workers/encryption/bootstrap"
        ? await bootstrap(request)
        : {};
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  } catch (error) {
    failure ??= error;
    response.writeHead(500).end("{}");
  }
});
const sockets = new WebSocketServer({
  server,
  handleProtocols: () => "cantrip-worker-auth-ready-v1",
});
sockets.on("connection", (socket, request) => {
  const connectionGeneration = new URL(
    request.url,
    "http://127.0.0.1",
  ).searchParams.get("connectionGeneration");
  for (const state of ["pending", "ready"]) {
    socket.send(
      JSON.stringify({
        kind: "connection",
        state,
        protocolVersion: 1,
        connectionGeneration,
      }),
    );
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

const connection = once(sockets, "connection");
const child = spawn(
  path.resolve(values.worker),
  ["--shutdown-on-stdin-close"],
  {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      HOME: root,
      PATH: "",
      NO_COLOR: "1",
      CANTRIP_WORKER_ID: workerId,
      CANTRIP_WORKER_CREDENTIAL: token,
      CANTRIP_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      CANTRIP_WORKER_DATA_DIR: path.join(root, "profile"),
      CANTRIP_CODEX_BIN: path.resolve(values.codex),
      CANTRIP_CUA_BIN: helper,
    },
  },
);
const exit = once(child, "close");
let diagnostics = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-32_000);
  });
}

try {
  let [socket] = await withTimeout(connection, 20_000, "Worker connection");
  async function send(command) {
    const requestId = randomUUID();
    const pending = new AbortController();
    const reply = (async () => {
      for await (const [raw] of on(socket, "message", {
        signal: pending.signal,
      })) {
        const response = JSON.parse(raw);
        if (response.kind === "response" && response.requestId === requestId)
          return response;
      }
    })();
    socket.send(JSON.stringify({ kind: "request", requestId, command }));
    try {
      return await withTimeout(reply, 20_000, command.type);
    } finally {
      pending.abort();
    }
  }
  const scan = (extra = {}) => ({
    type: "surface.desktop.targets",
    serverId,
    resourceId: workerId,
    operationId: randomUUID(),
    limit: 10,
    ...extra,
  });
  const readPids = async () =>
    (await readFile(pids, "utf8")).trim().split("\n").map(Number);
  assert.equal((await send(scan())).ok, false);
  await assert.rejects(readPids, { code: "ENOENT" });
  grant = true;
  assert.equal(
    (
      await send({
        type: "worker.encryption.refresh",
        component,
        keyRevision: 1,
      })
    ).ok,
    true,
  );
  assert.equal((await send(scan({ resourceId: "foreign-worker" }))).ok, false);
  assert.equal((await send(scan({ serverId: randomUUID() }))).ok, false);
  await assert.rejects(readPids, { code: "ENOENT" });

  const request = scan();
  async function inspect(command, counts) {
    const response = await send(command);
    assert.equal(response.ok, true, JSON.stringify(response));
    const { result } = response;
    assert.equal(result.operationId, command.operationId);
    assert.deepEqual(
      [result.monitorCount, result.windowCount, result.truncated],
      counts,
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /CUA fixture|fake-monitor|fake-window/,
    );
    const context = {
      serverId,
      resource: "remote-desktop-inventory",
      resourceId: workerId,
      operationId: result.operationId,
      recordKind: "remote-desktop-inventory",
    };
    const credentials = {
      componentKey: key,
      ownerId,
      keyRevision: 1,
      opaque: result.stateProtection,
    };
    await assert.rejects(
      decryptSurfacePrivateState({
        ...credentials,
        context: { ...context, operationId: randomUUID() },
      }),
    );
    return decryptSurfacePrivateState({ ...credentials, context });
  }
  const inventory = await inspect(request, [1, 1, false]);
  assert.deepEqual(inventory.monitors, [
    {
      kind: "monitor",
      id: "fake-monitor",
      name: "CUA fixture monitor",
      x: -320,
      y: -90,
      width: 320,
      height: 180,
      primary: true,
    },
  ]);
  assert.deepEqual(inventory.windows, [
    {
      kind: "window",
      id: "fake-window",
      application: "Cantrip CUA fixture",
      title: "CUA fixture window",
      iconKey: null,
      x: 24,
      y: 32,
      width: 160,
      height: 100,
      minimized: false,
      focused: false,
    },
  ]);
  const replay = await send(request);
  assert.equal(replay.ok, false);
  assert.match(replay.error.message, /replayed/);
  const limited = await inspect(scan({ limit: 1 }), [1, 0, true]);
  assert.deepEqual(limited.monitors, inventory.monitors);
  assert.deepEqual(limited.windows, []);
  const [pid] = await readPids();
  assert.deepEqual(await readPids(), [pid]);

  const reconnect = once(sockets, "connection");
  socket.close();
  [socket] = await withTimeout(reconnect, 20_000, "Worker reconnect");
  assert.match((await send(request)).error.message, /replayed/);
  assert.deepEqual(await inspect(scan(), [1, 1, false]), inventory);
  const [oldPid, newPid] = await readPids();
  assert.equal(oldPid, pid);
  assert.notEqual(newPid, pid);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

  child.stdin.end();
  assert.equal((await withTimeout(exit, 12_000, "Worker shutdown"))[0], 0);
  assert.throws(() => process.kill(newPid, 0), { code: "ESRCH" });
  if (failure) throw failure;
  console.log(
    JSON.stringify({ suite: "native-desktop-inventory", passed: true }),
  );
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  key.fill(0);
  try {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await withTimeout(exit, 4_000, "Worker cleanup").catch(async () => {
        child.kill("SIGKILL");
        await exit;
      });
    }
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
