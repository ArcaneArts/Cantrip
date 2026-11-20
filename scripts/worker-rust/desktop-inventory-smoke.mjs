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
  decryptRemoteSurfaceStreamPayload,
  decryptSurfacePrivateState,
  encryptRemoteSurfaceStreamPayload,
  encryptSurfacePrivateState,
  wrapComponentKeyForWorker,
} from "../../packages/crypto/dist/index.js";
import {
  decodeRemoteSurfaceFrame,
  encodeRemoteSurfaceFrame,
  remoteDesktopServerMessageSchema,
} from "../../packages/protocol/dist/index.js";
import { cuaEffectWorkerStatusSchema } from "../../packages/protocol/dist/computer-use-effects.js";

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
const sharp = require("sharp");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-desktop-inventory-"));
const serverId = randomUUID();
const ownerId = randomUUID();
const workerId = "desktop-inventory-fixture";
const token = "ctwk_" + "D".repeat(43);
const key = randomBytes(32);
const component = "surface-private-state";
const time = new Date().toISOString();
const off = { effect: "off", parameters: {} };
const debug = { effect: "debug-gradient", parameters: { strength: 0.5 } };
const heartbeatEffects = { revision: 4, configuration: off };
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
        : request.url === "/api/internal/workers/heartbeat"
          ? { computerUseEffects: heartbeatEffects }
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
      for await (const [raw, binary] of on(socket, "message", {
        signal: pending.signal,
      })) {
        if (binary) continue;
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
  async function effects(revision, configuration) {
    const response = await send({
      type: "computer-use.effects.sync",
      preferences: { revision, configuration },
    });
    assert.equal(response.ok, true, JSON.stringify(response));
    return cuaEffectWorkerStatusSchema.parse(response.result);
  }
  assert.deepEqual(await effects(2, debug), {
    ...heartbeatEffects,
    state: "idle",
    native: null,
    error: null,
  });
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
  const running = await effects(4, off);
  assert.equal(running.state, "running");
  assert.deepEqual(running.native?.configuration, off);
  assert.equal(running.native?.supported, false);
  assert.equal(running.error, null);
  const rejected = await effects(5, debug);
  assert.equal(rejected.state, "failed");
  assert.equal(rejected.native, null);
  assert.ok(rejected.error);
  assert.deepEqual(await inspect(scan(), [1, 1, false]), inventory);
  const recovered = await effects(6, off);
  assert.equal(recovered.state, "running");
  assert.deepEqual(recovered.native?.configuration, off);
  assert.deepEqual(await effects(5, debug), recovered);
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
  const surfaceId = randomUUID();
  const attachmentId = randomUUID();
  const common = { serverId, surfaceId, configuration: { kind: "desktop" } };
  const row = "remote-desktop-row";
  const selected = {
    kind: "window",
    id: "fake-window",
    application: "Cantrip CUA fixture",
    title: null,
  };
  const monitor = { kind: "monitor", id: "fake-monitor", name: null };
  async function state(target, revision) {
    return {
      stateResource: row,
      stateRevision: revision,
      stateProtection: await encryptSurfacePrivateState({
        ownerId,
        componentKey: key,
        keyRevision: 1,
        content: {
          version: 1,
          classification: { recordKind: "remote-desktop-state" },
          revision,
          target,
        },
        context: {
          serverId,
          resourceId: surfaceId,
          recordKind: "remote-desktop-state",
          resource: row,
          operationId: null,
        },
      }),
    };
  }

  const frames = [];
  socket.on("message", (raw, binary) => {
    if (binary) frames.push(decodeRemoteSurfaceFrame(new Uint8Array(raw)));
  });
  const counters = new Map();
  async function clear({ header, payload }) {
    assert.equal(header.surfaceId, surfaceId);
    assert.equal(header.attachmentId, attachmentId);
    assert.ok(header.sequence > (counters.get(header.channel) ?? -1));
    counters.set(header.channel, header.sequence);
    return Buffer.from(
      await decryptRemoteSurfaceStreamPayload({
        ownerId,
        componentKey: key,
        keyRevision: 1,
        context: {
          surfaceId: header.surfaceId,
          attachmentId: header.attachmentId,
          channel: header.channel,
          sequence: header.sequence,
          surfaceKind: "desktop",
          serverId,
          direction: "worker-to-client",
        },
        protectedPayload: payload,
      }),
    );
  }

  async function untilFrame(accept) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const frame = frames.shift();
      if (frame) {
        const bytes = await clear(frame);
        if (await accept(frame.header.channel, bytes)) return;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw new Error("Expected protected desktop frame did not arrive.");
  }
  async function dimensions(width, height) {
    await untilFrame(async (channel, bytes) => {
      if (channel !== "frame") return false;
      const image = await sharp(bytes).metadata();
      assert.equal(image.format, "jpeg");
      assert.deepEqual([image.width, image.height], [width, height]);
      return true;
    });
  }

  const attached = await send({
    ...common,
    type: "surface.attach",
    attachmentId,
    projectId: "fixture-project",
    preferredTransport: "websocket",
    viewport: { width: 800, height: 600, devicePixelRatio: 1 },
    desktopStream: { targetFps: 5, quality: "balanced" },
    ...(await state(selected, 1)),
  });
  assert.equal(attached.ok, true, JSON.stringify(attached));
  assert.deepEqual(attached.result, { accepted: true, transport: "websocket" });
  await dimensions(320, 200);
  let sequence = 0;
  async function input(message) {
    const header = {
      protocolVersion: 1,
      surfaceId,
      attachmentId,
      channel: "control",
      sequence: sequence++,
    };
    const payload = await encryptRemoteSurfaceStreamPayload({
      ownerId,
      componentKey: key,
      keyRevision: 1,
      context: {
        surfaceId,
        attachmentId,
        channel: header.channel,
        sequence: header.sequence,
        surfaceKind: "desktop",
        serverId,
        direction: "client-to-worker",
      },
      plaintext: Buffer.from(JSON.stringify(message)),
    });
    socket.send(encodeRemoteSurfaceFrame(header, payload));
  }
  let inputEpoch;
  await input({
    type: "viewport",
    viewport: { width: 800, height: 600, devicePixelRatio: 1 },
  });
  await untilFrame((channel, bytes) => {
    if (channel !== "control") return false;
    const message = remoteDesktopServerMessageSchema.parse(JSON.parse(bytes));
    if (message.type !== "desktop-input" || !message.epoch) return false;
    inputEpoch = message.epoch;
    return true;
  });
  await input({
    type: "pointer",
    event: "down",
    button: "left",
    buttons: 1,
    x: 80,
    y: 40,
    inputEpoch,
    inputSequence: 1,
  });
  await untilFrame((channel, bytes) => {
    if (channel !== "control") return false;
    const message = remoteDesktopServerMessageSchema.parse(JSON.parse(bytes));
    if (message.type !== "desktop-cursor") return false;
    assert.deepEqual(message, {
      type: "desktop-cursor",
      id: inputEpoch,
      x: 0.25,
      y: 0.2,
      click: true,
    });
    return true;
  });
  const suspended = await send({ type: "surface.suspend", surfaceId });
  assert.equal(suspended.ok, true);
  await untilFrame(
    (channel, bytes) =>
      channel === "control" &&
      remoteDesktopServerMessageSchema.parse(JSON.parse(bytes)).status ===
        "suspended",
  );
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.ok(frames.every(({ header }) => header.channel !== "frame"));

  const missing = { ...selected, id: "missing-window" };
  assert.equal(
    (
      await send({
        ...common,
        type: "surface.configure",
        ...(await state(missing, 2)),
      })
    ).ok,
    true,
  );
  assert.equal((await send({ type: "surface.resume", surfaceId })).ok, true);
  await untilFrame((channel, bytes) => {
    assert.notEqual(
      channel,
      "frame",
      "An exact missing target cannot fall back to a monitor.",
    );
    return (
      channel === "control" &&
      remoteDesktopServerMessageSchema.parse(JSON.parse(bytes)).status ===
        "error"
    );
  });

  assert.equal(
    (
      await send({
        ...common,
        type: "surface.configure",
        ...(await state(monitor, 3)),
      })
    ).ok,
    true,
  );
  await dimensions(640, 360);
  assert.equal(
    (
      await send({
        ...common,
        type: "surface.configure",
        ...(await state(selected, 2)),
      })
    ).ok,
    false,
  );
  assert.equal(
    (await send({ type: "surface.detach", surfaceId, attachmentId })).ok,
    true,
  );
  frames.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.ok(frames.every(({ header }) => header.channel !== "frame"));
  assert.equal((await send({ type: "surface.close", surfaceId })).ok, true);
  const [pid] = await readPids();
  assert.deepEqual(await readPids(), [pid]);

  const reconnect = once(sockets, "connection");
  socket.close();
  [socket] = await withTimeout(reconnect, 20_000, "Worker reconnect");
  assert.deepEqual(await effects(3, debug), {
    revision: 6,
    configuration: off,
    state: "idle",
    native: null,
    error: null,
  });
  assert.match((await send(request)).error.message, /replayed/);
  assert.deepEqual(await inspect(scan(), [1, 1, false]), inventory);
  assert.deepEqual(await effects(3, debug), recovered);
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
  throw failure ?? error;
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
