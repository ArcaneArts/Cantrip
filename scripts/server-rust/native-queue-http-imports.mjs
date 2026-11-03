import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { settingsWorker as worker } from "./native-settings-http-fixture.mjs";

const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function nativeQueueHttpImports({
  h,
  client,
  content,
  call,
  read,
}) {
  const session = read.session,
    nativeItemId = "native-queue-http-item";
  const first = await content.prompt({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
    key: "queue-import-first",
    text: "Private imported queue text 🌳",
  });
  const input = {
    ...read,
    runnerGeneration: "runner-one",
    items: [
      {
        nativeItemId,
        sourceDigest: "b".repeat(64),
        protectedSource: first.protectedNativeInput,
        prompt: first,
        attachments: [],
      },
    ],
  };
  const register = (result, sourceDigest, label, prompt) => {
    assert.equal(result.imports.length, 1);
    const record = result.imports[0];
    const normalized = {
      ...session,
      runtimeGeneration: null,
      connectionId: null,
    };
    const expected = hash([
      hash([h.owner, worker, normalized, nativeItemId]),
      sourceDigest,
    ]);
    assert.equal(
      record.importId,
      expected,
      "import ID hashes the actual owner and canonical session",
    );
    assert.equal(record.nativeDeleteOperationId, "queue-delete:" + expected);
    assert.equal(record.nativeItemId, nativeItemId);
    assert.equal(record.promptId, prompt.id);
    assert.deepEqual(record.protectedSource, prompt.protectedNativeInput);
    content.identity(expected, label);
    return record;
  };
  const imported = await call(
    "import encrypted native queue item",
    "import",
    input,
  );
  const original = register(
    imported,
    "b".repeat(64),
    "<queue import:0>",
    first,
  );
  assert.equal(original.status, "pending");
  assert.equal(imported.pendingImports.length, 1);
  assert.deepEqual(
    await call("import replay preserves exact snapshot", "import", input),
    imported,
  );
  const acknowledgment = {
    ...read,
    runnerGeneration: input.runnerGeneration,
    importId: original.importId,
    sourceDigest: original.sourceDigest,
    receipt: { deleted: false, conflict: false },
  };
  assert.deepEqual(
    await call(
      "import ack rejects stale runner",
      "import-ack",
      { ...acknowledgment, runnerGeneration: "stale" },
      { status: 409 },
    ),
    { code: "stale-queue-import" },
  );
  const uncertain = await call(
    "unconfirmed native deletion stays uncertain",
    "import-ack",
    acknowledgment,
  );
  assert.equal(uncertain.pendingImports[0].status, "uncertain");
  const renewedInput = { ...input, runnerGeneration: "runner-two" };
  const renewed = await content.sdk("worker SDK renews native import", () =>
    client.import(renewedInput),
  );
  assert.equal(renewed.imports[0].importId, original.importId);
  assert.equal(renewed.imports[0].status, "uncertain");
  assert.deepEqual(
    await call("renewal fences old runner ack", "import-ack", acknowledgment, {
      status: 409,
    }),
    { code: "stale-queue-import" },
  );
  const conflicted = await call(
    "native source conflict remains visible",
    "import-ack",
    {
      ...acknowledgment,
      runnerGeneration: "runner-two",
      receipt: { deleted: false, conflict: true },
    },
  );
  assert.equal(conflicted.pendingImports[0].status, "conflict");
  const replacement = await content.prompt({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
    messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6",
    key: "queue-import-replacement",
    text: "Private replacement queue text 🌙",
  });
  const replacedInput = {
    ...renewedInput,
    items: [
      {
        ...input.items[0],
        sourceDigest: "c".repeat(64),
        protectedSource: replacement.protectedNativeInput,
        prompt: replacement,
      },
    ],
  };
  const replaced = await call(
    "changed native source replaces conflicted import",
    "import",
    replacedInput,
  );
  const current = register(
    replaced,
    "c".repeat(64),
    "<queue import:1>",
    replacement,
  );
  assert.notEqual(current.importId, original.importId);
  assert.equal(replaced.pendingImports.length, 1);
  assert.equal(replaced.pendingImports[0].prompt.id, replacement.id);
  const success = {
    ...read,
    runnerGeneration: "runner-two",
    importId: current.importId,
    sourceDigest: current.sourceDigest,
    receipt: { deleted: true, conflict: false },
  };
  const accepted = await content.sdk(
    "worker SDK acknowledges native deletion",
    () => client.acknowledgeImport(success),
  );
  assert.deepEqual(accepted.pendingImports, []);
  assert.equal(accepted.items.length, 1);
  assert.equal(accepted.items[0].id, replacement.id);
  assert.equal(accepted.items[0].state, "pending");
  assert.equal(accepted.items[0].frozen, true);
  assert.deepEqual(
    await call("imported receipt cannot be downgraded", "import-ack", {
      ...success,
      receipt: { deleted: false, conflict: true },
    }),
    accepted,
  );
  const retained = await content.sdk(
    "worker SDK reads imported ciphertext",
    () => client.read({ session }),
  );
  assert.deepEqual(retained, accepted);
}
