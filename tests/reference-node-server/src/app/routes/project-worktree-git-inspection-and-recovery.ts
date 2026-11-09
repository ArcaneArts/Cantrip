import {
  gitBlameSchema,
  gitCommitSearchQuerySchema,
  gitCommitSearchResultSchema,
  gitConflictDetailSchema,
  gitConflictResolutionApplySchema,
  gitConflictResolutionPreviewSchema,
  gitConflictResolutionRequestSchema,
  gitConflictResolutionResultSchema,
  gitFileHistorySchema,
  gitManagedOperationWorkerStateSchema,
  gitRecoveryActionSchema,
  gitRecoveryApplySchema,
  gitRecoveryCandidateListSchema,
  gitRecoveryPreviewSchema,
  gitRecoveryResultSchema,
  gitRelativePathSchema,
  type GitManagedOperationRecord,
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
import { gitManagedOperationContext } from "../shared/git-managed-operations.js";
import { worktreeStatusFromGitStatus } from "../shared/worktree-status.js";

type ProjectWorktreeGitInspectionRepository = Pick<
  ServerRepository,
  "getActiveGitOperation" | "getProjectWorktreeContext" | "updateGitOperation"
>;

export interface ProjectWorktreeGitInspectionAndRecoveryRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "request">;
  publishGitOperation: (operation: GitManagedOperationRecord) => void;
  publishLiveInvalidation: (
    resource: "git-conflict" | "worktree" | "worktree-status",
    input: { entityId?: string; projectId: string },
  ) => void;
  recordLiveWorktreeStatus: (
    projectId: string,
    worktreeId: string,
    status: WorktreeStatusResult,
  ) => Promise<void>;
  repository: ProjectWorktreeGitInspectionRepository;
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "serialize">;
}

/**
 * Registers legacy plaintext Git inspection and recovery routes at their
 * original position. The root request policy currently tombstones these
 * endpoints; keep their latent handlers intact until that surface is removed.
 */
export function installProjectWorktreeGitInspectionAndRecoveryRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishGitOperation,
    publishLiveInvalidation,
    recordLiveWorktreeStatus,
    repository,
    worktreeCoordinator,
  }: ProjectWorktreeGitInspectionAndRecoveryRouteDependencies,
): void {
  app.get<{
    Params: { projectId: string; worktreeId: string };
    Querystring: { path?: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/conflicts/detail",
    async (request, reply) => {
      const parsedPath = gitRelativePathSchema.safeParse(request.query.path);
      if (!parsedPath.success) {
        return reply
          .code(400)
          .send({ error: "A safe conflict path is required." });
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
          gitConflictDetailSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.conflicts.get",
              cwd: context.worktree.path,
              path: parsedPath.data,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { projectId: string; worktreeId: string };
    Querystring: {
      cursor?: string;
      limit?: string;
      path?: string;
      revision?: string;
    };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/files/history",
    async (request, reply) => {
      const filePath = gitRelativePathSchema.safeParse(request.query.path);
      const revision = (request.query.revision ?? "HEAD").trim();
      if (!filePath.success || !revision || revision.length > 1_024) {
        return reply.code(400).send({ error: "Invalid file history query." });
      }
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      const limit = Math.min(
        100,
        Math.max(1, Number.parseInt(request.query.limit ?? "100", 10) || 100),
      );
      const cursor = Math.max(
        0,
        Number.parseInt(request.query.cursor ?? "0", 10) || 0,
      );
      try {
        return reply.send(
          gitFileHistorySchema.parse(
            await bridge.request(context.workerId, {
              type: "git.file.history",
              cwd: context.worktree.path,
              path: filePath.data,
              revision,
              cursor,
              limit,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { projectId: string; worktreeId: string };
    Querystring: {
      cursor?: string;
      limit?: string;
      path?: string;
      revision?: string;
    };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/files/blame",
    async (request, reply) => {
      const filePath = gitRelativePathSchema.safeParse(request.query.path);
      const revision = (request.query.revision ?? "HEAD").trim();
      if (!filePath.success || !revision || revision.length > 1_024) {
        return reply.code(400).send({ error: "Invalid file blame query." });
      }
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      const limit = Math.min(
        500,
        Math.max(1, Number.parseInt(request.query.limit ?? "200", 10) || 200),
      );
      const cursor = Math.max(
        0,
        Number.parseInt(request.query.cursor ?? "0", 10) || 0,
      );
      try {
        return reply.send(
          gitBlameSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.file.blame",
              cwd: context.worktree.path,
              path: filePath.data,
              revision,
              cursor,
              limit,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { projectId: string; worktreeId: string };
    Querystring: {
      author?: string;
      branch?: string;
      cursor?: string;
      dateFrom?: string;
      dateTo?: string;
      hash?: string;
      limit?: string;
      message?: string;
      path?: string;
      tag?: string;
    };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/commits/search",
    async (request, reply) => {
      const value = (candidate: string | undefined) =>
        candidate?.trim() ? candidate.trim() : null;
      const query = gitCommitSearchQuerySchema.safeParse({
        message: value(request.query.message),
        author: value(request.query.author),
        hash: value(request.query.hash),
        dateFrom: value(request.query.dateFrom),
        dateTo: value(request.query.dateTo),
        path: value(request.query.path),
        branch: value(request.query.branch),
        tag: value(request.query.tag),
      });
      if (!query.success) {
        return reply.code(400).send(invalidBody(query.error.issues));
      }
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      const limit = Math.min(
        100,
        Math.max(1, Number.parseInt(request.query.limit ?? "100", 10) || 100),
      );
      const cursor = Math.max(
        0,
        Number.parseInt(request.query.cursor ?? "0", 10) || 0,
      );
      try {
        return reply.send(
          gitCommitSearchResultSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.commit.search",
              cwd: context.worktree.path,
              query: query.data,
              cursor,
              limit,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { projectId: string; worktreeId: string };
    Querystring: { cursor?: string; kind?: string; limit?: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/recovery",
    async (request, reply) => {
      const kind = request.query.kind;
      if (kind !== "reflog" && kind !== "dangling") {
        return reply.code(400).send({ error: "Recovery kind is required." });
      }
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context) {
        return reply.code(404).send({ error: "Worktree not found." });
      }
      const limit = Math.min(
        100,
        Math.max(1, Number.parseInt(request.query.limit ?? "100", 10) || 100),
      );
      const cursor = Math.max(
        0,
        Number.parseInt(request.query.cursor ?? "0", 10) || 0,
      );
      try {
        return reply.send(
          gitRecoveryCandidateListSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.recovery.list",
              cwd: context.worktree.path,
              kind,
              cursor,
              limit,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/recovery/preview",
    async (request, reply) => {
      const input = gitRecoveryActionSchema.safeParse(request.body);
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
        return reply.send(
          gitRecoveryPreviewSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.recovery.preview",
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

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/recovery/apply",
    async (request, reply) => {
      const input = gitRecoveryApplySchema.safeParse(request.body);
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
            const applied = gitRecoveryResultSchema.parse(
              await bridge.request(
                context.workerId,
                {
                  type: "git.recovery.apply",
                  cwd: context.worktree.path,
                  request: input.data,
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
    "/api/projects/:projectId/worktrees/:worktreeId/git/conflicts/preview",
    async (request, reply) => {
      const input = gitConflictResolutionRequestSchema.safeParse(request.body);
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
          gitConflictResolutionPreviewSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.conflicts.preview",
              cwd: context.worktree.path,
              request: input.data,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/conflicts/apply",
    async (request, reply) => {
      const input = gitConflictResolutionApplySchema.safeParse(request.body);
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
            const resolved = gitConflictResolutionResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "git.conflicts.apply",
                cwd: context.worktree.path,
                request: input.data.request,
                token: input.data.token,
              }),
            );
            await recordLiveWorktreeStatus(
              request.params.projectId,
              request.params.worktreeId,
              worktreeStatusFromGitStatus(context.worktree, resolved.status),
            );
            const active = await repository.getActiveGitOperation(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (active) {
              const workerState = gitManagedOperationWorkerStateSchema.parse(
                await bridge.request(context.workerId, {
                  type: "git.operation.inspect",
                  cwd: context.worktree.path,
                  context: gitManagedOperationContext(active),
                }),
              );
              const updated = await repository.updateGitOperation(
                applicationOwnerId(),
                request.params.projectId,
                request.params.worktreeId,
                active.id,
                workerState,
              );
              if (updated) publishGitOperation(updated);
            }
            publishLiveInvalidation("git-conflict", {
              entityId: request.params.worktreeId,
              projectId: request.params.projectId,
            });
            publishLiveInvalidation("worktree", {
              projectId: request.params.projectId,
            });
            publishLiveInvalidation("worktree-status", {
              projectId: request.params.projectId,
            });
            return resolved;
          },
        );
        return reply.send(result);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );
}
