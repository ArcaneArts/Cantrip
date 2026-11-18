import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Reference, settle } from "./admission-reference.mjs";
const { values } = parseArgs({
  options: { binary: { type: "string" }, codex: { type: "string" } },
});
assert.ok(values.binary);
assert.ok(values.codex);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-admission-manager-"));
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
  let partial = "";
  for await (const chunk of stream) {
    partial += chunk;
    let at;
    while ((at = partial.indexOf("\n")) >= 0) {
      yield partial.slice(0, at);
      partial = partial.slice(at + 1);
    }
  }
  assert.equal(partial, "");
}
const output = lines(child.stdout),
  reference = new Reference(),
  generations = new Map(),
  reverse = new Map();
let comparisons = 0,
  serial = 0,
  current;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function generation(node, rust) {
  assert.match(node, uuid);
  assert.match(rust, uuid);
  assert.ok(!generations.has(node) || generations.get(node) === rust);
  assert.ok(!reverse.has(rust) || reverse.get(rust) === node);
  generations.set(node, rust);
  reverse.set(rust, node);
}
function discover(node, rust) {
  if (!node || !rust || typeof node !== "object" || typeof rust !== "object")
    return;
  if (
    typeof node.runtimeGeneration === "string" &&
    typeof rust.runtimeGeneration === "string"
  )
    generation(node.runtimeGeneration, rust.runtimeGeneration);
  for (const key of Object.keys(node)) discover(node[key], rust[key]);
}
function normalize(value) {
  if (typeof value === "string") return generations.get(value) ?? value;
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  if (typeof value.key === "string" && value.identity?.runtimeGeneration) {
    const expected = createHash("sha256")
      .update(
        JSON.stringify([
          value.workerGeneration,
          value.identity.runtimeGeneration,
          value.identity.operationId,
        ]),
      )
      .digest("hex");
    assert.equal(
      value.key,
      expected,
      "actual retained key must match its complete identity",
    );
  }
  const result = Object.fromEntries(
    Object.entries(value).map(([key, value]) => [key, normalize(value)]),
  );
  if (typeof value.key === "string" && value.identity?.runtimeGeneration)
    result.key = createHash("sha256")
      .update(
        JSON.stringify([
          result.workerGeneration,
          result.identity.runtimeGeneration,
          result.identity.operationId,
        ]),
      )
      .digest("hex");
  return result;
}
async function native(input) {
  child.stdin.write(JSON.stringify(input) + "\n");
  const line = await output.next();
  assert.equal(line.done, false);
  return JSON.parse(line.value);
}
function same(rust, node, label) {
  assert.deepEqual(rust, node, label);
  comparisons++;
}
async function pair(input) {
  const node = await settle(reference.call(input)),
    rust = await native(input);
  if (input.op === "runtime" && node.ok && rust.ok)
    generation(node.value, rust.value);
  discover(node, rust);
  if (
    input.op === "prepare" &&
    node.ok &&
    rust.ok &&
    Object.keys(node.value).length
  ) {
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          current.scope.serverId,
          current.scope.ownerId,
          current.scope.workerId,
        ]),
      )
      .digest("hex");
    assert.equal(
      node.value.CANTRIP_INFERENCE_SCOPE,
      path.join(current.nodeData, "inference-ownership", key),
    );
    assert.equal(
      rust.value.CANTRIP_INFERENCE_SCOPE,
      path.join(current.rustData, "inference-ownership", key),
    );
    node.value.CANTRIP_INFERENCE_SCOPE = rust.value.CANTRIP_INFERENCE_SCOPE;
  }
  // Notification coalescing and completion scheduling may expose different
  // revisions at a live read. Both revisions must independently be monotonic;
  // compare the full pool/operation state and all timing fields.
  if (input.op === "snapshot" && node.ok && rust.ok) {
    assert.ok(node.value.revision >= current.nodeRevision);
    assert.ok(rust.value.revision >= current.rustRevision);
    current.nodeRevision = node.value.revision;
    current.rustRevision = rust.value.revision;
    node.value.revision = rust.value.revision;
  }
  same(rust, normalize(node), input.op);
  return rust;
}
async function value(input) {
  const result = await pair(input);
  assert.equal(result.ok, true, result.error);
  return result.value;
}
async function open({ storage = false, scope, data, recover = false } = {}) {
  const directory = path.join(root, String(++serial));
  await mkdir(directory);
  const nodeData = data?.node ?? path.join(directory, "node"),
    rustData = data?.rust ?? path.join(directory, "rust");
  await mkdir(nodeData, { recursive: true });
  await mkdir(rustData, { recursive: true });
  scope ??= {
    serverId: randomUUID(),
    ownerId: randomUUID(),
    workerId: randomUUID(),
    workerGeneration: randomUUID(),
  };
  current = { scope, nodeData, rustData, nodeRevision: 0, rustRevision: 0 };
  const input = {
    op: "new",
    scope,
    ...(storage ? { binary: values.codex } : {}),
    recover,
  };
  same(
    await native({ ...input, data: rustData }),
    await settle(reference.call({ ...input, data: nodeData })),
    "new manager",
  );
  return current;
}
async function lifetime(name, operation, runtime = "r") {
  await value({ op: "lifetime", name, operation, runtime });
}
async function request(
  name,
  input = {},
  runtime = "r",
  provider = "p",
  life = name,
) {
  await value({
    op: "request",
    name,
    lifetime: life,
    runtime,
    provider,
    input,
  });
}
async function ready(ticket) {
  await value({ op: "ready", ticket });
}
async function waiting(ticket) {
  assert.equal((await value({ op: "status", ticket })).state, "waiting");
}
try {
  await open();
  for (const input of [
    { providerId: "p" },
    { providerId: "p", maxConcurrentInference: 2, inferenceConfigRevision: 1 },
    { providerId: "p" },
    { providerId: "p", maxConcurrentInference: 1, inferenceConfigRevision: 0 },
    { providerId: "p", maxConcurrentInference: 1, inferenceConfigRevision: 1 },
    { providerId: "bad", maxConcurrentInference: 0 },
  ])
    await pair({ op: "configure", input });
  await value({
    op: "configure",
    input: {
      providerId: "p",
      maxConcurrentInference: 1,
      inferenceConfigRevision: 2,
      inferenceCatalogCreatedRevision: 0,
    },
  });
  await value({ op: "runtime", name: "r" });
  await value({ op: "runtime", name: "other" });
  await lifetime("a", "a");
  await request("a");
  await ready("a");
  await value({ op: "start", ticket: "a" });
  await value({ op: "advance", ms: 7 });
  await lifetime("b", "b", "other");
  await request("b", {}, "other");
  await waiting("b");
  await value({ op: "cancel", ticket: "a" });
  await waiting("b");
  await value({ op: "snapshot" });
  await value({ op: "settle", ticket: "a", outcome: "interrupted" });
  await ready("b");
  await value({ op: "start", ticket: "b" });
  await value({ op: "suspend", ticket: "b" });
  await value({ op: "advance", ms: 4 });
  await value({ op: "resume", ticket: "b" });
  await value({ op: "snapshot" });
  await value({ op: "settle", ticket: "b", outcome: "completed" });
  await value({ op: "lifetime.close", name: "b" });
  await request("b-redelivery", {}, "other", "p", "b");
  assert.equal(
    (await value({ op: "status", ticket: "b-redelivery" })).state,
    "released",
  );
  assert.equal(
    (
      await pair({
        op: "request",
        name: "changed",
        lifetime: "b",
        runtime: "other",
        provider: "p",
        input: { chatId: null },
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await pair({
        op: "request",
        name: "foreign",
        lifetime: "b",
        runtime: "r",
        provider: "p",
        input: {},
      })
    ).ok,
    false,
  );
  await value({
    op: "catalog",
    input: { catalogRevision: 1, configurations: [] },
  });
  assert.equal(
    await value({ op: "configure", input: { providerId: "p" } }),
    false,
  );
  await value({
    op: "configure",
    input: {
      providerId: "p",
      maxConcurrentInference: 1,
      inferenceConfigRevision: 0,
      inferenceCatalogCreatedRevision: 2,
    },
  });
  await value({ op: "snapshot" });
  await value({ op: "close" });
  console.log(
    "Provider revisions, canonical lifetimes, shared FIFO and lifecycle passed.",
  );

  const initial = await open({ storage: true });
  await value({
    op: "configure",
    input: { providerId: "p", maxConcurrentInference: 1 },
  });
  await value({ op: "runtime", name: "r" });
  await value({ op: "prepare", runtime: "r" });
  await value({ op: "hold", action: "grant", held: true });
  await lifetime("a", "a");
  await request("a");
  await value({ op: "ready", ticket: "a", start: true, name: "a-ready" });
  await value({ op: "barrier", action: "grant" });
  assert.equal((await value({ op: "poll", name: "a-ready" })).pending, true);
  await lifetime("b", "b");
  await request("b");
  await value({ op: "queued", ticket: "b" });
  await waiting("b");
  await value({ op: "snapshot" });
  assert.equal(
    await value({ op: "pause", ticket: "a", unforwarded: true }),
    true,
  );
  await value({
    op: "confirm-pause",
    ticket: "a",
    start: true,
    name: "pause-receipt",
  });
  await value({ op: "hold", action: "grant", held: false });
  await value({ op: "await", name: "pause-receipt" });
  await ready("b");
  assert.equal((await value({ op: "poll", name: "a-ready" })).pending, true);
  await value({ op: "start", ticket: "b" });
  await value({ op: "advance", ms: 10 });
  await value({ op: "unpark", ticket: "a" });
  await waiting("a");
  await value({ op: "settle", ticket: "b", outcome: "completed" });
  await value({ op: "await", name: "a-ready" });
  const unused = await value({ op: "unused", ticket: "a" });
  assert.equal(unused.record.state, "granted");
  await value({
    op: "withdraw",
    ticket: "a",
    queueRevision: unused.queueRevision,
  });
  assert.equal((await pair({ op: "start", ticket: "a" })).ok, false);
  await lifetime("holder", "holder");
  await request("holder");
  await ready("holder");
  await value({ op: "start", ticket: "holder" });
  const old = randomUUID(),
    message = randomUUID(),
    command = randomUUID(),
    chat = randomUUID();
  await lifetime("old", old);
  await request("old", {
    chatId: chat,
    recoveryKey: message,
    recovery: {
      commandId: command,
      commandGeneration: old,
      messageId: message,
    },
  });
  await value({ op: "queued", ticket: "old" });
  await value({ op: "hold", action: "retire", held: true });
  await value({ op: "exit", runtime: "r", start: true, name: "retirement" });
  await value({ op: "barrier", action: "retire" });
  assert.equal((await value({ op: "poll", name: "retirement" })).pending, true);
  assert.equal(
    (await value({ op: "status", ticket: "holder" })).state,
    "cancelling",
  );
  await value({ op: "hold", action: "retire", held: false });
  await value({ op: "await", name: "retirement" });
  await value({ op: "close" });
  console.log(
    "Actual keeper grant barriers, parked permission and retirement acknowledgement passed.",
  );

  await open({
    storage: true,
    recover: true,
    scope: { ...initial.scope, workerGeneration: randomUUID() },
    data: { node: initial.nodeData, rust: initial.rustData },
  });
  await value({
    op: "configure",
    input: { providerId: "p", maxConcurrentInference: 1 },
  });
  await value({ op: "runtime", name: "r" });
  await value({ op: "prepare", runtime: "r" });
  const recoveries = await value({ op: "recovery" });
  assert.ok(recoveries.some((record) => record.identity.operationId === old));
  await lifetime("newer", "newer");
  await request("newer");
  await value({ op: "queued", ticket: "newer" });
  await waiting("newer");
  const replacement = randomUUID();
  await lifetime("adopted", replacement);
  await request("adopted", {
    chatId: chat,
    recoveryKey: message,
    recovery: {
      commandId: command,
      commandGeneration: replacement,
      messageId: message,
    },
  });
  await ready("adopted");
  await waiting("newer");
  assert.equal(
    (await value({ op: "recovery" })).some(
      (record) => record.identity.operationId === old,
    ),
    false,
  );
  await value({ op: "settle", ticket: "adopted", outcome: "never-started" });
  await ready("newer");
  await value({ op: "settle", ticket: "newer", outcome: "never-started" });
  await value({ op: "close" });
  await open({ storage: true });
  await value({
    op: "configure",
    input: { providerId: "p", maxConcurrentInference: 1 },
  });
  await value({ op: "runtime", name: "r" });
  await value({ op: "prepare", runtime: "r" });
  const thread = randomUUID(),
    turn = randomUUID(),
    cycle = {
      cycleId: randomUUID(),
      goalEpoch: randomUUID(),
      scopeId: randomUUID(),
      gateAttemptId: randomUUID(),
      runnerGeneration: randomUUID(),
      modelRouteId: randomUUID(),
      providerAccountId: null,
      orderEpoch: 3,
    };
  await lifetime(
    "task",
    `native-inference:${thread}:${turn}:${cycle.scopeId}:${cycle.gateAttemptId}`,
  );
  await request("task", {
    chatId: randomUUID(),
    recovery: { threadId: thread, turnId: turn, taskGoalCycle: cycle },
  });
  await ready("task");
  await value({
    op: "bind",
    ticket: "task",
    execution: { threadId: thread, turnId: turn, scopeId: cycle.scopeId },
  });
  await value({ op: "task-unused", ticket: "task" });
  assert.equal((await pair({ op: "unused", ticket: "task" })).ok, false);
  const withdrawn = await value({ op: "task-withdraw", ticket: "task" });
  assert.equal(withdrawn.outcome, "never-started");
  await value({ op: "lifetime.close", name: "task" });
  await value({ op: "task-withdraw", ticket: "task" });
  assert.equal((await pair({ op: "start", ticket: "task" })).ok, false);
  await value({ op: "close" });
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      actualNodeAdmission: true,
      actualRustKeeper: true,
      heldAcknowledgementsAfterCommit: true,
      coldRecoveryRetainsFifo: true,
      privateTaskGoalNoStartReceipts: true,
      nativeChildrenWithoutNode: true,
      noInference: true,
      rootRemovedOnExit: true,
    }),
  );
} finally {
  try {
    await reference.reset();
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    assert.equal(await finished, 0);
  } finally {
    reference.restore();
    await rm(root, { recursive: true, force: true });
  }
}
