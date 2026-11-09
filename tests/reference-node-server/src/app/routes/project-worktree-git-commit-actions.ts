import {
  gitCommitActionApplySchema,
  gitCommitActionPreviewSchema,
  gitCommitActionResultSchema,
  gitCommitActionSchema,
  gitManagedOperationWorkerStateSchema,
  type GitManagedOperationContext,
  type GitManagedOperationRecord,
  type WorktreeStatusResult,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { invalidBody } from "../../http/request-helpers.js";
import { sendWorkerConflictFailure } from "../../http/worker-request-failures.js";
import type { WorkerCommandBus } from "../../workers/bridge.js";
import type { ProjectWorktreeCoordinator } from "../../worktrees/coordinator.js";
import { worktreeStatusFromGitStatus } from "../shared/worktree-status.js";

export interface ProjectWorktreeGitCommitActionRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "request">;
  publishGitOperation: (operation: GitManagedOperationRecord) => void;
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
    | "createGitOperation"
    | "getActiveGitOperation"
    | "getProjectWorktreeContext"
    | "markGitOperationRunning"
    | "updateGitOperation"
  >;
  scheduleWorkerWorktreeObservation: (workerId: string) => void;
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "serialize">;
}

/**
 * Registers legacy plaintext worktree Git commit preview and apply routes at
 * their original position. The root request policy currently tombstones these
 * endpoints; keep their latent handlers intact until that surface is removed.
 */
export function installProjectWorktreeGitCommitActionRoutes(
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
  }: ProjectWorktreeGitCommitActionRouteDependencies,
): void {
  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/commits/actions/preview",
    async (request, reply) => {
      const input = gitCommitActionSchema.safeParse(request.body);
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
            const activeOperation = await repository.getActiveGitOperation(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (activeOperation) {
              throw new Error(
                `Finish or abort the active ${activeOperation.type} operation first.`,
              );
            }
            return gitCommitActionPreviewSchema.parse(
              await bridge.request(context.workerId, {
                type: "git.commit.action.preview",
                cwd: context.worktree.path,
                action: input.data,
              }),
            );
          },
        );
        return reply.send(result);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/commits/actions/apply",
    async (request, reply) => {
      const input = gitCommitActionApplySchema.safeParse(request.body);
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
            const activeOperation = await repository.getActiveGitOperation(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (activeOperation) {
              throw new Error(
                `Finish or abort the active ${activeOperation.type} operation first.`,
              );
            }
            const applied = gitCommitActionResultSchema.parse(
              await bridge.request(context.workerId, {
                type: "git.commit.action.apply",
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
                type: applied.operation.type,
                originalHead: applied.operation.originalHead,
                sourceRef: null,
                sourceRevision: applied.operation.sourceRevisions[0] ?? null,
                targetRef: applied.status.branch
                  ? `refs/heads/${applied.status.branch}`
                  : null,
                targetRevision: applied.operation.originalHead,
                pendingCommits: applied.operation.sourceRevisions,
                totalSteps: applied.operation.totalSteps,
                checkpointRef: applied.checkpointRef,
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
                  state: applied.operation.state,
                  currentHead: applied.operation.currentHead,
                  currentStep: applied.operation.currentStep,
                  pendingCommits:
                    applied.operation.state === "completed"
                      ? []
                      : applied.operation.sourceRevisions.slice(
                          Math.max(0, applied.operation.currentStep - 1),
                        ),
                  conflictedPaths: applied.operation.conflictedPaths,
                  output: applied.output,
                  status: applied.status,
                }),
              );
              if (updated) publishGitOperation(updated);
              scheduleWorkerWorktreeObservation(context.workerId);
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
