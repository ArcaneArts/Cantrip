// Real Rust worker command, managed Codex WebSocket, and bundled keeper. The
// HTTP/WS server and Codex account replies are disposable loopback fixtures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  computeBlindLookupTag,
  deriveLookupKey,
  encryptProtectedSecret,
  wrapComponentKeyForWorker,
} from "../../packages/crypto/dist/index.js";
import { chatGptModelInventorySchema } from "../../packages/protocol/dist/index.js";
import { providerCredentialProtectedContentSchema } from "../../packages/protocol/dist/protected-secrets.js";
import { quotaSnapshotFromRateLimits } from "../../cantrip_worker/src/codex/rate-limits.ts";
import { codexAccountHome } from "../../cantrip_worker/src/codex/account-home.ts";

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
  foreign = "wrong-record";
const home = (id) => "fixture-home-" + id;
const data = path.join(root, "profile");
const homeHash = (id) => createHash("sha256").update(home(id)).digest("hex");
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
const codexFixture = {
  catalog: {
    [homeHash(portable)]: {
      ...pages,
      probeRefresh: true,
      login: {
        type: "chatgptAuthTokens",
        accessToken: secret,
        chatgptAccountId: "upstream-account",
        chatgptPlanType: "fixture",
      },
    },
    [homeHash(local)]: { ...pages, login: null, quotaError: true },
  },
};
const aad = {
  ownerId,
  component,
  table: "model_provider_accounts",
  keyRevision,
  componentKey,
};
const subjectKey = deriveLookupKey({ ...aad, field: "subject" });
const credential = {
  accountId: portable,
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
      rowId: portable,
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
};
subjectKey.fill(0);
const counts = new Map();
let httpFailure;
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
    if (account === local) send(404, { code: "migration-needed" });
    else send(200, credential);
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
async function within(work) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Catalog fixture timed out\n" + output)),
      25_000,
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
  const [socket] = await within(connected);
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw);
    if (frame.kind === "response") pending.get(frame.requestId)?.(frame);
  });
  async function catalog(accountId, credentialHomeKey = home(accountId)) {
    const requestId = randomUUID();
    const result = new Promise((resolve) => pending.set(requestId, resolve));
    socket.send(
      JSON.stringify({
        kind: "request",
        requestId,
        command: {
          type: "model.chatgpt.catalog",
          provider: {
            id: providerId,
            kind: "chatgpt",
            name: "Fixture",
            baseUrl: "https://example.invalid",
            accountId,
            credentialHomeKey,
          },
        },
      }),
    );
    try {
      return await within(result);
    } finally {
      pending.delete(requestId);
    }
  }
  const [a, b] = await Promise.all([catalog(portable), catalog(portable)]);
  for (const response of [a, b]) {
    assert.equal(response.ok, true, JSON.stringify(response.error));
    const result = response.result;
    const expected = chatGptModelInventorySchema.parse({
      models: [inventoryItem, second],
      observedAt: result.observedAt,
      weeklyUsage: { resetsAt: 2_000_000_000, usedPercent: 42 },
      quotaSnapshot: quotaSnapshotFromRateLimits(quota, {
        codexVersion: result.quotaSnapshot.codexVersion,
        workerVersion: result.quotaSnapshot.workerVersion,
        snapshotId: result.quotaSnapshot.snapshotId,
        now: () => Date.parse(result.quotaSnapshot.observedAt),
      }),
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
  const homes = await readdir(path.join(data, "codex-accounts"));
  for (const id of [portable, local])
    assert.ok(homes.includes(path.basename(codexAccountHome(data, home(id)))));
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
      realKeeper: true,
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
