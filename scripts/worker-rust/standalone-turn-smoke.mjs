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
      "content-type": "application/json",
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

async function createModel(name) {
  const model = await taskModelProvider();
  models.push(model);
  const provider = await call("POST", "/api/settings/providers", 201, {
    id: randomUUID(),
    name,
    kind: "openai-compatible",
    baseUrl: model.baseUrl,
    initialAccount: null,
    protectedApiKey: null,
  });
  const profile = await call("POST", "/api/settings/models", 201, {
    name,
    routes: [
      { providerId: provider.id, modelName: model.model, enabled: true },
    ],
  });
  return { model, profile };
}

async function verifyTurn(
  response,
  naming,
  scenario,
  titleResponse,
  expectedTitle,
) {
  const chatId = randomUUID();
  const chatUrl = `/api/chats/${chatId}`;
  const label = "New chat";
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
    autoTitle: true,
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
    master.fill(0);
    await rm(root, { recursive: true, force: true });
  }
}
