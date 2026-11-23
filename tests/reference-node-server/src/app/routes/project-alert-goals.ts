import {
  projectGoalObservationSchema,
  projectGoalObservationResultSchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { ServerConfig } from "../../config.js";
import type { ServerRepository } from "../../db/repository.js";
import { authenticateWorkerRequest } from "../../workers/credentials.js";
import { invalidBody } from "../../http/request-helpers.js";

export function installProjectGoalObservationRoutes(
  app: FastifyInstance,
  deps: {
    config: ServerConfig;
    repository: ServerRepository;
    bridge: WorkerCommandBus;
  },
) {
  app.post(
    "/api/internal/project-alerts/goals",
    { logLevel: "warn" },
    async (request, reply) => {
      const parsed = projectGoalObservationSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send(invalidBody(parsed.error.issues));
      const input = parsed.data;
      const auth = await authenticateWorkerRequest(
        deps.repository,
        deps.config,
        request,
        input.workerId,
        "worker:agent-tools",
      );
      if (!auth) return reply.code(401).send({ error: "Unauthorized" });
      const identity = deps.bridge.connectionIdentity?.(input.workerId);
      if (identity) {
        if (
          identity.ownerId !== auth.ownerId ||
          identity.workerProcessGeneration !== input.generation
        )
          return reply.send({ accepted: false, reason: "retired-worker" });
        await deps.repository.alerts.registerGoalWorker(
          auth.ownerId,
          input.workerId,
          identity.workerProcessGeneration,
        );
      }
      if (
        input.snapshot.goal &&
        input.snapshot.goal.threadId !== input.threadId
      )
        return reply
          .code(400)
          .send({ error: "Goal observation belongs to a different thread." });
      return reply.send(
        projectGoalObservationResultSchema.parse(
          await deps.repository.alerts.observeGoal(auth.ownerId, input),
        ),
      );
    },
  );
}
