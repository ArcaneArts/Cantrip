// Real Redis and production Node/Rust coordinators in separate processes.
// This is directory/envelope acceptance; coordinated bridges and SQL/product
// multi-instance acceptance are deliberately still tracked separately.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { rustEnvironment, repositoryRoot } from "./cargo.mjs";
import { workerLinkWireFixtures } from "./worker-link-wire-fixtures.mjs";
import { compareAndSetFaults } from "./redis-cas-fault.mjs";
import { offlineDirectory } from "./redis-offline-directory.mjs";

const { values } = parseArgs({
  options: {
    "redis-bin": { type: "string" },
    report: { type: "string" },
    pair: { type: "string", multiple: true },
  },
});
const { createClient } = createRequire(
  path.join(repositoryRoot, "cantrip_server/package.json"),
)("redis");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-redis-coordination-"));
const report = {
  suite: "real-redis-coordinator-compatibility",
  root,
  platform: process.platform,
  architecture: process.arch,
  completeReplacement: false,
  scope:
    "Redis directory, message envelopes, cache/expiry, authority CAS, listener ordering and reconnect. Not full coordinated bridge, App Live or product rolling deployment.",
  cases: [],
};
const save = async () => {
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
};
const environment = await rustEnvironment();
const executable = path.join(
  environment.CARGO_TARGET_DIR ??
    path.join(repositoryRoot, "cantrip_server_rs/target"),
  environment.CARGO_BUILD_TARGET,
  "debug/examples/redis-coordinator-fixture" +
    (process.platform === "win32" ? ".exe" : ""),
);
const build = spawn(
  "cargo",
  [
    "build",
    "--locked",
    "--manifest-path",
    "cantrip_server_rs/Cargo.toml",
    "--example",
    "redis-coordinator-fixture",
  ],
  { cwd: repositoryRoot, env: environment, stdio: "inherit" },
);
await new Promise((resolve, reject) => {
  build.once("error", reject);
  build.once("exit", (code) =>
    code === 0
      ? resolve()
      : reject(new Error(`Rust fixture build exited ${code}`)),
  );
});
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const url = `redis://127.0.0.1:${port}`;
let redisProcess, control;
const peers = [];
async function redisStart() {
  redisProcess = spawn(
    values["redis-bin"] ?? process.env.CANTRIP_TEST_REDIS_BIN ?? "redis-server",
    [
      "--bind",
      "127.0.0.1",
      "--port",
      String(port),
      "--save",
      "",
      "--appendonly",
      "no",
      "--dir",
      root,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const child = redisProcess;
  let output = "",
    failure;
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stderr.on("data", (b) => {
    output += b;
  });
  child.on("error", (e) => {
    failure = e;
  });
  child.once("close", () =>
    writeFile(path.join(root, `redis-${Date.now()}.log`), output),
  );
  const until = Date.now() + 15000;
  while (true) {
    if (failure) throw failure;
    if (child.exitCode !== null)
      throw new Error(`Private Redis exited ${child.exitCode}: ${output}`);
    const candidate = createClient({
      url,
      socket: { reconnectStrategy: false },
    });
    candidate.on("error", () => {});
    try {
      await candidate.connect();
      assert.equal(await candidate.ping(), "PONG");
      control = candidate;
      return;
    } catch {
      if (candidate.isOpen) candidate.destroy();
      if (Date.now() > until)
        throw new Error(`Private Redis did not answer PING: ${output}`);
      await delay(25);
    }
  }
}
async function redisStop() {
  if (control?.isOpen) control.destroy();
  control = null;
  if (redisProcess?.exitCode === null) {
    const child = redisProcess;
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
  }
  redisProcess = null;
}
function fixture(kind, name) {
  const child = spawn(
    kind === "node" ? process.execPath : executable,
    kind === "node"
      ? ["--import", "tsx", "scripts/server-rust/redis-coordinator-node.mjs"]
      : [],
    { cwd: repositoryRoot, env: process.env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let next = 0,
    stderr = "",
    stdout = "";
  const pending = new Map();
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  const fail = (e) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(e);
    }
    pending.clear();
  };
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.once("exit", (code, signal) =>
    fail(new Error(`${name} exited ${code}/${signal}: ${stderr}`)),
  );
  createInterface({ input: child.stdout }).on("line", (line) => {
    stdout += line + "\n";
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    const waiting = pending.get(r.id);
    if (!waiting) return;
    pending.delete(r.id);
    clearTimeout(waiting.timer);
    waiting.resolve(r);
  });
  const peer = {
    name,
    kind,
    child,
    events: [],
    async call(op, fields = {}) {
      const id = ++next;
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${name} ${op} RPC timed out; stderr: ${stderr}`));
        }, 20000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, op, ...fields }) + "\n");
      });
      if (Object.hasOwn(response, "error")) throw new Error(response.error);
      return response.result;
    },
    async drain() {
      this.events.push(...(await this.call("events")));
      return this.events;
    },
    stop() {
      this.stopping ??= (async () => {
        const terminal = () =>
          child.exitCode !== null || child.signalCode !== null;
        try {
          if (!terminal()) {
            await this.call("close");
            child.stdin.end();
          }
          const closed = new Promise((resolve) =>
            terminal() ? resolve() : child.once("close", resolve),
          );
          await Promise.race([
            closed,
            delay(5000, undefined, { ref: false }).then(() => {
              if (!terminal())
                throw new Error(`${name} did not exit after coordinator close`);
            }),
          ]);
        } finally {
          if (!terminal()) child.kill("SIGKILL");
          await writeFile(path.join(root, name + ".stderr.log"), stderr);
          await writeFile(path.join(root, name + ".stdout.jsonl"), stdout);
        }
      })();
      return this.stopping;
    },
  };
  peers.push(peer);
  return peer;
}
async function eventually(read, accept, description) {
  const until = Date.now() + 15000;
  let value;
  while (true) {
    value = await read();
    if (accept(value)) return value;
    if (Date.now() > until)
      throw new Error(
        `Timed out: ${description}; actual ${JSON.stringify(value).slice(-3000)}`,
      );
    await delay(15);
  }
}
const message = (kind, extra = {}) => ({
  kind,
  messageId: randomUUID(),
  sourceInstanceId: "raw-control",
  createdAt: Date.now(),
  expiresAt: Date.now() + 60000,
  ...extra,
});
const byKind = (peer, kind) =>
  eventually(
    () => peer.drain(),
    (events) =>
      events.some((e) => e.kind === "message" && e.value.kind === kind),
    `${peer.name} receives ${kind}`,
  );
async function exercise(kinds) {
  const prefix = `cantrip:relay:v1:test:${randomUUID()}`,
    channel = prefix + ":messages";
  const item = { pair: kinds.join("/"), steps: [] };
  report.cases.push(item);
  await save();
  const a = fixture(kinds[0], item.pair.replace("/", "-") + "-a"),
    b = fixture(kinds[1], item.pair.replace("/", "-") + "-b");
  const options = (instanceId) => ({
    url,
    instanceId,
    keyPrefix: prefix,
    presenceTtlMs: 5000,
    maximumInstances: 2,
  });
  const publish = (value) =>
    control.publish(
      channel,
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    );
  const step = (name) => item.steps.push(name);
  try {
    const hydrated = {
      workerId: "hydrated",
      connectionId: "from-before-start",
      ownerId: "other-owner",
      instanceId: "old-instance",
      expiresAt: Date.now() + 60000,
      unknown: { opaque: "keep\ud800" },
    };
    await control.set(`${prefix}:worker:hydrated`, JSON.stringify(hydrated), {
      PX: 60000,
    });
    await control.set(
      `${prefix}:worker:expired`,
      JSON.stringify({
        ...hydrated,
        workerId: "expired",
        expiresAt: Date.now() - 1,
      }),
      { PX: 60000 },
    );
    await control.set(`${prefix}:worker:malformed`, "{", { PX: 60000 });
    await a.call("init", { options: options("instance-a") });
    await b.call("init", { options: options("instance-b") });
    for (const peer of [a, b]) {
      assert.deepEqual(
        await peer.call("cachedWorker", { workerId: "hydrated" }),
        hydrated,
      );
      assert.equal(
        await peer.call("cachedWorker", { workerId: "expired" }),
        null,
      );
      assert.equal((await peer.call("stats")).cachedWorkers, 1);
    }
    step(
      "startup hydrates valid live presences and ignores malformed/expired keys",
    );
    await a.call("start");
    assert.equal(await a.call("health"), true);
    assert.equal(await b.call("health"), true);
    assert.equal((await a.call("stats")).instanceCount, 2);
    step("subscription startup, idempotent start and real instance health");
    const opaque = {
      kind: "custom-forward-compatible-kind",
      payloadBase64: "opaque\ud800🦀",
      unknown: { nil: null, n: 9007199254740992 },
      targetInstanceId: "instance-b",
    };
    await a.call("publish", { payload: opaque, ttl: 12345.5 });
    await byKind(b, opaque.kind);
    const got = b.events.find(
      (e) => e.kind === "message" && e.value.kind === opaque.kind,
    ).value;
    for (const [key, value] of Object.entries(opaque))
      assert.deepEqual(got[key], value);
    assert.equal(got.expiresAt - got.createdAt, 12345.5);
    assert.equal(got.sourceInstanceId, "instance-a");
    assert.match(got.messageId, /^[a-f0-9-]{36}$/);
    assert.equal((await a.call("stats")).receivedMessages, 0);
    step(
      "opaque UTF-16, number, unknown fields, fractional TTL, directed envelopes and self suppression",
    );
    for (const ttl of [0, -1, 86400001, null, "1"]) {
      await assert.rejects(
        a.call("publish", { payload: { kind: "invalid-ttl" }, ttl }),
        /Coordination message TTL is outside the supported range\./,
      );
    }
    assert.equal((await a.call("stats")).sentMessages, 1);
    const workerId = "worker /:🦀!'()*~",
      first = {
        workerId,
        connectionId: "old",
        ownerId: "owner",
        continuityIdentity: {
          ownerId: "owner",
          credentialId: "credential",
          workerProcessGeneration: "process",
        },
        unknown: "retained",
      };
    assert.equal(await a.call("claimWorker", { input: first }), null);
    await eventually(
      () => b.call("cachedWorker", { workerId }),
      (p) => p?.connectionId === "old",
      "remote worker presence",
    );
    const raw = JSON.parse(
      await control.get(`${prefix}:worker:${encodeURIComponent(workerId)}`),
    );
    assert.equal(raw.unknown, "retained");
    const previous = await b.call("claimWorker", {
      input: { ...first, connectionId: "new" },
    });
    assert.equal(previous.connectionId, "old");
    await eventually(
      () => a.call("cachedWorker", { workerId }),
      (p) => p?.connectionId === "new",
      "replacement worker presence",
    );
    assert.equal(
      await a.call("refreshWorker", { workerId, connectionId: "old" }),
      false,
    );
    assert.equal(
      await a.call("releaseWorker", { workerId, connectionId: "old" }),
      false,
    );
    assert.equal(
      await b.call("refreshWorker", { workerId, connectionId: "new" }),
      true,
    );
    await publish(
      message("worker-presence", { action: "offline", presence: raw }),
    );
    await publish(message("old-offline-barrier"));
    await byKind(a, "old-offline-barrier");
    assert.equal(
      (await a.call("cachedWorker", { workerId })).connectionId,
      "new",
    );
    assert.equal(
      await b.call("releaseWorker", { workerId, connectionId: "new" }),
      true,
    );
    await eventually(
      () => a.call("cachedWorker", { workerId }),
      (p) => p === null,
      "released worker removed",
    );
    step(
      "encoded Redis keys, continuity metadata, claim replacement and stale-owner fencing",
    );
    await assert.rejects(
      a.call("findWorker", { workerId: "\ud800" }),
      /URI malformed/,
    );
    const before = await b.call("stats");
    await publish("{");
    await publish("null");
    await publish(message("expired", { expiresAt: Date.now() - 1 }));
    await publish(message("bad-id", { messageId: "" }));
    await publish(
      message("worker-presence", {
        action: "online",
        presence: { ...raw, continuityIdentity: null },
      }),
    );
    await publish(message("wrong-target", { targetInstanceId: "elsewhere" }));
    await publish(message("from-self", { sourceInstanceId: "instance-b" }));
    await publish(message("validation-barrier"));
    await byKind(b, "validation-barrier");
    const after = await b.call("stats");
    assert.equal(after.rejectedMessages - before.rejectedMessages, 4);
    assert.equal(after.receivedMessages - before.receivedMessages, 1);
    const [utf8Prefix, utf8Suffix] = JSON.stringify(
      message("invalid-utf8", { extra: "UTF8_MARKER" }),
    ).split("UTF8_MARKER");
    const bytes = Buffer.concat([
      Buffer.from(utf8Prefix),
      Buffer.from([0xff]),
      Buffer.from(utf8Suffix),
    ]);
    await publish(bytes);
    await byKind(b, "invalid-utf8");
    assert.equal(
      b.events.find(
        (e) => e.kind === "message" && e.value.kind === "invalid-utf8",
      ).value.extra,
      "�",
    );
    step(
      "malformed JSON, expiry, invalid presence, target filters and UTF-8 replacement counters",
    );
    const unicodeBefore = await b.call("stats");
    const unicodeKind = "🦀".repeat(50);
    await publish(
      message(unicodeKind, {
        messageId: "🦀".repeat(100),
        sourceInstanceId: "🦀".repeat(256),
      }),
    );
    await publish(message("🦀".repeat(51)));
    await publish(
      message("bad-message-id-units", { messageId: "🦀".repeat(101) }),
    );
    await publish(
      message("bad-source-id-units", { sourceInstanceId: "🦀".repeat(257) }),
    );
    const repeated = message("repeated-message-id");
    await publish(repeated);
    await publish(repeated);
    await publish(message("unicode-barrier"));
    await byKind(b, "unicode-barrier");
    assert.ok(
      b.events.some(
        (e) => e.kind === "message" && e.value.kind === unicodeKind,
      ),
    );
    assert.equal(
      b.events.filter(
        (e) => e.kind === "message" && e.value.kind === "repeated-message-id",
      ).length,
      2,
    );
    const unicodeAfter = await b.call("stats");
    assert.equal(
      unicodeAfter.rejectedMessages - unicodeBefore.rejectedMessages,
      3,
    );
    assert.equal(
      unicodeAfter.receivedMessages - unicodeBefore.receivedMessages,
      4,
    );
    step(
      "UTF-16 length boundaries and Source coordinator's repeated-ID delivery",
    );
    await b.call("blockingListener");
    await publish(message("await-next"));
    await eventually(
      () => b.drain(),
      (e) => e.some((v) => v.kind === "blocked"),
      "first listener awaits",
    );
    await publish(message("unblock"));
    await eventually(
      () => b.drain(),
      (e) => e.some((v) => v.kind === "resumed"),
      "later message unblocks listener",
    );
    assert.ok(
      b.events.findIndex((e) => e.kind === "unblock") <
        b.events.findIndex((e) => e.kind === "resumed"),
    );
    await b.call("failingListener");
    const rejected = (await b.call("stats")).rejectedMessages;
    await publish(message("listener-error"));
    await eventually(
      () => b.drain(),
      (e) => e.some((v) => v.kind === "after-error"),
      "listener failure isolated",
    );
    assert.equal((await b.call("stats")).rejectedMessages, rejected + 1);
    await b.call("mutatingListeners");
    b.events = [];
    await b.call("events");
    await publish(message("mutate-listeners"));
    await eventually(
      () => b.drain(),
      (e) => e.some((v) => v.kind === "late"),
      "live listener insertion",
    );
    assert.equal(
      b.events.some((v) => v.kind === "removed"),
      false,
    );
    step(
      "concurrent receive, callback rejection and live listener insertion/removal ordering",
    );
    const session = structuredClone(
        workerLinkWireFixtures.workerLinkSessionSchema[0],
      ),
      at = Date.now();
    Object.assign(session.lease, {
      issuedAt: new Date(at - 1000).toISOString(),
      expiresAt: new Date(at + 30000).toISOString(),
      absoluteExpiresAt: new Date(at + 60000).toISOString(),
    });
    const claim = {
      authorityInstanceId: "instance-a",
      expiresAt: at + 30000,
      session,
      unknown: "keep",
    };
    assert.equal(await a.call("claimSession", { claim }), null);
    assert.deepEqual(
      await b.call("claimSession", {
        claim: { ...claim, authorityInstanceId: "instance-b" },
      }),
      claim,
    );
    assert.equal(
      await b.call("refreshSession", {
        claim: { ...claim, authorityInstanceId: "instance-b" },
      }),
      false,
    );
    assert.equal(
      await b.call("releaseSession", {
        sessionId: session.sessionId,
        authorityInstanceId: "instance-b",
      }),
      false,
    );
    assert.equal(await a.call("refreshSession", { claim }), true);
    assert.equal(
      await a.call("releaseSession", {
        sessionId: session.sessionId,
        authorityInstanceId: "instance-a",
      }),
      true,
    );
    assert.equal(
      await b.call("findSession", { sessionId: session.sessionId }),
      null,
    );
    for (const invalid of [
      { ...claim, expiresAt: claim.expiresAt + 1 },
      { ...claim, authorityInstanceId: "" },
      { ...claim, session: {} },
    ]) {
      await assert.rejects(
        a.call("claimSession", { claim: invalid }),
        /WorkerLink session claim is invalid\./,
      );
      assert.equal(await a.call("refreshSession", { claim: invalid }), false);
    }
    const race = await Promise.all([
      a.call("claimSession", { claim }),
      b.call("claimSession", {
        claim: { ...claim, authorityInstanceId: "instance-b" },
      }),
    ]);
    assert.equal(race.filter((v) => v === null).length, 1);
    const winner = await a.call("findSession", {
      sessionId: session.sessionId,
    });
    assert.deepEqual(
      await b.call("findSession", { sessionId: session.sessionId }),
      winner,
    );
    step(
      "validated WorkerLink lease claims, atomic NX election, renewal and authority-only release",
    );
    const maximum = Math.ceil(((16 * 1024 * 1024 + 16) * 4) / 3) + 64 * 1024;
    let large = message("large-envelope", { payloadBase64: "" });
    large.payloadBase64 = "x".repeat(
      maximum - Buffer.byteLength(JSON.stringify(large)),
    );
    assert.equal(Buffer.byteLength(JSON.stringify(large)), maximum);
    await publish(large);
    await byKind(b, "large-envelope");
    assert.deepEqual(
      b.events.find(
        (e) => e.kind === "message" && e.value.kind === "large-envelope",
      ).value.payloadBase64,
      {
        bytes: large.payloadBase64.length,
        sha256: createHash("sha256").update(large.payloadBase64).digest("hex"),
      },
    );
    const beforeSize = await b.call("stats");
    large.kind = "large-envelope";
    large.payloadBase64 += "x";
    await publish(large);
    await publish(message("size-barrier"));
    await byKind(b, "size-barrier");
    const afterSize = await b.call("stats");
    assert.equal(afterSize.receivedMessages - beforeSize.receivedMessages, 1);
    assert.equal(afterSize.rejectedMessages, beforeSize.rejectedMessages);
    await assert.rejects(
      a.call("publish", {
        payload: { kind: "oversized", payloadBase64: "x".repeat(maximum) },
      }),
      /Coordination message exceeds the relay size limit\./,
    );
    step(
      "exact full encrypted-control envelope boundary and oversized ingress/egress rejection",
    );
    const third = fixture(kinds[0], item.pair.replace("/", "-") + "-c");
    await third.call("init", { options: options("instance-c") });
    assert.equal(await a.call("health"), false);
    assert.equal((await a.call("stats")).instanceCount, 3);
    await third.stop();
    assert.equal(await a.call("health"), true);
    step("actual excess-instance health and shutdown key removal");
    const expiring = {
      ...raw,
      workerId: "expiry",
      connectionId: "expires",
      expiresAt: Date.now() + 200,
    };
    await control.set(`${prefix}:worker:expiry`, JSON.stringify(expiring), {
      PX: 5000,
    });
    assert.equal(
      (await b.call("findWorker", { workerId: "expiry" })).connectionId,
      "expires",
    );
    await delay(250);
    assert.equal(await b.call("findWorker", { workerId: "expiry" }), null);
    step("embedded presence expiry despite a still-live Redis key");
    item.compareAndSetFaults = await compareAndSetFaults({
      port,
      control,
      fixture,
      kind: kinds[0],
      name: item.pair.replace("/", "-") + "-cas",
      options: options("cas-authority"),
      sessionTemplate: workerLinkWireFixtures.workerLinkSessionSchema[0],
    });
    step(
      "real EVAL races preserve intervening worker and WorkerLink renewal/release writes",
    );
    await redisStop();
    await delay(100);
    assert.equal(await a.call("health"), false);
    const offlineSent = (await a.call("stats")).sentMessages;
    await assert.rejects(
      a.call("publish", { payload: { kind: "offline" } }),
      /Redis coordination is unavailable\./,
    );
    assert.equal((await a.call("stats")).sentMessages, offlineSent + 1);
    await offlineDirectory([a, b], redisStart, item);
    await eventually(
      async () => {
        try {
          return (await a.call("health")) && (await b.call("health"));
        } catch {
          return false;
        }
      },
      (v) => v === true,
      "command reconnect",
    );
    await eventually(
      async () => {
        await publish(message("after-redis-restart"));
        await a.drain();
        await b.drain();
        return [a.events, b.events];
      },
      (e) =>
        e.every((events) =>
          events.some(
            (v) =>
              v.kind === "message" && v.value.kind === "after-redis-restart",
          ),
        ),
      "both subscribers acknowledge a fresh message after reconnect",
    );
    await b.call("publish", { payload: { kind: "restart-peer-b" } });
    await byKind(a, "restart-peer-b");
    await a.call("publish", { payload: { kind: "restart-peer-a" } });
    await byKind(b, "restart-peer-a");
    step(
      "Redis interruption, unavailable publish, command reconnect and subscriber resubscription",
    );
    item.passed = true;
  } catch (error) {
    item.failure = error.stack;
    throw error;
  } finally {
    if (!redisProcess) await redisStart();
    const stopped = await Promise.allSettled([a.stop(), b.stop()]);
    item.shutdown = stopped.map((v, index) => ({
      peer: index === 0 ? a.name : b.name,
      passed: v.status === "fulfilled",
      error: v.status === "rejected" ? v.reason.stack : undefined,
    }));
    const failure = stopped.find((v) => v.status === "rejected");
    if (failure) {
      item.passed = false;
      item.cleanupFailure = failure.reason.stack;
    }
    await save();
    if (failure && !item.failure) throw failure.reason;
  }
}
try {
  await redisStart();
  for (const pair of values.pair ?? [
    "node/node",
    "node/rust",
    "rust/node",
    "rust/rust",
  ]) {
    const kinds = pair.split("/");
    assert.ok(
      kinds.length === 2 && kinds.every((k) => ["node", "rust"].includes(k)),
    );
    await exercise(kinds);
  }
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  if (!redisProcess && peers.some((p) => p.child.exitCode === null))
    await redisStart();
  for (const peer of peers) {
    if (peer.child.exitCode === null)
      await peer.stop().catch((e) => {
        report.cleanupFailure = e.stack;
        process.exitCode = 1;
      });
  }
  await redisStop();
  await save();
}
console.log(
  JSON.stringify({
    suite: report.suite,
    root,
    cases: report.cases.map(({ pair, steps, passed, failure }) => ({
      pair,
      steps: steps.length,
      passed,
      failure,
    })),
    passed: report.passed,
    failure: report.failure,
  }),
);
