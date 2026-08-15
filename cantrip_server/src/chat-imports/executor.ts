import { createHash } from "node:crypto";

import {
  agentThreadSyncSchema,
  externalChatAttachmentReadResultSchema,
  externalChatReadWorkerResultSchema,
  workerAttachmentUploadResultSchema,
  type ChatImportError,
  type ChatImportJobSummary,
  type ExternalChatAttachment,
} from "@cantrip/protocol";

import { effectivePermissionProfile } from "../chats/execution-helpers.js";
import {
  CanonicalChatHydrationError,
  hydrateCanonicalChat,
} from "../chats/hydration.js";
import {
  ChatImportJobConflictError,
  ChatImportJobStaleAttemptError,
  chatImportAttachmentId,
  type ClaimedChatImportJob,
  type ImportedChatAttachment,
} from "../db/chat-import-jobs.js";
import type {
  ChatExecutionContext,
  ModelRuntime,
  ServerRepository,
} from "../db/repository.js";
import { isAccountProviderKind } from "../models/account-provider.js";
import { resolveAccountProviderRuntimes } from "../models/chatgpt-account-routing.js";
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
const ATTACHMENT_CHUNK_BYTES = 256 * 1_024;
export const CHAT_IMPORT_READ_TIMEOUT_MS = 30 * 60_000;
const REQUIRED_HYDRATION_METHODS = [
  "thread/start",
  "thread/read",
  "thread/inject_items",
  "skills/list",
  "permissionProfile/list",
  "collaborationMode/list",
  "thread/settings/update",
] as const;

function importError(error: unknown): ChatImportError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof WorkerUnavailableError) {
    return {
      code: "worker-offline",
      message:
        "A required worker is offline. The import will resume after it reconnects.",
      retryable: true,
    };
  }
  if (error instanceof CanonicalChatHydrationError) {
    return {
      code:
        error.code === "too-many-skills"
          ? "runtime-incompatible"
          : "source-changed",
      message,
      retryable: false,
    };
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
  if (
    /no selected model|no default model|no target model route|model profile was not found|permission profile|required skills|cannot inject/iu.test(
      message,
    )
  ) {
    return { code: "runtime-incompatible", message, retryable: false };
  }
  if (/no longer belongs|project match|destination worktree/iu.test(message)) {
    return { code: "project-mismatch", message, retryable: false };
  }
  if (/identity changed|invalid thread\/read|safe to import/iu.test(message)) {
    return { code: "source-changed", message, retryable: false };
  }
  if (/not found/iu.test(message)) {
    return { code: "source-not-found", message, retryable: false };
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
          this.queueAvailable();
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
      if (claimed.job.chatId) {
        await this.#hydrate(claimed);
        return;
      }
      await this.#readAndImport(claimed);
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

  async #readAndImport(claimed: ClaimedChatImportJob): Promise<void> {
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
          message: "The source worker no longer supports Codex history import.",
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
    const importedAttachments = await this.#transferAttachments(
      claimed,
      result.transcript.attachments,
    );
    const completed =
      await this.repository.chatImportJobs.completeCanonicalImport(
        claimed.job.id,
        claimed.commandId,
        claimed.job.attempt,
        result.transcript,
        importedAttachments,
      );
    this.onChanged({ ownerId: claimed.ownerId, job: completed });
    if (result.transcript.attachments.length) {
      await this.bridge
        .request(claimed.job.sourceWorkerId, {
          type: "external.chat-history.attachments.release",
          sourceKind: claimed.job.sourceKind,
          sourceId: claimed.job.sourceId,
          sourceThreadId: claimed.job.sourceThreadId,
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { err: error, chatImportJobId: claimed.job.id },
            "Could not release staged external chat attachments",
          );
        });
    }
  }

  async #transferAttachments(
    claimed: ClaimedChatImportJob,
    descriptors: ExternalChatAttachment[],
  ): Promise<ImportedChatAttachment[]> {
    const imported: ImportedChatAttachment[] = [];
    for (const descriptor of descriptors) {
      const id = chatImportAttachmentId(claimed.job.id, descriptor.id);
      if (descriptor.status !== "available") {
        imported.push({ descriptor, id });
        continue;
      }
      if (!this.bridge.isConnected(claimed.job.targetPlacement.workerId)) {
        throw new WorkerUnavailableError("Destination worker is offline.");
      }
      let uploadStarted = false;
      try {
        await this.bridge.request(claimed.job.targetPlacement.workerId, {
          type: "attachment.upload.begin",
          chatId: claimed.job.id,
          attachmentId: id,
          fileName: descriptor.fileName,
          sizeBytes: descriptor.sizeBytes,
        });
        uploadStarted = true;
        const digest = createHash("sha256");
        let offset = 0;
        let chunkIndex = 0;
        let unavailableWarning: string | null = null;
        while (
          offset < descriptor.sizeBytes ||
          (descriptor.sizeBytes === 0 && offset === 0)
        ) {
          const source = externalChatAttachmentReadResultSchema.parse(
            await this.bridge.request(claimed.job.sourceWorkerId, {
              type: "external.chat-history.attachment.read",
              sourceKind: claimed.job.sourceKind,
              sourceId: claimed.job.sourceId,
              sourceThreadId: claimed.job.sourceThreadId,
              attachmentId: descriptor.id,
              offset,
              limit: ATTACHMENT_CHUNK_BYTES,
            }),
          );
          if (source.status === "unavailable") {
            unavailableWarning = source.warning;
            break;
          }
          if (
            source.sizeBytes !== descriptor.sizeBytes ||
            source.sha256 !== descriptor.sha256
          ) {
            unavailableWarning =
              "The attachment changed after the source transcript was read.";
            break;
          }
          const bytes = Buffer.from(source.data, "base64");
          const remaining = descriptor.sizeBytes - offset;
          if (
            bytes.byteLength > Math.min(ATTACHMENT_CHUNK_BYTES, remaining) ||
            (!source.eof && bytes.byteLength === 0)
          ) {
            unavailableWarning =
              "The source worker returned an invalid attachment stream.";
            break;
          }
          digest.update(bytes);
          await this.bridge.request(claimed.job.targetPlacement.workerId, {
            type: "attachment.upload.chunk",
            chatId: claimed.job.id,
            attachmentId: id,
            chunkIndex,
            data: bytes.toString("base64"),
          });
          offset += bytes.byteLength;
          chunkIndex += 1;
          if (source.eof) {
            if (offset !== descriptor.sizeBytes) {
              unavailableWarning = "The source attachment was truncated.";
            }
            break;
          }
          if (offset === descriptor.sizeBytes) {
            unavailableWarning =
              "The source worker did not terminate the attachment stream.";
            break;
          }
        }
        if (
          unavailableWarning ||
          offset !== descriptor.sizeBytes ||
          digest.digest("hex") !== descriptor.sha256
        ) {
          await this.bridge.request(claimed.job.targetPlacement.workerId, {
            type: "attachment.delete",
            chatId: claimed.job.id,
            attachmentId: id,
          });
          uploadStarted = false;
          imported.push({
            id,
            descriptor: {
              ...descriptor,
              status: "missing",
              sha256: null,
              warning:
                unavailableWarning ??
                "The source attachment failed content verification.",
            },
          });
          continue;
        }
        const uploaded = workerAttachmentUploadResultSchema.parse(
          await this.bridge.request(claimed.job.targetPlacement.workerId, {
            type: "attachment.upload.complete",
            chatId: claimed.job.id,
            attachmentId: id,
          }),
        );
        uploadStarted = false;
        if (
          uploaded.sizeBytes !== descriptor.sizeBytes ||
          uploaded.sha256 !== descriptor.sha256
        ) {
          await this.bridge.request(claimed.job.targetPlacement.workerId, {
            type: "attachment.delete",
            chatId: claimed.job.id,
            attachmentId: id,
          });
          throw new Error(
            "The destination worker failed imported attachment verification.",
          );
        }
        imported.push({ descriptor, id });
      } catch (error) {
        if (uploadStarted) {
          await this.bridge
            .request(claimed.job.targetPlacement.workerId, {
              type: "attachment.delete",
              chatId: claimed.job.id,
              attachmentId: id,
            })
            .catch(() => undefined);
        }
        throw error;
      }
    }
    return imported;
  }

  async #hydrate(claimed: ClaimedChatImportJob): Promise<void> {
    const chatId = claimed.job.chatId;
    if (!chatId) {
      throw new ChatImportJobConflictError(
        "Canonical chat state is missing before hydration.",
      );
    }
    const context = await this.repository.getChatExecutionContext(
      claimed.ownerId,
      chatId,
    );
    if (
      !context ||
      context.workerId !== claimed.job.targetPlacement.workerId ||
      context.worktreeId !== claimed.job.targetPlacement.worktreeId
    ) {
      throw new ChatImportJobConflictError(
        "The imported chat destination is no longer available.",
      );
    }
    const worker = await this.repository.getWorker(
      claimed.ownerId,
      context.workerId,
    );
    if (!worker || !this.bridge.isConnected(context.workerId)) {
      throw new WorkerUnavailableError("Destination worker is offline.");
    }
    if (
      worker.codexRuntime.compatibility === "missing" ||
      worker.codexRuntime.compatibility === "incompatible"
    ) {
      const blocked = await this.repository.chatImportJobs.block(
        claimed.job.id,
        claimed.commandId,
        {
          code: "runtime-incompatible",
          message: `${worker.name} does not have a compatible Codex runtime.`,
          retryable: false,
        },
      );
      this.onChanged({ ownerId: claimed.ownerId, job: blocked });
      return;
    }
    const missingMethods = REQUIRED_HYDRATION_METHODS.filter(
      (method) => worker.codexRuntime.methods[method] !== "available",
    );
    if (missingMethods.length) {
      const blocked = await this.repository.chatImportJobs.block(
        claimed.job.id,
        claimed.commandId,
        {
          code: "capability-missing",
          message: `The destination worker cannot hydrate imported chats because Codex methods are unavailable: ${missingMethods.join(", ")}.`,
          retryable: false,
        },
      );
      this.onChanged({ ownerId: claimed.ownerId, job: blocked });
      return;
    }
    const hydration = await this.repository.chatImportJobs.hydrationContext(
      claimed.job.id,
      claimed.commandId,
    );
    if (!hydration) {
      throw new ChatImportJobConflictError(
        "The canonical transcript is no longer available for hydration.",
      );
    }
    const { modelId, runtime } = await this.#selectRuntime(claimed, context);
    const mcpServers = await this.repository.listEffectiveMcpServers(
      claimed.ownerId,
      claimed.job.projectId,
    );
    const hydrated = await hydrateCanonicalChat({
      bridge: this.bridge,
      chatId,
      cwd: context.cwd,
      mcpServers,
      payload: hydration.payload,
      permissionProfileId: effectivePermissionProfile(context).effectiveId,
      planMode: context.planMode,
      runtime,
      snapshotId: claimed.job.id,
      workerId: context.workerId,
    });
    const verified = agentThreadSyncSchema.parse(
      await this.bridge.request(
        context.workerId,
        {
          type: "chat.sync",
          chatId,
          cwd: context.cwd,
          threadId: hydrated.threadId,
          model: runtime.model,
          provider: runtime.provider,
        },
        { timeoutMs: 30_000 },
      ),
    );
    if (verified.threadId !== hydrated.threadId) {
      throw new Error(
        "The managed Codex thread could not be verified after hydration.",
      );
    }
    const completed = await this.repository.chatImportJobs.completeHydration(
      claimed.job.id,
      claimed.commandId,
      claimed.job.attempt,
      {
        threadId: hydrated.threadId,
        modelId,
        modelRouteId: runtime.routeId,
        providerAccountId: runtime.provider.accountId,
      },
    );
    this.onChanged({ ownerId: claimed.ownerId, job: completed });
  }

  async #selectRuntime(
    claimed: ClaimedChatImportJob,
    context: ChatExecutionContext,
  ): Promise<{ modelId: string; runtime: ModelRuntime }> {
    const settings = await this.repository.getSettings(claimed.ownerId);
    const modelId = context.modelId ?? settings.preferences.defaultModelId;
    if (!modelId) {
      throw new Error(
        "The imported chat has no selected model and no default model is configured.",
      );
    }
    const runtimes = await this.repository.getModelRuntimes(
      claimed.ownerId,
      modelId,
      claimed.job.targetModelRouteId ?? undefined,
    );
    const ordered = claimed.job.targetModelRouteId
      ? runtimes
      : [
          ...runtimes.filter(
            (runtime) => runtime.routeId === context.modelRouteId,
          ),
          ...runtimes.filter(
            (runtime) => runtime.routeId !== context.modelRouteId,
          ),
        ];
    const unavailable: string[] = [];
    for (const runtime of ordered) {
      if (isAccountProviderKind(runtime.provider.kind)) {
        const accountRouting = await resolveAccountProviderRuntimes({
          bridge: this.bridge,
          logger: this.logger,
          ownerId: claimed.ownerId,
          preferredAccountId:
            claimed.job.targetProviderAccountId ?? context.providerAccountId,
          repository: this.repository,
          runtime,
          workerId: context.workerId,
        });
        unavailable.push(...accountRouting.unavailable);
        if (accountRouting.runtimes[0]) {
          return { modelId, runtime: accountRouting.runtimes[0] };
        }
        continue;
      }
      return { modelId, runtime };
    }
    throw new Error(
      `No target model route is authenticated and available${unavailable.length ? `: ${unavailable.join("; ")}` : "."}`,
    );
  }
}
