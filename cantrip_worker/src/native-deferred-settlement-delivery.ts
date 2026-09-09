import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  nativeCommandSettlementSchema,
  nativeCommandSettlementResultSchema,
  type NativeCommandSettlement,
} from "@cantrip/protocol";
import type { NativeCommandClient } from "./native-command-client.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import {
  ensureHistoryDirectory,
  flushHistoryDirectory,
  readHistoryJson,
  serializeHistoryOperation,
  writeImmutableHistoryFile,
} from "./native-history-outbox-files.js";

type Input = Omit<NativeCommandSettlement, "workerId">;
type Result = Awaited<ReturnType<NativeCommandClient["settle"]>>;
const scopeSchema = z
  .object({
    serverId: z.string().min(1),
    ownerId: z.string().min(1),
    workerId: z.string().min(1),
  })
  .strict();
const recordSchema = z
  .object({ scope: scopeSchema, settlement: nativeCommandSettlementSchema })
  .strict();
const acknowledgementSchema = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    result: nativeCommandSettlementResultSchema,
  })
  .strict();
type Record = z.infer<typeof recordSchema>;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Delivers captured no-consumption facts. It never admits or replays native input. */
export class NativeDeferredSettlementDelivery {
  private readonly abort = new AbortController();
  private readonly writes = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private dirty = false;
  private failures = 0;

  constructor(
    private readonly options: {
      directory: string;
      workerId: string;
      service: Pick<WorkerEncryptionService, "ownerId" | "serverIdentity">;
      client: Pick<NativeCommandClient, "settle">;
      onPublished(result: Result): Promise<void> | void;
      onError(error: unknown): void;
      retryDelayMs?: number;
    },
  ) {}

  private scope() {
    return scopeSchema.parse({
      serverId: this.options.service.serverIdentity(),
      ownerId: this.options.service.ownerId(),
      workerId: this.options.workerId,
    });
  }

  private assertCurrent(record: Record) {
    if (
      this.abort.signal.aborted ||
      digest(this.scope()) !== digest(record.scope)
    )
      throw new Error(
        "Deferred settlement delivery ownership changed or stopped.",
      );
  }

  private directory(scope = this.scope()) {
    return path.join(
      this.options.directory,
      "native-deferred-settlements",
      digest(scope),
    );
  }

  private filename(record: Record) {
    return path.join(
      this.directory(record.scope),
      digest([
        record.settlement.operationId,
        record.settlement.operationGeneration,
      ]),
    );
  }

  private validate(record: Record) {
    const body = record.settlement;
    if (
      body.workerId !== record.scope.workerId ||
      !body.deferred ||
      body.status !== "rejected" ||
      !body.executionComplete ||
      !body.protectedResult ||
      !body.resultDigest ||
      body.decline ||
      body.reconciliation ||
      body.terminalResult
    )
      throw new Error(
        "Only protected completed no-consumption settlements can be retained.",
      );
    this.assertCurrent(record);
  }

  private correlate(result: Result, record: Record) {
    if (
      result.receipt.operationId !== record.settlement.operationId ||
      result.receipt.operationGeneration !==
        record.settlement.operationGeneration ||
      result.receipt.status !== "rejected" ||
      result.receipt.rejectionCode !== "native-settings-pending" ||
      result.receipt.method !== "turn/start" ||
      result.receipt.threadId !== record.settlement.deferred?.threadId
    )
      throw new Error("Deferred settlement acknowledgment identity mismatch.");
  }

  private async acknowledged(
    filename: string,
    record: Record,
  ): Promise<Result | null> {
    try {
      const ack = acknowledgementSchema.parse(
        await readHistoryJson(`${filename}.ack.json`),
      );
      if (ack.digest !== digest(record))
        throw new Error(
          "Deferred settlement identity was reused with different content.",
        );
      this.correlate(ack.result, record);
      return ack.result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  settle(input: Input): Promise<Result> {
    const record = recordSchema.parse({
      scope: this.scope(),
      settlement: { ...input, workerId: this.options.workerId },
    });
    this.validate(record);
    const filename = this.filename(record);
    const write = serializeHistoryOperation(filename, async () => {
      this.assertCurrent(record);
      const previous = await this.acknowledged(filename, record);
      if (previous) return previous;
      await ensureHistoryDirectory(this.directory(record.scope));
      this.assertCurrent(record);
      if (
        !(await writeImmutableHistoryFile(
          `${filename}.pending.json`,
          JSON.stringify(record),
        )) &&
        digest(
          recordSchema.parse(await readHistoryJson(`${filename}.pending.json`)),
        ) !== digest(record)
      )
        throw new Error(
          "Deferred settlement identity was reused with different content.",
        );
      return this.deliver(filename, record);
    });
    this.writes.add(write);
    void write.then(
      () => this.writes.delete(write),
      () => {
        this.writes.delete(write);
        this.wake();
      },
    );
    return write;
  }

  private async deliver(filename: string, record: Record): Promise<Result> {
    this.validate(record);
    const existing = await this.acknowledged(filename, record);
    if (existing) {
      await rm(`${filename}.pending.json`, { force: true });
      await flushHistoryDirectory(this.directory(record.scope));
      return existing;
    }
    const signal = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(15_000),
    ]);
    // Bound even a client implementation that does not observe its AbortSignal.
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () =>
        reject(
          new Error(
            "Deferred settlement delivery was interrupted before acknowledgment.",
          ),
        );
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    });
    let result: Result;
    try {
      result = nativeCommandSettlementResultSchema.parse(
        await Promise.race([
          this.options.client.settle(record.settlement, signal),
          aborted,
        ]),
      );
    } finally {
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
    this.assertCurrent(record);
    this.correlate(result, record);
    await this.options.onPublished(result);
    this.assertCurrent(record);
    const ack = { digest: digest(record), result };
    if (
      !(await writeImmutableHistoryFile(
        `${filename}.ack.json`,
        JSON.stringify(ack),
      ))
    ) {
      const previous = await this.acknowledged(filename, record);
      if (!previous)
        throw new Error("Deferred settlement acknowledgment was not retained.");
    }
    await rm(`${filename}.pending.json`, { force: true });
    await flushHistoryDirectory(this.directory(record.scope));
    return result;
  }

  wake(): void {
    if (this.abort.signal.aborted) return;
    this.dirty = true;
    this.schedule(0);
  }

  private schedule(delay: number) {
    if (this.abort.signal.aborted || this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dirty = false;
      let retry = false;
      this.running = this.drain()
        .then((value) => {
          retry = value;
        })
        .catch((error) => {
          retry = true;
          this.report(error);
        })
        .finally(() => {
          this.running = null;
          this.failures = retry ? this.failures + 1 : 0;
          if (retry || this.dirty)
            this.schedule(
              retry
                ? Math.min(
                    30_000,
                    (this.options.retryDelayMs ?? 1000) *
                      2 ** Math.min(this.failures - 1, 5),
                  )
                : 0,
            );
        });
    }, delay);
    this.timer.unref();
  }

  private report(error: unknown) {
    try {
      this.options.onError(error);
    } catch {
      /* Diagnostics never consume retained work. */
    }
  }

  private async drain(): Promise<boolean> {
    const scope = this.scope();
    const directory = this.directory(scope);
    await ensureHistoryDirectory(directory);
    let retry = false;
    // Independent records never wait behind a different record's HTTP timeout.
    await Promise.all(
      (await readdir(directory))
        .filter((name) => /^[a-f0-9]{64}\.pending\.json$/u.test(name))
        .map(async (name) => {
          const filename = path.join(
            directory,
            name.slice(0, -".pending.json".length),
          );
          try {
            await serializeHistoryOperation(filename, async () => {
              let record: Record;
              try {
                record = recordSchema.parse(
                  await readHistoryJson(`${filename}.pending.json`),
                );
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
                throw error;
              }
              if (
                this.filename(record) !== filename ||
                digest(record.scope) !== digest(scope)
              )
                throw new Error("Deferred settlement record scope mismatch.");
              await this.deliver(filename, record);
            });
          } catch (error) {
            retry = true;
            this.report(error);
          }
        }),
    );
    return retry;
  }

  async stop(): Promise<void> {
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.writes]);
    await this.running;
  }
}
