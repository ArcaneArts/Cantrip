import {
  encryptedTabGroupUpdateSchema,
  projectBuiltinSurfaceDefinitionIdSchema,
  projectSurfaceLauncherListSchema,
  projectSurfaceLauncherPinSchema,
  projectSurfaceLauncherSchema,
  projectSurfaceViewCloseResultSchema,
  projectSurfaceViewCloseSchema,
  projectSurfaceViewOpenResultSchema,
  projectSurfaceViewOpenSchema,
  projectTabLayoutWireSummarySchema,
  tabGroupMemberMoveSchema,
  tabGroupMemberOrderSchema,
  tabGroupOrderSchema,
  worktreeSelectionSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import {
  TabLayoutConflictError,
  TabLayoutInvariantError,
} from "../../db/tab-layouts.js";
import { invalidBody } from "../../http/request-helpers.js";

export interface TabLayoutRouteDependencies {
  applicationOwnerId: () => string;
  repository: ServerRepository;
}

export function installTabLayoutRoutes(
  app: FastifyInstance,
  { applicationOwnerId, repository }: TabLayoutRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tab-groups",
    async (request, reply) => {
      try {
        const layout = await repository.tabLayouts.get(
          applicationOwnerId(),
          request.params.projectId,
        );
        return layout
          ? reply.send(projectTabLayoutWireSummarySchema.parse(layout))
          : reply.code(404).send({ error: "Project not found." });
      } catch (error) {
        if (error instanceof TabLayoutInvariantError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/surface-launchers",
    async (request, reply) => {
      const launchers = await repository.tabLayouts.listSurfaceLaunchers(
        applicationOwnerId(),
        request.params.projectId,
      );
      return launchers
        ? reply.send(projectSurfaceLauncherListSchema.parse(launchers))
        : reply.code(404).send({ error: "Project not found." });
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/surface-launchers",
    async (request, reply) => {
      const input = projectSurfaceLauncherPinSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const launcher = await repository.tabLayouts.setSurfaceLauncherPin(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
        );
        return launcher
          ? reply.send(projectSurfaceLauncherSchema.parse(launcher))
          : reply.code(404).send({ error: "Project not found." });
      } catch (error) {
        if (error instanceof TabLayoutInvariantError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.patch<{
    Params: { definitionId: string; projectId: string };
  }>(
    "/api/projects/:projectId/builtin-surfaces/:definitionId/worktree",
    async (request, reply) => {
      const definitionId = projectBuiltinSurfaceDefinitionIdSchema.safeParse(
        request.params.definitionId,
      );
      const input = worktreeSelectionSchema.safeParse(request.body);
      if (!definitionId.success || !input.success) {
        return reply
          .code(400)
          .send(
            invalidBody([
              ...(definitionId.success ? [] : definitionId.error.issues),
              ...(input.success ? [] : input.error.issues),
            ]),
          );
      }
      try {
        const layout = await repository.tabLayouts.updateBuiltInSurfaceWorktree(
          applicationOwnerId(),
          request.params.projectId,
          definitionId.data,
          input.data.worktreeId,
        );
        return layout
          ? reply.send(projectTabLayoutWireSummarySchema.parse(layout))
          : reply.code(404).send({ error: "Project or worktree not found." });
      } catch (error) {
        if (error instanceof TabLayoutInvariantError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tab-groups/order",
    async (request, reply) => {
      const input = tabGroupOrderSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const layout = await repository.tabLayouts.reorderGroups(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
        );
        return layout
          ? reply.send(projectTabLayoutWireSummarySchema.parse(layout))
          : reply.code(404).send({ error: "Project not found." });
      } catch (error) {
        if (
          error instanceof TabLayoutConflictError ||
          error instanceof TabLayoutInvariantError
        ) {
          return reply
            .code(error instanceof TabLayoutConflictError ? 409 : 400)
            .send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { groupId: string; projectId: string } }>(
    "/api/projects/:projectId/tab-groups/:groupId",
    async (request, reply) => {
      const input = encryptedTabGroupUpdateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const layout = await repository.tabLayouts.updateGroup(
          applicationOwnerId(),
          request.params.projectId,
          request.params.groupId,
          input.data,
        );
        return layout
          ? reply.send(projectTabLayoutWireSummarySchema.parse(layout))
          : reply.code(404).send({ error: "Project not found." });
      } catch (error) {
        if (
          error instanceof TabLayoutConflictError ||
          error instanceof TabLayoutInvariantError
        ) {
          return reply
            .code(error instanceof TabLayoutConflictError ? 409 : 400)
            .send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { groupId: string; projectId: string } }>(
    "/api/projects/:projectId/tab-groups/:groupId/members/order",
    async (request, reply) => {
      const input = tabGroupMemberOrderSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const layout = await repository.tabLayouts.reorderMembers(
          applicationOwnerId(),
          request.params.projectId,
          request.params.groupId,
          input.data,
        );
        return layout
          ? reply.send(projectTabLayoutWireSummarySchema.parse(layout))
          : reply.code(404).send({ error: "Project not found." });
      } catch (error) {
        if (
          error instanceof TabLayoutConflictError ||
          error instanceof TabLayoutInvariantError
        ) {
          return reply
            .code(error instanceof TabLayoutConflictError ? 409 : 400)
            .send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tab-groups/member",
    async (request, reply) => {
      const input = tabGroupMemberMoveSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const layout = await repository.tabLayouts.moveMember(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
        );
        return layout
          ? reply.send(projectTabLayoutWireSummarySchema.parse(layout))
          : reply.code(404).send({ error: "Project not found." });
      } catch (error) {
        if (
          error instanceof TabLayoutConflictError ||
          error instanceof TabLayoutInvariantError
        ) {
          return reply
            .code(error instanceof TabLayoutConflictError ? 409 : 400)
            .send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tab-groups/member/open",
    async (request, reply) => {
      const input = projectSurfaceViewOpenSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const result = await repository.tabLayouts.openSurfaceView(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
        );
        return result
          ? reply.send(projectSurfaceViewOpenResultSchema.parse(result))
          : reply.code(404).send({ error: "Project not found." });
      } catch (error) {
        if (
          error instanceof TabLayoutConflictError ||
          error instanceof TabLayoutInvariantError
        ) {
          return reply
            .code(error instanceof TabLayoutConflictError ? 409 : 400)
            .send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tab-groups/member/close",
    async (request, reply) => {
      const input = projectSurfaceViewCloseSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const result = await repository.tabLayouts.closeSurfaceView(
          applicationOwnerId(),
          request.params.projectId,
          input.data,
        );
        return result
          ? reply.send(projectSurfaceViewCloseResultSchema.parse(result))
          : reply.code(404).send({ error: "Project not found." });
      } catch (error) {
        if (
          error instanceof TabLayoutConflictError ||
          error instanceof TabLayoutInvariantError
        ) {
          return reply
            .code(error instanceof TabLayoutConflictError ? 409 : 400)
            .send({ error: error.message });
        }
        throw error;
      }
    },
  );
}
