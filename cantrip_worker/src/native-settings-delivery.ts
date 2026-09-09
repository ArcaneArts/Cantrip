import { createHash, randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  nativeSettingsEvidenceSchema,
  type NativeSettingsEvidence,
} from "@cantrip/protocol";
import { NativeCommandClient } from "./native-command-client.js";
import { protectNativeCommandContent } from "./native-command-content.js";
import type { WorkerEncryptionService } from "./worker-encryption.js";
import {
  ensureHistoryDirectory,
  flushHistoryDirectory,
  readHistoryJson,
  writeImmutableHistoryFile,
} from "./native-history-outbox-files.js";

const id = z.string().min(1).max(255);
const scopeSchema = z
  .object({
    chatId: id,
    operationId: id,
    operationGeneration: id,
    threadId: id,
    runtimeGeneration: id,
    nativeOperationId: id,
  })
  .strict();
const registrationSchema = z
  .object({ scope: scopeSchema, recovery: nativeSettingsEvidenceSchema })
  .strict();
export type NativeSettingsEvidenceScope = z.infer<typeof scopeSchema>;
type Service = Pick<
  WorkerEncryptionService,
  "ownerId" | "serverIdentity" | "componentKey"
>;
type Kind = NativeSettingsEvidence["kind"];

/** Durable result delivery is independent of native execution and its timeouts.
 * Recovery sends only captured facts; it never resubmits a native operation. */
export class NativeSettingsDelivery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private dirty = false;
  private failures = 0;
  private readonly live = new Set<string>();
  private readonly pending = new Map<
    string,
    { event: NativeSettingsEvidence; directory: string }
  >();
  private readonly writes = new Set<Promise<unknown>>();
  private readonly abort = new AbortController();

  constructor(
    private readonly options: {
      directory: string;
      workerId: string;
      service: Service;
      client: Pick<NativeCommandClient, "settingsEvidence">;
      onError(error: unknown): void;
      retryDelayMs?: number;
    },
  ) {}

  private directory(): string {
    const scope = [
      this.options.service.serverIdentity(),
      this.options.service.ownerId(),
      this.options.workerId,
    ];
    return path.join(
      this.options.directory,
      "native-settings-evidence",
      createHash("sha256").update(JSON.stringify(scope)).digest("hex"),
    );
  }
  private marker(scope: NativeSettingsEvidenceScope): string {
    return `${createHash("sha256")
      .update(JSON.stringify([scope.operationId, scope.operationGeneration]))
      .digest("hex")}.pending.json`;
  }

  /** Register before dispatch. An interrupted worker can report uncertainty on recovery. */
  async track(value: NativeSettingsEvidenceScope): Promise<void> {
    const scope = scopeSchema.parse(value);
    const marker = this.marker(scope);
    this.live.add(marker);
    try {
      const { directory, event: recovery } = await this.prepare(
        scope,
        "transport-lost",
        null,
        { reason: "worker-recovered-before-settings-result" },
      );
      await ensureHistoryDirectory(directory);
      const created = await writeImmutableHistoryFile(
        path.join(directory, marker),
        JSON.stringify({ scope, recovery }),
      );
      if (
        !created &&
        JSON.stringify(
          registrationSchema.parse(
            await readHistoryJson(path.join(directory, marker)),
          ).scope,
        ) !== JSON.stringify(scope)
      )
        throw new Error("Native settings registration identity was reused.");
    } catch (error) {
      this.live.delete(marker);
      throw error;
    }
  }

  record(
    scope: NativeSettingsEvidenceScope,
    kind: Kind,
    submissionId: string | null,
    content: unknown,
  ): Promise<void> {
    const write = this.capture(scope, kind, submissionId, content);
    this.writes.add(write);
    void write.finally(() => this.writes.delete(write)).catch(() => {});
    return write;
  }

  private async capture(
    scope: NativeSettingsEvidenceScope,
    kind: Kind,
    submissionId: string | null,
    content: unknown,
  ): Promise<void> {
    const { directory, event } = await this.prepare(
      scope,
      kind,
      submissionId,
      content,
    );
    const eventId = event.eventId;
    // Keep the exact ciphertext/event identity if local publication fails.
    this.pending.set(eventId, { event, directory });
    try {
      await this.persist(event, directory);
      if (kind === "applied" || kind === "rejected") {
        await rm(path.join(directory, this.marker(scope)), { force: true });
        await flushHistoryDirectory(directory);
      }
    } finally {
      this.wake();
    }
  }

  private async prepare(
    scope: NativeSettingsEvidenceScope,
    kind: Kind,
    submissionId: string | null,
    content: unknown,
  ) {
    const directory = this.directory();
    const eventId = randomUUID();
    const protectedContent = await protectNativeCommandContent({
      service: this.options.service,
      context: {
        chatId: scope.chatId,
        operationId: scope.operationId,
        direction: "settings-evidence",
        eventId,
      },
      content: { scope, kind, submissionId, content },
    });
    if (this.directory() !== directory)
      throw new Error(
        "Native settings encryption ownership changed during capture.",
      );
    const { chatId: _chatId, ...identity } = scope;
    const event = nativeSettingsEvidenceSchema.parse({
      ...identity,
      eventId,
      kind,
      submissionId,
      workerId: this.options.workerId,
      resultDigest: protectedContent.digest,
      protectedResult: protectedContent.envelope,
    });
    return { directory, event };
  }

  private async persist(
    event: NativeSettingsEvidence,
    directory: string,
  ): Promise<void> {
    await ensureHistoryDirectory(directory);
    const filename = path.join(directory, `${event.eventId}.event.json`);
    const body = JSON.stringify(event);
    if (
      !(await writeImmutableHistoryFile(filename, body)) &&
      JSON.stringify(await readHistoryJson(filename)) !== body
    )
      throw new Error("Native settings event identity was reused.");
    this.pending.delete(event.eventId);
  }

  /** Called at worker startup as well as after new records. Idle stores do not poll. */
  wake(): void {
    if (this.stopped) return;
    this.dirty = true;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.stopped || this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.dirty = false;
      let retry = false;
      this.running = this.drain()
        .then((pending) => {
          retry = pending;
        })
        .catch((error) => {
          retry = true;
          this.options.onError(error);
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

  private async drain(): Promise<boolean> {
    let retry = false;
    const directory = this.directory();
    await ensureHistoryDirectory(directory);
    for (const { event, directory } of this.pending.values())
      await this.persist(event, directory);
    for (const name of await readdir(directory)) {
      if (this.stopped) return false;
      if (/^[a-f0-9]{64}\.pending\.json$/u.test(name) && !this.live.has(name)) {
        try {
          const { scope, recovery } = registrationSchema.parse(
            await readHistoryJson(path.join(directory, name)),
          );
          if (
            this.marker(scope) !== name ||
            recovery.operationId !== scope.operationId ||
            recovery.operationGeneration !== scope.operationGeneration ||
            recovery.threadId !== scope.threadId ||
            recovery.runtimeGeneration !== scope.runtimeGeneration ||
            recovery.nativeOperationId !== scope.nativeOperationId ||
            recovery.workerId !== this.options.workerId ||
            recovery.kind !== "transport-lost"
          )
            throw new Error("Native settings registration scope mismatch.");
          // Reuse the presealed event even if recovery committed before a crash
          // or deleting the marker failed. A retry never mints another result.
          await this.persist(recovery, directory);
          await rm(path.join(directory, name));
          await flushHistoryDirectory(directory);
        } catch (error) {
          retry = true;
          this.options.onError(error);
        }
      }
    }
    // Events are independent facts. A rejected/corrupt record must not starve another operation.
    for (const name of await readdir(directory)) {
      if (this.stopped) return false;
      if (!name.endsWith(".event.json")) continue;
      try {
        const event = nativeSettingsEvidenceSchema.parse(
          await readHistoryJson(path.join(directory, name)),
        );
        if (
          name !== `${event.eventId}.event.json` ||
          event.workerId !== this.options.workerId
        )
          throw new Error("Native settings event filename/scope mismatch.");
        await this.options.client.settingsEvidence(event, this.abort.signal);
        if (this.stopped) return false;
        await rm(path.join(directory, name));
        await flushHistoryDirectory(directory);
      } catch (error) {
        retry = true;
        this.options.onError(error);
      }
    }
    return retry;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.writes]);
    await this.running;
    for (const { event, directory } of this.pending.values())
      await this.persist(event, directory);
  }
}
