import { randomUUID } from "node:crypto";

import type { AppLiveResource } from "@cantrip/protocol";
import { runConfigurationIdSchema } from "@cantrip/protocol/run-configuration-definitions";
import {
  runConfigurationApiDeleteRequestSchema,
  runConfigurationApiFlutterDevicesRequestSchema,
  runConfigurationApiValidateRequestSchema,
  runConfigurationApiWriteRequestSchema,
  runConfigurationCapabilitiesResponseSchema,
  runConfigurationDeleteResponseSchema,
  runConfigurationDetectQuerySchema,
  runConfigurationDetectResponseSchema,
  runConfigurationFlutterDevicesResponseSchema,
  runConfigurationGetResponseSchema,
  runConfigurationListQuerySchema,
  runConfigurationListResponseSchema,
  runConfigurationPathsQuerySchema,
  runConfigurationPathsResponseSchema,
  runConfigurationValidateResponseSchema,
  runConfigurationWriteResponseSchema,
} from "@cantrip/protocol/run-configuration-operations";
import {
  protectedRunConfigurationRuntimeOutputResultSchema,
  protectedRunConfigurationRuntimeWorkerOutputSchema,
  runConfigurationRuntimeLifecycleRequestSchema,
  runConfigurationRuntimeOperationResultSchema,
  runConfigurationRuntimeOutputQuerySchema,
  runConfigurationRuntimeStatusQuerySchema,
  runConfigurationRuntimeStatusResultSchema,
  runConfigurationRuntimeWorkerObservationSchema,
  runConfigurationRuntimeWorkerOperationResultSchema,
} from "@cantrip/protocol/run-configuration-runtime";
import {
  type RunConfigurationProtectedSecret,
  runConfigurationSecretSetRequestSchema,
  runConfigurationSecretSetResultSchema,
} from "@cantrip/protocol/run-configuration-secrets";
import type { FastifyInstance, FastifyReply } from "fastify";

import { CliCommandRequestError } from "../../agent-tools/errors.js";
import type {
  ChatExecutionContext,
  ServerRepository,
} from "../../db/repository.js";
import {
  ExecutionLaneConflictError,
  ExecutionPlacementUnavailableError,
} from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { ProjectWorktreeCoordinator } from "../../worktrees/coordinator.js";
import { WorkerUnavailableError } from "../../workers/bridge.js";
import type { LimitedWorkerCommandBus } from "../../workers/limited-command-bus.js";
import type { AppendAudit } from "../http/audit.js";
import { runConfigurationSecretReferences } from "../shared/run-configuration-secrets.js";

export interface ExecutionOperationContext {
  chatId: string | null;
  executionLaneId: string | null;
  permissionProfileId: string | null;
  projectId: string;
  rootKind: ChatExecutionContext["rootKind"];
  terminalId: string | null;
  workerId: string;
  worktreeId: string;
  worktreeMode: ChatExecutionContext["worktreeMode"] | null;
}

export interface RunConfigurationRuntimeDependencies {
  appendAudit: AppendAudit;
  applicationOwnerId: () => string;
  bridge: LimitedWorkerCommandBus;
  ensureWorkerNotificationSubscription: (
    ownerId: string,
    workerId: string,
  ) => void;
  publishLiveInvalidation: (
    resource: AppLiveResource,
    input?: {
      chatId?: string | null;
      entityId?: string | null;
      projectId?: string | null;
    },
  ) => void;
  repository: ServerRepository;
  serverId: string;
  updateTerminalStatus: (
    terminalId: string,
    status: Parameters<ServerRepository["setTerminalStatus"]>[1],
  ) => ReturnType<ServerRepository["setTerminalStatus"]>;
  worktreeCoordinator: ProjectWorktreeCoordinator;
}

/** Owns Run configuration definitions, protected secrets, and runtime lifecycle. */
export function createRunConfigurationRuntime({
  appendAudit,
  applicationOwnerId,
  bridge,
  ensureWorkerNotificationSubscription,
  publishLiveInvalidation,
  repository,
  serverId,
  updateTerminalStatus,
  worktreeCoordinator,
}: RunConfigurationRuntimeDependencies) {
  const resolveAppRunContext = async (
    projectId: string,
    requestedWorktreeId?: string,
  ): Promise<ExecutionOperationContext> => {
    if (requestedWorktreeId) {
      const selected = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        projectId,
        requestedWorktreeId,
      );
      if (!selected) {
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The requested Run worktree was not found.",
        );
      }
      if (!bridge.isConnected(selected.workerId)) {
        throw new ExecutionPlacementUnavailableError(
          "worker-offline",
          "The requested Run worktree worker is offline.",
        );
      }
      return {
        chatId: null,
        executionLaneId: null,
        permissionProfileId: null,
        projectId,
        rootKind: selected.worktree.rootKind,
        terminalId: null,
        workerId: selected.workerId,
        worktreeId: selected.worktree.id,
        worktreeMode: null,
      };
    }
    const target = { kind: "project", projectId } as const;
    const resolution = await repository.resolveProjectExecutionPlacement(
      applicationOwnerId(),
      projectId,
      "terminal",
      target,
      (workerId) => bridge.isConnected(workerId),
    );
    if (!resolution.placement.worktreeId) {
      throw new ExecutionPlacementUnavailableError(
        "worktree-unavailable",
        "The project has no ready Run worktree.",
      );
    }
    const selected = await repository.getProjectWorktreeContext(
      applicationOwnerId(),
      projectId,
      resolution.placement.worktreeId,
    );
    if (!selected || selected.workerId !== resolution.placement.workerId) {
      throw new ExecutionLaneConflictError(
        "The Run worktree placement changed before the operation.",
      );
    }
    return {
      chatId: null,
      executionLaneId: null,
      permissionProfileId: null,
      projectId,
      rootKind: selected.worktree.rootKind,
      terminalId: null,
      workerId: selected.workerId,
      worktreeId: selected.worktree.id,
      worktreeMode: null,
    };
  };

  const sendRunApiFailure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof CliCommandRequestError) {
      return reply
        .code(error.status)
        .send({ code: error.code, error: error.message });
    }
    if (error instanceof ExecutionPlacementUnavailableError) {
      const status =
        error.code === "project-not-found" || error.code === "target-not-found"
          ? 404
          : error.code === "worker-offline"
            ? 503
            : 409;
      return reply
        .code(status)
        .send({ code: error.code, error: error.message });
    }
    if (error instanceof ExecutionLaneConflictError) {
      return reply.code(409).send({ code: "conflict", error: error.message });
    }
    return sendWorkerRequestFailure(reply, error);
  };

  const resolvePrimaryRunConfigurationSource = async (
    ownerId: string,
    projectId: string,
  ) => {
    const source = await repository.getProjectSource(ownerId, projectId);
    if (!source) {
      throw new CliCommandRequestError(
        "not-found",
        404,
        "The project Primary source was not found.",
      );
    }
    if (!bridge.isConnected(source.workerId)) {
      throw new CliCommandRequestError(
        "unavailable",
        503,
        "The project Primary worker is offline.",
      );
    }
    ensureWorkerNotificationSubscription(ownerId, source.workerId);
    return source;
  };

  const resolveRunConfigurationRuntimeTarget = async (
    ownerId: string,
    projectId: string,
    targetWorktreeId: string | null,
  ) => {
    const primary = targetWorktreeId
      ? null
      : await repository.getProjectSource(ownerId, projectId);
    if (!targetWorktreeId && !primary) {
      throw new CliCommandRequestError(
        "not-found",
        404,
        "The project Primary source was not found.",
      );
    }
    const context = await repository.getProjectWorktreeContext(
      ownerId,
      projectId,
      targetWorktreeId ?? primary!.worktreeId,
    );
    if (!context || context.worktree.lifecycleState !== "ready") {
      throw new CliCommandRequestError(
        "not-found",
        404,
        "The Run configuration target worktree is not ready.",
      );
    }
    if (!bridge.isConnected(context.workerId)) {
      throw new CliCommandRequestError(
        "unavailable",
        503,
        "The Run configuration target worker is offline.",
      );
    }
    ensureWorkerNotificationSubscription(ownerId, context.workerId);
    return {
      ...context,
      rootKind:
        context.worktree.rootKind === "folder-root"
          ? ("folder-root" as const)
          : ("git-root" as const),
      targetPath: context.worktree.path,
    };
  };

  const retireRunConfigurationRuntimes = async (
    ownerId: string,
    projectId: string,
    filter: { configurationId?: string; worktreeId?: string } = {},
  ): Promise<void> => {
    while (true) {
      const runtimes = await repository.listRunConfigurationRuntimes(
        ownerId,
        projectId,
        { ...filter, limit: 256 },
      );
      if (runtimes.length === 0) return;
      for (const current of runtimes) {
        if (
          ["starting", "running", "restarting", "stopping"].includes(
            current.state,
          )
        ) {
          if (!bridge.isConnected(current.workerId)) {
            throw new WorkerUnavailableError(
              "Every active Run configuration worker must be online before deletion.",
            );
          }
          const target = await resolveRunConfigurationRuntimeTarget(
            ownerId,
            projectId,
            current.worktreeId,
          );
          const operationId = randomUUID();
          const durable =
            await repository.requestRunConfigurationRuntimeOperation(ownerId, {
              operationId,
              projectId,
              configurationId: current.configurationId,
              worktreeId: target.worktree.id,
              workerId: target.workerId,
              operation: "stop",
              definitionRevision: null,
              codexEnvironmentRevision: null,
            });
          const stopping = durable.runtime;
          if (!stopping?.terminalId) {
            throw new ExecutionLaneConflictError(
              "An active Run configuration instance lost its terminal binding.",
            );
          }
          const identity = {
            runtimeId: stopping.id,
            projectId: stopping.projectId,
            configurationId: stopping.configurationId,
            worktreeId: stopping.worktreeId,
            workerId: stopping.workerId,
            definitionRevision: stopping.definitionRevision,
            codexEnvironmentRevision: stopping.codexEnvironmentRevision,
            generation: stopping.generation,
            operationId: stopping.requestedOperationId,
            terminalId: stopping.terminalId,
          };
          const workerResult =
            runConfigurationRuntimeWorkerOperationResultSchema.parse(
              await bridge.request(
                target.workerId,
                {
                  type: "project.run-configuration-runtime.stop",
                  identity,
                },
                { timeoutMs: 30_000 },
              ),
            );
          if (
            !["accepted", "replayed"].includes(workerResult.outcome) ||
            !workerResult.observation
          ) {
            throw new ExecutionLaneConflictError(
              "The worker could not stop a Run configuration instance before deletion.",
            );
          }
          const applied =
            await repository.applyRunConfigurationRuntimeObservation(
              ownerId,
              target.workerId,
              workerResult.observation,
            );
          if (!applied?.applied || applied.reason === "invalid-transition") {
            throw new ExecutionLaneConflictError(
              "The stopped Run configuration instance could not be reconciled before deletion.",
            );
          }
          if (
            ["starting", "running", "restarting", "stopping"].includes(
              applied.runtime.state,
            )
          ) {
            throw new ExecutionLaneConflictError(
              "The Run configuration instance remained active after its stop request.",
            );
          }
          await updateTerminalStatus(applied.runtime.terminalId!, "exited");
          publishLiveInvalidation("run", {
            projectId,
            entityId: applied.runtime.id,
          });
        }
      }
      for (const runtime of runtimes) {
        if (!runtime.terminalId) continue;
        const deleted = await repository.deleteTerminal(
          ownerId,
          runtime.terminalId,
        );
        if (!deleted) {
          throw new ExecutionLaneConflictError(
            "A Run configuration terminal changed before deletion.",
          );
        }
        publishLiveInvalidation("terminal", {
          entityId: runtime.terminalId,
          projectId,
        });
      }
      const deleted = await repository.deleteRunConfigurationRuntimes(
        ownerId,
        projectId,
        runtimes.map(({ id }) => id),
      );
      if (deleted !== runtimes.length) {
        throw new ExecutionLaneConflictError(
          "A Run configuration instance became active during deletion.",
        );
      }
    }
  };

  const listRunConfigurationDefinitions = async (
    ownerId: string,
    projectId: string,
    operationId: string,
  ) => {
    const source = await resolvePrimaryRunConfigurationSource(
      ownerId,
      projectId,
    );
    const result = runConfigurationListResponseSchema.parse(
      await bridge.request(source.workerId, {
        type: "project.run-configuration-definitions.list",
        operationId,
        projectId,
        sourcePath: source.cwd,
      }),
    );
    if (result.operationId !== operationId || result.projectId !== projectId) {
      throw new Error("The Run configuration list response was misrouted.");
    }
    return { result, source };
  };

  const getRunConfigurationDefinition = async (
    ownerId: string,
    projectId: string,
    operationId: string,
    configurationId: string,
  ) => {
    const id = runConfigurationIdSchema.parse(configurationId);
    const source = await resolvePrimaryRunConfigurationSource(
      ownerId,
      projectId,
    );
    const result = runConfigurationGetResponseSchema.parse(
      await bridge.request(source.workerId, {
        type: "project.run-configuration-definitions.get",
        operationId,
        projectId,
        sourcePath: source.cwd,
        configurationId: id,
      }),
    );
    if (result.operationId !== operationId || result.projectId !== projectId) {
      throw new Error("The Run configuration read response was misrouted.");
    }
    const references =
      result.result.found &&
      result.result.entry.status === "ready" &&
      result.result.entry.document
        ? runConfigurationSecretReferences(result.result.entry.document)
        : [];
    return {
      result: runConfigurationGetResponseSchema.parse({
        ...result,
        secretReferences: await repository.getRunConfigurationSecretStatuses(
          ownerId,
          projectId,
          references,
        ),
      }),
      source,
    };
  };

  const detectRunConfigurationDefinitions = async (
    ownerId: string,
    projectId: string,
    operationId: string,
    provider: unknown,
  ) => {
    const input = runConfigurationDetectQuerySchema.parse({
      operationId,
      ...(provider == null ? {} : { provider }),
    });
    const source = await resolvePrimaryRunConfigurationSource(
      ownerId,
      projectId,
    );
    const result = runConfigurationDetectResponseSchema.parse(
      await bridge.request(source.workerId, {
        type: "project.run-configuration-definitions.detect",
        operationId,
        projectId,
        sourcePath: source.cwd,
        providerKind: input.provider ?? null,
      }),
    );
    if (result.operationId !== operationId || result.projectId !== projectId) {
      throw new Error(
        "The Run configuration detection response was misrouted.",
      );
    }
    return { result, source };
  };

  const discoverRunConfigurationDefinitionPaths = async (
    ownerId: string,
    projectId: string,
    operationId: string,
    purpose: unknown,
    query: unknown,
  ) => {
    const input = runConfigurationPathsQuerySchema.parse({
      operationId,
      purpose,
      ...(query == null ? {} : { query }),
    });
    const source = await resolvePrimaryRunConfigurationSource(
      ownerId,
      projectId,
    );
    const result = runConfigurationPathsResponseSchema.parse(
      await bridge.request(source.workerId, {
        type: "project.run-configuration-definitions.paths",
        operationId,
        projectId,
        sourcePath: source.cwd,
        purpose: input.purpose,
        query: input.query,
      }),
    );
    if (
      result.operationId !== operationId ||
      result.projectId !== projectId ||
      result.purpose !== input.purpose ||
      result.query !== input.query
    ) {
      throw new Error("The Run configuration path response was misrouted.");
    }
    return { result, source };
  };

  const validateRunConfigurationDefinition = async (
    ownerId: string,
    projectId: string,
    operationId: string,
    document: unknown,
  ) => {
    const input = runConfigurationApiValidateRequestSchema.parse({
      operationId,
      document,
    });
    const source = await resolvePrimaryRunConfigurationSource(
      ownerId,
      projectId,
    );
    const result = runConfigurationValidateResponseSchema.parse(
      await bridge.request(source.workerId, {
        type: "project.run-configuration-definitions.validate",
        operationId,
        projectId,
        sourcePath: source.cwd,
        document: input.document,
      }),
    );
    if (
      result.operationId !== operationId ||
      result.projectId !== projectId ||
      result.validation.configurationId !== input.document.id ||
      result.validation.provider !== input.document.provider
    ) {
      throw new Error(
        "The Run configuration validation response was misrouted.",
      );
    }
    return { result, source };
  };

  const inspectRunConfigurationFlutterDevices = async (
    ownerId: string,
    projectId: string,
    operationId: string,
    document: unknown,
  ) => {
    const input = runConfigurationApiFlutterDevicesRequestSchema.parse({
      operationId,
      document,
    });
    const source = await resolvePrimaryRunConfigurationSource(
      ownerId,
      projectId,
    );
    const result = runConfigurationFlutterDevicesResponseSchema.parse(
      await bridge.request(source.workerId, {
        type: "project.run-configuration-definitions.flutter-devices",
        operationId,
        projectId,
        sourcePath: source.cwd,
        document: input.document,
      }),
    );
    if (
      result.operationId !== operationId ||
      result.projectId !== projectId ||
      result.configurationId !== input.document.id
    ) {
      throw new Error("The Flutter device inspection response was misrouted.");
    }
    return { result, source };
  };

  const writeRunConfigurationDefinition = async (
    ownerId: string,
    projectId: string,
    operationId: string,
    expectedRevision: string | null,
    document: unknown,
  ) => {
    const input = runConfigurationApiWriteRequestSchema.parse({
      operationId,
      expectedRevision,
      document,
    });
    return worktreeCoordinator.serialize(
      projectId,
      async () => {
        const source = await resolvePrimaryRunConfigurationSource(
          ownerId,
          projectId,
        );
        const result = runConfigurationWriteResponseSchema.parse(
          await bridge.request(source.workerId, {
            type: "project.run-configuration-definitions.write",
            operationId,
            projectId,
            sourcePath: source.cwd,
            request: {
              expectedRevision: input.expectedRevision,
              document: input.document,
            },
          }),
        );
        if (
          result.operationId !== operationId ||
          result.projectId !== projectId
        ) {
          throw new Error(
            "The Run configuration write response was misrouted.",
          );
        }
        return { result, source };
      },
      { notifyProjectChanged: false },
    );
  };

  const deleteRunConfigurationDefinition = async (
    ownerId: string,
    projectId: string,
    operationId: string,
    configurationId: string,
    expectedRevision: string,
  ) =>
    worktreeCoordinator.serialize(
      projectId,
      async () => {
        const id = runConfigurationIdSchema.parse(configurationId);
        const input = runConfigurationApiDeleteRequestSchema.parse({
          operationId,
          expectedRevision,
        });
        const source = await resolvePrimaryRunConfigurationSource(
          ownerId,
          projectId,
        );
        const preflightOperationId = randomUUID();
        const preflight = (
          await getRunConfigurationDefinition(
            ownerId,
            projectId,
            preflightOperationId,
            id,
          )
        ).result;
        if (!preflight.result.found) {
          return {
            result: runConfigurationDeleteResponseSchema.parse({
              operation: "delete",
              operationId,
              projectId,
              result: { outcome: "not-found", id, currentRevision: null },
            }),
            source,
          };
        }
        if (preflight.result.entry.revision !== input.expectedRevision) {
          return {
            result: runConfigurationDeleteResponseSchema.parse({
              operation: "delete",
              operationId,
              projectId,
              result: {
                outcome: "revision-mismatch",
                id,
                currentRevision: preflight.result.entry.revision,
              },
            }),
            source,
          };
        }
        await retireRunConfigurationRuntimes(ownerId, projectId, {
          configurationId: id,
        });
        const result = runConfigurationDeleteResponseSchema.parse(
          await bridge.request(source.workerId, {
            type: "project.run-configuration-definitions.delete",
            operationId,
            projectId,
            sourcePath: source.cwd,
            request: { id, expectedRevision: input.expectedRevision },
          }),
        );
        if (
          result.operationId !== operationId ||
          result.projectId !== projectId
        ) {
          throw new Error(
            "The Run configuration delete response was misrouted.",
          );
        }
        if (result.result.outcome === "deleted") {
          publishLiveInvalidation("run-configuration", {
            entityId: id,
            projectId,
          });
        }
        return { result, source };
      },
      { notifyProjectChanged: false },
    );

  const operateRunConfigurationRuntime = async (
    ownerId: string,
    requestInput: unknown,
  ) => {
    const input =
      runConfigurationRuntimeLifecycleRequestSchema.parse(requestInput);
    return worktreeCoordinator.serialize(
      input.projectId,
      async () => {
        const replay =
          await repository.getRunConfigurationRuntimeOperationResult(
            ownerId,
            input.operationId,
          );
        if (replay) {
          if (
            replay.operation.projectId !== input.projectId ||
            replay.operation.configurationId !== input.configurationId ||
            replay.operation.operation !== input.operation ||
            (input.targetWorktreeId !== null &&
              replay.operation.worktreeId !== input.targetWorktreeId)
          ) {
            throw new CliCommandRequestError(
              "conflict",
              409,
              "The Run configuration operation ID is already bound to another request.",
            );
          }
          return runConfigurationRuntimeOperationResultSchema.parse(replay);
        }

        const target = await resolveRunConfigurationRuntimeTarget(
          ownerId,
          input.projectId,
          input.targetWorktreeId,
        );
        let definitionRevision: string | null = null;
        let codexEnvironmentRevision: string | null = null;
        let protectedSecrets: RunConfigurationProtectedSecret[] = [];
        if (input.operation !== "stop") {
          const definition = (
            await getRunConfigurationDefinition(
              ownerId,
              input.projectId,
              input.operationId,
              input.configurationId,
            )
          ).result;
          if (!definition.result.found) {
            throw new CliCommandRequestError(
              "not-found",
              404,
              "The Run configuration definition was not found in Primary.",
            );
          }
          if (
            definition.result.entry.status !== "ready" ||
            !definition.result.entry.revision ||
            !definition.result.entry.document
          ) {
            throw new ExecutionLaneConflictError(
              definition.result.entry.diagnostics[0]?.message ??
                "The Run configuration definition is invalid.",
            );
          }
          definitionRevision = definition.result.entry.revision;
          protectedSecrets = (
            await repository.listRunConfigurationProtectedSecrets(
              ownerId,
              input.projectId,
              runConfigurationSecretReferences(
                definition.result.entry.document,
              ),
            )
          ).map(({ updatedAt: _updatedAt, ...secret }) => secret);
          if (definition.codexEnvironment.enabled) {
            if (!definition.codexEnvironment.valid) {
              throw new ExecutionLaneConflictError(
                definition.codexEnvironment.diagnostics[0]?.message ??
                  "The Codex environment source is invalid.",
              );
            }
            codexEnvironmentRevision = definition.codexEnvironment.revision;
          }
        }

        const operationRequest =
          input.operation === "stop"
            ? {
                operationId: input.operationId,
                projectId: input.projectId,
                configurationId: input.configurationId,
                worktreeId: target.worktree.id,
                workerId: target.workerId,
                operation: "stop" as const,
                definitionRevision: null,
                codexEnvironmentRevision: null,
              }
            : {
                operationId: input.operationId,
                projectId: input.projectId,
                configurationId: input.configurationId,
                worktreeId: target.worktree.id,
                workerId: target.workerId,
                operation: input.operation,
                definitionRevision: definitionRevision!,
                codexEnvironmentRevision,
              };
        const durable =
          await repository.requestRunConfigurationRuntimeOperation(
            ownerId,
            operationRequest,
          );
        if (durable.operation.outcome !== "accepted") {
          return runConfigurationRuntimeOperationResultSchema.parse(durable);
        }
        const runtime = durable.runtime;
        if (!runtime?.terminalId) {
          throw new Error(
            "The accepted Run configuration runtime has no terminal binding.",
          );
        }
        const identity = {
          runtimeId: runtime.id,
          projectId: runtime.projectId,
          configurationId: runtime.configurationId,
          worktreeId: runtime.worktreeId,
          workerId: runtime.workerId,
          definitionRevision: runtime.definitionRevision,
          codexEnvironmentRevision: runtime.codexEnvironmentRevision,
          generation: runtime.generation,
          operationId: runtime.requestedOperationId,
          terminalId: runtime.terminalId,
        };
        let workerResult;
        try {
          workerResult =
            runConfigurationRuntimeWorkerOperationResultSchema.parse(
              await bridge.request(
                target.workerId,
                input.operation === "stop"
                  ? {
                      type: "project.run-configuration-runtime.stop",
                      identity,
                    }
                  : {
                      type:
                        input.operation === "start"
                          ? "project.run-configuration-runtime.start"
                          : "project.run-configuration-runtime.restart",
                      identity,
                      rootKind: target.rootKind,
                      sourcePath: target.sourcePath,
                      targetPath: target.targetPath,
                      protectedSecrets,
                    },
                { timeoutMs: 30_000 },
              ),
            );
        } catch (error) {
          const failed = runConfigurationRuntimeWorkerObservationSchema.parse({
            ...identity,
            state: "failed",
            startedAt: runtime.startedAt,
            endedAt: new Date().toISOString(),
            exitCode: null,
            signal: null,
            failure: {
              phase: input.operation === "stop" ? "stop" : "spawn",
              code: "worker-request-failed",
              message: errorMessage(error).slice(0, 1_000),
              retryable: true,
            },
          });
          const applied =
            await repository.applyRunConfigurationRuntimeObservation(
              ownerId,
              target.workerId,
              failed,
            );
          if (applied?.runtime.terminalId) {
            await updateTerminalStatus(applied.runtime.terminalId, "failed");
          }
          publishLiveInvalidation("run", {
            projectId: input.projectId,
            entityId: runtime.id,
          });
          throw error;
        }
        if (
          workerResult.outcome !== "accepted" &&
          workerResult.outcome !== "replayed"
        ) {
          const rejected = runConfigurationRuntimeWorkerObservationSchema.parse(
            {
              ...identity,
              state: "failed",
              startedAt: runtime.startedAt,
              endedAt: new Date().toISOString(),
              exitCode: null,
              signal: null,
              failure: {
                phase: "reconcile",
                code:
                  workerResult.outcome === "not-found"
                    ? "worker-runtime-not-found"
                    : "worker-runtime-stale",
                message:
                  workerResult.outcome === "not-found"
                    ? "The worker no longer has this Run configuration runtime."
                    : "The worker rejected stale Run configuration lifecycle state.",
                retryable: true,
              },
            },
          );
          const rejectedApply =
            await repository.applyRunConfigurationRuntimeObservation(
              ownerId,
              target.workerId,
              rejected,
            );
          if (rejectedApply?.applied && rejectedApply.runtime.terminalId) {
            await updateTerminalStatus(
              rejectedApply.runtime.terminalId,
              "failed",
            );
            publishLiveInvalidation("run", {
              projectId: rejectedApply.runtime.projectId,
              entityId: rejectedApply.runtime.id,
            });
          }
          throw new ExecutionLaneConflictError(
            workerResult.outcome === "not-found"
              ? "The worker no longer has this Run configuration runtime."
              : "The worker rejected stale Run configuration lifecycle state.",
          );
        }
        if (!workerResult.observation) {
          throw new Error(
            "The worker omitted the Run configuration runtime observation.",
          );
        }
        const applied =
          await repository.applyRunConfigurationRuntimeObservation(
            ownerId,
            target.workerId,
            workerResult.observation,
          );
        if (!applied) {
          throw new Error(
            "The Run configuration runtime observation was unauthorized.",
          );
        }
        if (applied.reason === "invalid-transition") {
          const invalid = runConfigurationRuntimeWorkerObservationSchema.parse({
            ...identity,
            state: "failed",
            startedAt: runtime.startedAt,
            endedAt: new Date().toISOString(),
            exitCode: null,
            signal: null,
            failure: {
              phase: "reconcile",
              code: "worker-invalid-transition",
              message:
                "The worker returned an invalid Run configuration state transition.",
              retryable: true,
            },
          });
          const invalidApply =
            await repository.applyRunConfigurationRuntimeObservation(
              ownerId,
              target.workerId,
              invalid,
            );
          if (invalidApply?.applied && invalidApply.runtime.terminalId) {
            await updateTerminalStatus(
              invalidApply.runtime.terminalId,
              "failed",
            );
            publishLiveInvalidation("run", {
              projectId: invalidApply.runtime.projectId,
              entityId: invalidApply.runtime.id,
            });
          }
          throw new ExecutionLaneConflictError(
            "The worker returned an invalid Run configuration state transition.",
          );
        }
        if (applied.runtime.terminalId) {
          await updateTerminalStatus(
            applied.runtime.terminalId,
            ["starting", "running", "restarting", "stopping"].includes(
              applied.runtime.state,
            )
              ? "running"
              : applied.runtime.state === "failed"
                ? "failed"
                : "exited",
          );
        }
        publishLiveInvalidation("run", {
          projectId: applied.runtime.projectId,
          entityId: applied.runtime.id,
        });
        return runConfigurationRuntimeOperationResultSchema.parse({
          ...durable,
          runtime: applied.runtime,
        });
      },
      { notifyProjectChanged: false },
    );
  };

  const queryRunConfigurationRuntimeStatus = async (
    ownerId: string,
    requestInput: unknown,
  ) => {
    const input = runConfigurationRuntimeStatusQuerySchema.parse(requestInput);
    return runConfigurationRuntimeStatusResultSchema.parse({
      operationId: input.operationId,
      projectId: input.projectId,
      runtimes: await repository.listRunConfigurationRuntimes(
        ownerId,
        input.projectId,
        {
          configurationId: input.configurationId ?? undefined,
          worktreeId: input.targetWorktreeId ?? undefined,
          limit: input.limit,
        },
      ),
    });
  };

  const readRunConfigurationRuntimeOutput = async (
    ownerId: string,
    requestInput: unknown,
  ) => {
    const input = runConfigurationRuntimeOutputQuerySchema.parse(requestInput);
    const runtime = await repository.getRunConfigurationRuntime(
      ownerId,
      input.projectId,
      input.configurationId,
      input.worktreeId,
    );
    if (!runtime?.terminalId) {
      throw new CliCommandRequestError(
        "not-found",
        404,
        "Run configuration runtime not found.",
      );
    }
    if (!bridge.isConnected(runtime.workerId)) {
      throw new CliCommandRequestError(
        "unavailable",
        503,
        "The Run configuration worker is offline.",
      );
    }
    const protectedOutput =
      protectedRunConfigurationRuntimeWorkerOutputSchema.parse(
        await bridge.request(runtime.workerId, {
          type: "project.run-configuration-runtime.output",
          requestOperationId: input.operationId,
          serverId,
          identity: {
            runtimeId: runtime.id,
            projectId: runtime.projectId,
            configurationId: runtime.configurationId,
            worktreeId: runtime.worktreeId,
            workerId: runtime.workerId,
            definitionRevision: runtime.definitionRevision,
            codexEnvironmentRevision: runtime.codexEnvironmentRevision,
            generation: runtime.generation,
            operationId: runtime.requestedOperationId,
            terminalId: runtime.terminalId,
          },
          tail: input.tail,
        }),
      );
    if (
      protectedOutput.requestOperationId !== input.operationId ||
      protectedOutput.identity.runtimeId !== runtime.id ||
      protectedOutput.identity.projectId !== runtime.projectId ||
      protectedOutput.identity.configurationId !== runtime.configurationId ||
      protectedOutput.identity.worktreeId !== runtime.worktreeId ||
      protectedOutput.identity.workerId !== runtime.workerId ||
      protectedOutput.identity.definitionRevision !==
        runtime.definitionRevision ||
      protectedOutput.identity.codexEnvironmentRevision !==
        runtime.codexEnvironmentRevision ||
      protectedOutput.identity.generation !== runtime.generation ||
      protectedOutput.identity.operationId !== runtime.requestedOperationId ||
      protectedOutput.identity.terminalId !== runtime.terminalId
    ) {
      throw new Error("The Run configuration output response was misrouted.");
    }
    return protectedRunConfigurationRuntimeOutputResultSchema.parse({
      operationId: input.operationId,
      projectId: runtime.projectId,
      configurationId: runtime.configurationId,
      worktreeId: runtime.worktreeId,
      generation: runtime.generation,
      protectedOutput: protectedOutput.protectedOutput,
    });
  };

  const installAppRuntimeRoutes = (app: FastifyInstance): void => {
    app.post(
      "/api/run-configuration-runtimes/operations",
      async (request, reply) => {
        const input = runConfigurationRuntimeLifecycleRequestSchema.safeParse(
          request.body,
        );
        if (!input.success) {
          return reply.code(400).send(invalidBody(input.error.issues));
        }
        try {
          const result = await operateRunConfigurationRuntime(
            applicationOwnerId(),
            input.data,
          );
          await appendAudit(request, {
            action: `run.configuration.app.${input.data.operation}`,
            resourceId: input.data.configurationId,
            resourceType: "run-configuration-runtime",
            result: "succeeded",
          });
          return reply
            .code(
              result.operation.outcome === "accepted" && !result.replayed
                ? 202
                : 200,
            )
            .send(result);
        } catch (error) {
          return sendRunApiFailure(reply, error);
        }
      },
    );

    app.post(
      "/api/run-configuration-runtimes/status",
      async (request, reply) => {
        const input = runConfigurationRuntimeStatusQuerySchema.safeParse(
          request.body,
        );
        if (!input.success) {
          return reply.code(400).send(invalidBody(input.error.issues));
        }
        return reply.send(
          await queryRunConfigurationRuntimeStatus(
            applicationOwnerId(),
            input.data,
          ),
        );
      },
    );

    app.post(
      "/api/run-configuration-runtimes/output",
      async (request, reply) => {
        const input = runConfigurationRuntimeOutputQuerySchema.safeParse(
          request.body,
        );
        if (!input.success) {
          return reply.code(400).send(invalidBody(input.error.issues));
        }
        try {
          return reply.send(
            await readRunConfigurationRuntimeOutput(
              applicationOwnerId(),
              input.data,
            ),
          );
        } catch (error) {
          return sendRunApiFailure(reply, error);
        }
      },
    );
  };

  const installProjectRoutes = (app: FastifyInstance): void => {
    app.get<{
      Params: { projectId: string };
      Querystring: { operationId?: string };
    }>(
      "/api/projects/:projectId/run-configurations",
      async (request, reply) => {
        const input = runConfigurationListQuerySchema.safeParse(request.query);
        if (!input.success) {
          return reply.code(400).send(invalidBody(input.error.issues));
        }
        try {
          const { result } = await listRunConfigurationDefinitions(
            applicationOwnerId(),
            request.params.projectId,
            input.data.operationId,
          );
          return reply.send(result);
        } catch (error) {
          return sendRunApiFailure(reply, error);
        }
      },
    );

    app.get<{
      Params: { projectId: string };
      Querystring: { operationId?: string };
    }>(
      "/api/projects/:projectId/run-configurations/capabilities",
      async (request, reply) => {
        const input = runConfigurationListQuerySchema.safeParse(request.query);
        if (!input.success) {
          return reply.code(400).send(invalidBody(input.error.issues));
        }
        try {
          const source = await resolvePrimaryRunConfigurationSource(
            applicationOwnerId(),
            request.params.projectId,
          );
          const result = runConfigurationCapabilitiesResponseSchema.parse(
            await bridge.request(source.workerId, {
              type: "project.run-configuration-definitions.capabilities",
              operationId: input.data.operationId,
              projectId: request.params.projectId,
              sourcePath: source.cwd,
            }),
          );
          if (
            result.operationId !== input.data.operationId ||
            result.projectId !== request.params.projectId
          ) {
            throw new Error(
              "The Run configuration capability response was misrouted.",
            );
          }
          return reply.send(result);
        } catch (error) {
          return sendRunApiFailure(reply, error);
        }
      },
    );

    app.get<{
      Params: { projectId: string };
      Querystring: { operationId?: string; provider?: string };
    }>(
      "/api/projects/:projectId/run-configurations/detect",
      async (request, reply) => {
        const input = runConfigurationDetectQuerySchema.safeParse(
          request.query,
        );
        if (!input.success) {
          return reply.code(400).send(invalidBody(input.error.issues));
        }
        try {
          const { result } = await detectRunConfigurationDefinitions(
            applicationOwnerId(),
            request.params.projectId,
            input.data.operationId,
            input.data.provider,
          );
          return reply.send(result);
        } catch (error) {
          return sendRunApiFailure(reply, error);
        }
      },
    );

    app.get<{
      Params: { projectId: string };
      Querystring: { operationId?: string; purpose?: string; query?: string };
    }>(
      "/api/projects/:projectId/run-configurations/paths",
      async (request, reply) => {
        const input = runConfigurationPathsQuerySchema.safeParse(request.query);
        if (!input.success) {
          return reply.code(400).send(invalidBody(input.error.issues));
        }
        try {
          const { result } = await discoverRunConfigurationDefinitionPaths(
            applicationOwnerId(),
            request.params.projectId,
            input.data.operationId,
            input.data.purpose,
            input.data.query,
          );
          return reply.send(result);
        } catch (error) {
          return sendRunApiFailure(reply, error);
        }
      },
    );

    app.post<{
      Body: { document?: unknown; operationId?: string };
      Params: { projectId: string };
    }>(
      "/api/projects/:projectId/run-configurations/validate",
      async (request, reply) => {
        const input = runConfigurationApiValidateRequestSchema.safeParse(
          request.body,
        );
        if (!input.success) {
          return reply.code(400).send(invalidBody(input.error.issues));
        }
        try {
          const { result } = await validateRunConfigurationDefinition(
            applicationOwnerId(),
            request.params.projectId,
            input.data.operationId,
            input.data.document,
          );
          return reply.send(result);
        } catch (error) {
          return sendRunApiFailure(reply, error);
        }
      },
    );

    app.post<{
      Body: { document?: unknown; operationId?: string };
      Params: { projectId: string };
    }>(
      "/api/projects/:projectId/run-configurations/flutter-devices",
      async (request, reply) => {
        const input = runConfigurationApiFlutterDevicesRequestSchema.safeParse(
          request.body,
        );
        if (!input.success) {
          return reply.code(400).send(invalidBody(input.error.issues));
        }
        try {
          const { result } = await inspectRunConfigurationFlutterDevices(
            applicationOwnerId(),
            request.params.projectId,
            input.data.operationId,
            input.data.document,
          );
          await appendAudit(request, {
            action: "run.configuration.app.flutter-devices-inspected",
            resourceId: input.data.document.id,
            resourceType: "run-configuration",
            result: "succeeded",
          });
          return reply.send(result);
        } catch (error) {
          return sendRunApiFailure(reply, error);
        }
      },
    );

    app.get<{
      Params: { configurationId: string; projectId: string };
      Querystring: { operationId?: string };
    }>(
      "/api/projects/:projectId/run-configurations/:configurationId",
      async (request, reply) => {
        const input = runConfigurationListQuerySchema.safeParse(request.query);
        if (!input.success) {
          return reply.code(400).send(invalidBody(input.error.issues));
        }
        const configurationId = runConfigurationIdSchema.safeParse(
          request.params.configurationId,
        );
        if (!configurationId.success) {
          return reply
            .code(400)
            .send(invalidBody(configurationId.error.issues));
        }
        try {
          const { result } = await getRunConfigurationDefinition(
            applicationOwnerId(),
            request.params.projectId,
            input.data.operationId,
            configurationId.data,
          );
          return reply.send(result);
        } catch (error) {
          return sendRunApiFailure(reply, error);
        }
      },
    );

    app.put<{
      Params: { configurationId: string; projectId: string };
    }>(
      "/api/projects/:projectId/run-configurations/:configurationId",
      async (request, reply) => {
        const input = runConfigurationApiWriteRequestSchema.safeParse(
          request.body,
        );
        if (!input.success) {
          return reply.code(400).send(invalidBody(input.error.issues));
        }
        if (input.data.document.id !== request.params.configurationId) {
          return reply.code(400).send({
            code: "configuration-id-mismatch",
            error: "The route and document configuration IDs must match.",
          });
        }
        try {
          const { result } = await writeRunConfigurationDefinition(
            applicationOwnerId(),
            request.params.projectId,
            input.data.operationId,
            input.data.expectedRevision,
            input.data.document,
          );
          if (!("entry" in result.result)) {
            return reply.code(409).send(result);
          }
          await appendAudit(request, {
            action:
              result.result.outcome === "created"
                ? "run.configuration.app.created"
                : "run.configuration.app.updated",
            resourceId: input.data.document.id,
            resourceType: "run-configuration",
            result: "succeeded",
          });
          return reply
            .code(result.result.outcome === "created" ? 201 : 200)
            .send(result);
        } catch (error) {
          return sendRunApiFailure(reply, error);
        }
      },
    );

    app.delete<{
      Params: { configurationId: string; projectId: string };
    }>(
      "/api/projects/:projectId/run-configurations/:configurationId",
      async (request, reply) => {
        const input = runConfigurationApiDeleteRequestSchema.safeParse(
          request.body,
        );
        if (!input.success) {
          return reply.code(400).send(invalidBody(input.error.issues));
        }
        const configurationId = runConfigurationIdSchema.safeParse(
          request.params.configurationId,
        );
        if (!configurationId.success) {
          return reply
            .code(400)
            .send(invalidBody(configurationId.error.issues));
        }
        try {
          const { result } = await deleteRunConfigurationDefinition(
            applicationOwnerId(),
            request.params.projectId,
            input.data.operationId,
            configurationId.data,
            input.data.expectedRevision,
          );
          if (result.result.outcome === "not-found") {
            return reply.code(404).send(result);
          }
          if (result.result.outcome === "revision-mismatch") {
            return reply.code(409).send(result);
          }
          await appendAudit(request, {
            action: "run.configuration.app.deleted",
            resourceId: configurationId.data,
            resourceType: "run-configuration",
            result: "succeeded",
          });
          return reply.send(result);
        } catch (error) {
          return sendRunApiFailure(reply, error);
        }
      },
    );
  };

  return {
    deleteRunConfigurationDefinition,
    detectRunConfigurationDefinitions,
    getRunConfigurationDefinition,
    installAppRuntimeRoutes,
    installProjectRoutes,
    listRunConfigurationDefinitions,
    operateRunConfigurationRuntime,
    queryRunConfigurationRuntimeStatus,
    readRunConfigurationRuntimeOutput,
    resolveAppRunContext,
    resolvePrimaryRunConfigurationSource,
    resolveRunConfigurationRuntimeTarget,
    retireRunConfigurationRuntimes,
    sendRunApiFailure,
    writeRunConfigurationDefinition,
  };
}
