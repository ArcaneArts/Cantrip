import {
  gitManagedOperationActionSchema,
  gitManagedOperationAmendSchema,
  gitManagedOperationControlSchema,
  gitManagedOperationPreviewSchema,
  gitManagedOperationResponseSchema,
  gitManagedOperationStartSchema,
  gitManagedOperationWorkerStateSchema,
  type GitManagedOperationRecord,
  type WorktreeStatusResult,
} from "@cantrip/protocol";
import type { FastifyInstance } from "fastify";

import type { ServerRepository } from "../../db/repository.js";
import { errorMessage, invalidBody } from "../../http/request-helpers.js";
import { sendWorkerConflictFailure } from "../../http/worker-request-failures.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../../workers/bridge.js";
import type { ProjectWorktreeCoordinator } from "../../worktrees/coordinator.js";
import { FINITE_WORKER_COMMAND_TIMEOUT_MS } from "../shared/constants.js";
import { gitManagedOperationContext } from "../shared/git-managed-operations.js";
import { worktreeStatusFromGitStatus } from "../shared/worktree-status.js";

export interface GitOperationRequestRuntime {
  isRequestRunning: (operationId: string) => boolean;
  withRequestRunning: <T>(
    operationId: string,
    request: () => Promise<T>,
  ) => Promise<T>;
}

export interface ProjectWorktreeGitManagedOperationRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "request">;
  gitOperationRequestRuntime: GitOperationRequestRuntime;
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
    | "failGitOperation"
    | "getActiveGitOperation"
    | "getGitOperation"
    | "getLatestGitOperation"
    | "getProjectWorktreeContext"
    | "markGitOperationRunning"
    | "updateGitOperation"
  >;
  scheduleProjectWorktreeObservation: (projectId: string) => Promise<void>;
  scheduleWorkerWorktreeObservation: (workerId: string) => void;
  worktreeCoordinator: Pick<ProjectWorktreeCoordinator, "serialize">;
}

/**
 * Registers legacy plaintext managed Git operation routes at their original
 * position. Shared request activity remains owned by buildApp and is exposed
 * only through the narrow runtime needed by these latent handlers.
 */
export function installProjectWorktreeGitManagedOperationRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    gitOperationRequestRuntime,
    publishGitOperation,
    publishLiveInvalidation,
    recordLiveWorktreeStatus,
    repository,
    scheduleProjectWorktreeObservation,
    scheduleWorkerWorktreeObservation,
    worktreeCoordinator,
  }: ProjectWorktreeGitManagedOperationRouteDependencies,
): void {
  app.post<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/operations/preview",
    async (request, reply) => {
      const input = gitManagedOperationActionSchema.safeParse(request.body);
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
            return gitManagedOperationPreviewSchema.parse(
              await bridge.request(
                context.workerId,
                {
                  type: "git.operation.preview",
                  cwd: context.worktree.path,
                  action: input.data,
                },
                { timeoutMs: 5 * 60_000 },
              ),
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
    "/api/projects/:projectId/worktrees/:worktreeId/git/operations",
    async (request, reply) => {
      const input = gitManagedOperationStartSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      let durableId: string | null = null;
      let durableWorkerId: string | null = null;
      try {
        const operation = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const context = await repository.getProjectWorktreeContext(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
            );
            if (!context) throw new Error("Worktree not found.");
            durableWorkerId = context.workerId;
            const preview = gitManagedOperationPreviewSchema.parse(
              await bridge.request(
                context.workerId,
                {
                  type: "git.operation.preview",
                  cwd: context.worktree.path,
                  action: input.data.action,
                },
                { timeoutMs: 5 * 60_000 },
              ),
            );
            if (preview.token !== input.data.token) {
              throw new Error(
                "The worktree or selected revisions changed after this preview. Review the operation again.",
              );
            }
            const durable = await repository.createGitOperation(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
              context.workerId,
              preview.context,
            );
            durableId = durable.id;
            const running = await repository.markGitOperationRunning(
              durable.id,
            );
            if (!running) throw new Error("Git operation record disappeared.");
            publishGitOperation(running);
            scheduleWorkerWorktreeObservation(context.workerId);
            const workerState =
              await gitOperationRequestRuntime.withRequestRunning(
                durable.id,
                async () =>
                  gitManagedOperationWorkerStateSchema.parse(
                    await bridge.request(
                      context.workerId,
                      {
                        type: "git.operation.start",
                        cwd: context.worktree.path,
                        action: input.data.action,
                        token: input.data.token,
                      },
                      { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
                    ),
                  ),
              );
            const updated = await repository.updateGitOperation(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
              durable.id,
              workerState,
            );
            if (!updated) throw new Error("Git operation record disappeared.");
            await recordLiveWorktreeStatus(
              request.params.projectId,
              request.params.worktreeId,
              worktreeStatusFromGitStatus(context.worktree, workerState.status),
            );
            publishGitOperation(updated);
            scheduleWorkerWorktreeObservation(context.workerId);
            publishLiveInvalidation("worktree-status", {
              projectId: request.params.projectId,
            });
            return updated;
          },
        );
        return reply
          .code(201)
          .send(gitManagedOperationResponseSchema.parse({ operation }));
      } catch (error) {
        if (durableId && !(error instanceof WorkerUnavailableError)) {
          const failed = await repository.failGitOperation(
            applicationOwnerId(),
            request.params.projectId,
            request.params.worktreeId,
            durableId,
            errorMessage(error),
          );
          if (failed) publishGitOperation(failed);
          if (durableWorkerId) {
            scheduleWorkerWorktreeObservation(durableWorkerId);
          }
        }
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/operations/current",
    async (request, reply) => {
      try {
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
        let operation: GitManagedOperationRecord | null;
        if (!active) {
          operation = await repository.getLatestGitOperation(
            applicationOwnerId(),
            request.params.projectId,
            request.params.worktreeId,
          );
        } else if (
          active.state === "queued" ||
          (active.state === "running" &&
            (gitOperationRequestRuntime.isRequestRunning(active.id) ||
              Date.now() - new Date(active.updatedAt).getTime() < 5_000))
        ) {
          operation = active;
        } else {
          try {
            const workerState = gitManagedOperationWorkerStateSchema.parse(
              await bridge.request(context.workerId, {
                type: "git.operation.inspect",
                cwd: context.worktree.path,
                context: gitManagedOperationContext(active),
              }),
            );
            operation =
              (await repository.updateGitOperation(
                applicationOwnerId(),
                request.params.projectId,
                request.params.worktreeId,
                active.id,
                workerState,
              )) ?? active;
            if (operation.updatedAt !== active.updatedAt) {
              publishGitOperation(operation);
              if (
                ["completed", "failed", "aborted"].includes(operation.state)
              ) {
                publishLiveInvalidation("worktree", {
                  projectId: request.params.projectId,
                });
                publishLiveInvalidation("worktree-status", {
                  projectId: request.params.projectId,
                });
                void scheduleProjectWorktreeObservation(
                  request.params.projectId,
                );
              }
            }
            await recordLiveWorktreeStatus(
              request.params.projectId,
              request.params.worktreeId,
              worktreeStatusFromGitStatus(context.worktree, workerState.status),
            );
          } catch (error) {
            if (error instanceof WorkerUnavailableError) operation = active;
            else throw error;
          }
        }
        return reply.send(
          gitManagedOperationResponseSchema.parse({ operation }),
        );
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{
    Params: { projectId: string; worktreeId: string; operationId: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/operations/:operationId/control",
    async (request, reply) => {
      const input = gitManagedOperationControlSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const operation = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const [context, durable] = await Promise.all([
              repository.getProjectWorktreeContext(
                applicationOwnerId(),
                request.params.projectId,
                request.params.worktreeId,
              ),
              repository.getGitOperation(
                applicationOwnerId(),
                request.params.projectId,
                request.params.worktreeId,
                request.params.operationId,
              ),
            ]);
            if (!context || !durable)
              throw new Error("Git operation not found.");
            if (durable.workerId !== context.workerId) {
              throw new Error(
                "The Git operation belongs to a different worker than this worktree.",
              );
            }
            if (["completed", "failed", "aborted"].includes(durable.state)) {
              throw new Error(
                `This Git operation is already ${durable.state}.`,
              );
            }
            const workerState =
              await gitOperationRequestRuntime.withRequestRunning(
                durable.id,
                async () =>
                  gitManagedOperationWorkerStateSchema.parse(
                    await bridge.request(
                      context.workerId,
                      {
                        type: "git.operation.control",
                        cwd: context.worktree.path,
                        context: gitManagedOperationContext(durable),
                        action: input.data.action,
                      },
                      { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
                    ),
                  ),
              );
            const updated = await repository.updateGitOperation(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
              durable.id,
              workerState,
            );
            if (!updated) throw new Error("Git operation record disappeared.");
            await recordLiveWorktreeStatus(
              request.params.projectId,
              request.params.worktreeId,
              worktreeStatusFromGitStatus(context.worktree, workerState.status),
            );
            publishGitOperation(updated);
            publishLiveInvalidation("worktree", {
              projectId: request.params.projectId,
            });
            publishLiveInvalidation("worktree-status", {
              projectId: request.params.projectId,
            });
            void scheduleProjectWorktreeObservation(request.params.projectId);
            scheduleWorkerWorktreeObservation(context.workerId);
            return updated;
          },
        );
        return reply.send(
          gitManagedOperationResponseSchema.parse({ operation }),
        );
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{
    Params: { projectId: string; worktreeId: string; operationId: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/operations/:operationId/amend",
    async (request, reply) => {
      const input = gitManagedOperationAmendSchema.safeParse(request.body);
      if (!input.success) {
        return reply.code(400).send(invalidBody(input.error.issues));
      }
      try {
        const operation = await worktreeCoordinator.serialize(
          request.params.projectId,
          async () => {
            const [context, durable] = await Promise.all([
              repository.getProjectWorktreeContext(
                applicationOwnerId(),
                request.params.projectId,
                request.params.worktreeId,
              ),
              repository.getGitOperation(
                applicationOwnerId(),
                request.params.projectId,
                request.params.worktreeId,
                request.params.operationId,
              ),
            ]);
            if (!context || !durable) {
              throw new Error("Git operation not found.");
            }
            if (durable.workerId !== context.workerId) {
              throw new Error(
                "The Git operation belongs to a different worker than this worktree.",
              );
            }
            if (["completed", "failed", "aborted"].includes(durable.state)) {
              throw new Error(
                `This Git operation is already ${durable.state}.`,
              );
            }
            const workerState =
              await gitOperationRequestRuntime.withRequestRunning(
                durable.id,
                async () =>
                  gitManagedOperationWorkerStateSchema.parse(
                    await bridge.request(
                      context.workerId,
                      {
                        type: "git.operation.amend",
                        cwd: context.worktree.path,
                        context: gitManagedOperationContext(durable),
                        message: input.data.message,
                      },
                      { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
                    ),
                  ),
              );
            const updated = await repository.updateGitOperation(
              applicationOwnerId(),
              request.params.projectId,
              request.params.worktreeId,
              durable.id,
              workerState,
            );
            if (!updated) throw new Error("Git operation record disappeared.");
            await recordLiveWorktreeStatus(
              request.params.projectId,
              request.params.worktreeId,
              worktreeStatusFromGitStatus(context.worktree, workerState.status),
            );
            publishGitOperation(updated);
            publishLiveInvalidation("worktree", {
              projectId: request.params.projectId,
            });
            publishLiveInvalidation("worktree-status", {
              projectId: request.params.projectId,
            });
            void scheduleProjectWorktreeObservation(request.params.projectId);
            scheduleWorkerWorktreeObservation(context.workerId);
            return updated;
          },
        );
        return reply.send(
          gitManagedOperationResponseSchema.parse({ operation }),
        );
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );
}
