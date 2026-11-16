// Synthetic local content fixtures; never use actual credentials/profiles.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as c from "../../packages/crypto/src/index.ts";
import { CantripDecryptionError as WorkerDecryptionError } from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/src/index.ts";
import { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.ts";
import * as worker from "../../cantrip_worker/src/protected-secrets.ts";

const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass built --binary content-fixture");
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-content-compatibility-"),
);
const child = spawn(path.resolve(values.binary), [], {
  stdio: ["pipe", "pipe", "pipe"],
});
let sequence = 0,
  partial = "",
  stderr = "",
  comparisons = 0;
const pending = new Map();
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-16000);
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
        error: `fixture exited ${code}: ${stderr}`,
        decryption: false,
      });
    pending.clear();
    resolve(code);
  });
});
function rust(input) {
  const requestId = ++sequence;
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ ...input, requestId }) + "\n");
  });
}
async function native(input) {
  const result = await rust(input);
  assert.equal(result.ok, true, result.error);
  return result.value;
}
async function observe(read) {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      decryption:
        error instanceof c.CantripDecryptionError ||
        error instanceof WorkerDecryptionError,
    };
  }
}
async function compare(input, reference, label = input.op) {
  const actual = await rust(input),
    expected = await observe(reference);
  assert.deepEqual(actual, expected, label);
  comparisons++;
  return actual;
}
function same(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  comparisons++;
}
const key = new Uint8Array(32).fill(7),
  encoded = c.encodeBase64Url(key),
  bytes = (value) => c.encodeBase64Url(value);
const secret = {
  ownerId: "owner-\ud800",
  component: "provider-credential",
  table: "model_providers",
  rowId: "provider-1",
  field: "protected_api_key",
  keyRevision: 1,
};
const inputFor = (context) => ({ ...context, componentKey: key });
let service;
try {
  const schema = "providerApiKeyProtectedContentSchema",
    content = { version: 1, apiKey: "  synthetic\ud800  " };
  const fromNode = await c.encryptProtectedSecret({
    ...inputFor(secret),
    content,
    contentSchema: p[schema],
  });
  await compare(
    {
      op: "secret-decrypt",
      key: encoded,
      context: secret,
      encrypted: fromNode,
      schema,
    },
    () =>
      c.decryptProtectedSecret({
        ...inputFor(secret),
        encrypted: fromNode,
        contentSchema: p[schema],
      }),
  );
  const fromRust = await native({
    op: "secret-encrypt",
    key: encoded,
    context: secret,
    content,
    schema,
  });
  same(
    await c.decryptProtectedSecret({
      ...inputFor(secret),
      encrypted: fromRust,
      contentSchema: p[schema],
    }),
    p[schema].parse(content),
    "native secret opens in Node",
  );
  for (const change of [
    { rowId: "other" },
    { ownerId: "other" },
    { field: "protected_label" },
    { keyRevision: 2 },
  ]) {
    const context = { ...secret, ...change };
    await compare(
      {
        op: "secret-decrypt",
        key: encoded,
        context,
        encrypted: fromNode,
        schema,
      },
      () =>
        c.decryptProtectedSecret({
          ...inputFor(context),
          encrypted: fromNode,
          contentSchema: p[schema],
        }),
    );
  }
  const aad = p.encryptionAssociatedDataSchema.parse({
    ...secret,
    formatVersion: 1,
  });
  const fieldKey = c.deriveFieldKey({ ...inputFor(secret) });
  for (const plaintext of [
    new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('{"version":1,"apiKey":"BOM"}'),
    ]),
    new Uint8Array([0xc3, 0x28]),
    new TextEncoder().encode("{"),
    new TextEncoder().encode('{"version":2,"apiKey":"wrong schema"}'),
  ]) {
    const encrypted = {
      formatVersion: 1,
      keyRevision: 1,
      envelope: await c.encryptPayload({
        key: fieldKey,
        plaintext,
        associatedData: aad,
      }),
    };
    await compare(
      {
        op: "secret-decrypt",
        key: encoded,
        context: secret,
        encrypted,
        schema,
      },
      () =>
        c.decryptProtectedSecret({
          ...inputFor(secret),
          encrypted,
          contentSchema: p[schema],
        }),
      "strict UTF-8, BOM and decrypted schema",
    );
  }
  fieldKey.fill(0);
  await compare(
    {
      op: "secret-encrypt",
      key: encoded,
      context: secret,
      content,
      schema,
      maximum: 1,
    },
    () =>
      c.encryptProtectedSecret({
        ...inputFor(secret),
        content,
        contentSchema: p[schema],
        maximumBytes: 1,
      }),
  );
  await compare(
    {
      op: "secret-decrypt",
      key: encoded,
      context: secret,
      encrypted: fromNode,
      schema,
      maximum: 1,
    },
    () =>
      c.decryptProtectedSecret({
        ...inputFor(secret),
        encrypted: fromNode,
        contentSchema: p[schema],
        maximumBytes: 1,
      }),
  );

  const endpoint = {
    ownerId: secret.ownerId,
    keyRevision: 1,
    context: {
      domain: "run-content",
      serverId: "server-\ud800",
      workerId: null,
      scopeId: "scope-1",
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      operation: "run",
      direction: "request",
      sequence: 2,
    },
  };
  const data = new Uint8Array([0, 255, 128, 1]);
  await compare({ op: "endpoint-aad", context: endpoint }, () =>
    c.endpointContentAssociatedData(endpoint),
  );
  const endpointNode = await c.encryptEndpointContentPayload({
    ...inputFor(endpoint),
    plaintext: data,
  });
  await compare(
    {
      op: "endpoint-decrypt",
      key: encoded,
      context: endpoint,
      encrypted: endpointNode,
    },
    async () =>
      bytes(
        await c.decryptEndpointContentPayload({
          ...inputFor(endpoint),
          opaque: endpointNode,
        }),
      ),
  );
  const endpointRust = await native({
    op: "endpoint-encrypt",
    key: encoded,
    context: endpoint,
    bytes: bytes(data),
  });
  same(
    bytes(
      await c.decryptEndpointContentPayload({
        ...inputFor(endpoint),
        opaque: endpointRust,
      }),
    ),
    bytes(data),
    "native endpoint opens in Node",
  );
  for (const change of [
    { serverId: "other" },
    { sequence: 3 },
    { direction: "response" },
    { workerId: "other" },
  ]) {
    const context = {
      ...endpoint,
      context: { ...endpoint.context, ...change },
    };
    await compare(
      {
        op: "endpoint-decrypt",
        key: encoded,
        context,
        encrypted: endpointNode,
      },
      async () =>
        bytes(
          await c.decryptEndpointContentPayload({
            ...inputFor(context),
            opaque: endpointNode,
          }),
        ),
    );
  }
  const longContext = {
    ...endpoint,
    context: { ...endpoint.context, scopeId: "x".repeat(500) },
  };
  await compare(
    { op: "endpoint-encrypt", key: encoded, context: longContext, bytes: "" },
    () =>
      c.encryptEndpointContentPayload({
        ...inputFor(longContext),
        plaintext: new Uint8Array(),
      }),
  );

  for (const recordKind of p.privateDisplayLabelRecordKindSchema.options) {
    const context = {
      ownerId: secret.ownerId,
      recordKind,
      rowId: "row-1",
      keyRevision: 1,
    };
    const label = " label \ud800 🦀";
    await compare({ op: "label-aad", context }, () =>
      c.privateDisplayLabelAssociatedData(context),
    );
    const encrypted = await c.encryptPrivateDisplayLabel({
      ...inputFor(context),
      label,
    });
    await compare(
      { op: "label-decrypt", key: encoded, context, encrypted },
      () =>
        c.decryptPrivateDisplayLabel({
          ...inputFor(context),
          opaque: encrypted,
        }),
    );
    const nativeLabel = await native({
      op: "label-encrypt",
      key: encoded,
      context,
      label,
    });
    same(
      await c.decryptPrivateDisplayLabel({
        ...inputFor(context),
        opaque: nativeLabel,
      }),
      label,
      "native label opens in Node",
    );
  }
  const labelContext = {
    ownerId: "owner",
    recordKind: "project",
    rowId: "project",
    keyRevision: 1,
  };
  await compare(
    {
      op: "label-encrypt",
      key: encoded,
      context: labelContext,
      label: "\0".repeat(1000),
    },
    () =>
      c.encryptPrivateDisplayLabel({
        ...inputFor(labelContext),
        label: "\0".repeat(1000),
      }),
  );
  const labelAad = c.privateDisplayLabelAssociatedData(labelContext),
    labelKey = c.deriveFieldKey({ componentKey: key, ...labelAad });
  const labelForged = {
    classification: { recordKind: "project" },
    protectedLabel: {
      formatVersion: 1,
      keyRevision: 1,
      envelope: await c.encryptPayload({
        key: labelKey,
        associatedData: labelAad,
        plaintext: new TextEncoder().encode(
          JSON.stringify({
            version: 1,
            classification: { recordKind: "chat" },
            label: "wrong classification",
          }),
        ),
      }),
    },
  };
  await compare(
    {
      op: "label-decrypt",
      key: encoded,
      context: labelContext,
      encrypted: labelForged,
    },
    () =>
      c.decryptPrivateDisplayLabel({
        ...inputFor(labelContext),
        opaque: labelForged,
      }),
  );
  labelKey.fill(0);

  const attachment = {
    ownerId: secret.ownerId,
    chatId: "chat",
    attachmentId: "attachment",
    keyRevision: 1,
  };
  const metadata = {
    version: 1,
    fileName: "example.bin",
    mimeType: "application/octet-stream",
    kind: "file",
    source: "file",
    previewText: "preview\ud800",
    sha256: c.attachmentContentDigest(data),
    error: null,
  };
  await compare({ op: "digest", bytes: bytes(data) }, () =>
    c.attachmentContentDigest(data),
  );
  const metadataNode = await c.encryptAttachmentMetadata({
    ...inputFor(attachment),
    content: metadata,
  });
  await compare(
    {
      op: "metadata-decrypt",
      key: encoded,
      context: attachment,
      encrypted: metadataNode,
    },
    () =>
      c.decryptAttachmentMetadata({
        ...inputFor(attachment),
        encrypted: metadataNode,
      }),
  );
  const metadataRust = await native({
    op: "metadata-encrypt",
    key: encoded,
    context: attachment,
    content: metadata,
  });
  same(
    await c.decryptAttachmentMetadata({
      ...inputFor(attachment),
      encrypted: metadataRust,
    }),
    metadata,
    "native metadata opens in Node",
  );
  await compare(
    {
      op: "metadata-encrypt",
      key: encoded,
      context: attachment,
      content: { ...metadata, previewText: "\0".repeat(8000) },
    },
    () =>
      c.encryptAttachmentMetadata({
        ...inputFor(attachment),
        content: { ...metadata, previewText: "\0".repeat(8000) },
      }),
  );
  const chunk = {
    ...attachment,
    operationId: "operation-1",
    direction: "upload",
    sequence: 0,
    eof: true,
  };
  for (const plaintext of [new Uint8Array(), data]) {
    const encrypted = await c.encryptAttachmentChunk({
      ...inputFor(chunk),
      plaintext,
    });
    await compare(
      { op: "chunk-decrypt", key: encoded, context: chunk, encrypted },
      async () =>
        bytes(
          await c.decryptAttachmentChunk({ ...inputFor(chunk), encrypted }),
        ),
    );
    const encryptedRust = await native({
      op: "chunk-encrypt",
      key: encoded,
      context: chunk,
      bytes: bytes(plaintext),
    });
    same(
      bytes(
        await c.decryptAttachmentChunk({
          ...inputFor(chunk),
          encrypted: encryptedRust,
        }),
      ),
      bytes(plaintext),
      "native chunk opens in Node",
    );
    for (const changed of [
      { ...encrypted, eof: false },
      { ...encrypted, plaintextBytes: encrypted.plaintextBytes + 1 },
      { ...encrypted, sequence: 1 },
    ])
      await compare(
        {
          op: "chunk-decrypt",
          key: encoded,
          context: chunk,
          encrypted: changed,
        },
        async () =>
          bytes(
            await c.decryptAttachmentChunk({
              ...inputFor(chunk),
              encrypted: changed,
            }),
          ),
      );
  }
  const oversize = new Uint8Array(p.ATTACHMENT_MAX_CHUNK_BYTES + 1);
  await compare(
    {
      op: "chunk-encrypt",
      key: encoded,
      context: chunk,
      bytes: bytes(oversize),
    },
    () => c.encryptAttachmentChunk({ ...inputFor(chunk), plaintext: oversize }),
  );

  // Worker-side provider/MCP facade checks are appended below.
  const nodeDirectory = path.join(root, "node"),
    rustDirectory = path.join(root, "rust"),
    serverUrl = "https://content.test",
    workerId = "worker-content",
    ownerId = "owner-content";
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
    "same real endpoint identity",
  );
  await compare(
    {
      op: "mcp-open",
      servers: [{ enabled: false, protectedConfiguration: null }],
    },
    () =>
      worker.openMcpServers({
        service,
        servers: [{ enabled: false, protectedConfiguration: null }],
      }),
  );
  for (const name of ["CANTRIP", " codegraph ", "cantrip_cua"]) {
    const configuration = { name, transport: "stdio", command: "tool" };
    await compare({ op: "mcp-protect", workerId, configuration }, () =>
      worker.protectDiscoveredMcpServer({ service, workerId, configuration }),
    );
  }
  const registration = service.registration(),
    at = "2026-11-16T00:00:00.000Z";
  async function makeGrant(component, keyRevision, keyValue) {
    const wrappedKey = await c.wrapComponentKeyForWorker({
      ownerId,
      workerId,
      component,
      keyRevision,
      componentKey: new Uint8Array(32).fill(keyValue),
      workerPublicKey: registration.publicKey,
    });
    return {
      id: crypto.randomUUID(),
      ownerId,
      principalId: registration.principalId,
      component,
      keyRevision,
      wrappedKey,
      state: "active",
      revision: 1,
      revokedAt: null,
      revokedReason: null,
      createdAt: at,
      updatedAt: at,
    };
  }
  const providerGrant = await makeGrant("provider-credential", 1, 7),
    mcpGrant = await makeGrant("mcp-secret", 1, 7);
  function bootstrap(grants) {
    return {
      serverId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ownerId,
      principal: {
        id: registration.principalId,
        ownerId,
        kind: "worker",
        workerId,
        label: "Content fixture",
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
  }
  const authorization = bootstrap([providerGrant, mcpGrant]);
  await service.acceptBootstrap(authorization);
  assert.equal(
    (await native({ op: "accept", payload: authorization })).state,
    "ready",
  );
  const provider = {
    id: "provider-1",
    kind: "openai",
    protectedApiKey: await c.encryptProtectedSecret({
      ownerId,
      component: "provider-credential",
      table: "model_providers",
      rowId: "provider-1",
      field: "protected_api_key",
      keyRevision: 1,
      componentKey: key,
      content: { version: 1, apiKey: "  synthetic-api-key  " },
      contentSchema: p.providerApiKeyProtectedContentSchema,
    }),
  };
  await compare({ op: "provider-open-runtime", provider }, () =>
    worker.openRuntimeProvider({ service, provider }),
  );
  await compare(
    {
      op: "provider-open-runtime",
      provider: { id: "none", protectedApiKey: null },
    },
    () =>
      worker.openRuntimeProvider({
        service,
        provider: { id: "none", protectedApiKey: null },
      }),
  );
  let retained;
  for (const credential of [
    {
      version: 1,
      kind: "grok",
      accessToken: "synthetic-token",
      refreshToken: null,
      email: null,
      expiresAt: 1700000000000,
      planType: null,
      userId: "user-\ud800",
    },
    {
      version: 1,
      kind: "chatgpt",
      accessToken: "synthetic-token",
      refreshToken: "synthetic-refresh",
      email: "fixture@example.invalid",
      expiresAt: null,
      planType: "test",
      accountId: "account-\ud800",
      idToken: null,
      userId: null,
    },
  ]) {
    const accountId = "account-1",
      protectedNode = await worker.protectProviderCredential({
        service,
        accountId,
        credential,
      });
    await compare(
      { op: "provider-open", accountId, credential: protectedNode.credential },
      () =>
        worker.openProviderCredential({
          service,
          accountId,
          credential: protectedNode.credential,
        }),
    );
    const protectedRust = await native({
      op: "provider-protect",
      accountId,
      credential,
    });
    same(
      protectedRust.metadata,
      protectedNode.metadata,
      "provider expiry metadata",
    );
    same(
      protectedRust.credential.subjectBlindIndex,
      protectedNode.credential.subjectBlindIndex,
      "provider subject binding",
    );
    same(
      await worker.openProviderCredential({
        service,
        accountId,
        credential: protectedRust.credential,
      }),
      p.providerCredentialProtectedContentSchema.parse(credential),
      "native credential opens in Node",
    );
    await compare({ op: "provider-subject", credential }, () =>
      worker.providerCredentialSubjectBlindIndex({ service, credential }),
    );
    const wrong = {
      ...protectedNode.credential,
      subjectBlindIndex: bytes(new Uint8Array(32)),
    };
    await compare({ op: "provider-open", accountId, credential: wrong }, () =>
      worker.openProviderCredential({ service, accountId, credential: wrong }),
    );
    await compare(
      {
        op: "provider-open",
        accountId: "other",
        credential: protectedNode.credential,
      },
      () =>
        worker.openProviderCredential({
          service,
          accountId: "other",
          credential: protectedNode.credential,
        }),
    );
    retained = protectedNode.credential;
  }
  for (const configuration of [
    {
      name: "Example_Stdio",
      transport: "stdio",
      command: "synthetic-tool",
      enabled: false,
      environment: { " TOKEN ": "synthetic-secret" },
    },
    {
      name: "Example_Http",
      transport: "http",
      url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer synthetic" },
    },
  ]) {
    const protectedRust = await native({
      op: "mcp-protect",
      workerId,
      configuration,
    });
    const protectedNode = await worker.protectDiscoveredMcpServer({
      service,
      workerId,
      configuration,
    });
    same(
      protectedRust.nameBlindIndex,
      protectedNode.nameBlindIndex,
      "MCP blind name tag",
    );
    same(
      await worker.openMcpServers({ service, servers: [protectedRust] }),
      [
        p.mcpServerConfigurationSchema.parse({
          ...configuration,
          enabled: true,
        }),
      ],
      "native MCP configuration opens in Node",
    );
    await compare({ op: "mcp-open", servers: [protectedNode] }, () =>
      worker.openMcpServers({ service, servers: [protectedNode] }),
    );
  }
  for (const environment of [
    Object.fromEntries(Array.from({ length: 101 }, (_, i) => ["K" + i, "x"])),
    Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => ["K" + i, "🦀".repeat(32768)]),
    ),
    { " DUP ": "first", DUP: "last" },
    { " __proto__ ": "ignored", " KEY ": "retained" },
  ]) {
    const configuration = {
      name: "Collection",
      transport: "stdio",
      command: "tool",
      environment,
    };
    await compare(
      {
        op: "validate",
        schema: "mcpServerConfigurationSchema",
        content: configuration,
      },
      () => p.mcpServerConfigurationSchema.parse(configuration),
      "MCP record refinement and UTF-16 bounds",
    );
  }
  const rotated = bootstrap([
    providerGrant,
    await makeGrant("provider-credential", 2, 8),
    mcpGrant,
  ]);
  await service.acceptBootstrap(rotated);
  await native({ op: "accept", payload: rotated });
  await compare(
    { op: "provider-open", accountId: "account-1", credential: retained },
    () =>
      worker.openProviderCredential({
        service,
        accountId: "account-1",
        credential: retained,
      }),
    "existing latest-key selection behavior",
  );
  console.log(
    JSON.stringify({
      suite: "native-protected-content-compatibility",
      passed: true,
      comparisons,
      bidirectionalContent: true,
      utf16AndBom: true,
      authenticatedMetadataAndPlaintextValidation: true,
      providerSubjectsAndMcpSecrets: true,
      mcpCollectionLimits: true,
      latestKeyPolicy: true,
      scope:
        "Formats and worker secret adapters; serving resource/execution/stream lifetimes remain pending.",
    }),
  );
} finally {
  service?.lock();
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    assert.equal(await completion, 0, stderr);
  } finally {
    clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
}
