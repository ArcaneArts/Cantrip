import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  nativeHistoryCommitReceiptSchema as receiptSchema,
  nativeHistoryBatchRejectionSchema,
  type NativeHistoryCommitReceipt,
  type NativeHistoryBatchRejection,
} from "@cantrip/protocol";
import { encryptedPayloadEnvelopeSchema } from "@cantrip/protocol/encryption";
import {
  openNativeHistoryOutboxBaseline,
  protectNativeHistoryOutboxBaseline,
  openNativeHistoryBatch,
  protectNativeHistoryBatch,
  type NativeHistoryEncryptionService,
} from "./native-history-content.js";
import {
  flushHistoryDirectory,
  readHistoryJson,
  serializeHistoryOperation,
  writeImmutableHistoryFile,
} from "./native-history-outbox-files.js";

import {
  prepareNativeHistoryOutboxBaseline,
  validateNativeHistoryOutboxBaseline,
  verifyNativeHistoryRecoveredBody,
  type NativeHistoryOutboxBaseline,
  type NativeHistoryOutboxRecovery,
} from "./native-history-outbox-baseline.js";

import {
  nativeHistoryOutboxRecordSchema as recordSchema,
  historySequenceSchema as sequenceSchema,
  nativeHistoryJournalHash as hash,
  type NativeHistoryOutboxRecord,
} from "./native-history-outbox-record.js";
import {
  readNativeHistoryOutboxMutations,
  appendNativeHistoryOutboxMutation,
  type NativeHistoryOutboxMutation,
} from "./native-history-outbox-mutations.js";
import { verifyNativeHistoryRejection } from "./native-history-rejection.js";
export type { NativeHistoryOutboxRecord } from "./native-history-outbox-record.js";

const scopeSchema = z
  .object({
    serverId: z.string().min(1),
    ownerId: z.string().min(1),
    workerId: z.string().min(1),
    chatId: z.string().min(1),
    bindingId: z.string().min(1),
  })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    scope: scopeSchema,
    streamId: z.string().uuid(),
    baseline: encryptedPayloadEnvelopeSchema.optional(),
  })
  .strict();
export type { NativeHistoryCommitReceipt } from "@cantrip/protocol";
type Manifest = z.infer<typeof manifestSchema>;

const filename = (sequence: number, kind: "batch" | "ack") =>
  `${String(sequence).padStart(16, "0")}.${kind}.json`;
const sequenceFromFilename = (name: string, kind: "batch" | "ack") => {
  if (!name.endsWith(`.${kind}.json`)) return null;
  if (!/^\d{16}\.(batch|ack)\.json$/u.test(name))
    throw new Error("Native history journal has an invalid record filename.");
  return sequenceSchema.parse(Number(name.slice(0, 16)));
};

/**
 * Worker-local durable delivery, not execution or observation authority.
 * Call append before sending a prepared batch; acknowledge only its canonical
 * server commit. A timeout never consumes a record. Runtime incarnations are
 * deliberately absent from this stream's identity.
 *
 * The immutable ledger retains committed batches/receipts for recovery. It is
 * not yet a pruning policy or the live-event projector. Production integration
 * must supply server-owned bindings, opaque prepared wire bodies, and the
 * authenticated commit receipt; this class cannot establish those facts.
 */
export class NativeHistoryOutbox {
  private constructor(
    readonly directory: string,
    private readonly manifest: Manifest,
    private readonly service: NativeHistoryEncryptionService,
    private readonly baseline: NativeHistoryOutboxBaseline,
  ) {}

  static async open(input: {
    directory: string;
    workerId: string;
    chatId: string;
    bindingId: string;
    service: NativeHistoryEncryptionService;
    /** Used only when the local stream identity and record files are absent. */
    recover?(): Promise<NativeHistoryOutboxRecovery>;
  }): Promise<NativeHistoryOutbox> {
    const scope = scopeSchema.parse({
      serverId: input.service.serverIdentity(),
      ownerId: input.service.ownerId(),
      workerId: input.workerId,
      chatId: input.chatId,
      bindingId: input.bindingId,
    });
    const assertIdentity = () => {
      if (
        input.service.ownerId() !== scope.ownerId ||
        input.service.serverIdentity() !== scope.serverId
      )
        throw new Error(
          "Native history encryption identity changed during recovery.",
        );
    };
    const requested = path.join(input.directory, hash(scope));
    await mkdir(requested, { recursive: true, mode: 0o700 });
    const directory = await realpath(requested);
    return serializeHistoryOperation(directory, async () => {
      const files = await readdir(directory);
      if (!files.includes("stream.json")) {
        if (files.some((name) => /\.(batch|ack|mutation)\.json$/u.test(name)))
          throw new Error(
            "Native history journal is missing its stream identity.",
          );
        const recovered = input.recover
          ? prepareNativeHistoryOutboxBaseline(await input.recover(), scope)
          : null;
        assertIdentity();
        const streamId = recovered?.streamId ?? randomUUID();
        const baseline = recovered
          ? await protectNativeHistoryOutboxBaseline({
              service: input.service,
              context: {
                ...scope,
                streamId,
                sequence: 0,
                recordId: streamId,
                previousDigest: null,
              },
              body: JSON.stringify(recovered.entries),
            })
          : undefined;
        assertIdentity();
        await writeImmutableHistoryFile(
          path.join(directory, "stream.json"),
          JSON.stringify({
            version: 1,
            scope,
            streamId,
            ...(baseline ? { baseline } : {}),
          }),
        );
      }
      const manifest = manifestSchema.parse(
        await readHistoryJson(path.join(directory, "stream.json")),
      );
      if (hash(manifest.scope) !== hash(scope))
        throw new Error("Native history journal belongs to a different scope.");
      const baseline = manifest.baseline
        ? validateNativeHistoryOutboxBaseline(
            JSON.parse(
              await openNativeHistoryOutboxBaseline({
                service: input.service,
                context: {
                  ...scope,
                  streamId: manifest.streamId,
                  sequence: 0,
                  recordId: manifest.streamId,
                  previousDigest: null,
                },
                envelope: manifest.baseline,
              }),
            ),
            manifest.streamId,
          )
        : [];
      assertIdentity();
      const outbox = new NativeHistoryOutbox(
        directory,
        manifest,
        input.service,
        baseline,
      );
      await outbox.readLedger();
      await flushHistoryDirectory(directory);
      return outbox;
    });
  }

  get streamId(): string {
    return this.manifest.streamId;
  }
  get scope() {
    return { ...this.manifest.scope };
  }

  private assertScope(): void {
    if (
      this.service.ownerId() !== this.manifest.scope.ownerId ||
      this.service.serverIdentity() !== this.manifest.scope.serverId
    )
      throw new Error("Native history encryption identity changed.");
  }

  private context(
    record: Omit<NativeHistoryOutboxRecord, "version" | "envelope" | "digest">,
  ) {
    return { ...this.manifest.scope, ...record };
  }

  /** Retry with the SAME recordId and exact body after an uncertain disk result. */
  append(recordId: string, body: string): Promise<NativeHistoryOutboxRecord> {
    return serializeHistoryOperation(this.directory, async () => {
      this.assertScope();
      z.string().uuid().parse(recordId);
      const ledger = await this.readLedger();
      const { records, identities } = ledger;
      if (this.baseline.some((entry) => entry.receipt.recordId === recordId))
        throw new Error(
          "Native history record was restored as committed; retrieve its verified receipt instead of appending it.",
        );
      const existing = records.find((record) => record.recordId === recordId);
      if (existing) {
        if ((await this.openBody(existing)) !== body)
          throw new Error(
            "Native history record identity was reused with different content.",
          );
        await flushHistoryDirectory(this.directory);
        return existing;
      }
      if (identities.has(recordId))
        throw new Error(
          "Native history record was superseded; recover its replacement instead of appending it.",
        );
      const previous = records.at(-1) ?? this.baseline.at(-1)?.receipt;
      const header = {
        version: 1 as const,
        streamId: this.streamId,
        sequence: sequenceSchema.parse((previous?.sequence ?? 0) + 1),
        recordId,
        previousDigest: previous?.digest ?? null,
      };
      const unsigned = {
        ...header,
        envelope: await protectNativeHistoryBatch({
          service: this.service,
          context: this.context(header),
          body,
        }),
      };
      const record = recordSchema.parse({
        ...unsigned,
        digest: hash(unsigned),
      });
      await appendNativeHistoryOutboxMutation(
        this.mutationOptions(ledger),
        ledger.mutations,
        { kind: "append", record },
      );
      this.assertScope();
      return record;
    });
  }

  private mutationOptions(legacy: {
    legacyCount: number;
    legacyDigest: string | null;
  }) {
    return {
      ...legacy,
      directory: this.directory,
      streamId: this.streamId,
      scope: this.scope,
      service: this.service,
    };
  }

  private async verifyRejection(
    rejection: NativeHistoryBatchRejection,
    record: NativeHistoryOutboxRecord,
  ) {
    return verifyNativeHistoryRejection(
      rejection,
      {
        workerId: this.scope.workerId,
        chatId: this.scope.chatId,
        bindingId: this.scope.bindingId,
        streamId: record.streamId,
        sequence: record.sequence,
        recordId: record.recordId,
        digest: record.digest,
        previousDigest: record.previousDigest,
        batch: JSON.parse(await this.openBody(record)),
      },
      rejection.code,
    );
  }

  /** Use only a matched authenticated permanent rejection. The old records remain
   * encrypted in the ledger; committed records cannot be replaced. A dependent
   * uncommitted tail is re-chained with unchanged bodies and fresh identities. */
  replaceRejected(
    rejection: NativeHistoryBatchRejection,
    recordId: string,
    body: string,
  ): Promise<NativeHistoryOutboxRecord[]> {
    return serializeHistoryOperation(this.directory, async () => {
      this.assertScope();
      rejection = nativeHistoryBatchRejectionSchema.parse(rejection);
      z.string().uuid().parse(recordId);
      const ledger = await this.readLedger();
      const prior = ledger.mutations.find(
        ({ payload }) =>
          payload.kind === "replace" &&
          payload.rejection.rejectionId === rejection.rejectionId,
      );
      if (prior?.payload.kind === "replace") {
        if (
          hash(prior.payload.rejection) !== hash(rejection) ||
          prior.payload.records[0]!.recordId !== recordId ||
          (await this.openBody(prior.payload.records[0]!)) !== body
        )
          throw new Error(
            "Native history replacement identity was reused with different content.",
          );
        await flushHistoryDirectory(this.directory);
        return structuredClone(prior.payload.records);
      }
      const original = ledger.records[ledger.receipts.length];
      if (!original)
        throw new Error(
          "Native history replacement has no uncommitted record.",
        );
      await this.verifyRejection(rejection, original);
      if (ledger.identities.has(recordId))
        throw new Error(
          "Native history replacement must use a new record identity.",
        );
      const records: NativeHistoryOutboxRecord[] = [];
      for (const [index, old] of ledger.records
        .slice(ledger.receipts.length)
        .entries()) {
        const header = {
          version: 1 as const,
          streamId: this.streamId,
          sequence: old.sequence,
          recordId: index === 0 ? recordId : randomUUID(),
          previousDigest: records.at(-1)?.digest ?? original.previousDigest,
        };
        const unsigned = {
          ...header,
          envelope: await protectNativeHistoryBatch({
            service: this.service,
            context: this.context(header),
            body: index === 0 ? body : await this.openBody(old),
          }),
        };
        records.push(
          recordSchema.parse({ ...unsigned, digest: hash(unsigned) }),
        );
      }
      this.assertScope();
      await appendNativeHistoryOutboxMutation(
        this.mutationOptions(ledger),
        ledger.mutations,
        { kind: "replace", rejection, records },
      );
      this.assertScope();
      return records;
    });
  }

  replacement(recordId: string) {
    return serializeHistoryOperation(this.directory, async () => {
      this.assertScope();
      const result = (await this.readLedger()).superseded.get(recordId) ?? null;
      await flushHistoryDirectory(this.directory);
      return structuredClone(result);
    });
  }

  pending(): Promise<NativeHistoryOutboxRecord[]> {
    return serializeHistoryOperation(this.directory, async () => {
      this.assertScope();
      const { records, receipts } = await this.readLedger();
      // A prior append can fail after link publication but before directory
      // flush. Reestablish durability before exposing that batch for sending.
      await flushHistoryDirectory(this.directory);
      return records.slice(receipts.length);
    });
  }

  /** Actual durable receipt, not absence from pending() or a send attempt. */
  committedReceipt(
    recordId: string,
    expectedBody?: string,
  ): Promise<NativeHistoryCommitReceipt | null> {
    return serializeHistoryOperation(this.directory, async () => {
      this.assertScope();
      const { records, receipts } = await this.readLedger();
      const restored = this.baseline.find(
        (entry) => entry.receipt.recordId === recordId,
      );
      if (restored) {
        if (expectedBody !== undefined)
          verifyNativeHistoryRecoveredBody(restored, expectedBody);
        await flushHistoryDirectory(this.directory);
        return structuredClone(restored.receipt);
      }
      const index = records.findIndex((record) => record.recordId === recordId);
      const receipt = index < 0 ? null : (receipts[index] ?? null);
      if (receipt) {
        if (
          expectedBody !== undefined &&
          (await this.openBody(records[index]!)) !== expectedBody
        )
          throw new Error(
            "Native history committed receipt belongs to different batch content.",
          );
        await flushHistoryDirectory(this.directory);
      }
      return receipt;
    });
  }

  async openBody(record: NativeHistoryOutboxRecord): Promise<string> {
    this.assertScope();
    const parsed = recordSchema.parse(record);
    const { digest, ...unsigned } = parsed;
    if (parsed.streamId !== this.streamId || hash(unsigned) !== digest)
      throw new Error(
        "Native history record does not match its stream or digest.",
      );
    return openNativeHistoryBatch({
      service: this.service,
      context: this.context(parsed),
      envelope: parsed.envelope,
    });
  }

  acknowledgeCommitted(input: NativeHistoryCommitReceipt): Promise<void> {
    return serializeHistoryOperation(this.directory, async () => {
      this.assertScope();
      const receipt = receiptSchema.parse(input);
      const { records, receipts } = await this.readLedger();
      const restored = this.baseline[receipt.sequence - 1];
      if (restored) {
        if (hash(restored.receipt) !== hash(receipt))
          throw new Error("Native history recovered commit receipt changed.");
        await flushHistoryDirectory(this.directory);
        return;
      }
      const index = receipt.sequence - this.baseline.length - 1;
      this.correlate(receipt, records[index]);
      const existing = receipts[index];
      if (existing) {
        if (hash(existing) !== hash(receipt))
          throw new Error(
            "Native history commit receipt changed for an acknowledged batch.",
          );
        await flushHistoryDirectory(this.directory);
        return;
      }
      if (receipt.sequence !== this.baseline.length + receipts.length + 1)
        throw new Error(
          "Native history acknowledgment would skip an uncommitted batch.",
        );
      if (
        !(await writeImmutableHistoryFile(
          path.join(this.directory, filename(receipt.sequence, "ack")),
          JSON.stringify(receipt),
        ))
      ) {
        const stored = receiptSchema.parse(
          await readHistoryJson(
            path.join(this.directory, filename(receipt.sequence, "ack")),
          ),
        );
        if (hash(stored) !== hash(receipt))
          throw new Error(
            "Native history acknowledgment conflicted with another writer.",
          );
      }
    });
  }

  private correlate(
    receipt: NativeHistoryCommitReceipt,
    record?: NativeHistoryOutboxRecord,
  ): void {
    if (
      !record ||
      receipt.streamId !== this.streamId ||
      receipt.recordId !== record.recordId ||
      receipt.digest !== record.digest ||
      receipt.sequence !== record.sequence
    )
      throw new Error(
        "Native history acknowledgment does not match the durable batch.",
      );
  }

  private async readLedger(): Promise<{
    records: NativeHistoryOutboxRecord[];
    receipts: NativeHistoryCommitReceipt[];
    mutations: NativeHistoryOutboxMutation[];
    legacyCount: number;
    legacyDigest: string | null;
    identities: Set<string>;
    superseded: Map<
      string,
      {
        record: NativeHistoryOutboxRecord;
        rejection: NativeHistoryBatchRejection;
      }
    >;
  }> {
    const files = await readdir(this.directory);
    const sequences = (kind: "batch" | "ack") =>
      files
        .flatMap((name) => {
          const sequence = sequenceFromFilename(name, kind);
          return sequence === null ? [] : [sequence];
        })
        .sort((a, b) => a - b);
    const records: NativeHistoryOutboxRecord[] = [];
    for (const sequence of sequences("batch")) {
      const record = recordSchema.parse(
        await readHistoryJson(
          path.join(this.directory, filename(sequence, "batch")),
        ),
      );
      const { digest, ...unsigned } = record;
      if (
        sequence !== this.baseline.length + records.length + 1 ||
        record.sequence !== sequence ||
        record.streamId !== this.streamId ||
        hash(unsigned) !== digest ||
        record.previousDigest !==
          (records.at(-1)?.digest ??
            this.baseline.at(-1)?.receipt.digest ??
            null)
      )
        throw new Error(
          "Native history journal has a missing or conflicting batch.",
        );
      records.push(record);
    }
    if (
      new Set([
        ...this.baseline.map((entry) => entry.receipt.recordId),
        ...records.map((record) => record.recordId),
      ]).size !==
      this.baseline.length + records.length
    )
      throw new Error("Native history journal repeats a record identity.");
    const legacyCount = records.length;
    const legacyDigest =
      records.at(-1)?.digest ?? this.baseline.at(-1)?.receipt.digest ?? null;
    const identities = new Set([
      ...this.baseline.map((entry) => entry.receipt.recordId),
      ...records.map((entry) => entry.recordId),
    ]);
    const superseded = new Map<
      string,
      {
        record: NativeHistoryOutboxRecord;
        rejection: NativeHistoryBatchRejection;
      }
    >();
    const mutations = await readNativeHistoryOutboxMutations(
      this.mutationOptions({ legacyCount, legacyDigest }),
    );
    const validateRecord = (
      record: NativeHistoryOutboxRecord,
      sequence: number,
      previousDigest: string | null,
    ) => {
      const { digest, ...unsigned } = record;
      if (
        record.streamId !== this.streamId ||
        record.sequence !== sequence ||
        record.previousDigest !== previousDigest ||
        hash(unsigned) !== digest ||
        identities.has(record.recordId)
      )
        throw new Error(
          "Native history mutation repeats an identity or conflicts with the active batch chain.",
        );
      identities.add(record.recordId);
    };
    for (const { payload } of mutations) {
      if (payload.kind === "append") {
        validateRecord(
          payload.record,
          this.baseline.length + records.length + 1,
          records.at(-1)?.digest ??
            this.baseline.at(-1)?.receipt.digest ??
            null,
        );
        records.push(payload.record);
        continue;
      }
      const offset = payload.rejection.sequence - this.baseline.length - 1;
      const original = records[offset];
      if (!original || payload.records.length !== records.length - offset)
        throw new Error(
          "Native history replacement does not cover its original pending tail.",
        );
      await this.verifyRejection(payload.rejection, original);
      let previousDigest = original.previousDigest;
      for (const [index, record] of payload.records.entries()) {
        validateRecord(record, original.sequence + index, previousDigest);
        const replaced = records[offset + index]!;
        if (
          index > 0 &&
          (await this.openBody(record)) !== (await this.openBody(replaced))
        )
          throw new Error(
            "Native history replacement changed a dependent pending batch.",
          );
        superseded.set(replaced.recordId, {
          record,
          rejection: payload.rejection,
        });
        previousDigest = record.digest;
      }
      records.splice(offset, payload.records.length, ...payload.records);
    }
    const receipts: NativeHistoryCommitReceipt[] = [];
    for (const sequence of sequences("ack")) {
      const receipt = receiptSchema.parse(
        await readHistoryJson(
          path.join(this.directory, filename(sequence, "ack")),
        ),
      );
      if (
        sequence !== this.baseline.length + receipts.length + 1 ||
        receipt.sequence !== sequence
      )
        throw new Error("Native history journal has a missing acknowledgment.");
      this.correlate(receipt, records[sequence - this.baseline.length - 1]);
      receipts.push(receipt);
    }
    return {
      records,
      receipts,
      mutations,
      legacyCount,
      legacyDigest,
      identities,
      superseded,
    };
  }
}
