// Real Node/native source, outbox and projection files; controlled authenticated
// receiver callbacks isolate transaction behavior from provider/HTTP adapters.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  mkdir,
  open as openFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { NativeHistoryProjection } from "../../cantrip_worker/src/native-history-projection.ts";
import { NativeHistorySourceJournal } from "../../cantrip_worker/src/native-history-source-journal.ts";
import { NativeHistoryOutbox } from "../../cantrip_worker/src/native-history-outbox.ts";
import { reduceNativeHistory } from "../../cantrip_worker/src/native-history-reducer.ts";
import {
  NativeHistoryBatchRejectedError,
  verifyNativeHistoryRejection,
} from "../../cantrip_worker/src/native-history-rejection.ts";
import { nativeHistoryBatchPayloadDigest } from "../../cantrip_worker/src/native-history-batch-archive.ts";

const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass built --binary history-source-fixture");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-projection-native-"));
let comparisons = 0;
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
    async request(input) {
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
let child = driver();
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: (_scope, revision = 1) => ({
    key: new Uint8Array(32).fill(revision),
    keyRevision: revision,
  }),
};
function same(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  comparisons++;
  return actual;
}
async function native(input) {
  const result = await child.request(input);
  assert.equal(result.ok, true, result.error);
  return result.value;
}
async function observe(run) {
  try {
    return { ok: true, value: (await run()) ?? null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
async function compare(input, run, label = input.op) {
  return same(await child.request(input), await observe(run), label).value;
}
const empty = { items: [], turns: [] },
  alternate = {
    items: [],
    turns: [],
    snapshot: { readBarrierSequence: 2, complete: true },
  };
function project(p, records, previous, rebase) {
  const index = p.counts[rebase ? "rebase" : "project"]++;
  const selected = rebase ? (p.config.rebases?.[index] ?? p.config) : p.config;
  if (selected[rebase ? "rebaseError" : "projectError"])
    throw new Error(selected[rebase ? "rebaseError" : "projectError"]);
  const state = Object.hasOwn(selected, "state")
    ? selected.state
    : reduceNativeHistory(previous, records, "thread");
  return { state, batches: selected.batches ?? [] };
}
async function receiver(p, scope, record, body) {
  const config = p.config;
  let ledger;
  try {
    ledger = JSON.parse(await readFile(config.serverFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    ledger = { attempts: [], commits: [], rejections: [] };
  }
  ledger.attempts.push({
    recordId: record.recordId,
    digest: record.digest,
    body,
  });
  const attempt = ledger.attempts.length;
  async function save() {
    const file = await openFile(config.serverFile, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(ledger));
      await file.sync();
    } finally {
      await file.close();
    }
  }
  if (
    config.mode === "fail" ||
    config.mode === "ordinary-409" ||
    config.failAt?.includes(attempt)
  ) {
    await save();
    throw new Error(
      config.mode === "ordinary-409"
        ? "ordinary conflict"
        : "fixture delivery unavailable",
    );
  }
  if (config.rejectAt?.includes(attempt)) {
    const request = {
      workerId: "worker",
      ...scope,
      streamId: record.streamId,
      sequence: record.sequence,
      recordId: record.recordId,
      digest: record.digest,
      previousDigest: record.previousDigest,
      batch: JSON.parse(body),
    };
    const rejection = {
      rejected: true,
      rejectionId: randomUUID(),
      code: "item-revision-conflict",
      ...request,
    };
    delete rejection.batch;
    rejection.payloadDigest = nativeHistoryBatchPayloadDigest(
      JSON.parse(body),
      record.previousDigest,
    );
    ledger.rejections.push(rejection);
    await save();
    throw new NativeHistoryBatchRejectedError(
      verifyNativeHistoryRejection(rejection, request, rejection.code),
    );
  }
  const existing = ledger.commits.find(
    (v) => v.receipt.recordId === record.recordId,
  );
  let receipt;
  if (existing) {
    assert.equal(existing.receipt.digest, record.digest);
    assert.equal(existing.body, body);
    receipt = existing.receipt;
  } else {
    receipt = {
      committed: true,
      streamId: record.streamId,
      sequence: record.sequence,
      recordId: record.recordId,
      digest: record.digest,
      commitId: randomUUID(),
    };
    ledger.commits.push({
      receipt,
      body,
      previousDigest: record.previousDigest,
    });
  }
  await save();
  if (config.mode === "lost" || config.loseAt?.includes(attempt))
    throw new Error("fixture final reply lost");
  if (config.commitObstruction)
    await mkdir(config.commitObstruction, { recursive: true });
  if (config.stopAfterCommit) p.abort.abort(new Error("fixture stopped"));
  return receipt;
}
async function sourceOpen(p) {
  p.abort = new AbortController();
  p.source = await NativeHistorySourceJournal.open({
    directory: path.join(p.root, "source"),
    workerId: "worker",
    chatId: p.name,
    bindingId: "binding",
    threadId: "thread",
    service,
  });
  p.outbox = await NativeHistoryOutbox.open({
    directory: path.join(p.root, "outbox"),
    workerId: "worker",
    chatId: p.name,
    bindingId: "binding",
    service,
  });
  p.projection = await NativeHistoryProjection.open({
    directory: path.join(p.root, "projection"),
    workerId: "worker",
    chatId: p.name,
    bindingId: "binding",
    service,
    source: p.source,
    outbox: p.outbox,
    signal: p.abort.signal,
    project: async (records, previous) => project(p, records, previous, false),
    ...(p.allowRebase
      ? {
          rebase: async (records, previous) =>
            project(p, records, previous, true),
        }
      : {}),
    client: {
      deliver: (scope, record, body) => receiver(p, scope, record, body),
    },
  });
}
async function nativeOpen(p) {
  await native({
    op: "open",
    handle: p.name,
    directory: path.join(p.root, "source"),
    chatId: p.name,
  });
  await native({
    op: "outbox.open",
    handle: p.name,
    directory: path.join(p.root, "outbox"),
    chatId: p.name,
  });
  return native({
    op: "projection.open",
    handle: p.name,
    source: p.name,
    outbox: p.name,
    directory: path.join(p.root, "projection"),
    config: p.config,
    allowRebase: p.allowRebase,
  });
}
async function profile(name, config = {}, allowRebase = false) {
  const at = path.join(root, name);
  await mkdir(at);
  const p = {
    name,
    root: at,
    config: { serverFile: path.join(at, "receiver.json"), ...config },
    allowRebase,
    counts: { project: 0, rebase: 0 },
  };
  await sourceOpen(p);
  const opened = await nativeOpen(p);
  same(
    opened.directory,
    p.projection.directory,
    "same v1 projection identity path",
  );
  return p;
}
const op = (p, operation, rest = {}) => ({
  op: "projection." + operation,
  handle: p.name,
  ...rest,
});
async function config(p, patch) {
  Object.assign(p.config, patch);
  await native(op(p, "config", { config: p.config }));
}
async function event(p, n) {
  return p.source.append({
    kind: "notification",
    generation: "runtime",
    sequence: n,
    threadId: "thread",
    receivedAtMs: n,
    method: "item/completed",
    params: {
      turnId: "turn",
      item: {
        id: "item-" + n,
        type: "agentMessage",
        text: "synthetic private \ud800 evidence " + n,
      },
    },
  });
}
const file = (p, n, kind) =>
  path.join(
    p.projection.directory,
    String(n).padStart(16, "0") + `.${kind}.json`,
  );
async function checkpoint(p) {
  return compare(op(p, "checkpoint"), () => p.projection.checkpoint());
}
async function ledger(p) {
  return JSON.parse(await readFile(p.config.serverFile, "utf8"));
}
try {
  const lost = await profile("lost-native", { mode: "lost" });
  await event(lost, 1);
  await compare(
    op(lost, "drain"),
    () => lost.projection.drain(),
    "lost native reply preserves the same durable stage",
  );
  const frozen = await readFile(file(lost, 1, "stage"), "utf8");
  same(
    (await checkpoint(lost)).cursor.sequence,
    0,
    "remote commit alone does not checkpoint",
  );
  const beforeLost = await ledger(lost);
  same(beforeLost.commits.length, 1, "one committed effect despite retries");
  await config(lost, { mode: "success", projectError: "must not recompute" });
  await child.stop();
  child = driver();
  await nativeOpen(lost);
  await native(op(lost, "drain"));
  same(
    (await checkpoint(lost)).cursor.sequence,
    1,
    "native restart resumes frozen stage",
  );
  same(
    await readFile(file(lost, 1, "stage"), "utf8"),
    frozen,
    "stage ciphertext never rewritten",
  );
  const recoveredLost = await ledger(lost);
  same(
    recoveredLost.commits,
    beforeLost.commits,
    "canonical receipt survives replacement process",
  );
  same(
    recoveredLost.attempts.map((v) => v.body),
    Array(recoveredLost.attempts.length).fill(recoveredLost.attempts[0].body),
    "exact frozen wire bodies",
  );
  same(
    (await native(op(lost, "stats"))).projectCalls,
    0,
    "restart does not project again",
  );

  const nodeLost = await profile("lost-node", { mode: "lost" });
  await event(nodeLost, 1);
  await assert.rejects(nodeLost.projection.drain(), /fixture final reply lost/);
  const nodeFrozen = await readFile(file(nodeLost, 1, "stage"), "utf8");
  await config(nodeLost, {
    mode: "success",
    projectError: "must not project Node stage",
  });
  await native(op(nodeLost, "drain"));
  same(
    (await checkpoint(nodeLost)).cursor.sequence,
    1,
    "native resumes Node encrypted stage",
  );
  same(
    await readFile(file(nodeLost, 1, "stage"), "utf8"),
    nodeFrozen,
    "Node stage remains immutable",
  );

  const partial = await profile("partial", {
    batches: [empty, alternate],
    failAt: [2],
  });
  await event(partial, 1);
  same(
    (await child.request(op(partial, "drain"))).ok,
    false,
    "partial stage failure",
  );
  same(
    (await checkpoint(partial)).cursor.sequence,
    0,
    "accepted prefix cannot commit source range",
  );
  const partialBefore = await ledger(partial);
  same(partialBefore.commits.length, 1, "real accepted prefix persisted");
  await event(partial, 2);
  await config(partial, { failAt: [] });
  await native(op(partial, "drain"));
  same(
    (await checkpoint(partial)).cursor.sequence,
    2,
    "frozen page then new source page",
  );
  same(
    (await native(op(partial, "stats"))).projectCalls,
    2,
    "each source page reduced once",
  );
  same(
    (await ledger(partial)).commits[0],
    partialBefore.commits[0],
    "accepted prefix is not resent",
  );

  const local = await profile("local-checkpoint", { batches: [empty] });
  await event(local, 1);
  const obstruction = file(local, 1, "commit");
  await config(local, { commitObstruction: obstruction });
  same(
    (await child.request(op(local, "drain"))).ok,
    false,
    "actual commit publication obstruction",
  );
  const localBefore = await ledger(local);
  same(
    localBefore.commits.length,
    1,
    "canonical ACK precedes local checkpoint",
  );
  await rm(obstruction, { recursive: true });
  await config(local, {
    commitObstruction: null,
    projectError: "must not recompute acknowledged stage",
  });
  same(
    (await checkpoint(local)).cursor.sequence,
    0,
    "failed local commit remains pending",
  );
  await native(op(local, "drain"));
  same(
    (await checkpoint(local)).cursor.sequence,
    1,
    "repair commits from durable ACK",
  );
  same(
    (await ledger(local)).attempts,
    localBefore.attempts,
    "repair does not resend",
  );

  const planned = await profile(
    "planned",
    {
      state: { initial: true },
      rejectAt: [1],
      rebases: [{ state: { rebased: true }, batches: [] }],
    },
    true,
  );
  await event(planned, 1);
  const mutationObstruction = path.join(
    planned.outbox.directory,
    "0000000000000002.mutation.json",
  );
  await config(planned, { rebaseObstruction: mutationObstruction });
  same(
    (await child.request(op(planned, "drain"))).ok,
    false,
    "actual failure after rebase plan publication",
  );
  same(
    (await readdir(planned.projection.directory)).filter((v) =>
      v.endsWith(".rebase.json"),
    ).length,
    1,
    "rebase plan is durable before outbox repair",
  );
  await rm(mutationObstruction, { recursive: true });
  await config(planned, {
    rebaseObstruction: null,
    projectError: "must not project",
    rebaseError: "must not rebase frozen plan",
  });
  planned.config.rebases = [
    {
      state: { rebased: true },
      batches: [],
      rebaseError: "must not recompute plan",
    },
  ];
  await sourceOpen(planned);
  await planned.projection.drain();
  same(
    (await checkpoint(planned)).state,
    { rebased: true },
    "Node resumes native frozen rebase plan",
  );
  same(
    (await native(op(planned, "stats"))).rebaseCalls,
    1,
    "plan computed only once",
  );

  const repeated = await profile(
    "repeated",
    {
      batches: [empty, alternate],
      rejectAt: [2, 4],
      loseAt: [5],
      rebases: [
        { state: { pass: 1 }, batches: [alternate, empty] },
        { state: { pass: 2 }, batches: [] },
      ],
    },
    true,
  );
  await event(repeated, 1);
  const lostFinal = await child.request(op(repeated, "drain"));
  same(
    lostFinal.error,
    "fixture final reply lost",
    "repeated matched rejections rebase then lose final reply",
  );
  const repeatStats = await native(op(repeated, "stats"));
  same(repeatStats.projectCalls, 1, "one original reduction");
  same(repeatStats.rebaseCalls, 2, "two actual permanent decisions");
  same(
    repeatStats.rebaseInputs[1].state,
    { pass: 1 },
    "rebase receives last frozen pending state",
  );
  const repeatedBefore = await ledger(repeated);
  same(repeatedBefore.commits.length, 3, "each accepted prefix is retained");
  same(
    (await checkpoint(repeated)).cursor.sequence,
    0,
    "all source remains pending until final ACK",
  );
  await child.stop();
  child = driver();
  repeated.config.projectError = "must not project";
  repeated.config.rebaseError = "must not rebase";
  repeated.config.rebases = repeated.config.rebases.map((v) => ({
    ...v,
    rebaseError: "must not recompute durable rebase",
  }));
  await nativeOpen(repeated);
  await sourceOpen(repeated);
  await repeated.projection.drain();
  same(
    (await checkpoint(repeated)).state,
    { pass: 2 },
    "repeated rebase survives actual native restart and Node continuation",
  );
  same(
    (await ledger(repeated)).commits,
    repeatedBefore.commits,
    "lost final reply creates no duplicate commit",
  );

  const stopped = await profile("stopped", { stopAfterCommit: true });
  await event(stopped, 1);
  await compare(
    op(stopped, "drain"),
    () => stopped.projection.drain(),
    "stop after remote commit retains local pending record",
  );
  await compare(
    op(stopped, "checkpoint"),
    () => stopped.projection.checkpoint(),
    "explicit cancellation reason is preserved",
  );
  await config(stopped, {
    stopAfterCommit: false,
    projectError: "must not project stopped stage",
  });
  await nativeOpen(stopped);
  await sourceOpen(stopped);
  await native(op(stopped, "drain"));
  same(
    (await checkpoint(stopped)).cursor.sequence,
    1,
    "new owner resumes stopped delivery",
  );

  const ordinary = await profile("ordinary", { mode: "ordinary-409" }, true);
  await event(ordinary, 1);
  await compare(
    op(ordinary, "drain"),
    () => ordinary.projection.drain(),
    "ordinary conflict is not permanent rejection proof",
  );
  same(
    (await native(op(ordinary, "stats"))).rebaseCalls,
    0,
    "untyped conflict cannot trigger rebase",
  );
  const noRebase = await profile("no-rebase", { rejectAt: [1, 2] });
  await event(noRebase, 1);
  await compare(
    op(noRebase, "drain"),
    () => noRebase.projection.drain(),
    "typed rejection without rebase callback propagates",
  );
  same(
    (await checkpoint(noRebase)).cursor.sequence,
    0,
    "rejection alone never advances cursor",
  );

  const foreign = await profile("foreign");
  const mismatched = await child.request({
    op: "projection.open",
    handle: "mismatched",
    source: repeated.name,
    outbox: foreign.name,
    directory: path.join(root, "mismatched"),
    config: repeated.config,
  });
  const mismatchedSource = await observe(() =>
    NativeHistoryProjection.open({
      directory: path.join(root, "mismatched"),
      workerId: "worker",
      chatId: repeated.name,
      bindingId: "binding",
      service,
      source: repeated.source,
      outbox: foreign.outbox,
      client: {
        deliver: () => {
          throw new Error("unreachable");
        },
      },
      project: () => {
        throw new Error("unreachable");
      },
    }),
  );
  same(
    mismatched.error,
    mismatchedSource.error,
    "exact source/outbox binding required",
  );
  const replaced = await profile("replaced-source");
  await event(replaced, 1);
  await native(op(replaced, "drain"));
  await rm(replaced.source.directory, { recursive: true });
  await native({
    op: "open",
    handle: replaced.name,
    directory: path.join(replaced.root, "source"),
    chatId: replaced.name,
  });
  const replacedNative = await child.request({
    op: "projection.open",
    handle: replaced.name,
    source: replaced.name,
    outbox: replaced.name,
    directory: path.join(replaced.root, "projection"),
    config: replaced.config,
  });
  const replacedNode = await observe(() => sourceOpen(replaced));
  same(
    replacedNative.error,
    replacedNode.error,
    "replacement source identity cannot reset an existing projection epoch",
  );
  const emptyProfile = await profile("empty");
  await compare(op(emptyProfile, "drain"), () =>
    emptyProfile.projection.drain(),
  );
  same(
    (await native(op(emptyProfile, "stats"))).projectCalls,
    0,
    "idle profile performs no projection",
  );
  await event(emptyProfile, 1);
  const abandoned = await native(op(emptyProfile, "abandon"));
  same(
    abandoned,
    await emptyProfile.projection.checkpoint(),
    "accepted drain survives caller response abandonment",
  );
  same(abandoned.cursor.sequence, 1, "abandoned response is not cancellation");
  const ackPath = path.join(
      emptyProfile.outbox.directory,
      "0000000000000001.ack.json",
    ),
    ackBytes = await readFile(ackPath);
  await rm(ackPath);
  await compare(
    op(emptyProfile, "checkpoint"),
    () => emptyProfile.projection.checkpoint(),
    "commit file cannot replace actual canonical ACK",
  );
  await writeFile(ackPath, ackBytes, { mode: 0o600 });
  const stagePath = file(emptyProfile, 1, "stage"),
    stageBytes = await readFile(stagePath),
    broken = JSON.parse(stageBytes);
  broken.digest = "0".repeat(64);
  await writeFile(stagePath, JSON.stringify(broken));
  await compare(
    op(emptyProfile, "checkpoint"),
    () => emptyProfile.projection.checkpoint(),
    "tampered stage remains an error",
  );
  await writeFile(stagePath, stageBytes);
  await writeFile(
    path.join(
      emptyProfile.projection.directory,
      "0000000000000009.0000000000000001.rebase.json",
    ),
    "{}",
  );
  await compare(
    op(emptyProfile, "checkpoint"),
    () => emptyProfile.projection.checkpoint(),
    "orphaned plan cannot be ignored",
  );
  await rm(
    path.join(
      emptyProfile.projection.directory,
      "0000000000000009.0000000000000001.rebase.json",
    ),
  );
  await rm(path.join(emptyProfile.projection.directory, "projection.json"));
  const nativeLostIdentity = await child.request({
    op: "projection.open",
    handle: emptyProfile.name,
    source: emptyProfile.name,
    outbox: emptyProfile.name,
    directory: path.join(emptyProfile.root, "projection"),
    config: emptyProfile.config,
  });
  const nodeLostIdentity = await observe(() => sourceOpen(emptyProfile));
  same(
    nativeLostIdentity.error,
    nodeLostIdentity.error,
    "lost identity is never replaced over durable transactions",
  );
  for (const p of [lost, nodeLost, partial, local, planned, repeated]) {
    for (const name of await readdir(p.projection.directory)) {
      const bytes = await readFile(
        path.join(p.projection.directory, name),
        "utf8",
      );
      assert.ok(
        !bytes.includes("synthetic private"),
        "private state must remain encrypted on disk",
      );
    }
  }
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      nativeProcessRestart: true,
      repeatedRebaseAndAcceptedPrefix: true,
      scope: "controlled receiver; not production HTTP",
      runtime: "macOS ARM64",
      rootRemovedOnExit: true,
    }),
  );
} finally {
  await child.stop();
  await rm(root, { recursive: true, force: true });
}
