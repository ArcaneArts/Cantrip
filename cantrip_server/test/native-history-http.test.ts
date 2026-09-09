import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NativeHistoryBinding,
  NativeHistoryPreparedBatch,
} from "@cantrip/protocol";
import * as schema from "../src/db/schema.js";
import { createNativeCommandWorkerFixture } from "./native-command-worker-fixture.js";
import { NativeHistoryClient } from "../../cantrip_worker/src/native-history-client.js";
import { NativeHistoryBatchRejectedError } from "../../cantrip_worker/src/native-history-rejection.js";
import { NativeHistoryOutbox } from "../../cantrip_worker/src/native-history-outbox.js";
import { NativeHistoryDelivery } from "../../cantrip_worker/src/native-history-delivery.js";
import {
  protectChatMessage,
  openEncryptedChatTurn,
} from "../../cantrip_worker/src/chat-message-encryption.js";
import type { WorkerEncryptionService } from "../../cantrip_worker/src/worker-encryption.js";
import { protectNativeHistoryItemEvidence } from "../../cantrip_worker/src/native-history-item-content.js";
import {
  openNativeHistoryArchivePage,
  openNativeHistoryTurnArchivePage,
} from "../../cantrip_worker/src/native-history-archive.js";
import { NativeHistorySourceJournal } from "../../cantrip_worker/src/native-history-source-journal.js";
import { NativeHistoryProjection } from "../../cantrip_worker/src/native-history-projection.js";
import { createNativeHistoryProjector } from "../../cantrip_worker/src/native-history-projector.js";
import { restoreNativeHistoryProjectorState } from "../../cantrip_worker/src/native-history-projector-bootstrap.js";
import { readNativeHistoryRecovery } from "../../cantrip_worker/src/native-history-recovery.js";
import { openNativeHistoryBatchArchivePage } from "../../cantrip_worker/src/native-history-batch-archive.js";
import { nativeHistoryStateItemSchema } from "../../cantrip_worker/src/native-history-state.js";
import { reduceNativeHistory } from "../../cantrip_worker/src/native-history-reducer.js";
import {
  prepareNativeHistoryTurn,
  protectNativeHistoryTurnMetadata,
} from "../../cantrip_worker/src/native-history-turn-content.js";
import { parseCodexNativeHistory } from "../../cantrip_worker/src/codex/native-history.js";

let f: Awaited<ReturnType<typeof createNativeCommandWorkerFixture>>;
let directory: string;
let serverUrl: string;
let client: NativeHistoryClient;
let binding: NativeHistoryBinding;
let service: WorkerEncryptionService;
const pumps: NativeHistoryDelivery[] = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "cantrip-history-http-"));
  f = await createNativeCommandWorkerFixture({
    cwd: directory,
    modelBaseUrl: "http://127.0.0.1:1/v1",
  });
  serverUrl = await f.app.listen({ port: 0, host: "127.0.0.1" });
  client = makeClient();
  const threadId = randomUUID();
  await f.bindThread(threadId);
  binding = await client.open({
    chatId: f.chatId,
    threadId,
    provenance: { kind: "current" },
  });
  service = {
    ownerId: () => f.ownerId,
    serverIdentity: () => f.serverId,
    componentKey: (_scope: string, revision = 1) => ({
      key: new Uint8Array(32).fill(19),
      keyRevision: revision,
    }),
  } as unknown as WorkerEncryptionService;
}, 60_000);

afterEach(async () => {
  for (const pump of pumps.splice(0)) pump.stop();
  await f?.close();
  await rm(directory, { recursive: true, force: true });
});

function makeClient(fetcher?: typeof fetch, token = f.token) {
  return new NativeHistoryClient({
    serverUrl,
    workerId: f.workerId,
    token: () => token,
    fetch: fetcher,
  });
}
const scope = () => ({ chatId: f.chatId, bindingId: binding.id });
const outboxInput = () => ({
  directory,
  ...scope(),
  workerId: f.workerId,
  service,
});
const identity = (itemId: string) => ({
  threadId: binding.threadId,
  turnId: "http-turn",
  itemId,
  component: "assistant",
  identityKind: "canonical" as const,
});
const transaction = <T>(
  apply: Parameters<
    typeof f.repository.nativeHistoryBindings.withBinding<T>
  >[4],
) =>
  f.repository.nativeHistoryBindings.withBinding(
    f.ownerId,
    f.workerId,
    f.chatId,
    binding.id,
    apply,
  );

async function prepare(count = 1): Promise<NativeHistoryPreparedBatch> {
  const mappings = await client.resolve({
    ...scope(),
    items: Array.from({ length: count }, (_, index) => ({
      identity: identity(`item-${index}`),
      association: { kind: "native" as const },
    })),
  });
  return {
    items: await Promise.all(
      mappings.map(async (mapping, index) => ({
        identity: mapping.identity,
        revision: 1,
        state: "completed" as const,
        order: { turn: 0, item: index, component: 0 },
        message: await protectChatMessage({
          id: mapping.messageId,
          service,
          message: {
            role: "assistant",
            content: [{ type: "text", text: `private HTTP answer ${index}` }],
            idempotencyKey: mapping.idempotencyKey,
          },
        }),
        attachments: [],
      })),
    ),
    turns: [],
  };
}

async function archived(count = 3) {
  const batch = await prepare(count);
  batch.turns = await archiveTurnsFor(binding);
  for (const item of batch.items) {
    item.evidence = await protectNativeHistoryItemEvidence({
      service,
      binding,
      identity: item.identity,
      revision: 1,
      source: nativeHistoryStateItemSchema.parse({
        id: item.identity.itemId,
        identityKind: "canonical",
        revision: 1,
        ordinal: item.order.item,
        body: {
          id: item.identity.itemId,
          type: "agentMessage",
          text: "complete private source",
          unknownField: { preserved: true },
        },
        lifecycle: "completed",
        completeBody: true,
        startedAtMs: null,
        completedAtMs: null,
        conflicts: [],
        origin: {
          kind: "snapshot",
          generation: "retired-runtime",
          sequence: 3,
        },
      }),
    });
  }
  const outbox = await NativeHistoryOutbox.open(outboxInput());
  const body = JSON.stringify(batch);
  const record = await outbox.append(randomUUID(), body);
  await outbox.acknowledgeCommitted(
    await client.deliver(scope(), record, body),
  );
  return { batch, outbox };
}

async function archiveTurnsFor(
  sourceBinding: NativeHistoryBinding,
  ids = ["http-turn", "empty-turn", "older-turn"],
) {
  const snapshot = parseCodexNativeHistory(
    {
      thread: {
        id: sourceBinding.threadId,
        status: { type: "idle" },
        turns: ids.map((id) => ({
          id,
          status: "completed",
          items: [],
          itemsView: "full",
          startedAt: 1788000000,
          completedAt: 1788000002,
          durationMs: 1750,
          error: null,
          unknownTurnField: { value: "private turn evidence" },
        })),
      },
    },
    sourceBinding.threadId,
  );
  return Promise.all(
    snapshot.thread.turns.map((turn) =>
      prepareNativeHistoryTurn({
        service,
        binding: sourceBinding,
        snapshot,
        turnId: turn.id,
        revision: 1,
      }),
    ),
  );
}

describe("authenticated encrypted history transport", () => {
  it("compares the canonical preparation basis rather than accepting a larger producer counter or silently consuming a smaller one", async () => {
    const batch = await prepare();
    batch.items[0]!.revision = 7;
    const first = {
      ...scope(),
      streamId: randomUUID(),
      sequence: 1,
      recordId: randomUUID(),
      digest: "a".repeat(64),
      previousDigest: null,
      batch,
    };
    const firstReceipt = await client.ingest(first);
    const legacyStale = {
      ...first,
      sequence: 2,
      recordId: randomUUID(),
      digest: "b".repeat(64),
      previousDigest: firstReceipt.digest,
      batch: {
        items: [
          { ...batch.items[0]!, revision: 40, state: "started" as const },
        ],
        turns: [],
      },
    };
    const staleReceipt = await client.ingest(legacyStale);
    const basis = restoreNativeHistoryProjectorState(
      await readNativeHistoryRecovery({ binding, service, client }),
    );
    expect(basis.items[0]).toMatchObject({
      revision: 40,
      canonicalRevision: 7,
      canonicalState: "completed",
    });
    const winning = await prepare();
    winning.items[0]!.revision = 8;
    const winner = await client.ingest({
      ...first,
      sequence: 3,
      recordId: randomUUID(),
      digest: "c".repeat(64),
      previousDigest: staleReceipt.digest,
      batch: winning,
    });
    // Resolution can succeed after the source basis was captured. It is not
    // permission to stamp revision eight onto content prepared from seven.
    await client.resolve({
      ...scope(),
      items: [
        {
          identity: batch.items[0]!.identity,
          association: { kind: "existing" },
        },
      ],
    });
    const pending = {
      ...first,
      sequence: 4,
      recordId: randomUUID(),
      digest: "d".repeat(64),
      previousDigest: winner.digest,
      batch: {
        items: [
          {
            ...batch.items[0]!,
            revision: 41,
            expectedRevision: basis.items[0]!.canonicalRevision,
          },
        ],
        turns: [],
      },
    };
    const failure = await client.ingest(pending).catch((error) => error);
    expect(failure).toBeInstanceOf(NativeHistoryBatchRejectedError);
    expect(failure.code).toBe("item-revision-conflict");
    const smaller = {
      ...pending,
      recordId: randomUUID(),
      batch: {
        items: [{ ...batch.items[0]!, revision: 1, expectedRevision: 0 }],
        turns: [],
      },
    };
    await expect(client.ingest(smaller)).rejects.toBeInstanceOf(
      NativeHistoryBatchRejectedError,
    );
    // Knowing the current basis still cannot silently consume an obsolete
    // proposal. Current producers must advance it or explicitly reconcile.
    await expect(
      client.ingest({
        ...smaller,
        recordId: randomUUID(),
        batch: {
          items: [{ ...batch.items[0]!, revision: 1, expectedRevision: 8 }],
          turns: [],
        },
      }),
    ).rejects.toBeInstanceOf(NativeHistoryBatchRejectedError);
    const after = await transaction(async (tx) => ({
      messages: await tx.select().from(schema.chatMessages),
      receipts: await tx.select().from(schema.nativeHistoryReceipts),
      items: await tx.select().from(schema.nativeHistoryItems),
    }));
    expect(after.items[0]!.revision).toBe(8);
    expect(after.messages[0]!.protectedContent).toEqual(
      winning.items[0]!.message.protectedContent,
    );
    expect(after.receipts).toHaveLength(3);
    const corrected = {
      ...pending,
      recordId: randomUUID(),
      batch: {
        items: [{ ...pending.batch.items[0]!, expectedRevision: 8 }],
        turns: [],
      },
    };
    await client.ingest(corrected);
    expect((await client.archive(scope())).items[0]!.revision).toBe(41);
    await expect(client.ingest(pending)).rejects.toMatchObject({
      rejection: failure.rejection,
    });
  });

  it("delivers a corrected outbox chain after a real rejection, preserving the committed prefix and a lost replacement acknowledgment", async () => {
    const box = await NativeHistoryOutbox.open(outboxInput());
    const initialBatch = await prepare();
    const firstBody = JSON.stringify(initialBatch);
    const first = await box.append(randomUUID(), firstBody);
    const firstReceipt = await client.deliver(scope(), first, firstBody);
    await box.acknowledgeCommitted(firstReceipt);
    const competing = await prepare(3);
    const rejectedBody = JSON.stringify({
      items: [competing.items[0]!],
      turns: [],
    });
    const pending = await box.append(randomUUID(), rejectedBody);
    const tailBody = JSON.stringify({
      items: [competing.items[2]!],
      turns: [],
    });
    const tail = await box.append(randomUUID(), tailBody);
    const files = await Promise.all(
      [1, 2, 3].map(async (index) => {
        const filename = path.join(
          box.directory,
          `${String(index).padStart(16, "0")}.mutation.json`,
        );
        return { filename, content: await readFile(filename, "utf8") };
      }),
    );
    const failure = await client
      .deliver(scope(), pending, rejectedBody)
      .catch((error) => error);
    expect(failure).toBeInstanceOf(NativeHistoryBatchRejectedError);
    const correctedBody = JSON.stringify({
      items: [{ ...competing.items[0]!, revision: 2 }],
      turns: [],
    });
    const id = randomUUID();
    const corrected = await box.replaceRejected(
      failure.rejection,
      id,
      correctedBody,
    );
    expect(corrected.map((record) => record.sequence)).toEqual([2, 3]);
    expect(corrected[0]!.previousDigest).toBe(first.digest);
    expect(await box.openBody(corrected[1]!)).toBe(tailBody);
    const replacementReceipt = await client.deliver(
      scope(),
      corrected[0]!,
      correctedBody,
    );
    // Simulate the response being lost before the local ACK is persisted.
    const reopened = await NativeHistoryOutbox.open(outboxInput());
    expect(await reopened.pending()).toEqual(corrected);
    expect(
      await reopened.replaceRejected(failure.rejection, id, correctedBody),
    ).toEqual(corrected);
    const retried = await makeClient().deliver(
      scope(),
      corrected[0]!,
      correctedBody,
    );
    expect(retried).toEqual(replacementReceipt);
    await reopened.acknowledgeCommitted(retried);
    const tailReceipt = await client.deliver(scope(), corrected[1]!, tailBody);
    await reopened.acknowledgeCommitted(tailReceipt);
    expect(await reopened.pending()).toEqual([]);
    expect(await reopened.committedReceipt(first.recordId, firstBody)).toEqual(
      firstReceipt,
    );
    expect(
      await reopened.committedReceipt(pending.recordId, rejectedBody),
    ).toBeNull();
    expect(await reopened.replacement(tail.recordId)).toEqual({
      record: corrected[1],
      rejection: failure.rejection,
    });
    for (const file of files)
      expect(await readFile(file.filename, "utf8")).toBe(file.content);
    const result = await transaction(async (tx) => ({
      messages: await tx.select().from(schema.chatMessages),
      receipts: await tx.select().from(schema.nativeHistoryReceipts),
    }));
    expect(result.messages).toHaveLength(2);
    expect(result.receipts).toHaveLength(3);
    const replay = await client
      .deliver(scope(), pending, rejectedBody)
      .catch((error) => error);
    expect(replay.rejection).toEqual(failure.rejection);
  });

  it("retains a new historical worker's rejection without leaving a partially created stream", async () => {
    const batch = await prepare();
    await client.ingest({
      ...scope(),
      streamId: randomUUID(),
      recordId: randomUUID(),
      sequence: 1,
      digest: "a".repeat(64),
      previousDigest: null,
      batch,
    });
    const otherBinding = {
      ...binding,
      id: randomUUID(),
      workerId: randomUUID(),
    };
    await transaction(async (tx) => {
      const [worker] = await tx
        .select()
        .from(schema.workers)
        .where(eq(schema.workers.id, f.workerId));
      await tx
        .insert(schema.workers)
        .values({ ...worker!, id: otherBinding.workerId });
      await tx.insert(schema.nativeHistoryBindings).values({
        ...otherBinding,
        ownerId: f.ownerId,
        createdAt: new Date(otherBinding.createdAt),
      });
    });
    const request = {
      workerId: otherBinding.workerId,
      bindingId: otherBinding.id,
      chatId: f.chatId,
      streamId: randomUUID(),
      recordId: randomUUID(),
      sequence: 1,
      digest: "b".repeat(64),
      previousDigest: null,
      batch: await prepare(),
    };
    const result = await f.repository.nativeHistoryIngestion
      .ingest(f.ownerId, request)
      .catch((error) => error);
    expect(result).toMatchObject({
      code: "item-revision-conflict",
      rejection: {
        bindingId: otherBinding.id,
        workerId: otherBinding.workerId,
        streamId: request.streamId,
      },
    });
    const inspect = () =>
      transaction(async (tx) => ({
        streams: await tx
          .select()
          .from(schema.nativeHistoryStreams)
          .where(eq(schema.nativeHistoryStreams.bindingId, otherBinding.id)),
        rejections: await tx
          .select()
          .from(schema.nativeHistoryRejections)
          .where(eq(schema.nativeHistoryRejections.bindingId, otherBinding.id)),
      }));
    expect((await inspect()).streams).toEqual([]);
    expect((await inspect()).rejections).toHaveLength(1);
    const corrected = {
      ...request,
      recordId: randomUUID(),
      batch: {
        items: request.batch.items.map((item) => ({ ...item, revision: 2 })),
        turns: [],
      },
    };
    await f.repository.nativeHistoryIngestion.ingest(f.ownerId, corrected);
    expect((await inspect()).streams[0]?.acknowledgedSequence).toBe(1);
    await expect(
      f.repository.nativeHistoryIngestion.ingest(f.ownerId, request),
    ).rejects.toMatchObject({ rejection: result.rejection });
  });

  it("rolls back message writes on a turn revision conflict without permanently rejecting ordinary validation failures", async () => {
    const batch = await prepare();
    batch.turns = await archiveTurnsFor(binding);
    const request = {
      ...scope(),
      streamId: randomUUID(),
      sequence: 1,
      recordId: randomUUID(),
      digest: "a".repeat(64),
      previousDigest: null,
      batch,
    };
    const first = await client.ingest(request);
    const changed = await prepare();
    changed.items[0]!.revision = 2;
    changed.turns = await archiveTurnsFor(binding); // Same revision, different protected bytes.
    const next = {
      ...request,
      sequence: 2,
      previousDigest: first.digest,
      recordId: randomUUID(),
      digest: "b".repeat(64),
      batch: changed,
    };
    const inspect = () =>
      transaction(async (tx) => ({
        messages: await tx.select().from(schema.chatMessages),
        turns: await tx.select().from(schema.nativeHistoryTurns),
        receipts: await tx.select().from(schema.nativeHistoryReceipts),
        rejections: await tx.select().from(schema.nativeHistoryRejections),
      }));
    const before = await inspect();
    const invalid = {
      ...next,
      batch: {
        items: [
          changed.items[0]!,
          { ...changed.items[0]!, identity: identity("unresolved") },
        ],
        turns: [],
      },
    };
    await expect(client.ingest(invalid)).rejects.toMatchObject({
      code: "item-not-resolved",
    });
    expect(await inspect()).toEqual(before);
    const conflict = await client.ingest(next).catch((error) => error);
    expect(conflict).toBeInstanceOf(NativeHistoryBatchRejectedError);
    expect(conflict.rejection.code).toBe("turn-revision-conflict");
    const after = await inspect();
    expect(after.messages).toEqual(before.messages);
    expect(after.turns).toEqual(before.turns);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.rejections).toHaveLength(1);
    // The failed sequence remains free for a distinct, corrected record.
    await client.ingest({
      ...next,
      recordId: randomUUID(),
      batch: {
        ...changed,
        turns: changed.turns.map((turn) => ({ ...turn, revision: 2 })),
      },
    });
    const retry = await makeClient()
      .ingest(next)
      .catch((error) => error);
    expect(retry.rejection).toEqual(conflict.rejection);
  });

  it("retains a permanent revision rejection after rollback and lost response, even after the canonical head advances", async () => {
    const batch = await prepare();
    const first = {
      ...scope(),
      streamId: randomUUID(),
      sequence: 1,
      recordId: randomUUID(),
      digest: "a".repeat(64),
      previousDigest: null,
      batch,
    };
    const accepted = await client.ingest(first);
    const competing = await prepare(3);
    const rejected = {
      ...first,
      sequence: 2,
      recordId: randomUUID(),
      digest: "b".repeat(64),
      previousDigest: accepted.digest,
      // The first write must roll back when the second item's revision conflicts.
      batch: { items: [competing.items[2]!, competing.items[0]!], turns: [] },
    };
    const disconnected = makeClient(async (...args) => {
      const response = await fetch(...args);
      expect(response.status).toBe(409);
      await response.json();
      throw new Error("lost rejection response");
    });
    await expect(disconnected.ingest(rejected)).rejects.toThrow(
      "lost rejection response",
    );
    const decision = await client.ingest(rejected).catch((error) => error);
    expect(decision).toBeInstanceOf(NativeHistoryBatchRejectedError);
    expect(decision.rejection).toMatchObject({
      rejected: true,
      recordId: rejected.recordId,
      sequence: 2,
      code: "item-revision-conflict",
    });
    const inspect = () =>
      transaction(async (tx) => ({
        messages: await tx.select().from(schema.chatMessages),
        receipts: await tx.select().from(schema.nativeHistoryReceipts),
        rejections: await tx.select().from(schema.nativeHistoryRejections),
        streams: await tx.select().from(schema.nativeHistoryStreams),
        publications: await tx.select().from(schema.nativeHistoryPublications),
      }));
    const before = await inspect();
    expect(before.messages).toHaveLength(1);
    expect(before.receipts).toHaveLength(1);
    expect(before.rejections).toHaveLength(1);
    expect(before.streams[0]?.acknowledgedSequence).toBe(1);
    expect(
      before.publications.every(
        (entry) => entry.commitId === accepted.commitId,
      ),
    ).toBe(true);
    const newer = {
      ...rejected,
      recordId: randomUUID(),
      digest: "c".repeat(64),
      batch: { items: [{ ...competing.items[0]!, revision: 2 }], turns: [] },
    };
    await client.ingest(newer);
    const recovered = await makeClient()
      .ingest(rejected)
      .catch((error) => error);
    expect(recovered).toBeInstanceOf(NativeHistoryBatchRejectedError);
    expect(recovered.rejection).toEqual(decision.rejection);
    const after = await inspect();
    expect(after.messages).toHaveLength(1);
    expect(after.receipts).toHaveLength(2);
    expect(after.rejections).toEqual(before.rejections);
    expect(after.streams[0]?.acknowledgedSequence).toBe(2);
    await expect(
      client.ingest({ ...rejected, batch: newer.batch }),
    ).rejects.toMatchObject({
      code: "batch-rejection-conflict",
    });
    await expect(
      makeClient(undefined, "invalid").ingest(rejected),
    ).rejects.toMatchObject({ status: 401 });

    for (const change of [
      { bindingId: randomUUID() },
      { workerId: randomUUID() },
      { chatId: randomUUID() },
      { streamId: randomUUID() },
      { sequence: 3 },
      { recordId: randomUUID() },
      { digest: "d".repeat(64) },
      { previousDigest: null },
      { payloadDigest: "e".repeat(64) },
      { code: "turn-revision-conflict" },
    ]) {
      const altered = makeClient(async (...args) => {
        const response = await fetch(...args);
        const body = await response.json();
        return new Response(
          JSON.stringify({
            ...body,
            rejection: { ...body.rejection, ...change },
          }),
          { status: 409 },
        );
      });
      const mismatch = await altered.ingest(rejected).catch((error) => error);
      expect(mismatch).not.toBeInstanceOf(NativeHistoryBatchRejectedError);
      expect(mismatch.message).toContain("unrelated batch rejection");
    }
  });

  it("recovers the original committed stream after outbox loss without recreating old ciphertext or replaying accepted batches", async () => {
    const { outbox } = await archived(2);
    const recovery = await readNativeHistoryRecovery({
      client,
      service,
      binding,
    });
    const first = recovery.batches[0]!;
    const originalId = outbox.streamId;
    await rm(outbox.directory, { recursive: true });
    const recover = vi.fn(async () => recovery);
    const restored = await NativeHistoryOutbox.open({
      ...outboxInput(),
      recover,
    });
    expect(restored.streamId).toBe(originalId);
    expect(await restored.pending()).toEqual([]);
    expect(
      await restored.committedReceipt(
        first.receipt.recordId,
        JSON.stringify(first.batch),
      ),
    ).toEqual(first.receipt);
    await expect(
      restored.committedReceipt(
        first.receipt.recordId,
        JSON.stringify({ items: [], turns: [] }),
      ),
    ).rejects.toThrow("different batch content");
    await expect(
      restored.append(first.receipt.recordId, JSON.stringify(first.batch)),
    ).rejects.toThrow("restored as committed");
    const manifestPath = path.join(restored.directory, "stream.json");
    const manifest = await readFile(manifestPath, "utf8");
    expect(manifest).not.toContain(first.receipt.commitId);
    expect(manifest).not.toContain(first.payloadDigest);
    const nextBody = JSON.stringify({ items: [], turns: [] });
    const next = await restored.append(randomUUID(), nextBody);
    expect(next.sequence).toBe(2);
    expect(next.previousDigest).toBe(first.receipt.digest);
    const receipt = await client.deliver(scope(), next, nextBody);
    await restored.acknowledgeCommitted(receipt);
    await restored.acknowledgeCommitted(first.receipt);
    await expect(
      restored.acknowledgeCommitted({
        ...first.receipt,
        commitId: randomUUID(),
      }),
    ).rejects.toThrow("changed");
    const reopened = await NativeHistoryOutbox.open({
      ...outboxInput(),
      recover,
    });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await reopened.pending()).toEqual([]);
    expect(await reopened.committedReceipt(next.recordId, nextBody)).toEqual(
      receipt,
    );
    const third = await reopened.append(randomUUID(), nextBody);
    expect(third.sequence).toBe(3);
    expect(third.previousDigest).toBe(next.digest);
    expect(await reopened.pending()).toEqual([third]);
    // Relabeling the baseline's stream cannot authenticate its encrypted prefix.
    await writeFile(
      manifestPath,
      JSON.stringify({ ...JSON.parse(manifest), streamId: randomUUID() }),
    );
    await expect(NativeHistoryOutbox.open(outboxInput())).rejects.toThrow();
    await writeFile(manifestPath, manifest);
    expect((await NativeHistoryOutbox.open(outboxInput())).streamId).toBe(
      originalId,
    );
  });

  it("rejects incomplete or unrelated outbox recovery and stops an identity change before writing a new stream", async () => {
    const { outbox } = await archived(1);
    const body = JSON.stringify({ items: [], turns: [] });
    const next = await outbox.append(randomUUID(), body);
    await outbox.acknowledgeCommitted(
      await client.deliver(scope(), next, body),
    );
    const recovery = await readNativeHistoryRecovery({
      client,
      service,
      binding,
    });
    const input = {
      ...outboxInput(),
      directory: path.join(directory, "recovery-validation"),
    };
    await expect(
      NativeHistoryOutbox.open({
        ...input,
        recover: async () => ({
          ...recovery,
          batches: recovery.batches.slice(1),
        }),
      }),
    ).rejects.toThrow(/gap or conflicting|content does not match/u);
    await expect(
      NativeHistoryOutbox.open({
        ...input,
        recover: async () => ({
          ...recovery,
          binding: { ...binding, workerId: randomUUID() },
        }),
      }),
    ).rejects.toThrow("different binding");
    const altered = structuredClone(recovery);
    altered.batches[0]!.payloadDigest = "e".repeat(64);
    await expect(
      NativeHistoryOutbox.open({ ...input, recover: async () => altered }),
    ).rejects.toThrow("does not match");
    let ownerId = f.ownerId;
    const changing = {
      ...service,
      ownerId: () => ownerId,
    } as WorkerEncryptionService;
    await expect(
      NativeHistoryOutbox.open({
        ...input,
        service: changing,
        recover: async () => {
          ownerId = "changed-owner";
          return recovery;
        },
      }),
    ).rejects.toThrow("identity changed during recovery");
    const correct = await NativeHistoryOutbox.open({
      ...input,
      recover: async () => recovery,
    });
    expect(correct.streamId).toBe(outbox.streamId);
    expect(await correct.pending()).toEqual([]);
    expect((await correct.append(randomUUID(), body)).sequence).toBe(3);
  });

  it("bootstraps a fresh worker above retained revisions and preserves unchanged published content before applying a new native cursor", async () => {
    const { batch, outbox: oldOutbox } = await archived(1);
    const initial = await readNativeHistoryRecovery({
      client,
      service,
      binding,
    });
    const previousSource = {
      ...initial.items[0]!.source!,
      origin: {
        ...initial.items[0]!.source!.origin,
        nativeCursor: {
          epoch: "retained-native",
          sequence: "1",
          previousSequence: null,
        },
      },
    };
    const high = {
      ...batch.items[0]!,
      revision: 7,
      evidence: await protectNativeHistoryItemEvidence({
        service,
        binding,
        identity: batch.items[0]!.identity,
        revision: 7,
        source: previousSource,
      }),
    };
    const body = JSON.stringify({ items: [high], turns: [] });
    const record = await oldOutbox.append(randomUUID(), body);
    await oldOutbox.acknowledgeCommitted(
      await client.deliver(scope(), record, body),
    );
    // Accepted started evidence has a higher producer counter but did not
    // replace the completed canonical item. Its counter is a floor, not a vote
    // for its stale body during migration.
    const rejectedBody = {
      ...previousSource,
      lifecycle: "started" as const,
      body: {
        ...previousSource.body,
        text: "must not select this stale candidate",
      },
    };
    const stale = {
      ...high,
      revision: 40,
      state: "started" as const,
      evidence: await protectNativeHistoryItemEvidence({
        service,
        binding,
        identity: high.identity,
        revision: 40,
        source: rejectedBody,
      }),
    };
    const staleBody = JSON.stringify({ items: [stale], turns: [] });
    const staleRecord = await oldOutbox.append(randomUUID(), staleBody);
    await oldOutbox.acknowledgeCommitted(
      await client.deliver(scope(), staleRecord, staleBody),
    );
    const replacement = {
      ...binding,
      id: randomUUID(),
      workerId: randomUUID(),
    };
    await transaction(async (tx) => {
      const [worker] = await tx
        .select()
        .from(schema.workers)
        .where(eq(schema.workers.id, f.workerId));
      await tx
        .insert(schema.workers)
        .values({ ...worker!, id: replacement.workerId });
      await tx.insert(schema.nativeHistoryBindings).values({
        ...replacement,
        ownerId: f.ownerId,
        createdAt: new Date(replacement.createdAt),
      });
    });
    const migrated = new NativeHistoryClient({
      serverUrl,
      workerId: replacement.workerId,
      token: () => f.token,
    });
    const common = {
      directory: path.join(directory, "migration"),
      chatId: f.chatId,
      bindingId: replacement.id,
      workerId: replacement.workerId,
      service,
    };
    const journal = await NativeHistorySourceJournal.open({
      ...common,
      directory: path.join(common.directory, "source"),
      threadId: binding.threadId,
    });
    const outbox = await NativeHistoryOutbox.open({
      ...common,
      directory: path.join(common.directory, "outbox"),
    });
    const bootstrap = vi.fn(async () =>
      restoreNativeHistoryProjectorState(
        await readNativeHistoryRecovery({
          client: migrated,
          service,
          binding: replacement,
        }),
      ),
    );
    const context = vi.fn(async () => ({
      cwd: directory,
      mode: "default" as const,
    }));
    const materialize = vi.fn(async () => ({ attachments: [] }));
    const projection = await NativeHistoryProjection.open({
      ...common,
      directory: path.join(common.directory, "projection"),
      source: journal,
      outbox,
      client: migrated,
      project: createNativeHistoryProjector({
        binding: replacement,
        client: migrated,
        service,
        bootstrap,
        context,
        materialize,
        associate: async () => ({ kind: "native" }),
      }),
    });
    await journal.append({
      kind: "notification",
      threadId: binding.threadId,
      generation: "replacement",
      sequence: 1,
      receivedAtMs: 1,
      method: "thread/tokenUsage/updated",
      params: {
        threadId: binding.threadId,
        turnId: "http-turn",
        usage: { totalTokens: 42 },
      },
    });
    await projection.drain();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(context).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    let canonical = await transaction((tx) =>
      tx.select().from(schema.chatMessages),
    );
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.protectedContent).toEqual(
      high.message.protectedContent,
    );
    expect((await client.archive(scope())).items[0]!.revision).toBe(7);
    expect((await projection.checkpoint()).cursor.sequence).toBe(1);
    await journal.append({
      kind: "notification",
      threadId: binding.threadId,
      generation: "replacement",
      sequence: 2,
      receivedAtMs: 2,
      nativeCursor: {
        epoch: "retained-native",
        sequence: "2",
        previousSequence: "1",
      },
      method: "item/completed",
      params: {
        threadId: binding.threadId,
        turnId: "http-turn",
        item: {
          ...previousSource.body,
          text: "new native content after migration",
        },
      },
    });
    await projection.drain();
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenCalledTimes(1);
    const recovered = await readNativeHistoryRecovery({
      client: migrated,
      service,
      binding: replacement,
    });
    expect(recovered.items[0]!.revision).toBe(41);
    expect(recovered.items[0]!.source!.body.text).toBe(
      "new native content after migration",
    );
    expect(recovered.items[0]!.messageId).toBe(high.message.id);
    const restoredAgain = restoreNativeHistoryProjectorState(recovered);
    expect(restoredAgain.items[0]!.revision).toBe(41);
    expect(
      restoredAgain.source.turns.find((turn) => turn.id === "http-turn")!
        .items[0]!.body.text,
    ).toBe("new native content after migration");
    expect(
      new Set(restoredAgain.source.evidence.map((entry) => entry.recordId))
        .size,
    ).toBe(restoredAgain.source.evidence.length);

    canonical = await transaction((tx) =>
      tx.select().from(schema.chatMessages),
    );
    expect(canonical).toHaveLength(1);
    const current = await migrated.archiveTurns({
      chatId: f.chatId,
      bindingId: replacement.id,
    });
    expect(
      current.turns.filter((entry) => entry.bindingId === replacement.id),
    ).toHaveLength(3);
    expect((await projection.checkpoint()).cursor.sequence).toBe(2);
    const currentTurn = recovered.turns.find(
      (entry) =>
        entry.bindingId === replacement.id && entry.turn.turnId === "http-turn",
    )!;
    const { metadata: _metadata, ...header } = currentTurn.turn;
    const content = currentTurn.source as Record<string, any>;
    const failed = await protectNativeHistoryTurnMetadata({
      service,
      binding: replacement,
      header: { ...header, revision: 999, status: "failed" },
      content: {
        ...content,
        reducedTurn: {
          ...content.reducedTurn,
          body: { ...content.reducedTurn.body, status: "failed" },
        },
      },
    });
    const failedBody = JSON.stringify({ items: [], turns: [failed] });
    const failedRecord = await outbox.append(randomUUID(), failedBody);
    await outbox.acknowledgeCommitted(
      await migrated.deliver(
        { chatId: f.chatId, bindingId: replacement.id },
        failedRecord,
        failedBody,
      ),
    );
    const conflicting = restoreNativeHistoryProjectorState(
      await readNativeHistoryRecovery({
        client: migrated,
        service,
        binding: replacement,
      }),
    );
    const uncertain = conflicting.source.turns.find(
      (turn) => turn.id === "http-turn",
    )!;
    expect(uncertain.body.status).toBeUndefined();
    expect(uncertain.conflicts.some((body) => body.status === "failed")).toBe(
      true,
    );
    expect(
      uncertain.conflicts.some((body) => body.status === "completed"),
    ).toBe(true);
    expect(
      conflicting.turns.find((turn) => turn.turnId === "http-turn")!.revision,
    ).toBe(999);
    const confirmed = reduceNativeHistory(
      conflicting.source,
      [
        {
          sequence: 1,
          recordId: randomUUID(),
          frame: {
            kind: "notification",
            threadId: binding.threadId,
            generation: "confirmed-runtime",
            sequence: 1,
            receivedAtMs: 1,
            method: "turn/completed",
            params: {
              threadId: binding.threadId,
              turn: { id: "http-turn", status: "completed" },
            },
          },
        },
      ],
      binding.threadId,
    );
    expect(
      confirmed.turns.find((turn) => turn.id === "http-turn")!.body.status,
    ).toBe("completed");
  });

  it("recovers a coherent encrypted archive after a real commit changes the paginated snapshot", async () => {
    const { batch, outbox } = await archived(3);
    let commits = 0;
    let itemRequests = 0;
    const retry = vi.fn();
    const recovering = makeClient(async (input, init) => {
      const url = new URL(String(input));
      const request = JSON.parse(String(init!.body));
      if (url.pathname.endsWith("/archive")) itemRequests++;
      // Change the actual durable state between canonical-item and turn reads.
      // The server must reject the old snapshot and the reader must restart all
      // resources, rather than combine old item pages with new turn/batch pages.
      if (url.pathname.endsWith("/archive-turns") && commits++ === 0) {
        const updated = { ...batch.items[0]!, revision: 2 };
        const original = await openNativeHistoryArchivePage({
          service,
          page: await client.archive(scope()),
        });
        const source = original.items.find(
          (item) => item.identity.itemId === updated.identity.itemId,
        )!.source!;
        updated.evidence = await protectNativeHistoryItemEvidence({
          service,
          binding,
          identity: updated.identity,
          revision: 2,
          source: {
            ...source,
            revision: 2,
            body: { ...source.body, text: "committed during recovery" },
          },
        });
        const body = JSON.stringify({ items: [updated], turns: [] });
        const record = await outbox.append(randomUUID(), body);
        await outbox.acknowledgeCommitted(
          await client.deliver(scope(), record, body),
        );
      }
      if (
        url.pathname.endsWith("/archive-turns") ||
        url.pathname.endsWith("/archive-batches")
      )
        expect(request.snapshotId).toMatch(/^[a-f0-9]{64}$/u);
      return fetch(input, init);
    });
    const result = await readNativeHistoryRecovery({
      client: recovering,
      service,
      binding,
      pageSize: 1,
      batchPageSize: 1,
      onRetry: retry,
    });
    expect(retry).toHaveBeenCalledExactlyOnceWith(1);
    expect(itemRequests).toBe(6);
    expect(result.items).toHaveLength(3);
    expect(result.turns).toHaveLength(3);
    expect(result.batches).toHaveLength(2);
    expect(
      result.items.find((item) => item.revision === 2)!.source!.body.text,
    ).toBe("committed during recovery");
    expect(result.batches[1]!.source!.items[0]!.source!.body.text).toBe(
      "committed during recovery",
    );
    expect(result.snapshotId).toBe((await client.archive(scope())).snapshotId);
    const emptyBindingThread = randomUUID();
    await f.bindThread(emptyBindingThread);
    const emptyBinding = await client.open({
      chatId: f.chatId,
      threadId: emptyBindingThread,
      provenance: { kind: "current" },
    });
    const empty = await readNativeHistoryRecovery({
      client,
      service,
      binding: emptyBinding,
    });
    expect(empty.items).toEqual([]);
    expect(empty.turns).toEqual([]);
    expect(empty.batches).toEqual([]);
  });

  it("cancels recovery after a real snapshot conflict without retrying unrelated failures", async () => {
    const { outbox } = await archived(1);
    const abort = new AbortController();
    let requests = 0;
    const changing = makeClient(async (input, init) => {
      requests++;
      if (new URL(String(input)).pathname.endsWith("/archive-turns")) {
        const body = JSON.stringify({ items: [], turns: [] });
        const record = await outbox.append(randomUUID(), body);
        await outbox.acknowledgeCommitted(
          await client.deliver(scope(), record, body),
        );
      }
      return fetch(input, init);
    });
    await expect(
      readNativeHistoryRecovery({
        client: changing,
        service,
        binding,
        signal: abort.signal,
        onRetry: () => abort.abort(new Error("recovery stopped")),
      }),
    ).rejects.toThrow("recovery stopped");
    expect(requests).toBe(2);
    const retry = vi.fn();
    await expect(
      readNativeHistoryRecovery({
        client: makeClient(undefined, "invalid-token"),
        service,
        binding,
        onRetry: retry,
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      readNativeHistoryRecovery({
        client,
        service,
        binding: { ...binding, id: randomUUID() },
        onRetry: retry,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const brokenCrypto = {
      ...service,
      componentKey: () => {
        throw new Error("key unavailable");
      },
    } as WorkerEncryptionService;
    await expect(
      readNativeHistoryRecovery({
        client,
        service: brokenCrypto,
        binding,
        onRetry: retry,
      }),
    ).rejects.toThrow("key unavailable");
    expect(retry).not.toHaveBeenCalled();
  });

  it("stops archive decryption between items instead of waiting for the complete page", async () => {
    await archived(3);
    const pages = {
      items: await client.archive(scope()),
      turns: await client.archiveTurns(scope()),
      batches: await client.archiveBatches(scope()),
    };
    for (const open of [
      (service: WorkerEncryptionService, signal: AbortSignal) =>
        openNativeHistoryArchivePage({ service, signal, page: pages.items }),
      (service: WorkerEncryptionService, signal: AbortSignal) =>
        openNativeHistoryTurnArchivePage({
          service,
          signal,
          page: pages.turns,
        }),
      (service: WorkerEncryptionService, signal: AbortSignal) =>
        openNativeHistoryBatchArchivePage({
          service,
          signal,
          page: pages.batches,
        }),
      (service: WorkerEncryptionService, signal: AbortSignal) =>
        readNativeHistoryRecovery({ client, service, signal, binding }),
    ]) {
      const abort = new AbortController();
      const key = vi.fn((scope: string, revision?: number) => {
        abort.abort(new Error("stop archive decryption"));
        return service.componentKey(
          scope as Parameters<WorkerEncryptionService["componentKey"]>[0],
          revision,
        );
      });
      const interrupted = {
        ...service,
        componentKey: key,
      } as WorkerEncryptionService;
      await expect(open(interrupted, abort.signal)).rejects.toThrow(
        "stop archive decryption",
      );
      expect(key).toHaveBeenCalledTimes(1);
    }
  });

  it("retains accepted older batches without regressing presentation, deduplicates retries and rolls back failures", async () => {
    const { batch, outbox } = await archived(1);
    const original = await openNativeHistoryArchivePage({
      service,
      page: await client.archive(scope()),
    });
    const candidate = async (revision: number, text: string) => ({
      ...batch.items[0]!,
      revision,
      evidence: await protectNativeHistoryItemEvidence({
        service,
        binding,
        identity: batch.items[0]!.identity,
        revision,
        source: {
          ...original.items[0]!.source!,
          revision,
          body: { ...original.items[0]!.source!.body, text },
        },
      }),
    });
    const newer = await candidate(3, "newer retained evidence");
    const older = await candidate(2, "older retained evidence");
    const submit = async (
      item: NativeHistoryPreparedBatch["items"][number],
    ) => {
      const body = JSON.stringify({ items: [item], turns: [] });
      const record = await outbox.append(randomUUID(), body);
      const receipt = await client.deliver(scope(), record, body);
      await outbox.acknowledgeCommitted(receipt);
      return { body, record, receipt };
    };
    await submit(newer);
    const before = await client.archiveBatches({ ...scope(), limit: 1 });
    const acceptedOlder = await submit(older);
    await expect(
      client.archiveBatches({ ...scope(), cursor: before.nextCursor }),
    ).rejects.toMatchObject({ code: "archive-snapshot-changed" });
    const current = await openNativeHistoryArchivePage({
      service,
      page: await client.archive(scope()),
    });
    expect(current.items[0]!.revision).toBe(3);
    expect(current.items[0]!.source!.body.text).toBe("newer retained evidence");
    const first = await client.archiveBatches({ ...scope(), limit: 2 });
    const last = await client.archiveBatches({
      ...scope(),
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(first.batches.map((entry) => entry.receipt.sequence)).toEqual([
      1, 2,
    ]);
    expect(last.batches.map((entry) => entry.receipt.sequence)).toEqual([3]);
    expect(last.nextCursor).toBeNull();
    expect(last.batches[0]!.batch!.items[0]).toEqual(older);
    const opened = await openNativeHistoryBatchArchivePage({
      service,
      page: last,
    });
    expect(opened.batches[0]!.source!.items[0]!.source!.body.text).toBe(
      "older retained evidence",
    );
    expect(JSON.stringify(last)).not.toContain("older retained evidence");
    const openedFirst = await openNativeHistoryBatchArchivePage({
      service,
      page: first,
    });
    expect(openedFirst.batches[0]!.source!.turns).toHaveLength(3);
    expect(
      await client.deliver(scope(), acceptedOlder.record, acceptedOlder.body),
    ).toEqual(acceptedOlder.receipt);
    expect(
      await client.archiveBatches({
        ...scope(),
        limit: 2,
        cursor: first.nextCursor,
      }),
    ).toEqual(last);

    // The first write would advance canonical state; the unresolved second item
    // must roll it and the retained batch/receipt/publication back together.
    const fourth = await candidate(4, "must roll back");
    const invalid = {
      items: [
        fourth,
        { ...older, identity: { ...older.identity, itemId: "not-resolved" } },
      ],
      turns: [],
    };
    const body = JSON.stringify(invalid);
    const record = await outbox.append(randomUUID(), body);
    await expect(client.deliver(scope(), record, body)).rejects.toMatchObject({
      code: "item-not-resolved",
    });
    expect(
      await client.archiveBatches({
        ...scope(),
        limit: 2,
        cursor: first.nextCursor,
      }),
    ).toEqual(last);
    expect((await client.archive(scope())).items[0]!.revision).toBe(3);
  });

  it("represents old receipt source loss explicitly and rejects unrelated or altered batch archives", async () => {
    await archived(1);
    const first = await client.archiveBatches(scope());
    for (const mutate of [
      (page: any) => ({
        ...page,
        binding: { ...page.binding, workerId: "other" },
      }),
      (page: any) => ({ ...page, batches: [...page.batches, ...page.batches] }),
      (page: any) => ({
        ...page,
        batches: page.batches.map((entry: any) => ({
          ...entry,
          receipt: { ...entry.receipt, sequence: entry.receipt.sequence + 1 },
        })),
      }),
      (page: any) => ({
        ...page,
        batches: page.batches.map((entry: any) => ({
          ...entry,
          bindingId: "other",
        })),
      }),
      (page: any) => ({
        ...page,
        batches: page.batches.map((entry: any) => ({
          ...entry,
          batch: { ...entry.batch, turns: [] },
        })),
      }),
      (page: any) => ({
        ...page,
        batches: page.batches.map((entry: any) => ({
          ...entry,
          previousDigest: "a".repeat(64),
        })),
      }),
      (page: any) => ({
        ...page,
        nextCursor: {
          snapshotId: page.snapshotId,
          streamId: randomUUID(),
          sequence: 1,
        },
      }),
    ]) {
      const corrupt = makeClient(async (input, init) =>
        Response.json(mutate(await (await fetch(input, init)).json())),
      );
      await expect(corrupt.archiveBatches(scope())).rejects.toThrow(
        "inconsistent batch archive page",
      );
    }
    await expect(
      makeClient(undefined, "invalid-token").archiveBatches(scope()),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      client.archiveBatches({ ...scope(), bindingId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      client.archiveBatches({ ...scope(), chatId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
    await transaction(async (tx) => {
      await tx
        .update(schema.nativeHistoryReceipts)
        .set({ protectedBatch: null, previousDigest: null })
        .where(
          eq(
            schema.nativeHistoryReceipts.commitId,
            first.batches[0]!.receipt.commitId,
          ),
        );
    });
    const missing = await openNativeHistoryBatchArchivePage({
      service,
      page: await client.archiveBatches(scope()),
    });
    expect(missing.batches[0]!.source).toBeNull();
    expect(missing.batches[0]!.receipt).toEqual(first.batches[0]!.receipt);
    expect((await client.archive(scope())).items).toHaveLength(1);
  });

  it("paginates turn IDs in database-independent UTF-8 order", async () => {
    const ids = ["z", "A", "\u{10000}", "\ue000", "é"];
    const batch = { items: [], turns: await archiveTurnsFor(binding, ids) };
    const outbox = await NativeHistoryOutbox.open(outboxInput());
    const body = JSON.stringify(batch);
    const record = await outbox.append(randomUUID(), body);
    await outbox.acknowledgeCommitted(
      await client.deliver(scope(), record, body),
    );
    const first = await client.archiveTurns({ ...scope(), limit: 3 });
    const second = await client.archiveTurns({
      ...scope(),
      limit: 3,
      cursor: first.nextCursor,
    });
    expect(
      [...first.turns, ...second.turns].map((entry) => entry.turn.turnId),
    ).toEqual(
      [...ids].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    );
    expect(second.nextCursor).toBeNull();
  });
  it("reads committed archives in stable pages and decrypts full evidence with a fresh client", async () => {
    expect((await client.archive(scope())).items).toEqual([]);
    expect((await client.archiveTurns(scope())).turns).toEqual([]);
    const { batch } = await archived();
    const before = await f.repository.getChatExecutionContext(
      f.ownerId,
      f.chatId,
    );
    const recovered = makeClient();
    const first = await recovered.archive({ ...scope(), limit: 1 });
    const second = await recovered.archive({
      ...scope(),
      limit: 1,
      cursor: first.nextCursor,
    });
    const last = await recovered.archive({
      ...scope(),
      limit: 1,
      cursor: second.nextCursor,
    });
    expect(last.nextCursor).toBeNull();
    expect(
      new Set([first.snapshotId, second.snapshotId, last.snapshotId]).size,
    ).toBe(1);
    const ids = [];
    for (const page of [first, second, last]) {
      expect(JSON.stringify(page)).not.toContain("complete private source");
      const opened = await openNativeHistoryArchivePage({ service, page });
      expect(opened.items[0]).toMatchObject({
        sourceCurrent: true,
        sourceRevision: 1,
        source: {
          body: {
            text: "complete private source",
            unknownField: { preserved: true },
          },
        },
      });
      ids.push(opened.items[0]!.identity.itemId);
    }
    expect(ids.sort()).toEqual(
      batch.items.map((item) => item.identity.itemId).sort(),
    );
    const turnPages = [];
    let cursor = null;
    do {
      const page = await recovered.archiveTurns({
        ...scope(),
        limit: 1,
        cursor,
        snapshotId: first.snapshotId,
      });
      expect(page.snapshotId).toBe(first.snapshotId);
      expect(JSON.stringify(page)).not.toContain("private turn evidence");
      turnPages.push(await openNativeHistoryTurnArchivePage({ service, page }));
      cursor = page.nextCursor;
    } while (cursor);
    expect(
      turnPages.flatMap((page) => page.turns.map((entry) => entry.turn.turnId)),
    ).toEqual(batch.turns.map((turn) => turn.turnId).sort());
    expect(turnPages[0]!.turns[0]).toMatchObject({
      bindingId: binding.id,
      workerId: f.workerId,
      turn: { startedAtMs: 1788000000000, completedAtMs: 1788000002000 },
      source: {
        nativeTurn: {
          durationMs: 1750,
          unknownTurnField: { value: "private turn evidence" },
        },
      },
    });
    expect(
      await f.repository.getChatExecutionContext(f.ownerId, f.chatId),
    ).toEqual(before);
  });

  it("rejects a stale page cursor after another historical worker commits to the same thread", async () => {
    const { batch } = await archived();
    const first = await client.archive({ ...scope(), limit: 1 });
    const otherWorkerId = randomUUID();
    const otherBinding = {
      ...binding,
      id: randomUUID(),
      workerId: otherWorkerId,
    };
    await transaction(async (tx) => {
      const [worker] = await tx
        .select()
        .from(schema.workers)
        .where(eq(schema.workers.id, f.workerId));
      await tx.insert(schema.workers).values({ ...worker!, id: otherWorkerId });
      await tx.insert(schema.nativeHistoryBindings).values({
        ...otherBinding,
        ownerId: f.ownerId,
        createdAt: new Date(otherBinding.createdAt),
      });
    });
    const updated = { ...batch.items[0]!, revision: 2 };
    const opened = await openNativeHistoryArchivePage({
      service,
      page: await client.archive(scope()),
    });
    const source = opened.items.find(
      (item) => item.identity.itemId === updated.identity.itemId,
    )!.source!;
    updated.evidence = await protectNativeHistoryItemEvidence({
      service,
      binding: otherBinding,
      identity: updated.identity,
      revision: 2,
      source,
    });
    await f.repository.nativeHistoryIngestion.ingest(f.ownerId, {
      workerId: otherWorkerId,
      chatId: f.chatId,
      bindingId: otherBinding.id,
      streamId: randomUUID(),
      sequence: 1,
      recordId: randomUUID(),
      previousDigest: null,
      digest: "b".repeat(64),
      batch: { items: [updated], turns: await archiveTurnsFor(otherBinding) },
    });
    const allBatches = await client.archiveBatches(scope());
    expect(allBatches.batches).toHaveLength(2);
    const restored = await openNativeHistoryBatchArchivePage({
      service,
      page: allBatches,
    });
    expect(new Set(restored.batches.map((entry) => entry.workerId))).toEqual(
      new Set([f.workerId, otherWorkerId]),
    );
    expect(
      restored.batches.find((entry) => entry.workerId === otherWorkerId)!
        .source!.items[0]!.source!.body.text,
    ).toBe("complete private source");
    const batchPage = await client.archiveBatches({ ...scope(), limit: 1 });
    const batchNext = await client.archiveBatches({
      ...scope(),
      limit: 1,
      cursor: batchPage.nextCursor,
    });
    expect([...batchPage.batches, ...batchNext.batches]).toEqual(
      allBatches.batches,
    );
    await expect(
      client.archive({ ...scope(), cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "archive-snapshot-changed" });
    await expect(
      client.archiveTurns({ ...scope(), snapshotId: first.snapshotId }),
    ).rejects.toMatchObject({ code: "archive-snapshot-changed" });
    const fresh = await client.archive(scope());
    expect(fresh.snapshotId).not.toBe(first.snapshotId);
    const recovered = await openNativeHistoryArchivePage({
      service,
      page: fresh,
    });
    expect(
      recovered.items.find(
        (item) => item.identity.itemId === updated.identity.itemId,
      ),
    ).toMatchObject({
      revision: 2,
      sourceCurrent: true,
      sourceRevision: 2,
      evidence: { bindingId: otherBinding.id, workerId: otherWorkerId },
      source,
    });
    const turns = await openNativeHistoryTurnArchivePage({
      service,
      page: await client.archiveTurns({
        ...scope(),
        snapshotId: fresh.snapshotId,
      }),
    });
    expect(turns.turns).toHaveLength(6);
    const candidates = turns.turns.filter(
      (entry) => entry.turn.turnId === "http-turn",
    );
    expect(candidates.map((entry) => entry.bindingId).sort()).toEqual(
      [binding.id, otherBinding.id].sort(),
    );
    expect(
      candidates.every(
        (entry) =>
          (entry.source as any).nativeTurn.unknownTurnField.value ===
          "private turn evidence",
      ),
    ).toBe(true);
    const firstTurns = await client.archiveTurns({ ...scope(), limit: 3 });
    const nextTurns = await client.archiveTurns({
      ...scope(),
      limit: 3,
      cursor: firstTurns.nextCursor,
    });
    expect(firstTurns.turns[0]!.bindingId).not.toBe(
      nextTurns.turns[0]!.bindingId,
    );
    expect(nextTurns.nextCursor).toBeNull();
  });

  it("distinguishes missing and stale evidence instead of promoting it to the latest revision", async () => {
    const { batch, outbox } = await archived(1);
    const original = batch.items[0]!;
    const { evidence: _evidence, ...withoutEvidence } = original;
    const missing = (await prepare(2)).items[1]!;
    const body = JSON.stringify({
      items: [{ ...withoutEvidence, revision: 2 }, missing],
      turns: [],
    });
    const record = await outbox.append(randomUUID(), body);
    await outbox.acknowledgeCommitted(
      await client.deliver(scope(), record, body),
    );
    const page = await openNativeHistoryArchivePage({
      service,
      page: await client.archive(scope()),
    });
    expect(
      page.items.find(
        (item) => item.identity.itemId === original.identity.itemId,
      ),
    ).toMatchObject({
      revision: 2,
      sourceRevision: 1,
      sourceCurrent: false,
      source: { body: { text: "complete private source" } },
    });
    expect(
      page.items.find(
        (item) => item.identity.itemId === missing.identity.itemId,
      ),
    ).toMatchObject({
      revision: 1,
      sourceRevision: null,
      sourceCurrent: false,
      source: null,
    });
  });

  it("rejects an evidence source-binding mismatch without acknowledging the batch", async () => {
    const { batch, outbox } = await archived(1);
    const item = batch.items[0]!;
    const body = JSON.stringify({
      items: [
        {
          ...item,
          revision: 2,
          evidence: { ...item.evidence!, revision: 2, bindingId: randomUUID() },
        },
      ],
      turns: [],
    });
    const record = await outbox.append(randomUUID(), body);
    await expect(client.deliver(scope(), record, body)).rejects.toMatchObject({
      code: "item-evidence-binding-mismatch",
    });
    expect(await outbox.pending()).toEqual([record]);
    expect((await client.archive(scope())).items[0]!.revision).toBe(1);
  });

  it("enforces archive authentication and rejects unrelated or reordered page responses", async () => {
    await archived();
    await expect(
      makeClient(undefined, "invalid-token").archive(scope()),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      client.archive({ ...scope(), bindingId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      makeClient(undefined, "invalid-token").archiveTurns(scope()),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      client.archiveTurns({ ...scope(), bindingId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
    for (const mutate of [
      (page: any) => ({
        ...page,
        binding: { ...page.binding, chatId: "other" },
      }),
      (page: any) => ({ ...page, items: [...page.items].reverse() }),
      (page: any) => ({
        ...page,
        nextCursor: { snapshotId: "f".repeat(64), key: page.items.at(-1).key },
      }),
    ]) {
      const corrupted = makeClient(async (input, init) => {
        const response = await fetch(input, init);
        return Response.json(mutate(await response.json()));
      });
      await expect(corrupted.archive(scope())).rejects.toThrow(
        "inconsistent archive page",
      );
    }
    for (const mutate of [
      (page: any) => ({
        ...page,
        binding: { ...page.binding, workerId: "other" },
      }),
      (page: any) => ({ ...page, turns: [...page.turns].reverse() }),
      (page: any) => ({
        ...page,
        nextCursor: {
          snapshotId: page.snapshotId,
          bindingId: "other",
          turnId: "other",
        },
      }),
    ]) {
      const corrupted = makeClient(async (input, init) => {
        const response = await fetch(input, init);
        return Response.json(mutate(await response.json()));
      });
      await expect(corrupted.archiveTurns(scope())).rejects.toThrow(
        "inconsistent turn archive page",
      );
    }
  });
  it("refuses mismatched binding, item and receipt responses and leaves the original batch retryable", async () => {
    const corrupt = (change: (payload: any) => unknown) =>
      makeClient(async (input, init) => {
        const response = await fetch(input, init);
        expect(response.status).toBe(200);
        return Response.json(change(await response.json()));
      });
    await expect(
      corrupt((payload) => ({
        binding: { ...payload.binding, chatId: "unrelated-chat" },
      })).open({
        chatId: f.chatId,
        threadId: binding.threadId,
        provenance: { kind: "current" },
      }),
    ).rejects.toThrow("unrelated binding");
    const resolution = {
      ...scope(),
      items: [
        {
          identity: identity("item-0"),
          association: { kind: "native" as const },
        },
      ],
    };
    await expect(
      corrupt(() => ({ items: [] })).resolve(resolution),
    ).rejects.toThrow("unrelated item mappings");
    await expect(
      corrupt((payload) => ({
        items: payload.items.map((item: any) => ({
          ...item,
          identity: { ...item.identity, component: "user" },
        })),
      })).resolve(resolution),
    ).rejects.toThrow("unrelated item mappings");
    const batch = await prepare();
    const body = JSON.stringify(batch);
    const outbox = await NativeHistoryOutbox.open(outboxInput());
    const record = await outbox.append(randomUUID(), body);
    await expect(
      corrupt((payload) => ({ ...payload, recordId: randomUUID() })).deliver(
        scope(),
        record,
        body,
      ),
    ).rejects.toThrow("unrelated commit receipt");
    expect(await outbox.pending()).toEqual([record]);
    await outbox.acknowledgeCommitted(
      await client.deliver(scope(), record, body),
    );
    expect(await outbox.pending()).toEqual([]);
    await transaction(async (tx) => {
      expect(
        await tx
          .select()
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.chatId, f.chatId)),
      ).toHaveLength(1);
      expect(
        await tx
          .select()
          .from(schema.nativeHistoryReceipts)
          .where(eq(schema.nativeHistoryReceipts.streamId, record.streamId)),
      ).toHaveLength(1);
    });
  });

  it("retains failed writes and recovers a lost committed HTTP response through a reopened outbox", async () => {
    const before = await f.repository.getChatExecutionContext(
      f.ownerId,
      f.chatId,
    );
    const batch = await prepare(2);
    const body = JSON.stringify(batch);
    expect(body).not.toContain("private HTTP answer");
    const outbox = await NativeHistoryOutbox.open(outboxInput());
    const record = await outbox.append(randomUUID(), body);
    await transaction(async (tx) => {
      // The UUID is generated by the fixture's canonical item reservation.
      await tx.execute(
        sql.raw(
          `CREATE FUNCTION reject_http_history_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${batch.items[1]!.message.id}' THEN RAISE EXCEPTION 'fixture history write failure'; END IF; RETURN NEW; END $$`,
        ),
      );
      await tx.execute(
        sql`CREATE TRIGGER reject_http_history_message AFTER INSERT ON chat_messages FOR EACH ROW EXECUTE FUNCTION reject_http_history_message()`,
      );
    });
    try {
      await expect(client.deliver(scope(), record, body)).rejects.toMatchObject(
        { status: 500 },
      );
      expect(await outbox.pending()).toEqual([record]);
      await transaction(async (tx) => {
        expect(
          await tx
            .select()
            .from(schema.chatMessages)
            .where(eq(schema.chatMessages.chatId, f.chatId)),
        ).toEqual([]);
        expect(
          await tx
            .select()
            .from(schema.nativeHistoryStreams)
            .where(eq(schema.nativeHistoryStreams.bindingId, binding.id)),
        ).toEqual([]);
        expect(
          await tx
            .select()
            .from(schema.nativeHistoryPublications)
            .where(eq(schema.nativeHistoryPublications.bindingId, binding.id)),
        ).toEqual([]);
        expect(
          (
            await tx
              .select()
              .from(schema.nativeHistoryItems)
              .where(eq(schema.nativeHistoryItems.chatId, f.chatId))
          ).every((item) => item.revision === 0),
        ).toBe(true);
      });
    } finally {
      await transaction(async (tx) => {
        await tx.execute(
          sql`DROP TRIGGER reject_http_history_message ON chat_messages`,
        );
        await tx.execute(sql`DROP FUNCTION reject_http_history_message()`);
      });
    }
    const requests: string[] = [];
    let originalReceipt: unknown;
    const lossy = makeClient(async (input, init) => {
      requests.push(String(init?.body));
      const response = await fetch(input, init);
      if (requests.length === 1) {
        expect(response.status).toBe(200);
        originalReceipt = await response.json();
        // The real HTTP request has committed. Its caller never gets the ACK.
        throw new TypeError("Fixture lost committed HTTP response");
      }
      return response;
    });
    const reopened = await NativeHistoryOutbox.open(outboxInput());
    const errors = vi.fn();
    const delivery = new NativeHistoryDelivery({
      outbox: reopened,
      deliver: (next, prepared, signal) =>
        lossy.deliver(scope(), next, prepared, signal),
      retryDelayMs: 10,
      maxRetryDelayMs: 30,
      onError: errors,
    });
    pumps.push(delivery);
    delivery.wake();
    await vi.waitFor(async () => expect(await reopened.pending()).toEqual([]), {
      timeout: 10_000,
    });
    delivery.stop();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(errors).toHaveBeenCalledWith(expect.any(TypeError), "deliver");
    expect(await client.deliver(scope(), record, body)).toEqual(
      originalReceipt,
    );
    for (const [index, item] of batch.items.entries()) {
      const saved = await f.repository.getEncryptedMessageByIdempotencyKey(
        f.ownerId,
        f.chatId,
        item.message.idempotencyKey!,
      );
      expect(saved?.protectedContent).toEqual(item.message.protectedContent);
      expect(
        await openEncryptedChatTurn({
          service,
          threadId: binding.threadId,
          history: [],
          prompt: {
            ...item.message,
            protectedContent: saved!.protectedContent,
          },
        }),
      ).toBe(`private HTTP answer ${index}`);
    }
    await transaction(async (tx) => {
      expect(
        await tx
          .select()
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.chatId, f.chatId)),
      ).toHaveLength(2);
      expect(
        await tx
          .select()
          .from(schema.nativeHistoryReceipts)
          .where(eq(schema.nativeHistoryReceipts.streamId, record.streamId)),
      ).toHaveLength(1);
      expect(
        await tx
          .select()
          .from(schema.nativeHistoryPublications)
          .where(eq(schema.nativeHistoryPublications.bindingId, binding.id)),
      ).toHaveLength(1);
    });
    expect(
      await f.repository.getChatExecutionContext(f.ownerId, f.chatId),
    ).toEqual(before);
  });

  it("rejects unauthorized, malformed and cross-binding requests without consuming history", async () => {
    const batch = await prepare();
    const outbox = await NativeHistoryOutbox.open(outboxInput());
    const record = await outbox.append(randomUUID(), JSON.stringify(batch));
    const unauthorized = makeClient(undefined, "invalid-token");
    await expect(
      unauthorized.resolve({ ...scope(), items: [] }),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    await expect(
      unauthorized.deliver(scope(), record, JSON.stringify(batch)),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    await expect(
      client.resolve({
        ...scope(),
        items: [
          {
            identity: {
              ...identity("wrong-thread"),
              threadId: "different-thread",
            },
            association: { kind: "native" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "item-thread-mismatch" });
    await expect(
      client.deliver(
        { ...scope(), bindingId: randomUUID() },
        record,
        JSON.stringify(batch),
      ),
    ).rejects.toMatchObject({ status: 404 });
    for (const action of ["resolve", "ingest"]) {
      const response = await fetch(
        `${serverUrl}/api/internal/native-history/${action}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${f.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            workerId: f.workerId,
            ...scope(),
            plaintext: "must not be accepted",
          }),
        },
      );
      expect(response.status).toBe(400);
    }
    expect(await outbox.pending()).toEqual([record]);
    await transaction(async (tx) => {
      expect(
        await tx
          .select()
          .from(schema.nativeHistoryStreams)
          .where(eq(schema.nativeHistoryStreams.bindingId, binding.id)),
      ).toEqual([]);
      expect(
        await tx
          .select()
          .from(schema.chatMessages)
          .where(eq(schema.chatMessages.chatId, f.chatId)),
      ).toEqual([]);
    });
    // Actual valid work still succeeds after those rejected requests.
    await outbox.acknowledgeCommitted(
      await client.deliver(scope(), record, JSON.stringify(batch)),
    );
    expect(await outbox.pending()).toEqual([]);
  });

  it("rejects a changed payload behind an already committed record instead of returning its receipt", async () => {
    const batch = await prepare();
    const outbox = await NativeHistoryOutbox.open(outboxInput());
    const body = JSON.stringify(batch);
    const record = await outbox.append(randomUUID(), body);
    const receipt = await client.deliver(scope(), record, body);
    await expect(
      client.deliver(
        scope(),
        record,
        JSON.stringify({
          ...batch,
          snapshot: { readBarrierSequence: 2, complete: false },
        }),
      ),
    ).rejects.toMatchObject({ code: "batch-receipt-conflict" });
    expect(await client.deliver(scope(), record, body)).toEqual(receipt);
  });
});
