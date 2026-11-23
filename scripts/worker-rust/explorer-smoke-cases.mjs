// Real server routing -> production Rust worker -> private outcomes and files.
// Receives only the disposable workspace-smoke profile and synthetic account.
import assert from "node:assert/strict";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";

export function assertSurfaceGrantRefresh(result) {
  assert.equal(result.status, 200, JSON.stringify(result));
}

export async function verifyExplorer({
  call,
  serverId,
  ownerId,
  surfaceKey,
  metadataKey,
  projectId,
  workerId,
  checkout,
  binary,
  fileImports,
}) {
  const explorerId = crypto.randomUUID(),
    documentId = crypto.randomUUID();
  const state = (resource, resourceId, recordKind, content) =>
    c.encryptSurfacePrivateState({
      ownerId,
      context: {
        serverId,
        resource,
        resourceId,
        operationId: null,
        recordKind,
      },
      keyRevision: 1,
      componentKey: surfaceKey,
      content,
    });
  const stateProtection = await state(
    "explorer-row",
    explorerId,
    "explorer-state",
    {
      version: 1,
      classification: { recordKind: "explorer-state" },
      selectedPath: null,
    },
  );
  const titleProtection = await c.encryptPrivateDisplayLabel({
    ownerId,
    recordKind: "explorer",
    rowId: explorerId,
    keyRevision: 1,
    componentKey: metadataKey,
    label: "Native Explorer",
  });
  const created = await call("POST", `/api/projects/${projectId}/explorers`, {
    id: explorerId,
    titleProtection,
    stateProtection,
    attachToTabLayout: false,
  });
  assert.equal(created.status, 201, JSON.stringify(created));
  const binding = { projectId, workerId, worktreeId: created.body.worktreeId };
  assert.equal(created.body.activeWorkerId, workerId);
  async function operation(kind, id, request, options = {}) {
    const operationId = options.operationId ?? crypto.randomUUID(),
      sequence = options.sequence ?? 0;
    const context = {
      serverId,
      surfaceKind: kind,
      surfaceId: id,
      operationId,
      direction: "request",
      sequence,
    };
    const schema =
      kind === "chat-files"
        ? p.chatFileReferencesRequestContentSchema
        : p.explorerOperationRequestContentSchema;
    const plaintext = new TextEncoder().encode(
      JSON.stringify(schema.parse(request)),
    );
    let protectedRequest;
    try {
      protectedRequest = await c.encryptSurfaceStreamPayload({
        ownerId,
        context,
        keyRevision: 1,
        componentKey: surfaceKey,
        plaintext,
      });
    } finally {
      plaintext.fill(0);
    }
    const body = {
      operationId,
      sequence,
      protectedRequest,
      ...(kind === "explorer" ? { binding } : {}),
    };
    const route =
      kind === "chat-files"
        ? `/api/chats/${id}/file-references`
        : kind === "explorer"
          ? `/api/explorers/${id}/operation`
          : `/api/file-documents/${id}/operation`;
    const result = await call("POST", route, body);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(
      JSON.stringify(result.body).includes(checkout),
      false,
      "private checkout stays out of the server response",
    );
    const bytes = await c.decryptSurfaceStreamPayload({
      ownerId,
      context: { ...context, direction: "response" },
      keyRevision: 1,
      componentKey: surfaceKey,
      opaque: result.body.protectedResponse,
    });
    let outcome;
    try {
      outcome = p.surfaceOperationOutcomeContentSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } finally {
      bytes.fill(0);
    }
    return { outcome, route, body };
  }
  const explore = async (request) =>
    (await operation("explorer", explorerId, request)).outcome;
  const listing = await explore({ type: "explorer.directory.list", path: "" });
  assert.equal(listing.ok, true);
  assert.ok(
    listing.result.value.entries.some((e) => e.name === "untouched.txt"),
  );
  if (fileImports) {
    const { verifyHostFileImports } =
      await import("./explorer-import-smoke.mjs");
    await verifyHostFileImports({
      checkout,
      send: async (request, options) =>
        (await operation("explorer", explorerId, request, options)).outcome,
      restartWorker: fileImports.restartWorker,
    });
    const chatId = crypto.randomUUID();
    const chat = await call("POST", `/api/projects/${projectId}/chats`, {
      id: chatId,
      worktreeId: binding.worktreeId,
      attachToTabLayout: false,
      titleProtection: await c.encryptPrivateDisplayLabel({
        ownerId,
        recordKind: "chat",
        rowId: chatId,
        keyRevision: 1,
        componentKey: metadataKey,
        label: "Host references",
      }),
    });
    assert.equal(chat.status, 201, JSON.stringify(chat));
    const references = [
      ".",
      "drop",
      "untouched.txt#L5C3",
      pathToFileURL(path.join(checkout, "root.bin")).href,
      "external",
      "missing",
      "missing-\ud800.txt",
    ];
    const { outcome } = await operation("chat-files", chatId, {
      type: "chat.files.references",
      references,
    });
    const { chatFileReferences } =
      await import("../../tests/reference-node-worker/src/chat-file-references.ts");
    assert.deepEqual(outcome, {
      ok: true,
      result: {
        type: "chat.files.references",
        value: await chatFileReferences(checkout, references),
      },
    });
    return;
  }
  const file = "native-explorer.md";
  const newFile = await explore({
    type: "explorer.file.create",
    path: "",
    name: file,
  });
  assert.equal(newFile.ok, true, JSON.stringify(newFile));
  const read = await explore({ type: "explorer.file.read", path: file });
  assert.equal(read.ok, true);
  const wrote = await explore({
    type: "explorer.file.write",
    path: file,
    content: "\ufeffnative Explorer\n",
    version: read.result.value.version,
  });
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  assert.equal(
    await readFile(path.join(checkout, file), "utf8"),
    "\ufeffnative Explorer\n",
  );
  const conflict = await explore({
    type: "explorer.file.write",
    path: file,
    content: "stale",
    version: read.result.value.version,
  });
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /changed on disk/);
  const search = await explore({
    type: "explorer.files.search",
    query: "native-explorer",
    limit: 10,
  });
  assert.equal(search.ok, true);
  assert.ok(search.result.value.results.some((e) => e.path === file));
  const traversal = await explore({
    type: "explorer.file.read",
    path: "../outside",
  });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.error, "Explorer path traversal is not allowed.");
  const duplicate = await operation("explorer", explorerId, {
    type: "explorer.file.read",
    path: file,
  });
  const replay = await call("POST", duplicate.route, duplicate.body);
  assert.equal(replay.status, 502);
  assert.match(replay.body.error, /already completed/);
  const docPath = "native-document.txt";
  await writeFile(path.join(checkout, docPath), "document before\n");
  const location = {
    version: 1,
    classification: { recordKind: "file-document-state" },
    ...binding,
    path: docPath,
  };
  const document = await call(
    "POST",
    `/api/projects/${projectId}/file-documents`,
    {
      id: documentId,
      worktreeId: binding.worktreeId,
      stateProtection: await state(
        "file-document-row",
        documentId,
        "file-document-state",
        location,
      ),
    },
  );
  assert.equal(document.status, 200, JSON.stringify(document));
  assert.equal(
    JSON.stringify(document.body).includes(docPath),
    false,
    "document location stays encrypted",
  );
  const documentRead = await operation("file-document", documentId, {
    type: "explorer.file.read",
    path: docPath,
  });
  assert.equal(documentRead.outcome.ok, true, JSON.stringify(documentRead));
  const saved = await operation("file-document", documentId, {
    type: "explorer.file.write",
    path: docPath,
    content: "document after\n",
    version: documentRead.outcome.result.value.version,
  });
  assert.equal(saved.outcome.ok, true, JSON.stringify(saved));
  assert.equal(
    await readFile(path.join(checkout, docPath), "utf8"),
    "document after\n",
  );
  const wrong = await operation("file-document", documentId, {
    type: "explorer.file.read",
    path: "untouched.txt",
  });
  assert.equal(wrong.outcome.ok, false);
  assert.equal(
    wrong.outcome.error,
    "The operation does not target this file document.",
  );
  assert.equal(
    await readFile(path.join(checkout, "untouched.txt"), "utf8"),
    "private dirty content\n",
  );
  if (binary) {
    const {
      binaryDigest,
      binaryReceipt,
      binaryRequest,
      finalChunk,
      saveChecksum,
      verifyBinarySave,
    } = await import("./binary-save-cases.mjs");
    const send = async (request) =>
      (await operation("file-document", documentId, request)).outcome;
    const target = path.join(checkout, docPath);
    if (process.platform !== "win32") await chmod(target, 0o640);
    await verifyBinarySave({
      path: docPath,
      send,
      restartWorker: binary.restartWorker,
      digestTarget: async () => binaryDigest(await readFile(target)),
      replaceTarget: (bytes) => writeFile(target, bytes),
    });

    if (process.platform !== "win32")
      assert.equal((await stat(target)).mode & 0o777, 0o640);
    for (const conflict of [false, true]) {
      const name = conflict ? "raced.nbt" : "empty-copy.nbt";
      const id = crypto.randomUUID();
      const empty = Buffer.alloc(0);
      const request = (action, fields) =>
        binaryRequest(name, id, action, fields);
      const copy = (action, fields) => explore(request(action, fields));
      binaryReceipt(await copy("begin", { version: null }));
      binaryReceipt(await copy("chunk", finalChunk(empty)));
      const copyPath = path.join(checkout, name);
      if (conflict) await writeFile(copyPath, "appeared");
      const result = binaryReceipt(await copy("commit", saveChecksum(empty)));
      assert.equal(result.state, conflict ? "conflict" : "committed");
      assert.equal(
        await readFile(copyPath, "utf8"),
        conflict ? "appeared" : "",
      );
    }

    // A real legacy writer publishes the target and stops at its prepared
    // record. The Rust worker then observes that exact upload after startup.
    const baseline = (
      await send({
        type: "explorer.binary.read",
        path: docPath,
        offset: 0,
        limit: 1,
      })
    ).result.value.version;
    await binary.stopWorker();
    const { BinaryFileWrites } =
      await import("../../tests/reference-node-worker/src/binary-file-writes.ts");
    const legacy = new BinaryFileWrites(binary.workerDirectory, {
      ownerId: () => ownerId,
      componentKey: () => ({ key: surfaceKey.slice(), keyRevision: 1 }),
    });
    const context = {
      serverId,
      surfaceKind: "file-document",
      surfaceId: documentId,
      root: checkout,
    };
    const id = crypto.randomUUID();
    const request = (action, fields) =>
      binaryRequest(docPath, id, action, fields);
    const bytes = Buffer.from([0, 0xe2, 0xb2, 0]);
    try {
      await legacy.execute(context, request("begin", { version: baseline }));
      await legacy.execute(context, request("chunk", finalChunk(bytes)));
      const save = legacy.storage.write.bind(legacy.storage);
      legacy.storage.write = async (key, record) => {
        if (record.state === "committed")
          throw new Error("fixture lost committed receipt");
        return save(key, record);
      };
      await assert.rejects(
        legacy.execute(context, request("commit", saveChecksum(bytes))),
        /fixture lost committed receipt/u,
      );
      assert.deepEqual(await readFile(target), bytes);
    } finally {
      await legacy.dispose();
    }
    await binary.startWorker();
    const recovered = binaryReceipt(await send(request("status")));
    assert.equal(recovered.state, "committed");
    assert.equal(recovered.sha256, binaryDigest(bytes));
  }
  return async () => {
    const refreshed = await call(
      "POST",
      `/api/workers/${workerId}/encryption/refresh`,
      { component: "surface-private-state", keyRevision: 1 },
    );
    assertSurfaceGrantRefresh(refreshed);
    const read = await operation("file-document", documentId, {
      type: "explorer.file.read",
      path: docPath,
    });
    assert.equal(read.outcome.ok, true, JSON.stringify(read));
    assert.equal(read.outcome.result.value.content, "document after\n");
    const listed = await explore({ type: "explorer.directory.list", path: "" });
    assert.equal(listed.ok, true);
    assert.ok(listed.result.value.entries.some((e) => e.name === file));
  };
}
