// Coherent recovery over real loopback HTTP; synthetic encrypted source only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { readNativeHistoryRecovery } from "../../cantrip_worker/src/native-history-recovery.ts";
import { NativeHistoryClient } from "../../cantrip_worker/src/native-history-client.ts";
import { nativeHistoryBatchPayloadDigest } from "../../cantrip_worker/src/native-history-batch-archive.ts";
import { nativeHistoryWireFixtures } from "../server-rust/native-history-wire-fixtures.mjs";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary history-source-fixture");
const child = spawn(values.binary, [], {
  env: { ...process.env, PATH: "/usr/bin:/bin" },
  stdio: ["pipe", "pipe", "inherit"],
});
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
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
const output = lines(child.stdout);
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
const fixture = nativeHistoryWireFixtures("2026-11-17T00:00:00.000Z");
const binding = { ...fixture.nativeHistoryBindingSchema[0], id: "binding" };
const identity = {
  threadId: "thread",
  turnId: "turn",
  itemId: "item",
  component: "assistant",
  identityKind: "canonical",
};
const source = {
  id: "item",
  identityKind: "canonical",
  revision: 1,
  ordinal: 0,
  body: { type: "agentMessage", text: "private coherent recovery fixture" },
  lifecycle: "completed",
  completeBody: true,
  startedAtMs: null,
  completedAtMs: null,
  origin: { kind: "notification", generation: "runtime", sequence: 1 },
  conflicts: [],
};
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: (_scope, revision = 1) => ({
    key: new Uint8Array(32).fill(revision),
    keyRevision: revision,
  }),
};
let active,
  comparisons = 0;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  active.requests.push({ path: req.url, body: request });
  if (active.mode === "hang") return;
  if (active.mode === "permanent") {
    res.statusCode = 409;
    res.end(JSON.stringify({ code: "foreign-binding" }));
    return;
  }
  if (active.mode === "changed" && !active.changed && request.cursor) {
    active.changed = true;
    res.statusCode = 409;
    res.end(JSON.stringify({ code: "archive-snapshot-changed" }));
    return;
  }
  const kind = req.url.split("/").at(-1),
    after = request.cursor !== null;
  let page = structuredClone(active.pages[kind][after ? 1 : 0]);
  page.snapshotId = (active.changed ? "f" : "e").repeat(64);
  if (page.nextCursor) page.nextCursor.snapshotId = page.snapshotId;
  if (
    (active.mode === "changed" && !active.changed) ||
    (active.mode === "corrupt" && kind === "archive" && !after)
  )
    page.items[0].evidence.content.ciphertext =
      page.items[0].evidence.content.ciphertext.replace(
        /^./,
        page.items[0].evidence.content.ciphertext[0] === "A" ? "B" : "A",
      );
  if (active.mode === "foreign" && kind === "archive") {
    page.binding.threadId = "other";
    for (const item of page.items) item.identity.threadId = "other";
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(page));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  const mapping = {
    identity,
    key: "a".repeat(64),
    messageId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: "canonical",
    preservedInput: null,
  };
  const item = await result({
    op: "content.prepare",
    binding,
    rendered: {
      identity,
      source,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "native prepared" }],
      },
    },
    mapping,
    revision: 1,
    order: { turn: 0, item: 0, component: 0 },
    attachments: [],
  });
  const turn = await result({
    op: "content.turn.protect",
    binding,
    header: {
      threadId: "thread",
      turnId: "turn",
      revision: 1,
      ordinal: 0,
      status: "completed",
      startedAtMs: null,
      completedAtMs: null,
    },
    content: { version: 1, retained: true },
  });
  const batch = { items: [item], turns: [turn] },
    receipt = fixture.nativeHistoryCommitReceiptSchema[0],
    snapshotId = "e".repeat(64);
  const first = {
    key: "a".repeat(64),
    identity,
    messageId: mapping.messageId,
    attachments: [],
    revision: 2,
    state: "completed",
    order: { turn: 0, item: 0, component: 0 },
    evidence: item.evidence,
  };
  const second = {
    ...first,
    key: "b".repeat(64),
    identity: { ...identity, itemId: "legacy" },
    messageId: "22222222-2222-4222-8222-222222222222",
    evidence: null,
  };
  const pages = {
    archive: [
      {
        binding,
        snapshotId,
        items: [first],
        nextCursor: { snapshotId, key: first.key },
      },
      { binding, snapshotId, items: [second], nextCursor: null },
    ],
    "archive-turns": [
      {
        binding,
        snapshotId,
        turns: [{ bindingId: "binding", workerId: "worker", turn }],
        nextCursor: null,
      },
    ],
    "archive-batches": [
      {
        binding,
        snapshotId,
        batches: [
          {
            bindingId: "binding",
            workerId: "worker",
            receipt,
            payloadDigest: nativeHistoryBatchPayloadDigest(batch, null),
            previousDigest: null,
            batch,
          },
        ],
        nextCursor: { snapshotId, streamId: receipt.streamId, sequence: 1 },
      },
      {
        binding,
        snapshotId,
        batches: [
          {
            bindingId: "binding",
            workerId: "worker",
            receipt: {
              ...receipt,
              sequence: 2,
              recordId: "66666666-6666-4666-8666-666666666666",
              digest: "b".repeat(64),
              commitId: "77777777-7777-4777-8777-777777777777",
            },
            previousDigest: receipt.digest,
            payloadDigest: "c".repeat(64),
            batch: null,
          },
        ],
        nextCursor: null,
      },
    ],
  };
  async function observe(run) {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  for (const mode of [
    "success",
    "changed",
    "permanent",
    "foreign",
    "corrupt",
    "hang",
  ]) {
    const results = [];
    for (const kind of ["rust", "node"]) {
      active = { mode, pages, requests: [], changed: false };
      const retries = [];
      let timer,
        controller = new AbortController();
      if (mode === "hang")
        timer = setTimeout(
          () => controller.abort(new Error("fixture stopped")),
          150,
        );
      const value =
        kind === "rust"
          ? await native({
              op: "content.recovery",
              binding,
              serverUrl: origin,
              token: "synthetic-token",
              pageSize: 1,
              batchPageSize: 1,
              ...(mode === "hang" ? { abortAfterMs: 150 } : {}),
            })
          : await observe(async () => {
              const snapshot = await readNativeHistoryRecovery({
                binding,
                client: new NativeHistoryClient({
                  serverUrl: origin,
                  workerId: "worker",
                  token: () => "synthetic-token",
                }),
                service,
                pageSize: 1,
                batchPageSize: 1,
                signal: controller.signal,
                onRetry(attempt) {
                  retries.push(attempt);
                  throw new Error("ignored reporting error");
                },
              });
              return { snapshot, retries };
            });
      clearTimeout(timer);
      results.push({ value, requests: active.requests });
    }
    assert.deepEqual(results[0], results[1], mode);
    comparisons++;
    assert.equal(
      results[0].value.ok,
      ["success", "changed"].includes(mode),
      mode,
    );
    if (mode === "changed") {
      assert.deepEqual(results[0].value.value.retries, [1]);
      assert.equal(results[0].value.value.snapshot.snapshotId, "f".repeat(64));
      assert.equal(
        results[0].requests.length,
        7,
        "partial snapshot discarded before any decryption",
      );
    }
    if (mode === "success") {
      const snapshot = results[0].value.value.snapshot;
      assert.equal(snapshot.items.length, 2);
      assert.equal(snapshot.items[0].sourceCurrent, false);
      assert.equal(snapshot.items[1].source, null);
      assert.equal(snapshot.batches[1].source, null);
      assert.equal(results[0].requests.length, 5);
    }
    if (mode === "corrupt")
      assert.equal(
        results[0].requests.length,
        5,
        "all resources collected before decryption failure",
      );
  }
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      realLoopbackHttp: true,
      pinnedSnapshots: true,
      discardBeforeDecryption: true,
      missingSourcePreserved: true,
      cancellation: true,
      runtime: "macOS ARM64",
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  child.stdin.end();
  assert.equal(await completion, 0);
}
