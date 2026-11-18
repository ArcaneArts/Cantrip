// Real worker command socket, owned Codex transport and native MCP attachment.
// The server peer supplies only the enrollment/command contracts the worker uses.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { nativeTurnRecoveryObservationSchema } from "../../packages/protocol/dist/index.js";
import { CodexRpcClient } from "../../cantrip_worker/src/codex/rpc-client.ts";
import {
  decryptChatMessageProtectedContent,
  decryptChatPlanProtectedContent,
  decryptQueuedPromptProtectedContent,
  wrapComponentKeyForWorker,
} from "../../packages/crypto/dist/index.js";
import {
  EncryptedChatEventSealer,
  openEncryptedChatTurn,
  protectChatMessage,
} from "../../cantrip_worker/src/chat-message-encryption.ts";
import { protectChatPlanState } from "../../cantrip_worker/src/chat-plan-encryption.ts";
import { admit, GuiReceiptPeer, logical } from "./gui-receipt-cases.mjs";
import { GuiHistoryPeer } from "./gui-history-cases.mjs";
import { verifyTaskOutcomeRecovery } from "./task-outcome-recovery.mjs";
import { verifyTaskPreparation } from "./task-preparation-cases.mjs";
import { verifyDirectTask } from "./direct-task-cases.mjs";
import { verifyStructuredTasks } from "./structured-task-cases.mjs";

const { values } = parseArgs({
  options: {
    worker: { type: "string" },
    codex: { type: "string" },
    turns: { type: "boolean" },
    protected: { type: "boolean" },
    receipts: { type: "boolean" },
    outcomes: { type: "boolean" },
    taskPreparation: { type: "boolean" },
    directTask: { type: "boolean" },
    structuredTasks: { type: "boolean" },
  },
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
const upstream = new EventEmitter();
const contextCalls = [];
let providerCalls = 0;
let guiPeer,
  guiHistory,
  workerGeneration,
  taskOutcome,
  taskDispatch,
  taskResponse,
  holdHandshake;
const outcomeFrames = new EventEmitter();
const outputText = "Native host turn fixture.";
const privatePrompt = "Protected input fixture, only for the worker.";
const priorText = "Private preceding assistant message.";
const privateStep = "Private plan step.";
const privateQuestion = "Private retained plan question.";
const chatKey = new Uint8Array(32).fill(41);
const taskKey = new Uint8Array(32).fill(37);
const oracle = {
  ownerId: () => ownerId,
  serverIdentity: () => serverId,
  componentKey: (scope) => {
    if (scope === "task-content")
      return { key: taskKey.slice(), keyRevision: 2 };
    assert.equal(scope, "chat-content");
    return { key: chatKey.slice(), keyRevision: 1 };
  },
};

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks));
}
async function responses(request, response) {
  const body = await requestBody(request);
  assert.equal(body.model, "gpt-5");
  const number = ++providerCalls;
  const id = "assistant-" + number;
  const plan =
    JSON.stringify(body.input).includes(privatePrompt) &&
    !body.input.some((item) => item.type === "function_call_output");
  const fixture =
    typeof taskResponse === "function" ? taskResponse(body) : taskResponse;
  const text = typeof fixture === "string" ? fixture : outputText;
  const item =
    fixture && typeof fixture === "object"
      ? { id, type: "function_call", ...fixture }
      : plan
        ? {
            id,
            type: "function_call",
            name: "update_plan",
            call_id: "fixture-plan",
            arguments: JSON.stringify({
              explanation: "Protected model plan",
              plan: [{ step: privateStep, status: "in_progress" }],
            }),
          }
        : {
            id,
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          };
  const closed = once(response, "close");
  const write = (type, fields) =>
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
    );
  response.writeHead(200, { "content-type": "text/event-stream" });
  write("response.created", { response: { id: "response-" + number } });
  write("response.output_item.added", { item });
  if (item.type === "message")
    write("response.output_text.delta", { delta: text });
  upstream.emit("request", {
    number,
    plan,
    body,
    closed,
    finish: () => {
      write("response.output_item.done", { item });
      write("response.completed", {
        response: {
          id: "response-" + number,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      response.end();
    },
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/fixture/v1/responses") {
    try {
      await responses(request, response);
    } catch (error) {
      upstream.emit("failure", error);
      response.destroy();
    }
    return;
  }

  if (request.headers.authorization !== "Bearer " + credential) {
    response.writeHead(401).end("{}");
    return;
  }
  const send = (value) =>
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(value));
  if (url.pathname.startsWith("/api/internal/native-history/") && guiHistory) {
    try {
      await guiHistory.apply(
        url.pathname.split("/").at(-1),
        await requestBody(request),
        response,
        send,
      );
    } catch (error) {
      upstream.emit("failure", error);
      response.writeHead(400).end("{}");
    }
    return;
  }
  if (
    url.pathname === "/api/internal/native-commands/task-goal-outcome" &&
    taskOutcome
  ) {
    try {
      taskOutcome(await requestBody(request), send);
    } catch (error) {
      upstream.emit("failure", error);
      response.writeHead(400).end("{}");
    }
    return;
  }
  if (
    url.pathname === "/api/internal/native-commands/task-input-dispatch" &&
    taskDispatch
  ) {
    try {
      taskDispatch(await requestBody(request), send, response);
    } catch (error) {
      upstream.emit("failure", error);
      response.writeHead(400).end("{}");
    }
    return;
  }
  if (url.pathname.startsWith("/api/internal/native-commands/") && guiPeer) {
    try {
      await guiPeer.apply(
        url.pathname.split("/").at(-1),
        await requestBody(request),
        response,
        send,
      );
    } catch (error) {
      upstream.emit("failure", error);
      response.writeHead(400).end("{}");
    }
    return;
  }
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
      grants: await Promise.all(
        [
          ...(values.protected ||
          values.receipts ||
          values.taskPreparation ||
          values.directTask ||
          values.structuredTasks
            ? [
                {
                  component: "chat-content",
                  keyRevision: 1,
                  componentKey: chatKey,
                },
              ]
            : []),
          ...(values.taskPreparation ||
          values.directTask ||
          values.structuredTasks
            ? [
                {
                  component: "task-content",
                  keyRevision: 2,
                  componentKey: taskKey,
                },
              ]
            : []),
        ].map(async ({ component, keyRevision, componentKey }) => ({
          id: randomUUID(),
          ownerId,
          principalId,
          component,
          keyRevision,
          state: "active",
          revision: 1,
          revokedAt: null,
          revokedReason: null,
          createdAt: stamp,
          updatedAt: stamp,
          wrappedKey: await wrapComponentKeyForWorker({
            ownerId,
            workerId,
            component,
            keyRevision,
            componentKey,
            workerPublicKey: publicKey,
          }),
        })),
      ),
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
  else if (url.pathname === "/api/internal/agent-operations") {
    const { binding, request: call } = await requestBody(request);
    contextCalls.push(binding.executionLaneId);
    if (call.operation !== "context.get") {
      response.writeHead(400).end("{}");
      return;
    }
    send({
      summary: "Authorized native fixture context.",
      worktreeId: binding.worktreeId,
      data: {
        worker: { id: workerId, name: "Worker", online: true },
        context: {
          chatId: binding.chatId,
          executionLaneId: binding.executionLaneId,
          permissionProfileId: binding.permissionProfileId,
          projectId: binding.projectId,
          rootKind: binding.rootKind,
          terminalId: null,
          workerId,
          worktreeId: binding.worktreeId,
          worktreeMode: "agent-managed",
        },
        binding: {
          status: "read-only",
          mutationReady: false,
          staleClaims: [],
          recoveryInstruction: "Select an authorized profile for mutations.",
          expiresAt: binding.expiresAt,
        },
      },
    });
  } else response.writeHead(404).end("{}");
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
  workerGeneration = connectionGeneration;
  const hello = (state) =>
    socket.send(
      JSON.stringify({
        kind: "connection",
        state,
        protocolVersion: 1,
        connectionGeneration,
      }),
    );
  socket.on("message", (message) => {
    const frame = JSON.parse(message);
    outcomeFrames.emit("frame", frame);
  });
  hello("pending");
  if (holdHandshake) {
    holdHandshake.resolve(() => hello("ready"));
    holdHandshake = undefined;
  } else {
    hello("ready");
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
      ...(values.outcomes ? { CANTRIP_LOG_LEVEL: "debug" } : {}),
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
      upstream.emit("log");
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
async function ensure(fields, event = () => {}, requestId = randomUUID()) {
  const origin = connection;
  let onResponse;
  const reply = new Promise((resolve) => {
    onResponse = (frame) => {
      if (frame.requestId !== requestId) return;
      if (frame.kind === "response") resolve(frame);
      if (frame.kind === "event") event(frame.event);
    };
    outcomeFrames.on("frame", onResponse);
  });
  origin.send(
    JSON.stringify({
      kind: "request",
      requestId,
      command:
        fields.type === "chat.native-control" ||
        fields.type?.startsWith("chat.native-logical.") ||
        fields.type?.startsWith("task.")
          ? fields
          : {
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
    outcomeFrames.off("frame", onResponse);
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
function untilProvider() {
  const wait = new AbortController();
  const options = { signal: wait.signal };
  return available(
    Promise.race([
      once(upstream, "request", options).then(([request]) => request),
      once(upstream, "failure", options).then(([error]) => {
        throw error;
      }),
    ]),
  ).finally(() => wait.abort());
}

function waitForFrame(predicate) {
  return new Promise((resolve) => {
    const receive = (frame) => {
      if (predicate(frame)) {
        outcomeFrames.off("frame", receive);
        resolve(frame);
      }
    };
    outcomeFrames.on("frame", receive);
  });
}
async function waitForTurnOutcomeLog(requestId) {
  const evidence =
    "event=worker.command.completed operation=chat.turn requestId=" + requestId;
  while (!diagnostics.includes(evidence)) await once(upstream, "log");
}

async function verifyTurns() {
  const session = {
    contextKind: "project",
    chatId: randomUUID(),
    computerUseEnabled: false,
    projectId: randomUUID(),
    worktreeId: randomUUID(),
    rootKind: "folder-root",
    scratchRootId: null,
  };
  const provider = {
    id: "turn-fixture",
    kind: "openai-compatible",
    name: "Fixture",
    baseUrl: `http://127.0.0.1:${server.address().port}/fixture/v1`,
  };
  await start();
  const { threadId } = await expectThread({ session, provider });
  const [document] = await bindings();
  await assertIdle(document.file);
  const events = [];
  const issuedTurn = (executionLaneId, extra = {}, requestId) =>
    ensure(
      {
        type: "chat.turn",
        executionProfile: "ide",
        contextKind: "project",
        chatId: session.chatId,
        clientMessageId: randomUUID(),
        executionLaneId,
        worktreeId: session.worktreeId,
        scratchRootId: null,
        rootKind: "folder-root",
        isPrimary: true,
        worktreeMode: "agent-managed",
        worktreePolicy: "direct",
        policyProjectId: session.projectId,
        threadId,
        prompt: "Return the fixture response.",
        provider,
        ...extra,
      },
      (event) => events.push(event),
      requestId,
    );
  const observed = untilProvider();
  const first = issuedTurn("admitted-lane");
  const providerFirst = await Promise.race([
    observed,
    first.then((reply) => {
      throw new Error(JSON.stringify(reply) + "\n" + diagnostics);
    }),
  ]);
  assert.match(
    JSON.stringify(providerFirst.body.input),
    /Return the fixture response/,
  );
  const response = await fetch(document.endpoint + "/v1/execute", {
    method: "POST",
    headers: {
      authorization: "Bearer " + document.credential,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      bindingId: document.bindingId,
      request: { operation: "context.get", arguments: {} },
    }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(contextCalls, ["admitted-lane"]);
  const interrupt = (selectedThread, chatId = session.chatId) =>
    ensure({
      type: "chat.interrupt",
      chatId,
      threadId: selectedThread,
    });
  assert.deepEqual((await interrupt("different-thread")).result, {
    interrupted: false,
  });
  const duplicate = await issuedTurn("another-lane");
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error.message, /already has an active native turn/);

  providerFirst.finish();
  const completed = await first;
  assert.equal(
    completed.ok,
    true,
    JSON.stringify(completed) + "\n" + diagnostics,
  );
  assert.equal(completed.result.threadId, threadId);
  assert.equal(completed.result.text, outputText);
  assert.equal(completed.result.status, "completed");
  assert.equal(completed.result.measuredUsage.totalTokens, 2);
  assert.ok(
    events.some(
      ({ type, message }) =>
        type === "agent.message" &&
        !message.streaming &&
        message.text === outputText,
    ),
  );
  assert.ok(
    events.some(
      ({ type, message }) =>
        type === "agent.message" &&
        message.streaming &&
        message.text === outputText,
    ),
  );
  await assertIdle(document.file);
  const recovery = await expectThread(
    { session, provider, threadId, recoveryTurnId: completed.result.turnId },
    threadId,
  );
  assert.equal(recovery.recovery.status, "completed");
  const changedPermission = await issuedTurn("misconfigured-lane", {
    permissionProfileId: ":yolo",
  });
  assert.equal(changedPermission.ok, false);
  assert.match(changedPermission.error.message, /permission profile changed/);
  assert.equal(providerCalls, 1);
  await assertIdle(document.file);

  const observedSecond = untilProvider();
  const stoppedOutcome = waitForFrame(
    (frame) => frame.notification?.executionLaneId === "stop-lane",
  );
  const second = issuedTurn("stop-lane");
  const providerSecond = await Promise.race([
    observedSecond,
    second.then((reply) => {
      throw new Error(JSON.stringify(reply) + "\n" + diagnostics);
    }),
  ]);
  assert.equal(providerSecond.number, 2);
  assert.deepEqual((await interrupt(threadId, randomUUID())).result, {
    interrupted: false,
  });
  assert.deepEqual((await interrupt(threadId)).result, { interrupted: true });
  const stopped = await second;
  assert.equal(stopped.ok, false);
  assert.match(stopped.error.message, /interrupt/i);
  assert.deepEqual((await available(stoppedOutcome)).notification.outcome, {
    ok: false,
    error: stopped.error.message,
  });
  await assertIdle(document.file);
  await available(providerSecond.closed);
  assert.deepEqual((await interrupt(threadId)).result, { interrupted: false });
  if (values.outcomes) {
    const requestId = randomUUID();
    const clientMessageId = randomUUID();
    const isolated = { ...session, chatId: randomUUID() };
    const offlineProvider = { ...provider, id: "offline-turn-fixture" };
    const offline = await expectThread({
      session: isolated,
      provider: offlineProvider,
    });
    const nextProvider = untilProvider();
    const pending = issuedTurn(
      "offline-outcome-lane",
      {
        chatId: isolated.chatId,
        threadId: offline.threadId,
        provider: offlineProvider,
        clientMessageId,
      },
      requestId,
    );
    const offlineRequest = await Promise.race([
      nextProvider,
      pending.then((reply) => {
        throw new Error(JSON.stringify(reply) + "\n" + diagnostics);
      }),
    ]);
    holdHandshake = Promise.withResolvers();
    const connected = holdHandshake.promise;
    const reconnected = once(sockets, "connection");
    const closed = once(connection, "close");
    connection.terminate();
    await available(closed);
    offlineRequest.finish();
    await available(waitForTurnOutcomeLog(requestId));
    const [socket] = await available(reconnected);
    const release = await available(connected);
    const sequence = [];
    const emitted = waitForFrame((frame) => {
      if (frame.kind === "response" && frame.requestId === requestId)
        sequence.push("response");
      if (frame.notification?.clientMessageId !== clientMessageId) return false;
      sequence.push("notification");
      return true;
    });
    connection = socket;
    release();
    const [response, notification] = await Promise.all([
      pending,
      available(emitted),
    ]);
    assert.deepEqual(sequence, ["response", "notification"]);
    assert.equal(response.ok, true);
    assert.deepEqual(notification.notification, {
      type: "chat.turn.outcome",
      chatId: isolated.chatId,
      clientMessageId,
      executionLaneId: "offline-outcome-lane",
      contextKind: "project",
      worktreeId: session.worktreeId,
      scratchRootId: null,
      outcome: { ok: true, result: response.result },
    });
    assert.equal(providerCalls, 3);
    console.log(
      "A completed host response and recovery notification crossed an actual socket reconnect.",
    );
  }
  await stop();
  assert.deepEqual(await bindings(), []);
  console.log("Native host turn, streaming, MCP lane, and exact Stop passed.");
}

function actualMessage(message) {
  return decryptChatMessageProtectedContent({
    ownerId,
    messageId: message.id,
    keyRevision: 1,
    componentKey: chatKey,
    encrypted: message.protectedContent,
    publicClassification: message.classification,
  });
}
function summary(message, chatId, sequence) {
  return {
    ...message.classification,
    id: message.id,
    chatId,
    worktreeId: "prior-worktree",
    contextKind: "project",
    scratchRootId: null,
    executionLaneId: null,
    sequence,
    protectedContent: message.protectedContent,
    modelId: null,
    modelRouteId: null,
    providerId: null,
    providerName: null,
    providerModelName: null,
    reasoningEffort: null,
    appliedReasoningEffort: null,
    reasoningAdjusted: false,
    idempotencyKey: message.idempotencyKey,
    createdAt: stamp,
  };
}

async function verifyProtectedTurns() {
  const home = path.join(directory, "codex-home");
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(home, "config.toml"),
    "\n[tools.update_plan]\nenabled = true\n",
    { flag: "a" },
  );
  await start();
  const chatId = randomUUID(),
    projectId = randomUUID(),
    worktreeId = randomUUID();
  const provider = {
    id: "protected-turn-fixture",
    kind: "openai-compatible",
    name: "Fixture",
    baseUrl: `http://127.0.0.1:${server.address().port}/fixture/v1`,
  };
  const responseMessage = {
    id: randomUUID(),
    idempotencyKey: "protected-terminal-result",
  };
  const previous = {
    id: randomUUID(),
    role: "assistant",
    mode: "default",
    idempotencyKey: "prior-protected-message",
    content: [{ type: "text", text: priorText }],
  };
  const [historyEnvelope] = await expectSuccess({
    type: "chat.messages.protect",
    messages: [previous],
  });
  assert.deepEqual(
    (await actualMessage(historyEnvelope)).content,
    previous.content,
  );
  const [copied] = await expectSuccess({
    type: "chat.messages.reprotect",
    messages: [
      {
        source: summary(historyEnvelope, chatId, 1),
        id: randomUUID(),
        idempotencyKey: "copy",
      },
    ],
  });
  assert.notEqual(copied.id, historyEnvelope.id);
  assert.deepEqual((await actualMessage(copied)).content, previous.content);

  const issued = {
    type: "chat.turn.protect",
    promptId: randomUUID(),
    messageId: randomUUID(),
    text: privatePrompt,
    mode: "default",
    modelId: "gpt-5",
    reasoningEffort: null,
    idempotencyKey: "protected-client-input",
  };
  const prepared = await expectSuccess(issued);
  const queued = await decryptQueuedPromptProtectedContent({
    ownerId,
    promptId: issued.promptId,
    keyRevision: 1,
    componentKey: chatKey,
    encrypted: prepared.queuedPrompt.protectedContent,
    publicClassification: prepared.queuedPrompt.classification,
  });
  assert.equal(queued.text, privatePrompt);
  assert.deepEqual(prepared.queuedPrompt.pendingMessage, prepared.message);

  const message = {
    id: issued.messageId,
    role: "user",
    mode: "default",
    idempotencyKey: issued.idempotencyKey,
    content: [{ type: "text", text: privatePrompt }],
  };
  const workerInput = await expectSuccess({
    type: "chat.message.protect",
    message,
  });
  assert.deepEqual(
    await actualMessage(workerInput),
    await actualMessage(prepared.message),
  );

  const prompt = await protectChatMessage({
    id: message.id,
    message,
    service: oracle,
  });
  const oldQuestion = {
    id: "prior-question",
    threadId: "prior-thread",
    turnId: "prior-turn",
    itemId: "prior-item",
    createdAt: stamp,
    questions: [
      {
        id: "input",
        header: "Previous",
        question: privateQuestion,
        isOther: false,
        isSecret: false,
        options: null,
      },
    ],
  };
  const oldPlan = await protectChatPlanState({
    chatId,
    service: oracle,
    state: { explanation: null, steps: [], question: oldQuestion },
  });
  // The server can resend the already-committed user row as recent history.
  const history = [
    summary(historyEnvelope, chatId, 1),
    summary(workerInput, chatId, 2),
  ];
  const expectedInput = await openEncryptedChatTurn({
    history,
    prompt,
    service: oracle,
    threadId: null,
  });
  const fields = {
    type: "chat.turn",
    contextKind: "project",
    executionProfile: "ide",
    chatId,
    clientMessageId: prompt.id,
    executionLaneId: "protected-lane",
    worktreeId,
    scratchRootId: null,
    rootKind: "folder-root",
    isPrimary: true,
    worktreeMode: "agent-managed",
    worktreePolicy: "direct",
    policyProjectId: projectId,
    threadId: null,
    provider,
    protectedPrompt: prompt,
    protectedHistory: history,
    protectedPlan: oldPlan,
    resultMode: {
      kind: "chat-message-encrypted",
      messageId: responseMessage.id,
      idempotencyKey: responseMessage.idempotencyKey,
    },
  };
  const before = providerCalls;
  const altered = await ensure({
    ...fields,
    protectedPrompt: {
      ...prompt,
      classification: { ...prompt.classification, mode: "plan" },
    },
  });
  assert.equal(altered.ok, false);
  assert.match(altered.error.message, /authenticate protected chat input/);
  const wrongChat = await ensure({ ...fields, chatId: randomUUID() });
  assert.equal(wrongChat.ok, false);
  assert.match(wrongChat.error.message, /belongs to another conversation/);
  const badPlan = await ensure({
    ...fields,
    protectedPlan: { ...oldPlan, classification: { hasQuestion: false } },
  });
  assert.equal(badPlan.ok, false);
  assert.match(badPlan.error.message, /authenticate protected chat plan/);
  assert.equal(providerCalls, before);

  let receipt;
  if (values.receipts) {
    receipt = admit(fields, stamp);
    const cancelled = admit(fields, stamp);
    await expectSuccess(logical(cancelled, "chat.native-logical.cancel"));
    const preempted = await ensure({
      ...fields,
      nativeCommandReceipt: cancelled,
    });
    assert.equal(preempted.ok, false);
    assert.match(preempted.error.message, /stopped before native dispatch/);
    await expectSuccess(logical(cancelled));
    const unrelated = { ...receipt, payloadDigest: "0".repeat(64) };
    const mismatch = await ensure({
      ...fields,
      nativeCommandReceipt: unrelated,
    });
    assert.equal(mismatch.ok, false);
    assert.match(
      mismatch.error.message,
      /does not match the admitted native command/,
    );
    assert.equal(providerCalls, before);
    guiHistory = new GuiHistoryPeer({
      fields,
      receipt,
      workerId,
      stamp,
      oracle,
    });
    guiPeer = new GuiReceiptPeer(fields, receipt, {
      oracle,
      workerGeneration,
      workerId,
    });
  }
  const command = receipt
    ? { ...fields, nativeCommandReceipt: receipt }
    : fields;
  const events = [];
  const observed = untilProvider();
  const outcome = available(
    waitForFrame(
      (frame) =>
        frame.notification?.clientMessageId === fields.clientMessageId &&
        frame.notification?.outcome?.ok === true,
    ),
  );
  const pending = ensure(command, (event) => events.push(event));
  const providerInput = await Promise.race([
    observed,
    pending.then((reply) => {
      throw new Error(JSON.stringify(reply) + "\n" + diagnostics);
    }),
  ]);
  if (receipt)
    assert.deepEqual(guiPeer.steps.slice(0, 2), [
      "bind-preparation",
      "dispatch",
    ]);
  assert.ok(providerInput.plan);
  assert.ok(
    providerInput.body.tools.some((tool) => tool.name === "update_plan"),
    "The fixture provider must see the native plan tool.",
  );
  assert.ok(
    providerInput.body.input
      .flatMap((item) => item.content ?? [])
      .some((part) => part.text === expectedInput),
  );
  const follow = untilProvider();
  providerInput.finish();
  const response = await Promise.race([
    follow,
    pending.then((reply) => {
      throw new Error(JSON.stringify(reply) + "\n" + diagnostics);
    }),
  ]);
  assert.equal(response.plan, false);
  response.finish();
  const completed = await pending;
  assert.equal(
    completed.ok,
    true,
    JSON.stringify(completed) + "\n" + diagnostics,
  );
  assert.equal(completed.result.text, "");
  const delivered = (await outcome).notification;
  assert.deepEqual(delivered.outcome, { ok: true, result: completed.result });
  assert.equal(delivered.executionLaneId, fields.executionLaneId);
  assert.deepEqual(
    delivered.nativeLogicalRoot,
    receipt
      ? {
          operationId: receipt.operationId,
          operationGeneration: receipt.operationGeneration,
        }
      : undefined,
  );
  const result = completed.result.structuredResult.message;
  assert.equal(result.id, responseMessage.id);
  assert.equal(result.idempotencyKey, responseMessage.idempotencyKey);
  assert.deepEqual((await actualMessage(result)).content, [
    { type: "text", phase: "final_answer", text: outputText },
  ]);

  const planEvent = events.find(
    (event) => event.type === "agent.plan.protected",
  );
  assert.ok(
    planEvent,
    "The worker must publish the native plan as ciphertext.",
  );
  const nextPlan = await decryptChatPlanProtectedContent({
    ownerId,
    chatId,
    keyRevision: 1,
    componentKey: chatKey,
    encrypted: planEvent.state.protectedContent,
    publicClassification: planEvent.state.classification,
  });
  assert.deepEqual(nextPlan.question, oldQuestion);
  assert.deepEqual(nextPlan.steps, [
    { step: privateStep, status: "inProgress" },
  ]);
  const messages = events.filter(
    (event) => event.type === "agent.protected-message",
  );
  assert.ok(messages.some((event) => event.telemetry.streaming));
  assert.ok(messages.some((event) => !event.telemetry.streaming));
  const referenceSealer = new EncryptedChatEventSealer(
    oracle,
    chatId,
    {
      explanation: null,
      steps: [],
      question: null,
    },
    guiHistory
      ? async ({ message }) => {
          const { threadId, turnId, itemId } = message.correlation;
          const mapping = guiHistory.identity({
            threadId,
            turnId,
            itemId,
            component: "assistant",
            identityKind: "canonical",
          });
          assert.ok(mapping);
          return {
            id: mapping.messageId,
            idempotencyKey: mapping.idempotencyKey,
            mode: "default",
          };
        }
      : undefined,
  );
  for (const event of messages) {
    const [text] = (await actualMessage(event.message)).content;
    assert.equal(text.text, outputText);
    const reference = await referenceSealer.message({
      id: text.correlation.itemId,
      text: text.text,
      phase: text.phase,
      streaming: text.streaming,
      correlation: text.correlation,
    });
    assert.equal(event.message.id, reference.message.id);
    assert.equal(
      event.message.idempotencyKey,
      reference.message.idempotencyKey,
    );
    assert.deepEqual(event.telemetry, reference.telemetry);
  }
  const wire = JSON.stringify({
    events,
    completed,
    altered,
    wrongChat,
    badPlan,
  });
  for (const privateValue of [
    privatePrompt,
    priorText,
    outputText,
    privateStep,
    privateQuestion,
  ]) {
    assert.ok(
      !wire.includes(privateValue),
      "Protected plaintext appeared on the command socket.",
    );
    assert.ok(
      !diagnostics.includes(privateValue),
      "Protected plaintext appeared in worker output.",
    );
  }
  if (receipt) {
    const settledMessage = messages.find((event) => !event.telemetry.streaming);
    assert.equal(
      await available(
        guiHistory.verify(completed.result.turnId, settledMessage.message, [
          privatePrompt,
          outputText,
          priorText,
        ]),
      ),
      outputText,
    );
    assert.equal(guiPeer.terminal.nativeTurnId, completed.result.turnId);
    assert.equal(guiPeer.terminal.terminalStatus, "completed");
    assert.deepEqual(guiPeer.steps, [
      "bind-preparation",
      "dispatch",
      "receipt",
      "receipt",
      "receipt",
    ]);
    const stillOwned = await ensure(command);
    assert.match(stillOwned.error.message, /already has an active native turn/);
    await expectSuccess({
      ...logical(receipt),
      rootOperationGeneration: randomUUID(),
    });
    assert.match(
      (await ensure(command)).error.message,
      /already has an active native turn/,
    );
    await expectSuccess(logical(receipt));
    await expectSuccess(logical(receipt));

    // An existing native turn is interrupted only by its current activation.
    const resumed = { ...fields, threadId: completed.result.threadId };
    const uncertain = admit(resumed, stamp);
    guiPeer = new GuiReceiptPeer(resumed, uncertain, {
      oracle,
      workerGeneration,
      workerId,
    });
    guiPeer.loseDispatchResponse = true;
    const callsBeforeDispatchLoss = providerCalls;
    const lostDispatch = await ensure({
      ...resumed,
      nativeCommandReceipt: uncertain,
    });
    assert.equal(lostDispatch.ok, false);
    assert.match(
      lostDispatch.error.message,
      /did not acknowledge native command dispatch/,
    );
    assert.deepEqual(guiPeer.steps, ["bind-preparation", "dispatch"]);
    assert.equal(providerCalls, callsBeforeDispatchLoss);
    await expectSuccess(logical(uncertain));
    const following = admit(resumed, stamp);
    guiPeer = new GuiReceiptPeer(resumed, following, {
      oracle,
      workerGeneration,
      workerId,
    });
    let releaseRoot;
    guiPeer.holdRootAcknowledgment = new Promise((resolve) => {
      releaseRoot = resolve;
    });
    const resolvingOutput = Promise.withResolvers();
    const releaseOutput = Promise.withResolvers();
    guiHistory.holdResolution = {
      previousTurn: completed.result.turnId,
      arrived: resolvingOutput.resolve,
      release: releaseOutput.promise,
    };
    const request = untilProvider();
    const running = ensure({ ...resumed, nativeCommandReceipt: following });
    const active = await Promise.race([
      request,
      running.then((reply) => {
        throw new Error(JSON.stringify(reply) + "\n" + diagnostics);
      }),
    ]);
    const stopCommand = {
      type: "chat.native-control",
      chatId,
      threadId: resumed.threadId,
      nativeActivationGeneration: following.activationGeneration,
      nativeRuntimeGeneration: guiPeer.session.runtimeGeneration,
      modelRouteId: "fixture-route",
      providerAccountId: null,
      control: { kind: "interrupt" },
    };
    for (const wrong of [
      { nativeActivationGeneration: randomUUID() },
      { nativeRuntimeGeneration: randomUUID() },
      { threadId: randomUUID() },
      { modelRouteId: "other-route" },
      { providerAccountId: "other-account" },
    ]) {
      const refused = await ensure({ ...stopCommand, ...wrong });
      assert.equal(refused.ok, false);
      assert.match(
        refused.error.message,
        /does not identify one connected managed session/,
      );
    }
    await available(resolvingOutput.promise);
    guiPeer.loseNextControlDispatch = true;
    const lostStop = ensure(stopCommand);
    await expectSuccess({ type: "worker.version" });
    assert.equal(guiPeer.controls.size, 0);
    releaseRoot();
    const missed = await lostStop;
    assert.equal(missed.ok, false);
    assert.match(
      missed.error.message,
      /did not acknowledge native command dispatch/,
    );
    assert.equal(guiPeer.terminal, undefined);
    assert.deepEqual(await expectSuccess(stopCommand), { interrupted: true });
    await active.closed;
    releaseOutput.resolve();
    guiHistory.holdResolution = undefined;
    assert.deepEqual(
      [...guiPeer.controls.values()].map(({ receipt, steps }) => [
        receipt.status,
        steps,
      ]),
      [
        ["rejected", ["admit", "dispatch", "receipt"]],
        ["applied", ["admit", "dispatch", "receipt", "receipt"]],
      ],
    );
    assert.equal((await running).ok, false);
    assert.equal(guiPeer.terminal.terminalStatus, "interrupted");
    await expectSuccess(logical(following));
    guiPeer = undefined;
    console.log(
      "Native GUI preparation, dispatch, protected receipt retry, exact Stop, terminal evidence and logical completion passed.",
    );
  }
  await stop();
  assert.deepEqual(await bindings(), []);
  if (guiHistory) {
    await guiHistory.verifyLocalSource(directory, completed.result.turnId);
    guiHistory = undefined;
    console.log(
      "Canonical live message identities, encrypted History source and commit replay passed.",
    );
  }
  console.log(
    "Protected host turn, message identities, encrypted plan and Node interoperability passed.",
  );
}

async function expectSuccess(fields) {
  const reply = await ensure(fields);
  assert.equal(reply.ok, true, JSON.stringify(reply) + "\n" + diagnostics);
  return reply.result;
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
  let taskInputs;
  if (values.taskPreparation || values.directTask || values.structuredTasks) {
    taskInputs = await verifyTaskPreparation({
      dispatch: ensure,
      ownerId,
      oracle,
      key: taskKey,
    });
    console.log(
      "Native Task message conversion and four encrypted operation preparations match the Node reference.",
    );
  }
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
  if (values.turns || values.outcomes) await verifyTurns();
  if (values.outcomes) {
    await verifyTaskOutcomeRecovery({
      directory,
      scope: { ownerId, serverId, workerId },
      run: start,
      stop,
      attach: (peer) => {
        taskOutcome = peer;
      },
      available,
    });
    console.log(
      "Legacy Task files survived a mismatched acknowledgment and were recovered and retired by the Rust worker.",
    );
  }
  if (values.protected || values.receipts) await verifyProtectedTurns();
  if (values.directTask) {
    await verifyDirectTask({
      source: taskInputs.direct,
      outputText,
      ownerId,
      serverId,
      workerId,
      key: taskKey,
      directory,
      baseUrl: `http://127.0.0.1:${server.address().port}/fixture/v1`,
      invoke: ensure,
      start,
      stop,
      waitForFrame,
      untilProvider,
      available,
      generation: () => workerGeneration,
      attach: (dispatch, outcome) => {
        taskDispatch = dispatch;
        taskOutcome = outcome;
      },
      diagnostics: () => diagnostics,
    });
    console.log(
      "Direct Task claim, native binding, encrypted result, and persistent replay passed.",
    );
  }
  if (values.structuredTasks) {
    await verifyStructuredTasks({
      taskInputs,
      root,
      ownerId,
      serverId,
      workerId,
      key: taskKey,
      baseUrl: `http://127.0.0.1:${server.address().port}/fixture/v1`,
      invoke: ensure,
      start,
      stop,
      untilProvider,
      available,
      attach: ({ dispatch, outcome, answer } = {}) => {
        taskDispatch = dispatch;
        taskOutcome = outcome;
        taskResponse = answer;
      },
      diagnostics: () => diagnostics,
    });
    console.log(
      "Structured Task planning, revision, and finalization matched the Node reference.",
    );
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await available(exited);
  }
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.closeAllConnections();
  server.close();
  chatKey.fill(0);
  await rm(root, { recursive: true, force: true });
}
