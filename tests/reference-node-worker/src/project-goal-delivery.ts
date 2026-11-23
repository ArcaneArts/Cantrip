import { createHash, randomUUID } from "node:crypto";
import { open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  projectGoalObservationSchema,
  projectGoalObservationResultSchema,
  threadGoalSchema,
  type ThreadGoal,
  type ProjectGoalObservation,
} from "@cantrip/protocol";
import { protectChatGoalResponse } from "./chat-message-encryption.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import {
  ensureHistoryDirectory,
  flushHistoryDirectory,
  serializeHistoryOperation,
} from "./native-history-outbox-files.js";

const recordSchema = z
  .object({
    formatVersion: z.literal(1),
    observation: projectGoalObservationSchema,
    pending: z.array(projectGoalObservationSchema),
    delivered: z.boolean(),
  })
  .strict();
type Record = z.infer<typeof recordSchema>;
/** Captured native facts only. Delivery never resumes a Goal or a Chat. */
export class ProjectGoalDelivery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private dirty = false;
  private failures = 0;
  private readonly abort = new AbortController();
  private readonly latest = new Map<string, Array<ThreadGoal | null>>();
  private readonly watched = new Map<string, string>();
  private readonly ignored = new Set<string>();
  private readonly signatures = new Map<string, string>();
  constructor(
    private readonly options: {
      directory: string;
      workerId: string;
      generation(): string;
      service: WorkerEncryptionService;
      send(
        observation: ProjectGoalObservation,
        signal: AbortSignal,
      ): Promise<unknown>;
      onError(error: unknown): void;
      retryDelayMs?: number;
    },
  ) {}
  private directory() {
    return path.join(
      this.options.directory,
      "goal-observations",
      createHash("sha256")
        .update(
          JSON.stringify([
            this.options.service.serverIdentity(),
            this.options.service.ownerId(),
            this.options.workerId,
          ]),
        )
        .digest("hex"),
    );
  }
  private filename(thread: string) {
    return createHash("sha256").update(thread).digest("hex") + ".json";
  }
  skip(threadId: string): void {
    this.ignored.add(threadId);
    this.watched.delete(threadId);
    this.latest.delete(threadId);
    this.signatures.delete(threadId);
  }
  watch(threadId: string, chatId: string): void {
    if (this.ignored.has(threadId)) return;
    this.watched.set(threadId, chatId);
  }
  observe(threadId: string, goal: ThreadGoal | null): void {
    if (!this.watched.has(threadId)) return;
    const signature = createHash("sha256")
      .update(JSON.stringify(goal))
      .digest("hex");
    if (this.signatures.get(threadId) === signature) return;
    this.signatures.set(threadId, signature);
    const pending = this.latest.get(threadId) ?? [];
    const fact = goal === null ? null : threadGoalSchema.parse(goal);
    // Preserve lifecycle boundaries even while delivery or encryption is pending.
    pending.push(fact);
    this.latest.set(threadId, pending);
    this.wake();
  }
  wake(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) return;
    this.running = this.drain()
      .catch((error) => {
        if (!this.stopped) {
          this.options.onError(error);
          this.failures++;
          this.timer = setTimeout(
            () => {
              this.timer = null;
              this.wake();
            },
            this.options.retryDelayMs ??
              Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5)),
          );
          this.timer.unref();
        }
      })
      .finally(() => {
        this.running = null;
        if (this.dirty && !this.stopped && !this.timer) this.wake();
      });
  }
  private async read(filename: string): Promise<Record | null> {
    try {
      return recordSchema.parse(JSON.parse(await readFile(filename, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async write(filename: string, record: Record): Promise<void> {
    const temporary = filename + "." + randomUUID() + ".tmp";
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, filename);
      await flushHistoryDirectory(path.dirname(filename));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async persist(): Promise<void> {
    const directory = this.directory();
    await ensureHistoryDirectory(directory);
    let failure: unknown;
    for (const [threadId, queue] of this.latest) {
      const batch = queue.slice();
      const filename = path.join(directory, this.filename(threadId));
      try {
        await serializeHistoryOperation(filename, async () => {
          const previous = await this.read(filename);
          const generation = this.options.generation();
          let revision =
            previous?.observation.generation === generation
              ? previous.observation.revision
              : 0;
          const pending = previous?.pending.slice() ?? [];
          for (const goal of batch) {
            const snapshot = await protectChatGoalResponse(
              { goal },
              this.options.service,
            );
            pending.push(
              projectGoalObservationSchema.parse({
                chatId: this.watched.get(threadId),
                workerId: this.options.workerId,
                threadId,
                generation,
                revision: ++revision,
                snapshot,
              }),
            );
          }
          await this.write(filename, {
            formatVersion: 1,
            observation: pending.at(-1)!,
            pending,
            delivered: false,
          });
          // New observations can arrive while encryption and fsync are pending.
          if (this.latest.get(threadId) === queue) {
            queue.splice(0, batch.length);
            if (!queue.length) this.latest.delete(threadId);
          }
        });
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }
  private async drain(): Promise<void> {
    do {
      this.dirty = false;
      let failure: unknown;
      try {
        await this.persist();
      } catch (error) {
        failure = error;
      }
      const directory = this.directory();
      for (const name of (await readdir(directory)).filter((n) =>
        /^[a-f0-9]{64}\.json$/.test(n),
      )) {
        if (this.stopped) return;
        const filename = path.join(directory, name);
        try {
          await serializeHistoryOperation(filename, async () => {
            const record = await this.read(filename);
            if (!record || record.delivered) return;
            while (record.pending.length && !this.stopped) {
              const fact = record.pending[0]!;
              const result = projectGoalObservationResultSchema.parse(
                await this.options.send(fact, this.abort.signal),
              );
              if (
                !result.accepted &&
                (result.reason === "unbound-thread" ||
                  (result.reason === "retired-worker" &&
                    fact.generation === this.options.generation()))
              )
                throw new Error(
                  "Goal source binding has not been registered yet.",
                );
              record.pending.shift();
              record.delivered = record.pending.length === 0;
              await this.write(filename, record);
            }
          });
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
      this.failures = 0;
    } while (this.dirty && !this.stopped);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort.abort();
    await this.running;
    // Retain unsent encrypted facts across a clean shutdown too.
    if (this.latest.size) await this.persist();
  }
}
