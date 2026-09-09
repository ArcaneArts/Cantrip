import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  encryptedPayloadEnvelopeSchema,
  nativeHistoryPreparedBatchSchema,
  nativeHistoryCommitReceiptSchema,
  type NativeHistoryPreparedBatch,
} from "@cantrip/protocol";
import {
  openNativeHistoryProjection,
  protectNativeHistoryProjection,
  type NativeHistoryEncryptionService,
} from "./native-history-content.js";
import {
  flushHistoryDirectory,
  readHistoryJson,
  serializeHistoryOperation,
  writeImmutableHistoryFile,
} from "./native-history-outbox-files.js";
import type { NativeHistorySourceJournal } from "./native-history-source-journal.js";
import type { NativeHistoryOutbox } from "./native-history-outbox.js";
import type { NativeHistoryClient } from "./native-history-client.js";
import { NativeHistoryBatchRejectedError } from "./native-history-rejection.js";
import { nativeHistoryBatchPayloadDigest } from "./native-history-batch-archive.js";
import {
  readNativeHistoryProjectionRebases,
  appendNativeHistoryProjectionRebase,
  type NativeHistoryProjectionRebase,
} from "./native-history-projection-rebase.js";

const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const cursorSchema = z
  .object({ sequence: ordinal, recordId: z.string().uuid().nullable() })
  .strict();
const manifestSchema = z
  .object({
    version: z.literal(1),
    ownerId: z.string(),
    serverId: z.string(),
    workerId: z.string(),
    chatId: z.string(),
    bindingId: z.string(),
    sourceId: z.string().uuid(),
    streamId: z.string().uuid(),
  })
  .strict();
const stageSchema = z
  .object({
    version: z.literal(1),
    sequence: ordinal.positive(),
    recordId: z.string().uuid(),
    previousDigest: digest.nullable(),
    envelope: encryptedPayloadEnvelopeSchema,
    digest,
  })
  .strict();
const payloadSchema = z
  .object({
    from: cursorSchema,
    through: cursorSchema,
    state: z.json(),
    batches: z
      .array(
        z
          .object({
            recordId: z.string().uuid(),
            batch: nativeHistoryPreparedBatchSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const commitSchema = z
  .object({
    sequence: ordinal.positive(),
    digest,
    receipts: z.array(nativeHistoryCommitReceiptSchema).min(1),
    rebaseDigest: digest.optional(),
  })
  .strict();
type Stage = z.infer<typeof stageSchema>;
type Payload = z.infer<typeof payloadSchema>;
type Pending = {
  stage: Stage;
  payload: Payload;
  rebases: NativeHistoryProjectionRebase[];
};
type Cursor = z.infer<typeof cursorSchema>;
type State = z.infer<ReturnType<typeof z.json>>;
type SourcePage = Awaited<ReturnType<NativeHistorySourceJournal["read"]>>;
interface Options {
  directory: string;
  workerId: string;
  chatId: string;
  bindingId: string;
  service: NativeHistoryEncryptionService;
  source: NativeHistorySourceJournal;
  outbox: NativeHistoryOutbox;
  client: Pick<NativeHistoryClient, "deliver">;
  /** Pure source/state reduction plus canonical ID resolution and encryption.
   * May repeat only before a stage is durable. Never dispatch native input here. */
  project(
    records: SourcePage,
    state: State | null,
  ): Promise<{ state: State; batches: NativeHistoryPreparedBatch[] }>;
  /** Rebuild the same source page against current canonical history after a
   * proven permanent rejection, never against a guessed counter or new input. */
  rebase?: Options["project"];
  signal?: AbortSignal;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const name = (sequence: number, kind: "stage" | "commit") =>
  `${String(sequence).padStart(16, "0")}.${kind}.json`;
const emptyCursor: Cursor = { sequence: 0, recordId: null };

/** A local projection transaction freezes next state and wire ciphertext before
 * outbox delivery. Only verified canonical receipts commit its source cursor.
 * Recovery resumes a durable stage instead of resealing or incrementing revisions.
 * Caller supplies the item reducer; this class owns no model/input lifetime. */
export class NativeHistoryProjection {
  private constructor(
    readonly directory: string,
    private readonly manifest: z.infer<typeof manifestSchema>,
    private readonly options: Options,
  ) {}

  static async open(options: Options) {
    const manifest = manifestSchema.parse({
      version: 1,
      ownerId: options.service.ownerId(),
      serverId: options.service.serverIdentity(),
      workerId: options.workerId,
      chatId: options.chatId,
      bindingId: options.bindingId,
      sourceId: options.source.journalId,
      streamId: options.outbox.streamId,
    });
    for (const key of [
      "ownerId",
      "serverId",
      "workerId",
      "chatId",
      "bindingId",
    ] as const) {
      if (
        options.source.scope[key] !== manifest[key] ||
        options.outbox.scope[key] !== manifest[key]
      )
        throw new Error(
          "Native history source and outbox must belong to the projection's exact binding.",
        );
    }
    // Stable path omits source/outbox IDs so a lost/replaced journal fails against
    // the old manifest instead of silently starting an empty projection epoch.
    const requested = path.join(
      options.directory,
      hash([
        manifest.ownerId,
        manifest.serverId,
        manifest.workerId,
        manifest.chatId,
        manifest.bindingId,
      ]),
    );
    await mkdir(requested, { recursive: true, mode: 0o700 });
    const directory = await realpath(requested);
    return serializeHistoryOperation(directory, async () => {
      const files = await readdir(directory);
      if (!files.includes("projection.json")) {
        if (files.some((file) => /\.(stage|commit|rebase)\.json$/u.test(file)))
          throw new Error("Native history projection lost its identity.");
        await writeImmutableHistoryFile(
          path.join(directory, "projection.json"),
          JSON.stringify(manifest),
        );
      }
      const actual = manifestSchema.parse(
        await readHistoryJson(path.join(directory, "projection.json")),
      );
      if (hash(actual) !== hash(manifest))
        throw new Error(
          "Native history projection belongs to different source or outbox journals.",
        );
      const projection = new NativeHistoryProjection(
        directory,
        actual,
        options,
      );
      await projection.inspect();
      await flushHistoryDirectory(directory);
      return projection;
    });
  }

  private context(
    stage: Pick<Stage, "sequence" | "recordId" | "previousDigest">,
  ) {
    return { ...this.manifest, ...stage };
  }
  private async openStage(stage: Stage): Promise<Payload> {
    const { digest: expected, ...unsigned } = stage;
    if (hash(unsigned) !== expected)
      throw new Error("Native history projection stage is corrupt.");
    return payloadSchema.parse(
      JSON.parse(
        await openNativeHistoryProjection({
          service: this.options.service,
          context: this.context(stage),
          envelope: stage.envelope,
        }),
      ),
    );
  }
  private async assertCursor(cursor: Cursor) {
    if (cursor.sequence === 0) {
      if (cursor.recordId !== null)
        throw new Error("Invalid native history projection origin.");
      return;
    }
    const [actual] = await this.options.source.read(cursor.sequence - 1, 1);
    if (
      !actual ||
      actual.sequence !== cursor.sequence ||
      actual.recordId !== cursor.recordId
    )
      throw new Error(
        "Native history projection cursor disagrees with its durable source.",
      );
  }

  private async inspect() {
    if (
      this.options.service.ownerId() !== this.manifest.ownerId ||
      this.options.service.serverIdentity() !== this.manifest.serverId
    )
      throw new Error("Native history projection encryption identity changed.");
    const files = await readdir(this.directory);
    const sequences = (kind: "stage" | "commit") =>
      files
        .filter((file) => file.endsWith(`.${kind}.json`))
        .map((file) => {
          if (!/^\d{16}\.(stage|commit)\.json$/u.test(file))
            throw new Error("Invalid projection record filename.");
          return ordinal.positive().parse(Number(file.slice(0, 16)));
        })
        .sort((a, b) => a - b);
    const stages = sequences("stage"),
      commits = sequences("commit");
    if (
      stages.some((sequence, index) => sequence !== index + 1) ||
      commits.some((sequence, index) => sequence !== index + 1) ||
      commits.length > stages.length ||
      stages.length > commits.length + 1
    )
      throw new Error(
        "Native history projection has missing or unordered transactions.",
      );
    let previous: Stage | null = null;
    let cursor = { ...emptyCursor };
    let state: State | null = null;
    for (const file of files.filter((entry) =>
      entry.endsWith(".rebase.json"),
    )) {
      if (
        !/^\d{16}\.\d{16}\.rebase\.json$/u.test(file) ||
        !stages.includes(Number(file.slice(0, 16)))
      )
        throw new Error(
          "Native history projection has an orphaned rebase plan.",
        );
    }
    let pending: Pending | null = null;
    for (const sequence of stages) {
      const stage = stageSchema.parse(
        await readHistoryJson(
          path.join(this.directory, name(sequence, "stage")),
        ),
      );
      if (
        stage.sequence !== sequence ||
        stage.previousDigest !== (previous?.digest ?? null)
      )
        throw new Error("Native history projection stage chain conflicts.");
      let payload = await this.openStage(stage);
      if (
        hash(payload.from) !== hash(cursor) ||
        payload.through.sequence <= cursor.sequence
      )
        throw new Error(
          "Native history projection skipped or regressed its source cursor.",
        );
      const rebases = await readNativeHistoryProjectionRebases(
        this.rebaseOptions(stage),
      );
      const identities = new Set(
        payload.batches.map((entry) => entry.recordId),
      );
      for (const [index, plan] of rebases.entries()) {
        const proof = plan.payload.rejection;
        const failed = payload.batches[plan.payload.acceptedReceipts.length];
        if (
          !failed ||
          proof.recordId !== failed.recordId ||
          proof.workerId !== this.manifest.workerId ||
          proof.chatId !== this.manifest.chatId ||
          proof.bindingId !== this.manifest.bindingId ||
          proof.streamId !== this.manifest.streamId ||
          nativeHistoryBatchPayloadDigest(
            failed.batch,
            proof.previousDigest,
          ) !== proof.payloadDigest
        )
          throw new Error(
            "Native history rebase rejection does not match its pending stage.",
          );
        for (const [
          offset,
          receipt,
        ] of plan.payload.acceptedReceipts.entries()) {
          const batch = payload.batches[offset]!;
          const actual = await this.options.outbox.committedReceipt(
            batch.recordId,
            JSON.stringify(batch.batch),
          );
          if (!actual || hash(actual) !== hash(receipt))
            throw new Error(
              "Native history rebase lacks its accepted prefix acknowledgment.",
            );
        }
        const replacement = payloadSchema.parse(plan.payload.replacement);
        if (
          hash(replacement.from) !== hash(payload.from) ||
          hash(replacement.through) !== hash(payload.through)
        )
          throw new Error(
            "Native history rebase changed its original source range.",
          );
        for (const batch of replacement.batches) {
          if (identities.has(batch.recordId))
            throw new Error(
              "Native history rebase reused a stage batch identity.",
            );
          identities.add(batch.recordId);
        }
        const successor = await this.options.outbox.replacement(proof.recordId);
        const first = replacement.batches[0]!;
        if (
          successor &&
          (hash(successor.rejection) !== hash(proof) ||
            successor.record.recordId !== first.recordId ||
            (await this.options.outbox.openBody(successor.record)) !==
              JSON.stringify(first.batch))
        )
          throw new Error(
            "Native history rebase does not match its durable outbox replacement.",
          );
        if (
          !successor &&
          index < rebases.length - 1 &&
          !(await this.options.outbox.committedReceipt(
            first.recordId,
            JSON.stringify(first.batch),
          ))
        )
          throw new Error(
            "Native history rebase chain lost its previous outbox replacement.",
          );
        payload = replacement;
      }
      if (sequence <= commits.length) {
        const commit = commitSchema.parse(
          await readHistoryJson(
            path.join(this.directory, name(sequence, "commit")),
          ),
        );
        if (
          commit.sequence !== sequence ||
          commit.digest !== stage.digest ||
          commit.rebaseDigest !== rebases.at(-1)?.header.digest ||
          commit.receipts.length !== payload.batches.length
        )
          throw new Error(
            "Native history projection commit does not match its stage.",
          );
        for (const [index, batch] of payload.batches.entries()) {
          const receipt = await this.options.outbox.committedReceipt(
            batch.recordId,
            JSON.stringify(batch.batch),
          );
          if (!receipt || hash(receipt) !== hash(commit.receipts[index]))
            throw new Error(
              "Native history projection lacks its canonical acknowledgment.",
            );
        }
        cursor = payload.through;
        state = payload.state;
      } else pending = { stage, payload, rebases };
      previous = stage;
    }
    await this.assertCursor(cursor);
    if (pending) await this.assertCursor(pending.payload.through);
    return { cursor, state, previous, pending };
  }

  private rebaseOptions(stage: Stage) {
    return {
      directory: this.directory,
      stage,
      context: this.context(stage),
      service: this.options.service,
      ownerId: this.manifest.ownerId,
      serverId: this.manifest.serverId,
      signal: this.options.signal,
    };
  }

  private async resumeRebase(pending: Pending) {
    const plan = pending.rebases.at(-1);
    if (!plan) return;
    const first = pending.payload.batches[0]!;
    const body = JSON.stringify(first.batch);
    if (await this.options.outbox.committedReceipt(first.recordId, body))
      return;
    await this.options.outbox.replaceRejected(
      plan.payload.rejection,
      first.recordId,
      body,
    );
  }

  private async stageRebase(
    pending: Pending,
    error: NativeHistoryBatchRejectedError,
    receipts: z.infer<typeof nativeHistoryCommitReceiptSchema>[],
  ) {
    const failed = pending.payload.batches[receipts.length];
    if (!failed || failed.recordId !== error.rejection.recordId)
      throw new Error(
        "Native history rejection belongs to another pending stage batch.",
      );
    const records = await this.options.source.read(
      pending.payload.from.sequence,
      pending.payload.through.sequence - pending.payload.from.sequence,
    );
    if (
      records.at(-1)?.recordId !== pending.payload.through.recordId ||
      records.length !==
        pending.payload.through.sequence - pending.payload.from.sequence
    )
      throw new Error(
        "Native history rebase could not recover its complete original source page.",
      );
    this.options.signal?.throwIfAborted();
    const result = await this.options.rebase!(
      structuredClone(records),
      structuredClone(pending.payload.state),
    );
    this.options.signal?.throwIfAborted();
    const replacement = payloadSchema.parse({
      from: pending.payload.from,
      through: pending.payload.through,
      state: result.state,
      batches: (result.batches.length
        ? result.batches
        : [{ items: [], turns: [] }]
      ).map((batch) => ({ recordId: randomUUID(), batch })),
    });
    await appendNativeHistoryProjectionRebase(
      this.rebaseOptions(pending.stage),
      pending.rebases,
      {
        rejection: error.rejection,
        acceptedReceipts: receipts,
        replacement,
      },
    );
  }

  checkpoint() {
    return serializeHistoryOperation(this.directory, async () => {
      const { cursor, state } = await this.inspect();
      await flushHistoryDirectory(this.directory);
      return { cursor, state };
    });
  }

  /** Wake once after recovery and after source persistence. Failures propagate to
   * the owning retry pump; a healthy UI connection is irrelevant to recovery. */
  drain(): Promise<void> {
    return serializeHistoryOperation(this.directory, async () => {
      let current = await this.inspect();
      while (true) {
        this.options.signal?.throwIfAborted();
        let pending = current.pending;
        if (!pending) {
          const records = await this.options.source.read(
            current.cursor.sequence,
          );
          if (!records.length) return;
          const last = records.at(-1)!;
          const result = await this.options.project(
            structuredClone(records),
            structuredClone(current.state),
          );
          this.options.signal?.throwIfAborted();
          const payload = payloadSchema.parse({
            from: current.cursor,
            through: { sequence: last.sequence, recordId: last.recordId },
            state: result.state,
            batches: (result.batches.length
              ? result.batches
              : [{ items: [], turns: [] }]
            ).map((batch) => ({ recordId: randomUUID(), batch })),
          });
          const header = {
            version: 1 as const,
            sequence: (current.previous?.sequence ?? 0) + 1,
            recordId: randomUUID(),
            previousDigest: current.previous?.digest ?? null,
          };
          const unsigned = {
            ...header,
            envelope: await protectNativeHistoryProjection({
              service: this.options.service,
              context: this.context(header),
              body: JSON.stringify(payload),
            }),
          };
          const stage = stageSchema.parse({
            ...unsigned,
            digest: hash(unsigned),
          });
          if (
            !(await writeImmutableHistoryFile(
              path.join(this.directory, name(stage.sequence, "stage")),
              JSON.stringify(stage),
            ))
          )
            throw new Error(
              "Native history projection advanced concurrently; recover its saved stage.",
            );
          pending = { stage, payload, rebases: [] };
        }
        await flushHistoryDirectory(this.directory);
        await this.resumeRebase(pending);
        const receipts = [];
        try {
          for (const batch of pending.payload.batches) {
            this.options.signal?.throwIfAborted();
            const body = JSON.stringify(batch.batch);
            let receipt = await this.options.outbox.committedReceipt(
              batch.recordId,
              body,
            );
            if (!receipt) {
              const record = await this.options.outbox.append(
                batch.recordId,
                body,
              );
              receipt = await this.options.client.deliver(
                {
                  chatId: this.manifest.chatId,
                  bindingId: this.manifest.bindingId,
                },
                record,
                body,
                this.options.signal,
              );
              this.options.signal?.throwIfAborted();
              await this.options.outbox.acknowledgeCommitted(receipt);
            }
            receipts.push(receipt);
          }
        } catch (error) {
          if (
            !(error instanceof NativeHistoryBatchRejectedError) ||
            !this.options.rebase
          )
            throw error;
          await this.stageRebase(pending, error, receipts);
          current = await this.inspect();
          continue;
        }
        this.options.signal?.throwIfAborted();
        const commit = commitSchema.parse({
          sequence: pending.stage.sequence,
          digest: pending.stage.digest,
          ...(pending.rebases.length
            ? { rebaseDigest: pending.rebases.at(-1)!.header.digest }
            : {}),
          receipts,
        });
        const commitPath = path.join(
          this.directory,
          name(commit.sequence, "commit"),
        );
        if (
          !(await writeImmutableHistoryFile(
            commitPath,
            JSON.stringify(commit),
          )) &&
          hash(commitSchema.parse(await readHistoryJson(commitPath))) !==
            hash(commit)
        )
          throw new Error(
            "Native history projection has a conflicting commit.",
          );
        current = {
          cursor: pending.payload.through,
          state: pending.payload.state,
          previous: pending.stage,
          pending: null,
        };
      }
    });
  }
}
