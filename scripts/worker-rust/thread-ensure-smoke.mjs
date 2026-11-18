// Real worker command socket, owned Codex transport and native MCP attachment.
// The server peer supplies only the enrollment/command contracts the worker uses.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { nativeTurnRecoveryObservationSchema } from "../../packages/protocol/dist/index.js";
import { CodexRpcClient } from "../../cantrip_worker/src/codex/rpc-client.ts";

const { values } = parseArgs({
  options: { worker: { type: "string" }, codex: { type: "string" } },
});
assert.ok(values.worker && values.codex);
const requireWorker = createRequire(
  new URL("../../cantrip_worker/package.json", import.meta.url),
);
const { WebSocketServer } = requireWorker("ws");
const { Client } = await import(
  requireWorker.resolve("@modelcontextprotocol/sdk/client/index.js")
);
const { StdioClientTransport } = await import(
  requireWorker.resolve("@modelcontextprotocol/sdk/client/stdio.js")
);
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-native-thread-ensure-"),
);
const directory = path.join(root, "profile");
const data = path.join(directory, "agent-mcp-bindings");
const serverId = randomUUID(),
  ownerId = "fixture-owner",
  workerId = "thread-ensure-worker";
const credential = "ctwk_" + "Y".repeat(43);
const stamp = new Date().toISOString();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.headers.authorization !== "Bearer " + credential) {
    response.writeHead(401).end("{}");
    return;
  }
  const send = (value) =>
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(value));
  if (url.pathname === "/api/internal/workers/encryption/bootstrap") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { principalId, publicKey } = JSON.parse(Buffer.concat(chunks));
    send({
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
        approvedAt: stamp,
        revokedAt: null,
        revokedReason: null,
        createdAt: stamp,
        updatedAt: stamp,
      },
      grants: [],
    });
  } else if (url.pathname === "/api/internal/workers/heartbeat") send({});
  else if (
    url.pathname === "/api/internal/agent-operations/capabilities" &&
    url.searchParams.get("workerId") === workerId
  )
    send({
      bindingProtocolVersions: [1, 2],
      operations: ["tool.help", "context.get"],
    });
  else response.writeHead(404).end("{}");
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
let child,
  exited,
  diagnostics = "",
  connection;
function available(work, milliseconds = 25000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error("Thread preparation fixture timed out\n" + diagnostics),
        ),
      milliseconds,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
async function start() {
  diagnostics = "";
  const connected = once(sockets, "connection");
  child = spawn(path.resolve(values.worker), ["--shutdown-on-stdin-close"], {
    cwd: root,
    stdio: "pipe",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: root,
      NO_COLOR: "1",
      CANTRIP_WORKER_DATA_DIR: directory,
      CANTRIP_WORKER_ID: workerId,
      CANTRIP_WORKER_CREDENTIAL: credential,
      CANTRIP_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      CANTRIP_CODEX_BIN: path.resolve(values.codex),
    },
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-32000);
    });
  exited = once(child, "close");
  [connection] = await available(
    Promise.race([
      connected,
      exited.then(([code]) => {
        throw new Error(`Worker stopped (${code})\n${diagnostics}`);
      }),
    ]),
  );
}
async function stop() {
  child.stdin.end();
  assert.deepEqual(await available(exited), [0, null], diagnostics);
}
async function ensure(fields) {
  const requestId = randomUUID();
  let onResponse;
  const reply = new Promise((resolve) => {
    onResponse = (message) => {
      const frame = JSON.parse(message);
      if (frame.kind === "response" && frame.requestId === requestId)
        resolve(frame);
    };
    connection.on("message", onResponse);
  });
  connection.send(
    JSON.stringify({
      kind: "request",
      requestId,
      command: {
        type: "chat.thread.ensure",
        cwd: root,
        threadId: null,
        planMode: "default",
        model: {
          id: "gpt-5",
          routeId: "fixture-route",
          name: "gpt-5",
          reasoningEffort: null,
        },
        provider: {
          id: "fixture",
          kind: "openai-compatible",
          name: "Fixture",
          baseUrl: "http://127.0.0.1:1",
        },
        permissionProfileId: ":read-only",
        mcpServers: [],
        ...fields,
      },
    }),
  );
  try {
    return await available(reply);
  } finally {
    connection.off("message", onResponse);
  }
}
async function expectThread(fields, expected) {
  const response = await ensure(fields);
  assert.equal(
    response.ok,
    true,
    JSON.stringify(response) + "\n" + diagnostics,
  );
  const result = response.result;
  if (expected) assert.equal(result.threadId, expected);
  else assert.match(result.threadId, /^[0-9a-f-]{36}$/u);
  return result;
}
async function bindings() {
  return Promise.all(
    (await readdir(data)).map(async (id) => {
      const file = path.join(data, id, "connection.json");
      return { file, ...JSON.parse(await readFile(file, "utf8")) };
    }),
  );
}
async function assertPersistedSettings(threadId) {
  const native = spawn(
    path.resolve(values.codex),
    [
      "app-server",
      "-c",
      'model_provider="cantrip_runtime"',
      "-c",
      'model_providers.cantrip_runtime.name="Fixture"',
      "-c",
      'model_providers.cantrip_runtime.base_url="http://127.0.0.1:1"',
      "-c",
      'model_providers.cantrip_runtime.wire_api="responses"',
      "--listen",
      "stdio://",
    ],
    {
      cwd: root,
      stdio: "pipe",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        CODEX_HOME: path.join(directory, "codex-home"),
      },
    },
  );
  const done = once(native, "close");
  native.stderr.resume();
  const rpc = new CodexRpcClient(native, 5_000);
  async function request(method, params) {
    const response = await rpc.request(method, params);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result;
  }
  try {
    await request("initialize", {
      clientInfo: { name: "thread-ensure-fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized");
    await request("thread/resume", {
      threadId,
      managedConfig: {
        mcpServers: {},
        developerInstructions: null,
        multiAgentEnabled: true,
        subagentModel: null,
        subagentReasoningEffort: null,
        preserveSubagentSettings: true,
      },
    });
    const result = await request("thread/settings/read", { threadId });
    assert.equal(result.threadId, threadId);
    assert.equal(result.threadSettings.collaborationMode.mode, "plan");
    assert.equal(
      result.threadSettings.activePermissionProfile?.id,
      ":read-only",
    );
  } finally {
    native.stdin.end();
    assert.deepEqual(await available(done), [0, null]);
  }
}
async function assertIdle(file) {
  const client = new Client({ name: "thread-ensure-fixture", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: path.resolve(values.worker),
        args: ["mcp", "--connection", file],
        env: { PATH: "/usr/bin:/bin", CANTRIP_MCP_PROFILE: "ide" },
      }),
    );
    const result = await client.callTool({
      name: "context_get",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no active execution binding/);
  } finally {
    await client.close();
  }
}
try {
  await mkdir(path.join(root, "scratch"));
  const session = {
    contextKind: "project",
    chatId: randomUUID(),
    computerUseEnabled: false,
    projectId: randomUUID(),
    worktreeId: randomUUID(),
    rootKind: "folder-root",
    scratchRootId: null,
  };
  const standalone = {
    contextKind: "standalone",
    chatId: randomUUID(),
    computerUseEnabled: false,
    projectId: null,
    worktreeId: null,
    rootKind: null,
    scratchRootId: "isolated",
  };
  await start();
  const { threadId } = await expectThread({ session, planMode: "plan" });
  const idle = await bindings();
  assert.equal(idle.length, 1);
  await assertIdle(idle[0].file);
  const recovered = await expectThread(
    {
      session,
      threadId,
      recoveryTurnId: "unknown",
      permissionProfileId: ":workspace",
    },
    threadId,
  );
  assert.deepEqual(
    nativeTurnRecoveryObservationSchema.parse(recovered.recovery),
    {
      threadId,
      turnId: "unknown",
      runtimeGeneration: recovered.recovery.runtimeGeneration,
      status: null,
    },
  );
  assert.deepEqual(
    await bindings(),
    idle,
    "Reattachment preserves the binding generation.",
  );
  const scratch = { session: standalone, cwd: path.join(root, "scratch") };
  const scratchId = (await expectThread(scratch)).threadId;
  assert.notEqual(threadId, scratchId);
  assert.equal((await bindings()).length, 2);
  assert.equal(
    (await ensure({ session: { ...session, computerUseEnabled: true } })).ok,
    false,
  );
  await stop();
  assert.deepEqual(await bindings(), []);

  await start();
  const after = await expectThread(
    { session, recoveryTurnId: "unknown" },
    threadId,
  );
  assert.notEqual(
    after.recovery.runtimeGeneration,
    recovered.recovery.runtimeGeneration,
  );
  assert.notEqual((await bindings())[0].bindingId, idle[0].bindingId);
  await expectThread(scratch, scratchId);
  await stop();
  assert.deepEqual(await bindings(), []);
  await assertPersistedSettings(threadId);
  console.log(
    "Native project and standalone preparation, MCP, and restart recovery passed.",
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await available(exited);
  }
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.close();
  await rm(root, { recursive: true, force: true });
}
