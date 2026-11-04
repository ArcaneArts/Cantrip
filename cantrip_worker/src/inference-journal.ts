import { createHash } from "node:crypto";
import { z } from "zod";

/** Opaque canonical identities only. Never include prompts, titles or credentials. */
export interface InferenceRecoveryIdentity {
  commandId?: string | null;
  commandGeneration?: string | null;
  messageId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
}

export function recoveryIdentity(
  value?: InferenceRecoveryIdentity | null,
): string {
  return JSON.stringify([
    value?.commandId ?? null,
    value?.commandGeneration ?? null,
    value?.messageId ?? null,
    value?.threadId ?? null,
    value?.turnId ?? null,
  ]);
}

const identifier = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => Buffer.from(value, "utf8").toString("utf8") === value,
    "Admission identifiers must be valid Unicode.",
  );
const recoverySchema = z
  .object({
    commandId: identifier.nullable().optional(),
    commandGeneration: identifier.nullable().optional(),
    messageId: identifier.nullable().optional(),
    threadId: identifier.nullable().optional(),
    turnId: identifier.nullable().optional(),
  })
  .strict();
const identitySchema = z
  .object({
    operationId: identifier,
    providerId: identifier,
    runtimeGeneration: z.uuid(),
    recoveryKey: identifier.nullable(),
    recovery: recoverySchema.nullable(),
    chatId: identifier.nullable(),
    projectId: identifier.nullable(),
  })
  .strict();
const recordSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/u),
    identity: identitySchema,
    workerGeneration: z.uuid(),
    state: z.enum(["waiting", "granted", "released"]),
    order: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    everGranted: z.boolean(),
    outcome: z
      .enum([
        "completed",
        "failed",
        "interrupted",
        "runtime-exited",
        "never-started",
        "cancelled",
      ])
      .nullable(),
  })
  .strict();
const snapshotSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    operations: z.record(z.string(), recordSchema),
  })
  .strict();

export type InferenceJournalRecord = z.infer<typeof recordSchema>;
export type InferenceJournalMutation =
  | { action: "enqueue"; key: string; identity: z.infer<typeof identitySchema> }
  | { action: "grant" | "requeue"; key: string }
  | {
      action: "release";
      key: string;
      outcome: NonNullable<InferenceJournalRecord["outcome"]>;
    };
export type InferenceJournalCommand =
  | { action: "snapshot" }
  | InferenceJournalMutation
  | { action: "batch"; commands: InferenceJournalMutation[] };

/** Serial durable metadata operations travel over the existing lifetime keeper.
 * The keeper's exclusive OS ownership also fences journal writers on takeover. */
export class WorkerInferenceJournal {
  private initialization: Promise<void> | null = null;
  private recovered: InferenceJournalRecord[] = [];
  private readonly writes = new Set<Promise<unknown>>();
  private readonly queuedWrites: Array<{
    command: InferenceJournalMutation;
    bytes: number;
    resolve(): void;
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

  key(runtimeGeneration: string, operationId: string): string {
    return createHash("sha256")
      .update(
        JSON.stringify([this.workerGeneration, runtimeGeneration, operationId]),
      )
      .digest("hex");
  }

  async enqueue(
    key: string,
    identity: z.infer<typeof identitySchema>,
  ): Promise<void> {
    await this.write({
      action: "enqueue",
      key,
      identity: identitySchema.parse(identity),
    });
  }
  grant(key: string): Promise<void> {
    return this.write({ action: "grant", key });
  }
  requeue(key: string): Promise<void> {
    return this.write({ action: "requeue", key });
  }
  release(
    key: string,
    outcome: NonNullable<InferenceJournalRecord["outcome"]>,
  ): Promise<void> {
    return this.write({ action: "release", key, outcome });
  }

  private write(command: InferenceJournalMutation): Promise<void> {
    const pending = new Promise<void>((resolve, reject) => {
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
                (item.command.action === "release" &&
                  record.state !== "released")
              )
                throw new Error(
                  "Inference journal did not acknowledge the requested transition.",
                );
              if (item.command.action === "enqueue") {
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
              item.resolve();
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
    await Promise.allSettled([...this.writes]);
  }
}
