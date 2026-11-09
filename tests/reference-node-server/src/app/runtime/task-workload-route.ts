import { projectTaskWorkloadOpaqueSchema } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { TaskRouteRuntimeDependencies } from "./task-route-types.js";

/** Reads encrypted workload summaries without taking dispatch ownership. */
export function installTaskWorkloadRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    repository,
  }: Pick<TaskRouteRuntimeDependencies, "applicationOwnerId" | "repository">,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/tasks/workload",
    async (request, reply) => {
      const ownerId = applicationOwnerId();
      const tasks = await repository.tasks.list(
        ownerId,
        request.params.projectId,
      );
      const project = await repository.getProject(
        ownerId,
        request.params.projectId,
      );
      if (!project)
        return reply.code(404).send({ error: "Project not found." });
      const items = await Promise.all(
        tasks.map(async (task) => {
          const [plan, messagePage] = await Promise.all([
            repository.getChatPlanWireState(ownerId, task.chatId),
            repository.listTaskMessagePage(ownerId, task.chatId, {
              limit: 100,
            }),
          ]);
          if (!plan) throw new Error("Task Chat plan state was not found.");
          return { task, plan, messages: messagePage.messages };
        }),
      );
      return reply.send(
        projectTaskWorkloadOpaqueSchema.parse({
          projectId: request.params.projectId,
          items,
        }),
      );
    },
  );
}
