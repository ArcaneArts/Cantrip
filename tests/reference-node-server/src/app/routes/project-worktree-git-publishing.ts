import {
  gitActionResultSchema,
  gitForcePushApplySchema,
  gitForcePushPreviewSchema,
  githubReleaseCreateSchema,
  githubReleaseListSchema,
  githubReleaseSummarySchema,
  gitTagActionApplySchema,
  gitTagActionPreviewSchema,
  gitTagActionSchema,
  gitTagDetailSchema,
  gitTagListSchema,
  gitTagMutationResultSchema,
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
import { FINITE_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";
import { worktreeStatusFromGitStatus } from "../shared/worktree-status.js";

export interface ProjectWorktreeGitPublishingRouteDependencies {
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
  repository: Pick<
    ServerRepository,
    "getGithubProjectExecutionContext" | "getProjectWorktreeContext"
  >;
  scheduleProjectWorktreeObservation: (projectId: string) => Promise<void>;
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "serialize">;
}

/**
 * Registers legacy plaintext Git tag, GitHub release, and force-push routes at
 * their original position. The root request policy currently tombstones these
 * endpoints; keep their latent handlers intact until that surface is removed.
 */
export function installProjectWorktreeGitPublishingRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishLiveInvalidation,
    recordLiveWorktreeStatus,
    repository,
    scheduleProjectWorktreeObservation,
    worktreeCoordinator,
  }: ProjectWorktreeGitPublishingRouteDependencies,
): void {
  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/tags/actions/apply",
    async (request, reply) => {
      const input = gitTagActionApplySchema.safeParse(request.body);
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
            const applied = gitTagMutationResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "git.tag.action.apply",
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
    "/api/projects/:projectId/worktrees/:worktreeId/git/tags/actions/preview",
    async (request, reply) => {
      const input = gitTagActionSchema.safeParse(request.body);
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
          gitTagActionPreviewSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.tag.action.preview",
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

  app.get<{ Params: { name: string; projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/tags/:name",
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
          gitTagDetailSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.tag.get",
              cwd: context.worktree.path,
              name: request.params.name,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/tags",
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
          gitTagListSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.tag.list",
              cwd: context.worktree.path,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/github/releases",
    async (request, reply) => {
      const [worktree, github] = await Promise.all([
        repository.getProjectWorktreeContext(
          applicationOwnerId(),
          request.params.projectId,
          request.params.worktreeId,
        ),
        repository.getGithubProjectExecutionContext(
          applicationOwnerId(),
          request.params.projectId,
        ),
      ]);
      if (!worktree || !github) {
        return reply
          .code(404)
          .send({ error: "GitHub worktree project not found." });
      }
      try {
        return reply.send(
          githubReleaseListSchema.parse(
            await bridge.request(worktree.workerId, {
              type: "github.releases.list",
              cwd: worktree.worktree.path,
              repository: github.nameWithOwner,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { projectId: string; releaseId: string; worktreeId: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/github/releases/:releaseId",
    async (request, reply) => {
      const releaseId = Number.parseInt(request.params.releaseId, 10);
      if (!Number.isInteger(releaseId) || releaseId < 1) {
        return reply.code(400).send({ error: "Invalid release id." });
      }
      const [worktree, github] = await Promise.all([
        repository.getProjectWorktreeContext(
          applicationOwnerId(),
          request.params.projectId,
          request.params.worktreeId,
        ),
        repository.getGithubProjectExecutionContext(
          applicationOwnerId(),
          request.params.projectId,
        ),
      ]);
      if (!worktree || !github) {
        return reply
          .code(404)
          .send({ error: "GitHub worktree project not found." });
      }
      try {
        return reply.send(
          githubReleaseSummarySchema.parse(
            await bridge.request(worktree.workerId, {
              type: "github.release.get",
              cwd: worktree.worktree.path,
              repository: github.nameWithOwner,
              releaseId,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/github/releases",
    async (request, reply) => {
      const input = githubReleaseCreateSchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      try {
        const result = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const [worktree, github] = await Promise.all([
              repository.getProjectWorktreeContext(
                applicationOwnerId(),
                request.params.projectId,
                request.params.worktreeId,
              ),
              repository.getGithubProjectExecutionContext(
                applicationOwnerId(),
                request.params.projectId,
              ),
            ]);
            if (!worktree || !github) {
              throw new Error("GitHub worktree project not found.");
            }
            return githubReleaseSummarySchema.parse(
              await bridge.request(worktree.workerId, {
                type: "github.release.create",
                cwd: worktree.worktree.path,
                repository: github.nameWithOwner,
                request: input.data,
              }),
            );
          },
        );
        return reply.code(201).send(result);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/force-push/preview",
    async (request, reply) => {
      try {
        const preview = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const context = await repository.getProjectWorktreeContext(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!context) throw new Error("Worktree not found.");
            return gitForcePushPreviewSchema.parse(
              await bridge.request(
                context.workerId,
                {
                  type: "git.force-push.preview",
                  cwd: context.worktree.path,
                },
                { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
              ),
            );
          },
        );
        return reply.send(preview);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/force-push/apply",
    async (request, reply) => {
      const input = gitForcePushApplySchema.safeParse(request.body);
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
            const applied = gitActionResultSchema.parse(
              await bridge.request(
                context.workerId,
                {
                  type: "git.force-push.apply",
                  cwd: context.worktree.path,
                  token: input.data.token,
                },
                { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
              ),
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
            void scheduleProjectWorktreeObservation(request.params.projectId);
            return applied;
          },
        );
        return reply.send(result);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );
}
