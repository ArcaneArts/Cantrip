import {
  codeGraphProjectStatusSchema,
  gitManagedOperationWorkerStateSchema,
  worktreeObservationConfigurationResultSchema,
  type AppLiveResource,
  type CodeGraphProjectStatus,
  type GitConflictList,
  type GitManagedOperationRecord,
  type ProviderAuthLiveStatus,
  type WorkerNotification,
  type WorktreeStatusResult,
} from "@cantrip/protocol";
import {
  runConfigurationRuntimeWorkerObservationSchema,
  runConfigurationRuntimeWorkerReconciliationSchema,
} from "@cantrip/protocol/run-configuration-runtime";
import { workerLinkIdentityResolveResultSchema } from "@cantrip/protocol/worker-link";
import { cuaApprovalTerminalSchema } from "@cantrip/protocol/computer-use-preview";
import type { FastifyInstance } from "fastify";

import type {
  ChatThreadChangeNotification,
  ChatThreadChangeReconciler,
} from "../../chats/thread-change-reconciliation.js";
import {
  chatTurnOutcomeRecoveryKey,
  type ChatTurnOutcomeRecoveryScheduler,
} from "../../chats/turn-outcome-recovery.js";
import type { ServerRepository } from "../../db/repository.js";
import type { ProviderCredentialMigrationCoordinator } from "../../models/provider-credential-migrations.js";
import { WorkerUnavailableError } from "../../workers/bridge.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import type { ProjectWorktreeCoordinator } from "../../worktrees/coordinator.js";
import {
  gitManagedOperationContext,
  gitOperationObservationMatches,
} from "../shared/git-managed-operations.js";
import { worktreeStatusFromGitStatus } from "../shared/worktree-status.js";
import type { ComputerUseApprovalPublications } from "../routes/computer-use-preview.js";

interface ProviderAuthObservation {
  accountId: string;
  expiresAt: number;
  lastSequence: number;
  ownerId: string;
  providerId: string;
  providerKind: "chatgpt" | "grok";
  startedAt: number;
  workerId: string;
}

type OwnerRunner = <T>(ownerId: string, operation: () => T) => T;

export interface WorkerNotificationRuntimeDependencies {
  activeProviderAuthObservations: Map<string, ProviderAuthObservation>;
  app: Pick<FastifyInstance, "log">;
  applicationOwnerId: () => string;
  bridge: LimitedWorkerCommandBus;
  chatThreadChangeReconciler: ChatThreadChangeReconciler;
  chatTurnOutcomeRecoveryScheduler: ChatTurnOutcomeRecoveryScheduler;
  loadProviderCatalog: (
    ownerId: string,
    providerId: string,
    workerId: string | undefined,
    force: boolean,
    accountId?: string,
    quotaTrigger?: string,
  ) => Promise<unknown>;
  providerCredentialMigrations: ProviderCredentialMigrationCoordinator;
  publishCodeGraphStatus: (
    status: CodeGraphProjectStatus,
    revision: number,
  ) => void;
  publishGitConflicts: (
    projectId: string,
    worktreeId: string,
    conflicts: GitConflictList,
  ) => void;
  publishGitOperation: (operation: GitManagedOperationRecord) => void;
  publishLiveInvalidation: (
    resource: AppLiveResource,
    input?: {
      chatId?: string | null;
      entityId?: string | null;
      projectId?: string | null;
    },
  ) => void;
  publishProviderAuthStatus: (
    status: Omit<ProviderAuthLiveStatus, "revision">,
  ) => ProviderAuthLiveStatus;
  reconcileObservedChatThread: (
    chatId: string,
    workerId: string,
    threadId: string,
    changes: ChatThreadChangeNotification["changes"],
  ) => Promise<void>;
  recordLiveWorktreeStatus: (
    projectId: string,
    worktreeId: string,
    status: WorktreeStatusResult,
  ) => Promise<void>;
  recoverChatTurnOutcome: (
    ownerId: string,
    workerId: string,
    notification: Extract<WorkerNotification, { type: "chat.turn.outcome" }>,
  ) => Promise<void>;
  repository: ServerRepository;
  resolveAccountAuthTarget: (
    providerId: string,
    accountId?: string,
  ) => Promise<{ providerKind: "chatgpt" | "grok" }>;
  runAsOwner: OwnerRunner;
  serverId: () => string;
  terminalizeLiveAgentInteractionRequest: ServerRepository["terminalizeAgentInteractionRequestFromWorker"];
  computerUseApprovalPublications?: ComputerUseApprovalPublications;
  updateTerminalStatus: (
    terminalId: string,
    status: Parameters<ServerRepository["setTerminalStatus"]>[1],
  ) => ReturnType<ServerRepository["setTerminalStatus"]>;
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "serialize">;
}

/**
 * Owns worker notification subscriptions and the durable observation
 * reconciliation state associated with each connected worker.
 */
export function createWorkerNotificationRuntime({
  activeProviderAuthObservations,
  app,
  applicationOwnerId,
  bridge,
  chatThreadChangeReconciler,
  chatTurnOutcomeRecoveryScheduler,
  loadProviderCatalog,
  providerCredentialMigrations,
  publishCodeGraphStatus,
  publishGitConflicts,
  publishGitOperation,
  publishLiveInvalidation,
  publishProviderAuthStatus,
  reconcileObservedChatThread,
  recordLiveWorktreeStatus,
  recoverChatTurnOutcome,
  repository,
  resolveAccountAuthTarget,
  runAsOwner,
  serverId,
  terminalizeLiveAgentInteractionRequest,
  computerUseApprovalPublications,
  updateTerminalStatus,
  worktreeCoordinator,
}: WorkerNotificationRuntimeDependencies) {
  const worktreeObservationTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  const workerNotificationSubscriptions = new Map<string, () => void>();
  const codeGraphStatusObservations = new Map<
    string,
    {
      fingerprint: string;
      lastPublishedFingerprint: string | null;
      revision: number;
    }
  >();
  let codeGraphStatusRevision = Date.now() * 1_000;
  const configureWorkerWorktreeObservation = async (
    workerId: string,
  ): Promise<void> => {
    if (!bridge.subscribeNotifications || !bridge.isConnected(workerId)) return;
    const ownerId = applicationOwnerId();
    const [targets, codegraphTargets] = await Promise.all([
      repository.listWorkerWorktreeObservationTargets(ownerId, workerId),
      repository.listWorkerExecutionRootContexts(ownerId, workerId),
    ]);
    const configuredTargets = await Promise.all(
      targets.map(async (target) => {
        const active = await repository.getActiveGitOperation(
          applicationOwnerId(),
          target.projectId,
          target.worktreeId,
        );
        return {
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          sourcePath: target.sourcePath,
          worktreePath: target.worktreePath,
          operation:
            active && active.workerId === workerId
              ? {
                  id: active.id,
                  context: gitManagedOperationContext(active),
                }
              : null,
        };
      }),
    );
    const configuredCodegraphTargets = codegraphTargets.map((target) => ({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      rootKind: target.rootKind,
      sourcePath: target.sourcePath,
      worktreePath: target.worktreePath,
    }));
    const result = worktreeObservationConfigurationResultSchema.parse(
      await bridge.request(workerId, {
        type: "worktree.observation.configure",
        targets: configuredTargets,
        codegraphTargets: configuredCodegraphTargets,
      }),
    );
    const requested = new Map(
      [...configuredTargets, ...configuredCodegraphTargets].map((target) => [
        `${target.projectId}\0${target.worktreeId}`,
        target,
      ]),
    );
    const changed = await repository.reconcileWorkerProjectObservationPaths(
      ownerId,
      workerId,
      result.paths.flatMap((resolved) => {
        const expected = requested.get(
          `${resolved.projectId}\0${resolved.worktreeId}`,
        );
        return expected
          ? [
              {
                expectedSourcePath: expected.sourcePath,
                expectedWorktreePath: expected.worktreePath,
                projectId: resolved.projectId,
                sourcePath: resolved.sourcePath,
                worktreeId: resolved.worktreeId,
                worktreePath: resolved.worktreePath,
              },
            ]
          : [];
      }),
    );
    if (changed > 0) scheduleWorkerWorktreeObservation(workerId);
  };
  const scheduleWorkerWorktreeObservation = (workerId: string): void => {
    if (!bridge.subscribeNotifications) return;
    const existing = worktreeObservationTimers.get(workerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      worktreeObservationTimers.delete(workerId);
      void configureWorkerWorktreeObservation(workerId).catch((error) => {
        if (!(error instanceof WorkerUnavailableError)) {
          app.log.warn(
            { err: error, workerId },
            "Could not configure worker worktree observation",
          );
        }
      });
    }, 100);
    timer.unref();
    worktreeObservationTimers.set(workerId, timer);
  };
  const reconcileRunConfigurationRuntimesForWorker = async (
    ownerId: string,
    workerId: string,
  ): Promise<void> => {
    if (!bridge.isConnected(workerId)) return;
    const active =
      await repository.listActiveRunConfigurationRuntimeIdentitiesForWorker(
        ownerId,
        workerId,
      );
    const reconciliation =
      runConfigurationRuntimeWorkerReconciliationSchema.parse(
        await bridge.request(workerId, {
          type: "project.run-configuration-runtime.reconcile",
          identities: active,
        }),
      );
    await Promise.all(
      active.map(async (identity) => {
        const lookup = reconciliation.runtimes.find((candidate) =>
          candidate.found
            ? candidate.observation.runtimeId === identity.runtimeId
            : candidate.identity.runtimeId === identity.runtimeId,
        );
        const observationMatches =
          lookup?.found === true &&
          lookup.observation.projectId === identity.projectId &&
          lookup.observation.configurationId === identity.configurationId &&
          lookup.observation.worktreeId === identity.worktreeId &&
          lookup.observation.workerId === identity.workerId &&
          lookup.observation.definitionRevision ===
            identity.definitionRevision &&
          lookup.observation.codexEnvironmentRevision ===
            identity.codexEnvironmentRevision &&
          lookup.observation.generation === identity.generation &&
          lookup.observation.operationId === identity.operationId &&
          lookup.observation.terminalId === identity.terminalId;
        const observation = observationMatches
          ? lookup.observation
          : runConfigurationRuntimeWorkerObservationSchema.parse({
              ...identity,
              state: "lost",
              startedAt: null,
              endedAt: new Date().toISOString(),
              exitCode: null,
              signal: null,
              failure: {
                phase: "reconcile",
                code: "process-missing",
                message:
                  "The Run configuration process was not present after worker reconnect.",
                retryable: true,
              },
            });
        const result = await repository.applyRunConfigurationRuntimeObservation(
          ownerId,
          workerId,
          observation,
        );
        if (result?.applied) {
          publishLiveInvalidation("run", {
            projectId: result.runtime.projectId,
            entityId: result.runtime.id,
          });
          if (result.runtime.terminalId) {
            await updateTerminalStatus(
              result.runtime.terminalId,
              ["starting", "running", "restarting", "stopping"].includes(
                result.runtime.state,
              )
                ? "running"
                : result.runtime.state === "failed"
                  ? "failed"
                  : "exited",
            );
          }
        }
      }),
    );
  };
  const scheduleProjectWorktreeObservation = async (
    projectId: string,
  ): Promise<void> => {
    const source = await repository.getProjectSource(
      applicationOwnerId(),
      projectId,
      { isWorkerAvailable: (workerId) => bridge.isConnected(workerId) },
    );
    if (source) scheduleWorkerWorktreeObservation(source.workerId);
  };
  type GitOperationObservedNotification = Extract<
    WorkerNotification,
    { type: "git.operation.observed" }
  >;
  type PendingGitOperationObservation = {
    notification: GitOperationObservedNotification;
    ownerId: string;
    workerId: string;
  };
  const gitOperationObservationStates = new Map<
    string,
    {
      pending: PendingGitOperationObservation | null;
      running: boolean;
      settledFingerprint: string | null;
      settledObservedAt: string | null;
    }
  >();
  const reconcileGitOperationObservation = async (
    ownerId: string,
    workerId: string,
    notification: GitOperationObservedNotification,
  ): Promise<boolean> => {
    return worktreeCoordinator.serialize(notification.projectId, async () => {
      const context = await repository.getProjectWorktreeContext(
        ownerId,
        notification.projectId,
        notification.worktreeId,
      );
      if (
        !context ||
        context.workerId !== workerId ||
        context.sourcePath !== notification.sourcePath ||
        context.worktree.path !== notification.worktreePath
      ) {
        return false;
      }
      const durable = await repository.getGitOperation(
        ownerId,
        notification.projectId,
        notification.worktreeId,
        notification.operationId,
      );
      if (!durable || durable.workerId !== workerId) return false;
      if (["completed", "failed", "aborted"].includes(durable.state)) {
        if (
          durable.state === notification.state.state &&
          durable.currentHead === notification.state.currentHead
        ) {
          publishGitConflicts(
            notification.projectId,
            notification.worktreeId,
            notification.conflicts,
          );
          return true;
        }
        return false;
      }
      const workerState = gitManagedOperationWorkerStateSchema.parse(
        await bridge.request(workerId, {
          type: "git.operation.inspect",
          cwd: context.worktree.path,
          context: gitManagedOperationContext(durable),
        }),
      );
      const observationStillCurrent = gitOperationObservationMatches(
        workerState,
        notification.state,
      );
      const updated = await repository.updateGitOperation(
        ownerId,
        notification.projectId,
        notification.worktreeId,
        durable.id,
        workerState,
      );
      if (!updated) return false;
      await recordLiveWorktreeStatus(
        notification.projectId,
        notification.worktreeId,
        worktreeStatusFromGitStatus(context.worktree, workerState.status),
      );
      publishGitOperation(updated);
      if (observationStillCurrent) {
        publishGitConflicts(
          notification.projectId,
          notification.worktreeId,
          notification.conflicts,
        );
      } else {
        publishLiveInvalidation("git-conflict", {
          entityId: notification.worktreeId,
          projectId: notification.projectId,
        });
      }
      if (["completed", "failed", "aborted"].includes(updated.state)) {
        publishLiveInvalidation("worktree", {
          entityId: notification.worktreeId,
          projectId: notification.projectId,
        });
      }
      scheduleWorkerWorktreeObservation(workerId);
      return true;
    });
  };
  const scheduleGitOperationObservation = (
    ownerId: string,
    workerId: string,
    notification: GitOperationObservedNotification,
  ): void => {
    const key = `${ownerId}:${workerId}:${notification.projectId}:${notification.worktreeId}:${notification.operationId}`;
    let state = gitOperationObservationStates.get(key);
    if (!state) {
      state = {
        pending: null,
        running: false,
        settledFingerprint: null,
        settledObservedAt: null,
      };
      gitOperationObservationStates.set(key, state);
      if (gitOperationObservationStates.size > 4_096) {
        const oldest = [...gitOperationObservationStates].find(
          ([candidateKey, candidate]) =>
            candidateKey !== key && !candidate.running,
        )?.[0];
        if (oldest) gitOperationObservationStates.delete(oldest);
      }
    }
    if (
      state.settledFingerprint === notification.fingerprint ||
      (state.settledObservedAt !== null &&
        notification.observedAt < state.settledObservedAt) ||
      (state.pending !== null &&
        notification.observedAt < state.pending.notification.observedAt)
    ) {
      return;
    }
    state.pending = { notification, ownerId, workerId };
    if (state.running) return;
    state.running = true;
    queueMicrotask(() => {
      void (async () => {
        while (state.pending) {
          const pending = state.pending;
          state.pending = null;
          if (state.settledFingerprint === pending.notification.fingerprint) {
            continue;
          }
          try {
            const accepted = await runAsOwner(pending.ownerId, () =>
              reconcileGitOperationObservation(
                pending.ownerId,
                pending.workerId,
                pending.notification,
              ),
            );
            if (accepted) {
              state.settledFingerprint = pending.notification.fingerprint;
              state.settledObservedAt = pending.notification.observedAt;
            }
          } catch (error) {
            app.log.warn(
              {
                err: error,
                operationId: pending.notification.operationId,
                workerId: pending.workerId,
              },
              "Could not reconcile observed Git operation state",
            );
            scheduleWorkerWorktreeObservation(pending.workerId);
          }
        }
        state.running = false;
      })();
    });
  };
  const handleWorkerNotification = async (
    ownerId: string,
    workerId: string,
    notification: WorkerNotification,
  ): Promise<void> => {
    if (notification.type === "computer-use.approval.terminal") {
      await applyComputerUseApprovalTerminal({
        ownerId,
        workerId,
        notification,
        repository,
        terminalizeLiveAgentInteractionRequest,
        approvalPublications: computerUseApprovalPublications,
      });
      return;
    }
    if (notification.type === "terminal.runtime.observed") {
      const identity = workerLinkIdentityResolveResultSchema.safeParse(
        await bridge.request(
          workerId,
          { type: "worker-link.identity.resolve" },
          { ownerId, timeoutMs: 5_000 },
        ),
      );
      if (
        !identity.success ||
        identity.data.serverId !== serverId() ||
        identity.data.ownerId !== ownerId ||
        identity.data.workerId !== workerId ||
        identity.data.workerProcessGeneration !==
          notification.workerProcessGeneration
      ) {
        return;
      }
      const context = await repository.getTerminalExecutionContext(
        ownerId,
        notification.terminalId,
      );
      if (
        !context ||
        context.workerId !== workerId ||
        context.kind === "run-configuration"
      ) {
        return;
      }
      await updateTerminalStatus(notification.terminalId, "exited");
      return;
    }
    if (notification.type === "chat.turn.outcome") {
      app.log.info(
        {
          chatId: notification.chatId,
          clientMessageId: notification.clientMessageId,
          executionLaneId: notification.executionLaneId,
          outcome: notification.outcome.ok ? "completed" : "failed",
          workerId,
        },
        "Received durable agent turn outcome",
      );
      const key = chatTurnOutcomeRecoveryKey(
        workerId,
        notification.chatId,
        notification.clientMessageId,
      );
      const scheduled = chatTurnOutcomeRecoveryScheduler.schedule(key, () => {
        void runAsOwner(ownerId, () =>
          recoverChatTurnOutcome(ownerId, workerId, notification),
        ).catch((error) => {
          app.log.error(
            {
              chatId: notification.chatId,
              clientMessageId: notification.clientMessageId,
              err: error,
              workerId,
            },
            "Could not recover a completed agent turn",
          );
        });
      });
      if (!scheduled) {
        app.log.debug(
          {
            chatId: notification.chatId,
            clientMessageId: notification.clientMessageId,
            workerId,
          },
          "Ignored a durable outcome for a turn already settled normally",
        );
      }
      return;
    }
    if (notification.type === "chat.thread.changed") {
      const contexts = await repository.listChatExecutionContextsByThreadId(
        ownerId,
        workerId,
        notification.threadId,
      );
      if (contexts.length !== 1 || contexts[0]?.experience !== "agent") {
        return;
      }
      const context = contexts[0];
      const key = `${ownerId}:${workerId}:${notification.threadId}`;
      chatThreadChangeReconciler.schedule(key, notification, (observation) =>
        runAsOwner(ownerId, async () => {
          const current = await repository.getChatExecutionContext(
            ownerId,
            context.chatId,
          );
          if (
            !current ||
            current.experience !== "agent" ||
            current.workerId !== workerId ||
            current.threadId !== observation.threadId
          ) {
            return;
          }
          await reconcileObservedChatThread(
            current.chatId,
            workerId,
            observation.threadId,
            observation.changes,
          );
        }),
      );
      return;
    }
    if (notification.type === "worktree.inventory.observed") {
      if (
        notification.inventory.sourcePath !== notification.sourcePath ||
        notification.inventory.primaryPath === ""
      ) {
        return;
      }
      const context = await repository.getProjectWorktreeObservationContext(
        ownerId,
        workerId,
        notification.sourcePath,
        notification.inventory.primaryPath,
      );
      if (!context) return;
      const worktrees = await repository.reconcileProjectWorktrees(
        ownerId,
        context.projectId,
        workerId,
        notification.inventory,
      );
      if (!worktrees) return;
      publishLiveInvalidation("worktree", { projectId: context.projectId });
      scheduleWorkerWorktreeObservation(workerId);
      return;
    }
    if (notification.type === "worktree.filesystem.changed") {
      const context = await repository.getProjectWorktreeObservationContext(
        ownerId,
        workerId,
        notification.sourcePath,
        notification.worktreePath,
      );
      if (!context) return;
      publishLiveInvalidation("explorer-filesystem", {
        entityId: context.worktreeId,
        projectId: context.projectId,
      });
      return;
    }
    if (notification.type === "codegraph.status.observed") {
      const status = codeGraphProjectStatusSchema.parse(notification.status);
      const observationKey = `${ownerId}:${workerId}:${status.projectId}:${status.worktreeId}`;
      const previousObservation =
        codeGraphStatusObservations.get(observationKey);
      codeGraphStatusRevision = Math.max(
        codeGraphStatusRevision + 1,
        Date.now() * 1_000,
      );
      const observation = {
        fingerprint: JSON.stringify(status),
        lastPublishedFingerprint:
          previousObservation?.lastPublishedFingerprint ?? null,
        revision: codeGraphStatusRevision,
      };
      // Refresh insertion order so the bounded map retains recently active worktrees.
      codeGraphStatusObservations.delete(observationKey);
      codeGraphStatusObservations.set(observationKey, observation);
      if (codeGraphStatusObservations.size > 4_096) {
        const oldest = codeGraphStatusObservations.keys().next().value;
        if (oldest !== undefined) codeGraphStatusObservations.delete(oldest);
      }
      const context = await repository.getProjectWorktreeContext(
        ownerId,
        status.projectId,
        status.worktreeId,
      );
      if (!context || context.workerId !== workerId) return;
      const latestObservation = codeGraphStatusObservations.get(observationKey);
      if (
        latestObservation?.revision !== observation.revision ||
        latestObservation.lastPublishedFingerprint === observation.fingerprint
      ) {
        return;
      }
      latestObservation.lastPublishedFingerprint = observation.fingerprint;
      publishCodeGraphStatus(status, observation.revision);
      return;
    }
    if (notification.type === "git.operation.observed") {
      scheduleGitOperationObservation(ownerId, workerId, notification);
      return;
    }
    if (notification.type === "project.run-configuration-runtime.observed") {
      const result = await repository.applyRunConfigurationRuntimeObservation(
        ownerId,
        workerId,
        notification.observation,
      );
      if (result?.applied) {
        publishLiveInvalidation("run", {
          projectId: result.runtime.projectId,
          entityId: result.runtime.id,
        });
        if (result.runtime.terminalId) {
          await updateTerminalStatus(
            result.runtime.terminalId,
            ["starting", "running", "restarting", "stopping"].includes(
              result.runtime.state,
            )
              ? "running"
              : result.runtime.state === "failed"
                ? "failed"
                : "exited",
          );
        }
      }
      return;
    }
    if (notification.type === "project.run-configuration-definitions.changed") {
      const source = await repository.getProjectSource(
        ownerId,
        notification.projectId,
        { workerId },
      );
      if (
        !source ||
        source.workerId !== workerId ||
        source.cwd !== notification.sourcePath
      ) {
        return;
      }
      publishLiveInvalidation("run-configuration", {
        projectId: notification.projectId,
        entityId: notification.change.id,
      });
      return;
    }
    if (notification.type === "provider.auth.status.observed") {
      const active = activeProviderAuthObservations.get(
        notification.observationId,
      );
      const observedAt = Date.parse(notification.observedAt);
      if (
        !active ||
        active.ownerId !== ownerId ||
        active.workerId !== workerId ||
        active.providerId !== notification.providerId ||
        active.accountId !== notification.providerAccountId ||
        active.providerKind !== notification.providerKind ||
        (notification.status.state === "authenticated" &&
          notification.status.authMode !== notification.providerKind) ||
        observedAt < active.startedAt - 5 * 60_000 ||
        observedAt > Date.now() + 5 * 60_000 ||
        notification.sequence <= active.lastSequence
      ) {
        return;
      }
      const [worker, account] = await Promise.all([
        repository.getWorker(ownerId, workerId),
        resolveAccountAuthTarget(
          notification.providerId,
          notification.providerAccountId,
        ),
      ]);
      if (!worker || account.providerKind !== notification.providerKind) {
        return;
      }
      active.lastSequence = notification.sequence;
      active.expiresAt = Math.min(
        Date.parse(notification.expiresAt),
        Date.now() + 16 * 60_000,
      );
      let safeStatus = notification.status;
      if (notification.status.state === "authenticated") {
        const capture = await providerCredentialMigrations.captureAccount(
          ownerId,
          workerId,
          notification.providerId,
          notification.providerAccountId,
        );
        if (capture.captured + capture.alreadyCaptured === 0) {
          safeStatus = {
            state: "failed",
            authMode: null,
            email: null,
            planType: null,
            weeklyUsage: null,
            failureCode: "credential-capture-failed",
          };
        } else {
          await repository.recordModelProviderAccountStatus(
            notification.providerAccountId,
            workerId,
            {
              authenticated: true,
              email: notification.status.email,
              planType: notification.status.planType,
              weeklyUsage: notification.status.weeklyUsage,
            },
          );
          void loadProviderCatalog(
            ownerId,
            notification.providerId,
            workerId,
            true,
            notification.providerAccountId,
            "account-auth-live",
          ).catch(() => undefined);
        }
      }
      if (safeStatus.state !== "pending") {
        publishLiveInvalidation("settings");
      }
      publishProviderAuthStatus({
        providerId: notification.providerId,
        providerAccountId: notification.providerAccountId,
        providerKind: notification.providerKind,
        workerId,
        observedAt: notification.observedAt,
        expiresAt: notification.expiresAt,
        status: safeStatus,
      });
      if (safeStatus.state !== "pending") {
        activeProviderAuthObservations.delete(notification.observationId);
      }
      return;
    }
    if (notification.type === "diagnostics.logs.observed") return;
    if (
      notification.type === "worker-link.peer.signal" ||
      notification.type === "worker-link.peer.candidates"
    ) {
      return;
    }
    const context = await repository.getProjectWorktreeObservationContext(
      ownerId,
      workerId,
      notification.sourcePath,
      notification.worktreePath,
    );
    if (
      !context ||
      notification.result.worktree.path !== notification.worktreePath
    ) {
      return;
    }
    await recordLiveWorktreeStatus(
      context.projectId,
      context.worktreeId,
      notification.result,
    );
  };
  const ensureWorkerNotificationSubscription = (
    ownerId: string,
    workerId: string,
  ): void => {
    if (
      !bridge.subscribeNotifications ||
      workerNotificationSubscriptions.has(workerId)
    ) {
      return;
    }
    workerNotificationSubscriptions.set(
      workerId,
      bridge.subscribeNotifications(workerId, (notification) =>
        runAsOwner(ownerId, () =>
          handleWorkerNotification(ownerId, workerId, notification),
        ).catch((error) => {
          app.log.warn(
            { err: error, notificationType: notification.type, workerId },
            "Could not apply worker notification",
          );
        }),
      ),
    );
  };

  return {
    close(): void {
      for (const timer of worktreeObservationTimers.values()) {
        clearTimeout(timer);
      }
      worktreeObservationTimers.clear();
      gitOperationObservationStates.clear();
      codeGraphStatusObservations.clear();
      for (const unsubscribe of workerNotificationSubscriptions.values()) {
        unsubscribe();
      }
      workerNotificationSubscriptions.clear();
    },
    ensureWorkerNotificationSubscription,
    reconcileRunConfigurationRuntimesForWorker,
    scheduleProjectWorktreeObservation,
    scheduleWorkerWorktreeObservation,
  };
}

/** Authenticated subscription identity, not notification claims, owns the row. */
export async function applyComputerUseApprovalTerminal(input: {
  ownerId: string;
  workerId: string;
  notification: unknown;
  repository: Pick<ServerRepository, "getAgentInteractionRequestByKey">;
  terminalizeLiveAgentInteractionRequest: ServerRepository["terminalizeAgentInteractionRequestFromWorker"];
  approvalPublications?: ComputerUseApprovalPublications;
}): Promise<void> {
  const terminal = cuaApprovalTerminalSchema.safeParse(input.notification);
  if (!terminal.success) return;
  try {
    const scope = {
      ownerId: input.ownerId,
      workerId: input.workerId,
      chatId: terminal.data.chatId,
      requestKey: terminal.data.requestKey,
    };
    // Independent coordinated notifications may beat the first command event.
    // The dispatch fence exists before bridge.request and its completion waits
    // for that command's async event queue; ordered terminal events bypass this
    // helper so they cannot deadlock on their own command.
    await input.approvalPublications?.waitCommands(scope);
    // An HTTP timeout may end dispatch while a started insert can still commit.
    await input.approvalPublications?.wait(scope);
    const lookup = () =>
      input.repository.getAgentInteractionRequestByKey(
        input.ownerId,
        terminal.data.requestKey,
      );
    const existing = await lookup();
    if (
      !existing ||
      existing.provenance.owner !== "computer-use" ||
      existing.requestKey !== terminal.data.requestKey ||
      existing.provenance.chatId !== terminal.data.chatId ||
      existing.provenance.workerId !== input.workerId
    )
      return;
    await input.terminalizeLiveAgentInteractionRequest(
      terminal.data.requestKey,
      terminal.data.chatId,
      input.workerId,
      terminal.data.status,
    );
  } catch {
    throw new Error(
      "Computer-use approval terminal state could not be applied.",
    );
  }
}
