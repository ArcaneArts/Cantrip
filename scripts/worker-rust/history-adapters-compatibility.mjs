// Real Node/native algorithms, opaque cross-opening, owned filesystem recovery.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  AttachmentStore,
  safeAttachmentFileName,
  MAX_ATTACHMENT_CHUNK_BYTES,
} from "../../cantrip_worker/src/attachment-store.ts";
import { NativeHistoryAttachmentStore } from "../../cantrip_worker/src/native-history-attachment-store.ts";
import { createNativeHistoryInputMaterializer } from "../../cantrip_worker/src/native-history-input-materializer.ts";
import { openWorkerAttachment } from "../../cantrip_worker/src/attachment-encryption.ts";
import {
  NativeHistoryTurnContextIndex,
  resolveNativeHistoryTurnContext,
} from "../../cantrip_worker/src/native-history-turn-context.ts";
import { parseCodexNativeHistory } from "../../cantrip_worker/src/codex/native-history.ts";
import { nativeHistoryWireFixtures } from "../server-rust/native-history-wire-fixtures.mjs";
import { createNativeHistoryProjectorAdapters } from "../../cantrip_worker/src/native-history-projector-adapters.ts";
import { NativeHistorySourceJournal } from "../../cantrip_worker/src/native-history-source-journal.ts";
import { createNativeHistoryProjector } from "../../cantrip_worker/src/native-history-projector.ts";
import { reduceNativeHistory } from "../../cantrip_worker/src/native-history-reducer.ts";
import { renderNativeHistoryItem } from "../../cantrip_worker/src/native-history-render.ts";
import { openMessage } from "../../cantrip_worker/src/chat-message-encryption.ts";
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
const wire = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
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
  return same(await native(input), expected, label);
}
const hash = (v) => createHash("sha256").update(v).digest("hex");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-history-adapters-"));
const service = {
  ownerId: () => "owner",
  serverIdentity: () => "server",
  componentKey: () => ({ key: new Uint8Array(32).fill(1), keyRevision: 1 }),
};
const binding = nativeHistoryWireFixtures("2026-11-17T00:00:00Z")
  .nativeHistoryBindingSchema[0];
const identity = {
  threadId: binding.threadId,
  turnId: "turn",
  itemId: "input",
  identityKind: "canonical",
  component: "user",
};
try {
  for (const value of [
    "",
    ".",
    "../../a.txt",
    "..\\folder\\note.txt",
    "  .. x  y  ",
    "\0\t.hidden\u007f",
    "ＡＢＣ①.txt",
    "c:folder",
    "trailing/",
    "😀 /💚.png",
    "é漢字９.png",
    "a\ud800b",
    "\u{10400}".repeat(91),
    "x".repeat(179) + "\u{10400}",
    "[]() _- .txt",
  ]) {
    same(
      await result({ op: "adapters.filename", value }),
      safeAttachmentFileName(value),
      "safe filename",
    );
  }
  const nodeData = path.join(root, "ordinary-node"),
    dataDirectory = path.join(root, "ordinary-native");
  const files = new AttachmentStore(nodeData);
  const chatId = "chat",
    attachmentId = "file",
    operationId = "upload",
    fileName = "..\\safe note.txt";
  const bytes = Buffer.from("attachment upload bytes"),
    sha256 = hash(bytes);
  const base = { dataDirectory, chatId, attachmentId, operationId, fileName };
  const file = (op, extra, call) =>
    compare(
      { op: `adapters.file.${op}`, ...base, ...extra },
      call,
      `ordinary ${op}`,
    );
  await file("begin", { sizeBytes: -1, sha256 }, () =>
    files.begin(chatId, attachmentId, fileName, -1, operationId, sha256),
  );
  await file("begin", { sizeBytes: bytes.length, sha256 }, () =>
    files.begin(
      chatId,
      attachmentId,
      fileName,
      bytes.length,
      operationId,
      sha256,
    ),
  );
  await file("begin", { sizeBytes: bytes.length, sha256 }, () =>
    files.begin(
      chatId,
      attachmentId,
      fileName,
      bytes.length,
      operationId,
      sha256,
    ),
  );
  for (const [chunkIndex, part, eof, op] of [
    [1, bytes, false, operationId],
    [0, bytes, true, "other"],
    [0, bytes, false, operationId],
  ])
    await file(
      "append",
      { chunkIndex, bytes: part.toString("base64"), eof, operationId: op },
      () => files.append(chatId, attachmentId, chunkIndex, part, op, eof),
    );
  await file("complete", {}, () =>
    files.complete(chatId, attachmentId, operationId),
  );
  await file(
    "append",
    {
      chunkIndex: 0,
      bytes: bytes.subarray(0, 4).toString("base64"),
      eof: false,
    },
    () =>
      files.append(
        chatId,
        attachmentId,
        0,
        bytes.subarray(0, 4),
        operationId,
        false,
      ),
  );
  await file(
    "append",
    { chunkIndex: 1, bytes: bytes.subarray(4).toString("base64"), eof: true },
    () =>
      files.append(
        chatId,
        attachmentId,
        1,
        bytes.subarray(4),
        operationId,
        true,
      ),
  );
  await file("append", { chunkIndex: 2, bytes: "", eof: true }, () =>
    files.append(chatId, attachmentId, 2, Buffer.alloc(0), operationId, true),
  );
  await file("complete", {}, () =>
    files.complete(chatId, attachmentId, operationId),
  );
  for (const [offset, limit] of [
    [0, 4],
    [4, 100],
    [1e30, 1],
    [-1, 1],
    [0, MAX_ATTACHMENT_CHUNK_BYTES + 1],
  ]) {
    await file("read", { offset, limit }, async () => {
      const v = await files.read(chatId, attachmentId, fileName, offset, limit);
      return { ...v, bytes: Buffer.from(v.bytes).toString("base64") };
    });
  }
  await file("begin", { sizeBytes: 0, sha256: hash("") }, () =>
    files.begin(chatId, attachmentId, fileName, 0, operationId, hash("")),
  );
  await file("complete", {}, () =>
    files.complete(chatId, attachmentId, operationId),
  );
  await file("abort", { operationId: "other" }, () =>
    files.abort(chatId, attachmentId, "other"),
  );
  await file("abort", {}, () => files.abort(chatId, attachmentId, operationId));
  const retained = await result({
    op: "adapters.file.read",
    ...base,
    offset: 0,
    limit: 100,
    reopen: true,
  });
  same(
    retained.bytes,
    bytes.toString("base64"),
    "abort retains completed bytes",
  );
  await file("begin", { sizeBytes: 1, sha256: "wrong" }, () =>
    files.begin(chatId, attachmentId, fileName, 1, operationId, "wrong"),
  );
  await file("append", { chunkIndex: 0, bytes: "AQ==", eof: true }, () =>
    files.append(chatId, attachmentId, 0, Buffer.from([1]), operationId, true),
  );
  await file("complete", {}, () =>
    files.complete(chatId, attachmentId, operationId),
  );
  await file("remove", {}, () => files.remove(chatId, attachmentId));
  await file(
    "begin",
    { chatId: "../escape", sizeBytes: 0, sha256: hash("") },
    () =>
      files.begin(
        "../escape",
        attachmentId,
        fileName,
        0,
        operationId,
        hash(""),
      ),
  );

  await file("read", { offset: 0, limit: 1 }, () =>
    new AttachmentStore(dataDirectory).read(
      chatId,
      attachmentId,
      fileName,
      0,
      1,
    ),
  );
  const nodeHistory = path.join(root, "history-node"),
    nativeHistory = path.join(root, "history-native");
  const nodeFiles = new AttachmentStore(nodeHistory);
  const historyStore = () =>
    new NativeHistoryAttachmentStore({
      directory: path.join(nodeHistory, "metadata"),
      binding,
      service,
      attachments: nodeFiles,
    });
  const material = {
    identity,
    partIndex: 1,
    fileName: "private-note.txt",
    mimeType: "text/plain",
    kind: "text",
    bytes: Buffer.from("PRIVATE_ATTACHMENT_BYTES"),
  };
  const expected = await historyStore().materialize(material);
  const request = {
    op: "adapters.attachment",
    directory: path.join(nativeHistory, "metadata"),
    dataDirectory: nativeHistory,
    binding,
    input: { ...material, bytes: material.bytes.toString("base64") },
  };
  const candidate = await result(request);
  same(
    candidate.attachment.id,
    expected.attachment.id,
    "stable native attachment identity",
  );
  same(
    await result({ op: "adapters.open", attachment: candidate.attachment }),
    await openWorkerAttachment(candidate.attachment, service),
    "native metadata cross-open",
  );
  const adopted = await result({
    ...request,
    input: { ...request.input, publishedAttachment: expected.attachment },
  });
  same(
    adopted,
    expected,
    "adopt exact committed descriptor over local candidate",
  );
  same(await result(request), expected, "published descriptor wins on restart");
  const nativeFiles = new AttachmentStore(nativeHistory);
  const reopened = new NativeHistoryAttachmentStore({
    directory: request.directory,
    binding,
    service,
    attachments: nativeFiles,
  });
  same(
    await reopened.materialize(material),
    expected,
    "Node reopens native immutable manifest",
  );
  const manifest = path.join(
    request.directory,
    hash(JSON.stringify(["server", "owner", binding.workerId, binding.chatId])),
    expected.attachment.id,
    "attachment.json",
  );
  const savedManifest = await readFile(manifest);
  await writeFile(manifest, "{broken");
  await compare(
    request,
    () => reopened.materialize(material),
    "malformed retained manifest fails without replacement",
  );
  same(
    (await readFile(manifest)).toString(),
    "{broken",
    "damaged manifest remains available for recovery",
  );
  await writeFile(manifest, savedManifest);
  const disk = nativeFiles.resolve(
    binding.chatId,
    expected.attachment.id,
    material.fileName,
  );
  for (const corrupt of [false, true]) {
    if (corrupt) await writeFile(disk, "corrupt");
    else await rm(disk);
    same(await result(request), expected, "restore exact attachment bytes");
    same(
      (await readFile(disk)).toString("base64"),
      material.bytes.toString("base64"),
      "flushed attachment payload",
    );
  }
  const changed = {
    ...request.input,
    publishedAttachment: {
      ...expected.attachment,
      createdAt: "2000-01-01T00:00:00.000Z",
    },
  };
  await compare(
    { ...request, input: changed },
    () =>
      reopened.materialize({
        ...material,
        publishedAttachment: changed.publishedAttachment,
      }),
    "published ciphertext is immutable",
  );
  for (const payload of [
    Buffer.alloc(0),
    Buffer.alloc(MAX_ATTACHMENT_CHUNK_BYTES + 7, 17),
  ]) {
    const input = {
      ...material,
      partIndex: payload.length + 2,
      bytes: payload,
    };
    const value = await result({
      ...request,
      op: "adapters.concurrent",
      input: { ...input, bytes: payload.toString("base64") },
    });
    same(value[0], value[1], "concurrent stores share immutable descriptor");
    const node = await historyStore().materialize(input);
    same(
      value[0].attachment.id,
      node.attachment.id,
      "empty/multichunk identity",
    );
  }
  const relocated = {
    ...request,
    binding: { ...binding, id: randomUUID(), workerId: randomUUID() },
    directory: path.join(root, "relocated", "metadata"),
    dataDirectory: path.join(root, "relocated"),
  };
  same(
    await result({
      ...relocated,
      input: { ...request.input, publishedAttachment: expected.attachment },
    }),
    expected,
    "committed metadata relocates across worker and binding",
  );

  const turn = { id: "turn", metadata: null };
  const item = (body, id = "input") => ({
    id,
    identityKind: "canonical",
    body,
  });
  const mediaNode = path.join(root, "media-node"),
    mediaNative = path.join(root, "media-native");
  const mediaFiles = new AttachmentStore(mediaNode);
  const mediaOptions = {
    directory: path.join(mediaNode, "parts"),
    binding,
    service,
    files: mediaFiles,
    store: new NativeHistoryAttachmentStore({
      directory: path.join(mediaNode, "metadata"),
      binding,
      service,
      attachments: mediaFiles,
    }),
  };
  const materialize = createNativeHistoryInputMaterializer(mediaOptions);
  const mediaBase = {
    op: "adapters.media",
    directory: mediaNative,
    dataDirectory: mediaNative,
    binding,
    turn,
    context: { cwd: root },
  };
  async function media(source) {
    const value = await materialize(source, turn, { cwd: root });
    const expected = {
      inputParts: Object.fromEntries(value.inputParts),
      attachments: value.attachments,
      publishedCalls: 0,
    };
    return same(
      await result({
        ...mediaBase,
        item: source,
        publishedAttachments: value.attachments,
      }),
      expected,
      "actual native media materialization",
    );
  }
  await media(
    item({
      type: "userMessage",
      content: [
        { type: "text", text: "before" },
        { type: "image", url: "data:image/png;base64,AQID" },
        { type: "audio", url: "data:audio/wav;base64,BAUG" },
        { type: "skill", name: "safe", path: "/reference" },
        { type: "image", url: "https://example.invalid/no-fetch" },
      ],
    }),
  );
  await media(
    item(
      {
        type: "functionCallOutput",
        output: [
          { type: "input_text", text: "before" },
          { type: "input_image", image_url: "data:image/png;base64,AQID" },
          { type: "input_audio", audio_url: "data:audio/wav;base64,BAUG" },
          { type: "localImage", path: "never-open" },
        ],
      },
      "tool",
    ),
  );
  const generated = item(
    { type: "imageGeneration", result: "AQID", savedPath: "never-open" },
    "generated",
  );
  const generatedValue = await media(generated);
  await rm(path.join(mediaNative, "parts"), { recursive: true });
  same(
    await result({
      ...mediaBase,
      item: generated,
      publishedAttachments: generatedValue.attachments,
    }),
    generatedValue,
    "archive descriptor restores after media manifest loss",
  );
  const callback = await result({
    ...mediaBase,
    item: item(
      {
        type: "userMessage",
        content: [
          { type: "image", url: "data:image/png;base64,AQID" },
          { type: "audio", url: "data:audio/wav;base64,BAUG" },
        ],
      },
      "callback",
    ),
    callbackAttachments: [],
  });
  same(callback.publishedCalls, 1, "one lazy archive lookup per item");
  same(
    (
      await result({
        ...mediaBase,
        item: item(
          {
            type: "userMessage",
            content: [
              { type: "image", url: "https://example.invalid/ignored" },
            ],
          },
          "remote",
        ),
        callbackAttachments: [],
      })
    ).publishedCalls,
    0,
    "remote media causes no archive lookup or fetch",
  );
  await media(
    item(
      {
        type: "userMessage",
        content: [{ type: "image", url: "data:image/\ud800;base64,AQID" }],
      },
      "utf16-mime",
    ),
  );
  const localPath = path.join(root, "original.png");
  await writeFile(localPath, Buffer.from([8, 9, 10]));
  const localItem = item(
    {
      type: "userMessage",
      content: [{ type: "localImage", path: "original.png" }],
    },
    "local",
  );
  const localValue = await media(localItem);
  await writeFile(localPath, "changed source");
  same(
    await result({ ...mediaBase, item: localItem }),
    localValue,
    "retained local media survives source edits",
  );
  const opened = await openWorkerAttachment(localValue.attachments[0], service);
  await rm(
    new AttachmentStore(mediaNative).resolve(
      binding.chatId,
      opened.id,
      opened.fileName,
    ),
  );
  await rm(mediaFiles.resolve(binding.chatId, opened.id, opened.fileName));
  await compare(
    { ...mediaBase, item: localItem },
    () => materialize(localItem, turn, { cwd: root }),
    "missing retained bytes never adopt changed local source",
  );
  for (const [index, part] of [
    { type: "image", url: "data:image/png;base64,AQ" },
    { type: "image", url: "data:audio/wav;base64,AQID" },
    { type: "image", url: "data:image/png;base64,@@@" },
    { type: "localImage", path: "" },
    { type: "audio" },
  ].entries()) {
    const source = item(
      { type: "userMessage", content: [part] },
      `invalid-${index}`,
    );
    await compare(
      { ...mediaBase, item: source },
      () => materialize(source, turn, { cwd: root }),
      "invalid media matches actual worker error",
    );
  }
  const huge = path.join(root, "huge.wav");
  await writeFile(huge, "");
  await truncate(huge, 25 * 1024 * 1024 + 1);
  const hugeItem = item(
    { type: "userMessage", content: [{ type: "localAudio", path: huge }] },
    "huge",
  );
  await compare(
    { ...mediaBase, item: hugeItem },
    () => materialize(hugeItem, turn, { cwd: root }),
    "actual read enforces media budget",
  );
  const folderItem = item(
    { type: "userMessage", content: [{ type: "localImage", path: root }] },
    "folder",
  );
  await compare(
    { ...mediaBase, item: folderItem },
    () => materialize(folderItem, turn, { cwd: root }),
    "opened media must be a regular file",
  );

  if (process.platform !== "win32") {
    const fifo = path.join(root, "media-fifo");
    await promisify(execFile)("mkfifo", [fifo]);
    const fifoItem = item(
      { type: "userMessage", content: [{ type: "localImage", path: fifo }] },
      "fifo",
    );
    await compare(
      { ...mediaBase, item: fifoItem },
      () => materialize(fifoItem, turn, { cwd: root }),
      "FIFO opens nonblocking and is rejected as nonregular",
    );
  }
  const context = {
    cwd: root,
    model: "model",
    collaborationMode: "plan",
    reasoningEffort: "high",
    rootTurnId: "turn",
  };
  const snapshot = (
    sequence,
    contexts = [context],
    thread = { id: binding.threadId },
  ) => ({
    sequence,
    recordId: randomUUID(),
    frame: {
      kind: "snapshot",
      threadId: binding.threadId,
      snapshot: { thread, history: { turns: [{ turnId: "turn", contexts }] } },
    },
  });
  const records = Array.from({ length: 513 }, (_, i) =>
    snapshot(i + 1, i === 512 ? [context] : []),
  );
  const later = snapshot(514, [{ ...context, cwd: path.join(root, "later") }]);
  const nodeRecords = structuredClone(records),
    trace = [];
  let append = true;
  const source = {
    scope: { threadId: binding.threadId },
    head: async () => {
      trace.push(["head"]);
      return {
        sequence: nodeRecords.length,
        recordId: nodeRecords.at(-1)?.recordId ?? null,
      };
    },
    read: async (after, limit) => {
      trace.push(["read", after, limit]);
      const page = structuredClone(nodeRecords.slice(after, after + limit));
      if (append) {
        append = false;
        nodeRecords.push(later);
      }
      return page;
    },
  };
  const index = new NativeHistoryTurnContextIndex(source);
  await result({
    op: "adapters.index.open",
    config: { scope: source.scope, records, appendDuringRead: later },
  });
  await index.refresh();
  same(
    await result({ op: "adapters.index.refresh" }),
    trace,
    "finite head with 512 record pages",
  );
  same(
    await result({ op: "adapters.index.read", turn }),
    index.read(turn),
    "retained context beyond current projection page",
  );
  await index.refresh();
  same(
    await result({ op: "adapters.index.refresh" }),
    trace,
    "incremental context index",
  );
  await compare(
    { op: "adapters.context.resolve", contexts: index.read(turn) },
    () => resolveNativeHistoryTurnContext(index.read(turn)),
    "conflicting presentation scope",
  );
  for (const contexts of [
    [],
    [context],
    [context, { ...context, model: "other", reasoningEffort: null }],
    [{ ...context, cwd: "relative" }],
    [{ ...context, collaborationMode: null }],
    [{ ...context, collaborationMode: "future" }],
    [context, { ...context, rootTurnId: "other" }],
  ])
    await compare(
      { op: "adapters.context.resolve", contexts },
      () => resolveNativeHistoryTurnContext(contexts),
      "retained context resolution",
    );
  await compare(
    {
      op: "adapters.index.read",
      turn: { id: "turn", metadata: { turnId: "other" } },
    },
    () => index.read({ id: "turn", metadata: { turnId: "other" } }),
    "foreign turn metadata",
  );
  await result({
    op: "adapters.index.open",
    handle: "retry",
    config: {
      scope: source.scope,
      records: [records[0]],
      readErrorOnce: "source I/O failed",
    },
  });
  same(
    await native({ op: "adapters.index.refresh", handle: "retry" }),
    { ok: false, error: "source I/O failed" },
    "failed refresh propagates",
  );
  same(
    await result({ op: "adapters.index.refresh", handle: "retry" }),
    [["head"], ["read", 0, 1], ["head"], ["read", 0, 1]],
    "failed refresh releases its queue for retry",
  );
  const childThread = {
    id: binding.threadId,
    parentThreadId: "parent",
    agentNickname: "first",
    source: {
      subAgent: {
        thread_spawn: { agent_path: " root / child > nested ", depth: 2 },
      },
    },
  };
  const childRecords = [
    snapshot(1, [context], childThread),
    snapshot(2, [context], { ...childThread, agentNickname: "latest" }),
  ];
  const childSource = {
    scope: source.scope,
    head: async () => ({
      sequence: childRecords.length,
      recordId: childRecords.at(-1).recordId,
    }),
    read: async (a, n) => childRecords.slice(a, a + n),
  };
  const childIndex = new NativeHistoryTurnContextIndex(childSource);
  await childIndex.refresh();
  await result({
    op: "adapters.index.open",
    handle: "child",
    config: { scope: source.scope, records: childRecords },
  });
  await result({ op: "adapters.index.refresh", handle: "child" });
  same(
    await result({
      op: "adapters.index.child",
      handle: "child",
      parent: "parent",
    }),
    childIndex.childMetadata("parent"),
    "latest labels preserve bound parent",
  );
  await compare(
    { op: "adapters.index.child", handle: "child", parent: "foreign" },
    () => childIndex.childMetadata("foreign"),
    "foreign parent rejected",
  );

  const retainedSnapshot = parseCodexNativeHistory(
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
            warnings: [],
            errors: [],
          },
        ],
      },
    },
    binding.threadId,
  );
  await result({
    op: "open",
    handle: "verified",
    directory: path.join(root, "source"),
    workerId: binding.workerId,
    chatId: binding.chatId,
    bindingId: binding.id,
    threadId: binding.threadId,
  });
  await result({
    op: "append",
    handle: "verified",
    frame: {
      kind: "snapshot",
      id: randomUUID(),
      threadId: binding.threadId,
      generation: "runtime",
      readBarrierSequence: 0,
      completedSequence: 0,
      receivedAtMs: 1,
      snapshot: retainedSnapshot,
    },
  });
  const verifiedBase = {
    op: "adapters.verified",
    source: "verified",
    directory: path.join(root, "verified"),
    dataDirectory: path.join(root, "verified-files"),
    binding,
    turn,
    item: {},
    draft: { identity: { identityKind: "canonical", component: "assistant" } },
  };
  same(
    await result(verifiedBase),
    { context: { cwd: root, mode: "plan" }, association: { kind: "output" } },
    "real encrypted source supplies verified projector context",
  );
  same(
    await native({
      ...verifiedBase,
      binding: { ...binding, workerId: randomUUID() },
    }),
    {
      ok: false,
      error:
        "Native history adapters require the exact authorized source binding.",
    },
    "binding mismatch cannot read context as authorization",
  );
  const nodeSource = await NativeHistorySourceJournal.open({
    directory: path.join(root, "source"),
    workerId: binding.workerId,
    chatId: binding.chatId,
    bindingId: binding.id,
    threadId: binding.threadId,
    service,
  });
  async function verifiedExpected(source, bound, extra = {}) {
    const adapter = createNativeHistoryProjectorAdapters({
      directory: path.join(root, "node-verified"),
      binding: bound,
      source,
      service,
      attachments: mediaFiles,
      ...extra,
    });
    await adapter.prepare();
    return {
      context: await adapter.context({}, turn),
      association: await adapter.associate(verifiedBase.draft, turn),
    };
  }
  same(
    await result(verifiedBase),
    await verifiedExpected(nodeSource, binding),
    "verified adapter matches real Node adapter over native source",
  );
  const childBinding = {
    ...binding,
    id: randomUUID(),
    ancestorThreadIds: ["root-parent", "parent"],
  };
  const childSnapshot = structuredClone(retainedSnapshot);
  childSnapshot.thread = { ...childSnapshot.thread, ...childThread };
  childSnapshot.history.turns[0].contexts = [
    { ...context, rootTurnId: "root-turn" },
  ];
  await result({
    op: "open",
    handle: "verified-child",
    directory: path.join(root, "source"),
    workerId: binding.workerId,
    chatId: binding.chatId,
    bindingId: childBinding.id,
    threadId: binding.threadId,
  });
  const childFrame = {
    kind: "snapshot",
    id: randomUUID(),
    threadId: binding.threadId,
    generation: "runtime",
    readBarrierSequence: 0,
    completedSequence: 0,
    receivedAtMs: 1,
    snapshot: childSnapshot,
  };
  await result({ op: "append", handle: "verified-child", frame: childFrame });
  const childJournal = await NativeHistorySourceJournal.open({
    directory: path.join(root, "source"),
    workerId: binding.workerId,
    chatId: binding.chatId,
    bindingId: childBinding.id,
    threadId: binding.threadId,
    service,
  });
  const childRequest = {
    ...verifiedBase,
    source: "verified-child",
    binding: childBinding,
  };
  const scoped = await verifiedExpected(childJournal, childBinding);
  same(
    await result(childRequest),
    scoped,
    "bound ancestry and retained child labels construct scope",
  );
  const foreignScope = {
    ...scoped.context.agentScope,
    agentThreadId: "foreign",
  };
  await compare(
    { ...childRequest, childScope: foreignScope },
    () =>
      verifiedExpected(childJournal, childBinding, {
        childScope: async () => foreignScope,
      }),
    "custom scope cannot change bound child thread",
  );
  await compare(
    { ...verifiedBase, binding: { ...binding, ancestorThreadIds: ["parent"] } },
    () =>
      verifiedExpected(nodeSource, {
        ...binding,
        ancestorThreadIds: ["parent"],
      }),
    "child cannot use its own turn as root",
  );
  childSnapshot.thread.parentThreadId = "foreign";
  await result({
    op: "append",
    handle: "verified-child",
    frame: {
      ...childFrame,
      id: randomUUID(),
      receivedAtMs: 2,
      snapshot: childSnapshot,
    },
  });
  await compare(
    childRequest,
    () => verifiedExpected(childJournal, childBinding),
    "later child labels cannot erase conflicting parent evidence",
  );
  const one = snapshot(1, [context]);
  for (const [label, config, error] of [
    [
      "boundary",
      { records: [one], headOnce: { sequence: 1, recordId: randomUUID() } },
      "Native history context boundary changed identity.",
    ],
    [
      "missing",
      { records: [one], missing: true },
      "Native history context boundary is missing records.",
    ],
    [
      "gap",
      { records: [{ ...one, sequence: 2 }] },
      "Native history context evidence has a sequence gap.",
    ],
    [
      "thread",
      { records: [{ ...one, frame: { ...one.frame, threadId: "foreign" } }] },
      "Native history context belongs to another thread.",
    ],
  ]) {
    await result({
      op: "adapters.index.open",
      handle: label,
      config: { scope: source.scope, ...config },
    });
    same(
      await native({ op: "adapters.index.refresh", handle: label }),
      { ok: false, error },
      "context integrity " + label,
    );
  }
  await result({
    op: "identity",
    state: { owner: "owner", server: "server", revision: 2 },
  });
  await compare(
    { op: "adapters.open", attachment: expected.attachment },
    () =>
      openWorkerAttachment(expected.attachment, {
        ...service,
        componentKey: () => ({
          key: new Uint8Array(32).fill(2),
          keyRevision: 2,
        }),
      }),
    "attachment open requires current grant revision",
  );
  await result({
    op: "identity",
    state: { owner: "owner", server: "server", revision: 1 },
  });
  const mediaSnapshot = structuredClone(retainedSnapshot);
  mediaSnapshot.thread.turns = [
    {
      id: "turn",
      status: "completed",
      items: [
        {
          id: "projected-input",
          type: "userMessage",
          content: [{ type: "image", url: "data:image/png;base64,AQID" }],
        },
      ],
      startedAt: 1,
      completedAt: 2,
    },
  ];
  mediaSnapshot.history.turns[0].items = [
    {
      itemId: "projected-input",
      state: "completed",
      startedAtMs: 1000,
      completedAtMs: 2000,
    },
  ];
  await result({
    op: "append",
    handle: "verified",
    frame: {
      kind: "snapshot",
      id: randomUUID(),
      threadId: binding.threadId,
      generation: "runtime",
      readBarrierSequence: 0,
      completedSequence: 0,
      receivedAtMs: 2,
      snapshot: parseCodexNativeHistory(mediaSnapshot, binding.threadId),
    },
  });
  const projectionRecords = await nodeSource.read(0, 512);
  const reduced = reduceNativeHistory(
    undefined,
    projectionRecords,
    binding.threadId,
  );
  const mappings = [];
  for (const retainedTurn of reduced.turns)
    for (const retainedItem of retainedTurn.items)
      for (const draft of renderNativeHistoryItem(retainedItem, {
        cwd: root,
        mode: "plan",
        threadId: binding.threadId,
        turnId: retainedTurn.id,
      })) {
        const key = hash(JSON.stringify(draft.identity));
        mappings.push({
          key,
          identity: draft.identity,
          messageId: randomUUID(),
          idempotencyKey: `native:${key}`,
          preservedInput: null,
        });
      }
  const projectedDirectory = path.join(root, "projected-media");
  const verifiedMedia = createNativeHistoryProjectorAdapters({
    directory: projectedDirectory,
    binding,
    source: nodeSource,
    service,
    attachments: new AttachmentStore(path.join(projectedDirectory, "files")),
  });
  const expectedProjection = await createNativeHistoryProjector({
    binding,
    service,
    ...verifiedMedia,
    client: {
      resolve: async (request) =>
        request.items.map((item) =>
          mappings.find(
            (v) => JSON.stringify(v.identity) === JSON.stringify(item.identity),
          ),
        ),
    },
  })(projectionRecords, null);
  const actualProjection = await result({
    op: "projector.run",
    handle: "verified",
    records: projectionRecords,
    previous: null,
    config: {
      binding,
      mappings,
      nativeAdapters: { directory: projectedDirectory },
    },
  });
  assert.equal(actualProjection.error, undefined, actualProjection.error);
  same(
    actualProjection.state,
    expectedProjection.state,
    "complete native verified-media projector state",
  );
  assert.equal(actualProjection.batches[0].items.length, 1);
  const messages = async (batches) =>
    Promise.all(
      batches.flatMap((batch) =>
        batch.items.map((item) =>
          openMessage({
            message: item.message,
            componentKey: new Uint8Array(32).fill(1),
            ownerId: "owner",
          }),
        ),
      ),
    );
  const projectedContent = await messages(actualProjection.batches);
  same(
    projectedContent,
    await messages(expectedProjection.batches),
    "native materialized media reaches authenticated canonical message",
  );
  assert.ok(JSON.stringify(projectedContent).includes('"type":"attachment"'));
  const report = {
    comparisons,
    nativeChildrenWithoutNode: true,
    actualFiles: true,
    opaqueCrossOpening: true,
    finiteContextIndex: true,
    verifiedEncryptedSource: true,
  };
  console.log(JSON.stringify(report));
} finally {
  child.stdin.end();
  assert.equal(await finished, 0);
  await rm(root, { recursive: true, force: true });
}
