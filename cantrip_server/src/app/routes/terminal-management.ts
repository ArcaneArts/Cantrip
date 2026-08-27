import {
  encryptedTerminalCreateSchema,
  encryptedTerminalServiceConfigurationSchema,
  encryptedTerminalUpdateSchema,
  terminalWireListSchema,
  terminalWireSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  ExecutionPlacementUnavailableError,
  type ServerRepository,
} from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";

export interface TerminalServiceRuntime {
  isWorkerConnected: (workerId: string) => boolean;
  reconcileServicesForWorker: (workerId: string) => Promise<void>;
  recordStatus: (
    terminalId: string,
    status: "idle" | "offline" | "running",
  ) => Promise<unknown>;
  restartService: (workerId: string, terminalId: string) => Promise<void>;
}

export interface TerminalListRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<ServerRepository, "listTerminals">;
}

export interface TerminalCreateRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<ServerRepository, "createTerminal">;
  runtime: Pick<TerminalServiceRuntime, "isWorkerConnected">;
}

export interface TerminalManagementRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<
    ServerRepository,
    "getTerminalExecutionContext" | "updateTerminal" | "updateTerminalService"
  >;
  runtime: TerminalServiceRuntime;
}

/** Registers the project terminal list at its original early route phase. */
export function installTerminalListRoute(
  app: FastifyInstance,
  { applicationOwnerId, repository }: TerminalListRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/terminals",
    async (request, reply) => {
      const terminals = await repository.listTerminals(
        applicationOwnerId(),
        request.params.projectId,
      );
      return reply.send(terminalWireListSchema.parse(terminals));
    },
  );
}

/** Registers terminal creation after Run configuration definition routes. */
export function installTerminalCreateRoute(
  app: FastifyInstance,
  { applicationOwnerId, repository, runtime }: TerminalCreateRouteDependencies,
): void {
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/terminals",
    async (request, reply) => {
      const input = encryptedTerminalCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const terminal = await repository.createTerminal(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
          (workerId) => runtime.isWorkerConnected(workerId),
        );
        return terminal
          ? reply.code(201).send(terminalWireSummarySchema.parse(terminal))
          : reply.code(404).send({ error: "Project source not found." });
      } catch (error) {
        if (error instanceof ExecutionPlacementUnavailableError) {
          return reply
            .code(error.code === "project-not-found" ? 404 : 409)
            .send({ code: error.code, error: error.message });
        }
        throw error;
      }
    },
  );
}

/** Registers terminal metadata and managed-service controls. */
export function installTerminalManagementRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    repository,
    runtime,
  }: TerminalManagementRouteDependencies,
): void {
  app.patch<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId",
    async (request, reply) => {
      const input = encryptedTerminalUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const terminal = await repository.updateTerminal(
          applicationOwnerId(),
          request.params.terminalId,
          input.data,
        );
        return terminal
          ? reply.send(terminalWireSummarySchema.parse(terminal))
          : reply.code(404).send({ error: "Terminal not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.put<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId/service",
    async (request, reply) => {
      const input = encryptedTerminalServiceConfigurationSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const context = await repository.getTerminalExecutionContext(
          applicationOwnerId(),
          request.params.terminalId,
        );
        if (!context) {
          return reply.code(404).send({ error: "Terminal not found." });
        }
        if (context.kind === "run-configuration" || !context.stateProtection) {
          return reply.code(409).send({
            error:
              "Run configuration terminals are read-only and use the managed runtime output API.",
          });
        }
        const terminal = await repository.updateTerminalService(
          applicationOwnerId(),
          request.params.terminalId,
          input.data,
        );
        if (!terminal) {
          return reply.code(404).send({ error: "Terminal not found." });
        }
        let status: "idle" | "offline" | "running" = input.data.enabled
          ? "offline"
          : "idle";
        if (runtime.isWorkerConnected(context.workerId)) {
          try {
            await runtime.reconcileServicesForWorker(context.workerId);
            status = input.data.enabled ? "running" : "idle";
          } catch {
            app.log.warn(
              { terminalId: terminal.id },
              "Terminal service will reconcile when the worker reconnects",
            );
          }
        }
        await runtime.recordStatus(terminal.id, status);
        return reply.send(
          terminalWireSummarySchema.parse({
            ...terminal,
            status,
          }),
        );
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.post<{ Params: { terminalId: string } }>(
    "/api/terminals/:terminalId/service/restart",
    async (request, reply) => {
      const context = await repository.getTerminalExecutionContext(
        applicationOwnerId(),
        request.params.terminalId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Terminal not found." });
      }
      if (context.kind === "run-configuration") {
        return reply.code(409).send({
          error: "Run configuration terminals are controlled by their runtime.",
        });
      }
      if (!context.serviceEnabled) {
        return reply.code(409).send({ error: "Terminal service is disabled." });
      }
      if (!runtime.isWorkerConnected(context.workerId)) {
        await runtime.recordStatus(context.terminalId, "offline");
        return reply.code(503).send({ error: "Project worker is offline." });
      }
      try {
        await runtime.restartService(context.workerId, context.terminalId);
        await runtime.recordStatus(context.terminalId, "running");
        return reply.code(202).send({ accepted: true });
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
