import {
  encryptedExplorerCreateSchema,
  encryptedExplorerPinSchema,
  encryptedExplorerUpdateSchema,
  encryptedExplorerViewStateUpdateSchema,
  explorerWireListSchema,
  explorerWireSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import {
  ExecutionPlacementUnavailableError,
  type ServerRepository,
} from "../../db/repository.js";
import { TabLayoutInvariantError } from "../../db/tab-layouts.js";
import { invalidBody } from "../../http/request-helpers.js";

export interface ExplorerListRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<ServerRepository, "listExplorers">;
}

export interface ExplorerPlacementRuntime {
  isWorkerConnected: (workerId: string) => boolean;
}

export interface ExplorerBasicManagementRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<
    ServerRepository,
    "createExplorer" | "pinExplorer" | "updateExplorer"
  >;
  runtime: ExplorerPlacementRuntime;
}

export interface ExplorerViewStateRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<ServerRepository, "updateExplorerViewState">;
}

/** Registers the Explorer inventory route at its early read phase. */
export function installExplorerListRoute(
  app: FastifyInstance,
  { applicationOwnerId, repository }: ExplorerListRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/explorers",
    async (request, reply) =>
      reply.send(
        explorerWireListSchema.parse(
          await repository.listExplorers(
            applicationOwnerId(),
            request.params.projectId,
          ),
        ),
      ),
  );
}

/** Registers Explorer creation and basic persisted metadata routes. */
export function installExplorerBasicManagementRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    repository,
    runtime,
  }: ExplorerBasicManagementRouteDependencies,
): void {
  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/explorers",
    async (request, reply) => {
      const input = encryptedExplorerCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const explorer = await repository.createExplorer(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
          (workerId) => runtime.isWorkerConnected(workerId),
        );
        return explorer
          ? reply.code(201).send(explorerWireSummarySchema.parse(explorer))
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

  app.patch<{ Params: { explorerId: string } }>(
    "/api/explorers/:explorerId",
    async (request, reply) => {
      const input = encryptedExplorerUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const explorer = await repository.updateExplorer(
        applicationOwnerId(),
        request.params.explorerId,
        input.data,
      );
      return explorer
        ? reply.send(explorerWireSummarySchema.parse(explorer))
        : reply.code(404).send({ error: "Explorer not found." });
    },
  );

  app.post<{ Params: { explorerId: string } }>(
    "/api/explorers/:explorerId/pin",
    async (request, reply) => {
      const input = encryptedExplorerPinSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const explorer = await repository.pinExplorer(
          applicationOwnerId(),
          request.params.explorerId,
          input.data,
        );
        return explorer
          ? reply.send(explorerWireSummarySchema.parse(explorer))
          : reply.code(404).send({ error: "Explorer not found." });
      } catch (error) {
        if (error instanceof TabLayoutInvariantError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );
}

/** Registers the lightweight Explorer view-state mutation at its later phase. */
export function installExplorerViewStateRoute(
  app: FastifyInstance,
  { applicationOwnerId, repository }: ExplorerViewStateRouteDependencies,
): void {
  app.patch<{ Params: { explorerId: string } }>(
    "/api/explorers/:explorerId/view-state",
    async (request, reply) => {
      const input = encryptedExplorerViewStateUpdateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const explorer = await repository.updateExplorerViewState(
        applicationOwnerId(),
        request.params.explorerId,
        input.data,
      );
      return explorer
        ? reply.send(explorerWireSummarySchema.parse(explorer))
        : reply.code(404).send({ error: "Explorer not found." });
    },
  );
}
