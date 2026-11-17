// Actual local Node/Rust stream comparisons. Synthetic keys/profiles only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as c from "../../packages/crypto/src/index.ts";
import { CantripDecryptionError as WorkerDecryptionError } from "../../packages/crypto/dist/index.js";
import * as p from "../../packages/protocol/src/index.ts";
import * as remote from "../../packages/protocol/src/remote-surface-stream.ts";
import * as endpointWorker from "../../cantrip_worker/src/endpoint-content-encryption.ts";
import * as surfaceWorker from "../../cantrip_worker/src/surface-stream-encryption.ts";
import * as remoteWorker from "../../cantrip_worker/src/remote-surface-stream-encryption.ts";
import * as tunnel from "../../cantrip_worker/src/tunnel-data-protection.ts";
import { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.ts";

const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "Pass built --binary content-fixture");
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-stream-compatibility-"),
);
const child = spawn(path.resolve(values.binary), [], {
  stdio: ["pipe", "pipe", "pipe"],
});
let sequence = 0,
  partial = "",
  stderr = "",
  comparisons = 0;
const pending = new Map();
child.stderr.on("data", (bytes) => {
  stderr = (stderr + bytes).slice(-16000);
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
  assert.deepEqual(await rust(input), await observe(reference), label);
  comparisons++;
}
function same(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  comparisons++;
}
const bytes = c.encodeBase64Url,
  decode = c.decodeBase64Url,
  key = new Uint8Array(32).fill(7),
  encoded = bytes(key),
  encoder = new TextEncoder();
const surfaceContext = {
  serverId: "server-\ud800",
  surfaceKind: "terminal",
  surfaceId: "surface",
  operationId: "operation",
  direction: "input",
  sequence: 0,
};
const remoteContext = {
  serverId: "server-\ud800",
  surfaceKind: "browser",
  surfaceId: "surface",
  attachmentId: "attachment",
  direction: "worker-to-client",
  channel: "frame",
  sequence: 0,
};
const cryptoInput = (context) => ({
  ownerId: "owner-stream",
  keyRevision: 3,
  context,
  componentKey: key,
});
const outer = (context) => ({
  ownerId: "owner-stream",
  keyRevision: 3,
  context,
});
let service;
try {
  for (const surfaceKind of [
    "terminal",
    "explorer",
    "file-document",
    "chat-files",
  ]) {
    const context = { ...surfaceContext, surfaceKind },
      input = cryptoInput(context),
      plaintext = new Uint8Array([0, 255, 128, 13, 10]);
    await compare({ op: "surface-aad", context: outer(context) }, () =>
      c.surfaceStreamAssociatedData(input),
    );
    const node = await c.encryptSurfaceStreamPayload({ ...input, plaintext });
    await compare(
      {
        op: "surface-decrypt",
        key: encoded,
        context: outer(context),
        encrypted: node,
      },
      async () =>
        bytes(await c.decryptSurfaceStreamPayload({ ...input, opaque: node })),
    );
    const nativePayload = await native({
      op: "surface-encrypt",
      key: encoded,
      context: outer(context),
      bytes: bytes(plaintext),
    });
    same(
      bytes(
        await c.decryptSurfaceStreamPayload({
          ...input,
          opaque: nativePayload,
        }),
      ),
      bytes(plaintext),
      "native surface payload opens in Node",
    );
    if (surfaceKind === "terminal") {
      for (const change of [
        { sequence: 1 },
        { direction: "output" },
        { serverId: "other" },
        { surfaceId: "other" },
        { operationId: "other" },
      ]) {
        const wrong = { ...context, ...change };
        await compare(
          {
            op: "surface-decrypt",
            key: encoded,
            context: outer(wrong),
            encrypted: node,
          },
          async () =>
            bytes(
              await c.decryptSurfaceStreamPayload({
                ...cryptoInput(wrong),
                opaque: node,
              }),
            ),
        );
      }
      for (const encrypted of [
        { ...node, keyRevision: 4 },
        { ...node, envelope: { ...node.envelope, keyRevision: 4 } },
        { ...node, formatVersion: 2 },
      ]) {
        await compare(
          {
            op: "surface-decrypt",
            key: encoded,
            context: outer(context),
            encrypted,
          },
          async () =>
            bytes(
              await c.decryptSurfaceStreamPayload({
                ...input,
                opaque: encrypted,
              }),
            ),
        );
      }
    }
  }
  const tooLarge = new Uint8Array(
    p.SURFACE_STREAM_PROTECTED_CONTENT_BYTES_LIMIT + 1,
  );
  await compare(
    {
      op: "surface-encrypt",
      key: encoded,
      context: outer(surfaceContext),
      bytes: bytes(tooLarge),
    },
    () =>
      c.encryptSurfaceStreamPayload({
        ...cryptoInput(surfaceContext),
        plaintext: tooLarge,
      }),
  );
  for (const surfaceKind of ["browser", "desktop"]) {
    const context = { ...remoteContext, surfaceKind },
      input = cryptoInput(context);
    await compare({ op: "remote-aad", context: outer(context) }, () =>
      c.remoteSurfaceStreamAssociatedData(input),
    );
    for (const plaintext of [
      new Uint8Array(),
      new Uint8Array([0, 255, 128, 13, 10]),
    ]) {
      const node = await c.encryptRemoteSurfaceStreamPayload({
        ...input,
        plaintext,
      });
      await compare(
        {
          op: "remote-decrypt",
          key: encoded,
          context: outer(context),
          bytes: bytes(node),
        },
        async () =>
          bytes(
            await c.decryptRemoteSurfaceStreamPayload({
              ...input,
              protectedPayload: node,
            }),
          ),
      );
      const nativePayload = decode(
        await native({
          op: "remote-encrypt",
          key: encoded,
          context: outer(context),
          bytes: bytes(plaintext),
        }),
      );
      same(
        bytes(
          await c.decryptRemoteSurfaceStreamPayload({
            ...input,
            protectedPayload: nativePayload,
          }),
        ),
        bytes(plaintext),
        "native remote payload opens in Node",
      );
      if (plaintext.length) {
        for (const change of [
          { attachmentId: "other" },
          { channel: "cursor" },
          { sequence: 1 },
          { direction: "client-to-worker" },
        ]) {
          const wrong = { ...context, ...change };
          await compare(
            {
              op: "remote-decrypt",
              key: encoded,
              context: outer(wrong),
              bytes: bytes(node),
            },
            async () =>
              bytes(
                await c.decryptRemoteSurfaceStreamPayload({
                  ...cryptoInput(wrong),
                  protectedPayload: node,
                }),
              ),
          );
        }
        const bad = node.slice();
        bad[bad.length - 1] ^= 1;
        await compare(
          {
            op: "remote-decrypt",
            key: encoded,
            context: outer(context),
            bytes: bytes(bad),
          },
          async () =>
            bytes(
              await c.decryptRemoteSurfaceStreamPayload({
                ...input,
                protectedPayload: bad,
              }),
            ),
        );
      }
    }
  }
  const remoteParts = {
    formatVersion: 1,
    keyRevision: 0x01020304,
    nonce: new Uint8Array(12).fill(9),
    ciphertext: new Uint8Array(20).fill(7),
  };
  const packed = remote.encodeRemoteSurfaceProtectedPayload(remoteParts);
  same(
    await native({
      op: "remote-encode",
      keyRevision: remoteParts.keyRevision,
      nonce: bytes(remoteParts.nonce),
      bytes: bytes(remoteParts.ciphertext),
    }),
    bytes(packed),
    "remote header is byte-identical",
  );
  for (const payload of [
    packed,
    packed.subarray(0, 36),
    Uint8Array.from(packed, (x, i) => (i === 0 ? 2 : x)),
    Uint8Array.from(packed, (x, i) => (i >= 1 && i <= 8 ? 255 : x)),
  ]) {
    await compare({ op: "remote-decode", bytes: bytes(payload) }, () => {
      const value = remote.decodeRemoteSurfaceProtectedPayload(payload);
      return {
        ...value,
        nonce: bytes(value.nonce),
        ciphertext: bytes(value.ciphertext),
      };
    });
  }
  const remoteTooLarge = new Uint8Array(
    remote.REMOTE_SURFACE_PROTECTED_PLAINTEXT_BYTES_LIMIT + 1,
  );
  await compare(
    {
      op: "remote-encrypt",
      key: encoded,
      context: outer(remoteContext),
      bytes: bytes(remoteTooLarge),
    },
    () =>
      c.encryptRemoteSurfaceStreamPayload({
        ...cryptoInput(remoteContext),
        plaintext: remoteTooLarge,
      }),
  );
  const configuration = {
    formatVersion: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 3,
    key: encoded,
  };
  const header = {
    protocolVersion: 1,
    tunnelId: "tunnel",
    attachmentId: "attachment",
    sourceEndpointId: "client",
    destinationEndpointId: "worker",
    connectionId: "connection",
    sequence: 4,
    kind: "data",
    direction: "source-to-destination",
  };
  for (const plaintext of [
    new Uint8Array([0, 255, 128]),
    encoder.encode("GET /private HTTP/1.1\r\n\r\n"),
    new Uint8Array(),
  ]) {
    const sealed = tunnel.sealTunnelDataFrame(configuration, header, plaintext);
    await compare(
      {
        op: "tunnel-open",
        configuration,
        header: sealed.header,
        bytes: bytes(sealed.payload),
      },
      () =>
        bytes(
          tunnel.openTunnelDataFrame(
            configuration,
            sealed.header,
            sealed.payload,
          ),
        ),
    );
    const nativePayload = await native({
      op: "tunnel-seal",
      configuration,
      header,
      bytes: bytes(plaintext),
    });
    const nativeBytes = decode(nativePayload.payload);
    if (plaintext.length)
      same(
        bytes(
          tunnel.openTunnelDataFrame(
            configuration,
            nativePayload.header,
            nativeBytes,
          ),
        ),
        bytes(plaintext),
        "native tunnel data opens in Node",
      );
    else
      await compare(
        {
          op: "tunnel-open",
          configuration,
          header: nativePayload.header,
          bytes: nativePayload.payload,
        },
        () =>
          bytes(
            tunnel.openTunnelDataFrame(
              configuration,
              nativePayload.header,
              nativeBytes,
            ),
          ),
      );
    if (plaintext.length === 3) {
      for (const change of [
        { sequence: 5 },
        { connectionId: "other" },
        { attachmentId: "other" },
        { sourceEndpointId: "other" },
        { destinationEndpointId: "other" },
        { direction: "destination-to-source" },
      ]) {
        const wrong = { ...sealed.header, ...change };
        await compare(
          {
            op: "tunnel-open",
            configuration,
            header: wrong,
            bytes: bytes(sealed.payload),
          },
          () =>
            bytes(
              tunnel.openTunnelDataFrame(configuration, wrong, sealed.payload),
            ),
        );
      }
    }
  }
  const workerId = "worker-stream",
    ownerId = "owner-stream",
    serverUrl = "https://stream.test";
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
    "same real endpoint identity",
  );
  const endpointContext = {
    domain: "client-control-content",
    serverId: "server-stream",
    workerId,
    scopeId: "scope",
    operationId: "11111111-1111-4111-8111-111111111111",
    operation: "operation",
    direction: "request",
    sequence: 0,
  };
  const schema = "terminalInputContentSchema",
    content = { type: "terminal.input", data: "synthetic\ud800\u0000" },
    parsed = p[schema].parse(content);
  const endpointOptions = {
    service,
    context: endpointContext,
    schema: p[schema],
    content,
  };
  const surfaceOptions = {
    service,
    context: surfaceContext,
    schema: p[schema],
    content,
  };
  await compare(
    {
      op: "worker-endpoint-protect",
      context: endpointContext,
      schema,
      content,
    },
    () => endpointWorker.protectWorkerEndpointContent(endpointOptions),
  );
  await compare(
    { op: "worker-surface-protect", context: surfaceContext, schema, content },
    () => surfaceWorker.protectWorkerSurfaceStreamContent(surfaceOptions),
  );
  await compare(
    { op: "worker-remote-open", context: remoteContext, bytes: bytes(packed) },
    () =>
      remoteWorker.openWorkerRemoteSurfaceStreamPayload({
        service,
        context: remoteContext,
        protectedPayload: packed,
      }),
  );
  const registration = service.registration(),
    at = "2026-11-16T00:00:00.000Z";
  async function grant(component, keyRevision, keyValue) {
    return {
      id: crypto.randomUUID(),
      ownerId,
      principalId: registration.principalId,
      component,
      keyRevision,
      wrappedKey: await c.wrapComponentKeyForWorker({
        ownerId,
        workerId,
        component,
        keyRevision,
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
  function bootstrap(grants) {
    return {
      serverId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ownerId,
      principal: {
        id: registration.principalId,
        ownerId,
        kind: "worker",
        workerId,
        label: "Stream fixture",
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
  async function authorize(grants) {
    const payload = bootstrap(grants);
    await service.acceptBootstrap(payload);
    await native({ op: "accept", payload });
  }
  const endpointGrant = await grant("client-control-content", 3, 7),
    surfaceGrant = await grant("surface-private-state", 3, 7);
  await authorize([endpointGrant, surfaceGrant]);
  const nodeEndpoint =
    await endpointWorker.protectWorkerEndpointContent(endpointOptions);
  await compare(
    {
      op: "worker-endpoint-open",
      context: endpointContext,
      schema,
      encrypted: nodeEndpoint,
    },
    () =>
      endpointWorker.openWorkerEndpointContent({
        ...endpointOptions,
        opaque: nodeEndpoint,
      }),
  );
  const nativeEndpoint = await native({
    op: "worker-endpoint-protect",
    context: endpointContext,
    schema,
    content,
  });
  same(
    await endpointWorker.openWorkerEndpointContent({
      ...endpointOptions,
      opaque: nativeEndpoint,
    }),
    parsed,
    "native worker endpoint opens in Node",
  );
  for (const plaintext of [new Uint8Array(), new Uint8Array([0, 255, 128])]) {
    const encrypted = await endpointWorker.protectWorkerEndpointBytes({
      service,
      context: endpointContext,
      plaintext,
    });
    await compare(
      { op: "worker-endpoint-open-bytes", context: endpointContext, encrypted },
      async () =>
        bytes(
          await endpointWorker.openWorkerEndpointBytes({
            service,
            context: endpointContext,
            opaque: encrypted,
          }),
        ),
    );
    const nativePayload = await native({
      op: "worker-endpoint-protect-bytes",
      context: endpointContext,
      bytes: bytes(plaintext),
    });
    same(
      bytes(
        await endpointWorker.openWorkerEndpointBytes({
          service,
          context: endpointContext,
          opaque: nativePayload,
        }),
      ),
      bytes(plaintext),
      "native worker endpoint bytes open in Node",
    );
  }
  const nodeSurface =
    await surfaceWorker.protectWorkerSurfaceStreamContent(surfaceOptions);
  await compare(
    {
      op: "worker-surface-open",
      context: surfaceContext,
      schema,
      encrypted: nodeSurface,
    },
    () =>
      surfaceWorker.openWorkerSurfaceStreamContent({
        ...surfaceOptions,
        opaque: nodeSurface,
      }),
  );
  const nativeSurface = await native({
    op: "worker-surface-protect",
    context: surfaceContext,
    schema,
    content,
  });
  same(
    await surfaceWorker.openWorkerSurfaceStreamContent({
      ...surfaceOptions,
      opaque: nativeSurface,
    }),
    parsed,
    "native worker surface opens in Node",
  );
  for (const plaintext of [new Uint8Array(), new Uint8Array([0, 255, 128])]) {
    const nodePayload = remoteWorker.protectWorkerRemoteSurfaceStreamPayload({
      service,
      context: remoteContext,
      payload: plaintext,
    });
    await compare(
      {
        op: "worker-remote-open",
        context: remoteContext,
        bytes: bytes(nodePayload),
      },
      () =>
        bytes(
          remoteWorker.openWorkerRemoteSurfaceStreamPayload({
            service,
            context: remoteContext,
            protectedPayload: nodePayload,
          }),
        ),
    );
    const nativePayload = decode(
      await native({
        op: "worker-remote-protect",
        context: remoteContext,
        bytes: bytes(plaintext),
      }),
    );
    same(
      bytes(
        remoteWorker.openWorkerRemoteSurfaceStreamPayload({
          service,
          context: remoteContext,
          protectedPayload: nativePayload,
        }),
      ),
      bytes(plaintext),
      "native worker remote stream opens in Node",
    );
  }
  for (const plaintext of [
    new Uint8Array([0xc3, 0x28]),
    encoder.encode("{"),
    encoder.encode('{"type":"terminal.input","data":4}'),
    new Uint8Array([239, 187, 191, ...encoder.encode(JSON.stringify(content))]),
  ]) {
    const endpoint = await c.encryptEndpointContentPayload({
      ownerId,
      keyRevision: 3,
      context: endpointContext,
      componentKey: key,
      plaintext,
    });
    await compare(
      {
        op: "worker-endpoint-open",
        context: endpointContext,
        schema,
        encrypted: endpoint,
      },
      () =>
        endpointWorker.openWorkerEndpointContent({
          ...endpointOptions,
          opaque: endpoint,
        }),
      "worker endpoint plaintext validation",
    );
    const surface = await c.encryptSurfaceStreamPayload({
      ...cryptoInput(surfaceContext),
      plaintext,
    });
    await compare(
      {
        op: "worker-surface-open",
        context: surfaceContext,
        schema,
        encrypted: surface,
      },
      () =>
        surfaceWorker.openWorkerSurfaceStreamContent({
          ...surfaceOptions,
          opaque: surface,
        }),
      "worker surface plaintext validation",
    );
  }
  await authorize([
    endpointGrant,
    await grant("client-control-content", 4, 8),
    surfaceGrant,
    await grant("surface-private-state", 4, 8),
  ]);
  await compare(
    {
      op: "worker-endpoint-open",
      context: endpointContext,
      schema,
      encrypted: nodeEndpoint,
    },
    () =>
      endpointWorker.openWorkerEndpointContent({
        ...endpointOptions,
        opaque: nodeEndpoint,
      }),
    "endpoint historical revision remains accessible",
  );
  await compare(
    {
      op: "worker-surface-open",
      context: surfaceContext,
      schema,
      encrypted: nodeSurface,
    },
    () =>
      surfaceWorker.openWorkerSurfaceStreamContent({
        ...surfaceOptions,
        opaque: nodeSurface,
      }),
    "surface stale revision is rejected",
  );
  const oldRemote = await c.encryptRemoteSurfaceStreamPayload({
    ...cryptoInput(remoteContext),
    plaintext: encoder.encode("old"),
  });
  await compare(
    {
      op: "worker-remote-open",
      context: remoteContext,
      bytes: bytes(oldRemote),
    },
    () =>
      bytes(
        remoteWorker.openWorkerRemoteSurfaceStreamPayload({
          service,
          context: remoteContext,
          protectedPayload: oldRemote,
        }),
      ),
    "remote stale revision is rejected",
  );
  service.lock();
  await native({ op: "lock" });
  await compare(
    {
      op: "worker-endpoint-open",
      context: endpointContext,
      schema,
      encrypted: nodeEndpoint,
    },
    () =>
      endpointWorker.openWorkerEndpointContent({
        ...endpointOptions,
        opaque: nodeEndpoint,
      }),
  );
  await compare(
    {
      op: "worker-surface-open",
      context: surfaceContext,
      schema,
      encrypted: nodeSurface,
    },
    () =>
      surfaceWorker.openWorkerSurfaceStreamContent({
        ...surfaceOptions,
        opaque: nodeSurface,
      }),
  );
  const replay = new surfaceWorker.SurfaceStreamReplayGuard();
  await native({ op: "replay-reset" });
  const next = { ...surfaceContext, sequence: 1 };
  for (const [action, context, complete] of [
    ["accept", surfaceContext, false],
    ["reserve", surfaceContext],
    ["reserve", surfaceContext],
    ["reserve", next],
    ["accept", surfaceContext, true],
    ["accept", next, false],
    ["accept", next, true],
    ["reserve", { ...next, sequence: 2 }],
    ["release", next],
    ["reserve", surfaceContext],
    ["reserve", { ...surfaceContext, direction: "output" }],
    ["release", surfaceContext],
    ["reserve", surfaceContext],
  ]) {
    await compare(
      { op: "replay-" + action, context, complete },
      () => {
        if (action === "accept") replay.accept(context, complete);
        else replay[action](context);
        return null;
      },
      "actual replay guard transition",
    );
  }
  console.log(
    JSON.stringify({
      suite: "native-stream-compatibility",
      passed: true,
      comparisons,
      bidirectionalSurfaceAndRemoteAndTunnel: true,
      workerEndpointAndSurfaceAdapters: true,
      historicalVsLatestRevisionPolicy: true,
      actualReplayGuardTrace: true,
      scope:
        "Crypto/codecs and real worker content/replay helpers; serving resource adapters and execution capabilities remain pending.",
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
