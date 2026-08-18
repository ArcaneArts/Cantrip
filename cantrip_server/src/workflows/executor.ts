import { AsyncLocalStorage } from "node:async_hooks";

import {
  agentInteractionAcceptedSchema,
  worktreeStatusResultSchema,
  type AgentInteractionRequest,
  type AgentInteractionResponse,
  type WorkerEvent,
} from "@cantrip/protocol";
import {
  workflowFolderProducedChangesSchema,
  workflowNodeExecutionResultSchema,
  type WorkflowAgentNodeConfiguration,
  type WorkflowGateDecision,
  type WorkflowNodeRetry,
  type WorkflowRunCancel,
  type WorkflowRunDetail,
  type WorkflowRunPause,
  type WorkflowRunResume,
} from "@cantrip/protocol/workflows";
import { cantripVersion } from "@cantrip/version";

import {
  LOCAL_USER_ID,
  type ModelRuntime,
  type ServerRepository,
} from "../db/repository.js";
import type {
  WorkflowAttemptLease,
  WorkflowAgentCandidate,
  WorkflowCancellationExecutionContext,
  WorkflowChangeCheckpoint,
} from "../db/workflow-runs.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../workers/bridge.js";
import type { ProjectWorktreeCoordinator } from "../worktrees/coordinator.js";
import { evaluateWorkflowPredicate } from "./values.js";

interface WorkflowExecutorLogger {
  debug?(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
  info?(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface WorkflowRunLiveChange {
  ownerId: string;
  projectId: string | null;
  resource: "workflow-gate" | "workflow-node" | "workflow-run";
  revision: number | null;
  runId: string;
}

const MAX_WORKFLOW_PROMPT_LENGTH = 100_000;
const ATTEMPT_HEARTBEAT_INTERVAL_MS = 30_000;
const ATTEMPT_RECOVERY_SWEEP_INTERVAL_MS = 30_000;
export const WORKFLOW_ATTEMPT_STALE_MS = 2 * 60_000;
const MAX_WORKER_REQUEST_TIMEOUT_MS = 24 * 60 * 60_000;

class WorkflowProgressPersistenceError extends Error {}
class WorkflowVerificationError extends Error {}

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
  readonly #ownerContext = new AsyncLocalStorage<string>();
  readonly #rerunRequested = new Set<string>();
  readonly #respondingInteractions = new Set<string>();
  #recoveryTimer: ReturnType<typeof setInterval> | null = null;
  #recoverySweepRunning = false;
  #stopping = false;

  constructor(
    private readonly repository: ServerRepository,
    private readonly bridge: WorkerCommandBus,
    private readonly worktreeCoordinator: ProjectWorktreeCoordinator,
    private readonly logger: WorkflowExecutorLogger,
    private readonly onRunChanged: (
      change: WorkflowRunLiveChange,
    ) => void = () => undefined,
  ) {}

  #ownerId(): string {
    return this.#ownerContext.getStore() ?? LOCAL_USER_ID;
  }

  private notifyRunChanged(
    runId: string,
    projectId: string | null,
    resource: WorkflowRunLiveChange["resource"] = "workflow-run",
    revision: number | null = null,
  ): void {
    this.onRunChanged({
      ownerId: this.#ownerId(),
      projectId,
      resource,
      revision,
      runId,
    });
  }

  async recoverAfterRestart(
    recoverInterruptedAttempts = true,
  ): Promise<number> {
    const recovered = recoverInterruptedAttempts
      ? await this.repository.workflowRuns.recoverInterruptedAttempts(null)
      : [];
    this.notifyRecoveryChanges(recovered);
    await this.interruptRecoveryChanges(recovered);
    try {
      await this.recoverWorktreeLeases();
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Workflow worktree recovery scan could not complete during startup",
      );
    }
    this.logger.info?.(
      {
        event: "workflow.recovery.completed",
        subsystem: "workflow",
        operation: "recovery",
        status: "completed",
        counts: { recoveredRuns: recovered.length },
      },
      "Workflow restart recovery completed",
    );
    return recovered.length;
  }

  private notifyRecoveryChanges(
    changes: Array<{
      interruptions: WorkflowCancellationExecutionContext[];
      ownerId: string;
      projectId: string | null;
      runId: string;
    }>,
  ): void {
    for (const change of changes) {
      this.#ownerContext.run(change.ownerId, () => {
        this.notifyRunChanged(change.runId, change.projectId, "workflow-node");
      });
    }
  }

  private async interruptRecoveryChanges(
    changes: Array<{
      interruptions: WorkflowCancellationExecutionContext[];
      ownerId: string;
    }>,
  ): Promise<void> {
    await Promise.all(
      changes.map((change) =>
        this.#ownerContext.run(change.ownerId, () =>
          this.interruptExecutions(
            change.interruptions,
            "Workflow recovery was persisted but stale runtime interruption failed",
          ),
        ),
      ),
    );
  }

  startRecoverySweep(): void {
    if (this.#recoveryTimer || this.#stopping) return;
    this.#recoveryTimer = setInterval(() => {
      if (this.#recoverySweepRunning) return;
      this.#recoverySweepRunning = true;
      void this.repository.workflowRuns
        .recoverInterruptedAttempts(null, WORKFLOW_ATTEMPT_STALE_MS)
        .then(async (recovered) => {
          if (recovered.length === 0) return;
          this.notifyRecoveryChanges(recovered);
          await this.interruptRecoveryChanges(recovered);
          this.logger.warn(
            { recoveredWorkflowRuns: recovered.length },
            "Recovered stale workflow attempt leases",
          );
          await this.recoverWorktreeLeases();
          await this.queueAvailableRuns();
        })
        .catch((error: unknown) => {
          this.logger.error(
            { err: error },
            "Could not recover stale workflow attempt leases",
          );
        })
        .finally(() => {
          this.#recoverySweepRunning = false;
        });
    }, ATTEMPT_RECOVERY_SWEEP_INTERVAL_MS);
    this.#recoveryTimer.unref();
  }

  async recoverWorktreeLeases(workerId: string | null = null): Promise<number> {
    const candidates =
      await this.repository.workflowRuns.listRecoverableWorktreeLeases(
        null,
        workerId,
      );
    let resumed = 0;
    await Promise.all(
      candidates.map((candidate) =>
        this.#ownerContext.run(candidate.ownerId, async () => {
          if (!this.bridge.isConnected(candidate.workerId)) return;
          try {
            if (candidate.pendingOutcomeRequest) {
              const resolved =
                await this.worktreeCoordinator.resolveWorkflowLane(
                  candidate.ownerId,
                  candidate.runId,
                  candidate.leaseId,
                  candidate.pendingOutcomeRequest,
                );
              if (resolved) {
                resumed += 1;
                this.notifyRunChanged(
                  candidate.runId,
                  candidate.projectId,
                  "workflow-node",
                );
              }
              return;
            }
            this.queueRun(candidate.runId, candidate.ownerId);
            resumed += 1;
          } catch (error) {
            this.logger.warn(
              {
                err: error,
                workflowRunId: candidate.runId,
                workflowWorktreeLeaseId: candidate.leaseId,
                workerId: candidate.workerId,
              },
              "Workflow worktree recovery could not complete",
            );
          }
        }),
      ),
    );
    return resumed;
  }

  queueRun(runId: string, ownerId = this.#ownerId()): void {
    if (this.#stopping) return;
    const runKey = `${ownerId}\0${runId}`;
    if (this.#activeRuns.has(runKey)) {
      this.#rerunRequested.add(runKey);
      this.logger.debug?.(
        {
          event: "workflow.run.requeued",
          subsystem: "workflow",
          operation: "queue",
          status: "queued",
          runId,
        },
        "Workflow run requested another dispatch pass",
      );
      return;
    }
    this.logger.debug?.(
      {
        event: "workflow.run.queued",
        subsystem: "workflow",
        operation: "queue",
        status: "queued",
        runId,
      },
      "Workflow run queued",
    );
    const task = this.#ownerContext
      .run(ownerId, () => this.executeRun(runId))
      .catch((error: unknown) => {
        this.logger.error(
          { err: error, workflowRunId: runId },
          "Workflow dispatch failed",
        );
      })
      .finally(() => {
        this.#activeRuns.delete(runKey);
        if (this.#rerunRequested.delete(runKey)) this.queueRun(runId, ownerId);
      });
    this.#activeRuns.set(runKey, task);
  }

  async queueAvailableRuns(): Promise<void> {
    if (this.#stopping) return;
    const runs = await this.repository.workflowRuns.listDispatchableRuns();
    if (runs.length > 0) {
      this.logger.info?.(
        {
          event: "workflow.dispatch.discovered",
          subsystem: "workflow",
          operation: "dispatch",
          status: "queued",
          counts: { runs: runs.length },
        },
        "Dispatchable workflow runs discovered",
      );
    }
    for (const run of runs) this.queueRun(run.runId, run.ownerId);
  }

  async cancelRun(
    ownerId: string,
    runId: string,
    input: WorkflowRunCancel,
  ): Promise<WorkflowRunDetail | null> {
    return this.#ownerContext.run(ownerId, async () => {
      const requested = await this.repository.workflowRuns.requestCancellation(
        this.#ownerId(),
        runId,
        input,
      );
      if (requested) {
        this.notifyRunChanged(
          runId,
          requested.run.run.projectId,
          "workflow-run",
        );
      }
      if (requested) {
        this.logger.info?.(
          {
            event: "workflow.run.cancel_requested",
            subsystem: "workflow",
            operation: "cancel",
            status: "accepted",
            runId,
            projectId: requested.run.run.projectId,
            counts: { activeExecutions: requested.executions.length },
          },
          "Workflow cancellation requested",
        );
      }
      if (!requested?.executions.length || requested.replayed) {
        return requested?.run ?? null;
      }
      await this.interruptExecutions(
        requested.executions,
        "Workflow cancellation was persisted but runtime interruption failed",
      );
      return (
        (await this.repository.workflowRuns.getRun(this.#ownerId(), runId)) ??
        requested.run
      );
    });
  }

  async pauseRun(
    ownerId: string,
    runId: string,
    input: WorkflowRunPause,
  ): Promise<WorkflowRunDetail | null> {
    return this.#ownerContext.run(ownerId, async () => {
      const run = await this.repository.workflowRuns.pauseRun(
        this.#ownerId(),
        runId,
        input,
      );
      if (run) this.notifyRunChanged(runId, run.run.projectId, "workflow-run");
      if (run) {
        this.logger.info?.(
          {
            event: "workflow.run.paused",
            subsystem: "workflow",
            operation: "pause",
            status: "completed",
            runId,
            projectId: run.run.projectId,
          },
          "Workflow run paused",
        );
      }
      return run;
    });
  }

  async resumeRun(
    ownerId: string,
    runId: string,
    input: WorkflowRunResume,
  ): Promise<WorkflowRunDetail | null> {
    return this.#ownerContext.run(ownerId, async () => {
      const run = await this.repository.workflowRuns.resumeRun(
        this.#ownerId(),
        runId,
        input,
      );
      if (run && !["completed", "failed"].includes(run.run.status)) {
        this.queueRun(runId);
      }
      if (run) this.notifyRunChanged(runId, run.run.projectId, "workflow-run");
      if (run) {
        this.logger.info?.(
          {
            event: "workflow.run.resumed",
            subsystem: "workflow",
            operation: "resume",
            status: "completed",
            runId,
            projectId: run.run.projectId,
          },
          "Workflow run resumed",
        );
      }
      return run;
    });
  }

  private async interruptExecutions(
    executions: WorkflowCancellationExecutionContext[],
    failureMessage: string,
  ): Promise<void> {
    await Promise.all(
      executions.map(async (execution) => {
        const runtime = await this.repository.getModelRuntimeByRoute(
          this.#ownerId(),
          execution.modelRouteId,
        );
        if (!runtime || !this.bridge.isConnected(execution.workerId)) return;
        try {
          await this.bridge.request(
            execution.workerId,
            {
              type: "workflow.node.interrupt",
              workflowRunId: execution.runId,
              runNodeId: execution.runNodeId,
              attemptId: execution.attemptId,
              threadId: execution.threadId,
              model: runtime.model,
              provider: runtime.provider,
            },
            { timeoutMs: 30_000 },
          );
        } catch (error) {
          this.logger.warn(
            {
              err: error,
              workflowRunId: execution.runId,
              workflowRunNodeId: execution.runNodeId,
            },
            failureMessage,
          );
        }
      }),
    );
  }

  async retryNode(
    ownerId: string,
    runId: string,
    runNodeId: string,
    input: WorkflowNodeRetry,
  ): Promise<WorkflowRunDetail | null> {
    return this.#ownerContext.run(ownerId, async () => {
      const run = await this.repository.workflowRuns.retryNode(
        this.#ownerId(),
        runId,
        runNodeId,
        input,
      );
      if (run) {
        this.notifyRunChanged(runId, run.run.projectId, "workflow-node");
        this.queueRun(runId);
      }
      return run;
    });
  }

  async decideGate(
    ownerId: string,
    runId: string,
    gateId: string,
    input: WorkflowGateDecision,
  ): Promise<WorkflowRunDetail | null> {
    return this.#ownerContext.run(ownerId, async () => {
      const result = await this.repository.workflowRuns.decideGate(
        this.#ownerId(),
        runId,
        gateId,
        input,
      );
      if (result) {
        this.notifyRunChanged(runId, result.run.run.projectId, "workflow-gate");
        this.queueRun(runId);
      }
      return result?.run ?? null;
    });
  }

  async expireGates(now = new Date()): Promise<number> {
    const runIds = await this.repository.workflowRuns.expirePendingGates(
      this.#ownerId(),
      now,
    );
    for (const runId of runIds) {
      const run = await this.repository.workflowRuns.getRun(
        this.#ownerId(),
        runId,
      );
      if (run) {
        this.notifyRunChanged(runId, run.run.projectId, "workflow-gate");
      }
      this.queueRun(runId);
    }
    return runIds.length;
  }

  stop(): void {
    this.#stopping = true;
    if (this.#recoveryTimer) {
      clearInterval(this.#recoveryTimer);
      this.#recoveryTimer = null;
    }
    this.logger.info?.(
      {
        event: "workflow.executor.stopping",
        subsystem: "workflow",
        operation: "shutdown",
        status: "started",
        counts: { activeRuns: this.#activeRuns.size },
      },
      "Workflow executor stopping",
    );
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.#activeRuns.values());
  }

  async respondToInteraction(
    ownerId: string,
    interaction: AgentInteractionRequest,
    response: AgentInteractionResponse,
  ): Promise<{ accepted: true }> {
    const runId = interaction.provenance.workflowRunId;
    const runNodeId = interaction.provenance.workflowNodeId;
    if (!runId || !runNodeId) {
      throw new Error("The interaction is not attributed to a workflow node.");
    }
    const threadId = interaction.provenance.threadId;
    if (!threadId) {
      throw new Error("The interaction is not attributed to a Codex thread.");
    }
    const context =
      await this.repository.workflowRuns.getInteractionExecutionContext(
        ownerId,
        runId,
        runNodeId,
        threadId,
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
      ownerId,
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
    const startedAtMs = Date.now();
    const initial = await this.repository.workflowRuns.getRun(
      this.#ownerId(),
      runId,
    );
    if (!initial) return;
    const projectId = initial.run.projectId;
    this.logger.info?.(
      {
        event: "workflow.run.started",
        subsystem: "workflow",
        operation: "execute",
        status: "started",
        runId,
        workflowId: initial.run.workflowId,
        projectId,
      },
      "Workflow run dispatch started",
    );
    this.notifyRunChanged(runId, projectId);
    const active = new Set<Promise<void>>();
    while (!this.#stopping) {
      const budget = await this.repository.workflowRuns.enforceRunBudget(
        this.#ownerId(),
        runId,
      );
      if (!budget) break;
      if (budget.violation) {
        this.notifyRunChanged(runId, projectId);
        await this.interruptExecutions(
          budget.interruptions,
          "Workflow budget failure was persisted but runtime interruption failed",
        );
        break;
      }
      const collectionAdvanced =
        await this.repository.workflowRuns.advanceReadyCollectionNode(
          this.#ownerId(),
          runId,
        );
      if (collectionAdvanced === null) break;
      if (collectionAdvanced) {
        this.notifyRunChanged(runId, projectId, "workflow-node");
        continue;
      }
      const repeatUntilAdvanced =
        await this.repository.workflowRuns.advanceReadyRepeatUntilNode(
          this.#ownerId(),
          runId,
        );
      if (repeatUntilAdvanced === null) break;
      if (repeatUntilAdvanced) {
        this.notifyRunChanged(runId, projectId, "workflow-node");
        continue;
      }
      const controlAdvanced =
        await this.repository.workflowRuns.advanceReadyControlNode(
          this.#ownerId(),
          runId,
        );
      if (controlAdvanced === null) break;
      if (controlAdvanced) {
        this.notifyRunChanged(runId, projectId, "workflow-node");
        continue;
      }
      const candidates =
        await this.repository.workflowRuns.getReadyAgentCandidates(
          this.#ownerId(),
          runId,
        );
      if (candidates === null) break;
      const unsupported = candidates.find(
        ({ configuration, unsupportedReason }) =>
          unsupportedReason || !configuration,
      );
      if (unsupported) {
        await this.repository.workflowRuns.failUnsupportedRun(
          this.#ownerId(),
          runId,
          unsupported.unsupportedReason ??
            "The workflow node configuration is unavailable.",
        );
        this.notifyRunChanged(runId, projectId, "workflow-node");
        break;
      }
      const candidate = candidates[0];
      const [project, source] = candidate?.projectId
        ? await Promise.all([
            this.repository.getProject(this.#ownerId(), candidate.projectId),
            this.repository.getProjectSource(
              this.#ownerId(),
              candidate.projectId,
            ),
          ])
        : [null, null];
      if (candidate?.projectId && (!project || !source)) break;
      if (source && !this.bridge.isConnected(source.workerId)) break;
      if (candidates.length > 0 && !source) {
        await this.repository.workflowRuns.failUnsupportedRun(
          this.#ownerId(),
          runId,
          "The workflow project source is unavailable.",
        );
        this.notifyRunChanged(runId, projectId, "workflow-node");
        break;
      }
      let allocationBlocked = false;
      for (const ready of candidates) {
        const runtime = await this.runtimeFor(ready);
        if (!runtime) {
          await this.repository.workflowRuns.failUnsupportedRun(
            this.#ownerId(),
            runId,
            "The workflow has no available model route.",
          );
          this.notifyRunChanged(runId, projectId, "workflow-node");
          break;
        }
        let target = {
          ...source!,
          rootKind:
            project!.originKind === "managed-folder"
              ? ("folder-root" as const)
              : ("git-worktree" as const),
        };
        if (ready.node.writeCapable && project!.capabilities.worktrees) {
          try {
            const allocation =
              await this.worktreeCoordinator.allocateWorkflowLane(
                this.#ownerId(),
                ready.projectId!,
                {
                  runId: ready.run.id,
                  runNodeId: ready.node.id,
                  runNodeItemId: ready.item?.id ?? null,
                },
              );
            this.notifyRunChanged(runId, projectId, "workflow-node");
            if (!allocation) {
              allocationBlocked = true;
              break;
            }
            target = {
              cwd: allocation.worktree.path,
              projectReplicaId: allocation.worktree.projectSourceId,
              rootKind: "git-worktree",
              workerId: allocation.worktree.workerId,
              worktreeId: allocation.worktree.id,
            };
          } catch (error) {
            allocationBlocked = true;
            this.notifyRunChanged(runId, projectId, "workflow-node");
            this.logger.warn(
              {
                err: error,
                workflowRunId: ready.run.id,
                workflowRunNodeId: ready.node.id,
              },
              "Workflow worktree allocation failed",
            );
            break;
          }
        }
        const lease = await this.repository.workflowRuns.claimAgentAttempt(
          this.#ownerId(),
          ready,
          {
            cwd: target.cwd,
            modelRouteId: runtime.routeId,
            permissionProfileId: ready.node.permissionProfileId,
            rootKind: target.rootKind,
            workerId: target.workerId,
            worktreeId: target.worktreeId,
          },
        );
        if (!lease) continue;
        this.notifyRunChanged(runId, projectId, "workflow-node");
        let task!: Promise<void>;
        task = this.executeAttempt(lease, runtime).finally(() =>
          active.delete(task),
        );
        active.add(task);
      }
      if (active.size === 0) break;
      await Promise.race(active);
      if (allocationBlocked && active.size === 0) break;
    }
    await Promise.allSettled(active);
    const finalRun = await this.repository.workflowRuns.getRun(
      this.#ownerId(),
      runId,
    );
    this.logger.info?.(
      {
        event: "workflow.run.dispatch_completed",
        subsystem: "workflow",
        operation: "execute",
        status: finalRun?.run.status ?? "unavailable",
        runId,
        workflowId: initial.run.workflowId,
        projectId,
        durationMs: Date.now() - startedAtMs,
      },
      "Workflow run dispatch pass completed",
    );
  }

  private async executeAttempt(
    lease: WorkflowAttemptLease,
    runtime: ModelRuntime,
  ): Promise<void> {
    const startedAtMs = Date.now();
    const { cwd, workerId, worktreeId } = lease.assignment;
    const ownerId = this.#ownerId();
    const startedAt = new Date();
    let observedTurnId: string | null = null;
    let heartbeatInFlight = false;
    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void this.repository.workflowRuns
        .renewAttemptHeartbeat(ownerId, lease.attemptId)
        .then((renewed) => {
          if (!renewed) {
            this.logger.warn(
              { workflowAttemptId: lease.attemptId },
              "Workflow attempt no longer owns its durable heartbeat lease",
            );
          }
        })
        .catch((error: unknown) => {
          this.logger.warn(
            { err: error, workflowAttemptId: lease.attemptId },
            "Could not renew workflow attempt heartbeat lease",
          );
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, ATTEMPT_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();
    this.logger.info?.(
      {
        event: "workflow.attempt.started",
        subsystem: "workflow",
        operation: "node.execute",
        status: "started",
        runId: lease.candidate.run.id,
        workflowId: lease.candidate.run.workflowId,
        attemptId: lease.attemptId,
        workerId,
        projectId: lease.candidate.projectId,
      },
      "Workflow node attempt started",
    );
    try {
      await this.recordWorkflowTokenUsage(lease, runtime, undefined, {
        attemptStatus: "running",
        startedAt,
      });
      const mcpServers = await this.repository.listEffectiveMcpServers(
        this.#ownerId(),
        lease.candidate.run.projectId,
      );
      const rawResult = await this.bridge.request(
        workerId,
        {
          type: "workflow.node.execute",
          workflowRunId: lease.candidate.run.id,
          runNodeId: lease.candidate.node.id,
          attemptId: lease.attemptId,
          idempotencyKey: lease.idempotencyKey,
          worktreeId,
          rootKind: lease.assignment.rootKind,
          cwd,
          threadId:
            lease.candidate.item?.codexThreadId ??
            lease.candidate.node.codexThreadId,
          prompt: workflowAgentPrompt(
            lease.candidate.configuration!,
            lease.candidate.structuredInput,
          ),
          developerInstructions:
            lease.candidate.configuration!.developerInstructions,
          skillNames: lease.candidate.node.permissionManifest.skills,
          outputSchema: lease.candidate.outputSchema,
          mutationMode: lease.candidate.node.writeCapable
            ? "write"
            : "read-only",
          networkAccess: lease.candidate.node.permissionManifest.network,
          approvalMode: lease.candidate.node.permissionManifest.approvalMode,
          permissionProfileId: lease.candidate.node.permissionProfileId,
          timeoutMs: lease.timeoutMs,
          model: runtime.model,
          provider: runtime.provider,
          mcpServers,
        },
        {
          timeoutMs: Math.min(
            lease.timeoutMs + ATTEMPT_HEARTBEAT_INTERVAL_MS,
            MAX_WORKER_REQUEST_TIMEOUT_MS,
          ),
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
      observedTurnId = result.turnId;
      await this.recordWorkflowTokenUsage(
        lease,
        runtime,
        result.measuredUsage,
        {
          attemptStatus: "running",
          turnId: result.turnId,
        },
      );
      if (
        lease.candidate.verification &&
        lease.candidate.verification.failurePolicy === "fail-run" &&
        !evaluateWorkflowPredicate(
          result.structuredResult,
          lease.candidate.verification.passCondition,
        )
      ) {
        throw new WorkflowVerificationError(
          "The verification result did not satisfy its pass condition.",
        );
      }
      await this.repository.workflowRuns.completeAgentAttempt(
        this.#ownerId(),
        lease,
        result,
        await this.captureWorkflowChanges(lease),
      );
      const completedAt = new Date();
      await this.recordWorkflowTokenUsage(lease, runtime, undefined, {
        attemptStatus: "completed",
        turnId: result.turnId,
        completedAt,
        finalizedAt: completedAt,
      });
      this.notifyRunChanged(
        lease.candidate.run.id,
        lease.candidate.projectId,
        "workflow-node",
      );
      this.logger.info?.(
        {
          event: "workflow.attempt.completed",
          subsystem: "workflow",
          operation: "node.execute",
          status: "completed",
          runId: lease.candidate.run.id,
          workflowId: lease.candidate.run.workflowId,
          attemptId: lease.attemptId,
          workerId,
          projectId: lease.candidate.projectId,
          durationMs: Date.now() - startedAtMs,
        },
        "Workflow node attempt completed",
      );
    } catch (error) {
      const failedAt = new Date();
      await this.recordWorkflowTokenUsage(lease, runtime, undefined, {
        attemptStatus: "failed",
        turnId: observedTurnId,
        completedAt: failedAt,
        finalizedAt: failedAt,
      });
      const failure = await this.repository.workflowRuns.failAgentAttempt(
        this.#ownerId(),
        lease,
        this.failureFrom(error),
      );
      this.notifyRunChanged(
        lease.candidate.run.id,
        lease.candidate.projectId,
        "workflow-node",
      );
      await this.interruptExecutions(
        failure.interruptions,
        "Map failure was persisted but sibling runtime interruption failed",
      );
      this.logger.warn(
        {
          event: "workflow.attempt.failed",
          subsystem: "workflow",
          operation: "node.execute",
          status: "failed",
          runId: lease.candidate.run.id,
          workflowId: lease.candidate.run.workflowId,
          attemptId: lease.attemptId,
          workerId,
          projectId: lease.candidate.projectId,
          durationMs: Date.now() - startedAtMs,
          err: error,
        },
        "Workflow node attempt failed",
      );
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private async captureWorkflowChanges(
    lease: WorkflowAttemptLease,
  ): Promise<WorkflowChangeCheckpoint | null> {
    if (!lease.candidate.node.writeCapable) return null;
    if (lease.assignment.rootKind === "folder-root") {
      if (lease.worktreeLeaseId) {
        throw new Error(
          "A direct folder workflow attempt unexpectedly acquired a Git worktree lease.",
        );
      }
      return {
        kind: "folder",
        producedChanges: workflowFolderProducedChangesSchema.parse({
          folder: {
            executionMode: "direct-folder",
            checkpointAvailable: false,
          },
        }),
      };
    }
    const projectId = lease.candidate.projectId;
    if (!projectId || !lease.worktreeLeaseId) {
      throw new Error(
        "The write-capable workflow attempt has no attributed worktree lease.",
      );
    }
    const context = await this.repository.getProjectWorktreeContext(
      this.#ownerId(),
      projectId,
      lease.assignment.worktreeId,
    );
    if (
      !context ||
      context.workerId !== lease.assignment.workerId ||
      context.worktree.isPrimary
    ) {
      throw new Error(
        "The write-capable workflow attempt is no longer bound to its isolated lane.",
      );
    }
    const result = worktreeStatusResultSchema.parse(
      await this.bridge.request(context.workerId, {
        type: "worktree.status",
        sourcePath: context.sourcePath,
        worktreePath: context.worktree.path,
      }),
    );
    if (!result.status.head || result.status.head !== result.worktree.head) {
      throw new Error(
        "Worker Git status did not provide a consistent checkpoint revision.",
      );
    }
    const observed = await this.repository.observeProjectWorktree(
      this.#ownerId(),
      projectId,
      context.worktree.id,
      result.worktree,
    );
    this.worktreeCoordinator.notifyProjectChanged(projectId);
    if (
      !observed ||
      observed.isPrimary ||
      observed.lifecycleState !== "ready" ||
      !observed.branch
    ) {
      throw new Error("The workflow worktree is not ready to checkpoint.");
    }
    return {
      kind: "git",
      endingRevision: result.status.head,
      worktreeDirty: result.status.files.length > 0,
      producedChanges: {
        git: {
          branch: result.status.branch,
          head: result.status.head,
          upstream: result.status.upstream,
          ahead: result.status.ahead,
          behind: result.status.behind,
          files: result.status.files,
        },
      },
    };
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
        await this.repository.workflowRuns.terminalizeWorkflowInteraction(
          lease.candidate.run.id,
          lease.candidate.node.id,
          lease.attemptId,
          event.requestKey,
          event.type === "workflow.node.interaction.expired"
            ? "expired"
            : "interrupted",
        );
      }
    }
    try {
      const revision =
        await this.repository.workflowRuns.recordAttemptWorkerEvent(
          this.#ownerId(),
          lease,
          event,
        );
      this.notifyRunChanged(
        lease.candidate.run.id,
        lease.candidate.projectId,
        event.type === "workflow.node.interaction.requested" ||
          event.type === "workflow.node.interaction.cleared" ||
          event.type === "workflow.node.interaction.expired"
          ? "workflow-gate"
          : "workflow-node",
        revision,
      );
      if (
        event.type === "workflow.node.activity" &&
        event.activity.type === "usage"
      ) {
        const runtime = await this.repository.getModelRuntimeByRoute(
          this.#ownerId(),
          lease.assignment.modelRouteId,
        );
        if (runtime) {
          await this.recordWorkflowTokenUsage(
            lease,
            runtime,
            event.activity.last,
            {
              attemptStatus: "running",
              turnId: event.activity.correlation?.turnId ?? null,
            },
          );
        }
        const budget = await this.repository.workflowRuns.enforceRunBudget(
          this.#ownerId(),
          lease.candidate.run.id,
        );
        if (budget?.violation) {
          this.notifyRunChanged(
            lease.candidate.run.id,
            lease.candidate.projectId,
            "workflow-run",
          );
          await this.interruptExecutions(
            budget.interruptions,
            "Workflow budget failure was persisted but runtime interruption failed",
          );
        }
      }
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

  private async recordWorkflowTokenUsage(
    lease: WorkflowAttemptLease,
    runtime: ModelRuntime,
    usage:
      | {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          cachedInputTokens?: number;
          reasoningOutputTokens?: number;
          cacheWriteInputTokens?: number;
        }
      | undefined,
    attribution: {
      attemptStatus?: "running" | "completed" | "failed";
      turnId?: string | null;
      startedAt?: Date;
      completedAt?: Date | null;
      finalizedAt?: Date | null;
    } = {},
  ): Promise<void> {
    try {
      const worker = await this.repository.getWorker(
        this.#ownerId(),
        lease.assignment.workerId,
      );
      await this.repository.recordTokenUsage(this.#ownerId(), {
        sourceKey: `workflow:${lease.attemptId}`,
        projectId: lease.candidate.projectId,
        chatId: null,
        modelRouteId: runtime.routeId,
        modelName: runtime.model.profileName,
        providerName: runtime.provider.name,
        providerModelName: runtime.model.name,
        providerAccountId: runtime.provider.accountId,
        workerId: lease.assignment.workerId,
        turnId: attribution.turnId,
        executionAttemptId: lease.attemptId,
        attemptKind: "workflow-node",
        attemptStatus: attribution.attemptStatus,
        reasoningEffort: runtime.model.reasoningEffort,
        serverVersion: cantripVersion.version,
        workerVersion: null,
        codexVersion: worker?.codexVersion ?? null,
        startedAt: attribution.startedAt,
        completedAt: attribution.completedAt,
        finalizedAt: attribution.finalizedAt,
        usage,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, workflowAttemptId: lease.attemptId },
        "Unable to persist workflow token usage analytics",
      );
    }
  }

  private async cancelWorkerInteraction(
    workerId: string,
    lease: WorkflowAttemptLease,
    requestKey: string,
    reason: string,
  ): Promise<void> {
    const runtime = await this.repository.getModelRuntimeByRoute(
      this.#ownerId(),
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
    candidate: WorkflowAgentCandidate,
  ): Promise<ModelRuntime | null> {
    if (candidate.node.modelRouteId) {
      return this.repository.getModelRuntimeByRoute(
        this.#ownerId(),
        candidate.node.modelRouteId,
      );
    }
    const settings = await this.repository.getSettings(this.#ownerId());
    const modelId = settings.preferences.defaultModelId;
    return modelId
      ? this.repository.getModelRuntime(this.#ownerId(), modelId)
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
    if (error instanceof WorkflowVerificationError) {
      return { code: "verification-failed", message, status: "failed" };
    }
    if (/timed out/iu.test(message)) {
      return { code: "node-timeout", message, status: "timed-out" };
    }
    return { code: "node-execution-failed", message, status: "failed" };
  }
}
