import { createHash } from "node:crypto";

import {
  chatRelocationHydrationBeginResultSchema,
  chatRelocationHydrationResultSchema,
  mentionedSkillNames,
  workerAttachmentReadResultSchema,
  workerAttachmentUploadResultSchema,
  worktreeStatusResultSchema,
  type ChatRelocationError,
  type ChatRelocationJobSummary,
  type ChatSummary,
  type ProjectReplicaJobSummary,
} from "@cantrip/protocol";

import { effectivePermissionProfile } from "../chats/execution-helpers.js";
import {
  ChatRelocationJobStaleAttemptError,
  encodeChatRelocationPayload,
  type ClaimedChatRelocationJob,
} from "../db/chat-relocation-jobs.js";
import { ProjectReplicaJobConflictError } from "../db/project-replica-jobs.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
  ProjectWorktreeExecutionContext,
  ServerRepository,
} from "../db/repository.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../workers/bridge.js";
import { resolveAccountProviderRuntimes } from "../models/chatgpt-account-routing.js";
import { isAccountProviderKind } from "../models/account-provider.js";

interface ChatRelocationLogger {
  error(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface ChatRelocationLiveChange {
  chat?: ChatSummary;
  job: ChatRelocationJobSummary;
  ownerId: string;
}

class RelocationExecutionError extends Error {
  constructor(readonly relocationError: ChatRelocationError) {
    super(relocationError.message);
  }
}

const MAX_CONCURRENT_CHAT_RELOCATIONS = 2;
const ATTACHMENT_CHUNK_BYTES = 256 * 1_024;
const HYDRATION_CHUNK_BYTES = 256 * 1_024;
const REPLICA_JOB_WAIT_MS = 5 * 60_000;
const JOB_LEASE_RENEWAL_INTERVAL_MS = 30_000;
const JOB_RECOVERY_SWEEP_INTERVAL_MS = 30_000;
export const CHAT_RELOCATION_HYDRATION_TIMEOUT_MS = 30 * 60_000;
const REQUIRED_TARGET_METHODS = [
  "thread/start",
  "thread/inject_items",
  "thread/unsubscribe",
  "skills/list",
  "permissionProfile/list",
  "collaborationMode/list",
  "thread/settings/update",
] as const;

function executionError(
  code: ChatRelocationError["code"],
  message: string,
  retryable: boolean,
): RelocationExecutionError {
  return new RelocationExecutionError({ code, message, retryable });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function runtimeCapabilityError(
  workerName: string,
  methods: Record<string, "available" | "unavailable" | "unknown">,
): RelocationExecutionError | null {
  const missing = REQUIRED_TARGET_METHODS.filter(
    (method) => methods[method] !== "available",
  );
  return missing.length
    ? executionError(
        "capability-missing",
        `${workerName} cannot relocate chats because Codex methods are unavailable: ${missing.join(", ")}.`,
        false,
      )
    : null;
}

function requiredSkillNames(claimed: ClaimedChatRelocationJob): string[] {
  const names = new Set<string>();
  for (const message of claimed.snapshot.payload.messages) {
    for (const item of message.content) {
      if (item.type !== "text") continue;
      for (const name of mentionedSkillNames(item.text)) names.add(name);
    }
  }
  if (names.size > 64) {
    throw executionError(
      "policy-denied",
      "The canonical transcript references more than 64 skills and cannot be hydrated safely.",
      false,
    );
  }
  return [...names].sort();
}

function mapReplicaError(job: ProjectReplicaJobSummary): ChatRelocationError {
  const error = job.error;
  if (!error) {
    return {
      code: "replica-not-ready",
      message: "The target replica did not reach the required revision.",
      retryable: true,
    };
  }
  const sharedCodes = new Set<ChatRelocationError["code"]>([
    "target-not-found",
    "target-mismatch",
    "worker-offline",
    "capability-missing",
    "replica-not-ready",
    "worktree-dirty",
    "revision-diverged",
    "attachment-unavailable",
    "runtime-incompatible",
    "stale-attempt",
    "policy-denied",
    "worker-error",
  ]);
  return {
    code: sharedCodes.has(error.code as ChatRelocationError["code"])
      ? (error.code as ChatRelocationError["code"])
      : error.code === "remote-unavailable"
        ? "revision-diverged"
        : "policy-denied",
    message: error.message,
    retryable: error.retryable,
  };
}

export class ChatRelocationJobExecutor {
  readonly #active = new Set<Promise<void>>();
  #drainPromise: Promise<void> | null = null;
  #recoveryTimer: ReturnType<typeof setInterval> | null = null;
  #rerunRequested = false;
  #stopping = false;

  constructor(
    private readonly repository: ServerRepository,
    private readonly bridge: WorkerCommandBus,
    private readonly logger: ChatRelocationLogger,
    private readonly queueReplicaJobs: () => void,
    private readonly onChanged: (
      change: ChatRelocationLiveChange,
    ) => void = () => undefined,
  ) {}

  async recoverAfterRestart(force = true): Promise<number> {
    return this.repository.chatRelocationJobs.recoverInterrupted(force);
  }

  startRecoverySweep(): void {
    if (this.#recoveryTimer || this.#stopping) return;
    this.#recoveryTimer = setInterval(() => {
      void this.repository.chatRelocationJobs
        .recoverInterrupted(false)
        .then((recovered) => {
          if (recovered > 0) this.queueAvailable();
        })
        .catch((error: unknown) => {
          this.logger.error(
            { err: error },
            "Could not recover expired chat relocation job leases",
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
        this.logger.error({ err: error }, "Chat relocation dispatch failed");
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
    await this.repository.chatRelocationJobs.requeueRetryableForWorker(
      workerId,
    );
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
      if (this.#active.size >= MAX_CONCURRENT_CHAT_RELOCATIONS) {
        await Promise.race(this.#active);
        continue;
      }
      const claimed = await this.repository.chatRelocationJobs.claimNext();
      if (!claimed) break;
      const task = this.#execute(claimed)
        .catch((error: unknown) => {
          this.logger.error(
            { err: error, chatRelocationJobId: claimed.job.id },
            "Chat relocation failed outside its durable transition",
          );
        })
        .finally(() => {
          this.#active.delete(task);
          this.#rerunRequested = true;
        });
      this.#active.add(task);
    }
  }

  async #execute(claimed: ClaimedChatRelocationJob): Promise<void> {
    let hydratedTarget: {
      runtime: ModelRuntime;
      threadId: string;
      workerId: string;
    } | null = null;
    let placementCommitted = false;
    let renewalInFlight = false;
    const renewalTimer = setInterval(() => {
      if (renewalInFlight) return;
      renewalInFlight = true;
      void this.repository.chatRelocationJobs
        .renewLease(claimed.job.id, claimed.commandId, claimed.job.attempt)
        .then((renewed) => {
          if (!renewed) {
            this.logger.warn(
              {
                chatRelocationJobId: claimed.job.id,
                attempt: claimed.job.attempt,
              },
              "Chat relocation job no longer owns its durable lease",
            );
          }
        })
        .catch((error: unknown) => {
          this.logger.warn(
            {
              err: error,
              chatRelocationJobId: claimed.job.id,
              attempt: claimed.job.attempt,
            },
            "Could not renew chat relocation job lease",
          );
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, JOB_LEASE_RENEWAL_INTERVAL_MS);
    renewalTimer.unref();
    try {
      const prepared = await this.#validate(claimed);
      let job = await this.repository.chatRelocationJobs.advance(
        claimed.job.id,
        claimed.commandId,
        claimed.job.attempt,
        "validating",
        "preparing-replica",
        {
          stage: "preparing-replica",
          percent: 20,
          message: "Preparing the target worktree at the captured revision.",
        },
      );
      this.onChanged({ ownerId: claimed.ownerId, job });

      await this.#prepareReplica(claimed, prepared.target);
      job = await this.repository.chatRelocationJobs.advance(
        job.id,
        claimed.commandId,
        job.attempt,
        "preparing-replica",
        "transferring-attachments",
        {
          stage: "transferring-attachments",
          percent: 35,
          message: "Resolving canonical attachments on the target worker.",
        },
      );
      this.onChanged({ ownerId: claimed.ownerId, job });

      await this.#relayAttachments(claimed);
      job = await this.repository.chatRelocationJobs.advance(
        job.id,
        claimed.commandId,
        job.attempt,
        "transferring-attachments",
        "hydrating-runtime",
        {
          stage: "hydrating-runtime",
          percent: 65,
          message: "Hydrating a target Codex runtime from canonical history.",
        },
      );
      this.onChanged({ ownerId: claimed.ownerId, job });

      const targetRuntime = await this.#selectRuntime(
        claimed,
        claimed.job.targetPlacement.workerId,
        prepared.source.providerAccountId,
      );
      const targetThreadId = await this.#hydrateTarget(
        claimed,
        prepared.source,
        prepared.target,
        targetRuntime,
      );
      hydratedTarget = {
        runtime: targetRuntime,
        threadId: targetThreadId,
        workerId: prepared.target.workerId,
      };
      job = await this.repository.chatRelocationJobs.advance(
        job.id,
        claimed.commandId,
        job.attempt,
        "hydrating-runtime",
        "ready-to-commit",
        {
          stage: "ready-to-commit",
          percent: 90,
          message: "Target runtime is ready; committing chat placement.",
        },
        {
          cancellationUnsafe: true,
          targetModelRouteId: targetRuntime.routeId,
          targetProviderAccountId: targetRuntime.provider.accountId,
          targetRuntimeThreadId: targetThreadId,
        },
      );
      this.onChanged({ ownerId: claimed.ownerId, job });

      const committed = await this.repository.chatRelocationJobs.commit(
        job.id,
        claimed.commandId,
        job.attempt,
      );
      this.onChanged({
        chat: committed.chat,
        ownerId: claimed.ownerId,
        job: committed.job,
      });
      if (committed.job.state !== "succeeded") {
        await this.#releaseTarget(hydratedTarget);
        return;
      }
      placementCommitted = true;
      await this.#releaseSource(claimed, prepared.source).catch((error) => {
        this.logger.warn(
          { err: error, chatRelocationJobId: claimed.job.id },
          "Chat relocation committed but source runtime cleanup failed",
        );
      });
    } catch (error) {
      if (hydratedTarget && !placementCommitted) {
        const current = await this.repository.chatRelocationJobs
          .get(claimed.ownerId, claimed.job.id)
          .catch(() => null);
        if (current?.state !== "succeeded") {
          await this.#releaseTarget(hydratedTarget).catch((cleanupError) => {
            this.logger.warn(
              {
                err: cleanupError,
                chatRelocationJobId: claimed.job.id,
              },
              "Could not release an uncommitted target runtime",
            );
          });
        }
      }
      if (error instanceof ChatRelocationJobStaleAttemptError) {
        this.logger.warn(
          { err: error, chatRelocationJobId: claimed.job.id },
          "Ignored stale chat relocation completion",
        );
        return;
      }
      const relocationError =
        error instanceof RelocationExecutionError
          ? error.relocationError
          : error instanceof WorkerUnavailableError
            ? {
                code: "worker-offline" as const,
                message:
                  "A required worker disconnected during relocation. The job will resume after it reconnects.",
                retryable: true,
              }
            : {
                code: "worker-error" as const,
                message:
                  error instanceof Error
                    ? error.message.slice(0, 4_000)
                    : "A worker failed while relocating the chat.",
                retryable: true,
              };
      try {
        const settled = await this.repository.chatRelocationJobs.fail(
          claimed.job.id,
          claimed.commandId,
          claimed.job.attempt,
          relocationError,
        );
        this.onChanged({ ownerId: claimed.ownerId, job: settled });
      } catch (settleError) {
        if (!(settleError instanceof ChatRelocationJobStaleAttemptError)) {
          throw settleError;
        }
      }
    } finally {
      clearInterval(renewalTimer);
    }
  }

  async #validate(claimed: ClaimedChatRelocationJob): Promise<{
    source: ChatExecutionContext;
    target: ProjectWorktreeExecutionContext;
  }> {
    const [source, target, sourceWorker, targetWorker] = await Promise.all([
      this.repository.getChatExecutionContext(
        claimed.ownerId,
        claimed.job.chatId,
      ),
      this.repository.getProjectWorktreeContext(
        claimed.ownerId,
        claimed.job.projectId,
        claimed.job.targetPlacement.worktreeId!,
      ),
      this.repository.getWorker(
        claimed.ownerId,
        claimed.job.sourcePlacement.workerId,
      ),
      this.repository.getWorker(
        claimed.ownerId,
        claimed.job.targetPlacement.workerId,
      ),
    ]);
    if (
      !source ||
      source.workerId !== claimed.job.sourcePlacement.workerId ||
      source.worktreeId !== claimed.job.sourcePlacement.worktreeId ||
      source.status !== "idle"
    ) {
      throw executionError(
        "stale-attempt",
        "The source chat placement or execution state changed before relocation.",
        false,
      );
    }
    if (
      !target ||
      target.workerId !== claimed.job.targetPlacement.workerId ||
      target.projectSourceId !== claimed.job.targetPlacement.projectReplicaId
    ) {
      throw executionError(
        "target-not-found",
        "The target project worktree is no longer available.",
        false,
      );
    }
    if (!sourceWorker || !targetWorker) {
      throw executionError(
        "target-not-found",
        "A required worker is no longer enrolled.",
        false,
      );
    }
    if (!sourceWorker.chatRelocation || !targetWorker.chatRelocation) {
      throw executionError(
        "capability-missing",
        "Both workers must advertise durable chat relocation support. Upgrade the incompatible worker and retry.",
        false,
      );
    }
    if (
      !this.bridge.isConnected(source.workerId) ||
      !this.bridge.isConnected(target.workerId)
    ) {
      throw executionError(
        "worker-offline",
        "Both source and target workers must be online. Relocation will resume after they reconnect.",
        true,
      );
    }
    if (
      targetWorker.codexRuntime.compatibility === "missing" ||
      targetWorker.codexRuntime.compatibility === "incompatible"
    ) {
      throw executionError(
        "runtime-incompatible",
        `${targetWorker.name} does not have a compatible Codex runtime.`,
        false,
      );
    }
    const targetCapabilityError = runtimeCapabilityError(
      targetWorker.name,
      targetWorker.codexRuntime.methods,
    );
    if (targetCapabilityError) throw targetCapabilityError;
    if (
      source.threadId &&
      sourceWorker.codexRuntime.methods["thread/unsubscribe"] !== "available"
    ) {
      throw executionError(
        "capability-missing",
        `${sourceWorker.name} cannot safely release the source Codex thread.`,
        false,
      );
    }

    const [sourceWorktree, targetWorktree] = await Promise.all([
      this.repository.getProjectWorktreeContext(
        claimed.ownerId,
        claimed.job.projectId,
        source.worktreeId,
      ),
      Promise.resolve(target),
    ]);
    if (!sourceWorktree) {
      throw executionError(
        "target-not-found",
        "The source worktree is no longer available.",
        false,
      );
    }
    const [sourceStatus, targetStatus] = await Promise.all([
      this.#worktreeStatus(sourceWorktree),
      this.#worktreeStatus(targetWorktree),
    ]);
    if (sourceStatus.status.files.length) {
      throw executionError(
        "worktree-dirty",
        "The source worktree has uncommitted changes. Commit or preserve them before relocating this chat.",
        false,
      );
    }
    if (targetStatus.status.files.length) {
      throw executionError(
        "worktree-dirty",
        "The target worktree has uncommitted changes and will not be modified.",
        false,
      );
    }
    if (
      sourceStatus.status.head !== claimed.snapshot.summary.requiredRevision
    ) {
      throw executionError(
        "revision-diverged",
        "The source worktree revision changed after the relocation snapshot was captured.",
        false,
      );
    }
    return { source, target };
  }

  async #worktreeStatus(context: ProjectWorktreeExecutionContext) {
    return worktreeStatusResultSchema.parse(
      await this.bridge.request(
        context.workerId,
        {
          type: "worktree.status",
          sourcePath: context.sourcePath,
          worktreePath: context.worktree.path,
        },
        { timeoutMs: 30_000 },
      ),
    );
  }

  async #prepareReplica(
    claimed: ClaimedChatRelocationJob,
    target: ProjectWorktreeExecutionContext,
  ): Promise<void> {
    let status = await this.#worktreeStatus(target);
    if (status.status.files.length) {
      throw executionError(
        "worktree-dirty",
        "The target worktree became dirty during relocation and was left untouched.",
        false,
      );
    }
    if (status.status.head === claimed.snapshot.summary.requiredRevision) {
      return;
    }
    if (!target.worktree.isPrimary) {
      throw executionError(
        "revision-diverged",
        "Only a clean target Primary worktree can be synchronized automatically. Select a matching worktree or reconcile it first.",
        false,
      );
    }
    const settings = await this.repository.getSettings(claimed.ownerId);
    if (
      settings.preferences.automaticReplicaSynchronization !==
      "fast-forward-primary"
    ) {
      throw executionError(
        "revision-diverged",
        "The target replica is at a different revision. Enable safe automatic Primary synchronization or reconcile it manually.",
        false,
      );
    }
    let replicaJob: ProjectReplicaJobSummary;
    try {
      replicaJob = await this.repository.projectReplicaJobs.createSynchronize(
        claimed.ownerId,
        claimed.job.projectId,
        target.projectSourceId,
        {
          expectedRevision: claimed.snapshot.summary.requiredRevision,
          idempotencyKey: `chat-relocation:${claimed.job.id}:${claimed.snapshot.summary.requiredRevision}`,
          policy: "fast-forward-primary",
        },
      );
    } catch (error) {
      if (error instanceof ProjectReplicaJobConflictError) {
        throw executionError(
          "replica-not-ready",
          "Another replica operation is active on the target. Retry relocation after it finishes.",
          true,
        );
      }
      throw error;
    }
    if (
      (replicaJob.state === "blocked" || replicaJob.state === "failed") &&
      replicaJob.error?.retryable
    ) {
      replicaJob =
        (await this.repository.projectReplicaJobs.retry(
          claimed.ownerId,
          replicaJob.id,
          replicaJob.stateRevision,
        )) ?? replicaJob;
    }
    this.queueReplicaJobs();
    const deadline = Date.now() + REPLICA_JOB_WAIT_MS;
    while (replicaJob.state === "queued" || replicaJob.state === "running") {
      if (Date.now() >= deadline) {
        throw executionError(
          "replica-not-ready",
          "Target replica synchronization did not finish within five minutes.",
          true,
        );
      }
      await delay(250);
      replicaJob =
        (await this.repository.projectReplicaJobs.get(
          claimed.ownerId,
          replicaJob.id,
        )) ?? replicaJob;
    }
    if (replicaJob.state !== "succeeded") {
      throw new RelocationExecutionError(mapReplicaError(replicaJob));
    }
    status = await this.#worktreeStatus(target);
    if (
      status.status.files.length ||
      status.status.head !== claimed.snapshot.summary.requiredRevision
    ) {
      throw executionError(
        "revision-diverged",
        "The synchronized target did not materialize the captured revision cleanly.",
        false,
      );
    }
  }

  async #relayAttachments(claimed: ClaimedChatRelocationJob): Promise<void> {
    const targetWorkerId = claimed.job.targetPlacement.workerId;
    for (const item of claimed.snapshot.payload.attachments) {
      if (
        await this.repository.chatRelocationJobs.isAttachmentAvailable(
          item.attachment.id,
          targetWorkerId,
        )
      ) {
        continue;
      }
      const sourceWorkerId = [
        item.sourceWorkerId,
        ...item.availableWorkerIds,
      ].find((workerId) => this.bridge.isConnected(workerId));
      if (!sourceWorkerId) {
        throw executionError(
          "attachment-unavailable",
          `No online worker has ${item.attachment.fileName}.`,
          true,
        );
      }
      try {
        await this.bridge.request(targetWorkerId, {
          type: "attachment.upload.begin",
          chatId: claimed.job.chatId,
          attachmentId: item.attachment.id,
          fileName: item.attachment.fileName,
          sizeBytes: item.attachment.sizeBytes,
        });
        let offset = 0;
        let chunkIndex = 0;
        const hash = createHash("sha256");
        while (
          offset < item.attachment.sizeBytes ||
          (item.attachment.sizeBytes === 0 && offset === 0)
        ) {
          const chunk = workerAttachmentReadResultSchema.parse(
            await this.bridge.request(sourceWorkerId, {
              type: "attachment.read",
              chatId: claimed.job.chatId,
              attachmentId: item.attachment.id,
              fileName: item.attachment.fileName,
              offset,
              limit: ATTACHMENT_CHUNK_BYTES,
            }),
          );
          if (chunk.sizeBytes !== item.attachment.sizeBytes) {
            throw new Error("Attachment size changed during relocation.");
          }
          const bytes = Buffer.from(chunk.data, "base64");
          if (
            bytes.byteLength >
            Math.min(
              ATTACHMENT_CHUNK_BYTES,
              Math.max(item.attachment.sizeBytes - offset, 0),
            )
          ) {
            throw new Error("Attachment source returned an oversized chunk.");
          }
          hash.update(bytes);
          if (bytes.byteLength) {
            await this.bridge.request(targetWorkerId, {
              type: "attachment.upload.chunk",
              chatId: claimed.job.chatId,
              attachmentId: item.attachment.id,
              chunkIndex,
              data: bytes.toString("base64"),
            });
            chunkIndex += 1;
          }
          offset += bytes.byteLength;
          if (chunk.eof) {
            if (offset !== item.attachment.sizeBytes) {
              throw new Error("Attachment source truncated the content.");
            }
            break;
          }
          if (bytes.byteLength === 0 || offset >= item.attachment.sizeBytes) {
            throw new Error("Attachment source did not terminate the stream.");
          }
        }
        if (hash.digest("hex") !== item.sha256) {
          throw new Error("Attachment source digest verification failed.");
        }
        const uploaded = workerAttachmentUploadResultSchema.parse(
          await this.bridge.request(targetWorkerId, {
            type: "attachment.upload.complete",
            chatId: claimed.job.chatId,
            attachmentId: item.attachment.id,
          }),
        );
        if (
          uploaded.sha256 !== item.sha256 ||
          uploaded.sizeBytes !== item.attachment.sizeBytes
        ) {
          throw new Error("Target attachment digest verification failed.");
        }
        await this.repository.chatRelocationJobs.markAttachmentAvailable(
          item.attachment.id,
          targetWorkerId,
        );
      } catch (error) {
        await this.bridge
          .request(targetWorkerId, {
            type: "attachment.delete",
            chatId: claimed.job.chatId,
            attachmentId: item.attachment.id,
          })
          .catch(() => undefined);
        if (error instanceof WorkerUnavailableError) throw error;
        throw executionError(
          "attachment-unavailable",
          `Could not transfer ${item.attachment.fileName}: ${error instanceof Error ? error.message : "unknown attachment error"}`,
          true,
        );
      }
    }
  }

  async #selectRuntime(
    claimed: ClaimedChatRelocationJob,
    workerId: string,
    preferredAccountId: string | null,
  ): Promise<ModelRuntime> {
    const settings = await this.repository.getSettings(claimed.ownerId);
    const modelId =
      claimed.snapshot.summary.modelId ?? settings.preferences.defaultModelId;
    if (!modelId) {
      throw executionError(
        "runtime-incompatible",
        "The chat has no selected model and no default model is configured.",
        false,
      );
    }
    const runtimes = await this.repository.getModelRuntimes(
      claimed.ownerId,
      modelId,
    );
    const ordered = [
      ...runtimes.filter(
        (runtime) => runtime.routeId === claimed.snapshot.summary.modelRouteId,
      ),
      ...runtimes.filter(
        (runtime) => runtime.routeId !== claimed.snapshot.summary.modelRouteId,
      ),
    ];
    const unavailable: string[] = [];
    for (const runtime of ordered) {
      if (isAccountProviderKind(runtime.provider.kind)) {
        const accountRouting = await resolveAccountProviderRuntimes({
          bridge: this.bridge,
          logger: this.logger,
          ownerId: claimed.ownerId,
          preferredAccountId,
          repository: this.repository,
          runtime,
          workerId,
        });
        unavailable.push(...accountRouting.unavailable);
        if (accountRouting.runtimes[0]) return accountRouting.runtimes[0];
        continue;
      }
      return runtime;
    }
    throw executionError(
      "runtime-incompatible",
      `No target model route is authenticated and available${unavailable.length ? `: ${unavailable.join("; ")}` : "."}`,
      true,
    );
  }

  async #hydrateTarget(
    claimed: ClaimedChatRelocationJob,
    source: ChatExecutionContext,
    target: ProjectWorktreeExecutionContext,
    runtime: ModelRuntime,
  ): Promise<string> {
    const bytes = encodeChatRelocationPayload(claimed.snapshot.payload);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== claimed.snapshot.summary.transcriptSha256) {
      throw executionError(
        "stale-attempt",
        "The immutable relocation transcript failed server-side digest verification.",
        false,
      );
    }
    const targetContext: ChatExecutionContext = {
      ...source,
      cwd: target.worktree.path,
      isPrimary: target.worktree.isPrimary,
      threadId: null,
      workerId: target.workerId,
      worktreeId: target.worktree.id,
    };
    const mcpServers = await this.repository.listEffectiveMcpServers(
      claimed.ownerId,
      claimed.job.projectId,
    );
    const begin = chatRelocationHydrationBeginResultSchema.parse(
      await this.bridge.request(
        target.workerId,
        {
          type: "chat.relocation.hydration.begin",
          chatId: claimed.job.chatId,
          snapshotId: claimed.snapshot.summary.id,
          transcriptSha256: digest,
          sizeBytes: bytes.byteLength,
          cwd: target.worktree.path,
          requiredSkillNames: requiredSkillNames(claimed),
          planMode: source.planMode,
          model: runtime.model,
          provider: runtime.provider,
          permissionProfileId:
            effectivePermissionProfile(targetContext).effectiveId,
          mcpServers,
        },
        { timeoutMs: 30_000 },
      ),
    );
    if (begin.status === "hydrated") return begin.threadId;
    for (
      let offset = 0, chunkIndex = 0;
      offset < bytes.byteLength;
      offset += HYDRATION_CHUNK_BYTES, chunkIndex += 1
    ) {
      await this.bridge.request(
        target.workerId,
        {
          type: "chat.relocation.hydration.chunk",
          snapshotId: claimed.snapshot.summary.id,
          chunkIndex,
          data: bytes
            .subarray(offset, offset + HYDRATION_CHUNK_BYTES)
            .toString("base64"),
        },
        { timeoutMs: 30_000 },
      );
    }
    const hydrated = chatRelocationHydrationResultSchema.parse(
      await this.bridge.request(
        target.workerId,
        {
          type: "chat.relocation.hydration.complete",
          snapshotId: claimed.snapshot.summary.id,
        },
        { timeoutMs: CHAT_RELOCATION_HYDRATION_TIMEOUT_MS },
      ),
    );
    if (
      hydrated.snapshotId !== claimed.snapshot.summary.id ||
      hydrated.transcriptSha256 !== digest
    ) {
      throw executionError(
        "stale-attempt",
        "The target worker returned hydration state for a different snapshot.",
        false,
      );
    }
    return hydrated.threadId;
  }

  async #releaseSource(
    claimed: ClaimedChatRelocationJob,
    source: ChatExecutionContext,
  ): Promise<void> {
    if (!source.threadId) return;
    const routeId = claimed.snapshot.summary.modelRouteId;
    const runtime = routeId
      ? await this.repository.getModelRuntimeByRoute(claimed.ownerId, routeId)
      : null;
    if (!runtime) {
      throw executionError(
        "runtime-incompatible",
        "The source model route is no longer configured, so its runtime cannot be released safely.",
        false,
      );
    }
    await this.bridge.request(
      source.workerId,
      {
        type: "chat.relocation.thread.release",
        threadId: source.threadId,
        discard: false,
        model: runtime.model,
        provider: runtime.provider,
      },
      { timeoutMs: 30_000 },
    );
  }

  async #releaseTarget(target: {
    runtime: ModelRuntime;
    threadId: string;
    workerId: string;
  }): Promise<void> {
    await this.bridge.request(
      target.workerId,
      {
        type: "chat.relocation.thread.release",
        threadId: target.threadId,
        discard: true,
        model: target.runtime.model,
        provider: target.runtime.provider,
      },
      { timeoutMs: 30_000 },
    );
  }
}
