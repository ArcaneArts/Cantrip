// Compare actual encrypted command handlers, including replay admission and
// file-document binding. Node/Rust profiles and editable trees are separate.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
import { WorkerEncryptionService } from "../../tests/reference-node-worker/src/worker-encryption.ts";
import { WorkerRoutingRegistry } from "../../tests/reference-node-worker/src/routing-registry.ts";
import { handleExplorerCommand } from "../../tests/reference-node-worker/src/commands/explorer.ts";
import {
  SurfaceStreamReplayGuard,
  openWorkerSurfaceStreamContent,
} from "../../tests/reference-node-worker/src/surface-stream-encryption.ts";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary);
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-explorer-commands-")),
);
const nodeDirectory = path.join(root, "node"),
  rustDirectory = path.join(root, "rust"),
  nodeTree = path.join(nodeDirectory, "files"),
  rustTree = path.join(rustDirectory, "files");
const child = spawn(path.resolve(values.binary), [], {
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let requestId = 0,
  comparisons = 0,
  service;
const ownerId = "owner-commands",
  workerId = "worker-commands",
  serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  serverUrl = "https://commands.test",
  key = new Uint8Array(32).fill(7);
const documentId = "22222222-2222-4222-8222-222222222222";
async function native(input) {
  const id = ++requestId;
  child.stdin.write(JSON.stringify({ ...input, requestId: id }) + "\n");
  const line = await lines.next();
  assert.ok(!line.done);
  const message = JSON.parse(line.value);
  assert.equal(message.id, id);
  return message.result;
}
async function success(input) {
  const result = await native(input);
  assert.equal(result.ok, true, result.error);
  return result.value;
}
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "modifiedAt")
        .map(([k, v]) => [k, normalize(v)]),
    );
  return typeof value === "string"
    ? value.replaceAll(nodeTree, "<tree>").replaceAll(rustTree, "<tree>")
    : value;
}
function context(command) {
  return {
    serverId: command.serverId,
    surfaceKind:
      command.type === "explorer.operation" ? "explorer" : "file-document",
    surfaceId: command.explorerId ?? command.documentId,
    operationId: command.operationId,
    direction: "request",
    sequence: command.sequence,
  };
}
async function sealed(command, request) {
  return c.encryptSurfaceStreamPayload({
    ownerId,
    context: context(command),
    keyRevision: 3,
    componentKey: key,
    plaintext: new TextEncoder().encode(JSON.stringify(request)),
  });
}
async function privateState(changes = {}) {
  return c.encryptSurfacePrivateState({
    ownerId,
    context: {
      serverId,
      resource: "file-document-row",
      resourceId: documentId,
      operationId: null,
      recordKind: "file-document-state",
    },
    keyRevision: 3,
    componentKey: key,
    content: {
      version: 1,
      classification: { recordKind: "file-document-state" },
      projectId: "project",
      workerId,
      worktreeId: "worktree",
      path: "file.md",
      ...changes,
    },
  });
}
try {
  for (const directory of [nodeTree, rustTree]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "file.md"), "\ufeffinitial\n");
    await writeFile(path.join(directory, "INDEX_FILE_NAME_LONG.txt"), "case");
    await mkdir(path.join(directory, "dir"));
    await writeFile(
      path.join(directory, "dir/INDEX_FILE_NAME_LONG.txt"),
      "case",
    );
    await writeFile(
      path.join(directory, "preview.txt"),
      Buffer.alloc(2 * 1024 * 1024 + 1, 65),
    );
  }
  service = await WorkerEncryptionService.open({
    dataDirectory: nodeDirectory,
    serverUrl,
    workerId,
  });
  await writeFile(
    path.join(rustDirectory, "worker-encryption-key.json"),
    await readFile(path.join(nodeDirectory, "worker-encryption-key.json")),
  );
  assert.deepEqual(
    await success({
      op: "open-service",
      directory: rustDirectory,
      serverUrl,
      workerId,
    }),
    service.registration(),
  );
  const at = "2026-11-16T00:00:00.000Z",
    registration = service.registration();
  const wrappedKey = await c.wrapComponentKeyForWorker({
    ownerId,
    workerId,
    component: "surface-private-state",
    keyRevision: 3,
    componentKey: key,
    workerPublicKey: registration.publicKey,
  });
  const payload = {
    serverId,
    ownerId,
    principal: {
      id: registration.principalId,
      ownerId,
      kind: "worker",
      workerId,
      label: "Command fixture",
      publicKey: registration.publicKey,
      state: "approved",
      revision: 1,
      approvedAt: at,
      revokedAt: null,
      revokedReason: null,
      createdAt: at,
      updatedAt: at,
    },
    grants: [
      {
        id: crypto.randomUUID(),
        ownerId,
        principalId: registration.principalId,
        component: "surface-private-state",
        keyRevision: 3,
        wrappedKey,
        state: "active",
        revision: 1,
        revokedAt: null,
        revokedReason: null,
        createdAt: at,
        updatedAt: at,
      },
    ],
  };
  await service.acceptBootstrap(payload);
  await success({ op: "accept", payload });
  const registry = new WorkerRoutingRegistry(nodeDirectory),
    replay = new SurfaceStreamReplayGuard();
  const dependencies = {
    fileImports: null,
    workerEncryption: service,
    surfaceStreamReplay: replay,
  };
  async function compare(command) {
    const nodeCommand = {
      ...command,
      root:
        typeof command.root === "string"
          ? command.root.replace(rustTree, nodeTree)
          : command.root,
    };
    let expected;
    try {
      const routed = await registry.resolveCommand(
        p.workerCommandSchema.parse(JSON.parse(JSON.stringify(nodeCommand))),
      );
      expected = {
        ok: true,
        value: await handleExplorerCommand(routed, dependencies),
      };
    } catch (error) {
      expected = { ok: false, error: error.message, decryption: false };
    }
    const actual = await native({ op: "explorer-command", command });
    if (expected.ok) {
      assert.equal(actual.ok, true, actual.error);
      const binding = { ...context(command), direction: "response" };
      const open = (opaque) =>
        openWorkerSurfaceStreamContent({
          service,
          context: binding,
          opaque,
          schema: p.surfaceOperationOutcomeContentSchema,
        });
      const a = await open(actual.value.protectedResponse),
        b = await open(expected.value.protectedResponse);
      assert.equal(actual.value.operationId, command.operationId);
      assert.equal(actual.value.sequence, command.sequence);
      assert.deepEqual(normalize(a), normalize(b));
      comparisons++;
      return a;
    }
    assert.deepEqual(actual, expected);
    comparisons++;
    return actual;
  }
  async function command(request, changes = {}) {
    const wire = {
      type: "explorer.operation",
      explorerId: "explorer",
      serverId,
      root: rustTree,
      operationId: crypto.randomUUID(),
      sequence: 0,
      ...changes,
    };
    wire.protectedRequest = await sealed(wire, request);
    return wire;
  }
  async function run(request, changes = {}) {
    return compare(await command(request, changes));
  }
  await run({ type: "explorer.directory.list", path: "" });
  for (const query of ["I", "ı", "  INDEX_FILE_NAME_LONG  "])
    await run({ type: "explorer.files.search", query, limit: 10 });
  await run({ type: "explorer.directory.commits", path: "" });
  const first = await run({ type: "explorer.file.read", path: "file.md" });
  await run({
    type: "explorer.file.write",
    path: "file.md",
    content: "new\ud800",
    version: first.result.value.version,
  });
  await run({
    type: "explorer.file.write",
    path: "file.md",
    content: "stale",
    version: first.result.value.version,
  });
  await run({ type: "explorer.file.read", path: "preview.txt" });
  await run({ type: "explorer.file.read", path: "../forbidden" });
  await run({ type: "explorer.file.read", path: "missing" });
  await run({ type: "explorer.file.create", path: "", name: " created.txt " });
  await run({ type: "explorer.directory.create", path: "" });
  await run({
    type: "explorer.entry.rename",
    path: "created.txt",
    name: "renamed.txt",
  });
  await run({ type: "explorer.entry.delete", path: "renamed.txt" });
  const document = {
    type: "file-document.operation",
    explorerId: undefined,
    documentId,
    projectId: "project",
    workerId,
    worktreeId: "worktree",
    stateProtection: await privateState(),
  };
  const read = await run(
    { type: "explorer.file.read", path: "file.md" },
    document,
  );
  await run(
    {
      type: "explorer.file.write",
      path: "file.md",
      content: "document edit",
      version: read.result.value.version,
    },
    document,
  );
  await run({ type: "explorer.file.read", path: "other.md" }, document);
  await run({ type: "explorer.entry.delete", path: "file.md" }, document);
  for (const change of [
    { projectId: "other" },
    { workerId: "other" },
    { worktreeId: "other" },
  ])
    await run(
      { type: "explorer.file.read", path: "file.md" },
      { ...document, ...change },
    );
  await run(
    { type: "explorer.file.read", path: "file.md" },
    {
      ...document,
      stateProtection: await privateState({ projectId: "other" }),
    },
  );
  const bad = structuredClone(document.stateProtection),
    bytes = c.decodeBase64Url(bad.protectedState.envelope.ciphertext);
  bytes[0] ^= 1;
  bad.protectedState.envelope.ciphertext = c.encodeBase64Url(bytes);
  await run(
    { type: "explorer.file.read", path: "file.md" },
    { ...document, stateProtection: bad },
  );
  const repeated = await command({
    type: "explorer.file.read",
    path: "file.md",
  });
  await compare(repeated);
  await compare(repeated);
  const failed = await command({ type: "explorer.file.read", path: "file.md" }),
    correct = structuredClone(failed);
  const forged = c.decodeBase64Url(failed.protectedRequest.envelope.ciphertext);
  forged[0] ^= 1;
  failed.protectedRequest.envelope.ciphertext = c.encodeBase64Url(forged);
  await compare(failed);
  await compare(correct);
  correct.sequence = 1;
  correct.protectedRequest = await sealed(correct, {
    type: "explorer.file.read",
    path: "file.md",
  });
  await compare(correct);
  const unknown = await command(
    { type: "explorer.file.read", path: "file.md" },
    { root: "ctrr_" + "A".repeat(43) },
  );
  await compare(unknown);
  unknown.root = rustTree;
  await compare(unknown);
  assert.equal(
    await readFile(path.join(rustTree, "file.md"), "utf8"),
    "document edit",
  );
  console.log(
    JSON.stringify({
      comparisons,
      platform: process.platform,
      locale: Intl.Collator().resolvedOptions().locale,
      encryptedHandlers: true,
      fileDocumentBinding: true,
      replayBeforeOpening: true,
    }),
  );
} finally {
  service?.lock();
  key.fill(0);
  child.stdin.end();
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", resolve);
  });
  await rm(root, { recursive: true, force: true });
}
