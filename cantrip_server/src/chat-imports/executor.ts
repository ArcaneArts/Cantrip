import {
  externalChatReadWorkerResultSchema,
  type ChatImportError,
  type ChatImportJobSummary,
} from "@cantrip/protocol";

import {
  ChatImportJobConflictError,
  ChatImportJobStaleAttemptError,
  type ClaimedChatImportJob,
} from "../db/chat-import-jobs.js";
import type { ServerRepository } from "../db/repository.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../workers/bridge.js";

interface ChatImportLogger {
  error(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface ChatImportLiveChange {
  job: ChatImportJobSummary;
  ownerId: string;
}

const MAX_CONCURRENT_CHAT_IMPORTS = 2;
const JOB_LEASE_RENEWAL_INTERVAL_MS = 30_000;
const JOB_RECOVERY_SWEEP_INTERVAL_MS = 30_000;
export const CHAT_IMPORT_READ_TIMEOUT_MS = 30 * 60_000;

function importError(error: unknown): ChatImportError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof WorkerUnavailableError) {
    return {
      code: "worker-offline",
      message:
        "The source worker is offline. The import will resume after it reconnects.",
      retryable: true,
    };
  }
  if (/not found/iu.test(message)) {
    return { code: "source-not-found", message, retryable: false };
  }
  if (error instanceof Error && error.name === "ZodError") {
    return {
      code: "runtime-incompatible",
      message:
        "The source worker returned an unsupported Codex transcript shape.",
      retryable: false,
    };
  }
  if (/outside Cantrip's tested range|not supported/iu.test(message)) {
    return { code: "runtime-incompatible", message, retryable: false };
  }
  if (/no longer belongs|project match|destination worktree/iu.test(message)) {
    return { code: "project-mismatch", message, retryable: false };
  }
  if (/identity changed|invalid thread\/read|safe to import/iu.test(message)) {
    return { code: "source-changed", message, retryable: false };
  }
  if (/timed out|timeout/iu.test(message)) {
    return { code: "worker-error", message, retryable: true };
  }
  return {
    code: "worker-error",
    message:
      message.slice(0, 2_000) ||
      "The source worker could not import this chat.",
    retryable: true,
  };
}

export class ChatImportJobExecutor {
  readonly #active = new Set<Promise<void>>();
  #drainPromise: Promise<void> | null = null;
  #recoveryTimer: ReturnType<typeof setInterval> | null = null;
  #rerunRequested = false;
  #stopping = false;

  constructor(
    private readonly repository: ServerRepository,
    private readonly bridge: WorkerCommandBus,
    private readonly logger: ChatImportLogger,
    private readonly onChanged: (change: ChatImportLiveChange) => void = () =>
      undefined,
  ) {}

  async recoverAfterRestart(force = true): Promise<number> {
    return this.repository.chatImportJobs.recoverInterrupted(force);
  }

  startRecoverySweep(): void {
    if (this.#recoveryTimer || this.#stopping) return;
    this.#recoveryTimer = setInterval(() => {
      void this.repository.chatImportJobs
        .recoverInterrupted(false)
        .then((recovered) => {
          if (recovered > 0) this.queueAvailable();
        })
        .catch((error: unknown) => {
          this.logger.error(
            { err: error },
            "Could not recover expired chat import leases",
          );
        });
    }, JOB_RECOVERY_SWEEP_INTERVAL_MS);
    this.#recoveryTimer.unref();
  }

  queueAvailable(): void {
    if (this.#stopping) return;
    if (this.#drainPromise) {
      this.#rerunRequested = true;
      return;
    }
    this.#drainPromise = this.#drain()
      .catch((error: unknown) => {
        this.logger.error({ err: error }, "Chat import dispatch failed");
      })
      .finally(() => {
        this.#drainPromise = null;
        if (this.#rerunRequested) {
          this.#rerunRequested = false;
          this.queueAvailable();
        }
      });
  }

  async workerConnected(workerId: string): Promise<void> {
    await this.repository.chatImportJobs.requeueRetryableForWorker(workerId);
    this.queueAvailable();
  }

  stop(): void {
    this.#stopping = true;
    if (this.#recoveryTimer) {
      clearInterval(this.#recoveryTimer);
      this.#recoveryTimer = null;
    }
  }

  async drain(): Promise<void> {
    await this.#drainPromise;
    await Promise.allSettled([...this.#active]);
  }

  async #drain(): Promise<void> {
    while (!this.#stopping) {
      if (this.#active.size >= MAX_CONCURRENT_CHAT_IMPORTS) {
        await Promise.race(this.#active);
        continue;
      }
      const claimed = await this.repository.chatImportJobs.claimNext();
      if (!claimed) break;
      const task = this.#execute(claimed)
        .catch((error: unknown) => {
          this.logger.error(
            { err: error, chatImportJobId: claimed.job.id },
            "Chat import failed outside its durable transition",
          );
        })
        .finally(() => {
          this.#active.delete(task);
          this.#rerunRequested = true;
        });
      this.#active.add(task);
    }
  }

  async #execute(claimed: ClaimedChatImportJob): Promise<void> {
    let renewalInFlight = false;
    const renewalTimer = setInterval(() => {
      if (renewalInFlight) return;
      renewalInFlight = true;
      void this.repository.chatImportJobs
        .renewLease(claimed.job.id, claimed.commandId, claimed.job.attempt)
        .then((renewed) => {
          if (!renewed) {
            this.logger.warn(
              { chatImportJobId: claimed.job.id, attempt: claimed.job.attempt },
              "Chat import no longer owns its durable lease",
            );
          }
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { err: error, chatImportJobId: claimed.job.id },
            "Could not renew chat import lease",
          );
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, JOB_LEASE_RENEWAL_INTERVAL_MS);
    renewalTimer.unref();
    try {
      const worker = await this.repository.getWorker(
        claimed.ownerId,
        claimed.job.sourceWorkerId,
      );
      if (!worker || !this.bridge.isConnected(claimed.job.sourceWorkerId)) {
        const blocked = await this.repository.chatImportJobs.block(
          claimed.job.id,
          claimed.commandId,
          importError(new WorkerUnavailableError("Source worker is offline.")),
        );
        this.onChanged({ ownerId: claimed.ownerId, job: blocked });
        return;
      }
      if (!worker.externalCodexHistory) {
        const blocked = await this.repository.chatImportJobs.block(
          claimed.job.id,
          claimed.commandId,
          {
            code: "capability-missing",
            message:
              "The source worker no longer supports Codex history import.",
            retryable: false,
          },
        );
        this.onChanged({ ownerId: claimed.ownerId, job: blocked });
        return;
      }
      const context = await this.repository.chatImportJobs.readContext(
        claimed.job.id,
        claimed.commandId,
      );
      if (!context) {
        const failed = await this.repository.chatImportJobs.fail(
          claimed.job.id,
          claimed.commandId,
          {
            code: "target-not-found",
            message: "The source project replica is no longer available.",
            retryable: false,
          },
        );
        this.onChanged({ ownerId: claimed.ownerId, job: failed });
        return;
      }
      const result = externalChatReadWorkerResultSchema.parse(
        await this.bridge.request(
          claimed.job.sourceWorkerId,
          {
            type: "external.chat-history.read",
            sourceKind: claimed.job.sourceKind,
            sourceId: claimed.job.sourceId,
            sourceThreadId: claimed.job.sourceThreadId,
            targets: context.targets,
          },
          { timeoutMs: CHAT_IMPORT_READ_TIMEOUT_MS },
        ),
      );
      const importing = await this.repository.chatImportJobs.markImporting(
        claimed.job.id,
        claimed.commandId,
        claimed.job.attempt,
      );
      this.onChanged({ ownerId: claimed.ownerId, job: importing });
      const completed =
        await this.repository.chatImportJobs.completeCanonicalImport(
          claimed.job.id,
          claimed.commandId,
          claimed.job.attempt,
          result.transcript,
        );
      this.onChanged({ ownerId: claimed.ownerId, job: completed });
    } catch (error) {
      if (error instanceof ChatImportJobStaleAttemptError) {
        this.logger.warn(
          { chatImportJobId: claimed.job.id, attempt: claimed.job.attempt },
          "Ignored stale chat import result",
        );
        return;
      }
      const mapped = importError(error);
      const settled =
        mapped.retryable && !(error instanceof ChatImportJobConflictError)
          ? await this.repository.chatImportJobs.block(
              claimed.job.id,
              claimed.commandId,
              mapped,
            )
          : await this.repository.chatImportJobs.fail(
              claimed.job.id,
              claimed.commandId,
              mapped,
            );
      this.onChanged({ ownerId: claimed.ownerId, job: settled });
    } finally {
      clearInterval(renewalTimer);
    }
  }
}
