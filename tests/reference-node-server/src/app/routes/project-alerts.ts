import type { FastifyInstance } from "fastify";
import {
  projectAlertQuerySchema,
  projectGoalSnapshotSchema,
  projectAlertPageSchema,
  projectAlertCountsSchema,
} from "@cantrip/protocol";
import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";

export function installProjectAlertRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    repository,
  }: {
    applicationOwnerId(): string;
    repository: Pick<ServerRepository, "alerts">;
  },
) {
  app.get<{ Params: { projectId: string; alertId: string } }>(
    "/api/projects/:projectId/alerts/:alertId/goal",
    async (request, reply) => {
      const value = await repository.alerts.goalSource(
        applicationOwnerId(),
        request.params.projectId,
        request.params.alertId,
      );
      return value
        ? reply.send(projectGoalSnapshotSchema.parse(value))
        : reply
            .code(404)
            .send({ error: "Alert source is no longer available." });
    },
  );
  app.get("/api/project-alerts/counts", async (_request, reply) =>
    reply.send(
      projectAlertCountsSchema.parse(
        await repository.alerts.counts(applicationOwnerId()),
      ),
    ),
  );
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/alerts",
    async (request, reply) => {
      const input = projectAlertQuerySchema.safeParse(request.query);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      const page = await repository.alerts.list(
        applicationOwnerId(),
        request.params.projectId,
        input.data,
      );
      if (!page)
        return reply
          .code(404)
          .send({ error: "Alert Inbox or page not found." });
      return reply.send(projectAlertPageSchema.parse(page));
    },
  );
}
