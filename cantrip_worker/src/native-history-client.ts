import {
  nativeHistoryBatchArchiveReadSchema,
  nativeHistoryBatchArchivePageSchema,
  type NativeHistoryBatchArchiveRead,
  nativeHistoryBindingOpenSchema,
  nativeHistoryBindingOpenResultSchema,
  nativeHistoryResolveSchema,
  nativeHistoryResolveResultSchema,
  nativeHistoryPreparedBatchSchema,
  nativeHistoryIngestSchema,
  nativeHistoryCommitReceiptSchema,
  nativeHistoryArchiveReadSchema,
  nativeHistoryArchivePageSchema,
  nativeHistoryTurnArchiveReadSchema,
  nativeHistoryTurnArchivePageSchema,
  type NativeHistoryTurnArchiveRead,
  type NativeHistoryArchiveRead,
  type NativeHistoryBindingOpen,
  type NativeHistoryResolve,
  type NativeHistoryIngest,
} from "@cantrip/protocol";
import { validateNativeHistoryBatchArchivePage } from "./native-history-batch-archive.js";
import { CantripServerRequestError } from "./cli-client.js";
import type { NativeCommandClientOptions } from "./native-command-client.js";
import type { NativeHistoryOutboxRecord } from "./native-history-outbox.js";
import { nativeHistoryRejectionError } from "./native-history-rejection.js";

/** History transport only: no native input, active-turn lease or CUA authority. */
export class NativeHistoryClient {
  constructor(private readonly options: NativeCommandClientOptions) {}

  async archive(
    input: Omit<NativeHistoryArchiveRead, "workerId" | "limit" | "cursor"> &
      Partial<Pick<NativeHistoryArchiveRead, "limit" | "cursor">>,
    signal?: AbortSignal,
  ) {
    const request = nativeHistoryArchiveReadSchema.parse({
      ...input,
      workerId: this.options.workerId,
    });
    const page = await this.post(
      "archive",
      request,
      nativeHistoryArchivePageSchema,
      signal,
    );
    if (
      page.binding.id !== request.bindingId ||
      page.binding.chatId !== request.chatId ||
      page.binding.workerId !== request.workerId ||
      page.items.length > request.limit ||
      (request.snapshotId && page.snapshotId !== request.snapshotId) ||
      (request.cursor && page.snapshotId !== request.cursor.snapshotId) ||
      page.items.some(
        (item, index) =>
          item.identity.threadId !== page.binding.threadId ||
          item.attachments.some(
            (attachment) => attachment.chatId !== request.chatId,
          ) ||
          item.key <= (page.items[index - 1]?.key ?? request.cursor?.key ?? ""),
      ) ||
      (page.nextCursor &&
        (page.nextCursor.snapshotId !== page.snapshotId ||
          page.nextCursor.key !== page.items.at(-1)?.key))
    )
      throw new Error(
        "Native history returned an unrelated or inconsistent archive page.",
      );
    return page;
  }

  async archiveTurns(
    input: Omit<NativeHistoryTurnArchiveRead, "workerId" | "limit" | "cursor"> &
      Partial<Pick<NativeHistoryTurnArchiveRead, "limit" | "cursor">>,
    signal?: AbortSignal,
  ) {
    const request = nativeHistoryTurnArchiveReadSchema.parse({
      ...input,
      workerId: this.options.workerId,
    });
    const page = await this.post(
      "archive-turns",
      request,
      nativeHistoryTurnArchivePageSchema,
      signal,
    );
    const last = page.turns.at(-1);
    if (
      page.binding.id !== request.bindingId ||
      page.binding.chatId !== request.chatId ||
      page.binding.workerId !== request.workerId ||
      page.turns.length > request.limit ||
      (request.snapshotId && page.snapshotId !== request.snapshotId) ||
      (request.cursor && page.snapshotId !== request.cursor.snapshotId) ||
      page.turns.some((entry, index) => {
        const previous = page.turns[index - 1];
        const before = previous
          ? { bindingId: previous.bindingId, turnId: previous.turn.turnId }
          : request.cursor;
        // PostgreSQL C collation compares UTF-8 bytes, not JS UTF-16 code units.
        const bindingOrder = before
          ? Buffer.compare(
              Buffer.from(entry.bindingId),
              Buffer.from(before.bindingId),
            )
          : 1;
        return (
          entry.turn.threadId !== page.binding.threadId ||
          (before &&
            (bindingOrder < 0 ||
              (bindingOrder === 0 &&
                Buffer.compare(
                  Buffer.from(entry.turn.turnId),
                  Buffer.from(before.turnId),
                ) <= 0)))
        );
      }) ||
      (page.nextCursor &&
        (page.nextCursor.snapshotId !== page.snapshotId ||
          page.nextCursor.bindingId !== last?.bindingId ||
          page.nextCursor.turnId !== last?.turn.turnId))
    )
      throw new Error(
        "Native history returned an unrelated or inconsistent turn archive page.",
      );
    return page;
  }

  async archiveBatches(
    input: Omit<
      NativeHistoryBatchArchiveRead,
      "workerId" | "limit" | "cursor"
    > &
      Partial<Pick<NativeHistoryBatchArchiveRead, "limit" | "cursor">>,
    signal?: AbortSignal,
  ) {
    const request = nativeHistoryBatchArchiveReadSchema.parse({
      ...input,
      workerId: this.options.workerId,
    });
    const page = validateNativeHistoryBatchArchivePage(
      await this.post(
        "archive-batches",
        request,
        nativeHistoryBatchArchivePageSchema,
        signal,
      ),
    );
    const last = page.batches.at(-1)?.receipt;
    if (
      page.binding.id !== request.bindingId ||
      page.binding.chatId !== request.chatId ||
      page.binding.workerId !== request.workerId ||
      page.batches.length > request.limit ||
      (request.snapshotId && page.snapshotId !== request.snapshotId) ||
      (request.cursor && page.snapshotId !== request.cursor.snapshotId) ||
      page.batches.some((entry, index) => {
        const previous = page.batches[index - 1]?.receipt ?? request.cursor;
        return (
          (previous && entry.receipt.streamId < previous.streamId) ||
          entry.receipt.sequence !==
            (previous?.streamId === entry.receipt.streamId
              ? previous.sequence + 1
              : 1)
        );
      }) ||
      (page.nextCursor &&
        (page.nextCursor.snapshotId !== page.snapshotId ||
          page.nextCursor.streamId !== last?.streamId ||
          page.nextCursor.sequence !== last?.sequence))
    )
      throw new Error(
        "Native history returned an unrelated or inconsistent batch archive page.",
      );
    return page;
  }

  private async post<T>(
    action: string,
    body: unknown,
    schema: { parse(value: unknown): T },
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(
      new URL(`/api/internal/native-history/${action}`, this.options.serverUrl),
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${this.options.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code =
        payload && typeof payload === "object" && "code" in payload
          ? payload.code
          : null;
      if (
        action === "ingest" &&
        response.status === 409 &&
        payload &&
        typeof payload === "object" &&
        "rejection" in payload
      )
        throw nativeHistoryRejectionError(payload.rejection, body, code);
      // Never echo arbitrary response bodies into logs: only structured codes
      // are useful for recovery and the body may contain protected content.
      throw new CantripServerRequestError(
        `Native history ${action} failed with HTTP ${response.status}.`,
        response.status,
        typeof code === "string" ? code : null,
      );
    }
    return schema.parse(payload);
  }

  async open(
    input: Omit<NativeHistoryBindingOpen, "workerId">,
    signal?: AbortSignal,
  ) {
    const request = nativeHistoryBindingOpenSchema.parse({
      ...input,
      workerId: this.options.workerId,
    });
    const { binding } = await this.post(
      "open",
      request,
      nativeHistoryBindingOpenResultSchema,
      signal,
    );
    if (
      binding.workerId !== request.workerId ||
      binding.chatId !== request.chatId ||
      binding.threadId !== request.threadId ||
      (request.provenance.kind === "binding" &&
        binding.id !== request.provenance.bindingId)
    )
      throw new Error("Native history returned an unrelated binding.");
    return binding;
  }

  async resolve(
    input: Omit<NativeHistoryResolve, "workerId">,
    signal?: AbortSignal,
  ) {
    const request = nativeHistoryResolveSchema.parse({
      ...input,
      workerId: this.options.workerId,
    });
    const { items } = await this.post(
      "resolve",
      request,
      nativeHistoryResolveResultSchema,
      signal,
    );
    if (
      items.length !== request.items.length ||
      items.some((item, index) => {
        const expected = request.items[index]!.identity;
        return (
          item.identity.threadId !== expected.threadId ||
          item.identity.turnId !== expected.turnId ||
          item.identity.itemId !== expected.itemId ||
          item.identity.component !== expected.component ||
          item.identity.identityKind !== expected.identityKind ||
          (item.preservedInput !== null &&
            (item.preservedInput.id !== item.messageId ||
              item.preservedInput.idempotencyKey !== item.idempotencyKey))
        );
      })
    )
      throw new Error("Native history returned unrelated item mappings.");
    return items;
  }

  async ingest(
    input: Omit<NativeHistoryIngest, "workerId">,
    signal?: AbortSignal,
  ) {
    const request = nativeHistoryIngestSchema.parse({
      ...input,
      workerId: this.options.workerId,
    });
    const result = await this.post(
      "ingest",
      request,
      nativeHistoryCommitReceiptSchema,
      signal,
    );
    if (
      result.streamId !== request.streamId ||
      result.sequence !== request.sequence ||
      result.recordId !== request.recordId ||
      result.digest !== request.digest
    )
      throw new Error("Native history returned an unrelated commit receipt.");
    return result;
  }

  /** Opened outbox bodies contain only the already-protected prepared batch.
   * Keep the original identity, digest chain and ciphertext on every retry. */
  deliver(
    scope: { chatId: string; bindingId: string },
    record: NativeHistoryOutboxRecord,
    body: string,
    signal?: AbortSignal,
  ) {
    return this.ingest(
      {
        ...scope,
        streamId: record.streamId,
        sequence: record.sequence,
        recordId: record.recordId,
        digest: record.digest,
        previousDigest: record.previousDigest,
        batch: nativeHistoryPreparedBatchSchema.parse(JSON.parse(body)),
      },
      signal,
    );
  }
}
