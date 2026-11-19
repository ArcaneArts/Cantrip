// Real Rust server/worker and an upgraded disposable workspace. The legacy
// helper is used explicitly as a differential oracle and receipt producer.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";

const legacy = "/usr/lib/cantrip-os-executor/file-operations.mjs";
const native = "/usr/lib/cantrip-os-executor/cantrip-os-files";

export async function verifyProductFiles({
  call,
  target,
  workspace,
  os,
  actual,
  data,
  serverId,
  workerId,
  hash,
  docker,
  transport,
  container,
  crashWorker,
  restartWorker,
  surfaceKey,
  metadataKey,
}) {
  const ownerId = os.ownerId;
  const { projectId, worktreeId, guestPath } = target;
  const binding = { projectId, worktreeId, workerId };
  const placement = {
    worktreeId,
    cantripOsBindingId: target.id,
    cantripOsRuntimeGeneration: os.runtimeGeneration,
  };
  const guest = (...args) =>
    docker(
      "exec",
      "--user",
      String(actual.uid),
      "-e",
      "HOME=" + actual.home,
      container,
      ...args,
    );
  const root = (...args) => docker("exec", "--user", "0", container, ...args);
  const put = (file, contents) =>
    guest(
      "/bin/sh",
      "-ec",
      'printf "%s" "$2" > "$1"',
      "fixture",
      file,
      contents,
    );
  const encryptState = (resource, resourceId, recordKind, fields) =>
    c.encryptSurfacePrivateState({
      ownerId,
      keyRevision: 1,
      componentKey: surfaceKey,
      context: {
        resource,
        resourceId,
        serverId,
        recordKind,
        operationId: null,
      },
      content: { version: 1, classification: { recordKind }, ...fields },
    });
  const file = "les données.md";
  const explorer = randomUUID();
  const document = randomUUID();
  await call(
    "POST",
    "/api/projects/" + projectId + "/explorers",
    {
      ...placement,
      id: explorer,
      attachToTabLayout: false,
      titleProtection: await c.encryptPrivateDisplayLabel({
        ownerId,
        keyRevision: 1,
        componentKey: metadataKey,
        rowId: explorer,
        recordKind: "explorer",
        label: "Native guest files",
      }),
      stateProtection: await encryptState(
        "explorer-row",
        explorer,
        "explorer-state",
        { selectedPath: null },
      ),
    },
    201,
  );
  const summary = await call(
    "POST",
    "/api/projects/" + projectId + "/file-documents",
    {
      ...placement,
      id: document,
      stateProtection: await encryptState(
        "file-document-row",
        document,
        "file-document-state",
        { ...binding, path: file },
      ),
    },
  );
  assert.equal(summary.cantripOsBindingId, target.id);
  assert.ok(!JSON.stringify(summary).includes(file));

  async function operation(
    surfaceKind,
    surfaceId,
    input,
    operationId = randomUUID(),
    sequence = 0,
  ) {
    const request = p.explorerOperationRequestContentSchema.parse(input);
    const context = {
      serverId,
      surfaceKind,
      surfaceId,
      operationId,
      sequence,
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(request));
    const req = { ...context, direction: "request" };
    const opaque = await c.encryptSurfaceStreamPayload({
      ownerId,
      keyRevision: 1,
      componentKey: surfaceKey,
      context: req,
      plaintext,
    });
    plaintext.fill(0);
    const route =
      (surfaceKind === "explorer"
        ? "/api/explorers/"
        : "/api/file-documents/") +
      surfaceId +
      "/operation";
    return {
      context,
      request,
      send: async (expected = 200) => {
        const response = await call(
          "POST",
          route,
          {
            operationId,
            sequence,
            protectedRequest: opaque,
            ...(surfaceKind === "explorer" ? { binding } : {}),
          },
          expected,
        );
        if (expected !== 200) return response;
        assert.equal(response.operationId, operationId);
        assert.equal(response.sequence, sequence);
        assert.ok(!JSON.stringify(response).includes(file));
        const bytes = await c.decryptSurfaceStreamPayload({
          ownerId,
          keyRevision: 1,
          componentKey: surfaceKey,
          context: { ...context, direction: "response" },
          opaque: response.protectedResponse,
        });
        return p.surfaceOperationOutcomeContentSchema.parse(
          JSON.parse(new TextDecoder().decode(bytes)),
        );
      },
    };
  }
  const explore = async (request) =>
    (await operation("explorer", explorer, request)).send();
  const edit = async (request) =>
    (await operation("file-document", document, request)).send();

  await root("test", "-x", native);
  await root("mv", legacy, legacy + ".fixture");
  let savedWrite, original;
  try {
    const created = await explore({
      type: "explorer.file.create",
      path: "",
      name: file,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const listing = await explore({
      type: "explorer.directory.list",
      path: "",
    });
    assert.ok(listing.result.value.entries.some(({ name }) => name === file));
    const initial = await edit({ type: "explorer.file.read", path: file });
    assert.equal(initial.ok, true, JSON.stringify(initial));
    assert.equal(initial.result.value.content, "");
    const content = "\ufeff" + "résultat 日本語 🌿\n".repeat(2400);
    savedWrite = await operation("file-document", document, {
      type: "explorer.file.write",
      path: file,
      version: initial.result.value.version,
      content,
    });
    original = await savedWrite.send();
    assert.equal(original.ok, true, JSON.stringify(original).slice(0, 2000));
    assert.equal(original.result.value.content, content);
    assert.equal(
      await guest("stat", "-c", "%u", guestPath + "/" + file),
      String(actual.uid),
    );
    const wrong = await edit({
      type: "explorer.file.read",
      path: "untouched.txt",
    });
    assert.equal(
      wrong.error,
      "The operation does not target this file document.",
    );
    const outside = await explore({
      type: "explorer.file.read",
      path: "../outside",
    });
    assert.equal(outside.error, "Explorer path traversal is not allowed.");
    const preview = await edit({
      type: "explorer.file.preview",
      path: file,
      offset: 0,
    });
    assert.equal(preview.result.value.content, content);
    const binary = await edit({
      type: "explorer.binary.read",
      path: file,
      offset: 0,
      limit: 48110,
    });
    assert.deepEqual(
      Buffer.from(binary.result.value.data, "base64"),
      Buffer.from(content).subarray(0, 48110),
    );
    assert.equal(binary.result.value.eof, false);
    const tail = await edit({ type: "explorer.file.tail", path: file });
    assert.equal(tail.result.value.content, content);
    const sameTail = await edit({
      type: "explorer.file.tail",
      path: file,
      cursor: tail.result.value.cursor,
    });
    assert.equal(sameTail.result.value.reset, false);
    assert.equal(sameTail.result.value.content, "");

    const mediaFile = "media-fixture.PNG";
    await put(guestPath + "/" + mediaFile, "abcdef");
    const media = {
      type: "explorer.media.read",
      path: mediaFile,
      offset: 0,
      limit: 3,
    };
    const stream = randomUUID();
    const first = await (
      await operation("explorer", explorer, media, stream)
    ).send();
    assert.equal(first.result.value.eof, false);
    assert.equal(first.result.value.mimeType, "image/png");
    assert.equal(
      Buffer.from(first.result.value.data, "base64").toString(),
      "abc",
    );
    const next = await operation(
      "explorer",
      explorer,
      { ...media, offset: 3 },
      stream,
      1,
    );
    const second = await next.send();
    assert.equal(second.result.value.eof, true);
    assert.equal(
      Buffer.from(second.result.value.data, "base64").toString(),
      "def",
    );
    const closed = await operation(
      "explorer",
      explorer,
      { ...media, offset: 6 },
      stream,
      2,
    );
    assert.match((await closed.send(502)).error, /already completed/u);
  } finally {
    await root("mv", legacy + ".fixture", legacy);
  }

  const cache = actual.home + "/.local/state/cantrip-os-executor/files";
  const directories = (
    await guest("find", cache, "-mindepth", "1", "-maxdepth", "1", "-type", "d")
  ).split("\n");
  assert.equal(directories.length, 1);
  const [directory] = directories;
  const identity = path.posix.basename(directory);
  const execution = p.cantripOsExecutionSchema.parse({
    kind: "cantrip-os",
    transport,
    scope: {
      ...binding,
      ownerId,
      instanceId: os.id,
      guestInstanceId: os.guestInstanceId,
      attachmentGeneration: os.attachmentGeneration,
      runtimeGeneration: os.runtimeGeneration,
      bindingId: target.id,
      bindingGeneration: target.bindingGeneration,
      projectSourceId: target.projectSourceId,
      sourceKind: "git",
      workspaceId: workspace.id,
      guestWorkspaceId: actual.id,
      uid: actual.uid,
      gid: actual.gid,
      homeGuestPath: actual.home,
      guestPath,
      mode: "linux-owned",
      linkedWorkerPath: null,
      dependencyOverlays: [],
    },
  });
  assert.equal(identity, hash({ execution, serverId }));
  const receipt = ({ context }) => directory + "/" + hash(context) + ".json";
  const saved = JSON.parse(await guest("cat", receipt(savedWrite)));
  const fingerprint = ({ context, request }) =>
    hash({ id: context.operationId, request, context });
  assert.equal(saved.digest, fingerprint(savedWrite));
  const admission = (context) =>
    path.join(
      data,
      "os-file-admissions",
      hash({ identity, context }) + ".json",
    );
  assert.deepEqual(
    JSON.parse(await readFile(admission(savedWrite.context), "utf8")),
    { digest: saved.digest },
  );
  assert.deepEqual(saved.result, { complete: true, outcome: original });
  const oracle = async ({ context, request }, observed = false) => {
    const id = context.operationId;
    const frame = observed
      ? {
          action: "observe",
          id,
          context,
          digest: hash({ id, request, context }),
        }
      : { action: "execute", id, request, context };
    const stdout = await guest(
      "/bin/sh",
      "-ec",
      'printf "%s\\n" "$1" | /usr/bin/node "$2" "$3" "$4"',
      "fixture",
      JSON.stringify(frame),
      legacy,
      guestPath,
      identity,
    );
    const [ready, response] = stdout
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(ready.identity, identity);
    assert.equal(response.id, id);
    return response.result.outcome;
  };
  assert.deepEqual(await oracle(savedWrite, true), original);
  for (const request of [
    { type: "explorer.binary.read", path: file, offset: 0, limit: 32 },
    { type: "explorer.file.tail", path: file },
  ]) {
    const check = await operation("file-document", document, request);
    assert.deepEqual(await check.send(), await oracle(check));
  }

  const fromNode = await operation("file-document", document, {
    type: "explorer.file.write",
    path: file,
    version: original.result.value.version,
    content: "legacy completion\n",
  });
  const nodeReceipt = await oracle(fromNode);
  assert.equal(nodeReceipt.ok, true, JSON.stringify(nodeReceipt));
  // Use the receipt just emitted by the packaged Node peer and the local
  // admission record its worker would have persisted before dispatch.
  await writeFile(
    admission(fromNode.context),
    JSON.stringify({ digest: fingerprint(fromNode) }),
    { flag: "wx", mode: 0o600 },
  );

  await put(guestPath + "/" + file, "edited independently\n");
  assert.deepEqual(await fromNode.send(), nodeReceipt);
  assert.equal(
    await guest("cat", guestPath + "/" + file),
    "edited independently",
  );

  await crashWorker();
  assert.deepEqual(await savedWrite.send(), original);
  assert.equal(
    await guest("cat", guestPath + "/" + file),
    "edited independently",
  );
  await put(receipt(savedWrite), JSON.stringify({ digest: saved.digest }));
  await restartWorker();
  const unknown = await savedWrite.send();
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown outcome/u);
  assert.equal(
    await guest("cat", guestPath + "/" + file),
    "edited independently",
  );
  const {
    binaryReceipt,
    binaryRequest,
    finalChunk,
    saveChecksum,
    verifyBinarySave,
  } = await import("./binary-save-cases.mjs");
  const targetFile = guestPath + "/" + file;
  const digestTarget = async () =>
    (await guest("sha256sum", targetFile)).split(" ")[0];
  await verifyBinarySave({
    path: file,
    send: edit,
    digestTarget,
    replaceTarget: (bytes) => put(targetFile, bytes.toString("utf8")),
    restartWorker: crashWorker,
  });
  // Each implementation finishes the other implementation's staged upload.
  const node = async (request) =>
    oracle(await operation("file-document", document, request));
  for (const [stage, finish] of [
    [node, edit],
    [edit, node],
  ]) {
    const baseline = (
      await edit({
        type: "explorer.binary.read",
        path: file,
        offset: 0,
        limit: 1,
      })
    ).result.value.version;
    const bytes = Buffer.concat([
      Buffer.from([0, 255]),
      Buffer.from(randomUUID()),
    ]);
    const id = randomUUID();
    const request = (action, fields) => binaryRequest(file, id, action, fields);
    binaryReceipt(await stage(request("begin", { version: baseline })));
    binaryReceipt(await stage(request("chunk", finalChunk(bytes))));
    const committed = binaryReceipt(
      await finish(request("commit", saveChecksum(bytes))),
    );
    assert.equal(committed.state, "committed");
    assert.equal(await digestTarget(), committed.sha256);
    assert.deepEqual(binaryReceipt(await edit(request("status"))), committed);
  }
  const liveHelper = path.join(data, "os-file-helpers", identity + ".json");
  const bytes = Buffer.alloc(256 * 1024, 0xda);
  const lastBytes = Buffer.from([0, 255, 128]);
  const importedPath = "données importées.bin";
  const chunk = {
    type: "explorer.file.import",
    path: "",
    name: importedPath,
    size: bytes.length + lastBytes.length,
    offset: 0,
    data: bytes.toString("base64"),
    eof: false,
  };
  const final = {
    ...chunk,
    offset: bytes.length,
    data: lastBytes.toString("base64"),
    eof: true,
  };
  const drop = (request, id, sequence) =>
    operation("explorer", explorer, request, id, sequence);
  const imported = (outcome) => {
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.result.type, "explorer.file.imported");
    return outcome.result.value;
  };
  const noFile = (name) => guest("test", "!", "-e", guestPath + "/" + name);
  let completedDrop, completion;
  await root("mv", legacy, legacy + ".fixture");
  try {
    const id = randomUUID();
    const started = imported(await (await drop(chunk, id, 0)).send());
    assert.deepEqual(started, { offset: bytes.length, entry: null });
    await noFile(importedPath);
    const child = await readFile(liveHelper, "utf8");
    const canceled = randomUUID();
    const canceledName = "canceled.bin";
    imported(
      await (await drop({ ...chunk, name: canceledName }, canceled, 0)).send(),
    );
    assert.deepEqual(
      imported(
        await (
          await drop({ type: "explorer.file.import.cancel" }, canceled, 1)
        ).send(),
      ),
      { offset: 0, entry: null },
    );
    const list = await explore({ type: "explorer.directory.list", path: "" });
    assert.equal(list.ok, true, JSON.stringify(list));
    assert.equal(await readFile(liveHelper, "utf8"), child);
    const reused = await drop({ ...chunk, name: "reused.bin" });
    await writeFile(
      admission(reused.context),
      JSON.stringify({ digest: "0".repeat(64) }),
      { flag: "wx", mode: 0o600 },
    );
    assert.match((await reused.send()).error, /identity was reused/u);
    assert.equal(await readFile(liveHelper, "utf8"), child);
    await noFile(canceledName);
    completedDrop = await drop(final, id, 1);
    completion = await completedDrop.send();
    assert.equal(imported(completion).entry.path, importedPath);
    assert.equal(imported(completion).offset, chunk.size);
    assert.equal(
      (await guest("sha256sum", guestPath + "/" + importedPath)).split(" ")[0],
      saveChecksum(Buffer.concat([bytes, lastBytes])).sha256,
    );
    await assert.rejects(readFile(liveHelper), { code: "ENOENT" });

    const interrupted = randomUUID();
    const lost = { ...chunk, name: "interrupted.bin" };
    const firstPage = await drop(lost, interrupted, 0);
    const firstReceipt = await firstPage.send();
    imported(firstReceipt);
    await crashWorker();
    // The admission still observes the original receipt, without rebuilding
    // the abandoned private stage or replaying its bytes into a fresh child.
    assert.deepEqual(await firstPage.send(), firstReceipt);
    const missing = await (
      await drop({ ...final, name: lost.name }, interrupted, 1)
    ).send();
    assert.equal(missing.ok, false);
    assert.match(missing.error, /file import is unavailable/u);
    await noFile(lost.name);

    imported(
      await (
        await drop({ ...chunk, name: "shutdown.bin" }, randomUUID(), 0)
      ).send(),
    );
    await readFile(liveHelper);
    await restartWorker();
    await assert.rejects(readFile(liveHelper), { code: "ENOENT" });
    await noFile("shutdown.bin");
  } finally {
    await root("mv", legacy + ".fixture", legacy);
  }
  assert.deepEqual(await oracle(completedDrop, true), completion);
  console.log(
    "Native guest files passed: protected edits, retained imports, compatible receipts, and observation-only crash recovery.",
  );
}
