import {
  codeSessionListSchema,
  codeTabWireListSchema,
  codeTabWireSummarySchema,
  encryptedCodeTabCreateSchema,
  encryptedCodeTabUpdateSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  CodeCapabilityUnavailableError,
  ExecutionPlacementUnavailableError,
  type ServerRepository,
} from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";

export interface CodeTabPlacementRuntime {
  isWorkerConnected: (workerId: string) => boolean;
}

export interface CodeTabManagementRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<
    ServerRepository,
    "createCodeTab" | "listCodeTabs" | "updateCodeTab"
  >;
  runtime: CodeTabPlacementRuntime;
}

export interface CodeTabSessionListRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<ServerRepository, "listCodeSessions">;
}

/** Registers Code-tab inventory and metadata routes before retargeting. */
export function installCodeTabManagementRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    repository,
    runtime,
  }: CodeTabManagementRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/code-tabs",
    async (request, reply) =>
      reply.send(
        codeTabWireListSchema.parse(
          await repository.listCodeTabs(
            applicationOwnerId(),
            request.params.projectId,
          ),
        ),
      ),
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/code-tabs",
    async (request, reply) => {
      const input = encryptedCodeTabCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const codeTab = await repository.createCodeTab(
          applicationOwnerId(),
          request.params.projectId,
          { ...input.data, themeMode: "follow-cantrip" },
          (workerId) => runtime.isWorkerConnected(workerId),
        );
        return codeTab
          ? reply.code(201).send(codeTabWireSummarySchema.parse(codeTab))
          : reply
              .code(404)
              .send({ error: "Project source or worktree not found." });
      } catch (error) {
        if (error instanceof ExecutionPlacementUnavailableError) {
          return reply
            .code(error.code === "project-not-found" ? 404 : 409)
            .send({ code: error.code, error: error.message });
        }
        if (error instanceof CodeCapabilityUnavailableError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId",
    async (request, reply) => {
      const input = encryptedCodeTabUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const codeTab = await repository.updateCodeTab(
        applicationOwnerId(),
        request.params.codeTabId,
        { ...input.data, themeMode: "follow-cantrip" },
      );
      return codeTab
        ? reply.send(codeTabWireSummarySchema.parse(codeTab))
        : reply.code(404).send({ error: "Code tab not found." });
    },
  );
}

/** Registers the persisted session inventory before worker-backed controls. */
export function installCodeTabSessionListRoute(
  app: FastifyInstance,
  { applicationOwnerId, repository }: CodeTabSessionListRouteDependencies,
): void {
  app.get<{ Params: { codeTabId: string } }>(
    "/api/code-tabs/:codeTabId/sessions",
    async (request, reply) => {
      const sessions = await repository.listCodeSessions(
        applicationOwnerId(),
        request.params.codeTabId,
      );
      return sessions
        ? reply.send(codeSessionListSchema.parse(sessions))
        : reply.code(404).send({ error: "Code tab not found." });
    },
  );
}
