// Actual private-state crypto and worker-helper interoperability, using only
// synthetic keys and separately owned disposable worker profiles.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
import * as worker from "../../cantrip_worker/src/surface-private-state-encryption.ts";
import { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.ts";
import { openTerminalPrivateState } from "../../cantrip_worker/src/terminal-private-state.ts";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary content-fixture");
const root = await mkdtemp(path.join(tmpdir(), "cantrip-private-state-"));
const child = spawn(path.resolve(values.binary), [], {
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let requestId = 0,
  comparisons = 0,
  service;
const ownerId = "owner-state",
  workerId = "worker-state",
  serverUrl = "https://state.test",
  key = new Uint8Array(32).fill(7);
const content = {
  "terminal-state": {
    version: 1,
    classification: { recordKind: "terminal-state" },
    directory: { kind: "relative-path", path: "src\\nested" },
    serviceCommand: "echo synthetic\ud800",
  },
  "explorer-state": {
    version: 1,
    classification: { recordKind: "explorer-state" },
    selectedPath: "src/😀.md",
  },
  "file-document-state": {
    version: 1,
    classification: { recordKind: "file-document-state" },
    projectId: "project",
    workerId,
    worktreeId: "worktree",
    path: "src/file.md",
  },
  "browser-state": {
    version: 1,
    classification: { recordKind: "browser-state" },
    revision: 1,
    url: "https://example.invalid/private",
  },
  "remote-desktop-state": {
    version: 1,
    classification: { recordKind: "remote-desktop-state" },
    revision: 1,
    target: {
      kind: "window",
      id: null,
      application: " Synthetic ",
      title: null,
    },
  },
  "remote-desktop-inventory": {
    version: 1,
    classification: { recordKind: "remote-desktop-inventory" },
    monitors: [],
    windows: [],
  },
};
const resources = {
  "terminal-row": "terminal-state",
  "terminal-operation": "terminal-state",
  "explorer-row": "explorer-state",
  "explorer-operation": "explorer-state",
  "file-document-row": "file-document-state",
  "browser-row": "browser-state",
  "browser-remote-surface": "browser-state",
  "browser-operation": "browser-state",
  "remote-desktop-row": "remote-desktop-state",
  "remote-desktop-surface": "remote-desktop-state",
  "remote-desktop-operation": "remote-desktop-state",
  "remote-desktop-inventory": "remote-desktop-inventory",
};
function binding(resource, recordKind = resources[resource]) {
  return {
    serverId: "server-state-\ud800",
    resource,
    resourceId: "resource",
    operationId:
      resource.endsWith("-row") || resource.endsWith("-surface")
        ? null
        : "operation",
    recordKind,
  };
}
function outer(context) {
  return { ownerId, keyRevision: 3, context };
}
function options(context) {
  return { ...outer(context), componentKey: key };
}
async function rust(input) {
  const id = ++requestId;
  child.stdin.write(JSON.stringify({ ...input, requestId: id }) + "\n");
  const line = await lines.next();
  assert.ok(!line.done);
  const reply = JSON.parse(line.value);
  assert.equal(reply.id, id);
  return reply.result;
}
async function native(input) {
  const reply = await rust(input);
  assert.equal(reply.ok, true, reply.error);
  return reply.value;
}
async function observe(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      decryption: error instanceof c.CantripDecryptionError,
      ...(error instanceof worker.SurfacePrivateStateWorkerError
        ? { state: error.state }
        : {}),
    };
  }
}
async function compare(input, run) {
  assert.deepEqual(await rust(input), await observe(run), input.op);
  comparisons++;
}
function same(a, b) {
  assert.deepEqual(a, b);
  comparisons++;
}
try {
  for (const [resource, kind] of Object.entries(resources)) {
    const context = binding(resource),
      input = options(context),
      value = content[kind];
    await compare({ op: "private-state-aad", context: outer(context) }, () =>
      c.surfacePrivateStateAssociatedData(input),
    );
    const node = await c.encryptSurfacePrivateState({
      ...input,
      content: value,
    });
    await compare(
      {
        op: "private-state-decrypt",
        key: c.encodeBase64Url(key),
        context: outer(context),
        encrypted: node,
      },
      () => c.decryptSurfacePrivateState({ ...input, opaque: node }),
    );
    const encrypted = await native({
      op: "private-state-encrypt",
      key: c.encodeBase64Url(key),
      context: outer(context),
      content: value,
    });
    same(
      await c.decryptSurfacePrivateState({ ...input, opaque: encrypted }),
      p.surfacePrivateStateProtectedContentSchema.parse(value),
    );
  }
  const context = binding("file-document-row"),
    input = options(context),
    value = content["file-document-state"];
  const encrypted = await c.encryptSurfacePrivateState({
    ...input,
    content: value,
  });
  for (const changed of [
    { serverId: "other" },
    { resourceId: "other" },
    { recordKind: "explorer-state" },
    { operationId: "forbidden" },
  ]) {
    const wrong = { ...context, ...changed };
    await compare(
      {
        op: "private-state-decrypt",
        key: c.encodeBase64Url(key),
        context: outer(wrong),
        encrypted,
      },
      () =>
        c.decryptSurfacePrivateState({ ...options(wrong), opaque: encrypted }),
    );
  }
  for (const changed of [{ ownerId: "other" }, { keyRevision: 4 }])
    await compare(
      {
        op: "private-state-decrypt",
        key: c.encodeBase64Url(key),
        context: { ...outer(context), ...changed },
        encrypted,
      },
      () =>
        c.decryptSurfacePrivateState({
          ...input,
          ...changed,
          opaque: encrypted,
        }),
    );
  for (const mutate of [
    (v) => (v.classification.recordKind = "explorer-state"),
    (v) => {
      const bytes = c.decodeBase64Url(v.protectedState.envelope.ciphertext);
      bytes[0] ^= 1;
      v.protectedState.envelope.ciphertext = c.encodeBase64Url(bytes);
    },
    (v) => (v.protectedState.envelope.keyRevision = 4),
  ]) {
    const changed = structuredClone(encrypted);
    mutate(changed);
    await compare(
      {
        op: "private-state-decrypt",
        key: c.encodeBase64Url(key),
        context: outer(context),
        encrypted: changed,
      },
      () => c.decryptSurfacePrivateState({ ...input, opaque: changed }),
    );
  }
  for (const changed of [
    { recordKind: "terminal-state" },
    { operationId: "forbidden" },
    {
      resource: "explorer-operation",
      recordKind: "explorer-state",
      operationId: null,
    },
  ]) {
    const wrong = { ...context, ...changed };
    await compare({ op: "private-state-aad", context: outer(wrong) }, () =>
      c.surfacePrivateStateAssociatedData(options(wrong)),
    );
  }
  for (const bad of [
    {
      ...content["terminal-state"],
      directory: { kind: "relative-path", path: "src/../secret" },
    },
    { ...content["file-document-state"], path: "nul\0" },
    { ...content["browser-state"], url: "HTTPS://example.invalid" },
  ])
    await compare(
      {
        op: "validate",
        schema: "surfacePrivateStateProtectedContentSchema",
        content: bad,
      },
      () => p.surfacePrivateStateProtectedContentSchema.parse(bad),
    );
  // Authenticated but malformed plaintext must still be rejected after opening.
  const associatedData = c.surfacePrivateStateAssociatedData(input),
    fieldKey = c.deriveFieldKey({
      ...input,
      component: "surface-private-state",
      table: associatedData.table,
      field: associatedData.field,
    });
  for (const plaintext of [
    new TextEncoder().encode("\ufeff" + JSON.stringify(value)),
    new Uint8Array([0xff]),
    new TextEncoder().encode(JSON.stringify(content["explorer-state"])),
  ]) {
    const envelope = await c.encryptPayload({
      key: fieldKey,
      plaintext,
      associatedData,
    });
    const malformed = {
      ...encrypted,
      protectedState: { ...encrypted.protectedState, envelope },
    };
    await compare(
      {
        op: "private-state-decrypt",
        key: c.encodeBase64Url(key),
        context: outer(context),
        encrypted: malformed,
      },
      () => c.decryptSurfacePrivateState({ ...input, opaque: malformed }),
    );
  }
  fieldKey.fill(0);
  const wrongKey = new Uint8Array(32).fill(8);
  await compare(
    {
      op: "private-state-decrypt",
      key: c.encodeBase64Url(wrongKey),
      context: outer(context),
      encrypted,
    },
    () =>
      c.decryptSurfacePrivateState({
        ...input,
        componentKey: wrongKey,
        opaque: encrypted,
      }),
  );
  wrongKey.fill(0);
  const window = {
    kind: "window",
    id: "window",
    application: "A",
    title: "😀".repeat(500),
    iconKey: null,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    minimized: false,
    focused: false,
  };
  const oversized = {
    ...content["remote-desktop-inventory"],
    windows: Array(2000).fill(window),
  };
  const inventory = binding("remote-desktop-inventory");
  await compare(
    {
      op: "private-state-encrypt",
      key: c.encodeBase64Url(key),
      context: outer(inventory),
      content: oversized,
    },
    () =>
      c.encryptSurfacePrivateState({
        ...options(inventory),
        content: oversized,
      }),
  );
  for (const [schema, value] of [
    [
      "explorerOperationRequestContentSchema",
      { type: "explorer.binary.read", path: "file", offset: 1, limit: 1 },
    ],
    [
      "surfaceOperationOutcomeContentSchema",
      {
        ok: true,
        result: {
          type: "explorer.binary",
          value: {
            path: "file",
            size: 1,
            offset: 0,
            nextOffset: 0,
            eof: true,
            version: "binary-v1:" + "a".repeat(64),
            data: "YQ==",
          },
        },
      },
    ],
    [
      "surfaceOperationOutcomeContentSchema",
      {
        ok: true,
        result: {
          type: "explorer.binary.write",
          value: {
            path: "file",
            uploadId: "11111111-1111-4111-8111-111111111111",
            state: "committed",
            offset: 0,
            size: null,
            sha256: null,
            version: null,
            error: null,
          },
        },
      },
    ],
  ])
    await compare({ op: "validate", schema, content: value }, () =>
      p[schema].parse(value),
    );
  const nodeDirectory = path.join(root, "node"),
    rustDirectory = path.join(root, "rust");
  service = await WorkerEncryptionService.open({
    dataDirectory: nodeDirectory,
    serverUrl,
    workerId,
  });
  await mkdir(rustDirectory);
  await writeFile(
    path.join(rustDirectory, "worker-encryption-key.json"),
    await readFile(path.join(nodeDirectory, "worker-encryption-key.json")),
  );
  same(
    await native({
      op: "open-service",
      directory: rustDirectory,
      serverUrl,
      workerId,
    }),
    service.registration(),
  );
  const open = (opaque = encrypted, owner = ownerId) =>
    worker.decodeSurfacePrivateStateForWorker({
      service,
      ownerId: owner,
      context,
      opaque,
    });
  const openInput = (opaque = encrypted, owner = ownerId) => ({
    op: "worker-private-state-open",
    ownerId: owner,
    context,
    encrypted: opaque,
  });
  await compare(openInput(), () => open());
  const at = "2026-11-16T00:00:00.000Z",
    registration = service.registration();
  function bootstrap(grants, state = "approved") {
    return {
      serverId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ownerId,
      principal: {
        id: registration.principalId,
        ownerId,
        kind: "worker",
        workerId,
        label: "State fixture",
        publicKey: registration.publicKey,
        state,
        revision: 1,
        approvedAt: at,
        revokedAt: state === "revoked" ? at : null,
        revokedReason: state === "revoked" ? "Fixture revocation" : null,
        createdAt: at,
        updatedAt: at,
      },
      grants,
    };
  }
  async function grant(revision, keyValue) {
    return {
      id: crypto.randomUUID(),
      ownerId,
      principalId: registration.principalId,
      component: "surface-private-state",
      keyRevision: revision,
      wrappedKey: await c.wrapComponentKeyForWorker({
        ownerId,
        workerId,
        component: "surface-private-state",
        keyRevision: revision,
        componentKey: new Uint8Array(32).fill(keyValue),
        workerPublicKey: registration.publicKey,
      }),
      state: "active",
      revision: 1,
      revokedAt: null,
      revokedReason: null,
      createdAt: at,
      updatedAt: at,
    };
  }
  async function authorize(grants, state) {
    const payload = bootstrap(grants, state);
    await service.acceptBootstrap(payload);
    await native({ op: "accept", payload });
  }
  await authorize([await grant(3, 7)]);
  for (const directory of [
    { kind: "project-root" },
    { kind: "relative-path", path: "src/nested" },
    { kind: "relative-path", path: "C:relative" },
    { kind: "relative-path", path: "nested\\literal" },
  ]) {
    const terminalId = "terminal-config";
    const content = {
      version: 1,
      classification: { recordKind: "terminal-state" },
      directory,
      serviceCommand: "synthetic command",
    };
    const stateProtection = await c.encryptSurfacePrivateState({
      ownerId,
      context: {
        serverId: "server",
        resource: "terminal-row",
        resourceId: terminalId,
        operationId: null,
        recordKind: "terminal-state",
      },
      keyRevision: 3,
      componentKey: key,
      content,
    });
    const input = {
      serverId: "server",
      terminalId,
      worktreePath: path.join(root, "checkout"),
      stateProtection,
    };
    await compare({ op: "terminal-service-config", input }, () =>
      openTerminalPrivateState({ ...input, service }),
    );
  }
  await compare(openInput(), () => open());
  await compare(openInput(encrypted, "other-owner"), () =>
    open(encrypted, "other-owner"),
  );
  const nativeEnvelope = await native({
    op: "worker-private-state-protect",
    ownerId,
    context,
    content: value,
  });
  same(await open(nativeEnvelope), value);
  for (const malformed of [
    null,
    {},
    { protectedState: { formatVersion: 2 } },
    { protectedState: { formatVersion: 1, envelope: { version: 2 } } },
    { ...encrypted, classification: { recordKind: "explorer-state" } },
  ])
    await compare(openInput(malformed), () => open(malformed));
  await authorize([await grant(3, 7), await grant(4, 8)]);
  await compare(openInput(), () => open());
  await authorize([], "revoked");
  await compare(openInput(encrypted, "other-owner"), () =>
    open(encrypted, "other-owner"),
  );
  await compare(openInput(null), () => open(null));
  console.log(
    JSON.stringify({
      comparisons,
      resources: Object.keys(resources).length,
      platform: process.platform,
    }),
  );
} finally {
  key.fill(0);
  service?.lock();
  child.stdin.end();
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", resolve);
  });
  await rm(root, { recursive: true, force: true });
}
