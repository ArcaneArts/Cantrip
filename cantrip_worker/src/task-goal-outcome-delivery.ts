import { createHash, randomUUID } from "node:crypto";
import { opendir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  taskGoalOutcomeDeliverySchema,
  type TaskGoalOutcomeDelivery as OutcomeRecord,
} from "@cantrip/protocol";
import {
  ensureHistoryDirectory,
  flushHistoryDirectory,
  readHistoryJson,
  writeImmutableHistoryFile,
} from "./native-history-outbox-files.js";

export type GoalOutcomeScope = Pick<
  OutcomeRecord,
  "serverId" | "ownerId" | "workerId"
>;

/** Response delivery only. This class cannot acquire/release tickets or run input.
 * Pending files survive worker generations; acknowledged results retain no ledger.
 * At most one response body is read into memory by the delivery scanner. */
export class TaskGoalOutcomeDelivery {
  private readonly lifetime = new AbortController();
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private failures = 0;

  constructor(
    private readonly options: {
      directory: string;
      scope(): GoalOutcomeScope;
      send(record: OutcomeRecord, signal: AbortSignal): Promise<void>;
      onError(error: unknown): void;
    },
  ) {}

  private directory(scope: GoalOutcomeScope): string {
    return path.join(
      this.options.directory,
      "task-goal-outcomes",
      createHash("sha256")
        .update(JSON.stringify([scope.serverId, scope.ownerId, scope.workerId]))
        .digest("hex"),
    );
  }

  async append(
    notification: OutcomeRecord["notification"],
    scope = this.options.scope(),
  ): Promise<void> {
    const record = taskGoalOutcomeDeliverySchema.parse({
      ...scope,
      version: 1,
      deliveryId: randomUUID(),
      notification,
    });
    const directory = this.directory(scope);
    const filename = path.join(directory, record.deliveryId + ".json");
    const body = JSON.stringify(record);
    let failures = 0;
    // The execution already settled. A storage failure delays its response,
    // never turns that success into a contradictory model failure or replay.
    while (!this.lifetime.signal.aborted) {
      try {
        await ensureHistoryDirectory(directory);
        const written = await writeImmutableHistoryFile(filename, body);
        if (
          !written &&
          JSON.stringify(await readHistoryJson(filename)) !== body
        )
          throw new Error("Goal outcome delivery identity has another body.");
        this.wake();
        return;
      } catch (error) {
        this.options.onError(error);
        await delay(
          Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)),
          undefined,
          {
            signal: this.lifetime.signal,
          },
        );
      }
    }
    throw new Error("Goal outcome delivery stopped before persistence.");
  }

  wake(): void {
    if (this.lifetime.signal.aborted) return;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) return;
    this.running = this.drain()
      .then(() => {
        this.failures = 0;
      })
      .catch((error) => {
        if (this.lifetime.signal.aborted) return;
        this.options.onError(error);
        this.timer = setTimeout(
          () => {
            this.timer = null;
            this.wake();
          },
          Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5)),
        );
        this.timer.unref();
      })
      .finally(() => {
        this.running = null;
        if (this.dirty && !this.timer) this.wake();
      });
  }

  private async drain(): Promise<void> {
    do {
      this.dirty = false;
      const scope = this.options.scope();
      const directory = this.directory(scope);
      let entries;
      try {
        entries = await opendir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      let failure: unknown;
      for await (const entry of entries) {
        if (this.lifetime.signal.aborted) return;
        if (!/^[a-f0-9-]{36}\.json$/u.test(entry.name)) continue;
        const filename = path.join(directory, entry.name);
        try {
          const record = taskGoalOutcomeDeliverySchema.parse(
            await readHistoryJson(filename),
          );
          if (
            record.serverId !== scope.serverId ||
            record.ownerId !== scope.ownerId ||
            record.workerId !== scope.workerId ||
            entry.name !== record.deliveryId + ".json"
          )
            throw new Error(
              "Goal outcome file belongs to another scope or identity.",
            );
          // Credentials/bindings can change while disk reads are pending.
          if (this.directory(this.options.scope()) !== directory) return;
          await this.options.send(record, this.lifetime.signal);
          // send resolves only after matching canonical commit or positive
          // deletion/replacement retirement evidence; never a timeout.
          await rm(filename);
          await flushHistoryDirectory(directory);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
    } while (this.dirty && !this.lifetime.signal.aborted);
  }

  close(): void {
    this.lifetime.abort(new Error("Goal outcome delivery stopped."));
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
