import { gitCommitDetailSchema } from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { sendWorkerRequestFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";

export interface ProjectWorktreeGitCommitSignatureRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "request">;
  repository: Pick<ServerRepository, "getProjectWorktreeContext">;
}

/** Registers the late-phase worker-backed Git commit signature endpoint. */
export function installProjectWorktreeGitCommitSignatureRoute(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
  }: ProjectWorktreeGitCommitSignatureRouteDependencies,
): void {
  app.get<{
    Params: { projectId: string; worktreeId: string; revision: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/commits/:revision/signature",
    async (request, reply) => {
      if (!/^[0-9a-f]{40,64}$/u.test(request.params.revision)) {
        return reply
          .code(400)
          .send({ error: "A full commit hash is required." });
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
        const signature = await bridge.request(context.workerId, {
          type: "git.commit.signature.get",
          cwd: context.worktree.path,
          revision: request.params.revision,
        });
        return reply.send(
          gitCommitDetailSchema.shape.signature.unwrap().parse(signature),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
