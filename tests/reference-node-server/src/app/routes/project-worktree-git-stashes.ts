import {
  gitManagedOperationWorkerStateSchema,
  gitRelativePathSchema,
  gitStashActionApplySchema,
  gitStashActionPreviewSchema,
  gitStashActionSchema,
  gitStashCreateSchema,
  gitStashFileDiffSchema,
  gitStashListSchema,
  gitStashMutationResultSchema,
  type GitManagedOperationContext,
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
import { worktreeStatusFromGitStatus } from "../shared/worktree-status.js";

type ProjectWorktreeGitStashRepository = Pick<
  ServerRepository,
  | "createGitOperation"
  | "getActiveGitOperation"
  | "getProjectWorktreeContext"
  | "markGitOperationRunning"
  | "updateGitOperation"
>;

export interface ProjectWorktreeGitStashRouteDependencies {
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
  repository: ProjectWorktreeGitStashRepository;
  scheduleWorkerWorktreeObservation: (workerId: string) => void;
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "serialize">;
}

/**
 * Registers legacy plaintext Git stash routes at their original position.
 * The root request policy currently tombstones these endpoints; keep their
 * latent handlers intact until that surface is removed.
 */
export function installProjectWorktreeGitStashRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    publishGitOperation,
    publishLiveInvalidation,
    recordLiveWorktreeStatus,
    repository,
    scheduleWorkerWorktreeObservation,
    worktreeCoordinator,
  }: ProjectWorktreeGitStashRouteDependencies,
): void {
  app.get<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/stashes",
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
          gitStashListSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.stash.list",
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
    "/api/projects/:projectId/worktrees/:worktreeId/git/stashes",
    async (request, reply) => {
      const input = gitStashCreateSchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      const existing = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!existing)
        return reply.code(404).send({ error: "Worktree not found." });
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
            const active = await repository.getActiveGitOperation(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (active) {
              throw new Error(
                `Finish or abort the active ${active.type} operation first.`,
              );
            }
            const created = gitStashMutationResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "git.stash.create",
                cwd: context.worktree.path,
                request: input.data,
              }),
            );
            await recordLiveWorktreeStatus(
              request.params.projectId,
              request.params.worktreeId,
              worktreeStatusFromGitStatus(context.worktree, created.status),
            );
            return created;
          },
        );
        return reply.send(result);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.get<{
    Params: { projectId: string; worktreeId: string; hash: string };
    Querystring: { path?: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/stashes/:hash/diff",
    async (request, reply) => {
      const filePath = gitRelativePathSchema.safeParse(request.query.path);
      if (
        !/^[0-9a-f]{40,64}$/u.test(request.params.hash) ||
        !filePath.success
      ) {
        return reply
          .code(400)
          .send({ error: "A valid stash hash and path are required." });
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
          gitStashFileDiffSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.stash.diff",
              cwd: context.worktree.path,
              hash: request.params.hash,
              path: filePath.data,
              contextLines: 3,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/stashes/actions/preview",
    async (request, reply) => {
      const action = gitStashActionSchema.safeParse(request.body);
      if (!action.success)
        return reply.code(400).send(invalidBody(action.error.issues));
      const context = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!context)
        return reply.code(404).send({ error: "Worktree not found." });
      try {
        const active = await repository.getActiveGitOperation(
          applicationOwnerId(),
          request.params.projectId,
          request.params.worktreeId,
        );
        if (active) {
          throw new Error(
            `Finish or abort the active ${active.type} operation first.`,
          );
        }
        return reply.send(
          gitStashActionPreviewSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.stash.action.preview",
              cwd: context.worktree.path,
              action: action.data,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/stashes/actions/apply",
    async (request, reply) => {
      const input = gitStashActionApplySchema.safeParse(request.body);
      if (!input.success)
        return reply.code(400).send(invalidBody(input.error.issues));
      const existing = await repository.getProjectWorktreeContext(
        applicationOwnerId(),
        request.params.projectId,
        request.params.worktreeId,
      );
      if (!existing)
        return reply.code(404).send({ error: "Worktree not found." });
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
            const active = await repository.getActiveGitOperation(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (active) {
              throw new Error(
                `Finish or abort the active ${active.type} operation first.`,
              );
            }
            const applied = gitStashMutationResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "git.stash.action.apply",
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
            if (applied.operation) {
              const operationContext: GitManagedOperationContext = {
                type: "stash",
                originalHead: applied.operation.originalHead,
                sourceRef: applied.operation.sourceRef,
                sourceRevision: applied.operation.sourceRevision,
                targetRef: applied.operation.targetRef,
                targetRevision: applied.operation.targetRevision,
                pendingCommits: applied.operation.pendingCommits,
                totalSteps: 1,
                checkpointRef: applied.operation.checkpointRef,
              };
              const durable = await repository.createGitOperation(
                applicationOwnerId(),
                request.params.projectId,
                request.params.worktreeId,
                context.workerId,
                operationContext,
              );
              await repository.markGitOperationRunning(durable.id);
              const updated = await repository.updateGitOperation(
                applicationOwnerId(),
                request.params.projectId,
                request.params.worktreeId,
                durable.id,
                gitManagedOperationWorkerStateSchema.parse({
                  ...operationContext,
                  state: "conflicted",
                  currentHead: applied.operation.currentHead,
                  currentStep: 1,
                  pendingCommits: applied.operation.pendingCommits,
                  conflictedPaths: applied.operation.conflictedPaths,
                  output: applied.output,
                  status: applied.status,
                }),
              );
              if (updated) publishGitOperation(updated);
              scheduleWorkerWorktreeObservation(context.workerId);
              publishLiveInvalidation("git-conflict", {
                entityId: request.params.worktreeId,
                projectId: request.params.projectId,
              });
            }
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
}
