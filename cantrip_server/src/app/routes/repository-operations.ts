import {
  repositoryOperationWireRequestSchema,
  repositoryOperationWireResponseSchema,
  repositoryWorkerOperationWireRequestSchema,
} from "@cantrip/protocol/repository-operation";
import type { FastifyInstance } from "fastify";

import { principalOwnerId } from "../../auth/principal.js";
import type { ModelRuntime, ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { ProjectWorktreeCoordinator } from "../../worktrees/coordinator.js";
import { FINITE_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";

type RepositoryOperationResponse = ReturnType<
  typeof repositoryOperationWireResponseSchema.parse
>;
type RepositoryAgentExecution = NonNullable<
  RepositoryOperationResponse["agentExecution"]
>;

export interface RepositoryOperationRouteDependencies {
  availableModelRuntimes: (
    context: { providerAccountId?: string | null; workerId: string },
    modelId: string,
  ) => Promise<ModelRuntime[]>;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  recordRuntimeTokenUsage: (
    sourceKey: string,
    projectId: string,
    chatId: null,
    runtime: ModelRuntime,
    usage: RepositoryAgentExecution["measuredUsage"],
    attribution: {
      workerId: string;
      turnId: string;
      executionAttemptId: string;
      attemptKind: "git-agent";
      attemptStatus: "completed";
    },
  ) => Promise<void>;
  repository: Pick<
    ServerRepository,
    | "getGithubProjectExecutionContext"
    | "getProjectWorktreeContext"
    | "getUserSettings"
    | "getWorker"
    | "listEffectiveMcpServers"
  >;
  serverId: string;
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "serialize">;
}

export function installRepositoryOperationRoutes(
  app: FastifyInstance,
  {
    availableModelRuntimes,
    bridge,
    recordRuntimeTokenUsage,
    repository,
    serverId,
    worktreeCoordinator,
  }: RepositoryOperationRouteDependencies,
): void {
  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/repository-operation",
    { bodyLimit: 24 * 1_024 * 1_024 },
    async (request, reply) => {
      const input = repositoryOperationWireRequestSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = principalOwnerId(request);
      const context = await repository.getProjectWorktreeContext(
        ownerId,
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      if (!bridge.isConnected(context.workerId)) {
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      const githubContext = await repository.getGithubProjectExecutionContext(
        ownerId,
        request.params.projectId,
        context.workerId,
      );
      try {
        const agentModelId = input.data.agent
          ? (input.data.modelId ??
            (await repository.getUserSettings(ownerId)).defaultModelId)
          : null;
        if (input.data.agent && !agentModelId) {
          return reply.code(409).send({
            error:
              "Choose a model or configure a default model before using repository agent assistance.",
          });
        }
        const agentRuntimes = agentModelId
          ? await availableModelRuntimes(context, agentModelId)
          : [];
        const mcpServers = input.data.agent
          ? await repository.listEffectiveMcpServers(
              ownerId,
              request.params.projectId,
              context.workerId,
            )
          : [];
        const dispatch = () =>
          bridge.request(
            context.workerId,
            {
              type: "repository.operation" as const,
              serverId,
              projectId: request.params.projectId,
              worktreeId: request.params.worktreeId,
              cwd: context.worktree.path,
              sourcePath: context.sourcePath,
              repository:
                githubContext?.workerId === context.workerId
                  ? githubContext.nameWithOwner
                  : null,
              ...input.data,
              modelId: agentModelId ?? undefined,
              agentRuntimes: agentRuntimes.map((runtime) => ({
                routeId: runtime.routeId,
                model: runtime.model,
                provider: runtime.provider,
              })),
              mcpServers,
              routingPurpose: "repository" as const,
            },
            { ownerId, timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
          );
        const result = repositoryOperationWireResponseSchema.parse(
          await worktreeCoordinator.serialize(
            request.params.projectId,
            dispatch,
            { notifyProjectChanged: input.data.access === "write" },
          ),
        );
        if (result.agentExecution) {
          const runtime = agentRuntimes.find(
            (candidate) => candidate.routeId === result.agentExecution!.routeId,
          );
          if (!runtime) {
            return reply.code(502).send({
              error: "Worker returned an unknown repository agent route.",
            });
          }
          const attemptId = `${input.data.operationId}:${runtime.routeId}`;
          await recordRuntimeTokenUsage(
            `git-agent:${attemptId}`,
            request.params.projectId,
            null,
            runtime,
            result.agentExecution.measuredUsage,
            {
              workerId: context.workerId,
              turnId: result.agentExecution.turnId,
              executionAttemptId: attemptId,
              attemptKind: "git-agent",
              attemptStatus: "completed",
            },
          );
        }
        return reply.send(result);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { workerId: string } }>(
    "/api/workers/:workerId/repository-operation",
    { bodyLimit: 24 * 1_024 * 1_024 },
    async (request, reply) => {
      const input = repositoryWorkerOperationWireRequestSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const ownerId = principalOwnerId(request);
      const worker = await repository.getWorker(
        ownerId,
        request.params.workerId,
      );
      if (!worker) return reply.code(404).send({ error: "Worker not found." });
      if (!bridge.isConnected(request.params.workerId)) {
        return reply.code(503).send({ error: "Worker is offline." });
      }
      try {
        const { scopeId, ...wireRequest } = input.data;
        if (wireRequest.agent) {
          return reply.code(400).send({
            error: "Repository agent operations require a project worktree.",
          });
        }
        const result = await bridge.request(
          request.params.workerId,
          {
            type: "repository.operation",
            serverId,
            projectId: scopeId,
            worktreeId: request.params.workerId,
            cwd: ".",
            sourcePath: ".",
            repository: null,
            agentRuntimes: [],
            mcpServers: [],
            routingPurpose: "repository" as const,
            ...wireRequest,
          },
          { ownerId, timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
        );
        return reply.send(repositoryOperationWireResponseSchema.parse(result));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
