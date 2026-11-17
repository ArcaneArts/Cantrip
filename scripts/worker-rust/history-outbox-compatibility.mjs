// Actual Node/native outboxes over the same stopped, owned fixture profiles.
// Native writes are reopened and verified by the unchanged Node implementation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  readdir,
  stat,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { NativeHistoryOutbox } from "../../cantrip_worker/src/native-history-outbox.ts";
import {
  prepareNativeHistoryOutboxBaseline,
  validateNativeHistoryOutboxBaseline,
} from "../../cantrip_worker/src/native-history-outbox-baseline.ts";
import { nativeHistoryBatchPayloadDigest } from "../../cantrip_worker/src/native-history-batch-archive.ts";
import { verifyNativeHistoryRejection } from "../../cantrip_worker/src/native-history-rejection.ts";

const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass the built --binary history-source-fixture");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-outbox-native-"));
let comparisons = 0,
  state = { owner: "owner", server: "server", revision: 1 };
const service = {
  ownerId: () => state.owner,
  serverIdentity: () => state.server,
  componentKey: (_scope, revision = state.revision) => ({
    key: new Uint8Array(32).fill(revision),
    keyRevision: revision,
  }),
};
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
  assert.equal(partial, "", "native frame must end with LF");
}
function driver() {
  const child = spawn(path.resolve(values.binary), [], {
    env: { ...process.env, PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const output = lines(child.stdout);
  return {
    async request(request) {
      child.stdin.write(JSON.stringify(request) + "\n");
      const line = await output.next();
      assert.equal(line.done, false, "native fixture exited");
      return JSON.parse(line.value);
    },
    async stop() {
      child.stdin.end();
      assert.equal(await completion, 0);
    },
  };
}
let child = driver();
async function native(request) {
  const result = await child.request(request);
  assert.equal(result.ok, true, result.error);
  return result.value;
}
function same(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  comparisons++;
  return actual;
}
async function observe(run) {
  try {
    const value = await run();
    return { ok: true, value: value ?? null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
async function compare(request, run, label = request.op) {
  return same(await child.request(request), await observe(run), label).value;
}
async function ioFailure(request, run) {
  const actual = await child.request(request),
    reference = await observe(run);
  same(actual.ok, false, "native actual IO refusal");
  same(reference.ok, false, "Node actual IO refusal");
}
async function identity(patch) {
  state = { ...state, ...patch };
  await native({ op: "identity", state });
}
const input = (extra = {}) => ({
  directory: root,
  workerId: "worker",
  chatId: "chat",
  bindingId: "binding",
  service,
  ...extra,
});
async function open(handle = "a", extra = {}) {
  return native({ op: "outbox.open", handle, directory: root, ...extra });
}
const recordFile = (box, sequence, kind = "mutation") =>
  path.join(
    box.directory,
    String(sequence).padStart(16, "0") + `.${kind}.json`,
  );
const prepared = JSON.stringify({ items: [], turns: [] });
const corrected = JSON.stringify({
  items: [],
  turns: [],
  snapshot: { readBarrierSequence: 1, complete: true },
});
const tailBody = JSON.stringify({
  turns: [],
  items: [],
  snapshot: { complete: false, readBarrierSequence: 3 },
});
const receipt = (record) => ({
  committed: true,
  streamId: record.streamId,
  sequence: record.sequence,
  recordId: record.recordId,
  digest: record.digest,
  commitId: `00000000-0000-4000-8000-${String(record.sequence).padStart(12, "0")}`,
});
const rejection = (box, record, body) => ({
  rejected: true,
  rejectionId: randomUUID(),
  code: "item-revision-conflict",
  workerId: box.scope.workerId,
  chatId: box.scope.chatId,
  bindingId: box.scope.bindingId,
  streamId: record.streamId,
  sequence: record.sequence,
  recordId: record.recordId,
  digest: record.digest,
  previousDigest: record.previousDigest,
  payloadDigest: nativeHistoryBatchPayloadDigest(
    JSON.parse(body),
    record.previousDigest,
  ),
});
let raceRelease;
try {
  const created = await open(),
    box = await NativeHistoryOutbox.open(input());
  same(
    {
      directory: created.directory,
      streamId: created.streamId,
      scope: created.scope,
    },
    { directory: box.directory, streamId: box.streamId, scope: box.scope },
    "native stream identity reopens in Node",
  );
  same(created.recoveryCalls, 0, "no implicit recovery");
  const first = await box.append(randomUUID(), prepared);
  await compare(
    { op: "outbox.append", recordId: first.recordId, body: prepared },
    () => box.append(first.recordId, prepared),
    "native opens Node mutation and ciphertext",
  );
  await identity({ revision: 2 });
  const secondId = randomUUID();
  const second = await compare(
    { op: "outbox.append", recordId: secondId, body: prepared },
    () => box.append(secondId, prepared),
    "Node opens native append",
  );
  const thirdId = randomUUID(),
    third = await compare(
      { op: "outbox.append", recordId: thirdId, body: tailBody },
      () => box.append(thirdId, tailBody),
    );
  same(second.envelope.keyRevision, 2, "new encryption revision");
  await compare(
    { op: "outbox.body", record: first },
    () => box.openBody(first),
    "historical key revision",
  );
  await compare({ op: "outbox.pending" }, () => box.pending());
  await compare(
    { op: "outbox.receipt", recordId: secondId },
    () => box.committedReceipt(secondId),
    "a send attempt is not a receipt",
  );
  await compare(
    { op: "outbox.append", recordId: secondId, body: corrected },
    () => box.append(secondId, corrected),
  );
  await compare(
    { op: "outbox.ack", receipt: receipt(third) },
    () => box.acknowledgeCommitted(receipt(third)),
    "no skipped ACK",
  );
  await compare({ op: "outbox.ack", receipt: receipt(first) }, () =>
    box.acknowledgeCommitted(receipt(first)),
  );
  await compare(
    {
      op: "outbox.ack",
      receipt: { ...receipt(first), commitId: randomUUID() },
    },
    () =>
      box.acknowledgeCommitted({
        ...receipt(first),
        commitId: "00000000-0000-4000-8000-999999999999",
      }),
  );
  await compare(
    { op: "outbox.receipt", recordId: first.recordId, expectedBody: prepared },
    () => box.committedReceipt(first.recordId, prepared),
  );
  await compare(
    { op: "outbox.receipt", recordId: first.recordId, expectedBody: corrected },
    () => box.committedReceipt(first.recordId, corrected),
  );
  const proof = rejection(box, second, prepared),
    replacementId = randomUUID();
  for (const change of [
    { digest: "0".repeat(64) },
    { payloadDigest: "0".repeat(64) },
    { recordId: randomUUID() },
  ])
    await compare(
      {
        op: "outbox.replace",
        rejection: { ...proof, ...change },
        recordId: replacementId,
        body: corrected,
      },
      () =>
        box.replaceRejected({ ...proof, ...change }, replacementId, corrected),
    );
  const request = {
    workerId: box.scope.workerId,
    chatId: box.scope.chatId,
    bindingId: box.scope.bindingId,
    streamId: second.streamId,
    sequence: second.sequence,
    recordId: second.recordId,
    digest: second.digest,
    previousDigest: second.previousDigest,
    batch: JSON.parse(prepared),
  };
  for (const code of [proof.code, "unrelated-code"])
    await compare(
      { op: "outbox.verify-rejection", rejection: proof, request, code },
      () => verifyNativeHistoryRejection(proof, request, code),
    );
  await compare(
    {
      op: "outbox.verify-rejection",
      rejection: proof,
      request: { ...request, workerId: "other" },
      code: proof.code,
    },
    () =>
      verifyNativeHistoryRejection(
        proof,
        { ...request, workerId: "other" },
        proof.code,
      ),
  );
  const priorFiles = await Promise.all(
    [1, 2, 3].map((n) => readFile(recordFile(box, n), "utf8")),
  );
  const replacements = await compare(
    {
      op: "outbox.replace",
      rejection: proof,
      recordId: replacementId,
      body: corrected,
    },
    () => box.replaceRejected(proof, replacementId, corrected),
  );
  same(
    replacements.map((r) => r.sequence),
    [2, 3],
    "replace only the complete pending tail",
  );
  same(
    await Promise.all(
      [1, 2, 3].map((n) => readFile(recordFile(box, n), "utf8")),
    ),
    priorFiles,
    "old encrypted records retained",
  );
  await compare({ op: "outbox.pending" }, () => box.pending());
  await compare(
    {
      op: "outbox.replace",
      rejection: proof,
      recordId: replacementId,
      body: corrected,
    },
    () => box.replaceRejected(proof, replacementId, corrected),
    "uncertain replacement keeps identities and ciphertext",
  );
  await compare(
    {
      op: "outbox.replace",
      rejection: proof,
      recordId: replacementId,
      body: prepared,
    },
    () => box.replaceRejected(proof, replacementId, prepared),
  );
  for (const old of [second, third]) {
    await compare({ op: "outbox.replacement", recordId: old.recordId }, () =>
      box.replacement(old.recordId),
    );
    await compare(
      { op: "outbox.append", recordId: old.recordId, body: prepared },
      () => box.append(old.recordId, prepared),
    );
    await compare({ op: "outbox.ack", receipt: receipt(old) }, () =>
      box.acknowledgeCommitted(receipt(old)),
    );
  }
  await compare({ op: "outbox.body", record: replacements[1] }, () =>
    box.openBody(replacements[1]),
  );

  // Two independently opened native handles serialize at one canonical directory.
  await open("b");
  const nextId = randomUUID(),
    next = await native({
      op: "outbox.batch",
      entries: [
        { handle: "a", recordId: nextId, body: prepared },
        { handle: "b", recordId: nextId, body: prepared },
      ],
    });
  same(next[0], next[1], "FIFO same-frame deduplication");
  same(
    await box.append(nextId, prepared),
    next[0],
    "Node reopens separately queued native append",
  );
  const abandonedId = randomUUID();
  const afterAbandon = await native({
    op: "outbox.abandon",
    recordId: abandonedId,
    body: prepared,
  });
  same(
    afterAbandon,
    await box.pending(),
    "accepted append survives response abandonment",
  );
  const active = [first, ...afterAbandon];
  await child.stop();
  child = driver();
  await identity({});
  const restarted = await open();
  same(
    restarted.streamId,
    box.streamId,
    "actual process restart retains stream",
  );
  await compare(
    { op: "outbox.pending" },
    () => box.pending(),
    "restart replays immutable pending bytes",
  );
  for (const record of afterAbandon)
    await compare({ op: "outbox.ack", receipt: receipt(record) }, () =>
      box.acknowledgeCommitted(receipt(record)),
    );
  await compare({ op: "outbox.pending" }, () => box.pending());
  await compare(
    {
      op: "outbox.replace",
      rejection: rejection(box, afterAbandon[0], corrected),
      recordId: randomUUID(),
      body: prepared,
    },
    () =>
      box.replaceRejected(
        rejection(box, afterAbandon[0], corrected),
        randomUUID(),
        prepared,
      ),
  );

  // Reconstruct a lost local stream from a complete authenticated receipt archive.
  const bodies = [prepared, corrected, tailBody, prepared, prepared];
  const recovery = {
    binding: { id: "binding", workerId: "worker", chatId: "chat" },
    batches: active.map((record, i) => ({
      bindingId: "binding",
      workerId: "worker",
      receipt: receipt(record),
      previousDigest: record.previousDigest,
      payloadDigest: nativeHistoryBatchPayloadDigest(
        JSON.parse(bodies[i]),
        record.previousDigest,
      ),
      batch: JSON.parse(bodies[i]),
    })),
  };
  const expectedBaseline = prepareNativeHistoryOutboxBaseline(
    recovery,
    box.scope,
  );
  await compare(
    { op: "outbox.baseline", recovery, scope: box.scope },
    () => expectedBaseline,
  );
  await compare(
    {
      op: "outbox.digest",
      batch: JSON.parse(tailBody),
      previousDigest: first.digest,
    },
    () => nativeHistoryBatchPayloadDigest(JSON.parse(tailBody), first.digest),
  );
  for (const change of [
    { workerId: "foreign" },
    { chatId: "foreign" },
    { bindingId: "foreign" },
  ])
    await compare(
      { op: "outbox.baseline", recovery, scope: { ...box.scope, ...change } },
      () =>
        prepareNativeHistoryOutboxBaseline(recovery, {
          ...box.scope,
          ...change,
        }),
    );
  for (const entries of [
    expectedBaseline.entries.slice(1),
    [expectedBaseline.entries[0], expectedBaseline.entries[0]],
    [{ ...expectedBaseline.entries[0], previousDigest: "f".repeat(64) }],
  ])
    await compare(
      { op: "outbox.validate-baseline", entries, streamId: box.streamId },
      () => validateNativeHistoryOutboxBaseline(entries, box.streamId),
    );
  const oldSource = structuredClone(recovery);
  oldSource.batches.forEach((entry) => {
    entry.batch = null;
    delete entry.previousDigest;
  });
  await compare(
    { op: "outbox.baseline", recovery: oldSource, scope: box.scope },
    () => prepareNativeHistoryOutboxBaseline(oldSource, box.scope),
    "older archive with explicit missing source",
  );
  await rm(box.directory, { recursive: true });
  const restored = await open("restored", { recovery });
  same(restored.streamId, box.streamId, "recovered original stream identity");
  same(restored.recoveryCalls, 1, "native authenticated recovery callback");
  let sourceRecoveryCalls = 0;
  const recovered = await NativeHistoryOutbox.open(
    input({
      recover: async () => {
        sourceRecoveryCalls++;
        return recovery;
      },
    }),
  );
  same(
    sourceRecoveryCalls,
    0,
    "Node reopens native encrypted baseline without recalling recovery",
  );
  for (let i = 0; i < active.length; i++)
    await compare(
      {
        op: "outbox.receipt",
        handle: "restored",
        recordId: active[i].recordId,
        expectedBody: bodies[i],
      },
      () => recovered.committedReceipt(active[i].recordId, bodies[i]),
    );
  await compare(
    { op: "outbox.ack", handle: "restored", receipt: receipt(first) },
    () => recovered.acknowledgeCommitted(receipt(first)),
  );
  await compare(
    {
      op: "outbox.append",
      handle: "restored",
      recordId: first.recordId,
      body: prepared,
    },
    () => recovered.append(first.recordId, prepared),
  );
  await compare(
    {
      op: "outbox.receipt",
      handle: "restored",
      recordId: first.recordId,
      expectedBody: corrected,
    },
    () => recovered.committedReceipt(first.recordId, corrected),
  );
  const continuationId = randomUUID(),
    continuation = await compare(
      {
        op: "outbox.append",
        handle: "restored",
        recordId: continuationId,
        body: prepared,
      },
      () => recovered.append(continuationId, prepared),
    );
  same(
    continuation.sequence,
    active.length + 1,
    "recovered stream continues sequence",
  );
  same(
    continuation.previousDigest,
    active.at(-1).digest,
    "recovered predecessor",
  );

  // A legacy encrypted batch is a fixed prefix, preserved through native repairs.
  const legacy = await NativeHistoryOutbox.open(input({ chatId: "legacy" }));
  const legacyRecord = await legacy.append(randomUUID(), prepared);
  await rm(recordFile(legacy, 1));
  await writeFile(
    recordFile(legacy, 1, "batch"),
    JSON.stringify(legacyRecord),
    { mode: 0o600 },
  );
  await open("legacy", { chatId: "legacy" });
  const legacyTailId = randomUUID();
  await compare(
    {
      op: "outbox.append",
      handle: "legacy",
      recordId: legacyTailId,
      body: prepared,
    },
    () => legacy.append(legacyTailId, prepared),
  );
  const legacyBytes = await readFile(recordFile(legacy, 1, "batch"), "utf8"),
    legacyProof = rejection(legacy, legacyRecord, prepared),
    legacyReplacementId = randomUUID();
  await compare(
    {
      op: "outbox.replace",
      handle: "legacy",
      rejection: legacyProof,
      recordId: legacyReplacementId,
      body: corrected,
    },
    () => legacy.replaceRejected(legacyProof, legacyReplacementId, corrected),
  );
  same(
    await readFile(recordFile(legacy, 1, "batch"), "utf8"),
    legacyBytes,
    "legacy prefix never rewritten",
  );

  // Actual cross-process contention: block an owned native grant lookup after
  // its immutable ledger snapshot, let Node append, then release native repair.
  await open("race", { chatId: "race" });
  const race = await NativeHistoryOutbox.open(input({ chatId: "race" }));
  const raceId = randomUUID(),
    raceRecord = await compare(
      { op: "outbox.append", handle: "race", recordId: raceId, body: prepared },
      () => race.append(raceId, prepared),
    );
  const ready = path.join(root, "key-ready");
  raceRelease = path.join(root, "release-key");
  await native({
    op: "identity",
    state: { ...state, pause: { ready, release: raceRelease } },
  });
  const raceProof = rejection(race, raceRecord, prepared),
    raceReplacementId = randomUUID();
  const pendingRepair = child.request({
    op: "outbox.replace",
    handle: "race",
    rejection: raceProof,
    recordId: raceReplacementId,
    body: corrected,
  });
  try {
    for (let i = 0; ; i++) {
      try {
        await stat(ready);
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || i >= 200) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await race.append(randomUUID(), tailBody);
  } finally {
    await writeFile(raceRelease, "release");
  }
  const lost = await pendingRepair;
  same(lost.ok, false, "concurrent mutation slot refuses native stale repair");
  same(
    lost.error,
    "Native history journal advanced concurrently; retry the same record.",
    "real cross-process collision",
  );
  await compare(
    {
      op: "outbox.replace",
      handle: "race",
      rejection: raceProof,
      recordId: raceReplacementId,
      body: corrected,
    },
    () => race.replaceRejected(raceProof, raceReplacementId, corrected),
    "same repair retry includes actual concurrent tail",
  );

  const fault = await open("fault", { chatId: "fault" }),
    sourceFault = await NativeHistoryOutbox.open(input({ chatId: "fault" })),
    faultId = randomUUID();
  await mkdir(recordFile(fault, 1));
  await ioFailure(
    { op: "outbox.append", handle: "fault", recordId: faultId, body: prepared },
    () => sourceFault.append(faultId, prepared),
  );
  await rm(recordFile(fault, 1), { recursive: true });
  const faultRecord = await compare(
    { op: "outbox.append", handle: "fault", recordId: faultId, body: prepared },
    () => sourceFault.append(faultId, prepared),
    "same frame retry after storage repair",
  );
  await mkdir(recordFile(fault, 1, "ack"));
  await ioFailure(
    { op: "outbox.ack", handle: "fault", receipt: receipt(faultRecord) },
    () => sourceFault.acknowledgeCommitted(receipt(faultRecord)),
  );
  await rm(recordFile(fault, 1, "ack"), { recursive: true });
  await compare(
    { op: "outbox.pending", handle: "fault" },
    () => sourceFault.pending(),
    "failed ACK does not consume",
  );
  const bytes = await readFile(recordFile(fault, 1));
  const corrupt = JSON.parse(bytes);
  corrupt.digest = "0".repeat(64);
  await writeFile(recordFile(fault, 1), JSON.stringify(corrupt));
  await compare(
    { op: "outbox.pending", handle: "fault" },
    () => sourceFault.pending(),
    "corrupt mutation stays an error",
  );
  await writeFile(recordFile(fault, 1), bytes);
  await rm(path.join(fault.directory, "stream.json"));
  await compare(
    { op: "outbox.open", handle: "fault", directory: root, chatId: "fault" },
    () => NativeHistoryOutbox.open(input({ chatId: "fault" })),
    "lost durable identity is not recreated",
  );
  await identity({ owner: "changed" });
  await compare({ op: "outbox.pending", handle: "restored" }, () =>
    recovered.pending(),
  );
  await identity({ owner: "owner" });

  // Failed recovery creates no replacement identity and does not poison retry.
  await compare(
    {
      op: "outbox.open",
      handle: "recover-error",
      directory: root,
      chatId: "recover-error",
      recoveryError: "archive unavailable",
    },
    () =>
      NativeHistoryOutbox.open(
        input({
          chatId: "recover-error",
          recover: async () => {
            throw new Error("archive unavailable");
          },
        }),
      ),
  );
  const recoveryEmpty = {
    binding: { id: "binding", workerId: "worker", chatId: "recover-error" },
    batches: [],
  };
  const retried = await open("recover-error", {
    chatId: "recover-error",
    recovery: recoveryEmpty,
  });
  same(retried.recoveryCalls, 1, "actual recovery retry");
  const identityRecovery = {
    binding: { id: "binding", workerId: "worker", chatId: "recover-identity" },
    batches: [],
  };
  const changedIdentity = { ...state, owner: "new-owner" };
  await compare(
    {
      op: "outbox.open",
      handle: "recover-identity",
      directory: root,
      chatId: "recover-identity",
      recovery: identityRecovery,
      identityAfterRecovery: changedIdentity,
    },
    () =>
      NativeHistoryOutbox.open(
        input({
          chatId: "recover-identity",
          recover: async () => {
            state = changedIdentity;
            return identityRecovery;
          },
        }),
      ),
    "identity changes during actual recovery",
  );
  await identity({ owner: "owner" });
  const identityRetried = await open("recover-identity", {
    chatId: "recover-identity",
    recovery: identityRecovery,
  });
  same(
    identityRetried.recoveryCalls,
    1,
    "identity refusal left no replacement stream",
  );
  for (const [i, patch] of [
    { workerId: "other" },
    { chatId: "other" },
    { bindingId: "other" },
  ].entries()) {
    const independent = await open("independent" + i, patch),
      reference = await NativeHistoryOutbox.open(input(patch));
    same(
      independent.directory,
      reference.directory,
      "independent worker/chat/binding scope",
    );
    await compare(
      { op: "outbox.body", handle: "independent" + i, record: first },
      () => reference.openBody(first),
      "scoped stream rejects foreign ciphertext",
    );
  }
  const fresh = await NativeHistoryOutbox.open(
    input({ chatId: "recover-error" }),
  );
  same(fresh.streamId, retried.streamId, "recovery retry publishes once");
  for (const name of await readdir(recovered.directory)) {
    const at = path.join(recovered.directory, name);
    const body = await readFile(at, "utf8");
    assert.ok(!body.includes('"items"') && !body.includes('"turns"'));
    if (process.platform !== "win32")
      same((await stat(at)).mode & 0o777, 0o600, "private committed files");
  }
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      crossProcessNativeNodeContention: true,
      nativeProcessRestart: true,
      runtime: "macOS ARM64",
      rootRemovedOnExit: true,
    }),
  );
} finally {
  if (raceRelease) await writeFile(raceRelease, "release");
  await child.stop();
  await rm(root, { recursive: true, force: true });
}
