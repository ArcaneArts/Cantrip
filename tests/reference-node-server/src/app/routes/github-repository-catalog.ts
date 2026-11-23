import {
  githubAuthStatusSchema,
  githubRepositoryCreateSchema,
  githubRepositoryListSchema,
  githubRepositoryOwnerListSchema,
  githubRepositorySchema,
  githubWorkerRepositoryListSchema,
  githubWorkerRepositorySchema,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { FINITE_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";

export interface GithubRepositoryCatalogRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "request">;
  repository: Pick<ServerRepository, "getWorker" | "listGithubRepositoryIds">;
}

/** Registers the worker-backed GitHub authentication and repository catalog. */
export function installGithubRepositoryCatalogRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
  }: GithubRepositoryCatalogRouteDependencies,
): void {
  app.get<{ Querystring: { workerId?: string } }>(
    "/api/github/status",
    async (request, reply) => {
      const workerId = request.query.workerId;
      if (!workerId) {
        return reply.code(400).send({ error: "workerId is required" });
      }
      if (!(await repository.getWorker(applicationOwnerId(), workerId))) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      try {
        const result = await bridge.request(workerId, {
          type: "github.auth.status",
        });
        return reply.send(githubAuthStatusSchema.parse(result));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{ Querystring: { login?: string; workerId?: string } }>(
    "/api/github/repositories/cache",
    async (request, reply) => {
      const workerId = request.query.workerId;
      const login = request.query.login;
      if (!workerId || !login) {
        return reply
          .code(400)
          .send({ error: "workerId and login are required" });
      }
      if (!(await repository.getWorker(applicationOwnerId(), workerId))) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      try {
        const workerRepositories = githubWorkerRepositoryListSchema.parse(
          await bridge.request(workerId, {
            type: "github.repositories.cached",
            login,
          }),
        );
        const imported =
          await repository.listGithubRepositoryIds(applicationOwnerId());
        return reply.send(
          githubRepositoryListSchema.parse(
            workerRepositories.map((item) => ({
              ...item,
              imported: imported.has(item.id),
            })),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{ Querystring: { workerId?: string } }>(
    "/api/github/repository-owners",
    async (request, reply) => {
      const workerId = request.query.workerId;
      if (!workerId) {
        return reply.code(400).send({ error: "workerId is required" });
      }
      if (!(await repository.getWorker(applicationOwnerId(), workerId))) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      try {
        return reply.send(
          githubRepositoryOwnerListSchema.parse(
            await bridge.request(workerId, {
              type: "github.repository-owners.list",
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{ Querystring: { workerId?: string } }>(
    "/api/github/repositories",
    async (request, reply) => {
      const workerId = request.query.workerId;
      if (!workerId) {
        return reply.code(400).send({ error: "workerId is required" });
      }
      if (!(await repository.getWorker(applicationOwnerId(), workerId))) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      try {
        const workerRepositories = githubWorkerRepositoryListSchema.parse(
          await bridge.request(workerId, {
            type: "github.repositories.list",
          }),
        );
        const imported =
          await repository.listGithubRepositoryIds(applicationOwnerId());
        return reply.send(
          githubRepositoryListSchema.parse(
            workerRepositories.map((item) => ({
              ...item,
              imported: imported.has(item.id),
            })),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Querystring: { workerId?: string } }>(
    "/api/github/repositories",
    async (request, reply) => {
      const workerId = request.query.workerId;
      if (!workerId) {
        return reply.code(400).send({ error: "workerId is required" });
      }
      if (!(await repository.getWorker(applicationOwnerId(), workerId))) {
        return reply.code(404).send({ error: "Worker not found." });
      }
      const input = githubRepositoryCreateSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const created = githubWorkerRepositorySchema.parse(
          await bridge.request(
            workerId,
            { type: "github.repositories.create", request: input.data },
            { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
          ),
        );
        return reply.code(201).send(
          githubRepositorySchema.parse({
            ...created,
            imported: false,
          }),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
