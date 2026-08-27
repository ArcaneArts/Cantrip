import {
  worktreeStatusResultSchema,
  type WorktreeStatusResult,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../../workers/bridge.js";

export interface ProjectWorktreeStatusRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "request">;
  recordLiveWorktreeStatus: (
    projectId: string,
    worktreeId: string,
    status: WorktreeStatusResult,
  ) => Promise<void>;
  repository: Pick<
    ServerRepository,
    "getProjectWorktreeContext" | "getProjectWorktreeStatusSnapshot"
  >;
}

/**
 * Registers the legacy plaintext worktree status route at its original
 * position. The root request policy currently tombstones this endpoint; keep
 * its latent worker and offline-snapshot behavior intact until it is removed.
 */
export function installProjectWorktreeStatusRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    recordLiveWorktreeStatus,
    repository,
  }: ProjectWorktreeStatusRouteDependencies,
): void {
  app.get<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/status",
    async (request, reply) => {
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      try {
        const result = worktreeStatusResultSchema.parse(
          await bridge.request(context.workerId, {
            type: "worktree.status",
            sourcePath: context.sourcePath,
            worktreePath: context.worktree.path,
          }),
        );
        await recordLiveWorktreeStatus(
          request.params.projectId,
          request.params.worktreeId,
          result,
        );
        return reply.send(result);
      } catch (error) {
        if (error instanceof WorkerUnavailableError) {
          const snapshot = await repository.getProjectWorktreeStatusSnapshot(
            applicationOwnerId(),
            request.params.projectId,
            request.params.worktreeId,
          );
          if (snapshot)
            return reply.send(worktreeStatusResultSchema.parse(snapshot));
        }
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
