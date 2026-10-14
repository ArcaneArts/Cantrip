import type {
  ActiveTurn,
  AdmittedNativeReply,
  AdmittedNativeReplyIdentity,
  AdmittedNativeReplyResponse,
  ManagedNativeGuiCommand,
  NativePendingAgentInteraction,
  NativePendingPlanQuestion,
  RootExecution,
  RpcMessage,
  ServerRequestResolvedParams,
} from "./runtime-types.js";
import type {
  AgentInteractionResponse,
  AgentInteractionRuntimeRequest,
} from "@cantrip/protocol";
import {
  agentInteractionAcceptedSchema,
  pendingPlanQuestionSchema,
} from "@cantrip/protocol";
import { workerLogError, workerLogger } from "../logger.js";
import { publishPendingInteraction } from "./pending-interaction-publication.js";
import {
  agentInteractionRequestFromServerRequest,
  agentInteractionResponseFromNativeResult,
  codexResultForAgentInteraction,
  failClosedAgentInteractionReply,
} from "./interaction-protocol.js";

interface InteractionPorts {
  rootExecution(threadId: string): RootExecution | undefined;
  activeTurnForNotification(
    threadId: string,
    turnId: string,
  ): ActiveTurn | undefined;
  send(message: RpcMessage): void;
  dispatchGuiNativeCommand(
    threadId: string,
    command: ManagedNativeGuiCommand,
  ): Promise<unknown>;
  sessionId(): string;
}

/** Owns pending native replies, publication retries and plan-question lifetimes. */
export class CodexInteractions {
  readonly #pendingAgentInteractions = new Map<
    string,
    NativePendingAgentInteraction
  >();
  readonly #admittedReplyWaiters = new Set<() => void>();
  readonly #pendingPlanQuestions = new Map<string, NativePendingPlanQuestion>();
  constructor(private readonly ports: InteractionPorts) {}

  handleServerRequest(message: RpcMessage, rpcId: number | string): boolean {
    const request = agentInteractionRequestFromServerRequest(
      message.method ?? "",
      message.params,
      `codex:${this.ports.sessionId()}:${typeof rpcId}:${String(rpcId)}`,
    );
    if (request) {
      const active = request.turnId
        ? this.ports.activeTurnForNotification(request.threadId, request.turnId)
        : this.ports.rootExecution(request.threadId)?.active;
      if (!active || (!active.onInteractionRequest && !active.admission)) {
        this.ports.send({
          id: rpcId,
          ...failClosedAgentInteractionReply(
            request.payload.kind,
            "No active Cantrip interaction channel.",
          ),
        });
        return true;
      }

      if (active.interactionMode === "preauthorized") {
        this.ports.send({
          id: rpcId,
          ...failClosedAgentInteractionReply(
            request.payload.kind,
            "Preauthorized agent operations cannot open interactive requests.",
          ),
        });
        return true;
      }

      this.registerAgentInteraction(
        active,
        rpcId,
        request,
        message.method ?? "",
      );
      if (
        request.payload.kind === "userInput" &&
        request.turnId &&
        request.itemId
      ) {
        const question = pendingPlanQuestionSchema.parse({
          id: request.requestKey,
          threadId: request.threadId,
          turnId: request.turnId,
          itemId: request.itemId,
          questions: request.payload.questions,
          createdAt: new Date().toISOString(),
        });
        this.#pendingPlanQuestions.set(question.id, {
          active,
          question,
          requestKey: request.requestKey,
        });
        active.onPlanQuestion?.(question);
      }

      return true;
    }

    return false;
  }

  resolveServerRequest(params: ServerRequestResolvedParams): void {
    const pending = [...this.#pendingAgentInteractions.values()].find(
      (candidate) =>
        candidate.request.threadId === params.threadId &&
        candidate.rpcId === params.requestId,
    );
    if (pending) {
      this.releaseAgentInteraction(pending);
      pending.active.onInteractionCleared?.(pending.request.requestKey);
    }
  }
  clearOnExit(): void {
    for (const pending of [...this.#pendingAgentInteractions.values()]) {
      this.releaseAgentInteraction(pending);
      pending.active.onInteractionCleared?.(pending.request.requestKey);
    }

    this.#pendingAgentInteractions.clear();
    this.#pendingPlanQuestions.clear();
  }

  private admittedReplyPending(
    input: AdmittedNativeReplyIdentity,
  ): NativePendingAgentInteraction | null {
    const execution = this.ports.rootExecution(input.rootThreadId);
    if (
      !execution ||
      execution.rootThreadId !== input.rootThreadId ||
      execution.active.admission?.operationGeneration !==
        input.operationGeneration ||
      execution.active.admission.controller.signal.aborted
    )
      return null;
    return (
      [...this.#pendingAgentInteractions.values()].find(
        (pending) =>
          pending.active === execution.active &&
          pending.rpcId === input.requestId,
      ) ?? null
    );
  }

  pendingAdmittedNativeReply(
    input: AdmittedNativeReplyIdentity,
  ): AdmittedNativeReply | null {
    const pending = this.admittedReplyPending(input);
    return pending
      ? {
          ...input,
          requestKey: pending.request.requestKey,
          requestMethod: pending.requestMethod,
          threadId: pending.request.threadId,
          turnId: pending.request.turnId,
          kind: pending.request.payload.kind,
        }
      : null;
  }

  awaitPendingAdmittedNativeReply(
    input: AdmittedNativeReplyIdentity,
  ): Promise<AdmittedNativeReply> {
    const known = this.pendingAdmittedNativeReply(input);
    if (known) return Promise.resolve(known);
    const active = this.ports.rootExecution(input.rootThreadId)?.active;
    const admission = active?.admission;
    if (
      !admission ||
      admission.operationGeneration !== input.operationGeneration ||
      admission.controller.signal.aborted ||
      admission.resolvedRequestIds.has(
        `${typeof input.requestId}:${input.requestId}`,
      )
    ) {
      return Promise.reject(
        new Error("The native reply operation is no longer current."),
      );
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.#admittedReplyWaiters.delete(observed);
        admission.controller.signal.removeEventListener("abort", aborted);
      };
      const aborted = () => {
        cleanup();
        reject(
          new Error(
            "The native reply operation ended before its request was observed.",
          ),
        );
      };
      const observed = () => {
        const pending = this.pendingAdmittedNativeReply(input);
        if (!pending) return;
        cleanup();
        resolve(pending);
      };
      this.#admittedReplyWaiters.add(observed);
      admission.controller.signal.addEventListener("abort", aborted, {
        once: true,
      });
      observed();
    });
  }

  resolveAdmittedNativeReply(
    input: AdmittedNativeReplyIdentity & {
      response: AdmittedNativeReplyResponse;
    },
  ): { accepted: true } {
    const pending = this.admittedReplyPending(input);
    if (!pending)
      throw new Error(
        "The native reply is no longer pending for this operation.",
      );
    // Consume before transport send. An uncertain failure cannot authorize replay
    // or let a simultaneous GUI/console response win the same native request.
    this.releaseAgentInteraction(pending);
    this.ports.send({ id: pending.rpcId, ...input.response });
    pending.active.onInteractionCleared?.(
      pending.request.requestKey,
      "result" in input.response
        ? agentInteractionResponseFromNativeResult(
            pending.request.payload.kind,
            input.response.result,
          )
        : undefined,
    );
    return { accepted: true };
  }

  async answerAgentInteraction(
    requestKey: string,
    response: AgentInteractionResponse,
  ): Promise<{ accepted: true }> {
    const pending = this.#pendingAgentInteractions.get(requestKey);
    if (!pending) {
      throw new Error("The agent interaction is no longer pending.");
    }

    if (pending.request.payload.kind !== response.kind) {
      throw new Error("The agent interaction response kind does not match.");
    }

    const result = codexResultForAgentInteraction(response);
    await this.ports.dispatchGuiNativeCommand(pending.active.threadId, {
      method: "serverRequest/reply",
      params: { result },
      reply: {
        requestId: pending.rpcId,
        requestMethod: pending.requestMethod,
        turnId: pending.request.turnId,
      },
      dispatch: async () => {
        if (this.#pendingAgentInteractions.get(requestKey) !== pending)
          throw new Error("The agent interaction is no longer pending.");
        this.releaseAgentInteraction(pending);
        this.ports.send({ id: pending.rpcId, result });
        pending.active.onInteractionCleared?.(
          pending.request.requestKey,
          response,
        );
        return { accepted: true };
      },
    });
    return agentInteractionAcceptedSchema.parse({ accepted: true });
  }

  async cancelAgentInteraction(
    requestKey: string,
    reason: string,
  ): Promise<{ accepted: true }> {
    const pending = this.#pendingAgentInteractions.get(requestKey);
    if (!pending) {
      return agentInteractionAcceptedSchema.parse({ accepted: true });
    }

    this.ports.send({
      id: pending.rpcId,
      ...failClosedAgentInteractionReply(pending.request.payload.kind, reason),
    });
    this.releaseAgentInteraction(pending);
    pending.active.onInteractionCleared?.(pending.request.requestKey);
    return agentInteractionAcceptedSchema.parse({ accepted: true });
  }

  clearInteractionsForTurn(active: ActiveTurn, reason: string): void {
    for (const pending of [...this.#pendingAgentInteractions.values()]) {
      if (pending.active !== active) continue;
      try {
        this.ports.send({
          id: pending.rpcId,
          ...failClosedAgentInteractionReply(
            pending.request.payload.kind,
            reason,
          ),
        });
      } catch {
        // The turn or runtime may already be closed.
      }

      this.releaseAgentInteraction(pending);
      active.onInteractionCleared?.(pending.request.requestKey);
    }
  }

  clearInteractionsForAgentTurn(
    active: ActiveTurn,
    threadId: string,
    turnId: string,
    reason: string,
  ): void {
    for (const pending of [...this.#pendingAgentInteractions.values()]) {
      if (
        pending.active !== active ||
        pending.request.threadId !== threadId ||
        pending.request.turnId !== turnId
      ) {
        continue;
      }

      try {
        this.ports.send({
          id: pending.rpcId,
          ...failClosedAgentInteractionReply(
            pending.request.payload.kind,
            reason,
          ),
        });
      } catch {
        // The child turn or runtime may already be closed.
      }

      this.releaseAgentInteraction(pending);
      active.onInteractionCleared?.(pending.request.requestKey);
    }
  }

  private registerAgentInteraction(
    active: ActiveTurn,
    rpcId: number | string,
    request: AgentInteractionRuntimeRequest,
    requestMethod = "",
  ): void {
    const existing = this.#pendingAgentInteractions.get(request.requestKey);
    if (existing) {
      if (existing.rpcId !== rpcId) {
        throw new Error("Agent interaction request key was reused.");
      }

      return;
    }

    let pending: NativePendingAgentInteraction;
    const timeout = setTimeout(
      () => this.expireAgentInteraction(pending),
      Math.max(0, Date.parse(request.expiresAt) - Date.now()),
    );
    timeout.unref();
    pending = { active, request, requestMethod, rpcId, timeout };
    this.#pendingAgentInteractions.set(request.requestKey, pending);
    try {
      for (const observed of [...this.#admittedReplyWaiters]) observed();
      if (active.admission) {
        const metadata = this.pendingAdmittedNativeReply({
          operationGeneration: active.admission.operationGeneration,
          rootThreadId: active.threadId,
          requestId: rpcId,
        });
        const publish = active.onNativeInteractionRequest;
        if (metadata && publish) {
          pending.stopPublication = publishPendingInteraction({
            publish: () => publish(metadata),
            isCurrent: () =>
              this.#pendingAgentInteractions.get(request.requestKey) ===
                pending && !active.admission?.controller.signal.aborted,
            failed: (error, attempt) =>
              workerLogger.event(
                "warn",
                "Native interaction publication will retry",
                {
                  event: "codex.interaction.publication",
                  subsystem: "codex",
                  operation: "publish-pending-interaction",
                  status: "retrying",
                  threadId: request.threadId,
                  turnId: request.turnId ?? undefined,
                  counts: { attempt },
                  error: workerLogError(error),
                },
              ),
          });
        }
      }

      active.onInteractionRequest?.(request);
    } catch (error) {
      this.releaseAgentInteraction(pending);
      throw error;
    }
  }

  private expireAgentInteraction(pending: NativePendingAgentInteraction): void {
    if (
      this.#pendingAgentInteractions.get(pending.request.requestKey) !== pending
    ) {
      return;
    }

    try {
      this.ports.send({
        id: pending.rpcId,
        ...failClosedAgentInteractionReply(
          pending.request.payload.kind,
          "The Cantrip interaction expired before it was answered.",
        ),
      });
    } catch {
      // The runtime may already be unavailable; the request still expires.
    }

    this.releaseAgentInteraction(pending);
    pending.active.onInteractionExpired?.(pending.request.requestKey);
  }

  private releaseAgentInteraction(
    pending: NativePendingAgentInteraction,
  ): void {
    clearTimeout(pending.timeout);
    pending.stopPublication?.();
    if (
      this.#pendingAgentInteractions.get(pending.request.requestKey) !== pending
    )
      return;
    pending.active.admission?.resolvedRequestIds.add(
      `${typeof pending.rpcId}:${pending.rpcId}`,
    );
    this.#pendingAgentInteractions.delete(pending.request.requestKey);
    const planQuestion = this.#pendingPlanQuestions.get(
      pending.request.requestKey,
    );
    if (planQuestion) {
      this.#pendingPlanQuestions.delete(planQuestion.question.id);
      planQuestion.active.onPlanQuestionResolved?.(planQuestion.question.id);
    }
  }
}
