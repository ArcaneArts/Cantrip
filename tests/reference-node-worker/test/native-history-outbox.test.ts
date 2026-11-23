import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeHistoryBatchPayloadDigest } from "../src/native-history-batch-archive.js";
import * as historyFiles from "../src/native-history-outbox-files.js";
import {
  NativeHistoryOutbox,
  type NativeHistoryOutboxRecord,
} from "../src/native-history-outbox.js";
import {
  openNativeHistoryBatch,
  protectNativeHistoryBatch,
} from "../src/native-history-content.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function service(owner = "owner", server = "server", current = 1) {
  return {
    ownerId: () => owner,
    serverIdentity: () => server,
    componentKey: (_scope: string, revision = current) => ({
      key: new Uint8Array(32).fill(revision),
      keyRevision: revision,
    }),
  };
}

async function fixture() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-history-outbox-"),
  );
  roots.push(directory);
  const input = {
    directory,
    workerId: "worker",
    chatId: "chat",
    bindingId: "binding",
    service: service(),
  };
  return { input, outbox: await NativeHistoryOutbox.open(input) };
}

function receipt(record: NativeHistoryOutboxRecord) {
  return {
    committed: true as const,
    streamId: record.streamId,
    sequence: record.sequence,
    recordId: record.recordId,
    digest: record.digest,
    commitId: `00000000-0000-4000-8000-${String(record.sequence).padStart(12, "0")}`,
  };
}

const batchPath = (
  outbox: NativeHistoryOutbox,
  sequence: number,
  kind = "mutation",
) =>
  path.join(
    outbox.directory,
    `${String(sequence).padStart(16, "0")}.${kind}.json`,
  );

describe("native history durable outbox", () => {
  const preparedBody = JSON.stringify({ items: [], turns: [] });
  const correctedBody = JSON.stringify({
    items: [],
    turns: [],
    snapshot: { readBarrierSequence: 1, complete: true },
  });
  const rejection = (
    outbox: NativeHistoryOutbox,
    record: NativeHistoryOutboxRecord,
    body = preparedBody,
  ) => ({
    rejected: true as const,
    rejectionId: randomUUID(),
    code: "item-revision-conflict" as const,
    workerId: outbox.scope.workerId,
    chatId: outbox.scope.chatId,
    bindingId: outbox.scope.bindingId,
    streamId: record.streamId,
    sequence: record.sequence,
    recordId: record.recordId,
    digest: record.digest,
    previousDigest: record.previousDigest,
    payloadDigest: nativeHistoryBatchPayloadDigest(
      JSON.parse(body),
      record.previousDigest,
    ),
  });

  it("retains rejected bytes, re-chains the complete pending tail and replays replacement identities after reopen", async () => {
    const { input, outbox } = await fixture();
    const first = await outbox.append(randomUUID(), preparedBody);
    const second = await outbox.append(
      randomUUID(),
      "unchanged dependent body",
    );
    const original = await Promise.all(
      [1, 2].map((index) => readFile(batchPath(outbox, index), "utf8")),
    );
    const proof = rejection(outbox, first);
    const id = randomUUID();
    for (const change of [
      { digest: "0".repeat(64) },
      { payloadDigest: "0".repeat(64) },
      { recordId: randomUUID() },
    ])
      await expect(
        outbox.replaceRejected({ ...proof, ...change }, id, correctedBody),
      ).rejects.toThrow();
    expect(await outbox.pending()).toEqual([first, second]);
    const replacement = await outbox.replaceRejected(proof, id, correctedBody);
    expect(replacement.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(replacement[0]!.previousDigest).toBeNull();
    expect(replacement[1]!.previousDigest).toBe(replacement[0]!.digest);
    expect(replacement[1]!.recordId).not.toBe(second.recordId);
    expect(await outbox.openBody(replacement[1]!)).toBe(
      "unchanged dependent body",
    );
    expect(
      await Promise.all(
        [1, 2].map((index) => readFile(batchPath(outbox, index), "utf8")),
      ),
    ).toEqual(original);
    expect(await readFile(batchPath(outbox, 3), "utf8")).not.toContain(
      proof.rejectionId,
    );
    const reopened = await NativeHistoryOutbox.open(input);
    expect(await reopened.pending()).toEqual(replacement);
    expect(await reopened.replaceRejected(proof, id, correctedBody)).toEqual(
      replacement,
    );
    expect(await reopened.replacement(second.recordId)).toEqual({
      record: replacement[1],
      rejection: proof,
    });
    await expect(
      reopened.replaceRejected(proof, id, preparedBody),
    ).rejects.toThrow("reused");
    await expect(reopened.append(first.recordId, preparedBody)).rejects.toThrow(
      "superseded",
    );
    await expect(
      reopened.append(second.recordId, "unchanged dependent body"),
    ).rejects.toThrow("superseded");
    await expect(reopened.acknowledgeCommitted(receipt(first))).rejects.toThrow(
      "does not match",
    );
    const third = await reopened.append(randomUUID(), "another pending body");
    expect(third.previousDigest).toBe(replacement[1]!.digest);
    const secondProof = rejection(reopened, replacement[0]!, correctedBody);
    const again = await reopened.replaceRejected(
      secondProof,
      randomUUID(),
      preparedBody,
    );
    expect(again).toHaveLength(3);
    expect(await reopened.openBody(again[2]!)).toBe("another pending body");
    for (const record of again)
      await reopened.acknowledgeCommitted(receipt(record));
    expect(await (await NativeHistoryOutbox.open(input)).pending()).toEqual([]);
    await expect(
      reopened.replaceRejected(
        rejection(reopened, again[0]!),
        randomUUID(),
        correctedBody,
      ),
    ).rejects.toThrow("no uncommitted");
  });

  it("preserves legacy batch files as a fixed prefix while using the shared mutation log for new records", async () => {
    const { input, outbox } = await fixture();
    const first = await outbox.append(randomUUID(), preparedBody);
    // Model an existing pre-mutation journal, with its original encrypted record.
    await rm(batchPath(outbox, 1));
    const legacyPath = batchPath(outbox, 1, "batch");
    const legacyBytes = JSON.stringify(first);
    await writeFile(legacyPath, legacyBytes);
    const reopened = await NativeHistoryOutbox.open(input);
    const second = await reopened.append(randomUUID(), "tail");
    expect(second.sequence).toBe(2);
    const corrected = await reopened.replaceRejected(
      rejection(reopened, first),
      randomUUID(),
      correctedBody,
    );
    expect(await readFile(legacyPath, "utf8")).toBe(legacyBytes);
    expect(await (await NativeHistoryOutbox.open(input)).pending()).toEqual(
      corrected,
    );
  });

  it("arbitrates a cross-process append against replacement through the same immutable mutation slot", async () => {
    const { input, outbox } = await fixture();
    const first = await outbox.append(randomUUID(), preparedBody);
    const proof = rejection(outbox, first);
    const id = randomUUID();
    const source = fileURLToPath(
      new URL("../src/native-history-outbox.ts", import.meta.url),
    );
    const script = `
      import { NativeHistoryOutbox } from ${JSON.stringify(source)};
      const box = await NativeHistoryOutbox.open({
        directory: ${JSON.stringify(input.directory)}, workerId: 'worker', chatId: 'chat', bindingId: 'binding',
        service: { ownerId: () => 'owner', serverIdentity: () => 'server', componentKey: (_scope, revision = 1) => ({ key: new Uint8Array(32).fill(revision), keyRevision: revision }) }
      });
      await box.append(${JSON.stringify(randomUUID())}, 'concurrent tail');
    `;
    const actualWrite = historyFiles.writeImmutableHistoryFile;
    vi.spyOn(historyFiles, "writeImmutableHistoryFile").mockImplementationOnce(
      async (...args) => {
        await promisify(execFile)(process.execPath, [
          "--import",
          import.meta.resolve("tsx"),
          "--input-type=module",
          "-e",
          script,
        ]);
        return actualWrite(...args);
      },
    );
    await expect(
      outbox.replaceRejected(proof, id, correctedBody),
    ).rejects.toThrow("advanced concurrently");
    vi.restoreAllMocks();
    expect((await outbox.pending())[0]).toEqual(first);
    const replacement = await outbox.replaceRejected(proof, id, correctedBody);
    expect(replacement).toHaveLength(2);
    expect(await outbox.openBody(replacement[1]!)).toBe("concurrent tail");
    expect(await (await NativeHistoryOutbox.open(input)).pending()).toEqual(
      replacement,
    );
  });

  it("recovers exact encrypted batches and monotonic sequence after reopen", async () => {
    const { input, outbox } = await fixture();
    const body = '{ "private": "piano 🎹", "escaped": "line\\n2" }\n';
    const record = await outbox.append(randomUUID(), body);
    const reopened = await NativeHistoryOutbox.open(input);
    expect(reopened.streamId).toBe(outbox.streamId);
    expect(await reopened.pending()).toEqual([record]);
    expect(await reopened.openBody(record)).toBe(body);
    for (const name of await readdir(outbox.directory)) {
      const saved = await readFile(path.join(outbox.directory, name), "utf8");
      expect(saved).not.toContain("piano");
      expect(saved).not.toContain("escaped");
    }
    await reopened.acknowledgeCommitted(receipt(record));
    const afterAck = await NativeHistoryOutbox.open(input);
    expect(await afterAck.pending()).toEqual([]);
    const next = await afterAck.append(randomUUID(), "next opaque wire body");
    expect(next.sequence).toBe(2);
    expect(next.previousDigest).toBe(record.digest);
    expect(await afterAck.pending()).toEqual([next]);
  });

  it("retains a sent batch when the response is lost and does not reencrypt retry", async () => {
    const { input, outbox } = await fixture();
    const id = randomUUID();
    const first = await outbox.append(id, "exact prepared body");
    // Server may have committed, but no matching receipt reached this worker.
    const retry = await NativeHistoryOutbox.open(input);
    expect(await retry.append(id, "exact prepared body")).toEqual(first);
    expect(await retry.pending()).toEqual([first]);
    await retry.acknowledgeCommitted(receipt(first));
    await retry.acknowledgeCommitted(receipt(first));
    expect(await retry.pending()).toEqual([]);
    await expect(retry.append(id, "new content")).rejects.toThrow("reused");
    expect(await retry.append(id, "exact prepared body")).toEqual(first);
  });

  it("serializes separate handles without losing accepted records", async () => {
    const { input, outbox } = await fixture();
    const second = await NativeHistoryOutbox.open(input);
    const records = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? second : outbox).append(randomUUID(), `opaque body ${i}`),
      ),
    );
    expect(records.map((record) => record.sequence)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    expect(await second.pending()).toEqual(records);
    const id = randomUUID();
    const duplicates = await Promise.all([
      outbox.append(id, "same"),
      second.append(id, "same"),
    ]);
    expect(duplicates[0]).toEqual(duplicates[1]);
    expect((await outbox.pending()).length).toBe(13);
  });

  it("does not consume any batch on a missing, mismatched or noncontiguous ACK", async () => {
    const { outbox } = await fixture();
    const first = await outbox.append(randomUUID(), "one");
    const second = await outbox.append(randomUUID(), "two");
    for (const patch of [
      { streamId: randomUUID() },
      { recordId: randomUUID() },
      { digest: "0".repeat(64) },
      { sequence: 99 },
      { committed: false },
    ]) {
      await expect(
        outbox.acknowledgeCommitted({ ...receipt(first), ...patch } as never),
      ).rejects.toThrow();
      expect(await outbox.pending()).toEqual([first, second]);
    }
    await expect(outbox.acknowledgeCommitted(receipt(second))).rejects.toThrow(
      "skip",
    );
    await outbox.acknowledgeCommitted(receipt(first));
    await expect(
      outbox.acknowledgeCommitted({
        ...receipt(first),
        commitId: "10000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toThrow("changed");
    expect(await outbox.pending()).toEqual([second]);
    await outbox.acknowledgeCommitted(receipt(second));
    expect(await outbox.pending()).toEqual([]);
  });

  it("recovers actual disk publication failure without advancing or poisoning later writes", async () => {
    const { input, outbox } = await fixture();
    const first = await outbox.append(randomUUID(), "one");
    const obstruction = batchPath(outbox, 2);
    await mkdir(obstruction);
    const id = randomUUID();
    await expect(outbox.append(id, "two")).rejects.toThrow();
    await rm(obstruction, { recursive: true });
    const reopened = await NativeHistoryOutbox.open(input);
    expect(await reopened.pending()).toEqual([first]);
    const second = await reopened.append(id, "two");
    expect(second.sequence).toBe(2);
    expect(
      (await readdir(outbox.directory)).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  });

  it("keeps the batch retryable after an acknowledgment write fails", async () => {
    const { input, outbox } = await fixture();
    const record = await outbox.append(randomUUID(), "body");
    const obstruction = batchPath(outbox, 1, "ack");
    await mkdir(obstruction);
    await expect(
      outbox.acknowledgeCommitted(receipt(record)),
    ).rejects.toThrow();
    await rm(obstruction, { recursive: true });
    const reopened = await NativeHistoryOutbox.open(input);
    expect(await reopened.pending()).toEqual([record]);
    await reopened.acknowledgeCommitted(receipt(record));
    expect(await reopened.pending()).toEqual([]);
  });

  it("refuses missing or corrupt committed records instead of resetting the baseline", async () => {
    const { input, outbox } = await fixture();
    const first = await outbox.append(randomUUID(), "one");
    await outbox.append(randomUUID(), "two");
    const firstPath = batchPath(outbox, 1);
    const saved = JSON.parse(await readFile(firstPath, "utf8"));
    await rm(firstPath);
    await expect(NativeHistoryOutbox.open(input)).rejects.toThrow("missing");
    await writeFile(
      firstPath,
      JSON.stringify({ ...saved, digest: "0".repeat(64) }),
    );
    await expect(NativeHistoryOutbox.open(input)).rejects.toThrow(
      "conflicting",
    );
    await writeFile(firstPath, JSON.stringify(saved));
    await rm(path.join(outbox.directory, "stream.json"));
    await expect(NativeHistoryOutbox.open(input)).rejects.toThrow(
      "missing its stream",
    );
  });

  it("isolates owner, server, worker, chat and binding; auth changes cannot reuse a live handle", async () => {
    const { input, outbox } = await fixture();
    const record = await outbox.append(randomUUID(), "private");
    for (const patch of [
      { service: service("other") },
      { service: service("owner", "other") },
      { workerId: "other" },
      { chatId: "other" },
      { bindingId: "other" },
    ]) {
      const other = await NativeHistoryOutbox.open({ ...input, ...patch });
      expect(await other.pending()).toEqual([]);
      await expect(other.openBody(record)).rejects.toThrow();
    }
    input.service.ownerId = () => "new-owner";
    await expect(outbox.pending()).rejects.toThrow("identity changed");
    await expect(outbox.append(randomUUID(), "later")).rejects.toThrow(
      "identity changed",
    );
    await expect(outbox.acknowledgeCommitted(receipt(record))).rejects.toThrow(
      "identity changed",
    );
  });

  it("selects the recorded encryption revision after key rotation", async () => {
    const { input, outbox } = await fixture();
    const first = await outbox.append(randomUUID(), "old body");
    const rotated = await NativeHistoryOutbox.open({
      ...input,
      service: service("owner", "server", 2),
    });
    expect(await rotated.openBody(first)).toBe("old body");
    expect(await rotated.append(first.recordId, "old body")).toEqual(first);
    const second = await rotated.append(randomUUID(), "new body");
    expect(second.envelope.keyRevision).toBe(2);
  });

  it("ignores an incomplete unpublished temporary file but preserves committed records", async () => {
    const { input, outbox } = await fixture();
    const record = await outbox.append(randomUUID(), "one");
    await writeFile(
      `${batchPath(outbox, 2)}.${randomUUID()}.tmp`,
      "incomplete encrypted bytes",
    );
    const reopened = await NativeHistoryOutbox.open(input);
    expect(await reopened.pending()).toEqual([record]);
    expect((await reopened.append(randomUUID(), "two")).sequence).toBe(2);
  });

  it("replays a batch after abrupt process exit and persists its later ACK in another process", async () => {
    const { input, outbox } = await fixture();
    const id = randomUUID();
    const source = fileURLToPath(
      new URL("../src/native-history-outbox.ts", import.meta.url),
    );
    const executable = `
      import { NativeHistoryOutbox } from ${JSON.stringify(source)};
      const box = await NativeHistoryOutbox.open({
        directory: ${JSON.stringify(input.directory)}, workerId: 'worker',
        chatId: 'chat', bindingId: 'binding',
        service: {
          ownerId: () => 'owner', serverIdentity: () => 'server',
          componentKey: (_scope, revision = 1) => ({
            key: new Uint8Array(32).fill(revision), keyRevision: revision,
          }),
        },
      });
      const record = await box.append(${JSON.stringify(id)}, 'exact body after process crash');
    `;
    const run = promisify(execFile);
    const args = [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "-e",
    ];
    await expect(
      run(process.execPath, [
        ...args,
        `${executable}\nprocess.kill(process.pid, 'SIGKILL');`,
      ]),
    ).rejects.toMatchObject({ signal: "SIGKILL" });
    const [record] = await outbox.pending();
    expect(record?.recordId).toBe(id);
    expect(await outbox.openBody(record!)).toBe(
      "exact body after process crash",
    );
    await run(process.execPath, [
      ...args,
      `${executable}
      await box.acknowledgeCommitted({
        committed: true, streamId: record.streamId, sequence: record.sequence,
        recordId: record.recordId, digest: record.digest, commitId: '00000000-0000-4000-8000-000000000001',
      });
    `,
    ]);
    expect(await outbox.pending()).toEqual([]);
    const reopened = await NativeHistoryOutbox.open(input);
    expect(reopened.streamId).toBe(outbox.streamId);
    expect((await reopened.append(randomUUID(), "successor")).sequence).toBe(2);
  });
});

describe("history batch encryption domains", () => {
  const context = {
    workerId: "worker",
    chatId: "chat",
    bindingId: "binding",
    streamId: randomUUID(),
    recordId: randomUUID(),
    sequence: 1,
    previousDigest: null,
  };
  it.each([
    { workerId: "other" },
    { chatId: "other" },
    { bindingId: "other" },
    { streamId: randomUUID() },
    { recordId: randomUUID() },
    { sequence: 2 },
    { previousDigest: "0".repeat(64) },
  ])("authenticates record context %j", async (patch) => {
    const envelope = await protectNativeHistoryBatch({
      service: service(),
      context,
      body: "private body",
    });
    expect(
      await openNativeHistoryBatch({ service: service(), context, envelope }),
    ).toBe("private body");
    await expect(
      openNativeHistoryBatch({
        service: service(),
        context: { ...context, ...patch },
        envelope,
      }),
    ).rejects.toThrow("could not be authenticated");
  });
});
