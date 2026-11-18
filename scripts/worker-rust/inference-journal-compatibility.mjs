// Native keeper IO, durable journal orchestration and real runtime lease fencing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Reference, settle } from "./inference-journal-reference.mjs";
import { pure } from "./inference-journal-pure.mjs";
const { values } = parseArgs({
  options: { binary: { type: "string" }, codex: { type: "string" } },
});
assert.ok(values.binary);
assert.ok(values.codex);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-admission-"));
const keys = [
    "CANTRIP_INFERENCE_SCOPE",
    "CANTRIP_INFERENCE_GENERATION",
    "CANTRIP_INFERENCE_RUNTIME",
  ],
  previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const previousConfig = process.env.CANTRIP_NATIVE_OWNER_FIXTURE;
for (const key of keys)
  process.env[key] = "inherited-registration-must-be-cleared";
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
  reference = new Reference();
let comparisons = 0,
  serial = 0,
  current;
function same(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  comparisons++;
}
async function native(input, raw = false) {
  child.stdin.write(JSON.stringify(input) + "\n");
  const line = await output.next();
  assert.equal(line.done, false);
  const result = JSON.parse(line.value);
  if (raw) return result;
  assert.equal(result.ok, true, result.error);
  return result.value;
}
async function pair(input) {
  const node =
    input.op === "await"
      ? await reference.call(input)
      : await settle(reference.call(input));
  const rust = await native(input, true);
  if (input.op === "prepare" && node.ok && rust.ok) {
    const scopeKey = createHash("sha256")
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
      path.join(current.nodeData, "inference-ownership", scopeKey),
    );
    assert.equal(
      rust.value.CANTRIP_INFERENCE_SCOPE,
      path.join(current.rustData, "inference-ownership", scopeKey),
    );
    node.value.CANTRIP_INFERENCE_SCOPE = rust.value.CANTRIP_INFERENCE_SCOPE;
  }
  same(rust, node, input.op);
  return rust;
}
async function value(input) {
  const result = await pair(input);
  assert.equal(result.ok, true, result.error);
  return result.value;
}
async function open({ binary = values.codex, config = {}, scope, data } = {}) {
  const directory = path.join(root, String(++serial));
  await mkdir(directory);
  const nodeData = data?.node ?? path.join(directory, "node"),
    rustData = data?.rust ?? path.join(directory, "rust");
  await mkdir(nodeData, { recursive: true });
  await mkdir(rustData, { recursive: true });
  const nodeHome = path.join(directory, "node-home"),
    rustHome = path.join(directory, "rust-home");
  await mkdir(nodeHome);
  await mkdir(rustHome);
  scope ??= {
    serverId: randomUUID(),
    ownerId: randomUUID(),
    workerId: randomUUID(),
    workerGeneration: randomUUID(),
  };
  current = { scope, nodeData, rustData };
  const input = { op: "new", binary, cwd: root, scope, config };
  same(
    await native({ ...input, data: rustData, home: rustHome }, true),
    await settle(reference.call({ ...input, data: nodeData, home: nodeHome })),
    "new lazy ownership / journal",
  );
  return current;
}
function identity(runtime, operation, message = randomUUID(), extra = {}) {
  return {
    operationId: operation,
    providerId: "fixture-provider",
    runtimeGeneration: runtime,
    recoveryKey: message,
    recovery: { messageId: message },
    chatId,
    projectId: null,
    ...extra,
  };
}
function key(runtime, operation, generation = current.scope.workerGeneration) {
  return createHash("sha256")
    .update(JSON.stringify([generation, runtime, operation]))
    .digest("hex");
}
const chatId = randomUUID();
try {
  await pure({ native, same });
  console.log("Pure journal identities and schemas passed.");
  const initial = await open();
  const runtime = randomUUID();
  assert.equal((await value({ op: "status" })).available, false);
  await value({ op: "prepare", runtime });
  await value({ op: "initialize", start: true, name: "init-one" });
  await value({ op: "initialize", start: true, name: "init-two" });
  await value({ op: "await", name: "init-one" });
  await value({ op: "await", name: "init-two" });
  assert.equal((await value({ op: "status" })).calls.length, 1);
  const waitingId = randomUUID(),
    message = randomUUID(),
    waitingKey = key(runtime, waitingId);
  const waiting = await value({
    op: "enqueue",
    key: waitingKey,
    identity: identity(runtime, waitingId, message),
  });
  const usedId = randomUUID(),
    usedKey = key(runtime, usedId);
  await value({
    op: "enqueue",
    key: usedKey,
    identity: identity(runtime, usedId),
  });
  await value({ op: "grant", key: usedKey });
  await value({ op: "release", key: usedKey, outcome: "never-started" });
  assert.equal((await pair({ op: "grant", key: usedKey })).ok, false);
  await value({ op: "requeue", key: usedKey });
  await value({ op: "grant", key: usedKey });
  await value({
    op: "bind",
    key: usedKey,
    execution: {
      threadId: randomUUID(),
      turnId: randomUUID(),
      scopeId: randomUUID(),
    },
  });
  await value({ op: "release", key: usedKey, outcome: "never-started" });
  assert.equal((await pair({ op: "requeue", key: usedKey })).ok, false);
  const sealedId = randomUUID(),
    sealedKey = key(runtime, sealedId);
  await value({
    op: "seal",
    key: sealedKey,
    identity: identity(runtime, sealedId),
  });
  assert.equal((await pair({ op: "grant", key: sealedKey })).ok, false);
  const goalId = randomUUID(),
    goalKey = key(runtime, goalId);
  await value({
    op: "enqueue",
    key: goalKey,
    identity: identity(runtime, goalId, null, {
      recoveryKey: null,
      recovery: {
        commandId: randomUUID(),
        commandGeneration: randomUUID(),
        threadId: randomUUID(),
        turnId: randomUUID(),
        autonomousGoal: { goalEpoch: randomUUID(), orderEpoch: 0 },
      },
    }),
  });
  await value({ op: "grant", key: goalKey });
  await value({
    op: "release",
    key: goalKey,
    outcome: "never-started",
    start: true,
    name: "goal-release",
  });
  await value({ op: "flush" });
  await value({ op: "await", name: "goal-release" });
  assert.equal(
    (await value({ op: "recovery" })).some((r) => r.key === goalKey),
    true,
  );
  for (const fault of [
    "uncorrelated",
    "entry-failure",
    "wrong-key",
    "wrong-worker",
    "wrong-identity",
    "wrong-transition",
  ]) {
    const operation = randomUUID(),
      recordKey = key(runtime, operation);
    if (fault === "wrong-transition")
      await value({
        op: "enqueue",
        key: recordKey,
        identity: identity(runtime, operation),
      });
    await value({ op: "fault", value: fault });
    assert.equal(
      (
        await pair({
          op: fault === "wrong-transition" ? "grant" : "enqueue",
          key: recordKey,
          identity: identity(runtime, operation),
        })
      ).ok,
      false,
    );
    await value({ op: "fault", value: "" });
    assert.equal(
      (await value({ op: "snapshot" })).some((r) => r.key === recordKey),
      true,
      "real mutation committed despite rejected acknowledgement",
    );
  }
  console.log(
    "Actual keeper transitions and rejected acknowledgements passed.",
  );
  // One bounded metadata case crosses the actual 60 KB adoption frame limit.
  const aliasMessage = randomUUID();
  const aliases = Array.from({ length: 410 }, () => {
    const op = randomUUID();
    return {
      key: key(runtime, op),
      identity: identity(runtime, op, aliasMessage),
    };
  });
  const aliasRecords = await value({ op: "burst", items: aliases });
  await value({ op: "flush" });
  await value({ op: "close" });
  const nextScope = { ...initial.scope, workerGeneration: randomUUID() };
  await open({
    scope: nextScope,
    data: { node: initial.nodeData, rust: initial.rustData },
  });
  await value({ op: "fault", value: "snapshot-extra" });
  assert.equal((await pair({ op: "initialize" })).ok, false);
  await value({ op: "fault", value: "" });
  await value({ op: "initialize" });
  assert.equal(
    (await value({ op: "recovery" })).some((r) => r.key === waitingKey),
    true,
  );
  const nextRuntime = randomUUID(),
    replacement = randomUUID();
  await value({
    op: "adopt",
    key: key(nextRuntime, replacement),
    identity: identity(nextRuntime, replacement, message),
    previous: [waiting],
  });
  assert.equal(
    (await value({ op: "recovery" })).some((r) => r.key === waitingKey),
    false,
  );
  const replacementAliases = randomUUID();
  const adopted = await value({
    op: "adopt",
    key: key(nextRuntime, replacementAliases),
    identity: identity(nextRuntime, replacementAliases, aliasMessage),
    previous: aliasRecords,
    start: true,
    name: "adopt-aliases",
  });
  assert.equal(adopted, null);
  await value({ op: "flush" });
  const adoptedAliases = await value({ op: "await", name: "adopt-aliases" });
  assert.equal(adoptedAliases.order, aliasRecords[0].order);
  assert.equal(
    (await value({ op: "recovery" })).some((r) =>
      aliases.some((alias) => alias.key === r.key),
    ),
    false,
  );
  const snapshot = await value({ op: "snapshot" });
  await value({ op: "close" });
  // Actual Node reopen of the stopped native profile, then native reopen of Node's.
  const finalScope = { ...nextScope, workerGeneration: randomUUID() };
  await open({
    scope: finalScope,
    data: { node: initial.rustData, rust: initial.nodeData },
  });
  await value({ op: "initialize" });
  same(
    await value({ op: "snapshot" }),
    snapshot,
    "both stopped profiles retain exact durable metadata",
  );
  await value({ op: "close" });
  console.log(
    "Chunked adoption and Node/native retained-profile reopen passed.",
  );

  await open();
  await value({ op: "runtime.open", runtime: randomUUID() });
  assert.equal((await value({ op: "runtime.status" })).processExited, false);
  await value({ op: "close" });
  await value({ op: "runtime.exit" });
  await open();
  const physicalRuntime = randomUUID();
  await value({ op: "runtime.open", runtime: physicalRuntime });
  await value({ op: "retire", runtime: physicalRuntime });
  await value({ op: "runtime.exit" });
  await value({ op: "close" });
  console.log(
    "Actual registered Codex retirement and keeper EOF fencing passed.",
  );
  for (const config of [
    { fragmentUnicode: true },
    { missingResult: true },
    { closeDelayMs: 40 },
    { malformedIpc: true },
    { badAck: true },
    { exitBeforeAck: true },
  ]) {
    await open({ binary: values.binary, config });
    const prepared = await pair({ op: "prepare", runtime: randomUUID() });
    if (prepared.ok) {
      await pair({
        op: "raw",
        command: { action: "fixture/echo", text: "😀" },
      });
      if (config.malformedIpc) {
        const status = await value({ op: "status" });
        assert.equal(status.available, false);
        assert.equal(status.lost, 1);
        const reclaimed = await pair({ op: "prepare", runtime: randomUUID() });
        assert.equal(reclaimed.ok, false);
        assert.match(reclaimed.error, /ownership was lost/);
      }
      await value({ op: "close" });
    } else await value({ op: "close" });
  }
  await reference.reset();
  const readyFile = path.join(root, "retry-ready");
  const data = path.join(root, "native-retry"),
    home = path.join(root, "native-retry-home");
  await mkdir(data);
  await mkdir(home);
  const retryScope = {
    serverId: randomUUID(),
    ownerId: randomUUID(),
    workerId: randomUUID(),
    workerGeneration: randomUUID(),
  };
  await native({
    op: "new",
    binary: values.binary,
    cwd: root,
    data,
    home,
    scope: retryScope,
    config: { noAck: true, readyFile },
    ackTimeoutMs: 30,
  });
  const timed = await native({ op: "prepare", runtime: randomUUID() }, true);
  assert.equal(timed.ok, false);
  assert.match(timed.error, /operation failed \(deadline\)/);
  await writeFile(readyFile, "ready");
  await native({ op: "prepare", runtime: randomUUID() });
  await native({ op: "close" });
  await native({
    op: "new",
    binary: values.binary,
    cwd: root,
    data,
    home,
    scope: { ...retryScope, workerGeneration: randomUUID() },
    config: { delayFirstJournalMs: 60 },
    journalTimeoutMs: 10,
  });
  await native({ op: "prepare", runtime: randomUUID() });
  const late = await native(
    { op: "raw", command: { action: "fixture/echo", text: "first" } },
    true,
  );
  assert.equal(late.ok, false);
  assert.match(late.error, /acknowledgement timed out/);
  await native({ op: "tick", ms: 90 });
  same(
    await native({
      op: "raw",
      command: { action: "fixture/echo", text: "second" },
    }),
    { action: "fixture/echo", text: "second" },
    "late journal acknowledgement cannot settle a later request",
  );
  assert.equal((await native({ op: "status" })).available, true);
  await native({ op: "close" });
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      actualRustKeeper: true,
      actualNodeAlgorithms: true,
      schemaRoots: 3,
      nativeProfileAndNodeProfileReopen: true,
      rejectedAcknowledgementsAfterRealCommit: true,
      adoptionAliases: 410,
      realRegisteredCodexRetirement: true,
      keeperEofFencesRealRuntime: true,
      nativeProtocolPeers: true,
      failedClaimRetry: true,
      lateJournalAcknowledgement: true,
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
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    if (previousConfig === undefined)
      delete process.env.CANTRIP_NATIVE_OWNER_FIXTURE;
    else process.env.CANTRIP_NATIVE_OWNER_FIXTURE = previousConfig;
    await rm(root, { recursive: true, force: true });
  }
}
