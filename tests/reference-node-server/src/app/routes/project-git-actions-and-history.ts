import {
  gitActionResultSchema,
  gitActionSchema,
  gitHistorySchema,
  gitHistoryOptionsSchema,
  type WorktreeStatusResult,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import {
  sendWorkerConflictFailure,
  sendWorkerRequestFailure,
} from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { ProjectWorktreeCoordinator } from "../../worktrees/coordinator.js";
import { worktreeStatusFromGitStatus } from "../shared/worktree-status.js";

export interface ProjectGitActionAndHistoryRouteDependencies {
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
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "serialize">;
}

/**
 * Registers legacy plaintext Git action and project-history routes at their
 * original position. The root request policy currently tombstones these
 * endpoints; keep their latent handlers intact until that surface is removed.
 */
export function installProjectGitActionAndHistoryRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    recordLiveWorktreeStatus,
    repository,
    worktreeCoordinator,
  }: ProjectGitActionAndHistoryRouteDependencies,
): void {
  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/actions",
    async (request, reply) => {
      const input = gitActionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      try {
        const result = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const freshContext = await repository.getProjectWorktreeContext(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!freshContext) throw new Error("Worktree not found.");
            const applied = gitActionResultSchema.parse(
              await bridge.request(freshContext.workerId, {
                type: "git.action",
                cwd: freshContext.worktree.path,
                action: input.data,
              }),
            );
            await recordLiveWorktreeStatus(
              request.params.projectId,
              request.params.worktreeId,
              worktreeStatusFromGitStatus(
                freshContext.worktree,
                applied.status,
              ),
            );
            return applied;
          },
        );
        return reply.send(result);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { projectId: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/api/projects/:projectId/git/history", async (request, reply) => {
    const source = await repository.getProjectSource(
      applicationOwnerId(),
      request.params.projectId,
      { isWorkerAvailable: (workerId) => bridge.isConnected(workerId) },
    );
    if (!source) {
      return reply.code(404).send({ error: "Project source not found." });
    }
    const parsedLimit = Number.parseInt(request.query.limit ?? "100", 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(100, Math.max(1, parsedLimit))
      : 100;
    const parsedCursor = Number.parseInt(request.query.cursor ?? "0", 10);
    const cursor = Number.isFinite(parsedCursor)
      ? Math.max(0, parsedCursor)
      : 0;
    try {
      const history = await bridge.request(source.workerId, {
        type: "git.history",
        cwd: source.cwd,
        cursor,
        limit,
        revisions: [],
        options: gitHistoryOptionsSchema.parse({}),
      });
      return reply.send(gitHistorySchema.parse(history));
    } catch (error) {
      return sendWorkerRequestFailure(reply, error);
    }
  });
}
