import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";

export async function verifyStandaloneChatFiles({
  call,
  createChat,
  data,
  ownerId,
  keyRevision,
  componentKey,
}) {
  const { server } = await call("GET", "/api/bootstrap", 200);
  const chat = await createChat("Chat files", false);
  const second = await createChat("Separate Chat files", false);
  const scratch = path.join(data, "chat-scratch", chat.chatId);
  const notes = path.join(scratch, "notes");
  const textPath = "notes/draft.md";
  const content = "\ufeff# Draft 🌲\r\nSecond line\n";
  const edited = "\ufeff# Edited 🌲\n";
  const audio = Buffer.from([0, 1, 3, 5, 7, 9, 255]);
  await mkdir(notes);
  await writeFile(path.join(scratch, textPath), content);
  await writeFile(path.join(scratch, "audio.wav"), audio);
  const outside = path.join(data, "outside.txt");
  await writeFile(outside, "do not touch");
  if (process.platform !== "win32") {
    await symlink(outside, path.join(scratch, "linked.txt"));
    await symlink(notes, path.join(scratch, "linked-folder"));
  }

  async function send(intent, request, options = {}) {
    const surfaceId = options.chat?.chatId ?? chat.chatId;
    const operationId = options.operationId ?? randomUUID();
    const sequence = options.sequence ?? 0;
    const context = {
      serverId: server.id,
      surfaceKind: "chat-files",
      surfaceId,
      operationId,
      direction: "request",
      sequence,
    };
    const protectedRequest = await c.encryptSurfaceStreamPayload({
      ownerId,
      context,
      keyRevision,
      componentKey,
      plaintext: Buffer.from(
        JSON.stringify(
          p.standaloneChatFileOperationRequestContentSchema.parse(request),
        ),
      ),
    });
    const response = await call(
      "POST",
      "/api/chats/" + surfaceId + "/files/operation",
      200,
      { operationId, sequence, intent, protectedRequest },
    );
    assert.deepEqual(Object.keys(response).sort(), [
      "operationId",
      "protectedResponse",
      "sequence",
    ]);
    assert.equal(response.operationId, operationId);
    assert.equal(response.sequence, sequence);
    const clear = await c.decryptSurfaceStreamPayload({
      ownerId,
      context: { ...context, direction: "response" },
      keyRevision,
      componentKey,
      opaque: response.protectedResponse,
    });
    return p.surfaceOperationOutcomeContentSchema.parse(
      JSON.parse(Buffer.from(clear).toString("utf8")),
    );
  }
  async function success(intent, request, type, options) {
    const outcome = await send(intent, request, options);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.result.type, type);
    return outcome.result;
  }
  async function denied(intent, request, message, options) {
    const outcome = await send(intent, request, options);
    assert.equal(outcome.ok, false, JSON.stringify(outcome));
    assert.match(outcome.error, message);
  }

  const list = { type: "chat-files.directory.list", path: "" };
  const read = (path) => ({ type: "chat-files.file.read", path });
  const remove = (path, recursive = false) => ({
    type: "chat-files.entry.delete",
    path,
    recursive,
  });
  const listing = (await success("list", list, list.type)).value;
  assert.deepEqual(
    listing.entries.map(({ name, kind }) => [name, kind]),
    [
      ["notes", "directory"],
      ["audio.wav", "file"],
      ...(process.platform === "win32"
        ? []
        : [
            ["linked-folder", "other"],
            ["linked.txt", "other"],
          ]),
    ],
  );
  assert.equal(listing.truncated, false);
  assert.equal(listing.entries[1].size, audio.length);
  await denied("write", read(textPath), /declared capability/);
  await denied("read", read("../outside.txt"), /traversal/);
  await denied("read", read(outside), /must be relative/);
  if (process.platform !== "win32") {
    assert.ok(
      listing.entries
        .slice(2)
        .every(({ symbolicLink, viewable }) => symbolicLink && !viewable),
    );
    await denied("read", read("linked.txt"), /symbolic links/);
    await denied("read", read("linked-folder/draft.md"), /symbolic links/);
    await denied(
      "archive",
      { type: "chat-files.download.prepare", kind: "all", path: "" },
      /symbolic links/,
    );
    await unlink(path.join(scratch, "linked.txt"));
    await unlink(path.join(scratch, "linked-folder"));
  }

  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const original = (await success("read", read(textPath), "chat-files.file"))
    .value;
  assert.deepEqual(original, {
    path: textPath,
    content,
    size: Buffer.byteLength(content),
    markdown: true,
    version: sha(content),
  });
  for (const reference of [
    textPath + ":2:1",
    "chat-scratch/" + chat.chatId + "/notes\\draft.md#L2C1",
    pathToFileURL(path.join(scratch, textPath)).href,
  ]) {
    const resolved = await success(
      "read",
      { type: "chat-files.path.resolve", reference },
      "chat-files.path.resolved",
    );
    assert.equal(resolved.path, textPath);
  }
  await denied(
    "read",
    { type: "chat-files.path.resolve", reference: outside },
    /outside the scratch folder/,
  );

  const write = {
    type: "chat-files.file.write",
    path: textPath,
    content: edited,
    version: original.version,
  };
  const saved = (await success("write", write, "chat-files.file")).value;
  assert.equal(saved.version, sha(edited));
  assert.equal(saved.content, edited);
  assert.equal(await readFile(path.join(scratch, textPath), "utf8"), edited);
  await denied("write", write, /Reload it first/);
  await denied("remove", remove("notes"), /Recursive confirmation/);

  const mediaId = randomUUID();
  const media = {
    type: "chat-files.media.read",
    path: "audio.wav",
    offset: 0,
    limit: 3,
  };
  const first = (
    await success("read", media, "chat-files.media", { operationId: mediaId })
  ).value;
  assert.equal(first.mimeType, "audio/wav");
  assert.equal(first.eof, false);
  assert.deepEqual(Buffer.from(first.data, "base64"), audio.subarray(0, 3));
  const last = (
    await success(
      "read",
      { ...media, offset: 3, limit: 4 },
      "chat-files.media",
      { operationId: mediaId, sequence: 1 },
    )
  ).value;
  assert.equal(last.eof, true);
  assert.deepEqual(Buffer.from(last.data, "base64"), audio.subarray(3));

  async function prepare(kind, path) {
    const operationId = randomUUID();
    const intent = kind === "file" ? "download" : "archive";
    const { value } = await success(
      intent,
      { type: "chat-files.download.prepare", kind, path },
      "chat-files.download.prepared",
      { operationId },
    );
    return { ...value, operationId, intent };
  }
  async function receive(download) {
    const chunks = [];
    let offset = 0,
      sequence = 1;
    for (;;) {
      const { value } = await success(
        download.intent,
        {
          type: "chat-files.download.read",
          downloadId: download.downloadId,
          limit: 127,
          offset,
        },
        "chat-files.download.chunk",
        { operationId: download.operationId, sequence: sequence++ },
      );
      assert.equal(value.offset, offset);
      const chunk = Buffer.from(value.data, "base64");
      chunks.push(chunk);
      offset += chunk.length;
      assert.equal(value.eof, offset === download.size);
      if (value.eof) return Buffer.concat(chunks);
      assert.ok(chunk.length > 0 && offset < download.size);
    }
  }

  const download = await prepare("file", textPath);
  assert.equal(download.fileName, "draft.md");
  assert.equal(download.mimeType, "text/plain;charset=utf-8");
  const readDownload = {
    type: "chat-files.download.read",
    downloadId: download.downloadId,
    offset: 1,
    limit: 4,
  };
  await denied("download", readDownload, /offset is stale/);
  const cancel = {
    type: "chat-files.download.cancel",
    downloadId: download.downloadId,
  };
  await denied("download", cancel, /belongs to another scratch folder/, {
    chat: second,
  });
  await writeFile(path.join(scratch, textPath), content);
  assert.deepEqual(
    await receive(download),
    Buffer.from(edited),
    "download is a snapshot",
  );
  await denied("download", readDownload, /no longer available/);
  await success("download", cancel, "chat-files.download.cancelled");

  const require = createRequire(
    new URL("../../cantrip_app/package.json", import.meta.url),
  );
  const { unzipSync } = require("fflate");
  const folder = await prepare("folder", "notes");
  const all = await prepare("all", "");
  assert.equal(folder.fileName, "notes.zip");
  assert.equal(all.fileName, "chat-files.zip");
  const folderEntries = unzipSync(await receive(folder));
  const allEntries = unzipSync(await receive(all));
  assert.deepEqual(Object.keys(folderEntries), [textPath]);
  assert.deepEqual(Object.keys(allEntries).sort(), ["audio.wav", textPath]);
  assert.deepEqual(Buffer.from(folderEntries[textPath]), Buffer.from(content));
  assert.deepEqual(Buffer.from(allEntries[textPath]), Buffer.from(content));
  assert.deepEqual(Buffer.from(allEntries["audio.wav"]), audio);

  const staged = [];
  for (let i = 0; i < 4; i++) staged.push(await prepare("file", textPath));
  await denied(
    "download",
    { type: "chat-files.download.prepare", kind: "file", path: textPath },
    /Too many Chat file downloads/,
  );
  const firstStaged = staged.shift();
  const cancelStaged = async (download) =>
    success(
      "download",
      { type: "chat-files.download.cancel", downloadId: download.downloadId },
      "chat-files.download.cancelled",
      { operationId: download.operationId, sequence: 1 },
    );
  await cancelStaged(firstStaged);
  staged.push(await prepare("file", textPath));
  for (const entry of staged) await cancelStaged(entry);

  const removed = await success(
    "remove",
    remove("notes", true),
    "chat-files.entry.mutated",
  );
  assert.deepEqual(removed.value, { path: "notes", newPath: null });
  await assert.rejects(readFile(path.join(scratch, textPath)), {
    code: "ENOENT",
  });
  assert.equal(await readFile(outside, "utf8"), "do not touch");
  console.log(
    JSON.stringify({ suite: "native-standalone-chat-files", passed: true }),
  );
}
