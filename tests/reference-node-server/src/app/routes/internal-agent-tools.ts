import {
  CANTRIP_MCP_BINDING_PROTOCOL_VERSIONS,
  CANTRIP_MCP_OPERATIONS,
  cantripAgentOperationResultSchema,
  cantripCliCommandResultSchema,
  compatibleWorkerCantripMcpOperationCallSchema,
  isCantripMcpMutationOperation,
  workerCantripMcpCapabilitiesQuerySchema,
  workerCliCommandCallSchema,
  type CantripAgentOperationName,
  type CantripAgentOperationRequest,
  type CantripAgentOperationResult,
  type CantripCliCommandResult,
  type WorkerCliCommandCall,
} from "@cantrip/protocol";
import { runConfigurationRuntimeOperationResultSchema } from "@cantrip/protocol/run-configuration-runtime";
import type { FastifyInstance } from "fastify";

import {
  assertCantripMcpBinding,
  cantripMcpBindingReadiness,
  CantripMcpBindingError,
} from "../../agent-tools/binding.js";
import { CliCommandRequestError } from "../../agent-tools/errors.js";
import type { ServerConfig } from "../../config.js";
import {
  ExecutionLaneConflictError,
  ExecutionPlacementUnavailableError,
  SurfacePrivateStateConflictError,
  type ChatExecutionContext,
  type ServerRepository,
} from "../../db/repository.js";
import type { AppendAudit } from "../http/audit.js";
import type { ApplicationOwnerContext } from "../http/owner-context.js";
import {
  errorMessage,
  invalidBody,
  optionalToolString,
} from "../../http/request-helpers.js";
import { WorkerUnavailableError } from "../../workers/bridge.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import { WorktreeCreateMutationError } from "../../worktrees/coordinator.js";

export interface InternalAgentToolRouteDependencies {
  appendAudit: AppendAudit;
  cliCommandIsMutation: (command: WorkerCliCommandCall["command"]) => boolean;
  config: ServerConfig;
  executeAgentOperation: (
    context: ChatExecutionContext,
    request: CantripAgentOperationRequest,
  ) => Promise<CantripAgentOperationResult>;
  executeCliCommand: (
    call: WorkerCliCommandCall,
  ) => Promise<CantripCliCommandResult>;
  repository: Pick<
    ServerRepository,
    "authenticateWorkerCredential" | "getChatExecutionContext" | "getWorker"
  >;
  runAsOwner: ApplicationOwnerContext["runAsOwner"];
}

/** Registers worker-authenticated managed MCP and CLI agent-tool transports. */
export function installInternalAgentToolRoutes(
  app: FastifyInstance,
  {
    appendAudit,
    cliCommandIsMutation,
    config,
    executeAgentOperation,
    executeCliCommand,
    repository,
    runAsOwner,
  }: InternalAgentToolRouteDependencies,
): void {
  const mcpOperations: ReadonlySet<CantripAgentOperationName> = new Set(
    CANTRIP_MCP_OPERATIONS,
  );
  app.get(
    "/api/internal/agent-operations/capabilities",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerCantripMcpCapabilitiesQuerySchema.safeParse(
        request.query,
      );
      if (!input.success) {
        return reply.code(400).send({
          code: "invalid",
          ...invalidBody(input.error.issues),
        });
      }
      const workerAuth = await authenticateWorkerRequest(
        repository,
        config,
        request,
        input.data.workerId,
        "worker:agent-tools",
      );
      if (!workerAuth) {
        return reply.code(401).send({
          code: "invalid",
          error: "Unauthorized",
        });
      }
      if (
        !(await repository.getWorker(workerAuth.ownerId, input.data.workerId))
      ) {
        return reply.code(404).send({
          code: "not-found",
          error: "Worker not found.",
        });
      }
      return reply.send({
        bindingProtocolVersions: [...CANTRIP_MCP_BINDING_PROTOCOL_VERSIONS],
        operations: [...CANTRIP_MCP_OPERATIONS],
      });
    },
  );
  app.post(
    "/api/internal/agent-operations",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = compatibleWorkerCantripMcpOperationCallSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send({
          code: "incompatible-worker-protocol",
          error:
            "Cantrip worker/server MCP relay protocol mismatch. This is not a tool argument error. Do not retry this MCP call or change its arguments; use the Cantrip CLI fallback for this turn and report that the worker/server deployment needs updating.",
          issues: input.error.issues,
        });
      }
      const workerAuth = await authenticateWorkerRequest(
        repository,
        config,
        request,
        input.data.binding.workerId,
        "worker:agent-tools",
      );
      if (!workerAuth) {
        return reply.code(401).send({
          code: "invalid",
          error: "Unauthorized",
        });
      }
      return runAsOwner(workerAuth.ownerId, async () => {
        try {
          const context = await repository.getChatExecutionContext(
            workerAuth.ownerId,
            input.data.binding.chatId,
          );
          if (!context) {
            throw new CantripMcpBindingError(
              "stale-binding",
              409,
              "The MCP binding chat context no longer exists.",
            );
          }
          assertCantripMcpBinding({
            binding: input.data.binding,
            context,
            operation: input.data.request.operation,
            ownerId: workerAuth.ownerId,
            serverAllowedOperations: mcpOperations,
          });
          let result = await executeAgentOperation(context, input.data.request);
          if (input.data.request.operation === "context.get") {
            const readiness = cantripMcpBindingReadiness({
              binding: input.data.binding,
              context,
              serverAllowedOperations: mcpOperations,
            });
            const suffix =
              readiness.status === "ready"
                ? " Managed MCP mutations are ready."
                : readiness.status === "read-only"
                  ? " This managed MCP attachment is read-only."
                  : " This managed MCP attachment requires a fresh Cantrip turn before mutations.";
            const data =
              result.data &&
              typeof result.data === "object" &&
              !Array.isArray(result.data)
                ? result.data
                : {};
            result = cantripAgentOperationResultSchema.parse({
              ...result,
              summary: `${result.summary.slice(0, 2_000 - suffix.length)}${suffix}`,
              data: { ...data, binding: readiness },
            });
          }
          const runConfigurationResult = [
            "run-configuration.start",
            "run-configuration.restart",
            "run-configuration.stop",
          ].includes(input.data.request.operation)
            ? runConfigurationRuntimeOperationResultSchema.safeParse(
                result.data,
              )
            : null;
          await appendAudit(request, {
            action:
              input.data.request.operation === "run-configuration.start"
                ? "run-configuration.mcp.started"
                : input.data.request.operation === "run-configuration.restart"
                  ? "run-configuration.mcp.restarted"
                  : input.data.request.operation === "run-configuration.stop"
                    ? "run-configuration.mcp.stopped"
                    : input.data.request.operation ===
                        "run-configuration.delete"
                      ? "run-configuration.mcp.deleted"
                      : isCantripMcpMutationOperation(
                            input.data.request.operation,
                          )
                        ? "mcp.operation.mutated"
                        : "mcp.operation.executed",
            actorSessionId: null,
            actorUserId: null,
            ownerId: workerAuth.ownerId,
            resourceId: runConfigurationResult?.success
              ? runConfigurationResult.data.operation.configurationId
              : input.data.binding.bindingId,
            resourceType: runConfigurationResult?.success
              ? "run-configuration"
              : "mcp-binding",
            result: "succeeded",
          });
          return reply.send(cantripAgentOperationResultSchema.parse(result));
        } catch (error) {
          const mutationFailure =
            error instanceof WorktreeCreateMutationError ? error.failure : null;
          const operationError = mutationFailure
            ? new CantripMcpBindingError(
                mutationFailure.mutation.outcome === "notStarted"
                  ? "not-found"
                  : "conflict",
                mutationFailure.mutation.outcome === "notStarted" ? 404 : 409,
                mutationFailure.error,
              )
            : error instanceof CantripMcpBindingError
              ? error
              : error instanceof CliCommandRequestError
                ? new CantripMcpBindingError(
                    error.code,
                    error.status,
                    error.message,
                  )
                : error instanceof WorkerUnavailableError
                  ? new CantripMcpBindingError(
                      "unavailable",
                      503,
                      errorMessage(error),
                    )
                  : error instanceof ExecutionPlacementUnavailableError
                    ? new CantripMcpBindingError(
                        error.code === "worker-offline" ||
                          error.code === "capability-unavailable"
                          ? "unavailable"
                          : "conflict",
                        error.code === "worker-offline" ||
                          error.code === "capability-unavailable"
                          ? 503
                          : 409,
                        errorMessage(error),
                      )
                    : error instanceof ExecutionLaneConflictError
                      ? new CantripMcpBindingError(
                          "stale-binding",
                          409,
                          errorMessage(error),
                        )
                      : error instanceof SurfacePrivateStateConflictError
                        ? new CantripMcpBindingError(
                            "conflict",
                            409,
                            "Browser state changed before this operation.",
                          )
                        : new CantripMcpBindingError(
                            "invalid",
                            400,
                            error instanceof Error && error.name === "ZodError"
                              ? "Cantrip MCP operation validation failed on the server."
                              : errorMessage(error).slice(0, 2_000),
                          );
          await appendAudit(request, {
            action: "mcp.operation.rejected",
            actorSessionId: null,
            actorUserId: null,
            ownerId: workerAuth.ownerId,
            resourceId: input.data.binding.bindingId,
            resourceType: "mcp-binding",
            result:
              operationError.code === "forbidden" ||
              operationError.code === "stale-binding" ||
              operationError.code === "expired"
                ? "denied"
                : "failed",
          });
          return reply.code(operationError.status).send(
            mutationFailure ?? {
              code: operationError.code,
              error: operationError.message,
            },
          );
        }
      });
    },
  );

  app.post(
    "/api/internal/cli",
    { logLevel: "warn" },
    async (request, reply) => {
      const input = workerCliCommandCallSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send({
          code: "invalid",
          ...invalidBody(input.error.issues),
        });
      }
      const workerAuth = await authenticateWorkerRequest(
        repository,
        config,
        request,
        input.data.workerId,
        "worker:agent-tools",
      );
      if (!workerAuth) {
        return reply.code(401).send({
          code: "invalid",
          error: "Unauthorized",
        });
      }
      if (
        !(await repository.getWorker(workerAuth.ownerId, input.data.workerId))
      ) {
        return reply.code(404).send({
          code: "not-found",
          error: "Worker not found.",
        });
      }
      return runAsOwner(workerAuth.ownerId, async () => {
        const mutation = cliCommandIsMutation(input.data.command);
        try {
          const result = await executeCliCommand(input.data);
          if (mutation) {
            const configurationId = optionalToolString(
              input.data.arguments,
              "configurationId",
            );
            const runConfigurationMutation =
              input.data.command.startsWith("run.");
            await appendAudit(request, {
              action: runConfigurationMutation
                ? `run.configuration.cli.${input.data.command.slice("run.".length)}`
                : "cli.command.mutated",
              actorSessionId: null,
              actorUserId: null,
              ownerId: workerAuth.ownerId,
              resourceId: configurationId ?? input.data.requestId,
              resourceType: runConfigurationMutation
                ? "run-configuration"
                : "cli-command",
              result: "succeeded",
            });
          }
          return reply.send(cantripCliCommandResultSchema.parse(result));
        } catch (error) {
          const mutationFailure =
            error instanceof WorktreeCreateMutationError ? error.failure : null;
          const cliError = mutationFailure
            ? new CliCommandRequestError(
                mutationFailure.mutation.outcome === "notStarted"
                  ? "not-found"
                  : "conflict",
                mutationFailure.mutation.outcome === "notStarted" ? 404 : 409,
                mutationFailure.error,
              )
            : error instanceof CliCommandRequestError
              ? error
              : error instanceof WorkerUnavailableError
                ? new CliCommandRequestError(
                    "unavailable",
                    503,
                    errorMessage(error),
                  )
                : error instanceof ExecutionPlacementUnavailableError
                  ? new CliCommandRequestError(
                      error.code === "project-not-found" ||
                        error.code === "target-not-found"
                        ? "not-found"
                        : error.code === "worker-offline" ||
                            error.code === "capability-unavailable"
                          ? "unavailable"
                          : "conflict",
                      error.code === "project-not-found" ||
                        error.code === "target-not-found"
                        ? 404
                        : error.code === "worker-offline" ||
                            error.code === "capability-unavailable"
                          ? 503
                          : 409,
                      errorMessage(error),
                    )
                  : error instanceof ExecutionLaneConflictError
                    ? new CliCommandRequestError(
                        "conflict",
                        409,
                        errorMessage(error),
                      )
                    : error instanceof SurfacePrivateStateConflictError
                      ? new CliCommandRequestError(
                          "conflict",
                          409,
                          "Browser state changed before this operation.",
                        )
                      : new CliCommandRequestError(
                          "invalid",
                          400,
                          errorMessage(error),
                        );
          if (mutation) {
            await appendAudit(request, {
              action:
                input.data.command === "run.start"
                  ? "run.configuration.cli.start-failed"
                  : input.data.command === "run.restart"
                    ? "run.configuration.cli.restart-failed"
                    : input.data.command === "run.stop"
                      ? "run.configuration.cli.stop-failed"
                      : input.data.command.startsWith("run.")
                        ? "run.configuration.cli.mutation-failed"
                        : "cli.command.mutated",
              actorSessionId: null,
              actorUserId: null,
              ownerId: workerAuth.ownerId,
              resourceId: input.data.requestId,
              resourceType: "cli-command",
              result:
                cliError.code === "conflict" ||
                cliError.code === "unsupported-capability" ||
                cliError.code === "context-not-found"
                  ? "denied"
                  : "failed",
            });
          }
          return reply.code(cliError.status).send(
            mutationFailure ?? {
              code: cliError.code,
              error: cliError.message,
            },
          );
        }
      });
    },
  );
}
