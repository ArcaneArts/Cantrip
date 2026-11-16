// Development oracle. All profiles, keys and plaintexts are synthetic/owned.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import * as crypto from "../../packages/crypto/src/index.ts";
import { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.ts";

const { values } = parseArgs({ options: { binary: { type: "string" } } });
assert.ok(values.binary, "--binary requires the built crypto-fixture example");
const binary = path.resolve(values.binary);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-native-crypto-"));
let comparisons = 0;
const encode = crypto.encodeBase64Url,
  decode = crypto.decodeBase64Url;
const key = new Uint8Array(32).fill(7);
const aad = {
  ownerId: "owner-crypto",
  component: "chat-content",
  table: "messages",
  rowId: "row-1",
  field: "content",
  formatVersion: 1,
  keyRevision: 3,
};
function rust(input) {
  const child = spawnSync(binary, [], {
    encoding: "utf8",
    input: JSON.stringify(input) + "\n",
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
function value(input) {
  const result = rust(input);
  assert.equal(result.ok, true, result.error);
  return result.value;
}
function equal(input, expected, label) {
  assert.deepEqual(value(input), expected, label);
  comparisons++;
}
async function rejected(input, run, exact = false) {
  const native = rust(input);
  assert.equal(native.ok, false);
  let failure;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "Node reference should also reject");
  if (exact) assert.equal(native.error, failure.message);
  comparisons++;
}
async function identity(input) {
  const { directory, serverUrl, workerId, allowPortChange } = input;
  const node = await WorkerEncryptionService.open({
    dataDirectory: directory,
    serverUrl,
    workerId,
    allowLoopbackServerPortChange: allowPortChange,
  });
  equal(
    { op: "identity", ...input },
    node.registration(),
    "existing Node key record opens in Rust",
  );
  return node;
}
try {
  for (const ownerId of [aad.ownerId, "o\ud800\u0000🦀"]) {
    const context = { ...aad, ownerId };
    equal(
      { op: "aad", aad: context },
      crypto.canonicalAssociatedData(context),
      "canonical UTF-16 associated data",
    );
    const component = crypto.deriveComponentKey({
      accountMasterKey: key,
      ...context,
    });
    const field = crypto.deriveFieldKey({
      componentKey: component,
      ...context,
    });
    const lookup = crypto.deriveLookupKey({
      componentKey: component,
      ...context,
    });
    equal(
      { op: "derive", key: encode(key), context, canonical: "lookup\ud800" },
      {
        component: encode(component),
        field: encode(field),
        lookup: encode(lookup),
        tag: crypto.computeBlindLookupTag(lookup, "lookup\ud800"),
      },
      "HKDF/HMAC byte compatibility",
    );
  }
  for (const plaintext of [
    new Uint8Array(),
    new TextEncoder().encode("Cantrip\0🦀\n"),
    Uint8Array.from([0, 128, 255, 1]),
  ]) {
    const envelope = await crypto.encryptPayload({
      key,
      plaintext,
      associatedData: aad,
    });
    equal(
      { op: "decrypt", key: encode(key), envelope, aad },
      encode(plaintext),
      "Node AES payload opens in Rust",
    );
    const native = value({
      op: "encrypt",
      key: encode(key),
      plaintext: encode(plaintext),
      aad,
    });
    assert.equal(
      encode(
        await crypto.decryptPayload({
          key,
          envelope: native,
          associatedData: aad,
        }),
      ),
      encode(plaintext),
    );
    comparisons++;
    equal(
      { op: "serialize", envelope: native },
      crypto.serializePayloadEnvelope(native),
      "canonical envelope string",
    );
    for (const change of [
      { key: new Uint8Array(32).fill(8) },
      { associatedData: { ...aad, rowId: "wrong" } },
      { associatedData: { ...aad, keyRevision: 4 } },
      { envelope: { ...envelope, nonce: "AA" } },
    ]) {
      const input = { key, envelope, associatedData: aad, ...change };
      await rejected(
        {
          op: "decrypt",
          key: encode(input.key),
          envelope: input.envelope,
          aad: input.associatedData,
        },
        () => crypto.decryptPayload(input),
        true,
      );
    }
  }
  const nodePair = await crypto.generateHpkeKeyPair(true);
  const nativePair = value({ op: "generate" });
  const nodeSerialized = {
    publicKey: await crypto.exportHpkePublicKey(nodePair.publicKey),
    privateKey: encode(await crypto.exportHpkePrivateKey(nodePair.privateKey)),
  };
  for (const serialized of [nodeSerialized, nativePair]) {
    const pair = await crypto.importHpkeKeyPair({
      publicKey: serialized.publicKey,
      privateKey: decode(serialized.privateKey),
    });
    const envelope = await crypto.wrapKeyForRecipient({
      key,
      recipientPublicKey: serialized.publicKey,
      associatedData: aad,
    });
    equal(
      { op: "unwrap", ...serialized, envelope, aad },
      encode(key),
      "Node HPKE opens in Rust",
    );
    const native = value({
      op: "wrap",
      key: encode(key),
      publicKey: serialized.publicKey,
      aad,
    });
    assert.equal(
      encode(
        await crypto.unwrapKeyForRecipient({
          envelope: native,
          recipientKeyPair: pair,
          associatedData: aad,
        }),
      ),
      encode(key),
    );
    comparisons++;
    await rejected(
      {
        op: "unwrap",
        ...serialized,
        envelope,
        aad: { ...aad, field: "wrong" },
      },
      () =>
        crypto.unwrapKeyForRecipient({
          envelope,
          recipientKeyPair: pair,
          associatedData: { ...aad, field: "wrong" },
        }),
      true,
    );
    const grant = {
      workerId: "worker-crypto",
      component: "chat-content",
      keyRevision: 3,
    };
    const wrapped = await crypto.wrapComponentKeyForWorker({
      ownerId: aad.ownerId,
      ...grant,
      componentKey: key,
      workerPublicKey: serialized.publicKey,
    });
    equal(
      {
        op: "unwrap-component",
        ...serialized,
        ownerId: aad.ownerId,
        grant: wrapped,
      },
      encode(key),
      "Node worker grant opens in Rust",
    );
    const nativeGrant = value({
      op: "wrap-component",
      key: encode(key),
      publicKey: serialized.publicKey,
      ownerId: aad.ownerId,
      grant,
    });
    assert.equal(
      encode(
        await crypto.unwrapComponentKeyForWorker({
          ownerId: aad.ownerId,
          grant: nativeGrant,
          workerKeyPair: pair,
        }),
      ),
      encode(key),
    );
    comparisons++;
  }
  const base = {
    directory: path.join(root, "node-profile"),
    serverUrl: "https://cantrip.test",
    workerId: "worker-crypto",
  };
  await identity(base);
  const filename = path.join(base.directory, "worker-encryption-key.json");
  const original = await readFile(filename, "utf8");
  const record = JSON.parse(original);
  for (const change of [
    { version: 3 },
    { ownerId: undefined },
    { principalId: "aaaaaaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa" },
    { serverId: undefined },
    { workerId: "other" },
    { serverUrl: "https://other.test" },
    { privateKey: nativePair.privateKey },
    { acceptedRevisions: { "chat-content": 0 } },
    { acceptedRevisions: { unknown: 1 } },
    { acceptedRevisions: { "chat-content": 9007199254740992 } },
  ]) {
    await writeFile(filename, JSON.stringify({ ...record, ...change }) + "\n");
    const input = { op: "identity", ...base };
    const native = rust(input);
    assert.equal(native.ok, false);
    let failure;
    try {
      await WorkerEncryptionService.open({
        dataDirectory: base.directory,
        serverUrl: base.serverUrl,
        workerId: base.workerId,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "Node rejects corrupt/foreign key record");
    if (failure.code) assert.equal(native.code, failure.code);
    const after = await readFile(filename, "utf8");
    assert.equal(
      after,
      JSON.stringify({ ...record, ...change }) + "\n",
      "invalid record never rewritten",
    );
    comparisons++;
  }
  for (const revisions of [{ "chat-content": 9007199254740991 }, []]) {
    await writeFile(
      filename,
      JSON.stringify({ ...record, acceptedRevisions: revisions }) + "\n",
    );
    await identity(base);
  }
  await writeFile(filename, original);
  equal(
    { op: "identity", ...base },
    (
      await WorkerEncryptionService.open({
        dataDirectory: base.directory,
        serverUrl: base.serverUrl,
        workerId: base.workerId,
      })
    ).registration(),
    "original identity retained",
  );
  assert.equal(await readFile(filename, "utf8"), original);
  if (process.platform !== "win32")
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  const fresh = {
    directory: path.join(root, "rust-profile"),
    serverUrl: "http://127.0.0.1:4100",
    workerId: "worker-crypto",
    allowPortChange: true,
  };
  const registration = value({ op: "identity", ...fresh });
  const freshFile = path.join(fresh.directory, "worker-encryption-key.json");
  const freshBytes = await readFile(freshFile, "utf8");
  const reopened = await identity({
    ...fresh,
    serverUrl: "http://127.0.0.1:4200",
  });
  assert.deepEqual(reopened.registration(), registration);
  assert.equal(await readFile(freshFile, "utf8"), freshBytes);
  comparisons++;
  await identity({
    ...fresh,
    serverUrl: "http://127.0.0.1:4300",
    allowPortChange: false,
  });
  const v1 = {
    ...JSON.parse(freshBytes),
    version: 1,
    serverId: "http://127.0.0.1",
  };
  delete v1.serverUrl;
  await writeFile(freshFile, JSON.stringify(v1) + "\n");
  await identity({
    ...fresh,
    serverUrl: "http://127.0.0.1:4300",
    allowPortChange: false,
  });
  // The real Node bootstrap path publishes the same v2 record as the native
  // identity writer, including migration from v1 and exact field formatting.
  for (const legacy of [false, true]) {
    const nodeDirectory = path.join(root, `binding-node-${legacy}`);
    const rustDirectory = path.join(root, `binding-rust-${legacy}`);
    await mkdir(nodeDirectory);
    await mkdir(rustDirectory);
    const initial = { ...record };
    if (legacy) {
      initial.version = 1;
      initial.serverId = base.serverUrl;
      delete initial.serverUrl;
    }
    const initialBytes = JSON.stringify(initial) + "\n";
    await writeFile(
      path.join(nodeDirectory, "worker-encryption-key.json"),
      initialBytes,
    );
    await writeFile(
      path.join(rustDirectory, "worker-encryption-key.json"),
      initialBytes,
    );
    const service = await WorkerEncryptionService.open({
      dataDirectory: nodeDirectory,
      serverUrl: base.serverUrl,
      workerId: base.workerId,
    });
    const registration = service.registration(),
      timestamp = "2026-11-16T00:00:00.000Z";
    const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await service.acceptBootstrap({
      serverId,
      ownerId: aad.ownerId,
      principal: {
        id: registration.principalId,
        ownerId: aad.ownerId,
        kind: "worker",
        workerId: base.workerId,
        label: "Crypto fixture",
        publicKey: registration.publicKey,
        state: "pending",
        revision: 1,
        approvedAt: null,
        revokedAt: null,
        revokedReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      grants: [],
    });
    equal(
      {
        op: "identity-persist",
        directory: rustDirectory,
        serverUrl: base.serverUrl,
        workerId: base.workerId,
        ownerId: aad.ownerId,
        serverId,
        revisions: {},
      },
      registration,
      "persisted binding identity",
    );
    assert.equal(
      await readFile(
        path.join(rustDirectory, "worker-encryption-key.json"),
        "utf8",
      ),
      await readFile(
        path.join(nodeDirectory, "worker-encryption-key.json"),
        "utf8",
      ),
      "Node/native binding bytes match",
    );
    comparisons++;
  }
  console.log(
    JSON.stringify({
      suite: "native-endpoint-crypto-compatibility",
      passed: true,
      comparisons,
      bidirectionalAesAndHpke: true,
      canonicalAadAndKdf: true,
      nodeAndRustKeyRecords: true,
      corruptionAndBindingChecks: true,
      scope:
        "Crypto primitives and endpoint key identity; grant refresh and protected domain/stream adapters remain pending.",
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
