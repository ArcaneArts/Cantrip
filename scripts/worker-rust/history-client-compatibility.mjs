// Actual loopback HTTP against both clients; all data and credentials are synthetic.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { NativeHistoryClient } from "../../cantrip_worker/src/native-history-client.ts";
import { NativeHistoryBatchRejectedError } from "../../cantrip_worker/src/native-history-rejection.ts";
import { nativeHistoryBatchPayloadDigest } from "../../cantrip_worker/src/native-history-batch-archive.ts";
import { nativeHistoryWireFixtures } from "../server-rust/native-history-wire-fixtures.mjs";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary history-client-fixture");
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
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
    }
  }
  assert.equal(buffer, "");
}
const output = lines(child.stdout);
async function native(input) {
  child.stdin.write(JSON.stringify(input) + "\n");
  const result = await output.next();
  assert.equal(result.done, false);
  return JSON.parse(result.value);
}
const fixture = nativeHistoryWireFixtures("2026-11-17T00:00:00.000Z");
const take = (name) => structuredClone(fixture[name][0]);
const binding = take("nativeHistoryBindingSchema"),
  openInput = take("nativeHistoryBindingOpenSchema");
const resolveInput = structuredClone(fixture.nativeHistoryResolveSchema[1]);
const mapping = {
  identity: resolveInput.items[0].identity,
  key: "a".repeat(64),
  messageId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "reserved",
  preservedInput: null,
};
const ingest = take("nativeHistoryIngestSchema"),
  receipt = take("nativeHistoryCommitReceiptSchema");
const reads = {
  archive: take("nativeHistoryArchiveReadSchema"),
  archiveTurns: take("nativeHistoryTurnArchiveReadSchema"),
  archiveBatches: take("nativeHistoryBatchArchiveReadSchema"),
};
const pages = {
  archive: take("nativeHistoryArchivePageSchema"),
  archiveTurns: take("nativeHistoryTurnArchivePageSchema"),
  archiveBatches: take("nativeHistoryBatchArchivePageSchema"),
};
pages.archiveBatches.batches[0].batch.items[0].evidence.bindingId = binding.id;
pages.archiveBatches.batches[0].payloadDigest = nativeHistoryBatchPayloadDigest(
  pages.archiveBatches.batches[0].batch,
  null,
);
let active,
  comparisons = 0;
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = {
    path: req.url,
    method: req.method,
    authorization: req.headers.authorization,
    contentType: req.headers["content-type"],
    body,
  };
  active.requests.push(request);
  const n = active.requests.length;
  if (active.hang) return;
  if (active.disconnect && n === 1) {
    req.socket.destroy();
    return;
  }
  if (active.delay)
    await new Promise((resolve) => setTimeout(resolve, active.delay));
  const status = active.statuses?.[n - 1] ?? active.status ?? 200;
  if (status >= 300 && status < 400)
    res.setHeader("location", active.location ?? "/must-never-follow");
  res.statusCode = status;
  const payload = active.response
    ? active.response(JSON.parse(body), n)
    : active.payload;
  if (status === 200) active.committed++;
  let bytes = Buffer.from(active.raw ?? JSON.stringify(payload));
  if (active.bom) bytes = Buffer.concat([Buffer.from([239, 187, 191]), bytes]);
  if (active.gzip) {
    bytes = gzipSync(bytes);
    res.setHeader("content-encoding", "gzip");
  }
  res.end(bytes);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
function signal(spec, prefix) {
  if (!spec[prefix + "Aborted"] && spec[prefix + "AbortAfterMs"] === undefined)
    return {};
  const controller = new AbortController();
  const abort = () =>
    controller.abort(new Error(spec[prefix + "Reason"] ?? "fixture cancelled"));
  if (spec[prefix + "Aborted"]) abort();
  else {
    const timer = setTimeout(abort, spec[prefix + "AbortAfterMs"]);
    return { signal: controller.signal, close: () => clearTimeout(timer) };
  }
  return { signal: controller.signal };
}
async function node(spec) {
  let count = 0;
  const caller = signal(spec, "caller"),
    transport = signal(spec, "transport");
  const tokens = spec.tokens ?? [spec.token ?? "synthetic-token"];
  const client = new NativeHistoryClient({
    serverUrl: spec.serverUrl,
    workerId: spec.workerId ?? "worker",
    token: () => tokens[Math.min(count++, tokens.length - 1)],
    metadataSignal: () => transport.signal,
  });
  try {
    return {
      ok: true,
      value: await (spec.action === "deliver"
        ? client.deliver(spec.scope, spec.record, spec.body, caller.signal)
        : client[spec.action](spec.input, caller.signal)),
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      status: error.status ?? null,
      code: error.code ?? null,
      rejected: error instanceof NativeHistoryBatchRejectedError,
    };
  } finally {
    caller.close?.();
    transport.close?.();
  }
}
async function check(label, action, input, payload, options = {}) {
  const spec = {
    serverUrl: origin + "/ignored-prefix?query=ignored#fragment",
    action,
    input,
    token: "synthetic-token",
    ...options.client,
  };
  const observations = [];
  for (const run of [native, node]) {
    active = { payload, requests: [], committed: 0, ...options.http };
    const result = await run(spec);
    observations.push({ result, requests: active.requests });
  }
  assert.deepEqual(observations[0], observations[1], label);
  comparisons++;
  if (options.success !== undefined)
    assert.equal(observations[0].result.ok, options.success, label);
  if (options.calls !== undefined)
    assert.equal(observations[0].requests.length, options.calls, label);
  if (options.error)
    assert.match(observations[0].result.error, options.error, label);
  return observations[0];
}
try {
  await check(
    "open binding",
    "open",
    openInput,
    { binding },
    { success: true, calls: 1 },
  );
  await check(
    "binding provenance",
    "open",
    { ...openInput, provenance: { kind: "binding", bindingId: binding.id } },
    { binding },
    { success: true },
  );
  await check(
    "foreign binding refused",
    "open",
    openInput,
    { binding: { ...binding, threadId: "other" } },
    { success: false, error: /unrelated binding/ },
  );
  await check(
    "strict result wrapper",
    "open",
    openInput,
    { binding, extra: true },
    { success: false },
  );
  await check(
    "worker identity overrides input",
    "open",
    { ...openInput, workerId: "foreign" },
    { binding },
    { success: true },
  );
  await check(
    "resolve ordered identities",
    "resolve",
    resolveInput,
    { items: [mapping] },
    { success: true },
  );
  await check(
    "foreign mapping refused",
    "resolve",
    resolveInput,
    {
      items: [
        { ...mapping, identity: { ...mapping.identity, itemId: "other" } },
      ],
    },
    { success: false },
  );
  await check(
    "missing mapping refused",
    "resolve",
    resolveInput,
    { items: [] },
    { success: false },
  );
  await check(
    "mismatched preserved input refused",
    "resolve",
    resolveInput,
    {
      items: [
        {
          ...mapping,
          preservedInput: {
            id: "22222222-2222-4222-8222-222222222222",
            idempotencyKey: "reserved",
            classification: {
              role: "user",
              mode: "default",
              attachmentIds: [],
            },
            protectedContent: ingest.batch.items[0].message.protectedContent,
          },
        },
      ],
    },
    { success: false },
  );
  for (const action of ["open", "resolve"]) {
    const input = action === "open" ? openInput : resolveInput,
      payload = action === "open" ? { binding } : { items: [mapping] };
    const retry = await check(
      "bounded retry and token refresh " + action,
      action,
      input,
      payload,
      {
        http: { statuses: [503, 429, 408, 200] },
        client: { tokens: ["before-rotation", "after-rotation"] },
        success: true,
        calls: 4,
      },
    );
    assert.equal(
      new Set(retry.requests.map((v) => v.body)).size,
      1,
      "retry freezes the same metadata body",
    );
    assert.equal(retry.requests[1].authorization, "Bearer after-rotation");
    await check("network retry " + action, action, input, payload, {
      http: { disconnect: true },
      success: true,
      calls: 2,
    });
    await check(
      "permanent rejection " + action,
      action,
      input,
      { code: "foreign-binding", error: "private response text" },
      { http: { status: 409 }, success: false, calls: 1, error: /HTTP 409/ },
    );
  }
  await check("ingest correlated receipt", "ingest", ingest, receipt, {
    success: true,
    calls: 1,
  });
  await check(
    "ingest foreign receipt",
    "ingest",
    ingest,
    { ...receipt, digest: "b".repeat(64) },
    { success: false },
  );
  await check(
    "ingest does not retry server failures",
    "ingest",
    ingest,
    { code: "temporary" },
    { http: { status: 503 }, success: false, calls: 1 },
  );
  await check(
    "ordinary conflict is not rejection",
    "ingest",
    ingest,
    { code: "ordinary" },
    { http: { status: 409 }, success: false, calls: 1 },
  );
  const rejection = take("nativeHistoryBatchRejectionSchema");
  rejection.payloadDigest = nativeHistoryBatchPayloadDigest(
    ingest.batch,
    ingest.previousDigest,
  );
  const permanent = await check(
    "matched permanent rejection",
    "ingest",
    ingest,
    { code: rejection.code, rejection },
    { http: { status: 409 }, success: false, calls: 1 },
  );
  assert.equal(permanent.result.rejected, true);
  await check(
    "unrelated rejection refused",
    "ingest",
    ingest,
    {
      code: rejection.code,
      rejection: { ...rejection, recordId: receipt.commitId },
    },
    {
      http: { status: 409 },
      success: false,
      error: /unrelated batch rejection/,
    },
  );
  await check(
    "rejection code mismatch refused",
    "ingest",
    ingest,
    { code: "ordinary", rejection },
    { http: { status: 409 }, success: false },
  );
  await check("deliver preserves outbox identity", "deliver", {}, receipt, {
    client: {
      scope: { chatId: ingest.chatId, bindingId: ingest.bindingId },
      record: ingest,
      body: JSON.stringify(ingest.batch),
    },
    success: true,
  });
  for (const action of Object.keys(reads)) {
    await check("valid " + action, action, reads[action], pages[action], {
      success: true,
    });
    await check(
      "wrong binding " + action,
      action,
      reads[action],
      { ...pages[action], binding: { ...binding, id: "other" } },
      { success: false },
    );
    await check(
      "wrong pinned snapshot " + action,
      action,
      { ...reads[action], snapshotId: "f".repeat(64) },
      pages[action],
      { success: false },
    );
    await check(
      "wrong next cursor " + action,
      action,
      reads[action],
      {
        ...pages[action],
        nextCursor: { ...pages[action].nextCursor, snapshotId: "f".repeat(64) },
      },
      { success: false },
    );
    await check(
      "HTTP archive error remains structured " + action,
      action,
      reads[action],
      { code: "archive-snapshot-changed" },
      { http: { status: 409 }, success: false, calls: 1 },
    );
  }
  const outOfOrder = structuredClone(pages.archive);
  outOfOrder.items.push(outOfOrder.items[0]);
  await check(
    "duplicate archive key refused",
    "archive",
    reads.archive,
    outOfOrder,
    { success: false },
  );
  const backwards = structuredClone(pages.archiveTurns);
  backwards.turns = [
    { ...backwards.turns[0], bindingId: "\u{10000}" },
    { ...backwards.turns[0], bindingId: "\uE000" },
  ];
  backwards.nextCursor = null;
  await check(
    "turn order uses UTF-8 bytes",
    "archiveTurns",
    reads.archiveTurns,
    backwards,
    { success: false },
  );
  backwards.turns.reverse();
  await check(
    "UTF-8 order accepted despite UTF-16 reversal",
    "archiveTurns",
    reads.archiveTurns,
    backwards,
    { success: true },
  );
  const badDigest = structuredClone(pages.archiveBatches);
  badDigest.batches[0].payloadDigest = "f".repeat(64);
  await check(
    "archive payload digest verified",
    "archiveBatches",
    reads.archiveBatches,
    badDigest,
    { success: false },
  );
  const gap = structuredClone(pages.archiveBatches);
  gap.batches[0].receipt.sequence = 2;
  await check(
    "archive sequence gap refused",
    "archiveBatches",
    reads.archiveBatches,
    gap,
    { success: false },
  );
  await check(
    "legacy explicit missing source accepted",
    "archiveBatches",
    reads.archiveBatches,
    fixture.nativeHistoryBatchArchivePageSchema[1],
    { success: true },
  );
  await check("compressed BOM response", "ingest", ingest, receipt, {
    http: { gzip: true, bom: true },
    success: true,
  });
  await check("malformed success response", "ingest", ingest, null, {
    http: { raw: "private non-json body" },
    success: false,
    error: /Invalid input/,
  });
  await check("private HTTP failure body not echoed", "ingest", ingest, null, {
    http: { status: 502, raw: "private non-json body" },
    success: false,
    error: /HTTP 502/,
  });
  await check("redirect never followed", "ingest", ingest, null, {
    http: { status: 307 },
    success: false,
    calls: 1,
    error: /fetch failed/,
  });
  await check(
    "invalid redirect target is still a fetch failure",
    "ingest",
    ingest,
    null,
    {
      http: { status: 307, location: "http://[" },
      success: false,
      calls: 1,
      error: /fetch failed/,
    },
  );
  await check(
    "caller cancellation while waiting for headers",
    "ingest",
    ingest,
    receipt,
    {
      client: { callerAbortAfterMs: 50, callerReason: "actual caller stopped" },
      http: { hang: true },
      success: false,
      calls: 1,
      error: /actual caller stopped/,
    },
  );
  await check(
    "transport cancellation stops metadata retry",
    "open",
    openInput,
    { code: "temporary" },
    {
      client: {
        transportAbortAfterMs: 50,
        transportReason: "actual transport replaced",
      },
      http: { status: 503 },
      success: false,
      calls: 1,
      error: /The operation was aborted/,
    },
  );
  await check(
    "pre-aborted metadata does not dispatch",
    "open",
    openInput,
    { binding },
    {
      client: { callerAborted: true, callerReason: "already cancelled" },
      success: false,
      calls: 0,
    },
  );
  await check(
    "metadata lifetime does not cancel ordinary ingest",
    "ingest",
    ingest,
    receipt,
    { client: { transportAborted: true }, success: true, calls: 1 },
  );
  await check(
    "invalid request never dispatches",
    "resolve",
    { ...resolveInput, items: 513 },
    null,
    { success: false, calls: 0 },
  );
  await check("primitive spread validation matches", "open", "\uD800x", null, {
    success: false,
    calls: 0,
  });
  // Response abandonment leaves the owned metadata retry alive on the real socket.
  active = {
    payload: { binding },
    requests: [],
    committed: 0,
    statuses: [503, 200],
  };
  assert.deepEqual(
    await native({
      serverUrl: origin,
      action: "open",
      input: openInput,
      abandon: true,
    }),
    { ok: true, value: null },
  );
  const until = Date.now() + 3000;
  while (active.committed !== 1 && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    active.committed,
    1,
    "accepted metadata survives caller response abandonment",
  );
  assert.equal(active.requests.length, 2);
  comparisons++;
  console.log(
    JSON.stringify({
      status: "passed",
      comparisons,
      realLoopbackHttp: true,
      metadataRecovery: true,
      cancellation: true,
      abandonment: true,
      runtime: "macOS ARM64",
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  child.stdin.end();
  assert.equal(await completion, 0);
}
