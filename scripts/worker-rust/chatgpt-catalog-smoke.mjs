// Real Rust worker command, managed Codex WebSocket, and bundled keeper. The
// HTTP/WS server and Codex account replies are disposable loopback fixtures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  computeBlindLookupTag,
  decryptProtectedSecret,
  deriveLookupKey,
  encryptProtectedSecret,
  wrapComponentKeyForWorker,
} from "../../packages/crypto/dist/index.js";
import {
  agentThreadSyncSchema,
  chatGptModelInventorySchema,
  codexAuthStatusSchema,
  codexDeviceLoginSchema,
  providerAuthStatusObservationSchema,
  providerRateLimitResetConsumeResultSchema,
} from "../../packages/protocol/dist/index.js";
import { providerCredentialProtectedContentSchema } from "../../packages/protocol/dist/protected-secrets.js";
import {
  quotaSnapshotFromRateLimits,
  weeklyUsageFromRateLimits,
} from "../../cantrip_worker/src/codex/rate-limits.ts";
import { codexAccountHome } from "../../cantrip_worker/src/codex/account-home.ts";
import {
  captureLegacyProviderCredential,
  legacyProviderCredentialSubject,
} from "../../cantrip_worker/src/legacy-provider-credentials.ts";

import { codexRuntimeId } from "../../cantrip_worker/src/codex/app-server.ts";
import { ManagedRuntimeNamespaces } from "../../cantrip_worker/src/codex/managed-runtime-namespaces.ts";
import { observedCodexThreadStatus } from "../../cantrip_worker/src/codex/event-normalization.ts";

import { CodexRpcClient } from "../../cantrip_worker/src/codex/rpc-client.ts";
import { safeEndpointProviderError } from "../../cantrip_worker/src/codex/provider-errors.ts";

import { OsAgentPlacements } from "../../cantrip_worker/src/os-executor/agent-placements.ts";

const require = createRequire(
  new URL("../../cantrip_worker/package.json", import.meta.url),
);
const { WebSocketServer } = require("ws");
const { values } = parseArgs({
  options: {
    worker: { type: "string" },
    peer: { type: "string" },
    codex: { type: "string" },
  },
});
assert.ok(values.worker && values.peer && values.codex);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-chatgpt-catalog-"));
const workerId = "chatgpt-catalog-worker";
const token = "ctwk_" + "Y".repeat(43);
const providerId = "catalog-provider";
const ownerId = "fixture-owner";
const serverId = randomUUID();
const component = "provider-credential";
const keyRevision = 1;
const componentKey = new Uint8Array(32).fill(47);
const secret = "catalog-synthetic-portable-token";
const stamp = new Date().toISOString();
const portable = "portable-account",
  local = "local-account",
  foreign = "wrong-record",
  reset = "reset-account";
const home = (id) => "fixture-home-" + id;
const data = path.join(root, "profile");
const homeHash = (id) => createHash("sha256").update(home(id)).digest("hex");
const authSuccess = "auth-success",
  authPending = "auth-pending",
  authFailure = "auth-failure";
const authCases = {
  [homeHash(authSuccess)]: "success",
  [homeHash(authPending)]: "pending",
  [homeHash(authFailure)]: "failure",
};
const inventoryItem = {
  id: " native-model ",
  model: "model",
  displayName: " Native ",
  description: "synthetic",
  hidden: true,
  isDefault: false,
  inputModalities: [" text "],
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "low effort", dropped: 5 },
  ],
  defaultReasoningEffort: "low",
  modelSpecialty: null,
  supportsPersonality: false,
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
  ignored: "strip this field",
};
const second = { ...inventoryItem, id: "second", hidden: false };
const quota = {
  rateLimits: {
    limitId: " codex ",
    planType: "fixture",
    primary: {
      resetsAt: 2_000_000_000,
      usedPercent: 42,
      windowDurationMins: 10_080,
    },
    secondary: null,
  },
  rateLimitsByLimitId: {
    other: {
      limitId: "other",
      primary: { resetsAt: null, usedPercent: 30, windowDurationMins: 60 },
      secondary: null,
    },
  },
};
const pages = {
  firstPage: { data: [inventoryItem], nextCursor: "next-page" },
  secondPage: { data: [second] },
  quota,
};
const login = {
  type: "chatgptAuthTokens",
  accessToken: secret,
  chatgptAccountId: "upstream-account",
  chatgptPlanType: "fixture",
};
const selectedReset = { idempotencyKey: randomUUID(), creditId: "banked-1" };
const blockedReset = { idempotencyKey: randomUUID() };
const implicitReset = { idempotencyKey: randomUUID(), creditId: null };
const expiredReset = { idempotencyKey: randomUUID() };
const quotaRead = (result) => ({ method: "account/rateLimits/read", result });
const consume = (params, response) => ({
  method: "account/rateLimitResetCredit/consume",
  params,
  ...response,
});
const resetQuota = {
  ...quota,
  rateLimits: {
    ...quota.rateLimits,
    credits: { hasCredits: true, unlimited: false, balance: " 100 " },
  },
  rateLimitResetCredits: { availableCount: 1, credits: null },
};
const remainingQuota = {
  ...resetQuota,
  rateLimits: {
    ...resetQuota.rateLimits,
    primary: { ...resetQuota.rateLimits.primary, usedPercent: 0 },
  },
  rateLimitResetCredits: { availableCount: 0, credits: null },
};
const codexFixture = {
  catalog: {
    [homeHash(portable)]: { ...pages, probeRefresh: true, login },
    [homeHash(local)]: { ...pages, login: null, quotaError: true },
    [homeHash(reset)]: {
      login,
      quotaSteps: [
        quotaRead(resetQuota),
        quotaRead(resetQuota),
        consume(selectedReset, { result: { outcome: "reset" } }),
        quotaRead(remainingQuota),
        quotaRead({
          ...resetQuota,
          rateLimits: {
            ...resetQuota.rateLimits,
            credits: { ...resetQuota.rateLimits.credits, balance: "100.01" },
          },
        }),
        quotaRead(remainingQuota),
        consume(implicitReset, { result: { outcome: "noCredit" } }),
        { method: "account/rateLimits/read", error: "Quota unavailable" },
        quotaRead(remainingQuota),
        consume(expiredReset, { error: "HTTP 401: token_expired" }),
        quotaRead(remainingQuota),
      ],
    },
  },
};
const scope = { serverId, ownerId, workerId };
const endpointProvider = {
  id: "observation-provider",
  name: "Observation fixture",
  kind: "openai-compatible",
  baseUrl: "http://127.0.0.1:9/v1/responses",
  apiKey: null,
  accountId: null,
  credentialHomeKey: null,
};
const model = {
  id: "fixture-model",
  routeId: "fixture-route",
  name: "Fixture model",
  reasoningEffort: null,
};
const runtimeId = codexRuntimeId(
  model,
  endpointProvider,
  null,
  "standalone-chat",
  [],
);
const digest = (text) => createHash("sha256").update(text).digest("hex");
const standalone = digest(runtimeId);
const realProvider = { ...endpointProvider, id: "persisted-observation" };
const realHome = path.join(
  data,
  "codex-standalone-homes",
  digest(codexRuntimeId(model, realProvider, null, "standalone-chat", [])),
);
const namespaceChat = randomUUID();
const namespaceThread = randomUUID();
const operationId = randomUUID();
const namespace = new ManagedRuntimeNamespaces(data);
const namespaceHome = namespace.destination(
  scope,
  namespaceThread,
  operationId,
);
const selections = path.resolve(namespaceHome, "../../selections");
await mkdir(selections, { recursive: true });
const initialOperation = randomUUID();
const selection = {
  version: 1,
  scope,
  chatId: namespaceChat,
  threadId: namespaceThread,
  operationId: initialOperation,
  previousOperationId: null,
  provider: {
    id: endpointProvider.id,
    kind: endpointProvider.kind,
    accountId: null,
  },
};
for (const record of [
  selection,
  { ...selection, operationId, previousOperationId: initialOperation },
]) {
  await writeFile(
    path.join(selections, record.operationId + ".json"),
    JSON.stringify(record),
  );
}
assert.equal(namespace.current(scope, namespaceThread).home, namespaceHome);
const osChat = randomUUID();
new OsAgentPlacements(data).resolve(
  { ...scope, chatId: osChat },
  {
    kind: "cantrip-os",
    scope: {
      ownerId,
      workerId,
      instanceId: randomUUID(),
      guestInstanceId: randomUUID(),
      attachmentGeneration: randomUUID(),
      runtimeGeneration: randomUUID(),
      bindingId: randomUUID(),
      bindingGeneration: randomUUID(),
      projectId: "fixture-project",
      projectSourceId: randomUUID(),
      worktreeId: randomUUID(),
      workspaceId: randomUUID(),
      guestWorkspaceId: "fixture",
      uid: 20000,
      gid: 20000,
      homeGuestPath: "/home/fixture",
      guestPath: "/home/fixture/source",
      dependencyOverlays: [],
      mode: "linux-owned",
      linkedWorkerPath: null,
      sourceKind: "folder",
    },
    transport: { kind: "docker", container: "fixture" },
  },
);
const historyThread = (id, type, status = "completed") => ({
  id,
  status: { type },
  turns: [
    {
      id: "turn",
      status,
      items: [
        { type: "agentMessage", id: "assistant", text: "private native text" },
      ],
    },
  ],
});
const active = historyThread("active-thread", "active", "failed");
const failed = historyThread(namespaceThread, "idle", "failed");
const idle = historyThread("standalone-thread", "idle", "interrupted");
codexFixture.observation = {
  "codex-home": {
    threads: {
      [active.id]: { thread: active, metadataUnsupported: true },
      "wrong-thread": { thread: active },
      "missing-thread": { error: "Thread not found" },
    },
  },
  [operationId]: {
    threads: { [failed.id]: { thread: failed } },
    configuration: path.join(data, "codex-home", "config.toml"),
  },
  [standalone]: { threads: { [idle.id]: { thread: idle } } },
};
async function seedNativeThread() {
  await mkdir(realHome, { recursive: true });
  const child = spawn(
    path.resolve(values.codex),
    ["app-server", "--listen", "stdio://"],
    {
      cwd: root,
      env: { PATH: "/usr/bin:/bin", HOME: root, CODEX_HOME: realHome },
      stdio: "pipe",
    },
  );
  const closed = once(child, "close");
  const client = new CodexRpcClient(child, 10_000);
  const request = async (method, params) => {
    const reply = await client.request(method, params);
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  };
  try {
    await request("initialize", {
      clientInfo: { name: "cantrip_read_fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    const { thread } = await request("thread/start", {
      historyMode: "paginated",
      cwd: root,
      model: "gpt-5",
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    await request("thread/name/set", {
      threadId: thread.id,
      name: "Observe persisted thread",
    });
    return thread.id;
  } finally {
    const fail = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try {
      child.stdin.end();
      assert.deepEqual(await closed, [0, null]);
    } finally {
      clearTimeout(fail);
    }
  }
}
const aad = {
  ownerId,
  component,
  table: "model_provider_accounts",
  keyRevision,
  componentKey,
};
const subjectKey = deriveLookupKey({ ...aad, field: "subject" });
const accountCredential = async (accountId) => ({
  accountId,
  providerId,
  providerKind: "chatgpt",
  credentialRevision: 4,
  credential: {
    subjectBlindIndex: computeBlindLookupTag(
      subjectKey,
      "chatgpt:upstream-account",
    ),
    protectedCredential: await encryptProtectedSecret({
      ...aad,
      rowId: accountId,
      field: "protected_credential",
      content: {
        version: 1,
        kind: "chatgpt",
        accountId: "upstream-account",
        userId: null,
        accessToken: secret,
        refreshToken: null,
        idToken: null,
        email: null,
        expiresAt: null,
        planType: "fixture",
      },
      contentSchema: providerCredentialProtectedContentSchema,
    }),
  },
});
const credential = await accountCredential(portable);
const resetCredential = await accountCredential(reset);
subjectKey.fill(0);
const counts = new Map();
let httpFailure;
let portableSignedOut = false;
async function respond(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  assert.equal(request.headers.authorization, "Bearer " + token);
  function send(status, value) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  }
  if (url.pathname === "/api/internal/workers/encryption/bootstrap") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { principalId, publicKey } = JSON.parse(Buffer.concat(chunks));
    send(200, {
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
      grants: [
        {
          id: randomUUID(),
          ownerId,
          principalId,
          component,
          keyRevision,
          wrappedKey: await wrapComponentKeyForWorker({
            ownerId,
            workerId,
            component,
            keyRevision,
            componentKey,
            workerPublicKey: publicKey,
          }),
          state: "active",
          revision: 1,
          revokedAt: null,
          revokedReason: null,
          createdAt: stamp,
          updatedAt: stamp,
        },
      ],
    });
  } else if (url.pathname === "/api/internal/workers/heartbeat") {
    send(200, {});
  } else if (url.pathname.includes("/credential")) {
    assert.equal(request.method, "GET");
    assert.equal(url.searchParams.get("workerId"), workerId);
    const account = url.pathname.split("/").at(-2);
    assert.equal(
      url.pathname,
      `/api/internal/workers/providers/${providerId}/accounts/${account}/credential`,
    );
    counts.set(account, (counts.get(account) ?? 0) + 1);
    if (account === local || account === "empty-grok-auth")
      send(404, { code: "migration-needed" });
    else if (account === portable && portableSignedOut)
      send(409, { code: "reauth-required" });
    else send(200, account === reset ? resetCredential : credential);
  } else send(404, {});
}
const server = createServer((request, response) => {
  respond(request, response).catch((error) => {
    httpFailure ??= error;
    response.writeHead(500);
    response.end("{}");
  });
});
const sockets = new WebSocketServer({
  server,
  handleProtocols: () => "cantrip-worker-auth-ready-v1",
});
sockets.on("connection", (socket, request) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const connectionGeneration = url.searchParams.get("connectionGeneration");
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
const [connected, child] = [
  once(sockets, "connection"),
  spawn(path.resolve(values.worker), ["--shutdown-on-stdin-close"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin",
      HOME: root,
      NO_COLOR: "1",
      CANTRIP_WORKER_DATA_DIR: data,
      CANTRIP_WORKER_ID: workerId,
      CANTRIP_WORKER_CREDENTIAL: token,
      CANTRIP_SERVER_URL: `http://127.0.0.1:${server.address().port}`,
      CANTRIP_CODEX_BIN: path.resolve(values.peer),
      CANTRIP_TEST_CODEX: path.resolve(values.codex),
      CANTRIP_CATALOG_FIXTURE: "1",
      CANTRIP_TEST_REAL_OBSERVATION_HOME: realHome,
      CANTRIP_TEST_AUTH_FIXTURE: JSON.stringify(authCases),
      CANTRIP_CODEX_SESSION_FIXTURE: JSON.stringify(codexFixture),
    },
  }),
];
const ended = once(child, "close");
let output = "";
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    output = (output + chunk).slice(-64_000);
  });
const pending = new Map();
const observations = [];
const notifications = new EventEmitter();
function track(socket) {
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw);
    if (frame.kind === "response") pending.get(frame.requestId)?.(frame);
    if (
      frame.kind === "notification" &&
      frame.notification.type === "provider.auth.status.observed"
    ) {
      observations.push(
        providerAuthStatusObservationSchema.parse(frame.notification),
      );
      notifications.emit("observation");
    }
  });
}
async function within(work, timeoutMs = 25_000) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Catalog fixture timed out\n" + output)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      work,
      limit,
      ended.then(([code]) => {
        throw new Error(`Worker exited ${code}\n${output}`);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  let [socket] = await within(connected);
  track(socket);
  async function command(command) {
    const requestId = randomUUID();
    const result = new Promise((resolve) => pending.set(requestId, resolve));
    socket.send(
      JSON.stringify({
        kind: "request",
        requestId,
        command,
      }),
    );
    try {
      return await within(result);
    } finally {
      pending.delete(requestId);
    }
  }
  function chatGpt(type, accountId, credentialHomeKey, input = {}) {
    return command({
      type,
      provider: {
        id: providerId,
        kind: "chatgpt",
        name: "Fixture",
        baseUrl: "https://example.invalid",
        accountId,
        credentialHomeKey,
      },
      ...input,
    });
  }
  function catalog(accountId, credentialHomeKey = home(accountId)) {
    return chatGpt("model.chatgpt.catalog", accountId, credentialHomeKey);
  }
  function credentials(type, providerAccountId, providerKind, extra = {}) {
    return command({
      type: "provider.auth." + type,
      providerId,
      providerAccountId,
      providerKind,
      credentialHomeKey: home(providerAccountId),
      ...extra,
    });
  }
  function accountAuth(type, providerAccountId, extra = {}) {
    return command({
      type: "codex.auth." + type,
      providerId,
      providerAccountId,
      credentialHomeKey: home(providerAccountId),
      ...extra,
    });
  }
  async function expectObservation(observationId, state, after = 0, timeoutMs) {
    return within(
      (async () => {
        for (;;) {
          const result = observations.find(
            (observation) =>
              observation.observationId === observationId &&
              observation.sequence > after &&
              observation.status.state === state,
          );
          if (result) return result;
          await once(notifications, "observation");
        }
      })(),
      timeoutMs,
    );
  }
  const { apiKey: _apiKey, ...wireProvider } = endpointProvider;
  const sync = (threadId, options = {}) =>
    command({
      type: "chat.sync",
      chatId: "cold-observation",
      cwd: root,
      threadId,
      model,
      provider: wireProvider,
      ...options,
    });
  for (const [thread, options] of [
    [active, {}],
    [failed, { chatId: namespaceChat }],
    [idle, { executionProfile: "standalone-chat" }],
  ]) {
    const response = await sync(thread.id, options);
    assert.equal(response.ok, true, JSON.stringify(response.error));
    assert.deepEqual(agentThreadSyncSchema.parse(response.result), {
      threadId: thread.id,
      status: observedCodexThreadStatus(thread),
      statusSource: "native-thread",
      turns: [],
    });
    assert.equal(
      JSON.stringify(response.result).includes("private native text"),
      false,
    );
  }
  const wrongThread = await sync("wrong-thread");
  assert.equal(wrongThread.ok, false);
  assert.match(wrongThread.error.message, /different thread/);
  const missingThread = await sync("missing-thread");
  assert.equal(missingThread.ok, false);
  assert.equal(
    missingThread.error.message,
    safeEndpointProviderError("Thread not found"),
  );
  const otherRoute = await sync(namespaceThread, {
    chatId: namespaceChat,
    provider: { ...wireProvider, id: "changed" },
  });
  assert.equal(otherRoute.ok, false);
  assert.match(otherRoute.error.message, /managed runtime route changed/);
  const wrongChat = await sync(namespaceThread);
  assert.equal(wrongChat.ok, false);
  assert.match(wrongChat.error.message, /managed runtime route changed/);
  const osChatResult = await sync(active.id, { chatId: osChat });
  assert.equal(osChatResult.ok, false);
  assert.match(osChatResult.error.message, /OS-hosted conversation/);
  const realThread = await seedNativeThread();
  const persisted = await sync(realThread, {
    executionProfile: "standalone-chat",
    provider: { ...wireProvider, id: realProvider.id },
  });
  assert.equal(persisted.ok, true, JSON.stringify(persisted.error));
  assert.deepEqual(persisted.result, {
    threadId: realThread,
    status: "idle",
    statusSource: "native-thread",
    turns: [],
  });
  const [a, b] = await Promise.all([catalog(portable), catalog(portable)]);
  for (const response of [a, b]) {
    assert.equal(response.ok, true, JSON.stringify(response.error));
    const result = response.result;
    const expected = chatGptModelInventorySchema.parse({
      models: [inventoryItem, second],
      observedAt: result.observedAt,
      weeklyUsage: { resetsAt: 2_000_000_000, usedPercent: 42 },
      quotaSnapshot: expectedQuota(quota, result.quotaSnapshot),
    });
    assert.deepEqual(result, expected);
  }
  const fallback = await catalog(local);
  assert.equal(fallback.ok, true, JSON.stringify(fallback.error));
  assert.deepEqual(fallback.result.models, a.result.models);
  assert.equal(fallback.result.quotaSnapshot, null);
  assert.equal(fallback.result.weeklyUsage, null);
  const wrong = await catalog(foreign);
  assert.equal(wrong.ok, false);
  assert.match(wrong.error.message, /identity-conflict/);
  const wrongHome = await catalog(foreign, home(portable));
  assert.equal(wrongHome.ok, false);
  assert.match(wrongHome.error.message, /different account home/);
  assert.deepEqual(Object.fromEntries(counts), {
    [portable]: 2,
    [local]: 1,
    [foreign]: 1,
  });
  const readResetQuota = () =>
    chatGpt("provider.quota.read", reset, home(reset));
  const consumeReset = (params) =>
    chatGpt("provider.rate-limit-reset.consume", reset, home(reset), params);
  function expectedQuota(raw, actual) {
    return quotaSnapshotFromRateLimits(raw, {
      codexVersion: actual.codexVersion,
      workerVersion: actual.workerVersion,
      snapshotId: actual.snapshotId,
      now: () => Date.parse(actual.observedAt),
    });
  }
  const initialQuota = await readResetQuota();
  assert.equal(initialQuota.ok, true, JSON.stringify(initialQuota.error));
  assert.deepEqual(
    initialQuota.result,
    expectedQuota(resetQuota, initialQuota.result),
  );
  const redeemed = await consumeReset(selectedReset);
  assert.equal(redeemed.ok, true, JSON.stringify(redeemed.error));
  const receipt = providerRateLimitResetConsumeResultSchema.parse(
    redeemed.result,
  );
  assert.equal(receipt.outcome, "reset");
  assert.deepEqual(
    receipt.quotaSnapshot,
    expectedQuota(remainingQuota, receipt.quotaSnapshot),
  );
  const blocked = await consumeReset(blockedReset);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error.message, /more than 100 credits/);
  const noCredit = await consumeReset(implicitReset);
  assert.equal(noCredit.ok, true, JSON.stringify(noCredit.error));
  assert.deepEqual(noCredit.result, {
    outcome: "noCredit",
    quotaSnapshot: null,
  });
  const expiredRedemption = await consumeReset(expiredReset);
  assert.equal(expiredRedemption.ok, false);
  assert.equal(
    expiredRedemption.error.message,
    "ChatGPT authentication expired. Sign in again to reconnect this provider account.",
  );
  assert.equal(counts.get(reset), 2);
  const lastQuota = await readResetQuota();
  assert.equal(lastQuota.ok, true, JSON.stringify(lastQuota.error));
  assert.deepEqual(
    lastQuota.result,
    expectedQuota(remainingQuota, lastQuota.result),
  );
  const homes = await readdir(path.join(data, "codex-accounts"));
  for (const id of [portable, local])
    assert.ok(homes.includes(path.basename(codexAccountHome(data, home(id)))));

  const localHome = codexAccountHome(data, home(local));
  const localAuth = path.join(localHome, "auth.json");
  const grok = "grok-account";
  const grokHome = codexAccountHome(data, home(grok));
  const grokAuth = path.join(grokHome, "grok-auth.json");
  const jwt = (claims) =>
    "fixture." +
    Buffer.from(JSON.stringify(claims)).toString("base64") +
    ".signature";
  const chatgptTokens = JSON.stringify({
    tokens: {
      access_token: jwt({ exp: 2_000_000_000 }),
      id_token: jwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "worker-local-subject",
          user_id: "worker-local-user",
          chatgpt_plan_type: "fixture",
        },
        "https://api.openai.com/profile": { email: "local@example.invalid" },
      }),
      refresh_token: "synthetic-legacy-refresh",
    },
  });
  await mkdir(grokHome, { recursive: true });
  const missing = await credentials("legacy.capture", grok, "grok");
  assert.equal(missing.ok, true, JSON.stringify(missing.error));
  assert.deepEqual(missing.result, { status: "missing" });
  await writeFile(localAuth, chatgptTokens);
  await symlink(localAuth, grokAuth);
  const symlinkCapture = await credentials("legacy.capture", grok, "grok");
  assert.equal(symlinkCapture.ok, true, JSON.stringify(symlinkCapture.error));
  assert.deepEqual(symlinkCapture.result, { status: "malformed" });
  await unlink(grokAuth);
  await writeFile(
    grokAuth,
    JSON.stringify({
      accessToken: "synthetic-legacy-grok-access",
      userId: "local-grok",
      email: "",
      expiresAt: 2_000_000_000_000,
      version: 1,
    }),
  );
  const migrationLookup = deriveLookupKey({ ...aad, field: "subject" });
  for (const [account, kind, directory] of [
    [local, "chatgpt", localHome],
    [grok, "grok", grokHome],
  ]) {
    const node = await captureLegacyProviderCredential(directory, kind);
    assert.equal(node.status, "available");
    const result = await credentials("legacy.capture", account, kind);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.result.status, "available");
    assert.equal(result.result.portableAuth, true);
    const blind = computeBlindLookupTag(
      migrationLookup,
      legacyProviderCredentialSubject(node.credential),
    );
    assert.equal(result.result.credential.subjectBlindIndex, blind);
    assert.equal(
      result.result.metadata.expiresAt,
      new Date(node.credential.expiresAt).toISOString(),
    );
    const decrypted = await decryptProtectedSecret({
      ...aad,
      rowId: account,
      field: "protected_credential",
      encrypted: result.result.credential.protectedCredential,
      contentSchema: providerCredentialProtectedContentSchema,
    });
    assert.deepEqual(decrypted, node.credential);
  }
  migrationLookup.fill(0);

  const portableAuth = path.join(
    codexAccountHome(data, home(portable)),
    "auth.json",
  );
  await writeFile(portableAuth, chatgptTokens);
  const mismatch = await credentials("account.clear", foreign, "chatgpt", {
    credentialHomeKey: home(portable),
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error.message, /different account/);
  assert.equal(await readFile(portableAuth, "utf8"), chatgptTokens);
  portableSignedOut = true;
  const cleared = await credentials("account.clear", portable, "chatgpt");
  assert.equal(cleared.ok, true, JSON.stringify(cleared.error));
  assert.deepEqual(cleared.result, { accepted: true });
  await assert.rejects(readFile(portableAuth), { code: "ENOENT" });
  const afterClear = await catalog(portable);
  assert.equal(afterClear.ok, false);
  assert.match(afterClear.error.message, /reauth-required/);
  assert.equal(counts.get(portable), 3);
  assert.equal(await readFile(localAuth, "utf8"), chatgptTokens);
  assert.equal((await catalog(local)).ok, true);
  assert.equal(counts.get(local), 1);

  const captured = await credentials("legacy.capture", local, "chatgpt");
  const proof = {
    serverCredentialRevision: 7,
    expectedSubjectBlindIndex: captured.result.credential.subjectBlindIndex,
  };
  const rejected = await credentials("legacy.purge", local, "chatgpt", {
    ...proof,
    expectedSubjectBlindIndex: credential.credential.subjectBlindIndex,
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error.message, /identity changed before purge/);
  assert.equal(await readFile(localAuth, "utf8"), chatgptTokens);
  for (const purged of [true, false]) {
    const response = await credentials("legacy.purge", local, "chatgpt", proof);
    assert.equal(response.ok, true, JSON.stringify(response.error));
    assert.deepEqual(response.result, {
      purged,
      serverCredentialRevision: 7,
      subjectBlindIndex: proof.expectedSubjectBlindIndex,
    });
    await assert.rejects(readFile(localAuth), { code: "ENOENT" });
  }

  const signedOut = codexAuthStatusSchema.parse({
    authenticated: false,
    authMode: null,
    email: null,
    planType: null,
    weeklyUsage: null,
  });
  const grokSignedOut = await accountAuth("status", "empty-grok-auth", {
    providerKind: "grok",
  });
  assert.equal(grokSignedOut.ok, true, JSON.stringify(grokSignedOut.error));
  assert.deepEqual(grokSignedOut.result, signedOut);
  const grokLogout = await accountAuth("logout", "empty-grok-auth", {
    providerKind: "grok",
  });
  assert.equal(grokLogout.ok, true, JSON.stringify(grokLogout.error));
  assert.deepEqual(grokLogout.result, { accepted: true });
  const grokProvider = {
    id: providerId,
    kind: "grok",
    name: "Fixture",
    baseUrl: "https://example.invalid",
    accountId: "empty-grok-auth",
    credentialHomeKey: home("empty-grok-auth"),
  };
  const grokQuota = await command({
    type: "provider.quota.read",
    provider: grokProvider,
  });
  assert.equal(grokQuota.ok, true, JSON.stringify(grokQuota.error));
  assert.deepEqual(grokQuota.result.windows, []);
  const emptyGrokModels = await command({
    type: "model.grok.catalog",
    provider: grokProvider,
  });
  assert.equal(emptyGrokModels.ok, false);
  assert.match(emptyGrokModels.error.message, /Grok account is not signed in/);
  const actualLocalStatus = await accountAuth("status", "bundled-codex-auth");
  assert.equal(
    actualLocalStatus.ok,
    true,
    JSON.stringify(actualLocalStatus.error),
  );
  assert.deepEqual(actualLocalStatus.result, signedOut);
  const device = codexDeviceLoginSchema.parse({
    loginId: "device-fixture",
    verificationUrl: "https://example.invalid/verify",
    userCode: "FIXTURE-DEVICE-CODE",
  });
  const initial = await accountAuth("status", authSuccess, {
    providerId: home(authSuccess),
    credentialHomeKey: undefined,
  });
  assert.equal(initial.ok, true, JSON.stringify(initial.error));
  assert.deepEqual(initial.result, signedOut);

  const successId = randomUUID();
  const login = await accountAuth("login.start", authSuccess, {
    observationId: successId,
  });
  assert.equal(login.ok, true, JSON.stringify(login.error));
  assert.deepEqual(login.result, device);
  const initialObservation = await expectObservation(successId, "pending");
  assert.equal(
    (await accountAuth("status", authSuccess)).result.loginPending,
    true,
  );
  await writeFile(
    path.join(
      codexAccountHome(data, home(authSuccess)),
      "authorize-fixture-device",
    ),
    "",
  );
  const authenticated = await expectObservation(
    successId,
    "authenticated",
    0,
    2500,
  );
  assert.equal(initialObservation.sequence, 1);
  assert.equal(authenticated.sequence, 2);
  const weeklyUsage = weeklyUsageFromRateLimits({
    rateLimitsByLimitId: {
      codex: {
        primary: null,
        secondary: {
          usedPercent: 42,
          resetsAt: 2_000_000_000,
          windowDurationMins: 10_080,
        },
      },
    },
  });
  assert.deepEqual(authenticated.status, {
    state: "authenticated",
    authMode: "chatgpt",
    email: "device@example.invalid",
    planType: "plus",
    weeklyUsage,
    failureCode: null,
  });
  const status = await accountAuth("status", authSuccess);
  assert.deepEqual(
    status.result,
    codexAuthStatusSchema.parse({
      authenticated: true,
      authMode: "chatgpt",
      email: "device@example.invalid",
      planType: "plus",
      weeklyUsage,
    }),
  );

  const failedId = randomUUID();
  assert.equal(
    (await accountAuth("login.start", authFailure, { observationId: failedId }))
      .ok,
    true,
  );
  assert.equal(
    (await expectObservation(failedId, "expired")).status.failureCode,
    "authorization-expired",
  );
  const expired = await accountAuth("status", authFailure);
  assert.deepEqual(expired.result, {
    ...signedOut,
    loginError: "The ChatGPT sign-in code expired.",
  });

  const pendingId = randomUUID();
  assert.equal(
    (
      await accountAuth("login.start", authPending, {
        observationId: pendingId,
      })
    ).ok,
    true,
  );
  assert.equal(
    (await accountAuth("status", authPending)).result.loginPending,
    true,
  );
  assert.deepEqual((await accountAuth("logout", authPending)).result, {
    accepted: true,
  });
  assert.equal(
    (await expectObservation(pendingId, "cancelled")).status.failureCode,
    "authorization-cancelled",
  );
  assert.deepEqual(
    (await accountAuth("status", authPending)).result,
    signedOut,
  );

  const clearId = randomUUID();
  assert.equal(
    (await accountAuth("login.start", authPending, { observationId: clearId }))
      .ok,
    true,
  );
  const pendingFile = path.join(
    codexAccountHome(data, home(authPending)),
    "auth.json",
  );
  await writeFile(pendingFile, chatgptTokens);
  assert.deepEqual(
    (await credentials("account.clear", authPending, "chatgpt")).result,
    { accepted: true },
  );
  await assert.rejects(readFile(pendingFile), { code: "ENOENT" });
  await expectObservation(clearId, "cancelled");
  assert.deepEqual(
    (await accountAuth("status", authPending)).result,
    signedOut,
  );

  const reconnected = once(sockets, "connection");
  socket.terminate();
  [socket] = await within(reconnected);
  track(socket);
  const replay = await expectObservation(
    successId,
    "authenticated",
    authenticated.sequence,
  );
  assert.equal(replay.sequence, authenticated.sequence + 1);
  assert.equal(replay.expiresAt, authenticated.expiresAt);
  assert.deepEqual(replay.status, authenticated.status);
  for (const secret of [
    device.userCode,
    "fixture-authentication-private-error",
    "fixture-authentication-stderr-token",
  ]) {
    assert.equal(JSON.stringify(observations).includes(secret), false);
    assert.equal(output.includes(secret), false);
  }
  assert.equal(httpFailure, undefined);
  assert.equal(output.includes(secret), false);
  child.stdin.end();
  assert.deepEqual(
    await Promise.race([
      ended,
      new Promise((resolve) => setTimeout(resolve, 7_000).unref()),
    ]),
    [0, null],
    output,
  );
  console.log(
    JSON.stringify({
      status: "passed",
      nativeWorker: true,
      portableLogin: true,
      legacyHome: true,
      exactAccount: true,
      coalescedCredentialGet: true,
      nodeQuotaOracle: true,
      chatGptQuotaRead: true,
      bankedResetRedemption: true,
      bankedResetRequiresReauthentication: true,
      nodeCredentialOracle: true,
      identityCheckedPurge: true,
      scopedRuntimeAndLeaseRetirement: true,
      chatgptDeviceAuth: true,
      authObservationReplay: true,
      realKeeper: true,
      coldNativeObservation: true,
      nodeNamespaceAndStatusOracle: true,
      bundledPersistedThreadRead: true,
      providerCalls: 0,
    }),
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await ended;
  }
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.close();
  componentKey.fill(0);
  await rm(root, { recursive: true, force: true });
}
