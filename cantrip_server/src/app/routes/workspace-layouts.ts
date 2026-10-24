import {
  WorkspaceCommandError,
  workspaceCommandSchema,
} from "@cantrip/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { TabLayoutRouteDependencies } from "./tab-layouts.js";
import { invalidBody } from "../../http/request-helpers.js";

type Params = { projectId: string; workspaceId: string };
const base = "/api/projects/:projectId/workspace-layouts/:workspaceId";

function failure(error: unknown, reply: FastifyReply) {
  if (error instanceof WorkspaceCommandError) {
    return reply
      .code(error.code === "invalid" ? 400 : 409)
      .send({ error: error.message, code: error.code });
  }
  throw error;
}

export function installWorkspaceLayoutRoutes(
  app: FastifyInstance,
  { applicationOwnerId, repository }: TabLayoutRouteDependencies,
) {
  app.get<{ Params: Params }>(base, async (request, reply) => {
    const layout = await repository.workspaceLayouts.get(
      applicationOwnerId(),
      request.params.projectId,
      request.params.workspaceId,
    );
    return layout
      ? reply.send(layout)
      : reply.code(404).send({ error: "Workspace not found." });
  });
  app.post<{ Params: Params; Body: { mainWindowId?: unknown } }>(
    `${base}/seed`,
    async (request, reply) => {
      const body = request.body;
      if (
        !body ||
        typeof body.mainWindowId !== "string" ||
        !body.mainWindowId.length ||
        Object.keys(body).some((key) => key !== "mainWindowId")
      ) {
        return reply
          .code(400)
          .send({ error: "A main window identity is required." });
      }
      try {
        const layout = await repository.workspaceLayouts.seed(
          applicationOwnerId(),
          request.params.projectId,
          request.params.workspaceId,
          body.mainWindowId,
        );
        return layout
          ? reply.send(layout)
          : reply.code(404).send({ error: "Project not found." });
      } catch (error) {
        return failure(error, reply);
      }
    },
  );
  app.post<{ Params: Params }>(`${base}/commands`, async (request, reply) => {
    const input = workspaceCommandSchema.safeParse(request.body);
    if (!input.success)
      return reply.code(400).send(invalidBody(input.error.issues));
    if (
      input.data.projectId !== request.params.projectId ||
      input.data.workspaceId !== request.params.workspaceId
    ) {
      return reply
        .code(400)
        .send({ error: "Command and route scope do not match." });
    }
    try {
      const result = await repository.workspaceLayouts.execute(
        applicationOwnerId(),
        input.data,
      );
      return result
        ? reply.send(result)
        : reply.code(404).send({ error: "Workspace not found." });
    } catch (error) {
      return failure(error, reply);
    }
  });
}
