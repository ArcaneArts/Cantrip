import {
  gitActionResultSchema,
  gitActionSchema,
  gitStatusSchema,
  type WorktreeStatusResult,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import { worktreeStatusFromGitStatus } from "../shared/worktree-status.js";

export interface ProjectGitStatusAndActionRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "isConnected" | "request">;
  recordLiveWorktreeStatus: (
    projectId: string,
    worktreeId: string,
    status: WorktreeStatusResult,
  ) => Promise<void>;
  repository: Pick<
    ServerRepository,
    "getProjectSource" | "getProjectWorktreeContext"
  >;
}

/**
 * Registers legacy plaintext project Git status and action routes at their
 * original position. The root request policy currently tombstones these
 * endpoints; keep their latent handlers intact until that surface is removed.
 */
export function installProjectGitStatusAndActionRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    recordLiveWorktreeStatus,
    repository,
  }: ProjectGitStatusAndActionRouteDependencies,
): void {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/git/status",
    async (request, reply) => {
      const source = await repository.getProjectSource(
        applicationOwnerId(),
        request.params.projectId,
        { isWorkerAvailable: (workerId) => bridge.isConnected(workerId) },
      );
      if (!source) {
        return reply.code(404).send({ error: "Project source not found." });
      }
      try {
        const status = await bridge.request(source.workerId, {
          type: "git.status",
          cwd: source.cwd,
        });
        return reply.send(gitStatusSchema.parse(status));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/git/actions",
    async (request, reply) => {
      const input = gitActionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const source = await repository.getProjectSource(
        applicationOwnerId(),
        request.params.projectId,
        { isWorkerAvailable: (workerId) => bridge.isConnected(workerId) },
      );
      if (!source) {
        return reply.code(404).send({ error: "Project source not found." });
      }
      try {
        const result = gitActionResultSchema.parse(
          await bridge.request(source.workerId, {
            type: "git.action",
            cwd: source.cwd,
            action: input.data,
          }),
        );
        const context = await repository.getProjectWorktreeContext(
          applicationOwnerId(),
          request.params.projectId,
          source.worktreeId,
        );
        if (context) {
          await recordLiveWorktreeStatus(
            request.params.projectId,
            source.worktreeId,
            worktreeStatusFromGitStatus(context.worktree, result.status),
          );
        }
        return reply.send(result);
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
