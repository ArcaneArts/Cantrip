import type {
  CantripMcpBinding,
  WorkerComputerUseApprovalResponseCommand,
} from "@cantrip/protocol";
import {
  cuaAgentAuthoritySchema,
  type CuaAgentAuthority,
} from "@cantrip/protocol/computer-use-agent";
import {
  cuaPreviewAuthoritySchema,
  type CuaPreviewAuthority,
  type CuaPreviewRevocation,
} from "@cantrip/protocol/computer-use-preview";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CodexComputerUseExecution } from "../codex/execution-lifetime.js";
import type { CuaMcpRequest } from "../mcp/cua-contract.js";
import {
  CuaAgentApprovalEvents,
  type CuaAgentApprovalPublisher,
} from "./agent-approval-events.js";
import { CuaApprovalManager } from "./approvals.js";
import { CuaAgentObservations } from "./agent-observations.js";
import { computerUseActivity, type CuaActivityPublisher } from "./activity.js";
import { CuaAuthorizationError } from "./handler.js";
import { waitBeforeCuaSend } from "./cancellation.js";
import type { CuaJavascriptAction } from "./javascript.js";
import { adaptCuaModelImages } from "./model-images.js";
import { CantripCuaService } from "./service.js";
import type {
  ComputerUseOperation,
  CuaSession,
  CuaScope,
  CuaTargetReference,
} from "./types.js";

export interface CuaAgentCommand {
  initialAuthority: CuaAgentAuthority;
  ownerId: string;
  serverId: string;
  workerId: string;
  chatId: string;
  projectId: string | null;
  contextKind: "project" | "standalone";
  placementId: string;
  executionLaneId: string;
  taskId: string | null;
  rootThreadId: string;
  ownsThread(threadId: string): boolean;
  resolve(input: {
    chatId: string;
    threadId: string;
    turnId: string;
  }): CodexComputerUseExecution | null;
  publish: CuaAgentApprovalPublisher;
  /** Existing protected activity queue; metadata enqueue must not await native work. */
  publishActivity?: CuaActivityPublisher;
}
interface Lifetime {
  native: CodexComputerUseExecution;
  scope: CuaScope;
  signal: AbortSignal;
  controller: AbortController;
}
interface Registration {
  command: CuaAgentCommand;
  controller: AbortController;
  authority: CuaAgentAuthority;
  lifetimes: Map<AbortSignal, Lifetime>;
  calls: Set<Promise<unknown>>;
  cancelledThreads: Set<string>;
}
export interface CuaAgentCoordinatorOptions {
  service: CantripCuaService;
  approvals: CuaApprovalManager;
  events: CuaAgentApprovalEvents;
  identity(): { ownerId: string; serverId: string; workerId: string };
  authority(
    binding: CantripMcpBinding,
    signal: AbortSignal,
  ): Promise<CuaAgentAuthority>;
}

const operations: Record<
  CuaJavascriptAction["operation"],
  ComputerUseOperation
> = {
  state: "session.state",
  targets: "targets.list",
  attach: "target.attach",
  snapshot: "observation.snapshot",
  cursor: "session.state",
  configureCursor: "cursor.configure",
  moveCursor: "cursor.move",
  controls: "controls.inspect",
  press: "input.press",
  click: "input.click",
  globalClick: "input.click",
  processClick: "input.click",
  detach: "target.detach",
};

/** Registers actual running commands before any MCP/native/approval activity.
 * Tool metadata selects an observed turn; it cannot create a runtime lifetime. */
export class CuaAgentCoordinator {
  private registrations = new Set<Registration>();
  private closed = false;
  private readonly observations = new CuaAgentObservations();
  constructor(private readonly options: CuaAgentCoordinatorOptions) {}

  register(command: CuaAgentCommand): () => Promise<void> {
    this.identity(command);
    const authority = cuaAgentAuthoritySchema.parse(command.initialAuthority);
    this.identity(authority);
    if (
      authority.chatId !== command.chatId ||
      authority.projectId !== command.projectId ||
      authority.contextKind !== command.contextKind ||
      authority.placementId !== command.placementId ||
      authority.executionLaneId !== command.executionLaneId
    )
      throw new CuaAuthorizationError("ownership-mismatch");
    if (this.closed || this.registrations.size >= 32)
      throw new CuaAuthorizationError("execution-unavailable");
    const record: Registration = {
      command: { ...command },
      controller: new AbortController(),
      authority,
      lifetimes: new Map(),
      calls: new Set(),
      cancelledThreads: new Set(),
    };
    this.registrations.add(record);
    return async () => {
      this.cancel(record);
      try {
        await Promise.allSettled([...record.calls]);
        await this.options.events.drain(record.command.publish);
      } finally {
        this.registrations.delete(record);
      }
    };
  }

  private identity(input: {
    ownerId: string;
    serverId: string;
    workerId: string;
  }) {
    const current = this.options.identity();
    if (
      input.ownerId !== current.ownerId ||
      input.serverId !== current.serverId ||
      input.workerId !== current.workerId
    )
      throw new CuaAuthorizationError("ownership-mismatch");
  }
  private resolve(binding: CantripMcpBinding, request: CuaMcpRequest) {
    if (this.closed) throw new CuaAuthorizationError("execution-unavailable");
    for (const record of this.registrations) {
      const c = record.command;
      if (
        c.chatId !== binding.chatId ||
        c.ownerId !== binding.ownerId ||
        c.workerId !== binding.workerId ||
        c.projectId !== binding.projectId ||
        c.contextKind !== binding.contextKind ||
        c.executionLaneId !== binding.executionLaneId ||
        c.placementId !==
          (binding.contextKind === "project"
            ? binding.worktreeId
            : binding.scratchRootId)
      )
        continue;
      this.identity(c);
      if (
        record.controller.signal.aborted ||
        record.cancelledThreads.has(request.threadId)
      )
        continue;
      const native = c.resolve({
        chatId: c.chatId,
        threadId: request.threadId,
        turnId: request.turnId,
      });
      if (
        !native ||
        native.signal.aborted ||
        native.rootThreadId !== c.rootThreadId ||
        native.chatId !== c.chatId ||
        native.threadId !== request.threadId ||
        native.turnId !== request.turnId
      )
        continue;
      let lifetime = record.lifetimes.get(native.signal);
      if (!lifetime) {
        if (record.lifetimes.size >= 16)
          throw new CuaAuthorizationError("execution-unavailable");
        const controller = new AbortController();
        lifetime = {
          native,
          controller,
          scope: {
            ownerId: c.ownerId,
            serverId: c.serverId,
            workerId: c.workerId,
            chatId: c.chatId,
            taskId: c.taskId,
            threadId: native.threadId,
            turnId: native.turnId,
          },
          signal: AbortSignal.any([
            native.signal,
            record.controller.signal,
            controller.signal,
          ]),
        };
        record.lifetimes.set(native.signal, lifetime);
        const retained = lifetime;
        native.signal.addEventListener(
          "abort",
          () => {
            this.observations.clear(retained);
            this.options.approvals.revokeContext(retained.signal);
            this.options.service.cancelScope(retained.scope);
            record.lifetimes.delete(native.signal);
          },
          { once: true },
        );
      }
      if (lifetime.signal.aborted) continue;
      return { record, lifetime };
    }
    throw new CuaAuthorizationError("execution-unavailable");
  }

  execute(
    binding: CantripMcpBinding,
    request: CuaMcpRequest,
    requestId: string,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    // Snapshot broker claims before a renewal can change its selected lane.
    const claims = structuredClone(binding);
    const { record, lifetime } = this.resolve(claims, request);
    const startedAtMs = Date.now();
    let priorSession: CuaSession | null = null;
    if (record.command.publishActivity) {
      try {
        priorSession = this.options.service.javascriptSession(
          lifetime.scope,
          lifetime.signal,
        );
      } catch {}
    }
    const publishTerminal = (failed: boolean, error?: unknown) => {
      if (!record.command.publishActivity) return;
      let session = priorSession;
      try {
        session =
          this.options.service.javascriptSession(
            lifetime.scope,
            lifetime.signal,
          ) ?? priorSession;
      } catch {}
      record.command.publishActivity(
        computerUseActivity({
          source: "agent-mcp",
          operation: request.operation === "js" ? "js.evaluate" : "js.reset",
          operationId: requestId,
          requestId,
          scope: lifetime.scope,
          session,
          agentScope: lifetime.native.agentScope,
          itemId: request.itemId,
          startedAtMs,
          failed,
          error,
          cancelled: signal.aborted || lifetime.signal.aborted,
        }),
      );
    };
    // Clear before authority refresh or evaluation. Even a failed next call
    // invalidates the prior image, and overlapping calls cannot restore it.
    const token = this.observations.begin(lifetime);
    const work = this.invoke(
      record,
      lifetime,
      claims,
      request,
      requestId,
      signal,
      token,
    ).then(
      (value) => {
        publishTerminal(false);
        return value;
      },
      (error: unknown) => {
        this.observations.clear(lifetime, token);
        publishTerminal(true, error);
        throw error;
      },
    );
    record.calls.add(work);
    void work.finally(() => record.calls.delete(work)).catch(() => {});
    return work;
  }
  private async refresh(
    record: Registration,
    binding: CantripMcpBinding,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const authority = cuaAgentAuthoritySchema.parse(
      await waitBeforeCuaSend(this.options.authority(binding, signal), signal),
    );
    signal.throwIfAborted();
    this.identity(authority);
    const c = record.command;
    if (
      authority.chatId !== c.chatId ||
      authority.projectId !== c.projectId ||
      authority.executionLaneId !== c.executionLaneId ||
      authority.contextKind !== c.contextKind ||
      authority.placementId !== c.placementId ||
      (record.authority &&
        JSON.stringify(record.authority) !== JSON.stringify(authority))
    ) {
      this.cancel(record);
      throw new CuaAuthorizationError("ownership-mismatch");
    }
    record.authority = authority;
    return authority;
  }
  private async invoke(
    record: Registration,
    lifetime: Lifetime,
    binding: CantripMcpBinding,
    request: CuaMcpRequest,
    requestId: string,
    signal: AbortSignal,
    token: symbol,
  ): Promise<CallToolResult> {
    const active = AbortSignal.any([signal, lifetime.signal]);
    await this.refresh(record, binding, active);
    if (request.operation === "js_reset") {
      await waitBeforeCuaSend(
        this.options.service.resetJavascript(lifetime.scope, lifetime.signal),
        active,
      );
      active.throwIfAborted();
      return {
        content: [
          {
            type: "text",
            text: "Computer-use JavaScript state and target attachment reset. No native input was performed.",
          },
        ],
      };
    }
    const result = await this.options.service.evaluateJavascript(
      lifetime.scope,
      request.script,
      {
        executionSignal: lifetime.signal,
        signal: active,
        wallTimeoutMs: 345_000,
        onOperation: record.command.publishActivity
          ? (outcome) => {
              record.command.publishActivity!(
                computerUseActivity({
                  ...outcome,
                  position:
                    outcome.action.operation === "click" ||
                    outcome.action.operation === "globalClick" ||
                    outcome.action.operation === "processClick"
                      ? (outcome.action.point ??
                        outcome.session?.cursor.position ??
                        null)
                      : null,
                  inputMethod:
                    outcome.action.operation === "globalClick"
                      ? "coordinate"
                      : outcome.action.operation === "processClick"
                        ? "process-coordinate"
                        : "accessibility",
                  source: "agent-mcp",
                  operation: operations[outcome.action.operation],
                  operationId: crypto.randomUUID(),
                  requestId,
                  scope: lifetime.scope,
                  agentScope: lifetime.native.agentScope,
                  itemId: request.itemId,
                }),
              );
            }
          : undefined,
        authorize: async (action, callSignal) => {
          const authority = await this.refresh(record, binding, callSignal);
          const state = this.options.service.javascriptSession(
            lifetime.scope,
            lifetime.signal,
          );
          const target: CuaTargetReference | null =
            action.operation === "attach"
              ? action.target
              : state?.target
                ? {
                    targetId: state.target.id,
                    targetGeneration: state.target.generation,
                  }
                : null;
          let key: string | null = null;
          try {
            await this.options.approvals.authorizeAndWait({
              context: {
                scope: lifetime.scope,
                projectId: authority.projectId,
                executionLaneId: authority.executionLaneId,
                profile: authority.profile,
                signal: lifetime.signal,
              },
              operation: operations[action.operation],
              target,
              signal: callSignal,
              publish: async (permission) => {
                key = permission.requestKey;
                await this.options.events.publish(
                  {
                    type: "computer-use.approval.request",
                    operationId: requestId,
                    request: permission,
                  },
                  record.command.publish,
                );
              },
            });
            // Authority may change while an approval is shown, including A-to-B-to-A.
            await this.refresh(record, binding, callSignal);
          } finally {
            if (key) this.options.events.finish(key);
          }
        },
      },
    );
    const images = await adaptCuaModelImages(result.images, active);
    active.throwIfAborted();
    const response: CallToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            value: result.value,
            images: images.map(({ native, model }) => ({ native, model })),
            coordinates:
              "Target-local logical points. For model image pixels use x * logicalWidth / model.width and y * logicalHeight / model.height. Cursor movement never moves the system pointer.",
          }),
        },
        ...images.map((image) => image.content),
      ],
    };
    const image = images.at(-1);
    const sessionSignal = image
      ? this.options.service.javascriptSessionSignal(
          lifetime.scope,
          lifetime.signal,
        )
      : null;
    if (image && sessionSignal) {
      const { executionLaneId: _lane, ...authority } = record.authority;
      this.observations.publish(lifetime, token, {
        authority,
        rootThreadId: record.command.rootThreadId,
        image,
        signal: AbortSignal.any([active, sessionSignal]),
        current: () =>
          this.options.service.javascriptSession(
            lifetime.scope,
            lifetime.signal,
          ),
      });
    }
    return response;
  }

  listObservations(authority: CuaPreviewAuthority) {
    const claims = cuaPreviewAuthoritySchema.parse(authority);
    this.identity(claims);
    return this.observations.list(claims);
  }

  readObservation(authority: CuaPreviewAuthority, sourceId: string) {
    const claims = cuaPreviewAuthoritySchema.parse(authority);
    this.identity(claims);
    return this.observations.read(claims, sourceId);
  }

  async answer(command: WorkerComputerUseApprovalResponseCommand) {
    const context = this.options.approvals.contextForResponse(
      command.requestKey,
    );
    if (!context || context.previewLeaseId || !command.agentAuthority)
      throw new CuaAuthorizationError("execution-unavailable");
    this.identity(command.agentAuthority);
    const record = [...this.registrations].find(
      (r) =>
        !r.controller.signal.aborted &&
        [...r.lifetimes.values()].some(
          (l) => l.signal === context.signal && !l.signal.aborted,
        ),
    );
    if (
      !record ||
      !record.authority ||
      JSON.stringify(cuaAgentAuthoritySchema.parse(command.agentAuthority)) !==
        JSON.stringify(record.authority)
    )
      throw new CuaAuthorizationError("ownership-mismatch");
    return this.options.approvals.answer(command);
  }
  private cancel(record: Registration) {
    record.controller.abort();
    for (const lifetime of record.lifetimes.values()) {
      this.observations.clear(lifetime);
      this.options.approvals.revokeContext(lifetime.signal);
      this.options.service.cancelScope(lifetime.scope);
    }
  }
  cancelChat(chatId: string) {
    for (const r of this.registrations)
      if (r.command.chatId === chatId) this.cancel(r);
  }
  cancelThread(threadId: string) {
    for (const r of this.registrations) {
      if (r.command.rootThreadId === threadId) this.cancel(r);
      else if (r.command.ownsThread(threadId)) {
        // A Stop before a child's first CUA call must also fence that child.
        if (r.cancelledThreads.size >= 64) {
          this.cancel(r);
          continue;
        }
        r.cancelledThreads.add(threadId);
        for (const lifetime of r.lifetimes.values())
          if (lifetime.native.threadId === threadId) {
            this.observations.clear(lifetime);
            lifetime.controller.abort();
            this.options.approvals.revokeContext(lifetime.signal);
            this.options.service.cancelScope(lifetime.scope);
          }
      }
    }
  }
  revoke(input: {
    ownerId: string;
    serverId: string;
    scope: CuaPreviewRevocation;
  }) {
    this.identity({ ...input, workerId: this.options.identity().workerId });
    for (const r of this.registrations) {
      const s = input.scope;
      if (
        s.kind === "chat"
          ? r.command.chatId === s.chatId
          : s.kind === "project"
            ? r.command.projectId === s.projectId
            : r.command.contextKind === s.contextKind &&
              r.authority?.profile.usesDefault
      )
        this.cancel(r);
    }
  }
  disconnect() {
    for (const r of this.registrations) this.cancel(r);
  }
  close() {
    this.closed = true;
    this.disconnect();
  }
}
