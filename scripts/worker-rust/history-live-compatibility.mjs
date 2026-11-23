// Actual Node/native observation, capture, identity and original-mode algorithms.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { NativeHistoryObservations } from "../../tests/reference-node-worker/src/codex/native-history-observation.ts";
import { NativeHistoryCapture } from "../../tests/reference-node-worker/src/native-history-capture.ts";
import { NativeHistorySourceJournal } from "../../tests/reference-node-worker/src/native-history-source-journal.ts";
import { parseCodexNativeHistory } from "../../tests/reference-node-worker/src/codex/native-history.ts";
import {
  createNativeHistoryOutputIdentityResolver,
  createManagedNativeOutputIdentityResolver,
} from "../../tests/reference-node-worker/src/native-history-output-identity.ts";
import { createNativeHistoryOutputModeResolver } from "../../tests/reference-node-worker/src/native-history-output-mode.ts";
import { nativeHistoryWireFixtures } from "../server-rust/native-history-wire-fixtures.mjs";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary);
const child = spawn(values.binary, [], {
  env: { ...process.env, PATH: "/usr/bin:/bin" },
  stdio: ["pipe", "pipe", "inherit"],
});
const finished = new Promise((resolve, reject) => {
  child.once("close", resolve);
  child.once("error", reject);
});
async function* lines(stream) {
  stream.setEncoding("utf8");
  let pending = "";
  for await (const chunk of stream) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      yield pending.slice(0, end);
      pending = pending.slice(end + 1);
    }
  }
  assert.equal(pending, "");
}
const output = lines(child.stdout);
const wire = (value) =>
  value === undefined ? null : JSON.parse(JSON.stringify(value));
async function native(input) {
  child.stdin.write(JSON.stringify(input) + "\n");
  const line = await output.next();
  assert.equal(line.done, false);
  return JSON.parse(line.value);
}
async function result(input) {
  const value = await native(input);
  assert.equal(value.ok, true, value.error);
  return value.value;
}
let comparisons = 0;
function same(actual, expected, label) {
  assert.deepEqual(actual, wire(expected), label);
  comparisons++;
  return actual;
}
async function compare(input, operation, label) {
  let expected;
  try {
    expected = { ok: true, value: wire(await operation()) };
  } catch (error) {
    expected = { ok: false, error: error.message };
  }
  same(await native(input), expected, label);
}
async function until(test, label) {
  for (let i = 0; i < 200; i++) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Timed out: " + label);
}
function normal(frame) {
  const value = wire(frame);
  if (value.kind === "snapshot") delete value.id;
  return value;
}
const originalNow = Date.now;
Date.now = () => 1000;
const root = await mkdtemp(path.join(tmpdir(), "cantrip-history-live-"));
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: () => ({ key: new Uint8Array(32).fill(31), keyRevision: 1 }),
};
const empty = (threadId) =>
  parseCodexNativeHistory(
    { thread: { id: threadId, status: { type: "idle" }, turns: [] } },
    threadId,
  );
const event = (id, extra = {}) => ({
  method: "item/completed",
  params: {
    threadId: "thread",
    turnId: "turn",
    item: { id, type: "agentMessage", text: "PRIVATE_CAPTURE_CONTENT" },
  },
  ...extra,
});
let serial = 0,
  current;
class Oracle {
  constructor(config) {
    this.config = structuredClone(config);
    this.trace = [];
    this.errors = [];
    this.waiters = [];
    this.hub = new NativeHistoryObservations();
    this.hub.replace("runtime-1");
  }
  configure(config) {
    Object.assign(this.config, structuredClone(config));
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  async begin(kind, input) {
    this.trace.push({ kind, input: structuredClone(input) });
    let failure;
    if (this.config[kind + "FailNext"] > 0) {
      this.config[kind + "FailNext"]--;
      failure = this.config[kind + "Error"] ?? `fixture ${kind} failed`;
    }
    while (this.config[kind + "Held"])
      await new Promise((resolve) => this.waiters.push(resolve));
    if (failure) throw new Error(failure);
  }
  async read(threadId) {
    const reply = this.config.snapshots?.length
      ? this.config.snapshots.shift()
      : this.config.snapshot;
    await this.begin("read", threadId);
    if (reply?.error) throw new Error(reply.error);
    return parseCodexNativeHistory(reply ?? empty(threadId), threadId);
  }
  async open(input) {
    await this.begin("open", input);
    return structuredClone(this.config.openResult ?? this.config.binding);
  }
  async resolve(input) {
    await this.begin("resolve", input);
    return structuredClone(
      this.config.resolveResult ??
        input.items.map((item) =>
          this.config.mappings.find((v) =>
            ["threadId", "turnId", "itemId", "identityKind", "component"].every(
              (key) => v.identity[key] === item.identity[key],
            ),
          ),
        ),
    );
  }
  async append(frame) {
    const lost = this.config.lostAckNext;
    this.config.lostAckNext = false;
    await this.begin("append", frame);
    const value = await this.journal.append(frame);
    if (lost) throw new Error("lost source persistence acknowledgment");
    return value;
  }
  async persisted(record) {
    await this.begin("notify", record);
  }
  count(kind) {
    return this.trace.filter((v) => v.kind === kind).length;
  }
}
async function init(config = {}, capture = false) {
  if (current?.capture) {
    current.capture.stop();
    await current.capture.whenStopped();
  }
  const oracle = new Oracle({
    retryDelayMs: 5,
    maxRetryDelayMs: 10,
    snapshotDelayMs: 0,
    ...config,
  });
  current = oracle;
  const directory = path.join(root, String(++serial));
  await result({
    op: "init",
    generation: "runtime-1",
    config: oracle.config,
    ...(capture ? { directory: path.join(directory, "native") } : {}),
  });
  if (capture) {
    oracle.journal = await NativeHistorySourceJournal.open({
      directory: path.join(directory, "node"),
      workerId: "worker",
      chatId: "chat",
      bindingId: "binding",
      threadId: "thread",
      service,
    });
    oracle.capture = new NativeHistoryCapture({
      runtime: {
        observeNativeHistory: (thread, observer) =>
          oracle.hub.subscribe(thread, observer, () => oracle.read(thread)),
      },
      threadId: "thread",
      journal: { append: (frame) => oracle.append(frame) },
      onPersisted: (record) => oracle.persisted(record),
      onError: (error, phase) => {
        oracle.errors.push({ phase, error: error.message });
        if (oracle.config.diagnosticsFail)
          throw new Error("diagnostic failure");
      },
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
      snapshotDelayMs: 0,
    });
    await result({ op: "capture.start" });
    await drain(oracle, "initial capture");
  }
  return oracle;
}
async function configure(oracle, config) {
  oracle.configure(config);
  await result({ op: "configure", config });
}
async function emit(oracle, entries) {
  for (const entry of entries)
    oracle.hub.notification(entry.method, entry.params, entry.cursor);
  await result({ op: "notifications", entries });
}
async function frames(oracle, label) {
  same(
    (await result({ op: "records" })).map(normal),
    (await oracle.journal.read(0, 512)).map((v) => normal(v.frame)),
    label,
  );
}
async function drain(oracle, label) {
  await Promise.all([oracle.capture.flush(), result({ op: "capture.flush" })]);
  await frames(oracle, label);
  same(
    (await result({ op: "state" })).pendingRecords,
    oracle.capture.pendingRecords,
    label + " pending",
  );
}
async function phase(oracle, name) {
  await until(
    async () =>
      oracle.errors.some((e) => e.phase === name) &&
      (await result({ op: "state" })).errors.some((e) => e.phase === name),
    name,
  );
}
try {
  let oracle = await init();
  const events = [];
  const sub = oracle.hub.subscribe(
    "thread",
    {
      capture: (value) => events.push(value),
      onError: (error, source) =>
        oracle.errors.push({ error: error.message, source }),
    },
    () => oracle.read("thread"),
  );
  await result({ op: "subscribe", threadId: "thread" });
  await emit(oracle, [
    {
      method: "thread/started",
      params: { thread: { id: "thread", forkedFromId: "original" } },
    },
    event("one"),
    {
      method: "unknown/future",
      params: { threadId: "thread", raw: "PRIVATE_CAPTURE_CONTENT" },
    },
    {
      method: "item/completed",
      params: { threadId: "other", item: { id: "foreign" } },
    },
    { method: "account/updated", params: { account: "foreign" } },
  ]);
  same(
    (await result({ op: "state" })).events.a,
    events,
    "exact unknown/late observations, per-thread filtering",
  );
  await configure(oracle, { readHeld: true });
  const read = sub.readSnapshot();
  await result({ op: "read.start" });
  await emit(oracle, [event("during-read")]);
  await configure(oracle, { readHeld: false });
  same(
    normal(await result({ op: "await", name: "read" })),
    normal(await read),
    "snapshot records both sides of concurrent observation",
  );
  await configure(oracle, { readHeld: true });
  const stale = sub.readSnapshot().then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error: error.message }),
  );
  await result({ op: "read.start" });
  oracle.hub.replace("runtime-2");
  await result({ op: "replace", generation: "runtime-2" });
  await configure(oracle, { readHeld: false });
  same(
    await native({ op: "await", name: "read" }),
    await stale,
    "transport retirement rejects in-flight snapshot",
  );
  await result({ op: "subscribe", threadId: "thread", name: "successor" });
  const successor = [];
  const next = oracle.hub.subscribe(
    "thread",
    { capture: (v) => successor.push(v), onError: () => {} },
    () => oracle.read("thread"),
  );
  await emit(oracle, [event("new-generation")]);
  same(
    (await result({ op: "state" })).events.successor,
    successor,
    "replacement generation restarts sequence",
  );
  next.close();
  await result({ op: "subscription.close", name: "successor" });

  oracle = await init({ captureFails: true, diagnosticsFail: true });
  oracle.hub.subscribe(
    "thread",
    {
      capture: () => {
        throw new Error("fixture observer failed");
      },
      onError: (error, source) => {
        oracle.errors.push({ phase: "observe", error: error.message, source });
        throw new Error("diagnostic failed");
      },
    },
    () => oracle.read("thread"),
  );
  await result({ op: "subscribe", threadId: "thread" });
  await emit(oracle, [event("first"), event("second")]);
  same(
    (await result({ op: "state" })).errors,
    oracle.errors,
    "consumer and diagnostic errors do not poison dispatch or leak params",
  );
  assert.ok(!JSON.stringify(oracle.errors).includes("PRIVATE_CAPTURE_CONTENT"));

  oracle = await init({}, true);
  await configure(oracle, { lostAckNext: true });
  await emit(oracle, [event("once")]);
  await drain(
    oracle,
    "uncertain successful append retries exact captured frame",
  );
  const attempts = (await result({ op: "state" })).trace.filter(
    (v) => v.kind === "append",
  );
  same(
    attempts[1].input,
    attempts[2].input,
    "lost acknowledgement retains frame identity",
  );
  await configure(oracle, { readFailNext: 1 });
  await emit(oracle, [
    {
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
    },
  ]);
  await drain(
    oracle,
    "idle final snapshot failure retries without another event",
  );
  same(
    (await result({ op: "state" })).trace.filter((v) => v.kind === "read")
      .length,
    oracle.count("read"),
    "snapshot retry count",
  );

  oracle = await init({}, true);
  const nativeDirectory = await result({ op: "directory" });
  const obstruction = "0000000000000002.source.json";
  await mkdir(path.join(nativeDirectory, obstruction));
  await mkdir(path.join(oracle.journal.directory, obstruction));
  await emit(oracle, [event("ordered-one"), event("ordered-two")]);
  await phase(oracle, "append");
  same(
    (await result({ op: "state" })).pendingRecords,
    2,
    "disk failure preserves ordered pending frames",
  );
  await rm(path.join(nativeDirectory, obstruction), { recursive: true });
  await rm(path.join(oracle.journal.directory, obstruction), {
    recursive: true,
  });
  await drain(oracle, "actual failed disk publication recovers autonomously");

  oracle = await init({}, true);
  await configure(oracle, { appendHeld: true });
  await emit(oracle, [event("held")]);
  await until(
    async () =>
      oracle.count("append") === 2 &&
      (await result({ op: "state" })).trace.filter((v) => v.kind === "append")
        .length === 2,
    "held append begins",
  );
  await emit(oracle, [
    {
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: { id: "turn", status: "interrupted" },
      },
    },
  ]);
  await until(
    async () =>
      oracle.count("read") === 2 &&
      (await result({ op: "state" })).trace.filter((v) => v.kind === "read")
        .length === 2,
    "reads independent of storage",
  );
  same(
    (await result({ op: "state" })).pendingRecords,
    oracle.capture.pendingRecords,
    "held storage does not serialize native reads",
  );
  await configure(oracle, { appendHeld: false });
  await drain(oracle, "independent reads/writes drain in source order");

  oracle = await init({}, true);
  await configure(oracle, { readHeld: true });
  oracle.capture.reconcile();
  await result({ op: "capture.reconcile" });
  await until(
    async () =>
      oracle.count("read") === 2 &&
      (await result({ op: "state" })).trace.filter((v) => v.kind === "read")
        .length === 2,
    "snapshot read held",
  );
  await emit(oracle, [event("during-request")]);
  const requested = oracle.capture.snapshot();
  await result({ op: "capture.snapshot.start" });
  await configure(oracle, { readHeld: false });
  const captured = await requested,
    actualCaptured = await result({ op: "await" });
  same(
    normal(actualCaptured.observation),
    normal(captured.observation),
    "explicit snapshot waits for fresh read and durable append",
  );
  same(
    actualCaptured.observation.readBarrierSequence,
    1,
    "fresh snapshot begins after original request",
  );
  await drain(oracle, "explicit fresh snapshot");

  oracle = await init({}, true);
  await configure(oracle, { appendHeld: true });
  await emit(oracle, [event("accepted-before-stop")]);
  await until(
    async () =>
      oracle.count("append") === 2 &&
      (await result({ op: "state" })).trace.filter((v) => v.kind === "append")
        .length === 2,
    "accepted append held",
  );
  oracle.capture.stop();
  await result({ op: "capture.stop" });
  let stopped = false;
  const stoppedWait = oracle.capture.whenStopped().then(() => {
    stopped = true;
  });
  await result({ op: "capture.stopped.start" });
  same(
    await result({ op: "pending" }),
    { ready: false },
    "forced stop waits for accepted storage before key release",
  );
  assert.equal(stopped, false);
  await configure(oracle, { appendHeld: false });
  await stoppedWait;
  await result({ op: "await" });
  await frames(oracle, "accepted write remains durable after stop");
  same(
    (await result({ op: "state" })).pendingRecords,
    oracle.capture.pendingRecords,
    "stop reports actual settled pending count",
  );

  oracle = await init({}, true);
  await configure(oracle, { notifyHeld: true });
  await emit(oracle, [event("wake-in-flight")]);
  await until(
    async () =>
      oracle.count("notify") === 2 &&
      (await result({ op: "state" })).trace.filter((v) => v.kind === "notify")
        .length === 2,
    "accepted wake callback held",
  );
  oracle.capture.stop();
  await result({ op: "capture.stop" });
  const notified = oracle.capture.whenStopped();
  await result({ op: "capture.stopped.start" });
  same(
    await result({ op: "pending" }),
    { ready: false },
    "forced stop also waits for an accepted wake callback",
  );
  await configure(oracle, { notifyHeld: false });
  await notified;
  await result({ op: "await" });
  await frames(oracle, "wake callback settles before keys can be released");
  oracle = await init({}, true);
  await configure(oracle, { readHeld: true });
  const detached = oracle.capture.snapshot().then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error: error.message }),
  );
  await result({ op: "capture.snapshot.start" });
  await until(
    async () =>
      oracle.count("read") === 2 &&
      (await result({ op: "state" })).trace.filter((v) => v.kind === "read")
        .length === 2,
    "read begins before forced stop",
  );
  oracle.capture.stop();
  await result({ op: "capture.stop" });
  await oracle.capture.whenStopped();
  await result({ op: "capture.stopped.start", name: "stopped" });
  same(
    await result({ op: "await", name: "stopped" }),
    null,
    "detached native read does not prevent storage teardown",
  );
  same(
    await native({ op: "await" }),
    await detached,
    "stopped snapshot request rejects without a fictitious durable receipt",
  );
  await configure(oracle, { readHeld: false });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await result({ op: "tick" });
  oracle = await init({}, true);
  await configure(oracle, { appendFailNext: 1000, diagnosticsFail: true });
  await emit(oracle, [event("unsaved")]);
  await phase(oracle, "append");
  const failedDrain = oracle.capture.flush().then(
    () => ({ ok: true, value: null }),
    (error) => ({ ok: false, error: error.message }),
  );
  await result({ op: "capture.flush.start" });
  oracle.capture.stop();
  await result({ op: "capture.stop" });
  same(
    await native({ op: "await" }),
    await failedDrain,
    "forced teardown rejects drain rather than acknowledging memory",
  );
  same(
    (await result({ op: "state" })).pendingRecords,
    1,
    "unsaved frames remain counted",
  );
  await frames(oracle, "forced teardown does not invent persisted frames");

  oracle = await init({}, true);
  await configure(oracle, {
    appendFailNext: 1,
    notifyFailNext: 1,
    diagnosticsFail: true,
  });
  await emit(oracle, [event("retained-on-close")]);
  const closed = oracle.capture.close();
  await result({ op: "capture.close.start" });
  await emit(oracle, [event("after-close")]);
  await closed;
  await result({ op: "await" });
  await frames(oracle, "graceful close retains storage and wake retries");

  oracle = await init({}, true);
  const cursor = (sequence, previousSequence) => ({
    epoch: "native",
    sequence,
    previousSequence,
  });
  const repaired = parseCodexNativeHistory(
    {
      thread: { id: "thread", status: { type: "active" }, turns: [] },
      history: {
        version: 1,
        currentTurnId: "turn",
        currentTurnState: "live",
        turns: [],
        live: {
          epoch: "native",
          throughSequence: "3",
          items: [
            {
              turnId: "turn",
              item: { id: "answer", type: "agentMessage", text: "AB" },
              state: "started",
              startedAtMs: null,
              completedAtMs: null,
              cursor: cursor("3", "2"),
            },
          ],
        },
      },
    },
    "thread",
  );
  await configure(oracle, {
    snapshots: [
      { error: "snapshot temporarily unavailable" },
      empty("thread"),
      empty("thread"),
      repaired,
    ],
  });
  await emit(oracle, [
    {
      method: "item/started",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: { id: "answer", type: "agentMessage", text: "" },
      },
      cursor: cursor("1", null),
    },
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "answer",
        delta: "B",
      },
      cursor: cursor("3", "2"),
    },
  ]);
  await drain(
    oracle,
    "missing predecessor repairs across failure and stale snapshots",
  );
  same(
    (await result({ op: "state" })).trace.filter((v) => v.kind === "read")
      .length,
    5,
    "per-item gap needs actual replacement evidence",
  );
  await emit(oracle, [
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "answer",
        delta: "C",
      },
      cursor: cursor("4", "3"),
    },
  ]);
  await drain(oracle, "contiguous successor does not trigger another snapshot");
  same(
    (await result({ op: "state" })).trace.filter((v) => v.kind === "read")
      .length,
    5,
    "contiguous cursor read count",
  );

  const binding = nativeHistoryWireFixtures("2026-11-18T00:00:00Z")
    .nativeHistoryBindingSchema[0];
  const identity = {
    threadId: binding.threadId,
    turnId: "turn",
    itemId: "answer",
    component: "assistant",
    identityKind: "canonical",
  };
  const mapping = {
    identity,
    key: "a".repeat(64),
    messageId: randomUUID(),
    idempotencyKey: "native-history:fixture",
    preservedInput: null,
  };
  const context = {
    cwd: process.platform === "win32" ? "C:\\original" : "/original",
    model: "native-model",
    collaborationMode: "plan",
    reasoningEffort: null,
    rootTurnId: null,
  };
  const snapshot = parseCodexNativeHistory(
    {
      thread: { id: binding.threadId, status: { type: "idle" }, turns: [] },
      history: {
        version: 1,
        currentTurnId: null,
        currentTurnState: "notLoaded",
        turns: [
          {
            turnId: "turn",
            source: "canonical",
            retention: "complete",
            contexts: [context],
            items: [],
            usage: null,
            warnings: null,
            errors: null,
          },
        ],
      },
    },
    binding.threadId,
  );
  const message = {
    kind: "message",
    message: {
      id: "answer",
      text: "answer",
      correlation: {
        sourceMethod: "item/completed",
        threadId: binding.threadId,
        turnId: "turn",
        itemId: "answer",
        diagnosticId: null,
      },
    },
  };
  async function identitySetup(extra = {}, managed = false) {
    const oracle = await init({
      binding,
      identity,
      mappings: [mapping],
      scope: {
        chatId: binding.chatId,
        threadId: binding.threadId,
        provenance: { kind: "current" },
      },
      snapshot,
      ...extra,
    });
    await result({ op: "identity.start", managed });
    const mode = createNativeHistoryOutputModeResolver(
      (thread) => oracle.read(thread),
      oracle.config.observeMode
        ? (thread, observer) =>
            oracle.hub.subscribe(thread, observer, () => oracle.read(thread))
        : undefined,
    );
    const client = {
      open: (input) => oracle.open(input),
      resolve: (input) => oracle.resolve(input),
    };
    oracle.resolver = managed
      ? createManagedNativeOutputIdentityResolver({
          client,
          scope: (threadId, agentScope) => {
            oracle.trace.push({
              kind: "scope",
              input: { threadId, agentScope: agentScope ?? null },
            });
            return oracle.config.scope;
          },
          mode,
        })
      : createNativeHistoryOutputIdentityResolver({
          binding: oracle.config.binding,
          client,
          identity: () => oracle.config.identity,
        });
    oracle.mode = mode;
    return oracle;
  }
  async function startOutput(oracle, name = "a", value = message) {
    const pending = oracle.resolver(value).then(
      (value) => ({ ok: true, value: wire(value) }),
      (error) => ({ ok: false, error: error.message }),
    );
    await result({ op: "identity.resolve.start", name, output: value });
    return { pending, name };
  }
  async function finishOutput(p, label) {
    same(await native({ op: "await", name: p.name }), await p.pending, label);
  }
  oracle = await identitySetup({ resolveHeld: true });
  const one = await startOutput(oracle, "one"),
    two = await startOutput(oracle, "two");
  same(
    (await result({ op: "state" })).trace.filter((v) => v.kind === "resolve")
      .length,
    1,
    "concurrent identity lookups share pending mapping",
  );
  await configure(oracle, { resolveHeld: false });
  await finishOutput(one, "first bound output identity");
  await finishOutput(two, "shared bound output identity");
  await configure(oracle, { resolveFailNext: 1 });
  await finishOutput(
    await startOutput(oracle),
    "successful mapping remains immutable for sealer lifetime",
  );
  oracle = await identitySetup({ resolveFailNext: 1 });
  await finishOutput(
    await startOutput(oracle),
    "failed identity lookup propagates",
  );
  await finishOutput(
    await startOutput(oracle),
    "failed identity lookup retries",
  );
  for (const override of [
    { resolveResult: [] },
    {
      resolveResult: [
        { ...mapping, identity: { ...identity, itemId: "foreign" } },
      ],
    },
    { identity: { ...identity, threadId: "foreign" } },
    { identity: null },
  ]) {
    oracle = await identitySetup(override);
    await finishOutput(
      await startOutput(oracle),
      "bound identity validates unique related mapping",
    );
  }
  oracle = await identitySetup({ openHeld: true }, true);
  const first = await startOutput(oracle, "first"),
    second = await startOutput(oracle, "second");
  await configure(oracle, { openHeld: false });
  await finishOutput(
    first,
    "managed output opens dispatched binding and original mode",
  );
  await finishOutput(
    second,
    "managed output shares binding/mapping/mode caches",
  );
  const counts = (await result({ op: "state" })).trace;
  for (const kind of ["open", "resolve", "read"])
    same(
      counts.filter((v) => v.kind === kind).length,
      oracle.count(kind),
      "managed " + kind + " count",
    );
  const synthetic = {
    kind: "message",
    message: { ...message.message, id: "summary" },
  };
  await finishOutput(
    await startOutput(oracle, "aux", synthetic),
    "synthetic output never claims canonical identity",
  );
  for (const override of [
    { scope: null },
    {
      scope: {
        chatId: binding.chatId,
        threadId: "other",
        provenance: { kind: "current" },
      },
    },
    { openResult: { ...binding, chatId: "other" } },
    { openFailNext: 1 },
  ]) {
    oracle = await identitySetup(override, true);
    await finishOutput(
      await startOutput(oracle),
      "managed dispatched binding scope/failure",
    );
  }
  oracle = await identitySetup(
    { snapshot: empty(binding.threadId), observeMode: true },
    true,
  );
  const delayed = await startOutput(oracle, "delayed");
  await until(
    async () =>
      oracle.count("read") === 1 &&
      (await result({ op: "state" })).trace.some((v) => v.kind === "read"),
    "mode waits for retained context",
  );
  same(
    await result({ op: "pending", name: "delayed" }),
    { ready: false },
    "missing mode defers publication without guessing",
  );
  await configure(oracle, { snapshot });
  await emit(oracle, [
    { method: "history/updated", params: { threadId: binding.threadId } },
  ]);
  await finishOutput(
    delayed,
    "actual history change wakes original output mode",
  );
  oracle = await identitySetup(
    { snapshot: empty(binding.threadId), observeMode: true },
    true,
  );
  const retired = await startOutput(oracle, "retired");
  await until(
    async () =>
      oracle.count("read") === 1 &&
      (await result({ op: "state" })).trace.some((v) => v.kind === "read"),
    "mode observation active",
  );
  oracle.hub.replace("runtime-2");
  await result({ op: "replace", generation: "runtime-2" });
  await finishOutput(retired, "retired mode lookup fails instead of hanging");
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      nativeObservationCaptureAndIdentity: true,
      actualEncryptedJournals: true,
      nativeChildWithoutNode: true,
    }),
  );
} finally {
  if (current?.capture) {
    current.capture.stop();
    await current.capture.whenStopped();
  }
  Date.now = originalNow;
  child.stdin.end();
  assert.equal(await finished, 0);
  await rm(root, { recursive: true, force: true });
}
