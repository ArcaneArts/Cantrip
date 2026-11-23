import {
  gitBranchActionApplySchema,
  gitBranchActionPreviewSchema,
  gitBranchActionSchema,
  gitBranchListSchema,
  gitBranchMutationResultSchema,
  gitLfsActionApplySchema,
  gitLfsActionPreviewSchema,
  gitLfsActionSchema,
  gitLfsMutationResultSchema,
  gitLfsStatusSchema,
  gitRemoteActionApplySchema,
  gitRemoteActionPreviewSchema,
  gitRemoteActionSchema,
  gitRemoteListSchema,
  gitRemoteMutationResultSchema,
  gitSubmoduleActionApplySchema,
  gitSubmoduleActionPreviewSchema,
  gitSubmoduleActionSchema,
  gitSubmoduleListSchema,
  gitSubmoduleMutationResultSchema,
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

export interface ProjectWorktreeGitResourceRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "request">;
  publishLiveInvalidation: (
    resource: "worktree" | "worktree-status",
    input: { projectId: string },
  ) => void;
  recordLiveWorktreeStatus: (
    projectId: string,
    worktreeId: string,
    status: WorktreeStatusResult,
  ) => Promise<void>;
  repository: Pick<ServerRepository, "getProjectWorktreeContext">;
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "serialize">;
}

/**
 * Registers legacy plaintext Git branch, remote, submodule, and LFS routes at
 * their original position. The root request policy currently tombstones these
 * endpoints; keep their latent handlers intact until that surface is removed.
 */
export function installProjectWorktreeGitResourceRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishLiveInvalidation,
    recordLiveWorktreeStatus,
    repository,
    worktreeCoordinator,
  }: ProjectWorktreeGitResourceRouteDependencies,
): void {
  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/branches/actions/apply",
    async (request, reply) => {
      const input = gitBranchActionApplySchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const result = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const context = await repository.getProjectWorktreeContext(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!context) throw new Error("Worktree not found.");
            const applied = gitBranchMutationResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "git.branch.action.apply",
                cwd: context.worktree.path,
                action: input.data.action,
                token: input.data.token,
              }),
            );
            await recordLiveWorktreeStatus(
              request.params.projectId,
              request.params.worktreeId,
              worktreeStatusFromGitStatus(context.worktree, applied.status),
            );
            publishLiveInvalidation("worktree", {
              projectId: request.params.projectId,
            });
            publishLiveInvalidation("worktree-status", {
              projectId: request.params.projectId,
            });
            return applied;
          },
        );
        return reply.send(result);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/branches/actions/preview",
    async (request, reply) => {
      const input = gitBranchActionSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context)
        return reply.code(404).send({ error: "Worktree not found." });
      try {
        return reply.send(
          gitBranchActionPreviewSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.branch.action.preview",
              cwd: context.worktree.path,
              action: input.data,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/branches",
    async (request, reply) => {
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context)
        return reply.code(404).send({ error: "Worktree not found." });
      try {
        return reply.send(
          gitBranchListSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.branch.list",
              cwd: context.worktree.path,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/remotes/actions/apply",
    async (request, reply) => {
      const input = gitRemoteActionApplySchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      try {
        const result = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const context = await repository.getProjectWorktreeContext(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!context) throw new Error("Worktree not found.");
            const applied = gitRemoteMutationResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "git.remote.action.apply",
                cwd: context.worktree.path,
                action: input.data.action,
                token: input.data.token,
              }),
            );
            await recordLiveWorktreeStatus(
              request.params.projectId,
              request.params.worktreeId,
              worktreeStatusFromGitStatus(context.worktree, applied.status),
            );
            publishLiveInvalidation("worktree-status", {
              projectId: request.params.projectId,
            });
            return applied;
          },
        );
        return reply.send(result);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/remotes/actions/preview",
    async (request, reply) => {
      const input = gitRemoteActionSchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context)
        return reply.code(404).send({ error: "Worktree not found." });
      try {
        return reply.send(
          gitRemoteActionPreviewSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.remote.action.preview",
              cwd: context.worktree.path,
              action: input.data,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/remotes",
    async (request, reply) => {
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context)
        return reply.code(404).send({ error: "Worktree not found." });
      try {
        return reply.send(
          gitRemoteListSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.remote.list",
              cwd: context.worktree.path,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/submodules/actions/apply",
    async (request, reply) => {
      const input = gitSubmoduleActionApplySchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      try {
        const result = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const context = await repository.getProjectWorktreeContext(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!context) throw new Error("Worktree not found.");
            const applied = gitSubmoduleMutationResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "git.submodule.action.apply",
                cwd: context.worktree.path,
                action: input.data.action,
                token: input.data.token,
              }),
            );
            await recordLiveWorktreeStatus(
              request.params.projectId,
              request.params.worktreeId,
              worktreeStatusFromGitStatus(context.worktree, applied.status),
            );
            publishLiveInvalidation("worktree-status", {
              projectId: request.params.projectId,
            });
            return applied;
          },
        );
        return reply.send(result);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/submodules/actions/preview",
    async (request, reply) => {
      const input = gitSubmoduleActionSchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context)
        return reply.code(404).send({ error: "Worktree not found." });
      try {
        return reply.send(
          gitSubmoduleActionPreviewSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.submodule.action.preview",
              cwd: context.worktree.path,
              action: input.data,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/submodules",
    async (request, reply) => {
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context)
        return reply.code(404).send({ error: "Worktree not found." });
      try {
        return reply.send(
          gitSubmoduleListSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.submodule.list",
              cwd: context.worktree.path,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/lfs/actions/apply",
    async (request, reply) => {
      const input = gitLfsActionApplySchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      try {
        const result = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const context = await repository.getProjectWorktreeContext(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!context) throw new Error("Worktree not found.");
            const applied = gitLfsMutationResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "git.lfs.action.apply",
                cwd: context.worktree.path,
                action: input.data.action,
                token: input.data.token,
              }),
            );
            await recordLiveWorktreeStatus(
              request.params.projectId,
              request.params.worktreeId,
              worktreeStatusFromGitStatus(context.worktree, applied.status),
            );
            publishLiveInvalidation("worktree-status", {
              projectId: request.params.projectId,
            });
            return applied;
          },
        );
        return reply.send(result);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/lfs/actions/preview",
    async (request, reply) => {
      const input = gitLfsActionSchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context)
        return reply.code(404).send({ error: "Worktree not found." });
      try {
        return reply.send(
          gitLfsActionPreviewSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.lfs.action.preview",
              cwd: context.worktree.path,
              action: input.data,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/lfs",
    async (request, reply) => {
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context)
        return reply.code(404).send({ error: "Worktree not found." });
      try {
        return reply.send(
          gitLfsStatusSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.lfs.status",
              cwd: context.worktree.path,
              refreshLocks: false,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );
}
