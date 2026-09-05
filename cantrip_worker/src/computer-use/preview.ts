import { randomUUID } from "node:crypto";
import type {
  WorkerComputerUseApprovalResponseCommand,
  WorkerComputerUseCommand,
} from "@cantrip/protocol";
import {
  cuaPreviewStoppedSchema,
  cuaPreviewAuthoritySchema,
  type CuaApprovalRequestEvent,
  type CuaApprovalTerminal,
  type CuaPreviewAuthority,
  type CuaPreviewBinding,
  type CuaPreviewLease,
  type CuaPreviewRevocation,
} from "@cantrip/protocol/computer-use-preview";
import type {
  ComputerUseChunkEvent,
  CuaScope,
  CuaSession,
  CuaTargetReference,
} from "@cantrip/protocol/computer-use";
import type { WorkerEndpointEncryptionService } from "../endpoint-content-encryption.js";
import { CuaApprovalManager } from "./approvals.js";
import {
  CuaAuthorizationError,
  handleComputerUseOperation,
} from "./handler.js";
import { CantripCuaService, CuaServiceError } from "./service.js";
import { waitBeforeCuaSend } from "./cancellation.js";
import { CuaProcessError } from "./errors.js";
import type { CuaAgentCoordinator } from "./agent.js";
import { computerUseActivity, type CuaActivity } from "./activity.js";
import type { ComputerUseActivityEvent } from "@cantrip/protocol";

export type CuaPreviewEvent =
  | ComputerUseChunkEvent
  | CuaApprovalRequestEvent
  | CuaApprovalTerminal
  | ComputerUseActivityEvent;
interface Preview {
  contentDomain: "chat" | "task";
  id: string;
  authority: CuaPreviewAuthority;
  fingerprint: string;
  controller: AbortController;
  scope: CuaScope;
  sessionId: string | null;
  sessionQueue: Promise<void>;
  queuedOpens: number;
}
export interface CuaPreviewCoordinatorOptions {
  workerId: string;
  encryption: WorkerEndpointEncryptionService & { serverIdentity(): string };
  service: CantripCuaService;
  approvals: CuaApprovalManager;
  agentObservations?: Pick<
    CuaAgentCoordinator,
    "listObservations" | "readObservation"
  >;
  /** Trusted Stop/authority revocation reaches agent lifetimes, even without sessions. */
  onRevokeChat?: (chatId: string) => void;
  publishActivity?: (
    activity: CuaActivity,
    contentDomain: "chat" | "task",
    emit: (event: ComputerUseActivityEvent) => Promise<void>,
  ) => Promise<void>;
}

/** One worker-owned lifetime per chat preview. Native session/turn identities
 * remain distinct: an idle observer never fabricates a running agent turn. */
export class CuaPreviewCoordinator {
  private previews = new Map<string, Preview>();
  private byChat = new Map<string, Preview>();
  private closed = false;
  constructor(private readonly options: CuaPreviewCoordinatorOptions) {}

  status() {
    return { previews: this.previews.size, closed: this.closed };
  }

  open(
    input: CuaPreviewAuthority,
    contentDomain: "chat" | "task" = "chat",
  ): CuaPreviewLease {
    if (this.closed) throw new CuaAuthorizationError("execution-unavailable");
    const authority = this.authority(input);
    const fingerprint = JSON.stringify(authority);
    const prior = this.byChat.get(authority.chatId);
    if (prior) {
      if (prior.contentDomain !== contentDomain)
        throw new CuaAuthorizationError("ownership-mismatch");
      if (authority.generation < prior.authority.generation)
        throw new CuaAuthorizationError("ownership-mismatch");
      if (fingerprint === prior.fingerprint) return this.publicLease(prior);
      if (authority.generation === prior.authority.generation)
        throw new CuaAuthorizationError("ownership-mismatch");
      this.revokeChatPreview(prior);
    }
    if (this.previews.size >= 32)
      throw new CuaAuthorizationError("execution-unavailable");
    const preview: Preview = {
      contentDomain,
      id: randomUUID(),
      authority,
      fingerprint,
      controller: new AbortController(),
      sessionId: null,
      sessionQueue: Promise.resolve(),
      queuedOpens: 0,
      scope: {
        ownerId: authority.ownerId,
        serverId: authority.serverId,
        workerId: authority.workerId,
        chatId: authority.chatId,
        taskId: null,
        threadId: null,
        turnId: null,
      },
    };
    this.previews.set(preview.id, preview);
    this.byChat.set(authority.chatId, preview);
    return this.publicLease(preview);
  }

  async execute(
    command: WorkerComputerUseCommand,
    emit: (event: CuaPreviewEvent) => Promise<void>,
  ) {
    if (
      !command.preview ||
      command.request.previewLeaseId !== command.preview.leaseId
    )
      throw new CuaAuthorizationError("ownership-mismatch");
    const preview = this.resolve(command.preview);
    if (
      command.serverId !== preview.scope.serverId ||
      command.chatId !== preview.scope.chatId ||
      command.executionLaneId !== null
    )
      throw new CuaAuthorizationError("ownership-mismatch");
    return handleComputerUseOperation(command, emit, {
      workerId: this.options.workerId,
      service: this.options.service,
      encryption: this.options.encryption,
      publishActivity: this.options.publishActivity
        ? (activity) => this.publishActivity(preview, activity, emit)
        : undefined,
      agentObservations: this.options.agentObservations
        ? {
            list: () =>
              this.options.agentObservations!.listObservations(
                preview.authority,
              ),
            read: (sourceId) =>
              this.options.agentObservations!.readObservation(
                preview.authority,
                sourceId,
              ),
          }
        : undefined,
      openSession: (scope, target, signal) =>
        this.openSession(preview, scope, target, signal),
      resolveExecution: async () => ({
        scope: preview.scope,
        executionLaneId: null,
        signal: preview.controller.signal,
      }),
      authorize: async ({ action }) => {
        const decision = await this.options.approvals.authorize({
          context: {
            scope: preview.scope,
            projectId: preview.authority.projectId,
            executionLaneId: null,
            profile: preview.authority.profile,
            signal: preview.controller.signal,
            previewLeaseId: preview.id,
          },
          operation: action.operation,
          target:
            "targetId" in action
              ? {
                  targetId: action.targetId,
                  targetGeneration: action.targetGeneration,
                }
              : null,
        });
        if (decision.status === "allowed") return;
        await emit({
          type: "computer-use.approval.request",
          operationId: command.request.operationId,
          request: decision.request,
        });
        // A terminal notification may race the initial database insert. The
        // ordered event after publication closes that gap without replaying.
        if (
          preview.controller.signal.aborted ||
          Date.now() >= Date.parse(decision.request.expiresAt!)
        ) {
          await emit({
            type: "computer-use.approval.terminal",
            chatId: preview.scope.chatId,
            requestKey: decision.request.requestKey,
            status: preview.controller.signal.aborted
              ? "interrupted"
              : "expired",
          });
        }
        throw new CuaAuthorizationError("approval-required");
      },
    });
  }

  async answer(command: WorkerComputerUseApprovalResponseCommand) {
    const context = this.options.approvals.contextForResponse(
      command.requestKey,
    );
    if (!context?.previewLeaseId || !command.previewAuthority)
      throw new CuaAuthorizationError("execution-unavailable");
    this.resolve({
      leaseId: context.previewLeaseId,
      authority: command.previewAuthority,
    });
    return this.options.approvals.answer(command);
  }

  stop(
    input: {
      ownerId: string;
      serverId: string;
      chatId: string;
      leaseId: string;
      operationId?: string;
    },
    emit?: (event: ComputerUseActivityEvent) => Promise<void>,
  ) {
    const startedAtMs = Date.now();
    this.identity(input.ownerId, input.serverId);
    const preview = this.previews.get(input.leaseId);
    // Idempotent Stop never creates a lease or starts the helper.
    if (!preview) return { closed: true as const };
    if (
      preview.scope.chatId !== input.chatId ||
      preview.scope.ownerId !== input.ownerId
    )
      throw new CuaAuthorizationError("ownership-mismatch");
    let session = null;
    try {
      session = preview.sessionId
        ? this.options.service.state(preview.scope, preview.sessionId)
        : null;
    } catch {}
    this.revokeChatPreview(preview);
    if (this.options.publishActivity && emit) {
      if (!input.operationId)
        throw new Error(
          "Computer-use Stop activity correlation is unavailable.",
        );
      const activity = computerUseActivity({
        source: "user-preview",
        operation: "preview.stop",
        operationId: input.operationId,
        requestId: null,
        scope: preview.scope,
        session,
        startedAtMs,
      });
      // Stop already happened and owns no pixels. Encryption/publication errors
      // are surfaced without delaying or rolling back revocation.
      return this.publishActivity(preview, activity, emit).then(
        () => cuaPreviewStoppedSchema.parse({ closed: true }),
        () =>
          cuaPreviewStoppedSchema.parse({
            closed: true,
            activityPublicationFailed: true,
          }),
      );
    }
    return { closed: true as const };
  }

  private publishActivity(
    preview: Preview,
    activity: CuaActivity,
    emit: (event: ComputerUseActivityEvent) => Promise<void>,
  ) {
    return this.options.publishActivity!(
      {
        ...activity,
        binding: {
          ...activity.binding,
          taskId:
            preview.contentDomain === "task" ? preview.scope.chatId : null,
        },
      },
      preview.contentDomain,
      emit,
    );
  }

  revoke(input: {
    ownerId: string;
    serverId: string;
    scope: CuaPreviewRevocation;
  }) {
    this.identity(input.ownerId, input.serverId);
    for (const preview of this.previews.values()) {
      const scope = input.scope;
      if (
        scope.kind === "chat"
          ? preview.authority.chatId === scope.chatId
          : scope.kind === "project"
            ? preview.authority.projectId === scope.projectId
            : preview.authority.contextKind === scope.contextKind &&
              preview.authority.profile.usesDefault
      )
        this.revokeChatPreview(preview);
    }
    return { closed: true as const };
  }
  cancelChat(chatId: string) {
    const preview = this.byChat.get(chatId);
    if (preview) this.revokeChatPreview(preview);
  }
  disconnect() {
    for (const preview of this.previews.values()) this.remove(preview);
  }
  close() {
    this.closed = true;
    this.disconnect();
  }

  private resolve(binding: CuaPreviewBinding) {
    if (this.closed) throw new CuaAuthorizationError("execution-unavailable");
    const authority = this.authority(binding.authority);
    const preview = this.previews.get(binding.leaseId);
    if (!preview || preview.scope.chatId !== authority.chatId)
      throw new CuaAuthorizationError("execution-unavailable");
    if (JSON.stringify(authority) !== preview.fingerprint) {
      // A stale packet must not revoke a newer valid authority lifetime.
      if (authority.generation >= preview.authority.generation)
        this.remove(preview);
      throw new CuaAuthorizationError("ownership-mismatch");
    }
    return preview;
  }
  private openSession(
    preview: Preview,
    scope: CuaScope,
    target: CuaTargetReference,
    signal?: AbortSignal,
  ): Promise<CuaSession> {
    if (preview.queuedOpens >= 32)
      return Promise.reject(new CuaServiceError("capacity"));
    const active = signal
      ? AbortSignal.any([signal, preview.controller.signal])
      : preview.controller.signal;
    const previous = preview.sessionQueue;
    preview.queuedOpens += 1;
    const work = (async () => {
      await waitBeforeCuaSend(previous, active);
      if (active.aborted) throw new CuaProcessError("cancelled", "not-sent");
      // Full owner/server/worker/chat/task/thread/turn checks remain inside the
      // service. Reattach validates the actual target and preserves its cursor.
      if (preview.sessionId)
        return this.options.service.attach(
          scope,
          preview.sessionId,
          target,
          active,
        );
      const session = await this.options.service.open(scope, target, active);
      // Stop may race an already-resolved native operation. Its service-level
      // cancellation has invalidated that handle; never repopulate a closed lease.
      if (active.aborted) throw new CuaProcessError("cancelled", "unknown");
      preview.sessionId = session.binding.sessionId;
      return session;
    })();
    preview.sessionQueue = work.then(
      () => {},
      () => {},
    );
    return work.finally(() => {
      preview.queuedOpens -= 1;
    });
  }
  private authority(input: CuaPreviewAuthority) {
    const authority = cuaPreviewAuthoritySchema.parse(input);
    this.identity(authority.ownerId, authority.serverId);
    if (authority.workerId !== this.options.workerId)
      throw new CuaAuthorizationError("ownership-mismatch");
    return authority;
  }
  private identity(ownerId: string, serverId: string) {
    if (
      ownerId !== this.options.encryption.ownerId() ||
      serverId !== this.options.encryption.serverIdentity()
    )
      throw new CuaAuthorizationError("ownership-mismatch");
  }
  private publicLease(preview: Preview): CuaPreviewLease {
    return {
      leaseId: preview.id,
      workerId: preview.scope.workerId,
      chatId: preview.scope.chatId,
      contentDomain: preview.contentDomain,
      generation: preview.authority.generation,
    };
  }
  private remove(preview: Preview) {
    if (this.previews.get(preview.id) !== preview) return;
    this.previews.delete(preview.id);
    this.byChat.delete(preview.scope.chatId);
    preview.controller.abort();
    this.options.approvals.revokeContext(preview.controller.signal);
    this.options.service.cancelScope(preview.scope);
  }
  /** Explicit Stop, trusted policy/placement revocation and chat interruption
   * remain chat-wide. Ordinary preview cleanup must not own agent lifetimes. */
  private revokeChatPreview(preview: Preview) {
    this.options.onRevokeChat?.(preview.scope.chatId);
    this.remove(preview);
    this.options.approvals.revokeChat(preview.scope.chatId);
    this.options.service.cancelChat(preview.scope.chatId);
  }
}
