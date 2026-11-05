import { createHash } from "node:crypto";
import { z } from "zod";
import {
  inferenceJournalIdentitySchema as identitySchema,
  inferenceJournalRecordSchema as recordSchema,
  type InferenceRecoveryIdentity,
  type InferenceJournalRecord,
  type InferenceNativeExecution,
} from "@cantrip/protocol";
export type {
  InferenceRecoveryIdentity,
  InferenceJournalRecord,
} from "@cantrip/protocol";

export function recoveryIdentity(
  value?: InferenceRecoveryIdentity | null,
): string {
  return JSON.stringify([
    value?.commandId ?? null,
    value?.commandGeneration ?? null,
    value?.messageId ?? null,
    value?.threadId ?? null,
    value?.turnId ?? null,
    value?.taskInput
      ? [
          value.taskInput.operationId,
          value.taskInput.chatId,
          value.taskInput.clientMessageId,
          value.taskInput.workerId,
          value.taskInput.worktreeId,
          value.taskInput.executionLaneId,
          value.taskInput.executionLaneActivatedAt,
          value.taskInput.providerId,
          value.taskInput.modelRouteId,
          value.taskInput.providerAccountId,
          value.taskInput.dispatch.cycleId,
          value.taskInput.dispatch.operationId,
          value.taskInput.dispatch.leaseOwner,
          value.taskInput.dispatch.fencingToken,
        ]
      : null,
  ]);
}

const snapshotSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    operations: z.record(z.string(), recordSchema),
  })
  .strict();

export type InferenceJournalMutation =
  | { action: "enqueue"; key: string; identity: z.infer<typeof identitySchema> }
  | {
      action: "adopt";
      key: string;
      identity: z.infer<typeof identitySchema>;
      previous: InferenceRecoveryReference[];
    }
  | { action: "grant" | "requeue"; key: string }
  | { action: "bindNative"; key: string; execution: InferenceNativeExecution }
  | {
      action: "release";
      key: string;
      outcome: NonNullable<InferenceJournalRecord["outcome"]>;
    };
export type InferenceJournalCommand =
  | { action: "snapshot" }
  | { action: "forget"; previous: InferenceRecoveryReference }
  | InferenceJournalMutation
  | { action: "batch"; commands: InferenceJournalMutation[] };

interface InferenceRecoveryReference {
  key: string;
  workerGeneration: string;
  revision: number;
  taskInputNotDispatched?: boolean;
}

/** Serial durable metadata operations travel over the existing lifetime keeper.
 * The keeper's exclusive OS ownership also fences journal writers on takeover. */
export class WorkerInferenceJournal {
  private initialization: Promise<void> | null = null;
  private recovered: InferenceJournalRecord[] = [];
  private readonly writes = new Set<Promise<unknown>>();
  private readonly queuedWrites: Array<{
    command: InferenceJournalMutation;
    bytes: number;
    resolve(record: InferenceJournalRecord): void;
    reject(error: unknown): void;
  }> = [];
  private scheduled = false;

  constructor(
    private readonly workerGeneration: string,
    private readonly request: (
      command: InferenceJournalCommand,
    ) => Promise<unknown>,
  ) {}

  initialize(): Promise<void> {
    this.initialization ??= this.request({ action: "snapshot" }).then(
      (result) => {
        const snapshot = snapshotSchema.parse(result);
        this.recovered = Object.values(snapshot.operations)
          .filter((record) => record.workerGeneration !== this.workerGeneration)
          .sort((a, b) => a.order - b.order);
      },
    );
    return this.initialization;
  }

  recoverySnapshot(): readonly InferenceJournalRecord[] {
    return this.recovered;
  }

  /** Read the actual keeper, including a just-sealed current-generation owner.
   * A cached recovery list or absence of output is not withdrawal evidence. */
  async snapshot(): Promise<readonly InferenceJournalRecord[]> {
    const result = snapshotSchema.parse(
      await this.request({ action: "snapshot" }),
    );
    return Object.values(result.operations);
  }

  key(runtimeGeneration: string, operationId: string): string {
    return createHash("sha256")
      .update(
        JSON.stringify([this.workerGeneration, runtimeGeneration, operationId]),
      )
      .digest("hex");
  }

  enqueue(
    key: string,
    identity: z.infer<typeof identitySchema>,
  ): Promise<InferenceJournalRecord> {
    return this.write({
      action: "enqueue",
      key,
      identity: identitySchema.parse(identity),
    });
  }
  grant(key: string): Promise<InferenceJournalRecord> {
    return this.write({ action: "grant", key });
  }
  requeue(key: string): Promise<InferenceJournalRecord> {
    return this.write({ action: "requeue", key });
  }
  bindNative(
    key: string,
    execution: InferenceNativeExecution,
  ): Promise<InferenceJournalRecord> {
    return this.write({ action: "bindNative", key, execution });
  }
  release(
    key: string,
    outcome: NonNullable<InferenceJournalRecord["outcome"]>,
  ): Promise<InferenceJournalRecord> {
    return this.write({ action: "release", key, outcome });
  }

  async adopt(
    key: string,
    identity: z.infer<typeof identitySchema>,
    previous: readonly InferenceJournalRecord[],
    retainedOrder: number | null = null,
    signal?: AbortSignal,
    taskInputNotDispatched: ReadonlySet<string> = new Set(),
  ): Promise<InferenceJournalRecord> {
    const validatedIdentity = identitySchema.parse(identity);
    // Persist the oldest same-provider ordinal in the first chunk. Every later
    // chunk retains that replacement while acknowledging more physical aliases.
    const ordered = [...previous].sort(
      (a, b) =>
        Number(b.identity.providerId === identity.providerId) -
          Number(a.identity.providerId === identity.providerId) ||
        a.order - b.order,
    );
    const baseBytes = Buffer.byteLength(
      JSON.stringify({
        action: "adopt",
        key,
        identity: validatedIdentity,
        previous: [],
      }),
      "utf8",
    );
    const chunks: InferenceJournalRecord[][] = [];
    let chunk: InferenceJournalRecord[] = [];
    let bytes = baseBytes;
    for (const item of ordered) {
      const itemBytes = Buffer.byteLength(
        JSON.stringify({
          ...this.reference(item),
          ...(taskInputNotDispatched.has(item.key)
            ? { taskInputNotDispatched: true }
            : {}),
        }),
        "utf8",
      );
      if (chunk.length && bytes + itemBytes + 1 > 60_000) {
        chunks.push(chunk);
        chunk = [];
        bytes = baseBytes;
      }
      bytes += itemBytes + Number(chunk.length > 0);
      chunk.push(item);
    }
    if (chunk.length) chunks.push(chunk);
    const sameProvider = previous.filter(
      (item) => item.identity.providerId === identity.providerId,
    );
    const orders = sameProvider.map((item) => item.order);
    if (retainedOrder !== null) orders.push(retainedOrder);
    const expectedOrder = orders.length
      ? orders.reduce((a, b) => Math.min(a, b))
      : null;
    let record: InferenceJournalRecord | undefined;
    for (const chunk of chunks) {
      signal?.throwIfAborted();
      record = await this.write({
        action: "adopt",
        key,
        identity: validatedIdentity,
        previous: chunk.map((item) => ({
          ...this.reference(item),
          ...(taskInputNotDispatched.has(item.key)
            ? { taskInputNotDispatched: true }
            : {}),
        })),
      });
      if (
        record.state !== "waiting" ||
        record.everGranted ||
        (expectedOrder !== null && record.order !== expectedOrder)
      )
        throw new Error(
          "Inference recovery did not retain the expected queue order.",
        );
      const replaced = new Set(chunk.map((item) => item.key));
      this.recovered = this.recovered.filter((item) => !replaced.has(item.key));
    }
    if (!record)
      throw new Error("Inference recovery requires a source record.");
    return record;
  }

  forget(previous: InferenceJournalRecord): Promise<void> {
    const pending = this.request({
      action: "forget",
      previous: this.reference(previous),
    }).then((result) => {
      if (
        !result ||
        typeof result !== "object" ||
        !("key" in result) ||
        result.key !== previous.key ||
        !("forgotten" in result) ||
        result.forgotten !== true
      )
        throw new Error(
          "Inference recovery acknowledgement did not match its record.",
        );
      this.recovered = this.recovered.filter(
        (item) => item.key !== previous.key,
      );
    });
    this.writes.add(pending);
    void pending.finally(() => this.writes.delete(pending)).catch(() => {});
    return pending;
  }

  private reference(
    record: InferenceJournalRecord,
  ): InferenceRecoveryReference {
    return {
      key: record.key,
      workerGeneration: record.workerGeneration,
      revision: record.revision,
    };
  }

  private write(
    command: InferenceJournalMutation,
  ): Promise<InferenceJournalRecord> {
    const pending = new Promise<InferenceJournalRecord>((resolve, reject) => {
      // Bound actual encoded frames, including the private request envelope.
      const bytes = Buffer.byteLength(JSON.stringify(command), "utf8");
      if (bytes > 60_000) {
        reject(
          new Error("Inference admission metadata exceeds its frame limit."),
        );
        return;
      }
      this.queuedWrites.push({ command, bytes, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => this.sendWrites());
      }
    });
    this.writes.add(pending);
    void pending.finally(() => this.writes.delete(pending)).catch(() => {});
    return pending;
  }

  private sendWrites(): void {
    this.scheduled = false;
    while (this.queuedWrites.length) {
      let bytes = 0;
      const batch: typeof this.queuedWrites = [];
      while (this.queuedWrites.length && batch.length < 32) {
        const next = this.queuedWrites[0]!;
        if (batch.length && bytes + next.bytes > 60_000) break;
        batch.push(this.queuedWrites.shift()!);
        bytes += next.bytes + 1;
      }
      // Coalesce a burst into one durable snapshot write. Each operation's
      // result remains independent, and every grant still waits for the fsync.
      void this.request({
        action: "batch",
        commands: batch.map((item) => item.command),
      })
        .then((result) => {
          if (!Array.isArray(result) || result.length !== batch.length)
            throw new Error(
              "Inference journal returned an uncorrelated batch.",
            );
          for (const [index, item] of batch.entries()) {
            try {
              const response = result[index] as {
                ok?: unknown;
                result?: unknown;
              } | null;
              if (response?.ok !== true)
                throw new Error("Inference journal operation failed.");
              const record = recordSchema.parse(response.result);
              if (
                record.key !== item.command.key ||
                record.workerGeneration !== this.workerGeneration
              )
                throw new Error(
                  "Inference journal returned another operation's acknowledgement.",
                );
              if (
                (item.command.action === "grant" &&
                  (record.state !== "granted" || !record.everGranted)) ||
                (item.command.action === "requeue" &&
                  record.state !== "waiting") ||
                (item.command.action === "bindNative" &&
                  (record.state !== "granted" ||
                    !record.everGranted ||
                    JSON.stringify(record.nativeExecution) !==
                      JSON.stringify(item.command.execution))) ||
                (item.command.action === "release" &&
                  record.state !== "released")
              )
                throw new Error(
                  "Inference journal did not acknowledge the requested transition.",
                );
              if (
                item.command.action === "enqueue" ||
                item.command.action === "adopt"
              ) {
                const expected = item.command.identity;
                const actual = record.identity;
                if (
                  actual.operationId !== expected.operationId ||
                  actual.providerId !== expected.providerId ||
                  actual.runtimeGeneration !== expected.runtimeGeneration ||
                  actual.recoveryKey !== expected.recoveryKey ||
                  actual.chatId !== expected.chatId ||
                  actual.projectId !== expected.projectId ||
                  recoveryIdentity(actual.recovery) !==
                    recoveryIdentity(expected.recovery)
                )
                  throw new Error(
                    "Inference journal changed the queued operation identity.",
                  );
              }
              item.resolve(record);
            } catch (error) {
              item.reject(error);
            }
          }
        })
        .catch((error) => {
          for (const item of batch) item.reject(error);
        });
    }
  }

  async flush(): Promise<void> {
    // Actual ticket settlement is independent of status/housekeeping delivery.
    // A failed durable grant never resolves the ticket's ready promise.
    while (this.writes.size) await Promise.allSettled([...this.writes]);
  }
}
