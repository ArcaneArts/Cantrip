import {
  encryptedProjectWorkspaceCreateSchema,
  encryptedProjectWorkspaceUpdateSchema,
  projectWorkspaceWireListSchema,
  projectWorkspaceWireSummarySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";

export interface ProjectWorkspaceRouteDependencies {
  applicationOwnerId: () => string;
  repository: Pick<
    ServerRepository,
    | "createEncryptedProjectWorkspace"
    | "deleteProjectWorkspace"
    | "listProjectWorkspaceWire"
    | "updateEncryptedProjectWorkspace"
  >;
}

export function installProjectWorkspaceRoutes(
  app: FastifyInstance,
  { applicationOwnerId, repository }: ProjectWorkspaceRouteDependencies,
): void {
  app.get("/api/workspaces", async (_request, reply) => {
    return reply.send(
      projectWorkspaceWireListSchema.parse(
        await repository.listProjectWorkspaceWire(applicationOwnerId()),
      ),
    );
  });

  app.post("/api/workspaces", async (request, reply) => {
    const input = encryptedProjectWorkspaceCreateSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send(invalidBody(input.error.issues));
    }
    try {
      return reply
        .code(201)
        .send(
          projectWorkspaceWireSummarySchema.parse(
            await repository.createEncryptedProjectWorkspace(
              applicationOwnerId(),
              input.data,
            ),
          ),
        );
    } catch (error) {
      return reply.code(409).send({ error: errorMessage(error) });
    }
  });

  app.patch<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId",
    async (request, reply) => {
      const input = encryptedProjectWorkspaceUpdateSchema.safeParse(
        request.body,
      );
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const workspace = await repository.updateEncryptedProjectWorkspace(
          applicationOwnerId(),
          request.params.workspaceId,
          input.data,
        );
        return workspace
          ? reply.send(projectWorkspaceWireSummarySchema.parse(workspace))
          : reply.code(404).send({ error: "Workspace not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId",
    async (request, reply) => {
      try {
        return (await repository.deleteProjectWorkspace(
          applicationOwnerId(),
          request.params.workspaceId,
        ))
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Workspace not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );
}
