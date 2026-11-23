// Focused differential traces; all endpoints, keys and profiles are owned and
// synthetic. The serving Rust binary never invokes this development oracle.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { WorkerEncryptionService } from "../../tests/reference-node-worker/src/worker-encryption.ts";
import {
  wrapComponentKeyForWorker,
  encodeBase64Url,
} from "../../packages/crypto/src/index.ts";

const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "--binary requires the built grant-fixture example");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-grant-compatibility-"));
const ownerId = "owner-grant",
  workerId = "worker-grant";
const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  otherServerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const timestamp = "2026-11-16T00:00:00.000Z";
const requests = [],
  waiters = [];
const server = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  const value = {
    method: request.method,
    url: request.url,
    authorization: request.headers.authorization,
    worker: request.headers["x-cantrip-worker-id"],
    body: JSON.parse(text),
    response,
  };
  const next = waiters.shift();
  if (next) next(value);
  else requests.push(value);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const serverUrl = `http://127.0.0.1:${server.address().port}`;
function nextRequest() {
  if (requests.length) return Promise.resolve(requests.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Expected actual bootstrap HTTP request")),
      5000,
    );
    waiters.push((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}
function answer(request, payload, status = 200) {
  request.response.writeHead(status, { "content-type": "application/json" });
  request.response.end(
    typeof payload === "string" ? payload : JSON.stringify(payload),
  );
}
function resultError(error) {
  return { ok: false, error: error.message, code: error.code ?? null };
}
async function observed(operation) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return resultError(error);
  }
}
function normalize(result) {
  if (Array.isArray(result)) return result.map(normalize);
  if (!result || typeof result !== "object") return result;
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => {
      if (key === "lastSyncedAt" && value !== null) {
        assert.ok(Number.isFinite(Date.parse(value)));
        return [key, "<timestamp>"];
      }
      return [key, normalize(value)];
    }),
  );
}
function native() {
  const child = spawn(path.resolve(values.binary), [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let text = "",
    stderr = "",
    sequence = 0;
  const replies = new Map();
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16000);
  });
  child.stdout.on("data", (chunk) => {
    text += chunk;
    let end;
    while ((end = text.indexOf("\n")) >= 0) {
      const line = text.slice(0, end);
      text = text.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = replies.get(message.id);
      assert.ok(resolve);
      replies.delete(message.id);
      resolve(
        message.result.ok
          ? message.result
          : { ...message.result, code: message.result.code ?? null },
      );
    }
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      for (const resolve of replies.values())
        resolve({
          ok: false,
          error: `Native oracle exited ${code}: ${stderr}`,
          code: null,
        });
      replies.clear();
      resolve(code);
    });
  });
  return {
    call(input) {
      const requestId = ++sequence;
      return new Promise((resolve) => {
        replies.set(requestId, resolve);
        child.stdin.write(JSON.stringify({ ...input, requestId }) + "\n");
      });
    },
    async stop() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        assert.equal(await completion, 0, stderr);
      } finally {
        clearTimeout(timer);
      }
    },
    async abort() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await completion.catch(() => {});
    },
  };
}
function nodeEngine(service) {
  const pending = new Map(),
    owned = new Set();
  return {
    async call(input) {
      return observed(async () => {
        switch (input.op) {
          case "accept":
            return service.acceptBootstrap(input.payload);
          case "status":
            return service.status();
          case "owner":
            return service.ownerId();
          case "server":
            return service.serverIdentity();
          case "key": {
            const result = service.componentKey(
              input.component,
              input.revision,
            );
            return {
              key: encodeBase64Url(result.key),
              keyRevision: result.keyRevision,
            };
          }
          case "lock":
            service.lock();
            return service.status();
          case "start": {
            const promise = observed(() =>
              service.refresh({
                credential: input.credential,
                requestedGrant: input.requested,
              }),
            );
            pending.set(input.id, promise);
            owned.add(promise);
            void promise.finally(() => owned.delete(promise));
            return null;
          }
          case "wait": {
            const result = await pending.get(input.id);
            pending.delete(input.id);
            if (!result.ok) {
              const error = new Error(result.error);
              error.code = result.code;
              throw error;
            }
            return result.value;
          }
          case "drop":
            pending.delete(input.id);
            return null;
          case "close":
            service.lock();
            await Promise.all(owned);
            return service.status();
          default:
            throw new Error("Unknown Node fixture operation");
        }
      });
    },
  };
}
let registration;
function principal(owner = ownerId, state = "approved") {
  return {
    id: registration.principalId,
    ownerId: owner,
    kind: "worker",
    workerId,
    label: "Grant compatibility",
    publicKey: registration.publicKey,
    state,
    revision: state === "pending" ? 1 : 2,
    approvedAt: state === "approved" ? timestamp : null,
    revokedAt: state === "revoked" ? timestamp : null,
    revokedReason: state === "revoked" ? "revoked" : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
async function grant(revision, owner = ownerId) {
  const wrappedKey = await wrapComponentKeyForWorker({
    ownerId: owner,
    workerId,
    component: "task-content",
    keyRevision: revision,
    componentKey: new Uint8Array(32).fill(revision),
    workerPublicKey: registration.publicKey,
  });
  return {
    id: `${String(revision).repeat(8)}-1111-4111-8111-111111111111`,
    ownerId: owner,
    principalId: registration.principalId,
    component: "task-content",
    keyRevision: revision,
    wrappedKey,
    state: "active",
    revision: 1,
    revokedAt: null,
    revokedReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
function bootstrap(grants = [], options = {}) {
  const owner = options.owner ?? ownerId;
  return {
    serverId: options.server ?? serverId,
    ownerId: owner,
    principal: principal(owner, options.state ?? "approved"),
    grants,
  };
}
let comparisons = 0,
  child;
const seed = path.join(root, "seed");
try {
  const seedService = await WorkerEncryptionService.open({
    dataDirectory: seed,
    serverUrl,
    workerId,
  });
  registration = seedService.registration();
  const seedBytes = await readFile(
    path.join(seed, "worker-encryption-key.json"),
    "utf8",
  );
  const [v1, v2, v3, newOwnerGrant] = await Promise.all([
    grant(1),
    grant(2),
    grant(3),
    grant(1, "replacement-owner"),
  ]);
  const ready = bootstrap([v2]);
  async function run(engine, scenario) {
    const trace = [];
    const call = async (input) => {
      const result = await engine.call(input);
      trace.push(normalize(result));
      return result;
    };
    const start = async (id, credential = "credential-a", requested) => {
      const result = await call({ op: "start", id, credential, requested });
      assert.equal(result.ok, true);
    };
    const wait = async (id) => call({ op: "wait", id });
    const request = async () => {
      const value = await nextRequest();
      assert.equal(value.method, "POST");
      assert.equal(value.url, "/api/internal/workers/encryption/bootstrap");
      assert.equal(value.worker, workerId);
      assert.deepEqual(value.body, registration);
      trace.push({
        http: {
          authorization: value.authorization,
          worker: value.worker,
          method: value.method,
          url: value.url,
          body: value.body,
        },
      });
      return value;
    };
    const snapshot = async () => {
      await call({ op: "status" });
      await call({ op: "server" });
      await call({ op: "owner" });
      await call({ op: "key", component: "task-content" });
    };
    if (scenario === "authorization") {
      await snapshot();
      await call({
        op: "accept",
        payload: bootstrap([], { state: "pending" }),
      });
      await snapshot();
      await call({ op: "accept", payload: bootstrap([v1, v2]) });
      await snapshot();
      await call({ op: "key", component: "task-content", revision: 1 });
      await call({ op: "accept", payload: bootstrap([v1]) });
      await snapshot();
      await call({ op: "accept", payload: ready });
      await start("temporary");
      answer(await request(), { error: "temporary" + "🦀".repeat(251) }, 503);
      await wait("temporary");
      await snapshot();
      await start("denied");
      answer(await request(), { error: "denied" }, 401);
      await wait("denied");
      await snapshot();
      await start("recovery");
      answer(await request(), ready);
      await wait("recovery");
      await start("network-failure");
      (await request()).response.destroy();
      await wait("network-failure");
      await snapshot();
      await start("bad-json");
      answer(await request(), "{");
      await wait("bad-json");
      await snapshot();
      await call({ op: "accept", payload: ready });
      await call({
        op: "accept",
        payload: bootstrap([], { owner: "other-account" }),
      });
      await snapshot();
      const unreadable = structuredClone(newOwnerGrant);
      unreadable.wrappedKey.envelope.ciphertext = encodeBase64Url(
        new Uint8Array(48),
      );
      await call({
        op: "accept",
        payload: bootstrap([unreadable], {
          server: otherServerId,
          owner: "replacement-owner",
        }),
      });
      await snapshot();
      await call({
        op: "accept",
        payload: bootstrap([newOwnerGrant], {
          server: otherServerId,
          owner: "replacement-owner",
        }),
      });
      await snapshot();
      await call({
        op: "accept",
        payload: bootstrap([], {
          server: otherServerId,
          owner: "replacement-owner",
          state: "revoked",
        }),
      });
      await snapshot();
    } else {
      await start("heartbeat");
      const old = await request();
      await start("duplicate");
      await start("explicit-a", "credential-a", {
        component: "task-content",
        keyRevision: 3,
      });
      await start("explicit-b", "credential-a", {
        component: "task-content",
        keyRevision: 3,
      });
      answer(old, bootstrap());
      await wait("heartbeat");
      await wait("duplicate");
      const fresh = await request();
      answer(fresh, bootstrap([v3]));
      await wait("explicit-a");
      await wait("explicit-b");
      await snapshot();
      await start("older", "credential-old");
      const older = await request();
      await start("newer", "credential-new");
      const newer = await request();
      answer(newer, bootstrap([v3]));
      await wait("newer");
      answer(older, bootstrap([], { state: "pending", server: otherServerId }));
      await wait("older");
      await snapshot();
      await start("old-error", "credential-old-error");
      const error = await request();
      await start("latest", "credential-latest");
      const latest = await request();
      answer(latest, bootstrap([v3]));
      await wait("latest");
      answer(error, { error: "stale rejection" }, 409);
      await wait("old-error");
      await snapshot();
      await start("locked", "credential-locked");
      const locked = await request();
      await call({ op: "lock" });
      answer(locked, bootstrap([v3]));
      await wait("locked");
      await snapshot();
      // A dropped targeted continuation still performs its fresh request.
      await start("drop-heartbeat", "credential-drop");
      const dropOld = await request();
      await start("drop-target", "credential-drop", {
        component: "task-content",
        keyRevision: 3,
      });
      await call({ op: "drop", id: "drop-target" });
      answer(dropOld, bootstrap());
      await wait("drop-heartbeat");
      const dropFresh = await request();
      answer(dropFresh, bootstrap([v3]));
      const deadline = Date.now() + 3000;
      for (;;) {
        const status = await engine.call({ op: "status" });
        if (
          status.ok &&
          status.value.state === "ready" &&
          status.value.grants.length === 1
        )
          break;
        assert.ok(
          Date.now() < deadline,
          "abandoned targeted refresh should complete",
        );
        await delay(10);
      }
      await snapshot();
    }
    await call({ op: "close" });
    return trace;
  }
  for (const scenario of ["authorization", "concurrency"]) {
    const nodeDirectory = path.join(root, scenario + "-node"),
      rustDirectory = path.join(root, scenario + "-rust");
    for (const directory of [nodeDirectory, rustDirectory]) {
      await mkdir(directory);
      await writeFile(
        path.join(directory, "worker-encryption-key.json"),
        seedBytes,
      );
    }
    const nodeService = await WorkerEncryptionService.open({
      dataDirectory: nodeDirectory,
      serverUrl,
      workerId,
    });
    const expected = await run(nodeEngine(nodeService), scenario);
    child = native();
    assert.equal(
      (
        await child.call({
          op: "open",
          directory: rustDirectory,
          serverUrl,
          workerId,
        })
      ).ok,
      true,
    );
    const actual = await run(child, scenario);
    assert.deepEqual(actual, expected, scenario + " behavior trace");
    comparisons += actual.length;
    assert.equal(
      await readFile(
        path.join(rustDirectory, "worker-encryption-key.json"),
        "utf8",
      ),
      await readFile(
        path.join(nodeDirectory, "worker-encryption-key.json"),
        "utf8",
      ),
      "durable binding/high-water bytes",
    );
    comparisons++;
    await child.stop();
    child = undefined;
    assert.equal(requests.length, 0, "no extra bootstrap requests");
  }
  console.log(
    JSON.stringify({
      suite: "native-worker-grant-compatibility",
      passed: true,
      comparisons,
      traces: 2,
      scopedGrantsAndRevisions: true,
      transientVsAuthoritativeErrors: true,
      coalescingAndTargetedRetry: true,
      staleGenerationFencing: true,
      droppedTargetedCaller: true,
      persistenceBytesIdentical: true,
    }),
  );
} finally {
  await child?.abort();
  for (const request of requests) request.response.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
