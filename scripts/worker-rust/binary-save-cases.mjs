// Focused shared product checks. Both callers send authenticated file requests
// to the actual Rust server and worker.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const prefix = "explorer.binary.write.";
const page = 256 * 1024;
export const binaryDigest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function binaryRequest(path, uploadId, action, fields = {}) {
  return { type: prefix + action, path, uploadId, ...fields };
}

export function binaryReceipt(outcome) {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.result.type, "explorer.binary.write");
  return outcome.result.value;
}

export function finalChunk(bytes, offset = 0) {
  return { offset, data: bytes.toString("base64"), final: true };
}

export function saveChecksum(bytes) {
  return { size: bytes.length, sha256: binaryDigest(bytes) };
}

export async function verifyBinarySave({
  path,
  send,
  digestTarget,
  replaceTarget,
  restartWorker,
}) {
  const baseline = await send({
    type: "explorer.binary.read",
    path,
    offset: 0,
    limit: 32,
  });
  assert.equal(baseline.ok, true, JSON.stringify(baseline));
  const before = await digestTarget();
  const upload = (id, action, fields) =>
    send(binaryRequest(path, id, action, fields));
  const id = randomUUID();
  assert.equal(binaryReceipt(await upload(id, "status")).state, "unknown");
  const bytes = Buffer.concat([
    Buffer.alloc(page, 0xea),
    Buffer.from([0, 255, 177]),
  ]);
  const first = {
    offset: 0,
    data: bytes.subarray(0, page).toString("base64"),
    final: false,
  };
  assert.equal(
    binaryReceipt(
      await upload(id, "begin", { version: baseline.result.value.version }),
    ).state,
    "uploading",
  );
  const accepted = binaryReceipt(await upload(id, "chunk", first));
  assert.equal(accepted.offset, page);
  assert.deepEqual(binaryReceipt(await upload(id, "chunk", first)), accepted);
  const changed = await upload(id, "chunk", finalChunk(Buffer.from([0x10])));
  assert.equal(changed.ok, false);
  assert.match(changed.error, /different content/u);
  await restartWorker();
  assert.deepEqual(binaryReceipt(await upload(id, "status")), accepted);
  assert.equal(
    binaryReceipt(
      await upload(id, "chunk", finalChunk(bytes.subarray(page), page)),
    ).offset,
    bytes.length,
  );
  const wrong = await upload(id, "commit", {
    size: bytes.length,
    sha256: "0".repeat(64),
  });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /checksum/u);
  assert.equal(await digestTarget(), before);
  const committed = binaryReceipt(
    await upload(id, "commit", saveChecksum(bytes)),
  );
  assert.equal(committed.state, "committed");
  assert.equal(committed.sha256, binaryDigest(bytes));
  assert.equal(await digestTarget(), committed.sha256);
  assert.deepEqual(
    binaryReceipt(await upload(id, "commit", saveChecksum(bytes))),
    committed,
  );

  const abandoned = randomUUID();
  const cancelled = binaryReceipt(await upload(abandoned, "abort"));
  assert.equal(cancelled.state, "aborted");
  assert.deepEqual(
    binaryReceipt(
      await upload(abandoned, "begin", { version: committed.version }),
    ),
    cancelled,
  );

  const stale = randomUUID();
  const draft = Buffer.from([0x20, 0x21]);
  const external = Buffer.from("external edit after staging\n");
  assert.equal(
    binaryReceipt(await upload(stale, "begin", { version: committed.version }))
      .state,
    "uploading",
  );
  binaryReceipt(await upload(stale, "chunk", finalChunk(draft)));
  await replaceTarget(external);
  assert.equal(
    binaryReceipt(await upload(stale, "commit", saveChecksum(draft))).state,
    "conflict",
  );
  assert.equal(await digestTarget(), binaryDigest(external));
}
