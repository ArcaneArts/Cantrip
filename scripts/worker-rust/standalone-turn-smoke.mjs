// Public standalone Chat API through both Rust services and bundled Codex.
// A disposable loopback provider is the only execution substitute.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import * as crypto from "../../packages/crypto/dist/index.js";
import {
  encryptedChatTurnCreateSchema,
  encryptedConversationPromptSubmitResultSchema,
} from "../../packages/protocol/dist/index.js";
import { fixtureEnvironment, startServer } from "../server-rust/process.mjs";
import { discoveryWireFixtures } from "../server-rust/discovery-wire-fixtures.mjs";
import { projectLabel } from "../server-rust/security-fixtures.mjs";
import { taskContent } from "../server-rust/task-wire-fixtures.mjs";
import {
  createPreparedProjectChat,
  verifyConsoleInteraction,
} from "./console-interaction-cases.mjs";
import { verifyDecisions } from "./model-decision-smoke-cases.mjs";
import { verifyEmbeddings } from "./model-embedding-smoke-cases.mjs";
import { verifyProviderCatalog } from "./provider-catalog-smoke-cases.mjs";
import { verifySubagentInteraction } from "./subagent-interaction-cases.mjs";
import { LiveProbe } from "../server-rust/live-sockets.mjs";
import {
  fixtureCodex,
  deferredReceiptProxy,
  verifyDeferredReceipt,
} from "./deferred-receipt-smoke-cases.mjs";
import {
  modelFunctions,
  taskModelProvider,
} from "../server-rust/task-model-provider.mjs";

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    worker: { type: "string" },
    codex: { type: "string" },
    cli: { type: "string" },
    settings: { type: "boolean" },
    deferred: { type: "boolean" },
    interactions: { type: "boolean" },
    "console-interactions": { type: "boolean" },
    "restored-interactions": { type: "boolean" },
    "subagent-interactions": { type: "boolean" },
    "subagent-model": { type: "boolean" },
    "plan-question": { type: "boolean" },
    "runtime-handoff": { type: "boolean" },
    "runtime-handoff-recovery": { type: "boolean" },
    "runtime-handoff-cancel": { type: "boolean" },
    "queued-handoff": { type: "boolean" },
    "queued-handoff-recovery": { type: "boolean" },
    "queued-handoff-cancel": { type: "boolean" },
    "goal-handoff": { type: "boolean" },
    "goal-handoff-recovery": { type: "boolean" },
  },
});
assert.ok(
  values.server && values.worker && values.codex,
  "Pass --server, --worker, and --codex",
);
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-native-standalone-turn-")),
);
const ownerId = "00000000-0000-0000-0000-000000000001";
const workerId = "native-standalone-turn-worker";
const keyRevision = 1;
const master = crypto.generateAccountMasterKey();
const key = (component) =>
  crypto.deriveComponentKey({
    accountMasterKey: master,
    ownerId,
    component,
    keyRevision,
  });
const chatKey = key("chat-content");
const labelKey = key("private-surface-metadata");
const taskKey = key("task-content");
const providerKey = key("provider-credential");
const operationsKey = key("model-operation-content");
const consoleInteractions = values["console-interactions"];
const restoredInteractions = values["restored-interactions"];
const subagentInteractions =
  values["subagent-interactions"] || values["subagent-model"];
const planQuestion = values["plan-question"];
const queuedHandoff =
  values["queued-handoff"] ||
  values["queued-handoff-recovery"] ||
  values["queued-handoff-cancel"];
const runtimeHandoff =
  values["runtime-handoff"] ||
  values["runtime-handoff-recovery"] ||
  values["runtime-handoff-cancel"] ||
  queuedHandoff;
const recoverGoalHandoff = values["goal-handoff-recovery"];
const goalHandoff = recoverGoalHandoff || values["goal-handoff"];
const interactionKey =
  values.interactions ||
  consoleInteractions ||
  restoredInteractions ||
  subagentInteractions ||
  planQuestion
    ? key("interaction-content")
    : null;
const consoleStateKey =
  consoleInteractions ||
  subagentInteractions ||
  planQuestion ||
  runtimeHandoff ||
  goalHandoff
    ? key("surface-private-state")
    : null;
const consoleSocket = path.join(root, "managed-console-socket");
const approvalPrompt = "Exercise a protected native interaction 🌲";
const approvalMarker = path.join(root, "native-approval-replies.jsonl");
let server;
let receiptProxy;
let goalHandoffFault;
let child;
let workerExit;
let workerEnvironment;
const models = [];
let diagnostics = "";
const readyTimeout = 20_000;

async function eventually(read, verify, timeout = readyTimeout) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const value = await read();
      verify(value);
      return value;
    } catch (error) {
      if (Date.now() >= end || child?.exitCode !== null) throw error;
    }
    await delay(100);
  }
}

async function startWorker(enrollmentCode) {
  diagnostics = "";
  child = spawn(path.resolve(values.worker), ["--shutdown-on-stdin-close"], {
    cwd: root,
    env: {
      ...workerEnvironment,
      ...(enrollmentCode
        ? { CANTRIP_WORKER_ENROLLMENT_CODE: enrollmentCode }
        : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  workerExit = new Promise((resolve) => {
    child.once("error", (error) => resolve(error));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const capture = (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-24_000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  await eventually(
    () => diagnostics,
    (value) => assert.match(value, /event=worker\.connection\.connected/),
  );
}

async function stopWorker() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    return await workerExit;
  } finally {
    clearTimeout(timer);
  }
}

async function call(method, route, status, input) {
  const response = await fetch(server.origin + route, {
    method,
    headers: {
      origin: "http://127.0.0.1:5173",
      ...(input === undefined ? {} : { "content-type": "application/json" }),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(12_000),
  });
  const text = await response.text();
  assert.equal(
    response.status,
    status,
    `${method} ${route} ${text.slice(0, 2500)}`,
  );
  return text ? JSON.parse(text) : null;
}

async function setupEncryption() {
  const clientId = randomUUID();
  const publicKey = await crypto.publicKeyForPair(
    await crypto.generateHpkeKeyPair(),
  );
  await call("POST", "/api/encryption/profile/initialize", 201, {
    profile: {
      formatVersion: 1,
      activeMasterKeyRevision: keyRevision,
      passwordKdf: null,
      passwordWrappedMasterKey: null,
      payloadMigrationStatus: "pending",
    },
    initialClient: {
      id: clientId,
      label: "Standalone turn fixture",
      publicKey,
      wrappedMasterKey: await crypto.wrapAccountMasterKeyForClient({
        ownerId,
        clientId,
        accountMasterKey: master,
        masterKeyRevision: keyRevision,
        clientPublicKey: publicKey,
      }),
    },
  });
  const refresh = (component) =>
    call("POST", `/api/workers/${workerId}/encryption/refresh`, 200, {
      component,
      keyRevision,
    });
  assert.equal(
    (await refresh("chat-content")).status.state,
    "pending-approval",
  );
  const identity = JSON.parse(
    await readFile(
      path.join(root, "worker", "worker-encryption-key.json"),
      "utf8",
    ),
  );
  const principals = await call("GET", "/api/encryption/principals", 200);
  const worker = principals.find(
    (principal) => principal.id === identity.principalId,
  );
  assert.ok(worker);
  await call("POST", `/api/encryption/principals/${worker.id}/approve`, 200, {
    expectedRevision: worker.revision,
  });
  for (const [component, componentKey] of [
    ["chat-content", chatKey],
    ["private-surface-metadata", labelKey],
    ["task-content", taskKey],
    ["provider-credential", providerKey],
    ["model-operation-content", operationsKey],
    ...(interactionKey ? [["interaction-content", interactionKey]] : []),
    ...(consoleStateKey ? [["surface-private-state", consoleStateKey]] : []),
  ]) {
    await call("POST", `/api/encryption/principals/${worker.id}/grants`, 201, {
      component,
      keyRevision,
      wrappedKey: await crypto.wrapComponentKeyForWorker({
        ownerId,
        workerId,
        keyRevision,
        component,
        componentKey,
        workerPublicKey: identity.publicKey,
      }),
    });
    assert.equal((await refresh(component)).status.state, "ready");
  }
}

async function encryptedTurn(prompt, modelId, mode = "default") {
  const common = { ownerId, keyRevision, componentKey: chatKey };
  const messageId = randomUUID();
  const promptId = randomUUID();
  const idempotencyKey = randomUUID();
  const classification = { mode, attachmentIds: [] };
  const messageClassification = { ...classification, role: "user" };
  const message = {
    id: messageId,
    idempotencyKey,
    classification: messageClassification,
    reasoningEffort: null,
    protectedContent: await crypto.encryptChatMessageProtectedContent({
      ...common,
      messageId,
      content: {
        version: 1,
        classification: messageClassification,
        content: [{ type: "text", text: prompt }],
      },
    }),
  };
  return encryptedChatTurnCreateSchema.parse({
    modelId,
    message,
    queuedPrompt: {
      id: promptId,
      idempotencyKey,
      modelId,
      classification,
      reasoningEffort: null,
      frozen: false,
      customSubagentModel: false,
      subagentModelId: null,
      subagentReasoningEffort: null,
      worktreeId: null,
      pendingMessage: message,
      protectedContent: await crypto.encryptQueuedPromptProtectedContent({
        ...common,
        promptId,
        content: { version: 1, classification, text: prompt },
      }),
    },
  });
}

async function createModel(name, maxConcurrentInference, additionalModels) {
  const model = await taskModelProvider({
    observeStreams: true,
    additionalModels,
  });
  models.push(model);
  const provider = await call("POST", "/api/settings/providers", 201, {
    id: randomUUID(),
    name,
    kind: "openai-compatible",
    baseUrl: model.baseUrl,
    initialAccount: null,
    protectedApiKey: null,
    maxConcurrentInference,
  });
  const profile = await call("POST", "/api/settings/models", 201, {
    name,
    routes: [
      { providerId: provider.id, modelName: model.model, enabled: true },
    ],
  });
  return { model, provider, profile };
}

async function createChat(label, autoTitle) {
  const chatId = randomUUID();
  const chatUrl = `/api/chats/${chatId}`;
  const titleProtection = await crypto.encryptPrivateDisplayLabel({
    ownerId,
    keyRevision,
    recordKind: "chat",
    rowId: chatId,
    componentKey: labelKey,
    label,
  });
  await call("POST", "/api/chats", 202, {
    id: chatId,
    titleProtection,
    autoTitle,
  });
  await eventually(
    () =>
      server.events.findLast(
        (event) =>
          event.event === "standalone-chat.scratch.transitioned" &&
          event.operation === "provision" &&
          event.chatId === chatId,
      ),
    (event) => assert.equal(event?.status, "succeeded", JSON.stringify(event)),
  );
  return { chatId, chatUrl };
}

function openMessage(message) {
  return crypto.decryptChatMessageProtectedContent({
    ownerId,
    messageId: message.id,
    keyRevision,
    componentKey: chatKey,
    encrypted: message.protectedContent,
    publicClassification: message.classification ?? {
      role: message.role,
      mode: message.mode,
      attachmentIds: message.attachmentIds,
    },
  });
}

async function verifyTurn(
  response,
  naming,
  scenario,
  titleResponse,
  expectedTitle,
) {
  const { chatId, chatUrl } = await createChat("New chat", true);
  const prompt = `This is an encrypted ${scenario} prompt 🌲`;
  const answer = "This is a streamed fixture answer 🍄";
  const labelReply = naming.model.reply({ text: titleResponse });
  const reply = response.model.reply({ text: answer });
  const turn = await encryptedTurn(prompt, response.profile.id);
  const submitted = encryptedConversationPromptSubmitResultSchema.parse(
    await call("POST", `${chatUrl}/turns`, 202, turn),
  );
  assert.equal(submitted.status, "queued");
  await eventually(
    () => reply,
    (value) => assert.equal(value.request?.completed, true),
    35_000,
  );
  assert.ok(JSON.stringify(reply.request.input.input).includes(prompt));
  assert.equal(labelReply.request?.completed, true);
  const labelInput = JSON.stringify(labelReply.request.input.input);
  assert.match(labelInput, /initialRequest/);
  assert.ok(labelInput.includes(`encrypted ${scenario} prompt`));
  const messages = await eventually(
    () => call("GET", `${chatUrl}/messages`, 200),
    (value) =>
      assert.ok(
        value.messages.some(
          (message) =>
            message.classification?.role === "assistant" ||
            message.role === "assistant",
        ),
      ),
    25_000,
  );
  assert.ok(!JSON.stringify(messages).includes(prompt));
  assert.ok(!JSON.stringify(messages).includes(answer));
  const opened = await Promise.all(messages.messages.map(openMessage));
  assert.ok(
    opened.some((message) =>
      message.content.some((item) => item.text === prompt),
    ),
  );
  assert.ok(
    opened.some((message) =>
      message.content.some((item) => item.text === answer),
    ),
  );
  await eventually(
    async () => {
      const chats = await call("GET", "/api/chats?context=standalone", 200);
      const chat = chats.find((chat) => chat.id === chatId);
      assert.ok(chat);
      assert.ok(!JSON.stringify(chat).includes(expectedTitle));
      return crypto.decryptPrivateDisplayLabel({
        ownerId,
        keyRevision,
        recordKind: "chat",
        rowId: chatId,
        componentKey: labelKey,
        opaque: chat.titleProtection,
      });
    },
    (value) => assert.equal(value, expectedTitle),
  );
  const replay = encryptedConversationPromptSubmitResultSchema.parse(
    await call("POST", `${chatUrl}/turns`, 200, turn),
  );
  assert.equal(replay.status, "started");
  assert.equal(replay.message.id, turn.message.id);
  for (const provider of new Set([response, naming]))
    assert.deepEqual(provider.model.failures, []);
  return { chatId, chatUrl };
}

async function verifyManagedCli(response, workerDirectory) {
  const { chatId, chatUrl } = await createChat("Managed CLI context", false);
  const tool = response.model.reply({ hold: true });
  const answer = response.model.reply({ text: "The CLI checked its scope." });
  const turn = await encryptedTurn(
    "Check the managed CLI scope.",
    response.profile.id,
  );
  await call("POST", chatUrl + "/turns", 202, turn);
  await eventually(
    () => tool.entered,
    (value) => assert.equal(value, true),
  );
  const command = modelFunctions(tool.request.input.tools).find(
    ({ name }) => name === "exec_command" || name.endsWith("__exec_command"),
  );
  assert.ok(command, "The bundled runtime advertises its shell tool");
  tool.calls = [
    {
      ...command,
      arguments: {
        cmd: [
          'printf "fixture-thread:%s\\n" "$CODEX_THREAD_ID"',
          "cantrip --context lane --json status",
        ].join("; "),
        yield_time_ms: 1000,
      },
    },
  ];
  tool.release();
  await eventually(
    () => answer.request,
    (value) => assert.equal(value?.completed, true),
  );
  const output = answer.request.input.input.find(
    (item) =>
      item.type === "function_call_output" &&
      String(item.output).includes("fixture-thread:"),
  )?.output;
  assert.ok(output, JSON.stringify(answer.request.input.input));
  assert.match(
    String(output),
    /Standalone Chats do not support IDE execution operations/u,
  );
  const threadId = String(output).match(/fixture-thread:([0-9a-f-]{36})/u)?.[1];
  assert.ok(threadId, "Codex provided its own native thread identity");

  const connection = JSON.parse(
    await readFile(path.join(workerDirectory, "cli-connection.json"), "utf8"),
  );
  const status = async (codexThreadId) => {
    const result = await fetch(connection.endpoint + "/v1/execute", {
      method: "POST",
      headers: {
        authorization: "Bearer " + connection.sessionToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        command: "status",
        context: { codexThreadId, selection: "lane" },
        arguments: {},
      }),
      signal: AbortSignal.timeout(3000),
    });
    return { status: result.status, body: await result.json() };
  };
  await eventually(
    () => status(threadId),
    (value) => {
      assert.equal(value.status, 409);
      assert.equal(value.body.code, "conflict");
      assert.match(
        value.body.error,
        /did not originate from the active chat lane/u,
      );
    },
  );
  const unknown = await status(randomUUID());
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, "context-not-found");
  assert.deepEqual(response.model.failures, []);
  assert.ok(
    (await call("GET", "/api/chats?context=standalone", 200)).some(
      (chat) => chat.id === chatId,
    ),
  );
}

async function verifyTaskLabels(labeling, source) {
  const model = labeling.model;
  const executionModel = source.model;
  const workspaceId = randomUUID();
  const nameProtection =
    discoveryWireFixtures(projectLabel).encryptedProjectWorkspaceCreateSchema[0]
      .nameProtection;
  await call("POST", "/api/workspaces", 201, {
    id: workspaceId,
    nameProtection,
    storage: { kind: "managed" },
  });
  const projectId = randomUUID();
  const projectUrl = `/api/projects/${projectId}`;
  await call("POST", "/api/projects/from-folder", 202, {
    id: projectId,
    workerId,
    workspaceId,
    nameProtection: await crypto.encryptPrivateDisplayLabel({
      ownerId,
      keyRevision,
      recordKind: "project",
      rowId: projectId,
      componentKey: labelKey,
      label: "Private fixture project",
    }),
  });
  await eventually(
    () => call("GET", `${projectUrl}/folder-setup`, 200),
    (row) => assert.equal(row.state, "succeeded", JSON.stringify(row)),
  );
  await call("PATCH", "/api/settings", 200, { autoNameTasks: true });
  const pauseUrl = `${projectUrl}/tasks/pause`;
  const pause = await call("GET", pauseUrl, 200);
  assert.equal(
    (
      await call("PATCH", pauseUrl, 200, {
        paused: true,
        rowVersion: pause.rowVersion,
      })
    ).paused,
    true,
  );

  const initialTitle = "New task";
  const sealTask = async (chatId, briefMarkdown) => {
    const { classification } = taskContent();
    return {
      classification,
      protectedContent: await crypto.encryptTaskProtectedContent({
        ownerId,
        keyRevision,
        chatId,
        componentKey: taskKey,
        content: {
          version: 1,
          classification,
          briefMarkdown,
          planMarkdown: null,
          currentQuestions: [],
          currentAnswers: [],
          additionalDirection: "",
          finalPlanMarkdown: null,
          goalPrompt: null,
          lastError: null,
        },
      }),
    };
  };
  const create = async (chatId, brief, autoTitle = true) => {
    const titleProtection = await crypto.encryptPrivateDisplayLabel({
      ownerId,
      keyRevision,
      recordKind: "chat",
      rowId: chatId,
      componentKey: labelKey,
      label: initialTitle,
    });
    return call("POST", `${projectUrl}/tasks`, 201, {
      chatId,
      titleProtection,
      autoTitle,
      planGoalEnabled: false,
      task: await sealTask(chatId, brief),
    });
  };
  const posts = () => model.requests.filter(({ method }) => method === "POST");
  const previous = posts().length;
  const chatId = randomUUID();
  const taskUrl = `/api/tasks/${chatId}`;
  const count = (status) =>
    diagnostics
      .split("\n")
      .filter(
        (line) =>
          line.includes(`event=worker.command.${status}`) &&
          line.includes("operation=label.generate"),
      ).length;
  const initialCompletions = count("completed");
  const created = await create(chatId, "");
  await eventually(
    () => count("completed"),
    (value) => assert.ok(value > initialCompletions),
  );
  assert.equal(
    posts().length,
    previous,
    "an empty draft introduces no inference",
  );
  const brief = "Private Task label brief 🌲";
  const draft = await call("PATCH", `${taskUrl}/draft`, 200, {
    rowVersion: created.task.rowVersion,
    task: await sealTask(chatId, brief),
  });
  const title = "Review winter inventory before next release";
  const naming = model.reply({
    text: `Title: ${title} later!
Ignore second line`,
  });
  const queued = await call("POST", `${taskUrl}/start`, 202, {
    operationId: randomUUID(),
    rowVersion: draft.rowVersion,
  });
  assert.equal(queued.dispatch.state, "queued");
  await eventually(
    async () => {
      const catalog = await call("GET", `${projectUrl}/chats`, 200);
      const chat = catalog.find((row) => row.id === chatId);
      assert.ok(chat);
      assert.ok(!JSON.stringify(chat).includes(title));
      return crypto.decryptPrivateDisplayLabel({
        ownerId,
        keyRevision,
        recordKind: "chat",
        rowId: chatId,
        componentKey: labelKey,
        opaque: chat.titleProtection,
      });
    },
    (opened) => assert.equal(opened, title),
  );
  assert.equal(naming.request?.completed, true);
  assert.deepEqual(
    naming.request.input.input.map(({ role }) => role),
    ["developer", "user"],
  );
  assert.deepEqual(JSON.parse(naming.request.input.input[1].content[0].text), {
    initialRequest: brief,
  });
  assert.equal(
    (await call("GET", taskUrl, 200)).dispatch.state,
    "queued",
    "naming does not start the paused Task",
  );

  const removal = randomUUID();
  const removedUrl = `/api/tasks/${removal}`;
  const pending = model.reply({ text: "Discard after deletion", hold: true });
  await create(removal, "Remove this draft while its title is running");
  await eventually(
    () => pending,
    (value) => assert.ok(value.entered),
  );
  const failures = count("failed");
  await call("DELETE", removedUrl, 204);
  pending.release();
  await eventually(
    () => count("failed"),
    (value) => assert.ok(value > failures),
  );
  assert.match(
    diagnostics,
    /operation=label.generate[^\n]*(?:410 Gone|Private label generation failed on the worker)/,
  );
  await call("GET", removedUrl, 404);
  assert.equal(posts().length, previous + 2);

  // Core allows deletion of a running Task and durably delivers the cleanup.
  await call("DELETE", taskUrl, 204);
  await call("PATCH", pauseUrl, 202, {
    paused: false,
    rowVersion: (await call("GET", pauseUrl, 200)).rowVersion,
  });
  const runningId = randomUUID();
  const runningUrl = `/api/tasks/${runningId}`;
  const running = await create(
    runningId,
    "Interrupt this planning turn",
    false,
  );
  const stream = executionModel.reply({ hold: true });
  try {
    await call("POST", `${runningUrl}/start`, 202, {
      operationId: randomUUID(),
      rowVersion: running.task.rowVersion,
    });
    await eventually(
      () => stream,
      (value) => assert.ok(value.entered, "Task reached its actual provider"),
    );
    const sinceDeletion = diagnostics
      .split("\n")
      .filter((line) =>
        line.includes(
          "event=worker.command.completed operation=inference.revoke ",
        ),
      ).length;
    await call("DELETE", runningUrl, 204);
    await eventually(
      () => stream.request,
      (request) => {
        assert.ok(
          request.closed,
          "deletion interrupted the running provider request",
        );
        assert.ok(request.closedBeforeCompletion);
      },
    );
    await eventually(
      () =>
        diagnostics
          .split("\n")
          .filter((line) =>
            line.includes(
              "event=worker.command.completed operation=inference.revoke ",
            ),
          ).length,
      (count) => assert.ok(count > sinceDeletion),
    );
    await call("GET", runningUrl, 404);
  } finally {
    stream.release();
  }
  await verifyTaskRouteTransfer(create, source, labeling);
  assert.deepEqual(model.failures, []);
  assert.deepEqual(executionModel.failures, []);
}

async function verifyTaskRouteTransfer(create, source, destination) {
  const providerId = source.provider.id;
  const inference = () =>
    call("GET", `/api/workers/${workerId}/inference`, 200);
  const pool = (status) =>
    status.pools.find((entry) => entry.providerId === providerId);
  await call("PATCH", `/api/settings/providers/${providerId}`, 200, {
    name: source.provider.name,
    baseUrl: source.provider.baseUrl,
    kind: source.provider.kind,
    maxConcurrentInference: 1,
  });
  await eventually(inference, (status) =>
    assert.equal(pool(status)?.maxConcurrentInference, 1),
  );

  const blocker = await createChat("Hold the source provider", false);
  const held = source.model.reply({ text: "Unrelated reply", hold: true });
  const replacement = destination.model.reply({ hold: true });
  try {
    await call(
      "POST",
      `${blocker.chatUrl}/turns`,
      202,
      await encryptedTurn("Unrelated chat input", source.profile.id),
    );
    await eventually(
      () => held,
      (value) => assert.ok(value.entered),
    );
    const sourceRequests = source.model.requests.filter(
      ({ method }) => method === "POST",
    ).length;

    const taskId = randomUUID();
    const taskUrl = `/api/tasks/${taskId}`;
    const routeUrl = `${taskUrl}/inference-route`;
    const prompt = "Transfer this queued Task input";
    const task = await create(taskId, prompt, false);
    await call("POST", `${taskUrl}/start`, 202, {
      operationId: randomUUID(),
      rowVersion: task.task.rowVersion,
    });
    await eventually(inference, (status) =>
      assert.ok(
        pool(status)?.operations.some(
          (operation) =>
            operation.chatId === taskId && operation.state === "waiting",
        ),
        "the source input is waiting for its provider",
      ),
    );
    const view = await eventually(
      () => call("GET", routeUrl, 200),
      ({ source }) => assert.equal(source?.providerId, providerId),
    );
    const operationId = randomUUID();
    const targetModelRouteId = destination.profile.routes[0].id;
    const change = await call("POST", routeUrl, 200, {
      operationId,
      inputOperationId: view.source.operationId,
      expectedRevision: view.revision,
      targetModelRouteId,
      targetProviderAccountId: null,
    });
    assert.equal(change.phase, "draining");
    assert.equal(change.source.operationId, view.source.operationId);
    const completed = await eventually(
      () => call("GET", routeUrl, 200),
      ({ latest }) => {
        assert.equal(latest?.operationId, operationId);
        assert.equal(latest.phase, "completed");
      },
    );
    assert.equal(completed.latest.targetModelRouteId, targetModelRouteId);
    await eventually(
      () => replacement,
      (value) =>
        assert.ok(
          value.entered,
          "the replacement uses the destination provider",
        ),
    );
    assert.ok(JSON.stringify(replacement.request.input).includes(prompt));
    assert.equal(
      source.model.requests.filter(({ method }) => method === "POST").length,
      sourceRequests,
    );
    assert.equal(
      held.request.closed,
      false,
      "the unrelated execution retained its source slot",
    );

    await call("DELETE", taskUrl, 204);
    await eventually(
      () => replacement.request,
      (request) => assert.ok(request.closedBeforeCompletion),
    );
  } finally {
    held.release();
    replacement.release();
  }
}

async function verifyProviderCapacity() {
  const live = new LiveProbe({ server, client: () => ({ cookies: [] }) });
  try {
    await live.open();
    await live.initialized();
    await live.subscribed();
    const { model, provider, profile } = await createModel(
      "Capacity fixture",
      1,
    );
    await call("PATCH", "/api/settings", 200, {
      defaultModelId: profile.id,
      autoNameChats: false,
    });
    const poolFor = (status) =>
      status.pools.find((pool) => pool.providerId === provider.id);
    const status = () => call("GET", `/api/workers/${workerId}/inference`, 200);
    const configured = await eventually(status, (snapshot) => {
      assert.equal(snapshot.ownerId, ownerId);
      assert.equal(snapshot.workerId, workerId);
      assert.equal(poolFor(snapshot)?.maxConcurrentInference, 1);
      assert.ok(Number.isInteger(snapshot.providerCatalogRevision));
    });
    const firstChat = await createChat("First capacity fixture", false);
    const secondChat = await createChat("Second capacity fixture", false);
    const firstReply = model.reply({ text: "First visible reply", hold: true });
    const secondReply = model.reply({
      text: "Second visible reply",
      hold: true,
    });
    const submit = async (chatUrl, prompt) => {
      const turn = await encryptedTurn(prompt, profile.id);
      const receipt = await call("POST", `${chatUrl}/turns`, 202, turn);
      assert.equal(receipt.status, "queued");
    };
    try {
      await submit(firstChat.chatUrl, "First private capacity prompt");
      await eventually(
        () => firstReply,
        (value) => assert.ok(value.entered),
      );
      await submit(secondChat.chatUrl, "Second private capacity prompt");
      const waiting = (pool) =>
        pool?.activeCount === 1 &&
        pool.queuedCount === 1 &&
        pool.operations.some(
          (op) =>
            op.chatId === secondChat.chatId &&
            op.state === "waiting" &&
            op.queuePosition === 1,
        );
      const snapshot = await eventually(status, (value) =>
        assert.ok(waiting(poolFor(value))),
      );
      const event = await live.message(
        (frame) =>
          frame.type === "event" &&
          frame.resource === "worker-inference" &&
          frame.action === "status" &&
          frame.entityId === workerId &&
          waiting(poolFor(frame.payload)),
      );
      assert.equal(event.payload.workerGeneration, snapshot.workerGeneration);
      assert.equal(secondReply.entered, false);

      const changed = await call(
        "PATCH",
        `/api/settings/providers/${provider.id}`,
        200,
        {
          name: provider.name,
          baseUrl: provider.baseUrl,
          kind: provider.kind,
          maxConcurrentInference: 2,
        },
      );
      await eventually(
        () => secondReply,
        (value) => assert.ok(value.entered),
      );
      assert.equal(firstReply.request.completed, false);
      await eventually(status, (value) => {
        assert.equal(value.workerGeneration, configured.workerGeneration);
        const pool = poolFor(value);
        assert.equal(pool?.maxConcurrentInference, 2);
        assert.equal(
          pool?.inferenceConfigRevision,
          changed.inferenceConfigRevision,
        );
        assert.equal(pool?.activeCount, 2);
        assert.equal(pool?.queuedCount, 0);
      });
    } finally {
      firstReply.release();
      secondReply.release();
    }
    for (const chat of [firstChat, secondChat]) {
      await eventually(
        () => call("GET", `${chat.chatUrl}/messages`, 200),
        ({ messages }) =>
          assert.ok(
            messages.some(
              (message) =>
                (message.classification?.role ?? message.role) === "assistant",
            ),
          ),
      );
    }
    await eventually(status, (snapshot) =>
      assert.equal(poolFor(snapshot)?.activeCount, 0),
    );
    assert.deepEqual(model.failures, []);
  } finally {
    await live.close();
  }
}

async function verifyInteraction() {
  const model = await createModel("Native interaction model");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: model.profile.id,
    autoNameChats: false,
  });
  const { chatId, chatUrl } = await createChat("Native approval", false);
  const beforePause = restoredInteractions
    ? model.model.reply({ hold: true })
    : null;
  const answer = model.model.reply({
    text: "Protected interaction complete.",
    hold: true,
  });
  await call(
    "POST",
    `${chatUrl}/turns`,
    202,
    await encryptedTurn(approvalPrompt, model.profile.id),
  );
  let heldTurn;
  if (beforePause) {
    await eventually(
      () => beforePause.entered,
      (entered) => assert.ok(entered),
    );
    const tool = modelFunctions(beforePause.request.input.tools).find(
      ({ name }) => name === "exec_command" || name.endsWith("__exec_command"),
    );
    assert.ok(tool, "The bundled runtime advertises its shell tool");
    beforePause.text = "Holding this turn for restart.";
    beforePause.calls = [
      {
        ...tool,
        arguments: { cmd: "printf pause-boundary", yield_time_ms: 1000 },
      },
    ];
    const pause = call("PATCH", `${chatUrl}/pause`, 200, { paused: true });
    // Always release the provider, including if Core rejects Pause.
    heldTurn = await Promise.race([
      eventually(
        () => readFile(approvalMarker + ".pause", "utf8").then(JSON.parse),
        (turn) => assert.ok(turn.threadId && turn.turnId),
      ),
      pause.then(() => {
        throw new Error("Pause returned without reaching Codex.");
      }),
    ]).finally(() => beforePause.release());
    const paused = await pause;
    assert.equal(paused.paused, true);
    assert.equal(answer.entered, false);
    assert.deepEqual(await stopWorker(), { code: 0, signal: null });
    await startWorker();
    const resumed = await call("PATCH", `${chatUrl}/pause`, 200, {
      paused: false,
    });
    assert.equal(resumed.paused, false);
  }
  await eventually(
    () => answer,
    (plan) => assert.equal(plan.entered, true),
  );
  const listing = `/api/agent-requests?chatId=${chatId}&status=pending`;
  const [request] = await eventually(
    () => call("GET", listing, 200),
    (requests) => {
      assert.equal(requests.length, 1);
      assert.equal(requests[0].classification?.kind, "commandExecution");
    },
  );
  const common = {
    ownerId,
    keyRevision,
    componentKey: interactionKey,
    requestKey: request.requestKey,
  };
  assert.equal(request.provenance.chatId, chatId);
  assert.ok(request.provenance.turnId);
  if (heldTurn) {
    assert.equal(request.provenance.threadId, heldTurn.threadId);
    assert.equal(request.provenance.turnId, heldTurn.turnId);
  }
  assert.ok(!JSON.stringify(request).includes("private fixture approval"));
  const opened = await crypto.decryptInteractionRequestContent({
    ...common,
    encrypted: request.protectedPayload,
    publicClassification: request.classification,
  });
  assert.equal(opened.payload.command, "echo private fixture approval");
  const classification = { kind: "commandExecution" };
  const response = { kind: "commandExecution", decision: "decline" };
  async function encryptReply(requestKey) {
    return {
      idempotencyKey: randomUUID(),
      classification,
      protectedResponse: await crypto.encryptInteractionResponseContent({
        ...common,
        requestKey,
        content: { version: 1, classification, response },
      }),
    };
  }
  const url = `/api/agent-requests/${request.id}`;
  await call(
    "POST",
    `${url}/respond`,
    409,
    await encryptReply("unrelated-request-key"),
  );
  await assert.rejects(readFile(approvalMarker), { code: "ENOENT" });
  assert.equal((await call("GET", url, 200)).status, "pending");
  const payload = await encryptReply(request.requestKey);
  const saved = await call("POST", `${url}/respond`, 200, payload);
  assert.equal(saved.status, "resolved");
  const resolution = await crypto.decryptInteractionResponseContent({
    ...common,
    encrypted: saved.protectedResponse,
    publicClassification: saved.classification,
  });
  assert.deepEqual(resolution.response, response);
  await call("POST", `${url}/respond`, 409, {
    ...payload,
    idempotencyKey: randomUUID(),
  });
  await eventually(
    () => readFile(approvalMarker, "utf8"),
    (text) => {
      assert.deepEqual(text.trim().split("\n").map(JSON.parse), [
        { id: "cantrip-fixture-approval", result: { decision: "decline" } },
      ]);
    },
  );
  answer.release();
  await eventually(
    () => answer,
    (plan) => assert.equal(plan.request?.completed, true),
  );
  await eventually(
    async () => {
      const { messages } = await call("GET", `${chatUrl}/messages`, 200);
      return Promise.all(messages.map(openMessage));
    },
    (messages) => {
      assert.equal(
        messages.filter(({ content }) =>
          content.some((item) => item.text === answer.text),
        ).length,
        1,
      );
    },
  );
  assert.deepEqual(model.model.failures, []);
  console.log(
    heldTurn
      ? "A restored turn accepted one protected approval reply on its replacement runtime."
      : "Protected approval authenticated against its native request and reached Codex once.",
  );
}

async function verifyPlanQuestion() {
  const { model, profile } = await createModel("Native Plan Mode model");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: profile.id,
    autoNameChats: false,
  });
  const { chatId, chatUrl } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: "Native Plan Mode question",
  });
  const explanation = "Private plan explanation.";
  const steps = [{ step: "Private test step", status: "inProgress" }];
  const question = "Which private option should this plan use?";
  const selected = "First private option";
  const plan = model.reply({ hold: true });
  const prepared = model.reply({ text: "The checklist is prepared." });
  const input = model.reply({ hold: true });
  const final = model.reply({
    text: "The plan used the selected option.",
    hold: true,
  });
  const openedPlan = async (mode = "plan") => {
    const wire = await call("GET", `${chatUrl}/plan`, 200);
    assert.equal(wire.mode, mode);
    assert.ok(wire.state);
    assert.ok(!JSON.stringify(wire).includes(question));
    assert.ok(!JSON.stringify(wire).includes(explanation));
    const state = await crypto.decryptChatPlanProtectedContent({
      ownerId,
      chatId,
      keyRevision,
      componentKey: chatKey,
      encrypted: wire.state.protectedContent,
      publicClassification: wire.state.classification,
    });
    assert.equal(wire.hasQuestion, Boolean(state.question));
    return state;
  };
  const nativeTool = async (reply, name) => {
    await eventually(
      () => reply.entered,
      (entered) => assert.ok(entered),
    );
    const tool = modelFunctions(reply.request.input.tools).find(
      (entry) => entry.name === name,
    );
    assert.ok(tool, `The bundled runtime advertises ${name}`);
    return tool;
  };
  try {
    await call(
      "POST",
      `${chatUrl}/turns`,
      202,
      await encryptedTurn("Prepare a checklist for the next turn.", profile.id),
    );
    plan.calls = [
      {
        ...(await nativeTool(plan, "update_plan")),
        arguments: {
          explanation,
          plan: [{ step: steps[0].step, status: "in_progress" }],
        },
      },
    ];
    plan.release();
    await eventually(
      () => prepared.request,
      (request) => assert.equal(request?.completed, true),
    );
    const updateResult = prepared.request.input.input.find(
      (item) => item.type === "function_call_output",
    );
    assert.match(JSON.stringify(updateResult?.output ?? null), /Plan updated/);
    await eventually(
      () => openedPlan("default"),
      (state) => {
        assert.equal(state.explanation, explanation);
        assert.deepEqual(state.steps, steps);
        assert.equal(state.question, null);
      },
    );
    const planUrl = `${chatUrl}/plan`;
    const settingsUrl = `${chatUrl}/native-settings`;
    const { id: serverId } = (await call("GET", "/api/bootstrap", 200)).server;
    const nativeMode = async () => {
      const { effective } = await call(
        "POST",
        `${settingsUrl}/refresh`,
        200,
        {},
      );
      assert.ok(effective);
      const settings = await crypto.decryptNativeSettingsSnapshot({
        ownerId,
        serverId,
        keyRevision,
        componentKey: chatKey,
        context: effective.context,
        snapshot: effective,
      });
      return {
        threadId: effective.context.threadId,
        mode: settings.collaborationMode.mode,
      };
    };
    const initial = await eventually(nativeMode, (state) =>
      assert.equal(state.mode, "default"),
    );
    await eventually(
      () => call("PATCH", planUrl, 200, { mode: "plan" }),
      (state) => assert.equal(state.mode, "plan"),
    );
    assert.deepEqual(await nativeMode(), { ...initial, mode: "plan" });
    assert.equal((await call("GET", planUrl, 200)).mode, "plan");
    await call(
      "POST",
      `${chatUrl}/turns`,
      202,
      await encryptedTurn(
        "Ask for a decision before completing the plan.",
        profile.id,
        "plan",
      ),
    );
    const questionTool = await nativeTool(input, "request_user_input");
    await call("PATCH", planUrl, 409, { mode: "default" });
    input.calls = [
      {
        ...questionTool,
        arguments: {
          isBlocking: true,
          questions: [
            {
              id: "choice",
              header: "Choice",
              question,
              options: [
                { label: selected, description: "Use this option." },
                { label: "Alternative", description: "Use another option." },
              ],
            },
          ],
        },
      },
    ];
    input.release();

    const [pending] = await eventually(
      () =>
        call("GET", `/api/agent-requests?chatId=${chatId}&status=pending`, 200),
      (requests) => {
        assert.equal(requests.length, 1);
        assert.equal(requests[0].classification?.kind, "userInput");
      },
    );
    const state = await eventually(openedPlan, (state) => {
      assert.equal(state.explanation, explanation);
      assert.deepEqual(state.steps, steps);
      assert.equal(state.question?.id, pending.requestKey);
      assert.equal(state.question.questions[0].question, question);
    });
    for (const identity of ["threadId", "turnId", "itemId"]) {
      assert.equal(state.question[identity], pending.provenance[identity]);
    }
    assert.equal(final.entered, false);
    const context = {
      ownerId,
      keyRevision,
      componentKey: interactionKey,
      requestKey: pending.requestKey,
    };
    const request = await crypto.decryptInteractionRequestContent({
      ...context,
      encrypted: pending.protectedPayload,
      publicClassification: pending.classification,
    });
    assert.deepEqual(state.question.questions, request.payload.questions);
    const response = {
      kind: "userInput",
      answers: { choice: { answers: [selected] } },
    };
    const payload = {
      idempotencyKey: randomUUID(),
      classification: pending.classification,
      protectedResponse: await crypto.encryptInteractionResponseContent({
        ...context,
        content: {
          version: 1,
          classification: pending.classification,
          response,
        },
      }),
    };
    const resolved = await call(
      "POST",
      `/api/agent-requests/${pending.id}/respond`,
      200,
      payload,
    );
    assert.equal(resolved.status, "resolved");
    await eventually(openedPlan, (state) => {
      assert.equal(state.explanation, explanation);
      assert.deepEqual(state.steps, steps);
      assert.equal(state.question, null);
    });
    await eventually(
      () => final,
      (reply) => {
        assert.ok(reply.entered);
        assert.ok(
          reply.request.input.input.some(
            (item) =>
              item.type === "function_call_output" &&
              JSON.stringify(item.output).includes(selected),
          ),
        );
      },
    );
    final.release();
    await eventually(
      () => final.request,
      (request) => assert.equal(request?.completed, true),
    );
    await eventually(
      () => call("PATCH", planUrl, 200, { mode: "default" }),
      (state) => {
        assert.equal(state.mode, "default");
        assert.equal(state.state, null);
      },
    );
    assert.deepEqual(await nativeMode(), initial);
    const scratch = await createChat(
      "Default mode without a native thread",
      false,
    );
    assert.equal(
      (await call("PATCH", `${scratch.chatUrl}/plan`, 200, { mode: "default" }))
        .mode,
      "default",
    );
    const invalid = await call("PATCH", `${scratch.chatUrl}/plan`, 409, {
      mode: "plan",
    });
    assert.match(invalid.error, /supports only default conversation mode/);
    assert.equal(
      (await call("GET", `${scratch.chatUrl}/plan`, 200)).mode,
      "default",
    );
    assert.deepEqual(model.failures, []);
    console.log(
      "Native Plan Mode applied both settings writes and answered an encrypted question on the same thread.",
    );
  } finally {
    for (const reply of [plan, input, final]) reply.release();
  }
}

async function verifyGoalHandoff() {
  const source = await createModel("Queued Goal source", 1);
  const target = await createModel("Queued Goal destination", 1);
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: source.profile.id,
    autoNameChats: false,
  });
  const { chatId, chatUrl } = await createPreparedProjectChat({
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    labelKey,
    title: "Queued Goal provider handoff",
  });
  const blocker = await createChat("Unrelated Goal capacity fixture", false);
  const held = source.model.reply({
    text: "Source capacity is held.",
    hold: true,
  });
  let destinationHold;
  let finish;
  goalHandoffFault.sourceRoute = source.profile.routes[0].id;
  try {
    await call(
      "POST",
      `${blocker.chatUrl}/turns`,
      202,
      await encryptedTurn(
        "Hold the provider for another Chat.",
        source.profile.id,
      ),
    );
    await eventually(
      () => held.request,
      (request) => assert.ok(request),
    );
    const settings = `${chatUrl}/native-settings`;
    let binding;
    if (!recoverGoalHandoff) {
      ({ binding } = await call("POST", `${settings}/refresh`, 200, {}));
    }
    const objective = "Finish the existing queued Goal in the new provider.";
    await call("POST", `${chatUrl}/goal?encrypted=1`, 202, {
      objective,
      tokenBudget: 50_000,
    });
    await eventually(
      () => call("GET", `/api/workers/${workerId}/inference`, 200),
      (status) =>
        assert.ok(
          status.pools
            .find((pool) => pool.providerId === source.provider.id)
            ?.operations.some(
              (operation) =>
                operation.chatId === chatId && operation.state === "waiting",
            ),
        ),
      35_000,
    );
    const operationId = randomUUID();
    const url = `${chatUrl}/runtime-handoffs`;
    const transfer = `${url}/${operationId}`;
    const initiate = () =>
      call("POST", url, 202, {
        operationId,
        bindingId: binding.bindingId,
        targetModelRouteId: target.profile.routes[0].id,
        targetProviderAccountId: null,
      });
    let retained;
    let oldReceipt;
    if (recoverGoalHandoff) {
      await stopWorker();
      await startWorker();
      retained = await eventually(
        () => goalHandoffFault.sourceAdmission?.intent.goalRecovery,
        (value) => assert.ok(value?.goalEpoch),
        35_000,
      );
      ({ binding } = await call("POST", `${settings}/refresh`, 200, {}));
      assert.equal(binding.threadId, retained.threadId);
      await initiate();
      oldReceipt = await eventually(
        () => goalHandoffFault.fence,
        (receipt) => assert.equal(receipt?.operationId, operationId),
        35_000,
      );
      assert.deepEqual(oldReceipt.source, retained);
      const interrupted = await call("GET", transfer, 200);
      assert.equal(interrupted.phase, "preparing");
      assert.equal(interrupted.queuedSource.withdrawn, false);
      assert.equal(
        interrupted.binding.runtimeGeneration,
        oldReceipt.runtimeGeneration,
      );
      await stopWorker();
      await startWorker();
    }
    const destinationBlocker = await createChat(
      "Unrelated destination capacity",
      false,
    );
    destinationHold = target.model.reply({
      text: "Destination capacity is held.",
      hold: true,
    });
    await call(
      "POST",
      `${destinationBlocker.chatUrl}/turns`,
      202,
      await encryptedTurn(
        "Hold the new provider while the Goal is recovered.",
        target.profile.id,
      ),
    );
    await eventually(
      () => destinationHold.request,
      (request) => assert.ok(request),
    );
    finish = target.model.reply({ hold: true });
    const answer = target.model.reply({
      text: "The retained native Goal finished on the destination.",
    });
    if (recoverGoalHandoff) {
      goalHandoffFault.allowFence = true;
      await call("POST", `${transfer}/retry`, 202, {});
    } else {
      await initiate();
    }
    const completed = await eventually(
      () => call("GET", transfer, 200),
      (value) => assert.equal(value.phase, "completed", JSON.stringify(value)),
      35_000,
    );
    assert.equal(completed.queuedSource.withdrawn, true);
    if (recoverGoalHandoff) {
      assert.deepEqual(completed.queuedSource.goalRecovery, retained);
      const fence = completed.queuedSource.goalWithdrawal;
      assert.notEqual(fence.runtimeGeneration, oldReceipt.runtimeGeneration);
      assert.notEqual(fence.workerGeneration, oldReceipt.workerGeneration);
    } else {
      const admission = goalHandoffFault.liveSource;
      assert.ok(admission?.intent.autonomousAttempt.goalEpoch);
      assert.deepEqual(
        completed.queuedSource.autonomousAttempt,
        admission.intent.autonomousAttempt,
      );
      const proof = goalHandoffFault.withdrawal;
      assert.equal(proof.state, "released");
      assert.equal(proof.outcome, "never-started");
      assert.ok(!proof.nativeExecution);
      const recovered = proof.identity.recovery;
      assert.equal(recovered.commandId, admission.operationId);
      assert.equal(recovered.threadId, binding.threadId);
      assert.equal(recovered.turnId, admission.intent.autonomousAttempt.turnId);
      retained = {
        operationId: recovered.commandId,
        operationGeneration: recovered.commandGeneration,
        threadId: recovered.threadId,
        goalEpoch: admission.intent.autonomousAttempt.goalEpoch,
      };
    }
    assert.equal(completed.binding.threadId, retained.threadId);
    assert.equal(completed.binding.modelRouteId, target.profile.routes[0].id);
    await eventually(
      () => call("GET", `/api/workers/${workerId}/inference`, 200),
      (status) =>
        assert.ok(
          status.pools
            .find((pool) => pool.providerId === target.provider.id)
            ?.operations.some(
              (operation) =>
                operation.chatId === chatId && operation.state === "waiting",
            ),
        ),
    );
    await eventually(
      () => diagnostics,
      (logs) =>
        assert.match(
          logs,
          /event=worker\.command\.completed operation=chat\.goal\.recover /,
        ),
    );
    assert.equal(finish.request, null);
    destinationHold.release();
    await eventually(
      () => finish.request,
      (request) => assert.ok(request),
      35_000,
    );
    const tool = modelFunctions(finish.request.input.tools).find(
      ({ name }) => name === "update_goal" || name.endsWith("__update_goal"),
    );
    assert.ok(tool, "The retained Goal exposes native completion.");
    finish.calls = [{ ...tool, arguments: { status: "complete" } }];
    finish.release();
    await eventually(
      () => answer.request,
      (request) => assert.equal(request?.completed, true),
      35_000,
    );
    await eventually(
      () => call("GET", `${chatUrl}/goal?encrypted=1`, 200),
      (state) =>
        assert.equal(state.goal?.status, "complete", JSON.stringify(state)),
    );
    assert.ok(goalHandoffFault.destinationAdmission);
    assert.deepEqual(
      goalHandoffFault.destinationAdmission.intent.goalRecovery,
      retained,
    );
    assert.equal(
      goalHandoffFault.destinationAdmission.intent.goalRecoveryOrderEpoch,
      1,
    );
    assert.equal(
      source.model.requests.filter(({ method }) => method === "POST").length,
      1,
    );
    assert.deepEqual(target.model.failures, []);
    console.log(
      `The ${recoverGoalHandoff ? "recovered" : "queued"} Goal moved its existing epoch and resumed on the destination.`,
    );
  } finally {
    held.release();
    destinationHold?.release();
    finish?.release();
  }
}

async function verifyRuntimeHandoff() {
  const source = await createModel(
    "Handoff source",
    queuedHandoff ? 1 : undefined,
  );
  const target = await createModel("Handoff destination", undefined, [
    { id: "handoff-destination-model" },
  ]);
  const targetProfile = await call("POST", "/api/settings/models", 201, {
    name: "Handoff destination route",
    routes: [
      {
        providerId: target.provider.id,
        modelName: "handoff-destination-model",
        enabled: true,
      },
    ],
  });
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: source.profile.id,
    autoNameChats: false,
  });
  const { chatId, chatUrl } = queuedHandoff
    ? await createChat("Native queued provider handoff", false)
    : await createPreparedProjectChat({
        call,
        eventually,
        ownerId,
        workerId,
        keyRevision,
        labelKey,
        title: "Native provider handoff",
      });
  const submit = async (provider, content, text, modelId) => {
    const reply = provider.model.reply({ text });
    const turn = await encryptedTurn(content, modelId);
    await call("POST", `${chatUrl}/turns`, 202, turn);
    await eventually(
      () => reply.request,
      (request) => assert.equal(request?.completed, true),
      35_000,
    );
    await eventually(
      async () => {
        const { messages } = await call("GET", `${chatUrl}/messages`, 200);
        return Promise.all(messages.map(openMessage));
      },
      (messages) =>
        assert.ok(
          messages.some((message) =>
            message.content.some((item) => item.text === text),
          ),
        ),
    );
    return reply.request.input;
  };
  const firstPrompt = "Remember the source reply across the provider change.";
  const firstReply = "This is the original conversation.";
  await submit(source, firstPrompt, firstReply, source.profile.id);
  const handoffUrl = `${chatUrl}/runtime-handoffs`;
  const settingsUrl = `${chatUrl}/native-settings`;
  const { binding } = await call("POST", `${settingsUrl}/refresh`, 200, {});
  const operationId = randomUUID();
  const beginHandoff = () =>
    eventually(
      () =>
        call("POST", handoffUrl, 202, {
          operationId,
          bindingId: binding.bindingId,
          targetModelRouteId: targetProfile.routes[0].id,
          targetProviderAccountId: null,
        }),
      (state) => assert.equal(state.operationId, operationId),
    );
  if (queuedHandoff) {
    const cancelling = values["queued-handoff-cancel"];
    const restarting = values["queued-handoff-recovery"];
    const blocker = await createChat("Unrelated source capacity", false);
    const held = source.model.reply({
      text: "Unrelated source answer",
      hold: true,
    });
    const queueText = "Run this exact protected prompt once.";
    const answer = "The transferred prompt executed once.";
    try {
      await call(
        "POST",
        `${blocker.chatUrl}/turns`,
        202,
        await encryptedTurn("Hold the old provider slot.", source.profile.id),
      );
      await eventually(
        () => held.request,
        (request) => assert.ok(request),
      );
      const queued = await encryptedTurn(queueText, source.profile.id);
      await call("POST", `${chatUrl}/turns`, 202, queued);
      await eventually(
        () => call("GET", `/api/workers/${workerId}/inference`, 200),
        (status) =>
          assert.ok(
            status.pools
              .find(({ providerId }) => providerId === source.provider.id)
              ?.operations.some(
                (op) => op.chatId === chatId && op.state === "waiting",
              ),
          ),
      );
      if (!cancelling) {
        target.model.reply({
          text: "Proceed with the cleared model context.",
          onlyFor: (request) => request.input.model === source.model.model,
        });
      }
      const selected = cancelling ? source : target;
      const other = cancelling ? target : source;
      const selectedModel = cancelling
        ? source.model.model
        : "handoff-destination-model";
      const reply = selected.model.reply({ text: answer });
      const started = await beginHandoff();
      assert.ok(started.queuedSource?.operationGeneration);
      assert.equal(started.queuedSource.withdrawn, false);
      if (restarting || cancelling) {
        await eventually(
          () => receiptProxy.withheld(),
          (operation) => assert.equal(operation, operationId),
        );
        const saved = await call("GET", `${handoffUrl}/${operationId}`, 200);
        assert.equal(saved.queuedSource.withdrawn, true);
        assert.equal(saved.phase, "preparing");
        if (cancelling) {
          await call("POST", `${handoffUrl}/${operationId}/cancel`, 202, {});
        } else {
          await stopWorker();
          receiptProxy.open();
          await startWorker();
          await call("POST", `${handoffUrl}/${operationId}/retry`, 202, {});
        }
      }
      const transferred = await eventually(
        () => call("GET", `${handoffUrl}/${operationId}`, 200),
        (state) =>
          assert.equal(
            state.phase,
            cancelling ? "cancelled" : "completed",
            JSON.stringify(state),
          ),
        35_000,
      );
      assert.equal(
        transferred.queuedSource.operationId,
        started.queuedSource.operationId,
      );
      assert.equal(transferred.queuedSource.withdrawn, true);
      assert.equal(transferred.binding.threadId, binding.threadId);
      assert.equal(
        transferred.binding.modelRouteId,
        cancelling ? binding.modelRouteId : targetProfile.routes[0].id,
      );
      if (cancelling) {
        assert.equal(held.request.completed, false);
        assert.equal(reply.request, null);
        assert.equal(
          transferred.binding.runtimeGeneration,
          binding.runtimeGeneration,
        );
        held.release();
      } else {
        assert.equal(
          transferred.queuedSource.retargetedPrompt.id,
          queued.queuedPrompt.id,
        );
      }
      await eventually(
        () => reply.request,
        (request) => assert.equal(request?.completed, true),
        35_000,
      );
      assert.ok(JSON.stringify(reply.request.input.input).includes(queueText));
      assert.equal(reply.request.input.model, selectedModel);
      assert.ok(
        !other.model.requests.some(({ input }) =>
          JSON.stringify(input).includes(queueText),
        ),
      );
      const turns = selected.model.requests.filter(
        ({ input }) =>
          input?.model === selectedModel &&
          JSON.stringify(input.input).includes(queueText),
      );
      assert.equal(turns.length, 1);
      await eventually(
        async () => {
          const { messages } = await call("GET", `${chatUrl}/messages`, 200);
          assert.equal(
            messages.filter(({ id }) => id === queued.message.id).length,
            1,
          );
          return Promise.all(messages.map(openMessage));
        },
        (messages) =>
          assert.ok(
            messages.some((message) =>
              message.content.some((item) => item.text === answer),
            ),
          ),
      );
      if (!restarting && !cancelling)
        assert.equal(held.request.completed, false);
      assert.deepEqual(source.model.failures, []);
      assert.deepEqual(target.model.failures, []);
      console.log(
        cancelling
          ? "Cancellation resumed the original protected prompt exactly once."
          : "A protected queued prompt moved to the destination and executed once.",
      );
    } finally {
      held.release();
    }
    return;
  }
  await beginHandoff();
  if (values["runtime-handoff-recovery"] || values["runtime-handoff-cancel"]) {
    await eventually(
      () => receiptProxy.withheld(),
      (operation) => assert.equal(operation, operationId),
      35_000,
    );
    const state = await call("GET", `${handoffUrl}/${operationId}`, 200);
    if (values["runtime-handoff-cancel"]) {
      assert.equal(state.phase, "prepared");
      await call("POST", `${handoffUrl}/${operationId}/cancel`, 202, {});
      await eventually(
        () => call("GET", `${handoffUrl}/${operationId}`, 200),
        (state) =>
          assert.equal(state.phase, "cancelled", JSON.stringify(state)),
      );
      const current = await call("POST", `${settingsUrl}/refresh`, 200, {});
      assert.equal(current.binding.threadId, binding.threadId);
      assert.equal(
        current.binding.runtimeGeneration,
        binding.runtimeGeneration,
      );
      await submit(
        source,
        "Continue on the original provider after cancellation.",
        "The original provider resumed the conversation.",
        source.profile.id,
      );
      assert.ok(target.model.requests.every(({ method }) => method !== "POST"));
      console.log(
        "Native provider handoff cancellation restored the live source.",
      );
      return;
    }
    assert.equal(state.phase, "committed");
    await stopWorker();
    receiptProxy.open();
    await startWorker();
    await call("POST", `${handoffUrl}/${operationId}/retry`, 202, {});
  }
  const transferred = await eventually(
    () => call("GET", `${handoffUrl}/${operationId}`, 200),
    (state) => assert.equal(state.phase, "completed", JSON.stringify(state)),
    35_000,
  );
  assert.equal(transferred.chatId, chatId);
  assert.equal(transferred.binding.threadId, binding.threadId);
  assert.notEqual(
    transferred.binding.runtimeGeneration,
    binding.runtimeGeneration,
  );
  assert.equal(transferred.binding.modelRouteId, targetProfile.routes[0].id);
  await stopWorker();
  await startWorker();
  const summary = target.model.reply({
    text: "The transferred model context is empty.",
    onlyFor: (request) => request.input.model === source.model.model,
  });
  const after = await submit(
    target,
    "Continue the same conversation in the new provider.",
    "The new route resumed the original thread.",
    targetProfile.id,
  );
  assert.equal(after.model, "handoff-destination-model");
  for (const request of [after, summary.request?.input].filter(Boolean)) {
    assert.ok(!JSON.stringify(request.input).includes(firstPrompt));
    assert.ok(!JSON.stringify(request.input).includes(firstReply));
  }
  const { messages } = await call("GET", `${chatUrl}/messages`, 200);
  const retained = await Promise.all(messages.map(openMessage));
  for (const text of [firstPrompt, firstReply]) {
    assert.ok(
      retained.some((message) =>
        message.content.some((item) => item.text === text),
      ),
    );
  }
  assert.deepEqual(source.model.failures, []);
  assert.deepEqual(target.model.failures, []);
  console.log(
    "Native provider handoff retained the conversation across worker restart.",
  );
}

async function verifySettingsSnapshot() {
  const model = await createModel("Settings snapshot model");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: model.profile.id,
    autoNameChats: true,
  });
  const { chatId, chatUrl } = await verifyTurn(
    model,
    model,
    "settings",
    "Snapshot test title",
    "Snapshot test title",
  );
  const url = `${chatUrl}/native-settings`;
  const read = await eventually(
    () => call("GET", url, 200),
    (state) => assert.ok(state.binding && state.effective),
  );
  const explicit = await call("POST", `${url}/refresh`, 200, {});
  assert.equal(explicit.binding.bindingId, read.binding.bindingId);
  assert.equal(
    explicit.effective.contentFingerprint,
    read.effective.contentFingerprint,
  );
  const serverId = (await call("GET", "/api/bootstrap", 200)).server.id;
  assert.ok(serverId);
  assert.equal(read.effective.context.chatId, chatId);
  assert.equal(read.effective.context.workerId, workerId);
  assert.equal(read.effective.context.threadId, read.binding.threadId);
  assert.equal(
    read.effective.context.runtimeGeneration,
    read.binding.runtimeGeneration,
  );
  const open = (snapshot) =>
    crypto.decryptNativeSettingsSnapshot({
      ownerId,
      serverId,
      keyRevision,
      componentKey: chatKey,
      context: snapshot.context,
      snapshot,
    });
  const settings = await open(explicit.effective);
  assert.equal(settings.model, model.model.model);
  assert.equal(settings.settingsVersion.epoch, explicit.binding.nativeEpoch);
  assert.ok(!JSON.stringify(read).includes(settings.cwd));
  const bindingId = explicit.binding.bindingId;
  async function update(patch, changes = {}) {
    const operationId = randomUUID();
    const protectedPatch = await crypto.encryptNativeSettingsPatch({
      ownerId,
      serverId,
      keyRevision,
      componentKey: chatKey,
      patch,
      context: { chatId, operationId, bindingId, ...changes },
    });
    return { operationId, bindingId, protectedPatch };
  }

  const incorrect = await update(
    { effort: "low" },
    { bindingId: randomUUID() },
  );
  const denied = await call("POST", `${url}/update`, 500, incorrect);
  assert.ok(!JSON.stringify(denied).includes("low"));
  const wrongPlacement = path.join(root, "unauthorized-settings-directory");
  const rejected = await call(
    "POST",
    `${url}/update`,
    500,
    await update({ cwd: wrongPlacement }),
  );
  assert.ok(!JSON.stringify(rejected).includes(wrongPlacement));
  const afterErrors = await call("GET", url, 200);
  assert.equal(afterErrors.revision, explicit.revision);
  let state = afterErrors;
  for (const patch of [
    { effort: "low", serviceTier: null, collaborationModeKind: "plan" },
    { effort: null, unsetServiceTier: true },
  ]) {
    const request = await update(patch);
    const result = await call("POST", `${url}/update`, 200, request);
    assert.equal(result.operationId, request.operationId);
    assert.ok(result.submissionId);
    assert.ok(
      ["queued", "applied"].includes(result.status),
      JSON.stringify(result),
    );
    const previous = state.effective.context.settingsVersion;
    state = await eventually(
      () => call("GET", url, 200),
      (current) => {
        const version = current.effective?.context.settingsVersion;
        assert.equal(current.desiredStatus, "applied");
        assert.equal(current.desired.operationId, result.operationId);
        assert.equal(version?.epoch, previous.epoch);
        assert.ok(BigInt(version.revision) > BigInt(previous.revision));
      },
    );
    const changed = await open(state.effective);
    assert.equal(changed.effort, patch.effort);
    assert.equal(
      changed.serviceTier,
      patch.unsetServiceTier ? null : "default",
    );
    assert.equal(changed.collaborationMode.mode, "plan");
    assert.equal(changed.model, settings.model);
    await call("POST", `${url}/update`, 500, request);
    assert.equal((await call("GET", url, 200)).revision, state.revision);
  }
  console.log(
    "Production Rust Core and worker encrypted, applied and reopened client settings with stable operation receipts.",
  );
  await verifyAccountDefaults({ chatId, chatUrl, bindingId, serverId, state });
  await verifyPermissionTransition({ chatUrl, bindingId, model, open });
}

async function verifyPermissionTransition({ chatUrl, bindingId, model, open }) {
  const url = `${chatUrl}/native-settings`;
  const permission = `${chatUrl}/permission-profile`;
  const request = {
    id: ":read-only",
    bindingId,
    operationId: randomUUID(),
    expectedRevision: "0",
  };
  const update = await call("PATCH", permission, 200, request);
  assert.equal(update.operationId, request.operationId);
  assert.ok(update.submissionId);
  const applied = await eventually(
    () => call("GET", url, 200),
    (state) => {
      assert.equal(state.desiredStatus, "applied");
      assert.equal(state.permissionPolicy?.operationId, request.operationId);
      assert.equal(state.permissionPolicy?.effectiveId, ":read-only");
      assert.equal(state.permissionPolicy?.revision, "1");
      assert.equal(
        state.effective.context.settingsVersion.revision,
        state.permissionPolicy.settingsVersion.revision,
      );
    },
  );
  assert.equal(
    (await open(applied.effective)).activePermissionProfile.id,
    ":read-only",
  );

  await call("PATCH", permission, 409, {
    ...request,
    id: ":workspace",
    operationId: randomUUID(),
  });
  assert.equal(
    (await call("GET", url, 200)).permissionPolicy.operationId,
    request.operationId,
  );

  assert.deepEqual(await stopWorker(), { code: 0, signal: null });
  await startWorker();
  const response = model.model.reply({ text: "Permission recovery verified." });
  await call(
    "POST",
    `${chatUrl}/turns`,
    202,
    await encryptedTurn("Read only after restart", model.profile.id),
  );
  await eventually(
    () => response,
    (reply) => assert.equal(reply.request?.completed, true),
    35_000,
  );
  const recovered = await eventually(
    () => call("GET", url, 200),
    (state) => {
      const policy = state.permissionPolicy;
      assert.notEqual(
        state.binding.runtimeGeneration,
        applied.binding.runtimeGeneration,
      );
      assert.equal(policy.operationId, request.operationId);
      assert.equal(policy.revision, applied.permissionPolicy.revision);
      assert.equal(
        policy.source.runtimeGeneration,
        state.binding.runtimeGeneration,
      );
      assert.equal(policy.settingsVersion.epoch, state.binding.nativeEpoch);
    },
  );
  assert.equal(
    (await open(recovered.effective)).activePermissionProfile.id,
    ":read-only",
  );
  console.log(
    "Production Rust Core and worker confirmed the permission transition and recovered its native journal after restart.",
  );
}

async function verifyAccountDefaults({
  chatId,
  chatUrl,
  bindingId,
  serverId,
  state,
}) {
  const url = `${chatUrl}/native-account-defaults`;
  const material = { ownerId, serverId, keyRevision, componentKey: chatKey };
  const context = (operationId, direction) => ({
    chatId,
    bindingId,
    operationId,
    direction,
  });
  async function open(request) {
    const result = await call("POST", url, 200, request);
    assert.equal(result.operationId, request.operationId);
    assert.equal(result.bindingId, request.bindingId);
    assert.deepEqual(Object.keys(result).sort(), [
      "bindingId",
      "operationId",
      "protectedResult",
    ]);
    return crypto.decryptNativeAccountDefaults({
      ...material,
      context: context(request.operationId, "response"),
      envelope: result.protectedResult,
    });
  }
  const read = () =>
    open({ action: "read", bindingId, operationId: randomUUID() });
  async function write(expectedVersion, defaults, identity = {}) {
    const operationId = randomUUID();
    return {
      action: "write",
      bindingId,
      operationId,
      protectedWrite: await crypto.encryptNativeAccountDefaults({
        ...material,
        context: { ...context(operationId, "request"), ...identity },
        value: { expectedVersion, values: defaults },
      }),
    };
  }
  const before = await read();
  assert.equal(before.verification, "read");
  assert.equal(before.write, null);
  const initial = before.snapshot;
  const effort =
    initial.stored.model_reasoning_effort === "high" ? "low" : "high";
  await call(
    "POST",
    url,
    500,
    await write(
      initial.version,
      {
        model_reasoning_effort: effort,
      },
      { bindingId: randomUUID() },
    ),
  );
  assert.deepEqual((await read()).snapshot, initial);

  const request = await write(initial.version, {
    model_reasoning_effort: effort,
  });
  const written = await open(request);
  assert.equal(written.verification, "confirmed");
  assert.equal(written.write.version, written.snapshot.version);
  assert.notEqual(written.snapshot.version, initial.version);
  assert.deepEqual(written.snapshot.stored, {
    ...initial.stored,
    model_reasoning_effort: effort,
  });
  assert.deepEqual(
    await open(await write(initial.version, { personality: "friendly" })),
    {
      snapshot: null,
      write: null,
      verification: "rejected",
    },
  );
  await call("POST", url, 500, request);
  assert.deepEqual((await read()).snapshot, written.snapshot);

  const cleared = await open(
    await write(written.snapshot.version, { model_reasoning_effort: null }),
  );
  assert.equal(cleared.verification, "confirmed");
  assert.equal(cleared.snapshot.stored.model_reasoning_effort, undefined);
  assert.deepEqual((await read()).snapshot, cleared.snapshot);
  const settings = await call("GET", `${chatUrl}/native-settings`, 200);
  assert.equal(settings.revision, state.revision);
  assert.deepEqual(
    settings.effective.context.settingsVersion,
    state.effective.context.settingsVersion,
  );
  console.log(
    "Production Rust Core and worker reopened protected account defaults, confirmed writes and clears, and rejected stale versions and replays.",
  );
}

async function verifyStandaloneBehavior() {
  await verifyProviderCatalog({
    call,
    ownerId,
    workerId,
    keyRevision,
    componentKey: providerKey,
  });
  const modelOperations = {
    call,
    eventually,
    ownerId,
    workerId,
    keyRevision,
    providerKey,
    operationsKey,
  };
  await verifyEmbeddings(modelOperations);
  await verifyDecisions(modelOperations);
  await verifyProviderCapacity();

  const primary = await createModel("Response model");
  const alternate = await createModel("Title model");
  await call("PATCH", "/api/settings", 200, {
    defaultModelId: primary.profile.id,
    autoNameChats: true,
  });
  await verifyTurn(
    primary,
    primary,
    "same provider",
    "Title: “Working progress summary extra!”",
    "Working progress summary",
  );
  await call("PATCH", "/api/settings", 200, {
    labelingModelId: alternate.profile.id,
  });
  await verifyTurn(
    primary,
    alternate,
    "separate provider",
    "# Coordinating work today.",
    "Coordinating work today",
  );
  await verifyTurn(primary, alternate, "unusable label", "...", "New chat");
  assert.equal(
    primary.model.requests.filter(({ method }) => method === "POST").length,
    4,
  );
  assert.equal(
    alternate.model.requests.filter(({ method }) => method === "POST").length,
    2,
  );
  await verifyTaskLabels(alternate, primary);
  console.log(
    JSON.stringify({
      suite: "native-standalone-turn",
      passed: true,
      workerPathEmpty: true,
      durableEncryptedHistory: true,
      sameProviderTitle: true,
      separateProviderTitle: true,
      replySurvivesFailedTitle: true,
      duplicateSubmissionReplayed: true,
      taskLabelFromPausedQueue: true,
      revokedTaskCannotPublishTitle: true,
      resourceRevocationInterruptsRunningTask: true,
      queuedTaskTransferredProvider: true,
      protectedEmbeddingRequestsAndCancellation: true,
      protectedDecisionRequestsAndCancellation: true,
      liveProviderQueueAndLimit: true,
      endpointCatalogPagingAndMetadata: true,
      ollamaCatalogPagingAndMetadata: true,
    }),
  );
}

try {
  const data = path.join(root, "worker");
  const home = path.join(root, "home");
  await mkdir(home);
  if (planQuestion) {
    const codexHome = path.join(data, "codex-home");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(codexHome, "config.toml"),
      "[tools.update_plan]\nenabled = true\n",
      { mode: 0o600 },
    );
  }
  const environment = fixtureEnvironment(path.join(root, "server"));
  environment.HOME = home;
  environment.CANTRIP_BOOTSTRAP_MODE = "standalone";
  delete environment.CANTRIP_WORKER_TOKEN;
  server = await startServer(
    path.resolve(values.server),
    ["--database", "pglite", "--port", "0", "--shutdown-on-stdin-close"],
    { cwd: root, env: environment },
  );
  if (values.deferred) receiptProxy = await deferredReceiptProxy(server.origin);
  if (values["runtime-handoff-recovery"])
    receiptProxy = await deferredReceiptProxy(server.origin, {
      handoffAction: "commit",
    });
  if (values["runtime-handoff-cancel"])
    receiptProxy = await deferredReceiptProxy(server.origin, {
      handoffAction: "prepared",
    });
  if (values["queued-handoff-recovery"] || values["queued-handoff-cancel"])
    receiptProxy = await deferredReceiptProxy(server.origin, {
      handoffAction: "withdrawn",
    });
  if (goalHandoff) {
    goalHandoffFault = {};
    receiptProxy = await deferredReceiptProxy(server.origin, {
      blockRequest(url, bytes) {
        if (url === "/api/internal/native-commands/admit") {
          const request = JSON.parse(bytes);
          if (request.intent?.autonomousAttempt) {
            if (request.session.modelRouteId === goalHandoffFault.sourceRoute) {
              if (!request.intent.goalRecovery)
                goalHandoffFault.liveSource = request;
              else if (recoverGoalHandoff) {
                goalHandoffFault.sourceAdmission = request;
                return true;
              }
            } else if (request.intent.goalRecovery) {
              goalHandoffFault.destinationAdmission = request;
            }
          }
        }
        if (url === "/api/internal/native-runtime-handoffs") {
          const request = JSON.parse(bytes);
          if (request.action === "withdrawn")
            goalHandoffFault.withdrawal = request.record;
          if (
            request.action === "goal-recovery-withdrawn" &&
            !goalHandoffFault.allowFence
          ) {
            goalHandoffFault.fence = request.receipt;
            return true;
          }
        }
        return false;
      },
    });
  }
  const enrollment = await call("POST", "/api/workers/enrollment-codes", 201, {
    label: "Rust standalone turn",
  });
  workerEnvironment = {
    ...environment,
    PATH: "",
    NO_COLOR: "1",
    ...(consoleStateKey ? { TERM: "xterm-256color" } : {}),
    CANTRIP_LOG_LEVEL: "debug",
    CANTRIP_SERVER_URL: receiptProxy?.origin ?? server.origin,
    CANTRIP_WORKER_DATA_DIR: data,
    CANTRIP_WORKER_ID: workerId,
    CANTRIP_CODEX_BIN: values.deferred
      ? await fixtureCodex(root, values.codex)
      : values.interactions || consoleInteractions || restoredInteractions
        ? await fixtureCodex(root, values.codex, {
            scenario: restoredInteractions ? "resume-approval" : "approval",
            marker: approvalMarker,
            input: approvalPrompt,
            ...(consoleInteractions ? { socketFile: consoleSocket } : {}),
          })
        : path.resolve(values.codex),
    ...(values.cli ? { CANTRIP_CLI_BIN: path.resolve(values.cli) } : {}),
  };
  await startWorker(enrollment.code);
  await setupEncryption();
  if (values.cli) {
    // This disposable profile permits a shell connection to the local broker.
    await call("PATCH", "/api/settings", 200, {
      defaultChatPermissionProfileId: ":yolo",
    });
    await verifyManagedCli(await createModel("CLI scope model"), data);
    console.log(
      JSON.stringify({
        suite: "native-managed-codex-cli",
        passed: true,
        cliAvailableInCodexShell: true,
        staleLaneRejectedByCore: true,
      }),
    );
  } else if (values.deferred) {
    const model = await createModel("Deferred receipt model");
    await call("PATCH", "/api/settings", 200, {
      defaultModelId: model.profile.id,
      autoNameChats: true,
    });
    const chat = await verifyTurn(model, model, "warmup", "Warmup", "Warmup");
    await eventually(
      () => call("GET", `${chat.chatUrl}/native-settings`, 200),
      (state) => assert.ok(state.binding && state.effective),
    );
    await verifyDeferredReceipt({
      ...chat,
      data,
      proxy: receiptProxy,
      ownerId,
      workerId,
      model,
      encryptedTurn,
      call,
      eventually,
      startWorker,
      stopWorker,
      workerDiagnostics: () => diagnostics,
    });
    console.log(
      "Deferred prompt receipt survived a worker restart and replayed once.",
    );
  } else if (consoleInteractions) {
    await verifyConsoleInteraction({
      call,
      eventually,
      createModel,
      ownerId,
      workerId,
      keyRevision,
      labelKey,
      interactionKey,
      prompt: approvalPrompt,
      marker: approvalMarker,
      socketFile: consoleSocket,
    });
  } else if (values.interactions || restoredInteractions) {
    await verifyInteraction();
  } else if (subagentInteractions) {
    await verifySubagentInteraction({
      call,
      eventually,
      createModel,
      encryptedTurn,
      ownerId,
      workerId,
      keyRevision,
      labelKey,
      interactionKey,
      customModel: values["subagent-model"],
      startWorker,
      stopWorker,
      chatKey,
    });
  } else if (planQuestion) {
    await verifyPlanQuestion();
  } else if (goalHandoff) {
    await verifyGoalHandoff();
  } else if (runtimeHandoff) {
    await verifyRuntimeHandoff();
  } else if (values.settings) {
    await verifySettingsSnapshot();
  } else {
    await verifyStandaloneBehavior();
  }
} catch (error) {
  console.error(diagnostics.slice(-14_000));
  console.error(server?.diagnostics().slice(-14_000));
  throw error;
} finally {
  try {
    const workerResult = await stopWorker();
    await Promise.all([
      receiptProxy?.close(),
      server?.close(),
      ...models.map((model) => model.close()),
    ]);
    if (workerResult) assert.deepEqual(workerResult, { code: 0, signal: null });
  } finally {
    chatKey.fill(0);
    labelKey.fill(0);
    taskKey.fill(0);
    providerKey.fill(0);
    interactionKey?.fill(0);
    consoleStateKey?.fill(0);
    master.fill(0);
    await rm(root, { recursive: true, force: true });
  }
}
