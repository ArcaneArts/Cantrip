// Owned synthetic profiles and actual Node crypto/service/root-attachment code.
// The Rust driver invokes the same repository handler as the production worker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  symlink,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as c from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/dist/index.js";
import { WorkerEncryptionService } from "../../tests/reference-node-worker/src/worker-encryption.ts";
import { WorkerRoutingRegistry } from "../../tests/reference-node-worker/src/routing-registry.ts";
import { attachWorkspaceRoot } from "../../tests/reference-node-worker/src/workspace-root-attachment.ts";
import {
  openWorkerRepositoryOperationContent,
  protectWorkerRepositoryOperationContent,
  RepositoryOperationReplayGuard,
} from "../../tests/reference-node-worker/src/repository-operation-encryption.ts";

const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass --binary workspace-fixture");
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "cantrip-native-repository-")),
);
const nodeDirectory = path.join(root, "node"),
  rustDirectory = path.join(root, "rust"),
  tree = path.join(root, "private-root");
await mkdir(path.join(tree, "nested"), { recursive: true });
await mkdir(rustDirectory);
await writeFile(path.join(tree, "dirty.txt"), "untouched private content\n");
const nodeRegistry = new WorkerRoutingRegistry(nodeDirectory);
const attachment = await attachWorkspaceRoot(tree, nodeRegistry);
await copyFile(
  path.join(nodeDirectory, "repository-routing.json"),
  path.join(rustDirectory, "repository-routing.json"),
);
const child = spawn(path.resolve(values.binary), [], {
  env: { ...process.env, PATH: "" },
  stdio: ["pipe", "pipe", "pipe"],
});
let partial = "",
  errors = "",
  sequence = 0,
  comparisons = 0;
const pending = new Map();
child.stderr.on("data", (chunk) => {
  errors = (errors + chunk).slice(-16000);
});
child.stdout.on("data", (chunk) => {
  partial += chunk;
  let end;
  while ((end = partial.indexOf("\n")) >= 0) {
    const message = JSON.parse(partial.slice(0, end));
    partial = partial.slice(end + 1);
    const finish = pending.get(message.id);
    assert.ok(finish);
    pending.delete(message.id);
    finish(message.result);
  }
});
const completion = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => {
    for (const finish of pending.values())
      finish({
        ok: false,
        error: `Driver exited ${code}: ${errors}`,
        code: null,
      });
    pending.clear();
    resolve(code);
  });
});
function rust(input) {
  return new Promise((resolve) => {
    const requestId = ++sequence;
    pending.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ ...input, requestId }) + "\n");
  });
}
async function native(input) {
  const result = await rust(input);
  assert.equal(result.ok, true, result.error);
  return result.value;
}
function same(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  comparisons++;
}
async function compare(input, read, label = input.op) {
  let expected;
  try {
    expected = { ok: true, value: await read() };
  } catch (error) {
    // WorkerConnection publishes only bounded kebab-case failure codes. Node's
    // TextDecoder ERR_ENCODING_INVALID_ENCODED_DATA is not a wire error code.
    const code =
      typeof error.code === "string" &&
      error.code.length <= 100 &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(error.code)
        ? error.code
        : null;
    expected = { ok: false, error: error.message, code };
  }
  same(await rust(input), expected, label);
}
const ownerId = "owner-repository",
  serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workerId = "native-repository",
  serverUrl = "https://repository.test";
const key = new Uint8Array(32).fill(7),
  encoded = c.encodeBase64Url(key);
const binding = {
  serverId,
  projectId: "project-私",
  worktreeId: workerId,
  operationId: crypto.randomUUID(),
  direction: "request",
};
const context = { ownerId, keyRevision: 1, context: binding };
let service;
try {
  await native({ op: "open-registry", directory: rustDirectory });
  const cryptoContext = {
    ...context,
    ownerId: "owner-\ud800",
    context: { ...binding, serverId: "server-私\ud800" },
  };
  await compare({ op: "repository-aad", context: cryptoContext }, () =>
    c.repositoryOperationAssociatedData(cryptoContext),
  );
  const bytes = new TextEncoder().encode(
    '{"type":"workspace.root.attach","arguments":{"rootPath":"/private/fixture"}}',
  );
  const fromNode = await c.encryptRepositoryOperationPayload({
    ...cryptoContext,
    componentKey: key,
    plaintext: bytes,
  });
  await compare(
    {
      op: "repository-decrypt",
      key: encoded,
      context: cryptoContext,
      encrypted: fromNode,
    },
    async () =>
      c.encodeBase64Url(
        await c.decryptRepositoryOperationPayload({
          ...cryptoContext,
          componentKey: key,
          opaque: fromNode,
        }),
      ),
  );
  const fromRust = await native({
    op: "repository-encrypt",
    key: encoded,
    context: cryptoContext,
    bytes: c.encodeBase64Url(bytes),
  });
  same(
    c.encodeBase64Url(
      await c.decryptRepositoryOperationPayload({
        ...cryptoContext,
        componentKey: key,
        opaque: fromRust,
      }),
    ),
    c.encodeBase64Url(bytes),
    "Rust ciphertext opens in Node",
  );
  for (const change of [
    { serverId: "different" },
    { projectId: "different" },
    { worktreeId: "different" },
    { operationId: crypto.randomUUID() },
    { direction: "response" },
  ]) {
    const changed = {
      ...cryptoContext,
      context: { ...cryptoContext.context, ...change },
    };
    await compare(
      {
        op: "repository-decrypt",
        key: encoded,
        context: changed,
        encrypted: fromNode,
      },
      () =>
        c.decryptRepositoryOperationPayload({
          ...changed,
          componentKey: key,
          opaque: fromNode,
        }),
    );
  }
  for (const changed of [
    { ...cryptoContext, ownerId: "different" },
    { ...cryptoContext, keyRevision: 2 },
  ]) {
    await compare(
      {
        op: "repository-decrypt",
        key: encoded,
        context: changed,
        encrypted: fromNode,
      },
      () =>
        c.decryptRepositoryOperationPayload({
          ...changed,
          componentKey: key,
          opaque: fromNode,
        }),
    );
  }
  const types = [
    ...p.repositoryOperationTypeSchema.options,
    "unknown.operation",
  ];
  same(
    await native({ op: "operation-access", types }),
    types.map((type) =>
      p.repositoryOperationTypeSchema.safeParse(type).success
        ? p.repositoryOperationAccess(type)
        : null,
    ),
    "complete current access table",
  );
  for (const [schema, value] of [
    ["workspaceRootAttachArgumentsSchema", { rootPath: " \t" + tree + "\n" }],
    ["workspaceRootAttachArgumentsSchema", { rootPath: " " }],
    ["workspaceRootAttachArgumentsSchema", { rootPath: tree, extra: true }],
    [
      "repositoryMetadataValuesSchema",
      { path: "private", warnings: ["one"], name: null },
    ],
    ["repositoryMetadataValuesSchema", { unsupported: "private" }],
    [
      "repositoryMetadataValuesSchema",
      Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => ["unsupported" + i, "private"]),
      ),
    ],
    [
      "repositoryMetadataValuesSchema",
      JSON.parse('{"__proto__":"private","path":"valid"}'),
    ],
  ]) {
    const parsed = p[schema].safeParse(value);
    same(
      await native({ op: "schema-validate", schema, value }),
      parsed.success ? { ok: parsed.data } : { issues: parsed.error.issues },
      schema,
    );
  }
  for (const requested of [
    tree,
    " \t" + path.join(tree, "nested", "..") + "\n",
    "relative",
    path.join(root, "missing"),
    path.join(tree, "dirty.txt"),
  ]) {
    await compare({ op: "attach", root: requested }, () =>
      attachWorkspaceRoot(requested, nodeRegistry),
    );
  }
  if (process.platform !== "win32") {
    const alias = path.join(root, "alias");
    await symlink(tree, alias);
    await compare({ op: "attach", root: alias }, () =>
      attachWorkspaceRoot(alias, nodeRegistry),
    );
  }
  service = await WorkerEncryptionService.open({
    dataDirectory: nodeDirectory,
    serverUrl,
    workerId,
  });
  await copyFile(
    path.join(nodeDirectory, "worker-encryption-key.json"),
    path.join(rustDirectory, "worker-encryption-key.json"),
  );
  same(
    await native({
      op: "open-service",
      directory: rustDirectory,
      serverUrl,
      workerId,
    }),
    service.registration(),
    "compatible endpoint identity",
  );
  const registration = service.registration(),
    at = "2026-11-16T00:00:00.000Z";
  async function grant(keyRevision) {
    return {
      id: crypto.randomUUID(),
      ownerId,
      principalId: registration.principalId,
      component: "repository-content",
      keyRevision,
      wrappedKey: await c.wrapComponentKeyForWorker({
        ownerId,
        workerId,
        component: "repository-content",
        keyRevision,
        componentKey: key,
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
  const first = await grant(1),
    second = await grant(2);
  async function authorize(grants) {
    const payload = {
      serverId,
      ownerId,
      principal: {
        id: registration.principalId,
        ownerId,
        kind: "worker",
        workerId,
        label: "Repository fixture",
        publicKey: registration.publicKey,
        state: "approved",
        revision: 1,
        approvedAt: at,
        revokedAt: null,
        revokedReason: null,
        createdAt: at,
        updatedAt: at,
      },
      grants,
    };
    const nativeStatus = await native({ op: "accept", payload });
    const nodeStatus = await service.acceptBootstrap(payload);
    const withoutClock = ({ lastSyncedAt, ...status }) => {
      assert.ok(Number.isFinite(Date.parse(lastSyncedAt)));
      return status;
    };
    same(
      withoutClock(nativeStatus),
      withoutClock(nodeStatus),
      "authorization status",
    );
  }
  await authorize([first]);
  const schema = "repositoryOperationRequestContentSchema",
    content = { type: "workspace.root.attach", arguments: { rootPath: tree } };
  const protectedRequest = await protectWorkerRepositoryOperationContent({
    context: binding,
    content,
    schema: p[schema],
    service,
  });
  await compare(
    {
      op: "worker-repository-open",
      context: binding,
      encrypted: protectedRequest,
      schema,
    },
    () =>
      openWorkerRepositoryOperationContent({
        context: binding,
        opaque: protectedRequest,
        schema: p[schema],
        service,
      }),
  );
  const protectedNative = await native({
    op: "worker-repository-protect",
    context: binding,
    content,
    schema,
  });
  same(
    await openWorkerRepositoryOperationContent({
      context: binding,
      opaque: protectedNative,
      schema: p[schema],
      service,
    }),
    content,
    "native worker helper opens in Node",
  );
  for (const plaintext of [
    new Uint8Array([0xc3, 0x28]),
    new TextEncoder().encode("{"),
    new TextEncoder().encode("{}"),
  ]) {
    const opaque = await c.encryptRepositoryOperationPayload({
      ...context,
      componentKey: key,
      plaintext,
    });
    await compare(
      {
        op: "worker-repository-open",
        context: binding,
        encrypted: opaque,
        schema,
      },
      () =>
        openWorkerRepositoryOperationContent({
          context: binding,
          opaque,
          schema: p[schema],
          service,
        }),
      "authenticated plaintext errors",
    );
  }
  async function makeCommand(content, changes = {}) {
    const context = { ...binding, operationId: crypto.randomUUID() };
    const opaque = await protectWorkerRepositoryOperationContent({
      context,
      content,
      schema: p.repositoryOperationRequestContentSchema,
      service,
    });
    return {
      type: "repository.operation",
      ...context,
      direction: undefined,
      cwd: ".",
      sourcePath: ".",
      repository: null,
      agentRuntimes: [],
      mcpServers: [],
      protectedRequest: opaque,
      access: p.repositoryOperationAccess(content.type),
      agent: false,
      routingPurpose:
        content.type === "workspace.root.attach"
          ? "workspace-root-attachment"
          : "repository",
      ...changes,
    };
  }
  async function runCommand(content, changes) {
    const command = await makeCommand(content, changes);
    const response = await native({ op: "repository-command", command });
    const opened = await openWorkerRepositoryOperationContent({
      context: {
        serverId: command.serverId,
        projectId: command.projectId,
        worktreeId: command.worktreeId,
        operationId: command.operationId,
        direction: "response",
      },
      opaque: response.protectedResponse,
      schema: p.repositoryOperationOutcomeContentSchema,
      service,
    });
    assert.equal(
      JSON.stringify(response).includes(tree),
      false,
      "only opaque content leaves worker",
    );
    return { response, opened };
  }
  const attached = await runCommand(content);
  same(
    attached.opened,
    { ok: true, result: attachment },
    "actual native encrypted attachment outcome",
  );
  same(
    attached.response.workspaceRootAttachment,
    attachment,
    "server receives only attachment handles",
  );
  const invalid = await runCommand({
    type: "workspace.root.attach",
    arguments: { rootPath: "relative" },
  });
  same(
    invalid.opened,
    {
      ok: false,
      error: "Workspace root must be an absolute path on the worker.",
      code: "invalid-root",
    },
    "private typed attachment error",
  );
  assert.equal(invalid.response.workspaceRootAttachment, undefined);
  for (const [request, validate] of [
    [
      { type: "workspace.root.attach", arguments: { rootPath: " " } },
      p.workspaceRootAttachArgumentsSchema,
    ],
    [
      {
        type: "workspace.root.attach",
        arguments: { rootPath: tree, extra: true },
      },
      p.workspaceRootAttachArgumentsSchema,
    ],
    [
      {
        type: "repository.metadata.register",
        arguments: { values: { unsupported: "private" } },
      },
      p.repositoryMetadataValuesSchema,
    ],
  ]) {
    let expected;
    try {
      validate.parse(
        request.type === "repository.metadata.register"
          ? request.arguments.values
          : request.arguments,
      );
    } catch (error) {
      expected = { ok: false, error: error.message.slice(0, 2000) };
    }
    assert.ok(expected);
    same(
      (await runCommand(request)).opened,
      expected,
      "private argument validation errors",
    );
  }
  for (const [changes, error] of [
    [{ access: "read" }, "Repository operation access metadata is invalid."],
    [
      { routingPurpose: "repository" },
      "Repository operation routing purpose is invalid.",
    ],
  ]) {
    const command = await makeCommand(content, changes);
    same(
      await rust({ op: "repository-command", command }),
      { ok: false, error, code: null },
      "public routing admission",
    );
  }
  same(
    (await runCommand(content, { agent: true })).opened,
    { ok: false, error: "Repository agent routing metadata is invalid." },
    "agent mismatch stays encrypted",
  );
  const metadata = {
    path: "/fixture/private-私",
    branch: "private-branch\ud800",
  };
  const registered = await runCommand({
    type: "repository.metadata.register",
    arguments: { values: metadata },
  });
  const handles = registered.opened.result.values;
  assert.ok(registered.opened.ok);
  same(
    await new WorkerRoutingRegistry(rustDirectory).resolveMetadata(handles),
    metadata,
    "actual Node reopens native repository registration",
  );
  same(
    (
      await runCommand({
        type: "repository.metadata.resolve",
        arguments: { values: handles },
      })
    ).opened,
    { ok: true, result: { values: metadata } },
    "private metadata resolution",
  );
  const bad = await makeCommand(content);
  bad.protectedRequest.envelope.ciphertext = c.encodeBase64Url(
    new Uint8Array(32),
  );
  same(
    await rust({ op: "repository-command", command: bad }),
    {
      ok: false,
      error: "Protected repository content could not be authenticated.",
      code: null,
    },
    "authentication rejected",
  );
  same(
    await rust({ op: "repository-command", command: bad }),
    {
      ok: false,
      error: "Protected repository operation was already completed.",
      code: null,
    },
    "failed opening consumes reservation",
  );
  const replay = new RepositoryOperationReplayGuard();
  for (const context of [
    binding,
    { ...binding, direction: "response" },
    { ...binding, projectId: "other" },
  ]) {
    await compare({ op: "replay-reserve", context }, () => {
      replay.reserve(context);
      return null;
    });
  }
  await authorize([first, second]);
  const latest = await native({
    op: "worker-repository-protect",
    context: binding,
    content,
    schema,
  });
  assert.equal(latest.keyRevision, 2);
  same(
    await openWorkerRepositoryOperationContent({
      context: binding,
      opaque: latest,
      schema: p[schema],
      service,
    }),
    content,
    "native protection selects latest revision",
  );
  await compare(
    {
      op: "worker-repository-open",
      context: binding,
      encrypted: protectedRequest,
      schema,
    },
    () =>
      openWorkerRepositoryOperationContent({
        context: binding,
        opaque: protectedRequest,
        schema: p[schema],
        service,
      }),
  );
  await compare(
    {
      op: "worker-repository-open",
      context: binding,
      encrypted: protectedRequest,
      schema,
      historical: true,
    },
    () =>
      openWorkerRepositoryOperationContent({
        context: binding,
        opaque: protectedRequest,
        schema: p[schema],
        service,
        allowHistoricalKeyRevision: true,
      }),
  );
  await authorize([second]);
  await compare(
    {
      op: "worker-repository-open",
      context: binding,
      encrypted: protectedRequest,
      schema,
      historical: true,
    },
    () =>
      openWorkerRepositoryOperationContent({
        context: binding,
        opaque: protectedRequest,
        schema: p[schema],
        service,
        allowHistoricalKeyRevision: true,
      }),
  );
  service.lock();
  await native({ op: "lock" });
  await compare(
    {
      op: "worker-repository-open",
      context: binding,
      encrypted: protectedRequest,
      schema,
    },
    () =>
      openWorkerRepositoryOperationContent({
        context: binding,
        opaque: protectedRequest,
        schema: p[schema],
        service,
      }),
  );
  assert.equal(
    await readFile(path.join(tree, "dirty.txt"), "utf8"),
    "untouched private content\n",
  );
  console.log(
    JSON.stringify({
      suite: "native-repository-compatibility",
      passed: true,
      comparisons,
      bidirectionalCrypto: true,
      realRootAttachment: true,
      opaquePaths: true,
      metadataRegistration: true,
      replayAndLatestKeyPolicy: true,
      scope:
        "Native root attachment/metadata; Git/GitHub operation execution remains pending.",
    }),
  );
} finally {
  service?.lock();
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    assert.equal(await completion, 0, errors);
  } finally {
    clearTimeout(timer);
    key.fill(0);
    await rm(root, { recursive: true, force: true });
  }
}
