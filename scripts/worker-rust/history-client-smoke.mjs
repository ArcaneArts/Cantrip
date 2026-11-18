// Native HTTP client and native durable transactions against the real Rust server.
// Enrollment/control and source observations are controlled fixtures. Rendering,
// initial capture, preparation, encryption, transactions and recovery are native.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { heartbeat } from "../server-rust/security-fixtures.mjs";
import { literal } from "../server-rust/project-target-state.mjs";
import { repositoryFixture } from "../server-rust/repository-fixture.mjs";
import {
  settingsHttpFixture,
  settingsChat,
  settingsWorker,
} from "../server-rust/native-settings-http-fixture.mjs";
import { NativeHistoryClient } from "../../cantrip_worker/src/native-history-client.ts";
import { readNativeHistoryRecovery } from "../../cantrip_worker/src/native-history-recovery.ts";
import { createNativeHistoryProjector } from "../../cantrip_worker/src/native-history-projector.ts";
import { restoreNativeHistoryProjectorState } from "../../cantrip_worker/src/native-history-projector-bootstrap.ts";
import { parseCodexNativeHistory } from "../../cantrip_worker/src/codex/native-history.ts";
import { createManagedNativeOutputIdentityResolver } from "../../cantrip_worker/src/native-history-output-identity.ts";
import { createNativeHistoryOutputModeResolver } from "../../cantrip_worker/src/native-history-output-mode.ts";
import { verifyManagedHistory } from "./history-managed-smoke.mjs";
import { verifyHistoryCoordinator } from "./history-coordinator-smoke.mjs";
const { values } = parseArgs({
  options: {
    client: { type: "string" },
    live: { type: "string" },
    history: { type: "string" },
    server: { type: "string" },
    repository: { type: "string" },
    worker: { type: "string" },
  },
});
for (const key of [
  "client",
  "history",
  "server",
  "repository",
  "live",
  "worker",
])
  assert.ok(values[key], `Pass --${key}`);
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-native-history-client-"),
);
async function* lines(stream) {
  stream.setEncoding("utf8");
  let partial = "";
  for await (const chunk of stream) {
    partial += chunk;
    let end;
    while ((end = partial.indexOf("\n")) >= 0) {
      yield partial.slice(0, end);
      partial = partial.slice(end + 1);
    }
  }
  assert.equal(partial, "");
}
function driver(binary) {
  const child = spawn(binary, [], {
    env: { ...process.env, PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const output = lines(child.stdout);
  return {
    async call(input) {
      child.stdin.write(JSON.stringify(input) + "\n");
      const line = await output.next();
      assert.equal(line.done, false);
      return JSON.parse(line.value);
    },
    async stop() {
      child.stdin.end();
      assert.equal(await completion, 0);
    },
  };
}
let h, history, client, proxy, live;
let dropIngest = true,
  accepted;
let missingOpen,
  historyOpens = 0,
  historyArchives = 0;
const deliveries = [];
try {
  h = await settingsHttpFixture({
    kind: "rust",
    profile: "none",
    root,
    executable: values.server,
    repositoryExecutable: values.repository,
    databaseMode: "pglite",
    result: { observations: [], snapshotProofs: 0, defaultsProofs: 0 },
  });
  proxy = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (/\/native-history\/archive(?:-turns|-batches)?$/.test(req.url))
        historyArchives++;
      if (req.url.endsWith("/native-history/open")) {
        historyOpens++;
        if (missingOpen) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Controlled missing history destination",
              code: missingOpen,
            }),
          );
          return;
        }
      }
      const response = await fetch(h.fixture.server.origin + req.url, {
        method: req.method,
        headers: {
          authorization: req.headers.authorization,
          "content-type": "application/json",
        },
        body,
        redirect: "error",
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (req.url.endsWith("/ingest")) {
        deliveries.push({
          body,
          status: response.status,
          receipt: JSON.parse(bytes),
        });
        if (response.ok && dropIngest) {
          dropIngest = false;
          accepted = JSON.parse(bytes);
          req.socket.destroy();
          return;
        }
      }
      res.statusCode = response.status;
      res.setHeader("content-type", "application/json");
      res.end(bytes);
    } catch {
      res.statusCode = 502;
      res.end("{}");
    }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  client = driver(values.client);
  history = driver(values.history);
  async function invoke(action, input, extra = {}) {
    const result = await client.call({
      serverUrl: origin,
      workerId: settingsWorker,
      token: h.credential,
      action,
      input,
      ...extra,
    });
    assert.equal(result.ok, true, result.error);
    return result.value;
  }
  async function local(input) {
    const result = await history.call(input);
    assert.equal(result.ok, true, result.error);
    return result.value;
  }
  const binding = await invoke("open", {
    chatId: settingsChat,
    threadId: "thread",
    provenance: { kind: "current" },
  });
  const reference = new NativeHistoryClient({
    serverUrl: origin,
    workerId: settingsWorker,
    token: () => h.credential,
  });
  assert.deepEqual(
    await reference.open({
      chatId: settingsChat,
      threadId: "thread",
      provenance: { kind: "binding", bindingId: binding.id },
    }),
    binding,
  );
  const identity = {
    threadId: "thread",
    turnId: "native-http-turn",
    itemId: "native-http-item",
    component: "assistant",
    identityKind: "canonical",
  };
  const resolve = {
    chatId: settingsChat,
    bindingId: binding.id,
    items: [{ identity, association: { kind: "native" } }],
  };
  const [mapping] = await invoke("resolve", resolve);
  assert.deepEqual(await reference.resolve(resolve), [mapping]);
  const encryption = {
    ownerId: () => h.owner,
    serverIdentity: () => h.serverId,
    componentKey: (_scope, revision = 1) => ({
      key: new Uint8Array(32).fill(revision),
      keyRevision: revision,
    }),
  };
  const marker = "synthetic-native-history-client-private";
  const counts = {
    totalTokens: 8,
    inputTokens: 3,
    cachedInputTokens: 1,
    cacheWriteInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 2,
  };
  const snapshot = parseCodexNativeHistory(
    {
      thread: {
        id: "thread",
        status: { type: "idle" },
        parentThreadId: null,
        forkedFromId: null,
        turns: [
          {
            id: identity.turnId,
            status: "completed",
            items: [
              { id: identity.itemId, type: "agentMessage", text: marker },
            ],
            startedAt: 1,
            completedAt: 2,
          },
        ],
      },
      history: {
        version: 1,
        currentTurnId: null,
        currentTurnState: "notLoaded",
        turns: [
          {
            turnId: identity.turnId,
            source: "canonical",
            retention: "complete",
            contexts: [
              {
                cwd: root,
                model: "fixture-model",
                collaborationMode: "default",
                reasoningEffort: null,
                rootTurnId: null,
              },
            ],
            items: [
              {
                itemId: identity.itemId,
                state: "completed",
                startedAtMs: 1000,
                completedAtMs: 2000,
              },
            ],
            warnings: null,
            errors: null,
            cantripModelAttribution: {
              threadId: "thread",
              turnId: identity.turnId,
              isRoot: true,
              reasoningEffort: null,
              selection: { status: "unavailable" },
            },
            usage: {
              responses: [
                {
                  threadId: "thread",
                  responseId: "response",
                  sessionId: "session",
                  rootTurnId: identity.turnId,
                  usage: counts,
                },
              ],
              total: counts,
              conflictingResponseIds: [],
            },
          },
        ],
      },
    },
    "thread",
  );
  const scope = {
    workerId: settingsWorker,
    chatId: settingsChat,
    bindingId: binding.id,
  };
  const config = {
    workerId: settingsWorker,
    serverUrl: origin,
    token: h.credential,
    nativeProjector: {
      binding,
      context: { cwd: root, mode: "default" },
      prepare: true,
      nativeAdapters: { directory: path.join(root, "verified-adapters") },
    },
  };
  async function reopen() {
    await local({
      op: "identity",
      state: { owner: h.owner, server: h.serverId, revision: 1 },
    });
    await local({
      op: "open",
      handle: "http",
      directory: path.join(root, "source"),
      ...scope,
      threadId: "thread",
    });
    await local({
      op: "outbox.open",
      handle: "http",
      directory: path.join(root, "outbox"),
      ...scope,
    });
    return local({
      op: "projection.open",
      handle: "http",
      source: "http",
      outbox: "http",
      directory: path.join(root, "projection"),
      config,
      allowRebase: true,
      ...scope,
    });
  }
  const projection = await reopen();
  live = driver(values.live);
  async function captureCall(input) {
    const response = await live.call(input);
    assert.equal(response.ok, true, response.error);
    return response.value;
  }
  await captureCall({
    op: "init",
    generation: "fixture",
    directory: path.join(root, "source"),
    sourceScope: {
      ownerId: h.owner,
      serverId: h.serverId,
      ...scope,
      threadId: "thread",
    },
    keyByte: 1,
    config: { snapshot, snapshotDelayMs: 0 },
  });
  await captureCall({ op: "capture.start" });
  const captured = await captureCall({ op: "capture.flush" });
  assert.equal(captured.pendingRecords, 0);
  assert.equal(
    captured.trace.filter((entry) => entry.kind === "append").length,
    1,
  );
  await captureCall({ op: "capture.close.start" });
  await captureCall({ op: "await" });
  await live.stop();
  live = null;
  const first = await history.call({ op: "projection.drain", handle: "http" });
  assert.equal(first.ok, false);
  assert.equal(first.error, "fetch failed");
  assert.ok(
    accepted?.committed,
    "actual upstream canonical commit preceded lost reply",
  );
  assert.equal(
    (await local({ op: "projection.checkpoint", handle: "http" })).cursor
      .sequence,
    0,
  );
  const staged = await readFile(
    path.join(projection.directory, "0000000000000001.stage.json"),
    "utf8",
  );
  const pending = await local({ op: "outbox.pending", handle: "http" });
  assert.equal(pending.length, 1);
  const archive = { chatId: settingsChat, bindingId: binding.id };
  const committedBefore = await invoke("archiveBatches", archive);
  assert.equal(committedBefore.batches.length, 1);
  assert.deepEqual(committedBefore.batches[0].receipt, accepted);
  await history.stop();
  history = null;
  await client.stop();
  client = null;
  h.worker.close();
  await h.fixture.close();
  await h.fixture.start();
  history = driver(values.history);
  client = driver(values.client);
  config.projectError = "must not recompute a frozen canonical transaction";
  await reopen();
  await local({ op: "projection.drain", handle: "http" });
  const checkpoint = await local({
    op: "projection.checkpoint",
    handle: "http",
  });
  assert.equal(checkpoint.cursor.sequence, 1);
  const sourceRecords = await local({
    op: "read",
    handle: "http",
    after: 0,
    limit: 512,
  });
  const expectedProjection = await createNativeHistoryProjector({
    binding,
    service: encryption,
    client: reference,
    context: async () => ({ cwd: root, mode: "default" }),
    materialize: async () => ({ attachments: [] }),
    associate: async () => ({ kind: "native" }),
  })(sourceRecords, null);
  assert.deepEqual(checkpoint.state, expectedProjection.state);
  assert.deepEqual(await local({ op: "outbox.pending", handle: "http" }), []);
  assert.equal(
    await readFile(
      path.join(projection.directory, "0000000000000001.stage.json"),
      "utf8",
    ),
    staged,
  );
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].body, deliveries[1].body);
  assert.deepEqual(deliveries[1].receipt, accepted);
  for (const action of ["archive", "archiveTurns", "archiveBatches"])
    assert.deepEqual(
      await invoke(action, archive),
      await reference[action](archive),
    );
  const finalArchive = await invoke("archiveBatches", archive);
  assert.equal(finalArchive.batches.length, 1);
  assert.deepEqual(finalArchive.batches[0].receipt, accepted);
  const recovered = await local({
    op: "content.recovery",
    binding,
    serverUrl: origin,
    token: h.credential,
    pageSize: 1,
    batchPageSize: 1,
  });
  const expectedRecovery = await readNativeHistoryRecovery({
    binding,
    client: reference,
    service: encryption,
    pageSize: 1,
    batchPageSize: 1,
  });
  assert.deepEqual(recovered.snapshot, expectedRecovery);
  assert.deepEqual(
    await local({ op: "projector.restore", recovery: recovered.snapshot }),
    restoreNativeHistoryProjectorState(expectedRecovery),
  );
  assert.equal(recovered.snapshot.items[0].source.body.text, marker);
  assert.equal(recovered.snapshot.turns.length, 1);
  assert.equal(recovered.snapshot.batches.length, 1);
  assert.equal(JSON.stringify(deliveries).includes(marker), false);
  // A distinct committed stream advances the canonical item behind this local
  // checkpoint. The next native projection must receive an actual permanent
  // rejection, recover canonical floors over HTTP, replay retained source and
  // publish revision 3 from basis 2 without replaying execution/input.
  const concurrentWorker = "history-concurrent-worker",
    concurrentTree = randomUUID();
  const enrollmentCode = await h.visit(
    "history concurrent enrollment code",
    "POST",
    "/api/workers/enrollment-codes",
    { status: 201, json: { label: "History concurrent writer" } },
  );
  const enrollment = await h.visit(
    "history concurrent enrollment",
    "POST",
    "/api/internal/workers/enroll",
    {
      client: "worker",
      status: 201,
      json: {
        code: enrollmentCode.code,
        heartbeat: { ...heartbeat, workerId: concurrentWorker },
      },
    },
  );
  await h.fixture.close();
  const setupRepository = await repositoryFixture({
    kind: "rust",
    executable: values.repository,
    root: path.join(root, "none"),
    databaseMode: "pglite",
  });
  try {
    const seeded = await setupRepository.request({
      op: "transaction",
      statements: [
        `INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path) VALUES('history-concurrent-source',${literal(binding.projectId)},${literal(concurrentWorker)},'git','/worker-owned/concurrent','/worker-owned/concurrent')`,
        `INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,origin,lifecycle_state) VALUES(${literal(concurrentTree)},'history-concurrent-source',${literal(concurrentWorker)},'main','/worker-owned/concurrent','/worker-owned/concurrent',true,'cantrip','ready')`,
        `INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,codex_thread_id) VALUES('history-concurrent-runtime',${literal(settingsChat)},${literal(concurrentWorker)},${literal(concurrentTree)},'thread')`,
        `UPDATE chats SET active_worker_id=${literal(concurrentWorker)},active_worktree_id=${literal(concurrentTree)} WHERE id=${literal(settingsChat)}`,
      ],
    });
    assert.equal(seeded.rejected, false, seeded.diagnostic);
  } finally {
    await setupRepository.close();
  }
  await h.fixture.start();
  const concurrentBinding = await invoke(
    "open",
    {
      chatId: settingsChat,
      threadId: "thread",
      provenance: { kind: "current" },
    },
    { workerId: concurrentWorker, token: enrollment.credential },
  );
  const concurrentRecovered = await local({
    op: "content.recovery",
    binding: concurrentBinding,
    serverUrl: origin,
    token: enrollment.credential,
  });
  const concurrentState = await local({
    op: "projector.restore",
    recovery: concurrentRecovered.snapshot,
  });
  concurrentState.source.turns[0].items[0].body.text = marker + " concurrent";
  concurrentState.source.turns[0].items[0].revision++;
  const concurrent = await local({
    op: "projector.run",
    previous: concurrentState,
    records: [],
    config: {
      ...config.nativeProjector,
      nativeAdapters: null,
      binding: concurrentBinding,
      serverUrl: origin,
      token: enrollment.credential,
    },
  });
  assert.equal(concurrent.error, undefined);
  assert.equal(concurrent.batches.length, 1);
  assert.equal(concurrent.batches[0].items[0].revision, 2);
  assert.equal(concurrent.batches[0].items[0].expectedRevision, 1);
  const concurrentScope = {
    workerId: concurrentWorker,
    chatId: settingsChat,
    bindingId: concurrentBinding.id,
  };
  await local({
    op: "outbox.open",
    handle: "concurrent",
    directory: path.join(root, "concurrent-outbox"),
    ...concurrentScope,
  });
  const concurrentRecord = await local({
    op: "outbox.append",
    handle: "concurrent",
    recordId: randomUUID(),
    body: JSON.stringify(concurrent.batches[0]),
  });
  const concurrentBody = await local({
    op: "outbox.body",
    handle: "concurrent",
    record: concurrentRecord,
  });
  const concurrentReceipt = await invoke("deliver", null, {
    workerId: concurrentWorker,
    token: enrollment.credential,
    scope: concurrentScope,
    record: concurrentRecord,
    body: concurrentBody,
  });
  await local({
    op: "outbox.ack",
    handle: "concurrent",
    receipt: concurrentReceipt,
  });
  await local({
    op: "append",
    handle: "http",
    frame: {
      kind: "notification",
      generation: "fixture",
      threadId: "thread",
      sequence: 1,
      receivedAtMs: 2,
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: identity.turnId,
        item: {
          id: identity.itemId,
          type: "agentMessage",
          text: marker + " local",
        },
      },
    },
  });
  delete config.projectError;
  await local({ op: "projection.config", handle: "http", config });
  await local({ op: "projection.drain", handle: "http" });
  const rebasedCheckpoint = await local({
    op: "projection.checkpoint",
    handle: "http",
  });
  assert.equal(rebasedCheckpoint.cursor.sequence, 2);
  assert.equal(rebasedCheckpoint.state.items[0].revision, 3);
  assert.equal(rebasedCheckpoint.state.items[0].canonicalRevision, 3);
  assert.equal(
    (await local({ op: "projection.stats", handle: "http" })).rebaseCalls,
    1,
  );
  assert.deepEqual(await local({ op: "outbox.pending", handle: "http" }), []);
  assert.equal(
    deliveries.filter(
      (entry) =>
        entry.status === 409 &&
        entry.receipt.code === "item-revision-conflict" &&
        entry.receipt.rejection?.rejected === true,
    ).length,
    1,
  );
  const rebasedRecovery = await local({
    op: "content.recovery",
    binding,
    serverUrl: origin,
    token: h.credential,
    pageSize: 1,
    batchPageSize: 1,
  });
  assert.deepEqual(
    rebasedRecovery.snapshot,
    await readNativeHistoryRecovery({
      binding,
      client: reference,
      service: encryption,
      pageSize: 1,
      batchPageSize: 1,
    }),
  );
  assert.equal(rebasedRecovery.snapshot.items[0].revision, 3);
  assert.equal(
    rebasedRecovery.snapshot.items[0].source.body.text,
    marker + " local",
  );
  assert.equal(rebasedRecovery.snapshot.batches.length, 3);
  assert.equal(JSON.stringify(deliveries).includes(marker), false);
  const liveScope = {
    chatId: settingsChat,
    threadId: identity.threadId,
    provenance: { kind: "current" },
  };
  const liveOutput = {
    kind: "message",
    message: {
      id: identity.itemId,
      text: "controlled live output",
      correlation: {
        sourceMethod: "item/completed",
        threadId: identity.threadId,
        turnId: identity.turnId,
        itemId: identity.itemId,
        diagnosticId: null,
      },
    },
  };
  const liveResult = await client.call({
    serverUrl: origin,
    workerId: concurrentWorker,
    token: enrollment.credential,
    action: "liveOutput",
    input: { scope: liveScope, snapshot, output: liveOutput },
  });
  assert.equal(liveResult.ok, true, liveResult.error);
  const liveReference = createManagedNativeOutputIdentityResolver({
    client: new NativeHistoryClient({
      serverUrl: origin,
      workerId: concurrentWorker,
      token: () => enrollment.credential,
    }),
    scope: () => liveScope,
    mode: createNativeHistoryOutputModeResolver(async () => snapshot),
  });
  assert.deepEqual(
    liveResult.value.outputs,
    await Promise.all([liveReference(liveOutput), liveReference(liveOutput)]),
  );
  assert.equal(
    liveResult.value.requests,
    2,
    "one actual binding open and one actual identity resolution",
  );
  assert.equal(liveResult.value.outputs[0].mode, "default");
  const invalidLive = await client.call({
    serverUrl: origin,
    workerId: concurrentWorker,
    token: "not-enrolled",
    action: "liveOutput",
    input: { scope: liveScope, snapshot, output: liveOutput },
  });
  assert.equal(invalidLive.ok, false);
  assert.equal(
    invalidLive.status,
    401,
    "shared identity errors retain native HTTP classification",
  );
  const invalid = await client.call({
    serverUrl: origin,
    workerId: settingsWorker,
    token: "not-an-enrolled-worker",
    action: "archive",
    input: archive,
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, 401);
  const managedResult = await verifyManagedHistory({
    spawn: () => driver(values.live),
    root,
    serverUrl: origin,
    token: enrollment.credential,
    workerId: concurrentWorker,
    ownerId: h.owner,
    serverId: h.serverId,
    chatId: settingsChat,
    binding: concurrentBinding,
    snapshot,
    deliveries,
    fault: {
      dropNext: () => {
        dropIngest = true;
      },
      missing: (code) => {
        missingOpen = code;
      },
      opens: () => historyOpens,
      archives: () => historyArchives,
    },
  });
  const coordinatorResult = await verifyHistoryCoordinator({
    spawn: () => driver(values.live),
    root,
    serverUrl: origin,
    runtimeServerUrl: h.fixture.server.origin,
    token: enrollment.credential,
    workerId: concurrentWorker,
    ownerId: h.owner,
    serverId: h.serverId,
    chatId: settingsChat,
    binding: concurrentBinding,
    snapshot,
    workerBinary: values.worker,
    visit: h.visit,
  });
  assert.equal(h.fixture.server.diagnostics().includes(marker), false);
  console.log(
    JSON.stringify({
      status: "passed",
      actualRustServer: true,
      actualNativeClient: true,
      nativeProjectionAndOutbox: true,
      nativeContentPreparation: true,
      nativeCanonicalProjector: true,
      nativeArchiveBootstrap: true,
      nativeItemRendering: true,
      nativeVerifiedContextAdapters: true,
      nativeLiveOutputIdentityAndOriginalMode: true,
      nativeSourceCaptureIntoCanonicalPipeline: true,
      nativeCoherentArchiveRecovery: true,
      canonicalAckLostAndRecovered: true,
      nativeAndServerProcessRestart: true,
      exactFrozenRetry: true,
      archiveReaders: 3,
      canonicalBatchCountAfterLostAck: 1,
      canonicalBatchCount: 3,
      nativeCanonicalRebaseFromActualRejection: true,
      canonicalItemRevisionAfterRebase: 3,
      managed: managedResult,
      coordinator: coordinatorResult,
      scope:
        "controlled native snapshot RPC and enrollment/control; actual production Rust worker startup recovery; live Codex/provider capture integration pending",
      runtime: "macOS ARM64",
      rootRemovedOnExit: true,
    }),
  );
} finally {
  if (live) await live.stop();
  if (history) await history.stop();
  if (client) await client.stop();
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
  await h?.close();
  await rm(root, { recursive: true, force: true });
}
