import {
  agentInteractionAcceptedSchema,
  type AgentInteractionRequest,
  type AgentInteractionResponse,
  type WorkerEvent,
} from "@cantrip/protocol";
import {
  workflowNodeExecutionResultSchema,
  type WorkflowAgentNodeConfiguration,
} from "@cantrip/protocol/workflows";

import {
  LOCAL_USER_ID,
  type ModelRuntime,
  type ServerRepository,
} from "../db/repository.js";
import type {
  WorkflowAttemptLease,
  WorkflowSingleAgentCandidate,
} from "../db/workflow-runs.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../workers/bridge.js";

interface WorkflowExecutorLogger {
  error(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

const MAX_WORKFLOW_PROMPT_LENGTH = 100_000;

class WorkflowProgressPersistenceError extends Error {}

export function workflowAgentPrompt(
  configuration: WorkflowAgentNodeConfiguration,
  structuredInput: unknown,
): string {
  const prompt = configuration.includeStructuredInput
    ? `${configuration.prompt}\n\nStructured workflow input (JSON):\n${JSON.stringify(structuredInput)}`
    : configuration.prompt;
  if (prompt.length > MAX_WORKFLOW_PROMPT_LENGTH) {
    throw new Error(
      `The rendered workflow prompt exceeds ${MAX_WORKFLOW_PROMPT_LENGTH} characters.`,
    );
  }
  return prompt;
}

export class WorkflowExecutor {
  readonly #activeRuns = new Map<string, Promise<void>>();
  readonly #respondingInteractions = new Set<string>();
  #stopping = false;

  constructor(
    private readonly repository: ServerRepository,
    private readonly bridge: WorkerCommandBus,
    private readonly logger: WorkflowExecutorLogger,
  ) {}

  async recoverAfterRestart(): Promise<number> {
    return this.repository.workflowRuns.recoverInterruptedAttempts(
      LOCAL_USER_ID,
    );
  }

  queueRun(runId: string): void {
    if (this.#stopping || this.#activeRuns.has(runId)) return;
    const task = this.executeRun(runId)
      .catch((error: unknown) => {
        this.logger.error(
          { err: error, workflowRunId: runId },
          "Workflow dispatch failed",
        );
      })
      .finally(() => this.#activeRuns.delete(runId));
    this.#activeRuns.set(runId, task);
  }

  async queueAvailableRuns(): Promise<void> {
    if (this.#stopping) return;
    const runIds =
      await this.repository.workflowRuns.listDispatchableRunIds(LOCAL_USER_ID);
    for (const runId of runIds) this.queueRun(runId);
  }

  stop(): void {
    this.#stopping = true;
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.#activeRuns.values());
  }

  async respondToInteraction(
    interaction: AgentInteractionRequest,
    response: AgentInteractionResponse,
  ): Promise<{ accepted: true }> {
    const runId = interaction.provenance.workflowRunId;
    const runNodeId = interaction.provenance.workflowNodeId;
    if (!runId || !runNodeId) {
      throw new Error("The interaction is not attributed to a workflow node.");
    }
    const context =
      await this.repository.workflowRuns.getInteractionExecutionContext(
        LOCAL_USER_ID,
        runId,
        runNodeId,
      );
    if (!context) {
      throw new Error("The workflow attempt is no longer active.");
    }
    if (!this.bridge.isConnected(context.workerId)) {
      throw new WorkerUnavailableError(
        `Worker ${context.workerId} is offline.`,
      );
    }
    const runtime = await this.repository.getModelRuntimeByRoute(
      LOCAL_USER_ID,
      context.modelRouteId,
    );
    if (!runtime) throw new Error("The workflow model route is unavailable.");
    this.#respondingInteractions.add(interaction.requestKey);
    try {
      return agentInteractionAcceptedSchema.parse(
        await this.bridge.request(
          context.workerId,
          {
            type: "agent.interaction.respond",
            requestKey: interaction.requestKey,
            response,
            model: runtime.model,
            provider: runtime.provider,
          },
          { timeoutMs: 30_000 },
        ),
      );
    } catch (error) {
      this.#respondingInteractions.delete(interaction.requestKey);
      throw error;
    }
  }

  finishInteractionResponse(requestKey: string): void {
    this.#respondingInteractions.delete(requestKey);
  }

  private async executeRun(runId: string): Promise<void> {
    while (!this.#stopping) {
      const candidate =
        await this.repository.workflowRuns.getSingleAgentCandidate(
          LOCAL_USER_ID,
          runId,
        );
      if (!candidate) return;
      const source = candidate.projectId
        ? await this.repository.getProjectSource(
            LOCAL_USER_ID,
            candidate.projectId,
          )
        : null;
      if (candidate.projectId && !source) return;
      if (source && !this.bridge.isConnected(source.workerId)) return;
      if (candidate.unsupportedReason || !candidate.configuration || !source) {
        await this.repository.workflowRuns.failUnsupportedRun(
          LOCAL_USER_ID,
          runId,
          candidate.unsupportedReason ??
            "The workflow project source is unavailable.",
        );
        return;
      }
      const runtime = await this.runtimeFor(candidate);
      if (!runtime) {
        await this.repository.workflowRuns.failUnsupportedRun(
          LOCAL_USER_ID,
          runId,
          "The workflow has no available model route.",
        );
        return;
      }
      const lease = await this.repository.workflowRuns.claimSingleAgentAttempt(
        LOCAL_USER_ID,
        candidate,
        {
          cwd: source.cwd,
          modelRouteId: runtime.routeId,
          permissionProfileId: candidate.node.permissionProfileId,
          workerId: source.workerId,
          worktreeId: source.worktreeId,
        },
      );
      if (!lease) return;
      const retry = await this.executeAttempt(
        lease,
        source.cwd,
        source.workerId,
        source.worktreeId,
        runtime,
      );
      if (!retry) return;
    }
  }

  private async executeAttempt(
    lease: WorkflowAttemptLease,
    cwd: string,
    workerId: string,
    worktreeId: string,
    runtime: ModelRuntime,
  ): Promise<boolean> {
    try {
      const rawResult = await this.bridge.request(
        workerId,
        {
          type: "workflow.node.execute",
          workflowRunId: lease.candidate.run.id,
          runNodeId: lease.candidate.node.id,
          attemptId: lease.attemptId,
          idempotencyKey: lease.idempotencyKey,
          worktreeId,
          cwd,
          threadId: lease.candidate.node.codexThreadId,
          prompt: workflowAgentPrompt(
            lease.candidate.configuration!,
            lease.candidate.node.structuredInput,
          ),
          developerInstructions:
            lease.candidate.configuration!.developerInstructions,
          skillNames: lease.candidate.node.permissionManifest.skills,
          outputSchema: lease.candidate.outputSchema,
          mutationMode: "read-only",
          networkAccess: lease.candidate.node.permissionManifest.network,
          approvalMode: lease.candidate.node.permissionManifest.approvalMode,
          permissionProfileId: lease.candidate.node.permissionProfileId,
          timeoutMs: lease.budget.maxNodeDurationMs,
          model: runtime.model,
          provider: runtime.provider,
        },
        {
          timeoutMs: null,
          onEvent: async (event) => {
            try {
              await this.recordWorkerEvent(lease, event, workerId);
            } catch (error) {
              throw new WorkflowProgressPersistenceError(
                error instanceof Error ? error.message : String(error),
              );
            }
          },
        },
      );
      const result = workflowNodeExecutionResultSchema.parse(rawResult);
      await this.repository.workflowRuns.completeSingleAgentAttempt(
        LOCAL_USER_ID,
        lease,
        result,
      );
      return false;
    } catch (error) {
      const failure = await this.repository.workflowRuns.failSingleAgentAttempt(
        LOCAL_USER_ID,
        lease,
        this.failureFrom(error),
      );
      return failure.retryScheduled;
    }
  }

  private async recordWorkerEvent(
    lease: WorkflowAttemptLease,
    event: WorkerEvent,
    workerId: string,
  ): Promise<void> {
    if (event.type === "workflow.node.interaction.requested") {
      try {
        await this.repository.recordAgentInteractionRequest({
          requestKey: event.request.requestKey,
          projectId: lease.candidate.projectId!,
          provenance: {
            chatId: null,
            threadId: event.request.threadId,
            turnId: event.request.turnId,
            itemId: event.request.itemId,
            executionLaneId: null,
            workflowRunId: lease.candidate.run.id,
            workflowNodeId: lease.candidate.node.id,
            workerId,
          },
          payload: event.request.payload,
          expiresAt: event.request.expiresAt,
        });
      } catch (error) {
        await this.cancelWorkerInteraction(
          workerId,
          lease,
          event.request.requestKey,
          "Cantrip could not persist the workflow interaction safely.",
        );
        throw error;
      }
    }
    if (
      event.type === "workflow.node.interaction.cleared" ||
      event.type === "workflow.node.interaction.expired"
    ) {
      if (!this.#respondingInteractions.has(event.requestKey)) {
        await this.repository.workflowRuns.terminalizeWorkflowInteractions(
          lease.candidate.run.id,
          lease.candidate.node.id,
          event.type === "workflow.node.interaction.expired"
            ? "expired"
            : "interrupted",
        );
      }
    }
    try {
      await this.repository.workflowRuns.recordAttemptWorkerEvent(
        LOCAL_USER_ID,
        lease,
        event,
      );
    } catch (error) {
      if (event.type === "workflow.node.interaction.requested") {
        await this.cancelWorkerInteraction(
          workerId,
          lease,
          event.request.requestKey,
          "Cantrip could not persist workflow progress safely.",
        );
      }
      throw error;
    }
  }

  private async cancelWorkerInteraction(
    workerId: string,
    lease: WorkflowAttemptLease,
    requestKey: string,
    reason: string,
  ): Promise<void> {
    const runtime = await this.repository.getModelRuntimeByRoute(
      LOCAL_USER_ID,
      lease.assignment.modelRouteId,
    );
    if (!runtime || !this.bridge.isConnected(workerId)) return;
    try {
      await this.bridge.request(workerId, {
        type: "agent.interaction.cancel",
        requestKey,
        reason,
        model: runtime.model,
        provider: runtime.provider,
      });
    } catch {
      // The original attempt fails closed below.
    }
  }

  private async runtimeFor(
    candidate: WorkflowSingleAgentCandidate,
  ): Promise<ModelRuntime | null> {
    if (candidate.node.modelRouteId) {
      return this.repository.getModelRuntimeByRoute(
        LOCAL_USER_ID,
        candidate.node.modelRouteId,
      );
    }
    const settings = await this.repository.getSettings(LOCAL_USER_ID);
    const modelId = settings.preferences.defaultModelId;
    return modelId
      ? this.repository.getModelRuntime(LOCAL_USER_ID, modelId)
      : null;
  }

  private failureFrom(error: unknown): {
    code: string;
    message: string;
    status: "failed" | "orphaned" | "timed-out";
  } {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof WorkerUnavailableError) {
      return { code: "worker-disconnected", message, status: "orphaned" };
    }
    if (error instanceof WorkflowProgressPersistenceError) {
      return {
        code: "progress-persistence-failed",
        message,
        status: "orphaned",
      };
    }
    if (/timed out/iu.test(message)) {
      return { code: "node-timeout", message, status: "timed-out" };
    }
    return { code: "node-execution-failed", message, status: "failed" };
  }
}
