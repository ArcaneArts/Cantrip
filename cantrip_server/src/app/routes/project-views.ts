import {
  encryptedProjectViewCreateSchema,
  encryptedProjectViewUpdateSchema,
  projectViewWireListSchema,
  projectViewWireSummarySchema,
  worktreeSelectionSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import type { WorkerLinkService } from "../../worker-links/service.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ProjectViewRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  repository: Pick<
    ServerRepository,
    | "deleteProjectView"
    | "getProjectViewProjectId"
    | "getRemoteSurfaceExecutionContext"
    | "listProjectViews"
    | "updateProjectView"
    | "updateProjectViewWorktree"
  >;
  requireProjectWorktrees: (projectId: string) => Promise<unknown>;
  workerLinks: Pick<WorkerLinkService, "revokeResource">;
}

/** Registers project view creation, retargeting, and lifecycle routes. */
export function installProjectViewRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
    requireProjectWorktrees,
    workerLinks,
  }: ProjectViewRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/views",
    async (request, reply) =>
      reply.send(
        projectViewWireListSchema.parse(
          await repository.listProjectViews(
            applicationOwnerId(),
            request.params.projectId,
          ),
        ),
      ),
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/views",
    async (request, reply) => {
      const input = encryptedProjectViewCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      return reply.code(400).send({
        error:
          "Remote Desktop views must be created with endpoint configuration.",
      });
    },
  );

  app.patch<{ Params: { viewId: string } }>(
    "/api/project-views/:viewId",
    async (request, reply) => {
      const input = encryptedProjectViewUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const view = await repository.updateProjectView(
        applicationOwnerId(),
        request.params.viewId,
        input.data,
      );
      return view
        ? reply.send(projectViewWireSummarySchema.parse(view))
        : reply.code(404).send({ error: "Project view not found." });
    },
  );

  app.patch<{ Params: { viewId: string } }>(
    "/api/project-views/:viewId/worktree",
    async (request, reply) => {
      const input = worktreeSelectionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const projectId = await repository.getProjectViewProjectId(
        applicationOwnerId(),
        request.params.viewId,
      );
      if (projectId) await requireProjectWorktrees(projectId);
      try {
        const view = await repository.updateProjectViewWorktree(
          applicationOwnerId(),
          request.params.viewId,
          input.data,
        );
        return view
          ? reply.send(projectViewWireSummarySchema.parse(view))
          : reply
              .code(404)
              .send({ error: "History view or worktree not found." });
      } catch (error) {
        return reply.code(409).send({ error: errorMessage(error) });
      }
    },
  );

  app.delete<{ Params: { viewId: string } }>(
    "/api/project-views/:viewId",
    async (request, reply) => {
      const context = await repository.getRemoteSurfaceExecutionContext(
        applicationOwnerId(),
        request.params.viewId,
      );
      if (
        !(await repository.deleteProjectView(
          applicationOwnerId(),
          request.params.viewId,
        ))
      ) {
        return reply.code(404).send({ error: "Project view not found." });
      }
      if (context) {
        await workerLinks.revokeResource(
          applicationOwnerId(),
          context.surface.kind === "browser" ? "browser" : "remote-desktop",
          context.surface.id,
          "resource-deleted",
        );
      }
      if (context && bridge.isConnected(context.workerId)) {
        void bridge
          .request(context.workerId, {
            type: "surface.close",
            surfaceId: context.surface.id,
          })
          .catch(() => undefined);
      }
      return reply.code(204).send();
    },
  );
}
