// Public standalone Chat API through both Rust services and bundled Codex.
// A disposable loopback provider is the only execution substitute.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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
import { verifyProviderCatalog } from "./provider-catalog-smoke-cases.mjs";
import { LiveProbe } from "../server-rust/live-sockets.mjs";
import { taskModelProvider } from "../server-rust/task-model-provider.mjs";

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    worker: { type: "string" },
    codex: { type: "string" },
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
let server;
let child;
let workerExit;
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

async function encryptedTurn(prompt, modelId) {
  const common = { ownerId, keyRevision, componentKey: chatKey };
  const messageId = randomUUID();
  const promptId = randomUUID();
  const idempotencyKey = randomUUID();
  const classification = { mode: "default", attachmentIds: [] };
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

async function createModel(name, maxConcurrentInference) {
  const model = await taskModelProvider({ observeStreams: true });
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
  const opened = await Promise.all(
    messages.messages.map((message) =>
      crypto.decryptChatMessageProtectedContent({
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
      }),
    ),
  );
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

try {
  const data = path.join(root, "worker");
  const home = path.join(root, "home");
  await mkdir(home);
  const environment = fixtureEnvironment(path.join(root, "server"));
  environment.HOME = home;
  environment.CANTRIP_BOOTSTRAP_MODE = "standalone";
  delete environment.CANTRIP_WORKER_TOKEN;
  server = await startServer(
    path.resolve(values.server),
    ["--database", "pglite", "--port", "0", "--shutdown-on-stdin-close"],
    { cwd: root, env: environment },
  );
  const enrollment = await call("POST", "/api/workers/enrollment-codes", 201, {
    label: "Rust standalone turn",
  });
  child = spawn(path.resolve(values.worker), ["--shutdown-on-stdin-close"], {
    cwd: root,
    env: {
      ...environment,
      PATH: "",
      NO_COLOR: "1",
      CANTRIP_LOG_LEVEL: "debug",
      CANTRIP_SERVER_URL: server.origin,
      CANTRIP_WORKER_DATA_DIR: data,
      CANTRIP_WORKER_ID: workerId,
      CANTRIP_WORKER_ENROLLMENT_CODE: enrollment.code,
      CANTRIP_CODEX_BIN: path.resolve(values.codex),
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
  await setupEncryption();
  await verifyProviderCatalog({
    call,
    ownerId,
    workerId,
    keyRevision,
    componentKey: providerKey,
  });
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
      liveProviderQueueAndLimit: true,
      endpointCatalogPagingAndMetadata: true,
      ollamaCatalogPagingAndMetadata: true,
    }),
  );
} catch (error) {
  console.error(diagnostics.slice(-14_000));
  console.error(server?.diagnostics().slice(-14_000));
  throw error;
} finally {
  try {
    let workerResult;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        workerResult = await workerExit;
      } finally {
        clearTimeout(timer);
      }
    }
    await Promise.all([
      server?.close(),
      ...models.map((model) => model.close()),
    ]);
    if (workerResult) assert.deepEqual(workerResult, { code: 0, signal: null });
  } finally {
    chatKey.fill(0);
    labelKey.fill(0);
    taskKey.fill(0);
    providerKey.fill(0);
    master.fill(0);
    await rm(root, { recursive: true, force: true });
  }
}
