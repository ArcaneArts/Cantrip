import {
  gitConflictListSchema,
  githubPullRequestCheckoutResultSchema,
  githubPullRequestDetailSchema,
  githubPullRequestLifecycleActionSchema,
  githubPullRequestLifecycleApplySchema,
  githubPullRequestLifecyclePreviewSchema,
  githubPullRequestReviewActionSchema,
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

export interface ProjectWorktreePullRequestRouteDependencies {
  applicationOwnerId: () => string;
  bridge: Pick<WorkerCommandBus, "request">;
  repository: Pick<
    ServerRepository,
    "getGithubProjectExecutionContext" | "getProjectWorktreeContext"
  >;
  worktreeCoordinator: Pick<
    ProjectWorktreeCoordinator,
    "checkoutPullRequest" | "serialize"
  >;
}

/**
 * Registers legacy plaintext worktree repository routes at their original
 * position. The root request policy currently tombstones these endpoints,
 * except for the explicit Git-agent draft tombstone below. Keep their latent
 * handlers intact until the plaintext repository surface is removed wholesale.
 */
export function installProjectWorktreePullRequestRoutes(
  app: FastifyInstance,
  {
    applicationOwnerId,
    bridge,
    repository,
    worktreeCoordinator,
  }: ProjectWorktreePullRequestRouteDependencies,
): void {
  app.post<{
    Params: { projectId: string; worktreeId: string };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/agent/drafts",
    async (_request, reply) =>
      reply.code(410).send({
        error:
          "This plaintext Git agent route was removed. Use the protected repository operation endpoint.",
      }),
  );

  app.get<{ Params: { projectId: string; worktreeId: string } }>(
    "/api/projects/:projectId/worktrees/:worktreeId/git/conflicts",
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
          gitConflictListSchema.parse(
            await bridge.request(context.workerId, {
              type: "git.conflicts.list",
              cwd: context.worktree.path,
            }),
          ),
        );
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{
    Params: {
      projectId: string;
      worktreeId: string;
      pullRequestNumber: string;
    };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/github/pull-requests/:pullRequestNumber/checkout",
    async (request, reply) => {
      const pullRequestNumber = Number.parseInt(
        request.params.pullRequestNumber,
        10,
      );
      if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
        return reply.code(400).send({ error: "Invalid pull request number." });
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
      if (worktree.workerId !== github.workerId) {
        return reply.code(409).send({
          error:
            "The selected worktree and GitHub project belong to different workers.",
        });
      }
      try {
        const result = await worktreeCoordinator.checkoutPullRequest(
          applicationOwnerId(),
          request.params.projectId,
          request.params.worktreeId,
          github.nameWithOwner,
          pullRequestNumber,
        );
        return result
          ? reply.send(githubPullRequestCheckoutResultSchema.parse(result))
          : reply.code(404).send({ error: "Project worktree not found." });
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{
    Params: {
      projectId: string;
      worktreeId: string;
      pullRequestNumber: string;
    };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/github/pull-requests/:pullRequestNumber/lifecycle/preview",
    async (request, reply) => {
      const pullRequestNumber = Number.parseInt(
        request.params.pullRequestNumber,
        10,
      );
      const action = githubPullRequestLifecycleActionSchema.safeParse(
        request.body,
      );
      if (
        !Number.isInteger(pullRequestNumber) ||
        pullRequestNumber < 1 ||
        !action.success
      ) {
        return reply.code(400).send({ error: "Invalid lifecycle preview." });
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
      if (worktree.workerId !== github.workerId) {
        return reply.code(409).send({
          error:
            "The selected worktree and GitHub project belong to different workers.",
        });
      }
      try {
        return reply.send(
          githubPullRequestLifecyclePreviewSchema.parse(
            await bridge.request(
              worktree.workerId,
              {
                type: "github.pull-request.lifecycle.preview",
                cwd: worktree.worktree.path,
                repository: github.nameWithOwner,
                number: pullRequestNumber,
                action: action.data,
              },
              { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
            ),
          ),
        );
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );

  app.post<{
    Params: {
      projectId: string;
      worktreeId: string;
      pullRequestNumber: string;
    };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/github/pull-requests/:pullRequestNumber/lifecycle/apply",
    async (request, reply) => {
      const pullRequestNumber = Number.parseInt(
        request.params.pullRequestNumber,
        10,
      );
      const input = githubPullRequestLifecycleApplySchema.safeParse(
        request.body,
      );
      if (
        !Number.isInteger(pullRequestNumber) ||
        pullRequestNumber < 1 ||
        !input.success
      ) {
        return reply
          .code(400)
          .send({ error: "Invalid lifecycle apply request." });
      }
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
            if (worktree.workerId !== github.workerId) {
              throw new Error(
                "The selected worktree and GitHub project belong to different workers.",
              );
            }
            return githubPullRequestDetailSchema.parse(
              await bridge.request(
                worktree.workerId,
                {
                  type: "github.pull-request.lifecycle.apply",
                  cwd: worktree.worktree.path,
                  repository: github.nameWithOwner,
                  number: pullRequestNumber,
                  request: input.data,
                },
                { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
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

  app.get<{
    Params: {
      projectId: string;
      worktreeId: string;
      pullRequestNumber: string;
    };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/github/pull-requests/:pullRequestNumber",
    async (request, reply) => {
      const pullRequestNumber = Number.parseInt(
        request.params.pullRequestNumber,
        10,
      );
      if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
        return reply.code(400).send({ error: "Invalid pull request number." });
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
      if (worktree.workerId !== github.workerId) {
        return reply.code(409).send({
          error:
            "The selected worktree and GitHub project belong to different workers.",
        });
      }
      try {
        const pullRequest = await bridge.request(
          worktree.workerId,
          {
            type: "github.pull-request.get",
            cwd: worktree.worktree.path,
            repository: github.nameWithOwner,
            number: pullRequestNumber,
            section: "all",
          },
          { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
        );
        return reply.send(githubPullRequestDetailSchema.parse(pullRequest));
      } catch (error) {
        return sendWorkerRequestFailure(reply, error);
      }
    },
  );

  app.post<{
    Params: {
      projectId: string;
      worktreeId: string;
      pullRequestNumber: string;
    };
  }>(
    "/api/projects/:projectId/worktrees/:worktreeId/github/pull-requests/:pullRequestNumber/actions",
    async (request, reply) => {
      const pullRequestNumber = Number.parseInt(
        request.params.pullRequestNumber,
        10,
      );
      if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
        return reply.code(400).send({ error: "Invalid pull request number." });
      }
      const action = githubPullRequestReviewActionSchema.safeParse(
        request.body,
      );
      if (!action.success) {
        return reply.code(400).send(invalidBody(action.error.issues));
      }
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
            if (worktree.workerId !== github.workerId) {
              throw new Error(
                "The selected worktree and GitHub project belong to different workers.",
              );
            }
            const shared = {
              cwd: worktree.worktree.path,
              repository: github.nameWithOwner,
              number: pullRequestNumber,
            };
            const response =
              action.data.type === "comment"
                ? await bridge.request(
                    worktree.workerId,
                    {
                      type: "github.pull-request.comment",
                      ...shared,
                      body: action.data.body,
                    },
                    { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
                  )
                : action.data.type === "submit-review"
                  ? await bridge.request(
                      worktree.workerId,
                      {
                        type: "github.pull-request.review.submit",
                        ...shared,
                        review: action.data.review,
                      },
                      { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
                    )
                  : action.data.type === "inline-comment"
                    ? await bridge.request(
                        worktree.workerId,
                        {
                          type: "github.pull-request.review.comment",
                          ...shared,
                          comment: action.data.comment,
                        },
                        { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
                      )
                    : await bridge.request(
                        worktree.workerId,
                        {
                          type: "github.pull-request.review.reply",
                          ...shared,
                          commentId: action.data.commentId,
                          body: action.data.body,
                        },
                        { timeoutMs: FINITE_WORKER_COMMAND_TIMEOUT_MS },
                      );
            return githubPullRequestDetailSchema.parse(response);
          },
        );
        return reply.send(result);
      } catch (error) {
        return sendWorkerConflictFailure(reply, error);
      }
    },
  );
}
